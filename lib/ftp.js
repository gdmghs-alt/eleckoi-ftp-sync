/**
 * 极简 FTP 客户端（零依赖，只用 node:net / node:fs）。
 *
 * 只实现本插件需要的子集：登录、列目录（优先 MLSD，回退 LIST）、下载、上传、
 * 建目录、删除。不支持 FTPS —— 需要 TLS 时请改用 SFTP/WebDAV 方案。
 *
 * 之所以不用 npm 上的 FTP 库：插件以 link: 方式安装时，pnpm 不会安装被链接
 * 包的依赖，运行时 import 会直接失败。
 */
import fsp from 'node:fs/promises'
import net from 'node:net'

const CRLF = '\r\n'

function escapePath(value) {
  return value.replace(/[\r\n]/g, '')
}

export class FtpClient {
  constructor(options) {
    this.host = options.host
    this.port = Number(options.port) > 0 ? Number(options.port) : 21
    this.user = options.user ?? ''
    this.password = options.password ?? ''
    this.timeoutMs = Number(options.timeoutMs) > 0 ? Number(options.timeoutMs) : 30000
    this.socket = undefined
    this.buffer = ''
    this.pending = []
    // 已经收到、但当时没有等待者的回复。局域网里 226 常常在我们还在写文件的
    // 时候就到了 —— 那一刻 pending 是空的，直接丢掉就一定超时。
    this.queued = []
    // 正在拼装的回复（多行回复要等结尾那一行才算完整）
    this.current = undefined
    this.closed = false
    this.features = new Set()
    // 'auto' 自动判定；'utf8' / 'gbk' 强制指定（个别服务端两种都解得出但解错）
    this.listing = options.listing === 'utf8' || options.listing === 'gbk' ? options.listing : 'auto'
  }

  async connect() {
    await new Promise((resolve, reject) => {
      const socket = net.createConnection({ host: this.host, port: this.port })
      this.socket = socket
      const timer = setTimeout(() => reject(new Error(`FTP 连接超时：${this.host}:${this.port}`)), this.timeoutMs)
      socket.setEncoding('utf8')
      socket.once('error', error => {
        clearTimeout(timer)
        reject(error)
      })
      socket.once('connect', () => {
        clearTimeout(timer)
        resolve()
      })
      socket.on('data', chunk => this.onData(chunk))
      socket.on('close', () => {
        this.closed = true
        for (const entry of this.pending.splice(0)) entry.reject(new Error('FTP 连接已关闭'))
      })
    })

    const greeting = await this.readReply()
    if (greeting.code !== 220 && greeting.code !== 120) {
      throw new Error(`FTP 欢迎语异常：${greeting.code} ${greeting.text}`)
    }
    const user = await this.command(`USER ${this.user}`)
    if (user.code === 331) {
      const pass = await this.command(`PASS ${this.password}`)
      if (pass.code !== 230 && pass.code !== 202) throw new Error(`FTP 登录失败：${pass.code} ${pass.text}`)
    } else if (user.code !== 230) {
      throw new Error(`FTP 用户被拒绝：${user.code} ${user.text}`)
    }
    const type = await this.command('TYPE I')
    if (type.code !== 200) throw new Error(`FTP TYPE I 失败：${type.code} ${type.text}`)
    await this.command('FEAT').then(reply => {
      if (reply.code === 211) {
        for (const line of reply.text.split(/\r?\n/)) this.features.add(line.trim().split(' ')[0].toUpperCase())
      }
    }).catch(() => {})
    // IIS 默认按本地代码页（中文机器上是 GBK）回 LIST，文件名会乱码，
    // 导致每轮都把同一个文件当成新文件。服务端声明支持 UTF8 时打开它。
    if (this.features.has('UTF8')) {
      await this.command('OPTS UTF8 ON').catch(() => {})
    }
    return this
  }

  onData(chunk) {
    this.buffer += chunk
    for (;;) {
      const index = this.buffer.indexOf('\n')
      if (index < 0) return
      const line = this.buffer.slice(0, index).replace(/\r$/, '')
      this.buffer = this.buffer.slice(index + 1)
      // 没有等待者时也要把回复完整收下来放进队列，不能直接丢 —— 见 this.queued。
      if (this.current === undefined) {
        const match = /^(\d{3})([ -])(.*)$/.exec(line)
        if (match === null) continue
        this.current = { code: Number(match[1]), lines: [match[3]], multiline: match[2] === '-' }
        if (!this.current.multiline) this.settle()
        continue
      }
      this.current.lines.push(line)
      if (/^\d{3} /.test(line)) this.settle()
    }
  }

