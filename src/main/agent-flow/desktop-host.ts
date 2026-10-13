import type Database from 'better-sqlite3'
import { randomUUID } from 'node:crypto'
import type { ProjectFile } from '../../shared/types'
import { AgentNodeConfigSchema } from '../../shared/agent-flow/node-contracts'
import {
  AgentTaskSnapshotSchema,
  AgentRuntimeError,
  type AgentTaskSnapshot
} from '../../shared/agent-flow/runtime-contracts'
import {
  FlowAgentRunSchema,
  type FlowAgentRun,
  type FlowAgentReply,
  type FlowAgentView,
  type FlowAgentCatalog,
  FlowAgentCollaborationSchema,
  type FlowAgentCollaborationView
} from '../../shared/agent-flow/desktop-tasks'
import { FlowSkillStore, BUILTIN_FLOW_SKILLS } from './skill-store'
import { FlowTaskStore, agentThread, type AgentTaskRecord } from './task-store'
import { FlowAssetStore } from './asset-store'
import { createAgentRuntime, type AgentRuntime, type AgentModelPort } from './runtime'
import { createAgentTelemetry } from './runtime-diagnostics'
import { createLedgerToolPort } from './ledger-tool'
import type { FlowCommandDesktop } from '../ipc/flow-commands.ipc'
import { projectSemanticRevision, collaborationScopeRevision } from './command-intent'
import { FlowCollaborationStore } from './collaboration-store'
import type { FlowCommandReceipt } from '../../shared/agent-flow/commands'
import { readPinnedOutputs } from '../../shared/engine/deterministic-projections'
import { canonicalFlowJson } from '../../shared/agent-flow/semantic-revision'
import type { z } from 'zod'
import { AgentFlowAssetRefSchema } from '../../shared/agent-flow/node-contracts'
import type { CoordinatorPort, ModelIdentity } from '../../shared/agent-flow/coordination'
import { CoordinationStore } from './coordination-store'
import { FlowReviewStore, reviewBinding } from './review-store'

type Identity = { projectId: string; nodeId: string }
const view = (record: AgentTaskRecord): FlowAgentView => ({
  taskId: record.snapshot.taskId,
  state: record.state,
  waitKind: record.waitKind,
  waitRevision: record.waitRevision,
  decisions: record.decisions,
  tools: record.tools,
  code: record.code,
  prepared: record.state === 'ready' && !!record.snapshot.parentTaskId
})

/** Trusted desktop admission derives all execution scope from the saved canvas. */
export class FlowAgentDesktopHost {
  private coordinator?: CoordinatorPort
  setCoordinator(port: CoordinatorPort): void {
    this.coordinator = port
  }
  private readonly store: FlowTaskStore
  private readonly skills: FlowSkillStore
  private readonly assets: FlowAssetStore
  private readonly active = new Map<string, AgentRuntime>()
  private readonly admission = new Set<string>()
  private readonly controllers = new Map<string, AbortController>()
  constructor(
    private readonly db: Database.Database,
    private readonly open: (projectId: string) => ProjectFile | null,
    private readonly desktop: FlowCommandDesktop,
    private readonly model: (
      snapshot: ModelIdentity,
      signal: AbortSignal
    ) => Promise<AgentModelPort>
  ) {
    this.store = new FlowTaskStore(db)
    this.skills = new FlowSkillStore(db)
    this.assets = new FlowAssetStore(db, open)
    for (const skill of BUILTIN_FLOW_SKILLS) this.skills.import(skill)
  }

  private key(input: Identity): string {
    return JSON.stringify([input.projectId, input.nodeId])
  }
  private saved(input: Identity): {
    file: ProjectFile
    shape: {
      id: string
      props: { nodeType: string; config: string; text: string }
      meta?: Record<string, unknown>
    }
  } {
    if (!this.desktop.isActive(input.projectId))
      throw new AgentRuntimeError('FLOW_PROJECT_INACTIVE', 'admission')
    const file = this.open(input.projectId)
    if (!file) throw new AgentRuntimeError('FLOW_PROJECT_MISSING', 'admission')
    const record = (file.tldrawSnapshot as { store?: Record<string, unknown> } | undefined)
      ?.store?.[input.nodeId] as ReturnType<FlowAgentDesktopHost['saved']>['shape'] | undefined
    if (!record || record.props.nodeType !== 'agent')
      throw new AgentRuntimeError('AGENT_NODE_MISSING', 'admission')
    return { file, shape: record }
  }

