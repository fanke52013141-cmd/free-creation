import type { ChatMessage } from '../shapes/types'
import type { ModelConfig } from '../types'

const API_PREFIX = '/api'

async function readJson<T>(response: Response): Promise<T> {
  if (!response.ok) {
    const body = await response.text().catch(() => '')
    throw new Error(`服务端返回 ${response.status}：${body.slice(0, 240) || response.statusText}`)
  }
  return response.json() as Promise<T>
}

export async function getGatewayModels(): Promise<ModelConfig[]> {
  const data = await readJson<{ items: ModelConfig[] }>(await fetch(`${API_PREFIX}/models`))
  return data.items.map(({ apiKey: _ignored, ...model }) => model)
}

export async function callGatewayChat(input: {
  profileId: string
  messages: ChatMessage[]
  temperature?: number
  maxTokens?: number
  signal?: AbortSignal
}): Promise<string> {
  const data = await readJson<{ content: string }>(await fetch(`${API_PREFIX}/generate/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
    signal: input.signal,
  }))
  if (!data.content) throw new Error('模型返回内容为空')
  return data.content
}

export async function generateGatewayImages(input: {
  profileId: string
  prompt: string
  referenceUrls: string[]
  size: string
  quality: string
}): Promise<string[]> {
  const data = await readJson<{ urls: string[] }>(await fetch(`${API_PREFIX}/generate/image`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  }))
  if (!data.urls?.length) throw new Error('图片任务没有返回结果')
  return data.urls
}

export interface VideoTask {
  id: string
  status: 'pending' | 'running' | 'done' | 'failed' | 'canceled'
  progress: number
  resultUrls: string[]
  error?: string
}

export type GenerationTask = VideoTask

function normalizeTask(data: { id: string; status: VideoTask['status']; progress?: number; result_urls?: string[]; error?: string }): VideoTask {
  return { id: data.id, status: data.status, progress: data.progress ?? 0, resultUrls: data.result_urls ?? [], error: data.error }
}

export async function createVideoTask(input: {
  projectId: string
  profileId: string
  prompts: string[]
  referenceUrls: string[]
  resolution: string
  duration: number
}): Promise<VideoTask> {
  return normalizeTask(await readJson(await fetch(`${API_PREFIX}/tasks/video`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input),
  })))
}

export async function getVideoTask(taskId: string): Promise<VideoTask> {
  return normalizeTask(await readJson(await fetch(`${API_PREFIX}/tasks/${encodeURIComponent(taskId)}`)))
}

export async function cancelVideoTask(taskId: string): Promise<VideoTask> {
  return normalizeTask(await readJson(await fetch(`${API_PREFIX}/tasks/${encodeURIComponent(taskId)}/cancel`, { method: 'POST' })))
}

export async function createImageTask(input: {
  projectId: string
  profileId: string
  prompts: string[]
  referenceUrls: string[]
  size: string
  quality: string
}): Promise<GenerationTask> {
  return normalizeTask(await readJson(await fetch(`${API_PREFIX}/tasks/image`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input),
  })))
}

export async function uploadProjectAsset(projectId: string, file: File): Promise<{ id: string; url: string }> {
  const body = new FormData()
  body.append('file', file)
  return readJson(await fetch(`${API_PREFIX}/projects/${encodeURIComponent(projectId)}/assets`, { method: 'POST', body }))
}

export async function importProjectImage(projectId: string, url: string): Promise<{ id: string; url: string }> {
  return readJson(await fetch(`${API_PREFIX}/projects/${encodeURIComponent(projectId)}/assets/import`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url }),
  }))
}

export async function saveCanvasSnapshot(projectId: string, shapes: unknown[]): Promise<void> {
  await readJson(await fetch(`${API_PREFIX}/projects/${encodeURIComponent(projectId)}/canvas`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ shapes }),
  }))
}

export async function loadCanvasSnapshot(projectId: string): Promise<unknown[] | null> {
  const response = await fetch(`${API_PREFIX}/projects/${encodeURIComponent(projectId)}/canvas`)
  if (response.status === 404) return null
  const data = await readJson<{ shapes: unknown[] }>(response)
  return Array.isArray(data.shapes) ? data.shapes : []
}
