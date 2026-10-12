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
