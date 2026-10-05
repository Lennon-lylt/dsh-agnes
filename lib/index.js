/**
 * dsh-agnes host half.
 *
 * Owns, in this order of authority:
 *   - the `agnes` settings namespace (single source of truth for every knob),
 *   - the credential *reference* (never the secret value itself),
 *   - four model-facing tools: agnes_image / agnes_video / agnes_task / agnes_models,
 *   - a background poller plus a durable task record so a submitted video
 *     survives a process restart,
 *   - artifact landing on disk (a URL is never the deliverable: it can expire).
 *
 * Deliberately reads every Service through ctx.get() with an undefined check and
 * declares no `inject`: a missing optional capability must degrade one feature,
 * not leave the whole row permanently waiting.
 */

import { mkdir, readFile, writeFile, rename } from 'node:fs/promises'
import { readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// The schema library is resolved dynamically on purpose: a resolution failure
// in a given composition must degrade to the built-in defaults, never stop the
// row from applying (a row that throws on import takes the whole plugin down).
// The scoped specifier is the harness' own name for it everywhere else in the
// plugin ecosystem (dshmarket imports exactly this one); the unscoped name is
// the second chance, because a profile tree that carries schemastery under its
// published name resolves either way.
let z
try {
  z = (await import('@deepseek-ai/schemastery')).default
} catch (error) {
  try {
    z = (await import('schemastery')).default
  } catch (fallbackError) {
    console.warn(
      `[agnes] schemastery unavailable, so no settings namespace can be derived: ${error?.message ?? error}`,
    )
    z = undefined
  }
}

export const name = 'agnes'

/**
 * Same-origin routes the settings page reads and writes through.
 *
 * A client half cannot reach the settings plane by service name on every host:
 * on dsh 0.2.0-rc.2's web client neither `settingsScope` nor `remote.settings`
 * answers a plugin's context, so the page talks to THIS half instead — the same
 * same-origin route pattern the shipped image-generation plugin uses. The write
 * itself still goes through the documented Host service (`settings.mutate` /
 * `update`), so the profile patch stays the single source of truth.
 */
const SETTINGS_ROUTE = '/api/dsh-agnes.settings'
const CREDENTIAL_ROUTE = '/api/dsh-agnes.credential'

/** Loopback gate: these routes mutate configuration, so keep them local. */
/**
 * Why there is NO Host/loopback allowlist on these routes.
 *
 * They ride `ctx.connection.fetch.register`, i.e. the same authenticated,
 * same-origin `/api` fence every shipped plugin API uses (the image-generation
 * plugin's `/api/image-generation.*` routes carry no allowlist either). An
 * earlier revision added one and it was actively wrong: the harness builds the
 * handler's Request with a host the regex did not recognise, so EVERY request —
 * including the settings page's own — came back `403 loopback-only`, and the
 * page had to fall back to a settings plane that cannot see this row. The fence
 * is the boundary; the plugin's own field validation, revision check, and atomic
 * write are what protect the file.
 */
function jsonResponse(payload, status = 200) {
  let body
  try {
    body = JSON.stringify(payload)
  } catch (error) {
    status = 500
    body = JSON.stringify({ code: 'unserializable', error: `settings view is not JSON: ${error?.message ?? error}` })
  }
  return new Response(body, {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  })
}

/** Defaults mirror the schema below; the schema is what the settings UI documents. */
const DEFAULTS = {
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

/**
 * The plugin-owned configuration file — the settings page's real store.
 *
 * The DSH settings plane is not a dependable transport here (on dsh 0.2.0-rc.2
 * its Web client publishes no settings service to a plugin, and the Host-side
 * namespace is a *derived* view that only exists while the row's Config schema
 * is live and volatile). A plugin that hands its knobs to that plane inherits
 * every one of those conditions. This file does not: the page writes it over the
 * plugin's own loopback route, the tools read it synchronously, and the DSH
 * settings namespace — when a deployment does compose one — stays a lower
 * priority layer rather than the source of truth.
 *
 * Shape: `{ version: 1, revision: <int>, values: { <field>: <value> } }`.
 */
const CONFIG_FILE = 'config.json'

function configPath() {
  return path.join(dshHome(), 'storages', 'agnes', CONFIG_FILE)
}

/** Normalize a parsed file, dropping anything the plugin does not know. */
function normalizeConfigStore(parsed) {
  const values = {}
  if (parsed !== null && typeof parsed === 'object') {
    const raw = parsed.values !== null && typeof parsed.values === 'object' ? parsed.values : parsed
    for (const [key, value] of Object.entries(raw)) {
      if (!Object.hasOwn(DEFAULTS, key)) continue
      if (typeof DEFAULTS[key] === 'number') {
        const numeric = typeof value === 'number' ? value : Number(value)
        if (Number.isFinite(numeric)) values[key] = numeric
      } else if (typeof value === 'string') {
        values[key] = value
      }
    }
  }
  const revision =
    parsed !== null && typeof parsed === 'object' && Number.isSafeInteger(parsed.revision) && parsed.revision > 0
      ? parsed.revision
      : 1
  return { revision, values }
}

let configStore = { revision: 1, values: {}, mtimeMs: -1 }

/**
 * Re-read the file when its mtime moved.
 *
 * `config()` is synchronous (the tools build their client from it), so the cache
 * is refreshed by mtime instead of by an await: a hand-edited file is picked up
 * on the next tool call, and the page's own writes update the cache directly.
 */
function refreshConfigStore() {
  const file = configPath()
  try {
    const info = statSync(file)
    if (info.mtimeMs === configStore.mtimeMs) return configStore
    const normalized = normalizeConfigStore(JSON.parse(readFileSync(file, 'utf8')))
    configStore = { ...normalized, mtimeMs: info.mtimeMs }
  } catch (error) {
    // A missing file is the normal state before the first save.
  }
  return configStore
}

/** Persist `next`, refusing a write that read an older revision. */
async function writeConfigValues(next, expectedRevision) {
  const current = refreshConfigStore()
  if (expectedRevision !== undefined && expectedRevision !== current.revision) {
    throw new Error(`stale revision: the page read ${expectedRevision}, the file is at ${current.revision}`)
  }
  const revision = current.revision + 1
  const file = configPath()
  await mkdir(path.dirname(file), { recursive: true })
  const temporary = `${file}.${process.pid}.${Date.now()}.tmp`
  await writeFile(temporary, `${JSON.stringify({ version: 1, revision, values: next }, null, 2)}\n`, 'utf8')
  await rename(temporary, file)
  let mtimeMs = -1
  try {
    mtimeMs = statSync(file).mtimeMs
  } catch (error) {
    mtimeMs = Date.now()
  }
  configStore = { revision, values: next, mtimeMs }
  return configStore
}

const Config = z
  ? z.object({
      baseUrl: z.string().default(DEFAULTS.baseUrl).description('Agnes API base URL.'),
      credentialRef: z.string().default(DEFAULTS.credentialRef).description('Credential reference name holding the API key.'),
      imageModel: z.string().default(DEFAULTS.imageModel).description('Default image model.'),
      imageSize: z.string().default(DEFAULTS.imageSize).description('Default image size: 1K / 2K / 3K / 4K or a pixel pair.'),
      videoModel: z.string().default(DEFAULTS.videoModel).description('Default video model.'),
      videoSize: z.string().default(DEFAULTS.videoSize).description('Default video size tier (server snaps to the nearest preset).'),
      videoAspectRatio: z.string().default(DEFAULTS.videoAspectRatio).description('Default video aspect ratio.'),
      videoSeconds: z.string().default(DEFAULTS.videoSeconds).description('Default video length in seconds.'),
      outputDir: z.string().default(DEFAULTS.outputDir).description('Artifact root. Empty = <session workspace>/agnes-output, else <DSH_HOME>/agnes-output.'),
      imageTimeoutMs: z.number().default(DEFAULTS.imageTimeoutMs).description('Image request budget in ms.'),
      pollIntervalMs: z.number().default(DEFAULTS.pollIntervalMs).description('Background video poll interval in ms.'),
      queueRetryMax: z.number().default(DEFAULTS.queueRetryMax).description('Retries when the video queue reports full.'),
      queueRetryDelayMs: z.number().default(DEFAULTS.queueRetryDelayMs).description('Delay between queue-full retries in ms.'),
    })
  : undefined

export { Config }

function dshHome() {
  return process.env.DSH_HOME || path.join(homedir(), '.dsh')
}

export async function apply(ctx, rowConfig) {
  const log = (message) => console.log(`[agnes] ${message}`)
  const warn = (message) => console.warn(`[agnes] ${message}`)

  /**
   * The credentials service, captured when it composes.
   *
   * `ctx.get('credentials')` is undefined for the whole apply() call (the service
   * lands later), so both the route handlers and the key-file mirror read this
   * capture first and only fall back to a live lookup.
   */
  let credentialsService

  // dsh 0.2.x removed `settings.register`: a settings namespace is derived from
  // the plugin's exported Config schema — keyed by this row's own id, `agnes` —
  // and the resolved values arrive as this row's config, the second apply()
  // argument. Older hosts still need the explicit registration, so it is
  // attempted only while `register` exists; a host without it is a supported
  // shape, not a failure to warn about on every settings read. Registration is
  // still retried when the service has not been provided yet: row order inside
  // a bundle layer is not a dependency order.
  let settingsState = 'pending'
  let settingsPageState = 'pending'

  /**
   * Declare this instance's page policy (dsh 0.2.x).
   *
   * This plugin ships its own page, so the documented policy is
   * `configure({ auto: false }, ctx.fiber)`. The owner has to be passed
   * explicitly: the service defaults it to its OWN context's fiber, which would
   * attach the policy to the Settings plugin instead of this row. The call
   * rides an `inject(['settings'], …)` child so a host without the Settings
   * service still applies the whole row, and the effect hands the returned
   * disposer back to cordis. The policy governs page generation only — it never
   * removes the namespace from `settings.describe()`, so the settings page of
   * this plugin keeps its reads and writes either way.
   */
  function declareSettingsPage() {
    if (settingsPageState !== 'pending' || typeof ctx.inject !== 'function') return
    const owner = ctx.fiber
    if (owner === undefined) return
    settingsPageState = 'declared'
    ctx.inject(['settings'], (child) => {
      try {
        child.effect(() => child.settings.configure({ auto: false }, owner), 'agnes: settings page policy')
        log('settings page policy declared for the agnes row (auto: false: this plugin draws its own page)')
      } catch (error) {
        warn(`settings page policy not declared: ${error?.message ?? error}`)
      }
    })
  }

  function ensureSettingsNamespace() {
    if (settingsState !== 'pending') return
    const settings = ctx.get('settings')
    if (settings === undefined || Config === undefined) return
    if (typeof settings.register !== 'function') {
      settingsState = 'host-derived'
      log('host derives the "agnes" namespace from the exported Config schema; no register() to call')
      return
    }
    try {
      settings.register('agnes', Config)
      settingsState = 'registered'
      log('settings namespace "agnes" registered')
    } catch (error) {
      settingsState = 'failed'
      warn(`settings namespace registration failed: ${error?.message ?? error}`)
    }
  }

  // The page policy does not wait for the service: `ctx.inject` is what waits.
  declareSettingsPage()
  ensureSettingsNamespace()
  if (settingsState === 'pending') {
    let attempts = 0
    const retry = setInterval(() => {
      ensureSettingsNamespace()
      attempts += 1
      if (settingsState !== 'pending' || attempts > 30) clearInterval(retry)
    }, 1000)
    ctx.effect(() => () => clearInterval(retry), 'agnes: settings registration retry')
  }

  /**
   * Serve the settings page's transport over same-origin HTTP.
   *
   * Why a route and not the client's own service lookup: on this host's web
   * client the settings plane is not published to a plugin's context at all
   * (`settingsScope` and `remote.settings` both answer undefined), while the
   * HOST service that owns the namespace is right here. The page therefore asks
   * this half; every write still runs through `settings.mutate`/`update`, so the
   * settings document stays authoritative and the row's live config stays the
   * only thing the tools read.
   */
  function installSettingsBridge() {
    if (typeof ctx.inject !== 'function') {
      warn('ctx.inject is unavailable; the settings page keeps its client-side transports only')
      return
    }
    // `connection` composes AFTER a profile row applies — the same load-order
    // contract dsh-context documents — so `ctx.get('connection')` at apply time
    // is always undefined. The route therefore rides a nested inject: waiting
    // cannot block this row, and the registration lands on the injected fiber so
    // it is withdrawn with the service.
    ctx.inject(['connection'], (scoped) => {
      let connection
      try {
        connection = typeof scoped.get === 'function' ? scoped.get('connection') : undefined
      } catch (error) {
        connection = undefined
      }
      if (connection === undefined || connection === null) {
        try {
          connection = scoped.connection
        } catch (error) {
          connection = undefined
        }
      }
      const fetchApi = connection === undefined || connection === null ? undefined : connection.fetch
      if (fetchApi === undefined || typeof fetchApi.register !== 'function') {
        warn('connection.fetch.register is unavailable; the settings page keeps its client-side transports only')
        return
      }
      const register = fetchApi.register.bind(fetchApi)

      /**
       * The namespace view the page renders, built from the plugin's own file.
       *
       * Deliberately independent of the DSH settings service: `base` is the
       * plugin defaults and `user` is what the file overrides — exactly the
       * layering the page already draws, and what its "已改 · 重置" pill keys on.
       */
      const settingsView = () => {
        const store = refreshConfigStore()
        return {
          writable: true,
          hasDocument: true,
          store: 'file',
          documentPath: configPath(),
          known: ['agnes'],
          namespaces: [
            {
              autoGenerate: false,
              ns: 'agnes',
              schema: {},
              value: { ...DEFAULTS, ...store.values },
              base: { ...DEFAULTS },
              user: { ...store.values },
              applies: 'live',
              secrets: [],
              revision: store.revision,
            },
          ],
        }
      }

      /** One validated edit against the plugin's own field set. */
      const applySettingOp = (values, op) => {
        if (op === null || typeof op !== 'object' || !Array.isArray(op.path) || op.path.length !== 1) {
          throw new Error('only top-level field paths are supported')
        }
        const key = op.path[0]
        if (typeof key !== 'string' || !Object.hasOwn(DEFAULTS, key)) throw new Error(`unknown setting "${String(key)}"`)
        if (op.op === 'unset') {
          delete values[key]
          return
        }
        if (op.op !== 'set') throw new Error(`unsupported op "${String(op.op)}"`)
        if (typeof DEFAULTS[key] === 'number') {
          const numeric = typeof op.value === 'number' ? op.value : Number(op.value)
          if (!Number.isFinite(numeric)) throw new Error(`"${key}" needs a number`)
          values[key] = numeric
          return
        }
        values[key] = typeof op.value === 'string' ? op.value : String(op.value ?? '')
      }

      const readJsonBody = async (request) => {
        const text = await request.text()
        if (text.length > 65536) throw new Error('request body is too large')
        if (text.trim() === '') return {}
        return JSON.parse(text)
      }

      const registrations = []
      try {
        registrations.push(
          register({
            path: SETTINGS_ROUTE,
            methods: ['GET', 'POST'],
            requestBody: 'buffered',
            fetch: async (request) => {
              const method = String(request.method ?? 'GET').toUpperCase()
              log(`settings route: ${method}`)
              try {
                if (method === 'GET') return jsonResponse(settingsView())
                const body = await readJsonBody(request)
                const revision = typeof body.revision === 'number' ? body.revision : undefined
                const next = { ...refreshConfigStore().values }
                const opCount = Array.isArray(body.ops) ? body.ops.length : body.patch !== null && typeof body.patch === 'object' ? Object.keys(body.patch).length : 0
                if (Array.isArray(body.ops) && body.ops.length > 0) {
                  for (const op of body.ops) applySettingOp(next, op)
                } else if (body.patch !== null && typeof body.patch === 'object') {
                  for (const [key, value] of Object.entries(body.patch)) applySettingOp(next, { op: 'set', path: [key], value })
                } else {
                  log('settings route: rejected, expected { ops } or { patch }')
                  return jsonResponse({ code: 'bad-request', error: 'expected { ops: [...] } or { patch: {...} }' }, 400)
                }
                await writeConfigValues(next, revision)
                log(`settings route: applied ${opCount} op(s), now revision ${String(refreshConfigStore().revision)}`)
                return jsonResponse(settingsView())
              } catch (error) {
              const message = error?.message ?? String(error)
              const conflict = /revision|conflict/iu.test(message)
              return jsonResponse({ code: conflict ? 'settings/conflict' : 'settings/rejected', error: message }, conflict ? 409 : 400)
            }
          },
        }),
        register({
          path: CREDENTIAL_ROUTE,
          methods: ['GET', 'POST'],
          requestBody: 'buffered',
          fetch: async (request) => {
            const method = String(request.method ?? 'GET').toUpperCase()
            log(`credential route: ${method}`)
            try {
              const credentials = credentialsService ?? ctx.get('credentials')
              if (credentials === undefined) {
                log('credential route: no credentials service on this host')
                return jsonResponse({ code: 'credentials-unavailable', error: 'this host has no credentials service' }, 503)
              }
              if (method === 'GET') {
                const ref = new URL(request.url).searchParams.get('ref') ?? DEFAULTS.credentialRef
                let configured = null
                try {
                  const info = typeof credentials.describe === 'function' ? await credentials.describe(ref) : undefined
                  if (typeof info === 'boolean') configured = info
                  else if (info !== null && typeof info === 'object') {
                    configured = info.configured ?? info.present ?? info.set ?? info.hasValue ?? null
                    if (configured === null && typeof info.source === 'string') configured = true
                  }
                } catch (error) {
                  configured = null
                }
                log(`credential route: ${ref} configured=${String(configured)}`)
                return jsonResponse({ ref, configured })
              }
              const body = await readJsonBody(request)
              const ref = typeof body.ref === 'string' && body.ref.length > 0 ? body.ref : DEFAULTS.credentialRef
              if (typeof body.value !== 'string' || body.value.length === 0) {
                log('credential route: rejected, empty value')
                return jsonResponse({ code: 'bad-request', error: 'a non-empty value is required' }, 400)
              }
              if (typeof credentials.set !== 'function') {
                log('credential route: credentials.set is unavailable')
                return jsonResponse({ code: 'credentials-unavailable', error: 'credentials.set is unavailable' }, 503)
              }
              await credentials.set(ref, body.value)
              // The skill's CLI is a separate Node process with no credential
              // store, so the same value is mirrored into the plugin's own
              // 0600 key file (see writeKeyFile).
              const mirrored = await writeKeyFile(body.value)
              // Never the value itself: only that it arrived and how long it was.
              log(`credential route: stored ${ref} (${body.value.length} chars)${mirrored ? ' and mirrored to the api-key file' : ' (key file not written)'}`)
              return jsonResponse({ ref, configured: true, keyFile: mirrored })
            } catch (error) {
              log(`credential route: failed: ${error?.message ?? String(error)}`)
              return jsonResponse({ code: 'credentials-rejected', error: error?.message ?? String(error) }, 400)
            }
          },
        }),
      )
      try {
        scoped.effect(
          () => () => {
            for (const dispose of registrations) {
              if (typeof dispose === 'function') dispose()
            }
          },
          'agnes: settings bridge routes',
        )
      } catch (error) {
        /* an effect failure must not withdraw routes that already work */
      }
      log(`settings bridge ready at ${SETTINGS_ROUTE} and ${CREDENTIAL_ROUTE}`)
    } catch (error) {
      for (const dispose of registrations) {
        try {
          if (typeof dispose === 'function') dispose()
        } catch (cleanupError) {
          /* ignore */
        }
      }
      warn(`settings bridge routes not registered: ${error?.message ?? error}`)
    }
    })
  }

  // The settings page's store is this plugin's own file; load it once so the
  // tools see saved values from the very first tool call.
  refreshConfigStore()
  log(`configuration file: ${configPath()}`)

  installSettingsBridge()

  function config() {
    ensureSettingsNamespace()
    // Read order: the row's own resolved config (how 0.2.x hands a namespace
    // back to the plugin), then the fiber config, then the legacy get() seam
    // when the host still exposes it. DEFAULTS is the floor. The plugin-owned
    // file comes LAST and therefore wins: it is what the settings page writes,
    // so a value the user saved there cannot be shadowed by a stale row config.
    const live = {}
    if (rowConfig && typeof rowConfig === 'object') Object.assign(live, rowConfig)
    let fiberConfig
    try {
      fiberConfig = ctx.config
    } catch (error) {
      fiberConfig = undefined
    }
    if (fiberConfig && typeof fiberConfig === 'object') Object.assign(live, fiberConfig)
    const settings = ctx.get('settings')
    if (settings !== undefined && typeof settings.get === 'function') {
      try {
        const raw = settings.get('agnes')
        if (raw && typeof raw === 'object') Object.assign(live, raw)
      } catch (error) {
        warn(`settings read failed: ${error?.message ?? error}`)
      }
    }
    Object.assign(live, refreshConfigStore().values)
    return { ...DEFAULTS, ...live }
  }

  // ------------------------------------------------------------ key file sync

  /**
   * Mirror the API key into `<DSH_HOME>/storages/agnes/api-key`.
   *
   * The skill's CLI is a plain Node process: it has no Cordis context and no DSH
   * credential store, so this file is the handoff. It is written 0600 on POSIX
   * (on Windows the per-user ACL of the data directory is the boundary),
   * rewritten whenever the settings page saves a key, and refreshed at apply time
   * when a credential already exists.
   */
  const keyFilePath = path.join(dshHome(), 'storages', 'agnes', 'api-key')

  async function writeKeyFile(value) {
    const text = typeof value === 'string' ? value.trim() : ''
    if (text === '') return false
    try {
      await mkdir(path.dirname(keyFilePath), { recursive: true })
      const temporary = `${keyFilePath}.tmp`
      await writeFile(temporary, `${text}\n`, { encoding: 'utf8', mode: 0o600 })
      await rename(temporary, keyFilePath)
      return true
    } catch (error) {
      warn(`api-key file write failed: ${error?.message ?? error}`)
      return false
    }
  }

  /**
   * Mirror whatever the credential store already holds into that file.
   *
   * `credentials` composes AFTER this row applies — the same load-order contract
   * `connection` documents — so a one-shot `ctx.get('credentials')` at apply time
   * silently finds nothing and the skill's CLI is left with no key at all (the
   * file simply never appears). The nested inject waits for the service instead,
   * without holding this row's activation.
   */
  function watchCredentials() {
    if (typeof ctx.inject !== 'function') return
    ctx.inject(['credentials'], (scoped) => {
      void (async () => {
        try {
          const fromGet = typeof scoped.get === 'function' ? scoped.get('credentials') : undefined
          const credentials = fromGet ?? scoped.credentials
          if (credentials === undefined || credentials === null || typeof credentials.resolve !== 'function') return
          credentialsService = credentials
          const resolved = await credentials.resolve(config().credentialRef)
          const value = typeof resolved === 'string' ? resolved : (resolved?.value ?? resolved?.secret)
          if (typeof value === 'string' && value !== '' && (await writeKeyFile(value))) {
            log('api-key file refreshed for the skill CLI')
          }
        } catch (error) {
          // An unconfigured reference is the normal state before the first save.
          warn(`api-key file sync skipped: ${error?.message ?? error}`)
        }
      })()
    })
  }

  // -------------------------------------------------------------------- skill

  /**
   * Publish the bundled skill: `<plugin>/skills/agnes/SKILL.md`, whose `{{CLI}}`
   * placeholder is replaced with this installation's absolute CLI path, so the
   * model never has to guess where the plugin lives.
   */
  function registerSkill() {
    const skills = ctx.get('skills')
    if (skills === undefined || typeof skills.registerProvider !== 'function') {
      warn('skills service is unavailable; the agnes skill was not registered')
      return
    }
    const skillLocator = new URL('../skills/agnes/SKILL.md', import.meta.url)
    const skillDirectory = fileURLToPath(new URL('../skills/agnes/', import.meta.url))
    const cliPath = fileURLToPath(new URL('./cli.mjs', import.meta.url))
    let cached
    const candidate = async () => {
      if (cached !== undefined) return cached
      const raw = await readFile(fileURLToPath(skillLocator), 'utf8')
      const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---\r?\n/u.exec(raw)
      const header = frontmatter === null ? '' : frontmatter[1]
      const body = frontmatter === null ? raw : raw.slice(frontmatter[0].length)
      cached = {
        name: (/^name:\s*(.+)$/mu.exec(header)?.[1] ?? 'agnes').trim(),
        description: (/^description:\s*(.+)$/mu.exec(header)?.[1] ?? 'Agnes AI image and video generation.').trim(),
        invocation: { modelInvocable: true, userInvocable: true },
        provider: 'agnes',
        source: 'bundled',
        rank: 100,
        locator: skillLocator,
        resourceBase: { kind: 'directory', path: skillDirectory },
        content: body.replaceAll('{{CLI}}', cliPath).trim(),
      }
      return cached
    }
    try {
      const dispose = skills.registerProvider(() => ({
        name: 'agnes',
        async list() {
          return [await candidate()]
        },
        async get(selected) {
          return selected?.name === 'agnes' ? await candidate() : undefined
        },
      }))
      ctx.effect(() => dispose, 'agnes: bundled skill')
      log(`skill "agnes" registered (cli: ${cliPath})`)
    } catch (error) {
      warn(`skill registration failed: ${error?.message ?? error}`)
    }
  }

  registerSkill()
  watchCredentials()

  log(`ready (image=${config().imageModel}, video=${config().videoModel}, keyFile=${keyFilePath})`)
}
