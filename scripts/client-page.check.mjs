/**
 * Client-page check: drives the settings page against a simulated client world.
 *
 * The settings surface is where this plugin was already burned once, so the
 * transport is verified against all three shapes a deployment can present,
 * without a browser and without booting DSH:
 *
 *   1. dsh 0.2.x — the generated `ctx.remote.settings` plane
 *      (`describe()` for the layered view, `mutate()` for path-addressed
 *      writes), including the revision a write must carry;
 *   2. a host whose settings plane has no `agnes` namespace (host half not
 *      loaded, or no Config schema to derive it from);
 *   3. dsh 0.1.x — the legacy `settingsScope.bind({ namespace })` binder.
 *
 * It implements just enough of React (hooks with per-instance state, effects
 * with dependency comparison) and of the reconciler (child components rendered
 * by tree position) to render the page for real.
 *
 *   node scripts/client-page.check.mjs
 */
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const pluginPath = path.join(import.meta.dirname, '..', 'lib', 'client.js')

// ------------------------------------------------------------------ React
let current = null
let jobs = []
let dirty = false

/** Minimal React.Component, so the page's own error boundary is a real class. */
class Component {
  constructor(props) {
    this.props = props
    this.state = null
  }

  setState() {}
}
Component.prototype.isReactComponent = {}

const React = {
  Component,
  createElement(type, props, ...children) {
    const merged = { ...(props || {}) }
    if (children.length === 1) merged.children = children[0]
    else if (children.length > 1) merged.children = children
    return { type, props: merged }
  },
  Fragment: 'Fragment',
  useState(initial) {
    const inst = current
    const i = inst.cursor++
    if (!(i in inst.hooks)) inst.hooks[i] = typeof initial === 'function' ? initial() : initial
    const set = (next) => {
      const value = typeof next === 'function' ? next(inst.hooks[i]) : next
      if (value !== inst.hooks[i]) {
        inst.hooks[i] = value
        dirty = true
      }
    }
    return [inst.hooks[i], set]
  },
  useEffect(effect, deps) {
    const inst = current
    const i = inst.cursor++
    const prev = inst.hooks[i]
    const changed =
      prev === undefined ||
      !Array.isArray(deps) ||
      !Array.isArray(prev.deps) ||
      deps.length !== prev.deps.length ||
      deps.some((value, k) => value !== prev.deps[k])
    if (!changed) return undefined
    if (prev && typeof prev.cleanup === 'function') prev.cleanup()
    inst.hooks[i] = { deps, cleanup: undefined }
    jobs.push(() => {
      const cleanup = effect()
      if (inst.hooks[i] === undefined || inst.hooks[i].deps !== deps) return
      inst.hooks[i].cleanup = cleanup
    })
    return undefined
  },
  useCallback(fn) {
    current.cursor++
    return fn
  },
  useRef(initial) {
    const inst = current
    const i = inst.cursor++
    if (!(i in inst.hooks)) inst.hooks[i] = { current: initial }
    return inst.hooks[i]
  },
}

const primitive = (name) => (props) => ({ type: name, props: props || {} })
/** The value that makes the Input stub throw, to exercise the page boundary. */
const BOOM = '__agnes_boom__'
const primitives = {
  Button: primitive('Button'),
  Input: (props) => {
    if (props && props.value === BOOM) throw new Error('boom: injected render failure')
    return { type: 'Input', props: props || {} }
  },
  Pill: primitive('Pill'),
  StateDot: primitive('StateDot'),
  DisclosureRow: primitive('DisclosureRow'),
  Tooltip: primitive('Tooltip'),
}

// ------------------------------------------------------- tiny reconciler
const instances = new Map()

function childrenOf(props) {
  const value = props ? props.children : undefined
  if (value === undefined || value === null) return []
  return Array.isArray(value) ? value : [value]
}

