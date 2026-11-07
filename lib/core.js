/**
 * 同步核心：扫描本地数据、比对远端清单、生成双向计划。
 * 这里不碰业务数据库内容，只做文件级的时间/大小比对。
 */
import fsp from 'node:fs/promises'
import path from 'node:path'

export const DB_FILE = 'eleckoi-common.sqlite3'

/** 参与同步的目录（相对 appRoot）。缓存、日志、插件依赖等一律不碰。 */
export const INCLUDE_DIRS = [
  'dsh-runtime/sessions',
  'dsh-runtime/home/attachments',
  'media',
  'author-scripts',
]

const SKIP_DIR_NAMES = new Set([
  'node_modules', '.plugin-manager', '.git', '.cache',
  'Cache', 'Code Cache', 'GPUCache', 'GrShaderCache', 'ShaderCache',
  'DawnGraphiteCache', 'DawnWebGPUCache', 'blob_storage',
  'Local Storage', 'Session Storage', 'logs', 'backups', 'staging', 'temp',
])

const SKIP_FILE_PATTERNS = [
  /^eleckoi-common\.sqlite3-(wal|shm)$/i,
  /\.bak-\d{8}-\d{6}$/i,
  /\.BACKUP-\d{8}-\d{4,6}\.sqlite3(?:-(?:shm|wal))?$/i,
  /\.broken-\d+$/i,
]

/** 由 DSH_HOME（<appRoot>/dsh-runtime/home）反推应用数据根目录。 */
export function resolveAppRoot(config) {
  if (config && typeof config.appRoot === 'string' && config.appRoot.trim() !== '') {
    return path.resolve(config.appRoot.trim())
  }
  const home = process.env.DSH_HOME
  if (!home) return undefined
  const resolved = path.resolve(home)
  if (path.basename(resolved).toLowerCase() !== 'home') return path.dirname(resolved)
  return path.dirname(path.dirname(resolved))
}

export function dbWalPaths(appRoot) {
  const db = path.join(appRoot, DB_FILE)
  return { db, wal: `${db}-wal`, shm: `${db}-shm` }
}

