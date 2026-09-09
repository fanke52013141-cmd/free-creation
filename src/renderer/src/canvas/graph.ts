// 连线系统核心：创建/校验 tldraw arrow + binding，保存时派生图数据
// 端口信息存 arrow.meta（fromPort/toPort），绑定锚点按端口纵向位置计算
import { createShapeId, type Editor, type TLShapeId } from 'tldraw'
import type { CanvasEdge, CanvasNode, ExecStatus, GroupDecl, PortDecl } from '@shared/types'
import { nodeSchemasCompatible } from '@shared/node-schemas'
import { getNodePorts, getNodeType, portCompatible, portOffsets } from '../nodes/registry'
import type { NodeCardShape } from './NodeCardShape'
import type { BatchConnectionMember, ConnectionFrom } from '../stores/connection'
import { projectNodeOutputs, type NodeValue } from '../nodes/nodeValues'

// 默认连线保持中性灰，避免同一画布被端口类型色切成多种视觉噪声；
// 类型辨识交给端口色与详情面板，悬浮/选中/拖线则由统一蓝色交互态强调。
// 仍使用 tldraw 内置色名，确保 DefaultColorStyle 校验安全。
type ArrowColor =
  | 'black'
  | 'blue'
  | 'green'
  | 'grey'
  | 'orange'
  | 'red'
  | 'violet'
  | 'white'
  | 'yellow'
  | 'light-blue'
  | 'light-red'
  | 'light-green'
  | 'light-violet'

export const EDGE_COLORS: Record<string, ArrowColor> = {
  text: 'grey',
  markdown: 'grey',
  json: 'grey',
  image: 'grey',
  video: 'grey',
  audio: 'grey',
  file: 'grey',
  any: 'grey'
}

export function edgeColorFor(portType: string): ArrowColor {
  return EDGE_COLORS[portType] ?? 'grey'
}

export interface EdgeEndpoint {
  shapeId: TLShapeId
  portId: string
}

interface ArrowBindings {
  start: { toId: TLShapeId } | undefined
  end: { toId: TLShapeId } | undefined
}

function getArrowBindings(editor: Editor, arrowId: TLShapeId): ArrowBindings {
  const bindings = editor.getBindingsFromShape(arrowId, 'arrow')
  const start = bindings.find((b) => b.props.terminal === 'start')
  const end = bindings.find((b) => b.props.terminal === 'end')
  return { start, end }
}

/** 统一的保存顺序，供 many 输入的运行时读取与画布摘要共同使用。 */
function orderedPageArrows(editor: Editor): ReturnType<Editor['getCurrentPageShapes']> {
  return editor
    .getCurrentPageShapes()
    .filter((shape) => shape.type === 'arrow')
    .sort((a, b) => a.index.localeCompare(b.index))
}

/** 现有全部连线（仅两端都是 node-card 的 arrow） */
function listEdges(editor: Editor): { arrowId: TLShapeId; from: TLShapeId; to: TLShapeId }[] {
  const result: { arrowId: TLShapeId; from: TLShapeId; to: TLShapeId }[] = []
  for (const shape of editor.getCurrentPageShapes()) {
    if (shape.type !== 'arrow') continue
    const { start, end } = getArrowBindings(editor, shape.id)
    if (!start || !end) continue
    if (editor.getShape(start.toId)?.type !== 'node-card') continue
    if (editor.getShape(end.toId)?.type !== 'node-card') continue
    result.push({ arrowId: shape.id, from: start.toId, to: end.toId })
  }
  return result
}

/** from 节点沿连线能否到达 to 节点（环检测用） */
function reaches(editor: Editor, from: TLShapeId, to: TLShapeId): boolean {
  const adjacency = new Map<TLShapeId, TLShapeId[]>()
  for (const e of listEdges(editor)) {
    const list = adjacency.get(e.from) ?? []
    list.push(e.to)
    adjacency.set(e.from, list)
  }
  const visited = new Set<TLShapeId>()
  const stack = [from]
  while (stack.length > 0) {
    const cur = stack.pop()!
    if (cur === to) return true
    if (visited.has(cur)) continue
    visited.add(cur)
    for (const next of adjacency.get(cur) ?? []) stack.push(next)
  }
  return false
}

function edgeExists(editor: Editor, from: EdgeEndpoint, to: EdgeEndpoint): boolean {
  for (const shape of editor.getCurrentPageShapes()) {
    if (shape.type !== 'arrow') continue
    const { start, end } = getArrowBindings(editor, shape.id)
    if (!start || !end) continue
    if (
      start.toId === from.shapeId &&
      end.toId === to.shapeId &&
      (shape.meta?.fromPort as string | undefined) === from.portId &&
      (shape.meta?.toPort as string | undefined) === to.portId
    ) {
      return true
    }
  }
  return false
}

