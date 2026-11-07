/**
 * 就地同步：不关程序、不 spawn 守护进程，直接在宿主进程里比对并搬运文件。
 *
 * 桌面端走 guardian（等 ElecKoi 退出后再替换，最安全）。Android 端是独立的
 * App，spawn 不起子进程，也没有「重启后接管」这套机制 —— 那条路上
 * 「同步并重启」点下去什么都不会发生。所以给一条纯进程内的备用路：
 *
 *   比对 → 下载远端较新的文件 → 就地替换 → 上传本地较新的文件
 *
 * 替换正在被打开的文件：Android/iOS 是 unlink + rename，旧进程继续用旧 inode，
 * 新进程读到新文件 —— 所以替换完必须让用户自己重开 App 才看得到新数据。
 * 桌面 Windows 上 rename 到被占用的文件会 EBUSY，那种情况请用「同步并重启」。
 */
import fsp from 'node:fs/promises'
import path from 'node:path'

import {
  DB_FILE,
  backupLocal,
  checkpointDatabase,
  clearWalShm,
  localPathFor,
  planSync,
  pruneBackups,
  resolveLayout,
  scanLocal,
  timestampSlug,
} from './core.js'
import { createDriver } from './drivers.js'

/**
 * @param {object} options
 * @param {string} options.appRoot    ElecKoi 数据根目录
 * @param {object} options.config     归一化后的配置（driver / ftp / localRemoteRoot / toleranceMs）
 * @param {string} [options.metaDir]  状态与备份目录，默认 <appRoot>/eleckoi-sync
 * @param {string} [options.statePath]
 * @param {string} [options.logPath]
 * @param {string} [options.deviceId]
 * @param {'both'|'download'|'upload'} [options.direction]
 * @param {(phase: string, patch: object) => void} [options.onPhase]
 */
