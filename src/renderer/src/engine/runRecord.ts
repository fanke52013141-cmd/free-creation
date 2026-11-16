// 节点运行记录：保存运行可观测性信息，不保存 API Key。
// 2026-11-16 用户裁决：运行 tab 必须能查看并复制每次运行的完整输入输出正文，
// 因此 inputValues/outputValues 保存值快照（媒体只存引用，不存二进制）。
import type { ContractInputMap } from './contracts'
import type { NodeExecutionPhase, NodeExecutionTarget } from '@shared/engine/executor-types'
import type { NodeValue } from '@shared/engine/values'
import { redactDiagnosticText } from '@shared/diagnostics'
import type { GenerationTimingFeatures } from '@shared/contracts'
import { readStoredNodeRunStatus } from '@shared/engine/run-status'

export type NodeRunStatus = 'running' | 'success' | 'failed' | 'skipped' | 'cancelled'

export type NodeRunPhase = NodeExecutionPhase

export interface NodeRunTraceEntry {
  at: number
  phase: NodeRunPhase
  level: 'info' | 'error'
  message: string
}

export interface NodeRunSource {
  nodeId: string
  portId: string
  assetId?: string
  versionId?: string
}

/**
 * 最近一次节点执行的紧凑审计记录，持久化到 shape.meta.nodeRun。
 * 输入来源记端口；输入/输出正文以值快照保存（媒体只存引用），供运行 tab 查看与复制。
 */
export interface NodeRunRecord {
  runId: string
  commandId?: string
  commandLeaseId?: string
  fixedInputs?: import('@shared/agent-flow/commands').NodeExecuteCommand['inputs']
  status: NodeRunStatus
  startedAt: number
  finishedAt?: number
  durationMs?: number
  inputs: Record<string, NodeRunSource[]>
  /** 本次运行实际收集到的输入值快照（按端口）；旧记录缺省，UI 显示「未保存正文」。 */
  inputValues?: Record<string, unknown[]>
  /** 本次运行通过契约校验的输出值快照（按端口）；失败/跳过记录缺省。 */
  outputValues?: Record<string, unknown[]>
  outputPorts?: string[]
  error?: {
    phase: NodeRunPhase
    reason: string
    /** W4 失败定位：组合等嵌套执行失败的内部节点/端口 ID（只存 ID，不存正文）。 */
    failureNodeId?: string
    failurePortId?: string
  }
  target?: NodeExecutionTarget
  estimateFeatures?: GenerationTimingFeatures
  estimateProviderKey?: string
  estimateModelKey?: string
  /** L01 结构化诊断关联：根 trace 与本次节点执行实例（持久化到 meta 便于运行中心跳转）。 */
  traceId?: string
  nodeExecutionId?: string
  /** T09（F08）：本次成功运行对应的输入指纹；与当前输入不一致 = 输入已修改。 */
  inputFingerprint?: string
  /** 分阶段、脱敏的运行轨迹；不记录完整提示词、文件内容、媒体二进制或密钥。 */
  trace?: NodeRunTraceEntry[]
}

/** 本地单用户项目保留最近运行，用于结果比较、失败回溯和重试；不复制输入正文或媒体。 */
export const NODE_RUN_HISTORY_LIMIT = 12
export const NODE_RUN_TRACE_LIMIT = 24

export function appendNodeRunTrace(
  record: NodeRunRecord,
  phase: NodeRunPhase,
  level: NodeRunTraceEntry['level'],
  message: string
): NodeRunRecord {
  return {
    ...record,
    trace: [
      ...(record.trace ?? []),
      { at: Date.now(), phase, level, message: redactDiagnosticText(message) }
    ].slice(-NODE_RUN_TRACE_LIMIT)
  }
}

export function inputSources(inputs: ContractInputMap): Record<string, NodeRunSource[]> {
  return Object.fromEntries(
    Array.from(inputs.entries()).map(([portId, packets]) => [
      portId,
      packets.map((packet) => ({
        nodeId: packet.source.nodeId,
        portId: packet.source.portId,
        ...(packet.source.assetId ? { assetId: packet.source.assetId } : {}),
        ...(packet.source.versionId ? { versionId: packet.source.versionId } : {})
      }))
    ])
  )
}

export function readNodeRunRecord(value: unknown): NodeRunRecord | null {
  return readStoredNodeRunStatus(value) ? (value as NodeRunRecord) : null
}

export function readNodeRunHistory(value: unknown): NodeRunRecord[] {
  if (!Array.isArray(value)) return []
  return value
    .map(readNodeRunRecord)
    .filter((record): record is NodeRunRecord => Boolean(record && record.status !== 'running'))
    .slice(0, NODE_RUN_HISTORY_LIMIT)
}

/** 按最新在前去重，防止一次运行的 running/finished 两个中间状态重复出现在历史中。 */
export function appendNodeRunHistory(value: unknown, record: NodeRunRecord): NodeRunRecord[] {
  if (record.status === 'running') return readNodeRunHistory(value)
  return [record, ...readNodeRunHistory(value).filter((item) => item.runId !== record.runId)].slice(
    0,
    NODE_RUN_HISTORY_LIMIT
  )
}

/** 单个值快照的正文上限：超出截断并显式标记，避免画布快照被超大正文撑爆。 */
export const RUN_VALUE_TEXT_LIMIT = 40_000

/** 把端口值转成可持久化、可复制的快照：媒体只留引用，文本/JSON 留正文（超限截断）。 */
export function snapshotRunValue(value: NodeValue): unknown {
  if (value.kind === 'text' || value.kind === 'markdown') {
    return value.text.length > RUN_VALUE_TEXT_LIMIT
      ? {
          kind: value.kind,
          truncated: true,
          text: `${value.text.slice(0, RUN_VALUE_TEXT_LIMIT)}\n…（正文超过 ${RUN_VALUE_TEXT_LIMIT} 字符已截断）`
        }
      : { kind: value.kind, text: value.text }
  }
  if (value.kind === 'json' || value.kind === 'camera') {
    const serialized = JSON.stringify(value.data, null, 2)
    return serialized.length > RUN_VALUE_TEXT_LIMIT
      ? {
          kind: value.kind,
          truncated: true,
          text: `${serialized.slice(0, RUN_VALUE_TEXT_LIMIT)}\n…（正文超过 ${RUN_VALUE_TEXT_LIMIT} 字符已截断）`
        }
      : { kind: value.kind, data: value.data }
  }
  return {
    kind: value.kind,
    mediaId: value.mediaId,
    mediaPath: value.mediaPath,
    mime: value.mime,
    ...(value.name ? { name: value.name } : {})
  }
}

/** 输入数据包 map → 按端口的值快照数组。 */
export function snapshotRunInputs(inputs: ContractInputMap): Record<string, unknown[]> {
  return Object.fromEntries(
    Array.from(inputs.entries()).map(([portId, packets]) => [
      portId,
      packets.map((packet) => snapshotRunValue(packet.value))
    ])
  )
}

/** 契约输出 map → 按端口的值快照数组。 */
export function snapshotRunOutputs(
  outputs: Record<string, { value?: NodeValue } | undefined>
): Record<string, unknown[]> {
  const result: Record<string, unknown[]> = {}
  for (const [portId, packet] of Object.entries(outputs)) {
    if (packet?.value) result[portId] = [snapshotRunValue(packet.value)]
  }
  return result
}
