import type { CompositeManifest } from './manifest'

type ManifestNode = CompositeManifest['graph']['nodes'][number]
type NodePort = NonNullable<ManifestNode['ports']>[number]

export interface DerivedBoundary {
  inputs: CompositeManifest['inputs']
  outputs: CompositeManifest['outputs']
}

const OUTPUT_PRIORITY = ['image', 'video', 'audio', 'file', 'text', 'markdown', 'json'] as const

function unique(base: string, used: Set<string>): string {
  let id = base
  let index = 2
  while (used.has(id)) id = `${base}-${index++}`
  used.add(id)
  return id
}

/**
 * 从固定版本内部图推导默认公开边界（P2/P4 修正）：
 * - 输入：没有内部上游的边界源节点。文本节点默认暴露文本输入；
 *   其余源节点只暴露必填输入端口；已有内部来源的端口不公开。
 * - 输出：只取没有内部下游的汇节点的单个主输出，媒体优先；
 *   中间节点的多路 text/markdown/json 不再自动公开。
 * 该函数只做结构推导，不做类型/连线合法性校验；发布前仍走 validateCompositeManifest。
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
    for (const port of ports) {
      if (port.dir !== 'in' || !port.required) continue
      if (incoming.has(`${node.id}:${port.id}`)) continue
      inputs.push({
        id: unique(`${node.id}-${port.id}`, usedInputIds),
        label: port.name,
        type: port.type as CompositeManifest['inputs'][number]['type'],
        required: true,
        cardinality: port.cardinality,
        ...(port.schemaRef ? { schemaRef: port.schemaRef } : {}),
        targets: [{ nodeId: node.id, portId: port.id }]
      })
    }
  }

  for (const node of nodes as ManifestNode[]) {
    if (hasOutgoing.has(node.id)) continue
    const ports = ((node.ports ?? []) as NodePort[]).filter((port) => port.dir === 'out')
    const primary = [...ports].sort(
      (a, b) =>
        OUTPUT_PRIORITY.indexOf(a.type as never) - OUTPUT_PRIORITY.indexOf(b.type as never)
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
