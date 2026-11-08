// F8（第二批）：Agent 运行控制外部接入测试（flowAgent.run / pause / stop）。
//
// 关键断言不是"能调用"，而是：
// 1) 外部**只经启动时创建的同一宿主实例**执行（端口注入证明没有第二个权威）；
// 2) start/continue 的第一道闸门是模型工具调用预检——预检失败时宿主 run 一次都不会被调用
//    （付费路径不会被偷偷触发）；
// 3) 请求身份由 main 生成，外部不能自造 requestId/traceId/spanId；
// 4) continue/reconcile/restore 必须携带观测到的任务与等待修订号（乐观并发）；
// 5) 存在活动 Agent 任务时，run/pause/stop 不被占用检查挡住（否则无法操作自己刚建的任务），
//    而其他写操作仍按原规则被占用挡住；
// 6) pause/stop 对不存在的任务如实 NOT_FOUND，不编造空视图。
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { closeDb, getDataDir, getDb } from '../src/main/store/db'
import { createProject } from '../src/main/store/projects.repo'
import { LocalAccessService } from '../src/main/agent-access/service'
import {
  publishFlowAgentAccessPort,
  resetFlowAgentAccessPortForTest
} from '../src/main/agent-access/flow-bridge'
import { AgentRuntimeError } from '../src/shared/agent-flow/runtime-contracts'
import { setGatewayEventSink } from '../src/main/diagnostics/gateway-events'

let directory: string
let service: LocalAccessService
let active: string | null
const originalDirectory = process.env.CANVAS_DATA_DIR
const key = () => `${Date.now()}:${randomUUID()}`

interface FakePort {
  runs: unknown[]
  pauses: Array<{ projectId: string; nodeId: string }>
  stops: Array<{ projectId: string; nodeId: string }>
  prechecks: Array<{ projectId: string; nodeId: string }>
  precheckError: Error | null
  runReply: unknown
  taskView: unknown
}

function publishFakePort(overrides: Partial<FakePort> = {}): FakePort {
  const port: FakePort = {
    runs: [],
    pauses: [],
    stops: [],
    prechecks: [],
    precheckError: null,
    runReply: { task: taskView('running'), refs: [], outputs: {} },
    taskView: taskView('waiting'),
    ...overrides
  }
  publishFlowAgentAccessPort({
    async run(raw) {
      port.runs.push(raw)
      return port.runReply
    },
    pause(query) {
      port.pauses.push(query)
      return port.taskView
    },
    stop(query) {
      port.stops.push(query)
      return port.taskView
    },
    async assertAgentScopeToolCalling(projectId, nodeId) {
      port.prechecks.push({ projectId, nodeId })
      if (port.precheckError) throw port.precheckError
    },
    // F8 收官：端口扩展了 build/review（本文件只测运行控制，这里保持最小桩）。
    async build() {
      return null
    },
    async review() {
      return null
    },
    async assertReviewToolCalling() {
      return undefined
    }
  })
  return port
}

function taskView(state: string): Record<string, unknown> {
  return {
    taskId: 'agent-task-1',
    state,
    waitKind: state === 'waiting' ? 'human' : null,
    waitRevision: 2,
    decisions: 1,
    tools: 3
  }
}

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

function write(operationId: string, input: unknown, idempotencyKey = key()) {
  return call(operationId, input, idempotencyKey)
}

function seedFlowTask(projectId: string, nodeId: string): void {
  // 表结构见 db-migrations：thread 主键 + snapshot/skills JSON 必填。
  getDb()
    .prepare(
      `INSERT INTO flow_agent_tasks
        (thread, project_id, task_id, agent_node_id, snapshot_json, skills_json, state)
       VALUES (?,?,?,?,?,?,?)`
    )
    .run('thread-1', projectId, 'agent-task-1', nodeId, '{}', '[]', 'running')
}

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'canvas-flow-run-test-'))
  process.env.CANVAS_DATA_DIR = directory
  active = null
  setGatewayEventSink({ emit: () => undefined })
  resetFlowAgentAccessPortForTest()
  service = new LocalAccessService({
    instanceId: randomUUID(),
    appVersion: 'test',
    exportDirectory: join(getDataDir(), 'agent-exports'),
    activeProjectId: () => active
  })
})

