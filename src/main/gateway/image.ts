// 图片生成链路：按供应商能力表分发到三个驱动（能力契约见 shared/image-capabilities.ts）
//   openai-images   —— AI SDK generateImage（OpenAI Images 兼容端点，官方/中转站直接可用）
//   toapis-task     —— ToAPIS gpt-image-2：异步任务（提交 → 轮询 → 下载落盘），参考图先上传换 URL
//   openrouter-chat —— OpenRouter：chat-completions modalities 生图，参考图内联 data URL
// 产物统一走 media 管线 saveBufferAsset 入库，节点侧拿到 MediaAsset 即可展示。
import { generateImage } from 'ai'
import type { ImageEditInput, ImageGenerateInput } from '../../shared/contracts'
import { IMAGE_EDIT_SIZES } from '../../shared/image-edit'
import { imageCapabilitiesFor, type ImageCapabilities } from '../../shared/image-capabilities'
import type { MediaAsset, ProviderConfig } from '../../shared/types'
import { readMediaBuffer, saveBufferAsset } from '../store/media.repo'
import { createImageModel, GatewayError, requireProvider } from './factory'

const EXT_BY_MIME: Record<string, string> = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/webp': '.webp',
  'image/gif': '.gif'
}

/** 读取图库原始文件；图生图输入始终引用本地媒体，主进程负责按驱动转换格式。 */
async function readReferenceMedia(mediaId: string): Promise<{ buf: Buffer; mime: string }> {
  const m = await readMediaBuffer(mediaId)
  if (!m) throw new GatewayError('MEDIA_NOT_FOUND', `参考图不存在：${mediaId}`)
  return m
}

function uniqueReferenceIds(
  input: Pick<ImageGenerateInput, 'referenceMediaId' | 'referenceMediaIds'>
): string[] {
  // 旧的单参考图字段与新 many 端口合并，保持旧项目可运行。
  return [...new Set([input.referenceMediaId, ...(input.referenceMediaIds ?? [])])].filter(
    (id): id is string => typeof id === 'string' && Boolean(id)
  )
}

async function errorTail(res: Response): Promise<string> {
  const body = await res.text().catch(() => '')
  return body ? `：${body.slice(0, 180)}` : ''
}

export async function generateImageToAsset(input: ImageGenerateInput): Promise<MediaAsset> {
  if (!input.prompt?.trim()) throw new GatewayError('INVALID_INPUT', '提示词不能为空')
  const provider = requireProvider(input.providerId)
  const capabilities = imageCapabilitiesFor(provider.specId, input.modelId)
  switch (capabilities.driver) {
    case 'toapis-task':
      return generateWithToapisTask(provider, input, capabilities)
    case 'openrouter-chat':
      return generateWithOpenRouterChat(provider, input, capabilities)
    default:
      return generateWithOpenAiImages(input, capabilities)
  }
}

// ── 驱动一：OpenAI Images 兼容（AI SDK；OpenAI 官方与自定义中转站） ─────────

async function generateWithOpenAiImages(
  input: ImageGenerateInput,
  capabilities: ImageCapabilities
): Promise<MediaAsset> {
  const referenceIds = uniqueReferenceIds(input).slice(0, capabilities.maxReferenceImages)
  const referenceImages = await Promise.all(referenceIds.map(readReferenceMedia))
  // 供应商扩展参数只在能力表声明时提交，绝不静默猜测模型能力。
  const providerOptions: Record<string, string | number | boolean> = {}
  if (capabilities.forwardsAspectRatio && input.aspectRatio && input.aspectRatio !== 'auto') {
    providerOptions.aspectRatio = input.aspectRatio
  }
  if (capabilities.supportsQuality) providerOptions.quality = 'low'
  if (capabilities.resolutions.length > 0 && input.resolution) {
    providerOptions.resolution = input.resolution
  }
  return generateImageWithReference(
    input,
    referenceImages.map((m) => m.buf),
    Object.keys(providerOptions).length > 0 ? providerOptions : undefined
  )
}

