/**
 * Host 半：暴露 `/eleckoi-ftp-sync` RPC 通道。
 *
 * 只有两个搬运动作，都是「整份镜像」，不做时间比对：
 *   upload    —— 清空 FTP 上那个目录，然后把本地整份推上去（可以边用边传）
 *   download  —— 备份本机 → 清空本地 → 把 FTP 整份搬下来（必须先关程序）
 *
 * 另外几个是配套的：
 *   status / config.get / config.save / diagnose / test / cancel / log
 *   restore.*  —— 下载前的自动备份可以回滚
 */
import { spawn } from 'node:child_process'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { detectAppRoot, diagnoseAppRoot, hasAppRootEvidence, resolveLayout } from './lib/core.js'
import { createDriver } from './lib/drivers.js'
import { uploadAll } from './lib/mirror.js'
import { listRestorePoints, restorePoint } from './lib/restore.js'

const CHANNEL = '/eleckoi-ftp-sync'
const pluginDir = path.dirname(fileURLToPath(import.meta.url))

/**
 * 桌面端才做得了「下载」：宿主是 Electron，process.execPath 能带
 * ELECTRON_RUN_AS_NODE 起来当 node 用，守护进程等主进程退出后再清空、重灌。
 * 上传不需要这些 —— 它只读本地、写远端，就地跑。
 */
function describePlatform() {
  const platform = process.platform
  const execPath = process.execPath ?? ''
  // Node 在 Android 上会把 process.platform 报成 'android'；iOS 侧根本跑不了子进程。
  const mobile = platform === 'android' || platform === 'ios'
  const desktop = !mobile && (platform === 'win32' || platform === 'darwin' || platform === 'linux')
  return {
    platform,
    execPath,
    dshHome: process.env.DSH_HOME ?? null,
    mobile,
    guardianSupported: desktop && execPath !== '',
  }
}

const ok = value => ({ ok: true, value })
const fail = (code, message) => ({ ok: false, error: { code, message, details: {} } })

/**
 * 把「本机这份数据到底落在哪」摊成给人看的一行行。
 *
 * 手机端的目录布局和桌面完全不同（没有 dsh-runtime 那一层，库在 workspace/pc 里），
 * 光看「找不到文件」没法判断是路径没解对还是真的没数据，所以一起返回给面板。
 */
async function describeLayout(root) {
  if (!root) return null
  const layout = await resolveLayout(root)
  return {
    db: layout.db.abs,
    dbExists: layout.db.exists,
    dirs: layout.dirs.map(item => ({ rel: item.rel, path: item.abs, exists: item.exists })),
    files: layout.files.map(item => ({ rel: item.rel, path: item.abs, exists: item.exists })),
    missing: layout.dirs.filter(item => !item.exists).map(item => item.rel),
    selfProject: layout.selfProject,
    selfProjectConfident: layout.selfProjectConfident,
    selfProjectReason: layout.selfProjectReason,
  }
}

function normalizeConfig(raw) {
  const config = raw && typeof raw === 'object' ? raw : {}
  const ftp = config.ftp && typeof config.ftp === 'object' ? config.ftp : {}
  return {
    driver: config.driver === 'ftp' ? 'ftp' : 'local',
    localRemoteRoot: typeof config.localRemoteRoot === 'string' ? config.localRemoteRoot : '',
    ftp: {
      host: typeof ftp.host === 'string' ? ftp.host.trim() : '',
      port: Number(ftp.port) > 0 ? Number(ftp.port) : 21,
      user: typeof ftp.user === 'string' ? ftp.user : '',
      password: typeof ftp.password === 'string' ? ftp.password : '',
      remoteRoot: typeof ftp.remoteRoot === 'string' && ftp.remoteRoot.trim() !== '' ? ftp.remoteRoot.trim() : '/eleckoi',
    },
    appRoot: typeof config.appRoot === 'string' ? config.appRoot : '',
    toleranceMs: Number(config.toleranceMs) > 0 ? Number(config.toleranceMs) : 2000,
    allowConflicts: config.allowConflicts === true,
  }
}

function describeConfig(config, appRoot) {
  const target = config.driver === 'ftp'
    ? `FTP ${config.ftp.host || '(未填)'}:${config.ftp.port} ${config.ftp.remoteRoot}`
    : `本地目录 ${config.localRemoteRoot || '(未填)'}`
  return {
    driver: config.driver,
    target,
    appRoot: appRoot ?? null,
    configured: config.driver === 'ftp'
      ? config.ftp.host !== ''
      : config.localRemoteRoot.trim() !== '',
  }
}

