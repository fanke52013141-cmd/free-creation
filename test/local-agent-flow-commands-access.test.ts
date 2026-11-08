// F8（二/收官）Flow 命令账本协作外部接入测试：
// lookup / availability / reconcile / check 的参数校验、跨项目隔离、NOT_FOUND、幂等重放、
// 取消确认分离、unknown 不报成功、"外部不能改写账本既有事实"；
// 以及 F8 收官的 dispatch（经共享权威端口 + 假渲染器）与 abort（准入条件矩阵）。
//
// 夹具说明：用真实 SQLite + 真实 FlowCommandLedger。内部命令由测试直接 prepare；
// 外部 dispatch 的账本实例通过 publishFlowCommandAccessPort 以"共享权威端口"注入，
// 假渲染器只模拟 check→执行→保存→commit 的账本事实，**不触达任何供应商**。
// 真实 Electron 桌面段不在本文件范围。
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { CanvasNode } from '../src/shared/types'
import { closeDb, getDataDir, getDb } from '../src/main/store/db'
import { createProject, openProject, saveProject } from '../src/main/store/projects.repo'
import { LocalAccessService } from '../src/main/agent-access/service'
import { setGatewayEventSink } from '../src/main/diagnostics/gateway-events'
import { FlowCommandLedger } from '../src/main/agent-flow/command-ledger'
import { FlowAssetStore } from '../src/main/agent-flow/asset-store'
import { projectSemanticRevision } from '../src/main/agent-flow/command-intent'
import { PROCESSOR_PORTS } from '../src/shared/agent-flow/processor-contract'
import { computeInputFingerprint } from '../src/shared/engine/input-fingerprint'
import {
  ACCESS_OPERATIONS,
  operationDirectory,
  type AccessOperationId
} from '../src/shared/agent-access/registry'
import {
  publishFlowCommandAccessPort,
  resetFlowCommandAccessPortForTest
} from '../src/main/agent-access/flow-command-bridge'
import type { AccessDesktop } from '../src/main/agent-access/desktop'
import {
  FlowCommandError,
  type CommandLookup,
  type FlowCommandGrant,
  type FlowCommandPrepareResult,
  type FlowCommandReceipt,
  type NodeExecuteCommand
} from '../src/shared/agent-flow/commands'
import type { FlowAssetVersion } from '../src/shared/agent-flow/assets'

let directory: string
let service: LocalAccessService
let active: string | null
const events: any[] = []
const originalDirectory = process.env.CANVAS_DATA_DIR
const key = (): string => `${Date.now()}:${randomUUID()}`

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

function shape(
  id: string,
  nodeType: string,
  text: string,
  config = ''
): { id: string; type: string; props: Record<string, unknown>; meta: Record<string, unknown> } {
  return {
    id,
    type: 'node-card',
    props: {
      nodeType,
      title: nodeType,
      config,
      text,
      mediaId: '',
      mediaPath: '',
      mediaMime: '',
      exec: 'idle',
      w: 340,
      h: 260
    },
    meta: {}
  }
}

function canvasNode(
  id: string,
  type: CanvasNode['type'],
  contractVersion: number,
  init: Partial<CanvasNode>
): CanvasNode {
  return {
    id,
    type,
    contractVersion,
    title: type,
    x: 0,
    y: 0,
    w: 340,
    h: 260,
    ports: [],
    params: {},
    content: { kind: 'empty' },
    exec: { status: 'idle' },
    meta: { source: 'input', createdAt: 1 },
    ...init
  }
}

interface CanvasFixture {
  projectId: string
  sourceId: string
  agentId: string
  targetId: string
  assetVersion: FlowAssetVersion
}

/** 建一张可派发的画布（源文本 + Agent + processor 目标 + 已登记固定资产），不含任何命令。 */
function seedCanvas(name = '命令画布'): CanvasFixture {
  const project = createProject(name)
  const sourceId = 'shape:src'
  const agentId = 'shape:agent'
  const targetId = 'shape:tgt'
  const agentConfig = {
    schemaVersion: 1,
    role: 'specialist',
    interactionMode: 'autonomous',
    skills: [],
    tools: [],
    allowedNodeIds: [targetId],
    maxSteps: 3,
    relations: []
  }
  const nodes: CanvasNode[] = [
    canvasNode(sourceId, 'text', 3, {
      title: '源文本',
      content: { kind: 'text', text: '外部不可见的源文本' }
    }),
    canvasNode(agentId, 'agent', 1, {
      title: '执行 Agent',
      content: { kind: 'text', text: '外部不可见的 Agent 目标' },
      params: { config: JSON.stringify(agentConfig) }
    }),
    canvasNode(targetId, 'processor', 1, {
      title: '处理目标',
      ports: [...PROCESSOR_PORTS.in, ...PROCESSOR_PORTS.out],
      params: { config: '{"operation":"pass"}' }
    })
  ]
  const edges = [
    {
      id: 'edge-1',
      from: { nodeId: sourceId, portId: 'out-text' },
      to: { nodeId: targetId, portId: 'in-value' }
    }
  ]
  saveProject({
    id: project.id,
    graph: { nodes, edges, groups: [] },
    tldrawSnapshot: {
      store: {
        [sourceId]: shape(sourceId, 'text', '外部不可见的源文本'),
        [agentId]: shape(agentId, 'agent', '外部不可见的 Agent 目标', JSON.stringify(agentConfig)),
        [targetId]: shape(targetId, 'processor', '', '{"operation":"pass"}')
      }
    }
  })
  const saved = openProject(project.id)!
  const assetVersion = new FlowAssetStore(getDb(), openProject).submit({
    projectId: project.id,
    nodeId: sourceId,
    portId: 'out-text',
    submissionId: `fixture-source:${project.id}`,
    expectedGraphVersion: saved.meta.graphVersion,
    traceId: 'trace-fixture-source',
    spanId: 'span-fixture-source'
  })
  return { projectId: project.id, sourceId, agentId, targetId, assetVersion }
}

interface Fixture extends CanvasFixture {
  command: NodeExecuteCommand
  grant: FlowCommandGrant
  ledger: FlowCommandLedger
}

