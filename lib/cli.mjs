/**
 * dsh-agnes command line — the executable half of the bundled `agnes` skill.
 *
 * The plugin's browser half only configures; this CLI is what actually runs, so
 * it must work as a plain Node process with no Cordis, no DSH context and no
 * browser: it reads the same settings file and API-key file the host half writes
 * (`<DSH_HOME>/storages/agnes/...`) and reuses the dependency-free API client in
 * `./agnes-api.mjs`.
 *
 * Invocation contract for the skill:
 *   node <abs path to this file> <command> [flags]
 * stdout carries ONE JSON object (the result); progress notes go to stderr, so a
 * caller can always parse the output. A failing command exits 1 with
 * `{ ok: false, error, kind, hint }`.
 *
 * Commands:
 *   image --prompt <text> [--images a.png,b.jpg] [--size 1K] [--aspect 16:9]
 *         [--model <id>] [--out <dir>]
 *   video --prompt <text> [--image <url|path>] [--seconds 5] [--size 720P]
 *         [--aspect 16:9] [--model <id>] [--wait[=ms]] [--out <dir>]
 *   task list | status --id <id> | wait --id <id> [--wait-ms N] | cancel --id <id>
 *   models
 *   config            (resolved settings, never the key value)
 */
import { mkdir, readFile, writeFile, rename } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { createAgnesClient, AgnesError, isPublicUrl } from './agnes-api.mjs'

/** Mirrors the host half's schema defaults; the settings file overrides them. */
export const DEFAULTS = {
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

export function dshHome(env = process.env) {
  return env.DSH_HOME && env.DSH_HOME.length > 0 ? env.DSH_HOME : path.join(homedir(), '.dsh')
}

export function configFile(env = process.env) {
  return path.join(dshHome(env), 'storages', 'agnes', 'config.json')
}

export function apiKeyFile(env = process.env) {
  return path.join(dshHome(env), 'storages', 'agnes', 'api-key')
}

export function taskFile(env = process.env) {
  return path.join(dshHome(env), 'storages', 'agnes', 'tasks.json')
}

/** Settings file over defaults; unknown keys and wrong types are ignored. */
export async function loadConfig(env = process.env) {
  const values = { ...DEFAULTS }
  try {
    const parsed = JSON.parse(await readFile(configFile(env), 'utf8'))
    const raw = parsed !== null && typeof parsed === 'object' && parsed.values !== null && typeof parsed.values === 'object' ? parsed.values : parsed
    if (raw !== null && typeof raw === 'object') {
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
  } catch (error) {
    // No settings file yet is the normal state before the first save.
  }
  return values
}

/**
 * The API key, in the order the user's decision implies: an explicit environment
 * variable wins, then the file the host half mirrors the credential into (that
 * file is what makes a shell process able to use the key at all).
 */
export async function loadApiKey(cfg, env = process.env) {
  for (const name of [cfg.credentialRef, 'AGNES_API_KEY']) {
    const value = env[name]
    if (typeof value === 'string' && value.trim() !== '') return { key: value.trim(), source: `env:${name}` }
  }
  try {
    const raw = (await readFile(apiKeyFile(env), 'utf8')).trim()
    if (raw !== '') return { key: raw, source: `file:${apiKeyFile(env)}` }
  } catch (error) {
    /* missing file falls through to the error below */
  }
  return { key: '', source: 'none' }
}

// ------------------------------------------------------------------ arg parsing

/** `--flag`, `--key value`, `--key=value`, repeated `--images a --images b`. */
export function parseArgv(argv) {
  const flags = {}
  const positionals = []
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]
    if (!token.startsWith('--')) {
      positionals.push(token)
      continue
    }
    const body = token.slice(2)
    const eq = body.indexOf('=')
    const name = (eq >= 0 ? body.slice(0, eq) : body).replace(/-([a-z])/gu, (_match, letter) => letter.toUpperCase())
    let value
    if (eq >= 0) {
      value = body.slice(eq + 1)
    } else if (index + 1 < argv.length && !argv[index + 1].startsWith('--')) {
      value = argv[index + 1]
      index += 1
    } else {
      value = true
    }
    if (Object.hasOwn(flags, name)) {
      flags[name] = Array.isArray(flags[name]) ? [...flags[name], value] : [flags[name], value]
    } else {
      flags[name] = value
    }
  }
  return { flags, positionals }
}

