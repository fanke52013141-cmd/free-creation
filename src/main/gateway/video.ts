// 视频生成任务管理：MiniMax H3 与 Seedance 的统一任务式适配
// 两家 API 均为 content[] 多模态 + 异步任务 + 轮询（见调研报告 §3.3）：
//   MiniMax  POST {base}/v2/video_generation            → task_id
//           GET  {base}/v2/query/video_generation/{id}  → task.status / task.content.url
//   Seedance POST {base}/contents/generations/tasks     → id
//           GET  {base}/contents/generations/tasks/{id} → status / content.video_url
// 任务落 tasks 表（upstreamTaskId 存 input JSON），应用重启后恢复轮询
import { nanoid } from 'nanoid'
import { Readable } from 'stream'
import { pipeline } from 'stream/promises'
import { open } from 'fs/promises'
import { join } from 'path'
import type { GatewayEvent, VideoSubmitInput, VideoSubmitResult } from '../../shared/contracts'
import type { ProviderConfig, VideoGenerationMode, VideoTaskInfo } from '../../shared/types'
import { getDb, getDataDir } from '../store/db'
import { readMediaBuffer, saveFileAsset } from '../store/media.repo'
import { GatewayError } from './factory'
import { getProvider } from './providers.repo'
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
}

interface UpstreamState {
  status: 'running' | 'succeeded' | 'failed' | 'cancelled'
  url?: string
  error?: string
}

const cancelled = new Set<string>()

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
  init: RequestInit
): Promise<Record<string, unknown> & { status?: number }> {
  const res = await fetch(url, init)
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new GatewayError(
      'UPSTREAM_ERROR',
      `HTTP ${res.status}${body ? `：${body.slice(0, 200)}` : ''}`
    )
  }
  return (await res.json()) as Record<string, unknown>
}

