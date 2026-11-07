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
 *   cancel / log  —— 取消等待中的守护进程 / 读取最近日志
 */
import { spawn } from 'node:child_process'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { planSync, resolveAppRoot, scanLocal, summarize } from './lib/core.js'
import { createDriver } from './lib/drivers.js'

const CHANNEL = '/eleckoi-ftp-sync'
const pluginDir = path.dirname(fileURLToPath(import.meta.url))

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
  const appRoot = resolveAppRoot(patchConfig)
  const metaDir = appRoot ? path.join(appRoot, 'eleckoi-sync') : undefined
  const savedPath = metaDir ? path.join(metaDir, 'config.json') : undefined
  const statePath = metaDir ? path.join(metaDir, 'state.json') : undefined

  const readJson = async file => {
    if (!file) return {}
    try {
      return JSON.parse((await fsp.readFile(file, 'utf8')).replace(/^\uFEFF/, ''))
    } catch {
      return {}
    }
  }

  const readState = () => readJson(statePath)

  const writeState = async patch => {
    if (!statePath) return
    const next = { ...(await readState()), ...patch, updatedAt: new Date().toISOString() }
    await fsp.mkdir(path.dirname(statePath), { recursive: true })
    await fsp.writeFile(statePath, JSON.stringify(next, null, 2), 'utf8')
  }

  /** patch 配置是底，面板保存的覆盖在上；appRoot 只认 patch（它是环境事实）。 */
  const currentConfig = async () => {
    const saved = await readJson(savedPath)
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
      const config = await currentConfig()
      const state = await readState()
      const alive = guardianAlive(state.guardianPid)
      if (!alive && state.guardianPid) await writeState({ guardianPid: null })
      return ok({
        ...describeConfig(config, appRoot),
        guardianRunning: alive,
        phase: alive ? state.phase ?? 'waiting-exit' : state.phase ?? 'idle',
        last: state.result ?? null,
        lastBackupDir: state.lastBackupDir ?? null,
        updatedAt: state.updatedAt ?? null,
      })
    },

    async 'config.get'() {
      const config = await currentConfig()
      return ok({
        driver: config.driver,
        localRemoteRoot: config.localRemoteRoot,
        ftp: { ...config.ftp },
        toleranceMs: config.toleranceMs,
        appRoot: appRoot ?? null,
      })
    },

    async 'config.save'(payload) {
      const next = normalizeConfig({ ...(payload ?? {}), appRoot: patchConfig.appRoot })
      if (!savedPath) return fail('app-root-unknown', '找不到 ElecKoi 数据目录，无法保存配置')
      await fsp.mkdir(path.dirname(savedPath), { recursive: true })
      await fsp.writeFile(savedPath, JSON.stringify({
        driver: next.driver,
        localRemoteRoot: next.localRemoteRoot,
        ftp: next.ftp,
        toleranceMs: next.toleranceMs,
      }, null, 2), 'utf8')
      return ok({ saved: true, ...describeConfig(next, appRoot) })
    },

    async test() {
      const config = await currentConfig()
      if (!describeConfig(config, appRoot).configured) return fail('not-configured', '还没填同步目标')
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
      if (!appRoot) return fail('app-root-unknown', '找不到 ElecKoi 数据目录')
      const config = await currentConfig()
      const driver = await createDriver(config)
      try {
        const local = await scanLocal(appRoot)
        const remote = await driver.list()
        return ok({
          ...summarize(planSync(local, remote.files, config.toleranceMs)),
          remoteHasManifest: remote.hasManifest === true,
          target: describeConfig(config, appRoot).target,
        })
      } finally {
        await driver.close().catch(() => {})
      }
    },

    async start() {
      const config = await currentConfig()
      if (!appRoot) return fail('app-root-unknown', '找不到 ElecKoi 数据目录')
      if (!describeConfig(config, appRoot).configured) return fail('not-configured', '还没填同步目标')
      const state = await readState()
      if (guardianAlive(state.guardianPid)) return fail('already-running', '已经有一个同步在等待 ElecKoi 退出')

      const stamp = Date.now()
      const jobDir = path.join(metaDir, 'jobs')
      await fsp.mkdir(jobDir, { recursive: true })
      const jobPath = path.join(jobDir, `job-${stamp}.json`)
      const logPath = path.join(metaDir, 'logs', `sync-${stamp}.log`)
      const job = {
        createdAt: new Date().toISOString(),
        appRoot,
        config,
        pid: process.pid,
        execPath: process.execPath,
        relaunch: true,
        logPath,
        statePath,
        deviceId: process.env.COMPUTERNAME ?? null,
      }
      await fsp.writeFile(jobPath, JSON.stringify(job, null, 2), 'utf8')

      const script = path.join(pluginDir, 'lib', 'guardian.js')
      const env = { ...process.env, ELECTRON_RUN_AS_NODE: '1' }
      const child = spawn(process.execPath, [script, jobPath], {
        cwd: pluginDir,
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
        env,
      })
      child.unref()
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

    async cancel() {
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
      const state = await readState()
      if (!state.logPath) return ok({ text: '' })
      try {
        const text = await fsp.readFile(state.logPath, 'utf8')
        return ok({ text: text.slice(-20000), path: state.logPath })
      } catch {
        return ok({ text: '', path: state.logPath })
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
