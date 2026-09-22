// 连线拖拽引线浮层：订阅 connection store 渲染跟手贝塞尔曲线（portal 到 body，避开画布 transform）。
// 只在拖线时给出一次克制的类型色提示；正式连接后的视觉由 tldraw arrow 统一负责。
import { createPortal } from 'react-dom'
import { useEffect, useId, useState } from 'react'
import type { Editor } from 'tldraw'
import { useConnectionStore } from '../stores/connection'
import type { ConnectionFrom, Pt } from '../stores/connection'
import { PORT_COLORS } from '../nodes/registry'
import { buildDataEdgePath } from './edge-geometry'

export function ConnectionLayer(): React.JSX.Element | null {
  const draft = useConnectionStore((s) => s.draft)
  const reactId = useId().replace(/:/g, '')
  const gradientId = `connection-flow-gradient-${reactId}`

  if (!draft) return null

  const { startPt, pointer, from } = draft
  const color = PORT_COLORS[from.portType] ?? '#09caf5'
  // 与正式连线使用同一套比例几何，拖拽预览在反向拖动时也不会翻折成 S 型。
  const path = buildDataEdgePath(startPt, pointer)
  return createPortal(
    <svg className="conn-overlay">
      <defs>
        <linearGradient
          id={gradientId}
          gradientUnits="userSpaceOnUse"
          spreadMethod="repeat"
          x1="0"
          y1="0"
          x2="220"
          y2="0"
        >
          <stop offset="0" stopColor="#54f4cb" />
          <stop offset="0.22" stopColor="#4fc4ff" />
          <stop offset="0.48" stopColor="#a889ff" />
          <stop offset="0.7" stopColor="#6ff3b9" />
          <stop offset="1" stopColor="#54f4cb" />
        </linearGradient>
      </defs>
      {/* 静态类型色作底线；彩色水流只是一段从源端向光标移动的高光。 */}
      <path className="conn-glow-path" d={path} style={{ stroke: color }} />
      <path className="conn-main-path" d={path} style={{ stroke: color }} />
      <path
        className="conn-water-path"
        d={path}
        pathLength="1000"
        style={{ stroke: `url(#${gradientId})` }}
      />
      <circle className="conn-start" cx={startPt.x} cy={startPt.y} r={5} fill={color} />
      <circle className="conn-cursor" cx={pointer.x} cy={pointer.y} r={6.5} fill={color} />
    </svg>,
    document.body
  )
}

/** 拉线落在空白处时，菜单出现前保留一条明确连接到菜单落点的临时引线。 */
export function PendingConnectionLayer({
  editor,
  startPage,
  endPt,
  from
}: {
  editor: Editor
  startPage: Pt
  endPt: Pt
  from: ConnectionFrom
}): React.JSX.Element {
  const [, setRevision] = useState(0)

  // 菜单固定在屏幕坐标，但源端口属于页面坐标。每次相机变化后重新投影，
  // 避免缩放时仅节点移动、临时引线却停留在旧屏幕位置。
  useEffect(() => {
    let frame = 0
    const redraw = () => {
      if (frame) return
      frame = requestAnimationFrame(() => {
        frame = 0
        setRevision((revision) => revision + 1)
      })
    }
    editor.on('tick', redraw)
    editor.on('resize', redraw)
    return () => {
      editor.off('tick', redraw)
      editor.off('resize', redraw)
      if (frame) cancelAnimationFrame(frame)
    }
  }, [editor])

  const startPt = editor.pageToScreen(startPage)
  const color = PORT_COLORS[from.portType] ?? '#09caf5'
  const path = buildDataEdgePath(startPt, endPt)
  return createPortal(
    <svg className="conn-overlay conn-menu-link" aria-hidden="true">
      <path className="conn-glow-path" d={path} style={{ stroke: color }} />
      <path className="conn-main-path" d={path} style={{ stroke: color }} />
      <circle className="conn-start" cx={startPt.x} cy={startPt.y} r={5} fill={color} />
      <circle className="conn-menu-anchor" cx={endPt.x} cy={endPt.y} r={5} fill={color} />
    </svg>,
    document.body
  )
}
