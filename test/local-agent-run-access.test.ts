// F3 执行与结果外部接入测试：node.execute 受理/终态/取消、run.get/run.wait、output.get 投影。
// renderer 引擎用 mock 权威宿主模拟（真实桌面验收在里程碑脚本执行）。
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { CanvasNode } from '../src/shared/types'
import { closeDb, getDataDir } from '../src/main/store/db'
import { createProject, openProject, saveProject } from '../src/main/store/projects.repo'
import { LocalAccessService } from '../src/main/agent-access/service'
import { setGatewayEventSink } from '../src/main/diagnostics/gateway-events'
import type { AccessDesktop } from '../src/main/agent-access/desktop'
import { getExternalRun, reportExternalRun } from '../src/main/agent-access/runs'

let directory: string
let service: LocalAccessService
let active: string | null
const events: any[] = []
const originalDirectory = process.env.CANVAS_DATA_DIR
const key = () => `${Date.now()}:${randomUUID()}`

function call(operationId: string, input: unknown = {}, idempotencyKey?: string) {
  return service.dispatch({
    apiVersion: 1,
    operationVersion: 1,
    operationId,
    input,
    requestId: randomUUID(),
    expectedDataStoreId: service.dataStoreId,
    ...(idempotencyKey ? { idempotencyKey } : {})
  })
}

function textNode(id: string, text: string): CanvasNode {
  return {
    id: `shape:${id}`,
    type: 'text',
    contractVersion: 3,
    title: id,
    x: 0,
    y: 0,
    w: 340,
    h: 260,
    ports: [],
    params: {},
    content: { kind: 'text', text },
    exec: { status: 'idle' },
    meta: { source: 'input', createdAt: 1 }
  }
}

function jsonNode(id: string, body: string): CanvasNode {
  return { ...textNode(id, body), type: 'json', contractVersion: 1 }
}

function withDesktop(desktop?: AccessDesktop): void {
  service = new LocalAccessService({
    instanceId: randomUUID(),
    appVersion: 'test',
    exportDirectory: join(getDataDir(), 'agent-exports'),
    activeProjectId: () => active,
    desktop
  })
}

/** 模拟权威宿主：受理后立即 running，并按脚本在 Promise 内回填终态。 */
function autoRunDesktop(outcome: 'completed' | 'failed' | 'none', error?: string): AccessDesktop {
  return {
    run: async (request) => {
      expect(request.action).toBe('execute-nodes')
      reportExternalRun(String(request.taskId), 'running')
      if (outcome !== 'none') reportExternalRun(String(request.taskId), outcome, { error })
      return { graphVersion: 0 }
    }
  }
}

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'canvas-run-access-test-'))
  process.env.CANVAS_DATA_DIR = directory
  active = null
  events.length = 0
  setGatewayEventSink({
    emit: (event) => {
      if (event) events.push(event)
    }
  })
  service = new LocalAccessService({
    instanceId: randomUUID(),
    appVersion: 'test',
    exportDirectory: join(getDataDir(), 'agent-exports'),
    activeProjectId: () => active
  })
})

afterEach(() => {
  closeDb()
  setGatewayEventSink(null)
  process.env.CANVAS_DATA_DIR = originalDirectory
  if (originalDirectory === undefined) delete process.env.CANVAS_DATA_DIR
  if (
    resolve(directory, '..') !== resolve(tmpdir()) ||
    !basename(directory).startsWith('canvas-run-access-test-')
  )
    throw new Error('RUN_ACCESS_TEST_CLEANUP_OUTSIDE_ISOLATION')
  rmSync(directory, { recursive: true, force: true })
})

