import { create } from 'zustand'

const EMPTY_SET: ReadonlySet<string> = new Set()

export interface FlowFocusState {
  /** 当前聚光的阶段/节点 id；null 表示当前未启用单步聚光。 */
  focusedNodeId: string | null
  /** 当前聚光节点的直接上游输入节点 id 集合（聚光时保持高亮）。 */
  inputSourceIds: ReadonlySet<string>
  /** 当前等待人工处理/扭转的焦点节点 id（用于琥珀金高亮与唯一主按钮）。 */
  attentionNodeId: string | null
  /** 受主控 Agent 或审核门禁管辖的子节点 id 集合（用于隐藏冗余独立启动按钮）。 */
  controlledNodeIds: ReadonlySet<string>
  /** 聚光开关：开启时非关联节点轻度退暗。 */
  spotlightEnabled: boolean
  /** 控制关系虚线开关：默认关闭以减少画布噪音；选中节点或返工线仍按需可见。 */
  showControlRelations: boolean
  setFocusedNode: (nodeId: string | null, inputSourceIds?: ReadonlySet<string>) => void
  setFlowContext: (ctx: {
    attentionNodeId: string | null
    controlledNodeIds: ReadonlySet<string>
  }) => void
  toggleSpotlight: () => void
  toggleControlRelations: () => void
  reset: () => void
}

function sameSet(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
  if (a.size !== b.size) return false
  for (const item of a) {
    if (!b.has(item)) return false
  }
  return true
}

export const useFlowFocusStore = create<FlowFocusState>((set) => ({
  focusedNodeId: null,
  inputSourceIds: EMPTY_SET,
  attentionNodeId: null,
  controlledNodeIds: EMPTY_SET,
  spotlightEnabled: true,
  showControlRelations: false,
  setFocusedNode: (nodeId, inputSourceIds = EMPTY_SET) =>
    set((state) => {
      if (state.focusedNodeId === nodeId && sameSet(state.inputSourceIds, inputSourceIds)) {
        return state
      }
      return { focusedNodeId: nodeId, inputSourceIds }
    }),
  setFlowContext: ({ attentionNodeId, controlledNodeIds }) =>
    set((state) => {
      if (
        state.attentionNodeId === attentionNodeId &&
        sameSet(state.controlledNodeIds, controlledNodeIds)
      ) {
        return state
      }
      return { attentionNodeId, controlledNodeIds }
    }),
  toggleSpotlight: () => set((state) => ({ spotlightEnabled: !state.spotlightEnabled })),
  toggleControlRelations: () =>
    set((state) => ({ showControlRelations: !state.showControlRelations })),
  reset: () =>
    set({
      focusedNodeId: null,
      inputSourceIds: EMPTY_SET,
      attentionNodeId: null,
      controlledNodeIds: EMPTY_SET
    })
}))
