import { afterEach, describe, expect, it, vi } from 'vitest'
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
import type { FlowAgentReply } from '../src/shared/agent-flow/desktop-tasks'
import { setGatewayEventSink } from '../src/main/diagnostics/gateway-events'

/**
 * AF-01 固定顺序协调验收：两阶段按声明顺序交接；缺字段/缺人工决定不能越过；
 * 主控不调用模型；正式交付绑定最后阶段的具体产物；旧模式语义由既有 coordinator 测试保护。
 */
const dbs: Database.Database[] = []
afterEach(() => {
  vi.restoreAllMocks()
  dbs.splice(0).forEach((db) => db.close())
  setGatewayEventSink(null)
})
const input = {
  projectId: 'p',
  nodeId: 'main',
  requestId: 'flow-fixed-1',
  traceId: 'trace',
  spanId: 'span',
  action: 'start' as const
}

function fixture(
  options: {
    stages?: Array<Record<string, unknown>>
    secondCollaborative?: boolean
    requireHumanDecision?: boolean
    publicationFails?: boolean
    // 第一阶段交付的 JSON 内容（用于进入条件场景）；缺省交付纯文本。
    firstJson?: Record<string, unknown>
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
  const stages = options.stages ?? [
    { stageKey: 'organize', nodeId: 'first', goal: '整理材料', completion: '交付整理成果' },
    {
      stageKey: 'write',
      nodeId: 'second',
      goal: '基于整理成果写作',
      completion: '交付成稿',
      ...(options.requireHumanDecision ? { requireHumanDecision: true } : {})
    }
  ]
  const mainConfig = {
    ...cfg('coordinator', ['first', 'second']),
    executionMode: 'fixed-order',
    stages
  }
  mainConfig.relations = [
    { relationId: 'state', kind: 'observes', sourceNodeId: 'main', targetNodeId: 'state' }
  ]
  const secondConfig = cfg('specialist', ['process-second'])
  if (options.secondCollaborative || options.requireHumanDecision)
    secondConfig.interactionMode = 'collaborative'
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
    ],
    relations: []
  }
  const shapes = [
    shape('material', 'text', 'private-source'),
    shape('main', 'agent', '固定任务：先整理再写作', mainConfig),
    shape('first', 'agent', '整理', cfg('specialist', ['process-first'])),
    shape('second', 'agent', '写作', secondConfig),
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
  // 第一阶段交付 JSON 时，其正式输出端口为 out-json；下游边须从真实端口接入。
  const firstOutPort = options.firstJson ? 'out-json' : 'out-text'
  const secondInPort = options.firstJson ? 'in-json' : 'in-text'
  const file: ProjectFile = {
    version: 1,
    meta: { id: 'p', name: 'isolated', createdAt: 0, updatedAt: 0, graphVersion: 1 },
    nodes: shapes.map(node),
    edges: [
      edge('material', 'out-text', 'first', 'in-text'),
      edge('material', 'out-text', 'process-first', 'in-value'),
      edge('first', firstOutPort, 'second', secondInPort),
      edge('first', firstOutPort, 'process-second', 'in-value')
    ],
    groups: [],
    tldrawSnapshot: { store: byId }
  }
  const files = new Map<string, ProjectFile>([['p', file]])
  const open = (id: string): ProjectFile | null => files.get(id) ?? null
  const assets = new FlowAssetStore(db, open),
    ledger = new FlowCommandLedger(db, open)
  let executions = 0,
    coordinatorModelCalls = 0
  const host = new FlowAgentDesktopHost(
    db,
    open,
    {
      ledger,
      isActive: () => true,
      deliver: async (grant) => {
        executions++
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
        // 第一阶段可配置交付 JSON（进入条件场景）；其余按来源透传。
        target.meta.nodeResult = JSON.stringify(
          c.targetNodeId === 'process-first' && options.firstJson
            ? { kind: 'json', data: options.firstJson }
            : source
        )
        file.meta.graphVersion++
        ledger.commit({ projectId: c.projectId, commandId: c.commandId })
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
  // 固定顺序模式的主控模型工厂：一旦被调用即失败，证明推进不依赖模型。
  const coordinatorModel: AgentModelPort = {
    decide: async () => {
      throw new Error('not a specialist')
    },
    coordinate: async () => {
      coordinatorModelCalls++
      throw new Error('FIXED_ORDER_MUST_NOT_CALL_COORDINATOR_MODEL')
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
    async () => coordinatorModel,
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
    count: () => ({ executions, coordinatorModelCalls })
  }
}

describe('AF-01 fixed-order coordination', () => {
  it('两个阶段按声明顺序交接，主控零模型调用，交付绑定最后阶段产物', async () => {
    const f = fixture()
    const result = await f.host.run(input)
    expect(result.task.state).toBe('completed')
    expect(result.task.children?.map((c) => c.nodeId)).toEqual(['first', 'second'])
    expect(result.outputs['out-text']).toEqual({ kind: 'text', text: 'private-source' })
    expect(f.count()).toEqual({ executions: 4, coordinatorModelCalls: 0 })
    // 阶段目标/完成条件逐字来自声明配置
    const snapshots = (
      f.db.prepare('SELECT snapshot_json FROM flow_agent_tasks ORDER BY rowid').all() as Array<{
        snapshot_json: string
      }>
    ).map((row) => JSON.parse(row.snapshot_json))
    expect(snapshots[0].goal).toContain('整理材料')
    expect(snapshots[1].goal).toContain('基于整理成果写作')
    expect(snapshots[1].directInputs[0].sourceNodeId).toBe('first')
    // 重跑幂等：不重复执行
    await f.host.run(input)
    expect(f.count().executions).toBe(4)
  })

  it('进入条件字段缺失 → 阻断，不越过分派下游', async () => {
    const f = fixture({
      firstJson: { evidence: [] },
      stages: [
        { stageKey: 'organize', nodeId: 'first', goal: '整理', completion: '交付证据' },
        {
          stageKey: 'write',
          nodeId: 'second',
          goal: '写作',
          completion: '交付成稿',
          entry: [{ kind: 'output-field', stageKey: 'organize', path: 'evidence.0', op: 'exists' }]
        }
      ]
    })
    await expect(f.host.run(input)).rejects.toMatchObject({ code: 'FLOW_STAGE_ENTRY_UNMET' })
    expect(f.coordinator.inspect({ projectId: 'p', nodeId: 'main' })?.state).toBe('blocked')
    // 只执行了第一阶段（2 次），下游未执行
    expect(f.count().executions).toBe(2)
    expect(f.byId['process-second'].meta.nodeRun).toBeUndefined()
  })

  it('进入条件满足 → 正常交接（JSON 字段路径）', async () => {
    const f = fixture({
      firstJson: { evidence: [{ src: 'a' }] },
      stages: [
        { stageKey: 'organize', nodeId: 'first', goal: '整理', completion: '交付证据' },
        {
          stageKey: 'write',
          nodeId: 'second',
          goal: '写作',
          completion: '交付成稿',
          entry: [
            {
              kind: 'output-field',
              stageKey: 'organize',
              path: 'evidence.0.src',
              op: 'equals',
              value: 'a'
            }
          ]
        }
      ]
    })
    const result = await f.host.run(input)
    expect(result.task.state).toBe('completed')
    expect(f.count().executions).toBe(4)
  })

  it('要求人工采用的阶段：无显式人工决定不能收尾；人工采用后继续完成', async () => {
    const f = fixture({ requireHumanDecision: true })
    const waiting = await f.host.run(input)
    // 第二阶段协作停等 → 主控等待；即使子任务完成也需人工采用
    expect(waiting.task.state).toBe('waiting')
    const child = waiting.task.children!.find((c) => c.nodeId === 'second')!
    const childView = f.host.inspect({ projectId: 'p', nodeId: 'second' })!
    const resumed = await f.host.run({
      ...input,
      nodeId: 'second',
      action: 'continue',
      requestId: 'human-adopt',
      eventId: 'human-adopt',
      expectedTaskId: child.taskId,
      expectedWaitRevision: childView.waitRevision
    })
    await f.publish('second', resumed)
    const done = await f.host.run({
      ...input,
      action: 'continue',
      requestId: 'main-resume',
      eventId: 'main-resume',
      expectedTaskId: waiting.task.taskId,
      expectedWaitRevision: waiting.task.waitRevision
    })
    expect(done.task.state).toBe('completed')
    expect(f.count().coordinatorModelCalls).toBe(0)
  })

  it('发布中断后 reconcile/restore 不触发模型、不重复执行', async () => {
    const f = fixture({ publicationFails: true })
    await expect(f.host.run(input)).rejects.toThrow()
    const run = f.coordinator.store.latest('p', 'main')!
    const count = f.count()
    const recovered = await f.host.run({
      ...input,
      action: 'reconcile',
      requestId: 'reconcile',
      eventId: 'reconcile',
      expectedTaskId: run.taskId,
      expectedWaitRevision: run.waitRevision
    })
    expect(['waiting', 'blocked']).toContain(recovered.task.state)
    expect(f.count()).toEqual(count)
  })

  it('阶段承载节点不在授权范围 / 未覆盖全部子节点 → 准入拒绝', async () => {
    const f = fixture({
      stages: [{ stageKey: 'only', nodeId: 'first', goal: '整理', completion: '交付' }]
    })
    await expect(f.host.run(input)).rejects.toMatchObject({ code: 'FLOW_STAGE_SCOPE_INVALID' })
    expect(f.count().executions).toBe(0)
  })

  it('阶段诊断事件只记身份与计数，不泄漏正文', async () => {
    const events: Array<{ event?: string; attributes?: Record<string, unknown> }> = []
    setGatewayEventSink({
      emit: (event) => {
        if (event) events.push(event as never)
      }
    })
    const f = fixture()
    await f.host.run(input)
    const dispatched = events.filter((e) => e.event === 'agent.coordination.stage_dispatched')
    expect(dispatched.length).toBe(2)
    expect(dispatched[0].attributes).toMatchObject({ stageKey: 'organize', carrierNodeId: 'first' })
    // 目标/正文/完成条件不得进入任何诊断事件
    expect(JSON.stringify(events)).not.toContain('private-source')
    expect(JSON.stringify(events)).not.toContain('整理材料')
    expect(JSON.stringify(events)).not.toContain('基于整理成果写作')
  })
})

describe('AF-02 fixed-order context manifest', () => {
  const writeStages = (inputs: Record<string, unknown>) => [
    { stageKey: 'organize', nodeId: 'first', goal: '整理', completion: '交付' },
    { stageKey: 'write', nodeId: 'second', goal: '写作', completion: '交付', inputs }
  ]
  const snapshotsOf = (f: ReturnType<typeof fixture>) =>
    (
      f.db.prepare('SELECT snapshot_json FROM flow_agent_tasks ORDER BY rowid').all() as Array<{
        snapshot_json: string
      }>
    ).map((row) => JSON.parse(row.snapshot_json))

  it('阶段只取声明字段，manifest 随子任务持久化，无关内容不进入', async () => {
    const noise = 'x'.repeat(5000)
    const f = fixture({
      firstJson: { evidence: ['必需'], noise },
      stages: writeStages({
        selectors: [{ sourceStageKey: 'organize', path: 'evidence' }],
        budgetBytes: 4096
      })
    })
    const result = await f.host.run(input)
    expect(result.task.state).toBe('completed')
    const write = snapshotsOf(f).find((s) => s.agentNodeId === 'second')
    expect(write.contextManifest).toBeTruthy()
    expect(write.contextManifest.entries).toHaveLength(1)
    expect(write.contextManifest.entries[0].value).toEqual(['必需'])
    expect(JSON.stringify(write.contextManifest)).not.toContain(noise)
    expect(write.contextManifest.budget.exceeded).toBe(false)
  })

  it('必需字段缺失 → FLOW_CONTEXT_REQUIRED_MISSING 阻断，下游不执行', async () => {
    const f = fixture({
      firstJson: { other: 1 },
      stages: writeStages({ selectors: [{ sourceStageKey: 'organize', path: 'absent' }] })
    })
    await expect(f.host.run(input)).rejects.toMatchObject({ code: 'FLOW_CONTEXT_REQUIRED_MISSING' })
    expect(f.coordinator.inspect({ projectId: 'p', nodeId: 'main' })?.state).toBe('blocked')
    expect(f.count().executions).toBe(2) // 仅第一阶段
    expect(f.byId['process-second'].meta.nodeRun).toBeUndefined()
  })

  it('必需内容超预算 → FLOW_CONTEXT_OVER_BUDGET，不静默截断', async () => {
    const f = fixture({
      firstJson: { evidence: 'r'.repeat(5000) },
      stages: writeStages({
        selectors: [{ sourceStageKey: 'organize', path: 'evidence' }],
        budgetBytes: 1024
      })
    })
    await expect(f.host.run(input)).rejects.toMatchObject({ code: 'FLOW_CONTEXT_OVER_BUDGET' })
    expect(f.count().executions).toBe(2)
  })

  it('可选内容超预算被丢弃，必需内容保留，流程继续', async () => {
    const f = fixture({
      firstJson: { evidence: 'r'.repeat(100), optional: 'o'.repeat(5000) },
      stages: writeStages({
        budgetBytes: 2048,
        selectors: [
          { sourceStageKey: 'organize', path: 'evidence', required: true },
          { sourceStageKey: 'organize', path: 'optional', required: false }
        ]
      })
    })
    const result = await f.host.run(input)
    expect(result.task.state).toBe('completed')
    const write = snapshotsOf(f).find((s) => s.agentNodeId === 'second')
    expect(write.contextManifest.entries.map((e: { path: string }) => e.path)).toEqual(['evidence'])
    expect(write.contextManifest.dropped).toHaveLength(1)
  })
})

describe('AF-03 fixed-order execution envelope', () => {
  it('阶段目标/方法/输出要求随子任务持久化为执行信封', async () => {
    const f = fixture({
      stages: [
        { stageKey: 'organize', nodeId: 'first', goal: '整理材料', completion: '交付整理成果' },
        {
          stageKey: 'write',
          nodeId: 'second',
          goal: '基于整理成果写作',
          completion: '交付成稿',
          method: { instructions: '先案例后分析' }
        }
      ]
    })
    const result = await f.host.run(input)
    expect(result.task.state).toBe('completed')
    const snapshots = (
      f.db.prepare('SELECT snapshot_json FROM flow_agent_tasks ORDER BY rowid').all() as Array<{
        snapshot_json: string
      }>
    ).map((row) => JSON.parse(row.snapshot_json))
    const write = snapshots.find((s) => s.agentNodeId === 'second')
    expect(write.executionEnvelope).toBeTruthy()
    expect(write.executionEnvelope.stageGoal).toBe('基于整理成果写作')
    expect(write.executionEnvelope.methodInstructions).toBe('先案例后分析')
    expect(write.executionEnvelope.outputRequirements).toBe('交付成稿')
    // 无方法声明的阶段信封仍含目标/输出要求（缺省 method 不影响）
    const organize = snapshots.find((s) => s.agentNodeId === 'first')
    expect(organize.executionEnvelope.stageGoal).toBe('整理材料')
    expect(organize.executionEnvelope.methodInstructions).toBeUndefined()
  })
})
