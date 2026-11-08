/**
 * 整体镜像：不再做「谁新谁覆盖」，只做两件事 ——
 *
 *   uploadAll()   —— 先清空 FTP 上那个目录，再把本地整份推上去
 *   downloadAll() —— 先清空本地这些数据，再把 FTP 整份拉回来
 *
 * 为什么换掉原来的双向比对：
 * 按 mtime 比大小在两端时钟/精度不一致时会反复判错（FTP 的 LIST 只到分钟），
 * 一旦判错就是「拿旧的盖掉新的」，而且现场没了。镜像没有这个问题 ——
 * 目标端是被完全替换的，不存在「谁更新」的判断。
 *
 * 代价是单向摧毁：上传会删掉 FTP 上的全部内容，下载会删掉本地全部同步范围。
 * 所以两边都留了后路：
 *   - 下载前先把本机整份备份到 eleckoi-sync/backups/<时间戳>/（可回滚）
 *   - 上传前先把本地清单和字节数算出来，算不出来就不动远端
 *   - 每个文件上传完都核对大小，不一致立刻中止并报出文件名
 */
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import {
  DB_FILE,
  backupLocal,
  checkpointDatabase,
  clearWalShm,
  localPathFor,
  pruneBackups,
  readSessionHeader,
  resolveLayout,
  scanLocal,
  sessionIdFromRel,
  sessionPathForHeader,
  sessionsRootOf,
  timestampSlug,
} from './core.js'
import { createDriver } from './drivers.js'

/**
 * 给主库做一份一致快照。
 *
 * 程序开着的时候主库被 SQLite 独占着，直接 copyFile 抄出来的可能是个「半页」
 * 状态（文件头里的页数比实际写完的少，或者 -wal 里的行还没落盘）。
 * `VACUUM INTO` 是 SQLite 自己保证原子性的整库导出：它拿共享锁读一遍，
 * 写出来的那份能直接用，不需要程序先退出。
 */
async function snapshotDatabase(dbAbs, log) {
  try {
    await fsp.access(dbAbs)
  } catch {
    return undefined
  }
  const target = path.join(os.tmpdir(), `eleckoi-snapshot-${process.pid}-${Date.now()}.sqlite3`)
  try {
    const { DatabaseSync } = await import('node:sqlite')
    const handle = new DatabaseSync(dbAbs, { readOnly: true })
    try {
      handle.exec('PRAGMA busy_timeout = 5000')
      handle.exec(`VACUUM INTO '${target.replace(/'/g, "''")}'`)
    } finally {
      handle.close()
    }
    return target
  } catch (error) {
    // 拿不到一致快照时退回 checkpoint + 直接读文件：比没有强，日志里留痕。
    await log('一致快照失败，退回直接读主库', { error: error instanceof Error ? error.message : String(error) })
    await checkpointDatabase(path.dirname(dbAbs), message => void log(message))
    return undefined
  }
}

/** 会话在本地可能有多份（旧版插件留下的两套项目目录），挑内容最全的那份上传。 */
async function buildSessionIndex(layout) {
  const root = sessionsRootOf(layout)
  const index = new Map()
  if (!root) return index
  let projects = []
  try {
    const entries = await fsp.readdir(root, { withFileTypes: true })
    projects = entries.filter(entry => entry.isDirectory() && !entry.name.startsWith('.')).map(entry => entry.name)
  } catch {
    return index
  }
  for (const project of projects) {
    const projectAbs = path.join(root, project)
    let segments = []
    try {
      const entries = await fsp.readdir(projectAbs, { withFileTypes: true })
      segments = entries.filter(entry => entry.isDirectory()).map(entry => entry.name)
    } catch {
      continue
    }
    for (const segment of segments) {
      const file = path.join(projectAbs, segment, 'session.v4.jsonl')
      let stat
      try {
        stat = await fsp.stat(file)
      } catch {
        continue
      }
      // 目录名未必可信（可能是历史遗留的错位目录），以 header 里的 id 为准。
      const header = await readSessionHeader(file)
      const id = header?.id || segment
      const current = index.get(id)
      const meta = { file, size: stat.size, mtimeMs: Math.round(stat.mtimeMs), header }
      if (current === undefined || meta.size > current.size
        || (meta.size === current.size && meta.mtimeMs > current.mtimeMs)) {
        index.set(id, meta)
      }
    }
  }
  return index
}

/**
 * 本地清单 → 可上传项。
 *
 * rel 用的是同步口径（会话那层是 `@self`），source 是本机真实路径。
 * 拿不到 source 的项直接跳过并记日志，不猜。
 */
