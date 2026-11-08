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

/**
 * 会话目录在 rel 里的名字，以及它下面那一层的「本机项目」占位符。
 *
 * 为什么要占位：`sessions/<项目目录>/<sessionId>/session.v4.jsonl` 里的项目目录名
 * 是拿 cwd 编码出来的（`D:\...\workspace` → `--D-...-workspace--`），两台机器的
 * cwd 不可能相同。按原样镜像，同一场对话会在远端变成两个不同路径 —— 电脑一份、
 * 手机一份，永远对不上、也永远不冲突，然后两端各自把对方那份也拉下来。
 *
 * 结果就是 DSH 读会话时报：
 *   duplicate JSONL session id "xxx" appears in multiple project directories
 * 整个 listArtifacts() 抛异常，那个对话的 turn 一条都载不出来，界面上只剩开场白。
 *
 * 所以 rel 里统一用 `@self` 顶替项目目录名，落地时再换成本机真实的那一个。
 */
export const SESSIONS_REL = 'dsh-runtime/sessions'
export const SELF_PROJECT = '@self'

const SKIP_DIR_NAMES = new Set([
  'node_modules', '.plugin-manager', '.git', '.cache',
  'Cache', 'Code Cache', 'GPUCache', 'GrShaderCache', 'ShaderCache',
  'DawnGraphiteCache', 'DawnWebGPUCache', 'blob_storage',
  'Local Storage', 'Session Storage', 'logs', 'backups', 'staging', 'temp',
  // Android 私有目录里的纯缓存（可能几个 G），扫它们没意义。
  // 注意别把 files / databases / no_backup 加进来 —— appRoot 恰好可能在这些里面。
  'cache', 'code_cache', 'shared_prefs', 'app_webview', 'app_textures',
])

const SKIP_FILE_PATTERNS = [
  /^eleckoi-common\.sqlite3-(wal|shm)$/i,
  /\.bak-\d{8}-\d{6}$/i,
  /\.BACKUP-\d{8}-\d{4,6}\.sqlite3(?:-(?:shm|wal))?$/i,
  /\.broken-\d+$/i,
  // 会话锁：每台机器各自打开会话时建的，内容为空，搬过去只会互相干扰。
  /^session\.lock$/i,
  // 下载中途的临时文件（<name>.incoming）与放在 sessions 根下的半成品
  /\.incoming$/i,
  /^\.incoming-/i,
]

/**
 * 由 DSH_HOME（<appRoot>/dsh-runtime/home）反推应用数据根目录。
 *
 * 保留它只为兼容旧调用点。它不做特征校验，在 DSH 自己的进程里会跳错；
 * 真正找目录请用 detectAppRoot()。
 */
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
 * 环境变量 → appRoot 的推导表。
 *
 * 桌面端 host 注入的变量（逐字见 @eleckoi/desktop-host/dist/index.mjs 的 env 块）：
 *   DSH_HOME                      = <appRoot>/dsh-runtime/home
 *   DSH_SESSION_ROOT              = <appRoot>/dsh-runtime/sessions
 *   ELECKOI_SESSION_SNAPSHOT_ROOT = <appRoot>/dsh-runtime/session-snapshots
 *   ELECKOI_PRESET_ROOT           = <appRoot>/dsh-runtime/generated-presets
 *   ELECKOI_SESSION_BRIDGE_ROOT   = <appRoot>/dsh-runtime/session-bridges
 *   ELECKOI_DATABASE_PATH         = <appRoot>/eleckoi-common.sqlite3
 *   ELECKOI_MEDIA_ROOT            = <appRoot>/media
 *   ELECKOI_WORKSPACE_ROOT        = <appRoot>/workspace
 *
 * 手机端（独立 App）的目录布局和桌面不一样，但只要它注入了其中任意一个变量，
 * 就能反推 appRoot —— 这比「按特征去猜」准得多。最后的数字是「往上跳几层」。
 */
const ENV_APPROOT_HINTS = [
  ['DSH_HOME', 2],
  ['DSH_SESSION_ROOT', 2],
  ['ELECKOI_SESSION_SNAPSHOT_ROOT', 2],
  ['ELECKOI_PRESET_ROOT', 2],
  ['ELECKOI_SESSION_BRIDGE_ROOT', 2],
  ['ELECKOI_DATABASE_PATH', 1],
  ['ELECKOI_MEDIA_ROOT', 1],
  ['ELECKOI_WORKSPACE_ROOT', 1],
  ['ELECKOI_DATA_ROOT', 0],
  ['ELECKOI_APP_ROOT', 0],
  ['ELECKOI_HOME', 0],
  ['DSH_DATA_ROOT', 0],
]

/**
 * 目录像不像 appRoot。
 *
 * 强证据（桌面端一定命中）：dsh-runtime 子目录，或 eleckoi-common.sqlite3。
 * 弱证据（手机端可能长这样）：直接有 sessions / generated-presets 之类的成员目录，
 * 或者躺着任意一个 *.sqlite3 —— Android 上不一定带 dsh-runtime 这一层，
 * 数据库也可能叫别的名字。
 *
 * 自动探测只要强证据，免得认错目录；手动填的路径（appRootHint）弱证据也接受，
 * 毕竟用户是照着诊断结果自己看着填的。
 */
const STRONG_SIGNALS = ['dsh-runtime', 'dsh-runtime/home', 'dsh-runtime/sessions', DB_FILE]
const WEAK_SIGNALS = ['sessions', 'session-snapshots', 'generated-presets', 'home', 'media', 'workspace']

async function rootEvidence(dir, allowWeak = false) {
  if (typeof dir !== 'string' || dir === '') return null
  const found = []
  for (const rel of STRONG_SIGNALS) {
    try {
      await fsp.access(path.join(dir, rel))
      found.push(rel)
    } catch {
      // 没有就继续看下一个
    }
  }
  if (found.length > 0) return found
  if (!allowWeak) return null
  for (const rel of WEAK_SIGNALS) {
    try {
      await fsp.access(path.join(dir, rel))
      found.push(rel)
    } catch {
      // 同上
    }
  }
  if (found.length > 0) return found
  // 兜底：任何 .sqlite3 文件
  try {
    const entries = await fsp.readdir(dir, { withFileTypes: true })
    for (const entry of entries) {
      if (entry.isFile() && /\.sqlite3?$/i.test(entry.name)) found.push(entry.name)
    }
  } catch {
    // 读不了就算了
  }
  return found.length > 0 ? found : null
}

