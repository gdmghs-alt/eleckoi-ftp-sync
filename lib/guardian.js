/**
 * 守护进程：在 ElecKoi 关闭后执行真正的替换。
 *
 * 流程：等主进程退出 → 备份 → 下载远端较新的文件并就地替换 → 上传本地较新的文件
 *      → 写远端 manifest 与本地状态 → 重新拉起 ElecKoi。
 *
 * 它以 `ELECTRON_RUN_AS_NODE=1` 由宿主插件启动，参数是 job JSON 的路径。
 */
import { spawn } from 'node:child_process'
import fsp from 'node:fs/promises'
import path from 'node:path'

import {
  DB_FILE,
  backupLocal,
  checkpointDatabase,
  clearWalShm,
  consolidateSessions,
  dbWalPaths,
  localPathFor,
  planSync,
  pruneBackups,
  resolveLayout,
  scanLocal,
  timestampSlug,
} from './core.js'
import { createDriver } from './drivers.js'

const jobPath = process.argv[2]
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

async function main() {
  if (!jobPath) throw new Error('缺少 job 参数')
  const jobText = (await fsp.readFile(jobPath, 'utf8')).replace(/^\uFEFF/, '')
  const job = JSON.parse(jobText)
  const logPath = job.logPath
  const statePath = job.statePath

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
    await fsp.mkdir(path.dirname(statePath), { recursive: true })
    await fsp.writeFile(statePath, JSON.stringify(next, null, 2), 'utf8')
  }

  await log('guardian started', { appRoot: job.appRoot, pid: job.pid })
  await writeState({ phase: 'waiting-exit', startedAt: new Date().toISOString(), guardianPid: process.pid })

  await waitForExit(job.pid, log)
  await waitForAppExit(job, log)
  await log('host process exited; settling')
  await sleep(2000)

  const toleranceMs = Number(job.config?.toleranceMs) > 0 ? Number(job.config.toleranceMs) : 2000
  const driver = await createDriver(job.config, message => void log(message))
  let plan
  let backupDir
  try {
    await writeState({ phase: 'scanning' })
    // 先把 WAL 合并进主库：否则最新那几条记录既不在主库里（没上传），
    // 也不在 -wal 里（白名单外），换到另一台机器上就消失了。
    const checkpointed = await checkpointDatabase(job.appRoot, message => void log(message))
    if (checkpointed.ok) await log('database checkpointed (wal merged)')
    const layout = await resolveLayout(job.appRoot)
    await log('layout resolved', {
      db: layout.db.abs,
      dbExists: layout.db.exists,
      selfProject: layout.selfProject,
    })
    // 本机若有多套项目目录（旧版插件把两台的 sessions 树互搬留下的），
    // 会话会被 DSH 判成 duplicate 直接整份拒绝加载。先并成一套。
    const merged = await consolidateSessions(layout, path.join(job.appRoot, 'eleckoi-sync'), (message, extra) =>
      void log(message, extra),
    )
    if (merged.moved > 0 || merged.quarantined.length > 0) {
      await log('sessions consolidated', { kept: merged.kept, moved: merged.moved, quarantined: merged.quarantined })
    }
    const local = await scanLocal(job.appRoot)
    const remote = await driver.list()
    plan = planSync(local, remote.files, toleranceMs)
    await log('plan ready', {
      uploads: plan.uploads.length,
      downloads: plan.downloads.length,
      skipped: plan.skipped.length,
      conflicts: plan.conflicts.length,
      uploadBytes: plan.uploadBytes,
      downloadBytes: plan.downloadBytes,
    })
    if (plan.conflicts.length > 0 && job.config?.allowConflicts !== true) {
      const names = plan.conflicts.slice(0, 5).map(item => (typeof item === 'string' ? item : item.rel)).join(', ')
      throw new Error(
        `有 ${plan.conflicts.length} 个文件时间几乎相同但大小不同，无法判断谁更新，已停止以免覆盖：${names}。确认要以本地为准时，在插件配置里加 allowConflicts: true`,
      )
    }
    await writeState({
      phase: 'applying',
      plan: {
        uploads: plan.uploads.length,
        downloads: plan.downloads.length,
        skipped: plan.skipped.length,
        conflicts: plan.conflicts.length,
      },
    })

    if (plan.downloads.length > 0) {
      backupDir = path.join(job.appRoot, 'eleckoi-sync', 'backups', timestampSlug())
      const copied = await backupLocal(job.appRoot, backupDir)
      await log('backup created', { backupDir, copied })
      const pruned = await pruneBackups(path.join(job.appRoot, 'eleckoi-sync', 'backups'), 5)
      if (pruned.length > 0) await log('old backups pruned', { pruned })
      await writeState({ lastBackupDir: backupDir })
    }

    const applied = []
    for (const item of plan.downloads) {
      const target = localPathFor(layout, item.rel)
      if (!target) {
        await log('skip unmapped rel', { rel: item.rel })
        continue
      }
      const incoming = `${target}.incoming`
      await fsp.mkdir(path.dirname(target), { recursive: true })
      await driver.get(item.rel, incoming)
      const stat = await fsp.stat(incoming)
      if (stat.size !== item.size) {
        throw new Error(`下载大小不一致：${item.rel} 期望 ${item.size}，实际 ${stat.size}`)
      }
      if (item.rel === DB_FILE) await clearWalShm(job.appRoot, layout)
      await fsp.rm(target, { force: true })
      await fsp.rename(incoming, target)
      try {
        await fsp.utimes(target, new Date(), new Date(item.mtimeMs))
      } catch {
        // 时间设置失败不影响内容
      }
      applied.push(item.rel)
    }
    await log('downloads applied', { count: applied.length })
    await writeState({ phase: 'uploading', downloaded: applied.length })

    let uploaded = 0
    for (const item of plan.uploads) {
      const source = localPathFor(layout, item.rel)
      if (!source) {
        await log('skip unmapped rel', { rel: item.rel })
        continue
      }
      await driver.put(source, item.rel)
      uploaded += 1
    }
    await log('uploads finished', { count: uploaded })

    const manifestFiles = {}
    const replaced = new Set(applied)
    const refreshed = await scanLocal(job.appRoot)
    for (const [rel, meta] of refreshed) {
      if (replaced.has(rel)) continue
      manifestFiles[rel] = { size: meta.size, mtimeMs: meta.mtimeMs }
    }
    for (const item of plan.downloads) {
      manifestFiles[item.rel] = { size: item.size, mtimeMs: item.mtimeMs }
    }
    await driver.putManifest({
      version: 1,
      updatedAt: new Date().toISOString(),
      device: job.deviceId ?? null,
      files: manifestFiles,
    })

    await writeState({
      phase: 'done',
      finishedAt: new Date().toISOString(),
      result: {
        uploaded,
        downloaded: applied.length,
        skipped: plan.skipped.length,
        backupDir: backupDir ?? null,
        error: null,
      },
    })
    await log('sync complete')
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    await log('sync failed', { message, backupDir: backupDir ?? null })
    await writeState({
      phase: 'failed',
      finishedAt: new Date().toISOString(),
      result: { error: message, backupDir: backupDir ?? null },
    })
  } finally {
    try {
      await driver.close()
    } catch {
      // 忽略关闭错误
    }
  }

  if (job.relaunch !== false) {
    await relaunch(job, log)
  }
}

