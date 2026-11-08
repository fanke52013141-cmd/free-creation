// 供应商模型发现（`/models` 拉取）的**共享实现**。
//
// 从 ipc/models.ipc.ts 抽出来，让 GUI 的"拉取可用模型"与外部接入 `model.discover`
// 走同一份代码：同一端点绑定校验（密钥来源必须与目标 URL 一致）、同一错误文案、
// 同一诊断事件。IPC 与 agent-access 都调用这里，不各写一份。
import { emitGatewayEvent } from '../diagnostics/gateway-events'
import { newTraceId } from '../../shared/observability'
import type { SqliteModelHost } from './sqlite-model-host'

export interface DiscoveredModelSummary {
  id: string
  name: string
}

/** 支持统一 `/models` 列表接口的协议。 */
export const DISCOVERABLE_PROTOCOLS = [
  'openai-compatible',
  'openai',
  'openrouter',
  'toapis',
  'custom'
] as const

/**
 * 拉取某连接的可用模型列表。
 *
 * 行为与 GUI 完全一致：
 * - `vidu-cli` 返回固定的两档版本（本地 CLI 没有 /models）；
 * - 其余协议必须允许且有密钥；密钥经 `readSecretForRequest(connectionId, modelsUrl)`
 *   取得（P2 端点绑定：目标来源必须与密钥绑定来源一致才释放凭据）；
 * - 失败写 `model.discovery.failed` 诊断事件并抛带 HTTP 状态的错误。
 */
export async function discoverConnectionModels(
  host: SqliteModelHost,
  connectionId: string
): Promise<DiscoveredModelSummary[]> {
  if (!connectionId) throw new Error('连接 ID 不能为空')
  const connection = await host.getConnection(connectionId)
  if (!connection) throw new Error('连接不存在')
  if (connection.protocol === 'vidu-cli') {
    return [
      { id: '3.4', name: 'Vidu Q4（图片参考生视频）' },
      { id: '3.2', name: 'Vidu Q3（文生/首帧/首尾帧/参考生视频）' }
    ]
  }
  if (!(DISCOVERABLE_PROTOCOLS as readonly string[]).includes(connection.protocol)) {
    throw new Error('此协议未提供统一的模型列表接口；请手动添加模型 ID')
  }
  // P2 端点绑定：目标来源必须与密钥绑定来源一致才释放凭据；自定义头不得覆盖鉴权。
  const modelsUrl = `${connection.baseUrl.replace(/\/+$/, '')}/models`
  const secret = await host.readSecretForRequest(connectionId, modelsUrl)
  if (!secret) throw new Error('请先保存 API Key，再拉取可用模型')
  const traceId = newTraceId()
  emitGatewayEvent('model.discovery.started', '拉取供应商模型列表', { traceId }, {
    attributes: { component: 'models', connectionId }
  })
  const response = await fetch(modelsUrl, {
    headers: { ...connection.headers, Authorization: `Bearer ${secret}` },
    signal: AbortSignal.timeout(20_000),
    redirect: 'error'
  })
  if (!response.ok) {
    emitGatewayEvent('model.discovery.failed', '拉取供应商模型列表', { traceId }, {
      status: 'failed',
      level: 'warn',
      attributes: { component: 'models', code: `HTTP_${response.status}` }
    })
    throw new Error(`拉取模型失败（HTTP ${response.status}）`)
  }
  const payload = (await response.json()) as { data?: Array<{ id?: unknown; name?: unknown }> }
  const seen = new Set<string>()
  return (Array.isArray(payload.data) ? payload.data : []).flatMap((item) => {
    const id = typeof item.id === 'string' ? item.id.trim() : ''
    if (!id || seen.has(id)) return []
    seen.add(id)
    return [
      { id, name: typeof item.name === 'string' && item.name.trim() ? item.name.trim() : id }
    ]
  })
}