/** 准备一条**内部**账本命令：真实 ledger.prepare，等价于内部 Agent 已派发但尚未结算。 */
function seedFixture(name = '命令账本'): Fixture {
  const canvas = seedCanvas(name)
  const command: NodeExecuteCommand = {
    schemaVersion: 1,
    kind: 'node.execute',
    projectId: canvas.projectId,
    commandId: `cmd-${randomUUID()}`,
    taskId: `task-${randomUUID()}`,
    agentNodeId: canvas.agentId,
    targetNodeId: canvas.targetId,
    contractVersion: 1,
    expectedSemanticRevision: projectSemanticRevision(openProject(canvas.projectId)!),
    inputs: [{ targetPortId: 'in-value', assets: [canvas.assetVersion.ref] }],
    traceId: 'trace-fixture-command',
    spanId: 'span-fixture-command'
  }
  const ledger = new FlowCommandLedger(getDb(), openProject)
  const prepared = ledger.prepare(command)
  if (prepared.state !== 'ready') throw new Error('FLOW_COMMAND_FIXTURE_PREPARE_FAILED')
  return { ...canvas, command, grant: prepared.grant, ledger }
}

/** 模拟内部执行桥已经保存成功/失败运行记录（与桌面保存后的快照形态一致）。 */
function savedRun(fixture: Fixture, status: 'success' | 'failed' = 'success'): void {
  const { projectId, command, grant, assetVersion } = fixture
  fixture.ledger.check({ projectId, commandId: command.commandId, leaseId: grant.leaseId })
  const file = openProject(projectId)!
  const snapshot = structuredClone(file.tldrawSnapshot) as {
    store: Record<string, { props: Record<string, string>; meta: Record<string, unknown> }>
  }
  const target = snapshot.store['shape:tgt']!
  target.meta = {
    ...target.meta,
    nodeRun: {
      runId: grant.runId,
      status,
      startedAt: 0,
      finishedAt: 1,
      commandId: command.commandId,
      commandLeaseId: grant.leaseId,
      nodeExecutionId: 'exec-fixture',
      fixedInputs: command.inputs,
      inputs: {
        'in-value': [
          {
            nodeId: 'shape:src',
            portId: 'out-text',
            assetId: assetVersion.ref.assetId,
            versionId: assetVersion.ref.versionId
          }
        ]
      },
      inputFingerprint: computeInputFingerprint({
        contractVersion: command.contractVersion,
        config: target.props.config,
        text: target.props.text,
        sources: [
          {
            portId: 'in-value',
            nodeId: 'shape:src',
            sourcePortId: 'out-text',
            value: assetVersion.value
          }
        ]
      }),
      outputPorts: status === 'success' ? ['out-value'] : []
    },
    nodeResult: JSON.stringify({ kind: 'text', text: '处理器正式输出' })
  }
  saveProject({
    id: projectId,
    graph: { nodes: file.nodes, edges: file.edges, groups: file.groups },
    tldrawSnapshot: snapshot
  })
}

/** 模拟内部任务已被停止（取消确认来源）：账本据 flow_agent_tasks 事实结算。 */
function stoppedAgentTask(fixture: Fixture): void {
  getDb()
    .prepare(
      'INSERT INTO flow_agent_tasks(thread, project_id, task_id, agent_node_id, snapshot_json, skills_json, state) VALUES (?,?,?,?,?,?,?)'
    )
    .run(
      `thread-${randomUUID()}`,
      fixture.projectId,
      fixture.command.taskId,
      'shape:agent',
      JSON.stringify({ taskId: fixture.command.taskId }),
      '[]',
      'cancelled'
    )
}

interface LedgerRow {
  project_id: string
  command_id: string
  state: string
  receipt_json: string
  lease_id: string
  run_id: string
  owner_session: string
  admitted: number
  principal: 'internal' | 'external'
}

function ledgerRow(fixture: Fixture): LedgerRow {
  return ledgerRowByCommand(fixture.projectId, fixture.command.commandId)
}

function ledgerRowByCommand(projectId: string, commandId: string): LedgerRow {
  return getDb()
    .prepare('SELECT * FROM flow_commands WHERE project_id=? AND command_id=?')
    .get(projectId, commandId) as LedgerRow
}