async function collectLocalItems(appRoot, layout, sessions, log) {
  const scanned = await scanLocal(appRoot)
  const items = []
  let skipped = 0
  for (const [rel, meta] of scanned) {
    let source
    if (rel === DB_FILE) {
      source = layout.db.abs
    } else {
      const sessionId = sessionIdFromRel(rel)
      if (sessionId !== undefined) {
        const found = sessions.get(sessionId)
        source = found ? found.file : undefined
      } else {
        source = localPathFor(layout, rel)
      }
    }
    if (!source) {
      skipped += 1
      await log('跳过：本机找不到对应文件', { rel })
      continue
    }
    try {
      const stat = await fsp.stat(source)
      items.push({ rel, source, size: stat.size, mtimeMs: Math.round(stat.mtimeMs) })
    } catch {
      skipped += 1
      await log('跳过：文件读不到', { rel, source })
    }
  }
  // 大文件先传不对，主库排第一：库传坏了后面全白费。
  items.sort((a, b) => (a.rel === DB_FILE ? -1 : 0) - (b.rel === DB_FILE ? -1 : 0))
  return { items, skipped }
}

/**
 * 清空本机的同步范围（数据库 + 白名单目录 + 白名单文件）。
 *
 * 只删 INCLUDE_DIRS / INCLUDE_FILES / 主库，`eleckoi-sync`（配置、备份、日志）
 * 和用户自己的其它目录一概不动 —— 「清空本地」的意思是清掉会被覆盖的那部分，
 * 不是把数据根铲平。
 */
async function purgeLocal(appRoot, layout, log) {
  const removed = []
  const failed = []
  for (const dir of layout.dirs) {
    if (!dir.abs) continue
    try {
      await fsp.rm(dir.abs, { recursive: true, force: true })
      removed.push(dir.rel)
    } catch (error) {
      failed.push(`${dir.rel}: ${error?.code ?? error}`)
      await log('本地目录删不掉', { rel: dir.rel, error: String(error?.code ?? error) })
    }
  }
  for (const file of layout.files) {
    if (!file.abs) continue
    try {
      await fsp.rm(file.abs, { force: true })
      removed.push(file.rel)
    } catch (error) {
      failed.push(`${file.rel}: ${error?.code ?? error}`)
    }
  }
  // 主库放最后：连 -wal/-shm 一起清，否则新库会被上一份日志污染。
  const cleared = await clearWalShm(appRoot, layout)
  try {
    await fsp.rm(layout.db.abs, { force: true })
    removed.push(DB_FILE)
  } catch (error) {
    if (error?.code !== 'ENOENT') {
      failed.push(`${DB_FILE}: ${error?.code ?? error}`)
      await log('本地数据库删不掉（程序还开着？）', { error: String(error?.code ?? error) })
    }
  }
  return { removed, failed, wal: cleared }
}

/**
 * 上传：清空远端 → 整份推上去。
 *
 * @param {object} options
 * @param {string} options.appRoot
 * @param {object} options.config
 * @param {string} [options.metaDir]
 * @param {(progress: object) => void} [options.onProgress]
 */