export async function applyInPlace(options) {
  const appRoot = options.appRoot
  const config = options.config ?? {}
  const metaDir = options.metaDir ?? path.join(appRoot, 'eleckoi-sync')
  const statePath = options.statePath ?? path.join(metaDir, 'state.json')
  const deviceId = options.deviceId ?? null
  const direction = options.direction === 'download' || options.direction === 'upload' ? options.direction : 'both'
  const stamp = Date.now()
  const logPath = options.logPath ?? path.join(metaDir, 'logs', `inline-${stamp}.log`)
  const onPhase = typeof options.onPhase === 'function' ? options.onPhase : () => {}
  const toleranceMs = Number(config.toleranceMs) > 0 ? Number(config.toleranceMs) : 2000

  const log = async (message, extra) => {
    const line = `[${new Date().toISOString()}] ${message}${extra === undefined ? '' : ` ${JSON.stringify(extra)}`}\n`
    try {
      await fsp.mkdir(path.dirname(logPath), { recursive: true })
      await fsp.appendFile(logPath, line, 'utf8')
    } catch {
      // 日志失败不影响同步
    }
  }

  const writeState = async patch => {
    let current = {}
    try {
      current = JSON.parse(await fsp.readFile(statePath, 'utf8'))
    } catch {
      current = {}
    }
    const next = { ...current, ...patch, updatedAt: new Date().toISOString() }
    try {
      await fsp.mkdir(path.dirname(statePath), { recursive: true })
      await fsp.writeFile(statePath, JSON.stringify(next, null, 2), 'utf8')
    } catch {
      // 状态写不进去也不该中断搬运
    }
  }

  const result = { uploaded: 0, downloaded: 0, skipped: 0, backupDir: null, error: null, logPath, direction }
  await log('inline sync started', { appRoot, direction, platform: process.platform })

  let driver
  try {
    driver = await createDriver(config, message => void log(message))

    onPhase('scanning', {})
    await writeState({ phase: 'scanning', mode: 'inline', logPath })
    const checkpointed = await checkpointDatabase(appRoot, message => void log(message))
    if (checkpointed.ok) await log('database checkpointed (wal merged)')

    const layout = await resolveLayout(appRoot)
    await log('layout resolved', {
      db: layout.db.abs,
      dbExists: layout.db.exists,
      dirs: layout.dirs.map(item => `${item.rel} → ${item.abs}${item.exists ? '' : '（缺）'}`),
      files: layout.files.map(item => `${item.rel} → ${item.abs}${item.exists ? '' : '（缺）'}`),
    })

    const local = await scanLocal(appRoot)
    const remote = await driver.list()
    const plan = planSync(local, remote.files, toleranceMs)
    await log('plan ready', {
      uploads: plan.uploads.length,
      downloads: plan.downloads.length,
      skipped: plan.skipped.length,
      conflicts: plan.conflicts.length,
      uploadBytes: plan.uploadBytes,
      downloadBytes: plan.downloadBytes,
    })
    if (plan.conflicts.length > 0 && config.allowConflicts !== true) {
      const names = plan.conflicts.slice(0, 5).map(item => (typeof item === 'string' ? item : item.rel)).join(', ')
      throw new Error(
        `有 ${plan.conflicts.length} 个文件时间几乎相同但大小不同，无法判断谁更新，已停止以免覆盖：${names}。确认要以本地为准时，在插件配置里加 allowConflicts: true`,
      )
    }

    const downloads = direction === 'upload' ? [] : plan.downloads
    const uploads = direction === 'download' ? [] : plan.uploads
    result.skipped = plan.skipped.length

    // 主库先换：桌面 Windows 上库文件被占用时 rename 会 EBUSY，
    // 把它排在最前面，失败就立刻中止，别的文件一个都还没动。
    // Android/Linux 上 unlink 打开中的文件没问题，顺序不影响。
    downloads.sort((a, b) => (a.rel === DB_FILE ? -1 : 0) - (b.rel === DB_FILE ? -1 : 0))

    if (downloads.length > 0) {
      const backupDir = path.join(metaDir, 'backups', timestampSlug())
      const copied = await backupLocal(appRoot, backupDir)
      await log('backup created', { backupDir, copied })
      const pruned = await pruneBackups(path.join(metaDir, 'backups'), 5)
      if (pruned.length > 0) await log('old backups pruned', { pruned })
      result.backupDir = backupDir
      await writeState({ lastBackupDir: backupDir })
    }

    onPhase('applying', { downloads: downloads.length })
    await writeState({
      phase: 'applying',
      mode: 'inline',
      plan: {
        uploads: uploads.length,
        downloads: downloads.length,
        skipped: plan.skipped.length,
        conflicts: plan.conflicts.length,
      },
    })

    const applied = []
    for (const item of downloads) {
      const target = localPathFor(layout, item.rel)
      if (!target) {
        await log('跳过无法映射到本机路径的项', { rel: item.rel })
        continue
      }
      const incoming = `${target}.incoming`
      await fsp.mkdir(path.dirname(target), { recursive: true })
      await driver.get(item.rel, incoming)
      const stat = await fsp.stat(incoming)
      if (stat.size !== item.size) {
        throw new Error(`下载大小不一致：${item.rel} 期望 ${item.size}，实际 ${stat.size}`)
      }
      if (item.rel === DB_FILE) {
        // 主库被当前进程占着也要换：Android/Linux 上 unlink 后旧句柄还指向旧 inode，
        // 真正的读取发生在下次启动。旧的 -wal/-shm 必须一起清掉，
        // 否则新库会被上一份日志污染。
        const cleared = await clearWalShm(appRoot, layout)
        if (cleared && cleared.failed && cleared.failed.length > 0) {
          await log('wal/shm 未能删除（重启前请勿继续写入）', { failed: cleared.failed })
        }
      }
      await fsp.rm(target, { force: true }).catch(() => {})
      await fsp.rename(incoming, target)
      try {
        await fsp.utimes(target, new Date(), new Date(item.mtimeMs))
      } catch {
        // 时间设置失败不影响内容
      }
      applied.push(item.rel)
    }
    result.downloaded = applied.length
    await log('downloads applied', { count: applied.length })

    onPhase('uploading', { uploads: uploads.length })
    await writeState({ phase: 'uploading', mode: 'inline' })
    let uploaded = 0
    for (const item of uploads) {
      const source = localPathFor(layout, item.rel)
      if (!source) {
        await log('跳过无法映射到本机路径的项', { rel: item.rel })
        continue
      }
      await driver.put(source, item.rel)
      uploaded += 1
    }
    result.uploaded = uploaded
    await log('uploads finished', { count: uploaded })

    // manifest：下载过的用远端 meta（时间由远端给），其余用重扫的本地 meta。
    const manifestFiles = {}
    const replaced = new Set(applied)
    const refreshed = await scanLocal(appRoot)
    for (const [rel, meta] of refreshed) {
      if (replaced.has(rel)) continue
      manifestFiles[rel] = { size: meta.size, mtimeMs: meta.mtimeMs }
    }
    for (const item of downloads) {
      manifestFiles[item.rel] = { size: item.size, mtimeMs: item.mtimeMs }
    }
    await driver.putManifest({
      version: 1,
      updatedAt: new Date().toISOString(),
      device: deviceId,
      files: manifestFiles,
    })

    await writeState({
      phase: 'done',
      mode: 'inline',
      finishedAt: new Date().toISOString(),
      result: {
        uploaded,
        downloaded: applied.length,
        skipped: plan.skipped.length,
        backupDir: result.backupDir,
        error: null,
      },
    })
    await log('sync complete')
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    result.error = message
    await log('sync failed', { message, backupDir: result.backupDir })
    await writeState({
      phase: 'failed',
      mode: 'inline',
      finishedAt: new Date().toISOString(),
      result: { error: message, backupDir: result.backupDir },
    })
  } finally {
    if (driver) {
      try {
        await driver.close()
      } catch {
        // 忽略关闭错误
      }
    }
  }
  return result
}