function renderNode(node, key) {
  if (node === null || node === undefined || typeof node !== 'object') return node
  if (Array.isArray(node)) return node.map((child, index) => renderNode(child, `${key}.${index}`))
  const type = node.type
  if (type === 'Fragment') return childrenOf(node.props).map((child, index) => renderNode(child, `${key}.${index}`))
  if (typeof type === 'function') {
    const isClass = type.prototype !== undefined && type.prototype.isReactComponent !== undefined
    const inst = instances.get(key) || { hooks: [], cursor: 0, instance: null }
    instances.set(key, inst)
    const previous = current
    current = inst
    try {
      if (isClass) {
        if (inst.instance === null) {
          inst.instance = new type(node.props || {})
          inst.instance.setState = (patch) => {
            const next = typeof patch === 'function' ? patch(inst.instance.state) : patch
            inst.instance.state = { ...(inst.instance.state || {}), ...next }
            dirty = true
          }
        }
        inst.instance.props = node.props || {}
        // Real error-boundary scope: the boundary's static hook runs for a throw
        // anywhere in its SUBTREE, then the same instance renders again.
        try {
          return renderNode(inst.instance.render(), key)
        } catch (error) {
          if (typeof type.getDerivedStateFromError !== 'function') throw error
          inst.instance.state = { ...(inst.instance.state || {}), ...type.getDerivedStateFromError(error) }
          return renderNode(inst.instance.render(), key)
        }
      }
      return renderNode(type(node.props || {}), key)
    } finally {
      current = previous
    }
  }
  const original = node.props ? node.props.children : undefined
  const rendered = childrenOf(node.props).map((child, index) => renderNode(child, `${key}.${index}`))
  return { type, props: { ...(node.props || {}), children: Array.isArray(original) ? rendered : rendered[0] } }
}

/** Render until no state changed, running effects the way React does. */
async function flush() {
  let tree
  for (let round = 0; round < 60; round += 1) {
    dirty = false
    jobs = []
    for (const inst of instances.values()) inst.cursor = 0
    tree = renderNode(root, 'root')
    for (let guard = 0; jobs.length > 0 && guard < 200; guard += 1) jobs.shift()()
    await new Promise((resolve) => setTimeout(resolve, 15))
    for (let guard = 0; jobs.length > 0 && guard < 200; guard += 1) jobs.shift()()
    await new Promise((resolve) => setTimeout(resolve, 15))
    if (!dirty && jobs.length === 0) break
  }
  return tree
}

function walk(node, visit) {
  if (node === null || typeof node !== 'object') return
  if (Array.isArray(node)) {
    for (const child of node) walk(child, visit)
    return
  }
  visit(node)
  walk(node.props ? node.props.children : undefined, visit)
}

function rowByLabel(tree, label) {
  let found = null
  walk(tree, (node) => {
    if (found || !node.props || node.props.className !== 'ag-row') return
    const parts = childrenOf(node.props)
    const span = parts[0]
    if (span && span.props && span.props.children === label) found = { input: parts[1], tail: parts[2] }
  })
  if (found === null) throw new Error(`row not found: ${label}`)
  return found
}

function nodeWithText(tree, text) {
  let found = null
  walk(tree, (node) => {
    if (found || !node.props) return
    if (node.props.children === text) found = node
  })
  return found
}

function collectText(tree) {
  const out = []
  walk(tree, (node) => {
    if (node.props && typeof node.props.children === 'string') out.push(node.props.children)
  })
  return out.join(' | ')
}

/**
 * Type an input the way a person does: focus, change (its own render), blur.
 * React delivers change and blur in separate renders, so the intermediate
 * state is flushed first — otherwise the blur closure still holds the old
 * draft and the page would (correctly) skip the write.
 */
async function editField(tree, label, value) {
  let row = rowByLabel(tree, label)
  row.input.props.onFocus()
  row.input.props.onChange({ target: { value } })
  tree = await flush()
  row = rowByLabel(tree, label)
  row.input.props.onBlur()
  return flush()
}

// ---------------------------------------------------------------- fixtures
const BASE = {
  baseUrl: 'https://apihub.agnes-ai.com',
  credentialRef: 'AGNES_API_KEY',
  imageModel: 'agnes-image-2.5-flash',
  imageSize: '1K',
  videoModel: 'agnes-video-v2.0',
  videoSize: '720P',
  videoAspectRatio: '16:9',
  videoSeconds: '5',
  outputDir: '',
  imageTimeoutMs: 600000,
  pollIntervalMs: 10000,
  queueRetryMax: 3,
  queueRetryDelayMs: 15000,
}

function makeRemotePlane() {  const user = { imageModel: 'agnes-image-2.0-flash', imageSize: '2K' }
  const calls = []
  let revision = 7
  const view = () => ({
    autoGenerate: false,
    ns: 'agnes',
    schema: { type: 'object' },
    value: { ...BASE, ...user },
    base: { ...BASE },
    user: { ...user },
    applies: 'live',
    secrets: [],
    revision,
  })
  return {
    calls,
    async describe() {
      calls.push('describe')
      return { writable: true, hasDocument: true, namespaces: [view()] }
    },
    async mutate(ns, ops, expectedRevision) {
      calls.push({ op: 'mutate', ns, ops, expectedRevision })
      if (expectedRevision !== revision) throw new Error('settings/conflict: stale revision')
      for (const entry of ops) {
        if (entry.path.length !== 1) continue
        if (entry.op === 'set') user[entry.path[0]] = entry.value
        else delete user[entry.path[0]]
      }
      revision += 1
      return view()
    },
  }
}

