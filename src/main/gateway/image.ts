// 图片生成链路：按供应商能力表分发到三个驱动（能力契约见 shared/image-capabilities.ts）
//   openai-images   —— AI SDK generateImage（OpenAI Images 兼容端点，官方/中转站直接可用）
//   toapis-task     —— ToAPIS gpt-image-2：异步任务（提交 → 轮询 → 下载落盘），参考图先上传换 URL
//   openrouter-chat —— OpenRouter：chat-completions modalities 生图，参考图内联 data URL
// 产物统一走 media 管线 saveBufferAsset 入库，节点侧拿到 MediaAsset 即可展示。
import { generateImage } from 'ai'
import log from 'electron-log/main'
import type { ImageEditInput, ImageGenerateInput } from '../../shared/contracts'
import { IMAGE_EDIT_SIZES } from '../../shared/image-edit'
import { imageCapabilitiesFor, type ImageCapabilities } from '../../shared/image-capabilities'
import type { MediaAsset, ProviderConfig } from '../../shared/types'
import { describeUpstreamHttpError } from '../../shared/upstream-error'
import { readMediaBuffer, saveBufferAsset } from '../store/media.repo'
import { emitGatewayEvent, ensureRequestId } from '../diagnostics/gateway-events'
import type { GatewayDiagnosticsContext } from '../../shared/contracts'
import { createImageModel, GatewayError, requireProvider } from './factory'

// 桌面启动后注入 Chromium 网络栈，图片上传/轮询/下载跟随系统代理。
// 单测未启动 Electron 时保留可模拟的标准 fetch。
// emitGatewayEvent 继续记录请求开始/终态、任务轮询与下载落盘，不在适配器重复记录。
let desktopFetch: typeof globalThis.fetch | undefined
export function setImageNetworkFetch(fetcher: typeof globalThis.fetch | undefined): void {
  desktopFetch = fetcher
}
const imageFetch: typeof globalThis.fetch = (input, init) =>
  (desktopFetch ?? globalThis.fetch)(input, init)

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

/** 上游错误体归一化：中转站会返回 JSON 错误体甚至整页 HTML，节点上只该留下一句能行动的话。 */
async function errorTail(res: Response, context = ''): Promise<string> {
  const body = await res.text().catch(() => '')
  return describeUpstreamHttpError(res.status, body, context).message
}

