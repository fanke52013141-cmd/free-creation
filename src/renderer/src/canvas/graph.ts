// 连线系统核心：创建/校验 tldraw arrow + binding，保存时派生图数据
// 端口信息存 arrow.meta（fromPort/toPort），绑定锚点按端口纵向位置计算
import { createShapeId, type Editor, type TLShapeId } from 'tldraw'
import type { CanvasEdge, CanvasNode, ExecStatus, GroupDecl, PortDecl } from '@shared/types'
import { nodeSchemasCompatible } from '@shared/node-schemas'
import { getNodePorts, getNodeType, portCompatible, portOffsets } from '../nodes/registry'
import type { NodeCardShape } from './NodeCardShape'
import type { ConnectionFrom } from '../stores/connection'
import { projectNodeOutputs, type NodeValue } from '../nodes/nodeValues'

// 连线颜色按源端口类型分型。用 tldraw 内置标准色名（渲染层 getColorValue 解析为对应主题色），
// 因为 arrow 的 color 属性受 DefaultColorStyle 枚举校验，内置名才是类型安全且最稳的做法。
// 类型收窄为 tldraw 允许的色名联合，避免 string 过宽导致 typecheck 报错。
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
  text: 'light-blue',
  markdown: 'light-blue',
  json: 'violet',
  image: 'green',
  video: 'light-red',
  audio: 'yellow',
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
 * 创建连线：arrow 形状 + 两条 arrow binding（start/end 分别锚到源/目标端口位置）。
 * 绑定后连线自动跟随节点移动、可选中删除、支持撤销重做。
 */
export function createEdge(editor: Editor, from: EdgeEndpoint, to: EdgeEndpoint): boolean {
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

  const startPage = { x: fromShape.x + fromShape.props.w, y: fromShape.y + fromY }
  const endPage = { x: toShape.x, y: toShape.y + toY }
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
        dash: 'solid',
        size: 'l',
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
  editor.markHistoryStoppingPoint('create-edge')
  return true
}

/**
 * 尝试连接：选目标节点上最合适的输入端口（类型兼容 + 距离落点最近），
 * 校验重复/环后建边。返回错误信息（null = 成功）。
 */
export function tryConnect(
  editor: Editor,
  from: ConnectionFrom,
  targetShapeId: TLShapeId,
  dropPagePt?: { x: number; y: number }
): string | null {
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
  if (dropPagePt && usable.length > 1) {
    const offsets = portOffsets(targetPorts.in.length, target.props.h)
    let bestDist = Infinity
    for (const p of usable) {
      const idx = targetPorts.in.indexOf(p)
      const y = offsets[idx] ?? target.props.h / 2
      const d = Math.hypot(dropPagePt.x - target.x, dropPagePt.y - (target.y + y))
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

  createEdge(editor, { shapeId: from.shapeId, portId: from.portId }, endpoint)
  return null
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
        params: {},
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
 * 实时收集连入某节点的上游文本内容（用于对话/图片等节点手动触发时自动注入上下文）。
 * 遍历画布上的 arrow bindings，找到所有 → targetNodeId 的边，取源节点的文本输出。
 */
export function gatherUpstreamText(
  editor: Editor,
  targetNodeId: TLShapeId,
  targetPortId = 'in-text'
): string {
  const parts: string[] = []
  for (const shape of editor.getCurrentPageShapes()) {
    if (shape.type !== 'arrow') continue
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
  for (const shape of editor.getCurrentPageShapes()) {
    if (shape.type !== 'arrow') continue
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
  for (const shape of editor.getCurrentPageShapes()) {
    if (shape.type !== 'arrow') continue
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
  for (const shape of editor.getCurrentPageShapes()) {
    if (shape.type !== 'arrow') continue
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
