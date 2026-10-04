/**
 * Standalone smoke test for the dsh-agnes transport layer.
 *
 * Runs the exact code path the plugin row uses, without booting DSH, so a
 * failure here is a transport/API problem and never a composition problem.
 *
 *   node scripts/smoke.mjs            # auth + image + image-edit + video submit
 *   node scripts/smoke.mjs --video-wait   # additionally follow the video to completion
 *
 * The API key is read from AGNES_API_KEY; it is never written anywhere.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'

import { createAgnesClient, isPublicUrl } from '../lib/agnes-api.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
// Default to the OS temp area: a sandboxed child process may not hold write
// access to the checkout, while the plugin itself (host process) writes into
// the workspace at runtime.
const outDir = process.env.AGNES_SMOKE_OUT || path.join(os.tmpdir(), 'agnes-smoke')
const apiKey = process.env.AGNES_API_KEY
const videoWait = process.argv.includes('--video-wait')

if (!apiKey) {
  console.error('AGNES_API_KEY is not set')
  process.exit(2)
}

const api = createAgnesClient({ apiKey })
await mkdir(outDir, { recursive: true })

const step = (n, title) => console.log(`\n=== ${n}. ${title} ===`)
const ok = (message) => console.log(`    ok: ${message}`)

step(1, 'auth / model catalog')
const models = await api.listModels()
ok(`${models.length} models: ${models.join(', ')}`)

step(2, 'text-to-image (1K)')
const image = await api.generateImage({ prompt: 'a red apple on a white marble table, studio light', size: '1K' })
ok(`url=${image.url}`)
const imageBytes = await api.download(image.url)
const imageFile = path.join(outDir, 'smoke-image.png')
await writeFile(imageFile, imageBytes)
ok(`saved ${imageFile} (${imageBytes.length} bytes)`)

step(3, 'image-to-image from a LOCAL file (base64 data URI)')
const dataUri = `data:image/png;base64,${(await readFile(imageFile)).toString('base64')}`
const edited = await api.generateImage({
  prompt: 'change the apple to a green apple, keep the composition',
  size: '1K',
  images: [dataUri],
})
ok(`url=${edited.url}`)
const editedFile = path.join(outDir, 'smoke-image-edit.png')
await writeFile(editedFile, await api.download(edited.url))
ok(`saved ${editedFile}`)

step(4, 'video submit (text-to-video, agnes-video-v2.0)')
const submitted = await api.submitVideo({
  prompt: 'a silver sports car drives slowly through a neon-lit street after rain, cinematic',
  seconds: '5',
  size: '720P',
  aspectRatio: '16:9',
})
ok(`videoId=${submitted.videoId} status=${submitted.status} seconds=${submitted.seconds} size=${submitted.size}`)

if (videoWait) {
  step(5, 'video poll to completion')
  const deadline = Date.now() + 8 * 60 * 1000
  let last = ''
  while (Date.now() < deadline) {
    const poll = await api.pollVideo(submitted.videoId, 'agnes-video-v2.0')
    const line = `status=${poll.status} progress=${poll.progress} internal=${poll.internalStatus}`
    if (line !== last) {
      console.log(`    ${line}`)
      last = line
    }
    if (poll.status === 'completed' || poll.status === 'failed') {
      if (poll.status === 'failed') throw new Error(`video failed: ${poll.error}`)
      ok(`size_mapping=${JSON.stringify(poll.sizeMapping)} frame=${JSON.stringify(poll.requestParams)}`)
      const file = path.join(outDir, 'smoke-video.mp4')
      await writeFile(file, await api.download(poll.url))
      ok(`saved ${file}`)
      break
    }
    await new Promise((resolve) => setTimeout(resolve, 5000))
  }
}

console.log('\nAll smoke steps passed. Output:', outDir)
