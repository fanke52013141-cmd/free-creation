import { describe, expect, it } from 'vitest'
import {
  FlowStageSchema,
  FlowStagesSchema,
  StageConditionSchema,
  evaluateStageEntry,
  type StageEntryFacts
} from '../src/shared/agent-flow/stage-contracts'
import { AgentNodeConfigSchema } from '../src/shared/agent-flow/node-contracts'

const stage = (over: Record<string, unknown> = {}) =>
  FlowStageSchema.parse({
    stageKey: 'organize',
    nodeId: 'specialist-a',
    goal: '整理材料',
    completion: '产出证据表',
    ...over
  })

const facts = (over: Partial<StageEntryFacts> = {}): StageEntryFacts => ({
  deliveries: [
    {
      stageKey: 'organize',
      nodeId: 'specialist-a',
      outputs: [{ kind: 'json', data: { evidence: [{ src: 'a' }], count: 2 } }],
      humanDecided: false
    }
  ],
  reviews: [],
  ...over
})

describe('AF-01 阶段契约 Schema', () => {
  it('默认值：requireHumanDecision=false、entry=[]', () => {
    const parsed = stage()
    expect(parsed.requireHumanDecision).toBe(false)
    expect(parsed.entry).toEqual([])
  })

  it('阶段键与承载节点必须唯一', () => {
    expect(FlowStagesSchema.safeParse([stage(), stage({ nodeId: 'specialist-b' })]).success).toBe(
      false
    )
    expect(
      FlowStagesSchema.safeParse([stage(), stage({ stageKey: 'other', nodeId: 'specialist-b' })])
        .success
    ).toBe(true)
  })

  it('进入条件只能引用已声明阶段', () => {
    expect(
      FlowStagesSchema.safeParse([
        stage({
          entry: [{ kind: 'output-field', stageKey: 'ghost', path: 'x', op: 'exists' }]
        })
      ]).success
    ).toBe(false)
  })

  it('equals 必须带 value；type 必须带 valueType', () => {
    expect(
      StageConditionSchema.safeParse({
        kind: 'output-field',
        stageKey: 's',
        path: 'x',
        op: 'equals'
      }).success
    ).toBe(false)
    expect(
      StageConditionSchema.safeParse({ kind: 'output-field', stageKey: 's', path: 'x', op: 'type' })
        .success
    ).toBe(false)
  })

  it('主控配置：fixed-order 必须带 stages 且承载节点在授权范围内', () => {
    const base = {
      schemaVersion: 1,
      role: 'coordinator',
      interactionMode: 'autonomous',
      skills: [],
      tools: [{ id: 'agent.dispatch', version: '1' }],
      allowedNodeIds: ['specialist-a'],
      maxSteps: 8,
      relations: []
    }
    expect(AgentNodeConfigSchema.safeParse({ ...base, executionMode: 'fixed-order' }).success).toBe(
      false
    )
    expect(
      AgentNodeConfigSchema.safeParse({
        ...base,
        executionMode: 'fixed-order',
        stages: [stage()]
      }).success
    ).toBe(true)
    // 承载节点不在 allowedNodeIds → 拒绝
    expect(
      AgentNodeConfigSchema.safeParse({
        ...base,
        executionMode: 'fixed-order',
        stages: [stage({ nodeId: 'outside' })]
      }).success
    ).toBe(false)
    // 旧语义（无 executionMode）不受影响；stages 不能脱离 fixed-order
    expect(AgentNodeConfigSchema.safeParse(base).success).toBe(true)
    expect(AgentNodeConfigSchema.safeParse({ ...base, stages: [stage()] }).success).toBe(false)
    // fixed-order 不允许并行
    expect(
      AgentNodeConfigSchema.safeParse({
        ...base,
        executionMode: 'fixed-order',
        maxParallelTasks: 2,
        stages: [stage()]
      }).success
    ).toBe(false)
  })
})