function countRows(
  table: 'flow_commands' | 'flow_asset_versions' | 'flow_asset_submissions'
): number {
  return (getDb().prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n
}

/** 用受控桌面桌面替身重建服务（dispatch 需要活动画布 + flush 握手）。 */
function withDesktop(desktop?: AccessDesktop): void {
  service = new LocalAccessService({
    instanceId: randomUUID(),
    appVersion: 'test',
    exportDirectory: join(getDataDir(), 'agent-exports'),
    activeProjectId: () => active,
    desktop
  })
}

/** 桌面替身：flush 只报告已保存版本（与真实 renderer 的 flush 回执同语义）。 */
function fakeDesktop(): AccessDesktop {
  return {
    run: async (request) => {
      if (request.action === 'flush') {
        const file = openProject(request.projectId)
        if (!file) throw new Error('TEST_PROJECT_MISSING')
        return { graphVersion: file.meta.graphVersion }
      }
      throw new Error('TEST_DESKTOP_ACTION_UNEXPECTED')
    },
    ask: async () => ({ authorized: false, code: 'TEST_NOT_AUTHORIZED' })
  }
}

/**
 * 假渲染器：只复现"收到 grant → check 准入 → 写已保存运行事实 → commit"的账本行为，
 * **不执行任何节点、不触达供应商**。测试用它模拟桌面端完成一条外部命令。
 */
interface FakeRenderer {
  ledger: FlowCommandLedger
  grants: FlowCommandGrant[]
  sent: number
}

function installFlowCommandPort(): FakeRenderer {
  const ledger = new FlowCommandLedger(getDb(), openProject)
  const renderer: FakeRenderer = { ledger, grants: [], sent: 0 }
  publishFlowCommandAccessPort({
    isActive: (projectId) => active === projectId,
    prepareExternal: (raw): FlowCommandPrepareResult => ledger.prepare(raw, 'external'),
    send: (grant): void => {
      renderer.sent += 1
      renderer.grants.push(grant)
    },
    abandonExternal: (input: CommandLookup): FlowCommandReceipt =>
      ledger.abandonExternal(input)
  })
  return renderer
}

/** 模拟渲染器执行成功：check（可选）→ 保存运行记录 → commit；返回账本回执。 */
function rendererExecute(
  renderer: FakeRenderer,
  grant: FlowCommandGrant,
  canvas: CanvasFixture,
  options: { admit?: boolean; status?: 'success' | 'failed' } = {}
): FlowCommandReceipt {
  const { command } = grant
  const status = options.status ?? 'success'
  if (options.admit !== false)
    renderer.ledger.check({
      projectId: command.projectId,
      commandId: command.commandId,
      leaseId: grant.leaseId
    })
  const file = openProject(command.projectId)!
  const snapshot = structuredClone(file.tldrawSnapshot) as {
    store: Record<string, { props: Record<string, string>; meta: Record<string, unknown> }>
  }
  const target = snapshot.store[canvas.targetId]!
  target.meta = {
    ...target.meta,
    nodeRun: {
      runId: grant.runId,
      status,
      startedAt: 0,
      finishedAt: 1,
      commandId: command.commandId,
      commandLeaseId: grant.leaseId,
      nodeExecutionId: 'exec-external',
      fixedInputs: command.inputs,
      inputs: {
        'in-value': [
          {
            nodeId: canvas.sourceId,
            portId: 'out-text',
            assetId: canvas.assetVersion.ref.assetId,
            versionId: canvas.assetVersion.ref.versionId
          }
        ]
      },
      inputFingerprint: computeInputFingerprint({
        contractVersion: command.contractVersion,
        config: target.props.config,
        text: target.props.text,
        sources: [
          {
            portId: 'in-value',
            nodeId: canvas.sourceId,
            sourcePortId: 'out-text',
            value: canvas.assetVersion.value
          }
        ]
      }),
      outputPorts: status === 'success' ? ['out-value'] : []
    },
    nodeResult: JSON.stringify({ kind: 'text', text: '处理器正式输出' })
  }
  saveProject({
    id: command.projectId,
    graph: { nodes: file.nodes, edges: file.edges, groups: file.groups },
    tldrawSnapshot: snapshot
  })
  return renderer.ledger.commit({
    projectId: command.projectId,
    commandId: command.commandId
  })
}

/** 一次合法的外部派发输入（指向 seedCanvas 的 Agent 与 processor 目标）。 */
function dispatchInput(canvas: CanvasFixture): Record<string, unknown> {
  return {
    projectId: canvas.projectId,
    agentNodeId: canvas.agentId,
    targetNodeId: canvas.targetId,
    contractVersion: 1,
    inputs: [{ targetPortId: 'in-value', assets: [canvas.assetVersion.ref] }],
    confirmPaidTarget: false
  }
}

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'canvas-flow-commands-access-test-'))
  process.env.CANVAS_DATA_DIR = directory
  active = null
  events.length = 0
  resetFlowCommandAccessPortForTest()
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
  resetFlowCommandAccessPortForTest()
  closeDb()
  setGatewayEventSink(null)
  process.env.CANVAS_DATA_DIR = originalDirectory
  if (originalDirectory === undefined) delete process.env.CANVAS_DATA_DIR
  if (
    resolve(directory, '..') !== resolve(tmpdir()) ||
    !basename(directory).startsWith('canvas-flow-commands-access-test-')
  )
    throw new Error('FLOW_COMMANDS_ACCESS_TEST_CLEANUP_OUTSIDE_ISOLATION')
  rmSync(directory, { recursive: true, force: true })
})

