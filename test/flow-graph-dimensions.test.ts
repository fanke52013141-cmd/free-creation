import { describe, expect, it } from 'vitest'
import { FlowGraphSchema, FlowNodeSchema, resolveFlowNodeDimensions } from '../src/shared/agent-flow/flow-graph'
import type { FlowNode } from '../src/shared/agent-flow/flow-graph'

const baseNode = (overrides: Record<string, unknown> = {}): unknown => ({
  nodeId: 'n1',
  title: 'Node',
  participation: 'autonomous',
  kind: 'agent',
  goal: '完成某事',
  completion: '交付成果',
  ...overrides
})

const resolve = (input: unknown): ReturnType<typeof resolveFlowNodeDimensions> =>
  resolveFlowNodeDimensions(FlowNodeSchema.parse(input) as FlowNode)

describe('BL-21 / AF-9.3 执行者 × 决策者', () => {
  it('旧图按 participation 自动映射，行为不变', () => {
    expect(resolve(baseNode())).toEqual({ executor: 'ai', decider: 'none' })
    expect(
      resolve(
        baseNode({
          participation: 'collaborative',
          decisions: { allowed: ['approve'] }
        })
      )
    ).toEqual({ executor: 'mixed', decider: 'human' })
    expect(
      resolve(baseNode({ participation: 'human', kind: 'human-task' }))
    ).toEqual({ executor: 'human', decider: 'none' })
    expect(
      resolve(baseNode({ kind: 'review', review: { criteria: '标准', maxReworks: 3 } }))
    ).toEqual({ executor: 'ai', decider: 'ai-review' })
  })

  it('capability 可显式声明 decider human（AI 产出、人采用），无需 Agent 包装', () => {
    const node = FlowNodeSchema.parse(
      baseNode({
        kind: 'capability',
        capabilityRef: { kind: 'node', id: 'text-pass', version: '1' },
        decider: 'human'
      })
    )
    expect(resolveFlowNodeDimensions(node)).toEqual({ executor: 'ai', decider: 'human' })
    // 也可以在 capability 上显式写 executor: ai（与缺省一致）。
    const explicit = resolve(
      baseNode({
        kind: 'capability',
        capabilityRef: { kind: 'node', id: 'text-pass', version: '1' },
        executor: 'ai',
        decider: 'human'
      })
    )
    expect(explicit).toEqual({ executor: 'ai', decider: 'human' })
  })

  it('拒绝非法组合：capability 人工执行 / AI 审核、agent 与参与方式不一致等', () => {
    const invalid: unknown[] = [
      baseNode({
        kind: 'capability',
        capabilityRef: { kind: 'node', id: 'text-pass', version: '1' },
        executor: 'human'
      }),
      baseNode({
        kind: 'capability',
        capabilityRef: { kind: 'node', id: 'text-pass', version: '1' },
        decider: 'ai-review'
      }),
      baseNode({ executor: 'mixed' }),
      baseNode({ decider: 'human' }),
      baseNode({ participation: 'human', kind: 'human-task', decider: 'human' }),
      baseNode({ kind: 'review', review: { criteria: '标准', maxReworks: 3 }, decider: 'none' })
    ]
    for (const value of invalid) {
      expect(FlowNodeSchema.safeParse(value).success).toBe(false)
    }
  })

  it('含 decider human 的 capability 图通过 FlowGraph 解析', () => {
    const graph = {
      schemaVersion: 1,
      graphId: 'bl21',
      name: '人采用',
      goal: 'AI 产出、人采用',
      nodes: [
        baseNode({
          nodeId: 'cap',
          kind: 'capability',
          capabilityRef: { kind: 'node', id: 'text-pass', version: '1' },
          decider: 'human',
          goal: '产出候选',
          completion: '交付候选'
        })
      ],
      edges: [],
      entry: 'cap',
      exits: ['cap']
    }
    const parsed = FlowGraphSchema.safeParse(graph)
    expect(parsed.success).toBe(true)
  })
})