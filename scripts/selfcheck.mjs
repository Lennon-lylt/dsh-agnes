/**
 * Pre-flight check: proves both halves load and register without booting DSH.
 *
 * This is the check that must pass BEFORE a profile install, because a host row
 * that throws on import or a client bundle that fails to parse turns a plugin
 * install into a deployment incident.
 *
 * The host half is exercised against BOTH settings shapes it claims to support,
 * because the settings namespace is where this plugin was burned once already:
 * dsh 0.2.x derives the namespace from the exported Config schema and owns it
 * through `describe`/`configure`, while 0.1.x needed an explicit `register()`.
 * The settings PAGE, however, is served from this plugin's own config file, so
 * the route assertions below run against a throwaway DSH_HOME.
 *
 * It needs node_modules resolution for @deepseek-ai/schemastery; in a dev
 * checkout that means a junction to the harness node_modules:
 *
 *   cmd /c mklink /J dsh-agnes\node_modules "<DSH_HOME>\profiles\node_modules"
 */
import path from 'node:path'
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const pkgRoot = path.join(here, '..')
const load = (relative) => import(pathToFileURL(path.join(pkgRoot, relative)).href)

// The plugin's configuration store is a file under DSH_HOME, so the check runs
// against a temporary home: it writes real files, and must never touch the
// deployment's own storage.
const originalDshHome = process.env.DSH_HOME
const scratchHome = await mkdtemp(path.join(tmpdir(), 'agnes-selfcheck-'))
process.env.DSH_HOME = scratchHome
const configFile = path.join(scratchHome, 'storages', 'agnes', 'config.json')
const keyFile = path.join(scratchHome, 'storages', 'agnes', 'api-key')
const defaultImageModel = 'agnes-image-2.5-flash'

// ---------------------------------------------------------------- host half
const host = await load('lib/index.js')
if (typeof host.apply !== 'function') throw new Error('host half does not export apply()')
if (host.name !== 'agnes') throw new Error(`host half name is ${host.name}, expected agnes`)

/**
 * One host stub in the shape a real deployment publishes.
 *
 * `settings` is the whole variable: 0.2.x publishes `configure`/`describe` and
 * no `register`, 0.1.x published `register`/`get`.
 */
