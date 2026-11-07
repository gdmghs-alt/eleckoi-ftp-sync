# eleckoi-ftp-sync

ElecKoi（DeepSeek Harness 桌面端）插件：把宿主机数据目录与 FTP 服务器做**双向同步**，按文件修改时间比对，谁新谁覆盖。点一下「同步并重启」，守护进程等你关掉 ElecKoi，自动备份 → 应用 → 重新拉起。

用途很土：两台机器（比如台式 + 笔记本，或者电脑 + 手机端浏览器）轮流用同一套角色卡 / 会话记录 / 世界书，不想手动拷 3GB 的目录。

---

## 它同步什么

| 同步 | 路径（相对 `appRoot`，即 `%APPDATA%\eleckoi-desktop`） | 是什么 |
|---|---|---|
| ✅ | `eleckoi-common.sqlite3` | 角色卡、世界书、**Agent 预设**（`agent_preset_*` 表）、会话元数据 |
| ✅ | `dsh-runtime/sessions` | 对话正文 `session.v4.jsonl` |
| ✅ | `dsh-runtime/session-snapshots` | 每个会话挂的预设、模型、推理档位、禁用的工具组 |
| ✅ | `dsh-runtime/generated-presets` | 由预设表渲染出的 `preset.json` |
| ✅ | `dsh-runtime/home/attachments` | 聊天里贴的附件正文 |
| ✅ | `dsh-runtime/home/llm-deepseek/files-v3.json` | 附件索引（只带这一个文件），`fileId` ↔ sha256 映射 |
| ✅ | `media` | 图片资源 |
| ✅ | `author-scripts` | 作者脚本 |
| ❌ | 缓存、`logs`、`node_modules`、`.plugin-manager`、`*-wal`、`*-shm`、`*.bak-*` | |
| ❌ | `dsh-runtime/home/remote`、`.credentials.yaml`、`profiles` | 设备私钥、服务器凭据、API key、本机插件路径 |

关于 Agent 预设：**预设本体就在 `eleckoi-common.sqlite3` 里**（`agent_presets` / `agent_preset_versions` / `agent_preset_contents` / `agent_preset_entries` / `agent_preset_groups` / `agent_preset_state`），跟着数据库一起走。

但只同步数据库是不够的：`session-snapshots` 记录「这个会话当时挂的是哪个预设、哪个模型」，少了它换机器打开旧对话会静默回落到默认预设。
`generated-presets` 是从预设表渲染出来的产物，属于派生物，缺了下次创建会话会自动重建；一起带上只是让远端立刻有一份可读的预设定义。

远端真值不是 FTP 的 mtime（FTP 的 `MDTM` 精度和时区都不可靠），而是远端一份 manifest：

```
.eleckoi-sync/manifest.json
{ "version": 1, "updatedAt": 1789..., "device": "desktop", "files": { "<rel>": { "size": 123, "mtimeMs": 1789... } } }
```

每次同步先拉 manifest，再和本地 `stat` 对比，算出 `uploads / downloads / skipped / conflicts`，最后才动数据。

---

## 安装

插件通过 DSH 的 bundle 机制加载，需要两处同时存在：

1. `profiles/<name>/package.json` 的 `dependencies` 里有一条 `link:` 指向本目录（或发布后的包）
2. 同一个 `package.json` 的 `dsh.profile.bundles` 数组里有 `"eleckoi-ftp-sync"`

然后把 `profiles/<name>/node_modules/eleckoi-ftp-sync` 建成指向源码目录的 junction。改完**重启宿主机**才生效（客户端 JS 是启动时一次性加载的）。

> Windows 上做 junction：
> ```
> cmd /c mklink /J "…\profiles\desktop\node_modules\eleckoi-ftp-sync" "…\workspace\eleckoi-ftp-sync"
> ```

---

## 用法

重启后最左侧导航栏多一个图标（同步箭头），点开是整页面板：

