import { describe, expect, it } from 'vitest'
import {
  AgentNodeConfigSchema,
  StateMachineNodeConfigSchema,
  ReviewDecisionSchema,
  DEFAULT_AGENT_NODE_CONFIG,
  DEFAULT_REVIEW_NODE_CONFIG,
  DEFAULT_STATE_NODE_CONFIG,
  matchesReviewApproval
} from '../src/shared/agent-flow/node-contracts'

const subject = {
  assetId: 'asset',
  versionId: 'v1',
  sourceNodeId: 'producer',
  sourcePortId: 'out-text'
}
const report = {
  schemaVersion: 1,
  reviewId: 'review-1',
  cycleId: 'cycle-1',
  reviewNodeId: 'review',
  reviewRevision: 1,
  rulesVersion: 'rules-1',
  subjects: [subject],
  passed: true,
  feedback: 'Accepted',
  evidenceScope: 'complete-text-json',
  issues: []
}
const expected = {
  reviewNodeId: 'review',
  reviewRevision: 1,
  rulesVersion: 'rules-1',
  subjects: [subject]
}
describe('C1 Agent Flow protocol foundation', () => {
  it.each(['duplicate-state', 'missing-initial', 'unknown-from', 'unknown-to', 'ambiguous-event'])('COO-03 rejects %s state declarations', variant => {
    const config = { ...DEFAULT_STATE_NODE_CONFIG, states: ['draft', 'working', 'completed'], transitions: [{ from: 'draft', event: 'start', to: 'working' }] }
    if (variant === 'duplicate-state') config.states.push('draft')
    if (variant === 'missing-initial') config.states = ['working', 'completed']
    if (variant === 'unknown-from') config.transitions[0].from = 'missing'
    if (variant === 'unknown-to') config.transitions[0].to = 'missing'
    if (variant === 'ambiguous-event') config.transitions.push({ from: 'draft', event: 'start', to: 'completed' })
    expect(StateMachineNodeConfigSchema.safeParse(config).success).toBe(false)
  })
  it.each([1, 64, 65])('COO-03 state count boundary=%i', count => {
    const states = Array.from({ length: count }, (_, index) => 'state-' + index)
    expect(StateMachineNodeConfigSchema.safeParse({ ...DEFAULT_STATE_NODE_CONFIG, initialState: states[0], states, transitions: [] }).success).toBe(count <= 64)
  })
  it('COO-03 permits one event name in different source states without ambiguity', () => {
    expect(StateMachineNodeConfigSchema.safeParse({ ...DEFAULT_STATE_NODE_CONFIG, states: ['draft', 'working', 'completed'], transitions: [{ from: 'draft', event: 'advance', to: 'working' }, { from: 'working', event: 'advance', to: 'completed' }] }).success).toBe(true)
  })
  it.each(['assetId', 'versionId', 'sourceNodeId', 'sourcePortId'] as const)('REV-03 rejects approved subject replacement at %s', (field) => {
    expect(matchesReviewApproval(report, expected)).toBe(true)
    expect(matchesReviewApproval(report, { ...expected, subjects: [{ ...subject, [field]: 'replacement' }] })).toBe(false)
  })
  it('persists versioned config without task text, keys or implicit tool permission', () => {
    const config = {
      ...DEFAULT_AGENT_NODE_CONFIG,
      role: 'coordinator',
      interactionMode: 'autonomous',
      skills: [{ id: 'writing', version: 'v1' }],
      tools: [{ id: 'execute-node', version: 'v1' }],
      allowedNodeIds: ['producer'],
      relations: [
        { relationId: 'control', kind: 'controls', sourceNodeId: 'agent', targetNodeId: 'producer' }
      ]
    }
    expect(AgentNodeConfigSchema.parse(JSON.parse(JSON.stringify(config)))).toEqual(config)
    expect(AgentNodeConfigSchema.safeParse({ ...config, apiKey: 'secret' }).success).toBe(false)
    expect(AgentNodeConfigSchema.safeParse({ ...config, role: 'human' }).success).toBe(false)
    expect(DEFAULT_REVIEW_NODE_CONFIG.maxReworks).toBe(3)
  })
  it('rejects nondeterministic and dangling state transitions', () => {
    const transition = { from: 'draft', event: 'start', to: 'working' }
    expect(
      StateMachineNodeConfigSchema.safeParse({
        ...DEFAULT_STATE_NODE_CONFIG,
        transitions: [transition]
      }).success
    ).toBe(true)
    expect(
      StateMachineNodeConfigSchema.safeParse({
        ...DEFAULT_STATE_NODE_CONFIG,
        transitions: [transition, transition]
      }).success
    ).toBe(false)
    expect(
      StateMachineNodeConfigSchema.safeParse({
        ...DEFAULT_STATE_NODE_CONFIG,
        initialState: 'missing'
      }).success
    ).toBe(false)
    expect(
      StateMachineNodeConfigSchema.safeParse({
        ...DEFAULT_STATE_NODE_CONFIG,
        transitions: [{ ...transition, to: 'missing' }]
      }).success
    ).toBe(false)
  })
  it('does not release another asset version, changed rules or a late revision', () => {
    expect(matchesReviewApproval(report, expected)).toBe(true)
    expect(
      matchesReviewApproval(report, { ...expected, subjects: [{ ...subject, versionId: 'v2' }] })
    ).toBe(false)
    expect(matchesReviewApproval(report, { ...expected, rulesVersion: 'rules-2' })).toBe(false)
    expect(matchesReviewApproval(report, { ...expected, reviewRevision: 2 })).toBe(false)
    expect(matchesReviewApproval({ ...report, passed: false }, expected)).toBe(false)
    expect(matchesReviewApproval({ ...report, evidenceScope: 'sampled' }, expected)).toBe(false)
    expect(matchesReviewApproval({ error: 'network failed' }, expected)).toBe(false)
  })
  it('rejects duplicate subjects and feedback attributed to an unreviewed version', () => {
    expect(
      ReviewDecisionSchema.safeParse({ ...report, subjects: [subject, subject] }).success
    ).toBe(false)
    expect(
      ReviewDecisionSchema.safeParse({
        ...report,
        issues: [{ assetId: 'asset', versionId: 'v2', feedback: 'Bad' }]
      }).success
    ).toBe(false)
  })
})
