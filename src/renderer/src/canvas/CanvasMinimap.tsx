// 左下角停靠簇：小地图（弹出） + 画布整理 + 缩放（LibTV 布局）
// 小地图为只读缩略图，点击地图图标弹出；缩放簇提供 +/−/适配/百分比
import { useEffect, useRef, useState } from 'react'
import type { Editor, TLShapeId } from 'tldraw'
import type { NodeCardShape } from './NodeCardShape'
import { getNodeType } from '../nodes/registry'
import { markUndoPoint } from './history'

const BOX_W = 168
const BOX_H = 108
const PAD = 8

interface NodeRect {
  id: TLShapeId
  x: number
  y: number
  w: number
  h: number
  color: string
  label: string
}

interface MinimapState {
  nodes: NodeRect[]
  zoom: number
  viewport: { minX: number; minY: number; maxX: number; maxY: number } | null
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
  const [state, setState] = useState<MinimapState>({ nodes: [], zoom: 1, viewport: null })
  const [showMap, setShowMap] = useState(false)
  const svgRef = useRef<SVGSVGElement>(null)

  // 订阅画布（含 camera 的 instance state）变化刷新缩略图
  useEffect(() => {
    if (!editor) return
    const update = (): void => {
      const nodes: NodeRect[] = []
      for (const s of editor.getCurrentPageShapes()) {
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
            label: n.props.title || ''
          })
        }
      }
      const vp = editor.getViewportPageBounds()
      setState({
        nodes,
        zoom: editor.getCamera().z,
        viewport: { minX: vp.minX, minY: vp.minY, maxX: vp.maxX, maxY: vp.maxY }
      })
    }
    update()
    const unsub = editor.store.listen(update, { scope: 'document' })
    return () => {
      unsub?.()
    }
  }, [editor])

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
    if (state.nodes.length === 0) return { minX: -200, minY: -150, maxX: 200, maxY: 150 }
    let minX = Infinity
    let minY = Infinity
    let maxX = -Infinity
    let maxY = -Infinity
    for (const n of state.nodes) {
      minX = Math.min(minX, n.x)
      minY = Math.min(minY, n.y)
      maxX = Math.max(maxX, n.x + n.w)
      maxY = Math.max(maxY, n.y + n.h)
    }
    // 留一点边距
    const padX = 60
    const padY = 60
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

  const handleClick = (e: React.MouseEvent): void => {
    if (!editor || state.nodes.length === 0) return
    const svg = svgRef.current
    if (!svg) return
    const rect = svg.getBoundingClientRect()
    const mx = e.clientX - rect.left
    const my = e.clientY - rect.top
    const px = bounds.minX + (mx - offX) / scale
    const py = bounds.minY + (my - offY) / scale
    editor.centerOnPoint({ x: px, y: py }, { animation: { duration: 220 } })
  }

  const vpRect = state.viewport
    ? (() => {
        const a = toMini(state.viewport.minX, state.viewport.minY)
        const b = toMini(state.viewport.maxX, state.viewport.maxY)
        return { x: a.x, y: a.y, w: b.x - a.x, h: b.y - a.y }
      })()
    : null

  return (
    <div className="canvas-dock">
      {/* 小地图弹出层 */}
      {showMap && (
        <div className="dock-minimap dock-minimap-popup">
          {state.nodes.length === 0 ? (
            <span className="dock-minimap-empty">空画布</span>
          ) : (
            <svg
              ref={svgRef}
              className="dock-minimap-svg"
              viewBox={`0 0 ${BOX_W} ${BOX_H}`}
              onClick={handleClick}
            >
              {state.nodes.map((n) => {
                const p = toMini(n.x, n.y)
                return (
                  <rect
                    key={n.id}
                    x={p.x}
                    y={p.y}
                    width={Math.max(3, n.w * scale)}
                    height={Math.max(3, n.h * scale)}
                    rx={2}
                    fill={n.color}
                    opacity={0.9}
                  />
                )
              })}
              {vpRect && (
                <rect
                  x={vpRect.x}
                  y={vpRect.y}
                  width={vpRect.w}
                  height={vpRect.h}
                  fill="rgba(9,202,245,0.10)"
                  stroke="rgba(9,202,245,0.7)"
                  strokeWidth={1}
                  rx={2}
                />
              )}
            </svg>
          )}
        </div>
      )}
      <div className="dock-controls">
        {/* 工具组：小地图切换 + 画布整理 */}
        <div className="dock-tool-group">
          <button className="dock-btn" title="小地图导航" onClick={() => setShowMap((v) => !v)}>
            {showMap ? '⊡' : '🗺'}
          </button>
          <button
            className="dock-btn"
            title="整理画布（Shift+Alt+F）"
            onClick={() => editor && organizeCanvas(editor)}
          >
            ✨
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
          <span className="dock-zoom-label">{Math.round(state.zoom * 100)}%</span>
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
            title="适配画布"
            onClick={() => editor && editor.zoomToFit({ animation: { duration: 220 } })}
          >
            ⊡
          </button>
        </div>
      </div>
    </div>
  )
}