/** 对外暴露的校验：手动指定的这个目录能不能当数据根。 */
export async function hasAppRootEvidence(dir) {
  return (await rootEvidence(dir, true)) !== null
}

async function looksLikeAppRoot(dir) {
  return (await rootEvidence(dir, false)) !== null
}

/** 列出目录的一级内容，诊断用。只报名字，不递归。 */
async function listDirBriefly(dir, limit = 24) {
  try {
    const entries = await fsp.readdir(dir, { withFileTypes: true })
    return entries
      .slice(0, limit)
      .map(entry => (entry.isDirectory() ? `${entry.name}/` : entry.name))
  } catch (error) {
    return [`<读不了：${error?.code ?? 'unknown'}>`]
  }
}

/**
 * 往下找「像数据根的地方」，把命中全收起来（不像 scanForAppRoot 只返回第一个）。
 *
 * 手机端光靠固定落点猜不中，得先看清楚它到底把库和 dsh-runtime 放在哪一层。
 * 这里同时收两类东西：名字叫 dsh-runtime 的目录，和任意 *.sqlite3 文件 ——
 * 记下它们所在的那一层，就是候选 appRoot。
 */
async function probeDataDirs(seed, maxDepth = 3, limit = 60) {
  const hits = []
  const seen = new Set()
  let level = [path.resolve(seed)]
  for (let depth = 0; depth <= maxDepth && level.length > 0 && hits.length < limit; depth += 1) {
    const next = []
    for (const dir of level) {
      let entries
      try {
        entries = await fsp.readdir(dir, { withFileTypes: true })
      } catch {
        continue
      }
      for (const entry of entries) {
        const abs = path.join(dir, entry.name)
        if (entry.isDirectory()) {
          if (entry.name === 'dsh-runtime' && !seen.has(dir)) {
            seen.add(dir)
            hits.push({ path: dir, kind: 'dsh-runtime', detail: path.basename(dir) })
          }
          if (SKIP_DIR_NAMES.has(entry.name) || entry.name.startsWith('.')) continue
          next.push(abs)
          continue
        }
        if (entry.isFile() && /\.sqlite3?(-wal|-shm)?$/i.test(entry.name) && !seen.has(dir)) {
          seen.add(dir)
          hits.push({ path: dir, kind: 'db', detail: entry.name })
        }
      }
    }
    level = next.slice(0, 200)
  }
  return hits
}

/** 收集候选路径（只按变量推导，不验证），detect 与诊断共用。 */
export function appRootCandidates(config) {
  const out = []
  const push = (from, value, up) => {
    if (typeof value !== 'string' || value.trim() === '') return
    let current = path.resolve(value.trim())
    for (let i = 0; i <= up; i += 1) {
      out.push({ from: i === 0 ? from : `${from} 上跳${i}`, path: current })
      const parent = path.dirname(current)
      if (parent === current) break
      current = parent
    }
  }
  if (config && typeof config.appRoot === 'string' && config.appRoot.trim() !== '') {
    push('config.appRoot', config.appRoot, 0)
  }
  for (const [name, up] of ENV_APPROOT_HINTS) push(name, process.env[name], up)
  if (process.env.APPDATA) push('APPDATA/eleckoi-desktop', path.join(process.env.APPDATA, 'eleckoi-desktop'), 0)
  if (process.env.HOME) {
    push('HOME/eleckoi-desktop', path.join(process.env.HOME, 'eleckoi-desktop'), 0)
    push('HOME/files', path.join(process.env.HOME, 'files'), 2)
    push('HOME', process.env.HOME, 2)
  }
  push('cwd', process.cwd(), 3)
  return out
}

/**
 * 从 seed 往下做有限深度的广度优先搜索，找带 appRoot 特征的目录。
 * 只在环境变量全军覆没时才走这条 —— 手机端的变量名可能和桌面版完全不同。
 *
 * allowWeak 为真时连弱证据也认（给诊断用：把可能的落点全列出来给人挑）。
 */
async function scanForAppRoot(seed, maxDepth = 3, allowWeak = false) {
  let level = [path.resolve(seed)]
  for (let depth = 0; depth <= maxDepth && level.length > 0; depth += 1) {
    for (const dir of level) {
      if (await rootEvidence(dir, allowWeak)) return dir
    }
    const next = []
    for (const dir of level) {
      let entries
      try {
        entries = await fsp.readdir(dir, { withFileTypes: true })
      } catch {
        continue
      }
      for (const entry of entries) {
        if (!entry.isDirectory()) continue
        if (SKIP_DIR_NAMES.has(entry.name)) continue
        if (entry.name.startsWith('.')) continue
        next.push(path.join(dir, entry.name))
      }
    }
    level = next.slice(0, 400)
  }
  return null
}

/**
 * 扫描种子。手机上 HOME 可能是 <data>/no_backup/runtime/home 这种深路径，
 * 真正的数据根在它上层或兄弟目录里，所以从 HOME 往上走几层也都当种子。
 */
export function appRootSeeds() {
  const seeds = []
  const addSeed = value => {
    if (typeof value !== 'string' || value.trim() === '') return
    seeds.push(path.resolve(value.trim()))
  }
  addSeed(process.env.HOME)
  addSeed(process.env.ELECKOI_DATA_ROOT)
  addSeed(process.env.APPDATA)
  // HOME 往上三层（Android 上 data 根常在 HOME 的祖父层）
  if (process.env.HOME) {
    let current = path.resolve(process.env.HOME)
    for (let i = 0; i < 4; i += 1) {
      const parent = path.dirname(current)
      if (parent === current) break
      current = parent
      seeds.push(current)
    }
  }
  addSeed(process.cwd())
  return seeds
}

/**
 * 找 appRoot。顺序：配置 → host 注入的环境变量（反推）→ 已知落点 → 往下扫目录树。
 * 全都猜不中返回 undefined，让上层报「找不到 ElecKoi 数据目录」。
 *
 * 注意必须过特征校验：resolveAppRoot 只按「DSH_HOME 往上跳」推，在 DSH 自己的
 * 进程里（DSH_HOME=~/.dsh）会推到一个没有 dsh-runtime 的目录。
 */
