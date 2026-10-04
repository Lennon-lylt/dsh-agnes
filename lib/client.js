// dsh-agnes browser half.
//
// One settings page in the `settings.section` seat. It owns no state: every
// field reads and writes the host's `agnes` settings namespace through
// ctx.settingsScope, and the API key goes to the credential store through the
// settings/credentials Remote — the page never keeps a copy and never echoes
// the secret back.
//
// This file is a client bundle in the DSH module-loader format: executing it
// only registers a factory, and `require` resolves against the platform seed
// table (React) plus this package's declared externals.
window.__ModuleLoader__.load({
  id: 'dsh-agnes',
  factory: (require) => {
    var module = { exports: {} }

    const React = require('react')
    const h = React.createElement

    const FIELDS = [
      { key: 'baseUrl', label: 'API Base URL' },
      { key: 'imageModel', label: '默认图片模型' },
      { key: 'imageSize', label: '默认图片尺寸（1K/2K/3K/4K 或 1024x1024）' },
      { key: 'videoModel', label: '默认视频模型' },
      { key: 'videoSize', label: '默认视频分辨率档（720P）' },
      { key: 'videoAspectRatio', label: '默认视频宽高比（16:9）' },
      { key: 'videoSeconds', label: '默认视频秒数（5）' },
      { key: 'outputDir', label: '输出目录（留空 = 工作区 agnes-output）' },
      { key: 'pollIntervalMs', label: '后台轮询间隔 (ms)', numeric: true },
      { key: 'queueRetryMax', label: '队列满重试次数', numeric: true },
      { key: 'queueRetryDelayMs', label: '队列满重试间隔 (ms)', numeric: true },
    ]

    function readSnapshot(scope) {
      if (!scope) return null
      try {
        if (typeof scope.getSnapshot === 'function') return scope.getSnapshot()
        if (scope.snapshot && typeof scope.snapshot === 'object') return scope.snapshot
      } catch (error) {
        return { error: String(error && error.message ? error.message : error) }
      }
      return null
    }

    function sectionOf(scope, level) {
      const snapshot = readSnapshot(scope)
      if (!snapshot) return {}
      const bucket = snapshot[level]
      return bucket && typeof bucket === 'object' ? bucket : {}
    }

    function useScope(rawCtx) {
      const [scope, setScope] = React.useState(null)
      const [status, setStatus] = React.useState('正在绑定设置命名空间…')
      const [revision, setRevision] = React.useState(0)

      React.useEffect(() => {
        let bound
        try {
          bound = rawCtx.settingsScope.bind({ namespace: 'agnes' })
        } catch (error) {
          setStatus(`绑定失败：${error && error.message ? error.message : error}`)
          return undefined
        }
        setScope(bound)
        setStatus('')
        let dispose
        try {
          if (typeof bound.subscribe === 'function') {
            dispose = bound.subscribe(() => setRevision((n) => n + 1))
          }
        } catch (error) {
          /* a scope without subscribe still renders its first snapshot */
        }
        return () => {
          if (typeof dispose === 'function') dispose()
        }
      }, [])

      return { scope, status, revision }
    }

    function Field(props) {
      const resolved = props.resolved
      const initial = resolved[props.field.key]
      const [value, setValue] = React.useState(initial === undefined || initial === null ? '' : String(initial))
      const [state, setState] = React.useState('')

      React.useEffect(() => {
        const next = resolved[props.field.key]
        setValue(next === undefined || next === null ? '' : String(next))
      }, [props.revision])

      const save = async () => {
        if (!props.scope) return
        setState('保存中…')
        try {
          const payload = props.field.numeric ? Number(value) : value
          if (typeof props.scope.set === 'function') await props.scope.set(props.field.key, payload)
          else if (typeof props.scope.mutate === 'function') await props.scope.mutate([{ op: 'set', path: [props.field.key], value: payload }])
          setState('已保存')
        } catch (error) {
          setState(`失败：${error && error.message ? error.message : error}`)
        }
      }

      return h(
        'div',
        { style: { display: 'flex', gap: '8px', alignItems: 'center', margin: '6px 0' } },
        h('label', { style: { flex: '0 0 300px', fontSize: '12px', opacity: 0.8 } }, props.field.label),
        h('input', {
          value,
          onChange: (event) => setValue(event.target.value),
          style: { flex: '1 1 auto', minWidth: '160px', padding: '4px 8px' },
        }),
        h('button', { type: 'button', onClick: save, style: { padding: '4px 12px' } }, '保存'),
        h('span', { style: { fontSize: '12px', opacity: 0.7, minWidth: '120px' } }, state),
      )
    }

    function ApiKeyRow(props) {
      const [value, setValue] = React.useState('')
      const [state, setState] = React.useState('')

      const configured = props.credentialState

      const save = async () => {
        setState('保存中…')
        try {
          const credentials = props.rawCtx.remote && props.rawCtx.remote.credentials
          if (!credentials || typeof credentials.set !== 'function') throw new Error('当前连接不提供凭据写入（非 loopback 访问？）')
          await credentials.set(props.refName, value)
          setValue('')
          setState('已写入凭据存储')
          props.onSaved()
        } catch (error) {
          setState(`失败：${error && error.message ? error.message : error}`)
        }
      }

      return h(
        'div',
        { style: { margin: '10px 0' } },
        h(
          'div',
          { style: { fontSize: '12px', opacity: 0.8, marginBottom: '4px' } },
          `API Key（凭据引用 ${props.refName}；当前状态：${configured}）`,
        ),
        h(
          'div',
          { style: { display: 'flex', gap: '8px', alignItems: 'center' } },
          h('input', {
            type: 'password',
            value,
            placeholder: '粘贴 Agnes API Key（cpk-…）后点保存，不会回显',
            onChange: (event) => setValue(event.target.value),
            style: { flex: '1 1 auto', minWidth: '260px', padding: '4px 8px' },
          }),
          h('button', { type: 'button', onClick: save, style: { padding: '4px 12px' } }, '保存密钥'),
          h('span', { style: { fontSize: '12px', opacity: 0.7 } }, state),
        ),
      )
    }

    function SettingsPage(props) {
      const { scope, status, revision } = useScope(props.ctx)
      const resolved = scope ? { ...sectionOf(scope, 'base'), ...sectionOf(scope, 'user') } : {}
      const [credentialState, setCredentialState] = React.useState('未知')
      const refName = resolved.credentialRef || 'AGNES_API_KEY'

      const probeCredential = React.useCallback(async () => {
        try {
          const credentials = props.ctx.remote && props.ctx.remote.credentials
          if (!credentials || typeof credentials.describe !== 'function') {
            setCredentialState('无法查询')
            return
          }
          const described = await credentials.describe([refName])
          const entry = described && described[refName]
          setCredentialState(entry && entry.configured ? '已配置' : '未配置')
        } catch (error) {
          setCredentialState('无法查询')
        }
      }, [refName])

      React.useEffect(() => {
        void probeCredential()
      }, [probeCredential])

      const snapshot = scope ? readSnapshot(scope) : null

      return h(
        'div',
        { style: { padding: '4px 2px', maxWidth: '900px' } },
        h('h3', { style: { margin: '0 0 4px' } }, 'Agnes 图像 / 视频'),
        h(
          'p',
          { style: { fontSize: '12px', opacity: 0.75, margin: '0 0 12px' } },
          '工具：agnes_image（文生图 / 图生图）、agnes_video（文生视频 / 首帧驱动）、agnes_task（任务查询）、agnes_models（模型清单）。所有产出会立即下载到磁盘。',
        ),
        status ? h('div', { style: { color: 'crimson', fontSize: '12px' } }, status) : null,
        h(ApiKeyRow, { rawCtx: props.ctx, refName, credentialState, onSaved: probeCredential }),
        h('hr', { style: { margin: '12px 0', opacity: 0.2 } }),
        ...FIELDS.map((field) => h(Field, { key: field.key, field, scope, resolved, revision })),
        h(
          'details',
          { style: { marginTop: '12px', fontSize: '12px', opacity: 0.7 } },
          h('summary', null, '原始设置快照（排查用）'),
          h('pre', { style: { whiteSpace: 'pre-wrap', wordBreak: 'break-all' } }, JSON.stringify(snapshot, null, 2)),
        ),
      )
    }

    function apply(ctx) {
      const slots = ctx.get('slots')
      if (slots === undefined) return
      slots.inject('settings.section', () =>
        slots.register({ name: 'settings.section', id: 'agnes', order: 60, label: () => 'Agnes' }, (props) =>
          h(SettingsPage, { ctx, ...props }),
        ),
      )
    }

    module.exports = {
      name: 'dsh-agnes',
      inject: ['slots', 'settingsScope', 'remote'],
      apply,
    }

    return module.exports
  },
})