function makeHostStub(kind) {
  const tools = []
  const effects = []
  const namespaces = []
  const policies = []
  const routes = []
  const writes = []
  const providers = []
  const credentials = {
    secrets: new Map(),
    async describe(ref) {
      return { ref, configured: this.secrets.has(ref) }
    },
    async resolve(ref) {
      return this.secrets.get(ref)
    },
    async set(ref, value) {
      this.secrets.set(ref, value)
    },
  }
  /** The route carrier a real host composes after this row applies. */
  const connection = {
    fetch: {
      register(route) {
        routes.push(route)
        return () => {}
      },
    },
  }
  const described = [{ ns: 'agnes', revision: 4, value: { imageModel: 'agnes-image-2.5-flash' }, base: {}, user: {} }]
  const settings =
    kind === 'legacy'
      ? {
          register(ns, schema) {
            namespaces.push({ ns, kind: typeof schema })
            return {}
          },
          get: () => ({}),
        }
      : {
          configure(presentation, owner) {
            policies.push({ presentation, owner })
            return () => {}
          },
          describe: () => described,
          update: async (ns, patch, revision) => {
            writes.push({ op: 'update', ns, patch, revision })
          },
          mutate: async (ns, ops, revision) => {
            writes.push({ op: 'mutate', ns, ops, revision })
          },
        }
  const ctx = {
    // The row's fiber: what a page policy must be owned by.
    fiber: { entry: `${kind}:agnes` },
    get(name) {
      if (name === 'tools') {
        return {
          register(definition) {
            tools.push({
              name: definition.name,
              hasExecute: typeof definition.execute === 'function',
              hasRender: typeof definition.output?.render === 'function',
              timeoutMs: definition.timeoutMs,
              requiredArgs: definition.parameters?.required ?? [],
            })
            return () => {}
          },
        }
      }
      if (name === 'settings') return settings
      // `credentials` is deliberately NOT resolvable here either: a real host
      // composes it after the row applies, so the api-key mirror must ride the
      // nested inject. Reverting to ctx.get() leaves the skill's CLI with no key.
      // The skill registry: the plugin must publish exactly one bundled skill.
      if (name === 'skills') {
        return {
          registerProvider(create) {
            providers.push(create())
            return () => {}
          },
        }
      }
      // `connection` is deliberately NOT resolvable here: a real host composes it
      // AFTER the row applies, so the bridge must be registered through the
      // nested inject (see installSettingsBridge). Reverting to ctx.get() makes
      // the route assertions below fail.
      return undefined
    },
    effect(callback) {
      const dispose = callback()
      effects.push(dispose)
      return () => {}
    },
    inject(services, callback) {
      if (!Array.isArray(services)) return
      if (services.indexOf('connection') !== -1) {
        callback({
          get: (name) => (name === 'connection' ? connection : undefined),
          connection,
          effect(callback2) {
            const dispose = callback2()
            effects.push(dispose)
            return () => {}
          },
        })
        return
      }
      if (services.indexOf('credentials') !== -1) {
        callback({
          get: (name) => (name === 'credentials' ? credentials : undefined),
          credentials,
          effect(callback2) {
            const dispose = callback2()
            effects.push(dispose)
            return () => {}
          },
        })
        return
      }
      if (services.indexOf('settings') === -1) return
      callback({
        settings,
        effect(callback2) {
          const dispose = callback2()
          effects.push(dispose)
          return () => {}
        },
      })
    },
  }
  return { ctx, tools, effects, namespaces, policies, routes, writes, providers, credentials }
}

// The exported Config schema is what a settings namespace is derived from, on
// both host generations: 0.2.x reads it directly, 0.1.x was handed it through
// register(). A checkout without schemastery can therefore exercise the page
// policy but not the registration.
const schemaAvailable = host.Config !== undefined

