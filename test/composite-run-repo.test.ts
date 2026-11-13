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
  settleInterruptedCompositeRuns,
  attachCompositeRunInputs,
  attachCompositeRunRetry,
  countCompositeRetries,
  resubmitCompositeRun
} from '../src/main/store/composite-run.repo'

beforeEach(() => {
  fixture.db = new Database(':memory:')
  fixture.db.exec(`
    CREATE TABLE composite_runs (
      id TEXT PRIMARY KEY, project_id TEXT NOT NULL, capability_id TEXT NOT NULL,
      capability_version TEXT NOT NULL, content_hash TEXT NOT NULL, instance_node_id TEXT,
      parent_run_id TEXT, failure_phase TEXT, failure_node_id TEXT, failure_port_id TEXT,
      output_summary TEXT, output_values TEXT,
      input_values TEXT, retry_of TEXT, manual_submission INTEGER NOT NULL DEFAULT 0,
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

  it('W4：失败内部节点/端口 ID 持久化并可查（只存 ID）', () => {
    createCompositeRun({
      id: 'run-loc',
      projectId: 'project',
      capabilityId: 'model-polish',
      capabilityVersion: '1.0',
      contentHash: 'e'.repeat(64)
    })
    recordCompositeRunStep({ runId: 'run-loc', stepKey: 'n1', nodeType: 'ai-process', status: 'running' })
    recordCompositeRunStep({
      runId: 'run-loc',
      stepKey: 'n1',
      nodeType: 'ai-process',
      status: 'failed',
      reason: '功能 text.process 尚未绑定已验证文本模型'
    })
    finishCompositeRun({
      runId: 'run-loc',
      status: 'failed',
      errorCode: 'NODE_FAILED',
      failurePhase: 'step',
      failureNodeId: 'n1',
      failurePortId: 'out-text'
    })
    const record = getCompositeRun('run-loc')
    expect(record?.run.failureNodeId).toBe('n1')
    expect(record?.run.failurePortId).toBe('out-text')
    expect(record?.run.failurePhase).toBe('step')
    expect(record?.steps[0].status).toBe('failed')
    expect(record?.steps[0].reason).toContain('text.process')
  })

  it('W4：skipped 步骤如实记账，不再误记 completed', () => {
    createCompositeRun({
      id: 'run-skip',
      projectId: 'project',
      capabilityId: 'model-polish',
      capabilityVersion: '1.0',
      contentHash: 'f'.repeat(64)
    })
    recordCompositeRunStep({
      runId: 'run-skip',
      stepKey: 'n2',
      nodeType: 'ai-process',
      status: 'skipped',
      reason: '缺少必要输入'
    })
    const record = getCompositeRun('run-skip')
    expect(record?.steps[0].status).toBe('skipped')
    expect(record?.steps[0].reason).toBe('缺少必要输入')
  })

  it('W4：成功运行不携带失败定位字段', () => {
    createCompositeRun({
      id: 'run-ok',
      projectId: 'project',
      capabilityId: 'model-polish',
      capabilityVersion: '1.0',
      contentHash: '1'.repeat(64)
    })
    finishCompositeRun({ runId: 'run-ok', status: 'completed' })
    const run = getCompositeRun('run-ok')?.run
    expect(run?.failureNodeId).toBeNull()
    expect(run?.failurePortId).toBeNull()
  })

  it('W4 受控重试：输入值/重试链落盘，按根计数', () => {
    createCompositeRun({
      id: 'root',
      projectId: 'project',
      capabilityId: 'model-polish',
      capabilityVersion: '1.0',
      contentHash: '1'.repeat(64)
    })
    expect(attachCompositeRunInputs('root', { 'in-text': { kind: 'text', text: '原输入' } })).toBe(true)
    finishCompositeRun({ runId: 'root', status: 'failed', errorCode: 'REQUIRED_OUTPUT_MISSING' })
    expect(countCompositeRetries('root')).toBe(0)
    createCompositeRun({
      id: 'retry-1',
      projectId: 'project',
      capabilityId: 'model-polish',
      capabilityVersion: '1.0',
      contentHash: '1'.repeat(64),
      retryOf: 'root'
    })
    expect(attachCompositeRunRetry('retry-1', 'root')).toBe(true)
    expect(countCompositeRetries('root')).toBe(1)
    const root = getCompositeRun('root')?.run
    expect(root?.inputValues).toEqual({ 'in-text': { kind: 'text', text: '原输入' } })
    expect(root?.retryOf).toBeNull()
    expect(getCompositeRun('retry-1')?.run.retryOf).toBe('root')
  })

  it('W4 人工补交：仅 failed/interrupted 可补交，completed 但 manualSubmission 如实标记', () => {
    createCompositeRun({
      id: 'run-fail',
      projectId: 'project',
      capabilityId: 'model-polish',
      capabilityVersion: '1.0',
      contentHash: '1'.repeat(64)
    })
    finishCompositeRun({
      runId: 'run-fail',
      status: 'failed',
      errorCode: 'REQUIRED_OUTPUT_MISSING',
      failurePhase: 'output',
      failureNodeId: 'n1',
      failurePortId: 'out-text'
    })
    expect(
      resubmitCompositeRun({
        runId: 'run-fail',
        outputPorts: [{ portId: 'polished', kind: 'text' }],
        outputValues: { polished: { kind: 'text', text: '人工补交结果' } }
      })
    ).toBe(true)
    const run = getCompositeRun('run-fail')?.run
    expect(run?.status).toBe('completed')
    expect(run?.manualSubmission).toBe(true)
    expect(run?.outputValues).toEqual({ polished: { kind: 'text', text: '人工补交结果' } })
    // 补交清空失败定位（运行已交付），但补交标记永不移除。
    expect(run?.failureNodeId).toBeNull()
    // 已 completed 的运行不可再次补交（状态机守卫）。
    expect(
      resubmitCompositeRun({
        runId: 'run-fail',
        outputPorts: [{ portId: 'polished', kind: 'text' }],
        outputValues: { polished: { kind: 'text', text: '再次补交' } }
      })
    ).toBe(false)
  })

  it('W4 人工补交：running/completed 运行拒绝补交', () => {
    createCompositeRun({
      id: 'run-live',
      projectId: 'project',
      capabilityId: 'model-polish',
      capabilityVersion: '1.0',
      contentHash: '1'.repeat(64)
    })
    expect(
      resubmitCompositeRun({
        runId: 'run-live',
        outputPorts: [{ portId: 'polished', kind: 'text' }],
        outputValues: { polished: { kind: 'text', text: 'x' } }
      })
    ).toBe(false)
    expect(getCompositeRun('run-live')?.run.status).toBe('running')
  })
})