function makeScopeBinder() {
  const user = { imageModel: 'agnes-image-2.0-flash' }
  const calls = []
  const scope = {
    getSnapshot: () => ({
      status: 'ready',
      writable: true,
      revision: 3,
      base: { ...BASE },
      user: { ...user },
      value: { ...BASE, ...user },
      secrets: [],
    }),
    subscribe: () => () => {},
    async set(key, value) {
      calls.push({ op: 'set', key, value })
      user[key] = value
    },
    async unset(key) {
      calls.push({ op: 'unset', key })
      delete user[key]
    },
    async load() {},
  }
  return { calls, binder: { bind: () => scope } }
}

/**
 * The plugin's own host route, faked at the `fetch` boundary.
 *
 * This is the transport a host with no client-side settings plane uses, so the
 * check exercises it for real: same-origin GET/POST on the settings route plus
 * the credential route, including the revision the write must carry.
 */
function makeBridgeServer() {
  const user = { imageModel: 'agnes-image-2.0-flash' }
  const calls = []
  const credentials = new Map()
  let revision = 11
  const payload = () => ({ writable: true, hasDocument: true, namespaces: [{
    autoGenerate: false,
    ns: 'agnes',
    schema: { type: 'object' },
    value: { ...BASE, ...user },
    base: { ...BASE },
    user: { ...user },
    applies: 'live',
    secrets: [],
    revision,
  }] })
  const json = (body, status = 200) => ({
    ok: status >= 200 && status < 300,
    status,
    async json() {
      return body
    },
  })
  const fetchImpl = async (url, init = {}) => {
    const method = String(init.method ?? 'GET').toUpperCase()
    calls.push({ url: String(url), method, body: init.body ? JSON.parse(init.body) : undefined })
    if (String(url).startsWith('/api/dsh-agnes.settings')) {
      if (method === 'GET') return json(payload())
      const body = init.body ? JSON.parse(init.body) : {}
      if (body.revision !== revision) return json({ code: 'settings/conflict', error: 'stale revision' }, 409)
      for (const op of body.ops ?? []) {
        if (op.op === 'set') user[op.path[0]] = op.value
        else delete user[op.path[0]]
      }
      revision += 1
      return json(payload())
    }
    if (String(url).startsWith('/api/dsh-agnes.credential')) {
      if (method === 'GET') {
        const ref = new URL(`http://local${url}`).searchParams.get('ref')
        return json({ ref, configured: credentials.has(ref) })
      }
      const body = init.body ? JSON.parse(init.body) : {}
      credentials.set(body.ref, body.value)
      return json({ ref: body.ref, configured: true })
    }
    return json({ code: 'not-found', error: `no route for ${url}` }, 404)
  }
  return { calls, credentials, fetchImpl, settingsUser: user }
}

// ------------------------------------------------------------- module table
let captured = null
globalThis.window = {
  __ModuleLoader__: {
    load(registration) {
      captured = registration
    },
  },
}

await import(`${pathToFileURL(pluginPath).href}?t=${Date.now()}`)
if (captured === null || captured.id !== 'dsh-agnes') throw new Error('client bundle did not register id dsh-agnes')
const client = captured.factory((specifier) => {
  if (specifier === 'react') return React
  if (specifier === '@deepseek-ai/dsh-client-ui-primitives') return primitives
  throw new Error(`unexpected client require: ${specifier}`)
})

let root = null
let slotsRegistration = null
client.apply({
  get(name) {
    if (name !== 'slots') return undefined
    return {
      inject(_seat, register) {
        register()
      },
      register(meta, component) {
        slotsRegistration = { meta, component }
        return () => {}
      },
    }
  },
})

console.log('client half')
console.log('  inject        :', JSON.stringify(client.inject))
console.log('  registration  :', JSON.stringify(slotsRegistration.meta))
if (slotsRegistration.meta.id !== 'agnes' || slotsRegistration.meta.name !== 'settings.section') {
  throw new Error('unexpected settings.section registration')
}

// ------------------------------------------------ case 1: remote plane (0.2.x)
console.log('\ncase 1: dsh 0.2.x remote.settings plane')
const plane = makeRemotePlane()
instances.clear()
root = React.createElement(slotsRegistration.component, { ctx: { get: (name) => (name === 'remote' ? { settings: plane } : undefined) } })
let tree = await flush()