async function waitForExit(pid, log) {
  if (!Number.isInteger(pid) || pid <= 0) return
  for (;;) {
    try {
      process.kill(pid, 0)
    } catch {
      return
    }
    await sleep(1000)
    void log
  }
}

/**
 * 等 ElecKoi 彻底放手数据库文件。
 *
 * job.pid 只是宿主里那个进程的 pid。窗口关掉后 Electron 可能还有渲染进程、
 * 工具进程在跑，数据库仍被占用 —— 这时替换主库会失败（EBUSY），或者更糟：
 * 被替换掉的库还挂在别人的句柄上，写进去的数据全丢。
 *
 * Windows 上被打开的文件改名会失败，所以「能改名」就是「没人占着」。
 * 最多等 3 分钟，超时就继续往下走（后面的 rename 会给出明确错误）。
 */
async function waitForAppExit(job, log) {
  const layout = await resolveLayout(job.appRoot)
  const { db } = dbWalPaths(job.appRoot, layout)
  const probe = `${db}.lockprobe`
  const deadline = Date.now() + 180000
  while (Date.now() < deadline) {
    try {
      await fsp.rename(db, probe)
      await fsp.rename(probe, db)
      return
    } catch (error) {
      if (error && error.code === 'ENOENT') return
      if (!(error && (error.code === 'EBUSY' || error.code === 'EPERM' || error.code === 'EACCES'))) {
        await log('db lock probe failed', { code: error?.code ?? null })
        return
      }
    }
    await sleep(1000)
  }
  await log('db still locked after 180s; going ahead')
}

async function relaunch(job, log) {
  const execPath = job.execPath
  if (typeof execPath !== 'string' || execPath === '') {
    await log('no execPath; skip relaunch')
    return
  }
  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  try {
    const child = spawn(execPath, [], {
      cwd: path.dirname(execPath),
      detached: true,
      stdio: 'ignore',
      windowsHide: false,
      env,
    })
    child.unref()
    await log('relaunched ElecKoi', { execPath })
  } catch (error) {
    await log('relaunch failed', { message: error instanceof Error ? error.message : String(error) })
  }
}

main().catch(async error => {
  try {
    await fsp.appendFile(
      path.join(path.dirname(jobPath), 'guardian-crash.log'),
      `[${new Date().toISOString()}] ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`,
      'utf8',
    )
  } catch {
    // 最后兜底失败也无法记录
  }
  process.exit(1)
})