/** 单值输入端口是否已经有上游。连线数量规则属于端口契约，不能由节点执行器事后猜测。 */
function inputPortOccupied(editor: Editor, target: EdgeEndpoint): boolean {
  for (const shape of editor.getCurrentPageShapes()) {
    if (shape.type !== 'arrow') continue
    const { end } = getArrowBindings(editor, shape.id)
    if (
      end?.toId === target.shapeId &&
      (shape.meta?.toPort as string | undefined) === target.portId
    ) {
      return true
    }
  }
  return false
}

function clamp01(v: number): number {
  return Math.max(0.02, Math.min(0.98, v))
}

/**
 * Node-card x/y become local coordinates after tldraw groups the node.  All
 * arrow geometry and hit-testing, however, live in page coordinates.  Keep the
 * conversion in one place so grouped and root-level nodes follow the exact
 * same connection path.
 */
function pagePortPoint(
  editor: Editor,
  shape: NodeCardShape,
  side: 'in' | 'out',
  localY: number
): { x: number; y: number } | null {
  const bounds = editor.getShapePageBounds(shape.id)
  if (!bounds) return null
  return {
    x: side === 'out' ? bounds.maxX : bounds.x,
    y: shape.props.h > 0 ? bounds.y + (bounds.height * localY) / shape.props.h : bounds.y
  }
}

/**
 * 创建连线：arrow 形状 + 两条 arrow binding（start/end 分别锚到源/目标端口位置）。
 * 绑定后连线自动跟随节点移动、可选中删除、支持撤销重做。
 */
export function createEdge(
  editor: Editor,
  from: EdgeEndpoint,
  to: EdgeEndpoint,
  markHistory = true
): boolean {
  const fromShape = editor.getShape<NodeCardShape>(from.shapeId)
  const toShape = editor.getShape<NodeCardShape>(to.shapeId)
  if (!fromShape || !toShape) return false

  const fromSpec = getNodeType(fromShape.props.nodeType)
  const toSpec = getNodeType(toShape.props.nodeType)
  const fromPorts = fromSpec ? getNodePorts(fromSpec, fromShape) : null
  const toPorts = toSpec ? getNodePorts(toSpec, toShape) : null
  const fromPort = fromPorts?.out.find((p) => p.id === from.portId)
  const toPort = toPorts?.in.find((p) => p.id === to.portId)
  if (!fromSpec || !toSpec || !fromPorts || !toPorts || !fromPort || !toPort) return false
  if (!portCompatible(fromPort.type, toPort.type)) return false
  if (
    fromPort.type === 'json' &&
    toPort.type === 'json' &&
    !nodeSchemasCompatible(fromPort.schema, toPort.schema)
  )
    return false
  if (toPort.cardinality === 'one' && inputPortOccupied(editor, to)) return false

  const fromIdx = Math.max(0, fromPorts.out.indexOf(fromPort))
  const toIdx = Math.max(0, toPorts.in.indexOf(toPort))
  const fromY =
    portOffsets(fromPorts.out.length, fromShape.props.h)[fromIdx] ?? fromShape.props.h / 2
  const toY = portOffsets(toPorts.in.length, toShape.props.h)[toIdx] ?? toShape.props.h / 2

  const startPage = pagePortPoint(editor, fromShape, 'out', fromY)
  const endPage = pagePortPoint(editor, toShape, 'in', toY)
  if (!startPage || !endPage) return false
  const arrowId = createShapeId()

  // 弧线弯曲量：按连线长度自适应（tldraw 的 bend 为弧中点在垂直方向的偏移，越大越弯）。
  // 固定写死会近处过弯/远处过直，这里取 0.16*长度并限制在 [20, 84]，形成一致的柔和弧线。
  const connDist = Math.hypot(endPage.x - startPage.x, endPage.y - startPage.y)
  const bend = Math.max(20, Math.min(84, connDist * 0.16))

  editor.run(() => {
    editor.createShape({
      id: arrowId,
      type: 'arrow',
      x: startPage.x,
      y: startPage.y,
      props: {
        kind: 'arc',
        color: edgeColorFor(fromPort.type),
        fill: 'none',
        dash: 'dashed',
        size: 'm',
        font: 'sans',
        arrowheadStart: 'none',
        arrowheadEnd: 'arrow',
        start: { x: 0, y: 0 },
        end: { x: endPage.x - startPage.x, y: endPage.y - startPage.y },
        bend,
        labelPosition: 0.5,
        scale: 1
      },
      meta: { fromPort: fromPort.id, toPort: toPort.id }
    })
    editor.createBinding({
      type: 'arrow',
      fromId: arrowId,
      toId: fromShape.id,
      props: {
        terminal: 'start',
        normalizedAnchor: { x: 0.98, y: clamp01(fromY / fromShape.props.h) },
        isExact: false,
        isPrecise: true,
        snap: 'none'
      }
    })
    editor.createBinding({
      type: 'arrow',
      fromId: arrowId,
      toId: toShape.id,
      props: {
        terminal: 'end',
        normalizedAnchor: { x: 0.02, y: clamp01(toY / toShape.props.h) },
        isExact: false,
        isPrecise: true,
        snap: 'none'
      }
    })
  })
  // 连线单独成为一个撤销步；若上一操作是「拉线到空白新建节点」，
  // 节点创建尚未打点，会与本连线合并为一步（符合直觉）
  if (markHistory) editor.markHistoryStoppingPoint('create-edge')
  return true
}

