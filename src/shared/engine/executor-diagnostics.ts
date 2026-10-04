// 执行器 → 网关调用的诊断上下文构造（L03）。
// 只携带关联 ID 与模型身份；调用方缺 diagnostics（最小 mock / 测试路径）时返回
// undefined，网关侧记录 correlationMissing，不伪造关联。
import type { GatewayDiagnosticsContext } from '../contracts'
import type { NodeExecutionContext } from './executor-types'
import { newRequestId } from '../observability'

export interface GatewayDiagExtras {
  /** 缺省时自动生成（一次逻辑调用一个；自动重试由调用方复用同一个）。 */
  requestId?: string
  batchId?: string
  itemId?: string
}

export function gatewayDiagnostics(
  ctx: NodeExecutionContext,
  extras: GatewayDiagExtras = {}
): GatewayDiagnosticsContext | undefined {
  const diagnostics = ctx.diagnostics
  const requestId = extras.requestId ?? newRequestId()
  // 最小 mock 的 ctx 可能缺 node/projectId：全部按缺省处理，绝不因此改变业务执行。
  const nodeId = ctx.node?.id
  const nodeType = ctx.node?.type
  if (!diagnostics) {
    // 无执行器诊断上下文：仍返回最小上下文让 main 侧能拿到 requestId 并标记 trace 缺失。
    return {
      ...(ctx.runId ? { runId: ctx.runId } : {}),
      ...(nodeId ? { nodeId } : {}),
      ...(nodeType ? { nodeType } : {}),
      requestId,
      ...(ctx.projectId ? { projectId: ctx.projectId } : {})
    }
  }
  return {
    traceId: diagnostics.traceId,
    parentSpanId: diagnostics.spanId,
    ...(ctx.runId ? { runId: ctx.runId } : {}),
    ...(nodeId ? { nodeId } : {}),
    ...(nodeType ? { nodeType } : {}),
    nodeExecutionId: diagnostics.nodeExecutionId,
    requestId,
    ...(ctx.projectId ? { projectId: ctx.projectId } : {}),
    batchId: extras.batchId ?? diagnostics.batchId,
    itemId: extras.itemId ?? diagnostics.itemId
  }
}
