import { fixedFlowMedia, type FlowMediaRef } from '../agent-flow/image-assets'
import { videoReworkPrompt } from '../agent-flow/video-rework'
import { VIDEO_FLOW_MAX_REFERENCES } from '../../shared/agent-flow/video-adapter'
// 视频生成任务管理：MiniMax H3 与 Seedance 的统一任务式适配
// 两家 API 均为 content[] 多模态 + 异步任务 + 轮询（见调研报告 §3.3）：
//   MiniMax  POST {base}/v2/video_generation            → task_id
//           GET  {base}/v2/query/video_generation/{id}  → task.status / task.content.url
//   Seedance POST {base}/contents/generations/tasks     → id
//           GET  {base}/contents/generations/tasks/{id} → status / content.video_url
// 任务落 tasks 表（upstreamTaskId 存 input JSON），应用重启后恢复轮询
import { nanoid } from 'nanoid'
import { createHash } from 'node:crypto'
import { queryArkTask } from './video-task-control'
import { canonicalFlowJson } from '../../shared/agent-flow/semantic-revision'
import { Readable } from 'stream'
import { pipeline } from 'stream/promises'
import { createWriteStream } from 'fs'
import { unlink } from 'fs/promises'
import { join } from 'path'
import type { GatewayEvent, VideoSubmitInput, VideoSubmitResult } from '../../shared/contracts'
import type { ProviderConfig, VideoGenerationMode, VideoTaskInfo } from '../../shared/types'
import { getDb, getDataDir } from '../store/db'
import { readMediaBuffer } from '../store/media.repo'
import { materializeVideoAsset, recoverVideoAsset } from './video-materialization'
import { GraphWriteInProgressError } from '../../shared/graph-snapshot-sync'
import { CommandLeaseSchema, NodeExecuteCommandSchema } from '../../shared/agent-flow/commands'
import { GatewayError } from './factory'
import { emitGatewayEvent, ensureRequestId } from '../diagnostics/gateway-events'
import { newTraceId, newSpanId } from '@shared/observability'
import type { GatewayDiagnosticsContext } from '../../shared/contracts'
import {
  CONTROL_TIMEOUT_MS,
  DOWNLOAD_TIMEOUT_MS,
  fetchUpstream,
  UpstreamStatusError
} from './upstream-fetch'
import { getProvider } from './providers.repo'
import { pollVideoWithDreamina, submitVideoWithDreamina } from './dreamina-cli'
import { describeUpstreamHttpError } from '../../shared/upstream-error'
import {
  providerDriftMessage,
  snapshotProviderConnection,
  type ProviderConnectionSnapshot
} from '../../shared/provider-connection'
import {
  canonicalVideoModelId,
  videoCapabilitiesFor,
  videoCapabilityIssues,
  isSeedanceGatewayProxy
} from '../../shared/video-capabilities'
import {
  videoReferenceAssetIssues,
  type VideoReferenceAssetInput
} from '../../shared/video-reference-validation'

type Send = (e: GatewayEvent) => void

// 官方建议轮询间隔 10s，避免对服务端造成压力
const POLL_INTERVAL_MS = 10_000
const VIDEO_TIMEOUT_MS = 30 * 60 * 1000
// 提交被 429 拒绝时的退避重试预算；只覆盖「任务还没建起来」这一种失败。
const SUBMIT_RETRY_DELAYS_MS = [5_000, 15_000]

interface TaskRow {
  id: string
  provider_id: string
  model_id: string
  node_id: string
  project_id: string
  status: string
  input: string | null
  output: string | null
  error: string | null
  created_at: number
  updated_at: number
}

interface VideoInputState {
  flowCommandId?: string
  prompt: string
  mode?: VideoGenerationMode
  params?: VideoSubmitInput['params']
  firstFrameMediaId?: string
  lastFrameMediaId?: string
  referenceImageMediaIds?: string[]
  referenceVideoMediaIds?: string[]
  referenceVideoMediaId?: string
  referenceAudioMediaIds?: string[]
  upstreamTaskId?: string
  /** 提交时刻的供应商连接，续查前用于检测漂移 */
  connection?: ProviderConnectionSnapshot
  credentialHash?: string
  cancelRequested?: boolean
}

export interface UpstreamState {
  status: 'running' | 'succeeded' | 'failed' | 'cancelled' | 'unknown'
  url?: string
  error?: string
}

const cancelled = new Set<string>()
const liveRuns = new Map<string, { stopped: boolean }>()
const controls = new Map<string, Promise<VideoTaskInfo | null>>()
function credentialHash(p: ProviderConfig): string {
  return createHash('sha256').update(p.apiKey).digest('hex')
}
const UNKNOWN_VIDEO = '远端结果尚未确认；再次执行仅核对原任务，不会重新提交或重复计费'
function markUnknown(taskId: string): void {
  updateTask(taskId, { status: 'unknown', error: UNKNOWN_VIDEO })
}

function submittedMode(input: VideoSubmitInput): VideoGenerationMode {
  if (
    input.mode === 'text' ||
    input.mode === 'first-frame' ||
    input.mode === 'first-last-frame' ||
    input.mode === 'reference'
  )
    return input.mode
  if (input.firstFrameMediaId && input.lastFrameMediaId) return 'first-last-frame'
  if (input.firstFrameMediaId) return 'first-frame'
  if (
    input.referenceImageMediaIds?.length ||
    input.referenceVideoMediaIds?.length ||
    input.referenceAudioMediaIds?.length
  )
    return 'reference'
  return 'text'
}

function uniqueMediaIds(ids: string[] | undefined): string[] {
  return [
    ...new Set((ids ?? []).filter((id): id is string => typeof id === 'string' && Boolean(id)))
  ]
}

/**
 * 参考素材的数量限制属于供应商协议，必须在提交前给用户可操作的错误；
 * 不能让超限请求变成一个含糊的上游 400。
 */
function validateReferenceLimits(p: ProviderConfig, input: VideoSubmitInput): void {
  const images = uniqueMediaIds(input.referenceImageMediaIds)
  const videos = uniqueMediaIds([
    ...(input.referenceVideoMediaIds ?? []),
    ...(input.referenceVideoMediaId ? [input.referenceVideoMediaId] : [])
  ])
  const audios = uniqueMediaIds(input.referenceAudioMediaIds)
  const capabilities = videoCapabilitiesFor(p.specId, input.modelId, {
    gatewayProxy: isSeedanceGatewayProxy(p.specId, p.baseURL)
  })
  const issues = videoCapabilityIssues(capabilities, {
    prompt: input.prompt,
    params: input.params,
    mode: submittedMode(input),
    hasFirstFrame: Boolean(input.firstFrameMediaId),
    hasLastFrame: Boolean(input.lastFrameMediaId),
    imageCount:
      images.length +
      Number(Boolean(input.firstFrameMediaId)) +
      Number(Boolean(input.lastFrameMediaId)),
    referenceImageCount: images.length,
    referenceVideoCount: videos.length,
    referenceAudioCount: audios.length
  })
  if (issues.length > 0) throw new GatewayError('INVALID_INPUT', issues.join('；'))
  if (
    p.specId === 'minimax' &&
    canonicalVideoModelId(input.modelId) === 'minimax-h3' &&
    images.length +
      videos.length +
      audios.length +
      Number(Boolean(input.firstFrameMediaId)) +
      Number(Boolean(input.lastFrameMediaId)) >
      12
  ) {
    throw new GatewayError('INVALID_INPUT', 'MiniMax H3 的全部参考素材最多 12 个')
  }
}

function validateVideoCapabilities(p: ProviderConfig, input: VideoSubmitInput): void {
  const capabilities = videoCapabilitiesFor(p.specId, input.modelId, {
    gatewayProxy: isSeedanceGatewayProxy(p.specId, p.baseURL)
  })
  const issues = videoCapabilityIssues(capabilities, {
    prompt: input.prompt,
    params: input.params,
    mode: submittedMode(input),
    hasFirstFrame: Boolean(input.firstFrameMediaId),
    hasLastFrame: Boolean(input.lastFrameMediaId),
    imageCount:
      uniqueMediaIds(input.referenceImageMediaIds).length +
      Number(Boolean(input.firstFrameMediaId)) +
      Number(Boolean(input.lastFrameMediaId)),
    referenceImageCount: uniqueMediaIds(input.referenceImageMediaIds).length,
    referenceVideoCount: uniqueMediaIds([
      ...(input.referenceVideoMediaIds ?? []),
      ...(input.referenceVideoMediaId ? [input.referenceVideoMediaId] : [])
    ]).length,
    referenceAudioCount: uniqueMediaIds(input.referenceAudioMediaIds).length
  })
  if (issues.length > 0) throw new GatewayError('INVALID_INPUT', issues.join('；'))
}