afterEach(() => {
  resetFlowAgentAccessPortForTest()
  closeDb()
  if (originalDirectory === undefined) delete process.env.CANVAS_DATA_DIR
  else process.env.CANVAS_DATA_DIR = originalDirectory
  rmSync(directory, { recursive: true, force: true })
})

describe('flowAgent 运行控制', () => {
  it('宿主端口未发布时如实拒绝（不降级成本地替身）', async () => {
    const project = createProject('运行-无宿主')
    active = project.id
    const response = await write('flowAgent.pause', {
      projectId: project.id,
      nodeId: 'shape:agent-1'
    })
    expect(response.status).toBe('failed')
    expect(response.error?.code).toBe('FLOW_AGENTS_UNAVAILABLE')
  })

  it('run 要求目标项目是当前活动画布（宿主需要渲染器交付命令）', async () => {
    const project = createProject('运行-非活动')
    const other = createProject('运行-另一个')
    active = other.id
    const port = publishFakePort()
    const response = await write('flowAgent.run', {
      projectId: project.id,
      nodeId: 'shape:agent-1',
      action: 'start'
    })
    expect(response.status).toBe('failed')
    expect(response.error?.code).toBe('ACTIVE_PROJECT_REQUIRED')
    expect(port.runs).toEqual([])
    expect(port.prechecks).toEqual([])
  })

  it('start 先做模型工具调用预检，再用 main 生成的身份调用同一宿主', async () => {
    const project = createProject('运行-启动')
    active = project.id
    const port = publishFakePort()
    const response = await write('flowAgent.run', {
      projectId: project.id,
      nodeId: 'shape:agent-1',
      action: 'start'
    })
    expect(response.status, JSON.stringify(response.error)).toBe('completed')
    expect(port.prechecks).toEqual([{ projectId: project.id, nodeId: 'shape:agent-1' }])
    expect(port.runs).toHaveLength(1)
    const raw = port.runs[0] as Record<string, unknown>
    expect(raw.action).toBe('start')
    // 外部没有传身份：三个 ID 都由 main 生成（UUID），不能是调用方给的值。
    for (const field of ['requestId', 'traceId', 'spanId']) {
      expect(String(raw[field])).toMatch(/^[a-f0-9-]{36}$/)
    }
    const data = response.data as { task: { state: string }; refs: unknown[] }
    expect(data.task.state).toBe('running')
    expect(data.refs).toEqual([])
  })

  it('预检失败时宿主 run 一次都不会被调用（付费路径不被触发）', async () => {
    const project = createProject('运行-预检失败')
    active = project.id
    const port = publishFakePort({
      precheckError: new AgentRuntimeError('AGENT_MODEL_TOOL_UNVERIFIED', 'model-capability')
    })
    const response = await write('flowAgent.run', {
      projectId: project.id,
      nodeId: 'shape:agent-1',
      action: 'start'
    })
    expect(response.status).toBe('failed')
    expect(response.error?.code).toBe('AGENT_MODEL_TOOL_UNVERIFIED')
    expect(port.runs).toEqual([])
    // 失败不留下任何任务：账本里没有这条 Agent 任务。
    const rows = getDb()
      .prepare('SELECT COUNT(*) AS n FROM flow_agent_tasks WHERE project_id=?')
      .get(project.id) as { n: number }
    expect(rows.n).toBe(0)
  })

  it('continue 必须携带观测到的任务与等待修订号（乐观并发）', async () => {
    const project = createProject('运行-继续')
    active = project.id
    const port = publishFakePort()
    const missing = await write('flowAgent.run', {
      projectId: project.id,
      nodeId: 'shape:agent-1',
      action: 'continue'
    })
    expect(missing.status).toBe('failed')
    expect(missing.error?.code).toBe('INVALID_INPUT')
    expect(port.runs).toEqual([])

    const ok = await write('flowAgent.run', {
      projectId: project.id,
      nodeId: 'shape:agent-1',
      action: 'continue',
      eventId: 'event-1',
      expectedTaskId: 'agent-task-1',
      expectedWaitRevision: 2
    })
    expect(ok.status, JSON.stringify(ok.error)).toBe('completed')
    const raw = port.runs[0] as Record<string, unknown>
    expect(raw.action).toBe('continue')
    expect(raw.expectedTaskId).toBe('agent-task-1')
    expect(raw.expectedWaitRevision).toBe(2)
  })

  it('存在活动 Agent 任务时 run/pause/stop 不被占用检查挡住，其他写入仍被挡住', async () => {
    const project = createProject('运行-占用豁免')
    active = project.id
    seedFlowTask(project.id, 'shape:agent-1')
    const port = publishFakePort()
    const run = await write('flowAgent.run', {
      projectId: project.id,
      nodeId: 'shape:agent-1',
      action: 'start'
    })
    expect(run.status, JSON.stringify(run.error)).toBe('completed')
    const pause = await write('flowAgent.pause', {
      projectId: project.id,
      nodeId: 'shape:agent-1'
    })
    expect(pause.status, JSON.stringify(pause.error)).toBe('completed')
    const stop = await write('flowAgent.stop', {
      projectId: project.id,
      nodeId: 'shape:agent-1'
    })
    expect(stop.status, JSON.stringify(stop.error)).toBe('completed')
    // 对照：同一个项目上的其他写入仍被活动任务占用挡住（豁免只对这三个操作生效）。
    const media = await write('media.import', {
      projectId: project.id,
      filePath: join(directory, 'nope.png')
    })
    expect(media.error?.code).toBe('RESOURCE_BUSY')
    expect(port.pauses).toHaveLength(1)
    expect(port.stops).toHaveLength(1)
  })

  it('pause/stop 对不存在的任务如实 NOT_FOUND，不编造空视图', async () => {
    const project = createProject('运行-无任务')
    active = project.id
    publishFakePort({ taskView: null })
    for (const operationId of ['flowAgent.pause', 'flowAgent.stop']) {
      const response = await write(operationId, { projectId: project.id, nodeId: 'shape:agent-1' })
      expect(response.status).toBe('failed')
      expect(response.error?.code).toBe('NOT_FOUND')
    }
  })

  it('pause/stop 可以作用于非活动画布上的既有任务（停止工作不应被切换画布挡住）', async () => {
    const project = createProject('运行-后台任务')
    const other = createProject('运行-前台画布')
    active = other.id
    const port = publishFakePort()
    const pause = await write('flowAgent.pause', {
      projectId: project.id,
      nodeId: 'shape:agent-1'
    })
    expect(pause.status, JSON.stringify(pause.error)).toBe('completed')
    expect(port.pauses[0]).toEqual({ projectId: project.id, nodeId: 'shape:agent-1' })
  })

  it('同一幂等键重放返回原回执，宿主只被调用一次', async () => {
    const project = createProject('运行-幂等')
    active = project.id
    const port = publishFakePort()
    const idempotencyKey = key()
    const first = await call(
      'flowAgent.run',
      { projectId: project.id, nodeId: 'shape:agent-1', action: 'start' },
      idempotencyKey
    )
    const replay = await call(
      'flowAgent.run',
      { projectId: project.id, nodeId: 'shape:agent-1', action: 'start' },
      idempotencyKey
    )
    expect(first.status).toBe('completed')
    expect(replay.status).toBe('completed')
    expect(replay.data).toEqual(first.data)
    expect(port.runs).toHaveLength(1)
  })
})