  settle() {
    const reply = this.current
    this.current = undefined
    if (reply === undefined) return
    const value = { code: reply.code ?? 0, text: reply.lines.join('\n') }
    const entry = this.pending.shift()
    if (entry === undefined) {
      this.queued.push(value)
      return
    }
    entry.resolve(value)
  }

  readReply() {
    const ready = this.queued.shift()
    if (ready !== undefined) return Promise.resolve(ready)
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('FTP 响应超时')), this.timeoutMs)
      this.pending.push({
        code: undefined,
        lines: [],
        multiline: false,
        resolve: value => {
          clearTimeout(timer)
          resolve(value)
        },
        reject: error => {
          clearTimeout(timer)
          reject(error)
        },
      })
    })
  }

  async command(line) {
    if (this.socket === undefined || this.closed) throw new Error('FTP 未连接')
    const reply = this.readReply()
    this.socket.write(`${escapePath(line)}${CRLF}`)
    return reply
  }

  async pasv() {
    const reply = await this.command('PASV')
    if (reply.code !== 227) throw new Error(`FTP PASV 失败：${reply.code} ${reply.text}`)
    const match = /(\d+),(\d+),(\d+),(\d+),(\d+),(\d+)/.exec(reply.text)
    if (match === null) throw new Error(`FTP PASV 响应无法解析：${reply.text}`)
    const host = `${match[1]}.${match[2]}.${match[3]}.${match[4]}`
    const port = Number(match[5]) * 256 + Number(match[6])
    return { host: host === '0.0.0.0' ? this.host : host, port }
  }

  openDataSocket({ host, port }) {
    return new Promise((resolve, reject) => {
      const socket = net.createConnection({ host, port })
      const timer = setTimeout(() => reject(new Error('FTP 数据连接超时')), this.timeoutMs)
      socket.once('connect', () => {
        clearTimeout(timer)
        // 空闲超时：服务器不回数据也不断开时，别让整个同步卡死
        socket.setTimeout(this.timeoutMs, () => socket.destroy())
        resolve(socket)
      })
      socket.once('error', error => {
        clearTimeout(timer)
        reject(error)
      })
    })
  }

  async list(path) {
    const dir = path === '' ? '.' : path
    const texts = []
    // 逐个试：MLSD（最规范）→ LIST -a（Unix 隐藏文件）→ LIST（IIS 只认这个）。
    // IIS 对 MLSD 回 500、对 LIST -a 也常回 550，不挨个退一遍就永远列不出内容。
    //
    // 关键是区分「命令失败」和「命令成功但目录是空的」：前者要继续退下一条命令，
    // 后者说明目录确实存在（空目录），应当直接返回空表。三条命令全失败才算真错，
    // 否则调用方（ensureRoot）就没法判断目录到底在不在。
    let succeeded = false
    for (const commandLine of [`MLSD ${dir}`, `LIST -a ${dir}`, `LIST ${dir}`]) {
      const raw = await this.withData(socket => collect(socket), commandLine, true).catch(() => undefined)
      if (raw === undefined) continue
      succeeded = true
      if (raw.length > 0) texts.push(decodeListing(raw, this.listing || 'auto'))
      break
    }
    if (!succeeded) throw new Error(`FTP 无法列出目录：${dir}`)
    const entries = new Map()
    for (const text of texts) {
      for (const line of text.split(/\r?\n/)) {
        if (line.trim() === '') continue
        const entry = parseMlsd(line) ?? parseDosList(line) ?? parseList(line)
        if (entry !== undefined && !entries.has(entry.name)) entries.set(entry.name, entry)
      }
    }
    return [...entries.values()]
  }

  async withData(handler, commandLine, tolerateFailure = false) {
    const passive = await this.pasv()
    const socket = await this.openDataSocket(passive)
    const collected = handler(socket)
    const reply = await this.command(commandLine)
    if (reply.code >= 400) {
      socket.destroy()
      await collected.catch(() => {})
      if (tolerateFailure) return undefined
      throw new Error(`FTP 命令失败：${commandLine} -> ${reply.code} ${reply.text}`)
    }
    const result = await collected
    const done = await this.readReply()
    if (done.code >= 400 && !tolerateFailure) throw new Error(`FTP 传输失败：${done.code} ${done.text}`)
    return result
  }

  async downloadTo(remotePath, destPath) {
    await this.withData(async socket => {
      const file = await fsp.open(destPath, 'w')
      try {
        for await (const chunk of socket) await file.write(chunk)
      } finally {
        await file.close()
      }
    }, `RETR ${remotePath}`)
  }

  async uploadFrom(srcPath, remotePath) {
    await this.withData(async socket => {
      const data = await fsp.readFile(srcPath)
      await new Promise((resolve, reject) => {
        socket.end(data, () => resolve())
        socket.once('error', reject)
      })
    }, `STOR ${remotePath}`)
  }

  /**
   * 逐级建目录，遇到「已存在」一律算通过。
   *
   * 各服务端的回法都不一样：IIS 对已存在的目录回 550，Serv-U 回 521，
   * 有些只回 450；目录已存在时 MKD 失败属于正常情况，不能当成错误。
   * 其它非 2xx 也只记进 failed 不抛 —— 这里抛会把整次同步打断，而真正的
   * 后果（父目录不存在）会在后面的 STOR 上明确暴露出来。
   *
   * 返回 { created, existed, failed }，调用方可以据此打日志或提示用户。
   */
  async ensureDir(dir, base = '/') {
    const normalized = String(dir ?? '').replace(/\\/g, '/').trim()
    if (normalized === '' || normalized === '.' || normalized === '/') {
      return { created: [], existed: [], failed: [] }
    }
    const absolute = normalized.startsWith('/')
      ? normalized
      : `${String(base ?? '/').replace(/\/+$/, '')}/${normalized}`
    const segments = absolute.split('/').filter(segment => segment !== '' && segment !== '.')
    let current = ''
    const created = []
    const existed = []
    const failed = []
    for (const segment of segments) {
      current += `/${segment}`
      let reply
      try {
        reply = await this.command(`MKD ${current}`)
      } catch (error) {
        failed.push({ path: current, error: error instanceof Error ? error.message : String(error) })
        continue
      }
      if (reply.code === 257 || reply.code === 250 || reply.code === 200) {
        created.push(current)
      } else if (reply.code === 550 || reply.code === 521 || reply.code === 450 || reply.code === 452) {
        existed.push(current)
      } else if (reply.code >= 400) {
        failed.push({ path: current, code: reply.code, text: reply.text })
      }
    }
    return { created, existed, failed }
  }

  /** 远端路径是否存在（目录或文件）。父目录列不出来时当不存在。 */
  async exists(targetPath) {
    const normalized = String(targetPath ?? '').replace(/\\/g, '/').replace(/\/+$/, '')
    if (normalized === '') return true
    const index = normalized.lastIndexOf('/')
    const parentDir = index <= 0 ? '/' : normalized.slice(0, index)
    const name = normalized.slice(index + 1)
    try {
      const entries = await this.list(parentDir)
      return entries.some(entry => entry.name === name)
    } catch {
      return false
    }
  }

  async remove(remotePath) {
    const reply = await this.command(`DELE ${remotePath}`)
    if (reply.code === 550) return false
    if (reply.code >= 400) throw new Error(`FTP DELE 失败：${reply.code} ${reply.text}`)
    return true
  }

  /**
   * 改名（RNFR / RNTO），可跨目录。
   *
   * 用途：服务端上的文件被标成只读时，DELE 和覆盖式 STOR 都会回 550，
   * 但「改名」这一步通常还是允许的 —— 把旧文件挪走，新文件就能在原位置写进去。
   */
  async rename(from, to) {
    const first = await this.command(`RNFR ${from}`)
    if (first.code >= 400) throw new Error(`FTP RNFR 失败：${first.code} ${first.text}`)
    const second = await this.command(`RNTO ${to}`)
    if (second.code >= 400) throw new Error(`FTP RNTO 失败：${second.code} ${second.text}`)
    return true
  }

  async close() {
    if (this.socket === undefined) return
    try {
      await this.command('QUIT')
    } catch {
      // 已经断开
    }
    this.socket.destroy()
    this.socket = undefined
    this.closed = true
  }
}

