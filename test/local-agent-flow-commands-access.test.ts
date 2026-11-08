// F8（二）Flow 命令账本协作外部接入测试：
// flow.command.lookup / flow.command.availability / flow.command.reconcile 的
// 参数校验、跨项目隔离、NOT_FOUND、幂等重放、取消确认分离、unknown 不报成功，
// 以及"外部不能改写账本既有事实"的断言。
//
// 夹具说明：用真实 SQLite + 真实 FlowCommandLedger 准备一条内部命令（模拟内部 Agent
// 已经 prepare 的命令），外部操作只通过 LocalAccessService 进入；预期的"已保存运行事实"
// 由测试写入项目快照，和内部桌面保存后的形态一致。真实 Electron 桌面段不在本文件范围。
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
import type {
  FlowCommandGrant,
  NodeExecuteCommand
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

interface Fixture {
  projectId: string
  command: NodeExecuteCommand
  grant: FlowCommandGrant
  ledger: FlowCommandLedger
  assetVersion: FlowAssetVersion
}

/** 准备一条**内部**账本命令：真实 ledger.prepare，等价于内部 Agent 已派发但尚未结算。 */
function seedFixture(name = '命令账本'): Fixture {
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
  const command: NodeExecuteCommand = {
    schemaVersion: 1,
    kind: 'node.execute',
    projectId: project.id,
    commandId: `cmd-${randomUUID()}`,
    taskId: `task-${randomUUID()}`,
    agentNodeId: agentId,
    targetNodeId: targetId,
    contractVersion: 1,
    expectedSemanticRevision: projectSemanticRevision(openProject(project.id)!),
    inputs: [{ targetPortId: 'in-value', assets: [assetVersion.ref] }],
    traceId: 'trace-fixture-command',
    spanId: 'span-fixture-command'
  }
  const ledger = new FlowCommandLedger(getDb(), openProject)
  const prepared = ledger.prepare(command)
  if (prepared.state !== 'ready') throw new Error('FLOW_COMMAND_FIXTURE_PREPARE_FAILED')
  return { projectId: project.id, command, grant: prepared.grant, ledger, assetVersion }
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
}

function ledgerRow(fixture: Fixture): LedgerRow {
  return getDb()
    .prepare('SELECT * FROM flow_commands WHERE project_id=? AND command_id=?')
    .get(fixture.projectId, fixture.command.commandId) as LedgerRow
}

function countRows(table: 'flow_commands' | 'flow_asset_versions'): number {
  return (getDb().prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n
}

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'canvas-flow-commands-access-test-'))
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
    !basename(directory).startsWith('canvas-flow-commands-access-test-')
  )
    throw new Error('FLOW_COMMANDS_ACCESS_TEST_CLEANUP_OUTSIDE_ISOLATION')
  rmSync(directory, { recursive: true, force: true })
})

describe('local Agent flow command ledger access', () => {
  it('registers lookup/availability/reconcile with effects and both CLI/MCP transports', () => {
    const expected: Array<[string, 'read' | 'write']> = [
      ['flow.command.lookup', 'read'],
      ['flow.command.availability', 'read'],
      ['flow.command.reconcile', 'write']
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
