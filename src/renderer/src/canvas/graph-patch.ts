// 外部 graph.patch 的权威应用层（F2）。
// main 做结构预检与准入；这里用与 GUI 完全相同的节点 Spec、端口规则和 createEdge
// 校验整批操作，全部通过后才原子应用（单个撤销步），任何一项失败不改变画布。
// 校验在同步阶段完成并模拟最终状态；应用阶段不再做业务判断，避免半张成功图。
import { createShapeId, type Editor, type TLShapeId } from 'tldraw'
import type { PortDecl } from '@shared/types'
import { GraphPatchOpSchema, type GraphPatchOp } from '@shared/agent-access/graph-ops'
import {
  GRAPH_NODE_CONFIG_MAX_BYTES,
  GRAPH_NODE_TITLE_MAX_CHARS
} from '@shared/agent-access/graph-ops'
import { flowInitialConfig } from '@shared/agent-flow/model-defaults'
import type { FeatureBinding } from '@free-creation/model-contracts'
import {
  type MediaResolution,
  type MediaResolutionMap
} from '@shared/agent-access/graph-ops'
import { getNodeType, getNodePorts, type NodeTypeSpec } from '../nodes/registry'
import { createEdge, portPairCompatible } from './graph'
import type { NodeCardShape } from './NodeCardShape'
import { parseMediaResultCollection } from '@shared/engine/values'
import { selectMediaResult } from '../nodes/specs/bodies/shared'
import { arrangeBackdrop, createBackdrop, moveBackdrop } from './backdrop-layout'

export interface GraphPatchApplyCounts {
  nodeCreated: number
  nodeUpdated: number
  nodeDeleted: number
  edgeCreated: number
  edgeDeleted: number
}

export interface GraphPatchPlan {
  created: Array<{ ref?: string; nodeId: TLShapeId }>
  /** 本批创建的 tldraw group（节点之外的形状，供解组使用）。 */
  groups: Array<{ ref?: string; groupId: TLShapeId }>
  counts: GraphPatchApplyCounts
  apply(editor: Editor): void
}

export interface GraphPatchIssue {
  index: number
  code: string
  detail?: string
}

export type GraphPatchPlanResult =
  | { ok: true; plan: GraphPatchPlan }
  | { ok: false; issue: GraphPatchIssue }

interface SimNode {
  nodeType: string
  config: string
  text: string
  exists: boolean
}

interface SimEdge {
  from: { nodeId: TLShapeId; portId: string }
  to: { nodeId: TLShapeId; portId: string }
  exists: boolean
}

function configByteLength(value: string): number {
  return new TextEncoder().encode(value).length
}

function mergeConfig(current: string, patch: Record<string, unknown>): string {
  let base: Record<string, unknown> = {}
  if (current.trim()) {
    try {
      const parsed: unknown = JSON.parse(current)
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed))
        base = parsed as Record<string, unknown>
    } catch {
      // 旧配置不合法时按空配置处理，补丁键仍然生效（与 GUI 设置面板行为一致）
    }
  }
  const merged: Record<string, unknown> = { ...base }
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) delete merged[key]
    else merged[key] = value
  }
  return JSON.stringify(merged)
}

/** 与 GUI 建节点同源的初始配置；agent 提供的键在其上合并（null 删除键）。 */
function initialConfigString(spec: NodeTypeSpec, patch: Record<string, unknown> | undefined, bindings: FeatureBinding[]): string {
  const base = spec.initialConfig
    ? flowInitialConfig(spec.type, spec.initialConfig, bindings)
    : ''
  if (!patch) return base
  return mergeConfig(base, patch)
}

function resolvedPorts(spec: NodeTypeSpec, nodeType: string, config: string, h: number): {
  in: PortDecl[]
  out: PortDecl[]
} {
  const shape = {
    id: 'shape:simulated' as TLShapeId,
    type: 'node-card',
    x: 0,
    y: 0,
    index: 'a1',
    rotation: 0,
    isLocked: false,
    opacity: 1,
    meta: {},
    props: { w: 340, h, nodeType, title: '', config, text: '', mediaId: '', mediaPath: '', mediaMime: '', exec: 'idle' }
  }
  try {
    return getNodePorts(spec, shape as unknown as NodeCardShape)
  } catch {
    return { in: [], out: [] }
  }
}

