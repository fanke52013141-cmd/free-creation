import type { CanvasEdge, CanvasNode } from '@shared/types'
import type {
  CompositeGraphEdge,
  CompositeGraphNode,
  CompositeManifest,
  CompositeManifestIssue,
  CompositePort
} from '@shared/composite/manifest'
import { parseCompositeManifest } from '@shared/composite/manifest'
import { deriveCompositeBoundary } from '@shared/composite/boundary'
import {
  readCompositeManifest,
  readCompositeInstanceRef
} from '@shared/composite/outputs'
import { portPairCompatible } from '@shared/port-compatibility'

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
  const ref = readCompositeInstanceRef(node.config)
  if (ref) return { id: ref.capabilityId, version: ref.version }
  try {
    const parsed = JSON.parse(node.config) as {
      manifest?: { capabilityId?: unknown; version?: unknown }
      capabilityId?: unknown
      version?: unknown
    }
    // 内嵌快照形态同样登记固定 capabilityId@version。
    const source = parsed.manifest ?? parsed
    return typeof source.capabilityId === 'string' && typeof source.version === 'string'
      ? { id: source.capabilityId, version: source.version }
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

export interface CompositeEditorVersionRecord {
  manifest: CompositeManifest
  contentHash: string
}

/**
 * 编辑页铺图前解析直接嵌套的固定版本引用。内嵌快照直接复用；引用形态必须从发布仓库
 * 解析并核对 contentHash，再把快照缓存到 node shape 的 meta.compositeManifest，
 * 否则 resolvePorts 看不到公开端口，createEdge 会静默失败并在保存时丢线。
 */
export async function resolveCompositeEditorManifestCache(
  manifest: CompositeManifest,
  getVersion: (input: {
    capabilityId: string
    version: string
  }) => Promise<CompositeEditorVersionRecord | null>
): Promise<Map<string, CompositeManifest>> {
  const resolved = new Map<string, CompositeManifest>()
  for (const node of manifest.graph.nodes) {
    if (node.nodeType !== 'composite') continue
    const inline = readCompositeManifest(node.config)
    if (inline) {
      resolved.set(node.id, inline)
      continue
    }
    const ref = readCompositeInstanceRef(node.config)
    if (!ref) continue
    const record = await getVersion({ capabilityId: ref.capabilityId, version: ref.version })
    if (!record || (ref.contentHash && record.contentHash !== ref.contentHash)) {
      throw new Error(`内部组合节点固定版本引用无法解析：${ref.capabilityId}@${ref.version}`)
    }
    resolved.set(node.id, record.manifest)
  }
  return resolved
}

function portKey(nodeId: string, portId: string): string {
  return `${nodeId}:${portId}`
}

function uniqueBoundaryId(base: string, used: ReadonlySet<string>, reserved: ReadonlySet<string>): string {
  let candidate = base
  let index = 2
  while (used.has(candidate) || reserved.has(candidate)) {
    candidate = `${base.slice(0, 60)}-${index++}`
  }
  return candidate
}

/**
 * 编辑保存不能简单用 deriveCompositeBoundary 覆盖旧契约：合法的手工/API 边界可能包含
 * 一个公开输入广播到多个 targets，或非源/汇节点上的外部端口。这里先保留仍有效的既有
 * 公开端口与 ID，再只为尚未覆盖的源/汇端口补充自动推导边界。
 */
function mergeCompositeBoundary(
  previous: CompositeManifest,
  graph: CompositeManifest['graph'],
  derived: ReturnType<typeof deriveCompositeBoundary>
): Pick<CompositeManifest, 'inputs' | 'outputs'> {
  const nodeById = new Map(graph.nodes.map((node) => [node.id, node]))
  const portOf = (
    nodeId: string,
    portId: string
  ): NonNullable<CompositeGraphNode['ports']>[number] | undefined =>
    nodeById.get(nodeId)?.ports?.find((port) => port.id === portId)
  const usedInputTargets = new Set<string>()
  const usedOutputSources = new Set<string>()
  const reservedInputIds = new Set(previous.inputs.map((input) => input.id))
  const reservedOutputIds = new Set(previous.outputs.map((output) => output.id))
  const inputs: CompositeManifest['inputs'] = []
  const outputs: CompositeManifest['outputs'] = []

  for (const input of previous.inputs) {
    // 新发布只接受 schemaRef；历史内联 schema 不能通过编辑保存偷偷带入新版本。
    if (input.schema !== undefined) continue
    const targets = input.targets.filter((target) => {
      const port = portOf(target.nodeId, target.portId)
      if (!port || port.dir !== 'in') return false
      if (!portPairCompatible(
        { type: input.type, schema: input.schemaRef },
        { type: port.type, schema: port.schemaRef }
      )) return false
      if (input.cardinality === 'many' && port.cardinality === 'one') return false
      const key = portKey(target.nodeId, target.portId)
      if (usedInputTargets.has(key)) return false
      usedInputTargets.add(key)
      return true
    })
    if (targets.length > 0) inputs.push({ ...input, targets })
  }

  for (const output of previous.outputs) {
    if (output.schema !== undefined) continue
    const port = portOf(output.source.nodeId, output.source.portId)
    if (!port || port.dir !== 'out') continue
    if (!portPairCompatible(
      { type: port.type, schema: port.schemaRef },
      { type: output.type, schema: output.schemaRef }
    )) continue
    if (port.cardinality === 'many' && output.cardinality === 'one') continue
    const key = portKey(output.source.nodeId, output.source.portId)
    if (usedOutputSources.has(key)) continue
    usedOutputSources.add(key)
    outputs.push(output)
  }

  for (const input of inputs) {
    if (input.defaultValue !== undefined) continue
    const derivedMatch = derived.inputs.find((candidate) =>
      candidate.targets.some((target) =>
        input.targets.some((existing) => portKey(existing.nodeId, existing.portId) === portKey(target.nodeId, target.portId))
      )
    )
    if (derivedMatch?.defaultValue !== undefined) input.defaultValue = derivedMatch.defaultValue
  }

  const usedInputIds = new Set(inputs.map((input) => input.id))
  for (const input of derived.inputs) {
    const targets = input.targets.filter((target) => {
      const key = portKey(target.nodeId, target.portId)
      if (usedInputTargets.has(key)) return false
      usedInputTargets.add(key)
      return true
    })
    if (targets.length === 0) continue
    const id = uniqueBoundaryId(input.id, usedInputIds, reservedInputIds)
    usedInputIds.add(id)
    inputs.push({ ...input, id, targets })
  }

  const usedOutputIds = new Set(outputs.map((output) => output.id))
  for (const output of derived.outputs) {
    const key = portKey(output.source.nodeId, output.source.portId)
    if (usedOutputSources.has(key)) continue
    usedOutputSources.add(key)
    const id = uniqueBoundaryId(output.id, usedOutputIds, reservedOutputIds)
    usedOutputIds.add(id)
    outputs.push({ ...output, id })
  }

  return { inputs, outputs }
}

/**
 * 从全屏编辑画布重建内部图。
 *
 * 关键规则（2026-11-11 用户裁决）：
 * - 内部节点 ID 来自创建时的稳定映射，不按数组下标重新编号；
 * - 公开输入/输出始终按内部图自动推导（源节点输入规范 → 公开输入，
 *   汇节点主输出规范 → 公开输出），不再保留旧边界、也不提供手动挑选；
 * - 类型/连线合法性仍由发布前的 validateCompositeManifest 负责。
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
      to: { nodeId: internalIdByShape.get(edge.to.nodeId)!, portId: edge.to.portId },
      // NF-8.3a：扇入顺序必须持久化到 manifest 边的 order，不能因保存重排而丢失。
      ...(edge.connectOrder !== undefined ? { order: edge.connectOrder } : {})
    }))

  const graph = { nodes: graphNodes, edges: graphEdges }
  // 公开边界随内部图实时推导，但必须保留仍有效的既有 ID/映射（广播 targets、非源汇端口）。
  const boundary = mergeCompositeBoundary(
    input.manifest,
    graph,
    deriveCompositeBoundary({ ...input.manifest, graph })
  )
  const manifest: CompositeManifest = {
    ...input.manifest,
    runtimeVersion: 2,
    graph,
    inputs: boundary.inputs,
    outputs: boundary.outputs,
    dependencies: rebuildDependencies(input.manifest, graphNodes)
  }
  const parsed = parseCompositeManifest(manifest)
  if (!parsed.ok) return { manifest, issues: parsed.issues }
  return { manifest: parsed.manifest, issues: [] }
}