function authHeaders(p: ProviderConfig): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${p.apiKey}`
  }
}

async function mediaToDataUrl(mediaId: string): Promise<string | undefined> {
  const m = await readMediaBuffer(mediaId)
  if (!m) throw new GatewayError('MEDIA_NOT_FOUND', `参考媒体不存在：${mediaId}`)
  return `data:${m.mime};base64,${m.buf.toString('base64')}`
}

/**
 * 流式下载成片到临时文件，返回临时路径。
 *
 * 替代 Buffer.from(await fetch(url).arrayBuffer())：原方案把整段视频读进内存再
 * 落盘，几百 MB 成片会让主进程内存尖峰。这里用 pipeline 把响应流直接写到磁盘，
 * 内存占用恒定。调用方负责把返回的临时文件交给 saveFileAsset（登记后即被移走）。
 */
async function downloadToTempFile(url: string): Promise<string> {
  const res = await fetch(url)
  if (!res.ok || !res.body) {
    throw new GatewayError('DOWNLOAD_FAILED', `下载成片失败：HTTP ${res.status}`)
  }
  const tmpAbs = join(getDataDir(), `tmp-video-${nanoid(10)}.mp4`)
  const fh = await open(tmpAbs, 'w')
  try {
    const ws = fh.createWriteStream()
    // fetch 的 body 是 DOM ReadableStream；Readable.fromWeb 需要 stream/web 类型。
    // 运行时两者兼容，这里用双重断言绕过 TS 的不透明类型不匹配。
    const nodeStream = Readable.fromWeb(res.body as unknown as import('stream/web').ReadableStream)
    await pipeline(nodeStream, ws)
    await fh.sync()
  } finally {
    await fh.close()
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

/** 成片下载 → 入库 → 发送 video-done 事件，并清理 cancelled 标记。返回入库的资产。 */
async function finalizeVideo(
  send: Send,
  taskId: string,
  projectId: string,
  url: string
): Promise<void> {
  const tmp = await downloadToTempFile(url)
  try {
    const asset = await saveFileAsset(projectId, tmp, '.mp4', 'video')
    updateTask(taskId, { status: 'success', output: JSON.stringify({ mediaId: asset.id }) })
    send({
      kind: 'video-done',
      taskId,
      mediaId: asset.id,
      mediaPath: asset.path,
      name: asset.name ?? asset.id,
      mime: asset.mime
    })
  } finally {
    clearCancelled(taskId)
  }
}

// ── MiniMax 适配 ──

/** H3 中转网关 payload；媒体解析可注入，以便逐字段 wire fixture 测试。 */
export async function buildMiniMaxH3RequestBody(
  input: VideoSubmitInput,
  resolveMedia: (mediaId: string) => Promise<string | undefined> = mediaToDataUrl
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
  const res = await fetchJson(`${p.baseURL}/v2/video_generation`, {
    method: 'POST',
    headers: authHeaders(p),
    body: JSON.stringify(body)
  })
  const taskId = res.task_id ?? res.taskId ?? (res as { id?: string }).id
  if (typeof taskId !== 'string' || !taskId) {
    throw new GatewayError(
      'UPSTREAM_ERROR',
      `MiniMax 未返回 task_id：${JSON.stringify(res).slice(0, 200)}`
    )
  }
  return taskId
}

async function minimaxPoll(p: ProviderConfig, upstreamId: string): Promise<UpstreamState> {
  const res = await fetchJson(`${p.baseURL}/v2/query/video_generation/${upstreamId}`, {
    headers: authHeaders(p)
  })
  const task = (res.task ?? {}) as {
    status?: string
    content?: { url?: string }
    error?: { message?: string } | string
  }
  if (task.status === 'succeeded') {
    if (!task.content?.url) return { status: 'failed', error: '成功态缺少成片地址' }
    return { status: 'succeeded', url: task.content.url }
  }
  if (task.status === 'failed' || task.status === 'cancelled') {
    const msg =
      typeof task.error === 'string'
        ? task.error
        : task.error?.message || `任务${task.status === 'failed' ? '失败' : '被取消'}`
    return { status: 'failed', error: msg }
  }
  return { status: 'running' }
}

// ── Seedance 适配 ──

/**
 * 官方方舟和常见的 Ark 兼容网关使用不同任务路径。
 * 网关地址形如 /gateway/ark/v3 时沿用用户已验证的 /generations/tasks，
 * 官方方舟仍使用 /contents/generations/tasks。
 */
function seedanceTasksUrl(p: ProviderConfig, taskId?: string): string {
  const path = p.baseURL.includes('/gateway/ark/')
    ? '/generations/tasks'
    : '/contents/generations/tasks'
  return `${p.baseURL}${path}${taskId ? `/${taskId}` : ''}`
}

function isSeedanceProxy(p: ProviderConfig): boolean {
  return isSeedanceGatewayProxy(p.specId, p.baseURL)
}

export async function buildSeedanceRequestBody(
  p: ProviderConfig,
  input: VideoSubmitInput,
  resolveMedia: (mediaId: string) => Promise<string | undefined> = mediaToDataUrl
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
  const res = await fetchJson(seedanceTasksUrl(p), {
    method: 'POST',
    headers: authHeaders(p),
    body: JSON.stringify(body)
  })
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
  const res = await fetchJson(seedanceTasksUrl(p, upstreamId), {
    headers: authHeaders(p)
  })
  const status = res.status as string | undefined
  const content = res.content as { video_url?: string } | undefined
  if (status === 'succeeded') {
    if (!content?.video_url) return { status: 'failed', error: '成功态缺少成片地址' }
    return { status: 'succeeded', url: content.video_url }
  }
  if (status === 'failed' || status === 'cancelled') {
    const err = res.error as { message?: string } | string | undefined
    return {
      status: 'failed',
      error: (typeof err === 'string' ? err : err?.message) || `任务${status}`
    }
  }
  return { status: 'running' }
}

// ── 任务管理 ──

function adaptersFor(p: ProviderConfig): {
  submit: (p: ProviderConfig, input: VideoSubmitInput) => Promise<string>
  poll: (p: ProviderConfig, upstreamId: string) => Promise<UpstreamState>
} {
  return p.specId === 'minimax'
    ? { submit: minimaxSubmit, poll: minimaxPoll }
    : { submit: seedanceSubmit, poll: seedancePoll }
}

export function submitVideoTask(send: Send, input: VideoSubmitInput): VideoSubmitResult {
  if (!input.prompt?.trim()) throw new GatewayError('INVALID_INPUT', '提示词不能为空')
  const p = getProvider(input.providerId)
  if (!p) throw new GatewayError('PROVIDER_NOT_FOUND', '供应商不存在')
  if (p.specId !== 'minimax' && p.specId !== 'seedance') {
    throw new GatewayError('WRONG_SPEC', '该供应商不支持视频生成')
  }
  validateReferenceLimits(p, input)
  validateVideoCapabilities(p, input)
  validateReferenceAssets(p, input)

  const taskId = nanoid(10)
  const now = Date.now()
  const state: VideoInputState = {
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
    referenceAudioMediaIds: uniqueMediaIds(input.referenceAudioMediaIds)
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

  void pollLoop(send, taskId, input)
  return { taskId }
}

async function pollLoop(send: Send, taskId: string, input: VideoSubmitInput): Promise<void> {
  try {
    const p = getProvider(input.providerId)
    if (!p) throw new GatewayError('PROVIDER_NOT_FOUND', '供应商已被删除')

    const { submit, poll } = adaptersFor(p)
    const upstreamId = await submit(p, input)
    const state = parseInput(taskId)
    updateTask(taskId, {
      input: JSON.stringify({ ...state, upstreamTaskId: upstreamId }),
      status: 'running'
    })
    send({ kind: 'video-status', taskId, status: 'running' })

    const deadline = Date.now() + VIDEO_TIMEOUT_MS
    for (;;) {
      if (cancelled.has(taskId)) {
        updateTask(taskId, { status: 'cancelled' })
        clearCancelled(taskId)
        send({ kind: 'video-error', taskId, error: '已取消' })
        return
      }
      if (Date.now() > deadline) {
        throw new GatewayError('TIMEOUT', '视频生成超时（30 分钟）')
      }
      await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS))
      if (cancelled.has(taskId)) continue // 唤醒后走取消分支

      const st = await poll(p, upstreamId)
      if (st.status === 'succeeded' && st.url) {
        await finalizeVideo(send, taskId, input.projectId, st.url)
        return
      }
      if (st.status === 'failed') throw new GatewayError('GEN_FAILED', st.error ?? '生成失败')
      if (st.status === 'cancelled') {
        updateTask(taskId, { status: 'cancelled' })
        clearCancelled(taskId)
        send({ kind: 'video-error', taskId, error: '上游任务被取消' })
        return
      }
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    updateTask(taskId, { status: 'failed', error: msg })
    clearCancelled(taskId)
    send({ kind: 'video-error', taskId, error: msg })
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

export function cancelVideoTask(taskId: string): boolean {
  // 本地停止轮询并标记取消（上游任务可能仍在运行，两家的取消接口均为条件支持，暂不调用）
  const row = getDb()
    .prepare("SELECT status FROM tasks WHERE id = ? AND kind = 'video'")
    .get(taskId) as { status: string } | undefined
  if (!row || row.status === 'success' || row.status === 'failed' || row.status === 'cancelled') {
    return false
  }
  cancelled.add(taskId)
  return true
}

export function getVideoTask(taskId: string): VideoTaskInfo | null {
  const row = getDb().prepare("SELECT * FROM tasks WHERE id = ? AND kind = 'video'").get(taskId) as
    TaskRow | undefined
  return row ? rowToInfo(row) : null
}

// 应用启动恢复：重启前仍在途的任务，有 upstreamTaskId 则继续轮询，否则标失败
export function resumePendingVideoTasks(send: Send): void {
  const rows = getDb()
    .prepare("SELECT * FROM tasks WHERE kind = 'video' AND status IN ('submitted', 'running')")
    .all() as TaskRow[]
  for (const row of rows) {
    const state = parseInput(row.id)
    const p = getProvider(row.provider_id)
    if (!state.upstreamTaskId || !p) {
      updateTask(row.id, { status: 'failed', error: '应用重启导致任务状态丢失' })
      send({ kind: 'video-error', taskId: row.id, error: '应用重启导致任务状态丢失' })
      continue
    }
    void resumeLoop(send, row, p, state.upstreamTaskId)
  }
}

async function resumeLoop(
  send: Send,
  row: TaskRow,
  p: ProviderConfig,
  upstreamId: string
): Promise<void> {
  const { poll } = adaptersFor(p)
  try {
    for (;;) {
      if (cancelled.has(row.id)) {
        updateTask(row.id, { status: 'cancelled' })
        clearCancelled(row.id)
        send({ kind: 'video-error', taskId: row.id, error: '已取消' })
        return
      }

      // 恢复时先 poll 一次：上游任务可能在我们离线期间已经成功（或失败），
      // 此时即便已超过 deadline，也应取回已成片的 URL 而不是立即判超时失败。
      const st = await poll(p, upstreamId)
      if (st.status === 'succeeded' && st.url) {
        await finalizeVideo(send, row.id, row.project_id, st.url)
        return
      }
      if (st.status === 'failed') throw new GatewayError('GEN_FAILED', st.error ?? '生成失败')
      if (st.status === 'cancelled') {
        updateTask(row.id, { status: 'cancelled' })
        clearCancelled(row.id)
        send({ kind: 'video-error', taskId: row.id, error: '上游任务被取消' })
        return
      }

      // 只有在「上游仍在 running」时才判超时；否则进入下一轮 poll
      if (Date.now() > row.updated_at + VIDEO_TIMEOUT_MS) {
        throw new GatewayError('TIMEOUT', '视频生成超时（30 分钟）')
      }
      await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS))
      if (cancelled.has(row.id)) continue
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    updateTask(row.id, { status: 'failed', error: msg })
    clearCancelled(row.id)
    send({ kind: 'video-error', taskId: row.id, error: msg })
  }
}