/** 契约校验入口：schema 解析失败返回 INVALID_INPUT；业务校验返回带 index 的稳定错误码。 */
export function parseGraphPatchOps(raw: unknown): { ok: true; ops: GraphPatchOp[] } | { ok: false; detail: string } {
  const parsed = GraphPatchOpSchema.array().safeParse(raw)
  if (!parsed.success) return { ok: false, detail: parsed.error.issues[0]?.path.join('.') ?? 'invalid' }
  return { ok: true, ops: parsed.data }
}

export function planGraphPatch(
  editor: Editor,
  rawOps: unknown,
  modelBindings: FeatureBinding[],
  mediaResolutions?: MediaResolutionMap
): GraphPatchPlanResult {
  const parsed = parseGraphPatchOps(rawOps)
  if (!parsed.ok) return { ok: false, issue: { index: 0, code: 'INVALID_INPUT', detail: parsed.detail } }
  const ops = parsed.ops
  // main 预检注入的素材事实：外部 op 只携带 mediaId，相对路径与 MIME 由存储拥有者解析。
  const resolutionOf = (mediaId: string): MediaResolution | undefined => mediaResolutions?.[mediaId]

  // ── 模拟状态：以当前画布为基线，按操作顺序推进 ──
  const nodes = new Map<TLShapeId, SimNode>()
  const refToId = new Map<string, TLShapeId>()
  const idOf = (id: string): TLShapeId => id as TLShapeId
  for (const shape of editor.getCurrentPageShapes()) {
    if (shape.type !== 'node-card') continue
    const card = shape as NodeCardShape
    nodes.set(shape.id, {
      nodeType: card.props.nodeType,
      config: card.props.config ?? '',
      text: card.props.text ?? '',
      exists: true
    })
  }
  const edges = new Map<TLShapeId, SimEdge>()
  for (const shape of editor.getCurrentPageShapes()) {
    if (shape.type !== 'arrow') continue
    const bindings = editor.getBindingsFromShape(shape.id, 'arrow')
    const start = bindings.find((b) => b.props.terminal === 'start')
    const end = bindings.find((b) => b.props.terminal === 'end')
    if (!start || !end) continue
    if (!nodes.has(start.toId) || !nodes.has(end.toId)) continue
    edges.set(shape.id, {
      from: { nodeId: start.toId, portId: (shape.meta?.fromPort as string) ?? '' },
      to: { nodeId: end.toId, portId: (shape.meta?.toPort as string) ?? '' },
      exists: true
    })
  }

  const created: Array<{ ref?: string; nodeId: TLShapeId }> = []
  const createdGroups: Array<{ ref?: string; groupId: TLShapeId }> = []
  const counts: GraphPatchApplyCounts = { nodeCreated: 0, nodeUpdated: 0, nodeDeleted: 0, edgeCreated: 0, edgeDeleted: 0 }
  const applySteps: Array<(editor: Editor) => void> = []
  const plannedBackdrops = new Map<TLShapeId, boolean>()
  const fail = (index: number, code: string, detail?: string): GraphPatchPlanResult => ({ ok: false, issue: { index, code, ...(detail ? { detail } : {}) } })

  const livePorts = (nodeType: string, config: string, h: number): { in: PortDecl[]; out: PortDecl[] } => {
    const spec = getNodeType(nodeType)
    if (!spec) return { in: [], out: [] }
    return resolvedPorts(spec, nodeType, config, h)
  }
  const validateEdgesOn = (index: number, nodeId: TLShapeId): GraphPatchPlanResult | null => {
    const node = nodes.get(nodeId)
    if (!node || !node.exists) return null
    const spec = getNodeType(node.nodeType)
    if (!spec) return null
    const ports = livePorts(node.nodeType, node.config, 260)
    for (const edge of edges.values()) {
      if (!edge.exists) continue
      for (const side of [edge.from, edge.to] as const) {
        if (side.nodeId !== nodeId) continue
        const list = side === edge.from ? ports.out : ports.in
        if (!list.some((p) => p.id === side.portId))
          return fail(index, 'EDGE_PORT_INVALID', `${nodeId}:${side.portId}`)
      }
    }
    return null
  }

  for (let index = 0; index < ops.length; index++) {
    const op = ops[index]
    if (op.action === 'node.create') {
      const spec = getNodeType(op.nodeType)
      // `composite` 是内部节点类型：不进入创建面板，但允许以固定 manifest 快照插入实例。
      const internalComposite =
        op.nodeType === 'composite' &&
        typeof op.config?.manifest === 'object' &&
        op.config.manifest !== null
      if (!spec || (spec.creatable === false && !internalComposite))
        return fail(index, 'NODE_TYPE_INVALID', op.nodeType)
      const config = initialConfigString(spec, op.config, modelBindings)
      if (configByteLength(config) > GRAPH_NODE_CONFIG_MAX_BYTES)
        return fail(index, 'CONFIG_TOO_LARGE')
      const media = op.media ? resolutionOf(op.media.mediaId) : undefined
      if (op.media && !media) return fail(index, 'MEDIA_NOT_RESOLVED', op.media.mediaId)
      const id = createShapeId()
      nodes.set(id, { nodeType: op.nodeType, config, text: op.text ?? '', exists: true })
      if (op.ref) refToId.set(op.ref, id)
      created.push({ ...(op.ref ? { ref: op.ref } : {}), nodeId: id })
      counts.nodeCreated += 1
      applySteps.push((ed) => {
        ed.createShape({
          id,
          type: 'node-card',
          x: op.x,
          y: op.y,
          props: {
            nodeType: op.nodeType,
            title: op.title ?? media?.name ?? spec.label,
            w: op.w ?? spec.defaultSize.w,
            h: op.h ?? spec.defaultSize.h,
            config,
            text: op.text ?? '',
            mediaId: media?.mediaId ?? '',
            mediaPath: media?.mediaPath ?? '',
            mediaMime: media?.mediaMime ?? '',
            exec: 'idle'
          }
        })
      })
      continue
    }
    if (op.action === 'node.update') {
      const id = refToId.get(op.nodeId) ?? idOf(op.nodeId)
      const node = nodes.get(id)
      if (!node || !node.exists) return fail(index, 'NODE_NOT_FOUND', op.nodeId)
      const spec = getNodeType(node.nodeType)
      if (!spec) return fail(index, 'NODE_TYPE_INVALID', node.nodeType)
      const beforePorts = livePorts(node.nodeType, node.config, 260)
      let nextConfig = node.config
      if (op.config) {
        nextConfig = mergeConfig(node.config, op.config)
        if (configByteLength(nextConfig) > GRAPH_NODE_CONFIG_MAX_BYTES)
          return fail(index, 'CONFIG_TOO_LARGE')
      }
      const afterH = op.h ?? 260
      const afterPorts = livePorts(node.nodeType, nextConfig, afterH)
      // 静态端口 ID 之外的动态端口变化：已有连线引用的端口必须仍然存在。
      const staticIds = new Set([...spec.ports.in, ...spec.ports.out].map((p) => p.id))
      for (const side of ['in', 'out'] as const) {
        const before = beforePorts[side].filter((p) => !staticIds.has(p.id))
        const after = afterPorts[side]
        for (const port of before)
          if (!after.some((p) => p.id === port.id)) {
            const touched = [...edges.values()].some(
              (edge) =>
                edge.exists &&
                ((side === 'out' && edge.from.nodeId === id && edge.from.portId === port.id) ||
                  (side === 'in' && edge.to.nodeId === id && edge.to.portId === port.id))
            )
            if (touched) return fail(index, 'EDGE_PORT_INVALID', `${id}:${port.id}`)
          }
      }
      node.config = nextConfig
      if (op.text !== undefined) node.text = op.text
      const updateMedia = op.media ? resolutionOf(op.media.mediaId) : undefined
      if (op.media && !updateMedia) return fail(index, 'MEDIA_NOT_RESOLVED', op.media.mediaId)
      counts.nodeUpdated += 1
      applySteps.push((ed) => {
        const props: Record<string, unknown> = {}
        if (op.title !== undefined) props.title = op.title
        if (op.text !== undefined) props.text = op.text
        if (op.config) props.config = nextConfig
        if (op.w !== undefined) props.w = op.w
        if (op.h !== undefined) props.h = op.h
        if (updateMedia) {
          props.mediaId = updateMedia.mediaId
          props.mediaPath = updateMedia.mediaPath
          props.mediaMime = updateMedia.mediaMime
        }
        if (Object.keys(props).length) ed.updateShape({ id, type: 'node-card', props } as never)
        if (op.x !== undefined || op.y !== undefined) {
          const shape = ed.getShape(id)
          if (shape) ed.updateShape({ id, type: 'node-card', x: op.x ?? shape.x, y: op.y ?? shape.y } as never)
        }
        if (op.order === 'front') ed.bringToFront([id])
        else if (op.order === 'back') ed.sendToBack([id])
      })
      const portCheck = validateEdgesOn(index, id)
      if (portCheck) return portCheck
      continue
    }
    if (op.action === 'node.duplicate') {
      // 复制只带结构（类型/配置/正文/素材引用/尺寸），**不带运行结果与运行状态**：
      // meta 清空、exec 重置 idle，避免复制体伪装成"已经跑过"。
      const id = refToId.get(op.nodeId) ?? idOf(op.nodeId)
      const source = nodes.get(id)
      if (!source || !source.exists) return fail(index, 'NODE_NOT_FOUND', op.nodeId)
      const newId = createShapeId()
      nodes.set(newId, {
        nodeType: source.nodeType,
        config: source.config,
        text: source.text,
        exists: true
      })
      if (op.ref) refToId.set(op.ref, newId)
      created.push({ ...(op.ref ? { ref: op.ref } : {}), nodeId: newId })
      counts.nodeCreated += 1
      applySteps.push((ed) => {
        const src = ed.getShape(id)
        if (!src) return
        const props = (src as NodeCardShape).props
        ed.createShape({
          id: newId,
          type: 'node-card',
          x: src.x + (op.dx ?? 40),
          y: src.y + (op.dy ?? 40),
          props: {
            nodeType: props.nodeType,
            title: (op.title ?? props.title ?? '').slice(0, GRAPH_NODE_TITLE_MAX_CHARS),
            w: props.w,
            h: props.h,
            config: props.config ?? '',
            text: props.text ?? '',
            mediaId: props.mediaId ?? '',
            mediaPath: props.mediaPath ?? '',
            mediaMime: props.mediaMime ?? '',
            exec: 'idle'
          },
          meta: {}
        } as never)
      })
      continue
    }
    if (op.action === 'layout.align') {
      // 与 GUI 多选工具栏同一算法（左/右/水平居中/垂直居中/水平均分/垂直均分）。
      const ids: TLShapeId[] = []
      for (const raw of op.nodeIds) {
        const id = refToId.get(raw) ?? idOf(raw)
        const node = nodes.get(id)
        if (!node || !node.exists) return fail(index, 'NODE_NOT_FOUND', raw)
        ids.push(id)
      }
      if (new Set(ids).size !== ids.length) return fail(index, 'DUPLICATE_NODE', 'nodeIds')
      const mode = op.mode
      applySteps.push((ed) => {
        const bounds = ids
          .map((id) => {
            const shape = ed.getShape(id)
            if (!shape) return null
            const props = (shape as NodeCardShape).props
            return { id, x: shape.x, y: shape.y, w: props.w ?? 200, h: props.h ?? 120 }
          })
          .filter((entry): entry is { id: TLShapeId; x: number; y: number; w: number; h: number } => entry !== null)
        if (bounds.length < 2) return
        const minX = Math.min(...bounds.map((b) => b.x))
        const maxX = Math.max(...bounds.map((b) => b.x + b.w))
        const minY = Math.min(...bounds.map((b) => b.y))
        const maxY = Math.max(...bounds.map((b) => b.y + b.h))
        const totalW = maxX - minX
        const totalH = maxY - minY
        if (mode === 'distribute-h') {
          const sorted = [...bounds].sort((a, b) => a.x - b.x)
          const totalNodeW = sorted.reduce((sum, b) => sum + b.w, 0)
          const gap = sorted.length > 1 ? (totalW - totalNodeW) / (sorted.length - 1) : 0
          let cursor = minX
          for (const b of sorted) {
            ed.updateShape({ id: b.id, type: 'node-card', x: cursor } as never)
            cursor += b.w + gap
          }
          return
        }
        if (mode === 'distribute-v') {
          const sorted = [...bounds].sort((a, b) => a.y - b.y)
          const totalNodeH = sorted.reduce((sum, b) => sum + b.h, 0)
          const gap = sorted.length > 1 ? (totalH - totalNodeH) / (sorted.length - 1) : 0
          let cursor = minY
          for (const b of sorted) {
            ed.updateShape({ id: b.id, type: 'node-card', y: cursor } as never)
            cursor += b.h + gap
          }
          return
        }
        for (const b of bounds) {
          const patch =
            mode === 'left'
              ? { x: minX }
              : mode === 'right'
                ? { x: maxX - b.w }
                : mode === 'center-h'
                  ? { x: (minX + maxX) / 2 - b.w / 2 }
                  : { y: (minY + maxY) / 2 - b.h / 2 }
          ed.updateShape({ id: b.id, type: 'node-card', ...patch } as never)
        }
      })
      continue
    }
    if (
      op.action === 'backdrop.create' || op.action === 'backdrop.delete' ||
      op.action === 'backdrop.update' || op.action === 'backdrop.arrange' ||
      op.action === 'backdrop.move'
    ) {
      const id = idOf(op.backdropId)
      const existing = editor.getShape(id)
      const exists = plannedBackdrops.get(id) ?? existing?.type === 'backdrop'
      if (op.action !== 'backdrop.create') {
        if (!exists) return fail(index, 'BACKDROP_NOT_FOUND', op.backdropId)
        if (op.action === 'backdrop.delete') {
          plannedBackdrops.set(id, false)
          applySteps.push((ed) => ed.deleteShapes([id]))
        } else if (op.action === 'backdrop.update') {
          const { title, color, fillOpacity } = op
          const props = {
            ...(title !== undefined ? { title } : {}),
            ...(color !== undefined ? { color: color.toUpperCase() } : {}),
            ...(fillOpacity !== undefined ? { fillOpacity } : {})
          }
          applySteps.push((ed) => ed.updateShape({ id, type: 'backdrop', props }))
        } else {
          applySteps.push((ed) => {
            const board = ed.getShape(id)
            if (board?.type !== 'backdrop') return
            if (op.action === 'backdrop.move') moveBackdrop(ed, board, op.dx, op.dy)
            else arrangeBackdrop(ed, board)
          })
        }
        continue
      }
      if (exists || (existing && existing.type !== 'backdrop') || nodes.has(id) || edges.has(id))
        return fail(index, 'BACKDROP_ID_CONFLICT', op.backdropId)
      const members = op.nodeIds.map(idOf)
      if (new Set(members).size !== members.length) return fail(index, 'DUPLICATE_NODE', 'nodeIds')
      if (members.some((member) => !nodes.get(member)?.exists))
        return fail(index, 'NODE_NOT_FOUND', 'nodeIds')
      plannedBackdrops.set(id, true)
      applySteps.push((ed) => createBackdrop(ed, id, members))
      continue
    }
    if (op.action === 'group.create') {
      // 与 GUI「组合」同一 editor.groupShapes；分组本身是呈现结构，不改变节点数据。
      const ids: TLShapeId[] = []
      for (const raw of op.nodeIds) {
        const id = refToId.get(raw) ?? idOf(raw)
        const node = nodes.get(id)
        if (!node || !node.exists) return fail(index, 'NODE_NOT_FOUND', raw)
        ids.push(id)
      }
      if (new Set(ids).size !== ids.length) return fail(index, 'DUPLICATE_NODE', 'nodeIds')
      // tldraw 的 groupShapes 返回 editor 本身（不是新建的 group），所以必须**显式指定** groupId，
      // 否则拿不到 group 身份，外部组合之后就永远解不了组。
      const groupId = createShapeId()
      applySteps.push((ed) => {
        ed.markHistoryStoppingPoint('agent-group-create')
        ed.groupShapes(ids, { groupId })
        refToId.set(groupId, groupId)
        createdGroups.push({ ...(op.ref ? { ref: op.ref } : {}), groupId })
        if (op.ref) refToId.set(op.ref, groupId)
      })
      continue
    }
    if (op.action === 'group.delete') {
      const groupId = refToId.get(op.groupId) ?? idOf(op.groupId)
      const group = editor.getShape(groupId)
      // 只允许解组真实存在的 group：对普通节点调用 ungroup 会静默失败，必须提前拒绝。
      if (!group || group.type !== 'group') return fail(index, 'GROUP_NOT_FOUND', op.groupId)
      applySteps.push((ed) => {
        ed.markHistoryStoppingPoint('agent-group-delete')
        ed.ungroupShapes([groupId])
      })
      continue
    }
    if (op.action === 'node.select-result') {
      // 与 GUI 资产节点"选择结果版本"同一实现：只在该节点自己的结果集合里切换。
      // 不允许指向集合外的 mediaId——那等于把产物来源换成任意素材，属于伪造产出。
      const id = refToId.get(op.nodeId) ?? idOf(op.nodeId)
      const node = nodes.get(id)
      if (!node || !node.exists) return fail(index, 'NODE_NOT_FOUND', op.nodeId)
      const shape = editor.getShape(id) as NodeCardShape | undefined
      if (!shape) return fail(index, 'NODE_NOT_FOUND', op.nodeId)
      const collection = parseMediaResultCollection(
        typeof shape.meta?.nodeResult === 'string' ? shape.meta.nodeResult : ''
      )
      const item = collection?.results?.find((entry) => entry.mediaId === op.mediaId)
      if (!item) return fail(index, 'RESULT_NOT_FOUND', op.mediaId)
      const selected = selectMediaResult(shape, item)
      counts.nodeUpdated += 1
      applySteps.push((ed) => {
        ed.updateShape({
          id,
          type: 'node-card',
          props: selected.props,
          meta: { ...(shape.meta ?? {}), nodeResult: selected.nodeResult }
        } as never)
      })
      continue
    }
    if (op.action === 'node.delete') {
      const id = refToId.get(op.nodeId) ?? idOf(op.nodeId)
      const node = nodes.get(id)
      if (!node || !node.exists) return fail(index, 'NODE_NOT_FOUND', op.nodeId)
      node.exists = false
      for (const edge of edges.values())
        if (edge.from.nodeId === id || edge.to.nodeId === id) edge.exists = false
      counts.nodeDeleted += 1
      applySteps.push((ed) => {
        ed.deleteShapes([id])
      })
      continue
    }
    if (op.action === 'edge.delete') {
      const edge = edges.get(idOf(op.edgeId))
      if (!edge || !edge.exists) return fail(index, 'EDGE_NOT_FOUND', op.edgeId)
      edge.exists = false
      counts.edgeDeleted += 1
      applySteps.push((ed) => {
        ed.deleteShapes([idOf(op.edgeId)])
      })
      continue
    }
    // edge.create（chat.patch 由权威宿主单独分支处理，不进入几何规划）
    if (op.action !== 'edge.create') return fail(index, 'INVALID_INPUT')
    const fromId = refToId.get(op.from.nodeId) ?? idOf(op.from.nodeId)
    const toId = refToId.get(op.to.nodeId) ?? idOf(op.to.nodeId)
    const fromNode = nodes.get(fromId)
    const toNode = nodes.get(toId)
    if (!fromNode || !fromNode.exists) return fail(index, 'NODE_NOT_FOUND', op.from.nodeId)
    if (!toNode || !toNode.exists) return fail(index, 'NODE_NOT_FOUND', op.to.nodeId)
    const fromSpec = getNodeType(fromNode.nodeType)
    const toSpec = getNodeType(toNode.nodeType)
    if (!fromSpec || !toSpec) return fail(index, 'NODE_TYPE_INVALID')
    const fromPorts = livePorts(fromNode.nodeType, fromNode.config, 260).out
    const toPorts = livePorts(toNode.nodeType, toNode.config, 260).in
    const fromPort = fromPorts.find((p) => p.id === op.from.portId)
    const toPort = toPorts.find((p) => p.id === op.to.portId)
    if (!fromPort || !toPort) return fail(index, 'EDGE_PORT_INVALID', `${op.from.portId}->${op.to.portId}`)
    if (!portPairCompatible(fromPort, toPort)) return fail(index, 'EDGE_INCOMPATIBLE')
    if (
      toPort.cardinality === 'one' &&
      [...edges.values()].some((edge) => edge.exists && edge.to.nodeId === toId && edge.to.portId === toPort.id)
    )
      return fail(index, 'EDGE_OCCUPIED')
    if (
      [...edges.values()].some(
        (edge) =>
          edge.exists &&
          edge.from.nodeId === fromId &&
          edge.from.portId === fromPort.id &&
          edge.to.nodeId === toId &&
          edge.to.portId === toPort.id
      )
    )
      return fail(index, 'EDGE_DUPLICATE')
    edges.set(createShapeId(), {
      from: { nodeId: fromId, portId: fromPort.id },
      to: { nodeId: toId, portId: toPort.id },
      exists: true
    })
    counts.edgeCreated += 1
    applySteps.push((ed) => {
      createEdge(
        ed,
        { shapeId: fromId, portId: fromPort.id },
        { shapeId: toId, portId: toPort.id },
        false,
        op.connectOrder
      )
    })
  }

  // ── 全图终态无环校验（GUI 手动连线同样不允许循环依赖）──
  const adjacency = new Map<TLShapeId, TLShapeId[]>()
  for (const edge of edges.values()) {
    if (!edge.exists) continue
    const list = adjacency.get(edge.from.nodeId) ?? []
    list.push(edge.to.nodeId)
    adjacency.set(edge.from.nodeId, list)
  }
  const state = new Map<TLShapeId, 1 | 2>()
  const visit = (id: TLShapeId): boolean => {
    const mark = state.get(id)
    if (mark === 2) return false
    if (mark === 1) return true
    state.set(id, 1)
    for (const next of adjacency.get(id) ?? []) if (visit(next)) return true
    state.set(id, 2)
    return false
  }
  for (const id of adjacency.keys()) if (visit(id)) return fail(ops.length - 1, 'EDGE_CYCLE')

  // ── 终态动态端口合法性（声明重复/非法端口的配置必须整批拒绝）──
  for (const node of nodes.values()) {
    if (!node.exists) continue
    const spec = getNodeType(node.nodeType)
    if (!spec) continue
    let ports: { in: PortDecl[]; out: PortDecl[] }
    try {
      ports = getNodePorts(spec, {
        id: 'shape:simulated' as TLShapeId,
        type: 'node-card',
        x: 0,
        y: 0,
        index: 'a1',
        rotation: 0,
        isLocked: false,
        opacity: 1,
        meta: {},
        props: { w: 340, h: 260, nodeType: node.nodeType, title: '', config: node.config, text: '', mediaId: '', mediaPath: '', mediaMime: '', exec: 'idle' }
      } as unknown as NodeCardShape)
    } catch {
      return fail(ops.length - 1, 'CONFIG_INVALID')
    }
    void ports
  }

  return {
    ok: true,
    plan: {
      created,
      groups: createdGroups,
      counts,
      apply(editor: Editor): void {
        for (const step of applySteps) step(editor)
      }
    }
  }
}
