// 业务域 IPC 事件帮手（L04）：项目保存/导入导出、素材库、模型验证等领域事件
// 统一经 emitGatewayEvent 发射。这些操作不挂在某个节点下（规范 §4），
// renderer 尚未传入 trace 时显式标记 correlationMissing，不补造关联。
import { emitGatewayEvent } from './gateway-events'
import { redactDiagnosticText } from '../../shared/diagnostics'

export interface DomainEventOptions {
  status?: 'success' | 'failed' | 'cancelled' | 'skipped'
  error?: unknown
  attributes?: Record<string, unknown>
  /** 受控资源/连接 ID；只允许短标识。 */
  connectionId?: string
  resourceId?: string
}

export function emitDomainEvent(
  event: string,
  message: string,
  options: DomainEventOptions = {}
): void {
  emitGatewayEvent(event, message, { correlationMissing: true }, {
    ...options,
    attributes: options.attributes
  })
}

/** 从异常生成一句安全摘要（不携带原始正文）。 */
export function safeErrorDetail(error: unknown): string {
  return redactDiagnosticText(error instanceof Error ? error.message : String(error), 200)
}