function textFlag(flags, name) {
  const value = flags[name]
  if (typeof value === 'string' && value.trim() !== '') return value.trim()
  return undefined
}

function listFlag(flags, name) {
  const value = flags[name]
  if (value === undefined || value === true) return []
  const list = Array.isArray(value) ? value : [value]
  return list
    .flatMap((entry) => (typeof entry === 'string' ? entry.split(',') : []))
    .map((entry) => entry.trim())
    .filter((entry) => entry !== '')
}

function numberFlag(flags, name) {
  const value = flags[name]
  if (typeof value === 'number') return value
  if (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))) return Number(value)
  return undefined
}

/** `--wait` alone means "wait the default budget"; `--wait 90000` sets it. */
function waitFlag(flags) {
  if (flags.wait === true) return 120000
  const value = numberFlag(flags, 'wait')
  if (value !== undefined) return Math.max(0, value)
  return numberFlag(flags, 'waitMs')
}

// ---------------------------------------------------------------------- helpers

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const today = () => new Date().toISOString().slice(0, 10)

function shortHash(value) {
  // Small, non-cryptographic disambiguator for file names (no crypto import).
  let hash = 0
  for (const char of String(value)) hash = (hash * 31 + char.codePointAt(0)) % 0xffffffff
  return hash.toString(16).padStart(8, '0').slice(0, 8)
}

/**
 * Where artifacts go, in the order the settings page documents them:
 * `--out` beats the configured `outputDir`, then the workspace directory the
 * command runs in (the session workspace for an agent shell), then DSH_HOME.
 */
export function outputRoots(cfg, options = {}) {
  const cwd = options.cwd ?? process.cwd()
  const roots = []
  if (options.out !== undefined) roots.push(path.resolve(cwd, options.out))
  if (cfg.outputDir) roots.push(cfg.outputDir)
  roots.push(path.join(cwd, 'agnes-output'))
  roots.push(path.join(dshHome(options.env ?? process.env), 'agnes-output'))
  return roots
}

async function landArtifact(api, cfg, options, url, ext, label) {
  const bytes = await api.download(url)
  const fileName = `${label}-${Date.now().toString(36)}-${shortHash(url)}.${ext}`
  const roots = outputRoots(cfg, options)
  let lastError
  for (const root of roots) {
    try {
      const dir = path.join(root, today())
      await mkdir(dir, { recursive: true })
      const file = path.join(dir, fileName)
      await writeFile(file, bytes)
      return { file, bytes: bytes.length, root, fellBack: root !== roots[0] }
    } catch (error) {
      lastError = error
      options.stderr?.(`[agnes] cannot write under ${root}: ${error?.code ?? ''} ${error?.message ?? error}`)
    }
  }
  throw new AgnesError(`could not write the artifact to any output root: ${lastError?.message ?? lastError}`, {
    kind: 'write',
    hint: '检查输出目录是否可写，或在 Agnes 设置里指定一个可写路径。',
  })
}

async function readTasks(env) {
  const records = []
  try {
    const raw = JSON.parse(await readFile(taskFile(env), 'utf8'))
    for (const record of raw.tasks ?? []) {
      if (record !== null && typeof record === 'object' && typeof record.videoId === 'string') records.push(record)
    }
  } catch (error) {
    /* an absent store is normal */
  }
  return records
}

async function writeTasks(env, records) {
  const target = taskFile(env)
  await mkdir(path.dirname(target), { recursive: true })
  const tmp = `${target}.tmp`
  await writeFile(tmp, `${JSON.stringify({ version: 1, tasks: records }, null, 2)}\n`, 'utf8')
  await rename(tmp, target)
}

function taskView(record) {
  return {
    taskId: record.videoId,
    model: record.model,
    status: record.status,
    progress: record.progress ?? 0,
    prompt: record.prompt,
    submittedAt: record.submittedAt,
    finishedAt: record.finishedAt ?? null,
    file: record.file ?? null,
    actualSize: record.actualSize ?? null,
    sizeMapping: record.sizeMapping ?? null,
    restagedFirstFrame: record.restagedFirstFrame === true,
    error: record.error ?? null,
  }
}

