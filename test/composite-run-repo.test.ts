import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import Database from 'better-sqlite3'

const fixture = vi.hoisted(() => ({ db: null as unknown as Database.Database }))
vi.mock('../src/main/store/db', () => ({ getDb: () => fixture.db }))

import {
  createCompositeRun,
  finishCompositeRun,
  getCompositeRun,
  listCompositeRuns,
  recordCompositeRunStep,
  settleInterruptedCompositeRuns
} from '../src/main/store/composite-run.repo'

beforeEach(() => {
  fixture.db = new Database(':memory:')
  fixture.db.exec(`
    CREATE TABLE composite_runs (
      id TEXT PRIMARY KEY, project_id TEXT NOT NULL, capability_id TEXT NOT NULL,
      capability_version TEXT NOT NULL, content_hash TEXT NOT NULL, instance_node_id TEXT,
      parent_run_id TEXT, failure_phase TEXT, output_summary TEXT, output_values TEXT,
      status TEXT NOT NULL, started_at INTEGER NOT NULL, finished_at INTEGER,
      error_code TEXT, error_message TEXT, created_at INTEGER NOT NULL
    );
    CREATE TABLE composite_run_steps (
      run_id TEXT NOT NULL, step_key TEXT NOT NULL, node_type TEXT NOT NULL, status TEXT NOT NULL,
      started_at INTEGER, finished_at INTEGER, reason TEXT, PRIMARY KEY (run_id, step_key)
    );
  `)
})
afterEach(() => fixture.db.close())

describe('组合运行账本（P3 基础）', () => {
  it('创建运行、记录步骤并完成', () => {
    createCompositeRun({
      id: 'run-1',
      projectId: 'project',
      capabilityId: 'character-design',
      capabilityVersion: '1.0',
      contentHash: 'a'.repeat(64)
    })
    recordCompositeRunStep({ runId: 'run-1', stepKey: 'n1', nodeType: 'text', status: 'running' })
    recordCompositeRunStep({ runId: 'run-1', stepKey: 'n1', nodeType: 'text', status: 'completed' })
    finishCompositeRun({ runId: 'run-1', status: 'completed' })
    const record = getCompositeRun('run-1')
    expect(record?.run.status).toBe('completed')
    expect(record?.steps).toHaveLength(1)
    expect(record?.steps[0].status).toBe('completed')
    expect(listCompositeRuns('project')).toHaveLength(1)
  })

  it('重启结算把 running 标为 interrupted，不伪造成功', () => {
    createCompositeRun({
      id: 'run-2',
      projectId: 'project',
      capabilityId: 'character-design',
      capabilityVersion: '1.0',
      contentHash: 'b'.repeat(64)
    })
    expect(settleInterruptedCompositeRuns()).toBe(1)
    const run = getCompositeRun('run-2')
    expect(run?.run.status).toBe('interrupted')
    expect(run?.run.errorCode).toBe('HOST_RESTARTED')
  })

  it('失败运行保留有界错误信息', () => {
    createCompositeRun({
      id: 'run-3',
      projectId: 'project',
      capabilityId: 'character-design',
      capabilityVersion: '1.0',
      contentHash: 'c'.repeat(64)
    })
    finishCompositeRun({
      runId: 'run-3',
      status: 'failed',
      errorCode: 'GEN_FAILED',
      errorMessage: 'x'.repeat(800)
    })
    const run = getCompositeRun('run-3')
    expect(run?.run.errorMessage).toHaveLength(500)
  })

  it('W1：父子运行、失败阶段、公开输出摘要可查，且终态只写一次', () => {
    createCompositeRun({
      id: 'run-child',
      projectId: 'project',
      capabilityId: 'copy-polish',
      capabilityVersion: '1.0',
      contentHash: 'd'.repeat(64),
      parentRunId: 'run-parent',
      instanceNodeId: 'shape:instance'
    })
    expect(
      finishCompositeRun({
        runId: 'run-child',
        status: 'failed',
        errorCode: 'REQUIRED_OUTPUT_MISSING',
        failurePhase: 'output',
        outputPorts: [{ portId: 'out-text', kind: 'text' }]
      })
    ).toBe(true)
    // 已有终态时不得被第二次 finish 改写（唯一终态）。
    expect(finishCompositeRun({ runId: 'run-child', status: 'completed' })).toBe(false)
    const run = getCompositeRun('run-child')?.run
    expect(run?.parentRunId).toBe('run-parent')
    expect(run?.instanceNodeId).toBe('shape:instance')
    expect(run?.failurePhase).toBe('output')
    expect(run?.outputSummary).toEqual([{ portId: 'out-text', kind: 'text' }])
    expect(run?.status).toBe('failed')
  })
})
