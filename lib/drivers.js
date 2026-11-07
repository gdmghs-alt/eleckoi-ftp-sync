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
import { isSyncedRel } from './core.js'

export const MANIFEST_REL = '.eleckoi-sync/manifest.json'
const SKIP_NAMES = new Set(['.eleckoi-sync'])

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
  return map
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

  return {
    kind: 'local',
    describe: () => `本地目录 ${absRoot}`,
    async list() {
      const manifest = await readJsonFile(path.join(absRoot, MANIFEST_REL))
      const scanned = new Map()
      await walkDir(absRoot, '.', scanned)
      for (const rel of [...scanned.keys()]) if (rel === MANIFEST_REL || isSyncedRel(rel) === false) scanned.delete(rel)
      return mergeManifest(scanned, manifest)
    },
    async get(rel, destAbs) {
      await fsp.mkdir(path.dirname(destAbs), { recursive: true })
      await fsp.copyFile(path.join(absRoot, rel), destAbs)
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
  })
  await client.connect()
  const root = (typeof ftp.remoteRoot === 'string' && ftp.remoteRoot.trim() !== '' ? ftp.remoteRoot.trim() : '/eleckoi').replace(/\/+$/, '') || '/'
  const remote = rel => (root === '/' ? `/${rel}` : `${root}/${rel}`)

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

  async function listTree(relDir, out) {
    let entries
    try {
      entries = await client.list(relDir === '.' ? root : remote(relDir))
    } catch {
      return
    }
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

  return {
    kind: 'ftp',
    describe: () => `FTP ${host}:${Number(ftp.port) || 21} ${root}`,
    async list() {
      const tmp = path.join(os.tmpdir(), `eleckoi-sync-manifest-${process.pid}.json`)
      const scanned = new Map()
      await listTree('.', scanned)
      for (const rel of [...scanned.keys()]) if (rel === MANIFEST_REL) scanned.delete(rel)
      let manifest
      try {
        await client.downloadTo(remote(MANIFEST_REL), tmp)
        manifest = await readJsonFile(tmp)
      } catch {
        logger('远端还没有 manifest，按目录内容比对')
      } finally {
        await fsp.rm(tmp, { force: true }).catch(() => {})
      }
      return mergeManifest(scanned, manifest)
    },
    async get(rel, destAbs) {
      await fsp.mkdir(path.dirname(destAbs), { recursive: true })
      await client.downloadTo(remote(rel), destAbs)
    },
    async put(srcAbs, rel) {
      const remotePath = remote(rel)
      const parent = path.posix.dirname(remotePath)
      const made = await client.ensureDir(parent)
      if (made.created.length > 0) logger(`远端目录已创建 ${made.created.join(' ')}`)
      await client.uploadFrom(srcAbs, remotePath)
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
    async close() {
      await client.close()
    },
  }
}

export async function createDriver(config, logger = () => {}) {
  const driver = config?.driver === 'ftp' ? 'ftp' : 'local'
  return driver === 'ftp' ? createFtpDriver(config, logger) : createLocalDriver(config)
}
