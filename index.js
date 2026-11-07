/**
 * Host 半：暴露 `/eleckoi-ftp-sync` RPC 通道。
 *
 * 端点：
 *   status        —— 配置摘要、上次结果、守护进程是否在等重启
 *   config.get    —— 读取当前生效配置（patch 配置 + 面板里保存过的覆盖）
 *   config.save   —— 保存面板里填的 FTP/目录设置（写到 <appRoot>/eleckoi-sync/config.json）
 *   test          —— 用当前配置连一次远端，返回目录条目数（不传输数据）
 *   plan          —— 现在比对一次，返回上传/下载摘要（不传输、不修改任何文件）
 *   start         —— 写 job、启动守护进程；之后你关闭 ElecKoi，守护进程接管
 *   sync          —— 不关程序就地同步（Android / 没法 spawn 子进程的场合走这条）
 *   cancel / log  —— 取消等待中的守护进程 / 读取最近日志
 */
import { spawn } from 'node:child_process'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { detectAppRoot, planSync, scanLocal, summarize } from './lib/core.js'
import { createDriver } from './lib/drivers.js'
import { applyInPlace } from './lib/inline.js'

const CHANNEL = '/eleckoi-ftp-sync'
const pluginDir = path.dirname(fileURLToPath(import.meta.url))

/**
 * 桌面端能用「同步并重启」：宿主是 Electron，process.execPath 能带
 * ELECTRON_RUN_AS_NODE 起来当 node 用，守护进程等主进程退出后再替换文件。
 * Android 端是独立 App，既拿不到可执行的 node，也没有「退出后重新拉起」，
 * 那条路只能就地同步（换上数据后由用户自己重开 App）。
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
    inlineSupported: true,
  }
}

const ok = value => ({ ok: true, value })
const fail = (code, message) => ({ ok: false, error: { code, message, details: {} } })

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
  /** 就地同步是单飞的：一个进程里同时跑两次会互相踩文件。 */
  let inlineRunning = false

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
      if (!file) return fail('app-root-unknown', '找不到 ElecKoi 数据目录，无法保存配置')
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

    async plan() {
      const root = await ensureAppRoot()
      if (!root) return fail('app-root-unknown', '找不到 ElecKoi 数据目录')
      const config = await currentConfig()
      const driver = await createDriver(config)
      try {
        const local = await scanLocal(root)
        const remote = await driver.list()
        return ok({
          ...summarize(planSync(local, remote.files, config.toleranceMs)),
          remoteHasManifest: remote.hasManifest === true,
          target: describeConfig(config, root).target,
        })
      } finally {
        await driver.close().catch(() => {})
      }
    },

    async start() {
      const root = await ensureAppRoot()
      const metaDir = metaDirOf(root)
      const config = await currentConfig()
      if (!root || !metaDir) return fail('app-root-unknown', '找不到 ElecKoi 数据目录')
      if (!describeConfig(config, root).configured) return fail('not-configured', '还没填同步目标')
      if (!describePlatform().guardianSupported) {
        return fail('guardian-unsupported', '这个平台起不了后台守护进程，请用「立即同步」')
      }
      const state = await readState()
      if (guardianAlive(state.guardianPid)) return fail('already-running', '已经有一个同步在等待 ElecKoi 退出')

      const stamp = Date.now()
      const jobDir = path.join(metaDir, 'jobs')
      await fsp.mkdir(jobDir, { recursive: true })
      const jobPath = path.join(jobDir, `job-${stamp}.json`)
      const logPath = path.join(metaDir, 'logs', `sync-${stamp}.log`)
      const job = {
        createdAt: new Date().toISOString(),
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
        return fail('guardian-spawn-failed', `起不了后台守护进程（${error instanceof Error ? error.message : String(error)}），请用「立即同步」`)
      }
      await writeState({
        guardianPid: child.pid ?? null,
        phase: 'waiting-exit',
        jobPath,
        logPath,
        startedAt: new Date().toISOString(),
      })
      return ok({
        started: true,
        guardianPid: child.pid ?? null,
        logPath,
        hint: '现在关闭 ElecKoi；守护进程会在退出后自动替换数据并重新拉起程序。',
      })
    },

    /**
     * 就地同步：不 spawn、不等退出，直接在宿主进程里搬文件。
     *
     * 桌面端优先用 start()（守护进程能在程序退出后干净替换，还能自动重开）。
     * 这里这条是给「spawn 起不来」的环境兜底 —— 典型是 Android 独立 App：
     * 换了数据库要等用户自己重开 App 才生效。
     */
    async sync(payload) {
      const root = await ensureAppRoot()
      const metaDir = metaDirOf(root)
      if (!root || !metaDir) return fail('app-root-unknown', '找不到 ElecKoi 数据目录')
      const config = await currentConfig()
      if (!describeConfig(config, root).configured) return fail('not-configured', '还没填同步目标')
      const state = await readState()
      if (guardianAlive(state.guardianPid)) return fail('already-running', '已经有一个同步在等待 ElecKoi 退出')
      if (inlineRunning) return fail('already-running', '上一次就地同步还没结束')

      const direction = payload?.direction === 'download' || payload?.direction === 'upload' ? payload.direction : 'both'
      const stamp = Date.now()
      const logPath = path.join(metaDir, 'logs', `inline-${stamp}.log`)
      inlineRunning = true
      try {
        const result = await applyInPlace({
          appRoot: root,
          config,
          metaDir,
          logPath,
          deviceId: process.env.COMPUTERNAME ?? null,
          direction,
        })
        const needsRestart = result.downloaded > 0
        return ok({
          ...result,
          direction,
          needsRestart,
          hint: needsRestart
            ? '已把远端较新的数据换进本机。请完全退出并重新打开 ElecKoi（不是回到桌面，是从后台划掉），新数据才会被读到。'
            : (result.error ? '同步失败，详见日志。' : '已经是最新的，不需要重启。'),
        })
      } finally {
        inlineRunning = false
      }
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
