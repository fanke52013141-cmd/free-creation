// 全局搜索面板状态：CanvasPage 顶栏按钮 ↔ CanvasEditor 内搜索覆盖层
import { create } from 'zustand'

interface SearchState {
  open: boolean
  toggle: () => void
  close: () => void
}

export const useSearchStore = create<SearchState>((set) => ({
  open: false,
  toggle: (): void => set((s) => ({ open: !s.open })),
  close: (): void => set({ open: false })
}))
