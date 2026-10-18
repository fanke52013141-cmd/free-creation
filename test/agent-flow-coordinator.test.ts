import { afterEach, describe, expect, it, vi } from 'vitest'
import { writeFile } from 'node:fs/promises'
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
import { FlowReviewHost } from '../src/main/agent-flow/review-host'
import { FlowReviewStore } from '../src/main/agent-flow/review-store'
import { projectSemanticRevision } from '../src/main/agent-flow/command-intent'
import { CoordinatorReviews } from '../src/main/agent-flow/coordinator-reviews'

const dbs: Database.Database[] = []
afterEach(() => {
  vi.restoreAllMocks()
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
    parallel?: boolean
    deliveryDuring?: (nodeId: string, taskId: string) => Promise<void>
    human?: boolean
    brokenState?: boolean
    publicationFails?: boolean
    publicationDuring?: () => Promise<void>
    review?: {
      manual?: boolean
      collaborative?: boolean
      stop?: boolean
      maxReworks?: number
      alwaysReject?: boolean
      technicalFailure?: boolean
      during?: () => Promise<void>
      reportOnly?: boolean
    }
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
  const mainConfig = {
    ...cfg('coordinator', ['first', 'second']),
    ...(options.parallel ? { maxParallelTasks: 2 } : {})
  }
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
  if (options.review) {
    mainConfig.allowedNodeIds.push('review')
    mainConfig.tools.push({ id: 'review.execute', version: '1' })
    mainConfig.maxSteps = 24
    shapes.find((s) => s.id === 'main')!.props.config = JSON.stringify(mainConfig)
    if (!options.review.manual) {
      const first = shapes.find((s) => s.id === 'first')!
      const config = cfg('specialist', ['process-first', 'process-repair'])
      if (options.review.collaborative) config.interactionMode = 'collaborative'
      first.props.config = JSON.stringify(config)
      shapes.push(
        shape('process-repair', 'processor', '', {
          operation: 'template',
          template: '交付：{{value}}'
        })
      )
    }
    const owner = options.review.manual ? 'material' : 'first'
    shapes.push(
      shape('review', 'ai-review', '必须以交付：开头', {
        schemaVersion: 1,
        modelDefinitionId: 'fixture',
        rulesVersion: 'rules-1',
        rejectPolicy: options.review.stop ? 'stop' : 'rework',
        maxReworks: options.review.maxReworks ?? 1,
        responsibleNodeId: owner,
        subjectSources: [{ nodeId: owner, portId: 'out-text' }],
        gatedNodeIds: [options.review.manual ? 'first' : 'second'],
        relations: []
      })
    )
    stateConfig.transitions.push(
      ...['review.started', 'review.passed', 'review.rejected', 'rework.created'].map((event) => ({
        from: 'working',
        event,
        to: 'working'
      }))
    )
    shapes.find((s) => s.id === 'state')!.props.config = JSON.stringify(stateConfig)
  }
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
    ports:
      s.props.nodeType === 'processor'
        ? [...PROCESSOR_PORTS.in, ...PROCESSOR_PORTS.out]
        : s.props.nodeType === 'agent' || s.props.nodeType === 'text'
          ? [
              {
                id: 'out-text',
                name: 'text',
                dir: 'out',
                type: 'text',
                cardinality: 'one',
                required: true
              }
            ]
          : [],
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
  if (options.parallel) {
    file.edges = file.edges.map((edge) =>
      edge.from.nodeId === 'first'
        ? { ...edge, from: { nodeId: 'material', portId: 'out-text' } }
        : edge
    )
  }
  if (options.review) {
    file.edges.push(
      edge(options.review.manual ? 'material' : 'first', 'out-text', 'review', 'in-text')
    )
    if (!options.review.manual)
      file.edges.push(edge('material', 'out-text', 'process-repair', 'in-value'))
  }
  const files = new Map<string, ProjectFile>([['p', file]])
  const open = (id: string): ProjectFile | null => files.get(id) ?? null
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
        await options.deliveryDuring?.(grant.command.targetNodeId, grant.command.taskId)
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
          const source = fixed[0].versions[0].value
          target.meta.nodeResult = JSON.stringify(
            c.targetNodeId === 'process-repair' && 'text' in source
              ? { kind: 'text', text: `交付：${source.text}` }
              : source
          )
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
          ? {
              kind: 'execute',
              targetNodeId: ctx.rework
                ? ctx.targets.find((target) => target.nodeId === 'process-repair')!.nodeId
                : ctx.targets[0].nodeId
            }
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
      await options.publicationDuring?.()
      if (grant.kind === 'review') {
        ledger.assertNodeAvailable({
          projectId: grant.projectId,
          nodeId: grant.nodeId,
          controlledRequestId: grant.taskId
        })
        const decision = await reviews.run({
          projectId: grant.projectId,
          nodeId: grant.nodeId,
          requestId: grant.taskId,
          traceId: grant.traceId,
          spanId: grant.spanId
        })
        if (options.review?.reportOnly) throw new Error('saved report, no public projection')
        byId[grant.nodeId].meta.nodeRun = {
          status: 'success',
          runId: grant.taskId,
          startedAt: 0,
          finishedAt: 1,
          inputs: {}
        }
        byId[grant.nodeId].meta.nodeResult = JSON.stringify(decision)
        return
      }
      await publish(
        grant.nodeId,
        await host.run({
          ...input,
          nodeId: grant.nodeId,
          requestId: grant.taskId,
          expectedTaskId: grant.taskId
        })
      )
    },
    (projectId, nodeId) => reviews.cancel(projectId, nodeId)
  )
  const reviews = new FlowReviewHost(
    db,
    open,
    () => true,
    async () => ({
      decide: async () => {
        throw new Error('not used')
      },
      review: async (ctx) => {
        await options.review?.during?.()
        if (options.review?.technicalFailure) throw new Error('technical failure')
        const passed =
          !options.review?.alwaysReject &&
          ctx.subjects.every((value) => 'text' in value && value.text.startsWith('交付：'))
        return {
          passed,
          feedback: passed ? '满足标准' : '请补交付前缀',
          issues: passed ? [] : [{ subjectIndex: 0, feedback: '补交付前缀' }]
        }
      }
    })
  )
  host.setCoordinator(coordinator)
  return {
    db,
    file,
    files,
    byId,
    assets,
    ledger,
    host,
    coordinator,
    reviews,
    publish,
    deliveryErrors,
    count: () => ({ executions, modelCalls })
  }
}