/**
 * The media table is the authoritative local source for file size and kind. Do
 * this before mediaToDataUrl reads an entire source file into memory.
 */
function validateReferenceAssets(p: ProviderConfig, input: VideoSubmitInput): void {
  const references: VideoReferenceAssetInput[] = [
    ...(input.firstFrameMediaId
      ? [{ id: input.firstFrameMediaId, expectedKind: 'image' as const }]
      : []),
    ...(input.lastFrameMediaId
      ? [{ id: input.lastFrameMediaId, expectedKind: 'image' as const }]
      : []),
    ...uniqueMediaIds(input.referenceImageMediaIds).map((id) => ({
      id,
      expectedKind: 'image' as const
    })),
    ...uniqueMediaIds([
      ...(input.referenceVideoMediaIds ?? []),
      ...(input.referenceVideoMediaId ? [input.referenceVideoMediaId] : [])
    ]).map((id) => ({ id, expectedKind: 'video' as const })),
    ...uniqueMediaIds(input.referenceAudioMediaIds).map((id) => ({
      id,
      expectedKind: 'audio' as const
    }))
  ]
  if (!references.length) return

  const read = getDb().prepare('SELECT id, kind, size_bytes FROM media WHERE id = ?')
  const assets = new Map(
    references.flatMap((reference) => {
      const row = read.get(reference.id) as
        { id: string; kind: string; size_bytes: number } | undefined
      return row
        ? [[row.id, { id: row.id, kind: row.kind, sizeBytes: row.size_bytes }] as const]
        : []
    })
  )
  const issues = videoReferenceAssetIssues(p.specId, input.modelId, references, assets)
  if (issues.length > 0) throw new GatewayError('INVALID_INPUT', issues.join('；'))
}

function updateTask(id: string, patch: Partial<TaskRow>): void {
  const sets = Object.keys(patch)
    .map((k) => `${k} = @${k}`)
    .join(', ')
  getDb()
    .prepare(`UPDATE tasks SET ${sets}, updated_at = @now WHERE id = @id`)
    .run({ ...patch, id, now: Date.now() })
}

function rowToInfo(row: TaskRow): VideoTaskInfo {
  let output: { mediaId?: string } = {}
  try {
    output = row.output ? JSON.parse(row.output) : {}
  } catch {
    // ignore
  }
  return {
    id: row.id,
    projectId: row.project_id,
    nodeId: row.node_id,
    providerId: row.provider_id,
    modelId: row.model_id,
    status: row.status as VideoTaskInfo['status'],
    mediaId: output.mediaId,
    mediaPath: row.status === 'success' ? mediaPathById(output.mediaId ?? '') : undefined,
    error: row.error ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  }
}

function mediaPathById(mediaId: string): string | undefined {
  if (!mediaId) return undefined
  const row = getDb().prepare('SELECT path FROM media WHERE id = ?').get(mediaId) as
    { path: string } | undefined
  return row?.path
}

async function fetchJson(
  url: string,
  init: RequestInit,
  context = ''
): Promise<Record<string, unknown> & { status?: number }> {
  // 提交/轮询是控制面请求，正常秒级回包；不设上界就会复现 MiniMax 无回包挂死拖死
  // 整个执行入口的事故（见 upstream-fetch.ts 头注）。
  const res = await fetchUpstream(url, init, CONTROL_TIMEOUT_MS, context)
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    const error = describeUpstreamHttpError(res.status, body, context)
    throw new UpstreamStatusError(error.code, error.message, res.status)
  }
  return (await res.json()) as Record<string, unknown>
}