export interface BatchConnectionResult {
  created: number
  skipped: number
  error?: string
}

export interface HeterogeneousBatchConnectionPlan {
  sourcePortId: string
  targetPortId: string
}

/**
 * 为异构多选建立明确的端口映射，不把多种输出折叠成 `any`。
 *
 * 单值输入最多分配给一个成员且不能覆盖已有边；多值输入可接收多个成员。递归
 * 回溯保证“文本既可接 any 又可接 text、图片只能接 image”这类组合不会因为
 * 贪心顺序而错误失败。返回 null 表示不存在一个覆盖全部成员的合法映射。
 */
export function planHeterogeneousBatchConnections(
  sources: readonly BatchConnectionMember[],
  targetPorts: readonly PortDecl[],
  occupiedOnePortIds: ReadonlySet<string>,
  preferredTargetPortId?: string
): HeterogeneousBatchConnectionPlan[] | null {
  const candidatesBySource = sources.map((source, sourceIndex) => {
    const candidates = targetPorts.filter((target) => {
      if (sourceIndex === 0 && preferredTargetPortId && target.id !== preferredTargetPortId) {
        return false
      }
      if (target.cardinality === 'one' && occupiedOnePortIds.has(target.id)) return false
      if (!portCompatible(source.portType, target.type)) return false
      return !(
        source.portType === 'json' &&
        target.type === 'json' &&
        !nodeSchemasCompatible(source.schema, target.schema)
      )
    })
    return { source, candidates }
  })
  if (candidatesBySource.some(({ candidates }) => candidates.length === 0)) return null

  // 先处理候选最少的成员，同时保持结果按原始 sources 顺序返回，提升分配成功率。
  const order = candidatesBySource
    .map((item, index) => ({ ...item, index }))
    .sort((a, b) => a.candidates.length - b.candidates.length || a.index - b.index)
  const assignments = new Map<number, string>()
  const usedOnePorts = new Set<string>(occupiedOnePortIds)

  const assign = (cursor: number): boolean => {
    if (cursor === order.length) return true
    const current = order[cursor]
    for (const target of current.candidates) {
      if (target.cardinality === 'one' && usedOnePorts.has(target.id)) continue
      assignments.set(current.index, target.id)
      if (target.cardinality === 'one') usedOnePorts.add(target.id)
      if (assign(cursor + 1)) return true
      if (target.cardinality === 'one') usedOnePorts.delete(target.id)
      assignments.delete(current.index)
    }
    return false
  }

  if (!assign(0)) return null
  return sources.map((source, index) => ({
    sourcePortId: source.portId,
    targetPortId: assignments.get(index)!
  }))
}

function sameSchemaRef(left: BatchConnectionMember['schema'], right: PortDecl['schema']): boolean {
  if (!left || !right) return left === right
  return left.id === right.id && left.version === right.version
}

