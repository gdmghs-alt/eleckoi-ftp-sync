# eleckoi-ftp-sync

ElecKoi（DeepSeek Harness 桌面端）插件：把宿主机数据目录和 FTP 上的一份**整份镜像**来回搬。

只有两个动作：

- **上传到 FTP** —— 先把远端那个目录清空，再把本机整份传上去。
- **从 FTP 下载** —— 先把本机清空，再把远端整份搬下来（下载走守护进程：等你关掉 ElecKoi 再动手，动手前先自动备份，装完自动重新打开）。

不比对时间、不管谁新谁旧、不做双向合并。一端是标准，另一端照着变成标准。用途很土：两台机器轮流用同一套角色卡 / 会话记录 / 世界书时，不用手动拷那几个 GB。

---

## 它搬什么

| | 路径（相对 `appRoot`，即 `%APPDATA%\eleckoi-desktop`） | 是什么 |
|---|---|---|
| ✅ | `eleckoi-common.sqlite3` | 角色卡、世界书、**Agent 预设**、会话元数据 |
| ✅ | `dsh-runtime/sessions` | 对话正文 `session.v4.jsonl` |
| ✅ | `dsh-runtime/session-snapshots` | 每个会话挂的预设、模型、推理档位、禁用的工具组 |
| ✅ | `dsh-runtime/generated-presets` | 由预设表渲染出的 `preset.json` |
| ✅ | `dsh-runtime/home/attachments` | 聊天里贴的附件正文 |
| ✅ | `dsh-runtime/home/llm-deepseek/files-v3.json` | 附件索引（只带这一个文件），`fileId` ↔ sha256 映射 |
| ✅ | `media` | 图片资源 |
| ✅ | `author-scripts` | 作者脚本 |
| ❌ | 缓存、`logs`、`node_modules`、`.plugin-manager`、`*-wal`、`*-shm`、`*.bak-*`、`*.incoming` | |
| ❌ | `dsh-runtime/home/remote`、`.credentials.yaml`、`profiles` | 设备私钥、服务器凭据、API key、本机插件路径 |

远端 `.eleckoi-sync/` 这个目录本身**不在镜像范围内**，它是元数据（`manifest.json`、日志、回收站），两个动作都不会删它。

关于 Agent 预设：**预设本体就在 `eleckoi-common.sqlite3` 里**，跟着数据库一起走。

但只搬数据库是不够的：`session-snapshots` 记录「这个会话当时挂的是哪个预设、哪个模型」，少了它换机器打开旧对话会静默回落到默认预设。
`generated-presets` 是从预设表渲染出来的产物，缺了下次创建会话会自动重建；一起带上只是让远端立刻有一份可读的预设定义。

远端会写一份 manifest 记录这次镜像的时间、来源设备和文件清单：

```
.eleckoi-sync/manifest.json
{ "version": 2, "mode": "mirror", "updatedAt": 1789..., "device": "desktop",
  "files": { "<rel>": { "size": 123, "mtimeMs": 1789... } } }
```

它只是留个凭据，下载时不参与任何判定 —— 下载就是把远端有什么搬什么。

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

重启后最左侧导航栏多一个图标（上下对开的双箭头），点开是整页面板。核心就两个大按钮，每个都要点两下（第一下只是把文案换成「确认…再点一次」）：

### 上传到 FTP

```
本机扫描 → 拉一份数据库快照 → 清空远端（跳过 .eleckoi-sync）→ 逐份上传 → 写 manifest
```

- 在宿主进程里当场跑，**不用关 ElecKoi**。数据库用 `VACUUM INTO` 拿一份一致快照再传，所以程序开着也能传出一份完整的库。
- 清空是**自下而上**的：先删文件、再删空目录（IIS 支持 `DELE` 与 `RMD`，实测可行）。
- 万一有文件删不掉，**立刻中止、一个文件都不传**：远端只清空一半再灌新数据，会变成「旧残留 + 新数据」的混合体，比两者都糟。
- 本机同步范围是空的也会中止，避免拿空的去覆盖远端。

### 从 FTP 下载

```
探远端（空就直接拒绝，本机一个字节都不动）
  → 写 job → 拉起守护进程
你完全退出 ElecKoi
  → 守护进程轮询宿主 pid 直到退出，再等数据库真的没人占着
  → 把本机现有数据整份备份到 eleckoi-sync/backups/<时间戳>/
  → 清空本机 → 逐份下载 → 会话按它自己的 cwd 落回 DSH 认得的位置 → 写 manifest
  → 重新拉起 ElecKoi
```