async function walk(absDir, relDir, out) {
  let entries
  try {
    entries = await fsp.readdir(absDir, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    if (entry.isSymbolicLink()) continue
    const rel = `${relDir}/${entry.name}`
    if (entry.isDirectory()) {
      if (SKIP_DIR_NAMES.has(entry.name)) continue
      await walk(path.join(absDir, entry.name), rel, out)
      continue
    }
    if (!entry.isFile()) continue
    if (SKIP_FILE_PATTERNS.some(pattern => pattern.test(entry.name))) continue
    try {
      const stat = await fsp.stat(path.join(absDir, entry.name))
      out.set(rel, { size: stat.size, mtimeMs: Math.round(stat.mtimeMs) })
    } catch {
      // 读取期间被删除或占用：跳过这一项，不影响整体
    }
  }
}

/** 本地清单：rel -> { size, mtimeMs } */
export async function scanLocal(appRoot) {
  const out = new Map()
  try {
    const stat = await fsp.stat(path.join(appRoot, DB_FILE))
    out.set(DB_FILE, { size: stat.size, mtimeMs: Math.round(stat.mtimeMs) })
  } catch {
    // 数据库还不存在（首次运行），其余目录仍可同步
  }
  for (const dir of INCLUDE_DIRS) {
    await walk(path.join(appRoot, dir), dir, out)
  }
  return out
}

const sumBytes = items => items.reduce((total, item) => total + (item.size ?? 0), 0)

/**
 * 双向计划：逐文件比较时间，谁新谁覆盖。
 * 大小相同且时间差在 tolerance 内视为一致。
 */
export function planSync(local, remote, toleranceMs = 2000) {
  const uploads = []
  const downloads = []
  const skipped = []
  const conflicts = []

  for (const [rel, localEntry] of local) {
    const remoteEntry = remote.get(rel)
    if (!remoteEntry) {
      uploads.push({ rel, ...localEntry, reason: 'remote-missing' })
      continue
    }
    const sameSize = localEntry.size === remoteEntry.size
    const sameTime = Math.abs(localEntry.mtimeMs - remoteEntry.mtimeMs) <= toleranceMs
    if (sameSize && sameTime) {
      skipped.push(rel)
      continue
    }
    if (localEntry.mtimeMs > remoteEntry.mtimeMs + toleranceMs) {
      uploads.push({ rel, ...localEntry, reason: 'local-newer', remoteMtimeMs: remoteEntry.mtimeMs })
    } else if (remoteEntry.mtimeMs > localEntry.mtimeMs + toleranceMs) {
      downloads.push({ rel, ...remoteEntry, reason: 'remote-newer', localMtimeMs: localEntry.mtimeMs })
    } else {
      // 时间几乎相同却大小不同：无法判断谁对，交给上层拦截，宁可不动也不覆盖
      conflicts.push({ rel, local: localEntry, remote: remoteEntry })
      skipped.push(rel)
    }
  }

  for (const [rel, remoteEntry] of remote) {
    if (!local.has(rel)) downloads.push({ rel, ...remoteEntry, reason: 'local-missing' })
  }

  return {
    uploads,
    downloads,
    skipped,
    conflicts,
    uploadBytes: sumBytes(uploads),
    downloadBytes: sumBytes(downloads),
  }
}

export function summarize(plan) {
  return {
    uploadCount: plan.uploads.length,
    downloadCount: plan.downloads.length,
    skippedCount: plan.skipped.length,
    conflictCount: plan.conflicts.length,
    uploadBytes: plan.uploadBytes,
    downloadBytes: plan.downloadBytes,
    sampleUploads: plan.uploads.slice(0, 8).map(item => item.rel),
    sampleDownloads: plan.downloads.slice(0, 8).map(item => item.rel),
  }
}

/** 把当前数据整份复制到备份目录，供应用失败时回滚。 */
export async function backupLocal(appRoot, targetDir) {
  await fsp.mkdir(targetDir, { recursive: true })
  const copied = []
  const db = path.join(appRoot, DB_FILE)
  try {
    await fsp.copyFile(db, path.join(targetDir, DB_FILE))
    copied.push(DB_FILE)
  } catch {
    // 没有数据库文件就跳过
  }
  // wal/shm 一并留档：替换数据库后它们会被删除，先保存才有据可查
  for (const suffix of ['-wal', '-shm']) {
    const from = `${db}${suffix}`
    try {
      const stat = await fsp.stat(from)
      if (stat.size > 0) {
        await fsp.copyFile(from, path.join(targetDir, `${DB_FILE}${suffix}`))
        copied.push(`${DB_FILE}${suffix}(${stat.size}B)`)
      }
    } catch {
      // 不存在就算了
    }
  }
  for (const dir of INCLUDE_DIRS) {
    const from = path.join(appRoot, dir)
    const to = path.join(targetDir, dir)
    try {
      await fsp.mkdir(path.dirname(to), { recursive: true })
      await fsp.cp(from, to, { recursive: true, force: true })
      copied.push(dir)
    } catch {
      // 目录不存在（例如还没产生附件）
    }
  }
  return copied
}

/** 覆盖数据库前必须清掉旧的 wal/shm，否则新库会被旧日志污染。 */
export async function clearWalShm(appRoot) {
  const { wal, shm } = dbWalPaths(appRoot)
  for (const file of [wal, shm]) {
    try {
      await fsp.rm(file, { force: true })
    } catch {
      // 忽略
    }
  }
}

export function timestampSlug(date = new Date()) {
  const pad = value => String(value).padStart(2, '0')
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`
}

/** 备份轮转：只保留最近 keep 份，返回被删掉的目录名。 */
export async function pruneBackups(backupRoot, keep = 5) {
  let entries
  try {
    entries = await fsp.readdir(backupRoot, { withFileTypes: true })
  } catch {
    return []
  }
  const dirs = entries.filter(entry => entry.isDirectory()).map(entry => entry.name).sort()
  const removed = []
  while (dirs.length > keep) {
    const name = dirs.shift()
    try {
      await fsp.rm(path.join(backupRoot, name), { recursive: true, force: true })
      removed.push(name)
    } catch {
      // 删除失败不影响本次同步
    }
  }
  return removed
}