function tryConnectHeterogeneousBatch(
  editor: Editor,
  from: ConnectionFrom,
  targetShapeId: TLShapeId,
  preferredTargetPortId?: string
): BatchConnectionResult {
  const members = from.memberPorts ?? []
  if (members.length < 2) return { created: 0, skipped: 0, error: '批量连接至少需要两个节点' }
  if (new Set(members.map((member) => member.shapeId)).size !== members.length) {
    return { created: 0, skipped: 0, error: '批量连接包含重复源节点' }
  }
  const target = editor.getShape<NodeCardShape>(targetShapeId)
  if (!target) return { created: 0, skipped: 0, error: '目标节点不存在' }
  if (members.some((member) => member.shapeId === target.id)) {
    return { created: 0, skipped: 0, error: '批量连接不能连接到自身' }
  }

  const sources = members.map((member) => {
    const shape = editor.getShape<NodeCardShape>(member.shapeId)
    const spec = shape ? getNodeType(shape.props.nodeType) : undefined
    const port =
      shape && spec
        ? getNodePorts(spec, shape).out.find((item) => item.id === member.portId)
        : undefined
    return { member, shape, port }
  })
  if (
    sources.some(
      ({ member, shape, port }) =>
        !shape ||
        !port ||
        port.type !== member.portType ||
        !sameSchemaRef(member.schema, port.schema)
    )
  ) {
    return { created: 0, skipped: 0, error: '所选节点的输出端口已变化或不可用' }
  }

  const targetSpec = getNodeType(target.props.nodeType)
  if (!targetSpec) return { created: 0, skipped: 0, error: '目标节点类型未知' }
  if (sources.some(({ shape }) => shape && reaches(editor, target.id, shape.id))) {
    return { created: 0, skipped: 0, error: '批量连接会形成循环，未创建任何连线' }
  }

  const targetPorts = getNodePorts(targetSpec, target).in
  const occupiedOnePortIds = new Set(
    targetPorts
      .filter((port) => port.cardinality === 'one')
      .filter((port) => inputPortOccupied(editor, { shapeId: target.id, portId: port.id }))
      .map((port) => port.id)
  )
  const plan = planHeterogeneousBatchConnections(
    members,
    targetPorts,
    occupiedOnePortIds,
    preferredTargetPortId
  )
  if (!plan) {
    return {
      created: 0,
      skipped: 0,
      error: `${targetSpec.label} 没有可同时接收所选节点的兼容输入端口`
    }
  }

  const edges = plan.flatMap((item, index) => {
    const source = members[index]
    const fromEndpoint: EdgeEndpoint = { shapeId: source.shapeId, portId: item.sourcePortId }
    const toEndpoint: EdgeEndpoint = { shapeId: target.id, portId: item.targetPortId }
    return edgeExists(editor, fromEndpoint, toEndpoint)
      ? []
      : [{ from: fromEndpoint, to: toEndpoint }]
  })
  if (edges.length === 0) {
    return { created: 0, skipped: members.length, error: '所选节点均已存在相同连接' }
  }
  let created = 0
  editor.run(() => {
    for (const edge of edges) {
      if (createEdge(editor, edge.from, edge.to, false)) created += 1
    }
  })
  if (created > 0) editor.markHistoryStoppingPoint('create-batch-edges')
  return { created, skipped: members.length - created }
}

/**
 * 将多选节点作为一个临时的“共有输出”接入目标的多值输入。
 *
 * 先完整预检目标端口、每个源节点与环路，再一次性建边；不会出现只连上一半图片的状态。
 * 单值输入刻意不支持该快捷方式，避免批量动作悄悄覆盖用户已有连接。
 */