async function generateImageWithReference(
  input: Pick<ImageGenerateInput, 'projectId' | 'providerId' | 'modelId' | 'prompt' | 'size'>,
  referenceImages: readonly Buffer[] = [],
  providerOptions?: Record<string, string | number | boolean>,
  maskImage?: Buffer
): Promise<MediaAsset> {
  const prompt = input.prompt.trim()
  const { images } = await generateImage({
    model: createImageModel(input.providerId, input.modelId),
    prompt:
      referenceImages.length > 0
        ? { text: prompt, images: [...referenceImages], ...(maskImage ? { mask: maskImage } : {}) }
        : prompt,
    ...(input.size && input.size !== 'auto' ? { size: input.size as `${number}x${number}` } : {}),
    ...(providerOptions && Object.keys(providerOptions).length > 0
      ? { providerOptions: { [input.providerId]: providerOptions } }
      : {})
  })
  if (!images?.length) throw new GatewayError('EMPTY_RESULT', '模型未返回图片')
  const img = images[0]
  return saveBufferAsset(
    input.projectId,
    Buffer.from(img.uint8Array),
    EXT_BY_MIME[img.mediaType] ?? '.png',
    prompt.slice(0, 24)
  )
}

// ── 驱动二：ToAPIS 异步任务（gpt-image-2） ─────────────────────────────────

const TOAPIS_POLL_INTERVAL_MS = 2_500
const TOAPIS_TIMEOUT_MS = 10 * 60_000
// ToAPIS 文档在开发环境不可抓取（DNS 受限）；任务查询端点按常见形态给出候选，
// 首个命中的路径按供应商缓存。验收阶段用真实 Key 冒烟确认并收紧本表。
// （docs/IMAGE_PROVIDER_GATEWAY_PLAN.md §10）
const TOAPIS_TASK_QUERY_PATHS = ['/images/tasks/', '/tasks/', '/images/generations/']
const toapisTaskQueryPathByProvider = new Map<string, string>()


const delay = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms)
  })

/**
 * 从未知结构的响应里提取第一个图片值（http(s) URL 或 data:image URL）。
 * 文档未给出任务完成/上传响应的确切结构，按常见字段优先 + 文档序遍历实现，
 * 并排除本次已上传的参考图 URL，避免把回显的输入当结果。
 */
function extractFirstImageValue(
  value: unknown,
  exclude: ReadonlySet<string>,
  depth = 0
): string | null {
  if (depth > 6 || value == null) return null
  if (typeof value === 'string') {
    if (exclude.has(value)) return null
    if (/^https?:\/\//i.test(value) || /^data:image\//i.test(value)) return value
    return null
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = extractFirstImageValue(item, exclude, depth + 1)
      if (found) return found
    }
    return null
  }
  if (typeof value === 'object') {
    const obj = value as Record<string, unknown>
    for (const key of ['url', 'image_url', 'imageUrl', 'images', 'data', 'output', 'result']) {
      if (key in obj) {
        const found = extractFirstImageValue(obj[key], exclude, depth + 1)
        if (found) return found
      }
    }
    for (const item of Object.values(obj)) {
      const found = extractFirstImageValue(item, exclude, depth + 1)
      if (found) return found
    }
  }
  return null
}

