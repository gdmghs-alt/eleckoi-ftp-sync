/**
 * 恢复点：把「之前那份数据」找回来。
 *
 * 这里有两类恢复点，都躺在 `<appRoot>/eleckoi-sync/` 下面，只是来历不同：
 *
 * - `backups/<时间戳>/` —— 下载覆盖之前 `backupLocal()` 整份复制的现场。里面是
 *   逻辑名的相对路径（`dsh-runtime/sessions/...`、`media/...`、`eleckoi-common.sqlite3`）。
 * - `quarantine/<时间戳>/<项目目录>/` —— `consolidateSessions()` 判出「多余的项目目录」
 *   之后整目录挪走的现场。会话目录名是按 cwd 编码出来的，两台机器必然不同，所以
 *   归并时把不属于本机的那一支挪到这里，而不是直接删。
 *
 * 两类都要能读回来：第一类用于「同步把本机换坏了」，第二类用于「归并把我要的那支
 * 挪走了」。Android 上用户根本进不去 App 私有目录，所以这个入口是唯一的自救路径。
 *
 * 回滚只覆盖本机，不碰远端 —— 所以任何时候做都不至于把远端也搞坏。
 */

import fsp from 'node:fs/promises'
import path from 'node:path'

import { DB_FILE, SESSIONS_REL, SELF_PROJECT, canonicalRel, localPathFor } from './core.js'

const BACKUP_DIR = 'backups'
const QUARANTINE_DIR = 'quarantine'
const SESSION_PREFIX = `${SESSIONS_REL}/${SELF_PROJECT}/`

async function statSafe(target) {
  try {
    return await fsp.stat(target)
  } catch {
    return undefined
  }
}

