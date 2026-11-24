/**
 * 浮层 Esc 归属（2026-11-24 回归修复）：Radix 下拉/菜单在 document 层先关闭自己，
 * 等窗口冒泡阶段的页面快捷键再查询 `[data-state=open]` 时已经卸载——于是同一个 Esc
 * 既关了下拉、又关了外层弹窗/页面。
 *
 * 做法：弹窗外壳在**捕获阶段**看到内层浮层时先 `claimEscape()`（此时浮层仍挂载），
 * 页面级 Esc 处理器用 `consumeEscapeClaim()` 跳过本次按键。标记只对本次事件有效。
 */
let claimed = false

export function claimEscapeForPopup(): void {
  claimed = true
  // 同一事件分发内消费；下一轮事件循环自动失效，避免吞掉后续 Esc。
  setTimeout(() => {
    claimed = false
  }, 0)
}

export function consumeEscapeClaim(): boolean {
  if (!claimed) return false
  claimed = false
  return true
}