/** 上传本地参考图换公开 URL；失败必须给可操作错误，不允许静默丢弃参考图。 */
async function toapisUploadReference(
  provider: ProviderConfig,
  media: { buf: Buffer; mime: string }
): Promise<string> {
  const form = new FormData()
  form.append(
    'file',
    new Blob([new Uint8Array(media.buf)], { type: media.mime }),
    `reference-${Date.now()}`
  )
  const base = provider.baseURL.replace(/\/+$/, '')
  const res = await fetch(`${base}/uploads/images`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${provider.apiKey}` },
    body: form,
    signal: AbortSignal.timeout(60_000)
  })
  if (!res.ok) {
    throw new GatewayError(
      'TOAPIS_UPLOAD_FAILED',
      `参考图上传失败：HTTP ${res.status}${await errorTail(res)}`
    )
  }
  const json: unknown = await res.json().catch(() => null)
  const url = extractFirstImageValue(json, new Set())
  if (!url || url.startsWith('data:')) {
    throw new GatewayError('TOAPIS_UPLOAD_FAILED', '参考图上传完成但未返回可用的图片 URL')
  }
  return url
}

function toapisTaskErrorMessage(task: Record<string, unknown>): string {
  const err = task.error ?? (task.data as Record<string, unknown>)?.error
  if (typeof err === 'string' && err.trim()) return err.slice(0, 300)
  if (err && typeof err === 'object') {
    const msg =
      (err as Record<string, unknown>).message ||
      (err as Record<string, unknown>).msg ||
      (err as Record<string, unknown>).detail
    if (typeof msg === 'string' && msg.trim()) return msg.slice(0, 300)
  }
  const failReason =
    task.fail_reason ||
    task.failure_reason ||
    (task.data as Record<string, unknown>)?.fail_reason ||
    task.message ||
    task.msg
  if (typeof failReason === 'string' && failReason.trim()) return failReason.slice(0, 300)
  return `TOAPIS 生图任务失败（status=${String(task.status ?? (task.data as Record<string, unknown>)?.status ?? 'failed')}）`
}

async function pollToapisTask(
  provider: ProviderConfig,
  taskId: string
): Promise<Record<string, unknown>> {
  const deadline = Date.now() + TOAPIS_TIMEOUT_MS
  const base = provider.baseURL.replace(/\/+$/, '')
  const knownPath = toapisTaskQueryPathByProvider.get(provider.id) ?? null
  let pathResolved = knownPath !== null
  while (Date.now() < deadline) {
    await delay(TOAPIS_POLL_INTERVAL_MS)
    const candidates = knownPath ? [knownPath] : TOAPIS_TASK_QUERY_PATHS
    let notFoundCount = 0
    for (const path of candidates) {
      const res = await fetch(`${base}${path}${taskId}`, {
        headers: { Authorization: `Bearer ${provider.apiKey}` },
        signal: AbortSignal.timeout(30_000)
      }).catch(() => null)
      if (!res) continue
      if (res.status === 404) {
        notFoundCount += 1
        continue
      }
      if (!res.ok) {
        throw new GatewayError(
          'UPSTREAM_ERROR',
          `TOAPIS 任务查询失败：HTTP ${res.status}${await errorTail(res)}`
        )
      }
      const json: unknown = await res.json().catch(() => null)
      if (!json || typeof json !== 'object') {
        throw new GatewayError('EMPTY_RESULT', 'TOAPIS 任务查询返回了非结构化数据')
      }
      if (!pathResolved) {
        toapisTaskQueryPathByProvider.set(provider.id, path)
        pathResolved = true
      }
      const task = json as Record<string, unknown>
      const rawStatus = (
        (typeof task.status === 'string' ? task.status : '') ||
        (typeof (task.data as Record<string, unknown>)?.status === 'string'
          ? ((task.data as Record<string, unknown>).status as string)
          : '')
      ).toLowerCase()

      const isCompleted =
        rawStatus === 'completed' ||
        rawStatus === 'success' ||
        rawStatus === 'succeeded' ||
        rawStatus === 'done' ||
        rawStatus === 'finished' ||
        (Boolean(extractFirstImageValue(task, new Set())) &&
          rawStatus !== 'failed' &&
          rawStatus !== 'error' &&
          rawStatus !== 'in_progress' &&
          rawStatus !== 'queued' &&
          rawStatus !== 'processing' &&
          rawStatus !== 'pending')

      if (isCompleted) return task
      if (rawStatus === 'failed' || rawStatus === 'error') {
        throw new GatewayError('TOAPIS_TASK_FAILED', toapisTaskErrorMessage(task))
      }
      break
    }
    if (!pathResolved && notFoundCount === candidates.length) {
      throw new GatewayError(
        'UPSTREAM_ERROR',
        `TOAPIS 任务查询端点不可用（尝试过：${candidates.join('、')}）`
      )
    }
  }
  throw new GatewayError('TIMEOUT', 'TOAPIS 生图任务超时（10 分钟）')
}

function decodeDataUrl(url: string): { buf: Buffer; ext: string } {
  const match = /^data:image\/([a-z0-9.+-]+);base64,(.+)$/i.exec(url)
  if (!match) throw new GatewayError('EMPTY_RESULT', '返回的图片 data URL 无法解析')
  const ext = EXT_BY_MIME[`image/${match[1].toLowerCase()}`] ?? '.png'
  return { buf: Buffer.from(match[2], 'base64'), ext }
}

async function downloadImageAsAsset(
  projectId: string,
  url: string,
  name: string
): Promise<MediaAsset> {
  if (/^data:image\//i.test(url)) {
    const { buf, ext } = decodeDataUrl(url)
    return saveBufferAsset(projectId, buf, ext, name)
  }
  const res = await fetch(url, { signal: AbortSignal.timeout(120_000) })
  if (!res.ok) throw new GatewayError('DOWNLOAD_FAILED', `生成图片下载失败：HTTP ${res.status}`)
  const buf = Buffer.from(await res.arrayBuffer())
  const mime = res.headers.get('content-type')?.split(';')[0]?.trim() ?? 'image/png'
  return saveBufferAsset(projectId, buf, EXT_BY_MIME[mime] ?? '.png', name)
}

async function generateWithToapisTask(
  provider: ProviderConfig,
  input: ImageGenerateInput,
  capabilities: ImageCapabilities
): Promise<MediaAsset> {
  const prompt = input.prompt.trim()
  const referenceIds = uniqueReferenceIds(input).slice(0, capabilities.maxReferenceImages)
  const referenceMedia = await Promise.all(referenceIds.map(readReferenceMedia))
  const referenceUrls: string[] = []
  for (const media of referenceMedia) {
    referenceUrls.push(await toapisUploadReference(provider, media))
  }

  // 提交体按 ToAPIS 文档：size 为比例串，resolution/quality 仅在能力表允许时携带。
  const body: Record<string, unknown> = {
    model: input.modelId,
    prompt,
    n: 1,
    response_format: 'url'
  }
  if (input.size && input.size !== 'auto') body.size = input.size
  if (capabilities.resolutions.length > 0 && input.resolution) body.resolution = input.resolution
  if (capabilities.supportsQuality) body.quality = 'low'
  if (referenceUrls.length > 0) body.reference_images = referenceUrls

  const base = provider.baseURL.replace(/\/+$/, '')
  const res = await fetch(`${base}/images/generations`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${provider.apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(60_000)
  })
  if (!res.ok) {
    throw new GatewayError(
      'UPSTREAM_ERROR',
      `TOAPIS 生图提交失败：HTTP ${res.status}${await errorTail(res)}`
    )
  }
  const task = (await res.json().catch(() => null)) as Record<string, unknown> | null
  if (!task || typeof task !== 'object') {
    throw new GatewayError('EMPTY_RESULT', 'TOAPIS 生图提交未返回有效数据')
  }

  const immediateUrl = extractFirstImageValue(task, new Set(referenceUrls))
  if (immediateUrl) {
    return downloadImageAsAsset(input.projectId, immediateUrl, prompt.slice(0, 24))
  }

  const rawTaskId =
    task.id ??
    task.task_id ??
    task.taskId ??
    (task.data as Record<string, unknown>)?.id ??
    (task.data as Record<string, unknown>)?.task_id
  const taskId = typeof rawTaskId === 'string' && rawTaskId.trim() ? rawTaskId.trim() : null
  if (!taskId) {
    throw new GatewayError(
      'EMPTY_RESULT',
      `TOAPIS 未返回任务 ID（响应：${JSON.stringify(task).slice(0, 150)}）`
    )
  }

  const finished = await pollToapisTask(provider, taskId)
  const imageUrl = extractFirstImageValue(finished, new Set(referenceUrls))
  if (!imageUrl) throw new GatewayError('EMPTY_RESULT', 'TOAPIS 任务完成但未返回图片')
  return downloadImageAsAsset(input.projectId, imageUrl, prompt.slice(0, 24))
}

// ── 驱动三：OpenRouter chat 生图（modalities: ['image', 'text']） ──────────

interface OpenRouterImagePart {
  type?: unknown
  image_url?: { url?: unknown } | unknown
  url?: unknown
}

async function generateWithOpenRouterChat(
  provider: ProviderConfig,
  input: ImageGenerateInput,
  capabilities: ImageCapabilities
): Promise<MediaAsset> {
  const prompt = input.prompt.trim()
  const referenceIds = uniqueReferenceIds(input).slice(0, capabilities.maxReferenceImages)
  const content: Array<Record<string, unknown>> = [{ type: 'text', text: prompt }]
  for (const id of referenceIds) {
    const media = await readReferenceMedia(id)
    content.push({
      type: 'image_url',
      image_url: { url: `data:${media.mime};base64,${media.buf.toString('base64')}` }
    })
  }

  const res = await fetch(`${provider.baseURL}/chat/completions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${provider.apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: input.modelId,
      modalities: ['image', 'text'],
      messages: [{ role: 'user', content }]
    }),
    signal: AbortSignal.timeout(180_000)
  })
  if (!res.ok) {
    throw new GatewayError(
      'UPSTREAM_ERROR',
      `OpenRouter 生图失败：HTTP ${res.status}${await errorTail(res)}`
    )
  }
  const json: unknown = await res.json().catch(() => null)
  const message = (
    json as { choices?: Array<{ message?: { images?: OpenRouterImagePart[] } }> } | null
  )?.choices?.[0]?.message
  const imageUrl = extractFirstImageValue(message?.images ?? null, new Set())
  if (!imageUrl) throw new GatewayError('EMPTY_RESULT', '模型未返回图片')
  return downloadImageAsAsset(input.projectId, imageUrl, prompt.slice(0, 24))
}

