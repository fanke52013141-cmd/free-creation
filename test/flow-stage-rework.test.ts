import { afterEach, describe, expect, it, vi } from 'vitest'
import Database from 'better-sqlite3'
import type { CanvasNode, ProjectFile } from '../src/shared/types'
import { migrateDatabase } from '../src/main/store/db-migrations'
import { FlowCoordinatorHost } from '../src/main/agent-flow/coordinator-host'
import { FlowAgentDesktopHost } from '../src/main/agent-flow/desktop-host'
import { FlowCommandLedger } from '../src/main/agent-flow/command-ledger'
import { PROCESSOR_PORTS } from '../src/shared/agent-flow/processor-contract'
import { computeInputFingerprint } from '../src/shared/engine/input-fingerprint'
import type { AgentModelPort } from '../src/main/agent-flow/runtime'
import type { FlowAgentReply } from '../src/shared/agent-flow/desktop-tasks'
import { setGatewayEventSink } from '../src/main/diagnostics/gateway-events'

/**
 * AF-05 质量与返工：阶段交付验收记录持久化；局部返工只重跑受影响阶段（上游不重跑）；
 * 旧交付保留为历史、下游标过期；返工轮次有界；在途命令未结算拒绝。
 */
const dbs: Database.Database[] = []
afterEach(() => {
  vi.restoreAllMocks()
  dbs.splice(0).forEach((db) => db.close())
  setGatewayEventSink(null)
})
const input = {
  projectId: 'p', nodeId: 'main', requestId: 'flow-rw-1',
  traceId: 'trace', spanId: 'span', action: 'start' as const
}

