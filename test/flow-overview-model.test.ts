import { describe, expect, it } from 'vitest'
import type { FlowRunOverview } from '@shared/agent-flow/run-overview'
import {
  deriveFlowSteps,
  deriveNow,
  eventLabel,
  eventTone,
  flowProgress
} from '@renderer/canvas/flow-overview-model'

function overview(partial: Partial<FlowRunOverview> = {}): FlowRunOverview {
  return {
    projectId: 'p',
    nodeId: 'shape:main',
    taskId: 't',
    state: 'running',
    phase: 'working',
    revision: 3,
    goal: '材料→分析→协作整理→审核→最终资产',
    paused: false,
    executionMode: 'graph',
    graph: {
      name: '垂类贯穿图',
      entry: 'shape:analysis',
      exits: ['shape:down'],
      nodes: [
        { nodeId: 'shape:analysis', title: '分析 Agent', kind: 'agent', participation: 'autonomous' },
        { nodeId: 'shape:org', title: '协作整理 Agent', kind: 'agent', participation: 'collaborative' },
        {
          nodeId: 'shape:review',
          title: 'AI 审核',
          kind: 'review',
          participation: 'autonomous',
          review: { criteria: '必须以交付：开头', rejectPolicy: 'rework', maxReworks: 1 }
        },
        { nodeId: 'shape:down', title: '最终资产 Agent', kind: 'agent', participation: 'autonomous' }
      ],
      edges: [
        { from: 'shape:analysis', to: 'shape:org', kind: 'data' },
        { from: 'shape:org', to: 'shape:review', kind: 'data' },
        { from: 'shape:review', to: 'shape:down', kind: 'data' }
      ]
    },
    children: [
      { nodeId: 'shape:analysis', taskId: 't1', state: 'completed', goal: '分析材料' },
      { nodeId: 'shape:org', taskId: 't2', state: 'waiting', goal: '协作整理' },
      { nodeId: 'shape:down', taskId: 't3', state: 'ready', goal: '产出最终资产' }
    ],
    reviews: [{ nodeId: 'shape:review', state: 'ready', round: 0 }],
    events: [
      { eventId: 'e1', revision: 1, event: 'flow.started', state: 'working', source: 'agent' },
      { eventId: 'e2', revision: 2, event: 'agent.completed', state: 'working', source: 'agent' },
      { eventId: 'e3', revision: 3, event: 'human.wait', state: 'waiting', source: 'agent' }
    ],
    ...partial
  }
}

describe('flow overview model', () => {
  it('orders steps topologically and maps child/review states', () => {
    const steps = deriveFlowSteps(overview())
    expect(steps.map((step) => step.nodeId)).toEqual([
      'shape:analysis',
      'shape:org',
      'shape:review',
      'shape:down'
    ])
    expect(steps[0].state).toBe('completed')
    expect(steps[1].state).toBe('waiting-human')
    expect(steps[1].needsYou).toBe(true)
    expect(steps[1].roleLabel).toBe('人工协同')
    expect(steps[2].state).toBe('idle')
    // 下游被未通过的审核门禁拦截。
    expect(steps[3].state).toBe('gated')
    expect(steps[3].gatedBy).toBe('AI 审核')
  })

  it('marks rejected review as rework and keeps downstream gated', () => {
    const steps = deriveFlowSteps(
      overview({ reviews: [{ nodeId: 'shape:review', state: 'rejected', round: 1, feedback: '缺少交付：前缀' }] })
    )
    const review = steps.find((step) => step.nodeId === 'shape:review')!
    expect(review.state).toBe('rejected')
    expect(review.review?.round).toBe(1)
    expect(review.review?.maxReworks).toBe(1)
    expect(steps.find((step) => step.nodeId === 'shape:down')!.state).toBe('gated')
  })

  it('releases the gate once the review passes', () => {
    const steps = deriveFlowSteps(
      overview({ reviews: [{ nodeId: 'shape:review', state: 'passed', round: 1, passed: true }] })
    )
    expect(steps.find((step) => step.nodeId === 'shape:review')!.state).toBe('review-passed')
    expect(steps.find((step) => step.nodeId === 'shape:down')!.state).toBe('idle')
  })

  it('computes progress from completed + passed steps', () => {
    const progress = flowProgress(deriveFlowSteps(overview()))
    expect(progress.total).toBe(4)
    expect(progress.done).toBe(1)
    expect(progress.percent).toBe(25)
  })

  it('prioritizes the human wait in the NOW banner', () => {
    const data = overview()
    const now = deriveNow(data, deriveFlowSteps(data))
    expect(now.tone).toBe('human')
    expect(now.nodeId).toBe('shape:org')
    expect(now.action).toBe('collaborate')
  })

  it('falls back to sequential children order without a graph', () => {
    const data = overview({ executionMode: 'fixed-order', graph: undefined })
    const steps = deriveFlowSteps(data)
    expect(steps.map((step) => step.nodeId)).toEqual(['shape:analysis', 'shape:org', 'shape:down'])
    // 无图拓扑时缺少参与方式元数据，等待态保守呈现为"等待核对"（graph 模式才精确区分人工）。
    expect(steps[1].state).toBe('waiting-execution')
  })

  it('labels and attributes timeline events', () => {
    expect(eventLabel('review.rejected')).toBe('审核驳回')
    expect(eventLabel('human.submit')).toBe('人工操作')
    expect(eventTone('human.wait', 'agent')).toBe('human')
    expect(eventTone('review.passed', 'agent')).toBe('review')
    expect(eventTone('agent.completed', 'agent')).toBe('agent')
  })
})
it('projects router outcomes and excludes command reconciliation from the human inbox', () => {
  const steps = deriveFlowSteps(overview({
    children: [
      { nodeId: 'shape:org', taskId: 'org', state: 'waiting', goal: 'organize', waitKind: 'reconcile' }
    ],
    skippedNodeIds: ['shape:review'],
    stalledNodeIds: ['shape:down']
  }))
  const byNode = new Map(steps.map((step) => [step.nodeId, step]))
  expect(byNode.get('shape:org')).toMatchObject({ state: 'waiting-reconcile', needsYou: false })
  expect(byNode.get('shape:review')).toMatchObject({ state: 'skipped', needsYou: false })
  expect(byNode.get('shape:down')).toMatchObject({ state: 'stalled', needsYou: false })
})

it('shows what requires human action and retains a separate stalled step', () => {
  const run = overview({ stalledNodeIds: ['shape:down'], reviews: [] })
  const steps = deriveFlowSteps(run)
  expect(deriveNow(run, steps)).toMatchObject({ nodeId: 'shape:org', tone: 'human' })
  expect(steps.find((step) => step.nodeId === 'shape:down')?.state).toBe('stalled')
  const noHuman = overview({ children: [], reviews: [], stalledNodeIds: ['shape:down'], state: 'failed' })
  expect(deriveNow(noHuman, deriveFlowSteps(noHuman))).toMatchObject({
    nodeId: 'shape:down', title: expect.stringContaining('流程停滞'), action: 'locate'
  })
})
