// 左下角停靠簇：小地图（弹出） + 缩放控制
// 小地图完全重写：即时拖拽响应（无动画延迟）、实时视口跟随、连线可视化、点击节点聚焦
import { useCallback, useEffect, useRef, useState } from 'react'
import type { Editor, TLShapeId } from 'tldraw'
import type { NodeCardShape } from './NodeCardShape'
import { getNodeType } from '../nodes/registry'
import { markUndoPoint } from './history'
import { Icon } from '../components/Icon'

const BOX_W = 220
const BOX_H = 150
const PAD = 12

interface NodeRect {
  id: TLShapeId
  x: number
  y: number
  w: number
  h: number
  color: string
  selected: boolean
}

interface EdgeLine {
  x1: number
  y1: number
  x2: number
  y2: number
}

interface ViewportRect {
  x: number
  y: number
  w: number
  h: number
}

interface MinimapData {
  nodes: NodeRect[]
  edges: EdgeLine[]
  viewport: ViewportRect | null
  zoom: number
}

interface DockProps {
  editor: Editor | null
}

/** 画布整理：把所有节点按行列网格自动排列 */
function organizeCanvas(editor: Editor): void {
  const shapes = editor
    .getCurrentPageShapes()
    .filter((s): s is NodeCardShape => s.type === 'node-card')
  if (shapes.length === 0) return

  const sorted = [...shapes].sort((a, b) => {
    const ay = a.y + a.props.h / 2
    const by = b.y + b.props.h / 2
    if (Math.abs(ay - by) < 80) return a.x - b.x
    return ay - by
  })

  const GAP_X = 60
  const GAP_Y = 80
  const COLS = Math.max(1, Math.ceil(Math.sqrt(sorted.length)))
  const startX = sorted[0].x
  const startY = sorted[0].y

  // 使用每个节点的真实宽高计算网格，避免旧版固定 260px 列宽导致节点重叠。
  const colWidths = Array.from({ length: COLS }, (_, col) =>
    Math.max(...sorted.filter((_, i) => i % COLS === col).map((s) => s.props.w))
  )
  const rowCount = Math.ceil(sorted.length / COLS)
  const rowHeights = Array.from({ length: rowCount }, (_, row) =>
    Math.max(...sorted.slice(row * COLS, row * COLS + COLS).map((s) => s.props.h))
  )
  const colOffsets = colWidths.map((_, col) =>
    colWidths.slice(0, col).reduce((sum, width) => sum + width + GAP_X, 0)
  )
  const rowOffsets = rowHeights.map((_, row) =>
    rowHeights.slice(0, row).reduce((sum, height) => sum + height + GAP_Y, 0)
  )

  const updates: Array<{ id: TLShapeId; x: number; y: number }> = []
  for (const [index, s] of sorted.entries()) {
    const col = index % COLS
    const row = Math.floor(index / COLS)
    const x = startX + colOffsets[col]
    const y = startY + rowOffsets[row]
    updates.push({ id: s.id, x, y })
  }

  editor.updateShapes(
    updates.map((u) => ({
      id: u.id,
      type: 'node-card' as const,
      x: u.x,
      y: u.y
    }))
  )
  markUndoPoint(editor, 'organize-canvas')
  editor.zoomToFit({ animation: { duration: 300 } })
}

