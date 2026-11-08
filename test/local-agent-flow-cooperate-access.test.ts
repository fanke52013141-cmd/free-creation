// F8 收官：协作事件写入（flowAgent.cooperate）验收。
//
// 断言重点：
// 1) 必须经 flow-bridge 发布的**同一个宿主实例**执行（未发布时如实 FLOW_AGENTS_UNAVAILABLE）；
// 2) 事件显式带 actor=external，与人工输入可区分；
// 3) discuss/revise 会真实调用模型，必须先过工具调用预检（预检失败不能发出任何协作事件）；
// 4) 输入用与 IPC 完全相同的 Schema 校验（含 refs 去重），外部不能绕过。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { closeDb, getDataDir } from '../src/main/store/db'
import { createProject, saveProject } from '../src/main/store/projects.repo'
import { LocalAccessService } from '../src/main/agent-access/service'
import {
  publishFlowAgentAccessPort,
  resetFlowAgentAccessPortForTest,
  type FlowAgentAccessPort
} from '../src/main/agent-access/flow-bridge'
import { setGatewayEventSink } from '../src/main/diagnostics/gateway-events'
import { AgentRuntimeError } from '../src/shared/agent-flow/runtime-contracts'
import type { CanvasNode } from '../src/shared/types'

let directory: string
let service: LocalAccessService
let active: string | null
const originalDirectory = process.env.CANVAS_DATA_DIR
const key = () => `${Date.now()}:${randomUUID()}`

function textNode(id: string): CanvasNode {
  return {
    id: `shape:${id}`,
    type: 'agent',
    contractVersion: 1,
    title: 'Agent 节点',
    x: 0,
    y: 0,
    w: 340,
    h: 260,
    ports: [],
    params: { config: '{}' },
    content: { kind: 'text', text: '' },
    exec: { status: 'idle' },
    meta: { source: 'input', createdAt: 1 }
  }
}

function write(operationId: string, input: unknown) {
  return service.dispatch({
    apiVersion: 1,
    operationVersion: 1,
    operationId,
    input,
    requestId: randomUUID(),
    expectedDataStoreId: service.dataStoreId,
    idempotencyKey: key()
  })
}

const view = {
  task: {
    taskId: 'task-1',
    state: 'waiting' as const,
    waitKind: 'human' as const,
    waitRevision: 1,
    decisions: 0,
    tools: 0
  },
  goal: '目标',
  revision: 2,
  messages: [{ eventId: 'event-1', kind: 'note', text: '外部备注' }],
  inputs: [],
  candidates: []
}

function stubPort(overrides: Partial<FlowAgentAccessPort> = {}) {
  const cooperate = vi.fn(async () => view)
  const assertAgentScopeToolCalling = vi.fn(async () => undefined)
  const port: FlowAgentAccessPort = {
    run: vi.fn(async () => view),
    pause: vi.fn(() => view),
    stop: vi.fn(() => view),
    assertAgentScopeToolCalling,
    build: vi.fn(async () => ({})),
    review: vi.fn(async () => ({})),
    assertReviewToolCalling: vi.fn(async () => undefined),
    cooperate,
    ...overrides
  }
  publishFlowAgentAccessPort(port)
  return { port, cooperate, assertAgentScopeToolCalling }
}

const baseCollaboration = {
  taskId: 'task-1',
  waitRevision: 1,
  revision: 2,
  eventId: 'evt-external-1',
  text: '外部备注',
  accepted: true
}

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'canvas-cooperate-test-'))
  process.env.CANVAS_DATA_DIR = directory
  active = null
  setGatewayEventSink({ emit: () => undefined })
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
  vi.restoreAllMocks()
  if (originalDirectory === undefined) delete process.env.CANVAS_DATA_DIR
  else process.env.CANVAS_DATA_DIR = originalDirectory
  rmSync(directory, { recursive: true, force: true })
})

function seedProject(): string {
  const project = createProject('协作')
  saveProject({ id: project.id, graph: { nodes: [textNode('agent')], edges: [], groups: [] } })
  active = project.id
  return project.id
}

