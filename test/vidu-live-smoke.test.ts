// Opt in only: performs one paid Vidu video generation. Select Q4 (default) or Q3 with VIDU_SMOKE_MODEL.
import { createCanvas } from '@napi-rs/canvas'
import { mkdir, writeFile } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { describe, it, expect, vi } from 'vitest'
vi.mock('../src/main/gateway/factory', () => ({ GatewayError: class extends Error { constructor(public code: string, message: string) { super(message) } } }))
vi.mock('../src/main/store/db', () => ({ getDb: vi.fn() }))
vi.mock('../src/main/store/media.repo', () => ({ getMediaAbsPath: vi.fn() }))
import { pollVidu, runViduJson } from '../src/main/gateway/vidu-cli'
import { VIDU_BASE_URL } from '@shared/vidu-cli'
import { buildViduVideoArgs } from '@shared/vidu-cli'

describe.skipIf(process.env.VIDU_LIVE_SMOKE !== '1')('Vidu Q3/Q4 real CLI smoke', () => {
  it('uploads a synthetic image, submits once, polls the same task and downloads MP4', async () => {
    const token = process.env.VIDU_TOKEN
    expect(token).toBeTruthy()
    const credentials = { apiKey: token!, baseURL: VIDU_BASE_URL }
    const folder = resolve(process.env.VIDU_SMOKE_DIR || `qa/vidu/live-${Date.now()}`)
    await mkdir(folder, { recursive: true })
    const canvas = createCanvas(512, 512)
    const ctx = canvas.getContext('2d')
    ctx.fillStyle = '#eee7da'; ctx.fillRect(0, 0, 512, 512)
    ctx.fillStyle = '#2467b2'; ctx.beginPath(); ctx.arc(256, 256, 100, 0, Math.PI * 2); ctx.fill()
    const image = join(folder, 'reference.png')
    await writeFile(image, canvas.toBuffer('image/png'))
    const model = process.env.VIDU_SMOKE_MODEL === '3.2' ? '3.2' : '3.4'
    const mode = model === '3.2' ? 'first-last-frame' as const : 'reference' as const
    const resolution = model === '3.2' ? '1080p' : '540p'
    const imagePaths = [image]
    if (model === '3.2') {
      const tail = join(folder, 'tail.png')
      ctx.fillStyle = '#eee7da'; ctx.fillRect(0, 0, 512, 512)
      ctx.fillStyle = '#2467b2'; ctx.beginPath(); ctx.arc(330, 256, 100, 0, Math.PI * 2); ctx.fill()
      await writeFile(tail, canvas.toBuffer('image/png'))
      imagePaths.push(tail)
    }
    const taskType = model === '3.2' ? 'headtailimg2video' : 'character2video'
    const args = buildViduVideoArgs({ modelId: model, mode, prompt: 'A blue ball gently moves to the right on a plain beige background. Static camera.', duration: 1, resolution, ratio: '1:1', imagePaths })
    const quote = await runViduJson(credentials, ['task', 'cost', '--type', taskType, '--model-version', model, '--duration', '1', '--resolution', resolution, '--codec', 'h264', ...(model === '3.2' ? ['--transition', 'pro'] : ['--aspect-ratio', '1:1']), '--schedule-mode', 'normal'])
    expect(quote.can_submit).toBe(true)
    const before = await runViduJson(credentials, ['quota', 'credit'])
    const submitted = await runViduJson(credentials, args)
    const taskId = typeof submitted.task_id === 'string' ? submitted.task_id : ''
    expect(taskId).toMatch(/^[A-Za-z0-9_-]{1,200}$/)
    const receipt = { taskId, model, mode, duration: 1, resolution, state: 'accepted', quoteCredits: quote.cost_credits }
    await writeFile(join(folder, 'receipt.json'), JSON.stringify(receipt, null, 2))
    const deadline = Date.now() + 15 * 60_000
    while (Date.now() < deadline) {
      const state = await pollVidu(credentials, taskId)
      if (state.status === 'failed' || state.status === 'cancelled') throw new Error(`Vidu task ${taskId} ${state.status}`)
      if (state.status === 'succeeded' && state.url) {
        const response = await fetch(state.url, { signal: AbortSignal.timeout(60_000) })
        expect(response.ok).toBe(true)
        const video = Buffer.from(await response.arrayBuffer())
        expect(video.subarray(4, 8).toString()).toBe('ftyp')
        await writeFile(join(folder, 'result.mp4'), video)
        const after = await runViduJson(credentials, ['quota', 'credit'])
        await writeFile(join(folder, 'receipt.json'), JSON.stringify({ ...receipt, state: 'success', bytes: video.length, creditsBefore: before.credits, creditsAfter: after.credits }, null, 2))
        return
      }
      await new Promise((resolve) => setTimeout(resolve, 10_000))
    }
    throw new Error(`Vidu task ${taskId} is still pending; inspect original task, do not resubmit`)
  }, 1_000_000)
})
