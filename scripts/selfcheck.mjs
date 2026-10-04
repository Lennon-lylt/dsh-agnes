/**
 * Pre-flight check: proves both halves load and register without booting DSH.
 *
 * This is the check that must pass BEFORE a profile install, because a host row
 * that throws on import or a client bundle that fails to parse turns a plugin
 * install into a deployment incident.
 *
 * It needs node_modules resolution for @deepseek-ai/schemastery; in a dev
 * checkout that means a junction to the harness node_modules:
 *
 *   cmd /c mklink /J dsh-agnes\node_modules "<DSH_HOME>\profiles\node_modules"
 */
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const pkgRoot = path.join(here, '..')
const load = (relative) => import(pathToFileURL(path.join(pkgRoot, relative)).href)

// ---------------------------------------------------------------- host half
const host = await load('lib/index.js')
if (typeof host.apply !== 'function') throw new Error('host half does not export apply()')
if (host.name !== 'agnes') throw new Error(`host half name is ${host.name}, expected agnes`)

const registered = []
const namespaceRegistrations = []
const effects = []
let settingsValue = {}

const stubCtx = {
  get(name) {
    if (name === 'tools') {
      return {
        register(definition) {
          registered.push({
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
    if (name === 'settings') {
      return {
        register(ns, schema) {
          namespaceRegistrations.push({ ns, kind: typeof schema })
          return {}
        },
        get: () => settingsValue,
      }
    }
    return undefined
  },
  effect(callback) {
    const dispose = callback()
    effects.push(dispose)
    return () => {}
  },
}

await host.apply(stubCtx)

console.log('host half:')
console.log('  name          :', host.name)
console.log('  settings ns   :', namespaceRegistrations.map((entry) => entry.ns).join(', ') || '(none)')
console.log('  tools         :')
for (const tool of registered) console.log(`    - ${tool.name} timeoutMs=${tool.timeoutMs} required=${JSON.stringify(tool.requiredArgs)}`)

if (registered.length !== 4) throw new Error(`expected 4 tools, got ${registered.length}`)
if (namespaceRegistrations.length === 0 && process.env.AGNES_REQUIRE_SCHEMA === '1') {
  throw new Error('the agnes settings namespace was not registered')
}
if (namespaceRegistrations.length === 0) {
  console.log('  note: schemastery is not resolvable from this checkout, so the settings schema was skipped')
  console.log('        (install-time resolution comes from the profile node_modules tree)')
  // Prove the schema idioms the row uses, by loading the harness copy directly.
  const harnessSchema = process.env.DSH_HOME
    ? path.join(process.env.DSH_HOME, 'profiles', 'node_modules', '@deepseek-ai', 'schemastery', 'lib', 'index.mjs')
    : undefined
  if (harnessSchema) {
    const z = (await import(pathToFileURL(harnessSchema).href)).default
    const probe = z.object({
      s: z.string().default('fallback').description('a string knob'),
      n: z.number().default(7),
    })
    const resolved = probe({})
    if (resolved.s !== 'fallback' || resolved.n !== 7) {
      throw new Error(`schemastery defaults did not resolve as expected: ${JSON.stringify(resolved)}`)
    }
    console.log('  schema idioms: z.object/z.string().default().description() verified against', harnessSchema)
  }
}
for (const dispose of effects) {
  if (typeof dispose === 'function') dispose()
}

// -------------------------------------------------------------- client half
const loaded = []
let clientExports
globalThis.window = {
  __ModuleLoader__: {
    load(registration) {
      loaded.push(registration.id)
      const React = {
        createElement: (...args) => ({ type: args[0], props: args[1] }),
        useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
        useEffect: () => {},
        useCallback: (fn) => fn,
      }
      clientExports = registration.factory((specifier) => {
        if (specifier === 'react') return React
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

// The client apply must tolerate a missing slots service instead of throwing.
await clientExports.apply(stubCtx)
console.log('  apply with no slots: tolerated')
console.log('\nSelf-check passed.')
process.exit(0)