- **必须先退出程序**：Windows 上主库被打开着时连 rename 都会 `EBUSY`，而下载第一步就是把它删掉重建。
- 退出后它会自己动手，装完自己把 ElecKoi 拉起来。面板会显示「等待 ElecKoi 退出」，中间可以点**取消等待**（守护进程直接退出，什么都不动）。
- 下载前那份备份可以用面板「列出恢复点 → 预演 → 确认回滚」退回；只保留最近 5 份。

其它按钮：**保存设置** / **测试连接** / **刷新状态** / **诊断环境** / **看日志** / **列出恢复点**（含预演与确认回滚）/ **使用这个目录** / **清空**。

FTP 地址 / 端口 / 账号 / 密码 / 远端目录都能在面板里改，保存后写到 `<appRoot>/eleckoi-sync/config.json`，比 `cordis.patch.yml` 里的默认值优先。

### 搬坏了怎么退回去

每次下载清空本机之前，都会把现场整份复制到 `<appRoot>/eleckoi-sync/backups/<时间戳>/`。上传不备份（它只读本机）。

1. 点 **列出恢复点** —— 每个点显示：时间戳、文件数、体积、是否含数据库、包含哪些会话 id、磁盘路径。
2. 点 **预演 `<时间戳>`** —— 只算要覆盖哪些文件，一个字节都不写。看清单确认对不对。
3. 点 **确认回滚 `<时间戳>`** —— 逐个写回。主库排最前（库被占用时 rename 会 `EBUSY`，先动它，失败就立刻中止，别的文件一个都还没动）。
4. **完全退出并重新打开 ElecKoi**，新数据才会被读到。

回滚只覆盖本机，不碰远端。只覆盖恢复点里存在的那部分文件，本机多出来的一律不动（宁可少删，也不要因为路径算错把其它数据带走）。备份存的是**逻辑名**（`dsh-runtime/sessions/…`），回滚时按本机当前布局落到该在的位置。

如果本机一个备份都没有（第一次装插件），那就再点一次**从 FTP 下载** —— 但现在它是「先备份再清空」，第一次跑之前没有可备份的东西，等于直接以远端为准。

### 会话为什么不会搬坏

DSH 的 `assertStoredIdentity()` 会逐字比对：每份 `session.v4.jsonl` 的磁盘路径**必须**等于 `projectKey(header.cwd)/encodeSegment(header.id)/session.v4.jsonl`，否则整条被判 corrupt，`listArtifacts()` 一抛，会话列表就空了，点任何会话都报 `sessions.retain: unknown session`。

而 `projectKey` 是拿 cwd 现算的（`D:\...\workspace` → `--D-...-workspace--`），两台机器的 cwd 不可能一样。所以：

- 上传时会话统一写成 `dsh-runtime/sessions/@self/<sid>/session.v4.jsonl`，远端一个 sessionId 只有一份。
- 下载时**先落临时文件、读它自己的 header、再算落点**：`projectKey(header.cwd)` 决定目录名，`encodeSegment(header.id)` 决定子目录名。不是拿本机猜一个目录名套所有会话。
- 同一个 sessionId 在本机有多份时，挑体积最大的那份上传（并列取 mtime 最新的）。

`projectKey` 的规则是逐字符照抄 DSH 的：`/`、`\`、`:` 连续出现折成单个 `-`，`~` 与 `[A-Za-z0-9._-]` 之外的字符转成 `~XXXX`（4 位大写 hex），结果去掉前导 `-`、空则用 `root`、截断到 251 字符，最后两头包 `--`。这套规则不能自己发明 —— 差一个字符 DSH 就认不出来。

---

## 守护进程干了什么

```
你点「从 FTP 下载」
  → 宿主先探一次远端，空了就直接拒绝（本机未改动）
  → 写 <appRoot>/eleckoi-sync/jobs/job-<ts>.json（含宿主 pid、config、execPath）
  → spawn(ELECTRON_RUN_AS_NODE=1, lib/guardian.js, jobPath)，detached + unref
你完全退出 ElecKoi
  → guardian 轮询宿主 pid 直到退出
  → 再用「能不能给数据库改名」探针确认没人占着（最多等 180s）
  → sleep 2s 让句柄散干净
  → downloadAll()：备份 → 清空 → 下载 → 写 manifest
  → 重新拉起 ElecKoi
