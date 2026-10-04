/**
 * Agnes AI HTTP client. No DSH or Cordis dependency: this module is importable
 * by the plugin row AND by the standalone smoke script, so the transport layer
 * is testable without booting the harness.
 *
 * Verified against the live API (2026-10):
 * - POST /v1/images/generations -> { data:[{ url, b64_json, revised_prompt }], created, task_id }
 *   `size` accepts pixel pairs ("1024x1024") and tiers ("1K".."4K") with `aspect_ratio`.
 *   `image` accepts a public URL *or* a base64 data URI (image-to-image).
 * - POST /v1/videos -> { id, video_id, task_id, status, progress, seconds, size }
 *   `image` accepts ONLY a public URL: a data URI is accepted by the queue and
 *   then silently dropped (server stores a 3-char placeholder), so the caller
 *   must reject local files here instead of pretending they worked.
 * - GET /agnesapi?video_id=..&model_name=.. -> { status, progress, url, size_mapping, error }
 */

export const DEFAULT_BASE_URL = 'https://apihub.agnes-ai.com'

export class AgnesError extends Error {
  constructor(message, details = {}) {
    super(message)
    this.name = 'AgnesError'
    this.status = details.status ?? 0
    this.kind = details.kind ?? 'other'
    this.hint = details.hint ?? ''
    this.body = details.body ?? ''
  }
}

/** Turn one transport/HTTP failure into a stable kind plus an actionable hint. */
export function classify(status, bodyText) {
  const text = typeof bodyText === 'string' ? bodyText : ''
  const lower = text.toLowerCase()
  if (status === 401 || status === 403) {
    return { kind: 'auth', hint: 'API Key 无效或未授权：检查设置里的 Agnes credential ref 是否已写入值。' }
  }
  if (lower.includes('no available channel') || lower.includes('model_not_found')) {
    return { kind: 'no_channel', hint: '该模型对当前 key 没有可用通道：在设置里换一个默认模型（例如视频换成 agnes-video-v2.0）。' }
  }
  if (lower.includes('queue is full') || lower.includes('queue_full')) {
    return { kind: 'queue_full', hint: 'Agnes 视频队列已满：稍后重试，或减少并发任务。' }
  }
  if (status === 400 || status === 422) {
    return { kind: 'invalid_request', hint: '请求参数被拒绝：检查尺寸档位、宽高比与输入素材。' }
  }
  if (status >= 500) {
    return { kind: 'server', hint: 'Agnes 上游错误：可以重试。' }
  }
  return { kind: 'other', hint: '' }
}