async function walkFiles(root, current, out) {
  let entries
  try {
    entries = await fsp.readdir(current, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    const abs = path.join(current, entry.name)
    if (entry.isDirectory()) {
      await walkFiles(root, abs, out)
      continue
    }
    if (!entry.isFile()) continue
    const stat = await statSafe(abs)
    if (!stat) continue
    out.push({
      rel: path.relative(root, abs).replace(/\\/g, '/'),
      size: stat.size,
      mtimeMs: Math.round(stat.mtimeMs),
    })
  }
}

/**
 * 恢复点里的相对路径 → 同步用的逻辑名（canonical rel）。
 *
 * 备份里本来就是逻辑名，`canonicalRel` 顺手把残留的真实项目目录折成 `@self`。
 * 收容目录里没有 `dsh-runtime` 前缀，只有 `<项目目录>/<sessionId>/session.v4.jsonl`，
 * 所以丢掉第一段、其余拼到 `dsh-runtime/sessions/@self/` 后面。
 */
function toCanonicalRel(kind, rel) {
  if (kind === 'backup') return canonicalRel(rel)
  const segments = String(rel).split('/')
  if (segments.length < 2) return rel
  return `${SESSIONS_REL}/${SELF_PROJECT}/${segments.slice(1).join('/')}`
}

function sessionIdOf(canonical) {
  if (!canonical.startsWith(SESSION_PREFIX)) return undefined
  const rest = canonical.slice(SESSION_PREFIX.length)
  const slash = rest.indexOf('/')
  return slash === -1 ? undefined : rest.slice(0, slash)
}

async function describeSource(kind, id, dir, keep) {
  const files = []
  await walkFiles(dir, dir, files)
  const canonicals = files.map(item => ({ item, canonical: toCanonicalRel(kind, item.rel) }))
  const sessions = canonicals.map(entry => sessionIdOf(entry.canonical)).filter(Boolean)
  const db = files.find(item => item.rel === DB_FILE)
  const lastModified = files.reduce((max, item) => Math.max(max, item.mtimeMs), 0)
  return {
    kind,
    id,
    dir,
    files: files.length,
    bytes: files.reduce((sum, item) => sum + item.size, 0),
    hasDatabase: db !== undefined,
    databaseBytes: db ? db.size : 0,
    sessions: [...new Set(sessions)].sort(),
    lastModified: lastModified > 0 ? lastModified : undefined,
    truncated: files.length > keep ? undefined : undefined,
  }
}

async function listDirNames(root) {
  try {
    const entries = await fsp.readdir(root, { withFileTypes: true })
    return entries.filter(entry => entry.isDirectory()).map(entry => entry.name)
  } catch {
    return []
  }
}

/**
 * 列出所有恢复点。`items` 按时间倒序，每项：
 * `{kind: 'backup'|'quarantine', id, dir, files, bytes, hasDatabase, databaseBytes, sessions, lastModified}`
 *
 * 面板上直接据此渲染列表：`kind` 决定标题用「覆盖前备份」还是「归并时挪走的会话」。
 */
export async function listRestorePoints(metaDir, keep = 20) {
  if (!metaDir) return { backupsRoot: null, quarantineRoot: null, items: [] }
  const backupsRoot = path.join(metaDir, BACKUP_DIR)
  const quarantineRoot = path.join(metaDir, QUARANTINE_DIR)

  const items = []
  const backupNames = (await listDirNames(backupsRoot)).sort().reverse().slice(0, keep)
  for (const name of backupNames) {
    items.push(await describeSource('backup', name, path.join(backupsRoot, name), keep))
  }
  const quarantineNames = (await listDirNames(quarantineRoot)).sort().reverse().slice(0, keep)
  for (const name of quarantineNames) {
    items.push(await describeSource('quarantine', name, path.join(quarantineRoot, name), keep))
  }
  items.sort((a, b) => String(b.id).localeCompare(String(a.id)))
  return { backupsRoot, quarantineRoot, items }
}

function resolveSourceDir(metaDir, kind, id) {
  const base = kind === 'quarantine' ? QUARANTINE_DIR : BACKUP_DIR
  return path.join(metaDir, base, id)
}

/**
 * 把某个恢复点复制回本机。
 *
 * options:
 * - `appRoot` / `metaDir` / `layout`（调用方先 `resolveLayout()` 传进来，避免缓存不一致）
 * - `kind`：`'backup'` | `'quarantine'`，默认 `'backup'`
 * - `id`：恢复点目录名
 * - `sessionIds`：可选，只恢复这些会话 id（其余跳过）。用于「只把被挪走的那几场对话拿回来」
 * - `dryRun`：只算要动哪些文件，一个都不写
 * - `onProgress({restored, total, rel, target})`
 *
 * 返回 `{kind, id, dryRun, restored, skipped, items}`；每项
 * `{rel, canonical, target, action: 'restore' | 'skip', reason}`。
 *
 * 注意这是**单向覆盖本机**，不碰远端；只覆盖恢复点里存在的那部分文件，
 * 本机多出来的东西一律不动（避免误删）。
 */
export async function restorePoint(options) {
  const { appRoot, metaDir, layout } = options
  const kind = options.kind === 'quarantine' ? 'quarantine' : 'backup'
  const id = typeof options.id === 'string' ? options.id.trim() : ''
  const dryRun = options.dryRun === true
  const onProgress = typeof options.onProgress === 'function' ? options.onProgress : () => {}
  const onlySessions =
    Array.isArray(options.sessionIds) && options.sessionIds.length > 0
      ? new Set(options.sessionIds.map(String))
      : undefined

  if (!metaDir) throw new Error('找不到恢复点目录（metaDir 未确定）')
  if (id === '') throw new Error('没有指定要回滚哪个恢复点')

  const sourceDir = resolveSourceDir(metaDir, kind, id)
  const stat = await statSafe(sourceDir)
  if (!stat || !stat.isDirectory()) throw new Error(`恢复点不存在：${kind}/${id}`)

  const files = []
  await walkFiles(sourceDir, sourceDir, files)
  if (files.length === 0) throw new Error(`恢复点是空的：${kind}/${id}`)

  const items = []
  for (const item of files) {
    const canonical = toCanonicalRel(kind, item.rel)
    const backslash = canonical.replace(/\\/g, '/')

    // 会话锁是各机器各自打开会话时建的，内容是空的。搬回来只会让 Session
    // 以为「已经有别的进程占着」，所以恢复时一律跳过。
    if (/^session\.lock$/i.test(path.posix.basename(backslash))) {
      items.push({ rel: item.rel, canonical, target: null, action: 'skip', reason: '会话锁不需要恢复' })
      continue
    }

    if (onlySessions) {
      const sid = sessionIdOf(canonical)
      if (sid === undefined || !onlySessions.has(sid)) {
        items.push({ rel: item.rel, canonical, target: null, action: 'skip', reason: '不在指定的会话里' })
        continue
      }
    }

    // wal / shm 不是独立文件：回滚主库时必须跟着一起换，否则新库会被旧日志污染。
    if (/\.sqlite3-(wal|shm)$/i.test(backslash)) {
      const isDbSidecar = backslash === `${DB_FILE}-wal` || backslash === `${DB_FILE}-shm`
      if (isDbSidecar && layout && layout.db && layout.db.abs) {
        const suffix = backslash.endsWith('-wal') ? 'wal' : 'shm'
        items.push({ rel: item.rel, canonical, target: `${layout.db.abs}-${suffix}`, action: 'restore', reason: 'database sidecar' })
        continue
      }
      items.push({ rel: item.rel, canonical, target: null, action: 'skip', reason: '无主 wal/shm' })
      continue
    }

    const target = layout ? localPathFor(layout, canonical) : undefined
    if (!target) {
      items.push({ rel: item.rel, canonical, target: null, action: 'skip', reason: '本机布局里没有对应位置' })
      continue
    }
    items.push({ rel: item.rel, canonical, target, action: 'restore', reason: '' })
  }

  const restoreItems = items.filter(item => item.action === 'restore')
  const skipped = items.length - restoreItems.length
  if (dryRun) {
    return { kind, id, dryRun: true, restored: restoreItems.length, skipped, items }
  }

  // 主库放最前：Windows 上库被占用时 rename 会 EBUSY，先动它，失败立刻中止，
  // 别的文件一个都还没覆盖。Android/Linux 上顺序无所谓。
  const rank = item => (item.canonical === DB_FILE ? -1 : 0)
  restoreItems.sort((a, b) => rank(a) - rank(b))

  let restored = 0
  for (const item of restoreItems) {
    const from = path.join(sourceDir, item.rel)
    const incoming = `${item.target}.restoring`
    await fsp.mkdir(path.dirname(item.target), { recursive: true })
    await fsp.copyFile(from, incoming)
    await fsp.rm(item.target, { force: true }).catch(() => {})
    await fsp.rename(incoming, item.target)
    restored += 1
    await onProgress({ restored, total: restoreItems.length, rel: item.rel, target: item.target })
  }

  return { kind, id, dryRun: false, restored, skipped, appRoot, items }
}