export function tryConnectBatch(
  editor: Editor,
  from: ConnectionFrom,
  targetShapeId: TLShapeId,
  dropPagePt?: { x: number; y: number },
  preferredTargetPortId?: string
): BatchConnectionResult {
  if (from.memberPorts?.length) {
    return tryConnectHeterogeneousBatch(editor, from, targetShapeId, preferredTargetPortId)
  }
  const memberIds = [...new Set(from.memberIds ?? [])]
  if (memberIds.length < 2) return { created: 0, skipped: 0, error: '批量连接至少需要两个节点' }
  const target = editor.getShape<NodeCardShape>(targetShapeId)
  if (!target) return { created: 0, skipped: 0, error: '目标节点不存在' }
  if (memberIds.includes(target.id)) {
    return { created: 0, skipped: 0, error: '批量连接不能连接到自身' }
  }
  const sources = memberIds.map((id) => {
    const shape = editor.getShape<NodeCardShape>(id)
    const spec = shape ? getNodeType(shape.props.nodeType) : undefined
    const port =
      shape && spec
        ? getNodePorts(spec, shape).out.find((item) => item.id === from.portId)
        : undefined
    return { shape, spec, port }
  })
  if (
    sources.some(
      ({ shape, spec, port }) =>
        !shape ||
        !spec ||
        !port ||
        port.type !== from.portType ||
        (port.type === 'json' && !nodeSchemasCompatible(port.schema, from.schema))
    )
  ) {
    return { created: 0, skipped: 0, error: '所选节点没有相同且兼容的输出端口' }
  }
  const targetSpec = getNodeType(target.props.nodeType)
  if (!targetSpec) return { created: 0, skipped: 0, error: '目标节点类型未知' }
  const targetPorts = getNodePorts(targetSpec, target)
  const compatible = targetPorts.in.filter(
    (port) =>
      port.cardinality === 'many' &&
      sources.every(
        ({ port: sourcePort }) =>
          sourcePort &&
          portCompatible(port.type, sourcePort.type) &&
          !(
            port.type === 'json' &&
            sourcePort.type === 'json' &&
            !nodeSchemasCompatible(sourcePort.schema, port.schema)
          )
      )
  )
  if (compatible.length === 0) {
    return {
      created: 0,
      skipped: 0,
      error: `${targetSpec.label} 没有可接收多项 ${from.portType} 的多值输入端口`
    }
  }
  let targetPort = compatible[0]
  if (preferredTargetPortId) {
    const preferred = compatible.find((port) => port.id === preferredTargetPortId)
    if (!preferred) return { created: 0, skipped: 0, error: `${targetSpec.label} 的目标输入不可用` }
    targetPort = preferred
  } else if (dropPagePt && compatible.length > 1) {
    const targetBounds = editor.getShapePageBounds(target.id)
    if (!targetBounds) return { created: 0, skipped: 0, error: '目标节点位置不可用' }
    const offsets = portOffsets(targetPorts.in.length, target.props.h)
    targetPort = compatible.reduce((best, port) => {
      const bestIndex = targetPorts.in.indexOf(best)
      const index = targetPorts.in.indexOf(port)
      const bestY =
        targetBounds.y +
        (targetBounds.height * (offsets[bestIndex] ?? target.props.h / 2)) / target.props.h
      const y =
        targetBounds.y +
        (targetBounds.height * (offsets[index] ?? target.props.h / 2)) / target.props.h
      return Math.abs(dropPagePt.y - y) < Math.abs(dropPagePt.y - bestY) ? port : best
    })
  }
  const endpoint: EdgeEndpoint = { shapeId: target.id, portId: targetPort.id }
  // 环路不是可忽略的“个别失败”：批量手势必须保持原子性，否则用户会误以为
  // 整组选中项都已接入。已存在的同一条边可安全跳过，其他项仍照常创建。
  if (sources.some(({ shape }) => shape && reaches(editor, target.id, shape.id))) {
    return { created: 0, skipped: 0, error: '批量连接会形成循环，未创建任何连线' }
  }
  const plan = sources.flatMap(({ shape }) => {
    if (!shape || edgeExists(editor, { shapeId: shape.id, portId: from.portId }, endpoint))
      return []
    return [shape.id]
  })
  if (plan.length === 0) {
    return { created: 0, skipped: memberIds.length, error: '所选节点均已存在相同连接' }
  }
  let created = 0
  editor.run(() => {
    for (const sourceId of plan) {
      if (createEdge(editor, { shapeId: sourceId, portId: from.portId }, endpoint, false))
        created += 1
    }
  })
  if (created > 0) editor.markHistoryStoppingPoint('create-batch-edges')
  return { created, skipped: memberIds.length - created }
}

/**
 * 尝试连接：选目标节点上最合适的输入端口（类型兼容 + 距离落点最近），
 * 校验重复/环后建边。返回错误信息（null = 成功）。
 */
