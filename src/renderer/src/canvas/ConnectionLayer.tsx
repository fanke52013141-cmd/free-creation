// 连线拖拽引线浮层：订阅 connection store 渲染跟手虚线（portal 到 body，避开画布 transform）
import { createPortal } from 'react-dom'
import { useConnectionStore } from '../stores/connection'

export function ConnectionLayer(): React.JSX.Element | null {
  const draft = useConnectionStore((s) => s.draft)

  if (!draft) return null

  return createPortal(
    <svg className="conn-overlay">
      <line x1={draft.startPt.x} y1={draft.startPt.y} x2={draft.pointer.x} y2={draft.pointer.y} />
      <circle cx={draft.pointer.x} cy={draft.pointer.y} r={5} />
    </svg>,
    document.body
  )
}
