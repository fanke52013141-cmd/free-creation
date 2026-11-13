import type { CompositeManifest } from './manifest'

type ManifestNode = CompositeManifest['graph']['nodes'][number]
type NodePort = NonNullable<ManifestNode['ports']>[number]

export interface DerivedBoundary {
  inputs: CompositeManifest['inputs']
  outputs: CompositeManifest['outputs']
}

const OUTPUT_PRIORITY = ['image', 'video', 'audio', 'file', 'text', 'markdown', 'json'] as const
const INPUT_PRIORITY = [
  'text',
  'markdown',
  'json',
  'image',
  'video',
  'audio',
  'file',
  'any'
] as const

function unique(base: string, used: Set<string>): string {
  let id = base
  let index = 2
  while (used.has(id)) id = `${base}-${index++}`
  used.add(id)
  return id
}

/**
 * 源节点的主输入端口（2026-11-13 用户裁决：节点流默认是单输入单输出黑盒）。
 * 必填端口优先（节点真正赖以运行的输入），其次按内容类型优先级（文本驱动优先），
 * 同级保持声明顺序。组合默认只公开每个源节点的这一个主输入；辅助可选端口
 * （如 ai-process 的 in-json 上下文）不自动公开。多个源节点 → 多个公开输入，
 * 即「多种输入进来才分裂成多个输入端口」，与节点的黑盒心智一致。
 */
export function primaryInputPort<T extends { dir: string; type: string; required?: boolean }>(
  ports: readonly T[]
): T | undefined {
  const inputs = ports.filter((port) => port.dir === 'in')
  if (inputs.length === 0) return undefined
  const rank = (port: T): number => {
    const typeRank = INPUT_PRIORITY.indexOf(port.type as never)
    return (port.required ? 0 : 1) * 100 + (typeRank < 0 ? 99 : typeRank)
  }
  return [...inputs].sort((a, b) => rank(a) - rank(b))[0]
}

/**
 * 从固定版本内部图推导默认公开边界（2026-11-13 修正：单主输入黑盒）：
 * - 输入：没有内部上游的边界源节点，每个源节点只公开一个主输入（primaryInputPort），
 *   并标为必填——这样缺输入点运行会触发补输入弹窗，而不是空跑后下游契约失败。
 *   文本节点默认暴露文本输入（带默认正文）；辅助可选端口不自动公开。
 *   多个源节点各自贡献一个主输入 → 多输入。已有内部来源的端口不公开。
 * - 输出：只取没有内部下游的汇节点的单个主输出，媒体优先；
 *   中间节点的多路 text/markdown/json 不再自动公开。
 * 该函数只做结构推导，不做类型/连线合法性校验；发布前仍走 validateCompositeManifest。
 * 公开边界始终随内部图自动推导（2026-11-11 裁决），不提供手动挑选。
 */
export function deriveCompositeBoundary(manifest: CompositeManifest): DerivedBoundary {
  const nodes = manifest.graph.nodes
  const edges = manifest.graph.edges
  const incoming = new Set(edges.map((edge) => `${edge.to.nodeId}:${edge.to.portId}`))
  const hasIncoming = new Set(edges.map((edge) => edge.to.nodeId))
  const hasOutgoing = new Set(edges.map((edge) => edge.from.nodeId))
  const usedInputIds = new Set<string>()
  const usedOutputIds = new Set<string>()
  const inputs: CompositeManifest['inputs'] = []
  const outputs: CompositeManifest['outputs'] = []

  for (const node of nodes as ManifestNode[]) {
    if (hasIncoming.has(node.id)) continue
    const ports = (node.ports ?? []) as NodePort[]
    const textPort = ports.find((port) => port.dir === 'in' && port.type === 'text')
    if (node.nodeType === 'text' && textPort) {
      inputs.push({
        id: unique(`${node.id}-${textPort.id}`, usedInputIds),
        label: textPort.name || '文本输入',
        type: 'text',
        required: true,
        cardinality: 'one',
        description: '组合的文本输入；未提交时使用默认文本',
        targets: [{ nodeId: node.id, portId: textPort.id }],
        ...(node.text?.trim() ? { defaultValue: node.text.trim() } : {})
      })
      continue
    }
    const primary = primaryInputPort(
      ports.filter((port) => port.dir === 'in' && !incoming.has(`${node.id}:${port.id}`))
    )
    if (primary) {
      inputs.push({
        id: unique(`${node.id}-${primary.id}`, usedInputIds),
        label: primary.name,
        type: primary.type as CompositeManifest['inputs'][number]['type'],
        required: true,
        cardinality: primary.cardinality,
        ...(primary.schemaRef ? { schemaRef: primary.schemaRef } : {}),
        targets: [{ nodeId: node.id, portId: primary.id }]
      })
    }
  }

  for (const node of nodes as ManifestNode[]) {
    if (hasOutgoing.has(node.id)) continue
    const ports = ((node.ports ?? []) as NodePort[]).filter((port) => port.dir === 'out')
    const primary = [...ports].sort(
      (a, b) => OUTPUT_PRIORITY.indexOf(a.type as never) - OUTPUT_PRIORITY.indexOf(b.type as never)
    )[0]
    if (!primary) continue
    outputs.push({
      id: unique(`${node.id}-${primary.id}`, usedOutputIds),
      label: primary.name || '输出',
      type: primary.type as CompositeManifest['inputs'][number]['type'],
      required: primary.required,
      cardinality: primary.cardinality,
      ...(primary.schemaRef ? { schemaRef: primary.schemaRef } : {}),
      source: { nodeId: node.id, portId: primary.id }
    })
  }

  return { inputs, outputs }
}
