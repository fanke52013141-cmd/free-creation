import { afterEach, describe, expect, it } from 'vitest'
import Database from 'better-sqlite3'
import type { CanvasNode, ProjectFile } from '../src/shared/types'
import { migrateDatabase } from '../src/main/store/db-migrations'
import { FlowCoordinatorHost } from '../src/main/agent-flow/coordinator-host'
import { FlowAgentDesktopHost } from '../src/main/agent-flow/desktop-host'
import { FlowCommandLedger } from '../src/main/agent-flow/command-ledger'
import { FlowAssetStore } from '../src/main/agent-flow/asset-store'
import { PROCESSOR_PORTS } from '../src/shared/agent-flow/processor-contract'
import { computeInputFingerprint } from '../src/shared/engine/input-fingerprint'
import type { AgentModelPort } from '../src/main/agent-flow/runtime'
import type {
  CoordinationContext,
  CoordinationDecision
} from '../src/shared/agent-flow/coordination'
import type { FlowAgentReply } from '../src/shared/agent-flow/desktop-tasks'
import { setGatewayEventSink } from '../src/main/diagnostics/gateway-events'
import type { DiagnosticsEventInput } from '../src/shared/observability'

const dbs: Database.Database[] = []
afterEach(() => {
  dbs.splice(0).forEach((db) => db.close())
  setGatewayEventSink(null)
})
const input = {
  projectId: 'p',
  nodeId: 'main',
  requestId: 'flow-1',
  traceId: 'trace',
  spanId: 'span',
  action: 'start' as const
}
function fixture(
  options: {
    coordinate?: (ctx: CoordinationContext) => Promise<CoordinationDecision>
    human?: boolean
    brokenState?: boolean
    publicationFails?: boolean
  } = {}
) {
  const db = new Database(':memory:')
  dbs.push(db)
  migrateDatabase(db)
  db.prepare('INSERT INTO projects(id,name,created_at,updated_at) VALUES (?,?,0,0)').run(
    'p',
    'isolated'
  )
  const shape = (id: string, type: string, text = '', config: object = {}) => ({
    id,
    type: 'node-card',
    props: {
      nodeType: type,
      title: id,
      config: JSON.stringify(config),
      text,
      mediaId: '',
      mediaPath: '',
      mediaMime: '',
      w: 340,
      h: 260,
      exec: 'idle'
    },
    meta: {} as Record<string, unknown>
  })
  const cfg = (role: string, ids: string[]) => ({
    schemaVersion: 1,
    role,
    interactionMode: 'autonomous',
    modelDefinitionId: 'fixture',
    skills: [],
    tools: [{ id: role === 'coordinator' ? 'agent.dispatch' : 'node.execute', version: '1' }],
    allowedNodeIds: ids,
    maxSteps: 8,
    relations: [] as object[]
  })
  const mainConfig = cfg('coordinator', ['first', 'second'])
  mainConfig.relations = [
    { relationId: 'state', kind: 'observes', sourceNodeId: 'main', targetNodeId: 'state' }
  ]
  const secondConfig = cfg('specialist', ['process-second'])
  if (options.human) secondConfig.interactionMode = 'collaborative'
  const events = [
    'flow.started',
    'agent.dispatched',
    'agent.completed',
    'human.wait',
    'human.continue',
    'flow.paused',
    'flow.completed'
  ]
  const stateConfig = {
    schemaVersion: 1,
    initialState: 'draft',
    states: ['draft', 'working', 'waiting', 'completed'],
    transitions: [
      { from: 'draft', event: 'flow.started', to: 'working' },
      ...events
        .filter((e) => e !== 'flow.started')
        .map((event) => ({
          from: 'working',
          event,
          to:
            event === 'flow.completed'
              ? 'completed'
              : ['human.wait', 'flow.paused'].includes(event)
                ? 'waiting'
                : 'working'
        })),
      { from: 'waiting', event: 'human.continue', to: 'working' }
    ].filter((t) => !options.brokenState || t.event !== 'agent.dispatched'),
    relations: []
  }
  const shapes = [
    shape('material', 'text', 'private-source'),
    shape('main', 'agent', '先分析再整理，只交付最后整理成果', mainConfig),
    shape('first', 'agent', '执行两次处理并检查真实回执', cfg('specialist', ['process-first'])),
    shape('second', 'agent', '整理分析成果，执行两次处理并检查', secondConfig),
    shape('process-first', 'processor', '', { operation: 'pass' }),
    shape('process-second', 'processor', '', { operation: 'pass' }),
    shape('state', 'state-machine', '', stateConfig)
  ]
  const byId = Object.fromEntries(shapes.map((s) => [s.id, s]))
  const node = (s: (typeof shapes)[number]): CanvasNode => ({
    id: s.id,
    type: s.props.nodeType as CanvasNode['type'],
    contractVersion: 1,
    title: s.props.title,
    x: 0,
    y: 0,
    w: 340,
    h: 260,
    ports: s.props.nodeType === 'processor' ? [...PROCESSOR_PORTS.in, ...PROCESSOR_PORTS.out] : [],
    params: { config: s.props.config },
    content: s.props.text ? { kind: 'text', text: s.props.text } : { kind: 'empty' },
    exec: { status: 'idle' },
    meta: { source: 'input', createdAt: 0 }
  })
  const edge = (from: string, fromPort: string, to: string, toPort: string) => ({
    id: `edge-${from}-${to}`,
    from: { nodeId: from, portId: fromPort },
    to: { nodeId: to, portId: toPort }
  })
  const file: ProjectFile = {
    version: 1,
    meta: { id: 'p', name: 'isolated', createdAt: 0, updatedAt: 0, graphVersion: 1 },
    nodes: shapes.map(node),
    edges: [
      edge('material', 'out-text', 'first', 'in-text'),
      edge('material', 'out-text', 'process-first', 'in-value'),
      edge('first', 'out-text', 'second', 'in-text'),
      edge('first', 'out-text', 'process-second', 'in-value')
    ],
    groups: [],
    tldrawSnapshot: { store: byId }
  }
  const open = (id: string): ProjectFile | null => (id === 'p' ? file : null)
  const assets = new FlowAssetStore(db, open),
    ledger = new FlowCommandLedger(db, open)
  let executions = 0,
    modelCalls = 0
  const deliveryErrors: string[] = []
  const host = new FlowAgentDesktopHost(
    db,
    open,
    {
      ledger,
      isActive: () => true,
      deliver: async (grant) => {
        executions++
        try {
          const c = grant.command,
            target = byId[c.targetNodeId],
            fixed = grant.inputs
          ledger.check({ projectId: c.projectId, commandId: c.commandId, leaseId: grant.leaseId })
          target.meta.nodeRun = {
            runId: grant.runId,
            status: 'success',
            startedAt: 0,
            finishedAt: 1,
            commandId: c.commandId,
            commandLeaseId: grant.leaseId,
            nodeExecutionId: `execution-${executions}`,
            fixedInputs: c.inputs,
            inputs: Object.fromEntries(
              fixed.map((p) => [
                p.targetPortId,
                p.versions.map((v, i) => ({
                  nodeId: p.sources![i].nodeId,
                  portId: p.sources![i].portId,
                  assetId: v.ref.assetId,
                  versionId: v.ref.versionId
                }))
              ])
            ),
            inputFingerprint: computeInputFingerprint({
              contractVersion: 1,
              config: target.props.config,
              text: target.props.text,
              sources: fixed.flatMap((p) =>
                p.versions.map((v, i) => ({
                  portId: p.targetPortId,
                  nodeId: p.sources![i].nodeId,
                  sourcePortId: p.sources![i].portId,
                  value: v.value
                }))
              )
            }),
            outputPorts: ['out-value']
          }
          target.meta.nodeResult = JSON.stringify(fixed[0].versions[0].value)
          file.meta.graphVersion++
          ledger.commit({ projectId: c.projectId, commandId: c.commandId })
        } catch (error) {
          deliveryErrors.push(
            (error as { code?: string; phase?: string }).code +
              ':' +
              (error as { phase?: string }).phase
          )
          throw error
        }
      }
    },
    async () => ({
      decide: async (ctx) =>
        ctx.receipts.length < 2
          ? { kind: 'execute', targetNodeId: ctx.targets[0].nodeId }
          : ctx.mode === 'collaborative' && !ctx.humanAccepted
            ? { kind: 'wait' }
            : { kind: 'finish', outputs: ctx.receipts.at(-1)!.outputRefs }
    })
  )
  const model: AgentModelPort = {
    decide: async () => {
      throw new Error('not a specialist')
    },
    coordinate: async (ctx) => {
      modelCalls++
      return options.coordinate
        ? options.coordinate(ctx)
        : ctx.available.length
          ? {
              kind: 'dispatch',
              nodeId: ctx.available[0].nodeId,
              inputs: ctx.available[0].inputs,
              goal: ctx.available[0].goal,
              completion: '至少两次真实执行并提交固定成果'
            }
          : { kind: 'finish', outputs: ctx.completed.at(-1)!.outputs }
    }
  }
  const publish = async (id: string, reply: FlowAgentReply) => {
    const s = byId[id]
    s.meta.agentTask = JSON.stringify(reply.task)
    s.meta.nodeRun = {
      inputs: {},
      runId: reply.task.taskId,
      startedAt: 0,
      finishedAt: 1,
      status: reply.task.state === 'completed' ? 'success' : 'skipped'
    }
    s.meta.nodeResult =
      reply.task.state === 'completed'
        ? JSON.stringify({
            schemaVersion: 1,
            taskId: reply.task.taskId,
            outputs: reply.outputs,
            refs: reply.refs
          })
        : null
    file.meta.graphVersion++
  }
  const coordinator = new FlowCoordinatorHost(
    db,
    open,
    () => true,
    host,
    async () => model,
    async (grant) => {
      if (options.publicationFails) throw new Error('unconfirmed')
      await publish(
        grant.nodeId,
        await host.run({
          ...input,
          nodeId: grant.nodeId,
          requestId: grant.taskId,
          expectedTaskId: grant.taskId
        })
      )
    }
  )
  host.setCoordinator(coordinator)
  return {
    db,
    file,
    byId,
    assets,
    ledger,
    host,
    coordinator,
    publish,
    deliveryErrors,
    count: () => ({ executions, modelCalls })
  }
}

