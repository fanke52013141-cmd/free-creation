// 右侧节点面板开关（全局状态，统一管理契约信息窗与对话聊天面板）
//
// 改造前：单选节点 → 右侧自动弹出面板（契约窗或聊天面板）。选中与查看耦合，
// 且「画布选中」与「面板图标」交互易打架。
// 改造后：单击节点只负责选中；节点右上角的 info 图标点击后显式 open 本 store，
// 右侧面板据此打开。对话节点打开聊天面板，其余节点打开契约信息窗；二者互斥共用
// 右侧区域，同一时刻至多显示一个。
import { create } from 'zustand'
import type { TLShapeId } from 'tldraw'

export type NodePanelKind = 'chat' | 'contract'

interface NodePanelState {
  /** 当前打开的面板类型；null 表示关闭。 */
  kind: NodePanelKind | null
  /** 打开面板的目标节点 id。 */
  shapeId: TLShapeId | null
  /** 打开（或切换）到某个节点的指定面板。 */
  open: (kind: NodePanelKind, shapeId: TLShapeId) => void
  /** 关闭面板。 */
  close: () => void
}

export const useNodePanelStore = create<NodePanelState>((set) => ({
  kind: null,
  shapeId: null,
  open: (kind, shapeId) => set({ kind, shapeId }),
  close: () => set({ kind: null, shapeId: null })
}))