  private latest(input: Identity): AgentTaskRecord | null {
    const row = this.db
      .prepare(
        'SELECT thread FROM flow_agent_tasks WHERE project_id=? AND agent_node_id=? ORDER BY rowid DESC LIMIT 1'
      )
      .get(input.projectId, input.nodeId) as { thread: string } | undefined
    return row ? this.store.read(row.thread) : null
  }
  inspect(input: Identity): FlowAgentView | null {
    const file = this.open(input.projectId)
    const type = (
      file?.tldrawSnapshot as {
        store?: Record<string, { props: { nodeType: string; config: string } }>
      }
    )?.store?.[input.nodeId]?.props
    if (
      this.coordinator &&
      (type?.nodeType === 'state-machine' ||
        (type?.nodeType === 'agent' && JSON.parse(type.config).role === 'coordinator'))
    )
      return this.coordinator.inspect(input)
    this.saved(input)
    const record = this.latest(input)
    if (!record) return null
    if (
      (record.state === 'running' || (record.state === 'ready' && !record.snapshot.parentTaskId)) &&
      !this.active.has(this.key(input)) &&
      !this.admission.has(this.key(input))
    ) {
      this.store.setState(agentThread(record.snapshot), 'blocked', 'AGENT_SESSION_LOST')
      createAgentTelemetry(record.snapshot)('blocked', 'session-recovery', 'AGENT_SESSION_LOST')
      return view(this.store.read(agentThread(record.snapshot)))
    }
    return view(record)
  }
  stop(input: Identity): FlowAgentView | null {
    if (this.coordinator && JSON.parse(this.saved(input).shape.props.config).role === 'coordinator')
      return this.coordinator.stop(input)
    this.saved(input)
    this.controllers.get(this.key(input))?.abort()
    const runtime = this.active.get(this.key(input))
    if (runtime) return view(runtime.cancel())
    const record = this.latest(input)
    if (!record) return null
    if (!['completed', 'cancelled', 'failed'].includes(record.state)) {
      this.store.setState(agentThread(record.snapshot), 'cancelled', 'AGENT_CANCELLED')
      createAgentTelemetry(record.snapshot)('cancelled', 'stop')
    }
    return view(this.store.read(agentThread(record.snapshot)))
  }
  catalog(input: Identity, models: FlowAgentCatalog['models']): FlowAgentCatalog {
    // A new node can open settings before its first autosave. This is a read-only
    // catalog; task admission still requires the complete saved node and graph.
    if (!this.desktop.isActive(input.projectId) || !this.open(input.projectId))
      throw new AgentRuntimeError('FLOW_PROJECT_INACTIVE', 'catalog')
    return {
      models,
      tools: [
        { id: 'node.execute', version: '1', name: '执行画布数据处理节点' },
        { id: 'graph.preview', version: '1', name: '文本模板流程预览' },
        { id: 'agent.dispatch', version: '1', name: '分派专业 Agent 任务' }
      ],
      skills: BUILTIN_FLOW_SKILLS.map(({ id, version, name, description }) => ({
        id,
        version,
        name,
        description
      }))
    }
  }

