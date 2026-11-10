import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import Database from 'better-sqlite3'

const fixture = vi.hoisted(() => ({ db: null as unknown as Database.Database }))
vi.mock('../src/main/store/db', () => ({ getDb: () => fixture.db }))

import {
  cancelCompositeRunWait,
  getOpenCompositeRunWait,
  openCompositeRunWait,
  satisfyCompositeRunWait
} from '../src/main/store/composite-run-wait.repo'

beforeEach(() => {
  fixture.db = new Database(':memory:')
  fixture.db.exec(`
    CREATE TABLE composite_run_waits (
      id TEXT PRIMARY KEY, run_id TEXT NOT NULL, step_key TEXT, revision INTEGER NOT NULL,
      kind TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'open', fields_json TEXT NOT NULL,
      value_json TEXT, submitted_by TEXT, created_at INTEGER NOT NULL, expires_at INTEGER,
      satisfied_at INTEGER, UNIQUE(run_id, revision)
    );
  `)
})
afterEach(() => fixture.db.close())

const fields = [
  { fieldId: 'requirements', label: '人物要求', type: 'text', required: true, cardinality: 'one' as const }
]

describe('组合等待输入（P3）', () => {
  it('打开等待、按 revision 补交、重复提交幂等', () => {
    const wait = openCompositeRunWait({ requestId: 'w1', runId: 'r1', kind: 'input', fields })
    expect(wait.state).toBe('open')
    expect(wait.revision).toBe(1)
    expect(getOpenCompositeRunWait('r1')?.requestId).toBe('w1')
    expect(satisfyCompositeRunWait({ requestId: 'w1', revision: 1, value: { text: '人物' }, submittedBy: 'gui' })).toMatchObject({ ok: true })
    expect(satisfyCompositeRunWait({ requestId: 'w1', revision: 1, value: { text: '重复' }, submittedBy: 'gui' })).toMatchObject({ ok: true })
    expect(getOpenCompositeRunWait('r1')).toBeNull()
  })

  it('旧 revision 被拒绝，取消后不可补交', () => {
    openCompositeRunWait({ requestId: 'w1', runId: 'r1', kind: 'input', fields })
    openCompositeRunWait({ requestId: 'w2', runId: 'r1', kind: 'input', fields })
    expect(satisfyCompositeRunWait({ requestId: 'w1', revision: 1, value: {}, submittedBy: 'cli' })).toMatchObject({ ok: false, reason: 'WAIT_REVISION_CONFLICT' })
    expect(cancelCompositeRunWait('w2')).toBe(true)
    expect(satisfyCompositeRunWait({ requestId: 'w2', revision: 2, value: {}, submittedBy: 'cli' })).toMatchObject({ ok: false, reason: 'WAIT_CLOSED' })
  })
})