export async function detectAppRoot(config) {
  for (const candidate of appRootCandidates(config)) {
    if (await looksLikeAppRoot(candidate.path)) return candidate.path
  }
  for (const seed of appRootSeeds()) {
    const hit = await scanForAppRoot(seed)
    if (hit) return hit
  }
  // 最后一道：不求「整层像 appRoot」，只找「哪一层里躺着 dsh-runtime」。
  // 只认 dsh-runtime 这一种 —— 光凭一个 .sqlite3 太容易认错（foobar2000 之类全是库文件）。
  // 手机端如果连 dsh-runtime 这层都没有，就靠诊断面板里的人工兜底。
  for (const seed of appRootSeeds()) {
    const hits = await probeDataDirs(seed)
    const dshHit = hits.find(hit => hit.kind === 'dsh-runtime')
    if (dshHit) return dshHit.path
  }
  return undefined
}

/** 给面板用的诊断报告：把「为什么找不到」摊开，省得靠截图来回猜。 */
export async function diagnoseAppRoot(config, resolved) {
  const candidates = []
  for (const candidate of appRootCandidates(config)) {
    const evidence = await rootEvidence(candidate.path)
    candidates.push({ from: candidate.from, path: candidate.path, evidence: evidence ?? [] })
  }
  const env = {}
  const names = ENV_APPROOT_HINTS.map(entry => entry[0]).concat(['APPDATA', 'HOME', 'USERPROFILE', 'PWD', 'TMPDIR', 'TEMP'])
  for (const name of names) env[name] = process.env[name] ?? null

  // 目录普查：把种子目录及其一级/二级子目录摊开，连「弱证据」也标出来。
  // 这是给手机端用的 —— 那边变量名和目录布局跟桌面完全不同，光靠猜没用。
  const survey = []
  const probes = {}
  const seeds = appRootSeeds()
  for (const seed of seeds.slice(0, 6)) {
    const top = await listDirBriefly(seed)
    let hits = []
    for (const entry of top) {
      if (!entry.endsWith('/')) continue
      const dir = path.join(seed, entry.slice(0, -1))
      const evidence = await rootEvidence(dir, true)
      if (evidence) hits.push({ path: dir, evidence })
    }
    survey.push({ seed, entries: top, hits })

    // 再下一层（只对带 hits 的种子的子目录做，避免爆炸）
    if (hits.length === 0) {
      for (const entry of top) {
        if (!entry.endsWith('/')) continue
        const dir = path.join(seed, entry.slice(0, -1))
        const sub = await listDirBriefly(dir, 16)
        const subHits = []
        for (const child of sub) {
          if (!child.endsWith('/')) continue
          const grand = path.join(dir, child.slice(0, -1))
          const evidence = await rootEvidence(grand, true)
          if (evidence) subHits.push({ path: grand, evidence })
        }
        if (subHits.length > 0) {
          survey.push({ seed: dir, entries: sub, hits: subHits })
        }
      }
    }

    // 深挖：不管上面有没有命中，都往下找「哪一层有 dsh-runtime 或数据库文件」。
    // 手机端的真实布局只能这样找出来。
    const deep = await probeDataDirs(seed)
    if (deep.length > 0) probes[seed] = deep
  }

  return {
    resolved: resolved ?? null,
    platform: process.platform,
    arch: process.arch,
    execPath: process.execPath ?? null,
    isPackagedElectron: Boolean(process.versions && process.versions.electron),
    versions: { node: process.versions?.node ?? null, electron: process.versions?.electron ?? null },
    env,
    candidates,
    survey,
    probes,
  }
}

/** 环境变量里的一条路径，空值当没有。 */
function envPath(name) {
  const value = process.env[name]
  return typeof value === 'string' && value.trim() !== '' ? path.resolve(value.trim()) : undefined
}

async function exists(target) {
  if (typeof target !== 'string' || target === '') return false
  try {
    await fsp.access(target)
    return true
  } catch {
    return false
  }
}

/**
 * 逻辑名（canonical rel，与桌面端一致）→ 本机真实目录的候选表。
 *
 * 为什么要有这一层：rel 键是两端对账的**唯一标识**。桌面端历史上一直用
 * `dsh-runtime/sessions/...` 这套名字存进远端 manifest，手机端如果换成自己的
 * 物理路径（`runtime/data/sessions/...`）当键，两边就永远对不上，一条也同步不了。
 * 所以键固定用桌面那套，只把「它在本机落在哪」解出来。
 *
 * 候选顺序刻意是「appRoot 里面 → appRoot 的上层 → 环境变量」：
 * 环境变量不能优先，因为同一个进程里它可能指向别的东西 —— 在 DSH 自己的进程里
 * `DSH_HOME=<DSH 自己的 home>`，先信它就会把 `~/.dsh\attachments` 当成聊天附件，
 * 扫出 382 个无关文件。appRoot 内部命中的才是这次要同步的那份。
 *
 * 手机端（Android 独立 App）实测布局，appRoot = `<data>/no_backup/runtime/workspace/pc`：
 *   <data>/no_backup/runtime/home                    ← DSH_HOME
 *   <data>/no_backup/runtime/data/sessions           ← DSH_SESSION_ROOT
 *   <data>/no_backup/runtime/media
 *   <data>/no_backup/runtime/workspace/pc/eleckoi-common.sqlite3
 * 没有 dsh-runtime 这一层，所以要靠「往上两层」把 runtime 找回来。
 */