describe('AF-01 进入条件解释器', () => {
  it('无条件 → 通过', () => {
    expect(evaluateStageEntry(stage(), facts())).toEqual({ ok: true })
  })

  it('output-field exists/equals/type 按 JSON 路径求值', () => {
    const withEntry = (entry: unknown[]) => stage({ entry })
    expect(
      evaluateStageEntry(
        withEntry([{ kind: 'output-field', stageKey: 'organize', path: 'evidence', op: 'exists' }]),
        facts()
      ).ok
    ).toBe(true)
    expect(
      evaluateStageEntry(
        withEntry([
          { kind: 'output-field', stageKey: 'organize', path: 'count', op: 'equals', value: 2 }
        ]),
        facts()
      ).ok
    ).toBe(true)
    expect(
      evaluateStageEntry(
        withEntry([
          { kind: 'output-field', stageKey: 'organize', path: 'count', op: 'equals', value: 3 }
        ]),
        facts()
      ).ok
    ).toBe(false)
    expect(
      evaluateStageEntry(
        withEntry([
          {
            kind: 'output-field',
            stageKey: 'organize',
            path: 'evidence',
            op: 'type',
            valueType: 'array'
          }
        ]),
        facts()
      ).ok
    ).toBe(true)
    expect(
      evaluateStageEntry(
        withEntry([
          {
            kind: 'output-field',
            stageKey: 'organize',
            path: 'evidence.0.src',
            op: 'equals',
            value: 'a'
          }
        ]),
        facts()
      ).ok
    ).toBe(true)
  })

  it('文本交付的根为 { text }', () => {
    const textFacts = facts({
      deliveries: [
        {
          stageKey: 'organize',
          nodeId: 'specialist-a',
          outputs: [{ kind: 'text', text: '成稿' }],
          humanDecided: false
        }
      ]
    })
    expect(
      evaluateStageEntry(
        stage({
          entry: [{ kind: 'output-field', stageKey: 'organize', path: 'text', op: 'exists' }]
        }),
        textFacts
      ).ok
    ).toBe(true)
  })

  it('missing 与 output-count', () => {
    expect(
      evaluateStageEntry(
        stage({
          entry: [{ kind: 'output-field', stageKey: 'organize', path: 'absent', op: 'missing' }]
        }),
        facts()
      ).ok
    ).toBe(true)
    expect(
      evaluateStageEntry(
        stage({ entry: [{ kind: 'output-count', stageKey: 'organize', op: 'gte', count: 1 }] }),
        facts()
      ).ok
    ).toBe(true)
    expect(
      evaluateStageEntry(
        stage({ entry: [{ kind: 'output-count', stageKey: 'organize', op: 'gte', count: 2 }] }),
        facts()
      ).ok
    ).toBe(false)
  })

  it('human-decision 与 review-passed 缺项给出稳定原因', () => {
    const human = evaluateStageEntry(
      stage({ entry: [{ kind: 'human-decision', stageKey: 'organize' }] }),
      facts()
    )
    expect(human.ok).toBe(false)
    if (!human.ok) expect(human.reasons[0].code).toBe('STAGE_ENTRY_HUMAN_DECISION_MISSING')
    expect(
      evaluateStageEntry(
        stage({ entry: [{ kind: 'human-decision', stageKey: 'organize' }] }),
        facts({
          deliveries: [
            { stageKey: 'organize', nodeId: 'specialist-a', outputs: [], humanDecided: true }
          ]
        })
      ).ok
    ).toBe(true)
    const review = evaluateStageEntry(
      stage({ entry: [{ kind: 'review-passed', reviewNodeId: 'review-1' }] }),
      facts()
    )
    expect(review.ok).toBe(false)
    if (!review.ok) expect(review.reasons[0].code).toBe('STAGE_ENTRY_REVIEW_NOT_PASSED')
    expect(
      evaluateStageEntry(
        stage({ entry: [{ kind: 'review-passed', reviewNodeId: 'review-1' }] }),
        facts({ reviews: [{ nodeId: 'review-1', state: 'passed' }] })
      ).ok
    ).toBe(true)
  })

  it('未交付阶段 → DELIVERY_MISSING，不静默放行', () => {
    const result = evaluateStageEntry(
      stage({ entry: [{ kind: 'output-field', stageKey: 'organize', path: 'x', op: 'exists' }] }),
      { deliveries: [], reviews: [] }
    )
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reasons[0].code).toBe('STAGE_ENTRY_DELIVERY_MISSING')
  })
})