- **检查差异** —— 只比对不传输，告诉你会上传多少、下载多少、哪些冲突
- **同步并重启** —— 写 job，拉起守护进程，然后你手动关掉 ElecKoi；守护进程接手（仅桌面端）
- **立即同步（不重启）** —— 不关程序，当场比对并替换文件；手机上必须用这条
- **只从 FTP 下载** / **只上传到 FTP** —— 单向，不会反向覆盖
- **强制从 FTP 覆盖本机** —— 不看时间戳，远端有什么就盖什么；本机被换坏了用这条
- **取消** —— 撤掉等待中的守护进程
- **看日志** —— 读最近一次同步的完整日志
- **刷新状态** —— 手动拉一次 `status`
- **诊断环境** —— 把 `appRoot` 的推导过程摊开（候选路径、环境变量、命中证据），手机端找不到数据目录时靠它
- **列出恢复点** / **预演** / **确认回滚** —— 把之前那份数据拿回来，见下一节

FTP 地址 / 端口 / 账号 / 密码 / 远端目录都能在面板里改，保存后写到 `<appRoot>/eleckoi-sync/config.json`，比 `cordis.patch.yml` 里的默认值优先。

**建议先在面板里「检查差异」跑一遍**，看清楚方向和条数再点同步。

### 同步弄坏了怎么退回去

插件每次要覆盖本机之前，都会先把现场整份复制到 `<appRoot>/eleckoi-sync/backups/<时间戳>/`；归并会话目录时，被判成「不属于本机」的那一支会整目录挪到 `quarantine/<时间戳>/` 而不是删掉。两处都能从面板回滚：

1. 点 **列出恢复点** —— 每个点显示：类型（覆盖前备份 / 归并收容）、时间戳、文件数、体积、是否含数据库、包含哪些会话 id、磁盘路径。
2. 点 **预演 `<时间戳>`** —— 只算要覆盖哪些文件，一个字节都不写。看清单确认对不对。
3. 点 **确认回滚 `<时间戳>`** —— 逐个写回。主库排最前（Windows 上库被占用时 rename 会 EBUSY，先动它，失败就立刻中止，别的文件一个都还没动）。
4. **完全退出并重新打开 ElecKoi**，新数据才会被读到。

回滚只覆盖本机，不碰远端 —— 所以任何时候做都不会把远端也搞坏。只覆盖恢复点里存在的那部分文件，本机多出来的一律不动（宁可少删，也不要因为路径算错把其它数据带走）。

备份存的是**逻辑名**（`dsh-runtime/sessions/…`），但 `sessions` 底下那层仍是备份当时的真实项目目录名；回滚时先按逻辑名折成 `@self` 键，再用本机当前的布局落到该在的位置。所以跨设备、跨版本布局都能回滚对。

如果本机**一个备份都没有**（手机上第一次装插件就是这种情况），用 **强制从 FTP 覆盖本机**：它跳过时间比对、只朝一个方向写，把远端那份整体盖上来。这条路的前提是远端那份是好的。

### 桌面端 vs Android

| | 桌面（Windows / macOS / Linux） | Android 独立 App |
|---|---|---|
| 「同步并重启」 | 可用：守护进程等你关程序 | 不可用，按了会报 `guardian-unsupported` |
| 「立即同步」 | 可用，但数据库被占用时可能 EBUSY | **推荐**：就地替换，完了自己从后台划掉 App 再打开 |
| appRoot 来源 | `%APPDATA%\eleckoi-desktop` | 按 `dsh-runtime` / 库文件特征自动探测，认不出就靠诊断面板人工指定 |
| 会话目录 | `dsh-runtime/sessions/--D-...-workspace--/` | `…/no_backup/runtime/data/sessions/--data-user-10-…--/` —— 名字不同，但同步键统一成 `@self`，照常互通 |

Android 是 unlink + rename：正在跑的进程继续握着旧 inode，所以替换完**必须**完全退出 App 再打开，新数据才会被读到。界面会用 `needsRestart` 告诉你这一条。

