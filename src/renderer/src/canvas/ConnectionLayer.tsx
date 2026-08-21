// 连线拖拽引线浮层：订阅 connection store 渲染跟手虚线（portal 到 body，避开画布 transform）
// 用贝塞尔曲线 + 源端口类型配色，视觉与正式连线（spline + 分色）一致
import { createPortal } from 'react-dom'
import { useConnectionStore } from '../stores/connection'
import { PORT_COLORS } from '../nodes/registry'

export function ConnectionLayer(): React.JSX.Element | null {
  const draft = useConnectionStore((s) => s.draft)

  if (!draft) return null

  const { startPt, pointer, from } = draft
  const color = PORT_COLORS[from.portType] ?? '#7c5cff'
  // 从出端口（起点，右侧）到指针画一条平滑贝塞尔曲线：控制点沿水平方向外扩，形成自然弧度
  const dx = Math.max(48, Math.abs(pointer.x - startPt.x) * 0.5)
  const path = `M ${startPt.x} ${startPt.y} C ${startPt.x + dx} ${startPt.y}, ${pointer.x - dx} ${pointer.y}, ${pointer.x} ${pointer.y}`

  return createPortal(
    <svg className="conn-overlay">
      <path d={path} style={{ stroke: color }} />
      <circle className="conn-start" cx={startPt.x} cy={startPt.y} r={4.5} fill={color} />
      <circle className="conn-cursor" cx={pointer.x} cy={pointer.y} r={7} fill={color} />
    </svg>,
    document.body
  )
}
