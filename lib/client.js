// dsh-agnes browser half: one settings page in the `settings.section` seat.
//
// Styling rules followed here (docs/web-styling):
//   - controls come from @deepseek-ai/dsh-client-ui-primitives, never raw
//     <input>/<button>, so the page inherits the product's own geometry;
//   - our own layout uses only `--dsw-*` theme tokens, never fixed colors;
//   - the page owns no state: every value is read from the host settings plane
//     and written back through it, so the page and the tools cannot disagree.
//
// The settings transport is version-dependent, and resolving it is the whole
// point of `resolveTransport` below (see its doc comment).
window.__ModuleLoader__.load({
  id: 'dsh-agnes',
  factory: (require) => {
    var module = { exports: {} }

    const React = require('react')
    const primitives = require('@deepseek-ai/dsh-client-ui-primitives')
    const { Button, Input, Pill, StateDot, DisclosureRow } = primitives
    const h = React.createElement

    const CSS = `
.ag-root{display:flex;flex-direction:column;gap:16px;max-width:880px;font-size:14px;line-height:22px;color:var(--dsw-alias-label-primary)}
.ag-head{display:flex;flex-direction:column;gap:2px}
.ag-title{margin:0;font-size:16px;line-height:24px;font-weight:600}
.ag-sub{margin:0;font-size:12px;line-height:20px;color:var(--dsw-alias-label-tertiary)}
.ag-card{border:1px solid var(--dsw-alias-border-l2);border-radius:12px;background:var(--dsw-alias-bg-layer-1);padding:2px 16px 6px}
.ag-card-title{padding:12px 0 2px;font-size:12px;line-height:20px;color:var(--dsw-alias-label-tertiary)}
.ag-row{display:grid;grid-template-columns:minmax(160px,200px) minmax(0,1fr) auto;align-items:center;gap:6px 12px;padding:8px 0;border-top:1px solid var(--dsw-alias-border-l2)}
.ag-card-title + .ag-row{border-top:none}
.ag-label{font-size:13px;line-height:20px;color:var(--dsw-alias-label-secondary)}
.ag-hint{grid-column:2 / span 2;margin-top:-2px;font-size:12px;line-height:18px;color:var(--dsw-alias-label-dimmed)}
.ag-field{width:100%}
.ag-tail{display:flex;align-items:center;gap:8px;justify-content:flex-end;min-width:104px}
.ag-note{font-size:12px;line-height:20px;color:var(--dsw-alias-label-tertiary)}
.ag-note[data-tone="warn"]{color:var(--dsw-alias-state-warn-primary)}
.ag-note[data-tone="error"]{color:var(--dsw-alias-state-error-primary)}
.ag-note[data-tone="ok"]{color:var(--dsw-alias-state-success-primary)}
.ag-notice{display:flex;align-items:center;gap:8px;justify-content:space-between}
.ag-status{display:inline-flex;align-items:center;gap:6px;white-space:nowrap;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary)}
.ag-pre{margin:4px 0 12px;padding:10px 12px;border-radius:8px;background:var(--dsw-alias-bg-layer-2);font-size:12px;line-height:18px;white-space:pre-wrap;word-break:break-all;max-height:320px;overflow:auto}
`
    const STYLE_ID = 'dsh-agnes/settings.css'
    if (typeof document !== 'undefined' && document.querySelector(`style[data-plugin-css="${STYLE_ID}"]`) === null) {
      const style = document.createElement('style')
      style.dataset.plugin = 'dsh-agnes'
      style.dataset.pluginCss = STYLE_ID
      style.textContent = CSS
      document.head.appendChild(style)
    }

    /** The settings namespace this plugin owns: its row's declared id. */
    const NS = 'agnes'

    const GROUPS = [
      {
        title: '图片',
        fields: [
          { key: 'imageModel', label: '默认图片模型', hint: 'agnes-image-2.5-flash（推荐）/ 2.1-flash / 2.0-flash' },
          { key: 'imageSize', label: '默认尺寸', hint: '档位 1K / 2K / 3K / 4K，或像素对如 1024x1024' },
        ],
      },
      {
        title: '视频',
        fields: [
          { key: 'videoModel', label: '默认视频模型', hint: 'agnes-video-v2.0 稳定可用；agnes-video-2.5 对当前 key 无可用通道' },
          { key: 'videoSize', label: '默认分辨率档', hint: '服务端吸附到最近预设（720P），实际尺寸以结果回报为准' },
          { key: 'videoAspectRatio', label: '默认宽高比', hint: '如 16:9、9:16、4:3' },
          { key: 'videoSeconds', label: '默认时长（秒）', hint: '该模型族目前为 5 秒' },
        ],
      },
      {
        title: '输出与行为',
        fields: [
          { key: 'outputDir', label: '输出目录', hint: '留空 = 会话工作区 agnes-output/<日期>/；不可写时回退到 DSH_HOME/agnes-output' },
          { key: 'pollIntervalMs', label: '后台轮询间隔 (ms)', numeric: true },
          { key: 'queueRetryMax', label: '队列满重试次数', numeric: true },
          { key: 'queueRetryDelayMs', label: '队列满重试间隔 (ms)', numeric: true },
        ],
      },
      {
        title: '连接',
        fields: [
          { key: 'baseUrl', label: 'API Base URL' },
          { key: 'credentialRef', label: '凭据引用名', hint: '只保存引用名；密钥值存放于 DSH 凭据存储' },
        ],
      },
    ]

    // schema defaults -> user overrides -> resolved section: the last one wins,
    // and merging all three means a field is never blank just because one of
    // those layers happens to be empty.
    function effectiveOf(snapshot) {
      if (!snapshot) return {}
      return { ...(snapshot.base || {}), ...(snapshot.user || {}), ...(snapshot.value || {}) }
    }

    /**
     * Resolve an optional host service.
     *
     * A client plugin must not put a capability it can live without into its
     * module-level `inject`: cordis keeps the whole module "waiting for
     * activation" until every injected name exists, and a module that never
     * activates fails the entire client boot ("Failed to load plugins"). The
     * host half of this plugin already follows the same rule with ctx.get();
     * this is the browser-side equivalent.
     */
    function serviceOf(ctx, name) {
      try {
        if (ctx && typeof ctx.get === 'function') {
          const found = ctx.get(name)
          if (found !== undefined && found !== null) return found
        }
      } catch (error) {
        /* fall through to the property form */
      }
      try {
        return ctx ? ctx[name] : undefined
      } catch (error) {
        return undefined
      }
    }

    /** Same-origin routes the host half serves for this page. */
    const SETTINGS_ROUTE = '/api/dsh-agnes.settings'
    const CREDENTIAL_ROUTE = '/api/dsh-agnes.credential'

    /**
     * Services captured through `inject`.
     *
     * `ctx.get()` alone is not enough on every host: the shipped client pages
     * reach the settings plane by NAMING it in their own `inject`
     * (`inject: ['remote', 'remote.settings']`), and this plugin's context does
     * not answer for those names with `get()` on dsh 0.2.0-rc.2's web client.
     * The injects below are NESTED, so a host that never publishes the service
     * leaves a waiting child fiber instead of holding this plugin's activation.
     */
    const captured = { remote: undefined, remoteSettings: undefined, scope: undefined }

    function captureServices(ctx) {
      if (typeof ctx.inject !== 'function') return
      const watch = (names, assign) => {
        try {
          ctx.inject(names, (scoped) => {
            try {
              assign(scoped)
            } catch (error) {
              /* a throwing accessor must not break activation */
            }
          })
        } catch (error) {
          /* an unsupported inject shape is not fatal */
        }
      }
      watch(['remote'], (scoped) => {
        const found = serviceOf(scoped, 'remote')
        if (found !== undefined) captured.remote = found
      })
      watch(['remote.settings'], (scoped) => {
        const found = serviceOf(scoped, 'remote.settings')
        if (found !== undefined) captured.remoteSettings = found
      })
      watch(['settingsScope'], (scoped) => {
        const found = serviceOf(scoped, 'settingsScope')
        if (found !== undefined) captured.scope = found
      })
    }

    /** The client's Remote namespace root, from inject first, then from get. */
    function remoteOf(ctx) {
      if (captured.remote !== undefined) return captured.remote
      const found = serviceOf(ctx, 'remote')
      return found !== undefined && found !== null ? found : undefined
    }

    /** True when the value exposes the generated Remote settings namespace. */
    function isSettingsRemote(value) {
      return (
        typeof value === 'object' &&
        value !== null &&
        typeof value.describe === 'function' &&
        (typeof value.mutate === 'function' || typeof value.update === 'function')
      )
    }

    /** True when the value is a legacy settings-scope binder (dsh 0.1.x). */
    function isScopeBinder(value) {
      return typeof value === 'object' && value !== null && typeof value.bind === 'function'
    }

    /**
     * The settings transports this host might offer, in preference order.
     *
     * dsh 0.2.x dropped the client-side `settingsScope` binder this page was
     * written against: a settings namespace is now a *Host* surface, and every
     * client page reads and writes it through the generated
     * `ctx.remote.settings` namespace (the plane the shipped Plugins / Models /
     * preset pages use: `describe()` for the layered view, `mutate()` for
     * path-addressed writes, `update()` for a patch). Older hosts, and the
     * desktop shell's own client world, still publish the binder — so it stays
     * as the second candidate instead of an assumption.
     *
     * Candidates are tried in order and the first one whose first read succeeds
     * wins; the last one is this plugin's OWN host route, which works even on a
     * host that publishes no client-side settings plane at all (see the host
     * half's `installSettingsBridge`). A candidate that is simply not present on
     * this host is not an error — the page moves on and reports the whole chain
     * only if every candidate failed.
     */
    function settingsCandidates(ctx) {
      const list = []
      // This plugin's own store comes FIRST: the host half reads that same file,
      // and the DSH settings plane is a *derived* view that legitimately omits a
      // plugin row (it lists only entries whose fiber is active AND whose
      // exported Config schema yields a volatile form). Putting the plane first
      // produced the exact failure this page kept reporting: a plane that
      // answers, but without an `agnes` namespace, shadowing a route that works.
      if (typeof fetch === 'function') list.push({ name: `HTTP ${SETTINGS_ROUTE}`, create: createBridgeAdapter })
      try {
        const remote = remoteOf(ctx)
        const remoteSettings =
          captured.remoteSettings !== undefined ? captured.remoteSettings : (remote && remote.settings) || serviceOf(ctx, 'remote.settings')
        if (isSettingsRemote(remoteSettings)) {
          list.push({ name: 'remote.settings', create: () => createRemoteAdapter(remoteSettings) })
        }
        const direct = serviceOf(ctx, 'settings')
        if (isSettingsRemote(direct)) list.push({ name: 'settings', create: () => createRemoteAdapter(direct) })
        const binder = captured.scope !== undefined ? captured.scope : serviceOf(ctx, 'settingsScope')
        if (isScopeBinder(binder)) list.push({ name: 'settingsScope', create: () => createScopeAdapter(binder) })
      } catch (error) {
        /* a throwing accessor only removes that candidate */
      }
      return list
    }

    /**
     * Everything this page can learn about the host's settings surface, for the
     * diagnostic note: which services resolved, what the Remote root exposes,
     * and why each transport candidate was rejected.
     */
    function transportReport(ctx, failures) {
      const report = { failures: failures.slice() }
      const names = ['remote', 'remote.settings', 'settings', 'settingsScope', 'connection', 'slots']
      for (const name of names) {
        try {
          const found = serviceOf(ctx, name)
          report[name] = found === undefined ? 'undefined' : typeof found
        } catch (error) {
          report[name] = `throw:${error && error.message ? error.message : error}`
        }
      }
      try {
        const remote = remoteOf(ctx)
        report.remoteKeys = remote !== null && typeof remote === 'object' && remote !== undefined ? Object.keys(remote).slice(0, 40) : null
      } catch (error) {
        report.remoteKeys = `throw:${error && error.message ? error.message : error}`
      }
      report.injected = Object.keys(captured).filter((key) => captured[key] !== undefined)
      return report
    }

    /** Top-level keys the host reports as secrets; they are never echoed back. */
    function secretKeysOf(view) {
      const list = Array.isArray(view && view.secrets) ? view.secrets : []
      const keys = []
      for (const entry of list) {
        const path = entry && entry.path
        if (Array.isArray(path) && path.length === 1 && typeof path[0] === 'string') keys.push(path[0])
        else if (typeof path === 'string' && path.length > 0) keys.push(path)
      }
      return keys
    }

    /**
     * Normalize one host namespace view into the snapshot the page renders.
     *
     * `base` / `user` / `value` are the layer names both the Remote view
     * (`SettingsNamespaceView`) and the legacy scope snapshot use, so the rows
     * below do not care which transport answered.
     */
    function snapshotOfView(view, writable) {
      return {
        status: 'ready',
        writable: writable && view.readonly !== true,
        revision: view.revision,
        ns: view.ns,
        base: view.base,
        user: view.user,
        value: view.value,
        schema: view.schema,
        secrets: secretKeysOf(view),
      }
    }

    /**
     * Adapter over the Remote settings plane (`ctx.remote.settings`).
     *
     * Reads accept both shapes a host may answer with: the Remote
     * `SettingsDescribeValue` (`{ writable, hasDocument, namespaces }`) and the
     * service-level descriptor array, so a client ctx that exposes the service
     * itself degrades to the same page instead of a broken one.
     */
    function createRemoteAdapter(face) {
      let snapshot = null
      const listeners = new Set()

      const publish = (next) => {
        snapshot = next
        for (const listener of [...listeners]) {
          try {
            listener()
          } catch (error) {
            /* a broken subscriber must not take the page with it */
          }
        }
      }

      const adopt = (described) => {
        const list = Array.isArray(described)
          ? described
          : described && Array.isArray(described.namespaces)
            ? described.namespaces
            : []
        const writable = Array.isArray(described) ? true : !(described && described.writable === false)
        const view = list.find((entry) => entry && entry.ns === NS)
        if (view === undefined || view === null) {
          publish({ status: writable ? 'ns-missing' : 'unavailable', writable: false, ns: NS })
          return snapshot
        }
        publish(snapshotOfView(view, writable))
        return snapshot
      }

      const adapter = {
        kind: 'remote',
        getSnapshot: () => snapshot,
        subscribe(listener) {
          listeners.add(listener)
          return () => {
            listeners.delete(listener)
          }
        },
        async load() {
          return adopt(await face.describe())
        },
        async set(key, value) {
          const revision = snapshot ? snapshot.revision : undefined
          if (typeof face.mutate === 'function') {
            const next = await face.mutate(NS, [{ op: 'set', path: [key], value }], revision)
            if (next && next.ns === NS) {
              publish(snapshotOfView(next, snapshot ? snapshot.writable !== false : true))
              return
            }
          } else if (typeof face.update === 'function') {
            const next = await face.update(NS, { [key]: value }, revision)
            if (next && next.ns === NS) {
              publish(snapshotOfView(next, snapshot ? snapshot.writable !== false : true))
              return
            }
          } else {
            throw new Error('该宿主不提供设置写入')
          }
          await adapter.load()
        },
        async unset(key) {
          if (typeof face.mutate !== 'function') throw new Error('该宿主不支持恢复默认值')
          const revision = snapshot ? snapshot.revision : undefined
          const next = await face.mutate(NS, [{ op: 'unset', path: [key] }], revision)
          if (next && next.ns === NS) {
            publish(snapshotOfView(next, snapshot ? snapshot.writable !== false : true))
            return
          }
          await adapter.load()
        },
      }
      return adapter
    }

    /** Adapter over a legacy `settingsScope.bind({ namespace })`. */
    function createScopeAdapter(binder) {
      const scope = binder.bind({ namespace: NS })
      const adapter = {
        kind: 'scope',
        getSnapshot: () => (typeof scope.getSnapshot === 'function' ? scope.getSnapshot() : null),
        subscribe(listener) {
          if (typeof scope.subscribe !== 'function') return () => {}
          const dispose = scope.subscribe(listener)
          return typeof dispose === 'function' ? dispose : () => {}
        },
        async load() {
          if (typeof scope.load === 'function') await scope.load()
          return adapter.getSnapshot()
        },
        async set(key, value) {
          if (typeof scope.set !== 'function') throw new Error('该宿主不提供设置写入')
          await scope.set(key, value)
        },
        async unset(key) {
          if (typeof scope.unset !== 'function') throw new Error('该宿主不支持恢复默认值')
          await scope.unset(key)
        },
      }
      return adapter
    }

    /**
     * Adapter over this plugin's own host route.
     *
     * This is the transport that works on a host whose web client publishes no
     * settings plane at all: the request is same-origin, the Host half answers
     * with the namespace view it read from the Host settings service, and every
     * write goes through `settings.mutate` there. Reads are idempotent, so a
     * failed read simply means "this host did not register the route".
     */
    function createBridgeAdapter() {
      let snapshot = null
      const listeners = new Set()

      const publish = (next) => {
        snapshot = next
        for (const listener of [...listeners]) {
          try {
            listener()
          } catch (error) {
            /* a broken subscriber must not take the page with it */
          }
        }
      }

      const call = async (init) => {
        // A bounded request: an unanswered write must not leave the row stuck in
        // "保存中…" (a disabled button that never comes back), which reads as a
        // dead page.
        const controller = typeof AbortController === 'function' ? new AbortController() : undefined
        const timer = controller === undefined ? undefined : setTimeout(() => controller.abort(), 15000)
        let response
        try {
          response = await fetch(SETTINGS_ROUTE, {
            credentials: 'same-origin',
            ...init,
            ...(controller === undefined ? {} : { signal: controller.signal }),
          })
        } catch (error) {
          if (error !== null && typeof error === 'object' && error.name === 'AbortError') throw new Error('请求超时（15 秒）')
          throw error
        } finally {
          if (timer !== undefined) clearTimeout(timer)
        }
        let payload = null
        try {
          payload = await response.json()
        } catch (error) {
          payload = null
        }
        if (!response.ok) {
          const detail = payload && (payload.error || payload.code)
          throw new Error(detail ? String(detail) : `HTTP ${response.status}`)
        }
        // The SPA fallback answers an unknown path with index.html and 200, so a
        // success WITHOUT JSON means this route was never registered — reporting
        // that as "no namespace" would send the reader down the wrong path.
        if (payload === null || typeof payload !== 'object') {
          throw new Error('设置路由未注册（该路径返回的是非 JSON 内容）')
        }
        return payload
      }

      const adopt = (described) => {
        const list = described && Array.isArray(described.namespaces) ? described.namespaces : []
        const writable = !(described && described.writable === false)
        const view = list.find((entry) => entry && entry.ns === NS)
        if (view === undefined || view === null) {
          const known = described && Array.isArray(described.known) ? described.known : undefined
          publish({ status: writable ? 'ns-missing' : 'unavailable', writable: false, ns: NS, known })
          return snapshot
        }
        const next = snapshotOfView(view, writable)
        if (described && typeof described.documentPath === 'string') next.documentPath = described.documentPath
        publish(next)
        return snapshot
      }

      const adapter = {
        kind: 'bridge',
        getSnapshot: () => snapshot,
        subscribe(listener) {
          listeners.add(listener)
          return () => {
            listeners.delete(listener)
          }
        },
        async load() {
          if (typeof fetch !== 'function') throw new Error('这个页面没有 fetch')
          return adopt(await call({ method: 'GET', headers: { accept: 'application/json' } }))
        },
        async write(ops) {
          const revision = snapshot ? snapshot.revision : undefined
          const described = await call({
            method: 'POST',
            headers: { accept: 'application/json', 'content-type': 'application/json' },
            body: JSON.stringify({ ops, revision }),
          })
          adopt(described)
        },
        async set(key, value) {
          await adapter.write([{ op: 'set', path: [key], value }])
        },
        async unset(key) {
          await adapter.write([{ op: 'unset', path: [key] }])
        },
      }
      return adapter
    }

    /**
     * Credential access: this plugin's own host route FIRST, the Remote plane
     * only as a fallback.
     *
     * The order matters for the same reason it does on the settings side, and it
     * was learned the same way: on this host the client's `remote.credentials`
     * resolves (so the old order picked it) but its calls do not answer usefully,
     * which parked the row on "未知" forever — the status dot never moved and the
     * save never reported anything, because every request went to that plane
     * instead of to the route that measurably works.
     */
    function credentialTransport(ctx) {
      if (typeof fetch === 'function') return bridgeCredentialTransport()
      const remote = remoteOf(ctx)
      const credentials = remote === undefined ? undefined : remote.credentials
      if (credentials !== undefined && credentials !== null && typeof credentials.describe === 'function') {
        return {
          kind: 'remote',
          describe: (refs) => credentials.describe(refs),
          set: (ref, value) => credentials.set(ref, value),
        }
      }
      return null
    }

    /** The host-route credential transport (see `credentialTransport`). */
    function bridgeCredentialTransport() {
      const call = async (url, init) => {
        const controller = typeof AbortController === 'function' ? new AbortController() : undefined
        const timer = controller === undefined ? undefined : setTimeout(() => controller.abort(), 15000)
        let response
        try {
          response = await fetch(url, {
            credentials: 'same-origin',
            ...init,
            ...(controller === undefined ? {} : { signal: controller.signal }),
          })
        } catch (error) {
          if (error !== null && typeof error === 'object' && error.name === 'AbortError') throw new Error('请求超时（15 秒）')
          throw error
        } finally {
          if (timer !== undefined) clearTimeout(timer)
        }
        let payload = null
        try {
          payload = await response.json()
        } catch (error) {
          payload = null
        }
        if (!response.ok) {
          const detail = payload && (payload.error || payload.code)
          throw new Error(detail ? String(detail) : `HTTP ${response.status}`)
        }
        if (payload === null || typeof payload !== 'object') throw new Error('凭据路由未注册（返回了非 JSON 内容）')
        return payload
      }
      return {
        kind: 'bridge',
        async describe(refs) {
          const out = {}
          for (const ref of refs) {
            const payload = await call(`${CREDENTIAL_ROUTE}?ref=${encodeURIComponent(ref)}`, {
              method: 'GET',
              headers: { accept: 'application/json' },
            })
            out[ref] = payload && payload.ref === ref ? payload.configured : undefined
          }
          return out
        },
        async set(ref, value) {
          await call(CREDENTIAL_ROUTE, {
            method: 'POST',
            headers: { accept: 'application/json', 'content-type': 'application/json' },
            body: JSON.stringify({ ref, value }),
          })
        },
      }
    }

    /**
     * Attach one settings adapter and keep its snapshot in React state.
     *
     * Candidates are probed in order with a short retry window: a client
     * plugin's apply() runs before the page's own host half is guaranteed to
     * have registered its route, and a one-shot lookup would leave the page
     * permanently unbound — the failure this page used to report as
     * "当前宿主未提供 settingsScope 服务". When every candidate fails, the page
     * says so and shows the probe, so the next report names the cause.
     */
    function useSettings(ctx) {
      const [adapter, setAdapter] = React.useState(null)
      const [snapshot, setSnapshot] = React.useState(null)
      const [bindError, setBindError] = React.useState('')
      const [probe, setProbe] = React.useState(null)
      const [generation, setGeneration] = React.useState(0)

      React.useEffect(() => {
        let live = true
        let attached
        let unsubscribe
        let timer
        let tries = 0
        const failures = []

        const sync = () => {
          if (!live || !attached) return
          setSnapshot(attached.getSnapshot())
        }

        const attempt = (candidates, index) => {
          if (!live || attached) return
          if (index >= candidates.length) {
            tries += 1
            if (tries <= 20) {
              // The host half may still be applying its row; retry the chain.
              failures.length = 0
              timer = setTimeout(() => attempt(settingsCandidates(ctx), 0), 250)
              return
            }
            const report = transportReport(ctx, failures)
            setProbe(report)
            try {
              console.error('[agnes] no settings transport', JSON.stringify(report))
            } catch (loggingError) {
              /* logging must never break the page */
            }
            setBindError(`当前宿主没有可用的设置传输（${failures.slice(-3).join('；') || '未提供任何设置平面'}）`)
            return
          }
          const candidate = candidates[index]
          let instance
          try {
            instance = candidate.create()
            unsubscribe = instance.subscribe(sync)
            Promise.resolve()
              .then(() => instance.load())
              .then(() => {
                if (!live || attached) return
                attached = instance
                setAdapter(instance)
                setBindError('')
                sync()
                try {
                  // One line per mount: which transport the page actually bound
                  // to. It is the first thing to look for in harness.log when a
                  // settings plane starts answering differently.
                  console.warn(`[agnes] settings transport: ${candidate.name}`)
                } catch (loggingError) {
                  /* logging must never break the page */
                }
              })
              .catch((error) => {
                if (!live || attached) return
                failures.push(`${candidate.name}: ${error && error.message ? error.message : String(error)}`)
                if (typeof unsubscribe === 'function') {
                  try {
                    unsubscribe()
                  } catch (cleanupError) {
                    /* ignore */
                  }
                  unsubscribe = undefined
                }
                attempt(candidates, index + 1)
              })
          } catch (error) {
            failures.push(`${candidate.name}: ${error && error.message ? error.message : String(error)}`)
            attempt(candidates, index + 1)
          }
        }

        attempt(settingsCandidates(ctx), 0)
        return () => {
          live = false
          if (timer !== undefined) clearTimeout(timer)
          if (typeof unsubscribe === 'function') unsubscribe()
        }
      }, [generation])

      const retry = React.useCallback(() => {
        setAdapter(null)
        setSnapshot(null)
        setBindError('')
        setProbe(null)
        setGeneration((value) => value + 1)
      }, [])

      return { adapter, snapshot, bindError, probe, retry }
    }

    function Row(props) {
      const { field, adapter, snapshot } = props
      const effective = effectiveOf(snapshot)
      const user = (snapshot && snapshot.user) || {}
      const overridden = user[field.key] !== undefined && user[field.key] !== null
      const secret = Array.isArray(snapshot && snapshot.secrets) && snapshot.secrets.indexOf(field.key) >= 0
      const text = (value) => (value === undefined || value === null ? '' : String(value))
      const [draft, setDraft] = React.useState(text(effective[field.key]))
      const [status, setStatus] = React.useState('')
      const [busy, setBusy] = React.useState(false)
      const editing = React.useRef(false)

      React.useEffect(() => {
        if (editing.current) return
        setDraft(text(effectiveOf(snapshot)[field.key]))
      }, [snapshot])

      const commit = React.useCallback(async () => {
        if (!adapter || typeof adapter.set !== 'function') return
        const payload = field.numeric ? Number(draft) : draft
        if (field.numeric && !Number.isFinite(payload)) {
          setStatus('需要数字')
          return
        }
        // A secret field the host redacted comes back empty; an empty box means
        // "leave it alone", never "erase it".
        if (secret && draft === '') return
        setBusy(true)
        setStatus('保存中')
        try {
          await adapter.set(field.key, payload)
          setStatus('已保存')
        } catch (error) {
          setStatus(`失败：${error && error.message ? error.message : error}`)
          // A rejected write usually means a stale revision; re-read so the next
          // attempt is not guaranteed to fail the same way.
          try {
            await adapter.load()
          } catch (reloadError) {
            /* the next subscription tick reports the host state */
          }
        } finally {
          setBusy(false)
        }
      }, [draft, adapter, field, secret])

      const reset = React.useCallback(async () => {
        if (!adapter || typeof adapter.unset !== 'function') return
        setBusy(true)
        try {
          await adapter.unset(field.key)
          setStatus('已恢复默认')
        } catch (error) {
          setStatus(`失败：${error && error.message ? error.message : error}`)
          try {
            await adapter.load()
          } catch (reloadError) {
            /* the next subscription tick reports the host state */
          }
        } finally {
          setBusy(false)
        }
      }, [adapter, field])

      const readonly = snapshot ? snapshot.writable === false : false

      return h(
        React.Fragment,
        null,
        h(
          'div',
          { className: 'ag-row' },
          h('span', { className: 'ag-label' }, field.label),
          h(Input, {
            className: 'ag-field',
            value: draft,
            disabled: busy || readonly,
            placeholder: secret ? '已配置（不回显）' : undefined,
            onChange: (event) => setDraft(event.target.value),
            onFocus: () => {
              editing.current = true
            },
            onBlur: () => {
              editing.current = false
              if (draft !== text(effectiveOf(snapshot)[field.key])) void commit()
            },
            onKeyDown: (event) => {
              if (event.key === 'Enter') event.currentTarget.blur()
              if (event.key === 'Escape') setDraft(text(effectiveOf(snapshot)[field.key]))
            },
          }),
          h(
            'div',
            { className: 'ag-tail' },
            status
              ? h(
                  'span',
                  { className: 'ag-note', 'data-tone': status.startsWith('失败') || status === '需要数字' ? 'error' : 'ok' },
                  status,
                )
              : null,
            overridden
              ? h(Pill, { onClick: reset, title: '清除该项覆盖，回到默认值' }, '已改 · 重置')
              : h(Pill, null, '默认'),
          ),
        ),
        field.hint ? h('span', { className: 'ag-hint' }, field.hint) : null,
      )
    }

    function CredentialRow(props) {
      const { ctx, refName } = props
      const [value, setValue] = React.useState('')
      const [status, setStatus] = React.useState('')
      const [busy, setBusy] = React.useState(false)
      const [configured, setConfigured] = React.useState(null)
      const [probeNote, setProbeNote] = React.useState('')
      const inputRef = React.useRef(null)

      const probe = React.useCallback(async () => {
        const transport = credentialTransport(ctx)
        if (transport === null || typeof transport.describe !== 'function') {
          setConfigured('unknown')
          setProbeNote('没有可用的凭据通道（宿主半边未加载？）')
          return
        }
        try {
          const described = await transport.describe([refName])
          const entry = described ? described[refName] : undefined
          if (entry === undefined || entry === null) setConfigured(false)
          else if (typeof entry === 'boolean') setConfigured(entry)
          else if (typeof entry === 'object') {
            const flag = entry.configured ?? entry.present ?? entry.set ?? entry.hasValue
            setConfigured(flag === undefined ? Boolean(entry.value) : Boolean(flag))
          } else setConfigured(true)
          setProbeNote('')
        } catch (error) {
          // "未知" alone told nobody anything; keep the reason next to it.
          setConfigured('unknown')
          setProbeNote(`${transport.kind} 通道查询失败：${error && error.message ? error.message : error}`)
        }
      }, [ctx, refName])

      React.useEffect(() => {
        void probe()
      }, [probe])

      const save = React.useCallback(async () => {
        // The button stays clickable on purpose: a disabled save is
        // indistinguishable from a broken page, which is exactly how this row
        // was read once already. Say what is missing instead.
        //
        // The live DOM value is the fallback source: if a host build ever fails
        // to route the input's change event back into React state, the box would
        // LOOK filled while this component still saw an empty string — a silent
        // no-op. `Input` forwards refs (the official pages pass one), so the
        // text the user can see is always what gets written.
        let payload = value
        if (payload.length === 0) {
          const node = inputRef.current
          if (node !== null && node !== undefined && typeof node.value === 'string') payload = node.value
        }
        if (payload.length === 0) {
          setStatus('请先粘贴 API Key：输入框现在是空的')
          return
        }
        const transport = credentialTransport(ctx)
        setBusy(true)
        setStatus('')
        try {
          if (transport === null || typeof transport.set !== 'function') {
            throw new Error('当前页面拿不到凭据写入通道（宿主半边未加载？）')
          }
          await transport.set(refName, payload)
          setValue('')
          if (inputRef.current !== null && inputRef.current !== undefined) inputRef.current.value = ''
          setStatus('已写入凭据存储（页面不回显密钥）')
          await probe()
        } catch (error) {
          setStatus(`失败：${error && error.message ? error.message : error}`)
        } finally {
          setBusy(false)
        }
      }, [ctx, refName, value, probe])

      return h(
        React.Fragment,
        null,
        h(
          'div',
          { className: 'ag-row' },
          h('span', { className: 'ag-label' }, 'API Key'),
          h(Input, {
            className: 'ag-field',
            type: 'password',
            ref: inputRef,
            value,
            disabled: busy,
            placeholder: '粘贴 cpk- 开头的密钥，保存后不回显',
            onChange: (event) => setValue(event.target.value),
            onKeyDown: (event) => {
              if (event.key === 'Enter') void save()
            },
          }),
          h(
            'div',
            { className: 'ag-tail' },
            h(
              'span',
              { className: 'ag-status' },
              h(StateDot, { state: configured === true ? 'done' : configured === false ? 'warning' : 'ongoing', size: 8 }),
              configured === true ? '已配置' : configured === false ? '未配置' : '未知',
            ),
            h(Button, { variant: 'primary', size: 'sm', disabled: busy, onClick: save }, busy ? '保存中…' : '保存'),
          ),
        ),
        h('span', { className: 'ag-hint' }, `凭据引用：${refName} · 密钥值保存在 DSH 凭据存储中，页面不回显、日志不打印`),
        h(
          'span',
          { className: 'ag-hint' },
          value.length > 0
            ? `已输入 ${value.length} 个字符，点右侧「保存」写入凭据存储`
            : '把密钥粘贴到左边的输入框，再点右侧「保存」',
        ),
        probeNote ? h('span', { className: 'ag-note', 'data-tone': 'warn' }, probeNote) : null,
        status ? h('span', { className: 'ag-hint' }, status) : null,
      )
    }

    function SettingsPage(props) {
      const ctx = props.ctx
      const { adapter, snapshot, bindError, probe, retry } = useSettings(ctx)
      const [debugOpen, setDebugOpen] = React.useState(false)

      const effective = effectiveOf(snapshot)
      const refName = effective.credentialRef || 'AGNES_API_KEY'
      const writable = snapshot ? snapshot.writable !== false : true
      const status = snapshot ? snapshot.status : 'loading'

      let notice = null
      if (bindError) notice = { tone: 'error', text: `设置命名空间绑定失败：${bindError}`, retry: true }
      else if (status === 'unavailable') notice = { tone: 'warn', text: '设置服务不可用：只有通过本机（loopback）打开的页面才能读写设置。', retry: true }
      else if (status === 'ns-missing') {
        const known = Array.isArray(snapshot && snapshot.known) ? snapshot.known : []
        const knownText = known.length > 0 ? `（宿主现有：${known.slice(0, 12).join(', ')}${known.length > 12 ? ' …' : ''}）` : ''
        notice = {
          tone: 'warn',
          text: `宿主的设置平面里没有 “${NS}” 命名空间${knownText}：请确认插件宿主半边已加载，并已导出 Config schema。`,
          retry: true,
        }
      } else if (snapshot === null || status === 'loading') notice = { tone: '', text: '正在读取设置…' }
      else if (!writable) notice = { tone: 'warn', text: '当前页面只读：设置写入未开启。', retry: true }

      return h(
        'div',
        { className: 'ag-root' },
        h(
          'div',
          { className: 'ag-head' },
          h('h3', { className: 'ag-title' }, 'Agnes 图像 / 视频'),
          h(
            'p',
            { className: 'ag-sub' },
            '这里只做配置：填好 API Key 与默认参数后，能力由 bundled skill `agnes` 调用（agent 用 shell 执行 lib/cli.mjs 生成图片 / 视频），产物立即落盘，URL 不作为交付物。',
          ),
          snapshot && typeof snapshot.documentPath === 'string'
            ? h(
                'p',
                { className: 'ag-sub' },
                `配置文件：${snapshot.documentPath}（页面与命令行共用这一份；DSH 设置里的同名项会被它覆盖）`,
              )
            : null,
        ),
        notice
          ? h(
              'div',
              { className: 'ag-notice' },
              h('span', { className: 'ag-note', 'data-tone': notice.tone }, notice.text),
              notice.retry ? h(Pill, { onClick: retry, title: '重新读取宿主设置' }, '重新绑定') : null,
            )
          : null,
        h('div', { className: 'ag-card' }, h('div', { className: 'ag-card-title' }, '凭据'), h(CredentialRow, { ctx, refName })),
        ...GROUPS.map((group) =>
          h(
            'div',
            { className: 'ag-card', key: group.title },
            h('div', { className: 'ag-card-title' }, group.title),
            ...group.fields.map((field) => h(Row, { key: field.key, field, adapter, snapshot })),
          ),
        ),
        h(
          'div',
          { className: 'ag-card' },
          h(DisclosureRow, {
            title: '原始设置快照（排查用）',
            open: debugOpen,
            expandable: true,
            onToggle: () => setDebugOpen((open) => !open),
          }),
          debugOpen ? h('pre', { className: 'ag-pre' }, JSON.stringify(snapshot, null, 2)) : null,
          debugOpen && probe !== null
            ? h('pre', { className: 'ag-pre' }, `设置传输探测：\n${JSON.stringify(probe, null, 2)}`)
            : null,
        ),
      )
    }

    /**
     * Keeps one page-level crash from becoming a BLANK page.
     *
     * A slot entry whose render throws is abdicated by the shell's own error
     * boundary: the entry is retired, the settings nav loses the section, and
     * the user sees nothing at all — no message, no clue. Catching here turns
     * that into visible text (and a console line the desktop log bridge keeps),
     * so a failure is always reportable instead of silent.
     */
    class PageBoundary extends React.Component {
      constructor(props) {
        super(props)
        this.state = { error: null }
      }

      static getDerivedStateFromError(error) {
        return { error }
      }

      componentDidCatch(error, info) {
        try {
          console.error('[agnes] settings page render failed', error, info)
        } catch (loggingError) {
          /* logging must never re-break the page */
        }
      }

      render() {
        const error = this.state ? this.state.error : null
        if (!error) return this.props.children
        const message = error && error.message ? error.message : String(error)
        const stack = error && error.stack ? String(error.stack) : message
        try {
          console.warn('[agnes] settings page render failed:', message)
        } catch (loggingError) {
          /* ignore */
        }
        return h(
          'div',
          { className: 'ag-root' },
          h('h3', { className: 'ag-title' }, 'Agnes 设置页渲染失败'),
          h('span', { className: 'ag-note', 'data-tone': 'error' }, message),
          h('pre', { className: 'ag-pre' }, stack),
        )
      }
    }

    function apply(ctx) {
      const slots = ctx.get('slots')
      if (slots === undefined) return
      captureServices(ctx)
      slots.inject('settings.section', () =>
        slots.register({ name: 'settings.section', id: 'agnes', order: 60, label: () => 'Agnes' }, (props) =>
          h(PageBoundary, null, h(SettingsPage, { ctx, ...props })),
        ),
      )
    }

    module.exports = {
      name: 'dsh-agnes',
      // `slots` is the one service this page cannot work without. Everything
      // else — the settings transport and `remote` — is captured with NESTED
      // injects and lazy lookups that degrade on their own: naming them here
      // made the whole module wait forever for a name this host does not
      // publish, which surfaced as "dsh-agnes is waiting for activation".
      inject: ['slots'],
      apply,
    }

    return module.exports
  },
})