**两端目录布局不一样也没关系**：同步范围里的每一项都用固定的逻辑名做键（`dsh-runtime/sessions/…`、`media/…`、`eleckoi-common.sqlite3`），实际路径每次在本机现解。桌面对上 `dsh-runtime/sessions`，Android 对上的可能是 `<data>/no_backup/runtime/data/sessions` —— 键一样就算同一个文件，照常双向比时间。面板里「本机数据布局」那块会把每一项解到哪条路径、缺哪一项全列出来。

### 找不到数据目录怎么办

面板报「找不到 ElecKoi 数据目录」，说明自动探测没认出 `appRoot`（Android 上尤其常见，各家的私有目录布局不一样）。

1. 点 **诊断环境**。它会列出：最终认到的目录、平台/架构、是否跑在 Electron 里、所有参与推导的环境变量、所有候选路径（命中的前面打 `✓`，后面附上是靠哪个特征认出来的），以及
   - **找到的 dsh-runtime / 数据库所在层** —— 往下扫 3 层，把名字叫 `dsh-runtime` 的目录、以及躺着 `*.sqlite3` 的目录全列出来；
   - **目录普查** —— 每个种子目录的一级内容，看得出 Android 那边到底怎么摆的。
2. 在「找到的 dsh-runtime / 数据库所在层」里挑一个最像的（通常是**同时有 `sessions`、`home` 的那一层**），填进「数据目录」输入框，点 **使用这个目录**。
3. 这个值存在浏览器 `localStorage`，之后每次调用都会带上；host 侧会先验证「里面真有 `dsh-runtime`、`eleckoi-common.sqlite3`，或者至少有几个成员目录 / 任意 `.sqlite3`」才采纳，填错不会有副作用，点 **清空** 就回到自动探测。

手机端（Android 独立 App）实测的目录形状大致是 `/data/user/10/<包名>/...`，`HOME` 指向 `.../no_backup/runtime/home`，**没有桌面那种 `dsh-runtime` 中间层**，所以自动探测在手机上经常认不出来 —— 只能靠诊断面板人工确认一次，之后就一直记住了。

之所以把覆盖值放在前端而不是配置文件：配置文件本来就在 `appRoot` 里面，探测失败时恰好没有可写的地方。

---

## 守护进程干了什么

```
你点「同步并重启」
  → 写 <appRoot>/eleckoi-sync/jobs/job-<ts>.json（含宿主 pid）
  → spawn(node, lib/guardian.js, jobPath)，detached + unref
你关掉 ElecKoi
  → guardian 轮询宿主 pid 直到退出
  → sleep 2s（等文件句柄释放）
  → 再算一次 plan（这中间本机可能又改过东西）
  → 有下载项 → 先把要覆盖的文件备份到 <appRoot>/eleckoi-sync/backups/<slug>/
  → 下载到 <target>.incoming，校验 size 一致后再 rename
  → 替换前清掉 <db>-wal / <db>-shm（否则 sqlite 会拒绝打开）
  → 上传本机较新的文件
  → 写远端 manifest
  → 重新拉起 ElecKoi
```

日志落在 `<appRoot>/eleckoi-sync/logs/sync-<ts>.log`，状态落在同级的 `state.json`。

---

## 实现要点