describe('C3.3 coordinator sequential handoff', () => {
  it('does not advance a restored projection after a concurrent stop', async () => {
    let entered!: () => void, release!: () => void
    const ready = new Promise<void>((done) => {
      entered = done
    })
    const options: { publicationFails: boolean; publicationDuring?: () => Promise<void> } = {
      publicationFails: true
    }
    const f = fixture(options)
    await expect(f.host.run(input)).rejects.toThrow()
    const run = f.coordinator.store.latest('p', 'main')!
    options.publicationFails = false
    options.publicationDuring = async () => {
      entered()
      await new Promise<void>((done) => {
        release = done
      })
    }
    const restoring = f.host.run({
      ...input,
      action: 'restore',
      requestId: 'restore',
      eventId: 'restore',
      expectedTaskId: run.taskId,
      expectedWaitRevision: run.waitRevision
    })
    await ready
    f.host.stop({ projectId: 'p', nodeId: 'main' })
    release()
    expect((await restoring).task.state).toBe('cancelled')
    expect(f.count().executions).toBe(2)
  })
  it('restores a verified completion interrupted after its authoritative state event without a new model decision', async () => {
    const f = fixture()
    await f.host.run(input)
    const run = f.coordinator.store.latest('p', 'main')!
    // Simulate the durable final event preceding the final task state/projection write.
    run.state = 'running'
    f.coordinator.store.save(run)
    f.db.prepare('INSERT INTO flow_coordination_scope VALUES (?,?,?)').run('p', 'first', run.taskId)
    f.db
      .prepare('INSERT INTO flow_coordination_scope VALUES (?,?,?)')
      .run('p', 'second', run.taskId)
    f.coordinator.inspect({ projectId: 'p', nodeId: 'main' })
    const count = f.count()
    const completed = await f.host.run({
      ...input,
      action: 'reconcile',
      requestId: 'recover-complete',
      eventId: 'recover-complete',
      expectedTaskId: run.taskId,
      expectedWaitRevision: run.waitRevision
    })
    expect(completed.task.state).toBe('completed')
    expect(f.count()).toEqual(count)
    expect(f.db.prepare('SELECT count(*) AS count FROM flow_coordination_scope').get()).toEqual({
      count: 0
    })
  })
  it('recovers a saved review verdict and missing public projection without issuing another review', async () => {
    let calls = 0
    const options = {
      review: {
        reportOnly: true,
        during: async () => {
          calls++
        }
      }
    }
    const f = fixture(options)
    await expect(f.host.run(input)).rejects.toThrow()
    const run = f.coordinator.store.latest('p', 'main')!
    const query = {
      ...input,
      action: 'reconcile' as const,
      requestId: 'r',
      eventId: 'r',
      expectedTaskId: run.taskId,
      expectedWaitRevision: run.waitRevision
    }
    expect((await f.host.run(query)).task.recovery?.canRestore).toBe(true)
    expect(calls).toBe(1)
    options.review.reportOnly = false
    const restored = await f.host.run({ ...query, action: 'restore' })
    expect(restored.task.state).toBe('waiting')
    expect(calls).toBe(1)
    expect(f.coordinator.store.latest('p', 'main')!.reviews![0].state).toBe('rejected')
    expect(f.count().executions).toBe(2)
  })
  it('rejects a forged public output even when its task and asset identities match', async () => {
    const options = { publicationFails: true },
      f = fixture(options)
    await expect(f.host.run(input)).rejects.toThrow()
    const run = f.coordinator.store.latest('p', 'main')!,
      child = run.children[0]
    const completed = await f.host.run({
      ...input,
      nodeId: child.nodeId,
      requestId: child.taskId,
      expectedTaskId: child.taskId
    })
    await f.publish(child.nodeId, completed)
    const projected = JSON.parse(String(f.byId[child.nodeId].meta.nodeResult))
    projected.outputs['out-text'].text = 'forged'
    f.byId[child.nodeId].meta.nodeResult = JSON.stringify(projected)
    options.publicationFails = false
    await expect(
      f.host.run({
        ...input,
        action: 'restore',
        requestId: 'r',
        eventId: 'r',
        expectedTaskId: run.taskId,
        expectedWaitRevision: run.waitRevision
      })
    ).rejects.toMatchObject({ code: 'FLOW_PROJECTION_CONFLICT' })
    expect(f.count().executions).toBe(2)
  })
  it('restores only committed child projection, then waits for an explicit continue without extra tool/model decisions', async () => {
    const options = { publicationFails: true }
    const f = fixture(options)
    await expect(f.host.run(input)).rejects.toThrow()
    const run = f.coordinator.store.latest('p', 'main')!,
      count = f.count()
    options.publicationFails = false
    const recovered = await f.host.run({
      ...input,
      action: 'restore',
      requestId: 'restore',
      eventId: 'restore',
      expectedTaskId: run.taskId,
      expectedWaitRevision: run.waitRevision
    })
    expect(recovered.task.state).toBe('waiting')
    expect(f.count()).toEqual(count)
    const done = await f.host.run({
      ...input,
      action: 'continue',
      requestId: 'continue-restored',
      eventId: 'continue-restored',
      expectedTaskId: run.taskId,
      expectedWaitRevision: recovered.task.waitRevision
    })
    expect(done.task.state).toBe('completed')
    expect(f.count().executions).toBe(4)
  })
  it('reconciles a saved child publication after restart without another model or execution', async () => {
    const f = fixture({ publicationFails: true })
    await expect(f.host.run(input)).rejects.toThrow()
    const run = f.coordinator.store.latest('p', 'main')!
    const child = run.children[0]
    const reply = await f.host.run({
      ...input,
      nodeId: child.nodeId,
      requestId: child.taskId,
      expectedTaskId: child.taskId
    })
    await f.publish(child.nodeId, reply)
    const count = f.count()
    const recovered = await f.host.run({
      ...input,
      action: 'reconcile',
      requestId: 'recovery',
      eventId: 'recovery',
      expectedTaskId: run.taskId,
      expectedWaitRevision: run.waitRevision
    })
    expect(recovered.task.state).toBe('waiting')
    expect(recovered.task.children![0].state).toBe('completed')
    expect(f.count()).toEqual(count)
    expect(recovered.task.recovery?.reasons).toEqual([])
  })
  it('never repeats an interrupted model decision or calls models while facts are unknown', async () => {
    const f = fixture({
      coordinate: async () => {
        throw new Error('interrupted')
      }
    })
    await expect(f.host.run(input)).rejects.toThrow()
    const run = f.coordinator.store.latest('p', 'main')!,
      count = f.count()
    const recovered = await f.host.run({
      ...input,
      action: 'reconcile',
      requestId: 'recovery',
      eventId: 'recovery',
      expectedTaskId: run.taskId,
      expectedWaitRevision: run.waitRevision
    })
    expect(recovered.task.state).toBe('blocked')
    expect(recovered.task.recovery?.reasons).toContain('FLOW_MODEL_OUTCOME_UNKNOWN')
    expect(f.count()).toEqual(count)
    expect(() =>
      f.ledger.assertNodeAvailable({ projectId: 'p', nodeId: 'process-first' })
    ).toThrow()
  })
  it('distinguishes committed assets missing projection from unknown execution facts', async () => {
    const f = fixture({ publicationFails: true })
    await expect(f.host.run(input)).rejects.toThrow()
    const run = f.coordinator.store.latest('p', 'main')!,
      count = f.count()
    const result = await f.host.run({
      ...input,
      action: 'reconcile',
      requestId: 'r',
      eventId: 'r',
      expectedTaskId: run.taskId,
      expectedWaitRevision: run.waitRevision
    })
    expect(result.task.recovery).toEqual({
      reasons: ['FLOW_ASSET_PROJECTION_MISSING'],
      canRestore: true
    })
    expect(result.task.state).toBe('blocked')
    expect(f.count()).toEqual(count)
  })
  it('keeps review and rework results when diagnostics cannot be written', async () => {
    const f = fixture({ review: {} })
    setGatewayEventSink({
      emit: () => {
        throw new Error('diagnostics unavailable')
      }
    })
    const done = await f.host.run(input)
    expect(done.task.state).toBe('completed')
    expect(f.count().executions).toBe(6)
  })
  it('counts automatic reviews and rework against the total control budget', async () => {
    const f = fixture({ review: {} })
    const config = JSON.parse(f.byId.main.props.config)
    config.maxSteps = 2
    f.byId.main.props.config = JSON.stringify(config)
    await expect(f.host.run(input)).rejects.toMatchObject({ code: 'AGENT_BUDGET_EXHAUSTED' })
    expect(f.count().executions).toBe(2)
    expect(f.coordinator.inspect({ projectId: 'p', nodeId: 'main' })?.state).toBe('blocked')
  })
  it('stops an in-flight review without persisting its late verdict or dispatching downstream', async () => {
    let release!: () => void
    let entered!: () => void
    const ready = new Promise<void>((done) => {
      entered = done
    })
    const f = fixture({
      review: {
        during: async () => {
          entered()
          await new Promise<void>((done) => {
            release = done
          })
        }
      }
    })
    const running = f.host.run(input)
    await ready
    f.host.stop({ projectId: 'p', nodeId: 'main' })
    expect((await running).task.state).toBe('cancelled')
    release()
    await Promise.resolve()
    expect(new FlowReviewStore(f.db).latest('p', 'review')).toBeNull()
    expect(f.count().executions).toBe(2)
    expect((await f.host.run(input)).task.state).toBe('cancelled')
    expect(f.count().executions).toBe(2)
  })
  it('automatically reviews, creates an immutable bounded AI rework task and only then releases downstream', async () => {
    const f = fixture({ review: {} })
    const done = await f.host.run(input)
    expect(done.task.state).toBe('completed')
    expect(done.outputs['out-text']).toEqual({ kind: 'text', text: '交付：private-source' })
    const tasks = f.db
      .prepare(
        "SELECT snapshot_json FROM flow_agent_tasks WHERE agent_node_id='first' ORDER BY rowid"
      )
      .all() as Array<{ snapshot_json: string }>
    expect(tasks).toHaveLength(2)
    const [original, rework] = tasks.map((row) => JSON.parse(row.snapshot_json))
    expect(rework.parentTaskId).toBe(original.taskId)
    expect(rework.directInputs).toEqual(original.directInputs)
    expect(rework.targets).toEqual(original.targets)
    expect(rework.rework.feedback).toBe('请补交付前缀')
    expect(original.rework).toBeUndefined()
    expect(f.db.prepare('SELECT * FROM flow_reviews').all()).toHaveLength(2)
    expect(f.count().executions).toBe(6)
    await f.host.run(input)
    expect(f.count().executions).toBe(6)
  })
  it.each([
    { stop: true, code: 'FLOW_REVIEW_STOPPED' },
    { maxReworks: 0, code: 'FLOW_REVIEW_BUDGET_EXHAUSTED' },
    { alwaysReject: true, code: 'FLOW_REVIEW_BUDGET_EXHAUSTED' }
  ])(
    'blocks downstream for rejection strategy or exhausted rounds: %s',
    async ({ code, ...review }) => {
      const f = fixture({ review })
      await expect(f.host.run(input)).rejects.toMatchObject({ code })
      expect(f.coordinator.inspect(input)?.state).toBe('blocked')
      expect(f.byId['process-second'].meta.nodeRun).toBeUndefined()
    }
  )
  it('does not turn technical review failures into a quality verdict or dispatch downstream', async () => {
    const f = fixture({ review: { technicalFailure: true } })
    await expect(f.host.run(input)).rejects.toThrow()
    expect(f.db.prepare('SELECT * FROM flow_reviews').all()).toHaveLength(0)
    expect(f.byId['process-second'].meta.nodeRun).toBeUndefined()
    const cycle = f.coordinator.store.latest('p', 'main')!.reviews![0]
    expect(cycle.state).toBe('pending')
    expect(() =>
      f.ledger.assertNodeAvailable({
        projectId: 'p',
        nodeId: 'review',
        controlledRequestId: 'forged'
      })
    ).toThrow('FLOW_CONTROL_OCCUPIED')
  })
  it('requires an explicitly published manual version and rejects permission changes during a wait', async () => {
    const f = fixture({ review: { manual: true } })
    const waiting = await f.host.run(input)
    expect(waiting.task.state).toBe('waiting')
    expect(f.host.inspect({ projectId: 'p', nodeId: 'material' })?.reviewFeedback?.feedback).toBe(
      '请补交付前缀'
    )
    f.byId.material.props.text = '交付：private-source'
    const node = f.file.nodes.find((node) => node.id === 'material')!
    node.content = { kind: 'text', text: f.byId.material.props.text }
    const next = {
      ...input,
      action: 'continue' as const,
      requestId: 'manual-continue',
      expectedTaskId: waiting.task.taskId,
      expectedWaitRevision: waiting.task.waitRevision,
      eventId: 'manual-continue'
    }
    const stillWaiting = await f.host.run(next)
    expect(stillWaiting.task.state).toBe('waiting')
    const submitted = f.assets.submit({
      projectId: 'p',
      nodeId: 'material',
      portId: 'out-text',
      submissionId: 'explicit-manual',
      expectedGraphVersion: f.file.meta.graphVersion,
      traceId: 't',
      spanId: 's'
    })
    const done = await f.host.run({
      ...next,
      requestId: 'manual-published',
      eventId: 'manual-published',
      expectedWaitRevision: stillWaiting.task.waitRevision
    })
    expect(done.task.state).toBe('completed')
    expect(f.count().executions).toBe(4)
    expect(new FlowReviewStore(f.db).latest('p', 'review')!.decision.subjects).toEqual([
      submitted.ref
    ])
    expect(projectSemanticRevision(f.file)).toMatch(/^sha256:/)
  })
  it('restores a collaborative rework wait without dispatching until the responsible node explicitly starts', async () => {
    const f = fixture({ review: { collaborative: true } })
    // Initial collaborative task must complete its existing confirmation before quality review.
    let root = await f.host.run(input)
    const firstWait = f.host.inspect({ projectId: 'p', nodeId: 'first' })!
    await f.host.run({
      ...input,
      nodeId: 'first',
      action: 'continue',
      requestId: 'first-confirm',
      expectedTaskId: firstWait.taskId,
      expectedWaitRevision: firstWait.waitRevision,
      eventId: 'first-confirm'
    })
    root = await f.host.run({
      ...input,
      action: 'continue',
      requestId: 'root-resume',
      expectedTaskId: root.task.taskId,
      expectedWaitRevision: root.task.waitRevision,
      eventId: 'root-resume'
    })
    const prepared = f.host.inspect({ projectId: 'p', nodeId: 'first' })!
    expect(prepared.state).toBe('ready')
    expect(prepared.prepared).toBe(true)
    expect(prepared.reviewFeedback?.feedback).toBe('请补交付前缀')
    const before = f.count().executions
    const waitingAgain = await f.host.run({
      ...input,
      action: 'continue',
      requestId: 'still-wait',
      expectedTaskId: root.task.taskId,
      expectedWaitRevision: root.task.waitRevision,
      eventId: 'still-wait'
    })
    expect(waitingAgain.task.state).toBe('waiting')
    expect(f.count().executions).toBe(before)
    const revised = await f.host.run({
      ...input,
      nodeId: 'first',
      requestId: 'explicit-rework-start',
      expectedTaskId: prepared.taskId
    })
    expect(revised.task.state).toBe('waiting')
    await f.host.run({
      ...input,
      nodeId: 'first',
      action: 'continue',
      requestId: 'explicit-rework-confirm',
      expectedTaskId: revised.task.taskId,
      expectedWaitRevision: revised.task.waitRevision,
      eventId: 'explicit-rework-confirm'
    })
    const done = await f.host.run({
      ...input,
      action: 'continue',
      requestId: 'finish-reviewed',
      expectedTaskId: root.task.taskId,
      expectedWaitRevision: waitingAgain.task.waitRevision,
      eventId: 'finish-reviewed'
    })
    expect(done.task.state).toBe('completed')
    expect(f.count().executions).toBe(6)
  })
  it('rejects configuration changes while allowing only explicit manual body revision', async () => {
    const f = fixture({ review: { manual: true } })
    const waiting = await f.host.run(input)
    f.byId.material.props.config = '{"unauthorized":true}'
    await expect(
      f.host.run({
        ...input,
        action: 'continue',
        requestId: 'bad-edit',
        eventId: 'bad-edit',
        expectedTaskId: waiting.task.taskId,
        expectedWaitRevision: waiting.task.waitRevision
      })
    ).rejects.toMatchObject({ code: 'FLOW_REVISION_CONFLICT' })
    expect(f.count().executions).toBe(0)
  })
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
  it('COO-08 rejects a second coordinator whose authorized scope overlaps a waiting coordinator', async () => {
    const entered = deferred(),
      release = deferred()
    const f = fixture({
      coordinate: async () => {
        entered.resolve()
        await release.promise
        return { kind: 'wait' }
      }
    })
    const firstConfig = JSON.parse(f.byId.main.props.config)
    firstConfig.interactionMode = 'collaborative'
    f.byId.main.props.config = JSON.stringify(firstConfig)
    f.file.nodes.find((node) => node.id === 'main')!.params.config = f.byId.main.props.config
    const running = f.host.run(input)
    await entered.promise

    const mainShape = structuredClone(f.byId.main),
      stateShape = structuredClone(f.byId.state),
      mainConfig = JSON.parse(mainShape.props.config) as Record<string, unknown> & {
        allowedNodeIds: string[]
        relations: object[]
      }
    mainShape.id = 'main-overlap'
    mainShape.props.title = 'main-overlap'
    mainConfig.allowedNodeIds = ['first']
    mainConfig.relations = [
      {
        relationId: 'state-overlap',
        kind: 'observes',
        sourceNodeId: 'main-overlap',
        targetNodeId: 'state-overlap'
      }
    ]
    mainShape.props.config = JSON.stringify(mainConfig)
    stateShape.id = 'state-overlap'
    const shapes = (f.file.tldrawSnapshot as { store: Record<string, typeof mainShape> }).store
    shapes['main-overlap'] = mainShape
    shapes['state-overlap'] = stateShape

    const mainNode = structuredClone(f.file.nodes.find((node) => node.id === 'main')!),
      stateNode = structuredClone(f.file.nodes.find((node) => node.id === 'state')!)
    mainNode.id = 'main-overlap'
    mainNode.title = 'main-overlap'
    mainNode.params.config = mainShape.props.config
    stateNode.id = 'state-overlap'
    stateNode.title = 'state-overlap'
    f.file.nodes.push(mainNode, stateNode)

    const competing = new FlowCoordinatorHost(
      f.db,
      (projectId) => (projectId === 'p' ? f.file : null),
      () => true,
      f.host,
      async () => {
        throw new Error('OVERLAPPING_COORDINATOR_MODEL_SHOULD_NOT_START')
      },
      async () => {
        throw new Error('OVERLAPPING_COORDINATOR_PUBLICATION_SHOULD_NOT_START')
      }
    )
    let firstResult!: FlowAgentReply
    try {
      await expect(
        competing.run({
          ...input,
          nodeId: 'main-overlap',
          requestId: 'flow-overlap',
          traceId: 'overlap-trace'
        })
      ).rejects.toMatchObject({ code: 'FLOW_CONTROL_OCCUPIED' })
    } finally {
      release.resolve()
      firstResult = await running
    }
    expect(firstResult.task.state).toBe('waiting')
    await expect(
      competing.run({
        ...input,
        nodeId: 'main-overlap',
        requestId: 'flow-overlap-after-wait',
        eventId: 'overlap-after-wait',
        traceId: 'overlap-after-wait-trace'
      })
    ).rejects.toMatchObject({ code: 'FLOW_CONTROL_OCCUPIED' })
    expect(f.coordinator.inspect({ projectId: 'p', nodeId: 'main' })?.state).toBe('waiting')
    expect(f.coordinator.store.owner('p', 'first')).toBe('flow-1')
    expect(
      f.db.prepare('SELECT COUNT(*) AS n FROM flow_coordination_runs WHERE project_id=?').get('p')
    ).toEqual({ n: 1 })

    f.db
      .prepare('INSERT INTO projects(id,name,created_at,updated_at) VALUES (?,?,0,0)')
      .run('other-project', 'isolated-other-project')

    const otherFile = structuredClone(f.file)
    otherFile.meta = { ...otherFile.meta, id: 'other-project', name: 'isolated-other-project' }
    f.files.set('other-project', otherFile)
    const otherShapes = (otherFile.tldrawSnapshot as { store: Record<string, typeof mainShape> })
      .store
    delete otherShapes.main.meta.agentTask
    delete otherShapes.main.meta.nodeRun
    delete otherShapes.main.meta.nodeResult
    const otherCoordinator = new FlowCoordinatorHost(
      f.db,
      (projectId) => (projectId === 'other-project' ? otherFile : null),
      () => true,
      f.host,
      async () => ({
        decide: async () => {
          throw new Error('OTHER_PROJECT_SPECIALIST_SHOULD_NOT_START')
        },
        coordinate: async () => ({ kind: 'wait' })
      }),
      async () => {
        throw new Error('OTHER_PROJECT_PUBLICATION_SHOULD_NOT_START')
      }
    )
    const otherProjectReply = await otherCoordinator.run({
      ...input,
      projectId: 'other-project',
      requestId: 'other-project-flow',
      traceId: 'other-project-trace',
      spanId: 'other-project-span'
    })

    expect(firstResult.task.state).toBe('waiting')
    expect(otherProjectReply.task.state).toBe('waiting')
    expect(f.coordinator.store.latest('p', 'main')?.state).toBe('waiting')
    expect(otherCoordinator.store.latest('other-project', 'main')?.state).toBe('waiting')
    expect(f.coordinator.store.owner('p', 'first')).toBe('flow-1')
    expect(otherCoordinator.store.owner('other-project', 'first')).toBe('other-project-flow')
    expect(
      f.db.prepare('SELECT COUNT(*) AS n FROM flow_coordination_runs WHERE node_id=?').get('main')
    ).toEqual({ n: 2 })
  })
  it.each([
    ['a specialist-owned processor', 'process-first'],
    ['a node outside the project', 'other-project-node']
  ])('COO-08 blocks dispatch to %s before creating a child command', async (_label, nodeId) => {
    const f = fixture({
      coordinate: async (): Promise<CoordinationDecision> => ({
        kind: 'dispatch',
        nodeId,
        goal: 'outside authorized coordinator scope',
        completion: 'must never run',
        inputs: []
      })
    })
    await expect(f.host.run(input)).rejects.toThrow()
    expect(f.coordinator.store.latest('p', 'main')?.state).toBe('blocked')
    expect(f.count().executions).toBe(0)
    expect(f.db.prepare('SELECT COUNT(*) AS n FROM flow_commands').get()).toEqual({ n: 0 })
  })
  it('CFG-05 never rebinds a deleted authorized node ID to a same-title replacement', async () => {
    const replacementId = 'replacement-first'
    const f = fixture({
      coordinate: async (): Promise<CoordinationDecision> => ({
        kind: 'dispatch',
        nodeId: replacementId,
        goal: 'must not inherit the deleted node permission',
        completion: 'must never run',
        inputs: []
      })
    })
    const snapshot = f.file.tldrawSnapshot as { store: Record<string, typeof f.byId.first> }
    const oldShape = snapshot.store.first
    const oldNode = f.file.nodes.find((node) => node.id === 'first')!
    delete snapshot.store.first
    f.file.nodes = f.file.nodes.filter((node) => node.id !== 'first')
    const replacementShape = structuredClone(oldShape)
    replacementShape.id = replacementId
    snapshot.store[replacementId] = replacementShape
    const replacementNode = structuredClone(oldNode)
    replacementNode.id = replacementId
    f.file.nodes.push(replacementNode)

    expect(replacementShape.props.title).toBe(oldShape.props.title)
    expect(JSON.parse(f.byId.main.props.config).allowedNodeIds).toContain('first')
    expect(JSON.parse(f.byId.main.props.config).allowedNodeIds).not.toContain(replacementId)
    await expect(f.host.run(input)).rejects.toMatchObject({
      code: 'FLOW_NODE_MISSING',
      phase: 'scope'
    })

    expect(f.coordinator.store.latest('p', 'main')).toBeNull()
    expect(f.count().executions).toBe(0)
    expect(f.db.prepare('SELECT COUNT(*) AS n FROM flow_commands').get()).toEqual({ n: 0 })
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
    const availableInputVersions: string[][] = []
    const f = fixture({
      coordinate: async (ctx) => {
        availableInputVersions.push(
          ctx.available.map((candidate) => candidate.inputs[0]?.versionId ?? '')
        )
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
      // Renderer continuation saves the waiting task metadata, advancing graphVersion while
      // leaving the locked coordination scope and its actual inputs unchanged.
      f.file.meta.graphVersion++
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
    expect(availableInputVersions[1]).toEqual(availableInputVersions[0])
  })
})

function parallelDecision(ctx: CoordinationContext): Promise<CoordinationDecision> {
  return Promise.resolve(
    ctx.available.length >= 2 && ctx.available.length <= (ctx.maxParallelTasks ?? 1)
      ? {
          kind: 'dispatch-many',
          assignments: ctx.available.map((item) => ({
            nodeId: item.nodeId,
            goal: item.goal,
            inputs: item.inputs,
            completion: '交付真实固定成果'
          }))
        }
      : { kind: 'finish', outputs: ctx.completed.at(-1)!.outputs }
  )
}

function extendParallelFixture(f: ReturnType<typeof fixture>, branchCount: 4): void {
  const names = ['third', 'fourth'].slice(0, branchCount - 2)
  for (const name of names) {
    const targetId = `process-${name}`
    const agentShape = {
      ...structuredClone(f.byId.first),
      id: name,
      props: {
        ...f.byId.first.props,
        title: name,
        config: JSON.stringify({
          ...JSON.parse(f.byId.first.props.config),
          allowedNodeIds: [targetId]
        })
      },
      meta: {} as Record<string, unknown>
    }
    const targetShape = {
      ...structuredClone(f.byId['process-first']),
      id: targetId,
      props: { ...f.byId['process-first'].props, title: targetId },
      meta: {} as Record<string, unknown>
    }
    f.byId[name] = agentShape
    f.byId[targetId] = targetShape
    f.file.tldrawSnapshot.store[name] = agentShape
    f.file.tldrawSnapshot.store[targetId] = targetShape
    f.file.nodes.push(
      {
        ...structuredClone(f.file.nodes.find((node) => node.id === 'first')!),
        id: name,
        params: { config: agentShape.props.config }
      },
      {
        ...structuredClone(f.file.nodes.find((node) => node.id === 'process-first')!),
        id: targetId,
        params: { config: targetShape.props.config }
      }
    )
    f.file.edges.push(
      {
        id: `edge-material-${name}`,
        from: { nodeId: 'material', portId: 'out-text' },
        to: { nodeId: name, portId: 'in-text' }
      },
      {
        id: `edge-material-${targetId}`,
        from: { nodeId: 'material', portId: 'out-text' },
        to: { nodeId: targetId, portId: 'in-value' }
      }
    )
  }
  const config = JSON.parse(f.byId.main.props.config)
  config.allowedNodeIds = ['first', 'second', ...names]
  config.maxParallelTasks = branchCount
  f.byId.main.props.config = JSON.stringify(config)
  f.file.nodes.find((node) => node.id === 'main')!.params.config = f.byId.main.props.config
}
function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}
describe('bounded parallel coordination', () => {
  it('PAR-02 rejects a one-assignment dispatch-many batch before starting any child', async () => {
    let reduced = false
    const f = fixture({
      parallel: true,
      coordinate: async (ctx) => {
        const decision = await parallelDecision(ctx)
        if (decision.kind === 'dispatch-many' && !reduced) {
          reduced = true
          return { ...decision, assignments: decision.assignments.slice(0, 1) }
        }
        return decision
      }
    })

    await expect(f.host.run(input)).rejects.toThrow(/Too small/)
    expect(f.coordinator.store.latest('p', 'main')!.children).toHaveLength(0)
    expect(f.count().executions).toBe(0)
  })

  it('saves both intents before effects and actually overlaps independent tasks', async () => {
    const both = deferred(),
      entered = new Set<string>()
    const f = fixture({
      parallel: true,
      coordinate: parallelDecision,
      deliveryDuring: async (id) => {
        const run = f.coordinator.store.latest('p', 'main')!
        expect(run.children).toHaveLength(2)
        expect(run.children.every((child) => child.inputs.length > 0 && child.taskId)).toBe(true)
        entered.add(id)
        if (entered.size === 2) both.resolve()
        await both.promise
      }
    })
    const reply = await f.host.run(input)
    expect(reply.task.state).toBe('completed')
    expect(reply.task.children?.map((child) => child.state)).toEqual(['completed', 'completed'])
    expect(f.count()).toEqual({ executions: 4, modelCalls: 2 })
    expect(f.coordinator.store.latest('p', 'main')!.controlSteps).toBe(1)
  })
  it('runs four independent branches together under the bounded cap', async () => {
    const both = deferred(),
      entered = new Set<string>()
    const f = fixture({
      parallel: true,
      coordinate: parallelDecision,
      deliveryDuring: async (id) => {
        const run = f.coordinator.store.latest('p', 'main')!
        expect(run.children).toHaveLength(4)
        entered.add(id)
        if (entered.size === 4) both.resolve()
        await both.promise
      }
    })
    extendParallelFixture(f, 4)
    const reply = await f.host.run(input)
    expect(reply.task.state).toBe('completed')
    expect(reply.task.children?.map((child) => child.state)).toEqual([
      'completed',
      'completed',
      'completed',
      'completed'
    ])
    expect(entered).toEqual(
      new Set(['process-first', 'process-second', 'process-third', 'process-fourth'])
    )
    expect(f.count()).toEqual({ executions: 8, modelCalls: 2 })
    expect(f.coordinator.store.latest('p', 'main')!.controlSteps).toBe(3)
  })
  it('PAR-02 rejects a five-assignment batch above the four-task cap before any child is reserved', async () => {
    const f = fixture({
      parallel: true,
      coordinate: async (ctx) => {
        const decision = await parallelDecision(ctx)
        if (decision.kind !== 'dispatch-many') throw new Error('missing batch')
        return {
          ...decision,
          assignments: [...decision.assignments, { ...decision.assignments[0]!, nodeId: 'fifth' }]
        }
      }
    })
    extendParallelFixture(f, 4)

    await expect(f.host.run(input)).rejects.toThrow(/Too big/)
    expect(f.count().executions).toBe(0)
    expect(f.coordinator.store.latest('p', 'main')!.children).toHaveLength(0)
  })

  it.each(['disabled', 'duplicate', 'invalid-input', 'budget'] as const)(
    'rejects the entire %s batch without starting any child',
    async (kind) => {
      const f = fixture({
        parallel: true,
        coordinate: async (ctx) => {
          const decision = await parallelDecision(ctx)
          if (decision.kind !== 'dispatch-many') throw new Error('missing batch')
          if (kind === 'duplicate') decision.assignments[1] = decision.assignments[0]
          if (kind === 'invalid-input')
            decision.assignments[1].inputs = [
              { ...decision.assignments[1].inputs[0], versionId: 'forged' }
            ]
          return decision
        }
      })
      const cfg = JSON.parse(f.byId.main.props.config)
      if (kind === 'disabled') delete cfg.maxParallelTasks
      if (kind === 'budget') cfg.maxSteps = 1
      f.byId.main.props.config = JSON.stringify(cfg)
      f.file.nodes.find((node) => node.id === 'main')!.params.config = f.byId.main.props.config
      await expect(f.host.run(input)).rejects.toThrow()
      expect(f.count().executions).toBe(0)
      const rejected = f.coordinator.store.latest('p', 'main')!
      expect(rejected.children).toHaveLength(0)
      expect(rejected.decisions).toBe(1)
    }
  )
  it('queues shared target assignments in dispatch order and releases the next branch only at terminal', async () => {
    const entered = deferred(),
      release = deferred(),
      order: string[] = []
    const f = fixture({
      parallel: true,
      coordinate: parallelDecision,
      deliveryDuring: async (_nodeId, taskId) => {
        const run = f.coordinator.store.latest('p', 'main')!
        if (taskId === run.children[0]?.taskId) {
          order.push('first-start')
          entered.resolve()
          await release.promise
          order.push('first-terminal')
        } else if (taskId === run.children[1]?.taskId) order.push('second-start')
      }
    })
    const secondConfig = JSON.parse(f.byId.second.props.config)
    secondConfig.allowedNodeIds = ['process-first']
    f.byId.second.props.config = JSON.stringify(secondConfig)
    f.file.nodes.find((node) => node.id === 'second')!.params.config = f.byId.second.props.config

    const pending = f.host.run(input)
    await entered.promise
    await new Promise((done) => setTimeout(done, 20))
    expect(order).not.toContain('second-start')
    release.resolve()

    const reply = await pending
    expect(reply.task.state).toBe('completed')
    expect(reply.task.children?.map((child) => child.state)).toEqual(['completed', 'completed'])
    expect(order.indexOf('first-terminal')).toBeLessThan(order.indexOf('second-start'))
  })
  it('restores a shared target queue after a waiting child and continues only after that child completes', async () => {
    const f = fixture({ parallel: true, human: true, coordinate: parallelDecision })
    const sharedTargetConfig = JSON.parse(f.byId.second.props.config)
    sharedTargetConfig.allowedNodeIds = ['process-first']
    sharedTargetConfig.interactionMode = 'autonomous'
    f.byId.second.props.config = JSON.stringify(sharedTargetConfig)
    f.file.nodes.find((node) => node.id === 'second')!.params.config = f.byId.second.props.config
    const firstConfig = JSON.parse(f.byId.first.props.config)
    firstConfig.interactionMode = 'collaborative'
    f.byId.first.props.config = JSON.stringify(firstConfig)
    f.file.nodes.find((node) => node.id === 'first')!.params.config = f.byId.first.props.config

    const waiting = await f.host.run(input)
    expect(waiting.task.state).toBe('waiting')
    expect(waiting.task.children?.map((child) => child.state)).toEqual(['waiting', 'queued'])
    expect(f.count().executions).toBe(2)
    const reconciled = await f.coordinator.run({
      ...input,
      action: 'reconcile',
      eventId: 'shared-queue-reconcile',
      expectedTaskId: waiting.task.taskId,
      expectedWaitRevision: waiting.task.waitRevision
    })
    expect(reconciled.task.state).toBe('waiting')
    expect(reconciled.task.children?.map((child) => child.state)).toEqual(['waiting', 'queued'])

    const child = f.host.inspect({ projectId: 'p', nodeId: 'first' })!
    const completed = await f.host.run({
      ...input,
      nodeId: 'first',
      action: 'continue',
      requestId: 'shared-queue-child-continue',
      eventId: 'shared-queue-child-continue',
      expectedTaskId: child.taskId,
      expectedWaitRevision: child.waitRevision
    })
    expect(completed.task.state).toBe('completed')
    const resumed = await f.host.run({
      ...input,
      action: 'continue',
      requestId: 'shared-queue-root-continue',
      eventId: 'shared-queue-root-continue',
      expectedTaskId: waiting.task.taskId,
      expectedWaitRevision: reconciled.task.waitRevision
    })
    expect(resumed.task.state).toBe('completed')
    expect(resumed.task.children?.map((item) => item.state)).toEqual(['completed', 'completed'])
    expect(f.count().executions).toBe(4)
  })
  it('PER-03 drains four shared-target branches without starvation across repeated bounded waves', async () => {
    let activeDeliveries = 0,
      maxActiveDeliveries = 0
    const deliveryOrder: string[] = []
    const firstDeliveryOrder: string[] = []
    const firstDeliveryAt = new Map<string, number>()
    const waitSamples: Array<{ wave: number; nodeId: string; taskId: string; waitMs: number }> = []
    const childTaskIdsByWave: string[][] = []
    let waveStartedAt = 0
    const f = fixture({
      parallel: true,
      human: true,
      coordinate: parallelDecision,
      deliveryDuring: async (targetNodeId, taskId) => {
        if (targetNodeId !== 'process-first') throw new Error('unexpected target')
        activeDeliveries++
        maxActiveDeliveries = Math.max(maxActiveDeliveries, activeDeliveries)
        deliveryOrder.push(taskId)
        if (!firstDeliveryAt.has(taskId)) {
          firstDeliveryAt.set(taskId, performance.now())
          firstDeliveryOrder.push(taskId)
        }
        await new Promise((resolve) => setTimeout(resolve, 1))
        activeDeliveries--
      }
    })
    extendParallelFixture(f, 4)
    for (const nodeId of ['second', 'third', 'fourth']) {
      const config = JSON.parse(f.byId[nodeId].props.config)
      config.allowedNodeIds = ['process-first']
      config.interactionMode = 'autonomous'
      f.byId[nodeId].props.config = JSON.stringify(config)
      f.file.nodes.find((node) => node.id === nodeId)!.params.config = config
    }
    const firstConfig = JSON.parse(f.byId.first.props.config)
    firstConfig.interactionMode = 'collaborative'
    f.byId.first.props.config = JSON.stringify(firstConfig)
    f.file.nodes.find((node) => node.id === 'first')!.params.config = firstConfig

    const waveTaskIds: string[] = []
    for (let wave = 0; wave < 4; wave++) {
      const startedAt = Date.now()
      waveStartedAt = performance.now()
      const waiting = await f.host.run({
        ...input,
        requestId: `per03-wave-${wave}-start`,
        traceId: `per03-wave-${wave}-start-trace`,
        spanId: `per03-wave-${wave}-start-span`
      })
      expect(waiting.task.state).toBe('waiting')
      expect(waiting.task.children?.map((child) => child.state)).toEqual([
        'waiting',
        'queued',
        'queued',
        'queued'
      ])
      expect(waiting.task.children?.map((child) => child.nodeId)).toEqual([
        'first',
        'second',
        'third',
        'fourth'
      ])
      childTaskIdsByWave.push((waiting.task.children ?? []).map((child) => child.taskId))
      waveTaskIds.push(waiting.task.taskId)

      const reconciled = await f.coordinator.run({
        ...input,
        action: 'reconcile',
        requestId: `per03-wave-${wave}-reconcile`,
        eventId: `per03-wave-${wave}-reconcile`,
        expectedTaskId: waiting.task.taskId,
        expectedWaitRevision: waiting.task.waitRevision
      })
      expect(reconciled.task.children?.map((child) => child.state)).toEqual([
        'waiting',
        'queued',
        'queued',
        'queued'
      ])

      const child = f.host.inspect({ projectId: 'p', nodeId: 'first' })!
      const childDone = await f.host.run({
        ...input,
        nodeId: 'first',
        action: 'continue',
        requestId: `per03-wave-${wave}-child-continue`,
        eventId: `per03-wave-${wave}-child-continue`,
        expectedTaskId: child.taskId,
        expectedWaitRevision: child.waitRevision
      })
      expect(childDone.task.state).toBe('completed')

      const completed = await f.host.run({
        ...input,
        action: 'continue',
        requestId: `per03-wave-${wave}-root-continue`,
        eventId: `per03-wave-${wave}-root-continue`,
        expectedTaskId: waiting.task.taskId,
        expectedWaitRevision: reconciled.task.waitRevision
      })
      expect(completed.task.state).toBe('completed')
      expect(completed.task.children?.map((child) => child.state)).toEqual([
        'completed',
        'completed',
        'completed',
        'completed'
      ])
      for (const child of waiting.task.children ?? []) {
        const firstDelivery = firstDeliveryAt.get(child.taskId)
        expect(firstDelivery, `missing first delivery for ${child.nodeId}`).toBeDefined()
        waitSamples.push({
          wave,
          nodeId: child.nodeId,
          taskId: child.taskId,
          waitMs: Math.max(0, firstDelivery! - waveStartedAt)
        })
      }
      expect(f.count().executions).toBe((wave + 1) * 8)
      expect(Date.now() - startedAt).toBeLessThan(10000)
      expect(activeDeliveries).toBe(0)
      expect(() =>
        f.ledger.assertNodeAvailable({ projectId: 'p', nodeId: 'process-first' })
      ).not.toThrow()
    }
    expect(new Set(waveTaskIds).size).toBe(4)
    expect(deliveryOrder).toHaveLength(32)
    expect(firstDeliveryOrder).toEqual(childTaskIdsByWave.flat())
    expect(maxActiveDeliveries).toBe(1)
    expect(f.deliveryErrors).toEqual([])

    const orderedWaits = waitSamples.map((sample) => sample.waitMs).sort((a, b) => a - b)
    const percentile = (fraction: number): number =>
      orderedWaits[Math.max(0, Math.ceil(orderedWaits.length * fraction) - 1)] ?? 0
    const distribution = {
      sampleCount: waitSamples.length,
      minMs: orderedWaits[0] ?? 0,
      p50Ms: percentile(0.5),
      p95Ms: percentile(0.95),
      maxMs: orderedWaits.at(-1) ?? 0,
      samples: waitSamples
    }
    expect(distribution.sampleCount).toBe(16)
    expect(Number.isFinite(distribution.p95Ms)).toBe(true)
    if (process.env.CANVAS_PER03_WAIT_REPORT) {
      await writeFile(process.env.CANVAS_PER03_WAIT_REPORT, JSON.stringify(distribution, null, 2))
    }
  })
  it('preserves a successful sibling when the other branch fails', async () => {
    const f = fixture({ parallel: true, coordinate: parallelDecision })
    const original = f.host.runAssignment.bind(f.host)
    vi.spyOn(f.host, 'runAssignment').mockImplementation((request, ...args) =>
      request.nodeId === 'second'
        ? Promise.reject(new Error('isolated failure'))
        : original(request, ...args)
    )
    await expect(f.host.run(input)).rejects.toThrow('isolated failure')
    const run = f.coordinator.store.latest('p', 'main')!
    expect(run.state).toBe('blocked')
    expect(run.children.map((child) => child.state)).toEqual(['completed', 'blocked'])
    expect(run.children[0].outputs).toHaveLength(1)
    expect(f.byId.first.meta.nodeResult).toBeTruthy()
  })
  it('reconciles a completed parallel sibling beside an unconfirmed child without replaying either branch', async () => {
    const f = fixture({ parallel: true, coordinate: parallelDecision })
    const original = f.host.runAssignment.bind(f.host)
    vi.spyOn(f.host, 'runAssignment').mockImplementation((request, ...args) =>
      request.nodeId === 'second'
        ? Promise.reject(new Error('worker exited before its checkpoint was confirmed'))
        : original(request, ...args)
    )
    await expect(f.host.run(input)).rejects.toThrow(
      'worker exited before its checkpoint was confirmed'
    )
    const run = f.coordinator.store.latest('p', 'main')!
    expect(run.state).toBe('blocked')
    expect(run.children.map((child) => child.state)).toEqual(['completed', 'blocked'])
    expect(f.byId.first.meta.nodeResult).toBeTruthy()
    expect(f.byId.second.meta.nodeResult).toBeUndefined()
    const before = f.count()
    const reconciled = await f.host.run({
      ...input,
      action: 'reconcile',
      requestId: 'reconcile-mixed-parallel-facts',
      eventId: 'reconcile-mixed-parallel-facts',
      expectedTaskId: run.taskId,
      expectedWaitRevision: run.waitRevision
    })
    expect(reconciled.task.state).toBe('blocked')
    expect(reconciled.task.children?.map((child) => child.state)).toEqual(['completed', 'blocked'])
    expect(reconciled.task.recovery).toEqual({
      reasons: ['FLOW_TASK_CHECKPOINT_UNCONFIRMED'],
      canRestore: false
    })
    expect(f.byId.first.meta.nodeResult).toBeTruthy()
    expect(f.byId.second.meta.nodeResult).toBeUndefined()
    expect(f.count()).toEqual(before)
  })
  it('stops both in-flight branches and ignores late replies', async () => {
    const both = deferred(),
      release = deferred(),
      entered = new Set<string>()
    const f = fixture({
      parallel: true,
      coordinate: parallelDecision,
      deliveryDuring: async (id) => {
        entered.add(id)
        if (entered.size === 2) both.resolve()
        await release.promise
      }
    })
    const running = f.host.run(input)
    await both.promise
    const stopped = f.host.stop({ projectId: 'p', nodeId: 'main' })!
    expect(stopped.state).toBe('cancelled')
    expect(stopped.children?.every((child) => child.state === 'cancelled')).toBe(true)
    release.resolve()
    expect((await running).task.state).toBe('cancelled')
    expect(f.byId.first.meta.nodeResult).toBeUndefined()
    expect(f.byId.second.meta.nodeResult).toBeUndefined()
    expect(f.count().modelCalls).toBe(1)
    const saved = f.coordinator.store.latest('p', 'main')!
    const replay = await f.host.run({
      ...input,
      action: 'reconcile',
      eventId: 'reconcile-stop',
      expectedTaskId: saved.taskId,
      expectedWaitRevision: saved.waitRevision
    })
    expect(replay.task.state).toBe('cancelled')
    expect(f.count().modelCalls).toBe(1)
  })
  it.each([false, true])(
    'collects a completed sibling while another child waits (review wait: %s)',
    async (reviewWait) => {
      const f = fixture({ parallel: true, human: true, coordinate: parallelDecision })
      // Both branches deliberately wait so completion can arrive in reverse order.
      const config = JSON.parse(f.byId.first.props.config)
      config.interactionMode = 'collaborative'
      f.byId.first.props.config = JSON.stringify(config)
      f.file.nodes.find((node) => node.id === 'first')!.params.config = f.byId.first.props.config
      const waiting = await f.host.run(input)
      expect(waiting.task.state).toBe('waiting')
      const child = f.host.inspect({ projectId: 'p', nodeId: 'second' })!
      await f.host.run({
        ...input,
        nodeId: 'second',
        action: 'continue',
        requestId: 'second-continue',
        eventId: 'second-continue',
        expectedTaskId: child.taskId,
        expectedWaitRevision: child.waitRevision
      })
      if (reviewWait) vi.spyOn(CoordinatorReviews.prototype, 'step').mockResolvedValue('wait')
      const resumed = await f.host.run({
        ...input,
        action: 'continue',
        requestId: 'main-continue',
        eventId: 'main-continue',
        expectedTaskId: waiting.task.taskId,
        expectedWaitRevision: waiting.task.waitRevision
      })
      expect(resumed.task.state).toBe('waiting')
      expect(resumed.task.children?.map((child) => child.state)).toEqual(['waiting', 'completed'])
      expect(f.byId.second.meta.nodeResult).toBeTruthy()
      expect(f.count()).toEqual({ executions: 4, modelCalls: 1 })
    }
  )
})

it('stopping a parallel join preserves a sibling that already completed authoritatively', async () => {
  const firstDone = deferred(),
    release = deferred(),
    secondEntered = deferred()
  const f = fixture({ parallel: true, coordinate: parallelDecision })
  const original = f.host.runAssignment.bind(f.host)
  vi.spyOn(f.host, 'runAssignment').mockImplementation(async (request, ...args) => {
    if (request.nodeId === 'second') {
      secondEntered.resolve()
      await release.promise
    }
    const reply = await original(request, ...args)
    if (request.nodeId === 'first') firstDone.resolve()
    return reply
  })
  const pending = f.host.run(input)
  await Promise.all([firstDone.promise, secondEntered.promise])
  const stopped = f.host.stop({ projectId: 'p', nodeId: 'main' })!
  expect(stopped.children?.map((child) => child.state)).toEqual(['completed', 'cancelled'])
  expect(f.coordinator.store.latest('p', 'main')!.children[0].outputs).toHaveLength(1)
  release.resolve()
  expect((await pending).task.state).toBe('cancelled')
  expect(f.count().executions).toBe(2)
  expect(f.byId.first.meta.nodeResult).toBeUndefined()
})
it('restores both completed parallel projections without running another tool or decision', async () => {
  const options = { parallel: true, coordinate: parallelDecision, publicationFails: true }
  const f = fixture(options)
  await expect(f.host.run(input)).rejects.toThrow()
  const run = f.coordinator.store.latest('p', 'main')!
  expect(run.children.map((child) => child.state)).toEqual(['completed', 'completed'])
  const before = f.count()
  options.publicationFails = false
  const restored = await f.host.run({
    ...input,
    action: 'restore',
    requestId: 'restore-both',
    eventId: 'restore-both',
    expectedTaskId: run.taskId,
    expectedWaitRevision: run.waitRevision
  })
  expect(restored.task.state).toBe('waiting')
  expect(f.byId.first.meta.nodeResult).toBeTruthy()
  expect(f.byId.second.meta.nodeResult).toBeTruthy()
  expect(f.count()).toEqual(before)
  const completed = await f.host.run({
    ...input,
    action: 'continue',
    requestId: 'join-restored',
    eventId: 'join-restored',
    expectedTaskId: run.taskId,
    expectedWaitRevision: restored.task.waitRevision
  })
  expect(completed.task.state).toBe('completed')
  expect(f.count().executions).toBe(4)
})
