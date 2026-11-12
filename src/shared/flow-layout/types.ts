/**
 * 拓扑感知画布布局（agent flow 优化 L1）：纯函数，无 tldraw/Electron 依赖。
 * GUI 智能整理、graph.layout op、graph.patch autoLayout、内置构建器共用同一实现，
 * 满足三入口 parity；只产出坐标，不读取或修改任何业务配置。
 */

export interface LayoutNode {
  id: string
  /** node-card 的 nodeType（text/processor/agent/state-machine/ai-review/...） */
  type: string
  x: number
  y: number
  w: number
  h: number
  title: string
  /** agent 角色（config.role）；非 agent 或缺省为 undefined */
  role?: 'builder' | 'coordinator' | 'specialist'
  /** 控制目标：agent 的 allowedNodeIds、ai-review 的 gatedNodeIds（只读派生） */
  controls?: string[]
}

/** 节点级数据边（布局不关心端口） */
export interface LayoutEdge {
  from: string
  to: string
}

export type LayoutMode = 'auto' | 'flow' | 'lanes' | 'grid'
export type ResolvedLayoutMode = 'flow' | 'lanes' | 'grid'
export type LaneId = 'control' | 'execution' | 'output' | 'review' | 'none'

export interface LayoutOptions {
  /** 列间距（flow 分层列之间 / lanes 带内水平间距），默认 120 */
  columnGap?: number
  /** 行间距（层内节点之间 / lanes 带内垂直间距），默认 80 */
  rowGap?: number
  /** 输出包围盒左上角；缺省保持输入包围盒左上角（画布原位附近） */
  origin?: { x: number; y: number }
}

export interface LayoutResult {
  mode: ResolvedLayoutMode
  positions: Array<{ id: string; x: number; y: number }>
  /** 验收/诊断：flow 分层 rank（lanes 模式为成果带子图 rank，其余 0） */
  ranks: Record<string, number>
  /** 验收/诊断：泳道归属（非 lanes 模式全为 none） */
  lanes: Record<string, LaneId>
}

export const FLOW_LAYOUT_DEFAULTS = {
  columnGap: 120,
  rowGap: 80,
  /** lanes 带间距 = rowGap * 1.5 */
  bandGapFactor: 1.5
} as const