// 旧诊断接口适配：现有 ctx.trace（6 phase × info/error）映射到结构化事件。
// 旧接口签名不变、继续写 nodeRun meta；这里只是把同一信息补一条结构化事件，
// 避免「一口气修改所有节点执行器」。公共生命周期（node.started/终态）由执行器
// 显式发事件，不经本适配，避免重复终态。
import type { DiagnosticContext } from './context'
import type { DiagnosticsProducer } from './producer'
import type { DiagnosticsEventInput } from './schema'

export interface LegacyTraceInput {
  phase: 'input' | 'capability' | 'execution' | 'request' | 'result' | 'output'
  level: 'info' | 'error'
  message: string
}

/**
 * 旧 trace → `node.stage` 事件。info → info，error → error；
 * phase 保持原值写入事件 phase 字段，注册表未通过的输入丢弃返回 null。
 */
export function adaptLegacyTrace(
  producer: DiagnosticsProducer,
  context: DiagnosticContext,
  input: LegacyTraceInput
): DiagnosticsEventInput | null {
  return producer.build('node.stage', input.level, input.message, context, {
    attributes: {}
  })
}
