/**
 * 守护进程：在 ElecKoi 完全退出后执行「下载镜像」。
 *
 * 为什么下载必须退出程序才能做：Windows 上主库被打开着时连 rename 都会失败
 * （EBUSY），而下载的第一步就是把这个库删掉重建 —— 在宿主进程里做只会撞锁。
 * 上传不需要它（上传只读本地、写远端），所以上传是就地跑的，不走这里。
 *
 * 它以 `ELECTRON_RUN_AS_NODE=1` 由宿主插件启动，参数是 job JSON 的路径。
 */
import { spawn } from 'node:child_process'
import fsp from 'node:fs/promises'
import path from 'node:path'

import { dbWalPaths, resolveLayout } from './core.js'
import { downloadAll } from './mirror.js'

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
      // 日志失败不影响搬运
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

  await log('guardian started', { mode: job.mode ?? 'download', appRoot: job.appRoot, pid: job.pid })
  await writeState({ phase: 'waiting-exit', mode: job.mode ?? 'download', guardianPid: process.pid })

  await waitForExit(job.pid, log)
  await waitForAppExit(job, log)
  await log('host process exited; settling')
  await sleep(2000)

  try {
    await writeState({ phase: 'downloading' })
    const result = await downloadAll({
      appRoot: job.appRoot,
      config: job.config,
      metaDir: path.join(job.appRoot, 'eleckoi-sync'),
      logPath,
      deviceId: job.deviceId ?? null,
      onProgress: progress => {
        // 只记关键阶段，避免日志被进度刷爆。
        if (progress.phase === 'done' || progress.phase === 'failed') return
        if (typeof progress.done === 'number' && progress.done % 25 !== 0) return
        void writeState({ phase: progress.phase, progress })
      },
    })
    await writeState({
      phase: result.error ? 'failed' : 'done',
      finishedAt: new Date().toISOString(),
      result: {
        mode: 'download',
        downloaded: result.downloaded,
        skipped: result.skipped,
        bytes: result.bytes,
        backupDir: result.backupDir,
        error: result.error,
      },
    })
    await log('download complete', { downloaded: result.downloaded, bytes: result.bytes, error: result.error })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    await log('download failed', { message })
    await writeState({ phase: 'failed', finishedAt: new Date().toISOString(), result: { error: message } })
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
 * 工具进程在跑，数据库仍被占用 —— 这时删库会 EBUSY，或者更糟：
 * 删掉了但句柄还在，后面写进去的数据全丢。
 *
 * Windows 上被打开的文件改名会失败，所以「能改名」就是「没人占着」。
 * 最多等 3 分钟，超时就继续往下走（后面的删除会给出明确错误）。
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
    // Node 18.20+ 起 spawn 不能再直接拉起 .cmd/.bat（会 EINVAL），得借 cmd.exe。
    // 真实的 execPath 是 ElecKoi.exe，这一步只是为便携/绿色版留个后路。
    const shellScript = /\.(cmd|bat)$/i.test(execPath)
    const bin = shellScript ? process.env.ComSpec || 'cmd.exe' : execPath
    const args = shellScript ? ['/c', execPath] : []
    const child = spawn(bin, args, {
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
