// 连线拖拽引线浮层：订阅 connection store 渲染跟手贝塞尔曲线（portal 到 body，避开画布 transform）。
// 只在拖线时给出一次克制的类型色提示；正式连接后的视觉由 tldraw arrow 统一负责。
import { createPortal } from 'react-dom'
import { useConnectionStore } from '../stores/connection'
import { PORT_COLORS } from '../nodes/registry'

export function ConnectionLayer(): React.JSX.Element | null {
  const draft = useConnectionStore((s) => s.draft)

  if (!draft) return null

  const { startPt, pointer, from } = draft
  const color = PORT_COLORS[from.portType] ?? '#09caf5'
  // 从出端口（起点，右侧）到指针画一条平滑贝塞尔曲线：控制点沿水平方向外扩，形成自然弧度
  const dx = Math.max(48, Math.abs(pointer.x - startPt.x) * 0.5)
  const path = `M ${startPt.x} ${startPt.y} C ${startPt.x + dx} ${startPt.y}, ${pointer.x - dx} ${pointer.y}, ${pointer.x} ${pointer.y}`
  return createPortal(
    <svg className="conn-overlay">
      {/* 极弱底光仅用于把正在拖拽的连线从画布中分离出来。 */}
      <path className="conn-glow-path" d={path} style={{ stroke: color }} />
      {/* 实线跟随，避免持续流动虚线在大画布中制造噪声。 */}
      <path className="conn-main-path" d={path} style={{ stroke: color }} />
      <circle className="conn-start" cx={startPt.x} cy={startPt.y} r={5} fill={color} />
      <circle className="conn-cursor" cx={pointer.x} cy={pointer.y} r={5} fill={color} />
    </svg>,
    document.body
  )
}