export function tryConnect(
  editor: Editor,
  from: ConnectionFrom,
  targetShapeId: TLShapeId,
  dropPagePt?: { x: number; y: number },
  preferredTargetPortId?: string
): string | null {
  if ((from.memberIds?.length ?? 0) > 1) {
    const result = tryConnectBatch(editor, from, targetShapeId, dropPagePt, preferredTargetPortId)
    if (result.error) return result.error
    return result.skipped > 0
      ? `已批量连接 ${result.created} 个节点；${result.skipped} 个已存在相同连接`
      : null
  }
  const target = editor.getShape<NodeCardShape>(targetShapeId)
  if (!target) return '目标节点不存在'
  if (target.id === from.shapeId) return '不能连接到自身'

  const targetSpec = getNodeType(target.props.nodeType)
  if (!targetSpec) return '目标节点类型未知'

  const source = editor.getShape<NodeCardShape>(from.shapeId)
  const sourceSpec = source ? getNodeType(source.props.nodeType) : undefined
  const sourcePorts = source && sourceSpec ? getNodePorts(sourceSpec, source) : null
  const sourcePort = sourcePorts?.out.find((port) => port.id === from.portId)
  if (!source || !sourceSpec || !sourcePort) return '源节点或输出端口不存在'

  const targetPorts = getNodePorts(targetSpec, target)
  const compatible = targetPorts.in.filter(
    (port) =>
      portCompatible(port.type, sourcePort.type) &&
      !(
        port.type === 'json' &&
        sourcePort.type === 'json' &&
        !nodeSchemasCompatible(sourcePort.schema, port.schema)
      )
  )
  if (compatible.length === 0) {
    return `类型或 Schema 不兼容：${sourcePort.type} 输出无法接入 ${targetSpec.label} 节点`
  }
  const usable = compatible.filter(
    (port) =>
      port.cardinality === 'many' ||
      !inputPortOccupied(editor, { shapeId: targetShapeId, portId: port.id })
  )
  if (usable.length === 0) {
    return `${targetSpec.label} 的兼容输入均为单值端口且已有连线，请先断开原连线`
  }

  let port: PortDecl = usable[0]
  if (preferredTargetPortId) {
    const preferredPort = usable.find((candidate) => candidate.id === preferredTargetPortId)
    if (!preferredPort) return `${targetSpec.label} 的目标输入不可用`
    port = preferredPort
  } else if (dropPagePt && usable.length > 1) {
    const targetBounds = editor.getShapePageBounds(target.id)
    if (!targetBounds) return '目标节点位置不可用'
    const offsets = portOffsets(targetPorts.in.length, target.props.h)
    let bestDist = Infinity
    for (const p of usable) {
      const idx = targetPorts.in.indexOf(p)
      const y = offsets[idx] ?? target.props.h / 2
      const pageY =
        target.props.h > 0
          ? targetBounds.y + (targetBounds.height * y) / target.props.h
          : targetBounds.y
      const d = Math.hypot(dropPagePt.x - targetBounds.x, dropPagePt.y - pageY)
      if (d < bestDist) {
        bestDist = d
        port = p
      }
    }
  }

  const endpoint: EdgeEndpoint = { shapeId: targetShapeId, portId: port.id }
  if (edgeExists(editor, { shapeId: from.shapeId, portId: from.portId }, endpoint)) {
    return '已存在相同连线'
  }
  if (reaches(editor, targetShapeId, from.shapeId)) {
    return '不能创建循环连线'
  }

  if (!createEdge(editor, { shapeId: from.shapeId, portId: from.portId }, endpoint)) {
    return '创建连线失败'
  }
  return null
}

/**
 * 两个节点被同时选中后拖近时的便捷连接。
 *
 * 只在左右相邻、垂直距离合理的情况下尝试，并始终复用 tryConnect 的端口、Schema、
 * 单值占用和环路校验；因此它不会把“靠近”误变成绕过契约的连线。
 */
export function tryAutoConnectNearby(
  editor: Editor,
  firstId: TLShapeId,
  secondId: TLShapeId
): boolean {
  const first = editor.getShape<NodeCardShape>(firstId)
  const second = editor.getShape<NodeCardShape>(secondId)
  if (!first || !second || first.id === second.id) return false

  const firstBounds = editor.getShapePageBounds(first.id)
  const secondBounds = editor.getShapePageBounds(second.id)
  if (!firstBounds || !secondBounds) return false

  const firstCenter = firstBounds.center
  const secondCenter = secondBounds.center
  const left = firstCenter.x <= secondCenter.x ? first : second
  const right = left.id === first.id ? second : first
  const leftBounds = left.id === first.id ? firstBounds : secondBounds
  const rightBounds = right.id === first.id ? firstBounds : secondBounds
  const gap = Math.max(0, rightBounds.x - leftBounds.maxX)
  const verticalDistance = Math.abs(firstCenter.y - secondCenter.y)
  // 只有确实在“拖近对方输入侧”时才触发，避免普通框选时产生意外连线。
  if (gap > 140 || verticalDistance > 180) return false

  const sourceSpec = getNodeType(left.props.nodeType)
  if (!sourceSpec) return false
  const outputs = getNodePorts(sourceSpec, left).out
  for (const output of outputs) {
    if (
      tryConnect(
        editor,
        { shapeId: left.id, portId: output.id, portType: output.type, schema: output.schema },
        right.id,
        { x: rightBounds.x, y: rightBounds.y + rightBounds.height / 2 }
      ) === null
    ) {
      return true
    }
  }
  return false
}

