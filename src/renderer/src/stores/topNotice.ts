// 全局顶部提示：保存/发布等操作反馈统一出现在窗口顶部（用户裁决 2026-11-16）。
// 与 toast 同一套计时清理语义；全屏节点流编辑退出后提示仍可见。
import { create } from 'zustand'

interface TopNoticeState {
  msg: string | null
  timer: ReturnType<typeof setTimeout> | null
  show: (msg: string, ms?: number) => void
  clear: () => void
}

export const useTopNoticeStore = create<TopNoticeState>((set, get) => ({
  msg: null,
  timer: null,
  show: (msg, ms = 3200): void => {
    const { timer } = get()
    if (timer) clearTimeout(timer)
    set({
      msg,
      timer: setTimeout(() => {
        // 只清自己这条，避免旧计时器误清新消息
        set((s) => (s.msg === msg ? { msg: null, timer: null } : s))
      }, ms)
    })
  },
  clear: (): void => {
    const { timer } = get()
    if (timer) clearTimeout(timer)
    set({ msg: null, timer: null })
  }
}))

export function topNotice(msg: string, ms?: number): void {
  useTopNoticeStore.getState().show(msg, ms)
}