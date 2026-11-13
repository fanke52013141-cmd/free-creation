import { afterEach, describe, expect, it, vi } from 'vitest'
import Database from 'better-sqlite3'

const fixture = vi.hoisted(() => ({ db: null as unknown as Database.Database }))
vi.mock('../src/main/store/db', () => ({ getDb: () => fixture.db }))

import { migrateDatabase } from '../src/main/store/db-migrations'
import {
  createCompositeRun,
  waitCompositeRun,
  getCompositeRun,
  recordCompositeStepOutput,
  getCompositeStepOutputs,
  finishCompositeRun
} from '../src/main/store/composite-run.repo'
import {
  openCompositeRunWait,
  getOpenCompositeRunWait,
  satisfyCompositeRunWait,
  getSatisfiedHumanSubmissions
} from '../src/main/store/composite-run-wait.repo'

/**
 * AF-07 含人工等待的节点流：停等 → 外部提交 → 满足 → 续跑消费提交 + 回放已完成步骤输出。
 * 这里验证运行/等待账本的数据流与约束（不伪造完成、过期/修订拒绝、已完成步骤保护）。
 */
const dbs: Database.Database[] = []
afterEach(() => dbs.splice(0).forEach((db) => db.close()))

function setup() {
  const db = new Database(':memory:')
  dbs.push(db)
  fixture.db = db
  migrateDatabase(db)
  createCompositeRun({
    id: 'run-1',
    projectId: 'headless-run-1',
    capabilityId: 'cap-1',
    capabilityVersion: '1.0.0',
    contentHash: 'sha256:' + 'a'.repeat(64)
  })
  return db
}

describe('AF-07 composite human wait / resume', () => {
  it('停等：运行转 waiting-input 并开放人工等待', () => {
    setup()
    expect(waitCompositeRun({ runId: 'run-1', stepKey: 'human-node' })).toBe(true)
    expect(getCompositeRun('run-1')!.run.status).toBe('waiting-input')
    openCompositeRunWait({
      requestId: 'run-1:human-node',
      runId: 'run-1',
      stepKey: 'human-node',
      kind: 'human',
      fields: [
        { fieldId: 'result', label: '结果', type: 'text', required: true, cardinality: 'one' }
      ]
    })
    const wait = getOpenCompositeRunWait('run-1')!
    expect(wait.kind).toBe('human')
    expect(wait.state).toBe('open')
    expect(wait.stepKey).toBe('human-node')
  })

  it('外部提交满足等待；续跑读取提交值', () => {
    setup()
    waitCompositeRun({ runId: 'run-1', stepKey: 'human-node' })
    openCompositeRunWait({
      requestId: 'run-1:human-node',
      runId: 'run-1',
      stepKey: 'human-node',
      kind: 'human',
      fields: []
    })
    const wait = getOpenCompositeRunWait('run-1')!
    const result = satisfyCompositeRunWait({
      requestId: wait.requestId,
      revision: wait.revision,
      value: { kind: 'text', text: '人工结果' },
      submittedBy: 'external'
    })
    expect(result.ok).toBe(true)
    expect(getOpenCompositeRunWait('run-1')).toBeNull()
    const submissions = getSatisfiedHumanSubmissions('run-1')
    expect(submissions['human-node']).toEqual({ kind: 'text', text: '人工结果' })
  })

  it('过期修订提交被拒绝', () => {
    setup()
    waitCompositeRun({ runId: 'run-1', stepKey: 'human-node' })
    openCompositeRunWait({
      requestId: 'w1',
      runId: 'run-1',
      stepKey: 'human-node',
      kind: 'human',
      fields: []
    })
    const result = satisfyCompositeRunWait({
      requestId: 'w1',
      revision: 99,
      value: { kind: 'text', text: 'x' },
      submittedBy: 'external'
    })
    expect(result.ok).toBe(false)
    expect(result.reason).toBe('WAIT_REVISION_CONFLICT')
  })

  it('已完成步骤输出持久化与回放（保护已付费任务）', () => {
    setup()
    recordCompositeStepOutput({
      runId: 'run-1',
      nodeId: 'upstream',
      nodeResult: JSON.stringify({ kind: 'text', text: '上游成果' }),
      nodeRun: { runId: 'r', status: 'success' }
    })
    const outputs = getCompositeStepOutputs('run-1')
    expect(outputs.upstream.nodeResult).toContain('上游成果')
    expect((outputs.upstream.nodeRun as { status: string }).status).toBe('success')
  })

  it('续跑完成後运行转 completed（从 waiting-input）', () => {
    setup()
    waitCompositeRun({ runId: 'run-1', stepKey: 'human-node' })
    expect(getCompositeRun('run-1')!.run.status).toBe('waiting-input')
    const changed = finishCompositeRun({ runId: 'run-1', status: 'completed' })
    expect(changed).toBe(true)
    expect(getCompositeRun('run-1')!.run.status).toBe('completed')
  })
})