/** 保存时从画布 shapes 派生图数据（node-card → CanvasNode，arrow+binding → CanvasEdge） */
export function deriveGraph(editor: Editor): {
  nodes: CanvasNode[]
  edges: CanvasEdge[]
  groups: GroupDecl[]
} {
  const nodes: CanvasNode[] = []
  const edges: CanvasEdge[] = []
  const groups: GroupDecl[] = []

  for (const shape of editor.getCurrentPageShapes()) {
    if (shape.type === 'node-card') {
      const s = shape as NodeCardShape
      const spec = getNodeType(s.props.nodeType)
      const resolved = spec
        ? getNodePorts(spec, s)
        : { in: [] as PortDecl[], out: [] as PortDecl[] }
      const ports: PortDecl[] = [...resolved.in, ...resolved.out]
      nodes.push({
        id: s.id,
        type: s.props.nodeType as CanvasNode['type'],
        contractVersion: spec?.contractVersion ?? 1,
        title: s.props.title,
        x: s.x,
        y: s.y,
        w: s.props.w,
        h: s.props.h,
        ports,
        // 图数据中保留固定配置，但不再把它混入用户正文 content。
        params: s.props.config ? { config: s.props.config } : {},
        content: s.props.mediaId
          ? { kind: 'media', mediaId: s.props.mediaId }
          : s.props.text
            ? { kind: 'text', text: s.props.text }
            : { kind: 'empty' },
        exec: { status: (s.props.exec as ExecStatus) ?? 'idle' },
        meta: { source: 'input', createdAt: Date.now() }
      })
    } else if (shape.type === 'arrow') {
      const { start, end } = getArrowBindings(editor, shape.id)
      if (!start || !end) continue
      if (editor.getShape(start.toId)?.type !== 'node-card') continue
      if (editor.getShape(end.toId)?.type !== 'node-card') continue
      edges.push({
        id: shape.id,
        from: { nodeId: start.toId, portId: (shape.meta?.fromPort as string) ?? '' },
        to: { nodeId: end.toId, portId: (shape.meta?.toPort as string) ?? '' }
      })
    } else if (shape.type === 'group') {
      const nodeIds = editor
        .getSortedChildIdsForParent(shape.id)
        .filter((id) => editor.getShape(id)?.type === 'node-card')
      if (nodeIds.length >= 2) {
        groups.push({ id: shape.id, name: '分组', nodeIds, kind: 'plain' })
      }
    }
  }

  return { nodes, edges, groups }
}

/**
 * 画布卡片使用的已连接输入快照。
 *
 * 此处刻意从 Arrow binding + `fromPort` / `toPort` 读取关系，再经来源节点的
 * `projectOutputs` 取得当前已持久化输出。它既不扫描上游节点标题，也不按节点类型
 * 猜测数据；失效输出仍保留为 `null`，让 UI 可以如实提示“已连接，等待上游输出”。
 */
export interface ConnectedNodeInput {
  targetPortId: string
  targetPortName: string
  targetPortCardinality: PortDecl['cardinality']
  sourceNodeId: TLShapeId
  sourceNodeName: string
  sourcePortId: string
  sourcePortName: string
  sourcePortType: PortDecl['type']
  /** 同一目标输入端口内的真实边顺序，从 1 开始。 */
  order: number
  value: NodeValue | null
}

export function readConnectedNodeInputs(
  editor: Editor,
  targetNodeId: TLShapeId
): ConnectedNodeInput[] {
  const target = editor.getShape<NodeCardShape>(targetNodeId)
  const targetSpec = target ? getNodeType(target.props.nodeType) : undefined
  if (!target || !targetSpec) return []

  const targetPorts = getNodePorts(targetSpec, target).in
  const perPortOrder = new Map<string, number>()
  const connected: ConnectedNodeInput[] = []
  // tldraw 的 shape index 是保存到快照的稳定顺序。显式排序让 many 输入在刷新后
  // 仍以同一顺序呈现，并与执行器读取连线时采用的边顺序保持一致。
  const arrows = orderedPageArrows(editor)

  for (const arrow of arrows) {
    const { start, end } = getArrowBindings(editor, arrow.id)
    const sourcePortId = typeof arrow.meta?.fromPort === 'string' ? arrow.meta.fromPort : null
    const targetPortId = typeof arrow.meta?.toPort === 'string' ? arrow.meta.toPort : null
    if (!start || !end || !sourcePortId || !targetPortId || end.toId !== targetNodeId) continue

    const targetPort = targetPorts.find((port) => port.id === targetPortId)
    const source = editor.getShape<NodeCardShape>(start.toId)
    const sourceSpec = source ? getNodeType(source.props.nodeType) : undefined
    if (!targetPort || !source || !sourceSpec) continue
    const sourcePort = getNodePorts(sourceSpec, source).out.find((port) => port.id === sourcePortId)
    if (!sourcePort) continue

    const order = (perPortOrder.get(targetPort.id) ?? 0) + 1
    perPortOrder.set(targetPort.id, order)
    connected.push({
      targetPortId: targetPort.id,
      targetPortName: targetPort.name,
      targetPortCardinality: targetPort.cardinality,
      sourceNodeId: source.id,
      sourceNodeName: source.props.title,
      sourcePortId: sourcePort.id,
      sourcePortName: sourcePort.name,
      sourcePortType: sourcePort.type,
      order,
      value: projectNodeOutputs(source)[sourcePort.id] ?? null
    })
  }
  return connected
}

