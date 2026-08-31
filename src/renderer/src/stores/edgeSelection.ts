import { create } from 'zustand'

/**
 * 数据依赖连线不是 tldraw 白板形状：它可以被选中并断开，但不能被平移或弯折。
 * 选择状态独立保存，避免把隐藏的底层 arrow 再次交给默认选择工具。
 */
interface EdgeSelectionState {
  selectedEdgeId: string | null
  select: (id: string) => void
  clear: () => void
}

export const useEdgeSelectionStore = create<EdgeSelectionState>((set) => ({
  selectedEdgeId: null,
  select: (id) => set({ selectedEdgeId: id }),
  clear: () => set({ selectedEdgeId: null })
}))
