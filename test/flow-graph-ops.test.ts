// O4-P5 外部生成 FlowGraph 操作：flowGraph.validate / flowGraph.compile（只读纯函数）。
import { describe, expect, it } from 'vitest'
import { runFlowAgentOperation } from '../src/main/agent-access/flow-agents-ops'
import { FlowGraphSchema, type FlowNode } from '../src/shared/agent-flow/flow-graph'
import { canvasNodeId } from '../src/shared/agent-flow/flow-graph-compiler'

const context = {
  activeProjectId: () => null,
  diagnostics: { traceId: 'trace', spanId: 'span' }
}
const node = (nodeId: string, overrides: Partial<FlowNode> = {}): FlowNode =>
  ({
    nodeId,
    title: nodeId,
    participation: 'autonomous',
    kind: 'agent',
    goal: '完成某事',
    completion: '交付成果',
    ...overrides
  }) as FlowNode
const edge = (from: string, to: string) => ({
  from: { nodeId: from, portId: 'out-text' },
  to: { nodeId: to, portId: 'in-text' },
  kind: 'data' as const
})

const validGraph = FlowGraphSchema.parse({
  schemaVersion: 1,
  graphId: 'g',
  name: '顺序',
  goal: '总目标',
  nodes: [node('a'), node('b')],
  edges: [edge('a', 'b')],
  entry: 'a',
  exits: ['b']
})
const cycleGraph = FlowGraphSchema.parse({
  schemaVersion: 1,
  graphId: 'g',
  name: '无界环',
  goal: '总目标',
  nodes: [node('a'), node('b')],
  edges: [edge('a', 'b'), edge('b', 'a')],
  entry: 'a',
  exits: ['b']
})

describe('O4-P5 flowGraph.validate', () => {
  it('合法图 ok=true', async () => {
    const result = (await runFlowAgentOperation('flowGraph.validate', { graph: validGraph }, context)) as {
      ok: boolean
      errors: unknown[]
    }
    expect(result.ok).toBe(true)
    expect(result.errors).toEqual([])
  })
  it('无界环 ok=false 且稳定错误码', async () => {
    const result = (await runFlowAgentOperation('flowGraph.validate', { graph: cycleGraph }, context)) as {
      ok: boolean
      errors: Array<{ code: string }>
    }
    expect(result.ok).toBe(false)
    expect(result.errors.some((e) => e.code === 'CYCLE_WITHOUT_LOOP')).toBe(true)
  })
})

describe('O4-P5 flowGraph.compile', () => {
  it('合法图编译为画布图预览（含协调器与状态机）', async () => {
    const result = (await runFlowAgentOperation('flowGraph.compile', { graph: validGraph }, context)) as {
      ok: boolean
      compiled: { nodes: Array<{ id: string }>; coordinatorNodeId: string; stateNodeId: string }
    }
    expect(result.ok).toBe(true)
    expect(result.compiled.nodes.map((n) => n.id)).toEqual(
      expect.arrayContaining([canvasNodeId('a'), canvasNodeId('b'), result.compiled.coordinatorNodeId, result.compiled.stateNodeId])
    )
  })
  it('非法图 ok=false 且 compiled=null', async () => {
    const result = (await runFlowAgentOperation('flowGraph.compile', { graph: cycleGraph }, context)) as {
      ok: boolean
      compiled: unknown
    }
    expect(result.ok).toBe(false)
    expect(result.compiled).toBeNull()
  })
})