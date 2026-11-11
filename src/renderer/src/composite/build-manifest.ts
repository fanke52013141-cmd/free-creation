import type { CanvasEdge, CanvasNode, PortDecl } from '@shared/types'
import { COMPOSITE_PORT_TYPES } from '@shared/composite/manifest'
import type {
  CompositeDependency,
  CompositeGraphEdge,
  CompositeGraphNode,
  CompositeInput,
  CompositeManifest,
  CompositeManifestIssue,
  CompositePort,
  CompositeOutput
} from '@shared/composite/manifest'
import { parseCompositeManifest } from '@shared/composite/manifest'

export interface CompositeBuildOptions {
  capabilityId: string
  name: string
  version: string
  description?: string
  tags?: string[]
  nodes: readonly CanvasNode[]
  edges: readonly CanvasEdge[]
  /** 选区内的画布节点 ID（CanvasNode.id）。 */
  selectedNodeIds: readonly string[]
}

export type CompositeBuildResult =
  | { ok: true; manifest: CompositeManifest }
  | { ok: false; issues: CompositeManifestIssue[] }

function sanitizePublicId(value: string): string {
  const normalized = value
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
  return (normalized || 'port').slice(0, 64)
}

function uniquePublicId(base: string, used: Set<string>): string {
  let candidate = sanitizePublicId(base)
  let index = 2
  while (used.has(candidate)) {
    candidate = `${sanitizePublicId(base).slice(0, 60)}-${index}`
    index += 1
  }
  used.add(candidate)
  return candidate
}

function portSnapshot(ports: readonly PortDecl[]): NonNullable<CompositeGraphNode['ports']> {
  return ports
    .filter((port) => (COMPOSITE_PORT_TYPES as readonly string[]).includes(port.type))
    .map((port) => ({
    id: port.id,
    name: port.name,
    dir: port.dir,
    type: port.type as CompositePort['type'],
    required: port.required,
    cardinality: port.cardinality,
      ...(port.schema ? { schemaRef: { id: port.schema.id, version: port.schema.version } } : {})
    }))
}

function findPort(node: CanvasNode, portId: string): PortDecl | undefined {
  return node.ports.find((port) => port.id === portId)
}

/** 从内部组合节点的固定 config 快照读取嵌套版本；不解析当前最新版本。 */
function parseNestedCompositeManifest(node: CanvasNode): CompositeManifest | null {
  if (typeof node.params.config !== 'string') return null
  try {
    const parsed = JSON.parse(node.params.config) as { manifest?: unknown }
    if (!parsed.manifest) return null
    const result = parseCompositeManifest(parsed.manifest)
    return result.ok ? result.manifest : null
  } catch {
    return null
  }
}

/**
 * 从已选节点 + 真实连线生成组合契约候选（P1 草稿的默认边界）。
 *
 * 只做可判定的候选提取；端口存在性、类型兼容、递归与预算由 publish 校验负责。
 * 外部进入选区的边 → 公开输入；选区连向外部或终态输出 → 公开输出；
 * 必填但未接线的输入端口的也列为公开输入候选，避免保存后缺项不可见。
 */