function layoutSpec(root) {
  const up1 = path.dirname(root)
  const up2 = path.dirname(up1)
  const up3 = path.dirname(up2)
  const home = envPath('DSH_HOME')
  return {
    dirs: [
      ['dsh-runtime/sessions', [
        path.join(root, 'dsh-runtime/sessions'),
        path.join(root, 'data/sessions'),
        path.join(root, 'sessions'),
        path.join(up1, 'data/sessions'),
        path.join(up2, 'data/sessions'),
        path.join(up3, 'data/sessions'),
        path.join(up2, 'sessions'),
        envPath('DSH_SESSION_ROOT'),
      ]],
      ['dsh-runtime/session-snapshots', [
        path.join(root, 'dsh-runtime/session-snapshots'),
        path.join(root, 'data/session-snapshots'),
        path.join(root, 'session-snapshots'),
        path.join(up1, 'data/session-snapshots'),
        path.join(up2, 'data/session-snapshots'),
        path.join(up3, 'data/session-snapshots'),
        path.join(up2, 'session-snapshots'),
        envPath('ELECKOI_SESSION_SNAPSHOT_ROOT'),
      ]],
      ['dsh-runtime/generated-presets', [
        path.join(root, 'dsh-runtime/generated-presets'),
        path.join(root, 'data/generated-presets'),
        path.join(root, 'generated-presets'),
        path.join(up1, 'data/generated-presets'),
        path.join(up2, 'data/generated-presets'),
        path.join(up3, 'data/generated-presets'),
        path.join(up2, 'generated-presets'),
        envPath('ELECKOI_PRESET_ROOT'),
      ]],
      ['dsh-runtime/home/attachments', [
        path.join(root, 'dsh-runtime/home/attachments'),
        path.join(root, 'attachments'),
        path.join(up1, 'home/attachments'),
        path.join(up2, 'home/attachments'),
        path.join(up3, 'home/attachments'),
        home ? path.join(home, 'attachments') : undefined,
      ]],
      ['media', [
        path.join(root, 'media'),
        path.join(up1, 'media'),
        path.join(up2, 'media'),
        path.join(up3, 'media'),
        envPath('ELECKOI_MEDIA_ROOT'),
      ]],
      ['author-scripts', [
        path.join(root, 'author-scripts'),
        path.join(up1, 'author-scripts'),
        path.join(up2, 'author-scripts'),
      ]],
    ],
    files: [
      ['dsh-runtime/home/llm-deepseek/files-v3.json', [
        path.join(root, 'dsh-runtime/home/llm-deepseek/files-v3.json'),
        path.join(root, 'llm-deepseek/files-v3.json'),
        path.join(up1, 'home/llm-deepseek/files-v3.json'),
        path.join(up2, 'home/llm-deepseek/files-v3.json'),
        path.join(up3, 'home/llm-deepseek/files-v3.json'),
        home ? path.join(home, 'llm-deepseek/files-v3.json') : undefined,
      ]],
    ],
    db: [
      path.join(root, DB_FILE),
      path.join(root, 'workspace/pc', DB_FILE),
      path.join(up1, DB_FILE),
      path.join(up1, 'workspace/pc', DB_FILE),
      path.join(up2, DB_FILE),
      envPath('ELECKOI_DATABASE_PATH'),
    ],
  }
}

/**
 * cwd → DSH 的项目目录名，**逐字符照抄 DSH 的 projectKey()**。
 *
 * 这个函数不能自己发明规则。DSH 在 `assertStoredIdentity()` 里会拿磁盘上的路径
 * 跟 `generationLogPath(root, header.cwd, header.id, ...)` 算出来的路径逐字比对，
 * 对不上就判 `corrupt session log`，接着 `listArtifacts()` 整个 reject，
 * 界面表现就是「打开失败 / sessions.retain: unknown session」。
 *
 * 规则（与 DSH 逐字一致）：
 *   - `/` `\` `:` 连续出现折成**一个** `-`；
 *   - `~` 与 `[A-Za-z0-9._-]` 之外一律转 `~XXXX`（4 位大写十六进制码点）；
 *   - 去掉开头的 `-`，空串用 `root` 顶替；
 *   - 截断到 251 字符；
 *   - 两边各包 `--`。
 *
 * 实测两条都对得上：
 *   `<appRoot>\workspace`（桌面）
 *     → `--D-Users-<用户名>-AppData-Roaming-eleckoi-desktop-workspace--`
 *   `/data/user/10/com.eleckoi.app/no_backup/unified-runtime/workspace`
 *     → `--data-user-10-com.eleckoi.app-no_backup-unified-runtime-workspace--`
 */
export function encodeProjectDir(cwd) {
  const value = String(cwd ?? '')
  if (value.length === 0) return SELF_PROJECT
  let readable = ''
  let separatorRun = false
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i)
    const ch = String.fromCharCode(code)
    if (ch === '/' || ch === '\\' || ch === ':') {
      if (!separatorRun) readable += '-'
      separatorRun = true
      continue
    }
    if (ch !== '~' && /^[A-Za-z0-9._-]$/.test(ch)) {
      readable += ch
      separatorRun = false
      continue
    }
    readable += `~${code.toString(16).toUpperCase().padStart(4, '0')}`
    separatorRun = false
  }
  const head = readable.replace(/^-+/, '') || 'root'
  return `--${head.slice(0, 251)}--`
}

/**
 * sessionId → 会话目录名，照抄 DSH 的 encodeSegment()。
 *
 * UUID 全部落在 `[A-Za-z0-9._-]` 里，所以实际结果就是原样；但 `session-<uuid>`
 * 之外的 id 形态（或将来 DSH 换了 id 规则）必须靠这条兜住，不能想当然。
 */
export function encodeSessionSegment(raw) {
  const value = String(raw ?? '')
  let out = ''
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i)
    const ch = String.fromCharCode(code)
    if (ch === '~' || !/^[A-Za-z0-9._-]$/.test(ch)) {
      out += `~${code.toString(16).toUpperCase().padStart(4, '0')}`
      continue
    }
    out += ch
  }
  return out
}

/**
 * 读一份 session.v4.jsonl 的首行，取出 `cwd` 与 `id`。
 *
 * 为什么需要它：DSH 在 `assertStoredIdentity()` 里拿磁盘路径跟
 * `generationLogPath(root, header.cwd, header.id, ...)` 逐字比对，对不上就判
 * corrupt → `listArtifacts()` 抛 → 界面「打开失败 / unknown session」。
 * 所以「这份 jsonl 该落在哪个项目目录」只能由它**自己的 cwd** 决定，
 * 不能用一个全局猜出来的项目名去套。
 *
 * 只是读第一行，文件可能很大，所以用 readline 而不是整个读进来。
 * 解析失败返回 undefined，让调用方退回旧逻辑。
 */
export async function readSessionHeader(fileAbs) {
  try {
    const { createReadStream } = await import('node:fs')
    const { createInterface } = await import('node:readline')
    const stream = createReadStream(fileAbs, { encoding: 'utf8' })
    const reader = createInterface({ input: stream, crlfDelay: Number.POSITIVE_INFINITY })
    try {
      for await (const line of reader) {
        if (line.trim() === '') continue
        const parsed = JSON.parse(line)
        if (parsed && typeof parsed === 'object' && typeof parsed.id === 'string' && parsed.id !== '') {
          return {
            id: parsed.id,
            cwd: typeof parsed.cwd === 'string' ? parsed.cwd : undefined,
            type: typeof parsed.type === 'string' ? parsed.type : undefined,
          }
        }
        return undefined
      }
      return undefined
    } finally {
      reader.close()
      stream.destroy()
    }
  } catch {
    return undefined
  }
}