export async function uploadAll(options) {
  const appRoot = options.appRoot
  const config = options.config ?? {}
  const metaDir = options.metaDir ?? path.join(appRoot, 'eleckoi-sync')
  const onProgress = typeof options.onProgress === 'function' ? options.onProgress : () => {}
  const logPath = options.logPath ?? path.join(metaDir, 'logs', `upload-${Date.now()}.log`)

  const log = async (message, extra) => {
    const line = `[${new Date().toISOString()}] ${message}${extra === undefined ? '' : ` ${JSON.stringify(extra)}`}\n`
    try {
      await fsp.mkdir(path.dirname(logPath), { recursive: true })
      await fsp.appendFile(logPath, line, 'utf8')
    } catch {
      // 日志失败不影响搬运
    }
  }

  const result = { mode: 'upload', uploaded: 0, skipped: 0, bytes: 0, purged: null, error: null, logPath }
  let driver
  let snapshot
  try {
    await log('upload started', { appRoot })
    onProgress({ phase: 'checkpoint' })
    // 先把 WAL 并进主库，否则最新写入的行只存在于 -wal 里，不会跟着上传。
    await checkpointDatabase(appRoot, message => void log(message))

    onProgress({ phase: 'scanning' })
    const layout = await resolveLayout(appRoot)
    const sessions = await buildSessionIndex(layout)
    const { items, skipped } = await collectLocalItems(appRoot, layout, sessions, log)
    result.skipped = skipped

    // 主库换成一份一致快照再传。程序开着时主库随时可能被写，直接读文件传上去的
    // 可能是「文件头说 100 页、实际只写满 87 页」的半页库；远端拿到那种库，
    // 拉回来打开就是 corrupt。快照在 tmp 里，传完即删。
    const dbItem = items.find(item => item.rel === DB_FILE)
    if (dbItem) {
      snapshot = await snapshotDatabase(layout.db.abs, log)
      if (snapshot !== undefined) {
        const stat = await fsp.stat(snapshot)
        dbItem.source = snapshot
        dbItem.size = stat.size
        await log('数据库已快照', { bytes: stat.size })
      }
    }
    const totalBytes = items.reduce((sum, item) => sum + item.size, 0)
    await log('local scan ready', { files: items.length, bytes: totalBytes, skipped })
    if (items.length === 0) throw new Error('本机没有可上传的文件（同步范围是空的），已中止，远端未改动')

    driver = await createDriver(config, message => void log(message))
    onProgress({ phase: 'purging', total: items.length, totalBytes })
    const purged = await driver.purgeAll()
    result.purged = purged
    await log('remote purged', purged)
    /**
     * 清不干净就不能往下传。
     *
     * 镜像是「远端 = 本地」的语义，删一半再传上去的话，远端会变成
     * 「旧的残留 + 新的这一份」的混合体，下次拉回来就是一堆本不该存在的文件，
     * 而且没有任何地方记录过它们。宁可在这一步停住，让用户去修权限。
     */
    if (Array.isArray(purged.failed) && purged.failed.length > 0) {
      throw new Error(`远端有 ${purged.failed.length} 个条目删不掉，已中止（远端只清空了一部分）：${purged.failed.slice(0, 5).join('；')}`)
    }

    onProgress({ phase: 'uploading', done: 0, total: items.length, bytes: 0, totalBytes })
    let done = 0
    let moved = 0
    for (const item of items) {
      await driver.put(item.source, item.rel)
      done += 1
      moved += item.size
      if (done % 10 === 0 || done === items.length) {
        await log('progress', { done, total: items.length, bytes: moved })
      }
      onProgress({ phase: 'uploading', done, total: items.length, bytes: moved, totalBytes, rel: item.rel })
    }
    result.uploaded = done
    result.bytes = moved

    // 远端清单按本地扫描结果写（大小 + 精确 mtime）。清空后重新写一遍，
    // 否则远端留着的那份是上一轮的形状，test 端点会报出对不上的条目数。
    const manifestFiles = {}
    for (const item of items) manifestFiles[item.rel] = { size: item.size, mtimeMs: item.mtimeMs }
    await driver.putManifest({
      version: 2,
      mode: 'mirror',
      updatedAt: new Date().toISOString(),
      device: options.deviceId ?? null,
      files: manifestFiles,
    })
    await log('upload complete', { uploaded: done, bytes: moved })
    onProgress({ phase: 'done', done, total: items.length, bytes: moved, totalBytes })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    result.error = message
    await log('upload failed', { message })
    onProgress({ phase: 'failed', error: message })
  } finally {
    if (driver) await driver.close().catch(() => {})
    if (snapshot !== undefined) await fsp.rm(snapshot, { force: true }).catch(() => {})
  }
  return result
}

/**
 * 下载：备份本机 → 清空本地 → 整份拉回来。
 *
 * 只能在 ElecKoi 关掉之后跑（守护进程里）：Windows 上主库被打开时连改名都做不到，
 * 更没法删了重建。在程序里直接跑，第一步删库就会 EBUSY。
 *
 * @param {object} options
 * @param {string} options.appRoot
 * @param {object} options.config
 * @param {string} [options.metaDir]
 * @param {(progress: object) => void} [options.onProgress]
 */
