// 左下角停靠簇：连线显隐 + 小地图 + 缩放（LibTV 26-7-7 布局）
// 小地图为只读缩略图，单击任意处把画布视角中心移到对应位置；缩放簇提供 +/−/适配/百分比
import { useEffect, useRef, useState } from 'react'
import type { Editor, TLShapeId } from 'tldraw'
import type { NodeCardShape } from './NodeCardShape'
import { getNodeType } from '../nodes/registry'

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
  edgesVisible: boolean
  onToggleEdges: () => void
}

export function CanvasBottomDock({
  editor,
  edgesVisible,
  onToggleEdges
}: DockProps): React.JSX.Element {
  const [state, setState] = useState<MinimapState>({ nodes: [], zoom: 1, viewport: null })
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
            color: spec?.color ?? '#6c8cff',
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
      <div className="dock-minimap">
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
                fill="rgba(108,140,255,0.10)"
                stroke="rgba(108,140,255,0.7)"
                strokeWidth={1}
                rx={2}
              />
            )}
          </svg>
        )}
      </div>
      <div className="dock-controls">
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
        <button className="dock-btn dock-toggle" title="显示 / 隐藏连线" onClick={onToggleEdges}>
          🔗 {edgesVisible ? '隐' : '显'}
        </button>
      </div>
    </div>
  )
}