let row = rowByLabel(tree, '默认图片模型')
if (row.input.props.value !== 'agnes-image-2.0-flash') throw new Error(`user layer did not win: ${row.input.props.value}`)
if (rowByLabel(tree, '默认尺寸').input.props.value !== '2K') throw new Error('overridden value not rendered')
if (rowByLabel(tree, 'API Base URL').input.props.value !== BASE.baseUrl) throw new Error('base layer not rendered')
if (collectText(tree).includes('设置命名空间绑定失败')) throw new Error('page reported a bind failure on the remote plane')
console.log('  layered snapshot (base < user) and bind: ok')

tree = await editField(tree, '默认图片模型', 'agnes-image-2.5-flash')
const setCall = plane.calls.find((entry) => entry && entry.op === 'mutate' && entry.ops[0].op === 'set')
if (!setCall) throw new Error(`no set write reached the plane: ${JSON.stringify(plane.calls)}`)
if (setCall.ops[0].path[0] !== 'imageModel' || setCall.ops[0].value !== 'agnes-image-2.5-flash') {
  throw new Error(`wrong write: ${JSON.stringify(setCall)}`)
}
if (setCall.expectedRevision !== 7) throw new Error(`write did not carry the read revision: ${setCall.expectedRevision}`)
if (rowByLabel(tree, '默认图片模型').input.props.value !== 'agnes-image-2.5-flash') {
  throw new Error('page did not adopt the written value')
}
console.log('  set through the plane: ok (revision honoured)')

row = rowByLabel(tree, '默认尺寸')
const pill = nodeWithText(row.tail, '已改 · 重置')
if (!pill || typeof pill.props.onClick !== 'function') throw new Error('override pill missing')
pill.props.onClick()
tree = await flush()
const unsetCall = plane.calls.find((entry) => entry && entry.op === 'mutate' && entry.ops[0].op === 'unset')
if (!unsetCall) throw new Error('no unset write reached the plane')
if (unsetCall.ops[0].path[0] !== 'imageSize') throw new Error(`wrong unset: ${JSON.stringify(unsetCall)}`)
if (rowByLabel(tree, '默认尺寸').input.props.value !== '1K') throw new Error('reset did not fall back to the schema default')
console.log('  unset through the plane: ok (falls back to the schema default)')

// ------------------------------------------ case 2: namespace not registered
console.log('\ncase 2: settings plane without an agnes namespace')
instances.clear()
root = React.createElement(slotsRegistration.component, {
  ctx: {
    get: (name) =>
      name === 'remote' ? { settings: { describe: async () => ({ writable: true, namespaces: [] }), mutate: async () => ({}) } } : undefined,
  },
})
tree = await flush()
if (!collectText(tree).includes('宿主的设置平面里没有')) throw new Error('missing-namespace notice was not rendered')
console.log('  actionable notice: ok')

// --------------------------------------- case 3: legacy settingsScope binder
console.log('\ncase 3: dsh 0.1.x settingsScope binder')
const legacy = makeScopeBinder()
instances.clear()
root = React.createElement(slotsRegistration.component, { ctx: { get: (name) => (name === 'settingsScope' ? legacy.binder : undefined) } })
tree = await flush()
if (collectText(tree).includes('设置命名空间绑定失败')) throw new Error('legacy binder path reported a bind failure')
if (rowByLabel(tree, '默认图片模型').input.props.value !== 'agnes-image-2.0-flash') {
  throw new Error('legacy snapshot not rendered')
}
tree = await editField(tree, '默认图片模型', 'agnes-image-2.1-flash')
if (!legacy.calls.some((entry) => entry.op === 'set' && entry.key === 'imageModel')) {
  throw new Error(`legacy binder got no write: ${JSON.stringify(legacy.calls)}`)
}
console.log('  read + write through the binder: ok')

// -------------------------- case 4: a render crash must not blank the page
// The shell abdicates (retires) a slot entry whose render throws, which shows
// the user NOTHING. The page's own boundary has to catch it first and say so.
console.log('\ncase 4: render crash is reported instead of retiring the entry')
const crashPlane = makeRemotePlane()
const originalDescribe = crashPlane.describe.bind(crashPlane)
crashPlane.describe = async () => {
  const described = await originalDescribe()
  described.namespaces[0].value = { ...described.namespaces[0].value, imageModel: BOOM }
  described.namespaces[0].user = { ...described.namespaces[0].user, imageModel: BOOM }
  return described
}
instances.clear()
root = React.createElement(slotsRegistration.component, { ctx: { get: (name) => (name === 'remote' ? { settings: crashPlane } : undefined) } })
tree = await flush()
const crashText = collectText(tree)
if (!crashText.includes('Agnes 设置页渲染失败')) throw new Error('the page boundary did not catch the crash')
if (!crashText.includes('boom: injected render failure')) throw new Error(`the boundary hid the cause: ${crashText}`)
console.log('  boundary message: ok')