const preseededKey = 'cpk-selfcheck-preseeded'
for (const kind of ['modern', 'legacy']) {
  const stub = makeHostStub(kind)
  if (kind === 'modern') stub.credentials.secrets.set('AGNES_API_KEY', preseededKey)
  await host.apply(stub.ctx)
  if (kind === 'modern') {
    // The mirror rides a nested inject, so it lands a task after apply returns.
    await new Promise((resolve) => setTimeout(resolve, 25))
    if ((await readFile(keyFile, 'utf8')).trim() !== preseededKey) {
      throw new Error('the api-key file was not mirrored from the credential store at apply time')
    }
    console.log('  key mirror    : refreshed from the credential store through the nested inject ok')
  }

  console.log(`host half (${kind} settings host):`)
  console.log('  name          :', host.name)
  console.log('  settings ns   :', stub.namespaces.map((entry) => entry.ns).join(', ') || '(none — host-derived)')
  console.log(
    '  page policy   :',
    stub.policies
      .map((entry) => `auto=${entry.presentation?.auto} owner=${entry.owner?.entry ?? '(none)'}`)
      .join(', ') || '(none)',
  )
  console.log('  tools         :', stub.tools.length === 0 ? '(none — the capability lives in the skill)' : stub.tools.map((entry) => entry.name).join(', '))
  console.log('  skill         :', stub.providers.length === 0 ? '(none)' : 'agnes (bundled SKILL.md)')

  // The capability is a skill, not model-facing tools: an accidental tool
  // registration would both bloat every model call and double the surface.
  if (stub.tools.length !== 0) throw new Error(`expected no tool registrations, got ${stub.tools.length}`)
  if (kind === 'modern') {
    const policy = stub.policies[0]
    if (policy === undefined) throw new Error('the 0.2.x settings page policy was not declared')
    if (policy.presentation?.auto !== false) throw new Error(`policy auto should be false, got ${JSON.stringify(policy.presentation)}`)
    if (policy.owner?.entry !== 'modern:agnes') {
      throw new Error(`the page policy must be owned by the row fiber, got ${JSON.stringify(policy.owner)}`)
    }

    // The bundled skill: one provider, whose candidate carries the CLI path
    // substituted into the SKILL.md body (no {{CLI}} placeholder left behind).
    if (stub.providers.length !== 1) throw new Error(`expected 1 skill provider, got ${stub.providers.length}`)
    const provider = stub.providers[0]
    const listed = await provider.list()
    if (listed.length !== 1 || listed[0].name !== 'agnes') throw new Error(`unexpected skill list: ${JSON.stringify(listed.map((entry) => entry.name))}`)
    const fetched = await provider.get({ name: 'agnes' })
    if (fetched === undefined || typeof fetched.content !== 'string') throw new Error('the skill provider returned no content')
    if (fetched.content.includes('{{CLI}}')) throw new Error('the {{CLI}} placeholder was not substituted')
    if (!fetched.content.includes(path.join('lib', 'cli.mjs'))) throw new Error('the skill body must name the CLI path')
    if (fetched.invocation?.modelInvocable !== true) throw new Error('the skill must be model-invocable')
    const resourceBase = String(fetched.resourceBase?.path ?? '').replace(/[\\/]+$/u, '')
    if (!resourceBase.endsWith(path.join('skills', 'agnes'))) {
      throw new Error(`unexpected skill resourceBase: ${JSON.stringify(fetched.resourceBase)}`)
    }
    // The settings page's transport, end to end, against the same route object
    // the host carrier would invoke — and against this plugin's own config file.
    console.log('  routes        :', stub.routes.map((route) => route.path).join(', ') || '(none)')
    if (stub.routes.length !== 2) throw new Error(`expected 2 settings routes, got ${stub.routes.length}`)
    const settingsRoute = stub.routes.find((route) => route.path.endsWith('.settings'))
    const origin = 'http://127.0.0.1/api/dsh-agnes.settings'
    const readView = async () =>
      (await settingsRoute.fetch(new Request(origin, { method: 'GET' }))).json()
    const post = (body) =>
      settingsRoute.fetch(
        new Request(origin, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        }),
      )

    const initial = await readView()
    const initialView = initial?.namespaces?.[0]
    if (initialView?.ns !== 'agnes') throw new Error(`route read did not report the namespace: ${JSON.stringify(initial)}`)
    if (initialView.revision !== 1) throw new Error(`unexpected initial revision: ${initialView.revision}`)
    if (initialView.user?.imageModel !== undefined) throw new Error('a fresh store must carry no user overrides')
    if (initialView.value?.imageModel !== defaultImageModel) throw new Error('the view must carry the defaults')
    if (!String(initial.documentPath).endsWith(path.join('storages', 'agnes', 'config.json'))) {
      throw new Error(`the view must name the plugin's own file: ${initial.documentPath}`)
    }

    const write = await post({ ops: [{ op: 'set', path: ['imageModel'], value: 'agnes-image-2.1-flash' }], revision: 1 })
    if (!write.ok) throw new Error(`route write was rejected: ${write.status}`)
    const stored = JSON.parse(await readFile(configFile, 'utf8'))
    if (stored.values?.imageModel !== 'agnes-image-2.1-flash' || stored.revision !== 2) {
      throw new Error(`the write did not land in the config file: ${JSON.stringify(stored)}`)
    }
    const afterWrite = (await readView()).namespaces[0]
    if (afterWrite.value.imageModel !== 'agnes-image-2.1-flash' || afterWrite.user.imageModel !== 'agnes-image-2.1-flash') {
      throw new Error(`the view did not adopt the write: ${JSON.stringify(afterWrite)}`)
    }

    const conflict = await post({ ops: [{ op: 'set', path: ['imageModel'], value: 'x' }], revision: 1 })
    if (conflict.status !== 409) throw new Error(`a stale revision was not refused: ${conflict.status}`)
    const unknown = await post({ ops: [{ op: 'set', path: ['nope'], value: 'x' }], revision: 2 })
    if (unknown.status !== 400) throw new Error(`an unknown field was not refused: ${unknown.status}`)
    const numeric = await post({ ops: [{ op: 'set', path: ['pollIntervalMs'], value: 'not-a-number' }], revision: 2 })
    if (numeric.status !== 400) throw new Error(`a non-numeric value was not refused: ${numeric.status}`)

    const unset = await post({ ops: [{ op: 'unset', path: ['imageModel'] }], revision: 2 })
    if (!unset.ok) throw new Error(`unset was rejected: ${unset.status}`)
    const afterUnset = (await readView()).namespaces[0]
    if (afterUnset.user.imageModel !== undefined || afterUnset.value.imageModel !== defaultImageModel) {
      throw new Error(`unset did not fall back to the default: ${JSON.stringify(afterUnset)}`)
    }

    // The route rides the authenticated same-origin /api fence, so it must NOT
    // filter by Host: an earlier allowlist rejected the settings page's OWN
    // requests (the harness builds the Request with a host that regex missed),
    // which is why the page kept falling back to a plane that cannot see this
    // row. Pin the real contract instead of pretending a header check exists.
    const otherHost = await settingsRoute.fetch(new Request('https://elsewhere.example/api/dsh-agnes.settings', { method: 'GET' }))
    if (!otherHost.ok) throw new Error(`the route must not depend on the Host header: ${otherHost.status}`)
    console.log('  route check   : file read + set/unset + conflict + validation + no Host filter ok')

    // The credential route, and the handoff the skill's CLI depends on: saving a
    // key must mirror it into the plugin's own 0600 api-key file.
    const credentialRoute = stub.routes.find((route) => route.path.endsWith('.credential'))
    if (credentialRoute === undefined) throw new Error('the credential route was not registered')
    const savedKey = 'cpk-selfcheck-not-a-real-key'
    const save = await credentialRoute.fetch(
      new Request('http://127.0.0.1/api/dsh-agnes.credential', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ref: 'AGNES_API_KEY', value: savedKey }),
      }),
    )
    if (!save.ok) throw new Error(`the credential route rejected the write: ${save.status}`)
    if ((await readFile(keyFile, 'utf8')).trim() !== savedKey) throw new Error('the api-key file was not mirrored')
    const readBack = await credentialRoute.fetch(new Request('http://127.0.0.1/api/dsh-agnes.credential?ref=AGNES_API_KEY', { method: 'GET' }))
    const credentialView = await readBack.json()
    if (credentialView.configured !== true) throw new Error(`the credential route does not report the saved key: ${JSON.stringify(credentialView)}`)
    console.log('  credential    : stored via the route and mirrored to <DSH_HOME>/storages/agnes/api-key ok')
  } else if (!schemaAvailable) {
    console.log('  note: schemastery is unavailable here, so register() cannot be exercised in this checkout')
  } else if (stub.namespaces.length !== 1 || stub.namespaces[0].ns !== 'agnes') {
    throw new Error(`legacy host did not register the agnes namespace: ${JSON.stringify(stub.namespaces)}`)
  }
  for (const dispose of stub.effects) {
    if (typeof dispose === 'function') dispose()
  }
  console.log('')
}