function fixture() {
  const db = new Database(':memory:')
  dbs.push(db)
  migrateDatabase(db)
  db.prepare('INSERT INTO projects(id,name,created_at,updated_at) VALUES (?,?,0,0)').run('p', 'isolated')
  const shape = (id: string, type: string, text = '', config: object = {}) => ({
    id, type: 'node-card',
    props: { nodeType: type, title: id, config: JSON.stringify(config), text, mediaId: '', mediaPath: '', mediaMime: '', w: 340, h: 260, exec: 'idle' },
    meta: {} as Record<string, unknown>
  })
  const cfg = (role: string, ids: string[]) => ({
    schemaVersion: 1, role, interactionMode: 'autonomous', modelDefinitionId: 'fixture',
    skills: [], tools: [{ id: role === 'coordinator' ? 'agent.dispatch' : 'node.execute', version: '1' }],
    allowedNodeIds: ids, maxSteps: 16, relations: [] as object[]
  })
  const mainConfig = {
    ...cfg('coordinator', ['first', 'second']),
    executionMode: 'fixed-order',
    stages: [
      { stageKey: 'organize', nodeId: 'first', goal: '整理', completion: '交付整理' },
      { stageKey: 'write', nodeId: 'second', goal: '写作', completion: '交付成稿' }
    ]
  }
  mainConfig.relations = [{ relationId: 'state', kind: 'observes', sourceNodeId: 'main', targetNodeId: 'state' }]
  const events = ['flow.started', 'agent.dispatched', 'agent.completed', 'human.wait', 'human.continue', 'flow.paused', 'flow.completed', 'flow.rework']
  const stateConfig = {
    schemaVersion: 1, initialState: 'draft', states: ['draft', 'working', 'waiting', 'completed'],
    transitions: [
      { from: 'draft', event: 'flow.started', to: 'working' },
      ...events.filter((e) => e !== 'flow.started').map((event) => ({
        from: 'working', event,
        to: event === 'flow.completed' ? 'completed' : ['human.wait', 'flow.paused'].includes(event) ? 'waiting' : 'working'
      })),
      { from: 'waiting', event: 'human.continue', to: 'working' },
      { from: 'completed', event: 'flow.rework', to: 'working' },
      { from: 'waiting', event: 'flow.rework', to: 'working' }
    ],
    relations: []
  }
  const shapes = [
    shape('material', 'text', 'private-source'),
    shape('main', 'agent', '固定任务', mainConfig),
    shape('first', 'agent', '整理', cfg('specialist', ['process-first'])),
    shape('second', 'agent', '写作', cfg('specialist', ['process-second'])),
    shape('process-first', 'processor', '', { operation: 'pass' }),
    shape('process-second', 'processor', '', { operation: 'pass' }),
    shape('state', 'state-machine', '', stateConfig)
  ]
  const byId = Object.fromEntries(shapes.map((s) => [s.id, s]))
  const node = (s: (typeof shapes)[number]): CanvasNode => ({
    id: s.id, type: s.props.nodeType as CanvasNode['type'], contractVersion: 1, title: s.props.title,
    x: 0, y: 0, w: 340, h: 260,
    ports: s.props.nodeType === 'processor' ? [...PROCESSOR_PORTS.in, ...PROCESSOR_PORTS.out]
      : s.props.nodeType === 'agent' || s.props.nodeType === 'text'
        ? [{ id: 'out-text', name: 'text', dir: 'out', type: 'text', cardinality: 'one', required: true }] : [],
    params: { config: s.props.config },
    content: s.props.text ? { kind: 'text', text: s.props.text } : { kind: 'empty' },
    exec: { status: 'idle' }, meta: { source: 'input', createdAt: 0 }
  })
  const edge = (from: string, fromPort: string, to: string, toPort: string) => ({
    id: `edge-${from}-${to}`, from: { nodeId: from, portId: fromPort }, to: { nodeId: to, portId: toPort }
  })
  const file: ProjectFile = {
    version: 1, meta: { id: 'p', name: 'isolated', createdAt: 0, updatedAt: 0, graphVersion: 1 },
    nodes: shapes.map(node),
    edges: [
      edge('material', 'out-text', 'first', 'in-text'),
      edge('material', 'out-text', 'process-first', 'in-value'),
      edge('first', 'out-text', 'second', 'in-text'),
      edge('first', 'out-text', 'process-second', 'in-value')
    ],
    groups: [], tldrawSnapshot: { store: byId }
  }
  const open = (id: string) => (id === 'p' ? file : null)
  const ledger = new FlowCommandLedger(db, open)
  let executions = 0
  const host = new FlowAgentDesktopHost(db, open, {
    ledger, isActive: () => true,
    deliver: async (grant) => {
      executions++
      const c = grant.command, target = byId[c.targetNodeId], fixed = grant.inputs
      ledger.check({ projectId: c.projectId, commandId: c.commandId, leaseId: grant.leaseId })
      target.meta.nodeRun = {
        runId: grant.runId, status: 'success', startedAt: 0, finishedAt: 1,
        commandId: c.commandId, commandLeaseId: grant.leaseId, nodeExecutionId: `execution-${executions}`,
        fixedInputs: c.inputs,
        inputs: Object.fromEntries(fixed.map((p) => [p.targetPortId, p.versions.map((v, i) => ({
          nodeId: p.sources![i].nodeId, portId: p.sources![i].portId, assetId: v.ref.assetId, versionId: v.ref.versionId
        }))])),
        inputFingerprint: computeInputFingerprint({
          contractVersion: 1, config: target.props.config, text: target.props.text,
          sources: fixed.flatMap((p) => p.versions.map((v, i) => ({
            portId: p.targetPortId, nodeId: p.sources![i].nodeId, sourcePortId: p.sources![i].portId, value: v.value
          })))
        }),
        outputPorts: ['out-value']
      }
      target.meta.nodeResult = JSON.stringify(fixed[0].versions[0].value)
      file.meta.graphVersion++
      ledger.commit({ projectId: c.projectId, commandId: c.commandId })
    }
  }, async (): Promise<AgentModelPort> => ({
    decide: async (ctx) =>
      ctx.receipts.length < 2
        ? { kind: 'execute', targetNodeId: ctx.targets[0].nodeId }
        : { kind: 'finish', outputs: ctx.receipts.at(-1)!.outputRefs }
  }))
  const publish = async (id: string, reply: FlowAgentReply) => {
    const s = byId[id]
    s.meta.agentTask = JSON.stringify(reply.task)
    s.meta.nodeRun = { inputs: {}, runId: reply.task.taskId, startedAt: 0, finishedAt: 1, status: reply.task.state === 'completed' ? 'success' : 'skipped' }
    s.meta.nodeResult = reply.task.state === 'completed'
      ? JSON.stringify({ schemaVersion: 1, taskId: reply.task.taskId, outputs: reply.outputs, refs: reply.refs })
      : null
    file.meta.graphVersion++
  }
  const coordinator = new FlowCoordinatorHost(db, open, () => true, host,
    async () => ({ decide: async () => { throw new Error('no coordinator model') }, coordinate: async () => { throw new Error('FIXED_ORDER_NO_MODEL') } }),
    async (grant) => { await publish(grant.nodeId, await host.run({ ...input, nodeId: grant.nodeId, requestId: grant.taskId, expectedTaskId: grant.taskId })) }
  )
  host.setCoordinator(coordinator)
  return { db, file, byId, host, coordinator, count: () => executions }
}