  private bind(raw: FlowAgentRun): AgentTaskSnapshot {
    const { file, shape } = this.saved(raw)
    const config = AgentNodeConfigSchema.parse(JSON.parse(shape.props.config))
    if (config.role !== 'specialist')
      throw new AgentRuntimeError('AGENT_ROLE_NOT_READY', 'admission')
    if (!shape.props.text.trim()) throw new AgentRuntimeError('AGENT_GOAL_REQUIRED', 'admission')
    if (!config.modelDefinitionId) throw new AgentRuntimeError('AGENT_MODEL_REQUIRED', 'admission')
    if (!config.tools.some((tool) => tool.id === 'node.execute' && tool.version === '1'))
      throw new AgentRuntimeError('AGENT_TOOL_REQUIRED', 'admission')
    if (config.tools.some((tool) => tool.id !== 'node.execute' || tool.version !== '1'))
      throw new AgentRuntimeError('AGENT_TOOL_UNSUPPORTED', 'admission')
    const versions = new Map<string, z.infer<typeof AgentFlowAssetRefSchema>>()
    const freeze = (
      from: { nodeId: string; portId: string },
      submissionId: string
    ): z.infer<typeof AgentFlowAssetRefSchema> => {
      const key = JSON.stringify(from)
      const prior = versions.get(key)
      if (prior) return prior
      for (const review of file.nodes.filter((node) => node.type === 'ai-review')) {
        const approval = new FlowReviewStore(this.db).approval(file, review.id)
        if (!approval) continue
        const binding = reviewBinding(file, review.id)
        if (
          !binding.config.gatedNodeIds.some(
            (id) => config.allowedNodeIds.includes(id) || id === raw.nodeId
          )
        )
          continue
        const index = binding.config.subjectSources.findIndex(
          (source) => source.nodeId === from.nodeId && source.portId === from.portId
        )
        if (index >= 0) {
          const ref = approval.decision.subjects[index]
          versions.set(key, ref)
          return ref
        }
      }
      const source = (
        file.tldrawSnapshot as { store: Record<string, { meta?: Record<string, unknown> }> }
      ).store[from.nodeId]
      const stored = source?.meta?.flowAssetRef
      let ref: z.infer<typeof AgentFlowAssetRefSchema>
      if (typeof stored === 'string') {
        ref = AgentFlowAssetRefSchema.parse(JSON.parse(stored))
        const value = this.assets.resolveInputs(raw.projectId, [ref])[0].value
        const pinned = readPinnedOutputs(source.meta?.pinnedOutput)?.[from.portId]
        if (!pinned || canonicalFlowJson(pinned) !== canonicalFlowJson(value))
          throw new AgentRuntimeError('AGENT_INPUT_NOT_FIXED', 'admission')
      } else {
        ref = this.assets.submit({
          projectId: raw.projectId,
          nodeId: from.nodeId,
          portId: from.portId,
          submissionId,
          expectedGraphVersion: file.meta.graphVersion,
          traceId: raw.traceId,
          spanId: raw.spanId
        }).ref
      }
      versions.set(key, ref)
      return ref
    }
    const targets = config.allowedNodeIds.map((nodeId) => {
      const node = file.nodes.find((item) => item.id === nodeId)
      if (!node || node.type !== 'processor' || node.contractVersion !== 1)
        throw new AgentRuntimeError('AGENT_TARGET_UNSUPPORTED', 'admission')
      const edges = file.edges.filter((edge) => edge.to.nodeId === nodeId)
      if (edges.some((edge) => edge.to.portId !== 'in-value') || edges.length > 1)
        throw new AgentRuntimeError('AGENT_INPUT_INVALID', 'admission')
      const inputs = edges.map((edge) => ({
        targetPortId: edge.to.portId,
        assets: [freeze(edge.from, `task:${raw.requestId}:${versions.size}`)]
      }))
      return { nodeId, contractVersion: 1 as const, inputs }
    })
    const directInputs = file.edges
      .filter((edge) => edge.to.nodeId === raw.nodeId)
      .map((edge, index) => {
        if (!['in-text', 'in-json'].includes(edge.to.portId))
          throw new AgentRuntimeError('AGENT_INPUT_TYPE_UNSUPPORTED', 'admission')
        const ref = freeze(edge.from, `task:${raw.requestId}:context:${index}`)
        const input = this.assets.resolveInputs(raw.projectId, [ref])[0]
        if (
          (edge.to.portId === 'in-json' && input.value.kind !== 'json') ||
          (edge.to.portId === 'in-text' &&
            input.value.kind !== 'text' &&
            input.value.kind !== 'markdown')
        )
          throw new AgentRuntimeError('AGENT_INPUT_TYPE_INVALID', 'admission')
        return ref
      })
    return AgentTaskSnapshotSchema.parse({
      runtimeVersion: 1,
      projectId: raw.projectId,
      agentNodeId: raw.nodeId,
      taskId: raw.requestId,
      semanticRevision: projectSemanticRevision(file),
      config,
      goal: shape.props.text,
      scopeRevision: collaborationScopeRevision(file, raw.nodeId),
      directInputs,
      maxDecisions: config.maxSteps,
      targets,
      traceId: raw.traceId,
      spanId: raw.spanId
    })
  }

