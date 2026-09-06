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

/** 契约面板的初始 tab：节点详情默认从可编辑的「设置」开始。 */
export type NodePanelInitialTab = 'overview' | 'settings'

interface NodePanelState {
  /** 当前打开的面板类型；null 表示关闭。 */
  kind: NodePanelKind | null
  /** 打开面板的目标节点 id。 */
  shapeId: TLShapeId | null
  /** 本次打开面板时契约面板应定位的初始 tab（仅对 contract 生效）。 */
  initialTab: NodePanelInitialTab
  /**
   * 每次 open 递增的请求版本。open 的参数可能与上次完全相同（重复点击同一节点
   * 的说明按钮），订阅方需要据此感知「又发生了一次打开请求」，用于与运行中心等
   * 互斥面板收口（QA-NODE-AUDIT-2026-09-06 P1-2）。
   */
  openVersion: number
  /** 打开（或切换）到某个节点的指定面板。 */
  open: (kind: NodePanelKind, shapeId: TLShapeId, initialTab?: NodePanelInitialTab) => void
  /** 关闭面板。 */
  close: () => void
}

export const useNodePanelStore = create<NodePanelState>((set) => ({
  kind: null,
  shapeId: null,
  initialTab: 'settings',
  openVersion: 0,
  open: (kind, shapeId, initialTab = 'settings') =>
    set((s) => ({ kind, shapeId, initialTab, openVersion: s.openVersion + 1 })),
  close: () => set({ kind: null, shapeId: null, initialTab: 'settings' })
}))
