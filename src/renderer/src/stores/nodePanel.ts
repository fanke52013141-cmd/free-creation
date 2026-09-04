// 右侧节点面板开关（全局状态，统一管理契约信息窗与对话聊天面板）
//
// 改造前：单选节点 → 右侧自动弹出面板（契约窗或聊天面板）。选中与查看耦合，
// 且「画布选中」与「面板图标」交互易打架。
// 改造后：单击节点只负责选中；节点右上角的 info 图标点击后显式 open 本 store，
// 右侧面板据此打开。对话节点打开聊天面板，其余节点打开契约信息窗；二者互斥共用
// 右侧区域，同一时刻至多显示一个。
import { create } from 'zustand'
import type { TLShapeId } from 'tldraw'

export type NodePanelKind = 'chat' | 'contract' | 'director'

/** 契约面板的初始 tab：配置类入口直达「设置」，说明入口停留在「概览」。 */
export type NodePanelInitialTab = 'overview' | 'settings'

interface NodePanelState {
  /** 当前打开的面板类型；null 表示关闭。 */
  kind: NodePanelKind | null
  /** 打开面板的目标节点 id。 */
  shapeId: TLShapeId | null
  /** 本次打开面板时契约面板应定位的初始 tab（仅对 contract 生效）。 */
  initialTab: NodePanelInitialTab
  /** 打开（或切换）到某个节点的指定面板。 */
  open: (kind: NodePanelKind, shapeId: TLShapeId, initialTab?: NodePanelInitialTab) => void
  /** 关闭面板。 */
  close: () => void
}

export const useNodePanelStore = create<NodePanelState>((set) => ({
  kind: null,
  shapeId: null,
  initialTab: 'overview',
  open: (kind, shapeId, initialTab = 'overview') => set({ kind, shapeId, initialTab }),
  close: () => set({ kind: null, shapeId: null, initialTab: 'overview' })
}))