// The exported Config schema is what the namespace is derived from on 0.2.x.
if (host.Config === undefined) {
  if (process.env.AGNES_REQUIRE_SCHEMA === '1') {
    throw new Error('the exported Config schema is missing, so 0.2.x cannot derive the agnes namespace')
  }
  console.log('note: schemastery is not resolvable from this checkout, so the settings schema was skipped')
  console.log('      (install-time resolution comes from the profile node_modules tree)')
  const home = originalDshHome
  const candidates = home
    ? [
        path.join(home, 'profiles', 'node_modules', '@deepseek-ai', 'schemastery', 'lib', 'index.mjs'),
        path.join(home, 'profiles', 'node_modules', 'schemastery', 'lib', 'index.mjs'),
        path.join(home, 'profiles', 'web', 'node_modules', 'schemastery', 'lib', 'index.mjs'),
      ]
    : []
  for (const harnessSchema of candidates) {
    let z
    try {
      z = (await import(pathToFileURL(harnessSchema).href)).default
    } catch (error) {
      continue
    }
    const probe = z.object({
      s: z.string().default('fallback').description('a string knob'),
      n: z.number().default(7),
    })
    const resolved = probe({})
    if (resolved.s !== 'fallback' || resolved.n !== 7) {
      throw new Error(`schemastery defaults did not resolve as expected: ${JSON.stringify(resolved)}`)
    }
    console.log('  schema idioms: z.object/z.string().default().description() verified against', harnessSchema)
    break
  }
} else {
  const resolved = host.Config({})
  console.log('config schema defaults:', JSON.stringify(resolved))
}

