// 连线拖拽引线浮层：订阅 connection store 渲染跟手贝塞尔曲线（portal 到 body，避开画布 transform）。
// 只在拖线时给出一次克制的类型色提示；正式连接后的视觉由 tldraw arrow 统一负责。
import { createPortal } from 'react-dom'
import { useConnectionStore } from '../stores/connection'
import { PORT_COLORS } from '../nodes/registry'
import { buildDataEdgePath } from './edge-geometry'

export function ConnectionLayer(): React.JSX.Element | null {
  const draft = useConnectionStore((s) => s.draft)

  if (!draft) return null

  const { startPt, pointer, from } = draft
  const color = PORT_COLORS[from.portType] ?? '#09caf5'
  // 与正式连线使用同一套比例几何，拖拽预览在反向拖动时也不会翻折成 S 型。
  const path = buildDataEdgePath(startPt, pointer)
  return createPortal(
    <svg className="conn-overlay">
      <defs>
        {/* 镜面玻璃珠：左上高光 → 透光 → 右下暗缘，叠加在端口色底上 */}
        <radialGradient id="conn-cursor-glass" cx="0.32" cy="0.28" r="0.95">
          <stop offset="0" stopColor="#ffffff" stopOpacity="0.95" />
          <stop offset="0.3" stopColor="#ffffff" stopOpacity="0.32" />
          <stop offset="0.65" stopColor="#ffffff" stopOpacity="0.05" />
          <stop offset="1" stopColor="#0b1016" stopOpacity="0.3" />
        </radialGradient>
      </defs>
      {/* 极弱底光仅用于把正在拖拽的连线从画布中分离出来。 */}
      <path className="conn-glow-path" d={path} style={{ stroke: color }} />
      {/* 实线跟随，避免持续流动虚线在大画布中制造噪声。 */}
      <path className="conn-main-path" d={path} style={{ stroke: color }} />
      <circle className="conn-start" cx={startPt.x} cy={startPt.y} r={5} fill={color} />
      <circle className="conn-cursor" cx={pointer.x} cy={pointer.y} r={6.5} fill={color} />
      <circle
        className="conn-cursor-glass"
        cx={pointer.x}
        cy={pointer.y}
        r={6.5}
        fill="url(#conn-cursor-glass)"
      />
    </svg>,
    document.body
  )
}
