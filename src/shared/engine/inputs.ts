// 输入端口数据包类型与提取辅助（从 renderer/contracts.ts 抽出的纯函数部分）
//
// buildOutputPackets / collectContractInputs 依赖 renderer 注册表（getNodeType），
// 留在 renderer 层。这里只保留执行器直接使用的类型安全和提取函数。
import type { PortType } from '../types'
import type { NodeValue } from './values'

export interface NodeValuePacket {
  type: PortType
  value: NodeValue
  schema?: import('../types').PortSchemaRef
  source: { nodeId: string; portId: string; runId: string }
  createdAt: number
}

export type ContractOutputs = Partial<Record<string, NodeValuePacket>>
export type ContractInputMap = ReadonlyMap<string, readonly NodeValuePacket[]>

/** 运行器在动态作用域内注入的输入包（目前由 iterate.out-item 使用）。 */
export interface ContractInputInjection {
  portId: string
  packet: NodeValuePacket
}

export function inputPackets(inputs: ContractInputMap, portId: string): readonly NodeValuePacket[] {
  return inputs.get(portId) ?? []
}

export function inputText(inputs: ContractInputMap, portId: string): string {
  return inputPackets(inputs, portId)
    .map((packet) =>
      packet.value.kind === 'text' || packet.value.kind === 'markdown' ? packet.value.text : ''
    )
    .filter(Boolean)
    .join('\n\n---\n\n')
}

export function inputJson(inputs: ContractInputMap, portId: string): unknown[] {
  return inputPackets(inputs, portId)
    .filter((packet) => packet.value.kind === 'json')
    .map((packet) => (packet.value.kind === 'json' ? packet.value.data : null))
}

export function inputMedia<K extends 'image' | 'video' | 'audio' | 'file'>(
  inputs: ContractInputMap,
  portId: string,
  kind: K
): Extract<NodeValue, { kind: K }>[] {
  return inputPackets(inputs, portId)
    .map((packet) => packet.value)
    .filter((value): value is Extract<NodeValue, { kind: K }> => value.kind === kind)
}

export function inputValue(inputs: ContractInputMap, portId: string): NodeValue | null {
  return inputPackets(inputs, portId)[0]?.value ?? null
}
