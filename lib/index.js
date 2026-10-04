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
import { existsSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { homedir } from 'node:os'
import path from 'node:path'

// The schema library is resolved dynamically on purpose: a resolution failure
// in a given composition must degrade to the built-in defaults, never stop the
// row from applying (a row that throws on import takes the whole plugin down).
let z
try {
  z = (await import('@deepseek-ai/schemastery')).default
} catch (error) {
  console.warn(`[agnes] schemastery unavailable, settings schema will not be registered: ${error?.message ?? error}`)
  z = undefined
}

import { createAgnesClient, AgnesError, isPublicUrl } from './agnes-api.mjs'

export const name = 'agnes'

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

const text = (value) => [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }]

function dshHome() {
  return process.env.DSH_HOME || path.join(homedir(), '.dsh')
}

function today() {
  return new Date().toISOString().slice(0, 10)
}

function shortHash(value) {
  return createHash('sha1').update(String(value)).digest('hex').slice(0, 8)
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export async function apply(ctx) {
  const log = (message) => console.log(`[agnes] ${message}`)
  const warn = (message) => console.warn(`[agnes] ${message}`)

  const tools = ctx.get('tools')
  if (tools === undefined) {
    warn('tools service is unavailable; the agnes plugin contributes nothing')
    return
  }

  const settings = ctx.get('settings')
  if (settings !== undefined && Config !== undefined) {
    try {
      settings.register('agnes', Config)
    } catch (error) {
      warn(`settings namespace registration failed: ${error?.message ?? error}`)
    }
  } else if (settings === undefined) {
    warn('settings service is unavailable; running on built-in defaults')
  }

  function config() {
    let live = {}
    if (settings !== undefined) {
      try {
        const raw = settings.get('agnes')
        if (raw && typeof raw === 'object') live = raw
      } catch (error) {
        warn(`settings read failed: ${error?.message ?? error}`)
      }
    }
    return { ...DEFAULTS, ...live }
  }

  async function apiKeyFor(cfg) {
    const credentials = ctx.get('credentials')
    if (credentials !== undefined) {
      try {
        const resolved = await credentials.resolve(cfg.credentialRef)
        const value = typeof resolved === 'string' ? resolved : resolved?.value ?? resolved?.secret ?? resolved?.key
        if (typeof value === 'string' && value.length > 0) return value
      } catch (error) {
        warn(`credential resolve failed for ${cfg.credentialRef}: ${error?.message ?? error}`)
      }
    }
    const fromEnv = process.env[cfg.credentialRef]
    return typeof fromEnv === 'string' ? fromEnv : ''
  }

  async function client() {
    const cfg = config()
    return { cfg, client: createAgnesClient({ baseUrl: cfg.baseUrl, apiKey: await apiKeyFor(cfg) }) }
  }

  function outputCandidates(cfg, exec) {
    if (cfg.outputDir) return [cfg.outputDir]
    const roots = []
    const cwd = typeof exec?.agent?.cwd === 'string' ? exec.agent.cwd : undefined
    if (cwd) roots.push(path.join(cwd, 'agnes-output'))
    roots.push(path.join(dshHome(), 'agnes-output'))
    return roots
  }

  /**
   * Download the artifact immediately and write it under the first writable
   * root. A URL is never the deliverable: Agnes output URLs can expire, and a
   * session workspace can be temporarily unwritable, so this walks the
   * candidates instead of assuming the first one works.
   */
  async function land(cfg, exec, url, ext, label) {
    const bytes = await clientDownload(url)
    const fileName = `${label}-${Date.now().toString(36)}-${shortHash(url)}.${ext}`
    let lastError
    for (const root of outputCandidates(cfg, exec)) {
      try {
        const dir = path.join(root, today())
        await mkdir(dir, { recursive: true })
        const file = path.join(dir, fileName)
        await writeFile(file, bytes)
        return { file, bytes: bytes.length, root, fellBack: root !== outputCandidates(cfg, exec)[0] }
      } catch (error) {
        lastError = error
        warn(`cannot land artifact under ${root}: ${error?.code ?? ''} ${error?.message ?? error}`)
      }
    }
    throw new AgnesError(`Could not write the artifact to any candidate root: ${lastError?.message ?? lastError}`, {
      kind: 'write',
      hint: '检查输出目录是否可写，或在 Agnes 设置里指定一个可写路径。',
    })
  }

  async function clientDownload(url) {
    const { client: api } = await client()
    return api.download(url)
  }

  // ---------------------------------------------------------------- task store

  const storePath = path.join(dshHome(), 'storages', 'agnes', 'tasks.json')
  /** @type {Map<string, object>} */
  const tasks = new Map()

  async function loadTasks() {
    try {
      if (!existsSync(storePath)) return
      const raw = JSON.parse(await readFile(storePath, 'utf8'))
      for (const record of raw.tasks ?? []) {
        if (record && typeof record.videoId === 'string') tasks.set(record.videoId, record)
      }
      log(`restored ${tasks.size} video task record(s) from ${storePath}`)
    } catch (error) {
      warn(`task store read failed: ${error?.message ?? error}`)
    }
  }

  async function saveTasks() {
    try {
      await mkdir(path.dirname(storePath), { recursive: true })
      const payload = JSON.stringify({ version: 1, tasks: [...tasks.values()] }, null, 2)
      const tmp = `${storePath}.tmp`
      await writeFile(tmp, payload)
      await rename(tmp, storePath)
    } catch (error) {
      warn(`task store write failed: ${error?.message ?? error}`)
    }
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

  /** One poll of one record; downloads the artifact the moment it completes. */
  async function advance(record) {
    if (record.status !== 'running') return record
    const { cfg, client: api } = await client()
    let poll
    try {
      poll = await api.pollVideo(record.videoId, record.model)
    } catch (error) {
      record.lastError = error?.message ?? String(error)
      warn(`poll failed for ${record.videoId}: ${record.lastError}`)
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
          const landed = await land(cfg, record.exec ?? undefined, poll.url, 'mp4', `agnes-video-${record.model}`)
          record.file = landed.file
          record.bytes = landed.bytes
        } catch (error) {
          record.downloadError = error?.message ?? String(error)
          warn(`artifact download failed: ${record.downloadError}`)
        }
      }
    } else if (poll.status === 'failed') {
      record.status = 'failed'
      record.finishedAt = Date.now()
      record.error = poll.error ?? 'Agnes reported failure'
    }
    await saveTasks()
    return record
  }

  await loadTasks()

  const interval = setInterval(() => {
    for (const record of tasks.values()) {
      if (record.status === 'running') void advance(record)
    }
  }, Math.max(2000, config().pollIntervalMs))
  ctx.effect(() => () => clearInterval(interval), 'agnes: video poller')

  // --------------------------------------------------------------------- tools

  const unregister = []

  unregister.push(
    tools.register({
      name: 'agnes_image',
      description:
        'Generate or edit an image with Agnes AI. Text-to-image when only `prompt` is given; image-to-image when `images` carries one or more local file paths, data URIs, or public URLs. The result is downloaded into the workspace and the saved path is returned.',
      parameters: {
        type: 'object',
        properties: {
          prompt: { type: 'string', description: 'What to generate or how to edit the input image(s).' },
          images: {
            type: 'array',
            items: { type: 'string' },
            description: 'Optional input images: local file paths, data URIs, or public URLs.',
          },
          size: { type: 'string', description: 'Size tier (1K/2K/3K/4K) or a pixel pair such as 1024x1024.' },
          aspect_ratio: { type: 'string', description: 'Aspect ratio such as 16:9, used with a size tier.' },
          model: { type: 'string', description: 'Override the configured image model.' },
        },
        required: ['prompt'],
        additionalProperties: false,
      },
      output: {
        schema: {
          type: 'object',
          properties: {
            files: { type: 'array', items: { type: 'string' } },
            model: { type: 'string' },
            requestedSize: { type: 'string' },
            bytes: { type: 'number' },
            note: { type: 'string' },
          },
        },
        render: (_args, value) =>
          text(
            `Agnes image saved:\n${(value.files ?? []).join('\n')}\nmodel=${value.model} size=${value.requestedSize} bytes=${value.bytes}${value.note ? `\n${value.note}` : ''}`,
          ),
      },
      timeoutMs: 620000,
      isConcurrencySafe: () => true,
      async execute(args, exec) {
        const { cfg, client: api } = await client()
        const inputs = []
        for (const entry of args.images ?? []) {
          if (typeof entry !== 'string' || entry.length === 0) continue
          if (/^data:image\//i.test(entry) || isPublicUrl(entry)) {
            inputs.push(entry)
            continue
          }
          const bytes = await readFile(entry)
          const ext = path.extname(entry).toLowerCase() === '.jpg' || path.extname(entry).toLowerCase() === '.jpeg' ? 'jpeg' : 'png'
          inputs.push(`data:image/${ext};base64,${bytes.toString('base64')}`)
        }
        const result = await api.generateImage({
          prompt: args.prompt,
          model: args.model || cfg.imageModel,
          size: args.size || cfg.imageSize,
          aspectRatio: args.aspect_ratio,
          images: inputs,
          signal: exec.signal,
        })
        if (!result.url) {
          throw new AgnesError('Agnes returned no image URL', { kind: 'empty', hint: '重试，或检查是否有并发上限。' })
        }
        const landed = await land(cfg, exec, result.url, 'png', `agnes-image-${result.url.includes('/i2i/') ? 'i2i' : 't2i'}`)
        return {
          files: [landed.file],
          model: args.model || cfg.imageModel,
          requestedSize: args.size || cfg.imageSize,
          bytes: landed.bytes,
          note: [
            inputs.length > 0 ? `图生图（${inputs.length} 张输入）` : '文生图',
            landed.fellBack ? `首选输出目录不可写，已回退到 ${landed.root}` : '',
          ]
            .filter(Boolean)
            .join('；'),
        }
      },
    }),
  )

  unregister.push(
    tools.register({
      name: 'agnes_video',
      description:
        'Generate a video with Agnes AI. Text-to-video by default. Pass `image` to drive the first frame: a PUBLIC URL is used directly, while a LOCAL FILE is first passed through the image endpoint to obtain a public URL (that restaging slightly rewrites the still, and the result says so). Returns immediately with a task id unless `wait_ms` is given.',
      parameters: {
        type: 'object',
        properties: {
          prompt: { type: 'string', description: 'What the video should show, including camera and motion notes.' },
          image: { type: 'string', description: 'Optional first frame: local file path or public URL.' },
          seconds: { type: 'string', description: 'Video length in seconds (this model family uses 5).' },
          size: { type: 'string', description: 'Size tier such as 720P; the server snaps to the nearest preset.' },
          aspect_ratio: { type: 'string', description: 'Aspect ratio such as 16:9.' },
          model: { type: 'string', description: 'Override the configured video model.' },
          wait_ms: { type: 'number', description: 'Wait this long for completion before returning the task id (0 = return immediately).' },
        },
        required: ['prompt'],
        additionalProperties: false,
      },
      output: {
        schema: {
          type: 'object',
          properties: {
            taskId: { type: 'string' },
            status: { type: 'string' },
            progress: { type: 'number' },
            file: { type: 'string' },
            note: { type: 'string' },
          },
        },
        render: (_args, value) =>
          text(
            `Agnes video task ${value.taskId}\nstatus=${value.status} progress=${value.progress}%${value.file ? `\nfile=${value.file}` : ''}${value.note ? `\n${value.note}` : ''}`,
          ),
      },
      timeoutMs: 900000,
      isConcurrencySafe: () => true,
      async execute(args, exec) {
        const { cfg, client: api } = await client()
        let firstFrame
        let restaged = false
        const notes = []

        if (typeof args.image === 'string' && args.image.length > 0) {
          if (isPublicUrl(args.image)) {
            firstFrame = args.image
          } else {
            const bytes = await readFile(args.image)
            const dataUri = `data:image/png;base64,${bytes.toString('base64')}`
            const staged = await api.generateImage({
              prompt: '保持输入图像的构图、主体、配色与风格完全不变，仅做高保真还原',
              model: cfg.imageModel,
              size: cfg.imageSize,
              images: [dataUri],
              signal: exec.signal,
            })
            if (!staged.url) throw new AgnesError('First-frame restaging produced no public URL', { kind: 'empty' })
            firstFrame = staged.url
            restaged = true
            notes.push('首帧来自本地文件：已先经一次图生图换取公网 URL，因此画面被轻微改写。')
          }
        }

        const attemptSubmit = () =>
          api.submitVideo({
            prompt: args.prompt,
            model: args.model || cfg.videoModel,
            image: firstFrame,
            seconds: args.seconds || cfg.videoSeconds,
            size: args.size || cfg.videoSize,
            aspectRatio: args.aspect_ratio || cfg.videoAspectRatio,
            signal: exec.signal,
          })

        let submitted
        let lastQueueError
        for (let attempt = 0; attempt <= cfg.queueRetryMax; attempt += 1) {
          try {
            submitted = await attemptSubmit()
            break
          } catch (error) {
            lastQueueError = error
            if (error instanceof AgnesError && error.kind === 'queue_full' && attempt < cfg.queueRetryMax) {
              notes.push(`第 ${attempt + 1} 次遇到队列已满，等待 ${cfg.queueRetryDelayMs}ms 后重试。`)
              await sleep(cfg.queueRetryDelayMs)
              continue
            }
            throw error
          }
        }
        if (!submitted) throw lastQueueError ?? new AgnesError('Video submit failed', {})

        const record = {
          videoId: submitted.videoId,
          model: args.model || cfg.videoModel,
          prompt: args.prompt,
          requestedSeconds: args.seconds || cfg.videoSeconds,
          requestedSize: args.size || cfg.videoSize,
          requestedAspectRatio: args.aspect_ratio || cfg.videoAspectRatio,
          firstFrame: firstFrame ?? null,
          restagedFirstFrame: restaged,
          status: 'running',
          progress: submitted.progress ?? 0,
          submittedAt: Date.now(),
          cwd: typeof exec?.agent?.cwd === 'string' ? exec.agent.cwd : undefined,
        }
        tasks.set(record.videoId, record)
        await saveTasks()

        const waitMs = Number.isFinite(args.wait_ms) ? Math.max(0, args.wait_ms) : 0
        if (waitMs > 0) {
          const deadline = Date.now() + waitMs
          while (Date.now() < deadline && record.status === 'running') {
            await sleep(Math.min(3000, Math.max(500, config().pollIntervalMs / 3)))
            await advance(record)
          }
        }

        return {
          taskId: record.videoId,
          status: record.status,
          progress: record.progress,
          file: record.file ?? undefined,
          note: [
            ...notes,
            record.status === 'running'
              ? `任务在后台继续轮询；用 agnes_task { action: "status" } 查询，完成后会自动落盘。`
              : '',
          ]
            .filter(Boolean)
            .join(' '),
        }
      },
    }),
  )

  unregister.push(
    tools.register({
      name: 'agnes_task',
      description: 'Inspect, wait for, or stop tracking an Agnes video task submitted by agnes_video.',
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['list', 'status', 'wait', 'cancel'] },
          task_id: { type: 'string', description: 'The video task id (required for status/wait/cancel).' },
          wait_ms: { type: 'number', description: 'For action=wait: how long to wait.' },
        },
        required: ['action'],
        additionalProperties: false,
      },
      output: {
        schema: {
          type: 'object',
          properties: {
            tasks: { type: 'array', items: { type: 'object' } },
            task: { type: 'object' },
            note: { type: 'string' },
          },
        },
        render: (_args, value) => text(value),
      },
      timeoutMs: 900000,
      isConcurrencySafe: () => false,
      async execute(args) {
        if (args.action === 'list') {
          return { tasks: [...tasks.values()].map(taskView) }
        }
        const record = args.task_id ? tasks.get(args.task_id) : undefined
        if (!record) {
          return { note: `未知任务 ${args.task_id ?? '(未提供 task_id)'}；用 action:"list" 查看当前跟踪的任务。` }
        }
        if (args.action === 'status') {
          await advance(record)
          return { task: taskView(record) }
        }
        if (args.action === 'wait') {
          const waitMs = Number.isFinite(args.wait_ms) ? args.wait_ms : 120000
          const deadline = Date.now() + waitMs
          while (Date.now() < deadline && record.status === 'running') {
            await advance(record)
            if (record.status === 'running') await sleep(Math.min(3000, Math.max(500, config().pollIntervalMs / 3)))
          }
          return {
            task: taskView(record),
            note: record.status === 'running' ? '等待超时，任务仍在后台轮询。' : '',
          }
        }
        if (args.action === 'cancel') {
          record.status = 'cancelled'
          record.finishedAt = Date.now()
          await saveTasks()
          return {
            task: taskView(record),
            note: 'Agnes 未公开任务取消端点：这里只停止本地跟踪与落盘，服务端任务可能仍在消耗额度。',
          }
        }
        return { note: `未知 action: ${args.action}` }
      },
    }),
  )

  unregister.push(
    tools.register({
      name: 'agnes_models',
      description: 'List the Agnes models reachable with the currently configured API key.',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      output: {
        schema: { type: 'object', properties: { models: { type: 'array', items: { type: 'string' } } } },
        render: (_args, value) => text(`Agnes models:\n${(value.models ?? []).join('\n')}`),
      },
      timeoutMs: 60000,
      isConcurrencySafe: () => true,
      async execute() {
        const { client: api } = await client()
        return { models: await api.listModels() }
      },
    }),
  )

  ctx.effect(() => () => {
    for (const dispose of unregister) dispose()
  }, 'agnes: tool registrations')

  log(`ready (image=${config().imageModel}, video=${config().videoModel}, store=${storePath})`)
}
