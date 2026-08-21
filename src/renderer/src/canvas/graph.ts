// 连线系统核心：创建/校验 tldraw arrow + binding，保存时派生图数据
// 端口信息存 arrow.meta（fromPort/toPort），绑定锚点按端口纵向位置计算
import { createShapeId, type Editor, type TLShapeId } from 'tldraw'
import type { CanvasEdge, CanvasNode, ExecStatus, PortDecl } from '@shared/types'
import { getNodeType, portCompatible, portOffsets } from '../nodes/registry'
import type { NodeCardShape } from './NodeCardShape'
import type { ConnectionFrom } from '../stores/connection'

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
  const fromPort = fromSpec?.ports.out.find((p) => p.id === from.portId) ?? fromSpec?.ports.out[0]
  const toPort = toSpec?.ports.in.find((p) => p.id === to.portId) ?? toSpec?.ports.in[0]
  if (!fromSpec || !toSpec || !fromPort || !toPort) return false

  const fromIdx = Math.max(0, fromSpec.ports.out.indexOf(fromPort))
  const toIdx = Math.max(0, toSpec.ports.in.indexOf(toPort))
  const fromY =
    portOffsets(fromSpec.ports.out.length, fromShape.props.h)[fromIdx] ?? fromShape.props.h / 2
  const toY = portOffsets(toSpec.ports.in.length, toShape.props.h)[toIdx] ?? toShape.props.h / 2

  const startPage = { x: fromShape.x + fromShape.props.w, y: fromShape.y + fromY }
  const endPage = { x: toShape.x, y: toShape.y + toY }
  const arrowId = createShapeId()

  editor.run(() => {
    editor.createShape({
      id: arrowId,
      type: 'arrow',
      x: startPage.x,
      y: startPage.y,
      props: {
        kind: 'arc',
        color: 'grey',
        fill: 'none',
        dash: 'solid',
        size: 'm',
        font: 'sans',
        arrowheadStart: 'none',
        arrowheadEnd: 'arrow',
        start: { x: 0, y: 0 },
        end: { x: endPage.x - startPage.x, y: endPage.y - startPage.y },
        bend: 0,
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

  const usable = targetSpec.ports.in.filter((p) => portCompatible(p.type, from.portType))
  if (usable.length === 0) {
    return `类型不兼容：${from.portType} 输出无法接入 ${targetSpec.label} 节点`
  }

  let port: PortDecl = usable[0]
  if (dropPagePt && usable.length > 1) {
    const offsets = portOffsets(targetSpec.ports.in.length, target.props.h)
    let bestDist = Infinity
    for (const p of usable) {
      const idx = targetSpec.ports.in.indexOf(p)
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
  groups: []
} {
  const nodes: CanvasNode[] = []
  const edges: CanvasEdge[] = []

  for (const shape of editor.getCurrentPageShapes()) {
    if (shape.type === 'node-card') {
      const s = shape as NodeCardShape
      const spec = getNodeType(s.props.nodeType)
      const ports: PortDecl[] = [...(spec?.ports.in ?? []), ...(spec?.ports.out ?? [])]
      nodes.push({
        id: s.id,
        type: s.props.nodeType as CanvasNode['type'],
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
    }
  }

  return { nodes, edges, groups: [] }
}