describe('local Agent flow command ledger access', () => {
  it('registers lookup/availability/reconcile/check/dispatch/abort with effects and both transports', () => {
    const expected: Array<[string, 'read' | 'write' | 'execute']> = [
      ['flow.command.lookup', 'read'],
      ['flow.command.availability', 'read'],
      ['flow.command.reconcile', 'write'],
      ['flow.command.check', 'read'],
      ['flow.command.dispatch', 'execute'],
      ['flow.command.abort', 'write']
    ]
    for (const [operationId, effect] of expected) {
      expect(Object.hasOwn(ACCESS_OPERATIONS, operationId)).toBe(true)
      expect(ACCESS_OPERATIONS[operationId as AccessOperationId].effect).toBe(effect)
    }
    const directory = operationDirectory() as Array<{
      operationId: string
      effect: string
      transports: string[]
    }>
    for (const [operationId, effect] of expected) {
      const entry = directory.find((item) => item.operationId === operationId)
      expect(entry).toMatchObject({ effect, transports: ['cli', 'mcp-stdio'] })
    }
    // prepare 不单独开放：外部"只准备不交付"会留下无法执行的占用，等价能力并入 dispatch。
    expect(ACCESS_OPERATIONS).not.toHaveProperty('flow.command.prepare')
  })

  it('rejects invalid input, hides unknown commands and isolates cross-project reads', async () => {
    const fixture = seedFixture()
    const lookup = await call('flow.command.lookup', {
      projectId: fixture.projectId,
      commandId: fixture.command.commandId
    })
    expect(lookup.status).toBe('completed')
    expect(lookup.data).toMatchObject({
      projectId: fixture.projectId,
      commandId: fixture.command.commandId,
      taskId: fixture.command.taskId,
      targetNodeId: 'shape:tgt',
      state: 'pending'
    })
    // 外部回执不携带命令输入清单/资产值
    expect((lookup.data as Record<string, unknown>).inputs).toBeUndefined()
    expect((lookup.data as { outputRefs: unknown[] }).outputRefs).toEqual([])

    // 非法参数：命令 ID 格式、未知字段
    expect(
      (
        await call('flow.command.lookup', {
          projectId: fixture.projectId,
          commandId: 'bad command id!'
        })
      ).error?.code
    ).toBe('INVALID_INPUT')
    expect(
      (
        await call('flow.command.lookup', {
          projectId: fixture.projectId,
          commandId: fixture.command.commandId,
          body: '私有正文'
        })
      ).error?.code
    ).toBe('INVALID_INPUT')
    expect(
      (await call('flow.command.availability', { projectId: fixture.projectId, nodeId: 'ghost' }))
        .error?.code
    ).toBe('INVALID_INPUT')

    // 未知命令 NOT_FOUND
    const ghost = await call('flow.command.lookup', {
      projectId: fixture.projectId,
      commandId: 'cmd-ghost'
    })
    expect(ghost.status).toBe('failed')
    expect(ghost.error?.code).toBe('NOT_FOUND')

    // 跨项目越权：项目 B 读不到项目 A 的命令，且不泄漏目标节点
    const other = createProject('另一个项目')
    const cross = await call('flow.command.lookup', {
      projectId: other.id,
      commandId: fixture.command.commandId
    })
    expect(cross.status).toBe('failed')
    expect(cross.error?.code).toBe('NOT_FOUND')
    expect(JSON.stringify(cross)).not.toContain('shape:tgt')
    expect(
      (await call('flow.command.availability', { projectId: other.id, nodeId: 'shape:tgt' }))
        .error?.code
    ).toBe('NODE_NOT_FOUND')

    // 未开放通道没有外部幽灵操作
    const cancel = await call(
      'flow.command.cancel',
      { projectId: fixture.projectId, taskId: fixture.command.taskId },
      key()
    )
    expect(cancel.error?.code).toBe('UNSUPPORTED_OPERATION')

    // reconcile 是写操作，必须带幂等键
    expect(
      (
        await call('flow.command.reconcile', {
          projectId: fixture.projectId,
          commandId: fixture.command.commandId
        })
      ).error?.code
    ).toBe('IDEMPOTENCY_REQUIRED')
  })

  it('gates availability with the same ledger occupancy/scope rules and never writes', async () => {
    const fixture = seedFixture()
    const before = ledgerRow(fixture)
    const commandsBefore = countRows('flow_commands')

    // 目标节点已被内部 pending 命令占用（与 GUI 手动运行前的同一门禁）
    const occupied = await call('flow.command.availability', {
      projectId: fixture.projectId,
      nodeId: 'shape:tgt'
    })
    expect(occupied.status).toBe('failed')
    expect(occupied.error?.code).toBe('FLOW_NODE_OCCUPIED')

    // 源节点空闲
    const free = await call('flow.command.availability', {
      projectId: fixture.projectId,
      nodeId: 'shape:src'
    })
    expect(free.status).toBe('completed')
    expect(free.data).toMatchObject({
      projectId: fixture.projectId,
      nodeId: 'shape:src',
      available: true
    })

    // 协调控制范围占用：非 agent 节点被 scope 覆盖时不可手动/外部执行
    getDb()
      .prepare(
        'INSERT INTO flow_coordination_runs(project_id, node_id, task_id, body_json) VALUES (?,?,?,?)'
      )
      .run(fixture.projectId, 'shape:agent', 'task-coord', '{"state":"running"}')
    getDb()
      .prepare('INSERT INTO flow_coordination_scope(project_id, node_id, task_id) VALUES (?,?,?)')
      .run(fixture.projectId, 'shape:src', 'task-coord')
    const controlled = await call('flow.command.availability', {
      projectId: fixture.projectId,
      nodeId: 'shape:src'
    })
    expect(controlled.error?.code).toBe('FLOW_CONTROL_OCCUPIED')

    // 只读：账本行与命令数不变
    expect(ledgerRow(fixture)).toEqual(before)
    expect(countRows('flow_commands')).toBe(commandsBefore)
  })

  it('never turns an unconfirmed command into success and never rewrites ledger facts', async () => {
    const fixture = seedFixture()
    const before = ledgerRow(fixture)
    const versionsBefore = countRows('flow_asset_versions')
    const replayKey = key()
    const first = await call(
      'flow.command.reconcile',
      { projectId: fixture.projectId, commandId: fixture.command.commandId },
      replayKey
    )
    expect(first.status).toBe('completed')
    expect(first.data).toMatchObject({
      projectId: fixture.projectId,
      commandId: fixture.command.commandId,
      state: 'pending',
      commitAttempted: true,
      reason: 'FLOW_SAVED_RUN_MISMATCH'
    })
    expect((first.data as { state: string }).state).not.toBe('committed')
    expect((first.data as { receipt: { state: string } }).receipt.state).toBe('pending')

    // 外部不能改写既有账本事实：状态/回执/租约/运行/所有者/准入位全部不变
    const after = ledgerRow(fixture)
    expect(after).toEqual(before)
    expect(after.state).toBe('pending')
    expect(after.admitted).toBe(0)

    // 同一幂等键重放原回执，且不重新执行 commit
    const replay = await call(
      'flow.command.reconcile',
      { projectId: fixture.projectId, commandId: fixture.command.commandId },
      replayKey
    )
    expect(replay.status).toBe('completed')
    expect(replay.data).toEqual(first.data)
    expect(replay.idempotencyKey).toBe(first.idempotencyKey)
    expect(ledgerRow(fixture)).toEqual(before)

    // 同键异参冲突
    const conflict = await call(
      'flow.command.reconcile',
      { projectId: fixture.projectId, commandId: 'cmd-other' },
      replayKey
    )
    expect(conflict.status).toBe('failed')
    expect(conflict.error?.code).toBe('IDEMPOTENCY_CONFLICT')

    // 新键再次核对：仍未确认，不会谎报成功；也不产生新命令/新输出
    const again = await call(
      'flow.command.reconcile',
      { projectId: fixture.projectId, commandId: fixture.command.commandId },
      key()
    )
    expect((again.data as { state: string }).state).toBe('pending')
    expect(countRows('flow_commands')).toBe(1)
    expect(countRows('flow_asset_versions')).toBe(versionsBefore)

    // 日志：账本阶段事件与外部生命周期共享同一 trace，且不含正文
    const completedEvents = events.filter(
      (event) =>
        event.event === 'command.operation.completed' &&
        event.attributes?.commandId === fixture.command.commandId
    )
    const startedEvents = events.filter(
      (event) =>
        event.event === 'command.operation.started' &&
        event.attributes?.commandId === fixture.command.commandId
    )
    expect(startedEvents).toHaveLength(2)
    expect(completedEvents).toHaveLength(2)
    // 幂等重放不再产生第二次账本阶段事件（上面两次 = 首次核对 + 新键再核对）
    expect(completedEvents[0]?.attributes?.state).toBe('pending')
    // 每次外部核对的一次 started/completed 共享同一 trace，并与应答 trace 一致
    expect(completedEvents.at(-1)?.traceId).toBe(startedEvents.at(-1)?.traceId)
    expect(completedEvents.at(-1)?.traceId).toBe(again.traceId)
    expect(events.some((event) => event.event === 'agent.access.started')).toBe(true)
    const serialized = JSON.stringify(events)
    expect(serialized).not.toContain('外部不可见的源文本')
    expect(serialized).not.toContain('外部不可见的 Agent 目标')
  })

  it('settles committed only from signature-matching saved facts and stays idempotent', async () => {
    const fixture = seedFixture()
    savedRun(fixture)
    const settleKey = key()
    const committed = await call(
      'flow.command.reconcile',
      { projectId: fixture.projectId, commandId: fixture.command.commandId },
      settleKey
    )
    expect(committed.status).toBe('completed')
    expect(committed.data).toMatchObject({
      projectId: fixture.projectId,
      commandId: fixture.command.commandId,
      state: 'committed',
      commitAttempted: true
    })
    const data = committed.data as {
      reason?: string
      receipt: {
        state: string
        nodeExecutionId?: string
        inputFingerprint?: string
        graphVersion?: number
        outputRefs: Array<{ assetId: string; versionId: string }>
      }
    }
    expect(data.reason).toBeUndefined()
    expect(data.receipt.state).toBe('committed')
    expect(data.receipt.nodeExecutionId).toBe('exec-fixture')
    expect(data.receipt.inputFingerprint).toMatch(/^v1:[0-9a-f]{16}$/)
    expect(data.receipt.outputRefs).toHaveLength(1)
    // 账本真实结算，且正式输出版本可从资产库读回
    expect(ledgerRow(fixture).state).toBe('committed')
    const version = new FlowAssetStore(getDb(), openProject).read(
      fixture.projectId,
      data.receipt.outputRefs[0]!.versionId
    )
    expect(version.value).toMatchObject({ kind: 'text' })
    const versionsAfterCommit = countRows('flow_asset_versions')

    // 同一幂等键重放原回执，不重复结算
    const replay = await call(
      'flow.command.reconcile',
      { projectId: fixture.projectId, commandId: fixture.command.commandId },
      settleKey
    )
    expect(replay.data).toEqual(committed.data)
    expect(countRows('flow_asset_versions')).toBe(versionsAfterCommit)

    // 终态命令再核对不再调用 commit，也不产生新版本
    const terminal = await call(
      'flow.command.reconcile',
      { projectId: fixture.projectId, commandId: fixture.command.commandId },
      key()
    )
    expect(terminal.data).toMatchObject({ state: 'committed', commitAttempted: false })
    expect(countRows('flow_asset_versions')).toBe(versionsAfterCommit)
    const lookup = await call('flow.command.lookup', {
      projectId: fixture.projectId,
      commandId: fixture.command.commandId
    })
    expect(lookup.data).toMatchObject({ state: 'committed', nodeExecutionId: 'exec-fixture' })
    expect((lookup.data as { outputRefs: unknown[] }).outputRefs).toHaveLength(1)

    // 外部核对不改写命令身份与租约事实
    const row = ledgerRow(fixture)
    expect(row.lease_id).toBe(fixture.grant.leaseId)
    expect(row.run_id).toBe(fixture.grant.runId)
  })

  it('previews settlement read-only: no ledger facts, receipts or output versions are written', async () => {
    const fixture = seedFixture()
    const before = ledgerRow(fixture)
    const versionsBefore = countRows('flow_asset_versions')
    const submissionsBefore = countRows('flow_asset_submissions')

    // 1) 没有已保存运行事实：预演如实给出"现在不能结算"的原因
    const blocked = await call('flow.command.check', {
      projectId: fixture.projectId,
      commandId: fixture.command.commandId
    })
    expect(blocked.status).toBe('completed')
    expect(blocked.data).toMatchObject({
      projectId: fixture.projectId,
      commandId: fixture.command.commandId,
      state: 'pending',
      alreadySettled: false,
      wouldSettle: false,
      reason: 'FLOW_SAVED_RUN_MISMATCH'
    })
    expect((blocked.data as { state: string }).state).not.toBe('committed')
    // 预演不落账：账本行与资产版本/提交记录全部不变
    expect(ledgerRow(fixture)).toEqual(before)
    expect(countRows('flow_asset_versions')).toBe(versionsBefore)
    expect(countRows('flow_asset_submissions')).toBe(submissionsBefore)

    // 2) 保存成功运行事实后：预演预测 committed，但仍不写账
    savedRun(fixture)
    const afterSavedRun = ledgerRow(fixture)
    const versionsAfterSavedRun = countRows('flow_asset_versions')
    const submissionsAfterSavedRun = countRows('flow_asset_submissions')
    const preview = await call('flow.command.check', {
      projectId: fixture.projectId,
      commandId: fixture.command.commandId
    })
    expect(preview.status).toBe('completed')
    expect(preview.data).toMatchObject({
      state: 'pending',
      alreadySettled: false,
      wouldSettle: true,
      wouldResultState: 'committed'
    })
    // 预演中的资产写入已随事务回滚：命令仍 pending，没有第二个输出版本/提交记录
    expect(ledgerRow(fixture)).toEqual(afterSavedRun)
    expect(ledgerRow(fixture).state).toBe('pending')
    expect(countRows('flow_asset_versions')).toBe(versionsAfterSavedRun)
    expect(countRows('flow_asset_submissions')).toBe(submissionsAfterSavedRun)

    // 3) 真正的落账只由 reconcile 完成（check 只是预演）
    const settled = await call(
      'flow.command.reconcile',
      { projectId: fixture.projectId, commandId: fixture.command.commandId },
      key()
    )
    expect(settled.data).toMatchObject({ state: 'committed', commitAttempted: true })
    expect(ledgerRow(fixture).state).toBe('committed')
    expect(countRows('flow_asset_versions')).toBe(versionsAfterSavedRun + 1)

    // 4) 终态命令的 check 如实报告 alreadySettled，不再预演、不产生新版本
    const settledCheck = await call('flow.command.check', {
      projectId: fixture.projectId,
      commandId: fixture.command.commandId
    })
    expect(settledCheck.data).toMatchObject({
      state: 'committed',
      alreadySettled: true,
      wouldSettle: false
    })
    expect((settledCheck.data as Record<string, unknown>).reason).toBeUndefined()
    expect(countRows('flow_asset_versions')).toBe(versionsAfterSavedRun + 1)

    // 5) 未知命令 NOT_FOUND、跨项目隔离与非法参数
    const ghost = await call('flow.command.check', {
      projectId: fixture.projectId,
      commandId: 'cmd-ghost'
    })
    expect(ghost.status).toBe('failed')
    expect(ghost.error?.code).toBe('NOT_FOUND')
    const other = createProject('check 越权')
    const cross = await call('flow.command.check', {
      projectId: other.id,
      commandId: fixture.command.commandId
    })
    expect(cross.status).toBe('failed')
    expect(cross.error?.code).toBe('NOT_FOUND')
    expect(
      (
        await call('flow.command.check', {
          projectId: fixture.projectId,
          commandId: 'bad command id!'
        })
      ).error?.code
    ).toBe('INVALID_INPUT')

    // 6) 取消确认的预演与 reconcile 结论一致（不会把 unknown/skipped 报成成功）
    const stopped = seedFixture('check 取消预演')
    stoppedAgentTask(stopped)
    const stoppedPreview = await call('flow.command.check', {
      projectId: stopped.projectId,
      commandId: stopped.command.commandId
    })
    expect(stoppedPreview.data).toMatchObject({
      state: 'pending',
      alreadySettled: false,
      wouldSettle: true,
      wouldResultState: 'skipped'
    })
    expect(ledgerRow(stopped).state).toBe('pending')
    const stoppedSettle = await call(
      'flow.command.reconcile',
      { projectId: stopped.projectId, commandId: stopped.command.commandId },
      key()
    )
    expect((stoppedSettle.data as { state: string }).state).toBe(
      (stoppedPreview.data as { wouldResultState: string }).wouldResultState
    )
    expect((stoppedSettle.data as { state: string }).state).not.toBe('committed')
  })

  it('dispatches through the shared authoritative port with main identity and no output before renderer commit', async () => {
    const canvas = seedCanvas('外部派发')
    active = canvas.projectId
    const renderer = installFlowCommandPort()
    withDesktop(fakeDesktop())
    const versionsBefore = countRows('flow_asset_versions')
    const dispatched = await call('flow.command.dispatch', dispatchInput(canvas), key())
    expect(dispatched.status).toBe('completed')
    const data = dispatched.data as {
      projectId: string
      commandId: string
      taskId: string
      runId: string
      targetNodeId: string
      graphVersion: number
      accepted: true
      state: 'pending'
    }
    expect(data).toMatchObject({
      projectId: canvas.projectId,
      targetNodeId: canvas.targetId,
      accepted: true,
      state: 'pending'
    })
    // 运行身份由 main 生成（UUID），外部不能自造
    expect(data.commandId).toMatch(/^[0-9a-f-]{36}$/)
    expect(data.taskId).toMatch(/^[0-9a-f-]{36}$/)
    expect(data.runId).toMatch(/^[0-9a-f-]{36}$/)
    expect(data.graphVersion).toBe(openProject(canvas.projectId)!.meta.graphVersion)
    expect(
      (
        await call(
          'flow.command.dispatch',
          { ...dispatchInput(canvas), commandId: 'external-choice' },
          key()
        )
      ).error?.code
    ).toBe('INVALID_INPUT')

    // 账本：principal=external、同一权威会话、pending、未准入
    const row = ledgerRowByCommand(canvas.projectId, data.commandId)
    expect(row.principal).toBe('external')
    expect(row.owner_session).toBe(renderer.ledger.sessionId)
    expect(row.state).toBe('pending')
    expect(row.admitted).toBe(0)
    expect(renderer.sent).toBe(1)

    // 受理阶段（渲染器尚未提交运行事实）不产生任何输出版本
    expect(countRows('flow_asset_versions')).toBe(versionsBefore)
    const lookup = await call('flow.command.lookup', {
      projectId: canvas.projectId,
      commandId: data.commandId
    })
    expect(lookup.data).toMatchObject({ state: 'pending', targetNodeId: canvas.targetId })
    const checked = await call('flow.command.check', {
      projectId: canvas.projectId,
      commandId: data.commandId
    })
    expect(checked.data).toMatchObject({
      state: 'pending',
      wouldSettle: false,
      reason: 'FLOW_SAVED_RUN_MISMATCH'
    })
    expect(countRows('flow_asset_versions')).toBe(versionsBefore)

    // 假渲染器完成 check→保存→commit 后，账本事实才出现正式输出
    const receipt = rendererExecute(renderer, renderer.grants[0]!, canvas)
    expect(receipt.state).toBe('committed')
    expect(countRows('flow_asset_versions')).toBe(versionsBefore + 1)
    const settled = await call(
      'flow.command.reconcile',
      { projectId: canvas.projectId, commandId: data.commandId },
      key()
    )
    expect(settled.data).toMatchObject({ state: 'committed', commitAttempted: false })
    expect((settled.data as { receipt: { outputRefs: unknown[] } }).receipt.outputRefs).toHaveLength(
      1
    )
  })

  it('rejects dispatch off the active canvas, unconfirmed paid targets and missing shared port', async () => {
    const canvas = seedCanvas('派发拒绝')
    const renderer = installFlowCommandPort()
    withDesktop(fakeDesktop())

    // 非活动画布：必须在 prepare 前拒绝，不产生命令、不下发 grant
    active = null
    const notActive = await call('flow.command.dispatch', dispatchInput(canvas), key())
    expect(notActive.status).toBe('failed')
    expect(notActive.error?.code).toBe('ACTIVE_PROJECT_REQUIRED')
    expect(countRows('flow_commands')).toBe(0)
    expect(renderer.sent).toBe(0)

    // 付费族目标：未确认时在 prepare 前拒绝（不创建命令，也不会触达供应商）
    const paid = createProject('付费目标')
    const paidAgentConfig = JSON.stringify({
      schemaVersion: 1,
      role: 'specialist',
      interactionMode: 'autonomous',
      skills: [],
      tools: [],
      allowedNodeIds: ['shape:paid'],
      maxSteps: 3,
      relations: []
    })
    saveProject({
      id: paid.id,
      graph: {
        nodes: [
          canvasNode('shape:agent', 'agent', 1, {
            title: '付费执行 Agent',
            params: { config: paidAgentConfig }
          }),
          canvasNode('shape:paid', 'image-gen', 3, {
            title: '生图目标',
            params: { config: '{}' }
          })
        ],
        edges: [],
        groups: []
      },
      tldrawSnapshot: {
        store: {
          'shape:agent': shape('shape:agent', 'agent', '', paidAgentConfig),
          'shape:paid': shape('shape:paid', 'image-gen', '')
        }
      }
    })
    active = paid.id
    const paidInput = {
      projectId: paid.id,
      agentNodeId: 'shape:agent',
      targetNodeId: 'shape:paid',
      contractVersion: 3,
      inputs: [],
      confirmPaidTarget: false
    }
    const paidRefused = await call('flow.command.dispatch', paidInput, key())
    expect(paidRefused.status).toBe('failed')
    expect(paidRefused.error?.code).toBe('PAID_TARGET_CONFIRM_REQUIRED')
    expect(countRows('flow_commands')).toBe(0)
    expect(renderer.sent).toBe(0)
    // 确认后越过付费闸门，但目标配置在账本契约校验失败 → 仍不产生命令、不触达渲染器
    const afterConfirm = await call(
      'flow.command.dispatch',
      { ...paidInput, confirmPaidTarget: true },
      key()
    )
    expect(afterConfirm.status).toBe('failed')
    expect(afterConfirm.error?.code).toBe('FLOW_CONTRACT_MISMATCH')
    expect(countRows('flow_commands')).toBe(0)
    expect(renderer.sent).toBe(0)

    // 端口未发布：如实拒绝（不降级成本地替身）
    resetFlowCommandAccessPortForTest()
    active = canvas.projectId
    const noPort = await call('flow.command.dispatch', dispatchInput(canvas), key())
    expect(noPort.status).toBe('failed')
    expect(noPort.error?.code).toBe('FLOW_COMMANDS_UNAVAILABLE')
    const noPortAbort = await call(
      'flow.command.abort',
      { projectId: canvas.projectId, commandId: 'cmd-none' },
      key()
    )
    expect(noPortAbort.error?.code).toBe('FLOW_COMMANDS_UNAVAILABLE')
  })

  it('replays dispatch idempotently without a second command or second grant', async () => {
    const canvas = seedCanvas('幂等派发')
    active = canvas.projectId
    const renderer = installFlowCommandPort()
    withDesktop(fakeDesktop())
    const replayKey = key()
    const first = await call('flow.command.dispatch', dispatchInput(canvas), replayKey)
    const replay = await call('flow.command.dispatch', dispatchInput(canvas), replayKey)
    expect(replay.status).toBe('completed')
    expect(replay.data).toEqual(first.data)
    expect(countRows('flow_commands')).toBe(1)
    expect(renderer.sent).toBe(1)
    // 同键异参冲突：不会创建第二条命令
    const conflict = await call(
      'flow.command.dispatch',
      { ...dispatchInput(canvas), contractVersion: 2 },
      replayKey
    )
    expect(conflict.error?.code).toBe('IDEMPOTENCY_CONFLICT')
    expect(countRows('flow_commands')).toBe(1)
    // 新键再派发：同一项目仍有在途命令，按既有占用策略如实 RESOURCE_BUSY（不并发出第二条）
    const whilePending = await call('flow.command.dispatch', dispatchInput(canvas), key())
    expect(whilePending.status).toBe('failed')
    expect(whilePending.error?.code).toBe('RESOURCE_BUSY')
    expect(countRows('flow_commands')).toBe(1)
    expect(renderer.sent).toBe(1)
  })

  it('aborts only unadmitted external commands and never rewrites admitted or terminal facts', async () => {
    const canvas = seedCanvas('外部放弃')
    active = canvas.projectId
    const renderer = installFlowCommandPort()
    withDesktop(fakeDesktop())

    // 1) pending + admitted=0：可放弃，释放占用
    const first = await call('flow.command.dispatch', dispatchInput(canvas), key())
    const firstId = (first.data as { commandId: string }).commandId
    const aborted = await call(
      'flow.command.abort',
      { projectId: canvas.projectId, commandId: firstId },
      key()
    )
    expect(aborted.status).toBe('completed')
    expect(aborted.data).toMatchObject({
      state: 'skipped',
      code: 'FLOW_EXTERNAL_ABANDONED',
      outputRefs: []
    })
    expect(ledgerRowByCommand(canvas.projectId, firstId)).toMatchObject({
      state: 'skipped',
      principal: 'external'
    })
    const available = await call('flow.command.availability', {
      projectId: canvas.projectId,
      nodeId: canvas.targetId
    })
    expect(available.status).toBe('completed')
    // 重复放弃幂等返回原回执（新的幂等键也不产生第二次迁移）
    const again = await call(
      'flow.command.abort',
      { projectId: canvas.projectId, commandId: firstId },
      key()
    )
    expect(again.status).toBe('completed')
    expect(again.data).toMatchObject({ state: 'skipped', code: 'FLOW_EXTERNAL_ABANDONED' })
    // 放弃后 reconcile 不再结算（终态 skipped，commitAttempted=false）
    const reconciled = await call(
      'flow.command.reconcile',
      { projectId: canvas.projectId, commandId: firstId },
      key()
    )
    expect(reconciled.data).toMatchObject({ state: 'skipped', commitAttempted: false })
    // 迟到的渲染器准入不能复活已放弃命令
    expect(() =>
      renderer.ledger.check({
        projectId: canvas.projectId,
        commandId: firstId,
        leaseId: renderer.grants[0]!.leaseId
      })
    ).toThrow()

    // 2) 已准入（admitted=1）：拒绝，且不改状态
    const second = await call('flow.command.dispatch', dispatchInput(canvas), key())
    const secondId = (second.data as { commandId: string }).commandId
    renderer.ledger.check({
      projectId: canvas.projectId,
      commandId: secondId,
      leaseId: renderer.grants[1]!.leaseId
    })
    const admittedAbort = await call(
      'flow.command.abort',
      { projectId: canvas.projectId, commandId: secondId },
      key()
    )
    expect(admittedAbort.status).toBe('failed')
    expect(admittedAbort.error?.code).toBe('FLOW_COMMAND_ALREADY_ADMITTED')
    expect(ledgerRowByCommand(canvas.projectId, secondId).state).toBe('pending')
    // 已执行并 committed：一律拒绝，账本事实完全不变
    rendererExecute(renderer, renderer.grants[1]!, canvas, { admit: false })
    const committedRow = ledgerRowByCommand(canvas.projectId, secondId)
    expect(committedRow.state).toBe('committed')
    const committedAbort = await call(
      'flow.command.abort',
      { projectId: canvas.projectId, commandId: secondId },
      key()
    )
    expect(committedAbort.status).toBe('failed')
    expect(committedAbort.error?.code).toBe('FLOW_COMMAND_NOT_PENDING')
    expect(ledgerRowByCommand(canvas.projectId, secondId)).toEqual(committedRow)

    // 3) unknown + admitted=0：从未准入，可放弃
    const third = await call('flow.command.dispatch', dispatchInput(canvas), key())
    const thirdId = (third.data as { commandId: string }).commandId
    renderer.ledger.unknown({
      projectId: canvas.projectId,
      commandId: thirdId,
      leaseId: renderer.grants[2]!.leaseId
    })
    expect(ledgerRowByCommand(canvas.projectId, thirdId).state).toBe('unknown')
    const unknownAbort = await call(
      'flow.command.abort',
      { projectId: canvas.projectId, commandId: thirdId },
      key()
    )
    expect(unknownAbort.data).toMatchObject({
      state: 'skipped',
      code: 'FLOW_EXTERNAL_ABANDONED'
    })

    // 4) unknown + admitted=1：可能已执行，拒绝放弃（必须 reconcile 核对）
    const fourth = await call('flow.command.dispatch', dispatchInput(canvas), key())
    const fourthId = (fourth.data as { commandId: string }).commandId
    renderer.ledger.check({
      projectId: canvas.projectId,
      commandId: fourthId,
      leaseId: renderer.grants[3]!.leaseId
    })
    renderer.ledger.unknown({
      projectId: canvas.projectId,
      commandId: fourthId,
      leaseId: renderer.grants[3]!.leaseId
    })
    expect(ledgerRowByCommand(canvas.projectId, fourthId)).toMatchObject({
      state: 'unknown',
      admitted: 1
    })
    const unknownAdmittedAbort = await call(
      'flow.command.abort',
      { projectId: canvas.projectId, commandId: fourthId },
      key()
    )
    expect(unknownAdmittedAbort.error?.code).toBe('FLOW_COMMAND_ALREADY_ADMITTED')
    expect(ledgerRowByCommand(canvas.projectId, fourthId).state).toBe('unknown')

    // 5) 内部命令：外部不能放弃（principal 不是 external）
    const internal = seedFixture('内部命令不可放弃')
    const internalAbort = await call(
      'flow.command.abort',
      { projectId: internal.projectId, commandId: internal.command.commandId },
      key()
    )
    expect(internalAbort.status).toBe('failed')
    expect(internalAbort.error?.code).toBe('FLOW_COMMAND_NOT_EXTERNAL')
    expect(ledgerRow(internal).state).toBe('pending')

    // 6) 未知命令 / 跨项目：NOT_FOUND，且不泄漏命令事实
    const ghost = await call(
      'flow.command.abort',
      { projectId: canvas.projectId, commandId: 'cmd-ghost' },
      key()
    )
    expect(ghost.error?.code).toBe('NOT_FOUND')
    const cross = await call(
      'flow.command.abort',
      { projectId: internal.projectId, commandId: thirdId },
      key()
    )
    expect(cross.error?.code).toBe('NOT_FOUND')
  })

  it('cleans up a definite pre-delivery failure and reports unknown for an unconfirmed delivery', async () => {
    const canvas = seedCanvas('下发失败')
    active = canvas.projectId
    const ledger = new FlowCommandLedger(getDb(), openProject)
    let mode: 'inactive' | 'unknown' = 'inactive'
    publishFlowCommandAccessPort({
      isActive: (projectId) => active === projectId,
      prepareExternal: (raw) => ledger.prepare(raw, 'external'),
      send: () => {
        if (mode === 'inactive')
          throw new FlowCommandError('FLOW_PROJECT_INACTIVE', 'dispatch')
        throw new Error('TEST_DELIVERY_LOST')
      },
      abandonExternal: (input) => ledger.abandonExternal(input)
    })
    withDesktop(fakeDesktop())

    // 确定未下发（活动画布/窗口判空失败）：放弃未准入命令释放占用，本次按 failed 报告
    const failed = await call('flow.command.dispatch', dispatchInput(canvas), key())
    expect(failed.status).toBe('failed')
    expect(failed.error?.code).toBe('FLOW_PROJECT_INACTIVE')
    expect(
      getDb().prepare('SELECT state, principal FROM flow_commands').all()
    ).toEqual([{ state: 'skipped', principal: 'external' }])
    expect(
      (
        await call('flow.command.availability', {
          projectId: canvas.projectId,
          nodeId: canvas.targetId
        })
      ).status
    ).toBe('completed')

    // 下发结果不确定：返回 unknown（保留 pending，由 arm 定时器/外部核对处理），绝不宣告成功
    mode = 'unknown'
    const unconfirmed = await call('flow.command.dispatch', dispatchInput(canvas), key())
    expect(unconfirmed.status).toBe('unknown')
    expect(unconfirmed.error?.code).toBe('OUTCOME_UNKNOWN')
    expect(
      getDb().prepare("SELECT state FROM flow_commands WHERE state='pending'").all()
    ).toHaveLength(1)
  })

  it('keeps cancel confirmation separate: stopped tasks settle skipped/unknown, never success', async () => {
    // 未准入（admitted=0）→ skipped；已准入（admitted=1）→ unknown
    const notAdmitted = seedFixture('取消未准入')
    stoppedAgentTask(notAdmitted)
    const skipped = await call(
      'flow.command.reconcile',
      { projectId: notAdmitted.projectId, commandId: notAdmitted.command.commandId },
      key()
    )
    expect(skipped.status).toBe('completed')
    expect(skipped.data).toMatchObject({ state: 'skipped', commitAttempted: true })
    expect(
      (skipped.data as { receipt: { code?: string; state: string } }).receipt
    ).toMatchObject({ state: 'skipped', code: 'FLOW_TASK_STOPPED_BEFORE_ADMISSION' })
    expect((skipped.data as { state: string }).state).not.toBe('committed')
    expect(ledgerRow(notAdmitted).state).toBe('skipped')

    const admitted = seedFixture('取消已准入')
    admitted.ledger.check({
      projectId: admitted.projectId,
      commandId: admitted.command.commandId,
      leaseId: admitted.grant.leaseId
    })
    stoppedAgentTask(admitted)
    const unknown = await call(
      'flow.command.reconcile',
      { projectId: admitted.projectId, commandId: admitted.command.commandId },
      key()
    )
    expect(unknown.status).toBe('completed')
    expect(unknown.data).toMatchObject({ state: 'unknown', commitAttempted: true })
    expect((unknown.data as { state: string }).state).not.toBe('committed')
    expect(ledgerRow(admitted).state).toBe('unknown')
    // 同一事实再次核对（新键）仍是 unknown，不会谎报成功
    const again = await call(
      'flow.command.reconcile',
      { projectId: admitted.projectId, commandId: admitted.command.commandId },
      key()
    )
    expect((again.data as { state: string }).state).toBe('unknown')

    // 外部 run.cancel 只作用于 external_runs；它不会接管内部 Flow 命令（无伪造取消确认）
    const cancel = await call(
      'run.cancel',
      { projectId: admitted.projectId, taskId: admitted.command.taskId },
      key()
    )
    expect(cancel.status).toBe('failed')
    expect(cancel.error?.code).toBe('NOT_FOUND')
    // 内部未知命令仍保持账本事实，未被外部取消改写
    expect(ledgerRow(admitted).state).toBe('unknown')
  })
})
