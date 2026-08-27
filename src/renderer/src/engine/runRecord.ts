// 节点运行记录：只保存运行可观测性信息，不保存 API Key 或完整输入正文。
import type { ContractInputMap } from './contracts'

export type NodeRunStatus = 'running' | 'success' | 'failed' | 'skipped' | 'cancelled'

export type NodeRunPhase = 'input' | 'execution' | 'output'

export interface NodeRunSource {
  nodeId: string
  portId: string
}

/**
 * 最近一次节点执行的紧凑审计记录，持久化到 shape.meta.nodeRun。
 * 输入只记来源端口，不复制可能很大的文本、JSON 或媒体二进制。
 */
export interface NodeRunRecord {
  runId: string
  status: NodeRunStatus
  startedAt: number
  finishedAt?: number
  durationMs?: number
  inputs: Record<string, NodeRunSource[]>
  outputPorts?: string[]
  error?: { phase: NodeRunPhase; reason: string }
}

export function inputSources(inputs: ContractInputMap): Record<string, NodeRunSource[]> {
  return Object.fromEntries(
    Array.from(inputs.entries()).map(([portId, packets]) => [
      portId,
      packets.map((packet) => ({
        nodeId: packet.source.nodeId,
        portId: packet.source.portId
      }))
    ])
  )
}

export function readNodeRunRecord(value: unknown): NodeRunRecord | null {
  if (!value || typeof value !== 'object') return null
  const record = value as Partial<NodeRunRecord>
  if (
    typeof record.runId !== 'string' ||
    !['running', 'success', 'failed', 'skipped', 'cancelled'].includes(record.status ?? '') ||
    typeof record.startedAt !== 'number' ||
    !record.inputs ||
    typeof record.inputs !== 'object'
  )
    return null
  return record as NodeRunRecord
}