// -------------------------------------------------------------- client half
const loaded = []
let clientExports
globalThis.window = {
  __ModuleLoader__: {
    load(registration) {
      loaded.push(registration.id)
      const React = {
        // The page's error boundary extends React.Component, so the stub needs a
        // constructor: without one the whole bundle throws at load time.
        Component: class Component {
          constructor(props) {
            this.props = props
          }
        },
        createElement: (...args) => ({ type: args[0], props: args[1] }),
        Fragment: 'Fragment',
        useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
        useEffect: () => {},
        useCallback: (fn) => fn,
        useRef: (initial) => ({ current: initial }),
      }
      clientExports = registration.factory((specifier) => {
        if (specifier === 'react') return React
        if (specifier === '@deepseek-ai/dsh-client-ui-primitives') {
          // Every primitive the page composes; the stub only has to exist,
          // because the page builds elements lazily at render time.
          const stub = (name) => (props) => ({ type: name, props })
          return {
            Button: stub('Button'),
            Input: stub('Input'),
            Pill: stub('Pill'),
            StateDot: stub('StateDot'),
            DisclosureRow: stub('DisclosureRow'),
            Tooltip: stub('Tooltip'),
          }
        }
        throw new Error(`unexpected client require: ${specifier}`)
      })
    },
  },
}

await load('lib/client.js')

console.log('\nclient half:')
console.log('  bundle id     :', loaded.join(', ') || '(nothing registered)')
console.log('  exports       :', clientExports ? Object.keys(clientExports).join(', ') : '(none)')
console.log('  inject        :', JSON.stringify(clientExports?.inject))
console.log('  name          :', clientExports?.name)

if (loaded.length !== 1 || loaded[0] !== 'dsh-agnes') throw new Error('client bundle did not register id dsh-agnes')
if (typeof clientExports?.apply !== 'function') throw new Error('client half does not export apply()')
for (const required of ['slots']) {
  if (!clientExports.inject.includes(required)) throw new Error(`client inject is missing ${required}`)
}
// Neither transport name may ride the module-level inject: naming a service a
// host does not publish keeps the whole module waiting for activation.
for (const optional of ['settingsScope', 'remote', 'remote.settings']) {
  if (clientExports.inject.includes(optional)) {
    throw new Error(`client inject must not hard-depend on ${optional} (resolve it lazily instead)`)
  }
}

// The client apply must tolerate a missing slots service instead of throwing.
await clientExports.apply({ get: () => undefined })
console.log('  apply with no slots: tolerated')

// ------------------------------------------------- CLI (the skill's executable)
// The whole point of the skill split: a plain Node process, no Cordis and no DSH
// context, must be able to read the settings + key file and land an artifact in
// the directory it runs in (the session workspace for an agent shell).
const cli = await load('lib/cli.mjs')
const runCwd = path.join(scratchHome, 'session-workspace')
await mkdir(runCwd, { recursive: true })