  pause(input: Identity): FlowAgentView | null {
    if (
      !this.coordinator ||
      JSON.parse(this.saved(input).shape.props.config).role !== 'coordinator'
    )
      throw new AgentRuntimeError('FLOW_COORDINATOR_CONFIG_INVALID', 'pause')
    return this.coordinator.pause(input)
  }
  describeAssignment(input: FlowAgentRun): AgentTaskSnapshot {
    return this.bind(input)
  }
  async runAssignment(
    input: FlowAgentRun,
    assignment: { goal: string; completion: string; inputs: FlowAgentReply['refs'] },
    coordinatorTaskId: string,
    prepared?: AgentTaskSnapshot
  ): Promise<FlowAgentReply> {
    if (new CoordinationStore(this.db).owner(input.projectId, input.nodeId) !== coordinatorTaskId)
      throw new AgentRuntimeError('FLOW_SCOPE_REJECTED', 'assignment')
    const snapshot = prepared ? AgentTaskSnapshotSchema.parse(prepared) : this.bind(input)
    if (
      snapshot.projectId !== input.projectId ||
      snapshot.agentNodeId !== input.nodeId ||
      snapshot.taskId !== input.requestId ||
      snapshot.semanticRevision !== projectSemanticRevision(this.saved(input).file)
    )
      throw new AgentRuntimeError('FLOW_REVISION_CONFLICT', 'assignment')
    if (
      assignment.inputs.some(
        (ref) =>
          !snapshot.directInputs.some(
            (allowed) => canonicalFlowJson(allowed) === canonicalFlowJson(ref)
          )
      )
    )
      throw new AgentRuntimeError('FLOW_HANDOFF_INPUT_REJECTED', 'assignment')
    snapshot.goal = `${snapshot.goal}\n本次主控分派要求：${assignment.goal}\n完成条件：${assignment.completion}`
    snapshot.directInputs = assignment.inputs
    snapshot.coordinatorTaskId = coordinatorTaskId
    return this.run(input, AgentTaskSnapshotSchema.parse(snapshot))
  }
  private reply(record: AgentTaskRecord): FlowAgentReply {
    const outputs: FlowAgentReply['outputs'] = {}
    if (record.state === 'completed') {
      for (const ref of record.outputRefs) {
        const value = this.assets.resolveInputs(record.snapshot.projectId, [ref])[0].value
        const port = value.kind === 'json' ? 'out-json' : 'out-text'
        if (outputs[port] && canonicalFlowJson(outputs[port]) !== canonicalFlowJson(value))
          throw new AgentRuntimeError('AGENT_OUTPUT_CARDINALITY', 'output')
        outputs[port] = value.kind === 'markdown' ? { kind: 'text', text: value.text } : value
      }
    }
    return {
      task: view(record),
      outputs,
      refs: record.state === 'completed' ? record.outputRefs : []
    }
  }

