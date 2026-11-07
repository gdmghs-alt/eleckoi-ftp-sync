/**
 * Client 半：把「FTP 数据同步」做成最左侧导航栏（sidebar.panellist）里的一个图标入口，
 * 点开后是主区域（main slot / key = ftp-sync）里的整页面板。
 * 面板里可以直接填 FTP 地址/端口/账号/密码/远端目录，保存后会写到
 * <appRoot>/eleckoi-sync/config.json，不需要改 profile 配置。
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
      mono: { fontFamily: 'ui-monospace, Menlo, Consolas, monospace', fontSize: 12 },
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

    /** 侧栏图标：两个绕行的循环箭头。 */
    function SyncNavIcon({ size = 24 }) {
      return h('svg', {
        width: size, height: size, viewBox: '0 0 24 24', fill: 'none',
        stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round', strokeLinejoin: 'round',
        'aria-hidden': true,
      },
        h('path', { d: 'M20.4 12a8.4 8.4 0 0 1-14.2 6.1' }),
        h('path', { d: 'M3.6 12a8.4 8.4 0 0 1 14.2-6.1' }),
        h('path', { d: 'M17.8 2.6v3.9h-3.9' }),
        h('path', { d: 'M6.2 21.4v-3.9h3.9' })
      )
    }

    return {
      inject: ['slots', 'connection'],
      apply(ctx) {
        const ROOT_HINT_KEY = 'eleckoi-ftp-sync.appRootHint'

        /** 手动指定的数据目录。手机端自动探测不出来时靠它，存在浏览器侧。 */
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
          const [plan, setPlan] = React.useState(null)
          const [busy, setBusy] = React.useState(false)
          const [error, setError] = React.useState(null)
          const [note, setNote] = React.useState('')
          const [logText, setLogText] = React.useState('')
          const [diag, setDiag] = React.useState(null)
          const [rootHint, setRootHint] = React.useState(() => readRootHint())
          const [form, setForm] = React.useState(null)

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
            }, 5000)
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

          const doPlan = () => run(async () => {
            setPlan(await call('plan'))
            setNote('')
          })

          const doStart = () => run(async () => {
            const result = await call('start')
            setNote(result && result.hint ? result.hint : '已启动')
            setStatus(await call('status'))
          })

          // 就地同步：手机上（spawn 不起守护进程）走这条。direction 决定只拉、只推还是双向。
          const doSync = direction => run(async () => {
            const result = await call('sync', { direction })
            setNote(result && result.hint ? result.hint : '完成')
            setPlan(null)
            setStatus(await call('status'))
          })

          const doCancel = () => run(async () => {
            await call('cancel')
            setNote('已取消')
            setStatus(await call('status'))
          })

          // 诊断：把 appRoot 推导过程摊出来。手机端找不到数据目录时靠这个自报。
          const doDiagnose = () => run(async () => {
            const report = await call('diagnose')
            setDiag(report)
            setNote(report && report.resolved ? `数据目录：${report.resolved}` : '没找到数据目录，把下面的内容发出来')
          })

          const doLog = () => run(async () => {
            const result = await call('log')
            setLogText(result && result.text ? result.text : '（还没有日志）')
          })

          // 手动指定数据目录：写进浏览器本地，之后每个请求都带上，host 侧校验通过才认。
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

          const running = Boolean(status && status.guardianRunning === true)

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
                h('span', null, running ? `等待退出（${status.phase}）` : (status ? status.phase : '读取中…'))),
              h('div', { style: styles.row },
                h('span', { style: styles.label }, '同步目标'),
                h('span', { style: styles.mono }, status ? status.target : '—')),
              h('div', { style: styles.row },
                h('span', { style: styles.label }, '配置'),
                h('span', null, status ? (status.configured ? '已填写' : '未填写') : '—')),
              status && status.last
                ? h('div', { style: styles.row },
                  h('span', { style: styles.label }, '上次结果'),
                  h('span', null, status.last.error
                    ? `失败：${status.last.error}`
                    : `上传 ${status.last.uploaded} · 下载 ${status.last.downloaded}`))
                : null),

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

            plan
              ? h('div', { style: styles.card },
                h('div', { style: styles.cardTitle }, '差异'),
                h('div', { style: styles.row },
                  h('span', { style: styles.label }, '需要上传'),
                  h('span', null, `${plan.uploadCount} 个 / ${Math.round(plan.uploadBytes / 1024)} KB`)),
                h('div', { style: styles.row },
                  h('span', { style: styles.label }, '需要下载'),
                  h('span', null, `${plan.downloadCount} 个 / ${Math.round(plan.downloadBytes / 1024)} KB`)),
                h('div', { style: styles.row },
                  h('span', { style: styles.label }, '已一致'),
                  h('span', null, `${plan.skippedCount} 个`)),
                plan.conflictCount > 0
                  ? h('div', { style: { ...styles.row, color: '#ffb46a' } },
                    h('span', { style: styles.label }, '冲突'),
                    h('span', null, `${plan.conflictCount} 个（会阻止执行）`))
                  : null)
              : null,

            h('div', { style: styles.actions },
              h('button', { type: 'button', style: styles.button, disabled: busy, onClick: doPlan }, '检查差异'),
              h('button', { type: 'button', style: styles.primary, disabled: busy || running, onClick: doStart }, '同步并重启'),
              h('button', { type: 'button', style: styles.primary, disabled: busy || running, onClick: () => doSync('both') }, '立即同步（不重启）'),
              running ? h('button', { type: 'button', style: styles.button, disabled: busy, onClick: doCancel }, '取消') : null,
              h('button', { type: 'button', style: styles.button, disabled: busy, onClick: doLog }, '看日志'),
              h('button', { type: 'button', style: styles.button, disabled: busy, onClick: doDiagnose }, '诊断环境'),
              h('button', { type: 'button', style: styles.button, disabled: busy, onClick: refresh }, '刷新状态')),

            h('div', { style: styles.actions },
              h('button', { type: 'button', style: styles.button, disabled: busy, onClick: () => doSync('download') }, '只从 FTP 下载'),
              h('button', { type: 'button', style: styles.button, disabled: busy, onClick: () => doSync('upload') }, '只上传到 FTP')),

            h('div', { style: styles.card },
              h('div', { style: styles.cardTitle }, '数据目录'),
              h('div', { style: styles.hint },
                '一般不用填。手机端如果报「找不到 ElecKoi 数据目录」，点「诊断环境」看候选路径，'
                + '把其中真实的那个（含 dsh-runtime 的那一层）填到这里。'),
              field('目录', h('input', {
                style: styles.input, value: rootHint, placeholder: '/data/user/0/<包名>/files/eleckoi-desktop',
                onChange: event => setRootHint(event.target.value),
              })),
              h('div', { style: styles.actions },
                h('button', { type: 'button', style: styles.primary, disabled: busy, onClick: doSetRoot }, '使用这个目录'),
                h('button', {
                  type: 'button', style: styles.button, disabled: busy,
                  onClick: () => { setRootHint(''); writeRootHint(''); setNote('已清空手动目录，下次请求重新自动探测') },
                }, '清空'))),

            h('div', { style: styles.hint },
              '「同步并重启」只在电脑上有效：守护进程会等你关闭 ElecKoi，备份、双向替换，然后重新打开程序。'),
            h('div', { style: styles.hint },
              '手机上（独立 App）用「立即同步」：当场比对并替换文件，完成后自己从后台划掉 ElecKoi 再打开，新数据才会被读到。'),

            h('div', { style: styles.card },
              h('div', { style: styles.cardTitle }, '同步范围'),
              h('div', { style: styles.hint },
                '数据库（角色卡、世界书、Agent 预设）+ 对话正文 + 会话快照（每个对话挂的预设与模型）+ '
                + '渲染出的 preset + 聊天附件与附件索引 + 图片资源 + 作者脚本。'),
              h('div', { style: styles.hint },
                '设备私钥、服务器凭据、API key、插件配置、缓存与日志不在范围内。')),
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
                Object.keys(diag.env).map(key => `${key} = ${diag.env[key] === null ? '（未设置）' : diag.env[key]}`).join('\n')),
              h('div', { style: styles.hint }, '全部候选（含未命中）：'),
              h('pre', { style: styles.pre },
                diag.candidates.map(item => `${item.evidence.length > 0 ? '✓' : '·'} ${item.path}  ← ${item.from}`).join('\n')),
              h('div', { style: styles.hint }, '找到的 dsh-runtime / 数据库所在层（直接填最可能的那个到「数据目录」）：'),
              h('pre', { style: styles.pre },
                Object.keys(diag.probes || {}).length === 0
                  ? '（往下扫了 3 层，没找到任何 dsh-runtime 目录或 .sqlite3 文件）'
                  : Object.keys(diag.probes).map(seed => `${seed}\n` + diag.probes[seed]
                    .map(hit => `  ✓ ${hit.path}   [${hit.kind === 'db' ? `含 ${hit.detail}` : '含 dsh-runtime'}]`)
                    .join('\n')).join('\n\n')),
              h('div', { style: styles.hint }, '目录普查（每个种子目录里都有些什么；✓ 表示那层像数据根，可以直接填到上面「数据目录」）：'),
              h('pre', { style: styles.pre },
                (diag.survey || []).map(block => {
                  const head = `${block.seed}`
                  const listing = `  ${block.entries.join('  ')}`
                  const hits = block.hits.length === 0
                    ? '  ✗ 这一层没有像数据根的子目录'
                    : block.hits.map(hit => `  ✓ ${hit.path}  [${hit.evidence.join(', ')}]`).join('\n')
                  return `${head}\n${listing}\n${hits}`
                }).join('\n\n') || '（没扫到候选种子）'))
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
