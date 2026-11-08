/**
 * Client 半：最左侧导航栏（sidebar.panellist）一个图标 → 主区域（main slot / key = ftp-sync）整页面板。
 *
 * 面板只做两件事：
 *   1. 上传 —— 把 FTP 那个远端目录清空，然后把本机数据整份传上去（不用关程序）。
 *   2. 下载 —— 把本机数据清空，然后把 FTP 的东西整份搬下来（必须先退出 ElecKoi，
 *      因为 Windows 上主库被打开着时连改名都做不到）。
 * 没有按时间比对的「双向同步」了：谁新谁旧的判断已经删掉，两个按钮都是整份覆盖。
 */
window.__ModuleLoader__.load({
  id: 'eleckoi-ftp-sync',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const CHANNEL = '/eleckoi-ftp-sync'
    const PANEL_ID = 'ftp-sync'

    const styles = {
      page: {
        display: 'flex', flexDirection: 'column', gap: 0, height: '100%', minHeight: 0,
        overflow: 'auto', padding: '22px 26px 34px', boxSizing: 'border-box',
        color: 'var(--primary-text, #e8eef2)', fontSize: 13, lineHeight: 1.6,
      },
      header: { display: 'flex', alignItems: 'center', gap: 10, marginBottom: 4 },
      title: { fontSize: 17, fontWeight: 600, margin: 0 },
      card: {
        marginTop: 14, padding: '14px 16px', borderRadius: 14,
        border: '1px solid var(--border, rgba(255,255,255,.14))',
        background: 'var(--card, rgba(255,255,255,.035))',
        maxWidth: 620,
      },
      cardTitle: { fontWeight: 600, marginBottom: 8, fontSize: 13 },
      row: { display: 'flex', justifyContent: 'space-between', gap: 12, margin: '3px 0' },
      label: { color: 'var(--tertiary-text, #93a3ae)' },
      mono: { fontFamily: 'ui-monospace, Menlo, Consolas, monospace', fontSize: 12, wordBreak: 'break-all' },
      field: { display: 'grid', gridTemplateColumns: '82px 1fr', alignItems: 'center', gap: 8, margin: '6px 0' },
      input: {
        width: '100%', padding: '6px 8px', borderRadius: 8,
        border: '1px solid var(--border, rgba(255,255,255,.18))',
        background: 'var(--input, rgba(0,0,0,.28))',
        color: 'inherit', fontSize: 12, boxSizing: 'border-box',
      },
      button: {
        padding: '7px 12px', borderRadius: 9,
        border: '1px solid var(--border, rgba(255,255,255,.18))',
        background: 'var(--button, rgba(255,255,255,.06))',
        color: 'inherit', fontSize: 12, cursor: 'pointer',
      },
      primary: {
        padding: '7px 14px', borderRadius: 9, border: '1px solid rgba(120,220,180,.5)',
        background: 'rgba(80,200,150,.18)', color: '#b8f0d8', fontSize: 12,
        cursor: 'pointer', fontWeight: 600,
      },
      danger: {
        padding: '7px 14px', borderRadius: 9, border: '1px solid rgba(255,140,120,.55)',
        background: 'rgba(230,110,90,.16)', color: '#ffc2b6', fontSize: 12,
        cursor: 'pointer', fontWeight: 600,
      },
      big: {
        display: 'block', width: '100%', marginTop: 10, padding: '13px 16px', borderRadius: 12,
        fontSize: 13.5, fontWeight: 600, cursor: 'pointer', textAlign: 'left',
      },
      actions: { display: 'flex', gap: 8, marginTop: 12, flexWrap: 'wrap' },
      error: { color: '#ff9c8a', marginTop: 10, whiteSpace: 'pre-wrap' },
      ok: { color: '#b8f0d8', marginTop: 10, whiteSpace: 'pre-wrap' },
      hint: { color: 'var(--tertiary-text, #93a3ae)', fontSize: 11.5, marginTop: 8, maxWidth: 620 },
      pre: {
        marginTop: 10, padding: 10, borderRadius: 10, background: 'rgba(0,0,0,.32)',
        color: '#c8d4dc', fontSize: 11, maxHeight: 260, overflow: 'auto', whiteSpace: 'pre-wrap',
        maxWidth: 620,
      },
      badge: {
        display: 'inline-block', padding: '1px 8px', borderRadius: 999, fontSize: 11,
        border: '1px solid var(--border, rgba(255,255,255,.18))',
      },
    }

    /** 侧栏图标：上下两个对开的箭头（一个上去、一个下来）。 */
    function SyncNavIcon({ size = 24 }) {
      return h('svg', {
        width: size, height: size, viewBox: '0 0 24 24', fill: 'none',
        stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round', strokeLinejoin: 'round',
        'aria-hidden': true,
      },
        h('path', { d: 'M8 20.5V4' }),
        h('path', { d: 'M4.2 7.8 8 4l3.8 3.8' }),
        h('path', { d: 'M16 3.5V20' }),
        h('path', { d: 'M19.8 16.2 16 20l-3.8-3.8' })
      )
    }

    const mb = bytes => {
      const n = Number(bytes) || 0
      return n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.round(n / 1024)} KB`
    }

    return {
      inject: ['slots', 'connection'],
      apply(ctx) {
        const ROOT_HINT_KEY = 'eleckoi-ftp-sync.appRootHint'

        /** 手动指定的数据目录。自动探测不出来时靠它，存在浏览器侧。 */
        const readRootHint = () => {
          try {
            return window.localStorage.getItem(ROOT_HINT_KEY) || ''
          } catch {
            return ''
          }
        }
        const writeRootHint = value => {
          try {
            if (value) window.localStorage.setItem(ROOT_HINT_KEY, value)
            else window.localStorage.removeItem(ROOT_HINT_KEY)
          } catch {
            // 隐私模式下写不了，就只在本次会话里生效
          }
        }

        const call = async (endpoint, payload) => {
          const hint = readRootHint()
          const body = { ...(payload ?? {}) }
          if (hint) body.appRootHint = hint
          const raw = await ctx.connection.rpc.call(CHANNEL, endpoint, body)
          const result = typeof raw === 'string' ? JSON.parse(raw) : raw
          if (!result || result.ok !== true) {
            throw new Error(result && result.error ? result.error.message : '同步通道调用失败')
          }
          return result.value
        }

        function SyncPage() {
          const [status, setStatus] = React.useState(null)
          const [busy, setBusy] = React.useState(false)
          const [error, setError] = React.useState(null)
          const [note, setNote] = React.useState('')
          const [logText, setLogText] = React.useState('')
          const [diag, setDiag] = React.useState(null)
          const [rootHint, setRootHint] = React.useState(() => readRootHint())
          const [form, setForm] = React.useState(null)
          const [restore, setRestore] = React.useState(null)
          const [restorePreview, setRestorePreview] = React.useState(null)
          const [confirming, setConfirming] = React.useState(null)

          const run = async task => {
            setBusy(true)
            setError(null)
            try {
              await task()
            } catch (reason) {
              setError(reason instanceof Error ? reason.message : String(reason))
            } finally {
              setBusy(false)
            }
          }

          React.useEffect(() => {
            call('status').then(setStatus).catch(() => {})
            call('config.get').then(setForm).catch(() => {})
            const timer = setInterval(() => {
              call('status').then(setStatus).catch(() => {})
            }, 3000)
            return () => clearInterval(timer)
          }, [])

          const refresh = () => run(async () => setStatus(await call('status')))
          const patch = (key, value) => setForm(current => ({ ...current, [key]: value }))
          const patchFtp = (key, value) => setForm(current => ({ ...current, ftp: { ...current.ftp, [key]: value } }))

          const doSave = () => run(async () => {
            if (form === null) return
            const saved = await call('config.save', {
              driver: form.driver,
              localRemoteRoot: form.localRemoteRoot,
              ftp: form.ftp,
              toleranceMs: Number(form.toleranceMs) || 2000,
            })
            setNote(`已保存：${saved.target}`)
            setStatus(await call('status'))
          })

          const doTest = () => run(async () => {
            const result = await call('test')
            setNote(`连接成功：${result.target}，远端 ${result.entries} 个文件${result.hasManifest ? '（有 manifest）' : ''}`)
          })

          /**
           * 上传：整个远端目录会被清空，所以点一次不够 —— 先弹成「再点一次确认」。
           * 二次确认放在按钮自己身上，不用 window.confirm（Electron 里那个是原生模态，
           * 会把整个渲染进程卡住，连面板自己的进度都刷不出来）。
           */
          const doUpload = () => run(async () => {
            if (confirming !== 'upload') {
              setConfirming('upload')
              setNote('再点一次「确认清空远端并上传」：远端那个目录里的东西会被全部删掉，然后换成这台电脑上的数据。')
              return
            }
            setConfirming(null)
            setNote('正在清空远端并上传，别关程序…')
            const result = await call('upload')
            setNote(result && result.hint ? result.hint : `已上传 ${result.uploaded} 个文件`)
            setStatus(await call('status'))
          })

          /**
           * 下载：本机会被清空，而且必须退出程序才能做 —— 点下去之后只写 job、起守护进程，
           * 真正的活在退出后干。守护进程先备份、再清空、再把远端搬下来，最后自动重开。
           */
          const doDownload = () => run(async () => {
            if (confirming !== 'download') {
              setConfirming('download')
              setNote('再点一次「确认清空本机并从 FTP 下载」：本机数据会被清空，然后换成 FTP 上那一份。'
                + '动手前会自动整份备份到 eleckoi-sync/backups/<时间戳>/，出事能用「恢复点」回滚。')
              return
            }
            setConfirming(null)
            const result = await call('download')
            setNote(result && result.hint ? result.hint : '已经排队，等你退出 ElecKoi')
            setStatus(await call('status'))
          })

          const doListRestore = () => run(async () => {
            const result = await call('restore.list')
            setRestore(result)
            setRestorePreview(null)
            setNote(result && result.items ? `找到 ${result.items.length} 个恢复点` : '没有找到恢复点')
          })

          const doRestorePlan = (kind, id) => run(async () => {
            setRestorePreview(await call('restore.plan', { kind, id }))
            setNote('以下是预演，还没动任何文件')
          })

          const doRestoreApply = (kind, id) => run(async () => {
            const result = await call('restore.apply', { kind, id })
            setNote(result && result.hint ? result.hint : `已恢复 ${result.restored} 个文件`)
            setRestorePreview(null)
            setStatus(await call('status'))
          })

          const doCancel = () => run(async () => {
            await call('cancel')
            setNote('已取消等待')
            setStatus(await call('status'))
          })

          const doDiagnose = () => run(async () => {
            const report = await call('diagnose')
            setDiag(report)
            setNote(report && report.resolved ? `数据目录：${report.resolved}` : '没找到数据目录，把下面的内容发出来')
          })

          const doLog = () => run(async () => {
            const result = await call('log')
            setLogText(result && result.text ? result.text : '（还没有日志）')
          })

          const doSetRoot = () => run(async () => {
            const value = rootHint.trim()
            writeRootHint(value)
            const report = await call('diagnose')
            if (report && report.resolved) {
              setNote(`数据目录已设为：${report.resolved}`)
              setStatus(await call('status'))
              setForm(await call('config.get'))
            } else {
              setNote('这个目录不像 ElecKoi 的数据目录（里面没有 dsh-runtime 或数据库文件）')
            }
            setDiag(report)
          })

          const waitingExit = Boolean(status && status.guardianRunning === true)
          const phaseText = status
            ? (waitingExit ? `等待退出（${status.phase}）` : (status.phase || 'idle'))
            : '读取中…'

          const field = (label, input) => h('label', { style: styles.field },
            h('span', { style: styles.label }, label), input)

          return h('div', { style: styles.page },
            h('div', { style: styles.header },
              h('span', { style: { display: 'inline-flex', width: 24, height: 24, color: 'var(--blue, #5aa9ff)' } },
                h(SyncNavIcon, { size: 24 })),
              h('h1', { style: styles.title }, 'FTP 数据同步')),

            h('div', { style: styles.card },
              h('div', { style: styles.row },
                h('span', { style: styles.label }, '状态'),
                h('span', null, phaseText)),
              h('div', { style: styles.row },
                h('span', { style: styles.label }, '目标'),
                h('span', { style: styles.mono }, status ? status.target : '—')),
              h('div', { style: styles.row },
                h('span', { style: styles.label }, '配置'),
                h('span', null, status ? (status.configured ? '已填写' : '未填写') : '—')),
              status && status.last
                ? h('div', { style: styles.row },
                  h('span', { style: styles.label }, '上次结果'),
                  h('span', null, status.last.error
                    ? `失败：${status.last.error}`
                    : (status.last.mode === 'download'
                      ? `下载 ${status.last.downloaded} 个 / ${mb(status.last.bytes)}`
                      : `上传 ${status.last.uploaded} 个 / ${mb(status.last.bytes)}`)))
                : null),

            h('div', { style: styles.card },
              h('div', { style: styles.cardTitle }, '两个动作'),
              h('button', {
                type: 'button',
                disabled: busy || waitingExit,
                onClick: doUpload,
                style: {
                  ...styles.big,
                  border: `1px solid ${confirming === 'upload' ? 'rgba(255,140,120,.6)' : 'rgba(120,220,180,.45)'}`,
                  background: confirming === 'upload' ? 'rgba(230,110,90,.16)' : 'rgba(80,200,150,.16)',
                  color: confirming === 'upload' ? '#ffc2b6' : '#b8f0d8',
                },
              }, confirming === 'upload'
                ? '确认清空远端并上传（再点一次）'
                : '上传到 FTP：清空远端 → 把本机传上去'),
              h('div', { style: styles.hint },
                '不用关程序。传之前会把数据库做一份一致快照，所以程序开着时传上去的库也是能打开的。'
                + '远端那个目录里的东西会被全部删掉，只留同步用的 .eleckoi-sync。'),
              h('button', {
                type: 'button',
                disabled: busy || waitingExit,
                onClick: doDownload,
                style: {
                  ...styles.big,
                  border: `1px solid ${confirming === 'download' ? 'rgba(255,140,120,.6)' : 'rgba(255,140,120,.35)'}`,
                  background: confirming === 'download' ? 'rgba(230,110,90,.22)' : 'rgba(230,110,90,.1)',
                  color: '#ffc2b6',
                },
              }, confirming === 'download'
                ? '确认清空本机并从 FTP 下载（再点一次）'
                : '从 FTP 下载：清空本机 → 把远端搬下来'),
              h('div', { style: styles.hint },
                '本机会被清空，所以必须退出 ElecKoi 才能做（主库开着时连改名都做不到）。'
                + '点完之后照提示完全退出程序：它会先整份备份本机，再清空，再把 FTP 的内容搬回来，最后自动重开。'),
              h('div', { style: styles.actions },
                waitingExit
                  ? h('button', { type: 'button', style: styles.button, disabled: busy, onClick: doCancel }, '取消等待')
                  : null,
                h('button', { type: 'button', style: styles.button, disabled: busy, onClick: doLog }, '看日志'),
                h('button', { type: 'button', style: styles.button, disabled: busy, onClick: refresh }, '刷新状态'))),

            h('div', { style: styles.card },
              h('div', { style: styles.cardTitle }, '同步目标'),
              form === null
                ? h('div', { style: styles.hint }, '读取配置中…')
                : h(React.Fragment, null,
                  field('方式', h('select', {
                    style: styles.input, value: form.driver,
                    onChange: event => patch('driver', event.target.value),
                  },
                  h('option', { value: 'ftp' }, 'FTP 服务器'),
                  h('option', { value: 'local' }, '本地目录'))),
                  form.driver === 'ftp'
                    ? h(React.Fragment, null,
                      field('地址', h('input', {
                        style: styles.input, value: form.ftp.host, placeholder: 'ftp.example.com',
                        onChange: event => patchFtp('host', event.target.value),
                      })),
                      field('端口', h('input', {
                        style: styles.input, type: 'number', value: String(form.ftp.port),
                        onChange: event => patchFtp('port', Number(event.target.value) || 21),
                      })),
                      field('用户名', h('input', {
                        style: styles.input, value: form.ftp.user, placeholder: 'anonymous',
                        onChange: event => patchFtp('user', event.target.value),
                      })),
                      field('密码', h('input', {
                        style: styles.input, type: 'password', value: form.ftp.password,
                        onChange: event => patchFtp('password', event.target.value),
                      })),
                      field('远端目录', h('input', {
                        style: styles.input, value: form.ftp.remoteRoot, placeholder: '/eleckoi',
                        onChange: event => patchFtp('remoteRoot', event.target.value),
                      })))
                    : field('本地目录', h('input', {
                      style: styles.input, value: form.localRemoteRoot,
                      onChange: event => patch('localRemoteRoot', event.target.value),
                    })),
                  h('div', { style: styles.actions },
                    h('button', { type: 'button', style: styles.primary, disabled: busy, onClick: doSave }, '保存设置'),
                    h('button', { type: 'button', style: styles.button, disabled: busy, onClick: doTest }, '测试连接')))),

            h('div', { style: styles.card },
              h('div', { style: styles.cardTitle }, '搬运范围'),
              h('div', { style: styles.hint },
                '数据库（角色卡、世界书、Agent 预设）+ 对话正文 + 会话快照 + 渲染出的 preset + '
                + '聊天附件与附件索引 + 图片资源 + 作者脚本。'),
              h('div', { style: styles.hint },
                '设备私钥、服务器凭据、API key、插件配置、缓存与日志不在范围内。')),

            status && status.layout ? h('div', { style: styles.card },
              h('div', { style: styles.cardTitle }, '本机数据布局'),
              h('div', { style: styles.hint }, '把上面每一项解到本机真实路径的结果，出错时先来这里核对。'),
              h('pre', { style: styles.pre },
                `数据库  ${status.layout.dbExists ? '✓' : '✗'}  ${status.layout.db}\n`
                + (status.layout.dirs || []).map(item => `${item.exists ? '✓' : '✗'} ${item.rel}\n     → ${item.path}`).join('\n') + '\n'
                + (status.layout.files || []).map(item => `${item.exists ? '✓' : '✗'} ${item.rel}\n     → ${item.path}`).join('\n')),
              (status.layout.missing && status.layout.missing.length > 0)
                ? h('div', { style: styles.hint }, `缺失：${status.layout.missing.join('、')}（这些目录本机没有，不会搬）`)
                : null)
              : null,

            h('div', { style: styles.card },
              h('div', { style: styles.cardTitle }, '恢复点'),
              h('div', { style: styles.hint },
                '每次「从 FTP 下载」清空本机之前，都会先把现场整份复制到 eleckoi-sync/backups/<时间戳>/。'
                + '回滚只覆盖本机，不碰远端。'),
              h('div', { style: styles.actions },
                h('button', { type: 'button', style: styles.button, disabled: busy, onClick: doListRestore }, '列出恢复点')),
              restore && restore.items ? h('pre', { style: styles.pre },
                restore.items.length === 0
                  ? '（本机还没有任何恢复点）'
                  : restore.items.map(item =>
                    `${item.kind === 'quarantine' ? '归并收容' : '覆盖前备份'}  ${item.id}`
                    + `\n   ${item.files} 个文件 / ${mb(item.bytes)}`
                    + `${item.hasDatabase ? ` / 含数据库 ${mb(item.databaseBytes)}` : ' / 不含数据库'}`
                    + `\n   → ${item.dir}`
                  ).join('\n\n')) : null,
              restore && restore.items && restore.items.length > 0
                ? h('div', { style: styles.actions },
                  ...restore.items.slice(0, 6).map(item =>
                    h('button', {
                      type: 'button', style: styles.button, disabled: busy,
                      onClick: () => doRestorePlan(item.kind, item.id),
                    }, `预演 ${item.id}`)))
                : null,
              restorePreview ? h('div', null,
                h('pre', { style: styles.pre },
                  `恢复点 ${restorePreview.kind}/${restorePreview.id}`
                  + `\n要覆盖 ${restorePreview.restored} 个文件，跳过 ${restorePreview.skipped} 个`
                  + `\n\n` + (restorePreview.sample || []).map(entry =>
                    `${entry.canonical}\n     → ${entry.target}`).join('\n')),
                h('div', { style: styles.actions },
                  h('button', {
                    type: 'button', style: styles.primary, disabled: busy,
                    onClick: () => doRestoreApply(restorePreview.kind, restorePreview.id),
                  }, `确认回滚 ${restorePreview.id}`))) : null),

            h('div', { style: styles.card },
              h('div', { style: styles.cardTitle }, '数据目录'),
              h('div', { style: styles.hint },
                '一般不用填。报「找不到 ElecKoi 数据目录」时点「诊断环境」，把候选里真实的那个（含 dsh-runtime 的那一层）填到这里。'),
              field('目录', h('input', {
                style: styles.input, value: rootHint, placeholder: 'D:\\Users\\<你>\\AppData\\Roaming\\eleckoi-desktop',
                onChange: event => setRootHint(event.target.value),
              })),
              h('div', { style: styles.actions },
                h('button', { type: 'button', style: styles.primary, disabled: busy, onClick: doSetRoot }, '使用这个目录'),
                h('button', {
                  type: 'button', style: styles.button, disabled: busy,
                  onClick: () => { setRootHint(''); writeRootHint(''); setNote('已清空手动目录，下次请求重新自动探测') },
                }, '清空'),
                h('button', { type: 'button', style: styles.button, disabled: busy, onClick: doDiagnose }, '诊断环境'))),

            note ? h('div', { style: styles.ok }, note) : null,
            error ? h('div', { style: styles.error }, error) : null,
            diag ? h('div', { style: styles.card },
              h('div', { style: styles.cardTitle }, '环境诊断'),
              h('div', { style: styles.row },
                h('span', { style: styles.label }, '数据目录'),
                h('span', { style: styles.mono }, diag.resolved || '未找到')),
              h('div', { style: styles.row },
                h('span', { style: styles.label }, '平台'),
                h('span', { style: styles.mono }, `${diag.platform}/${diag.arch}`)),
              h('div', { style: styles.row },
                h('span', { style: styles.label }, '运行方式'),
                h('span', null, diag.isPackagedElectron ? 'Electron 应用内' : '纯 node')),
              h('div', { style: styles.hint }, '命中的候选路径：'),
              h('pre', { style: styles.pre },
                diag.candidates.filter(item => item.evidence.length > 0)
                  .map(item => `✓ ${item.path}  ← ${item.from}  [${item.evidence.join(', ')}]`)
                  .join('\n') || '（没有任何候选命中）'),
              h('div', { style: styles.hint }, '环境变量：'),
              h('pre', { style: styles.pre },
                Object.keys(diag.env).map(key => `${key} = ${diag.env[key] === null ? '（未设置）' : diag.env[key]}`).join('\n')))
              : null,
            logText ? h('pre', { style: styles.pre }, logText) : null)
        }

        // 1) 主导航栏入口：只有 main 里存在同 key 的主页面时才会显示。
        ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
          name: 'sidebar.panellist',
          id: PANEL_ID,
          order: 30,
          label: 'FTP 同步',
          registrant: 'eleckoi-ftp-sync',
        }, ({ size }) => h(SyncNavIcon, { size })))

        // 2) 对应的主页面。
        ctx.slots.inject('main', () => ctx.slots.register({
          name: 'main',
          key: PANEL_ID,
          registrant: 'eleckoi-ftp-sync',
        }, () => h(SyncPage)))
      },
    }
  },
})
