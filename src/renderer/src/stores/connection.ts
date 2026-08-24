// 连线拖拽草稿（跨组件共享）：输出端口按下开始，拖拽层跟随指针，松手完成
import { create } from 'zustand'
import type { TLShapeId } from 'tldraw'
import type { PortType } from '@shared/types'

export interface ConnectionFrom {
  shapeId: TLShapeId
  portId: string
  portType: PortType
}

export interface Pt {
  x: number
  y: number
}

interface ConnectionState {
  draft: { from: ConnectionFrom; startPt: Pt; pointer: Pt } | null
  start: (from: ConnectionFrom, pt: Pt) => void
  move: (pt: Pt) => void
  clear: () => void
}

export const useConnectionStore = create<ConnectionState>((set) => ({
  draft: null,
  start: (from, pt) => set({ draft: { from, startPt: pt, pointer: pt } }),
  move: (pt) => set((s) => (s.draft ? { draft: { ...s.draft, pointer: pt } } : s)),
  clear: () => set({ draft: null })
}))