/**
 * 一份 session jsonl 按 DSH 规则应该落在的绝对路径。
 *
 * `sessionsRoot` 是 `<appRoot>/dsh-runtime/sessions`（手机上是 `.../data/sessions`）。
 * header 里没有 cwd 时返回 undefined —— 那种情况只能靠调用方兜底。
 */
export function sessionPathForHeader(sessionsRoot, header) {
  if (!sessionsRoot || !header || typeof header.id !== 'string' || header.id === '') return undefined
  const project = typeof header.cwd === 'string' && header.cwd !== '' ? encodeProjectDir(header.cwd) : '_no-cwd'
  return path.join(sessionsRoot, project, encodeSessionSegment(header.id), 'session.v4.jsonl')
}

async function readSessionIdsFromDatabase(dbPath) {
  const ids = new Set()
  if (!dbPath) return ids
  let handle
  try {
    const { DatabaseSync } = await import('node:sqlite')
    try {
      handle = new DatabaseSync(dbPath, { readOnly: true })
    } catch {
      handle = new DatabaseSync(dbPath)
    }
    for (const row of handle.prepare('SELECT id FROM chat_sessions').all()) ids.add(String(row.id))
  } catch {
    // 库读不了（被独占 / 版本不兼容）就退回按文件时间判断，不影响主流程
  } finally {
    try {
      handle?.close()
    } catch {
      // 关不掉就算了
    }
  }
  return ids
}

/**
 * 判断 `sessions/<项目目录>` 里哪一个是「本机的」，以及这个判断有多大把握。
 *
 * 项目目录名是 cwd 的路径编码。cwd 会变（Android 上数据根从 `runtime/` 换成
 * `unified-runtime/` 就变过一次），一变就会多出一个名字，而旧名字里还留着完整历史。
 * 所以**编码结果不能单独作数**，必须跟磁盘/数据库里的事实对一遍：
 *
 *   1. 先按库里 `chat_sessions` 的 id 给每个目录打票（有多少个会话真躺在里面）；
 *   2. 编码命中的那个目录，只有「它的票数不低于最高票」时才采用 —— 否则说明
 *      编码算出来的名字是个空壳，真正装着数据的是另一个目录；
 *   3. 没有库可投（空机器 / 库读不了）时才退回编码命中；
 *   4. 只有一个目录就直接用它；
 *   5. 全都判不出来时**不做决定**（confident=false），只把现状报给面板。
 *      猜错的方向是灾难性的：会把本机正在写的那一支当成「多余的」挪走。
 *
 * `cwdHints` 是 `{from, value}` 数组，`from` 只用于日志，`value` 是当时的 cwd。
 */
async function pickSelfProject(sessionsAbs, dbPath, cwdHints = []) {
  if (!sessionsAbs) return { name: SELF_PROJECT, confident: false, reason: '没有会话目录' }
  let names = []
  try {
    const entries = await fsp.readdir(sessionsAbs, { withFileTypes: true })
    names = entries.filter(entry => entry.isDirectory() && !entry.name.startsWith('.')).map(entry => entry.name)
  } catch {
    return { name: SELF_PROJECT, confident: false, reason: '会话目录读不了' }
  }
  if (names.length === 0) return { name: SELF_PROJECT, confident: false, reason: '会话目录是空的' }

  // 每个目录里真有几个库认的会话
  const ids = await readSessionIdsFromDatabase(dbPath)
  const scores = new Map()
  let best = ''
  let bestScore = 0
  if (ids.size > 0) {
    for (const name of names) {
      let score = 0
      for (const id of ids) {
        if (await exists(path.join(sessionsAbs, name, id, 'session.v4.jsonl'))) score += 1
      }
      scores.set(name, score)
      if (score > bestScore) {
        bestScore = score
        best = name
      }
    }
  }

  const hinted = []
  for (const hint of cwdHints) {
    const value = hint && hint.value
    if (!value) continue
    const encoded = encodeProjectDir(value)
    const hit = names.find(name => name === encoded)
    if (hit) hinted.push({ name: hit, from: hint.from })
  }

  for (const item of hinted) {
    const hitScore = scores.get(item.name) ?? 0
    // 编码命中，且它就是（或并列）装数据最多的那个 —— 可信
    if (bestScore === 0 || hitScore >= bestScore) {
      return { name: item.name, confident: true, reason: `按 ${item.from} 判定，含 ${hitScore} 个会话` }
    }
    // 编码命中了个空壳，真正有数据的是别的目录：以数据为准
    if (best !== '') {
      return {
        name: best,
        confident: true,
        reason: `按 ${item.from} 算出的 ${item.name} 里只有 ${hitScore} 个会话，改用含 ${bestScore} 个的 ${best}`,
      }
    }
  }

  if (best !== '' && bestScore > 0) {
    return { name: best, confident: true, reason: `库里有 ${bestScore} 个会话对得上` }
  }
  if (names.length === 1) return { name: names[0], confident: true, reason: '只有一个项目目录' }
  return { name: names[0], confident: false, reason: `${names.length} 个项目目录，无法判断哪个是本机` }
}

const layoutCache = new Map()

/**
 * 解出「本机这份数据在哪」。rel 键保持桌面那套 canonical 名字，只把绝对路径换掉。
 *
 * 每个逻辑项按候选顺序取**第一个真实存在**的那个；一个都不存在时退回第一个候选
 * （读不到就当空目录，不会凭空造出来）。结果按 appRoot 缓存在进程内。
 */
