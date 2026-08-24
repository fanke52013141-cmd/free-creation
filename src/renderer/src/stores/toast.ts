// 全局轻量 toast：主进程/渲染进程错误提示的统一出口
import { create } from 'zustand'

interface ToastState {
  msg: string | null
  timer: ReturnType<typeof setTimeout> | null
  show: (msg: string, ms?: number) => void
  clear: () => void
}

export const useToastStore = create<ToastState>((set, get) => ({
  msg: null,
  timer: null,
  show: (msg, ms = 2600): void => {
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

export function toast(msg: string, ms?: number): void {
  useToastStore.getState().show(msg, ms)
}