/**
 * 目录列表的字节 → 字符串。
 *
 * IIS 的 LIST 按服务端本地代码页输出（中文 Windows 上是 GBK），`OPTS UTF8 ON`
 * 只影响命令通道、不影响 LIST 的数据通道 —— 这是 IIS 的老毛病。直接按 UTF-8
 * 解会得到一堆替换字符，文件名对不上，同步就会反复把同一个文件当成新文件。
 * 所以先严格按 UTF-8 解，解不开就退 GBK（Node 的 full-icu 支持）。
 */
function decodeListing(buffer, mode) {
  const bytes = buffer instanceof Buffer ? buffer : Buffer.from(String(buffer), 'utf8')
  if (mode === 'gbk') return new TextDecoder('gbk').decode(bytes)
  if (mode === 'utf8') return bytes.toString('utf8')
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    try {
      return new TextDecoder('gbk').decode(bytes)
    } catch {
      return bytes.toString('utf8')
    }
  }
}

function collect(socket) {
  return new Promise(resolve => {
    const chunks = []
    let settled = false
    const finish = () => {
      if (settled) return
      settled = true
      resolve(Buffer.concat(chunks))
    }
    socket.on('data', chunk => chunks.push(chunk))
    // 'end' 正常结束；'close' 兜住服务器直接断开的错误路径，避免永久挂起
    socket.once('end', finish)
    socket.once('close', finish)
    socket.once('error', finish)
  })
}