export async function resolveLayout(appRoot) {
  const root = path.resolve(appRoot)
  const cached = layoutCache.get(root)
  if (cached) return cached
  const spec = layoutSpec(root)
  const pick = async candidates => {
    const list = candidates.filter(item => typeof item === 'string' && item !== '')
    for (const candidate of list) {
      if (await exists(candidate)) return { abs: candidate, exists: true }
    }
    return { abs: list[0] ?? '', exists: false }
  }
  const dirs = []
  for (const [rel, candidates] of spec.dirs) {
    const hit = await pick(candidates)
    dirs.push({ rel, abs: hit.abs, exists: hit.exists, candidates: candidates.filter(Boolean) })
  }
  const files = []
  for (const [rel, candidates] of spec.files) {
    const hit = await pick(candidates)
    files.push({ rel, abs: hit.abs, exists: hit.exists, candidates: candidates.filter(Boolean) })
  }
  let db = await pick(spec.db)
  if (!db.exists) {
    // 最后兜底：appRoot 里随便哪个 *.sqlite3 —— 名字可能不叫 eleckoi-common。
    try {
      const entries = await fsp.readdir(root, { withFileTypes: true })
      const found = entries.find(entry => entry.isFile() && /\.sqlite3$/i.test(entry.name))
      if (found) db = { abs: path.join(root, found.name), exists: true }
    } catch {
      // 读不了就用候选
    }
  }
  const sessionsDir = dirs.find(item => item.rel === SESSIONS_REL)
  /**
   * cwd 线索：同一台机器上 DSH 的项目目录名就是「工作区」的路径编码。
   * 桌面端工作区是 `<appRoot>/workspace`；Android 上解析出来的 appRoot 是
   * `<runtime>/workspace/pc`，工作区是它的上一层。两种都试，命中就用。
   */
  const cwdHints = []
  for (const key of ['DSH_CWD', 'ELECKOI_WORKSPACE_ROOT']) {
    if (process.env[key]) cwdHints.push({ from: key, value: process.env[key] })
  }
  cwdHints.push({ from: 'appRoot/workspace', value: path.join(root, 'workspace') })
  cwdHints.push({ from: 'appRoot 的上一层', value: path.dirname(root) })
  const picked = await pickSelfProject(sessionsDir?.abs, db.exists ? db.abs : undefined, cwdHints)
  const layout = {
    appRoot: root,
    db,
    dirs,
    files,
    selfProject: picked.name,
    selfProjectConfident: picked.confident,
    selfProjectReason: picked.reason,
  }
  layoutCache.set(root, layout)
  return layout
}

export function dbWalPaths(appRoot, layout) {
  const db = layout && layout.db && layout.db.abs ? layout.db.abs : path.join(appRoot, DB_FILE)
  return { db, wal: `${db}-wal`, shm: `${db}-shm` }
}

/**
 * 本机项目目录的真实名字。
 *
 * `layout.selfProject` 正常情况下就是它；探不出来（空机器、没有库、环境变量也没给）
 * 时用 cwd / appRoot 现算一个，保证下载有地方落，也不会写到 sessions 根上。
 */
export function selfProjectName(layout) {
  if (layout && typeof layout.selfProject === 'string' && layout.selfProject !== SELF_PROJECT) return layout.selfProject
  const cwd = process.env.DSH_CWD || process.env.ELECKOI_WORKSPACE_ROOT || (layout && layout.appRoot)
  return encodeProjectDir(cwd)
}

function sessionsDirEntry(layout) {
  return layout.dirs.find(item => item.rel === SESSIONS_REL)
}

/**
 * 本机会话目录（`<sessions>/<本机项目>`）的绝对路径。
 *
 * 判断不出哪个项目目录是本机的（`selfProjectConfident !== true`）时返回 undefined：
 * 宁可这一轮不搬会话文件，也不能把文件写进别人的项目目录 —— 那会直接覆盖另一台
 * 机器正在写的那一支，比不同步严重得多。
 */
export function sessionsSelfAbs(layout) {
  const entry = sessionsDirEntry(layout)
  if (!entry || !entry.abs) return undefined
  if (layout && layout.selfProjectConfident === false) return undefined
  return path.join(entry.abs, selfProjectName(layout))
}

/** `<appRoot>/dsh-runtime/sessions`（手机上解出来是 `.../data/sessions`）的绝对路径。 */
export function sessionsRootOf(layout) {
  const entry = sessionsDirEntry(layout)
  return entry && entry.abs ? entry.abs : undefined
}

/** 从 canonical 会话键里取 sessionId；不是会话键就返回 undefined。 */
export function sessionIdFromRel(rel) {
  const normalized = String(rel).replace(/\\/g, '/')
  const prefix = `${SESSIONS_REL}/${SELF_PROJECT}/`
  if (!normalized.startsWith(prefix)) return undefined
  const rest = normalized.slice(prefix.length)
  const slash = rest.indexOf('/')
  if (slash <= 0) return undefined
  return rest.slice(0, slash)
}

/**
 * 在**所有**项目目录里找同一个 sessionId 的副本，按「大 → 新」排序。
 *
 * 不能直接用 `localPathFor()`：那个函数只认「本机项目目录」一支，而本机可能
 * 同时存在两套项目目录（Android 数据根从 `runtime/` 换成 `unified-runtime/`
 * 就是这么来的）。上传时必须挑真实存在且内容最全的那一份。
 */
export async function findSessionCopies(layout, sessionId) {
  const root = sessionsRootOf(layout)
  if (!root || typeof sessionId !== 'string' || sessionId === '') return []
  let names = []
  try {
    const entries = await fsp.readdir(root, { withFileTypes: true })
    names = entries.filter(entry => entry.isDirectory() && !entry.name.startsWith('.')).map(entry => entry.name)
  } catch {
    return []
  }
  const segment = encodeSessionSegment(sessionId)
  const hits = []
  for (const name of names) {
    const dirAbs = path.join(root, name, segment)
    const file = path.join(dirAbs, 'session.v4.jsonl')
    try {
      const stat = await fsp.stat(file)
      hits.push({ project: name, dirAbs, file, size: stat.size, mtimeMs: Math.round(stat.mtimeMs) })
    } catch {
      // 这个项目目录里没有这条会话
    }
  }
  hits.sort((a, b) => b.size - a.size || b.mtimeMs - a.mtimeMs)
  return hits
}

/** 找一份会话在本机的最佳副本（内容最全的那份）。 */
export async function bestSessionCopy(layout, sessionId) {
  const hits = await findSessionCopies(layout, sessionId)
  return hits.length > 0 ? hits[0] : undefined
}

/**
 * canonical rel → 本机绝对路径。
 *
 * 两个方向都要用：上传时要知道本地文件在哪，下载时要知道写到哪。
 * 目录项取 rel 之后那段相对路径拼到真实目录上，所以里面的子结构（会话 id、
 * media 分桶）仍然是原样。
 *
 * 会话目录里的 `@self` 要换回本机项目目录的真名 —— 这是让同一个 sessionId
 * 在两端只有一个键的关键。
 */
