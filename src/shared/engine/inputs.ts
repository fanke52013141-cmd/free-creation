// 输入端口数据包类型与提取辅助（从 renderer/contracts.ts 抽出的纯函数部分）
//
// buildOutputPackets / collectContractInputs 依赖 renderer 注册表（getNodeType），
// 留在 renderer 层。这里只保留执行器直接使用的类型安全和提取函数。
import type { PortType } from '../types'
import type { NodeValue } from './values'
import { TEXT_MERGE_SEPARATOR } from './helpers'
import type { DirectorCamera } from '../director-data'
import { validateNodeSchema } from '../node-schemas'

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
    .join(TEXT_MERGE_SEPARATOR)
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

/**
 * 循环当前项默认作为 JSON 传递；带明确 kind 与完整资产定位信息的列表项，
 * 则还原成可接入图片/视频/音频/文件端口的类型化资产引用。
 */
export function iterationItemValue(
  item: Record<string, unknown>,
  targetType?: PortType
): NodeValue {
  const kind = item.kind
  if (targetType === 'camera') {
    const camera =
      kind === 'camera' && 'data' in item
        ? item.data
        : kind === 'camera'
          ? Object.fromEntries(Object.entries(item).filter(([key]) => key !== 'kind'))
          : item
    if (validateNodeSchema({ id: 'previs.camera', version: 1 }, camera).ok) {
      return { kind: 'camera', data: camera as Partial<DirectorCamera> }
    }
  }
  if (
    (kind === 'image' || kind === 'video' || kind === 'audio' || kind === 'file') &&
    targetType !== 'json' &&
    (targetType === undefined || targetType === 'any' || targetType === kind) &&
    typeof item.mediaId === 'string' &&
    item.mediaId.length > 0 &&
    typeof item.mediaPath === 'string' &&
    item.mediaPath.length > 0 &&
    typeof item.mime === 'string' &&
    item.mime.length > 0
  ) {
    return {
      kind,
      mediaId: item.mediaId,
      mediaPath: item.mediaPath,
      mime: item.mime,
      ...(typeof item.name === 'string' ? { name: item.name } : {})
    }
  }
  return { kind: 'json', data: item }
}