/** One poll; on completion the artifact is downloaded into the record's cwd. */
async function advanceTask(api, cfg, options, record) {
  if (record.status !== 'running') return record
  let poll
  try {
    poll = await api.pollVideo(record.videoId, record.model)
  } catch (error) {
    record.lastError = error?.message ?? String(error)
    options.stderr?.(`[agnes] poll failed for ${record.videoId}: ${record.lastError}`)
    return record
  }
  record.progress = poll.progress
  record.actualSize = poll.size ?? record.actualSize ?? null
  if (poll.sizeMapping) record.sizeMapping = poll.sizeMapping
  if (poll.status === 'completed') {
    record.status = 'completed'
    record.finishedAt = Date.now()
    if (poll.url) {
      try {
        const landed = await landArtifact(api, cfg, { ...options, cwd: record.cwd ?? options.cwd }, poll.url, 'mp4', `agnes-video-${record.model}`)
        record.file = landed.file
        record.bytes = landed.bytes
      } catch (error) {
        record.downloadError = error?.message ?? String(error)
        options.stderr?.(`[agnes] artifact download failed: ${record.downloadError}`)
      }
    }
  } else if (poll.status === 'failed') {
    record.status = 'failed'
    record.finishedAt = Date.now()
    record.error = poll.error ?? 'Agnes reported failure'
  }
  return record
}

async function localImageToDataUri(file) {
  const bytes = await readFile(file)
  const ext = ['.jpg', '.jpeg'].includes(path.extname(file).toLowerCase()) ? 'jpeg' : 'png'
  return `data:image/${ext};base64,${bytes.toString('base64')}`
}

// --------------------------------------------------------------------- commands