export function localPathFor(layout, rel) {
  const normalized = String(rel).replace(/\\/g, '/')
  if (normalized === DB_FILE) return layout.db.abs
  for (const dir of layout.dirs) {
    if (normalized === dir.rel) {
      return dir.rel === SESSIONS_REL ? sessionsSelfAbs(layout) : dir.abs
    }
    if (normalized.startsWith(`${dir.rel}/`)) {
      const rest = normalized.slice(dir.rel.length + 1)
      if (dir.rel === SESSIONS_REL) {
        const selfAbs = sessionsSelfAbs(layout)
        if (selfAbs === undefined) return undefined
        const selfPrefix = `${SELF_PROJECT}/`
        if (!rest.startsWith(selfPrefix)) return undefined
        return path.join(selfAbs, rest.slice(selfPrefix.length))
      }
      return path.join(dir.abs, rest)
    }
  }
  for (const file of layout.files) {
    if (normalized === file.rel) return file.abs
  }
  return undefined
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
  const layout = await resolveLayout(appRoot)
  const { db, wal } = dbWalPaths(appRoot, layout)
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
    // 键永远是 DB_FILE：远端 manifest 里认的是这个名字，两端才能对上。
    out.set(DB_FILE, { size: dbSize, mtimeMs: dbMtime })
  }
  for (const dir of layout.dirs) {
    if (!dir.abs) continue
    if (dir.rel === SESSIONS_REL) {
      // 会话区要把**所有**项目目录都扫进来，每个会话按自己的 id 折成
      // `@self/<sid>/...`。以前只扫「猜出来的本机项目目录」那一支，结果：
      //   - 本机若有两套项目目录（数据根从 runtime 换成 unified-runtime 那种），
      //     另一套里的历史根本不上传；
      //   - 猜错目录名时整片会话区被当成空，同步器反而把远端的东西往下灌。
      // 折成 @self 之后同一个 sessionId 只有一个键，planSync 那边再折一次也幂等。
      const scanned = new Map()
      await walk(dir.abs, dir.rel, scanned)
      for (const [rel, meta] of scanned) out.set(canonicalRel(rel), meta)
      continue
    }
    await walk(dir.abs, dir.rel, out)
  }
  for (const file of layout.files) {
    if (!file.abs) continue
    try {
      const stat = await fsp.stat(file.abs)
      out.set(file.rel, { size: stat.size, mtimeMs: Math.round(stat.mtimeMs) })
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

/**
 * 把任意一层项目目录名折成 `@self`。
 *
 * 用来收拾历史遗留：远端 manifest 与远端目录里早就有一堆
 * `dsh-runtime/sessions/--D-...--/<sid>/...` 和
 * `dsh-runtime/sessions/--data-user-10-...--/<sid>/...`，
 * 那正是 duplicate 的来源。读进来时统一折成 `@self`，写出去自然只剩一份。
 */
export function canonicalRel(rel) {
  const normalized = String(rel).replace(/\\/g, '/')
  const prefix = `${SESSIONS_REL}/`
  if (!normalized.startsWith(prefix)) return normalized
  const rest = normalized.slice(prefix.length)
  const slash = rest.indexOf('/')
  if (slash < 0) return normalized
  return `${prefix}${SELF_PROJECT}/${rest.slice(slash + 1)}`
}

/** 把一份清单里的会话键全部折成 @self；同一个 sessionId 出现多次时留较新较大的那份。 */
export function canonicalizeMap(files) {
  return canonicalizeWithSource(files).files
}

/**
 * 折键的同时记下「每个 canonical 键实际对应哪一条原始路径」。
 *
 * 远端还留着上一版写的两套项目目录（`--D-...--` 与 `--data-user-10-...--`），
 * 折叠之后逻辑上只剩一份，但真要去读的时候得知道原路径在哪 —— 否则下载会
 * 去敲一个根本不存在的 `@self/...`。
 */
export function canonicalizeWithSource(files) {
  const out = new Map()
  const source = new Map()
  for (const [rel, meta] of files) {
    const key = canonicalRel(rel)
    const existing = out.get(key)
    const better =
      existing === undefined ||
      (meta?.size ?? 0) > (existing.size ?? 0) ||
      ((meta?.size ?? 0) === (existing.size ?? 0) && (meta?.mtimeMs ?? 0) > (existing.mtimeMs ?? 0))
    if (better) {
      out.set(key, meta)
      source.set(key, rel)
    }
  }
  return { files: out, source }
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
  //
  // 会话项还要先折成 @self：上一版插件把两个项目目录都镜像上去了，远端 manifest
  // 里于是有同一个 sessionId 的两条记录。不折的话它们会被当成两个不同文件，
  // 各自下载一份回到本地 —— 那正是 DSH 报 duplicate JSONL session id 的直接原因。
  const localFiles = canonicalizeMap(new Map([...local].filter(([rel]) => isSyncedRel(rel))))
  const remoteFiles = canonicalizeMap(new Map([...remote].filter(([rel]) => isSyncedRel(rel))))

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

/**
 * 按「每份 jsonl 自己的 header.cwd」把会话放回 DSH 要求的位置，并清掉多余副本。
 *
 * 为什么不能再「挑一个本机项目目录、其余都搬进去」：DSH 在
 * `assertStoredIdentity()` 里用 `generationLogPath(root, header.cwd, header.id, ...)`
 * 算出期望路径，再跟磁盘上的真实路径逐字比对，**不一致就判该条 corrupt**，
 * `listArtifacts()` 于是整个 reject，界面表现是「打开失败 / unknown session」。
 * 也就是说，落点只能由每份文件自己的 cwd 决定，用任何「全局项目名」去套都会有一部分对不上
 * —— 手机端数据根从 `runtime/` 换成 `unified-runtime/` 之后，两种 cwd 的会话同时存在。
 *
 * 规则：
 *   1. 扫 `sessions/<项目目录>/<sid>/session.v4.jsonl`，逐份读首行拿 `id` 与 `cwd`；
 *   2. 同一个 id 只留一份（大小优先，其次 mtime）；
 *   3. 留下的那份挪到 `projectKey(它自己的 cwd)/encodeSegment(id)/`；
 *   4. 其余副本与空掉的项目目录移进 `<metaDir>/quarantine/<时间戳>/`，不硬删。
 *
 * 读不出 header 的文件一律不动（宁可不同步，也不猜）。
 *
 * 返回 { kept, moved, quarantined, backupDir, unfixable }，供日志与面板展示。
 */
export async function consolidateSessions(layout, metaDir, logger = () => {}) {
  const root = sessionsRootOf(layout)
  const empty = { kept: 0, moved: 0, quarantined: [], backupDir: undefined, unfixable: 0 }
  if (!root) return empty
  let names = []
  try {
    const entries = await fsp.readdir(root, { withFileTypes: true })
    names = entries.filter(item => item.isDirectory() && !item.name.startsWith('.')).map(item => item.name)
  } catch {
    return empty
  }
  if (names.length === 0) return empty

  // 收集所有副本，按 header.id 归组
  const groups = new Map()
  let unfixable = 0
  for (const name of names) {
    const projectAbs = path.join(root, name)
    let ids = []
    try {
      const entries = await fsp.readdir(projectAbs, { withFileTypes: true })
      ids = entries.filter(item => item.isDirectory()).map(item => item.name)
    } catch {
      continue
    }
    for (const segment of ids) {
      const dirAbs = path.join(projectAbs, segment)
      const file = path.join(dirAbs, 'session.v4.jsonl')
      const header = await readSessionHeader(file)
      if (!header || header.id === '') {
        unfixable += 1
        continue
      }
      let stat
      try {
        stat = await fsp.stat(file)
      } catch {
        continue
      }
      const item = { header, segment, project: name, dirAbs, file, size: stat.size, mtimeMs: Math.round(stat.mtimeMs) }
      const list = groups.get(header.id)
      if (list === undefined) groups.set(header.id, [item])
      else list.push(item)
    }
  }
  if (groups.size === 0) return { ...empty, unfixable }

  const stamp = timestampSlug()
  const quarantineRoot = metaDir ? path.join(metaDir, 'quarantine', stamp) : undefined
  const moveToQuarantine = async (fromAbs, suffix) => {
    if (quarantineRoot === undefined) {
      await fsp.rm(fromAbs, { recursive: true, force: true })
      return '(删除)'
    }
    const to = path.join(quarantineRoot, suffix)
    await fsp.mkdir(path.dirname(to), { recursive: true })
    await fsp.rm(to, { recursive: true, force: true })
    await fsp.rename(fromAbs, to)
    return to
  }

  let moved = 0
  const quarantined = []
  for (const [id, list] of groups) {
    list.sort((a, b) => b.size - a.size || b.mtimeMs - a.mtimeMs)
    const best = list[0]
    const expected = sessionPathForHeader(root, best.header)
    if (expected === undefined) {
      unfixable += list.length
      continue
    }
    const expectedDir = path.dirname(expected)

    // 先把多余副本搬走，再归位 best。
    // 顺序不能反：某个副本可能正好占着 expectedDir（它本来就在「正确」位置，只是内容不是最新的），
    // 归位时会先 rm 掉它再 rename best 进去；若把它留到归位之后再「移走」，
    // 那时它的 dirAbs 已经是 best 刚搬进去的那份，等于把刚归位的结果再扔进 quarantine。
    const bestAbs = path.resolve(best.dirAbs)
    for (const item of list.slice(1)) {
      const itemAbs = path.resolve(item.dirAbs)
      if (itemAbs === bestAbs) continue
      if (itemAbs === path.resolve(expectedDir)) {
        // 占着目标位置的旧副本：归位时会被 rm 覆盖，不必搬
        await logger(`会话 ${id} 的目标位置已有一份旧副本，归位时会被替换`, {
          at: path.relative(root, item.dirAbs),
          size: item.size,
        })
        continue
      }
      try {
        const to = await moveToQuarantine(
          item.dirAbs,
          `${item.project}${path.sep}${item.segment}`,
        )
        quarantined.push(`${item.project}/${item.segment}`)
        await logger(`会话 ${id} 的多余副本已移走`, { from: item.project, to })
      } catch (error) {
        await logger(`会话 ${id} 的多余副本移走失败`, {
          error: error instanceof Error ? error.message : String(error),
        })
      }
    }

    if (path.resolve(best.dirAbs) !== path.resolve(expectedDir)) {
      try {
        await fsp.mkdir(path.dirname(expectedDir), { recursive: true })
        await fsp.rm(expectedDir, { recursive: true, force: true })
        await fsp.rename(best.dirAbs, expectedDir)
        moved += 1
        await logger(`会话 ${id} 已按它自己的 cwd 归位`, {
          from: path.relative(root, best.dirAbs),
          to: path.relative(root, expectedDir),
        })
      } catch (error) {
        await logger(`会话 ${id} 归位失败，已跳过`, {
          error: error instanceof Error ? error.message : String(error),
        })
        continue
      }
    }
  }

  // 收掉空掉的项目目录（DSH 会去扫它们，留着只会再触发一次 duplicate）
  for (const name of names) {
    const projectAbs = path.join(root, name)
    try {
      const left = await fsp.readdir(projectAbs)
      if (left.length > 0) continue
      await moveToQuarantine(projectAbs, `${name}__empty`)
      quarantined.push(`${name}（空目录）`)
    } catch {
      // 读不了 / 已不存在都跳过
    }
  }

  layoutCache.delete(path.resolve(layout.appRoot))
  return { kept: groups.size, moved, quarantined, backupDir: quarantineRoot, unfixable }
}

/** 把当前数据整份复制到备份目录，供应用失败时回滚。 */
export async function backupLocal(appRoot, targetDir) {
  await fsp.mkdir(targetDir, { recursive: true })
  const copied = []
  const layout = await resolveLayout(appRoot)
  const { db } = dbWalPaths(appRoot, layout)
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
  for (const dir of layout.dirs) {
    if (!dir.abs || !dir.exists) continue
    const to = path.join(targetDir, dir.rel)
    try {
      await fsp.mkdir(path.dirname(to), { recursive: true })
      await fsp.cp(dir.abs, to, { recursive: true, force: true })
      copied.push(`${dir.rel} ← ${dir.abs}`)
    } catch {
      // 目录不存在（例如还没产生附件）
    }
  }
  for (const file of layout.files) {
    if (!file.abs || !file.exists) continue
    const to = path.join(targetDir, file.rel)
    try {
      await fsp.mkdir(path.dirname(to), { recursive: true })
      await fsp.copyFile(file.abs, to)
      copied.push(`${file.rel} ← ${file.abs}`)
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
export async function clearWalShm(appRoot, layout) {
  const resolved = layout ?? (await resolveLayout(appRoot))
  const { wal, shm } = dbWalPaths(appRoot, resolved)
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
  const layout = await resolveLayout(appRoot)
  const { db } = dbWalPaths(appRoot, layout)
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