describe('flowAgent.cooperate', () => {
  it('宿主未发布时如实拒绝（不降级成本地替身）', async () => {
    const projectId = seedProject()
    resetFlowAgentAccessPortForTest()
    const response = await write('flowAgent.cooperate', {
      projectId,
      nodeId: 'shape:agent',
      action: 'note',
      ...baseCollaboration
    })
    expect(response.status).toBe('failed')
    expect(response.error?.code).toBe('FLOW_AGENTS_UNAVAILABLE')
  })

  it('note 事件不触发模型预检，且落库时带 actor=external', async () => {
    const projectId = seedProject()
    const { cooperate, assertAgentScopeToolCalling } = stubPort()
    const response = await write('flowAgent.cooperate', {
      projectId,
      nodeId: 'shape:agent',
      action: 'note',
      ...baseCollaboration
    })
    expect(response.status, JSON.stringify(response.error)).toBe('completed')
    expect(assertAgentScopeToolCalling).not.toHaveBeenCalled()
    expect(cooperate).toHaveBeenCalledTimes(1)
    // 关键：外部写入必须可区分于人工输入
    expect((cooperate.mock.calls[0][0] as { actor?: string }).actor).toBe('external')
    expect((response.data as { revision: number }).revision).toBe(2)
  })

  it('discuss/revise 会真实调用模型，必须先过工具调用预检', async () => {
    const projectId = seedProject()
    const { assertAgentScopeToolCalling, cooperate } = stubPort()
    const discuss = await write('flowAgent.cooperate', {
      projectId,
      nodeId: 'shape:agent',
      action: 'discuss',
      ...baseCollaboration
    })
    expect(discuss.status, JSON.stringify(discuss.error)).toBe('completed')
    expect(assertAgentScopeToolCalling).toHaveBeenCalledWith(projectId, 'shape:agent')
    expect(cooperate).toHaveBeenCalledTimes(1)

    const revise = await write('flowAgent.cooperate', {
      projectId,
      nodeId: 'shape:agent',
      action: 'revise',
      ...baseCollaboration
    })
    expect(revise.status).toBe('completed')
    expect(assertAgentScopeToolCalling).toHaveBeenCalledTimes(2)
  })

  it('预检失败时不写任何协作事件（付费路径第一道闸门）', async () => {
    const projectId = seedProject()
    const { cooperate } = stubPort({
      assertAgentScopeToolCalling: vi.fn(async () => {
        // 真实预检抛的是 AgentRuntimeError（带 phase），映射为可判定的失败，
        // 而不是"未知结果"——因为此时还没写任何协作事件。
        throw new AgentRuntimeError('TOOL_CALLING_UNVERIFIED', 'validate')
      })
    })
    const response = await write('flowAgent.cooperate', {
      projectId,
      nodeId: 'shape:agent',
      action: 'discuss',
      ...baseCollaboration
    })
    expect(response.status).toBe('failed')
    expect(response.error?.code).toBe('TOOL_CALLING_UNVERIFIED')
    expect(cooperate).not.toHaveBeenCalled()
  })

  it('非法 action 与重复的 selectedOutputs 被同一 Schema 拒绝', async () => {
    const projectId = seedProject()
    stubPort()
    const badAction = await write('flowAgent.cooperate', {
      projectId,
      nodeId: 'shape:agent',
      action: 'approve',
      ...baseCollaboration
    })
    expect(badAction.error?.code).toBe('INVALID_INPUT')

    const ref = { assetId: 'a1', versionId: 'v1', sourceNodeId: 'shape:n', sourcePortId: 'p1' }
    const duplicated = await write('flowAgent.cooperate', {
      projectId,
      nodeId: 'shape:agent',
      action: 'submit',
      ...baseCollaboration,
      selectedOutputs: [ref, ref]
    })
    expect(duplicated.status).toBe('failed')
    expect(duplicated.error?.code).toBe('AGENT_INPUT_INVALID')
  })

  it('宿主回执缺任务视图时如实报错，不伪造成功', async () => {
    const projectId = seedProject()
    stubPort({ cooperate: vi.fn(async () => ({ task: null })) as never })
    const response = await write('flowAgent.cooperate', {
      projectId,
      nodeId: 'shape:agent',
      action: 'note',
      ...baseCollaboration
    })
    expect(response.status).toBe('failed')
    expect(response.error?.code).toBe('FLOW_AGENT_REPLY_INVALID')
  })
})
