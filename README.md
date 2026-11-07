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
| ✅ | `dsh-runtime/home/llm-deepseek` | 附件索引 `files-v3.json`，`fileId` ↔ sha256 映射 |
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
- **同步并重启** —— 写 job，拉起守护进程，然后你手动关掉 ElecKoi；守护进程接手
- **取消** —— 撤掉等待中的守护进程
- **看日志** —— 读最近一次同步的完整日志
- **刷新状态** —— 手动拉一次 `status`

FTP 地址 / 端口 / 账号 / 密码 / 远端目录都能在面板里改，保存后写到 `<appRoot>/eleckoi-sync/config.json`，比 `cordis.patch.yml` 里的默认值优先。

**建议先在面板里「检查差异」跑一遍**，看清楚方向和条数再点同步。

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
```

---

## 免责

同步会**覆盖文件**。面板里第一次点「同步并重启」之前，先「检查差异」。备份目录会保留，但它只备份被下载覆盖的那部分，不是全量快照。

## License

MIT
