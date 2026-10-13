import { afterEach, describe, expect, it } from 'vitest'
import Database from 'better-sqlite3'
import { migrateDatabase } from '../src/main/store/db-migrations'
import { FlowReviewHost } from '../src/main/agent-flow/review-host'
import { FlowReviewStore } from '../src/main/agent-flow/review-store'
import { FlowCommandLedger } from '../src/main/agent-flow/command-ledger'
import { FlowAssetStore } from '../src/main/agent-flow/asset-store'
import type { ProjectFile } from '../src/shared/types'
import type { AgentModelPort } from '../src/main/agent-flow/runtime'
import type { ReviewModelVerdict } from '../src/shared/agent-flow/review'
import { projectReviewOutputs } from '../src/shared/agent-flow/review'
const databases: Database.Database[] = []
afterEach(() => databases.splice(0).forEach((db) => db.close()))
const request = {
  projectId: 'p',
  nodeId: 'review',
  requestId: 'first',
  traceId: 'trace',
  spanId: 'span'
}
function fixture(
  options: {
    verdict?: ReviewModelVerdict
    maxReworks?: number
    stop?: boolean
    error?: boolean
  } = {}
) {
  const db = new Database(':memory:')
  databases.push(db)
  migrateDatabase(db)
  db.prepare('INSERT INTO projects(id,name,created_at,updated_at) VALUES (?,?,0,0)').run(
    'p',
    'isolated'
  )
  const shape = (id: string, type: string, text = '', config: object = {}) => ({
    id,
    type: 'node-card',
    props: {
      nodeType: type,
      title: id,
      text,
      config: JSON.stringify(config),
      mediaId: '',
      mediaPath: '',
      mediaMime: ''
    },
    meta: {} as Record<string, unknown>
  })
  const store = {
    text: shape('text', 'text', 'private-review-material'),
    target: shape('target', 'processor'),
    review: shape('review', 'ai-review', '必须包含完整交付标题', {
      schemaVersion: 1,
      modelDefinitionId: 'fixture',
      rulesVersion: 'rules-1',
      rejectPolicy: options.stop ? 'stop' : 'rework',
      maxReworks: options.maxReworks ?? 3,
      responsibleNodeId: 'text',
      subjectSources: [{ nodeId: 'text', portId: 'out-text' }],
      gatedNodeIds: ['target'],
      relations: []
    })
  }
  const file: ProjectFile = {
    version: 1,
    meta: { id: 'p', name: 'test', createdAt: 0, updatedAt: 0, graphVersion: 0 },
    nodes: Object.values(store).map((s) => ({
      id: s.id,
      type: s.props.nodeType,
      contractVersion: s.id === 'text' ? 3 : 1,
      ports:
        s.id === 'text'
          ? [{ id: 'out-text', dir: 'out', type: 'text', required: true, cardinality: 'one' }]
          : [],
      params: { config: s.props.config },
      content: { kind: 'text', text: s.props.text }
    })) as ProjectFile['nodes'],
    edges: [
      {
        id: 'edge',
        from: { nodeId: 'text', portId: 'out-text' },
        to: { nodeId: 'review', portId: 'in-text' }
      }
    ],
    groups: [],
    tldrawSnapshot: { store }
  }
  let calls = 0,
    during = () => {}
  const model: AgentModelPort = {
    decide: async () => ({ kind: 'wait' }),
    review: async (context) => {
      calls++
      expect(context.subjects).toEqual([{ kind: 'text', text: store.text.props.text }])
      during()
      if (options.error) throw new Error('private-review-model-failure')
      return options.verdict ?? { passed: true, feedback: '标准完整，允许交付', issues: [] }
    }
  }
  const host = new FlowReviewHost(
      db,
      () => file,
      () => true,
      async () => model
    ),
    ledger = new FlowCommandLedger(db, () => file)
  return {
    db,
    store,
    file,
    host,
    ledger,
    calls: () => calls,
    during: (fn: () => void) => {
      during = fn
    },
    publish: (decision: unknown) => {
      store.review.meta.nodeResult = JSON.stringify(decision)
      store.review.meta.nodeRun = { runId: 'r', status: 'success', startedAt: 0, inputs: [] }
    }
  }
}
describe('fixed-version AI review and bounded manual rework', () => {
  it('reviews materialized fixed assets through their actual canvas port while retaining original provenance', async () => {
    const f = fixture()
    f.store.target.meta.nodeResult = JSON.stringify({
      kind: 'text',
      text: 'private-review-material'
    })
    f.store.target.meta.nodeRun = { runId: 'producer', status: 'success', startedAt: 0, inputs: [] }
    const version = new FlowAssetStore(f.db, () => f.file).submit({
      projectId: 'p',
      nodeId: 'target',
      portId: 'out-value',
      submissionId: 'producer',
      expectedGraphVersion: 0,
      traceId: 'trace',
      spanId: 'span'
    })
    f.store.text.meta.flowAssetRef = JSON.stringify(version.ref)
    f.store.text.meta.pinnedOutput = JSON.stringify({
      version: 1,
      outputs: { 'out-text': version.value }
    })
    const decision = await f.host.run(request)
    expect(decision.subjects).toEqual([version.ref])
    f.publish(decision)
    expect(() => f.ledger.assertNodeAvailable({ projectId: 'p', nodeId: 'target' })).not.toThrow()
  })
  it('only releases a saved authoritative approval; projects and submits one report and feedback', async () => {
    const f = fixture()
    expect(() => f.ledger.assertNodeAvailable({ projectId: 'p', nodeId: 'target' })).toThrow(
      'FLOW_REVIEW_NOT_READY'
    )
    const decision = await f.host.run(request)
    expect(decision.passed).toBe(true)
    expect(decision.subjects).toHaveLength(1)
    expect(() => f.ledger.assertNodeAvailable({ projectId: 'p', nodeId: 'target' })).toThrow(
      'FLOW_REVIEW_NOT_READY'
    )
    f.publish(decision)
    expect(() => f.ledger.assertNodeAvailable({ projectId: 'p', nodeId: 'target' })).not.toThrow()
    expect(projectReviewOutputs(f.store.review)['out-feedback']).toEqual({
      kind: 'text',
      text: decision.feedback
    })
    const asset = new FlowAssetStore(f.db, () => f.file).submit({
      projectId: 'p',
      nodeId: 'review',
      portId: 'out-review',
      submissionId: 'report',
      expectedGraphVersion: 0,
      traceId: 'trace',
      spanId: 'span'
    })
    expect(asset.value).toEqual({ kind: 'json', data: decision })
    expect(await f.host.run({ ...request, requestId: 'same-version' })).toEqual(decision)
    expect(f.calls()).toBe(1)
  })
  it('rejects forged reports, changed versions, criteria, bindings and technical failure', async () => {
    const f = fixture(),
      decision = await f.host.run(request)
    f.publish(decision)
    f.store.review.meta.nodeResult = JSON.stringify({ ...decision, feedback: 'forged' })
    expect(() => f.ledger.assertNodeAvailable({ projectId: 'p', nodeId: 'target' })).toThrow(
      'FLOW_REVIEW_NOT_READY'
    )
    f.publish(decision)
    f.store.text.props.text = 'v2'
    expect(new FlowReviewStore(f.db).approval(f.file, 'review')).toBeNull()
    f.store.text.props.text = 'private-review-material'
    f.store.review.props.text += ' changed'
    expect(new FlowReviewStore(f.db).approval(f.file, 'review')).toBeNull()
    const bad = fixture({ error: true })
    await expect(bad.host.run(request)).rejects.toThrow()
    expect(new FlowReviewStore(bad.db).latest('p', 'review')).toBeNull()
  })
  it('binds negative quality to success and limits initial review plus configured reworks without duplicate consumption', async () => {
    const f = fixture({
      maxReworks: 1,
      verdict: {
        passed: false,
        feedback: '缺交付标题，请提交新版本',
        issues: [{ subjectIndex: 0, feedback: '补标题' }]
      }
    })
    const first = await f.host.run(request)
    f.publish(first)
    expect(first.passed).toBe(false)
    expect(() => f.ledger.assertNodeAvailable({ projectId: 'p', nodeId: 'target' })).toThrow(
      'FLOW_REVIEW_NOT_READY'
    )
    expect(await f.host.run({ ...request, requestId: 'duplicate' })).toEqual(first)
    expect(f.calls()).toBe(1)
    f.store.text.props.text = 'v2'
    const second = await f.host.run({ ...request, requestId: 'second' })
    expect(second.reviewRevision).toBe(1)
    expect(second.subjects[0].versionId).not.toBe(first.subjects[0].versionId)
    f.store.text.props.text = 'v3'
    await expect(f.host.run({ ...request, requestId: 'third' })).rejects.toMatchObject({
      code: 'FLOW_REVIEW_BUDGET_EXHAUSTED'
    })
    expect(f.calls()).toBe(2)
  })
  it('stop policy prevents an implicit new round; input edits during model response and invalid issue identities fail closed', async () => {
    const f = fixture({ stop: true, verdict: { passed: false, feedback: '拒绝', issues: [] } })
    await f.host.run(request)
    f.store.text.props.text = 'v2'
    await expect(f.host.run({ ...request, requestId: 'second' })).rejects.toMatchObject({
      code: 'FLOW_REVIEW_STOPPED'
    })
    const edited = fixture()
    edited.during(() => {
      edited.store.text.props.text = 'during-model'
    })
    await expect(edited.host.run(request)).rejects.toMatchObject({ code: 'FLOW_REVISION_CONFLICT' })
    expect(new FlowReviewStore(edited.db).latest('p', 'review')).toBeNull()
    const invalid = fixture({
      verdict: {
        passed: false,
        feedback: '拒绝',
        issues: [{ subjectIndex: 9, feedback: 'unknown' }]
      }
    })
    await expect(invalid.host.run(request)).rejects.toMatchObject({
      code: 'AGENT_MODEL_ACTION_INVALID'
    })
  })
})
