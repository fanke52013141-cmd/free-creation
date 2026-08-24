// 视频生成任务管理：MiniMax H3 与 Seedance 的统一任务式适配
// 两家 API 均为 content[] 多模态 + 异步任务 + 轮询（见调研报告 §3.3）：
//   MiniMax  POST {base}/v2/video_generation            → task_id
//           GET  {base}/v2/query/video_generation/{id}  → task.status / task.content.url
//   Seedance POST {base}/contents/generations/tasks     → id
//           GET  {base}/contents/generations/tasks/{id} → status / content.video_url
// 任务落 tasks 表（upstreamTaskId 存 input JSON），应用重启后恢复轮询
import { nanoid } from 'nanoid'
import type { GatewayEvent, VideoSubmitInput, VideoSubmitResult } from '../../shared/contracts'
import type { ProviderConfig, VideoTaskInfo } from '../../shared/types'
import { getDb } from '../store/db'
import { readMediaBuffer, saveBufferAsset } from '../store/media.repo'
import { GatewayError } from './factory'
import { getProvider } from './providers.repo'

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
  params?: VideoSubmitInput['params']
  firstFrameMediaId?: string
  upstreamTaskId?: string
}

interface UpstreamState {
  status: 'running' | 'succeeded' | 'failed' | 'cancelled'
  url?: string
  error?: string
}

const cancelled = new Set<string>()

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
  if (!m) throw new GatewayError('MEDIA_NOT_FOUND', `首帧图不存在：${mediaId}`)
  return `data:${m.mime};base64,${m.buf.toString('base64')}`
}

// ── MiniMax 适配 ──

async function minimaxSubmit(p: ProviderConfig, input: VideoSubmitInput): Promise<string> {
  const content: Array<Record<string, unknown>> = [{ type: 'text', text: input.prompt }]
  if (input.firstFrameMediaId) {
    content.push({
      type: 'image_url',
      image_url: { url: await mediaToDataUrl(input.firstFrameMediaId) },
      role: 'first_frame'
    })
  }
  const body: Record<string, unknown> = { model: input.modelId, content }
  const { params } = input
  if (params?.duration) body.duration = params.duration
  if (params?.resolution) body.resolution = params.resolution
  // 图生视频场景 ratio 由输入图片决定（恒 adaptive），不传
  if (params?.ratio && !input.firstFrameMediaId) body.ratio = params.ratio

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

function isSeedanceGatewayProxy(p: ProviderConfig): boolean {
  return p.baseURL.includes('/gateway/ark/')
}

async function seedanceSubmit(p: ProviderConfig, input: VideoSubmitInput): Promise<string> {
  const isProxy = isSeedanceGatewayProxy(p)
  const suffix = isProxy
    ? [
        input.params?.ratio ? `--ratio ${input.params.ratio}` : '',
        input.params?.resolution ? `--resolution ${input.params.resolution}` : '',
        input.params?.duration ? `--duration ${input.params.duration}` : ''
      ]
        .filter(Boolean)
        .join(' ')
    : ''
  const content: Array<Record<string, unknown>> = [
    { type: 'text', text: suffix ? `${input.prompt} ${suffix}` : input.prompt }
  ]
  if (input.firstFrameMediaId) {
    content.push({
      type: 'image_url',
      image_url: { url: await mediaToDataUrl(input.firstFrameMediaId) },
      // 官方方舟要求 role；兼容网关采用用户已验证的无 role 格式。
      ...(!isProxy ? { role: 'first_frame' } : {})
    })
  }
  const { params } = input
  const body: Record<string, unknown> = { model: input.modelId, content }
  if (!isProxy) {
    if (params?.ratio) body.ratio = params.ratio
    if (params?.duration) body.duration = params.duration
    if (params?.resolution) body.resolution = params.resolution
  }

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

  const taskId = nanoid(10)
  const now = Date.now()
  const state: VideoInputState = {
    prompt: input.prompt.trim(),
    params: input.params,
    firstFrameMediaId: input.firstFrameMediaId
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
        const buf = Buffer.from(await (await fetch(st.url)).arrayBuffer())
        const asset = await saveBufferAsset(input.projectId, buf, '.mp4', input.prompt.slice(0, 24))
        updateTask(taskId, {
          status: 'success',
          output: JSON.stringify({ mediaId: asset.id })
        })
        send({
          kind: 'video-done',
          taskId,
          mediaId: asset.id,
          mediaPath: asset.path,
          name: asset.name ?? asset.id,
          mime: asset.mime
        })
        return
      }
      if (st.status === 'failed') throw new GatewayError('GEN_FAILED', st.error ?? '生成失败')
      if (st.status === 'cancelled') {
        updateTask(taskId, { status: 'cancelled' })
        send({ kind: 'video-error', taskId, error: '上游任务被取消' })
        return
      }
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    updateTask(taskId, { status: 'failed', error: msg })
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
    const deadline = row.updated_at + VIDEO_TIMEOUT_MS
    for (;;) {
      if (cancelled.has(row.id)) {
        updateTask(row.id, { status: 'cancelled' })
        send({ kind: 'video-error', taskId: row.id, error: '已取消' })
        return
      }
      if (Date.now() > deadline) throw new GatewayError('TIMEOUT', '视频生成超时（30 分钟）')
      await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS))
      if (cancelled.has(row.id)) continue

      const st = await poll(p, upstreamId)
      if (st.status === 'succeeded' && st.url) {
        const buf = Buffer.from(await (await fetch(st.url)).arrayBuffer())
        const asset = await saveBufferAsset(row.project_id, buf, '.mp4', 'video')
        updateTask(row.id, {
          status: 'success',
          output: JSON.stringify({ mediaId: asset.id })
        })
        send({
          kind: 'video-done',
          taskId: row.id,
          mediaId: asset.id,
          mediaPath: asset.path,
          name: asset.name ?? asset.id,
          mime: asset.mime
        })
        return
      }
      if (st.status === 'failed') throw new GatewayError('GEN_FAILED', st.error ?? '生成失败')
      if (st.status === 'cancelled') {
        updateTask(row.id, { status: 'cancelled' })
        send({ kind: 'video-error', taskId: row.id, error: '上游任务被取消' })
        return
      }
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    updateTask(row.id, { status: 'failed', error: msg })
    send({ kind: 'video-error', taskId: row.id, error: msg })
  }
}
