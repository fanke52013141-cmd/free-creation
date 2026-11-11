import type { CanvasEdge, CanvasNode } from '@shared/types'
import type {
  CompositeGraphEdge,
  CompositeGraphNode,
  CompositeManifest,
  CompositeManifestIssue,
  CompositePort
} from '@shared/composite/manifest'
import { parseCompositeManifest } from '@shared/composite/manifest'

export interface CompositeEditorBuildInput {
  manifest: CompositeManifest
  nodes: readonly CanvasNode[]
  edges: readonly CanvasEdge[]
  /** 画布 shape ID → 已确认的内部节点 ID（来自创建时的 meta）。 */
  internalIdByShapeId: ReadonlyMap<string, string>
  /** 新加入节点的稳定内部 ID 生成器；不依赖数组下标。 */
  nextInternalId: () => string
}

export interface CompositeEditorBuildResult {
  manifest: CompositeManifest
  /** 结构性错误（不能保存为草稿）。 */
  issues: CompositeManifestIssue[]
  /** 可定位的映射失效提示（发布前必须处理，但草稿允许保留）。 */
  staleMappings: string[]
}

function portSnapshot(ports: CanvasNode['ports']): NonNullable<CompositeGraphNode['ports']> {
  return ports.map((port) => ({
    id: port.id,
    name: port.name,
    dir: port.dir,
    type: port.type as CompositePort['type'],
    required: port.required,
    cardinality: port.cardinality,
    ...(port.schema ? { schemaRef: { id: port.schema.id, version: port.schema.version } } : {})
  }))
}

function nestedCapability(node: CompositeGraphNode): { id: string; version: string } | null {
  if (node.nodeType !== 'composite' || !node.config) return null
  try {
    const parsed = JSON.parse(node.config) as { manifest?: { capabilityId?: unknown; version?: unknown } }
    return typeof parsed.manifest?.capabilityId === 'string' &&
      typeof parsed.manifest.version === 'string'
      ? { id: parsed.manifest.capabilityId, version: parsed.manifest.version }
      : null
  } catch {
    return null
  }
}

/**
 * 依赖随内部图重建：节点依赖按现有节点类型/契约版本生成；嵌套节点流依赖按固定
 * config 快照生成。删除节点不会留下悬空 node 依赖，也不会自动改用最新版本。
 */
function rebuildDependencies(
  previous: CompositeManifest,
  nodes: readonly CompositeGraphNode[]
): CompositeManifest['dependencies'] {
  const nodeDeps = new Map<string, NonNullable<CompositeManifest['dependencies']>[number]>()
  for (const node of nodes) {
    nodeDeps.set(`${node.nodeType}@${node.contractVersion}`, {
      kind: 'node',
      id: node.nodeType,
      contractVersion: node.contractVersion
    })
  }
  const capabilityDeps = new Map<string, NonNullable<CompositeManifest['dependencies']>[number]>()
  for (const node of nodes) {
    const nested = nestedCapability(node)
    if (nested) {
      capabilityDeps.set(`${nested.id}@${nested.version}`, {
        kind: 'capability',
        id: nested.id,
        version: nested.version
      })
    }
  }
  // 保留旧版本里其他非节点依赖（media/model），但去掉已无人使用的 capability。
  const retained = (previous.dependencies ?? []).filter(
    (dependency) => dependency.kind === 'media' || dependency.kind === 'model'
  )
  return [...nodeDeps.values(), ...capabilityDeps.values(), ...retained]
}

/**
 * 从全屏编辑画布重建内部图（W1）。
 *
 * 关键规则：
 * - 内部节点 ID 来自创建时的稳定映射，不按数组下标重新编号；
 * - 已确认的公开输入/输出原样保留，不因增删节点自动重写；
 * - 映射失效只记录可定位问题（节点 ID + 端口 ID），由发布校验阻断，不静默丢弃。
 */
