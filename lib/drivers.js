/**
 * 远端驱动：local（本地目录模拟）与 ftp（真实 FTP / FTPS）。
 *
 * 双方都以 `.eleckoi-sync/manifest.json` 作为“远端真值”：里面记录每个文件的
 * 大小与原始修改时间。这样传输时不需要依赖 FTP 服务器对 mtime 的精度
 * （很多服务器只到分钟，甚至不保留），比对结果才稳定。
 */
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { FtpClient } from './ftp.js'
import { canonicalizeWithSource, isSyncedRel, SELF_PROJECT } from './core.js'

export const MANIFEST_REL = '.eleckoi-sync/manifest.json'
const SKIP_NAMES = new Set(['.eleckoi-sync'])
/** 远端遗留项目目录的收容处，见 retireLegacySessionDirs()。 */
const REMOTE_QUARANTINE = '.eleckoi-sync/remote-quarantine'

async function walkDir(root, relDir, out) {
  let entries
  try {
    entries = await fsp.readdir(path.join(root, relDir === '.' ? '' : relDir), { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    if (entry.isSymbolicLink()) continue
    const rel = relDir === '.' ? entry.name : `${relDir}/${entry.name}`
    if (entry.isDirectory()) {
      if (SKIP_NAMES.has(entry.name)) continue
      await walkDir(root, rel, out)
      continue
    }
    if (!entry.isFile()) continue
    try {
      const stat = await fsp.stat(path.join(root, rel))
      out.set(rel, { size: stat.size, mtimeMs: Math.round(stat.mtimeMs) })
    } catch {
      // 跳过读不到的项
    }
  }
}

async function readJsonFile(file) {
  try {
    return JSON.parse((await fsp.readFile(file, 'utf8')).replace(/^\uFEFF/, ''))
  } catch {
    return undefined
  }
}

function manifestToMap(manifest) {
  const map = new Map()
  const files = manifest && typeof manifest.files === 'object' && manifest.files !== null ? manifest.files : {}
  for (const [rel, meta] of Object.entries(files)) {
    if (!meta || typeof meta !== 'object') continue
    if (typeof meta.size !== 'number' || typeof meta.mtimeMs !== 'number') continue
    map.set(rel, { size: meta.size, mtimeMs: meta.mtimeMs })
  }
  // manifest 里也存着历史的两套项目目录键，一并折成 @self，
  // 否则折过的扫描结果跟它对不上，精度丢失后每轮都会重传一遍会话文件。
  return canonicalizeWithSource(map).files
}

/**
 * 以「磁盘上实际有什么」为准，用 manifest 只补 mtime 的精度。
 *
 * manifest 存的是上传那一刻本地的精确 mtime —— 这是必要的，因为 FTP 的 LIST
 * 只精确到分钟，直接比 mtime 会让每个文件都看起来「本地更新」，每轮全量重传。
 *
 * 但文件被别处改过（手工往 FTP 拖一个、另一台机器覆盖过）时，manifest 就过期了：
 * 以前整份信 manifest，那种改动会被当成「一致」永远不下载。所以这里拿扫描结果
 * 做骨架 —— 大小对不上就以扫描结果为准，manifest 只在大小时才沿用它的 mtime。
 * manifest 里有、磁盘上没有的条目一律丢弃（文件已经被删了）。
 */
function mergeManifest(scanned, manifest) {
  if (!manifest) return { files: scanned, hasManifest: false }
  const fromManifest = manifestToMap(manifest)
  const files = new Map()
  for (const [rel, meta] of scanned) {
    const known = fromManifest.get(rel)
    if (known !== undefined && known.size === meta.size) {
      files.set(rel, { size: meta.size, mtimeMs: known.mtimeMs })
    } else {
      files.set(rel, meta)
    }
  }
  return { files, hasManifest: true, updatedAt: manifest.updatedAt }
}

/* ─────────────────────────── local ─────────────────────────── */

function createLocalDriver(config) {
  const root = typeof config?.localRemoteRoot === 'string' ? config.localRemoteRoot.trim() : ''
  if (root === '') throw new Error('driver=local 时需要填写 localRemoteRoot（用来模拟 FTP 目录）')
  const absRoot = path.resolve(root)
  /** canonical rel → 远端磁盘上真实的 rel（两套项目目录折叠后可能对不上） */
  const sources = new Map()

  return {
    kind: 'local',
    describe: () => `本地目录 ${absRoot}`,
    async list() {
      const manifest = await readJsonFile(path.join(absRoot, MANIFEST_REL))
      const scanned = new Map()
      await walkDir(absRoot, '.', scanned)
      for (const rel of [...scanned.keys()]) if (rel === MANIFEST_REL || isSyncedRel(rel) === false) scanned.delete(rel)
      const canonical = canonicalizeWithSource(scanned)
      sources.clear()
      for (const [key, actual] of canonical.source) sources.set(key, actual)
      return mergeManifest(canonical.files, manifest)
    },
    async get(rel, destAbs) {
      await fsp.mkdir(path.dirname(destAbs), { recursive: true })
      await fsp.copyFile(path.join(absRoot, sources.get(rel) ?? rel), destAbs)
    },
    async put(srcAbs, rel) {
      const target = path.join(absRoot, rel)
      await fsp.mkdir(path.dirname(target), { recursive: true })
      await fsp.copyFile(srcAbs, target)
    },
    async putManifest(manifest) {
      const target = path.join(absRoot, MANIFEST_REL)
      await fsp.mkdir(path.dirname(target), { recursive: true })
      await fsp.writeFile(target, JSON.stringify(manifest, null, 2), 'utf8')
    },
    /**
     * 清空远端（这里是本地目录）：删掉根下所有条目，只留 `.eleckoi-sync`。
     *
     * 镜像上传是「远端整片换成本地」，「整片」指的是同步范围里的那部分；
     * 清单目录必须留下 —— 下一次 test 要读它，而且它也是「远端曾经是什么」的唯一记录。
     */
    async purgeAll() {
      const removed = []
      let entries
      try {
        entries = await fsp.readdir(absRoot, { withFileTypes: true })
      } catch {
        return { removed: [], failed: [] }
      }
      for (const entry of entries) {
        if (entry.name === '.eleckoi-sync') continue
        const abs = path.join(absRoot, entry.name)
        try {
          await fsp.rm(abs, { recursive: true, force: true })
          removed.push(entry.name)
        } catch (error) {
          return { removed, failed: [`${entry.name}: ${error?.code ?? error}`] }
        }
      }
      return { removed, failed: [] }
    },
    async close() {},
  }
}

/* ──────────────────────────── ftp ──────────────────────────── */

async function createFtpDriver(config, logger) {
  const ftp = config?.ftp ?? {}
  const host = typeof ftp.host === 'string' ? ftp.host.trim() : ''
  const user = typeof ftp.user === 'string' ? ftp.user : ''
  const password = typeof ftp.password === 'string' ? ftp.password : ''
  if (host === '') throw new Error('driver=ftp 时需要填写 ftp.host')

  const client = new FtpClient({
    host,
    port: Number(ftp.port) > 0 ? Number(ftp.port) : 21,
    user,
    password,
    // 超时全部显式传下来：默认值只写在 FtpClient 里，不传就永远用默认，
    // 面板上也没法调。手机走错网段时连接超时快失败，比等 30 秒强。
    connectTimeoutMs: Number(ftp.connectTimeoutMs) > 0 ? Number(ftp.connectTimeoutMs) : undefined,
    timeoutMs: Number(ftp.timeoutMs) > 0 ? Number(ftp.timeoutMs) : undefined,
    dataTimeoutMs: Number(ftp.dataTimeoutMs) > 0 ? Number(ftp.dataTimeoutMs) : undefined,
  })
  await client.connect()
  const root = (typeof ftp.remoteRoot === 'string' && ftp.remoteRoot.trim() !== '' ? ftp.remoteRoot.trim() : '/eleckoi').replace(/\/+$/, '') || '/'
  const remote = rel => (root === '/' ? `/${rel}` : `${root}/${rel}`)
  /** canonical rel → 远端磁盘上真实的 rel（两套项目目录折叠后可能对不上） */
  const sources = new Map()

  /**
   * 远端根目录不存在时自己建，不报错。
   *
   * 这里不能只看 MKD 的返回码：IIS 对已存在的目录也回 550，对父目录缺失回 550，
   * 两者没法用返回码分辨。所以建完再列一次目录确认，列得出来才算就绪；
   * 只有「建也建不出、列也列不出」才把错误抛出去（那时后面 STOR 一定失败，
   * 早点报比传到一半失败好）。
   */
  async function ensureRoot() {
    if (root === '/') return
    try {
      await client.list(root)
      return
    } catch {
      // 目录不存在或不可列，往下走建一遍
    }
    const made = await client.ensureDir(root)
    if (made.created.length > 0) {
      logger(`远端目录已创建 ${made.created.join(' ')}`)
    }
    try {
      await client.list(root)
    } catch (error) {
      const detail = made.failed.length > 0 ? ` 建目录返回：${made.failed.map(item => `${item.path}=${item.code ?? item.error}`).join(', ')}` : ''
      throw new Error(`远端目录 ${root} 不存在也建不出来：${error instanceof Error ? error.message : String(error)}${detail}`)
    }
  }
  await ensureRoot()

  /**
   * 服务端拒绝写这个路径。
   *
   * IIS 的文案是 `550 Access is denied. / Win32 error: Access is denied. /
   * Error details: File system denied the access.`，别的服务端可能只说 550。
   * 这里只认「明确是权限」的措辞，不把所有 550 都当只读 —— 目录不存在、
   * 磁盘满也是 550，那些靠改名救不回来。
   */
  function isAccessDenied(error) {
    const message = error instanceof Error ? error.message : String(error)
    return /550/.test(message) && /access is denied|permission denied|denied the access/i.test(message)
  }

  /**
   * 把挡路的远端文件挪进 `.eleckoi-sync/trash/`，返回新路径。
   *
   * 只能挪，不能删：只读文件的 DELE 同样是 550。挪走之后原路径就空了，
   * 新文件才写得进去。挪不动时返回 undefined，把原始错误留给调用方抛。
   */
  async function moveAside(remotePath) {
    const trashDir = `${root}/.eleckoi-sync/trash`
    const target = `${trashDir}/${Date.now()}-${path.posix.basename(remotePath)}`
    try {
      const made = await client.ensureDir(trashDir)
      if (made.created.length > 0) logger(`远端目录已创建 ${made.created.join(' ')}`)
      await client.rename(remotePath, target)
      return target
    } catch {
      return undefined
    }
  }

  /** 写一个远端文件；被只读挡住时挪开旧文件再写一次。 */
  async function putFileOrReplaceReadonly(srcAbs, remotePath) {
    try {
      await client.uploadFrom(srcAbs, remotePath)
      return
    } catch (error) {
      if (!isAccessDenied(error)) throw error
      const moved = await moveAside(remotePath)
      if (moved === undefined) throw error
      logger(`远端文件只读，已挪到 ${moved}`)
      await client.uploadFrom(srcAbs, remotePath)
    }
  }

  async function listTree(relDir, out) {
    // 这里不再把错误吞成「空目录」：列不出来就让它抛。吞掉的后果是远端看起来
    // 什么都没有，planSync 会把本地全部判成 remote-missing 重传一遍 ——
    // 白白跑几十分钟，还可能在半路把远端写乱。
    const entries = await client.list(relDir === '.' ? root : remote(relDir))
    for (const entry of entries) {
      if (entry.name === '.' || entry.name === '..') continue
      const rel = relDir === '.' ? entry.name : `${relDir}/${entry.name}`
      if (entry.isDirectory) {
        if (SKIP_NAMES.has(entry.name)) continue
        await listTree(rel, out)
        continue
      }
      // 远端是整棵树，只收白名单目录里的文件；否则对方目录里的杂物
      // 会被当成「本地缺失」下载进来。
      if (!isSyncedRel(rel)) continue
      out.set(rel, { size: entry.size || 0, mtimeMs: entry.mtimeMs || Date.now() })
    }
  }

  /**
   * 把远端 `dsh-runtime/sessions/<机器名>/` 这些历史遗留目录挪进收容区。
   *
   * 上一版插件把会话树按路径镜像，远端于是同时有电脑的 `--D-...--` 和手机的
   * `--data-user-10-...--`，同一个 sessionId 出现两条记录。折叠成 `@self` 之后逻辑上
   * 只剩一份，但物理上那两套还躺在远端：不挪走的话，下一个上传的客户端随时会把
   * 旧那份当成「远端较新」下载回来，duplicate 又回来了。挪进 trash 一类的收容区，
   * 需要翻旧账还能找到，同时不再参与比对。
   */
  async function retireLegacySessionDirs(scanned) {
    const sessionsRel = 'dsh-runtime/sessions'
    let entries
    try {
      entries = await client.list(remote(sessionsRel))
    } catch {
      return 0
    }
    const legacy = entries
      .filter(entry => entry.isDirectory && entry.name !== SELF_PROJECT && !entry.name.startsWith('.'))
      .map(entry => entry.name)
    if (legacy.length === 0) return 0
    const stamp = String(Date.now())
    let retired = 0
    for (const name of legacy) {
      const to = `${root}/${REMOTE_QUARANTINE}/${stamp}/${name}`
      try {
        const made = await client.ensureDir(path.posix.dirname(to))
        if (made.created.length > 0) logger(`远端目录已创建 ${made.created.join(' ')}`)
        await client.rename(remote(`${sessionsRel}/${name}`), to)
        retired += 1
        logger(`远端遗留的会话目录 ${name} 已挪到 ${REMOTE_QUARANTINE}`)
      } catch (error) {
        // 挪不动就别管它，折叠逻辑仍能保证只认一份，只是多占点空间。
        logger(`远端会话目录 ${name} 挪不动`, { error: error instanceof Error ? error.message : String(error) })
      }
    }
    if (retired > 0) {
      // 挪完那段路径变了，把扫描结果里对应的项丢掉重新扫一遍，别拿旧键比对。
      for (const key of [...scanned.keys()]) {
        if (key === sessionsRel || key.startsWith(`${sessionsRel}/`)) scanned.delete(key)
      }
      await listTree(sessionsRel, scanned)
    }
    return retired
  }

  return {
    kind: 'ftp',
    describe: () => `FTP ${host}:${Number(ftp.port) || 21} ${root}`,
    async list() {
      const tmp = path.join(os.tmpdir(), `eleckoi-sync-manifest-${process.pid}.json`)
      const scanned = new Map()
      await listTree('.', scanned)
      for (const rel of [...scanned.keys()]) if (rel === MANIFEST_REL) scanned.delete(rel)
      const retired = await retireLegacySessionDirs(scanned)
      if (retired > 0) logger(`远端遗留会话目录已收容 ${retired} 个`)
      let manifest
      try {
        await client.downloadTo(remote(MANIFEST_REL), tmp)
        manifest = await readJsonFile(tmp)
      } catch {
        logger('远端还没有 manifest，按目录内容比对')
      } finally {
        await fsp.rm(tmp, { force: true }).catch(() => {})
      }
      // 远端可能还留着上一版写的两套项目目录（电脑一套、手机一套）。
      // 折叠成 @self 之后逻辑上只剩一份，同时记住各自真实路径，下载时才有处可读。
      const canonical = canonicalizeWithSource(scanned)
      sources.clear()
      for (const [key, actual] of canonical.source) sources.set(key, actual)
      return mergeManifest(canonical.files, manifest)
    },
    async get(rel, destAbs) {
      await fsp.mkdir(path.dirname(destAbs), { recursive: true })
      const actual = sources.get(rel) ?? rel
      await client.downloadTo(remote(actual), destAbs)
    },
    async put(srcAbs, rel) {
      // 写出去时 @self 直接照原样落盘：远端不再按机器名分目录，
      // 两台都往 `dsh-runtime/sessions/@self/<sid>/` 写，永远只有一份。
      const remotePath = remote(rel)
      const parent = path.posix.dirname(remotePath)
      const made = await client.ensureDir(parent)
      if (made.created.length > 0) logger(`远端目录已创建 ${made.created.join(' ')}`)
      await putFileOrReplaceReadonly(srcAbs, remotePath)
    },
    async putManifest(manifest) {
      const tmp = path.join(os.tmpdir(), `eleckoi-sync-manifest-out-${process.pid}.json`)
      await fsp.writeFile(tmp, JSON.stringify(manifest, null, 2), 'utf8')
      try {
        const made = await client.ensureDir(path.posix.dirname(remote(MANIFEST_REL)))
        if (made.created.length > 0) logger(`远端目录已创建 ${made.created.join(' ')}`)
        await client.uploadFrom(tmp, remote(MANIFEST_REL))
      } finally {
        await fsp.rm(tmp, { force: true }).catch(() => {})
      }
    },
    /**
     * 清空远端根目录下的全部内容，只留 `.eleckoi-sync`（manifest 与回收站的家）。
     *
     * 顺序必须是「先删文件、后删目录」：IIS 的 RMD 对非空目录回 550，跟「目录不存在」
     * 同一个码，分不出来；所以自下而上走一遍，删不掉的目录最后再试一次。
     *
     * `.eleckoi-sync` 里的 trash / remote-quarantine 也一起清 —— 那是上一版为了绕开
     * 只读文件攒下来的垃圾，镜像上传之后它们没有任何用处，留着只会越滚越大。
     */
    async purgeAll() {
      const removed = []
      const failed = []

      const purgeNode = async (relPath, isDir) => {
        const abs = relPath === '' ? root : remote(relPath)
        if (!isDir) {
          try {
            await client.remove(abs)
            removed.push(relPath)
          } catch (error) {
            failed.push(`${relPath}: ${error instanceof Error ? error.message : String(error)}`)
          }
          return
        }
        let entries
        try {
          entries = await client.list(abs)
        } catch {
          // 列不出来就别动了，报上去让上层中止（宁可不上传，也别把远端删一半）
          failed.push(`${relPath}: 列目录失败`)
          return
        }
        for (const entry of entries) {
          if (entry.name === '.' || entry.name === '..') continue
          const childRel = relPath === '' ? entry.name : `${relPath}/${entry.name}`
          await purgeNode(childRel, entry.isDirectory === true)
        }
        try {
          const empty = await client.rmdir(abs)
          if (empty) removed.push(`${relPath}/`)
          else failed.push(`${relPath}/: 目录删不掉（可能非空或只读）`)
        } catch (error) {
          failed.push(`${relPath}/: ${error instanceof Error ? error.message : String(error)}`)
        }
      }

      let top
      try {
        top = await client.list(root)
      } catch (error) {
        return { removed, failed: [`${root}: ${error instanceof Error ? error.message : String(error)}`] }
      }
      for (const entry of top) {
        if (entry.name === '.' || entry.name === '..') continue
        if (entry.name === '.eleckoi-sync') continue
        await purgeNode(entry.name, entry.isDirectory === true)
        if (failed.length > 0) return { removed, failed }
      }

      // 回收站与旧收容区一起清空，但保留 .eleckoi-sync 本身和里面的 manifest。
      for (const sub of ['trash', 'remote-quarantine']) {
        const relPath = `.eleckoi-sync/${sub}`
        let entries
        try {
          entries = await client.list(remote(relPath))
        } catch {
          continue
        }
        const purgeInner = async (dirRel) => {
          let list
          try {
            list = await client.list(remote(dirRel))
          } catch {
            return
          }
          for (const entry of list) {
            if (entry.name === '.' || entry.name === '..') continue
            const childRel = `${dirRel}/${entry.name}`
            if (entry.isDirectory) {
              await purgeInner(childRel)
              await client.rmdir(remote(childRel)).catch(() => {})
            } else {
              await client.remove(remote(childRel)).catch(() => {})
            }
          }
        }
        await purgeInner(relPath)
        void entries
      }

      return { removed, failed }
    },
    async close() {
      await client.close()
    },
  }
}

export async function createDriver(config, logger = () => {}) {
  const driver = config?.driver === 'ftp' ? 'ftp' : 'local'
  return driver === 'ftp' ? createFtpDriver(config, logger) : createLocalDriver(config)
}