describe('C3.3 coordinator sequential handoff', () => {
  it('gives two isolated specialists minimum fixed inputs across autosave, publishes real handoff and completes only with receipts', async () => {
    const f = fixture({
        coordinate: async (ctx) => {
          autosave()
          return ctx.available.length
            ? {
                kind: 'dispatch',
                nodeId: ctx.available[0].nodeId,
                inputs: ctx.available[0].inputs,
                goal: ctx.available[0].goal,
                completion: 'two real executions'
              }
            : { kind: 'finish', outputs: ctx.completed.at(-1)!.outputs }
        }
      }),
      events: DiagnosticsEventInput[] = []
    const autosave = () => {
      f.file.meta.graphVersion++
    }
    setGatewayEventSink({
      emit: (event) => {
        if (event) events.push(event)
      }
    })
    const result = await f.host.run(input)
    expect(f.deliveryErrors).toEqual([])
    expect(result.task.state).toBe('completed')
    expect(result.task.children).toHaveLength(2)
    expect(result.outputs['out-text']).toEqual({ kind: 'text', text: 'private-source' })
    expect(f.count()).toEqual({ executions: 4, modelCalls: 3 })
    const snapshots = (
      f.db.prepare('SELECT snapshot_json FROM flow_agent_tasks ORDER BY rowid').all() as Array<{
        snapshot_json: string
      }>
    ).map((row) => JSON.parse(row.snapshot_json))
    expect(snapshots[0].taskId).not.toBe(snapshots[1].taskId)
    expect(snapshots[0].directInputs[0].sourceNodeId).toBe('material')
    expect(snapshots[1].directInputs[0].sourceNodeId).toBe('first')
    expect(snapshots.every((s) => s.coordinatorTaskId === input.requestId)).toBe(true)
    expect(f.coordinator.inspect({ projectId: 'p', nodeId: 'state' })?.phase).toBe('completed')
    expect(f.db.prepare('SELECT count(*) AS count FROM flow_coordination_scope').get()).toEqual({
      count: 0
    })
    expect((await f.host.run(input)).refs).toEqual(result.refs)
    expect(f.count().executions).toBe(4)
    expect(JSON.stringify(events)).not.toContain('private-source')
  })
  it('does not repeat completed specialists while a collaborative child waits for a human', async () => {
    const f = fixture({ human: true })
    const first = await f.host.run(input)
    expect(first.task.state).toBe('waiting')
    expect(f.count().executions).toBe(4)
    const child = first.task.children![1],
      waiting = f.host.inspect({ projectId: 'p', nodeId: child.nodeId })!
    const resumed = await f.host.run({
      ...input,
      nodeId: child.nodeId,
      action: 'continue',
      eventId: 'human-child',
      expectedTaskId: child.taskId,
      expectedWaitRevision: waiting.waitRevision
    })
    await f.publish(child.nodeId, resumed)
    const done = await f.host.run({
      ...input,
      action: 'continue',
      eventId: 'human-main',
      expectedTaskId: first.task.taskId,
      expectedWaitRevision: first.task.waitRevision
    })
    expect(done.task.state).toBe('completed')
    expect(f.count().executions).toBe(4)
  })
  it('rejects forged output, unready or foreign dispatch, and undeclared state transitions before execution', async () => {
    for (const options of [
      {
        coordinate: async (): Promise<CoordinationDecision> => ({
          kind: 'dispatch',
          nodeId: 'second',
          goal: 'fake',
          completion: 'fake',
          inputs: []
        })
      },
      {
        coordinate: async (): Promise<CoordinationDecision> => ({
          kind: 'finish',
          outputs: [
            { assetId: 'fake', versionId: 'fake', sourceNodeId: 'fake', sourcePortId: 'out-text' }
          ]
        })
      },
      { brokenState: true }
    ]) {
      const f = fixture(options)
      await expect(f.host.run(input)).rejects.toThrow()
      expect(f.count().executions).toBe(0)
      expect(f.coordinator.inspect({ projectId: 'p', nodeId: 'main' })?.state).toBe('blocked')
    }
  })
  it('holds control occupancy, preserves publication failure facts, and never dispatches again after cancellation', async () => {
    const f = fixture({ publicationFails: true })
    await expect(f.host.run(input)).rejects.toThrow()
    expect(f.count().executions).toBe(2)
    expect(() =>
      f.ledger.assertNodeAvailable({ projectId: 'p', nodeId: 'process-second' })
    ).toThrow('FLOW_CONTROL_OCCUPIED')
    await expect(
      f.host.run({ ...input, nodeId: 'second', requestId: 'manual-race' })
    ).rejects.toThrow('FLOW_CONTROL_OCCUPIED')
    f.host.stop({ projectId: 'p', nodeId: 'main' })
    expect(f.coordinator.inspect({ projectId: 'p', nodeId: 'main' })?.state).toBe('cancelled')
    expect((await f.host.run(input)).task.state).toBe('cancelled')
    expect(f.count().executions).toBe(2)
  })
  it('pauses dispatch after a current model call, then continues without replay or refunding the decision budget', async () => {
    let pause!: () => void
    const f = fixture({
      coordinate: async (ctx) => {
        if (!ctx.completed.length) pause()
        return ctx.available.length
          ? {
              kind: 'dispatch',
              nodeId: ctx.available[0].nodeId,
              goal: 'process',
              completion: 'two calls',
              inputs: ctx.available[0].inputs
            }
          : { kind: 'finish', outputs: ctx.completed.at(-1)!.outputs }
      }
    })
    pause = () => {
      f.host.pause({ projectId: 'p', nodeId: 'main' })
    }
    const waiting = await f.host.run(input)
    expect(waiting.task.state).toBe('waiting')
    expect(f.count().executions).toBe(0)
    pause = () => {}
    const done = await f.host.run({
      ...input,
      action: 'continue',
      eventId: 'pause-resume',
      expectedTaskId: waiting.task.taskId,
      expectedWaitRevision: waiting.task.waitRevision
    })
    expect(done.task.state).toBe('completed')
    expect(done.task.decisions).toBe(4)
    expect(f.count().executions).toBe(4)
  })
})