export async function downloadAll(options) {
  const appRoot = options.appRoot
  const config = options.config ?? {}
  const metaDir = options.metaDir ?? path.join(appRoot, 'eleckoi-sync')
  const onProgress = typeof options.onProgress === 'function' ? options.onProgress : () => {}
  const logPath = options.logPath ?? path.join(metaDir, 'logs', `download-${Date.now()}.log`)

  const log = async (message, extra) => {
    const line = `[${new Date().toISOString()}] ${message}${extra === undefined ? '' : ` ${JSON.stringify(extra)}`}\n`
    try {
      await fsp.mkdir(path.dirname(logPath), { recursive: true })
      await fsp.appendFile(logPath, line, 'utf8')
    } catch {
      // 日志失败不影响搬运
    }
  }

  const result = { mode: 'download', downloaded: 0, skipped: 0, bytes: 0, backupDir: null, error: null, logPath }
  let driver
  try {
    await log('download started', { appRoot })
    driver = await createDriver(config, message => void log(message))

    onProgress({ phase: 'scanning' })
    const remote = await driver.list()
    const entries = [...remote.files.entries()]
      .map(([rel, meta]) => ({ rel, size: meta.size, mtimeMs: meta.mtimeMs }))
    const totalBytes = entries.reduce((sum, item) => sum + item.size, 0)
    await log('remote scan ready', { files: entries.length, bytes: totalBytes })
    if (entries.length === 0) {
      throw new Error('远端是空的（没有可下载的文件），已中止，本机未改动')
    }

    // 备份必须在清空之前：清空之后本机什么都没了，备份是唯一退路。
    onProgress({ phase: 'backup', total: entries.length, totalBytes })
    const backupDir = path.join(metaDir, 'backups', timestampSlug())
    const copied = await backupLocal(appRoot, backupDir)
    result.backupDir = backupDir
    await log('backup created', { backupDir, copied })
    const pruned = await pruneBackups(path.join(metaDir, 'backups'), 5)
    if (pruned.length > 0) await log('old backups pruned', { pruned })

    onProgress({ phase: 'purging', total: entries.length, totalBytes })
    const layout = await resolveLayout(appRoot)
    const purged = await purgeLocal(appRoot, layout, log)
    await log('local purged', { removed: purged.removed, failed: purged.failed })
    if (purged.failed.length > 0) {
      throw new Error(`本机有文件删不掉，已中止（备份在 ${backupDir}）：${purged.failed.join('；')}`)
    }

    const sessionsRoot = sessionsRootOf(layout)
    let done = 0
    let moved = 0
    for (const item of entries) {
      const sessionId = sessionIdFromRel(item.rel)
      const isSession = sessionId !== undefined && sessionsRoot !== undefined
      let target
      let incoming
      if (isSession) {
        await fsp.mkdir(sessionsRoot, { recursive: true })
        incoming = path.join(sessionsRoot, `.incoming-${sessionId}.jsonl`)
      } else {
        target = localPathFor(layout, item.rel)
        if (!target) {
          result.skipped += 1
          await log('跳过：映射不到本机路径', { rel: item.rel })
          continue
        }
        await fsp.mkdir(path.dirname(target), { recursive: true })
        incoming = `${target}.incoming`
      }
      await driver.get(item.rel, incoming)
      const stat = await fsp.stat(incoming)
      if (stat.size !== item.size) {
        await fsp.rm(incoming, { force: true }).catch(() => {})
        throw new Error(`下载大小不一致：${item.rel} 期望 ${item.size}，实际 ${stat.size}`)
      }
      if (isSession) {
        // 会话落点必须由它自己的 header.cwd 决定：DSH 会拿真实路径跟
        // generationLogPath(header.cwd, header.id) 逐字比对，不一致就判整份 corrupt，
        // 界面表现为「打开失败 / sessions.retain: unknown session」。
        const header = await readSessionHeader(incoming)
        const expected = sessionPathForHeader(sessionsRoot, header)
        if (expected === undefined) {
          // 读不出 header 就别猜位置：留在 sessions 根下，至少不冒充某个项目的会话。
          result.skipped += 1
          await log('会话文件读不出 header，原样留下', { rel: item.rel, incoming })
          continue
        }
        target = expected
      }
      if (path.resolve(incoming) !== path.resolve(target)) {
        await fsp.mkdir(path.dirname(target), { recursive: true })
        await fsp.rm(target, { force: true }).catch(() => {})
        await fsp.rename(incoming, target)
      }
      try {
        await fsp.utimes(target, new Date(), new Date(item.mtimeMs))
      } catch {
        // 时间设置失败不影响内容
      }
      done += 1
      moved += item.size
      if (done % 10 === 0 || done === entries.length) {
        await log('progress', { done, total: entries.length, bytes: moved })
      }
      onProgress({ phase: 'downloading', done, total: entries.length, bytes: moved, totalBytes, rel: item.rel })
    }
    result.downloaded = done
    result.bytes = moved

    // 本地这份清单按远端记录写，方便下次打开面板核对。
    const manifestFiles = {}
    for (const item of entries) {
      if (sessionIdFromRel(item.rel) !== undefined) continue
      manifestFiles[item.rel] = { size: item.size, mtimeMs: item.mtimeMs }
    }
    const refreshed = await scanLocal(appRoot)
    for (const [rel, meta] of refreshed) {
      const sessionId = sessionIdFromRel(rel)
      if (sessionId !== undefined) {
        // 会话的键在远端是 @self，本机扫描已经是 @self，直接照抄
        manifestFiles[rel] = { size: meta.size, mtimeMs: meta.mtimeMs }
      }
    }
    await driver.putManifest({
      version: 2,
      mode: 'mirror',
      updatedAt: new Date().toISOString(),
      device: options.deviceId ?? null,
      files: manifestFiles,
    })
    await log('download complete', { downloaded: done, bytes: moved })
    onProgress({ phase: 'done', done, total: entries.length, bytes: moved, totalBytes })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    result.error = message
    await log('download failed', { message })
    onProgress({ phase: 'failed', error: message })
  } finally {
    if (driver) await driver.close().catch(() => {})
  }
  return result
}