/**
 * 实时收集连入某节点的上游文本内容（用于对话/图片等节点手动触发时自动注入上下文）。
 * 遍历画布上的 arrow bindings，找到所有 → targetNodeId 的边，取源节点的文本输出。
 */
export function gatherUpstreamText(
  editor: Editor,
  targetNodeId: TLShapeId,
  targetPortId = 'in-text'
): string {
  const parts: string[] = []
  for (const shape of orderedPageArrows(editor)) {
    const { start, end } = getArrowBindings(editor, shape.id)
    if (!start || !end) continue
    if (end.toId !== targetNodeId || shape.meta?.toPort !== targetPortId) continue
    const src = editor.getShape<NodeCardShape>(start.toId)
    if (!src || src.type !== 'node-card') continue
    const fromPort = shape.meta?.fromPort as string | undefined
    if (!fromPort) continue
    const output = projectNodeOutputs(src)[fromPort]
    if ((output?.kind === 'text' || output?.kind === 'markdown') && output.text.trim()) {
      parts.push(output.text.trim())
    }
  }
  return parts.join('\n\n---\n\n')
}

/**
 * 收集进入目标节点的第一个结构化 JSON 输出。
 * 手动操作与工作流使用同一端口约定：脚本/分镜板输出 { shots }，JSON 输出自身内容，
 * 代码节点输出其最近一次运行结果。解析失败返回 null，不把普通文本伪装成 JSON。
 */
export function gatherUpstreamJson(
  editor: Editor,
  targetNodeId: TLShapeId,
  targetPortId = 'in-json'
): unknown | null {
  for (const shape of orderedPageArrows(editor)) {
    const { start, end } = getArrowBindings(editor, shape.id)
    if (!start || !end || end.toId !== targetNodeId || shape.meta?.toPort !== targetPortId) continue
    const fromPort = shape.meta?.fromPort as string | undefined
    if (!fromPort) continue
    const source = editor.getShape<NodeCardShape>(start.toId)
    if (!source || source.type !== 'node-card') continue
    const output = projectNodeOutputs(source)[fromPort]
    if (output?.kind === 'json') return output.data
  }
  return null
}

/** 读取指定媒体输入端口的第一个真实资产输出；图片资产与生图节点使用相同协议。 */
export function gatherUpstreamMedia<K extends 'image' | 'video' | 'audio' | 'file'>(
  editor: Editor,
  targetNodeId: TLShapeId,
  targetPortId: string,
  kind: K
): Extract<NodeValue, { kind: K }> | null {
  for (const shape of orderedPageArrows(editor)) {
    const { start, end } = getArrowBindings(editor, shape.id)
    if (
      !start ||
      !end ||
      end.toId !== targetNodeId ||
      shape.meta?.toPort !== targetPortId ||
      typeof shape.meta?.fromPort !== 'string'
    )
      continue
    const source = editor.getShape<NodeCardShape>(start.toId)
    if (!source || source.type !== 'node-card') continue
    const output = projectNodeOutputs(source)[shape.meta.fromPort]
    if (output?.kind === kind) return output as Extract<NodeValue, { kind: K }>
  }
  return null
}

/**
 * 收集某个 many 媒体端口的所有真实资产输出，顺序遵循画布边的保存顺序。
 * 交互式节点（如导演台）可把它显示为资源列表，但不得通过节点类型或标题猜测来源。
 */
export function gatherUpstreamMediaList<K extends 'image' | 'video' | 'audio' | 'file'>(
  editor: Editor,
  targetNodeId: TLShapeId,
  targetPortId: string,
  kind: K
): Extract<NodeValue, { kind: K }>[] {
  const assets: Extract<NodeValue, { kind: K }>[] = []
  for (const shape of orderedPageArrows(editor)) {
    const { start, end } = getArrowBindings(editor, shape.id)
    if (
      !start ||
      !end ||
      end.toId !== targetNodeId ||
      shape.meta?.toPort !== targetPortId ||
      typeof shape.meta?.fromPort !== 'string'
    )
      continue
    const source = editor.getShape<NodeCardShape>(start.toId)
    if (!source || source.type !== 'node-card') continue
    const output = projectNodeOutputs(source)[shape.meta.fromPort]
    if (output?.kind === kind) assets.push(output as Extract<NodeValue, { kind: K }>)
  }
  return assets
}

export function hasIncomingConnection(
  editor: Editor,
  targetNodeId: TLShapeId,
  targetPortId: string
): boolean {
  return editor.getCurrentPageShapes().some((shape) => {
    if (shape.type !== 'arrow' || shape.meta?.toPort !== targetPortId) return false
    return getArrowBindings(editor, shape.id).end?.toId === targetNodeId
  })
}