const calls = []
const pngBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4])
const fakeFetch = async (url, init = {}) => {
  calls.push({ url: String(url), method: init.method ?? 'GET', auth: init.headers?.Authorization })
  if (String(url).includes('/v1/images/generations')) {
    return new Response(JSON.stringify({ data: [{ url: 'https://cdn.example/img.png', b64_json: '' }], created: 1, task_id: 't1' }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  }
  if (String(url).includes('/v1/models')) {
    return new Response(JSON.stringify({ data: [{ id: 'agnes-image-2.5-flash' }, { id: 'agnes-video-v2.0' }] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  }
  if (String(url).includes('cdn.example')) return new Response(pngBytes, { status: 200 })
  return new Response('{}', { status: 404, headers: { 'content-type': 'application/json' } })
}

const cliOptions = { env: { ...process.env, DSH_HOME: scratchHome }, cwd: runCwd, fetchImpl: fakeFetch }
const imageRun = await cli.run(['image', '--prompt', 'a red circle', '--size', '2K'], cliOptions)
if (imageRun.exitCode !== 0 || imageRun.payload.ok !== true) {
  throw new Error(`CLI image failed: ${JSON.stringify(imageRun.payload)}`)
}
const landed = imageRun.payload.files?.[0]
const expectedDir = path.join(runCwd, 'agnes-output', new Date().toISOString().slice(0, 10))
if (!String(landed).startsWith(expectedDir)) throw new Error(`the CLI must land in the session workspace: ${landed}`)
if (!(await readFile(landed)).equals(pngBytes)) throw new Error('the landed bytes do not match the download')
if (imageRun.payload.keySource !== `file:${keyFile}`) throw new Error(`the CLI did not read the mirrored key file: ${imageRun.payload.keySource}`)
if (calls[0]?.auth !== 'Bearer cpk-selfcheck-not-a-real-key') throw new Error('the CLI did not authenticate with the mirrored key')
if (imageRun.payload.requestedSize !== '2K') throw new Error('the CLI ignored the --size flag')
console.log('\nCLI (skill body):')
console.log('  image         :', `landed ${path.relative(scratchHome, landed)} (${imageRun.payload.bytes} bytes, key from file)`)

const modelsRun = await cli.run(['models'], cliOptions)
if (modelsRun.payload.models?.length !== 2) throw new Error(`CLI models failed: ${JSON.stringify(modelsRun.payload)}`)
const configRun = await cli.run(['config'], cliOptions)
if (configRun.payload.keyConfigured !== true || configRun.payload.values?.imageModel !== defaultImageModel) {
  throw new Error(`CLI config failed: ${JSON.stringify(configRun.payload)}`)
}
const noKeyRun = await cli.run(['image', '--prompt', 'x'], { ...cliOptions, env: { DSH_HOME: path.join(scratchHome, 'empty-home') } })
if (noKeyRun.payload.ok !== false || noKeyRun.payload.kind !== 'auth') {
  throw new Error(`a missing key must fail as auth: ${JSON.stringify(noKeyRun.payload)}`)
}
const helpRun = await cli.run(['help'], cliOptions)
if (typeof helpRun.payload.usage !== 'string' || !helpRun.payload.usage.includes('image --prompt')) {
  throw new Error('the CLI help text is missing')
}
console.log('  models/config :', 'ok')
console.log('  missing key   :', 'reported as { ok: false, kind: "auth" }')
console.log('  help          :', 'ok')

// Leave the machine as it was found: the scratch home was this check's only
// footprint.
if (originalDshHome === undefined) delete process.env.DSH_HOME
else process.env.DSH_HOME = originalDshHome
await rm(scratchHome, { recursive: true, force: true })
console.log(`\nscratch home removed: ${scratchHome}`)
console.log('\nSelf-check passed.')
process.exit(0)
