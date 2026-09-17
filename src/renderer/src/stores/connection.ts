// 连线拖拽草稿（跨组件共享）：输出端口按下开始，拖拽层跟随指针，松手完成
import { create } from 'zustand'
import type { TLShapeId } from 'tldraw'
import type { PortSchemaRef, PortType } from '@shared/types'

export interface ConnectionFrom {
  shapeId: TLShapeId
  portId: string
  portType: PortType
  schema?: PortSchemaRef
  /**
   * 拖拽方向：缺省 'out'（从输出端口拖出，落点是目标输入）；
   * 'in' 表示从输入端口反向拖出，落点应是某个上游输出。
   * 建出的边永远保持 out→in 数据流方向，反向只影响找端口的解析方式。
   */
  direction?: 'out' | 'in'
  /** 多选资产以一个临时“共有输出”拖出时，包含全部实际源节点。 */
  memberIds?: TLShapeId[]
  /**
   * 异构多选的显式来源端口。
   *
   * 这不是一个“联合 any 输出”：每一项都保留其实际节点、端口、类型和 JSON
   * Schema，落到目标时必须逐项映射至真实兼容输入端口。仅同构批量可省略本字段，
   * 继续沿用 `portId` + `memberIds` 的既有语义。
   */
  memberPorts?: BatchConnectionMember[]
}

export interface BatchConnectionMember {
  shapeId: TLShapeId
  portId: string
  portType: PortType
  schema?: PortSchemaRef
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
