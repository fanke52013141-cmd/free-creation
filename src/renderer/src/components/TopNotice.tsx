// 全局顶部提示渲染层：挂在 App 根部，fixed 定位覆盖主画布与全屏编辑顶栏区域。
import { useTopNoticeStore } from '../stores/topNotice'
import { Icon } from './Icon'

export function TopNotice(): React.JSX.Element {
  const msg = useTopNoticeStore((s) => s.msg)
  return msg ? (
    <div className="global-top-notice" role="status" aria-live="polite" aria-atomic="true">
      <Icon name="check" size={14} />
      <span>{msg}</span>
    </div>
  ) : (
    <></>
  )
}