describe('AF-05 stage delivery acceptance + local rework', () => {
  it('完成后持久化阶段交付验收记录（绑定产物/定义修订）', async () => {
    const f = fixture()
    await f.host.run(input)
    const run = f.coordinator.store.latest('p', 'main')!
    expect(run.state).toBe('completed')
    expect(run.stageDeliveries).toHaveLength(2)
    const organize = run.stageDeliveries!.find((r) => r.stageKey === 'organize')!
    expect(organize.outputRefs.length).toBeGreaterThan(0)
    expect(organize.definitionRevision).toMatch(/^sha256:/)
    expect(organize.stale).toBe(false)
    expect(organize.acceptedAt).toBeGreaterThan(0)
  })

  it('局部返工最后阶段：上游不重跑，仅下游重跑；旧交付入历史', async () => {
    const f = fixture()
    await f.host.run(input)
    const before = f.count()
    expect(before).toBe(4) // 两阶段各 2 次执行
    const organizeBefore = f.coordinator.store.latest('p', 'main')!.stageDeliveries!.find((r) => r.stageKey === 'organize')!
    f.coordinator.reworkStage({ projectId: 'p', nodeId: 'main' }, 'write')
    const reworked = f.coordinator.store.latest('p', 'main')!
    expect(reworked.state).toBe('waiting')
    expect(reworked.reworkRound).toBe(1)
    // 上游交付保留，下游交付移入历史并标过期
    expect(reworked.stageDeliveries!.map((r) => r.stageKey)).toEqual(['organize'])
    expect(reworked.reworkHistory!.some((r) => r.stageKey === 'write' && r.stale)).toBe(true)
    // continue 恢复 → 仅重跑 write（2 次执行），上游不重跑
    const done = await f.host.run({
      ...input, action: 'continue', requestId: 'rw-continue', eventId: 'rw-continue',
      expectedTaskId: reworked.taskId, expectedWaitRevision: reworked.waitRevision
    })
    expect(done.task.state).toBe('completed')
    expect(f.count()).toBe(before + 2)
    const organizeAfter = f.coordinator.store.latest('p', 'main')!.stageDeliveries!.find((r) => r.stageKey === 'organize')!
    expect(organizeAfter.taskId).toBe(organizeBefore.taskId) // 上游任务身份不变
  })

  it('返工轮次有界（上限 10）', async () => {
    const f = fixture()
    await f.host.run(input)
    const run = f.coordinator.store.latest('p', 'main')!
    run.reworkRound = 10
    f.coordinator.store.save(run)
    expect(() => f.coordinator.reworkStage({ projectId: 'p', nodeId: 'main' }, 'write'))
      .toThrow(/FLOW_REWORK_BUDGET_EXHAUSTED/)
  })

  it('未知阶段拒绝返工', async () => {
    const f = fixture()
    await f.host.run(input)
    expect(() => f.coordinator.reworkStage({ projectId: 'p', nodeId: 'main' }, 'ghost'))
      .toThrow(/FLOW_STAGE_MISSING/)
  })
})