function authHeaders(p: ProviderConfig): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${p.apiKey}`
  }
}

async function mediaToDataUrl(
  mediaId: string,
  input?: VideoSubmitInput
): Promise<string | undefined> {
  const m = await readMediaBuffer(mediaId)
  if (!m) throw new GatewayError('MEDIA_NOT_FOUND', `参考媒体不存在：${mediaId}`)
  if (input?.flowCommand) {
    const image = commandFrames(input).find((frame) => frame.mediaId === mediaId)
    if (
      !image ||
      image.mediaId !== mediaId ||
      image.mime !== m.mime ||
      createHash('sha256').update(m.buf).digest('hex') !== image.contentSha256
    )
      throw new GatewayError('FLOW_INPUT_CONTRACT_INVALID', '固定参考媒体内容已变化')
  }
  return `data:${m.mime};base64,${m.buf.toString('base64')}`
}

/**
 * 流式下载成片到临时文件，返回临时路径。
 *
 * 替代 Buffer.from(await fetch(url).arrayBuffer())：原方案把整段视频读进内存再
 * 落盘，几百 MB 成片会让主进程内存尖峰。这里用 pipeline 把响应流直接写到磁盘，
 * 内存占用恒定。调用方负责把返回的临时文件交给 saveFileAsset（登记后即被移走）。
 */
export async function downloadToTempFile(url: string, destination?: string): Promise<string> {
  // 下载是长传输（数百 MB 级、受服务端出网带宽主导），不能套用控制面的 60s 窗口；
  // 上界独立且更宽（DOWNLOAD_TIMEOUT_MS），但同样必须有界。
  const res = await fetchUpstream(url, {}, DOWNLOAD_TIMEOUT_MS, '下载成片失败')
  if (!res.ok || !res.body) {
    throw new GatewayError('DOWNLOAD_FAILED', `下载成片失败：HTTP ${res.status}`)
  }
  const tmpAbs = destination ?? join(getDataDir(), `tmp-video-${nanoid(10)}.mp4`)
  // 必须用路径流：FileHandle.createWriteStream() 把 fd 交给流之后，pipeline 结束即关闭
  // fd，随后任何 fh.sync()/fh.close() 都是 EBADF「file closed」——2026-09-19 真跑时
  // 成片已经完整落盘，任务却被这句异常标成 failed，白烧了一次计费。
  // fetch 的 body 是 DOM ReadableStream；Readable.fromWeb 需要 stream/web 类型。
  // 运行时两者兼容，这里用双重断言绕过 TS 的不透明类型不匹配。
  const nodeStream = Readable.fromWeb(res.body as unknown as import('stream/web').ReadableStream)
  try {
    await pipeline(nodeStream, createWriteStream(tmpAbs))
  } catch (error) {
    // 中途断流/超时留下的半截 tmp-video-* 必须就地清掉：反复失败不能蚕食数据盘
    await unlink(tmpAbs).catch(() => undefined)
    throw error
  }
  return tmpAbs
}

/**
 * 任务终态时清理 cancelled 标记。
 * cancelled 集合原本只在 cancel 时 add、永不 delete，长期运行会累积字符串，
 * 且任务 id 用 nanoid(10)，理论碰撞虽概率极低也非零。终态清理保持集合干净。
 */
function clearCancelled(taskId: string): void {
  cancelled.delete(taskId)
}

/** 成片下载重试的指数退避；只重试下载，绝不重投任务。 */
const DOWNLOAD_RETRY_DELAYS_MS = [2_000, 8_000, 32_000]

/** 下载至多重试 retryDelays 轮；全部失败时错误信息带上成片 URL 与 taskId 供人工取回。 */
async function downloadWithRetry(
  url: string,
  taskId: string,
  retryDelays: readonly number[],
  destination?: string
): Promise<string> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await downloadToTempFile(url, destination)
    } catch (error) {
      const delay = retryDelays[attempt]
      if (delay === undefined) {
        // 成片 URL 是已付费的成果，静默丢弃等于逼用户重投再扣一次费
        const reason = error instanceof Error ? error.message : String(error)
        throw new GatewayError(
          'DOWNLOAD_FAILED',
          `成片下载失败（已重试 ${retryDelays.length} 次），任务未入库，可用该地址人工取回 ` +
            `taskId=${taskId} 成片地址=${url}；原因：${reason}`
        )
      }
      await sleep(delay)
    }
  }
}

/**
 * 成片下载 → 入库 → 发送 video-done 事件，并清理 cancelled 标记。返回入库的资产。
 * 下载失败只重试下载；入库失败时 best-effort 删除临时文件，避免 tmp-video-* 泄漏。
 */
export async function finalizeVideo(
  send: Send,
  taskId: string,
  projectId: string,
  url: string,
  retryDelays: readonly number[] = DOWNLOAD_RETRY_DELAYS_MS,
  diagnostics?: GatewayDiagnosticsContext
): Promise<void> {
  const taskDiag = { ...diagnostics, taskId }
  emitGatewayEvent('media.persist_started', '成片开始入库', taskDiag, {
    attributes: { operation: 'video.generate' }
  })
  try {
    const asset = await materializeVideoAsset(
      taskId,
      projectId,
      async (target) => {
        emitGatewayEvent('media.download_started', '开始下载成片', taskDiag, {
          attributes: { operation: 'video.generate' }
        })
        try {
          await downloadWithRetry(url, taskId, retryDelays, target)
          emitGatewayEvent('media.download_completed', '成片下载完成', taskDiag, {
            attributes: { operation: 'video.generate' }
          })
        } catch (error) {
          emitGatewayEvent('media.download_failed', '成片下载失败', taskDiag, {
            error,
            attributes: { operation: 'video.generate' }
          })
          throw error
        }
      },
      () => Boolean(parseInput(taskId).cancelRequested || cancelled.has(taskId))
    )
    const stopped = parseInput(taskId).cancelRequested || cancelled.has(taskId)
    updateTask(taskId, {
      status: stopped ? 'unknown' : 'success',
      error: stopped ? UNKNOWN_VIDEO : null
    })
    emitGatewayEvent('media.persist_completed', '成片已入库', taskDiag, {
      status: 'success',
      attributes: { operation: 'video.generate', mediaId: asset.id, mime: asset.mime }
    })
    if (!stopped)
      send({
        kind: 'video-done',
        taskId,
        mediaId: asset.id,
        mediaPath: asset.path,
        name: asset.name ?? asset.id,
        mime: asset.mime
      })
  } catch (error) {
    // Keep verified staging/final files and receipts for recovery. Partial download
    // cleanup remains owned by downloadToTempFile; never delete the only valid copy.
    emitGatewayEvent('media.persist_failed', '成片入库失败', taskDiag, {
      error,
      attributes: { operation: 'video.generate' }
    })
    throw error
  } finally {
    clearCancelled(taskId)
  }
}

// ── MiniMax 适配 ──

/**
 * MiniMax 官方 v2 端点：`{base}/v2/…`。用户常把 BaseURL 填成 `…/`（307）或干脆带上
 * `/v2`（会拼成 `/v2/v2/…` 404），所以这里统一去尾斜杠并去掉重复的版本段。
 */
export function minimaxApiUrl(p: ProviderConfig, path: string): string {
  const base = p.baseURL.replace(/\/+$/, '').replace(/\/v2$/i, '')
  return `${base}${path}`
}

/** H3/H3-Max 官方 v2 payload；媒体解析可注入，以便逐字段 wire fixture 测试。 */
export async function buildMiniMaxH3RequestBody(
  input: VideoSubmitInput,
  resolveMedia: (mediaId: string) => Promise<string | undefined> = (id) => mediaToDataUrl(id, input)
): Promise<Record<string, unknown>> {
  const content: Array<Record<string, unknown>> = [{ type: 'text', text: input.prompt }]
  if (input.firstFrameMediaId) {
    content.push({
      type: 'image_url',
      image_url: { url: await resolveMedia(input.firstFrameMediaId) },
      role: 'first_frame'
    })
  }
  if (input.lastFrameMediaId) {
    content.push({
      type: 'image_url',
      image_url: { url: await resolveMedia(input.lastFrameMediaId) },
      role: 'last_frame'
    })
  }
  for (const mediaId of input.referenceImageMediaIds ?? []) {
    content.push({
      type: 'image_url',
      image_url: { url: await resolveMedia(mediaId) },
      role: 'reference_image'
    })
  }
  const referenceVideoIds = uniqueMediaIds([
    ...(input.referenceVideoMediaIds ?? []),
    ...(input.referenceVideoMediaId ? [input.referenceVideoMediaId] : [])
  ])
  for (const mediaId of referenceVideoIds) {
    content.push({
      type: 'video_url',
      video_url: { url: await resolveMedia(mediaId) },
      role: 'reference_video'
    })
  }
  for (const mediaId of input.referenceAudioMediaIds ?? []) {
    content.push({
      type: 'audio_url',
      audio_url: { url: await resolveMedia(mediaId) },
      role: 'reference_audio'
    })
  }
  const body: Record<string, unknown> = { model: input.modelId, content }
  const { params } = input
  if (params?.duration) body.duration = params.duration
  if (params?.resolution) body.resolution = params.resolution
  // H3 的首尾帧模式由输入图决定画幅；纯文本或纯参考模式使用明确 ratio。
  if (params?.ratio && !input.firstFrameMediaId && !input.lastFrameMediaId)
    body.ratio = params.ratio
  if (typeof params?.watermark === 'boolean') body.aigc_watermark = params.watermark
  return body
}

async function minimaxSubmit(p: ProviderConfig, input: VideoSubmitInput): Promise<string> {
  const body = await buildMiniMaxH3RequestBody(input)
  const res = await fetchJson(
    minimaxApiUrl(p, '/v2/video_generation'),
    {
      method: 'POST',
      headers: authHeaders(p),
      body: JSON.stringify(body)
    },
    'MiniMax 提交视频任务失败'
  )
  const rejected = minimaxBaseRespError(res)
  if (rejected) throw new GatewayError('UPSTREAM_ERROR', `MiniMax 提交视频任务失败：${rejected}`)
  const taskId = res.task_id ?? res.taskId ?? (res as { id?: string }).id
  if (typeof taskId !== 'string' || !taskId) {
    throw new GatewayError(
      'UPSTREAM_ERROR',
      `MiniMax 未返回 task_id：${JSON.stringify(res).slice(0, 200)}`
    )
  }
  return taskId
}

/**
 * MiniMax 会在 HTTP 200 的响应体里用 `base_resp.status_code` 表达业务错误。
 * 不先看它，错误响应就会被轮询当成「任务还没好」，一路白等到超时——而任务早已扣费。
 */
function minimaxBaseRespError(res: Record<string, unknown>): string | undefined {
  const base = res.base_resp
  if (!base || typeof base !== 'object') return undefined
  const { status_code: rawCode, status_msg: rawMsg } = base as Record<string, unknown>
  const code = typeof rawCode === 'number' ? rawCode : Number(rawCode)
  if (!Number.isFinite(code) || code === 0) return undefined
  const msg = typeof rawMsg === 'string' && rawMsg ? `${rawMsg}（status_code ${code}）` : ''
  return msg || `status_code ${code}`
}

/**
 * 官方 v2 的任务状态是 queued / running / succeeded / failed / cancelled。
 * 查询错误、结构缺失、未知状态和缺少结果均不能证明业务失败；保留 unknown
 * 防止重新提交已计费任务。只有可信任务终态允许释放占用。
 */
export function classifyMiniMaxTask(res: Record<string, unknown>): UpstreamState {
  const rejected = minimaxBaseRespError(res)
  if (rejected) return { status: 'unknown', error: '供应商查询未能确认任务结果' }
  const task = res.task as
    | {
        status?: string
        content?: { url?: string }
        error?: { message?: string } | string
      }
    | undefined
  if (!task || typeof task !== 'object') {
    return {
      status: 'unknown',
      error: 'MiniMax 查询响应里没有 task 字段：供应商 BaseURL 指向的不是 /v2 视频协议'
    }
  }
  if (typeof task.status !== 'string' || !task.status) {
    return {
      status: 'unknown',
      error: 'MiniMax 任务响应缺少 status'
    }
  }
  if (task.status === 'succeeded') {
    if (!task.content?.url) return { status: 'unknown', error: '成功态缺少成片地址' }
    return { status: 'succeeded', url: task.content.url }
  }
  if (task.status === 'failed' || task.status === 'cancelled') {
    const msg =
      typeof task.error === 'string'
        ? task.error
        : task.error?.message || `任务${task.status === 'failed' ? '失败' : '被取消'}`
    return { status: task.status, error: msg }
  }
  return { status: task.status === 'queued' || task.status === 'running' ? 'running' : 'unknown' }
}

async function minimaxPoll(p: ProviderConfig, upstreamId: string): Promise<UpstreamState> {
  const res = await fetchJson(
    minimaxApiUrl(p, `/v2/query/video_generation/${upstreamId}`),
    { headers: authHeaders(p) },
    'MiniMax 查询视频任务失败'
  )
  return classifyMiniMaxTask(res)
}

// ── Seedance 适配 ──

/**
 * 官方方舟和常见的 Ark 兼容网关使用不同任务路径。
 * 网关地址形如 /gateway/ark/v3 时沿用用户已验证的 /generations/tasks，
 * 官方方舟仍使用 /contents/generations/tasks。
 */
export function seedanceTasksUrl(p: ProviderConfig, taskId?: string): string {
  const base = p.baseURL.replace(/\/+$/, '')
  const path = base.includes('/gateway/ark/') ? '/generations/tasks' : '/contents/generations/tasks'
  return `${base}${path}${taskId ? `/${taskId}` : ''}`
}

function isSeedanceProxy(p: ProviderConfig): boolean {
  return isSeedanceGatewayProxy(p.specId, p.baseURL)
}

export async function buildSeedanceRequestBody(
  p: ProviderConfig,
  input: VideoSubmitInput,
  resolveMedia: (mediaId: string) => Promise<string | undefined> = (id) => mediaToDataUrl(id, input)
): Promise<Record<string, unknown>> {
  const isProxy = isSeedanceProxy(p)
  const mode = submittedMode(input)
  const suffix = isProxy
    ? [
        input.params?.ratio ? `--rt ${input.params.ratio}` : '',
        input.params?.resolution ? `--rs ${input.params.resolution}` : '',
        input.params?.duration ? `--dur ${input.params.duration}` : '',
        typeof input.params?.seed === 'number' ? `--seed ${input.params.seed}` : '',
        typeof input.params?.watermark === 'boolean' ? `--wm ${input.params.watermark}` : ''
      ]
        .filter(Boolean)
        .join(' ')
    : ''
  const content: Array<Record<string, unknown>> = [
    { type: 'text', text: suffix ? `${input.prompt} ${suffix}` : input.prompt }
  ]
  if (mode === 'first-frame' || mode === 'first-last-frame') {
    if (input.firstFrameMediaId) {
      content.push({
        type: 'image_url',
        image_url: { url: await resolveMedia(input.firstFrameMediaId) },
        ...(!isProxy ? { role: 'first_frame' } : {})
      })
    }
    if (mode === 'first-last-frame' && input.lastFrameMediaId) {
      content.push({
        type: 'image_url',
        image_url: { url: await resolveMedia(input.lastFrameMediaId) },
        ...(!isProxy ? { role: 'last_frame' } : {})
      })
    }
  }
  for (const mediaId of mode === 'reference' ? (input.referenceImageMediaIds ?? []) : []) {
    content.push({
      type: 'image_url',
      image_url: { url: await resolveMedia(mediaId) },
      ...(!isProxy ? { role: 'reference_image' } : {})
    })
  }
  const referenceVideoIds = uniqueMediaIds([
    ...(input.referenceVideoMediaIds ?? []),
    ...(input.referenceVideoMediaId ? [input.referenceVideoMediaId] : [])
  ])
  for (const mediaId of mode === 'reference' ? referenceVideoIds : []) {
    content.push({
      type: 'video_url',
      video_url: { url: await resolveMedia(mediaId) },
      // 兼容网关延续无 role 的多模态格式；官方端点可识别参考视频语义。
      ...(!isProxy ? { role: 'reference_video' } : {})
    })
  }
  for (const mediaId of mode === 'reference' ? (input.referenceAudioMediaIds ?? []) : []) {
    content.push({
      type: 'audio_url',
      audio_url: { url: await resolveMedia(mediaId) },
      ...(!isProxy ? { role: 'reference_audio' } : {})
    })
  }
  const { params } = input
  const body: Record<string, unknown> = { model: input.modelId, content }
  if (!isProxy) {
    if (params?.ratio) body.ratio = params.ratio
    if (params?.duration) body.duration = params.duration
    if (params?.resolution) body.resolution = params.resolution
    if (typeof params?.generateAudio === 'boolean') body.generate_audio = params.generateAudio
    if (typeof params?.seed === 'number') body.seed = params.seed
    if (typeof params?.watermark === 'boolean') body.watermark = params.watermark
  }
  return body
}

async function seedanceSubmit(p: ProviderConfig, input: VideoSubmitInput): Promise<string> {
  const body = await buildSeedanceRequestBody(p, input)
  const res = await fetchJson(
    seedanceTasksUrl(p),
    {
      method: 'POST',
      headers: authHeaders(p),
      body: JSON.stringify(body)
    },
    'Seedance 提交视频任务失败'
  )
  const id = res.id
  if (typeof id !== 'string' || !id) {
    throw new GatewayError(
      'UPSTREAM_ERROR',
      `Seedance 未返回任务 id：${JSON.stringify(res).slice(0, 200)}`
    )
  }
  return id
}

async function seedancePoll(p: ProviderConfig, upstreamId: string): Promise<UpstreamState> {
  const res = await fetchJson(
    seedanceTasksUrl(p, upstreamId),
    { headers: authHeaders(p) },
    'Seedance 查询视频任务失败'
  )
  const status = res.status as string | undefined
  if (res.id !== undefined && res.id !== upstreamId) return { status: 'unknown' }
  const content = res.content as { video_url?: string } | undefined
  if (status === 'succeeded') {
    if (!content?.video_url) return { status: 'unknown', error: '成功态缺少成片地址' }
    return { status: 'succeeded', url: content.video_url }
  }
  if (status === 'failed' || status === 'cancelled') {
    const err = res.error as { message?: string } | string | undefined
    return {
      status,
      error: (typeof err === 'string' ? err : err?.message) || `任务${status}`
    }
  }
  return { status: status === 'queued' || status === 'running' ? 'running' : 'unknown' }
}

// ── 任务管理 ──

function adaptersFor(p: ProviderConfig): {
  submit: (p: ProviderConfig, input: VideoSubmitInput) => Promise<string>
  poll: (p: ProviderConfig, upstreamId: string) => Promise<UpstreamState>
} {
  // 即梦走本机 CLI：提交与查询都是 spawn 子进程，复用同一套 tasks 表、轮询与恢复链路。
  if (p.specId === 'dreamina')
    return {
      submit: (_provider, input) => submitVideoWithDreamina(input),
      poll: (_provider, upstreamId) => pollVideoWithDreamina(upstreamId)
    }
  return p.specId === 'minimax'
    ? { submit: minimaxSubmit, poll: minimaxPoll }
    : { submit: seedanceSubmit, poll: seedancePoll }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** 供应商连接可能在任务在途时被用户改动，因此每轮续查前重新读取。 */
function requireLiveProvider(providerId: string): ProviderConfig {
  const p = getProvider(providerId)
  if (!p) throw new GatewayError('PROVIDER_NOT_FOUND', '供应商已被删除')
  return p
}

/**
 * 提交只在被 429 拒绝时重发：那一定是任务还没建起来，重发不产生第二次扣费。
 * 超时与 5xx 都可能已经创建了任务，重发等于同一支视频扣两次额度。
 */
async function submitWithBackoff(
  submit: (p: ProviderConfig, input: VideoSubmitInput) => Promise<string>,
  p: ProviderConfig,
  input: VideoSubmitInput,
  diagnostics?: GatewayDiagnosticsContext,
  requestId?: string,
  shouldStop: () => boolean = () => false
): Promise<string> {
  for (let attempt = 0; ; attempt++) {
    if (shouldStop()) throw new GatewayError('TASK_OUTCOME_UNKNOWN', UNKNOWN_VIDEO)
    try {
      return await submit(p, input)
    } catch (error) {
      const delay = SUBMIT_RETRY_DELAYS_MS[attempt]
      if (
        delay === undefined ||
        !(error instanceof GatewayError) ||
        error.code !== 'UPSTREAM_RATE_LIMIT'
      )
        throw error
      // L04：重试保持逻辑 requestId 不变、attempt 递增；日志不触发重试。
      emitGatewayEvent(
        'model.request.attempt_failed',
        '视频任务提交被限流',
        { ...diagnostics, requestId },
        {
          attempt: attempt + 1,
          error,
          attributes: { operation: 'video.generate', providerId: p.id, modelId: input.modelId }
        }
      )
      emitGatewayEvent(
        'model.request.retry_scheduled',
        '将按退避间隔重试提交',
        { ...diagnostics, requestId },
        {
          attempt: attempt + 2,
          waitMs: delay,
          attributes: { operation: 'video.generate', providerId: p.id, modelId: input.modelId }
        }
      )
      await sleep(delay)
    }
  }
}

/** 连续瞬时错误容错阈值：任务可能仍在上游运行，一次抖动就判死会诱导重投再扣费。 */
const POLL_TRANSIENT_TOLERANCE = 5

/**
 * 轮询容错只认「任务可能仍在运行」的失败：网络断开、查询超时、上游 5xx。
 * 401/403/404 等 4xx 是确定性错误（Key/地址/参数问题），重试同样的请求不会变好，
 * 必须立即抛出；多等只会把「配置错了」拖成「半小时后失败」。
 */
function isTransientPollError(error: unknown): boolean {
  // fetch 层的网络断开（DNS/连接被拒/TLS）不带 GatewayError 包装，任务可能仍在运行
  if (!(error instanceof GatewayError)) return true
  if (error.code === 'TIMEOUT') return true
  return error instanceof UpstreamStatusError && error.status >= 500
}

/**
 * 单次续查：先确认连接没有漂移，再查询上游。轮询被限流不算任务失败——
 * 任务已经在付费运行，误判成失败会让用户重新提交并再扣一次费。
 * 瞬时错误（断网/超时/5xx）连续 POLL_TRANSIENT_TOLERANCE 次以内同样只继续轮询，
 * 计数在任何成功响应后清零；达到阈值或上游明确返回终态才判失败。
 */
export async function pollUpstream(
  poll: (p: ProviderConfig, upstreamId: string) => Promise<UpstreamState>,
  provider: ProviderConfig,
  connection: ProviderConnectionSnapshot | undefined,
  upstreamId: string,
  failures: { count: number }
): Promise<UpstreamState> {
  const drift = providerDriftMessage(connection, provider, upstreamId)
  if (drift) throw new GatewayError('PROVIDER_DRIFTED', drift)
  try {
    const state = await poll(provider, upstreamId)
    failures.count = 0 // 成功响应清零
    return state
  } catch (error) {
    if (error instanceof GatewayError && error.code === 'UPSTREAM_RATE_LIMIT')
      return { status: 'running' }
    if (!isTransientPollError(error)) throw error
    failures.count += 1
    if (failures.count >= POLL_TRANSIENT_TOLERANCE) throw error
    return { status: 'running' }
  }
}

/** Resolve only the declared fixed asset version, never renderer supplied media metadata. */
function commandFrames(
  input: VideoSubmitInput,
  fixed?: ReturnType<typeof NodeExecuteCommandSchema.parse>
): (FlowMediaRef & { contentSha256: string })[] {
  if (!input.flowCommand) return []
  if (!fixed) {
    const row = getDb()
      .prepare('SELECT command_json FROM flow_commands WHERE project_id=? AND command_id=?')
      .get(input.projectId, input.flowCommand.commandId) as { command_json: string } | undefined
    if (!row) throw new GatewayError('FLOW_LEASE_REJECTED', '视频命令未获准执行')
    fixed = NodeExecuteCommandSchema.parse(JSON.parse(row.command_json))
  }
  const images = fixed.inputs
    .filter((item) => item.targetPortId === 'in-images')
    .flatMap((item) => item.assets)
  const videos = fixed.inputs
    .filter((item) => item.targetPortId === 'in-reference-video')
    .flatMap((item) => item.assets)
  const audios = fixed.inputs
    .filter((item) => item.targetPortId === 'in-reference-audio')
    .flatMap((item) => item.assets)
  if (input.mode === 'text' && images.length === 0 && videos.length === 0 && audios.length === 0)
    return []
  if (
    !['first-frame', 'first-last-frame', 'reference'].includes(input.mode ?? '') ||
    (input.mode === 'reference'
      ? images.length + videos.length + audios.length < 1 ||
        images.length > 30 ||
        videos.length > VIDEO_FLOW_MAX_REFERENCES ||
        audios.length > VIDEO_FLOW_MAX_REFERENCES ||
        audios.length !== (input.referenceAudioMediaIds?.length ?? 0) ||
        videos.length !== (input.referenceVideoMediaIds?.length ?? 0) ||
        images.length !== (input.referenceImageMediaIds?.length ?? 0)
      : videos.length !== 0 ||
        audios.length !== 0 ||
        images.length !== (input.mode === 'first-last-frame' ? 2 : 1)) ||
    new Set([...images, ...videos, ...audios].map((ref) => ref.versionId)).size !==
      images.length + videos.length + audios.length
  )
    throw new GatewayError('FLOW_INPUT_CONTRACT_INVALID', '视频输入须匹配有序固定媒体版本')
  const entries = [
    ...images.map((ref, index) => ({
      ref,
      kind: 'image' as const,
      mediaId:
        input.mode === 'reference'
          ? input.referenceImageMediaIds?.[index]
          : index === 0
            ? input.firstFrameMediaId
            : input.lastFrameMediaId
    })),
    ...videos.map((ref, index) => ({
      ref,
      kind: 'video' as const,
      mediaId: input.referenceVideoMediaIds?.[index]
    })),
    ...audios.map((ref, index) => ({
      ref,
      kind: 'audio' as const,
      mediaId: input.referenceAudioMediaIds?.[index]
    }))
  ]
  const frames = entries.map(({ ref, kind, mediaId }) => {
    const row = getDb()
      .prepare(
        'SELECT asset_id,node_id,port_id,value_json,digest FROM flow_asset_versions WHERE project_id=? AND version_id=?'
      )
      .get(input.projectId, ref.versionId) as
      | { asset_id: string; node_id: string; port_id: string; value_json: string; digest: string }
      | undefined
    if (
      !row ||
      row.asset_id !== ref.assetId ||
      row.node_id !== ref.sourceNodeId ||
      row.port_id !== ref.sourcePortId ||
      createHash('sha256').update(row.value_json).digest('hex') !== row.digest
    )
      throw new GatewayError('FLOW_INPUT_CONTRACT_INVALID', '固定参考媒体版本不可用')
    const value = JSON.parse(row.value_json)
    if (
      value.kind !== kind ||
      value.mediaId !== mediaId ||
      !/^[a-f0-9]{64}$/.test(value.contentSha256 ?? '')
    )
      throw new GatewayError('FLOW_INPUT_CONTRACT_INVALID', '参考输入不匹配固定媒体版本')
    return fixedFlowMedia(getDb(), input.projectId, value)
  })
  if (new Set(frames.map((frame) => frame.mediaId)).size !== frames.length)
    throw new GatewayError('FLOW_INPUT_CONTRACT_INVALID', '固定参考媒体不得重复')
  return frames
}

export function submitVideoTask(send: Send, input: VideoSubmitInput): VideoSubmitResult {
  if (input.flowCommand) {
    const binding = CommandLeaseSchema.parse(input.flowCommand)
    const command = getDb()
      .prepare(
        'SELECT lease_id,admitted,state,command_json,target_node_id FROM flow_commands WHERE project_id=? AND command_id=?'
      )
      .get(binding.projectId, binding.commandId) as
      | {
          lease_id: string
          admitted: number
          state: string
          command_json: string
          target_node_id: string
        }
      | undefined
    if (
      !command ||
      binding.projectId !== input.projectId ||
      command.target_node_id !== input.nodeId ||
      command.lease_id !== binding.leaseId ||
      command.admitted !== 1 ||
      !['pending', 'unknown'].includes(command.state)
    )
      throw new GatewayError('FLOW_LEASE_REJECTED', '视频命令未获准执行')
    let fixed: ReturnType<typeof NodeExecuteCommandSchema.parse>
    try {
      fixed = NodeExecuteCommandSchema.parse(JSON.parse(command.command_json))
    } catch {
      throw new GatewayError('FLOW_LEASE_REJECTED', '视频命令未获准执行')
    }
    if (
      fixed.contractVersion !== 7 ||
      fixed.projectId !== input.projectId ||
      fixed.targetNodeId !== input.nodeId ||
      fixed.commandId !== binding.commandId
    )
      throw new GatewayError('FLOW_LEASE_REJECTED', '视频命令未获准执行')
    if (
      !['text', 'first-frame', 'first-last-frame', 'reference'].includes(input.mode ?? '') ||
      (input.mode === 'text' && Boolean(input.firstFrameMediaId)) ||
      (input.mode === 'first-frame' && !input.firstFrameMediaId) ||
      (input.mode !== 'first-last-frame' && Boolean(input.lastFrameMediaId)) ||
      (input.mode === 'first-last-frame' &&
        (!input.firstFrameMediaId || !input.lastFrameMediaId)) ||
      (input.mode !== 'reference' && input.referenceImageMediaIds?.length) ||
      (input.mode !== 'reference' && input.referenceVideoMediaIds?.length) ||
      (input.mode !== 'reference' && input.referenceAudioMediaIds?.length) ||
      (input.mode === 'reference' &&
        (input.firstFrameMediaId ||
          input.lastFrameMediaId ||
          !(
            input.referenceImageMediaIds?.length ||
            input.referenceVideoMediaIds?.length ||
            input.referenceAudioMediaIds?.length
          ))) ||
      (input.referenceVideoMediaIds?.length ?? 0) > VIDEO_FLOW_MAX_REFERENCES ||
      input.referenceVideoMediaId ||
      (input.referenceAudioMediaIds?.length ?? 0) > VIDEO_FLOW_MAX_REFERENCES
    )
      throw new GatewayError(
        'FLOW_TYPE_UNSUPPORTED',
        'Agent 视频支持文本、提示词包、固定首尾帧及有序图片、视频和音频参考'
      )
    commandFrames(input, fixed)
    if (input.mode === 'reference') {
      const provider = getProvider(input.providerId)
      if (!provider) throw new GatewayError('PROVIDER_NOT_FOUND', '供应商不存在')
      const caps = videoCapabilitiesFor(provider.specId, input.modelId, {
        gatewayProxy: isSeedanceGatewayProxy(provider.specId, provider.baseURL)
      })
      if (
        !caps.modes.includes('reference') ||
        ((input.referenceImageMediaIds?.length ?? 0) > 0 && !caps.supportsReferenceImages) ||
        ((input.referenceVideoMediaIds?.length ?? 0) > 0 && !caps.supportsReferenceVideo) ||
        ((input.referenceAudioMediaIds?.length ?? 0) > 0 && !caps.supportsReferenceAudio) ||
        (input.referenceAudioMediaIds?.length ?? 0) > caps.maxReferenceAudios ||
        (input.referenceVideoMediaIds?.length ?? 0) > caps.maxReferenceVideos ||
        (input.referenceImageMediaIds?.length ?? 0) > caps.maxReferenceImages
      )
        throw new GatewayError('FLOW_INPUT_CONTRACT_INVALID', '当前模型不支持该参考媒体或数量')
    }
    if (fixed.videoRework) {
      try {
        input = { ...input, prompt: videoReworkPrompt(getDb(), fixed, input.prompt) }
      } catch {
        throw new GatewayError(
          'FLOW_VIDEO_REWORK_INVALID',
          '视频返工任务或固定审核依据不可用，请核对原任务'
        )
      }
    }
    const prior = getDb()
      .prepare(
        "SELECT * FROM tasks WHERE project_id=? AND node_id=? AND kind='video' AND json_extract(input,'$.flowCommandId')=? ORDER BY created_at LIMIT 1"
      )
      .get(input.projectId, input.nodeId, binding.commandId) as TaskRow | undefined
    if (prior) {
      const saved = parseInput(prior.id)
      if (
        prior.provider_id !== input.providerId ||
        prior.model_id !== input.modelId ||
        saved.prompt !== input.prompt.trim() ||
        saved.mode !== input.mode ||
        saved.firstFrameMediaId !== input.firstFrameMediaId ||
        saved.lastFrameMediaId !== input.lastFrameMediaId ||
        canonicalFlowJson(saved.referenceImageMediaIds ?? []) !==
          canonicalFlowJson(input.referenceImageMediaIds ?? []) ||
        canonicalFlowJson(saved.referenceVideoMediaIds ?? []) !==
          canonicalFlowJson(input.referenceVideoMediaIds ?? []) ||
        canonicalFlowJson(saved.referenceAudioMediaIds ?? []) !==
          canonicalFlowJson(input.referenceAudioMediaIds ?? []) ||
        canonicalFlowJson(saved.params ?? null) !== canonicalFlowJson(input.params ?? null)
      )
        throw new GatewayError('TASK_OUTCOME_UNKNOWN', '原视频命令输入发生变化，请核对原任务')
      cancelled.delete(prior.id)
      if (saved.cancelRequested)
        updateTask(prior.id, { input: JSON.stringify({ ...saved, cancelRequested: false }) })
      return { taskId: prior.id }
    }
  }
  if (!input.prompt?.trim()) throw new GatewayError('INVALID_INPUT', '提示词不能为空')
  const p = getProvider(input.providerId)
  if (!p) throw new GatewayError('PROVIDER_NOT_FOUND', '供应商不存在')
  if (p.specId !== 'minimax' && p.specId !== 'seedance' && p.specId !== 'dreamina') {
    throw new GatewayError('WRONG_SPEC', '该供应商不支持视频生成')
  }
  // 同节点在途去重：双击/重放会让同一条视频在上游建两个计费任务。
  // 只拦 submitted/running；failed/success/cancelled 都允许重投。
  if (input.nodeId) {
    const inflight = getDb()
      .prepare(
        "SELECT id FROM tasks WHERE kind = 'video' AND project_id = ? AND node_id = ? " +
          "AND status IN ('submitted', 'running', 'unknown') ORDER BY created_at DESC LIMIT 1"
      )
      .get(input.projectId, input.nodeId) as { id: string } | undefined
    if (inflight) {
      if (input.flowCommand)
        throw new GatewayError(
          'TASK_OUTCOME_UNKNOWN',
          '该节点已有未绑定本命令的任务，请先核对原任务'
        )
      const previous = getDb()
        .prepare('SELECT * FROM tasks WHERE id = ?')
        .get(inflight.id) as TaskRow
      if (previous.status === 'unknown') {
        const old = parseInput(previous.id)
        const keys = [
          'prompt',
          'params',
          'firstFrameMediaId',
          'lastFrameMediaId',
          'mode',
          'referenceImageMediaIds',
          'referenceVideoMediaIds',
          'referenceVideoMediaId',
          'referenceAudioMediaIds'
        ] as const
        const expected = {
          ...input,
          prompt: input.prompt.trim(),
          mode: submittedMode(input),
          referenceImageMediaIds: uniqueMediaIds(input.referenceImageMediaIds),
          referenceVideoMediaIds: uniqueMediaIds([
            ...(input.referenceVideoMediaIds ?? []),
            ...(input.referenceVideoMediaId ? [input.referenceVideoMediaId] : [])
          ]),
          referenceAudioMediaIds: uniqueMediaIds(input.referenceAudioMediaIds)
        }
        if (
          previous.provider_id !== input.providerId ||
          previous.model_id !== input.modelId ||
          keys.some(
            (key) =>
              canonicalFlowJson(old[key] ?? null) !== canonicalFlowJson(expected[key] ?? null)
          )
        )
          throw new GatewayError(
            'TASK_OUTCOME_UNKNOWN',
            '原任务结果未知，请恢复原输入后核对，不能提交另一项生成'
          )
        cancelled.delete(previous.id)
        updateTask(previous.id, { input: JSON.stringify({ ...old, cancelRequested: false }) })
        return { taskId: previous.id }
      }
      throw new GatewayError(
        'TASK_IN_FLIGHT',
        `该节点已有在途视频任务（taskId: ${inflight.id}），等待其完成或先取消，避免同一条视频重复计费`
      )
    }
  }
  validateReferenceLimits(p, input)
  validateVideoCapabilities(p, input)
  validateReferenceAssets(p, input)

  // The existing tasks primary key is the final cross-process submission fence.
  // A concurrent loser fails before POST; it must inspect this original task.
  const taskId = input.flowCommand
    ? `fv-${createHash('sha256')
        .update(JSON.stringify([input.projectId, input.flowCommand.commandId]))
        .digest('hex')
        .slice(0, 40)}`
    : nanoid(10)
  const now = Date.now()
  const state: VideoInputState = {
    ...(input.flowCommand ? { flowCommandId: input.flowCommand.commandId } : {}),
    prompt: input.prompt.trim(),
    mode: submittedMode(input),
    params: input.params,
    firstFrameMediaId: input.firstFrameMediaId,
    lastFrameMediaId: input.lastFrameMediaId,
    referenceImageMediaIds: uniqueMediaIds(input.referenceImageMediaIds),
    referenceVideoMediaIds: uniqueMediaIds([
      ...(input.referenceVideoMediaIds ?? []),
      ...(input.referenceVideoMediaId ? [input.referenceVideoMediaId] : [])
    ]),
    referenceVideoMediaId: input.referenceVideoMediaId,
    referenceAudioMediaIds: uniqueMediaIds(input.referenceAudioMediaIds),
    connection: snapshotProviderConnection(p),
    credentialHash: credentialHash(p)
  }
  getDb()
    .prepare(
      `INSERT INTO tasks (id, provider_id, model_id, node_id, project_id, kind, status, input, attempts, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'video', 'submitted', ?, 0, ?, ?)`
    )
    .run(
      taskId,
      input.providerId,
      input.modelId,
      input.nodeId,
      input.projectId,
      JSON.stringify(state),
      now,
      now
    )

  // L04：请求边界事件。本地 taskId 与（提交成功后的）upstreamTaskId 区分记录。
  const requestDiagnostics: GatewayDiagnosticsContext = {
    ...input.diagnostics,
    requestId: ensureRequestId(input.diagnostics)
  }
  emitGatewayEvent('model.request.started', '视频任务开始提交', requestDiagnostics, {
    attributes: {
      operation: 'video.generate',
      providerId: input.providerId,
      modelId: input.modelId
    }
  })
  void pollLoop(send, taskId, input, requestDiagnostics)
  return { taskId }
}

async function pollLoop(
  send: Send,
  taskId: string,
  input: VideoSubmitInput,
  requestDiagnostics?: GatewayDiagnosticsContext
): Promise<void> {
  const taskDiag = { ...requestDiagnostics, taskId }
  const run = { stopped: false }
  liveRuns.set(taskId, run)
  try {
    const p = requireLiveProvider(input.providerId)
    const { submit, poll } = adaptersFor(p)
    const upstreamId = await submitWithBackoff(
      submit,
      p,
      input,
      requestDiagnostics,
      requestDiagnostics?.requestId,
      () => run.stopped
    )
    const state = parseInput(taskId)
    updateTask(taskId, {
      input: JSON.stringify({ ...state, upstreamTaskId: upstreamId }),
      status: 'running'
    })
    if (run.stopped) {
      markUnknown(taskId)
      await controlVideoTask(taskId, true)
      return
    }
    // L04：远端任务已创建——与「提交请求成功」是两个事实。
    emitGatewayEvent('model.request.accepted', '远端已接受视频任务', taskDiag, {
      upstreamTaskId: upstreamId,
      attributes: {
        operation: 'video.generate',
        providerId: input.providerId,
        modelId: input.modelId
      }
    })
    emitGatewayEvent('task.state_changed', '本地任务状态更新为运行中', taskDiag, {
      upstreamTaskId: upstreamId,
      status: 'success',
      attributes: { state: 'running', operation: 'video.generate' }
    })
    send({ kind: 'video-status', taskId, status: 'running' })

    const deadline = Date.now() + VIDEO_TIMEOUT_MS
    // 连续瞬时失败计数跨轮询轮次维持，成功清零（见 pollUpstream）
    const pollFailures = { count: 0 }
    let lastSummaryAt = Date.now()
    for (;;) {
      if (run.stopped) return
      if (Date.now() > deadline) {
        throw new GatewayError('TIMEOUT', '视频生成超时（30 分钟）')
      }
      await sleep(POLL_INTERVAL_MS)
      if (run.stopped) return

      const liveProvider = requireLiveProvider(input.providerId)
      if (state.credentialHash && credentialHash(liveProvider) !== state.credentialHash)
        throw new GatewayError('TASK_OUTCOME_UNKNOWN', UNKNOWN_VIDEO)
      const st = await pollUpstream(poll, liveProvider, state.connection, upstreamId, pollFailures)
      if (run.stopped) return
      if (Date.now() - lastSummaryAt >= 30_000) {
        lastSummaryAt = Date.now()
        emitGatewayEvent('task.poll_summary', '远端任务轮询汇总', taskDiag, {
          upstreamTaskId: upstreamId,
          attributes: {
            state: st.status,
            pollCount: pollFailures.count,
            transientErrors: pollFailures.count,
            operation: 'video.generate'
          }
        })
      }
      if (st.status === 'succeeded' && st.url) {
        await finalizeVideo(
          send,
          taskId,
          input.projectId,
          st.url,
          DOWNLOAD_RETRY_DELAYS_MS,
          taskDiag
        )
        return
      }
      if (st.status === 'failed') throw new GatewayError('GEN_FAILED', st.error ?? '生成失败')
      if (st.status === 'unknown') throw new GatewayError('TASK_OUTCOME_UNKNOWN', UNKNOWN_VIDEO)
      if (st.status === 'cancelled') {
        updateTask(taskId, { status: 'cancelled' })
        clearCancelled(taskId)
        emitGatewayEvent('task.state_changed', '上游任务已取消', taskDiag, {
          upstreamTaskId: upstreamId,
          status: 'cancelled',
          attributes: { state: 'cancelled', operation: 'video.generate' }
        })
        send({ kind: 'video-error', taskId, error: '上游任务被取消' })
        return
      }
    }
  } catch (e) {
    if (['success', 'failed', 'cancelled'].includes(getVideoTask(taskId)?.status ?? '')) return
    const msg = e instanceof Error ? e.message : String(e)
    const definitive = e instanceof GatewayError && e.code === 'GEN_FAILED'
    if (definitive) updateTask(taskId, { status: 'failed', error: msg })
    else if (!(e instanceof GraphWriteInProgressError)) markUnknown(taskId)
    clearCancelled(taskId)
    emitGatewayEvent('task.failed', '视频任务失败', taskDiag, {
      error: e,
      status: definitive ? 'failed' : 'unknown',
      attributes: { state: definitive ? 'failed' : 'unknown', operation: 'video.generate' }
    })
    send({ kind: 'video-error', taskId, error: msg })
  } finally {
    if (liveRuns.get(taskId) === run) liveRuns.delete(taskId)
  }
}

function parseInput(taskId: string): VideoInputState {
  const row = getDb().prepare('SELECT input FROM tasks WHERE id = ?').get(taskId) as
    { input: string | null } | undefined
  if (!row?.input) return { prompt: '' }
  try {
    return JSON.parse(row.input) as VideoInputState
  } catch {
    return { prompt: '' }
  }
}

export async function cancelVideoTask(taskId: string): Promise<boolean> {
  // Stop local execution first. Only provider facts can confirm remote cancellation.
  const row = getDb()
    .prepare("SELECT status FROM tasks WHERE id = ? AND kind = 'video'")
    .get(taskId) as { status: string } | undefined
  if (!row || row.status === 'success' || row.status === 'failed' || row.status === 'cancelled') {
    return false
  }
  cancelled.add(taskId)
  const run = liveRuns.get(taskId)
  if (run) run.stopped = true
  markUnknown(taskId)
  updateTask(taskId, { input: JSON.stringify({ ...parseInput(taskId), cancelRequested: true }) })
  await controlVideoTask(taskId, true)
  clearCancelled(taskId)
  return true
}

export function getVideoTask(taskId: string): VideoTaskInfo | null {
  const row = getDb().prepare("SELECT * FROM tasks WHERE id = ? AND kind = 'video'").get(taskId) as
    TaskRow | undefined
  return row ? rowToInfo(row) : null
}

/** Serializes query/cancel/download so concurrent IPC calls cannot duplicate recovery. */
export function controlVideoTask(taskId: string, cancel = false): Promise<VideoTaskInfo | null> {
  const current = controls.get(taskId)
  if (current)
    return cancel
      ? current.then(() => {
          if (controls.get(taskId) === current) controls.delete(taskId)
          return controlVideoTask(taskId, true)
        })
      : current
  const work = (async () => {
    const row = getDb()
      .prepare("SELECT * FROM tasks WHERE id = ? AND kind = 'video'")
      .get(taskId) as TaskRow | undefined
    if (!row || ['success', 'failed', 'cancelled'].includes(row.status)) return getVideoTask(taskId)
    const diag = { traceId: newTraceId(), spanId: newSpanId(), taskId, correlationMissing: true }
    emitGatewayEvent('task.control.started', '远端视频事实核对开始', diag, {
      attributes: { operation: cancel ? 'video.cancel' : 'video.reconcile' }
    })
    let outcome = 'unknown'
    try {
      const state = parseInput(taskId)
      if (!cancel && !state.cancelRequested && !cancelled.has(taskId)) {
        const restored = await recoverVideoAsset(taskId, row.project_id, diag)
        if (restored) {
          if (!parseInput(taskId).cancelRequested && !cancelled.has(taskId)) {
            updateTask(taskId, { status: 'success', error: null })
            outcome = 'local_asset_verified'
          }
          return getVideoTask(taskId)
        }
      }
      const provider = getProvider(row.provider_id)
      if (
        !provider ||
        !state.upstreamTaskId ||
        !state.connection ||
        !state.credentialHash ||
        providerDriftMessage(state.connection, provider, state.upstreamTaskId) ||
        credentialHash(provider) !== state.credentialHash
      )
        return getVideoTask(taskId)
      // Ark DELETE also removes terminal records; a prior query cannot close that
      // race. Local stop only inspects facts until atomic cancellation is supported.
      const fact = await queryArkTask(provider, state.upstreamTaskId)
      outcome = fact.state
      const latest = getDb().prepare('SELECT input FROM tasks WHERE id = ?').get(taskId) as {
        input: string
      }
      const currentProvider = getProvider(row.provider_id)
      if (
        latest.input !== row.input ||
        !currentProvider ||
        credentialHash(currentProvider) !== state.credentialHash ||
        providerDriftMessage(state.connection, currentProvider, state.upstreamTaskId)
      ) {
        outcome = 'unknown'
        return getVideoTask(taskId)
      }
      if (fact.state === 'cancelled' || fact.state === 'failed')
        updateTask(taskId, {
          status: fact.state,
          error: fact.state === 'cancelled' ? '供应商已确认取消' : '供应商已确认失败'
        })
      else if (
        fact.state === 'succeeded' &&
        !cancel &&
        !parseInput(taskId).cancelRequested &&
        !cancelled.has(taskId)
      ) {
        await finalizeVideo(() => {}, taskId, row.project_id, fact.url, [], diag)
      }
      // queued/running only establish liveness, not permission to submit another task.
      return getVideoTask(taskId)
    } catch (error) {
      outcome = 'unknown'
      // Another live materializer owns the files. Inspection must not overwrite
      // that owner's task state or release its occupancy.
      if (!(error instanceof GraphWriteInProgressError)) markUnknown(taskId)
      return getVideoTask(taskId)
    } finally {
      emitGatewayEvent('task.control.completed', '远端视频事实核对结束', diag, {
        status: outcome === 'unknown' ? 'unknown' : 'success',
        attributes: { state: outcome, operation: cancel ? 'video.cancel' : 'video.reconcile' }
      })
    }
  })()
  controls.set(taskId, work)
  void work
    .finally(() => {
      if (controls.get(taskId) === work) controls.delete(taskId)
    })
    .catch(() => {})
  return work
}

// 应用启动恢复：重启前仍在途的任务，有 upstreamTaskId 且连接未漂移才继续轮询，否则标失败
export function resumePendingVideoTasks(send: Send): void {
  const rows = getDb()
    .prepare("SELECT * FROM tasks WHERE kind = 'video' AND status IN ('submitted', 'running')")
    .all() as TaskRow[]
  if (rows.length > 0) {
    // L04：恢复是主进程开启的新 trace；旧记录没有 traceId，明确标记关联缺失。
    emitGatewayEvent(
      'task.resume_started',
      '应用启动：恢复在途视频任务',
      { traceId: newTraceId(), correlationMissing: true } as never,
      { attributes: { pendingCount: rows.length, operation: 'video.generate' } }
    )
  }
  for (const row of rows) {
    const state = parseInput(row.id)
    const p = getProvider(row.provider_id)
    if (
      state.cancelRequested ||
      (p && state.credentialHash && credentialHash(p) !== state.credentialHash)
    ) {
      markUnknown(row.id)
      emitGatewayEvent(
        'task.resume_blocked',
        '恢复被停止意图或供应商身份变化阻断',
        { traceId: newTraceId(), taskId: row.id, correlationMissing: true },
        {
          attributes: {
            reason: state.cancelRequested ? 'local_stop' : 'credential_changed',
            operation: 'video.generate'
          }
        }
      )
      continue
    }
    if (!state.upstreamTaskId || !p) {
      markUnknown(row.id)
      emitGatewayEvent(
        'task.resume_blocked',
        '恢复被阻断：缺少上游任务或供应商连接',
        { traceId: newTraceId(), taskId: row.id, correlationMissing: true } as never,
        {
          attributes: {
            reason: !state.upstreamTaskId ? 'missing_upstream_task' : 'provider_missing',
            operation: 'video.generate'
          }
        }
      )
      send({ kind: 'video-error', taskId: row.id, error: '应用重启导致任务状态丢失' })
      continue
    }
    void resumeLoop(send, row, p, state.upstreamTaskId, state.connection)
  }
}

async function resumeLoop(
  send: Send,
  row: TaskRow,
  p: ProviderConfig,
  upstreamId: string,
  connection?: ProviderConnectionSnapshot
): Promise<void> {
  const { poll } = adaptersFor(p)
  const run = { stopped: false }
  liveRuns.set(row.id, run)
  // 超时基准必须从恢复时刻重新起算：库里的 updated_at 是停机前的旧值，长停机后
  // 拿它当基准会一进循环就误报 TIMEOUT，诱导用户重投已计费的任务。
  const deadline = Date.now() + VIDEO_TIMEOUT_MS
  const pollFailures = { count: 0 }
  // 恢复续跑的事件：稳定 taskId 关联旧任务；旧 trace 未知标记关联缺失。
  const resumeDiag = { traceId: newTraceId(), taskId: row.id, correlationMissing: true }
  emitGatewayEvent('task.state_changed', '恢复轮询开始', resumeDiag, {
    upstreamTaskId: upstreamId,
    attributes: { state: 'resumed', operation: 'video.generate' }
  })
  try {
    for (;;) {
      if (run.stopped) return

      // 恢复时先 poll 一次：上游任务可能在我们离线期间已经成功（或失败），
      // 此时即便已超过 deadline，也应取回已成片的 URL 而不是立即判超时失败。
      const stored = parseInput(row.id)
      if (stored.credentialHash && credentialHash(p) !== stored.credentialHash)
        throw new GatewayError('TASK_OUTCOME_UNKNOWN', UNKNOWN_VIDEO)
      const st = await pollUpstream(poll, p, connection, upstreamId, pollFailures)
      if (run.stopped) return
      if (st.status === 'succeeded' && st.url) {
        await finalizeVideo(
          send,
          row.id,
          row.project_id,
          st.url,
          DOWNLOAD_RETRY_DELAYS_MS,
          resumeDiag
        )
        return
      }
      if (st.status === 'failed') throw new GatewayError('GEN_FAILED', st.error ?? '生成失败')
      if (st.status === 'unknown') throw new GatewayError('TASK_OUTCOME_UNKNOWN', UNKNOWN_VIDEO)
      if (st.status === 'cancelled') {
        updateTask(row.id, { status: 'cancelled' })
        clearCancelled(row.id)
        send({ kind: 'video-error', taskId: row.id, error: '上游任务被取消' })
        return
      }

      // 只有在「上游仍在 running」时才判超时；否则进入下一轮 poll
      if (Date.now() > deadline) {
        throw new GatewayError('TIMEOUT', '视频生成超时（30 分钟）')
      }
      await sleep(POLL_INTERVAL_MS)
      if (run.stopped) return
      // 重启后用户可能改过供应商；每轮重新读取，漂移即停手
      p = requireLiveProvider(row.provider_id)
    }
  } catch (e) {
    if (['success', 'failed', 'cancelled'].includes(getVideoTask(row.id)?.status ?? '')) return
    const msg = e instanceof Error ? e.message : String(e)
    const definitive = e instanceof GatewayError && e.code === 'GEN_FAILED'
    if (definitive) updateTask(row.id, { status: 'failed', error: msg })
    else if (!(e instanceof GraphWriteInProgressError)) markUnknown(row.id)
    clearCancelled(row.id)
    emitGatewayEvent('task.failed', '恢复任务失败', resumeDiag, {
      error: e,
      status: definitive ? 'failed' : 'unknown',
      attributes: { state: definitive ? 'failed' : 'unknown', operation: 'video.generate' }
    })
    send({ kind: 'video-error', taskId: row.id, error: msg })
  } finally {
    if (liveRuns.get(row.id) === run) liveRuns.delete(row.id)
  }
}