export function CanvasBottomDock({ editor }: DockProps): React.JSX.Element {
  const [data, setData] = useState<MinimapData>({ nodes: [], edges: [], viewport: null, zoom: 1 })
  const [showMap, setShowMap] = useState(false)
  const svgRef = useRef<SVGSVGElement>(null)
  const draggingRef = useRef(false)

  // 直接读取数据（无 rAF 延迟）：解决"不跟手"问题
  const readData = useCallback((ed: Editor): MinimapData => {
    const selIds = new Set(ed.getSelectedShapeIds())
    const nodes: NodeRect[] = []
    for (const s of ed.getCurrentPageShapes()) {
      if (s.type === 'node-card') {
        const n = s as NodeCardShape
        const spec = getNodeType(n.props.nodeType)
        nodes.push({
          id: s.id,
          x: n.x,
          y: n.y,
          w: n.props.w,
          h: n.props.h,
          color: spec?.color ?? '#09caf5',
          selected: selIds.has(s.id)
        })
      }
    }
    // 提取连线
    const edges: EdgeLine[] = []
    const nodeMap = new Map<string, NodeCardShape>()
    for (const s of ed.getCurrentPageShapes()) {
      if (s.type === 'node-card') nodeMap.set(s.id, s as NodeCardShape)
    }
    for (const s of ed.getCurrentPageShapes()) {
      if (s.type !== 'arrow') continue
      const bindings = ed.getBindingsFromShape(s.id, 'arrow')
      const startB = bindings.find((b) => b.props.terminal === 'start')
      const endB = bindings.find((b) => b.props.terminal === 'end')
      if (!startB || !endB) continue
      const fromShape = nodeMap.get(startB.toId)
      const toShape = nodeMap.get(endB.toId)
      if (!fromShape || !toShape) continue
      edges.push({
        x1: fromShape.x + fromShape.props.w,
        y1: fromShape.y + fromShape.props.h / 2,
        x2: toShape.x,
        y2: toShape.y + toShape.props.h / 2
      })
    }
    const vp = ed.getViewportPageBounds()
    return {
      nodes,
      edges,
      zoom: ed.getCamera().z,
      viewport: { x: vp.minX, y: vp.minY, w: vp.maxX - vp.minX, h: vp.maxY - vp.minY }
    }
  }, [])

  // 监听 store 变化 + 相机变化：用微任务批处理而非 rAF，减少延迟
  useEffect(() => {
    if (!editor) return
    let pending = false
    const flush = (): void => {
      pending = false
      setData(readData(editor))
    }
    const schedule = (): void => {
      if (pending) return
      pending = true
      // 微任务：比 rAF 更快响应，解决拖拽时"不跟手"
      Promise.resolve().then(flush)
    }
    const unsub1 = editor.store.listen(schedule, { scope: 'document' })
    const unsub2 = editor.store.listen(schedule, { scope: 'session' })
    schedule()
    return () => {
      unsub1?.()
      unsub2?.()
    }
  }, [editor, readData])

  // 画布整理快捷键 Shift + Alt + F
  useEffect(() => {
    const handler = (e: KeyboardEvent): void => {
      if (e.shiftKey && e.altKey && (e.key === 'f' || e.key === 'F')) {
        e.preventDefault()
        if (editor) organizeCanvas(editor)
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [editor])

  // 计算 bounds 和坐标映射
  const b = (() => {
    if (data.nodes.length === 0 && !data.viewport) {
      return { minX: -200, minY: -150, maxX: 200, maxY: 150 }
    }
    let minX = Infinity
    let minY = Infinity
    let maxX = -Infinity
    let maxY = -Infinity
    for (const n of data.nodes) {
      minX = Math.min(minX, n.x)
      minY = Math.min(minY, n.y)
      maxX = Math.max(maxX, n.x + n.w)
      maxY = Math.max(maxY, n.y + n.h)
    }
    if (data.viewport) {
      minX = Math.min(minX, data.viewport.x)
      minY = Math.min(minY, data.viewport.y)
      maxX = Math.max(maxX, data.viewport.x + data.viewport.w)
      maxY = Math.max(maxY, data.viewport.y + data.viewport.h)
    }
    const padX = 100
    const padY = 100
    return { minX: minX - padX, minY: minY - padY, maxX: maxX + padX, maxY: maxY + padY }
  })()

  const cw = Math.max(1, b.maxX - b.minX)
  const ch = Math.max(1, b.maxY - b.minY)
  const scale = Math.min((BOX_W - PAD * 2) / cw, (BOX_H - PAD * 2) / ch) || 1
  const offX = PAD + (BOX_W - PAD * 2 - cw * scale) / 2
  const offY = PAD + (BOX_H - PAD * 2 - ch * scale) / 2

  const toMini = (x: number, y: number): { x: number; y: number } => ({
    x: offX + (x - b.minX) * scale,
    y: offY + (y - b.minY) * scale
  })

  // 即时导航：拖拽时直接 setCamera（无动画延迟），解决"不跟手"
  const navigateToPoint = (clientX: number, clientY: number): void => {
    if (!editor) return
    const svg = svgRef.current
    if (!svg) return
    const rect = svg.getBoundingClientRect()
    const sx = BOX_W / rect.width
    const sy = BOX_H / rect.height
    const mx = (clientX - rect.left) * sx
    const my = (clientY - rect.top) * sy
    const px = b.minX + (mx - offX) / scale
    const py = b.minY + (my - offY) / scale
    editor.centerOnPoint({ x: px, y: py })
  }

  // 点击节点：选中并聚焦缩放到该节点
  const focusNode = (node: NodeRect): void => {
    if (!editor) return
    editor.setSelectedShapes([node.id])
    editor.zoomToSelection({ animation: { duration: 200 } })
  }

  const handlePointerDown = (e: React.PointerEvent): void => {
    if (!editor || data.nodes.length === 0) return
    e.preventDefault()
    e.stopPropagation()
    draggingRef.current = true
    navigateToPoint(e.clientX, e.clientY)
    const svg = svgRef.current
    if (svg) svg.setPointerCapture(e.pointerId)
  }

  const handlePointerMove = (e: React.PointerEvent): void => {
    if (!draggingRef.current) return
    navigateToPoint(e.clientX, e.clientY)
  }

  const handlePointerUp = (e: React.PointerEvent): void => {
    draggingRef.current = false
    const svg = svgRef.current
    if (svg && svg.hasPointerCapture(e.pointerId)) svg.releasePointerCapture(e.pointerId)
  }

  // 视口框
  const vpMini = data.viewport
    ? (() => {
        const a = toMini(data.viewport.x, data.viewport.y)
        const b2 = toMini(data.viewport.x + data.viewport.w, data.viewport.y + data.viewport.h)
        return {
          x: a.x,
          y: a.y,
          w: Math.max(5, b2.x - a.x),
          h: Math.max(5, b2.y - a.y)
        }
      })()
    : null

  return (
    <div className="canvas-dock">
      {showMap && (
        <div className="dock-minimap dock-minimap-popup">
          {data.nodes.length === 0 ? (
            <span className="dock-minimap-empty">空画布</span>
          ) : (
            <svg
              ref={svgRef}
              className="dock-minimap-svg"
              viewBox={`0 0 ${BOX_W} ${BOX_H}`}
              onPointerDown={handlePointerDown}
              onPointerMove={handlePointerMove}
              onPointerUp={handlePointerUp}
              onPointerCancel={handlePointerUp}
            >
              <defs>
                <pattern id="mm-grid" width="20" height="20" patternUnits="userSpaceOnUse">
                  <path
                    d="M 20 0 L 0 0 0 20"
                    fill="none"
                    stroke="rgba(255,255,255,0.04)"
                    strokeWidth="0.5"
                  />
                </pattern>
              </defs>
              <rect width={BOX_W} height={BOX_H} fill="url(#mm-grid)" />
              {/* 连线 */}
              {data.edges.map((edge, i) => {
                const a = toMini(edge.x1, edge.y1)
                const c = toMini(edge.x2, edge.y2)
                return (
                  <line
                    key={`e${i}`}
                    x1={a.x}
                    y1={a.y}
                    x2={c.x}
                    y2={c.y}
                    stroke="rgba(148,163,184,0.4)"
                    strokeWidth="1"
                    strokeLinecap="round"
                  />
                )
              })}
              {/* 节点 */}
              {data.nodes.map((n) => {
                const p = toMini(n.x, n.y)
                const w = Math.max(4, n.w * scale)
                const h = Math.max(4, n.h * scale)
                return (
                  <rect
                    key={n.id}
                    x={p.x}
                    y={p.y}
                    width={w}
                    height={h}
                    rx={Math.min(3, w / 3)}
                    ry={Math.min(3, h / 3)}
                    fill={n.color}
                    opacity={n.selected ? 1 : 0.75}
                    stroke={n.selected ? '#fff' : 'none'}
                    strokeWidth={n.selected ? 1.5 : 0}
                    style={{ cursor: 'pointer', transition: 'opacity 0.15s' }}
                    onPointerDown={(e) => {
                      e.stopPropagation()
                      focusNode(n)
                    }}
                  >
                    <title>点击聚焦此节点</title>
                  </rect>
                )
              })}
              {/* 视口框 */}
              {vpMini && (
                <rect
                  x={vpMini.x}
                  y={vpMini.y}
                  width={vpMini.w}
                  height={vpMini.h}
                  fill="rgba(9,202,245,0.06)"
                  stroke="var(--brand)"
                  strokeWidth={1.5}
                  strokeDasharray="4 3"
                  rx={3}
                  pointerEvents="none"
                />
              )}
            </svg>
          )}
        </div>
      )}
      <div className="dock-controls">
        <div className="dock-tool-group">
          <button className="dock-btn" title="小地图导航" onClick={() => setShowMap((v) => !v)}>
            <Icon name="minimap" size={16} />
          </button>
        </div>
        <div className="dock-zoom">
          <button
            className="dock-btn"
            title="放大"
            onClick={() =>
              editor &&
              editor.zoomIn(editor.getViewportPageBounds().center, { animation: { duration: 180 } })
            }
          >
            <Icon name="zoom-in" size={16} />
          </button>
          <span className="dock-zoom-label">{Math.round(data.zoom * 100)}%</span>
          <button
            className="dock-btn"
            title="缩小"
            onClick={() =>
              editor &&
              editor.zoomOut(editor.getViewportPageBounds().center, {
                animation: { duration: 180 }
              })
            }
          >
            <Icon name="zoom-out" size={16} />
          </button>
          <button
            className="dock-btn"
            title="适配画布（缩放到所有节点）"
            onClick={() => editor && editor.zoomToFit({ animation: { duration: 220 } })}
          >
            <Icon name="fit" size={16} />
          </button>
          <button
            className="dock-btn"
            title="重置缩放到 100%"
            onClick={() =>
              editor &&
              editor.setCamera({ ...editor.getCamera(), z: 1 }, { animation: { duration: 220 } })
            }
          >
            <Icon name="reset" size={16} />
          </button>
        </div>
      </div>
    </div>
  )
}
