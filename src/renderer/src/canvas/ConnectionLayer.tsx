// 连线拖拽引线浮层：订阅 connection store 渲染跟手贝塞尔曲线（portal 到 body，避开画布 transform）
// 用贝塞尔曲线 + 源端口类型配色 + 流动虚线动画 + 脉冲光环，视觉精致统一
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
  // 唯一 ID 确保 gradient 引用不冲突
  const gid = 'conn-grad'

  return createPortal(
    <svg className="conn-overlay">
      <defs>
        <linearGradient id={gid} x1="0%" y1="0%" x2="100%" y2="0%">
          <stop offset="0%" stopColor={color} stopOpacity="0.9" />
          <stop offset="100%" stopColor={color} stopOpacity="0.5" />
        </linearGradient>
        <filter id="conn-glow" x="-20%" y="-20%" width="140%" height="140%">
          <feGaussianBlur stdDeviation="3" result="blur" />
          <feMerge>
            <feMergeNode in="blur" />
            <feMergeNode in="SourceGraphic" />
          </feMerge>
        </filter>
      </defs>
      {/* 外层发光底色 */}
      <path className="conn-glow-path" d={path} style={{ stroke: color }} />
      {/* 主连线：渐变 + 流动虚线 */}
      <path className="conn-main-path" d={path} style={{ stroke: color }} />
      {/* 起点指示器 */}
      <circle className="conn-start-ring" cx={startPt.x} cy={startPt.y} r={10} stroke={color} />
      <circle className="conn-start" cx={startPt.x} cy={startPt.y} r={5} fill={color} />
      {/* 跟手光标：脉冲光环 */}
      <circle className="conn-cursor-pulse" cx={pointer.x} cy={pointer.y} r={14} stroke={color} />
      <circle className="conn-cursor" cx={pointer.x} cy={pointer.y} r={7} fill={color} />
    </svg>,
    document.body
  )
}