async function commandImage(flags, options) {
  const prompt = textFlag(flags, 'prompt')
  if (prompt === undefined) throw new AgnesError('image needs --prompt', { kind: 'usage', hint: '见 `agnes help`。' })
  const cfg = await loadConfig(options.env)
  const { key, source } = await loadApiKey(cfg, options.env)
  const api = createAgnesClient({ baseUrl: cfg.baseUrl, apiKey: key, fetchImpl: options.fetchImpl })
  const inputs = []
  for (const entry of listFlag(flags, 'images')) {
    if (isPublicUrl(entry) || /^data:image\//iu.test(entry)) inputs.push(entry)
    else inputs.push(await localImageToDataUri(entry))
  }
  const model = textFlag(flags, 'model') ?? cfg.imageModel
  const size = textFlag(flags, 'size') ?? cfg.imageSize
  const result = await api.generateImage({
    prompt,
    model,
    size,
    aspectRatio: textFlag(flags, 'aspect'),
    images: inputs,
  })
  if (!result.url) throw new AgnesError('Agnes returned no image URL', { kind: 'empty', hint: '重试，或检查是否有并发上限。' })
  const landed = await landArtifact(api, cfg, options, result.url, 'png', `agnes-image-${result.url.includes('/i2i/') ? 'i2i' : 't2i'}`)
  return {
    ok: true,
    command: 'image',
    files: [landed.file],
    bytes: landed.bytes,
    model,
    requestedSize: size,
    mode: inputs.length > 0 ? 'image-to-image' : 'text-to-image',
    keySource: source,
    fellBack: landed.fellBack,
    note: landed.fellBack ? `首选输出目录不可写，已回退到 ${landed.root}` : '',
  }
}

async function commandVideo(flags, options) {
  const prompt = textFlag(flags, 'prompt')
  if (prompt === undefined) throw new AgnesError('video needs --prompt', { kind: 'usage', hint: '见 `agnes help`。' })
  const cfg = await loadConfig(options.env)
  const { key, source } = await loadApiKey(cfg, options.env)
  const api = createAgnesClient({ baseUrl: cfg.baseUrl, apiKey: key, fetchImpl: options.fetchImpl })
  const model = textFlag(flags, 'model') ?? cfg.videoModel
  const notes = []
  let firstFrame
  let restaged = false
  const image = textFlag(flags, 'image')
  if (image !== undefined) {
    if (isPublicUrl(image)) {
      firstFrame = image
    } else {
      // The video endpoint accepts only a public URL: a local first frame has to be
      // restaged through the image endpoint first, which rewrites it slightly.
      const staged = await api.generateImage({
        prompt: '保持输入图像的构图、主体、配色与风格完全不变，仅做高保真还原',
        model: cfg.imageModel,
        size: cfg.imageSize,
        images: [await localImageToDataUri(image)],
      })
      if (!staged.url) throw new AgnesError('first-frame restaging produced no public URL', { kind: 'empty' })
      firstFrame = staged.url
      restaged = true
      notes.push('首帧来自本地文件：已先经一次图生图换取公网 URL，因此画面被轻微改写。')
    }
  }

  let submitted
  let lastError
  for (let attempt = 0; attempt <= cfg.queueRetryMax; attempt += 1) {
    try {
      submitted = await api.submitVideo({
        prompt,
        model,
        image: firstFrame,
        seconds: textFlag(flags, 'seconds') ?? cfg.videoSeconds,
        size: textFlag(flags, 'size') ?? cfg.videoSize,
        aspectRatio: textFlag(flags, 'aspect') ?? cfg.videoAspectRatio,
      })
      break
    } catch (error) {
      lastError = error
      if (error instanceof AgnesError && error.kind === 'queue_full' && attempt < cfg.queueRetryMax) {
        notes.push(`第 ${attempt + 1} 次遇到队列已满，等待 ${cfg.queueRetryDelayMs}ms 后重试。`)
        await sleep(cfg.queueRetryDelayMs)
        continue
      }
      throw error
    }
  }
  if (submitted === undefined) throw lastError ?? new AgnesError('video submit failed', {})

  const record = {
    videoId: submitted.videoId,
    model,
    prompt,
    requestedSeconds: textFlag(flags, 'seconds') ?? cfg.videoSeconds,
    requestedSize: textFlag(flags, 'size') ?? cfg.videoSize,
    requestedAspectRatio: textFlag(flags, 'aspect') ?? cfg.videoAspectRatio,
    firstFrame: firstFrame ?? null,
    restagedFirstFrame: restaged,
    status: 'running',
    progress: submitted.progress ?? 0,
    submittedAt: Date.now(),
    cwd: options.cwd ?? process.cwd(),
  }
  const records = await readTasks(options.env)
  records.push(record)
  await writeTasks(options.env, records)

  const waitMs = waitFlag(flags)
  if (waitMs !== undefined && waitMs > 0) {
    const deadline = Date.now() + waitMs
    while (Date.now() < deadline && record.status === 'running') {
      await sleep(Math.min(3000, Math.max(500, cfg.pollIntervalMs / 3)))
      await advanceTask(api, cfg, options, record)
    }
    await writeTasks(options.env, records.map((entry) => (entry.videoId === record.videoId ? record : entry)))
  }

  return {
    ok: true,
    command: 'video',
    task: taskView(record),
    keySource: source,
    note: [
      ...notes,
      record.status === 'running' ? `任务仍在进行；用 \`task wait --id ${record.videoId}\`（或 status）继续查询，完成后自动落盘。` : '',
    ]
      .filter(Boolean)
      .join(' '),
  }
}

async function commandTask(flags, positionals, options) {
  const action = positionals[0] ?? 'list'
  const cfg = await loadConfig(options.env)
  const { key, source } = await loadApiKey(cfg, options.env)
  const api = createAgnesClient({ baseUrl: cfg.baseUrl, apiKey: key, fetchImpl: options.fetchImpl })
  const records = await readTasks(options.env)
  const id = textFlag(flags, 'id') ?? positionals[1]

  if (action === 'list') {
    return { ok: true, command: 'task', action, count: records.length, tasks: records.map(taskView), keySource: source }
  }
  const record = id === undefined ? undefined : records.find((entry) => entry.videoId === id)
  if (record === undefined) {
    return {
      ok: false,
      command: 'task',
      action,
      error: `unknown task ${id ?? '(no --id)'}`,
      kind: 'usage',
      tasks: records.map((entry) => entry.videoId),
    }
  }
  if (action === 'status') {
    await advanceTask(api, cfg, options, record)
  } else if (action === 'wait') {
    const waitMs = waitFlag(flags) ?? 120000
    const deadline = Date.now() + waitMs
    while (Date.now() < deadline && record.status === 'running') {
      await advanceTask(api, cfg, options, record)
      if (record.status === 'running') await sleep(Math.min(3000, Math.max(500, cfg.pollIntervalMs / 3)))
    }
  } else if (action === 'cancel') {
    record.status = 'cancelled'
    record.finishedAt = Date.now()
  } else {
    throw new AgnesError(`unknown task action "${action}"`, { kind: 'usage', hint: 'list | status | wait | cancel' })
  }
  await writeTasks(options.env, records.map((entry) => (entry.videoId === record.videoId ? record : entry)))
  return { ok: true, command: 'task', action, task: taskView(record), keySource: source }
}

async function commandModels(options) {
  const cfg = await loadConfig(options.env)
  const { key, source } = await loadApiKey(cfg, options.env)
  const api = createAgnesClient({ baseUrl: cfg.baseUrl, apiKey: key, fetchImpl: options.fetchImpl })
  const models = await api.listModels()
  return { ok: true, command: 'models', count: models.length, models, keySource: source }
}

async function commandConfig(options) {
  const cfg = await loadConfig(options.env)
  const { source } = await loadApiKey(cfg, options.env)
  return {
    ok: true,
    command: 'config',
    configFile: configFile(options.env),
    apiKeyFile: apiKeyFile(options.env),
    taskFile: taskFile(options.env),
    keyConfigured: source !== 'none',
    keySource: source,
    values: cfg,
  }
}

export const USAGE = `dsh-agnes CLI — 配置在 DSH 的 设置 → Agnes 里，这里只负责执行。

  image --prompt <text> [--images a.png,b.jpg] [--size 1K] [--aspect 16:9] [--model <id>] [--out <dir>]
  video --prompt <text> [--image <公网URL|本地路径>] [--seconds 5] [--size 720P] [--aspect 16:9]
        [--model <id>] [--wait[=毫秒]] [--out <dir>]
  task list | status --id <id> | wait --id <id> [--wait-ms 毫秒] | cancel --id <id>
  models
  config

产物落盘顺序：--out → 设置里的输出目录 → <当前目录>/agnes-output/<日期>/ → <DSH_HOME>/agnes-output/<日期>/。
stdout 只输出一个 JSON 对象；过程信息走 stderr。`

/**
 * Run one command. Returns `{ exitCode, payload }`; the entry point prints the
 * payload, so tests can call this directly.
 */
export async function run(argv, options = {}) {
  const resolved = {
    env: options.env ?? process.env,
    cwd: options.cwd ?? process.cwd(),
    fetchImpl: options.fetchImpl,
    stderr: options.stderr ?? ((line) => process.stderr.write(`${line}\n`)),
  }
  const { flags, positionals } = parseArgv(argv)
  const command = typeof flags.help === 'boolean' ? 'help' : (positionals.shift() ?? 'help')
  try {
    if (command === 'help' || command === '--help') return { exitCode: 0, payload: { ok: true, command: 'help', usage: USAGE } }
    if (command === 'image') return { exitCode: 0, payload: await commandImage(flags, resolved) }
    if (command === 'video') return { exitCode: 0, payload: await commandVideo(flags, resolved) }
    if (command === 'task') return await taskResult(flags, positionals, resolved)
    if (command === 'models') return { exitCode: 0, payload: await commandModels(resolved) }
    if (command === 'config') return { exitCode: 0, payload: await commandConfig(resolved) }
    return { exitCode: 2, payload: { ok: false, command, error: `unknown command "${command}"`, kind: 'usage', usage: USAGE } }
  } catch (error) {
    const failure = {
      ok: false,
      command,
      error: error?.message ?? String(error),
      kind: error instanceof AgnesError ? error.kind : 'other',
      hint: error instanceof AgnesError ? error.hint : '',
    }
    return { exitCode: 1, payload: failure }
  }
}

async function taskResult(flags, positionals, options) {
  const payload = await commandTask(flags, positionals, options)
  return { exitCode: payload.ok ? 0 : 1, payload }
}

const isEntry = process.argv[1] !== undefined && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
if (isEntry) {
  const { exitCode, payload } = await run(process.argv.slice(2))
  process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`)
  process.exit(exitCode)
}