function asJson(text) {
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

export function createAgnesClient(options = {}) {
  const baseUrl = (options.baseUrl || DEFAULT_BASE_URL).replace(/\/+$/, '')
  const apiKey = options.apiKey
  const fetchImpl = options.fetchImpl || globalThis.fetch

  async function request(path, init = {}, timeoutMs = 180000) {
    if (!apiKey) {
      throw new AgnesError('Agnes API key is not configured', {
        kind: 'auth',
        hint: '在 DSH 设置的 Agnes 页填写 API Key（写入 credential ref），或设置同名环境变量。',
      })
    }
    const signal = init.signal ?? AbortSignal.timeout(timeoutMs)
    let response
    try {
      response = await fetchImpl(`${baseUrl}${path}`, {
        ...init,
        signal,
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
          ...(init.headers || {}),
        },
      })
    } catch (error) {
      throw new AgnesError(`Agnes request failed: ${error?.message ?? error}`, {
        kind: 'network',
        hint: '无法连接 Agnes：检查网络与 baseUrl。',
      })
    }
    const text = await response.text()
    if (!response.ok) {
      const { kind, hint } = classify(response.status, text)
      throw new AgnesError(`Agnes HTTP ${response.status}: ${text.slice(0, 500)}`, {
        status: response.status,
        kind,
        hint,
        body: text,
      })
    }
    const json = asJson(text)
    if (json === undefined) {
      throw new AgnesError('Agnes returned a non-JSON body', { status: response.status, body: text.slice(0, 500) })
    }
    return json
  }

  return {
    baseUrl,

    async listModels() {
      const json = await request('/v1/models', { method: 'GET' }, 60000)
      return (json.data ?? []).map((entry) => entry.id).filter((id) => typeof id === 'string')
    },

    /** Text-to-image, image-to-image, or multi-reference image generation. */
    async generateImage({ prompt, model = 'agnes-image-2.5-flash', size = '1K', aspectRatio, images = [], signal }) {
      const body = { model, prompt }
      if (size) body.size = size
      if (aspectRatio) body.aspect_ratio = aspectRatio
      if (images.length === 1) body.image = images[0]
      else if (images.length > 1) body.images = images
      const json = await request('/v1/images/generations', { method: 'POST', body: JSON.stringify(body), signal }, 600000)
      const first = (json.data ?? [])[0] ?? {}
      return {
        url: first.url,
        b64Length: typeof first.b64_json === 'string' ? first.b64_json.length : 0,
        revisedPrompt: first.revised_prompt || '',
        taskId: json.task_id,
        requestedSize: size,
        requestedAspectRatio: aspectRatio ?? null,
      }
    },

    /** Submit an asynchronous video task. `image` must be a public URL. */
    async submitVideo({ prompt, model = 'agnes-video-v2.0', image, seconds, size, aspectRatio, height, width, numFrames, frameRate, signal }) {
      const body = { model, prompt }
      if (image) body.image = image
      if (seconds) body.seconds = String(seconds)
      if (size) body.size = size
      if (aspectRatio) body.aspect_ratio = aspectRatio
      if (height) body.height = height
      if (width) body.width = width
      if (numFrames) body.num_frames = numFrames
      if (frameRate) body.frame_rate = frameRate
      const json = await request('/v1/videos', { method: 'POST', body: JSON.stringify(body), signal }, 120000)
      return {
        videoId: json.video_id,
        taskId: json.task_id ?? json.id,
        status: json.status ?? 'queued',
        progress: json.progress ?? 0,
        seconds: json.seconds ?? null,
        size: json.size ?? null,
      }
    },

    /** Read one video task. */
    async pollVideo(videoId, model) {
      const query = `video_id=${encodeURIComponent(videoId)}&model_name=${encodeURIComponent(model)}`
      const json = await request(`/agnesapi?${query}`, { method: 'GET' }, 60000)
      return {
        status: json.status,
        progress: json.progress ?? 0,
        internalStatus: json.internal_status ?? '',
        url: json.url ?? undefined,
        error: json.error ? String(json.error?.message ?? JSON.stringify(json.error)) : undefined,
        size: json.size ?? null,
        seconds: json.seconds ?? null,
        sizeMapping: json.size_mapping ? { adjusted: json.size_mapping.adjusted, message: json.size_mapping.message } : undefined,
        requestParams: json.request_params
          ? {
              mode: json.request_params.mode,
              image: json.request_params.image === null ? null : String(json.request_params.image).slice(0, 200),
              frameRate: json.request_params.frame_rate,
              numFrames: json.request_params.num_frames,
            }
          : undefined,
      }
    },

    /** Download one remote artifact to bytes. */
    async download(url, signal) {
      const response = await fetchImpl(url, { signal: signal ?? AbortSignal.timeout(600000) })
      if (!response.ok) {
        throw new AgnesError(`Download failed HTTP ${response.status} for ${url}`, { status: response.status, kind: 'download' })
      }
      return Buffer.from(await response.arrayBuffer())
    },
  }
}

/** True for a value the video endpoint can consume as a first frame. */
export function isPublicUrl(value) {
  return typeof value === 'string' && /^https?:\/\//i.test(value)
}

/** True for a local path or a base64 data URI, i.e. what only images/ accepts. */
export function toImageInput(value) {
  if (typeof value !== 'string' || value.length === 0) return undefined
  if (/^data:image\//i.test(value)) return value
  if (/^https?:\/\//i.test(value)) return value
  return undefined
}
