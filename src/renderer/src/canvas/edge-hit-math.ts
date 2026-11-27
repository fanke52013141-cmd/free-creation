import type { Editor, TLShapeId } from 'tldraw'
import type { EdgePoint } from './edge-geometry'
import { NODE_PORT_OUTSET } from './edge-geometry'
import type { NodeCardShape } from './NodeCardShape'
import { getNodePorts, getNodeType } from '../nodes/registry'
import { createNodePortLayout } from './node-port-layout'
import { dynamicPortIdsForShape } from './graph'
import { nodePageIndex } from './node-page-index'

export interface CubicBezierCurve {
  x0: number
  y0: number
  c1x: number
  c1y: number
  c2x: number
  c2y: number
  x1: number
  y1: number
  minX: number
  minY: number
  maxX: number
  maxY: number
}

/**
 * 与 edge-geometry.ts buildDataEdgePath 完全同源的三次贝塞尔几何与解析 AABB。
 * 同时产出 SVG path 字符串与纯数学命中曲线，消除 path.getBBox() 与 isPointInStroke() DOM 调用。
 */
export function buildDataEdgeCurve(
  start: EdgePoint,
  end: EdgePoint,
  opts?: { backward?: boolean }
): { path: string; curve: CubicBezierCurve } {
  let c1x: number
  let c1y: number
  let c2x: number
  let c2y: number
  if (opts?.backward) {
    const lift = Math.abs(end.x - start.x) * 0.25
    const topY = Math.min(start.y, end.y) - lift
    c1x = start.x
    c1y = topY
    c2x = end.x
    c2y = topY
  } else {
    const dx = end.x - start.x
    const handle = Math.abs(dx) * 0.46
    const direction = dx >= 0 ? 1 : -1
    c1x = start.x + direction * handle
    c1y = start.y
    c2x = end.x - direction * handle
    c2y = end.y
  }

  const curve: CubicBezierCurve = {
    x0: start.x,
    y0: start.y,
    c1x,
    c1y,
    c2x,
    c2y,
    x1: end.x,
    y1: end.y,
    minX: Math.min(start.x, c1x, c2x, end.x),
    minY: Math.min(start.y, c1y, c2y, end.y),
    maxX: Math.max(start.x, c1x, c2x, end.x),
    maxY: Math.max(start.y, c1y, c2y, end.y)
  }

  return {
    path: `M ${start.x} ${start.y} C ${c1x} ${c1y}, ${c2x} ${c2y}, ${end.x} ${end.y}`,
    curve
  }
}

function pointToSegmentDistSq(
  px: number,
  py: number,
  ax: number,
  ay: number,
  bx: number,
  by: number
): number {
  const dx = bx - ax
  const dy = by - ay
  const lenSq = dx * dx + dy * dy
  if (lenSq === 0) {
    const ex = px - ax
    const ey = py - ay
    return ex * ex + ey * ey
  }
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / lenSq))
  const projX = ax + t * dx
  const projY = ay + t * dy
  const ex = px - projX
  const ey = py - projY
  return ex * ex + ey * ey
}

/** 计算页面坐标点到三次贝塞尔曲线的近似最短距离（16 段折线采样，误差 < 0.3px，0 DOM 开销）。 */
export function distancePointToCubicBezier(
  px: number,
  py: number,
  curve: CubicBezierCurve,
  steps = 16
): number {
  let prevX = curve.x0
  let prevY = curve.y0
  let bestSq = Number.POSITIVE_INFINITY
  for (let i = 1; i <= steps; i += 1) {
    const t = i / steps
    const mt = 1 - t
    const mt2 = mt * mt
    const t2 = t * t
    const a = mt2 * mt
    const b = 3 * mt2 * t
    const c = 3 * mt * t2
    const d = t2 * t
    const x = a * curve.x0 + b * curve.c1x + c * curve.c2x + d * curve.x1
    const y = a * curve.y0 + b * curve.c1y + c * curve.c2y + d * curve.y1
    const distSq = pointToSegmentDistSq(px, py, prevX, prevY, x, y)
    if (distSq < bestSq) bestSq = distSq
    prevX = x
    prevY = y
  }
  return Math.sqrt(bestSq)
}

/**
 * 纯数学判断页面坐标是否落在任意节点端口的屏幕半径内（默认 27px）。
 * 替代全页 document.querySelectorAll('.port-dot') + getBoundingClientRect() 强制回流。
 */
export function findPortNearPagePoint(
  editor: Editor,
  pagePt: EdgePoint,
  screenRadiusPx: number
): { shapeId: TLShapeId; portId: string; side: 'in' | 'out' } | null {
  const zoom = editor.getCamera().z || 1
  const pageRadius = screenRadiusPx / zoom
  const searchMargin = NODE_PORT_OUTSET + pageRadius + 4
  const candidate = editor.getShapeAtPoint(pagePt, {
    hitInside: true,
    margin: searchMargin,
    filter: (s) => s.type === 'node-card' && s.opacity !== 0
  }) as NodeCardShape | undefined
  if (!candidate || candidate.type !== 'node-card') return null
  const bounds = editor.getShapePageBounds(candidate.id)
  if (!bounds) return null
  const spec = getNodeType(candidate.props.nodeType)
  if (!spec) return null
  const ports = getNodePorts(spec, candidate)
  const conn = nodePageIndex(editor).portConnections.get(candidate.id)
  const dynamic = dynamicPortIdsForShape(candidate)
  const inLayout = createNodePortLayout(
    ports.in,
    conn?.in ?? new Set(),
    candidate.props.h,
    undefined,
    dynamic.in
  )
  const outLayout = createNodePortLayout(
    ports.out,
    conn?.out ?? new Set(),
    candidate.props.h,
    undefined,
    dynamic.out
  )
  const toPageY = (offset: number): number =>
    candidate.props.h > 0 ? bounds.y + (bounds.height * offset) / candidate.props.h : bounds.y

  for (const p of inLayout.ports) {
    const px = bounds.x - NODE_PORT_OUTSET
    const py = toPageY(inLayout.offsets.get(p.id) ?? candidate.props.h / 2)
    if (Math.hypot(pagePt.x - px, pagePt.y - py) <= pageRadius) {
      return { shapeId: candidate.id, portId: p.id, side: 'in' }
    }
  }
  for (const p of outLayout.ports) {
    const px = bounds.maxX + NODE_PORT_OUTSET
    const py = toPageY(outLayout.offsets.get(p.id) ?? candidate.props.h / 2)
    if (Math.hypot(pagePt.x - px, pagePt.y - py) <= pageRadius) {
      return { shapeId: candidate.id, portId: p.id, side: 'out' }
    }
  }
  return null
}