  collaboration(input: Identity): FlowAgentCollaborationView | null {
    this.saved(input)
    const record = this.latest(input)
    if (!record) return null
    const events = new FlowCollaborationStore(this.db).read(agentThread(record.snapshot))
    return {
      task: view(record),
      goal: record.snapshot.goal,
      revision: events.length,
      messages: [
        ...(record.snapshot.parentTaskId
          ? (() => {
              const parent = this.db
                .prepare(
                  'SELECT thread FROM flow_agent_tasks WHERE project_id=? AND task_id=? AND agent_node_id=?'
                )
                .get(input.projectId, record.snapshot.parentTaskId, input.nodeId) as
                { thread: string } | undefined
              return parent ? new FlowCollaborationStore(this.db).read(parent.thread) : []
            })()
          : []),
        ...events
      ].map(({ eventId, action, text, reply }) => ({
        eventId,
        kind: action,
        text,
        reply
      })),
      inputs: [
        ...record.snapshot.directInputs,
        ...record.snapshot.targets.flatMap((target) => target.inputs.flatMap((port) => port.assets))
      ],
      candidates: this.receipts(record)
        .filter((item) => item.state === 'committed')
        .flatMap((item) => item.outputRefs)
    }
  }
  private receipts(record: AgentTaskRecord): FlowCommandReceipt[] {
    return (
      this.db
        .prepare(
          'SELECT receipt_json FROM flow_commands WHERE project_id=? AND task_id=? ORDER BY created_at,command_id'
        )
        .all(record.snapshot.projectId, record.snapshot.taskId) as Array<{ receipt_json: string }>
    ).map((row) => JSON.parse(row.receipt_json))
  }
  async cooperate(raw: unknown): Promise<FlowAgentCollaborationView> {
    const input = FlowAgentCollaborationSchema.parse(raw)
    this.saved(input)
    // A saved note is inert and can coexist with an active task. It never changes
    // the model's fixed goal/inputs or supplies consent to an interrupt.
    if (input.action === 'note') {
      const record = this.latest(input)
      if (
        !record ||
        record.snapshot.taskId !== input.taskId ||
        record.waitRevision !== input.waitRevision
      )
        throw new AgentRuntimeError('RESUME_CONFLICT', 'discussion')
      if (record.snapshot.config.interactionMode !== 'collaborative')
        throw new AgentRuntimeError('HUMAN_WAIT_DENIED', 'discussion')
      if (!input.text.trim()) throw new AgentRuntimeError('AGENT_INPUT_INVALID', 'discussion')
      new FlowCollaborationStore(this.db).append(agentThread(record.snapshot), input)
      return this.collaboration(input)!
    }
    const key = this.key(input)
    if (this.admission.has(key) || this.active.has(key))
      throw new AgentRuntimeError('AGENT_TASK_BUSY', 'collaboration')
    this.admission.add(key)
    try {
      const rows = this.db
        .prepare(
          'SELECT thread FROM flow_agent_tasks WHERE project_id=? AND agent_node_id=? AND task_id=?'
        )
        .get(input.projectId, input.nodeId, input.taskId) as { thread: string } | undefined
      if (!rows) throw new AgentRuntimeError('AGENT_TASK_MISSING', 'collaboration')
      const store = new FlowCollaborationStore(this.db)
      if (store.check(rows.thread, input)) return this.collaboration(input)!
      const record = this.latest(input)!
      if (record.snapshot.taskId !== input.taskId || record.waitRevision !== input.waitRevision)
        throw new AgentRuntimeError('RESUME_CONFLICT', 'collaboration')
      if (record.snapshot.config.interactionMode !== 'collaborative')
        throw new AgentRuntimeError('HUMAN_WAIT_DENIED', 'collaboration')
      if (
        !(record.state === 'waiting' && record.waitKind === 'human') &&
        !(
          input.action === 'revise' &&
          record.state === 'blocked' &&
          record.code === 'HUMAN_REJECTED'
        )
      )
        throw new AgentRuntimeError('AGENT_NOT_WAITING', 'collaboration')
      const { file, shape } = this.saved(input)
      if (
        input.action !== 'revise' &&
        projectSemanticRevision(file) !== record.snapshot.semanticRevision
      )
        throw new AgentRuntimeError('FLOW_REVISION_CONFLICT', 'collaboration')
      if (input.action === 'revise') {
        if (
          !input.text.trim() ||
          shape.props.text !== input.text ||
          !record.snapshot.scopeRevision ||
          collaborationScopeRevision(file, input.nodeId) !== record.snapshot.scopeRevision
        )
          throw new AgentRuntimeError('COLLABORATION_SCOPE_CONFLICT', 'revision')
        if (this.receipts(record).some((receipt) => ['pending', 'unknown'].includes(receipt.state)))
          throw new AgentRuntimeError('AGENT_NOT_WAITING', 'revision')
        const child = this.bind({
          ...input,
          action: 'start',
          requestId: input.eventId,
          traceId: randomUUID(),
          spanId: randomUUID()
        })
        child.parentTaskId = record.snapshot.taskId
        const submitted = store
          .read(rows.thread)
          .filter((event) => event.action === 'submit')
          .at(-1)
        child.humanFeedback = submitted?.text
        const choices = input.selectedInputs ?? []
        const originals = [
          ...child.directInputs,
          ...child.targets.flatMap((target) => target.inputs.flatMap((port) => port.assets))
        ]
        for (const choice of choices) {
          this.assets.resolveInputs(input.projectId, [choice])
          if (
            !originals.some(
              (ref) =>
                ref.sourceNodeId === choice.sourceNodeId && ref.sourcePortId === choice.sourcePortId
            )
          )
            throw new AgentRuntimeError('AGENT_INPUT_NOT_FIXED', 'revision')
        }
        if (
          new Set(choices.map((ref) => JSON.stringify([ref.sourceNodeId, ref.sourcePortId])))
            .size !== choices.length
        )
          throw new AgentRuntimeError('AGENT_INPUT_INVALID', 'revision')
        const select = (
          ref: AgentTaskRecord['outputRefs'][number]
        ): AgentTaskRecord['outputRefs'][number] =>
          choices.find(
            (choice) =>
              choice.sourceNodeId === ref.sourceNodeId && choice.sourcePortId === ref.sourcePortId
          ) ?? ref
        child.directInputs = child.directInputs.map(select)
        child.targets = child.targets.map((target) => ({
          ...target,
          inputs: target.inputs.map((port) => ({ ...port, assets: port.assets.map(select) }))
        }))
        const directEdges = file.edges.filter((edge) => edge.to.nodeId === input.nodeId)
        child.directInputs.forEach((ref, index) => {
          const value = this.assets.resolveInputs(input.projectId, [ref])[0].value
          if (
            (directEdges[index].to.portId === 'in-json' && value.kind !== 'json') ||
            (directEdges[index].to.portId === 'in-text' &&
              !['text', 'markdown'].includes(value.kind))
          )
            throw new AgentRuntimeError('AGENT_INPUT_TYPE_INVALID', 'revision')
        })
        this.db.transaction(() => {
          this.store.setState(rows.thread, 'cancelled', 'AGENT_SUPERSEDED')
          this.store.create(child, record.skills)
          store.append(rows.thread, input, { childTaskId: child.taskId })
        })()
      } else if (input.action === 'submit') {
        if (typeof input.accepted !== 'boolean')
          throw new AgentRuntimeError('AGENT_INPUT_INVALID', 'human')
        const candidates = this.collaboration(input)!.candidates
        const chosen = this.assets.resolveInputs(input.projectId, input.selectedOutputs ?? [])
        if (
          new Set(chosen.map((version) => (version.value.kind === 'json' ? 'json' : 'text')))
            .size !== chosen.length
        )
          throw new AgentRuntimeError('AGENT_OUTPUT_CARDINALITY', 'human-selection')
        if (
          input.selectedOutputs?.some(
            (ref) =>
              !candidates.some(
                (candidate) => canonicalFlowJson(candidate) === canonicalFlowJson(ref)
              )
          )
        )
          throw new AgentRuntimeError('AGENT_OUTPUT_UNVERIFIED', 'human')
        store.append(rows.thread, input)
      } else {
        if (!input.text.trim()) throw new AgentRuntimeError('AGENT_INPUT_INVALID', 'discussion')
        let reply: string | undefined
        if (input.action === 'discuss') {
          const model = await this.model(record.snapshot, AbortSignal.timeout(30000))
          if (!model.discuss)
            throw new AgentRuntimeError('AGENT_DISCUSSION_UNAVAILABLE', 'discussion')
          reply = await model.discuss(
            record.snapshot.goal,
            store.read(rows.thread).map(({ text, reply }) => ({ text, reply })),
            input.text,
            AbortSignal.timeout(30000)
          )
          this.saved(input)
          if (
            this.latest(input)?.state !== 'waiting' ||
            projectSemanticRevision(this.saved(input).file) !== record.snapshot.semanticRevision
          )
            throw new AgentRuntimeError('RESUME_CONFLICT', 'discussion')
        }
        store.append(rows.thread, input, { reply })
      }
      return this.collaboration(input)!
    } finally {
      this.admission.delete(key)
    }
  }

