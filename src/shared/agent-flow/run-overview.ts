import type { FlowAgentView } from './desktop-tasks'

/**
 * O3 / 流程总览：流程运行的统一只读投影（非权威实体）。
 * 由 CoordinationStore.overview 生成，GUI / CLI / MCP 三入口共用同一形状。
 * graph 为声明式图拓扑（节点身份 + 边 + 入口/出口），reviews 为审核门禁状态，
 * events 为可回放协调事件时间线（human.* 归因 user，其余可信事件归因 agent）。
 */
export interface FlowRunOverview {
  projectId: string
  nodeId: string
  taskId: string
  state: FlowAgentView['state']
  phase: string
  revision: number
  goal: string
  paused: boolean
  code?: string
  executionMode: 'model' | 'fixed-order' | 'graph'
  graph?: {
    name: string
    entry: string
    exits: string[]
    nodes: Array<{
      nodeId: string
      title: string
      kind: string
      participation: string
      review?: { criteria: string; rejectPolicy: string; maxReworks: number }
    }>
    edges: Array<{ from: string; to: string; kind: string }>
  }
  children: Array<{ nodeId: string; taskId: string; state: string; goal: string }>
  reviews: Array<{
    nodeId: string
    state: string
    round: number
    responsibleNodeId?: string
    passed?: boolean
    feedback?: string
  }>
  events: Array<{
    eventId: string
    revision: number
    event: string
    state: string
    source: 'user' | 'agent'
  }>
}