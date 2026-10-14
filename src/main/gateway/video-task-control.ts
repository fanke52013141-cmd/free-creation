import type { ProviderConfig } from '../../shared/types'
import { fetchUpstream, CONTROL_TIMEOUT_MS } from './upstream-fetch'

export type RemoteVideoFact =
  | { state: 'queued' | 'running' | 'failed' | 'cancelled' }
  | { state: 'succeeded'; url: string }
  | { state: 'unknown' }

/** Only the documented official Ark task API is trusted for recovery facts. */
export function arkTaskEndpoint(provider: ProviderConfig, taskId: string): string | null {
  try {
    const base = new URL(provider.baseURL)
    if (
      provider.specId !== 'seedance' ||
      base.protocol !== 'https:' ||
      base.hostname !== 'ark.cn-beijing.volces.com' ||
      base.port ||
      base.username ||
      base.password ||
      base.search ||
      base.hash ||
      base.pathname.replace(/\/$/, '') !== '/api/v3' ||
      !/^[A-Za-z0-9_-]{1,200}$/.test(taskId)
    )
      return null
    return `${base.origin}/api/v3/contents/generations/tasks/${taskId}`
  } catch {
    return null
  }
}

export async function queryArkTask(
  provider: ProviderConfig,
  taskId: string
): Promise<RemoteVideoFact> {
  const url = arkTaskEndpoint(provider, taskId)
  if (!url || !provider.apiKey) return { state: 'unknown' }
  try {
    const response = await fetchUpstream(
      url,
      { headers: { Authorization: `Bearer ${provider.apiKey}` }, redirect: 'error' },
      CONTROL_TIMEOUT_MS,
      '查询远端视频任务'
    )
    if (!response.ok) return { state: 'unknown' }
    const value = (await response.json()) as {
      id?: unknown
      status?: unknown
      content?: { video_url?: unknown }
    }
    if (value?.id !== taskId) return { state: 'unknown' }
    if (value.status === 'succeeded') {
      const result = value.content?.video_url
      if (typeof result !== 'string' || !result.trim()) return { state: 'unknown' }
      return { state: 'succeeded', url: result }
    }
    if (['queued', 'running', 'failed', 'cancelled'].includes(String(value.status)))
      return { state: value.status as 'queued' | 'running' | 'failed' | 'cancelled' }
  } catch {
    /* Network/protocol failure is not evidence of a terminal outcome. */
  }
  return { state: 'unknown' }
}