describe('local Agent run access', () => {
  it('accepts execution, reports terminal state through the ledger and answers run.get/run.wait', async () => {
    const p = createProject('执行')
    saveProject({ id: p.id, graph: { nodes: [textNode('a', '正文')], edges: [], groups: [] } })!
    active = p.id
    withDesktop(autoRunDesktop('completed'))
    const accepted = await call(
      'node.execute',
      { projectId: p.id, expectedGraphVersion: 1, nodeIds: ['shape:a'], mode: 'single' },
      key()
    )
    expect(accepted.status).toBe('completed')
    expect(accepted.data).toMatchObject({ projectId: p.id, accepted: true, mode: 'single' })
    const taskId = (accepted.data as any).taskId
    expect(getExternalRun(taskId)?.status).toBe('completed')
    const status = await call('run.get', { projectId: p.id, taskId })
    expect(status.data).toMatchObject({
      source: 'node-run',
      state: 'completed',
      taskId,
      hostResident: true
    })
    const waited = await call('run.wait', { projectId: p.id, taskId, timeoutMs: 1000 })
    expect((waited.data as any).state).toBe('completed')
  })

  it('waits for a late terminal report instead of fabricating success', async () => {
    const p = createProject('等待')
    saveProject({ id: p.id, graph: { nodes: [textNode('a', 'x')], edges: [], groups: [] } })!
    active = p.id
    let release!: () => void
    withDesktop({
      run: async (request) => {
        reportExternalRun(String(request.taskId), 'running')
        void new Promise<void>((resolveHold) => {
          release = () => {
            reportExternalRun(String(request.taskId), 'completed')
            resolveHold()
          }
        })
        return { graphVersion: 0 }
      }
    })
    const accepted = await call(
      'node.execute',
      { projectId: p.id, expectedGraphVersion: 0, nodeIds: ['shape:a'] },
      key()
    )
    const taskId = (accepted.data as any).taskId as string
    setTimeout(() => release?.(), 700)
    const waited = await call('run.wait', { projectId: p.id, taskId, timeoutMs: 5000 })
    expect((waited.data as any).state).toBe('completed')
  })

  it('maps validated host refusals to failed without a live task', async () => {
    const p = createProject('拒绝')
    saveProject({ id: p.id, graph: { nodes: [textNode('a', 'x')], edges: [], groups: [] } })!
    active = p.id
    const { DesktopAccessError } = await import('../src/main/agent-access/desktop')
    withDesktop({
      run: async () => {
        throw new DesktopAccessError('ENGINE_BUSY', false)
      }
    })
    const refused = await call(
      'node.execute',
      { projectId: p.id, expectedGraphVersion: 0, nodeIds: ['shape:a'] },
      key()
    )
    expect(refused.status).toBe('failed')
    expect(refused.error?.code).toBe('ENGINE_BUSY')
  })

  it('keeps unknown semantics when the host handshake is lost and replays idempotently', async () => {
    const p = createProject('失联')
    saveProject({ id: p.id, graph: { nodes: [textNode('a', 'x')], edges: [], groups: [] } })!
    active = p.id
    const { DesktopAccessError } = await import('../src/main/agent-access/desktop')
    withDesktop({
      run: async (request) => {
        reportExternalRun(String(request.taskId), 'running')
        throw new DesktopAccessError('DESKTOP_TIMEOUT', true)
      }
    })
    const same = key()
    const first = await call(
      'node.execute',
      { projectId: p.id, expectedGraphVersion: 0, nodeIds: ['shape:a'] },
      same
    )
    expect(first.status).toBe('unknown')
    const replay = await call(
      'node.execute',
      { projectId: p.id, expectedGraphVersion: 0, nodeIds: ['shape:a'] },
      same
    )
    expect(replay.status).toBe('unknown')
    expect(replay.idempotencyKey).toBe(first.idempotencyKey)
  })

  it('separates cancel requests from confirmed cancellation', async () => {
    const p = createProject('取消')
    saveProject({ id: p.id, graph: { nodes: [textNode('a', 'x')], edges: [], groups: [] } })!
    active = p.id
    withDesktop({
      run: async (request) => {
        reportExternalRun(String(request.taskId), 'running')
        if (request.action === 'execute-nodes') return { graphVersion: 0 }
        return { graphVersion: 0 }
      }
    })
    const accepted = await call(
      'node.execute',
      { projectId: p.id, expectedGraphVersion: 0, nodeIds: ['shape:a'] },
      key()
    )
    const taskId = (accepted.data as any).taskId as string
    // cancel-run 握手由 run.cancel 触发；这里用宿主报告模拟用户侧停止后的确认。
    const cancelled = await call('run.cancel', { projectId: p.id, taskId }, key())
    expect(cancelled.data).toMatchObject({ state: 'cancel-requested', cancelRequested: true })
    expect(getExternalRun(taskId)?.status).toBe('cancel-requested')
    reportExternalRun(taskId, 'cancelled')
    expect((await call('run.get', { projectId: p.id, taskId })).data).toMatchObject({
      state: 'cancelled',
      cancelRequested: true
    })
    // 已终态任务再取消是无操作，不伪造 cancelRequested。
    const again = await call('run.cancel', { projectId: p.id, taskId }, key())
    expect(again.data).toMatchObject({ state: 'cancelled', cancelRequested: false })
  })

  it('projects formal outputs for deterministic nodes from persisted data only', async () => {
    const p = createProject('结果')
    const processorNode: CanvasNode = {
      ...textNode('proc', ''),
      type: 'processor',
      contractVersion: 1
    }
    saveProject({
      id: p.id,
      graph: {
        nodes: [textNode('a', '正式文本  '), jsonNode('j', '{"k":1}'), processorNode],
        edges: [],
        groups: []
      },
      tldrawSnapshot: {
        store: {
          'shape:proc': {
            type: 'node-card',
            props: { nodeType: 'processor', config: '' },
            meta: { nodeResult: JSON.stringify({ kind: 'text', text: '处理器输出' }) }
          }
        }
      }
    })!
    const text = await call('output.get', { projectId: p.id, nodeId: 'shape:a' })
    expect(text.data).toMatchObject({
      nodeType: 'text',
      outputSource: 'document',
      projection: 'deterministic@1'
    })
    expect((text.data as any).outputs).toEqual([{ portId: 'out-text', kind: 'text', text: '正式文本' }])
    const json = await call('output.get', { projectId: p.id, nodeId: 'shape:j' })
    expect((json.data as any).outputs).toEqual([{ portId: 'out-json', kind: 'json', json: { k: 1 } }])
    const proc = await call('output.get', { projectId: p.id, nodeId: 'shape:proc' })
    expect((proc.data as any).outputs).toEqual([
      { portId: 'out-value', kind: 'text', text: '处理器输出' }
    ])
    expect(
      (await call('output.get', { projectId: p.id, nodeId: 'shape:missing' })).error?.code
    ).toBe('NODE_NOT_FOUND')
    const website = await call('output.get', { projectId: p.id, nodeId: 'shape:a' })
    void website
  })

  it('projects ai-process results by stored kind (F6 third batch)', async () => {
    const p = createProject('AI处理')
    const config = JSON.stringify({ modelKey: '', mode: 'json', temperature: 0.7, maxTokens: 4096 })
    const aiNode: CanvasNode = {
      ...textNode('a', ''),
      id: 'shape:a',
      type: 'ai-process',
      contractVersion: 1,
      params: { config }
    }
    saveProject({
      id: p.id,
      graph: { nodes: [aiNode], edges: [], groups: [] },
      tldrawSnapshot: {
        store: {
          'shape:a': {
            type: 'node-card',
            props: { nodeType: 'ai-process', config },
            meta: { nodeResult: JSON.stringify({ kind: 'json', data: { shots: [1, 2] } }) }
          }
        }
      }
    })!
    const output = await call('output.get', { projectId: p.id, nodeId: 'shape:a' })
    expect(output.status === 'completed' ? output.data : output.error).toMatchObject({
      nodeType: 'ai-process'
    })
    expect(output.status).toBe('completed')
    expect(output.data).toMatchObject({ nodeType: 'ai-process', outputSource: 'run' })
    expect((output.data as any).outputs).toEqual([
      { portId: 'out-json', kind: 'json', json: { shots: [1, 2] } }
    ])
  })
})
