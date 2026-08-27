import type { CanvasEdge, CanvasNode, PortDecl, PortSchemaRef, PortType } from '@shared/types'
import { nodeSchemasCompatible, validateNodeSchema } from '@shared/node-schemas'
import { getNodeType, portCompatible } from '../nodes/registry'
import type { NodeValue, RawNodeOutputs } from '../nodes/nodeValues'

export interface NodeValuePacket {
  type: PortType
  value: NodeValue
  schema?: PortSchemaRef
  source: { nodeId: string; portId: string; runId: string }
  createdAt: number
}

export type ContractOutputs = Partial<Record<string, NodeValuePacket>>
export type ContractInputMap = ReadonlyMap<string, readonly NodeValuePacket[]>

export interface ContractResult<T> {
  value: T
  errors: string[]
}

function valueType(value: NodeValue): PortType {
  return value.kind === 'text' ? 'text' : value.kind
}

function valueMatchesPort(value: NodeValue, port: PortDecl): boolean {
  return portCompatible(valueType(value), port.type)
}

function describePort(port: PortDecl): string {
  return `${port.name}（${port.id}）`
}

/**
 * 从 CanvasNode 解析实际端口。优先使用 deriveGraph 已填充的 node.ports
 * （包含动态解析的端口），为空时回退到 spec 静态端口（兼容测试与旧数据）。
 */
function portsOf(node: CanvasNode): { in: PortDecl[]; out: PortDecl[] } {
  if (node.ports.length > 0) {
    return {
      in: node.ports.filter((p) => p.dir === 'in'),
      out: node.ports.filter((p) => p.dir === 'out')
    }
  }
  const spec = getNodeType(node.type)
  return spec?.ports ?? { in: [], out: [] }
}

/** 成功执行后，把节点持久化结果封装成带来源的端口数据包，并验证输出契约。 */
export function buildOutputPackets(
  node: CanvasNode,
  rawOutputs: RawNodeOutputs,
  runId: string
): ContractResult<ContractOutputs> {
  const spec = getNodeType(node.type)
  if (!spec) return { value: {}, errors: [`未知节点类型：${node.type}`] }

  const errors: string[] = []
  const packets: ContractOutputs = {}
  const resolved = portsOf(node)
  const outputPorts = new Map(resolved.out.map((port) => [port.id, port]))

  for (const [portId, raw] of Object.entries(rawOutputs)) {
    if (!raw) continue
    const port = outputPorts.get(portId)
    if (!port) {
      errors.push(`产生了未声明的输出端口：${portId}`)
      continue
    }
    if (!valueMatchesPort(raw, port)) {
      errors.push(`${describePort(port)} 声明为 ${port.type}，实际输出为 ${valueType(raw)}`)
      continue
    }
    if (port.type === 'json' && port.schema && raw.kind === 'json') {
      const result = validateNodeSchema(port.schema, raw.data)
      if (!result.ok) {
        errors.push(
          `${describePort(port)} 不符合 ${port.schema.id}@${port.schema.version}：${result.errors.join('；')}`
        )
        continue
      }
    }
    packets[port.id] = {
      type: port.type === 'any' ? valueType(raw) : port.type,
      value: raw,
      ...(port.schema ? { schema: port.schema } : {}),
      source: { nodeId: node.id, portId: port.id, runId },
      createdAt: Date.now()
    }
  }

  for (const port of resolved.out) {
    if (port.required && !packets[port.id]) {
      errors.push(`缺少必需输出：${describePort(port)}`)
    }
  }
  return { value: packets, errors }
}

/**
 * 只按边的 target portId 填充输入；不再按节点类型或上游标题猜测数据含义。
 * 已连接但上游没有产生对应输出也会明确报错，避免静默使用旧值或固定值。
 */
export function collectContractInputs(
  node: CanvasNode,
  edges: CanvasEdge[],
  outputs: ReadonlyMap<string, ContractOutputs>
): ContractResult<ContractInputMap> {
  const spec = getNodeType(node.type)
  if (!spec) return { value: new Map(), errors: [`未知节点类型：${node.type}`] }

  const errors: string[] = []
  const mutable = new Map<string, NodeValuePacket[]>()
  const resolved = portsOf(node)
  const inputPorts = new Map(resolved.in.map((port) => [port.id, port]))

  for (const edge of edges) {
    if (edge.to.nodeId !== node.id) continue
    const target = inputPorts.get(edge.to.portId)
    if (!target) {
      errors.push(`连线 ${edge.id} 指向不存在的输入端口：${edge.to.portId}`)
      continue
    }
    const packet = outputs.get(edge.from.nodeId)?.[edge.from.portId]
    if (!packet) {
      errors.push(`连线 ${edge.id} 的上游未产生 ${edge.from.portId} 输出`)
      continue
    }
    if (!portCompatible(packet.type, target.type)) {
      errors.push(
        `${describePort(target)} 需要 ${target.type}，上游 ${packet.source.portId} 实际为 ${packet.type}`
      )
      continue
    }
    if (packet.type === 'json' && target.type === 'json' && target.schema) {
      if (packet.schema && !nodeSchemasCompatible(packet.schema, target.schema)) {
        errors.push(
          `${describePort(target)} 的 Schema ${target.schema.id}@${target.schema.version} 与上游 ${packet.schema.id}@${packet.schema.version} 不兼容`
        )
        continue
      }
      if (packet.value.kind !== 'json') {
        errors.push(`${describePort(target)} 收到的 JSON 数据包内容类型无效`)
        continue
      }
      const result = validateNodeSchema(target.schema, packet.value.data)
      if (!result.ok) {
        errors.push(`${describePort(target)} 校验失败：${result.errors.join('；')}`)
        continue
      }
    }
    const values = mutable.get(target.id) ?? []
    values.push(packet)
    mutable.set(target.id, values)
  }

  for (const port of resolved.in) {
    const count = mutable.get(port.id)?.length ?? 0
    if (port.required && count === 0) errors.push(`缺少必需输入：${describePort(port)}`)
    if (port.cardinality === 'one' && count > 1) {
      errors.push(`${describePort(port)} 是单值输入，但收到 ${count} 条连线`)
    }
  }

  return { value: mutable, errors }
}

export function inputPackets(inputs: ContractInputMap, portId: string): readonly NodeValuePacket[] {
  return inputs.get(portId) ?? []
}

export function inputText(inputs: ContractInputMap, portId: string): string {
  return inputPackets(inputs, portId)
    .map((packet) => (packet.value.kind === 'text' ? packet.value.text : ''))
    .filter(Boolean)
    .join('\n\n---\n\n')
}

export function inputJson(inputs: ContractInputMap, portId: string): unknown[] {
  return inputPackets(inputs, portId)
    .filter((packet) => packet.value.kind === 'json')
    .map((packet) => (packet.value.kind === 'json' ? packet.value.data : null))
}

export function inputMedia<K extends 'image' | 'video' | 'audio'>(
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