// ------------------------------- case 5: no client plane, the host route only
// dsh 0.2.0-rc.2's web client answers NEITHER settingsScope NOR remote.settings
// for a plugin context — the case this whole route exists for.
console.log('\ncase 5: host route only (no client-side settings plane)')
const bridge = makeBridgeServer()
const originalFetch = globalThis.fetch
globalThis.fetch = bridge.fetchImpl
try {
  instances.clear()
  root = React.createElement(slotsRegistration.component, { ctx: { get: () => undefined } })
  tree = await flush()
  if (collectText(tree).includes('设置命名空间绑定失败')) {
    throw new Error(`bridge transport did not bind: ${collectText(tree)}`)
  }
  if (rowByLabel(tree, '默认图片模型').input.props.value !== 'agnes-image-2.0-flash') {
    throw new Error('bridge snapshot did not render the user layer')
  }
  console.log('  GET /api/dsh-agnes.settings: bound, layered values rendered')

  tree = await editField(tree, '默认图片模型', 'agnes-image-2.1-flash')
  const write = bridge.calls.find((entry) => entry.method === 'POST' && entry.url.startsWith('/api/dsh-agnes.settings'))
  if (!write) throw new Error(`no settings write reached the route: ${JSON.stringify(bridge.calls)}`)
  if (write.body.ops[0].path[0] !== 'imageModel' || write.body.ops[0].value !== 'agnes-image-2.1-flash') {
    throw new Error(`wrong write: ${JSON.stringify(write.body)}`)
  }
  if (write.body.revision !== 11) throw new Error(`write did not carry the read revision: ${write.body.revision}`)
  if (bridge.settingsUser.imageModel !== 'agnes-image-2.1-flash') throw new Error('the route did not apply the write')
  if (rowByLabel(tree, '默认图片模型').input.props.value !== 'agnes-image-2.1-flash') {
    throw new Error('page did not adopt the routed value')
  }
  console.log('  POST /api/dsh-agnes.settings: write applied with revision')

  // The credential row must reach the host even without remote.credentials.
  let password = null
  walk(tree, (node) => {
    if (password === null && node.props && node.props.type === 'password') password = node
  })
  if (password === null) throw new Error('API key input missing')
  password.props.onChange({ target: { value: 'cpk-test-key' } })
  tree = await flush()
  let saveButton = null
  walk(tree, (node) => {
    if (saveButton === null && node.props && node.props.children === '保存' && typeof node.props.onClick === 'function') saveButton = node
  })
  if (saveButton === null) throw new Error('save button missing')
  saveButton.props.onClick()
  tree = await flush()
  if (bridge.credentials.get('AGNES_API_KEY') !== 'cpk-test-key') {
    throw new Error(`credential did not reach the route: ${JSON.stringify([...bridge.credentials])}`)
  }
  if (!collectText(tree).includes('已写入凭据存储')) throw new Error('credential status not reported')
  console.log('  POST /api/dsh-agnes.credential: key stored, status reported')
} finally {
  globalThis.fetch = originalFetch
}

// ---------------------- case 6: an unregistered route must not read as "no ns"
// The SPA fallback answers unknown paths with index.html and 200; treating that
// as a successful empty describe reported "no agnes namespace" while the real
// fault was a route that never got registered.
console.log('\ncase 6: HTML-200 fallback is reported as a transport failure')
globalThis.fetch = async () => ({
  ok: true,
  status: 200,
  async json() {
    throw new SyntaxError('Unexpected token < in JSON at position 0')
  },
})
try {
  instances.clear()
  root = React.createElement(slotsRegistration.component, { ctx: { get: () => undefined } })
  tree = await flush()
  // The page retries the transport chain for ~5s before giving up, so give the
  // retry window real time instead of asserting on the first paint.
  for (let round = 0; round < 30 && !collectText(tree).includes('设置命名空间绑定失败'); round += 1) {
    await new Promise((resolve) => setTimeout(resolve, 300))
    tree = await flush()
  }
  const text = collectText(tree)
  if (text.includes('宿主的设置平面里没有')) throw new Error('an unregistered route was reported as a missing namespace')
  if (!text.includes('设置命名空间绑定失败')) throw new Error(`expected a transport failure notice, got: ${text}`)
} finally {
  globalThis.fetch = originalFetch
}
console.log('  transport failure reported: ok')

console.log('\nClient-page check passed.')
process.exit(0)