  async run(raw: unknown, assigned?: AgentTaskSnapshot): Promise<FlowAgentReply> {
    const input = FlowAgentRunSchema.parse(raw)
    if (this.coordinator && JSON.parse(this.saved(input).shape.props.config).role === 'coordinator')
      return this.coordinator.run(raw)
    const owner = new CoordinationStore(this.db).owner(input.projectId, input.nodeId)
    const prior = this.latest(input)
    if (
      owner &&
      !assigned &&
      !(
        prior?.snapshot.coordinatorTaskId === owner &&
        (input.action === 'continue' || input.requestId === prior.snapshot.taskId)
      )
    )
      throw new AgentRuntimeError('FLOW_CONTROL_OCCUPIED', 'admission')
    const key = this.key(input)
    if (this.admission.has(key)) throw new AgentRuntimeError('AGENT_TASK_BUSY', 'admission')
    this.admission.add(key)
    const controller = new AbortController()
    this.controllers.set(key, controller)
    let runtime: AgentRuntime | undefined
    let admittingTaskId: string | undefined
    try {
      this.saved(input)
      const old = this.latest(input)
      if (
        input.expectedTaskId &&
        (old?.snapshot.taskId !== input.expectedTaskId ||
          (input.expectedWaitRevision !== undefined &&
            old.waitRevision !== input.expectedWaitRevision))
      )
        throw new AgentRuntimeError('RESUME_CONFLICT', 'resume')
      if (input.action === 'start' && old && old.snapshot.taskId === input.requestId)
        return this.reply(old)
      if (
        input.action === 'continue' &&
        old?.state === 'completed' &&
        input.eventId &&
        this.db
          .prepare('SELECT 1 FROM flow_agent_responses WHERE thread=? AND event_id=?')
          .get(agentThread(old.snapshot), input.eventId)
      )
        return this.reply(old)
      if (
        input.action === 'start' &&
        old &&
        !['completed', 'cancelled', 'failed'].includes(old.state) &&
        !(
          old.state === 'ready' &&
          old.snapshot.parentTaskId &&
          input.expectedTaskId === old.snapshot.taskId
        )
      )
        throw new AgentRuntimeError('AGENT_TASK_OCCUPIED', 'admission')
      if (input.action === 'continue' && (!old || old.state !== 'waiting' || !input.eventId))
        throw new AgentRuntimeError('AGENT_NOT_WAITING', 'resume')
      const prepared =
        input.action === 'start' &&
        old?.state === 'ready' &&
        !!old.snapshot.parentTaskId &&
        input.expectedTaskId === old.snapshot.taskId
      const snapshot =
        input.action === 'continue' || prepared ? old!.snapshot : (assigned ?? this.bind(input))
      const telemetry = createAgentTelemetry(snapshot)
      if (input.action === 'start' && !prepared)
        this.store.create(snapshot, this.skills.bind(snapshot.config.skills, snapshot.config.tools))
      admittingTaskId = snapshot.taskId
      const model = await this.model(snapshot, controller.signal)
      if (controller.signal.aborted) throw new AgentRuntimeError('AGENT_CANCELLED', 'admission')
      runtime = createAgentRuntime({
        snapshot,
        store: this.store,
        skills: this.skills,
        model,
        tools: createLedgerToolPort(this.desktop.ledger, this.desktop.deliver),
        telemetry,
        assertRevision: (fixed) => {
          const { file } = this.saved({ projectId: fixed.projectId, nodeId: fixed.agentNodeId })
          if (projectSemanticRevision(file) !== fixed.semanticRevision)
            throw new AgentRuntimeError('FLOW_REVISION_CONFLICT', 'revision')
        }
      })
      this.active.set(key, runtime)
      if (input.action === 'continue' && old!.waitKind === 'reconcile') {
        const commands = this.db
          .prepare(
            "SELECT command_id FROM flow_commands WHERE project_id=? AND task_id=? AND state IN ('pending','unknown')"
          )
          .all(input.projectId, snapshot.taskId) as Array<{ command_id: string }>
        for (const command of commands) {
          try {
            this.desktop.ledger.commit({
              projectId: input.projectId,
              commandId: command.command_id
            })
          } catch {
            /* Still uncertain. */
          }
        }
      }
      const human = old
        ? new FlowCollaborationStore(this.db)
            .read(agentThread(old.snapshot))
            .filter((event) => event.action === 'submit' && event.waitRevision === old.waitRevision)
            .at(-1)
        : undefined
      const record =
        input.action === 'start'
          ? await runtime.start()
          : await runtime.resume({
              taskId: snapshot.taskId,
              semanticRevision: snapshot.semanticRevision,
              waitRevision: old!.waitRevision,
              eventId: input.eventId ?? randomUUID(),
              kind: old!.waitKind,
              ...(old!.waitKind === 'human'
                ? {
                    accepted: human?.accepted ?? true,
                    feedback: human?.text,
                    selectedOutputs: human?.selectedOutputs
                  }
                : {})
            })
      return this.reply(record)
    } catch (error) {
      const record = this.latest(input)
      if (record?.state === 'cancelled') return this.reply(record)
      if (record && record.state === 'ready' && record.snapshot.taskId === admittingTaskId) {
        const code = error instanceof AgentRuntimeError ? error.code : 'AGENT_ADMISSION_FAILED'
        this.store.setState(
          agentThread(record.snapshot),
          controller.signal.aborted ? 'cancelled' : 'blocked',
          code
        )
        createAgentTelemetry(record.snapshot)(
          controller.signal.aborted ? 'cancelled' : 'blocked',
          'admission',
          code
        )
      }
      throw error
    } finally {
      if (runtime) this.active.delete(key)
      this.admission.delete(key)
      this.controllers.delete(key)
    }
  }
}