```

日志落在 `<appRoot>/eleckoi-sync/logs/download-<ts>.log`，状态落在同级的 `state.json`。

---

## 实现要点

- **零外部依赖**：`lib/ftp.js` 是手写的极简 FTP 客户端（`USER/PASS/TYPE I/PASV/SIZE/RETR/STOR/DELE/RMD/MKD/RNFR+RNTO`），不引 `basic-ftp`。所以 `dependencies` 是空对象，装的时候不会去拉网络包。
- **RPC 通道名必须以 `/` 开头**：DSH 的 `@deepseek-ai/dsh-client-connection` 里是 `const CHANNEL_PATTERN = /^\/[A-Za-z0-9._~-]+$/`，写 `eleckoi-ftp-sync` 会直接抛 `invalid or reserved RPC channel`，整个插件静默不激活。
- **不用 `ctx.connection.rpc.handle`**：它的内部 effect 会在子作用域里访问 `owner.webServer`，触发 "without inject" 报错。改成自己 `webServer.register({ kind: 'prefix', path: CHANNEL, handler })`，手写 `POST <channel>/<endpoint>`，回 `{ type: 'server-response', rpcId, result }`，请求先过 `connection.requestRejection({ headers })`。
- **导航项要能显示**：`sidebar.panellist` 里的项只有在 `main` slot 存在同 `key` 的页面时才渲染。所以本插件同时注册 `main` 的 `key: 'ftp-sync'` 页面 + `sidebar.panellist` 的 `id: 'ftp-sync'` 图标。
- **IIS 的坑（都是实测）**：
  - `MLSD` 回 `500`，所以 `list()` 必须 `MLSD → LIST -a → LIST` 三级回退；
  - `OPTS UTF8 ON` 只管命令通道，LIST 的数据通道仍是 GBK，文件名要「先按 UTF-8 严格解、失败退 GBK」；
  - `MDTM`/`SIZE` 对目录都回 `550`，判存在只能靠 `CWD`/`NLST`/`LIST`；
  - `MKD` 对已存在的目录也回 `550`，必须把 `550` 当「已存在」而不是错误；
  - LIST 给的是服务端本地时间，得按本地时区解析；
  - 不支持 `SITE ATTRIB` / `SITE CHMOD`，覆盖只读文件只能 `RNFR/RNTO` 改名绕过；
  - `RMD` 只删空目录，所以清空必须**自下而上**：先把文件 `DELE` 干净，再逐层 `RMD`。
- **别把「列不出来」当「目录是空的」**：早期版本给 `list()` 加了 `.catch(() => undefined)`，数据连接一超时就被当成空目录，同步于是把本地整棵树重传一遍。现在 `collect()` 会区分「正常收完」和「被超时掐断」，后者直接抛。
- **三个超时分开**：`connectTimeoutMs`（建 TCP，默认 12s）/ `timeoutMs`（控制通道等回复，20s）/ `dataTimeoutMs`（数据通道空闲，20s），都能在配置里覆盖。
- **appRoot 自动探测**：`detectAppRoot()` 不盲目相信环境变量（DSH 自己的进程里 `DSH_HOME=~/.dsh`，往上跳两层会落到用户主目录），而是拿候选目录去验证「里面有 `dsh-runtime` 或 `eleckoi-common.sqlite3`」，不成立就换下一个，最后才从 `APPDATA` / `HOME` 的已知落点里找。
- **探测失败可以手动兜底**：前端把目录存在 `localStorage`，每个 RPC 请求带一个 `appRootHint`；host 用 `hasAppRootEvidence()` 校验后才认。这样即使自动探测全落空，面板本身还能用（不然连配置都存不下来 —— 配置文件就在 `appRoot` 里）。
- **布局自适应**：`resolveLayout()` 把「逻辑名 → 本机真实路径」现解一遍。每个逻辑名给一串候选（appRoot 内的桌面式路径 → 往上 1~3 层的 Android 式路径 → 宿主注入的环境变量），取第一个真实存在的。候选顺序是「appRoot 内优先、环境变量最后」—— 反过来会出事：在 DSH 自己的进程里 `DSH_HOME` 指向它自己的 home，先信它就会把那下面的 `attachments` 当聊天附件扫进去（实测文件数从 75 涨到 443）。
- **备份是可读回来的，不只是写着好看**：`lib/restore.js` 把 `backups/` 暴露成可枚举、可预演、可回滚的资源（`restore.list` / `restore.plan` / `restore.apply`）。回滚按逻辑名落回本机当前布局，单向覆盖本机、不碰远端。

---

## 配置字段

```yaml
driver: ftp              # ftp | local（local 用本地目录模拟远端，调试用）
localRemoteRoot: ''      # driver=local 时的模拟远端目录
appRoot: ''              # 留空则自动推断 %APPDATA%\eleckoi-desktop
toleranceMs: 2000        # 已不再参与判定，保留字段仅为兼容旧配置
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

这两个动作都会**删东西**：上传清空远端，下载清空本机。

- 上传前建议先在别的机器上「从 FTP 下载」验证一次，或者确认远端那份不要了。
- 下载会在动手前把本机整份备份到 `<appRoot>/eleckoi-sync/backups/<时间戳>/`，可用面板回滚。但备份只保留最近 5 份，而且只覆盖「搬运范围」里那些路径 —— 不是全量快照。

## License

MIT
