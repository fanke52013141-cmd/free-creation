import { describe, expect, it } from 'vitest'
import { FlowAgentRunSchema, FlowAgentCollaborationSchema } from '../src/shared/agent-flow/desktop-tasks'

const run = { projectId: 'p', nodeId: 'agent', requestId: 'request', traceId: 'trace', spanId: 'span', action: 'continue', expectedTaskId: 'task', expectedWaitRevision: 1, eventId: 'confirm' }
const collaboration = { projectId: 'p', nodeId: 'agent', taskId: 'task', waitRevision: 1, revision: 0, eventId: 'confirm', action: 'submit', text: 'isolated feedback', accepted: true }
const ref = { assetId: 'asset', versionId: 'v1', sourceNodeId: 'source', sourcePortId: 'out-text' }

describe('HUM-03 request identity validation before task lookup', () => {
  for (const action of ['continue', 'reconcile', 'restore']) {
    it.each(['expectedTaskId', 'expectedWaitRevision', 'eventId'])(`${action} requires %s`, (field) => {
      const input: Record<string, unknown> = { ...run, action }
      delete input[field]
      expect(FlowAgentRunSchema.safeParse(input).success).toBe(false)
    })
    it(`${action} accepts complete explicit identity`, () => {
      expect(FlowAgentRunSchema.safeParse({ ...run, action }).success).toBe(true)
    })
  }
  it.each([0, -1, 1.5])('continue rejects wait revision %s', expectedWaitRevision => {
    expect(FlowAgentRunSchema.safeParse({ ...run, expectedWaitRevision }).success).toBe(false)
  })
})
describe('SEC-02 bounded collaboration input validation', () => {
  it.each([128, 129])('identifier length=%i', length => {
    expect(FlowAgentRunSchema.safeParse({ ...run, requestId: 'x'.repeat(length) }).success).toBe(length === 128)
  })
  it.each([4096, 4097])('feedback characters=%i', length => {
    expect(FlowAgentCollaborationSchema.safeParse({ ...collaboration, text: 'x'.repeat(length) }).success).toBe(length === 4096)
  })
  it.each([128, 129])('selected output count=%i', count => {
    const selectedOutputs = Array.from({ length: count }, (_, index) => ({ ...ref, versionId: 'v' + index }))
    expect(FlowAgentCollaborationSchema.safeParse({ ...collaboration, selectedOutputs }).success).toBe(count === 128)
  })
  it('rejects duplicate output selection', () => {
    expect(FlowAgentCollaborationSchema.safeParse({ ...collaboration, selectedOutputs: [ref, ref] }).success).toBe(false)
  })
  it('rejects an undeclared nested permission payload', () => {
    expect(FlowAgentCollaborationSchema.safeParse({ ...collaboration, permissions: { shell: true, nested: { project: 'foreign' } } }).success).toBe(false)
  })
})