export function buildCompositeManifestFromGraph(
  options: CompositeBuildOptions
): CompositeBuildResult {
  const issues: CompositeManifestIssue[] = []
  const selected = new Set(options.selectedNodeIds)
  const nodes = options.nodes.filter((node) => selected.has(node.id))
  if (nodes.length === 0) {
    return { ok: false, issues: [{ path: 'graph.nodes', message: '至少选择一个节点' }] }
  }
  const nodeById = new Map(nodes.map((node) => [node.id, node]))
  const internalIds = new Map<string, string>()
  nodes.forEach((node, index) => internalIds.set(node.id, `n${index + 1}`))
  const minX = Math.min(...nodes.map((node) => node.x))
  const minY = Math.min(...nodes.map((node) => node.y))

  const graphNodes: CompositeGraphNode[] = nodes.map((node) => {
    const internalId = internalIds.get(node.id)!
    return {
      id: internalId,
      nodeType: node.type,
      contractVersion: node.contractVersion,
      title: node.title,
      dx: Math.round(node.x - minX),
      dy: Math.round(node.y - minY),
      w: node.w,
      h: node.h,
      ...(node.content.kind === 'text' ? { text: node.content.text } : {}),
      ...(typeof node.params.config === 'string' ? { config: node.params.config } : {}),
      ...(node.content.kind === 'media' ? { mediaRefs: [] } : {}),
      ports: portSnapshot(node.ports)
    }
  })

  const internalEdges: CompositeGraphEdge[] = []
  const inputs = new Map<string, CompositeInput>()
  const outputs = new Map<string, CompositeOutput>()
  const usedInputIds = new Set<string>()
  const usedOutputIds = new Set<string>()
  const incomingExternal = new Set<string>()
  const outgoingExternal = new Set<string>()

  for (const edge of options.edges) {
    const fromSelected = selected.has(edge.from.nodeId)
    const toSelected = selected.has(edge.to.nodeId)
    if (fromSelected && toSelected) {
      const fromInternal = internalIds.get(edge.from.nodeId)!
      const toInternal = internalIds.get(edge.to.nodeId)!
      const fromNode = nodeById.get(edge.from.nodeId)!
      const toNode = nodeById.get(edge.to.nodeId)!
      if (!findPort(fromNode, edge.from.portId) || !findPort(toNode, edge.to.portId)) {
        issues.push({
          path: `graph.edges.${edge.id}`,
          message: '内部连线引用了不存在的端口，发布前需修复'
        })
        continue
      }
      internalEdges.push({
        from: { nodeId: fromInternal, portId: edge.from.portId },
        to: { nodeId: toInternal, portId: edge.to.portId }
      })
      continue
    }
    if (!fromSelected && toSelected) {
      const target = nodeById.get(edge.to.nodeId)
      const port = target ? findPort(target, edge.to.portId) : undefined
      if (!target || !port) {
        issues.push({ path: `inputs.${edge.id}`, message: '外部输入连线指向不存在的节点端口' })
        continue
      }
      if (!(COMPOSITE_PORT_TYPES as readonly string[]).includes(port.type)) {
        issues.push({ path: `inputs.${edge.id}`, message: `组合暂不支持 ${port.type} 类型的公开输入` })
        continue
      }
      incomingExternal.add(`${edge.to.nodeId}:${edge.to.portId}`)
      const key = `${edge.to.nodeId}:${edge.to.portId}`
      if (!inputs.has(key)) {
        const id = uniquePublicId(`${internalIds.get(target.id)}-${port.id}`, usedInputIds)
        inputs.set(key, {
          id,
          label: port.name,
          type: port.type as CompositePort['type'],
          required: port.required,
          cardinality: port.cardinality,
          ...(port.description ? { description: port.description } : {}),
          ...(port.schema ? { schemaRef: { id: port.schema.id, version: port.schema.version } } : {}),
          targets: [{ nodeId: internalIds.get(target.id)!, portId: port.id }]
        })
      }
      continue
    }
    if (fromSelected && !toSelected) {
      const source = nodeById.get(edge.from.nodeId)
      const port = source ? findPort(source, edge.from.portId) : undefined
      if (!source || !port) {
        issues.push({ path: `outputs.${edge.id}`, message: '对外输出连线来自不存在的节点端口' })
        continue
      }
      if (!(COMPOSITE_PORT_TYPES as readonly string[]).includes(port.type)) {
        issues.push({ path: `outputs.${edge.id}`, message: `组合暂不支持 ${port.type} 类型的公开输出` })
        continue
      }
      outgoingExternal.add(`${edge.from.nodeId}:${edge.from.portId}`)
      const key = `${edge.from.nodeId}:${edge.from.portId}`
      if (!outputs.has(key)) {
        const id = uniquePublicId(`${internalIds.get(source.id)}-${port.id}`, usedOutputIds)
        outputs.set(key, {
          id,
          label: port.name,
          type: port.type as CompositePort['type'],
          required: port.required,
          cardinality: port.cardinality,
          ...(port.description ? { description: port.description } : {}),
          ...(port.schema ? { schemaRef: { id: port.schema.id, version: port.schema.version } } : {}),
          source: { nodeId: internalIds.get(source.id)!, portId: port.id }
        })
      }
    }
  }

  // 边界源节点：没有内部上游。文本节点默认把正文变成公开输入；
  // 其余源节点的必填输入端口也公开。外部连线已映射的目标不重复添加。
  const internalIncoming = new Set(internalEdges.map((edge) => `${edge.to.nodeId}:${edge.to.portId}`))
  for (const node of nodes) {
    const internalId = internalIds.get(node.id)!
    const hasInternalIncoming = internalEdges.some((edge) => edge.to.nodeId === internalId)
    if (hasInternalIncoming) continue
    if (node.type === 'text') {
      const port = node.ports.find((item) => item.dir === 'in' && item.type === 'text')
      if (port) {
        const key = `${node.id}:${port.id}`
        if (!incomingExternal.has(key)) {
          const defaultValue = node.content.kind === 'text' ? node.content.text.trim() : ''
          const id = uniquePublicId(`${internalId}-${port.id}`, usedInputIds)
          inputs.set(`source-${key}`, {
            id,
            label: port.name || '文本输入',
            type: 'text',
            required: true,
            cardinality: 'one',
            description: '组合的文本输入；未提交时使用默认文本',
            targets: [{ nodeId: internalId, portId: port.id }],
            ...(defaultValue ? { defaultValue } : {})
          })
          incomingExternal.add(key)
        }
      }
    }
    for (const port of node.ports) {
      if (port.dir !== 'in' || !port.required) continue
      const key = `${node.id}:${port.id}`
      if (incomingExternal.has(key) || internalIncoming.has(`${internalId}:${port.id}`)) continue
      const id = uniquePublicId(`${internalId}-${port.id}`, usedInputIds)
      inputs.set(`required-${key}`, {
        id,
        label: port.name,
        type: port.type as CompositePort['type'],
        required: true,
        cardinality: port.cardinality,
        ...(port.description ? { description: port.description } : {}),
        ...(port.schema ? { schemaRef: { id: port.schema.id, version: port.schema.version } } : {}),
        targets: [{ nodeId: internalId, portId: port.id }]
      })
      incomingExternal.add(key)
    }
  }

  // 只公开汇节点（没有内部下游）的单个主输出：媒体优先，其次文本/JSON。
  // 中间节点的多路输出不再自动公开，用户可在边界编辑器显式添加。
  const primaryTypes = ['image', 'video', 'audio', 'file', 'text', 'markdown', 'json'] as const
  for (const node of nodes) {
    const internalId = internalIds.get(node.id)!
    if (internalEdges.some((edge) => edge.from.nodeId === internalId)) continue
    const candidates = node.ports.filter((port) => port.dir === 'out')
    const primary =
      [...candidates].sort(
        (a, b) => primaryTypes.indexOf(a.type as never) - primaryTypes.indexOf(b.type as never)
      )[0] ?? candidates[0]
    if (!primary) continue
    const publicKey = `${node.id}:${primary.id}`
    if (outputs.has(publicKey)) continue
    const id = uniquePublicId(`${internalId}-${primary.id}`, usedOutputIds)
    outputs.set(publicKey, {
      id,
      label: primary.name,
      type: primary.type as CompositePort['type'],
      required: primary.required,
      cardinality: primary.cardinality,
      ...(primary.description ? { description: primary.description } : {}),
      ...(primary.schema ? { schemaRef: { id: primary.schema.id, version: primary.schema.version } } : {}),
      source: { nodeId: internalId, portId: primary.id }
    })
  }

  if (outputs.size === 0) {
    issues.push({ path: 'outputs', message: '组合至少需要一个公开输出' })
  }

  const dependencies: CompositeDependency[] = [
    ...new Map(
      nodes.map((node) => [
        `${node.type}@${node.contractVersion}`,
        { kind: 'node' as const, id: node.type, contractVersion: node.contractVersion }
      ])
    ).values()
  ]

  // 嵌套节点流：公开契约里登记固定 capabilityId@version，发布/运行都按快照解析，
  // 不能因为内层发布了新版本就静默改用最新版。
  for (const node of nodes) {
    if (node.type !== 'composite') continue
    const nested = parseNestedCompositeManifest(node)
    if (!nested) {
      issues.push({
        path: `graph.nodes.${internalIds.get(node.id)}`,
        message: '内部组合节点缺少可解析的固定版本 manifest'
      })
      continue
    }
    dependencies.push({
      kind: 'capability',
      id: nested.capabilityId,
      version: nested.version
    })
  }

  const manifest: CompositeManifest = {
    schemaVersion: 1,
    runtimeVersion: 2,
    capabilityId: options.capabilityId,
    version: options.version,
    name: options.name,
    ...(options.description ? { description: options.description } : {}),
    ...(options.tags?.length ? { tags: options.tags } : {}),
    inputs: [...inputs.values()],
    outputs: [...outputs.values()],
    graph: { nodes: graphNodes, edges: internalEdges },
    dependencies,
    executionPolicy: {
      timeoutMs: 30 * 60 * 1000,
      maxDepth: 5,
      maxExpandedNodes: 40,
      maxExpandedEdges: 120,
      waitForInput: true
    }
  }
  const parsed = parseCompositeManifest(manifest)
  if (!parsed.ok) return { ok: false, issues: [...issues, ...parsed.issues] }
  return { ok: true, manifest: parsed.manifest }
}