export async function generateImageToAsset(input: ImageGenerateInput): Promise<MediaAsset> {
  if (!input.prompt?.trim()) throw new GatewayError('INVALID_INPUT', '提示词不能为空')
  const provider = requireProvider(input.providerId)
  const capabilities = imageCapabilitiesFor(provider.specId, input.modelId)
  const promptChars = input.prompt.trim().length
  if (capabilities.maxPromptChars && promptChars > capabilities.maxPromptChars) {
    throw new GatewayError(
      'INVALID_INPUT',
      `该模型提示词上限为 ${capabilities.maxPromptChars} 个字符，当前 ${promptChars} 个`
    )
  }
  // L03：请求边界事件由入口统一发射；远端接受/下载/入库等详细阶段由各驱动补充。
  const requestId = ensureRequestId(input.diagnostics)
  const diagnostics: GatewayDiagnosticsContext = { ...input.diagnostics, requestId }
  const startedAt = Date.now()
  const modelAttributes = {
    operation: 'image.generate',
    providerId: input.providerId,
    modelId: input.modelId
  }
  emitGatewayEvent('model.request.started', '生图请求开始', diagnostics, {
    attributes: modelAttributes
  })
  try {
    let asset: MediaAsset
    switch (capabilities.driver) {
      case 'toapis-task':
        asset = await generateWithToapisTask(provider, input, capabilities, diagnostics)
        break
      case 'openrouter-chat':
        asset = await generateWithOpenRouterChat(provider, input, capabilities)
        break
      default:
        asset = await generateWithOpenAiImages(input, capabilities)
    }
    emitGatewayEvent('model.request.completed', '生图请求完成', diagnostics, {
      status: 'success',
      durationMs: Date.now() - startedAt,
      attributes: { ...modelAttributes, mediaId: asset.id }
    })
    return asset
  } catch (error) {
    emitGatewayEvent('model.request.failed', '生图请求失败', diagnostics, {
      status: 'failed',
      durationMs: Date.now() - startedAt,
      error,
      attributes: modelAttributes
    })
    throw error
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
  // P 图的存量配置里 size 可能存的是比例串（旧版把画幅镜像进 size），同步接口只接受像素尺寸。
  const pixelSize = /^\d+x\d+$/.test(input.size ?? '') ? input.size : undefined
  const { images } = await generateImage({
    model: createImageModel(input.providerId, input.modelId),
    prompt:
      referenceImages.length > 0
        ? { text: prompt, images: [...referenceImages], ...(maskImage ? { mask: maskImage } : {}) }
        : prompt,
    ...(pixelSize ? { size: pixelSize as `${number}x${number}` } : {}),
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
// 4K 任务可能排队数分钟；两张图片由执行器逐张提交，每张单独计时。
const TOAPIS_TIMEOUT_MS = 20 * 60_000
const IMAGE_DOWNLOAD_TIMEOUT_MS = 5 * 60_000
// 官方文档已确认任务查询为 GET /v1/images/generations/{task_id}；后两条只覆盖个别旧中转
// 部署的路径形态，仅在文档路径返回 404 时才会用到，命中结果按供应商缓存。
const TOAPIS_TASK_QUERY_PATHS = ['/images/generations/', '/images/tasks/', '/tasks/']
const toapisTaskQueryPathByProvider = new Map<string, string>()

function toapisNetworkError(phase: string, error: unknown): GatewayError {
  const cause = error instanceof Error ? (error as Error & { cause?: unknown }).cause : undefined
  const detail =
    cause instanceof Error
      ? `${cause.message}${'code' in cause ? ` (${String(cause.code)})` : ''}`
      : error instanceof Error
        ? error.message
        : String(error)
  log.error('toapis image network error', { phase, detail })
  return new GatewayError('UPSTREAM_ERROR', `TOAPIS ${phase}网络失败：${detail}`)
}

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
  const res = await imageFetch(`${base}/uploads/images`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${provider.apiKey}` },
    body: form,
    signal: AbortSignal.timeout(60_000)
  }).catch((error: unknown) => {
    throw toapisNetworkError('参考图上传', error)
  })
  if (!res.ok) {
    throw new GatewayError('TOAPIS_UPLOAD_FAILED', await errorTail(res, '参考图上传失败'))
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
  taskId: string,
  diag?: MediaDiag
): Promise<Record<string, unknown>> {
  const deadline = Date.now() + TOAPIS_TIMEOUT_MS
  const base = provider.baseURL.replace(/\/+$/, '')
  const knownPath = toapisTaskQueryPathByProvider.get(provider.id) ?? null
  let pathResolved = knownPath !== null
  let lastNetworkError = ''
  // L03：轮询只记状态变化与周期汇总，不逐次记录相同结果。
  let lastEmittedState = ''
  let pollCount = 0
  let lastSummaryAt = Date.now()
  let transientErrors = 0
  while (Date.now() < deadline) {
    await delay(TOAPIS_POLL_INTERVAL_MS)
    const candidates = knownPath ? [knownPath] : TOAPIS_TASK_QUERY_PATHS
    let notFoundCount = 0
    for (const path of candidates) {
      const res = await imageFetch(`${base}${path}${taskId}`, {
        headers: { Authorization: `Bearer ${provider.apiKey}` },
        signal: AbortSignal.timeout(30_000)
      }).catch((error: unknown) => {
        lastNetworkError = toapisNetworkError('任务查询', error).message
        return null
      })
      if (!res) {
        transientErrors += 1
        continue
      }
      if (res.status === 404) {
        notFoundCount += 1
        continue
      }
      if (!res.ok) {
        emitGatewayEvent('model.request.attempt_failed', '任务查询失败', diag?.diagnostics, {
          error: { code: 'UPSTREAM_ERROR', status: res.status },
          attributes: { operation: 'image.generate' }
        })
        throw new GatewayError('UPSTREAM_ERROR', await errorTail(res, 'TOAPIS 任务查询失败'))
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

      pollCount += 1
      if (rawStatus && rawStatus !== lastEmittedState) {
        lastEmittedState = rawStatus
        emitGatewayEvent('task.state_changed', '远端任务状态变化', diag?.diagnostics, {
          upstreamTaskId: taskId,
          attributes: { state: rawStatus, operation: 'image.generate' }
        })
      }
      if (Date.now() - lastSummaryAt >= 30_000) {
        lastSummaryAt = Date.now()
        emitGatewayEvent('task.poll_summary', '远端任务轮询汇总', diag?.diagnostics, {
          upstreamTaskId: taskId,
          attributes: {
            state: rawStatus || 'unknown',
            pollCount,
            transientErrors,
            operation: 'image.generate'
          }
        })
      }

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

      if (isCompleted) {
        emitGatewayEvent('task.completed', '远端任务完成', diag?.diagnostics, {
          upstreamTaskId: taskId,
          status: 'success',
          attributes: { state: rawStatus || 'completed', pollCount, operation: 'image.generate' }
        })
        return task
      }
      if (rawStatus === 'failed' || rawStatus === 'error') {
        emitGatewayEvent('task.failed', '远端任务失败', diag?.diagnostics, {
          upstreamTaskId: taskId,
          status: 'failed',
          error: new GatewayError('UPSTREAM_FAILED', '远端生图任务失败'),
          attributes: { state: rawStatus, pollCount, operation: 'image.generate' }
        })
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
  // 超时：远端任务是否最终完成未知，必须保留 taskId 线索，不得断言失败即未计费。
  emitGatewayEvent('task.failed', '远端任务轮询超时，远端结果未知', diag?.diagnostics, {
    upstreamTaskId: taskId,
    status: 'unknown',
    error: new GatewayError('TIMEOUT', 'TOAPIS 生图任务超时'),
    attributes: { state: 'unknown', pollCount, operation: 'image.generate' }
  })
  throw new GatewayError(
    'TIMEOUT',
    `TOAPIS 生图任务超时（20 分钟）${lastNetworkError ? `；最近一次请求：${lastNetworkError}` : ''}`
  )
}

function decodeDataUrl(url: string): { buf: Buffer; ext: string } {
  const match = /^data:image\/([a-z0-9.+-]+);base64,(.+)$/i.exec(url)
  if (!match) throw new GatewayError('EMPTY_RESULT', '返回的图片 data URL 无法解析')
  const ext = EXT_BY_MIME[`image/${match[1].toLowerCase()}`] ?? '.png'
  return { buf: Buffer.from(match[2], 'base64'), ext }
}

interface MediaDiag {
  diagnostics?: GatewayDiagnosticsContext
  taskId?: string
}

async function downloadImageAsAsset(
  projectId: string,
  url: string,
  name: string,
  diag?: MediaDiag
): Promise<MediaAsset> {
  const mediaAttributes = { operation: 'image.generate' }
  emitGatewayEvent('media.download_started', '开始下载生成结果', diag?.diagnostics, {
    attributes: mediaAttributes
  })
  if (/^data:image\//i.test(url)) {
    let asset: MediaAsset
    try {
      const { buf, ext } = decodeDataUrl(url)
      asset = await saveBufferAsset(projectId, buf, ext, name)
    } catch (error) {
      emitGatewayEvent('media.persist_failed', '生成结果入库失败', diag?.diagnostics, {
        ...(diag?.taskId ? { upstreamTaskId: diag.taskId } : {}),
        error,
        attributes: mediaAttributes
      })
      throw error
    }
    emitGatewayEvent('media.persist_completed', '生成结果已入库', diag?.diagnostics, {
      ...(diag?.taskId ? { upstreamTaskId: diag.taskId } : {}),
      attributes: { ...mediaAttributes, mediaId: asset.id, mime: asset.mime }
    })
    return asset
  }
  let buf: Buffer
  let mime = 'image/png'
  try {
    const res = await imageFetch(url, {
      signal: AbortSignal.timeout(IMAGE_DOWNLOAD_TIMEOUT_MS)
    }).catch((error: unknown) => {
      throw toapisNetworkError('图片下载', error)
    })
    if (!res.ok) {
      throw new GatewayError('DOWNLOAD_FAILED', `生成图片下载失败：HTTP ${res.status}`)
    }
    buf = Buffer.from(await res.arrayBuffer())
    mime = res.headers.get('content-type')?.split(';')[0]?.trim() ?? 'image/png'
  } catch (error) {
    emitGatewayEvent('media.download_failed', '生成结果下载失败', diag?.diagnostics, {
      ...(diag?.taskId ? { upstreamTaskId: diag.taskId } : {}),
      error,
      attributes: mediaAttributes
    })
    throw error
  }
  emitGatewayEvent('media.download_completed', '生成结果下载完成', diag?.diagnostics, {
    ...(diag?.taskId ? { upstreamTaskId: diag.taskId } : {}),
    attributes: { ...mediaAttributes, byteSize: buf.length, mime }
  })
  emitGatewayEvent('media.persist_started', '开始写入媒体库', diag?.diagnostics, {
    ...(diag?.taskId ? { upstreamTaskId: diag.taskId } : {}),
    attributes: { ...mediaAttributes, mime }
  })
  try {
    const asset = await saveBufferAsset(projectId, buf, EXT_BY_MIME[mime] ?? '.png', name)
    emitGatewayEvent('media.persist_completed', '生成结果已入库', diag?.diagnostics, {
      ...(diag?.taskId ? { upstreamTaskId: diag.taskId } : {}),
      attributes: { ...mediaAttributes, mediaId: asset.id, mime: asset.mime }
    })
    return asset
  } catch (error) {
    emitGatewayEvent('media.persist_failed', '生成结果入库失败', diag?.diagnostics, {
      ...(diag?.taskId ? { upstreamTaskId: diag.taskId } : {}),
      error,
      attributes: mediaAttributes
    })
    throw error
  }
}

async function generateWithToapisTask(
  provider: ProviderConfig,
  input: ImageGenerateInput,
  capabilities: ImageCapabilities,
  diagnostics?: GatewayDiagnosticsContext
): Promise<MediaAsset> {
  const prompt = input.prompt.trim()
  const referenceIds = uniqueReferenceIds(input).slice(0, capabilities.maxReferenceImages)
  const referenceMedia = await Promise.all(referenceIds.map(readReferenceMedia))
  const referenceUrls: string[] = []
  for (const media of referenceMedia) {
    referenceUrls.push(await toapisUploadReference(provider, media))
  }

  // 提交体只带文档化字段：size 为比例串，resolution 与 background 由能力表放行才发送。
  const body: Record<string, unknown> = {
    model: input.modelId,
    prompt,
    n: 1,
    response_format: 'url'
  }
  if (input.size && input.size !== 'auto') body.size = input.size
  if (capabilities.resolutions.length > 0 && input.resolution) body.resolution = input.resolution
  // VIP defaults to medium upstream; quality is deliberately fixed to low, independent of 4K size.
  if (input.modelId === 'gpt-image-2-vip' || input.modelId === 'gpt-image-2-official') {
    body.quality = 'low'
  }
  if (capabilities.supportsTransparentBackground && input.background === 'transparent')
    body.background = 'transparent'
  if (referenceUrls.length > 0) body.reference_images = referenceUrls

  const base = provider.baseURL.replace(/\/+$/, '')
  log.info('toapis image submit', {
    model: input.modelId,
    resolution: body.resolution,
    quality: body.quality,
    referenceCount: referenceUrls.length
  })
  const res = await imageFetch(`${base}/images/generations`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${provider.apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(60_000)
  }).catch((error: unknown) => {
    throw toapisNetworkError('生图提交', error)
  })
  if (!res.ok) {
    // 401/429/5xx 在此区分：带上状态码供归一化映射稳定错误码。
    emitGatewayEvent('model.request.attempt_failed', '生图提交失败', diagnostics, {
      error: { code: 'UPSTREAM_ERROR', status: res.status },
      attributes: { operation: 'image.generate' }
    })
    throw new GatewayError('UPSTREAM_ERROR', await errorTail(res, 'TOAPIS 生图提交失败'))
  }
  const task = (await res.json().catch(() => null)) as Record<string, unknown> | null
  if (!task || typeof task !== 'object') {
    throw new GatewayError('EMPTY_RESULT', 'TOAPIS 生图提交未返回有效数据')
  }

  const immediateUrl = extractFirstImageValue(task, new Set(referenceUrls))
  if (immediateUrl) {
    return downloadImageAsAsset(input.projectId, immediateUrl, prompt.slice(0, 24), { diagnostics })
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

  // 远端已接受任务：与「本地下载/入库成功」是不同事实，事件分开记录。
  emitGatewayEvent('model.request.accepted', '远端已接受生图任务', diagnostics, {
    upstreamTaskId: taskId,
    attributes: {
      operation: 'image.generate',
      providerId: input.providerId,
      modelId: input.modelId
    }
  })
  const finished = await pollToapisTask(provider, taskId, { diagnostics, taskId })
  const imageUrl = extractFirstImageValue(finished, new Set(referenceUrls))
  if (!imageUrl) throw new GatewayError('EMPTY_RESULT', 'TOAPIS 任务完成但未返回图片')
  return downloadImageAsAsset(input.projectId, imageUrl, prompt.slice(0, 24), {
    diagnostics,
    taskId
  })
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

  const res = await imageFetch(`${provider.baseURL}/chat/completions`, {
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
    throw new GatewayError('UPSTREAM_ERROR', await errorTail(res, 'OpenRouter 生图失败'))
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
    if (input.modelId === 'gpt-image-2-vip' || input.modelId === 'gpt-image-2-official') {
      body.quality = 'low'
    }
    if (referenceUrls.length > 0) body.reference_images = referenceUrls

    const base = provider.baseURL.replace(/\/+$/, '')
    const res = await imageFetch(`${base}/images/generations`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${provider.apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(60_000)
    })
    if (!res.ok) {
      throw new GatewayError('UPSTREAM_ERROR', await errorTail(res, 'TOAPIS 图片修改提交失败'))
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

  // 非 TOAPIS 通道：遮罩与画幅都要真正写进请求，否则节点上就不该出现这两个控件。
  const providerOptions: Record<string, string | number | boolean> = {}
  if (
    capabilities.forwardsAspectRatio &&
    input.config?.aspectRatio &&
    input.config.aspectRatio !== 'auto'
  ) {
    providerOptions.aspectRatio = input.config.aspectRatio
  }
  return generateImageWithReference(
    input,
    referenceImages,
    Object.keys(providerOptions).length > 0 ? providerOptions : undefined,
    maskImage
  )
}
