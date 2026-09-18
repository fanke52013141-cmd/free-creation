// 供应商连接快照：异步任务从提交到出片可能跨几十分钟，期间用户完全可能在设置里
// 改 Base URL 或换协议。续跑时若拿旧服务商返回的 task id 去查已经改过的连接，
// 会把别人的任务或空结果当成自己的成片。因此提交时冻结连接，每次续查前先比对。
import type { ProviderConfig } from './types'

export interface ProviderConnectionSnapshot {
  specId: string
  baseURL: string
}

/** 尾斜杠与大小写不该被当成漂移。 */
export function normalizeBaseURL(url: string): string {
  return url.trim().replace(/\/+$/, '').toLowerCase()
}

export function snapshotProviderConnection(
  provider: Pick<ProviderConfig, 'specId' | 'baseURL'>
): ProviderConnectionSnapshot {
  return { specId: provider.specId, baseURL: normalizeBaseURL(provider.baseURL) }
}

/**
 * 连接漂移时返回一句可直接展示给用户的错误，未漂移返回 null。
 * 没有快照的历史任务一律放行：那是改动之前提交的数据，不能倒推成漂移。
 */
export function providerDriftMessage(
  snapshot: ProviderConnectionSnapshot | undefined,
  provider: Pick<ProviderConfig, 'specId' | 'baseURL'>,
  upstreamTaskId: string
): string | null {
  if (!snapshot) return null
  const current = snapshotProviderConnection(provider)
  if (current.specId === snapshot.specId && current.baseURL === snapshot.baseURL) return null
  const changed =
    current.specId !== snapshot.specId
      ? `协议从 ${snapshot.specId} 变成 ${current.specId}`
      : `Base URL 从 ${snapshot.baseURL} 变成 ${current.baseURL}`
  return (
    `供应商连接已变更（${changed}），已停止查询上游任务 ${upstreamTaskId}；` +
    '请到该服务商控制台确认这条任务，或重新提交生成'
  )
}
