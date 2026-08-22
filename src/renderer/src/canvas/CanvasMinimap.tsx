// 左下角停靠簇：小地图（弹出） + 画布整理 + 缩放（LibTV 布局）
// 小地图支持点击 + 拖拽导航，节点彩色缩略图，视口框实时跟随
import { useCallback, useEffect, useRef, useState } from 'react'
import type { Editor, TLShapeId } from 'tldraw'
import type { NodeCardShape } from './NodeCardShape'
import { getNodeType } from '../nodes/registry'
import { markUndoPoint } from './history'

const BOX_W = 176
const BOX_H = 116
const PAD = 10

interface NodeRect {
  id: TLShapeId
  x: number
  y: number
  w: number
  h: number
  color: string
}

interface ViewportRect {
  x: number
  y: number
  w: number
  h: number
}

interface MinimapData {
  nodes: NodeRect[]
  viewport: ViewportRect | null
  zoom: number
}

interface DockProps {
  editor: Editor | null
}

/** 画布整理：把所有节点按行列网格自动排列（LibTV Shift+Option+F） */
function organizeCanvas(editor: Editor): void {
  const shapes = editor
    .getCurrentPageShapes()
    .filter((s): s is NodeCardShape => s.type === 'node-card')
  if (shapes.length === 0) return

  // 按节点 y 排序后做简单的自适应网格排列
  const sorted = [...shapes].sort((a, b) => {
    const ay = a.y + a.props.h / 2
    const by = b.y + b.props.h / 2
    if (Math.abs(ay - by) < 80) return a.x - b.x // 同一行按 x 排
    return ay - by
  })

  const GAP_X = 60
  const GAP_Y = 80
  const COLS = Math.ceil(Math.sqrt(sorted.length))
  let col = 0
  let row = 0
  let rowMaxH = 0
  const startX = sorted[0].x
  const startY = sorted[0].y

  const updates: Array<{ id: TLShapeId; x: number; y: number }> = []
  for (const s of sorted) {
    const x = startX + col * (260 + GAP_X)
    const y = startY + row * (rowMaxH + GAP_Y)
    updates.push({ id: s.id, x, y })
    rowMaxH = Math.max(rowMaxH, s.props.h)
    col++
    if (col >= COLS) {
      col = 0
      row++
      rowMaxH = 0
    }
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
  const [data, setData] = useState<MinimapData>({ nodes: [], viewport: null, zoom: 1 })
  const [showMap, setShowMap] = useState(false)
  const svgRef = useRef<SVGSVGElement>(null)
  const draggingRef = useRef(false)
  // rAF 节流：避免频繁 store 更新引发 setState 风暴
  const rafRef = useRef<number | null>(null)

  const scheduleUpdate = useCallback(
    (ed: Editor): void => {
      if (rafRef.current !== null) return
      rafRef.current = requestAnimationFrame(() => {
        rafRef.current = null
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
              color: spec?.color ?? '#09caf5'
            })
          }
        }
        const vp = ed.getViewportPageBounds()
        setData({
          nodes,
          zoom: ed.getCamera().z,
          viewport: { x: vp.minX, y: vp.minY, w: vp.maxX - vp.minX, h: vp.maxY - vp.minY }
        })
      })
    },
    []
  )

  useEffect(() => {
    if (!editor) return
    scheduleUpdate(editor)
    const unsub1 = editor.store.listen(() => scheduleUpdate(editor), { scope: 'document' })
    const unsub2 = editor.store.listen(() => scheduleUpdate(editor), { scope: 'session' })
    return () => {
      unsub1?.()
      unsub2?.()
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current)
    }
  }, [editor, scheduleUpdate])

  // 画布整理快捷键 Shift + Alt + F（LibTV）
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

  // 节点包围盒（页坐标）
  const bounds = ((): { minX: number; minY: number; maxX: number; maxY: number } => {
    if (data.nodes.length === 0) return { minX: -200, minY: -150, maxX: 200, maxY: 150 }
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
    // 包含当前视口范围，避免缩放时 minimap 内容跳动
    if (data.viewport) {
      minX = Math.min(minX, data.viewport.x)
      minY = Math.min(minY, data.viewport.y)
      maxX = Math.max(maxX, data.viewport.x + data.viewport.w)
      maxY = Math.max(maxY, data.viewport.y + data.viewport.h)
    }
    const padX = 80
    const padY = 80
    return { minX: minX - padX, minY: minY - padY, maxX: maxX + padX, maxY: maxY + padY }
  })()

  const cw = bounds.maxX - bounds.minX
  const ch = bounds.maxY - bounds.minY
  const scale = Math.min((BOX_W - PAD * 2) / cw, (BOX_H - PAD * 2) / ch) || 1
  const offX = PAD + (BOX_W - PAD * 2 - cw * scale) / 2
  const offY = PAD + (BOX_H - PAD * 2 - ch * scale) / 2

  const toMini = (x: number, y: number): { x: number; y: number } => ({
    x: offX + (x - bounds.minX) * scale,
    y: offY + (y - bounds.minY) * scale
  })

  const navigateToPoint = (clientX: number, clientY: number): void => {
    if (!editor || data.nodes.length === 0) return
    const svg = svgRef.current
    if (!svg) return
    const rect = svg.getBoundingClientRect()
    // SVG viewBox 与显示尺寸可能有偏差，用比例换算
    const sx = BOX_W / rect.width
    const sy = BOX_H / rect.height
    const mx = (clientX - rect.left) * sx
    const my = (clientY - rect.top) * sy
    const px = bounds.minX + (mx - offX) / scale
    const py = bounds.minY + (my - offY) / scale
    editor.centerOnPoint({ x: px, y: py }, { animation: { duration: 120 } })
  }

  // 拖拽导航
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

  // 视口框（小地图坐标系）
  const vpMini = data.viewport
    ? (() => {
        const a = toMini(data.viewport.x, data.viewport.y)
        const b = toMini(data.viewport.x + data.viewport.w, data.viewport.y + data.viewport.h)
        return {
          x: a.x,
          y: a.y,
          w: Math.max(4, b.x - a.x),
          h: Math.max(4, b.y - a.y)
        }
      })()
    : null

  return (
    <div className="canvas-dock">
      {/* 小地图弹出层 */}
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
                <pattern
                  id="mm-grid"
                  width="16"
                  height="16"
                  patternUnits="userSpaceOnUse"
                >
                  <path d="M 16 0 L 0 0 0 16" fill="none" stroke="rgba(255,255,255,0.03)" strokeWidth="1" />
                </pattern>
              </defs>
              <rect width={BOX_W} height={BOX_H} fill="url(#mm-grid)" />
              {data.nodes.map((n) => {
                const p = toMini(n.x, n.y)
                return (
                  <rect
                    key={n.id}
                    x={p.x}
                    y={p.y}
                    width={Math.max(3, n.w * scale)}
                    height={Math.max(3, n.h * scale)}
                    rx={2}
                    ry={2}
                    fill={n.color}
                    opacity={0.82}
                  >
                    <title>{n.id.toString()}</title>
                  </rect>
                )
              })}
              {vpMini && (
                <rect
                  x={vpMini.x}
                  y={vpMini.y}
                  width={vpMini.w}
                  height={vpMini.h}
                  fill="rgba(9,202,245,0.08)"
                  stroke="var(--brand)"
                  strokeWidth={1.5}
                  strokeDasharray="3 2"
                  rx={2}
                  pointerEvents="none"
                />
              )}
            </svg>
          )}
        </div>
      )}
      <div className="dock-controls">
        {/* 工具组：小地图切换 */}
        <div className="dock-tool-group">
          <button className="dock-btn" title="小地图导航" onClick={() => setShowMap((v) => !v)}>
            {showMap ? '⊡' : '🗺'}
          </button>
        </div>
        {/* 缩放簇 */}
        <div className="dock-zoom">
          <button
            className="dock-btn"
            title="放大"
            onClick={() =>
              editor &&
              editor.zoomIn(editor.getViewportPageBounds().center, { animation: { duration: 180 } })
            }
          >
            ＋
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
            －
          </button>
          <button
            className="dock-btn"
            title="适配画布（缩放到所有节点）"
            onClick={() => editor && editor.zoomToFit({ animation: { duration: 220 } })}
          >
            ⤢
          </button>
          <button
            className="dock-btn"
            title="重置缩放到 100%"
            onClick={() =>
              editor &&
              editor.setCamera({ ...editor.getCamera(), z: 1 }, { animation: { duration: 220 } })
            }
          >
            ◎
          </button>
        </div>
      </div>
    </div>
  )
}