- **零外部依赖**：`lib/ftp.js` 是手写的极简 FTP 客户端（`USER/PASS/TYPE I/PASV/EPSV/SIZE/MDTM/RETR/STOR/DELE/RNFR+RNTO`），不引 `basic-ftp`。所以 `dependencies` 是空对象，装的时候不会去拉网络包。
- **RPC 通道名必须以 `/` 开头**：DSH 的 `@deepseek-ai/dsh-client-connection` 里是 `const CHANNEL_PATTERN = /^\/[A-Za-z0-9._~-]+$/`，写 `eleckoi-ftp-sync` 会直接抛 `invalid or reserved RPC channel`，整个插件静默不激活。
- **不用 `ctx.connection.rpc.handle`**：它的内部 effect 会在子作用域里访问 `owner.webServer`，触发 "without inject" 报错。改成自己 `webServer.register({ kind: 'prefix', path: CHANNEL, handler })`，手写 `POST <channel>/<endpoint>`，回 `{ type: 'server-response', rpcId, result }`，请求先过 `connection.requestRejection({ headers })`。
- **导航项要能显示**：`sidebar.panellist` 里的项只有在 `main` slot 存在同 `key` 的页面时才渲染。所以本插件同时注册 `main` 的 `key: 'ftp-sync'` 页面 + `sidebar.panellist` 的 `id: 'ftp-sync'` 图标。
- **服务端只读文件**：IIS 上文件一旦被标成只读，覆盖式 `STOR` 与 `DELE` 都回 `550 Access is denied`，而 `SITE ATTRIB` / `SITE CHMOD` 在 IIS 上是 `500 command not understood`。唯一还能做的是改名，所以上传被挡时用 `RNFR/RNTO` 把旧文件挪进 `.eleckoi-sync/trash/<时间戳>-<原名>`，腾出位置再传一次。只对「明确写了 Access is denied」的 550 这么做，目录不存在、磁盘满之类仍然照原样报错。
- **两条执行通道**：`start` 走守护进程（等宿主退出后再替换，最干净），`sync` 走进程内就地搬运。后者是为 Android 独立 App 准备的 —— 那边 `spawn` 起不了子进程，也没有「退出后重新拉起」，点「同步并重启」什么都不会发生。`lib/inline.js` 与 `lib/guardian.js` 共用 `lib/core.js` 的比对和备份逻辑，差别只在「谁来搬」。
- **appRoot 自动探测**：`detectAppRoot()` 不盲目相信环境变量（DSH 自己的进程里 `DSH_HOME=~/.dsh`，往上跳两层会落到用户主目录），而是拿候选目录去验证「里面有 `dsh-runtime` 或 `eleckoi-common.sqlite3`」，不成立就换下一个，最后才从 `APPDATA` / `HOME` 的已知落点里找。候选来源包括宿主注入的一整组变量（`DSH_HOME` / `DSH_SESSION_ROOT` / `ELECKOI_SESSION_SNAPSHOT_ROOT` / `ELECKOI_PRESET_ROOT` / `ELECKOI_DATABASE_PATH` / `ELECKOI_MEDIA_ROOT` …），各自按已知层级往上跳；还不行就从 `HOME` / `APPDATA` / `cwd` 往下做一次三层广度扫描。
- **探测失败可以手动兜底**：前端把目录存在 `localStorage`，每个 RPC 请求带一个 `appRootHint`；host 用 `hasAppRootEvidence()` 校验后才认。这样即使自动探测全落空，面板本身还能用（不然连配置都存不下来 —— 配置文件就在 `appRoot` 里）。
- **布局自适应**：`resolveLayout()` 把「逻辑名 → 本机真实路径」现解一遍。每个逻辑名给一串候选（appRoot 内的桌面式路径 → 往上 1~3 层的 Android 式路径 → 宿主注入的环境变量），取第一个真实存在的；数据库除了固定位置外，最后还会在 appRoot 里找任意 `*.sqlite3`。候选顺序是「appRoot 内优先、环境变量最后」—— 反过来会出事：在 DSH 自己的进程里 `DSH_HOME` 指向它自己的 home，先信它就会把那下面的 `attachments` 当聊天附件扫进去（实测文件数从 75 涨到 443）。
- **会话目录统一成 `@self`**：`dsh-runtime/sessions/<项目目录>/<sessionId>/session.v4.jsonl` 里的「项目目录」是 DSH 拿 cwd 编码出来的（`D:\...\workspace` → `--D-...-workspace--`），两台机器的 cwd 不可能一样。按原路径镜像的话，同一场对话在远端会变成两个文件，DSH 启动时 `listArtifacts()` 遍历所有项目目录、拿 `Set` 断言 sessionId 全局唯一，一撞就抛 `duplicate JSONL session id ... appears in multiple project directories`，整个会话的历史一条都载不出来（jsonl 本身完好）。所以 rel 键里固定写 `dsh-runtime/sessions/@self/<sid>/session.v4.jsonl`，落地时再换回本机真实的项目目录名 —— 远端一个 sessionId 永远只有一份。
- **本机项目目录怎么认**：`pickSelfProject()` 依次试 cwd 线索（`DSH_CWD` / `ELECKOI_WORKSPACE_ROOT` / `<appRoot>/workspace` / appRoot 的上一层）、「只有一个目录就是它」、用库里 `chat_sessions.id` 投票。三条全落空就**明确返回「判不出来」并且什么都不动** —— 猜错会把本机正在写的那一支当成「多余的」挪走，比不同步严重得多。「本机数据布局」里会显示判断依据和置信度。
- **历史遗留目录会自愈**：`consolidateSessions()` 把非本机项目目录里本机没有的会话搬进来，剩下的整目录挪到 `<appRoot>/eleckoi-sync/quarantine/<时间戳>/`（不删）；远端同理，`retireLegacySessionDirs()` 把 `dsh-runtime/sessions/` 下不是 `@self` 的历史目录 `RNFR/RNTO` 到 `.eleckoi-sync/remote-quarantine/<时间戳>/`，再重扫一遍。IIS 上整个目录改名是支持的（实测带三层子目录也能一次挪走）。
- **别把「列不出来」当「目录是空的」**：早期版本给 `list()` 加了 `.catch(() => undefined)`，数据连接一超时就被当成空目录，同步于是把本地整棵树重传一遍。现在 `collect()` 会区分「正常收完」和「被超时掐断」（`socket.eleckoiTimedOut`），后者直接抛；`withData` 的 `tolerateFailure` 只用于「服务端不认识这条命令」，不吞数据连接错误。
- **三个超时分开**：`connectTimeoutMs`（建 TCP，默认 12s）/ `timeoutMs`（控制通道等回复，20s）/ `dataTimeoutMs`（数据通道空闲，20s），都能在配置里覆盖。合成一个 30 秒的后果是：手机走错网段时每个文件都要干等 30 秒，面板看起来就是「点测试连接一直卡住」。
- **备份是可读回来的，不只是写着好看**：`backupLocal()` 只写不读的话，同步把本机换错了，Android 上用户连私有目录都进不去，等于没救。所以 `lib/restore.js` 把 `backups/` 和 `quarantine/` 都暴露成可枚举、可预演、可回滚的资源（`restore.list` / `restore.plan` / `restore.apply`）。回滚按逻辑名落回本机当前布局，单向覆盖本机、不碰远端。
- **强制下载是独立的开关**，不是「方向 = download」的同义词：`direction: 'download'` 仍然按时间比，只下载远端较新的；`forceDownload: true` 才跳过时间、远端有什么盖什么。因为「本机被换坏了」时坏数据的 mtime 往往最新，正常比对会判成该上传，正好把坏的推回远端。
- **归并前会把会话区整棵挪走**：`resetSessions: true` 时先把 `sessions/` 下所有项目目录移到 `quarantine/<时间戳>/`，再让下载把远端那份写回来 —— 手机第一次装插件、或本地残留半截/分叉目录时靠这个清干净。挪走不删，随时能捞回来。

---

## 配置字段

```yaml
driver: ftp              # ftp | local（local 用本地目录模拟远端，调试用）
localRemoteRoot: ''      # driver=local 时的模拟远端目录
appRoot: ''              # 留空则自动推断 %APPDATA%\eleckoi-desktop
toleranceMs: 2000        # mtime 容差，小于它的差异算「相同」，避免 FAT/NTFS 精度打架
ftp:
  host: ''
  port: 21
  user: 'anonymous'
  password: ''
  remoteRoot: '/eleckoi'
  connectTimeoutMs: 12000   # 建 TCP 的超时
  timeoutMs: 20000          # 控制通道等回复
  dataTimeoutMs: 20000      # 数据通道空闲
```

---

## 免责

同步会**覆盖文件**。第一次点「同步并重启」（或「立即同步」）之前，先「检查差异」。

覆盖前会把现场整份复制到 `<appRoot>/eleckoi-sync/backups/<时间戳>/`，可用面板「列出恢复点 → 预演 → 确认回滚」退回。但备份只保留最近 5 份，而且只覆盖「同步范围」里那些路径 —— 不是全量快照。

## License

MIT