function parseMlsd(line) {
  const match = /^([a-zA-Z0-9-]+=[^;]*;)+ (.*)$/.exec(line)
  if (match === null) return undefined
  const facts = {}
  for (const part of line.split(' ')[0].split(';')) {
    if (part === '') continue
    const [key, value] = part.split('=')
    if (key && value !== undefined) facts[key.toLowerCase()] = value
  }
  const name = line.slice(line.indexOf(' ') + 1).trim()
  if (name === '' || name === '.' || name === '..') return undefined
  const isDirectory = (facts.type ?? '').toLowerCase() === 'dir'
  const mtimeMs = parseMlsdTime(facts.modify)
  return { name, isDirectory, size: Number(facts.size) || 0, mtimeMs }
}

function parseMlsdTime(value) {
  if (typeof value !== 'string' || value.length < 14) return Date.now()
  const iso = `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}T${value.slice(8, 10)}:${value.slice(10, 12)}:${value.slice(12, 14)}Z`
  const parsed = Date.parse(iso)
  return Number.isNaN(parsed) ? Date.now() : parsed
}

function parseList(line) {
  const match = /^([dl-])([rwxStTs-]{9})\s+\d+\s+\S+\s+\S+\s+(\d+)\s+(\w{3}\s+\d+\s+[\d:]+)\s+(.*)$/.exec(line)
  if (match === null) return undefined
  const name = match[5].trim()
  if (name === '' || name === '.' || name === '..') return undefined
  // Unix LIST 的时间是服务端本地时间（不带时区），按本机时区解才和 fs.stat 对齐
  const parsed = Date.parse(`${match[4]} ${new Date().getFullYear()}`)
  return {
    name,
    isDirectory: match[1] === 'd',
    size: Number(match[3]) || 0,
    mtimeMs: Number.isNaN(parsed) ? Date.now() : parsed,
  }
}

/** Windows IIS 的 MS-DOS 格式：07-11-26  11:30PM       <DIR>          name */
function parseDosList(line) {
  const match = /^(\d{2})-(\d{2})-(\d{2})\s+(\d{1,2}):(\d{2})\s*([AP]M)\s+(<DIR>|\d+)\s+(.+)$/i.exec(line)
  if (match === null) return undefined
  const name = match[8].trim()
  if (name === '' || name === '.' || name === '..') return undefined
  let hour = Number(match[4]) % 12
  if (match[6].toUpperCase() === 'PM') hour += 12
  // IIS 的 MS-DOS 时间同样是服务端本地时间，不能用 Date.UTC 解，
  // 否则远端 mtime 会整体偏移一个时区，「谁新谁覆盖」就永远判成本地更新。
  const parsed = new Date(2000 + Number(match[3]), Number(match[1]) - 1, Number(match[2]), hour, Number(match[5])).getTime()
  const isDirectory = match[7].toUpperCase() === '<DIR>'
  return {
    name,
    isDirectory,
    size: isDirectory ? 0 : Number(match[7]) || 0,
    mtimeMs: Number.isNaN(parsed) ? Date.now() : parsed,
  }
}
