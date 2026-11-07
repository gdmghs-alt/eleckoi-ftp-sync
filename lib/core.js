/**
 * 同步核心：扫描本地数据、比对远端清单、生成双向计划。
 * 这里不碰业务数据库内容，只做文件级的时间/大小比对。
 */
import fsp from 'node:fs/promises'
import path from 'node:path'

export const DB_FILE = 'eleckoi-common.sqlite3'

/**
 * 参与同步的目录（相对 appRoot）。缓存、日志、插件依赖、凭据一律不碰。
 *
 * 同步范围的口径是「补齐另一台机器跑起来需要的东西」，不是「复制整个 AppData」：
 *
 * - dsh-runtime/sessions：对话正文（session.v4.jsonl）。
 * - dsh-runtime/session-snapshots：每个会话挂的预设、模型、推理档位、禁用的工具组。
 *   少了它，换机器打开旧对话会静默回落到默认预设/默认模型，表现就是
 *   「我明明挂的是夏瑾天琴座，怎么变回默认了」。
 * - dsh-runtime/generated-presets：由数据库里的 agent_preset_* 表 + 模板渲染出的
 *   preset.json。属派生物，但一起带走能让远端立刻有一份可读的预设定义，
 *   缺了也会在下次创建会话时自动重建。
 * - dsh-runtime/home/attachments：聊天里贴的附件正文（按 sha256 分桶存放）。
 * - dsh-runtime/home/llm-deepseek/files-v3.json：附件索引，fileId 到 sha256 的映射。
 *   少了它界面里点开历史消息中的附件会对不上号。只带这一个文件，不带整个目录 ——
 *   那个目录以后可能被塞进模型缓存。
 * - media / author-scripts：图片资源与作者脚本。
 *
 * 预设本身（agent_presets / agent_preset_versions / agent_preset_contents /
 * agent_preset_entries / agent_preset_groups / agent_preset_state）存在
 * eleckoi-common.sqlite3 里，随数据库一起同步，不需要单独列目录。
 *
 * 明确排除：dsh-runtime/home/remote（设备私钥与服务器凭据）、
 * dsh-runtime/home/.credentials.yaml（API key）、profiles（本机插件与路径）、
 * cache、logs、各 Electron 缓存目录。
 */
export const INCLUDE_DIRS = [
  'dsh-runtime/sessions',
  'dsh-runtime/session-snapshots',
  'dsh-runtime/generated-presets',
  'dsh-runtime/home/attachments',
  'media',
  'author-scripts',
]

/**
 * 单独要同步的零星文件（相对 appRoot）。
 *
 * 附件索引就在这里面：目录里现在只有它，但将来可能被模型缓存填满，
 * 所以按文件点名，不按目录整包带走。
 */