// ── 图片修改（P图节点）：保持 OpenAI Images 兼容提交，原始图片不被覆写 ──────

/** 图片修改会同时携带原图和标注参考图，原始图片不会被覆写。 */
export async function generateImageEditToAsset(
  input: ImageEditInput,
  referenceImages: readonly Buffer[],
  maskImage?: Buffer
): Promise<MediaAsset> {
  const prompt = input.prompt?.trim() ?? ''
  if (!prompt) throw new GatewayError('INVALID_INPUT', '修改说明不能为空')
  if (prompt.length > 8000) throw new GatewayError('INVALID_INPUT', '修改说明超过 8000 字')
  if (input.size && !IMAGE_EDIT_SIZES.includes(input.size as (typeof IMAGE_EDIT_SIZES)[number])) {
    throw new GatewayError('INVALID_INPUT', '图片修改尺寸不受支持')
  }
  const provider = requireProvider(input.providerId)
  const capabilities = imageCapabilitiesFor(provider.specId, input.modelId)

  if (capabilities.driver === 'toapis-task') {
    const referenceUrls: string[] = []
    for (const buf of referenceImages) {
      referenceUrls.push(await toapisUploadReference(provider, { buf, mime: 'image/png' }))
    }
    const size =
      input.config?.aspectRatio && input.config.aspectRatio !== 'auto'
        ? input.config.aspectRatio
        : input.size && input.size !== 'auto'
          ? input.size
          : undefined

    const body: Record<string, unknown> = {
      model: input.modelId,
      prompt,
      n: 1,
      response_format: 'url'
    }
    if (size) body.size = size
    if (capabilities.resolutions.length > 0 && input.config?.resolution) {
      body.resolution = input.config.resolution
    }
    if (capabilities.supportsQuality) body.quality = 'low'
    if (referenceUrls.length > 0) body.reference_images = referenceUrls

    const base = provider.baseURL.replace(/\/+$/, '')
    const res = await fetch(`${base}/images/generations`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${provider.apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(60_000)
    })
    if (!res.ok) {
      throw new GatewayError(
        'UPSTREAM_ERROR',
        `TOAPIS 图片修改提交失败：HTTP ${res.status}${await errorTail(res)}`
      )
    }
    const task = (await res.json().catch(() => null)) as Record<string, unknown> | null
    if (!task || typeof task !== 'object') {
      throw new GatewayError('EMPTY_RESULT', 'TOAPIS 图片修改提交未返回有效数据')
    }

    const immediateUrl = extractFirstImageValue(task, new Set(referenceUrls))
    if (immediateUrl) {
      return downloadImageAsAsset(input.projectId, immediateUrl, prompt.slice(0, 24))
    }

    const rawTaskId =
      task.id ??
      task.task_id ??
      task.taskId ??
      (task.data as Record<string, unknown>)?.id ??
      (task.data as Record<string, unknown>)?.task_id
    const taskId = typeof rawTaskId === 'string' && rawTaskId.trim() ? rawTaskId.trim() : null
    if (!taskId) {
      throw new GatewayError(
        'EMPTY_RESULT',
        `TOAPIS 未返回任务 ID（响应：${JSON.stringify(task).slice(0, 150)}）`
      )
    }

    const finished = await pollToapisTask(provider, taskId)
    const imageUrl = extractFirstImageValue(finished, new Set(referenceUrls))
    if (!imageUrl) throw new GatewayError('EMPTY_RESULT', 'TOAPIS 任务完成但未返回图片')
    return downloadImageAsAsset(input.projectId, imageUrl, prompt.slice(0, 24))
  }

  return generateImageWithReference(input, referenceImages, undefined, maskImage)
}