export function apply(ctx, rawConfig) {
  const patchConfig = normalizeConfig(rawConfig)
  /**
   * appRoot 是「数据放哪」的唯一真相，但它依赖宿主注入的环境变量。
   * 桌面端固定是 %APPDATA%\eleckoi-desktop；Android 端是 App 私有目录，
   * 不同版本给的变量名还不一定一样 —— 所以这里不预设，一律交给
   * detectAppRoot() 按特征去找（见 lib/core.js）。认准了才缓存，
   * 后面所有 handler 复用同一个结果。
   */
  let appRoot
  let appRootPromise
  const ensureAppRoot = async () => {
    if (appRoot) return appRoot
    if (appRootPromise === undefined) appRootPromise = detectAppRoot(patchConfig)
    appRoot = (await appRootPromise) ?? undefined
    return appRoot
  }
  const metaDirOf = root => (root ? path.join(root, 'eleckoi-sync') : undefined)

  /**
   * 允许前端把「你替我指定数据目录」传上来。
   *
   * 手机端如果自动探测失败，整页都用不了 —— 而这时又没有任何可写的地方去存
   * 覆盖值（配置文件本来就在 appRoot 里）。所以覆盖值放在前端（localStorage），
   * 每次调用带上来；这里只负责校验它确实像个数据目录，然后认下来。
   */
  const acceptRootHint = async hint => {
    if (typeof hint !== 'string' || hint.trim() === '') return null
    const candidate = path.resolve(hint.trim())
    if (!(await hasAppRootEvidence(candidate))) return null
    appRoot = candidate
    appRootPromise = Promise.resolve(candidate)
    return candidate
  }

  /** 就地同步是单飞的：一个进程里同时跑两次会互相踩文件。 */
  let inlineRunning = false
  let inlineStartedAt = 0
  /** 就地同步锁的最长持有时间；超时视为上一次已经挂死，允许重来。 */
  const INLINE_LOCK_TIMEOUT_MS = 10 * 60 * 1000

  const readJson = async file => {
    if (!file) return {}
    try {
      return JSON.parse((await fsp.readFile(file, 'utf8')).replace(/^\uFEFF/, ''))
    } catch {
      return {}
    }
  }

  const statePathOf = () => {
    const dir = metaDirOf(appRoot)
    return dir ? path.join(dir, 'state.json') : undefined
  }

  const readState = () => readJson(statePathOf())

  const writeState = async patch => {
    const statePath = statePathOf()
    if (!statePath) return
    const next = { ...(await readState()), ...patch, updatedAt: new Date().toISOString() }
    await fsp.mkdir(path.dirname(statePath), { recursive: true })
    await fsp.writeFile(statePath, JSON.stringify(next, null, 2), 'utf8')
  }

  /** patch 配置是底，面板保存的覆盖在上；appRoot 只认 patch（它是环境事实）。 */
  const currentConfig = async () => {
    const savedDir = metaDirOf(await ensureAppRoot())
    const saved = await readJson(savedDir ? path.join(savedDir, 'config.json') : undefined)
    return normalizeConfig({ ...patchConfig, ...saved, appRoot: patchConfig.appRoot })
  }

  const guardianAlive = pid => {
    if (!Number.isInteger(pid) || pid <= 0) return false
    try {
      process.kill(pid, 0)
      return true
    } catch {
      return false
    }
  }

  const handlers = {
    async status() {
      const root = await ensureAppRoot()
      const config = await currentConfig()
      const state = await readState()
      const alive = guardianAlive(state.guardianPid)
      if (!alive && state.guardianPid) await writeState({ guardianPid: null })
      return ok({
        ...describeConfig(config, root),
        ...describePlatform(),
        layout: await describeLayout(root),
        guardianRunning: alive,
        phase: alive ? state.phase ?? 'waiting-exit' : state.phase ?? 'idle',
        last: state.result ?? null,
        lastBackupDir: state.lastBackupDir ?? null,
        updatedAt: state.updatedAt ?? null,
      })
    },

    async 'config.get'() {
      const root = await ensureAppRoot()
      const config = await currentConfig()
      return ok({
        driver: config.driver,
        localRemoteRoot: config.localRemoteRoot,
        ftp: { ...config.ftp },
        toleranceMs: config.toleranceMs,
        appRoot: root ?? null,
      })
    },

    async 'config.save'(payload) {
      const root = await ensureAppRoot()
      const dir = metaDirOf(root)
      const file = dir ? path.join(dir, 'config.json') : undefined
      if (!file) return fail('app-root-unknown', '找不到 ElecKoi 数据目录，无法保存配置；点「诊断环境」把结果发出来')
      const next = normalizeConfig({ ...(payload ?? {}), appRoot: patchConfig.appRoot })
      await fsp.mkdir(path.dirname(file), { recursive: true })
      await fsp.writeFile(file, JSON.stringify({
        driver: next.driver,
        localRemoteRoot: next.localRemoteRoot,
        ftp: next.ftp,
        toleranceMs: next.toleranceMs,
      }, null, 2), 'utf8')
      return ok({ saved: true, ...describeConfig(next, root) })
    },

    /**
     * 环境诊断：把 appRoot 推导过程摊开。
     *
     * Android 独立 App 的数据目录布局和桌面不一样，插件猜不中时整页都不可用，
     * 而这台机器上又没法远程看 —— 所以留一个端点，把变量、候选路径、命中证据
     * 全吐出来，让用户复制回来即可。
     */
    async diagnose() {
      const root = await ensureAppRoot()
      const report = await diagnoseAppRoot(patchConfig, root ?? null)
      return ok(report)
    },

    async test() {
      const root = await ensureAppRoot()
      const config = await currentConfig()
      if (!describeConfig(config, root).configured) return fail('not-configured', '还没填同步目标')
      const driver = await createDriver(config)
      try {
        const remote = await driver.list()
        return ok({
          connected: true,
          target: driver.describe(),
          entries: remote.files.size,
          hasManifest: remote.hasManifest === true,
          sample: [...remote.files.keys()].slice(0, 6),
        })
      } finally {
        await driver.close().catch(() => {})
      }
    },

    /**
     * 上传：清空远端 → 本地上传。
     *
     * 这条**不用关程序**：它只读本地、只写远端，本机一个字节都不改。
     * 主库在传之前会做一份 VACUUM INTO 快照，所以程序开着时传上去的也是能打开的库。
     */
    async upload() {
      const root = await ensureAppRoot()
      const metaDir = metaDirOf(root)
      if (!root || !metaDir) return fail('app-root-unknown', '找不到 ElecKoi 数据目录')
      const config = await currentConfig()
      if (!describeConfig(config, root).configured) return fail('not-configured', '还没填同步目标')
      const state = await readState()
      if (guardianAlive(state.guardianPid)) return fail('already-running', '有一个任务在等 ElecKoi 退出，先取消它')
      if (inlineRunning) {
        const stuckFor = Date.now() - (inlineStartedAt ?? 0)
        if (stuckFor < INLINE_LOCK_TIMEOUT_MS) {
          return fail('already-running', `上一次搬运还在跑（已 ${Math.round(stuckFor / 1000)} 秒），等一下再看`)
        }
        inlineRunning = false
      }

      const stamp = Date.now()
      const logPath = path.join(metaDir, 'logs', `upload-${stamp}.log`)
      inlineRunning = true
      inlineStartedAt = stamp
      let lastWrite = 0
      try {
        await writeState({ phase: 'uploading', mode: 'upload', startedAt: new Date().toISOString(), logPath })
        const result = await uploadAll({
          appRoot: root,
          config,
          metaDir,
          logPath,
          deviceId: process.env.COMPUTERNAME ?? null,
          onProgress: progress => {
            // 面板是轮询 status 的，节流一下，别把大量进度写盘。
            if (Date.now() - lastWrite < 800 && progress.phase !== 'done' && progress.phase !== 'failed') return
            lastWrite = Date.now()
            void writeState({ phase: progress.phase, progress })
          },
        })
        await writeState({
          phase: result.error ? 'failed' : 'done',
          finishedAt: new Date().toISOString(),
          logPath,
          result: {
            mode: 'upload',
            uploaded: result.uploaded,
            skipped: result.skipped,
            bytes: result.bytes,
            purged: result.purged,
            error: result.error,
          },
        })
        return ok({
          ...result,
          hint: result.error
            ? '上传失败，详见日志。远端可能已被清空一部分，重跑一次即可。'
            : `已把远端清空并传上去 ${result.uploaded} 个文件（${(result.bytes / 1048576).toFixed(1)} MB）。`,
        })
      } finally {
        inlineRunning = false
      }
    },

    /**
     * 下载：备份本机 → 清空本地 → FTP 搬下来。
     *
     * 必须关掉 ElecKoi 才能做：Windows 上主库被打开着时连改名都做不到（EBUSY），
     * 更没法删了重建。所以在宿主进程里只写 job、起守护进程，真正的活在退出后干。
     */
    async download() {
      const root = await ensureAppRoot()
      const metaDir = metaDirOf(root)
      const config = await currentConfig()
      if (!root || !metaDir) return fail('app-root-unknown', '找不到 ElecKoi 数据目录')
      if (!describeConfig(config, root).configured) return fail('not-configured', '还没填同步目标')
      if (!describePlatform().guardianSupported) {
        return fail('guardian-unsupported', '这个平台起不了后台进程，下载（要清空本机）在这台设备上做不到')
      }
      const state = await readState()
      if (guardianAlive(state.guardianPid)) return fail('already-running', '已经有一个任务在等 ElecKoi 退出')
      if (inlineRunning) return fail('already-running', '正在上传，等它结束再来')

      // 先连一次远端：远端是空的话没必要让用户白关一次程序。
      const probe = await createDriver(config)
      try {
        const remote = await probe.list()
        if (remote.files.size === 0) {
          return fail('remote-empty', '远端是空的，没有可下载的东西；本机未做任何改动')
        }
      } finally {
        await probe.close().catch(() => {})
      }

      const stamp = Date.now()
      const jobDir = path.join(metaDir, 'jobs')
      await fsp.mkdir(jobDir, { recursive: true })
      const jobPath = path.join(jobDir, `job-${stamp}.json`)
      const logPath = path.join(metaDir, 'logs', `download-${stamp}.log`)
      const job = {
        createdAt: new Date().toISOString(),
        mode: 'download',
        appRoot: root,
        config,
        pid: process.pid,
        execPath: process.execPath,
        relaunch: true,
        logPath,
        statePath: path.join(metaDir, 'state.json'),
        deviceId: process.env.COMPUTERNAME ?? null,
      }
      await fsp.writeFile(jobPath, JSON.stringify(job, null, 2), 'utf8')

      const script = path.join(pluginDir, 'lib', 'guardian.js')
      const env = { ...process.env, ELECTRON_RUN_AS_NODE: '1' }
      let child
      try {
        child = spawn(process.execPath, [script, jobPath], {
          cwd: pluginDir,
          detached: true,
          stdio: 'ignore',
          windowsHide: true,
          env,
        })
        child.unref()
      } catch (error) {
        return fail('guardian-spawn-failed', `起不了后台进程（${error instanceof Error ? error.message : String(error)}）`)
      }
      await writeState({
        guardianPid: child.pid ?? null,
        phase: 'waiting-exit',
        mode: 'download',
        jobPath,
        logPath,
        startedAt: new Date().toISOString(),
      })
      return ok({
        started: true,
        guardianPid: child.pid ?? null,
        logPath,
        hint: '现在完全退出 ElecKoi。它会先备份本机、再清空、然后把 FTP 的东西搬回来，最后自动重开。',
      })
    },

    async cancel() {
      await ensureAppRoot()
      const state = await readState()
      if (guardianAlive(state.guardianPid)) {
        try {
          process.kill(state.guardianPid)
        } catch {
          // 已经退出
        }
      }
      await writeState({ guardianPid: null, phase: 'cancelled' })
      return ok({ cancelled: true })
    },

    async log() {
      await ensureAppRoot()
      const state = await readState()
      const file = state.logPath ?? state.result?.logPath
      if (!file) return ok({ text: '' })
      try {
        const text = await fsp.readFile(file, 'utf8')
        return ok({ text: text.slice(-20000), path: file })
      } catch {
        return ok({ text: '', path: file })
      }
    },

    /**
     * 列出本机的恢复点：覆盖前的备份 + 归并时挪走的会话目录。
     *
     * 手机端是独立 App，数据在私有目录里，用户既不能用文件管理器也不能 adb 进去，
     * 所以必须由面板把「能回到哪一刻」摊出来，否则同步出错就是死局。
     */
    async 'restore.list'() {
      const root = await ensureAppRoot()
      const metaDir = metaDirOf(root)
      if (!metaDir) return fail('app-root-unknown', '找不到 ElecKoi 数据目录')
      return ok(await listRestorePoints(metaDir))
    },

    /** 预演：说清楚会覆盖哪些文件，一个字节都不写。 */
    async 'restore.plan'(payload) {
      const root = await ensureAppRoot()
      const metaDir = metaDirOf(root)
      if (!root || !metaDir) return fail('app-root-unknown', '找不到 ElecKoi 数据目录')
      const layout = await resolveLayout(root)
      const result = await restorePoint({
        appRoot: root,
        metaDir,
        layout,
        kind: payload?.kind,
        id: payload?.id,
        sessionIds: payload?.sessionIds,
        dryRun: true,
      })
      return ok({
        ...result,
        sample: result.items.filter(item => item.action === 'restore').slice(0, 12),
      })
    },

    /**
     * 真回滚。只覆盖恢复点里存在的那部分文件，本机多出来的一律不动 ——
     * 宁可少删，也不要因为路径算错把用户的其它数据带走。
     */
    async 'restore.apply'(payload) {
      const root = await ensureAppRoot()
      const metaDir = metaDirOf(root)
      if (!root || !metaDir) return fail('app-root-unknown', '找不到 ElecKoi 数据目录')
      if (inlineRunning) return fail('already-running', '正在上传，等它结束再回滚')
      const state = await readState()
      if (guardianAlive(state.guardianPid)) return fail('already-running', '有一个下载任务在等 ElecKoi 退出，先取消它')
      const layout = await resolveLayout(root)
      const stamp = Date.now()
      const logPath = path.join(metaDir, 'logs', `restore-${stamp}.log`)
      const append = async (message, extra) => {
        const line = `[${new Date().toISOString()}] ${message}${extra === undefined ? '' : ` ${JSON.stringify(extra)}`}\n`
        try {
          await fsp.mkdir(path.dirname(logPath), { recursive: true })
          await fsp.appendFile(logPath, line, 'utf8')
        } catch {
          // 日志写不进去不影响回滚
        }
      }
      await append('restore started', { kind: payload?.kind ?? 'backup', id: payload?.id ?? null })
      const result = await restorePoint({
        appRoot: root,
        metaDir,
        layout,
        kind: payload?.kind,
        id: payload?.id,
        sessionIds: payload?.sessionIds,
        dryRun: false,
        onProgress: progress => void append('restored', progress),
      })
      await append('restore complete', { restored: result.restored, skipped: result.skipped })
      await writeState({ lastRestore: { kind: result.kind, id: result.id, restored: result.restored, at: new Date().toISOString() } })
      return ok({
        ...result,
        logPath,
        hint: '已把备份换回本机。请完全退出并重新打开 ElecKoi（从后台划掉），新数据才会被读到。',
      })
    },
  }

  // 自己注册 HTTP 路由，而不是走 connection.rpc.handle：
  // 后者的内部 effect 会在子作用域里访问 owner.webServer，触发 "without inject"。
  // 这里沿用同一套线路格式（POST <channel>/<endpoint> + {rpcId,method,payload}），
  // 所以客户端仍然可以直接用 ctx.connection.rpc.call(...)。
  const webServer = ctx.webServer
  const connection = ctx.connection

  const readBody = req => new Promise((resolve, reject) => {
    const chunks = []
    req.on('data', chunk => chunks.push(chunk))
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })

  ctx.effect(() => {
    const dispose = webServer.register({
      kind: 'prefix',
      path: CHANNEL,
      handler: async (req, res) => {
        const rejection = connection.requestRejection({ headers: req.headers })
        if (rejection !== undefined) {
          res.writeHead(rejection)
          res.end(rejection === 401 ? 'unauthorized' : 'forbidden')
          return
        }
        const url = new URL(req.url ?? CHANNEL, 'http://127.0.0.1')
        const endpoint = url.pathname.startsWith(`${CHANNEL}/`) ? url.pathname.slice(CHANNEL.length + 1) : ''
        if (req.method !== 'POST' || endpoint === '') {
          res.writeHead(404)
          res.end('not found')
          return
        }
        let message
        try {
          message = JSON.parse(await readBody(req))
        } catch {
          res.writeHead(400)
          res.end('body is not JSON')
          return
        }
        const rpcId = typeof message?.rpcId === 'string' ? message.rpcId : 'invalid'
        const handler = handlers[endpoint]
        let result
        if (!handler) {
          result = fail('unknown-endpoint', `未知端点：${endpoint}`)
        } else {
          try {
            // 前端可以在任意请求里带 appRootHint，指定「用它当数据目录」。
            // 先认这个，再走自动探测 —— 手机端探测不出来时全靠它。
            await acceptRootHint(message?.payload?.appRootHint)
            result = await handler(message?.payload)
          } catch (error) {
            result = fail('handler-failed', error instanceof Error ? error.message : String(error))
          }
        }
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
        res.end(JSON.stringify({ type: 'server-response', rpcId, result }))
      },
    })
    return () => {
      void dispose()
    }
  })
}

export const inject = ['connection', 'webServer']
