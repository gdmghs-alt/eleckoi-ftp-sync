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
    this.closed = false
    this.features = new Set()
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
    return this
  }

  onData(chunk) {
    this.buffer += chunk
    for (;;) {
      const index = this.buffer.indexOf('\n')
      if (index < 0) return
      const line = this.buffer.slice(0, index).replace(/\r$/, '')
      this.buffer = this.buffer.slice(index + 1)
      const entry = this.pending[0]
      if (entry === undefined) continue
      if (entry.lines.length === 0) {
        const match = /^(\d{3})([ -])(.*)$/.exec(line)
        if (match === null) continue
        entry.code = Number(match[1])
        entry.lines.push(match[3])
        entry.multiline = match[2] === '-'
        if (!entry.multiline) this.settle()
        continue
      }
      entry.lines.push(line)
      if (/^\d{3} /.test(line)) this.settle()
    }
  }

  settle() {
    const entry = this.pending.shift()
    if (entry === undefined) return
    entry.resolve({ code: entry.code ?? 0, text: entry.lines.join('\n') })
  }

  readReply() {
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
    // IIS 的 MLSD 有时返回空表，所以两条都试，合并去重
    const mlsd = await this.withData(socket => collect(socket), `MLSD ${dir}`, true).catch(() => undefined)
    if (typeof mlsd === 'string' && mlsd.trim() !== '') texts.push(mlsd)
    if (texts.length === 0) {
      const listed = await this.withData(socket => collect(socket), `LIST -a ${dir}`, true).catch(() => undefined)
      if (typeof listed === 'string') texts.push(listed)
    }
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

  async ensureDir(dir) {
    const segments = dir.split('/').filter(segment => segment !== '' && segment !== '.')
    let current = dir.startsWith('/') ? '' : ''
    for (const segment of segments) {
      current += `/${segment}`
      const reply = await this.command(`MKD ${current}`)
      if (reply.code >= 400 && reply.code !== 550 && reply.code !== 521) {
        throw new Error(`FTP MKD 失败：${current} -> ${reply.code} ${reply.text}`)
      }
    }
  }

  async remove(remotePath) {
    const reply = await this.command(`DELE ${remotePath}`)
    if (reply.code === 550) return false
    if (reply.code >= 400) throw new Error(`FTP DELE 失败：${reply.code} ${reply.text}`)
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

function collect(socket) {
  return new Promise(resolve => {
    const chunks = []
    let settled = false
    const finish = () => {
      if (settled) return
      settled = true
      resolve(Buffer.concat(chunks).toString('utf8'))
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
  const parsed = Date.parse(`${match[4]} UTC`)
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
  const parsed = Date.UTC(2000 + Number(match[3]), Number(match[1]) - 1, Number(match[2]), hour, Number(match[5]))
  const isDirectory = match[7].toUpperCase() === '<DIR>'
  return {
    name,
    isDirectory,
    size: isDirectory ? 0 : Number(match[7]) || 0,
    mtimeMs: Number.isNaN(parsed) ? Date.now() : parsed,
  }
}
