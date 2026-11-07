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
      const files = await (async () => {
        const scanned = new Map()
        await walkDir(absRoot, '.', scanned)
        return scanned
      })()
      if (manifest) {
        const fromManifest = manifestToMap(manifest)
        // manifest 优先，扫描结果补上 manifest 之外的残留文件
        for (const [rel, meta] of files) if (!fromManifest.has(rel)) fromManifest.set(rel, meta)
        return { files: fromManifest, hasManifest: true, updatedAt: manifest.updatedAt }
      }
      const cleaned = new Map()
      for (const [rel, meta] of files) if (rel !== MANIFEST_REL) cleaned.set(rel, meta)
      return { files: cleaned, hasManifest: false }
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
      out.set(rel, { size: entry.size || 0, mtimeMs: entry.mtimeMs || Date.now() })
    }
  }

  return {
    kind: 'ftp',
    describe: () => `FTP ${host}:${Number(ftp.port) || 21} ${root}`,
    async list() {
      const tmp = path.join(os.tmpdir(), `eleckoi-sync-manifest-${process.pid}.json`)
      try {
        await client.downloadTo(remote(MANIFEST_REL), tmp)
        const manifest = await readJsonFile(tmp)
        if (manifest) return { files: manifestToMap(manifest), hasManifest: true, updatedAt: manifest.updatedAt }
      } catch {
        logger('远端还没有 manifest，改为直接扫描目录')
      } finally {
        await fsp.rm(tmp, { force: true }).catch(() => {})
      }
      const scanned = new Map()
      await listTree('.', scanned)
      for (const rel of [...scanned.keys()]) if (rel === MANIFEST_REL) scanned.delete(rel)
      return { files: scanned, hasManifest: false }
    },
    async get(rel, destAbs) {
      await fsp.mkdir(path.dirname(destAbs), { recursive: true })
      await client.downloadTo(remote(rel), destAbs)
    },
    async put(srcAbs, rel) {
      const remotePath = remote(rel)
      const parent = path.posix.dirname(remotePath)
      await client.ensureDir(parent)
      await client.uploadFrom(srcAbs, remotePath)
    },
    async putManifest(manifest) {
      const tmp = path.join(os.tmpdir(), `eleckoi-sync-manifest-out-${process.pid}.json`)
      await fsp.writeFile(tmp, JSON.stringify(manifest, null, 2), 'utf8')
      try {
        await client.ensureDir(path.posix.dirname(remote(MANIFEST_REL)))
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
