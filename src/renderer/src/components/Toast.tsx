// 全局 toast 渲染层：挂在 App 根部（body 下无 transform 祖先，fixed 定位可靠）
import { useToastStore } from '../stores/toast'

export function Toast(): React.JSX.Element {
  const msg = useToastStore((s) => s.msg)
  return msg ? (
    <div className="global-toast" role="status" aria-live="polite" aria-atomic="true">
      {msg}
    </div>
  ) : (
    <></>
  )
}
