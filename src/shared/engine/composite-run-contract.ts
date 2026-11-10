import type { CompositeManifest } from '../composite/manifest'
import type { ContractInputMap } from '../engine/inputs'

export interface CompositeRunRequest {
  manifest: CompositeManifest
  inputs: ContractInputMap
  /** 便于运行记录/日志关联；由宿主生成。 */
  runId?: string
}

export interface CompositeRunOutcome {
  status: 'done' | 'failed'
  reason?: string
  /** 单一业务媒体产物；多输出/多值时 P2 后续扩展。 */
  media?: { mediaId: string; mediaPath: string; mime: string }
  /** 内部运行摘要，供诊断/未来持久化使用，不进入公开端口。 */
  stepCount?: number
}