export const INCLUDE_FILES = [
  'dsh-runtime/home/llm-deepseek/files-v3.json',
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

/**
 * resolveAppRoot 的加强版：环境变量之外再试几个已知落点。
 *
 * Android 端的独立 App 不一定会把 DSH_HOME 传进来（它是自己 bundle 的运行时），
 * 拿不到 appRoot 时插件整页都报「找不到 ElecKoi 数据目录」。这里按
 * 「目录里有 dsh-runtime 子目录或 eleckoi-common.sqlite3」这个特征去猜：
 * 先看配置、再看 DSH_HOME、再看 ELECKOI_DATA_ROOT / ELECKOI_HOME 这类变量、
 * 最后从 DSH_HOME 与 cwd 往上逐层找。猜不中仍然返回 undefined，让上层报错。
 */
export async function detectAppRoot(config) {
  // resolveAppRoot 只按「DSH_HOME 往上跳」推，在 DSH 自己的进程里（DSH_HOME=~/.dsh）
  // 会推到一个没有 dsh-runtime 的目录，所以这里必须过一道特征校验再用。
  const direct = resolveAppRoot(config)
  if (direct && await looksLikeAppRoot(direct)) return direct

  for (const name of ['ELECKOI_DATA_ROOT', 'ELECKOI_HOME', 'ELECKOI_APP_ROOT', 'DSH_DATA_ROOT']) {
    const value = process.env[name]
    if (typeof value === 'string' && value.trim() !== '') {
      const candidate = path.resolve(value.trim())
      if (await looksLikeAppRoot(candidate)) return candidate
      const parent = path.dirname(candidate)
      if (await looksLikeAppRoot(parent)) return parent
    }
  }

  // 已知落点：桌面版固定在 %APPDATA%\eleckoi-desktop；Android 上同级的 App 私有目录
  // 一般挂在 <HOME> 或 <HOME>/files 下，两个都试。
  const known = []
  if (process.env.APPDATA) known.push(path.join(process.env.APPDATA, 'eleckoi-desktop'))
  if (process.env.HOME) {
    known.push(path.join(process.env.HOME, 'eleckoi-desktop'))
    known.push(path.join(process.env.HOME, 'files'))
    known.push(process.env.HOME)
  }
  for (const candidate of known) {
    if (await looksLikeAppRoot(candidate)) return candidate
  }

  const seeds = [
    config && typeof config.appRoot === 'string' ? config.appRoot : '',
    process.env.DSH_HOME,
    process.env.ELECKOI_DSH_HOME,
    process.env.HOME,
    process.env.APPDATA,
    process.cwd(),
  ]
  for (const seed of seeds) {
    if (typeof seed !== 'string' || seed.trim() === '') continue
    let current = path.resolve(seed.trim())
    for (let depth = 0; depth < 5; depth += 1) {
      if (await looksLikeAppRoot(current)) return current
      const parent = path.dirname(current)
      if (parent === current) break
      current = parent
    }
  }
  return undefined
}

async function looksLikeAppRoot(dir) {
  try {
    await fsp.access(path.join(dir, 'dsh-runtime'))
    return true
  } catch {
    // 没有 dsh-runtime 也还有可能只有库文件（极早期数据目录）
  }
  try {
    await fsp.access(path.join(dir, DB_FILE))
    return true
  } catch {
    return false
  }
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

/**
 * 本地清单：rel -> { size, mtimeMs }
 *
 * 数据库这一项的时间取 db 与「非空的」-wal 里较新的那个：Electron 关闭前
 * 新写入的行还在 WAL 里没合并进主库，主库文件本身的 mtime 可能是几小时前。
 * 只看主库会得出「本地比远端旧」的错误结论，然后拿远端的旧库把新数据盖掉。
 *
 * -shm 不参与：它只是内存映射的索引，每次打开数据库都会刷新 mtime，
 * 算进去会让数据库永远被判成「本地较新」，每轮都白传一次。
 */
export async function scanLocal(appRoot) {
  const out = new Map()
  const { db, wal } = dbWalPaths(appRoot)
  let dbSize = 0
  let dbMtime = 0
  for (const file of [db, wal]) {
    try {
      const stat = await fsp.stat(file)
      if (file === db) {
        dbSize = stat.size
        dbMtime = Math.max(dbMtime, Math.round(stat.mtimeMs))
      } else if (stat.size > 0) {
        dbMtime = Math.max(dbMtime, Math.round(stat.mtimeMs))
      }
    } catch {
      // 不存在就跳过
    }
  }
  if (dbSize > 0 || dbMtime > 0) {
    out.set(DB_FILE, { size: dbSize, mtimeMs: dbMtime })
  }
  for (const dir of INCLUDE_DIRS) {
    await walk(path.join(appRoot, dir), dir, out)
  }
  for (const rel of INCLUDE_FILES) {
    try {
      const stat = await fsp.stat(path.join(appRoot, rel))
      out.set(rel, { size: stat.size, mtimeMs: Math.round(stat.mtimeMs) })
    } catch {
      // 还没产生这个文件
    }
  }
  return out
}

/**
 * 某个相对路径是否属于同步范围。
 *
 * 本地扫描天然只走白名单目录，但**远端扫描是整棵树**：远端可能残留 wal/shm、
 * 备份文件、甚至别人塞进去的别的文件。不在这里统一过滤，远端那些东西就会被
 * 当成「本地缺失」下载回来 —— 把旧的 -wal 拖回本地是最容易把库搞坏的一种。
 */
export function isSyncedRel(rel) {
  if (typeof rel !== 'string' || rel === '') return false
  const normalized = rel.replace(/\\/g, '/')
  const base = normalized.slice(normalized.lastIndexOf('/') + 1)
  if (SKIP_FILE_PATTERNS.some(pattern => pattern.test(base))) return false
  if (normalized === DB_FILE) return true
  if (INCLUDE_FILES.includes(normalized)) return true
  return INCLUDE_DIRS.some(dir => normalized === dir || normalized.startsWith(`${dir}/`))
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

  // 两侧都先按白名单过一遍：远端清单里可能留着上一版写进去的 wal/shm、备份文件，
  // 本地清单也可能被别处喂进无关项。过滤是幂等的，重复调用没副作用。
  const localFiles = new Map([...local].filter(([rel]) => isSyncedRel(rel)))
  const remoteFiles = new Map([...remote].filter(([rel]) => isSyncedRel(rel)))

  for (const [rel, localEntry] of localFiles) {
    const remoteEntry = remoteFiles.get(rel)
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

  for (const [rel, remoteEntry] of remoteFiles) {
    if (!localFiles.has(rel)) downloads.push({ rel, ...remoteEntry, reason: 'local-missing' })
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
  for (const rel of INCLUDE_FILES) {
    const from = path.join(appRoot, rel)
    const to = path.join(targetDir, rel)
    try {
      await fsp.mkdir(path.dirname(to), { recursive: true })
      await fsp.copyFile(from, to)
      copied.push(rel)
    } catch {
      // 还没产生这个文件
    }
  }
  return copied
}

/**
 * 覆盖数据库前必须清掉旧的 wal/shm，否则新库会被旧日志污染。
 *
 * 返回 `{ removed, failed }`：Windows 上被别的进程占着时 rm 会 EPERM/EBUSY，
 * 那种情况必须让调用方知道 —— 静默忽略会让新库被上一份 WAL 覆盖回去。
 */
export async function clearWalShm(appRoot) {
  const { wal, shm } = dbWalPaths(appRoot)
  const removed = []
  const failed = []
  for (const file of [wal, shm]) {
    try {
      await fsp.rm(file, { force: true })
      removed.push(path.basename(file))
    } catch (error) {
      if (error && error.code === 'ENOENT') continue
      failed.push(`${path.basename(file)}: ${error?.code ?? error}`)
    }
  }
  return { removed, failed }
}

/**
 * 把 -wal 里还没合并的数据写回主库，然后清空 wal。
 *
 * Electron 退出前后新写入的行常常还躺在 WAL 里：只搬主库文件，那些行就
 * 丢在 -wal 里没上传（而 -wal 本身在白名单外，永远不上传）—— 另一端拿到的
 * 是一份少了最新几条记录的旧库。所以在扫描/上传之前先 checkpoint 一次。
 *
 * 用 Node 24 自带的 node:sqlite，不引入任何依赖。失败不抛：checkpoint 只是
 * 优化，真正致命的（库被占用）会在后面的文件操作上暴露。
 */
export async function checkpointDatabase(appRoot, logger = () => {}) {
  const { db } = dbWalPaths(appRoot)
  try {
    await fsp.access(db)
  } catch {
    return { ok: false, reason: 'missing' }
  }
  try {
    const { DatabaseSync } = await import('node:sqlite')
    const handle = new DatabaseSync(db)
    try {
      handle.exec('PRAGMA busy_timeout = 5000')
      handle.prepare('PRAGMA wal_checkpoint(TRUNCATE)').all()
    } finally {
      handle.close()
    }
    return { ok: true }
  } catch (error) {
    logger(`数据库 checkpoint 失败（继续同步）：${error instanceof Error ? error.message : String(error)}`)
    return { ok: false, reason: error instanceof Error ? error.message : String(error) }
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