export function buildCompositeManifestFromEditor(
  input: CompositeEditorBuildInput
): CompositeEditorBuildResult {
  const used = new Set<string>()
  const internalIdByShape = new Map<string, string>()
  for (const node of input.nodes) {
    const existing = input.internalIdByShapeId.get(node.id)
    if (existing && !used.has(existing)) {
      internalIdByShape.set(node.id, existing)
      used.add(existing)
      continue
    }
    let next = input.nextInternalId()
    while (used.has(next)) next = input.nextInternalId()
    internalIdByShape.set(node.id, next)
    used.add(next)
  }

  const graphNodes: CompositeGraphNode[] = input.nodes.map((node) => ({
    id: internalIdByShape.get(node.id)!,
    nodeType: node.type,
    contractVersion: node.contractVersion,
    title: node.title,
    dx: node.x,
    dy: node.y,
    w: node.w,
    h: node.h,
    ...(node.content.kind === 'text' ? { text: node.content.text } : {}),
    ...(typeof node.params?.config === 'string' ? { config: node.params.config } : {}),
    ...(node.content.kind === 'media'
      ? {
          mediaRefs: [
            {
              mediaId: node.content.mediaId,
              mediaPath: String(node.params?.mediaPath ?? ''),
              mime: String(node.params?.mediaMime ?? '')
            }
          ]
        }
      : {}),
    ports: portSnapshot(node.ports)
  }))
  const graphEdges: CompositeGraphEdge[] = input.edges
    .filter(
      (edge) => internalIdByShape.has(edge.from.nodeId) && internalIdByShape.has(edge.to.nodeId)
    )
    .map((edge) => ({
      from: { nodeId: internalIdByShape.get(edge.from.nodeId)!, portId: edge.from.portId },
      to: { nodeId: internalIdByShape.get(edge.to.nodeId)!, portId: edge.to.portId }
    }))

  const nodeById = new Map(graphNodes.map((node) => [node.id, node]))
  const portOf = (
    nodeId: string,
    portId: string
  ): NonNullable<CompositeGraphNode['ports']>[number] | undefined =>
    nodeById.get(nodeId)?.ports?.find((port) => port.id === portId)
  const staleMappings: string[] = []

  const inputs = input.manifest.inputs.map((port) => {
    const target = port.targets[0]
    if (!target) {
      staleMappings.push(`输入「${port.label}」（${port.id}）没有映射目标`)
      return port
    }
    if (!nodeById.has(target.nodeId)) {
      staleMappings.push(
        `输入「${port.label}」（${port.id}）映射的节点 ${target.nodeId} 已不存在（目标端口 ${target.nodeId}.${target.portId}）`
      )
      return port
    }
    if (!portOf(target.nodeId, target.portId)) {
      staleMappings.push(
        `输入「${port.label}」（${port.id}）映射的端口 ${target.nodeId}.${target.portId} 已不存在`
      )
    }
    return port
  })
  const outputs = input.manifest.outputs.map((port) => {
    if (!nodeById.has(port.source.nodeId)) {
      staleMappings.push(
        `输出「${port.label}」（${port.id}）来源节点 ${port.source.nodeId} 已不存在`
      )
      return port
    }
    if (!portOf(port.source.nodeId, port.source.portId)) {
      staleMappings.push(
        `输出「${port.label}」（${port.id}）来源端口 ${port.source.nodeId}.${port.source.portId} 已不存在`
      )
    }
    return port
  })

  const manifest: CompositeManifest = {
    ...input.manifest,
    graph: { nodes: graphNodes, edges: graphEdges },
    inputs,
    outputs,
    dependencies: rebuildDependencies(input.manifest, graphNodes)
  }
  const parsed = parseCompositeManifest(manifest)
  if (!parsed.ok) return { manifest, issues: parsed.issues, staleMappings }
  return { manifest: parsed.manifest, issues: [], staleMappings }
}
