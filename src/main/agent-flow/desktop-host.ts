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
  type FlowAgentCatalog
} from '../../shared/agent-flow/desktop-tasks'
import { FlowSkillStore, BUILTIN_FLOW_SKILLS } from './skill-store'
import { FlowTaskStore, agentThread, type AgentTaskRecord } from './task-store'
import { FlowAssetStore } from './asset-store'
import { createAgentRuntime, type AgentRuntime, type AgentModelPort } from './runtime'
import { createAgentTelemetry } from './runtime-diagnostics'
import { createLedgerToolPort } from './ledger-tool'
import type { FlowCommandDesktop } from '../ipc/flow-commands.ipc'
import { projectSemanticRevision } from './command-intent'
import { readPinnedOutputs } from '../../shared/engine/deterministic-projections'
import { canonicalFlowJson } from '../../shared/agent-flow/semantic-revision'
import type { z } from 'zod'
import { AgentFlowAssetRefSchema } from '../../shared/agent-flow/node-contracts'

type Identity = { projectId: string; nodeId: string }
const view = (record: AgentTaskRecord): FlowAgentView => ({
  taskId: record.snapshot.taskId,
  state: record.state,
  waitKind: record.waitKind,
  waitRevision: record.waitRevision,
  decisions: record.decisions,
  tools: record.tools,
  code: record.code
})

/** Trusted desktop admission derives all execution scope from the saved canvas. */
export class FlowAgentDesktopHost {
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
      snapshot: AgentTaskSnapshot,
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
    this.saved(input)
    const record = this.latest(input)
    if (!record) return null
    if (
      ['ready', 'running'].includes(record.state) &&
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
      tools: [{ id: 'node.execute', version: '1', name: '执行画布数据处理节点' }],
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
      directInputs,
      maxDecisions: config.maxSteps,
      targets,
      traceId: raw.traceId,
      spanId: raw.spanId
    })
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

  async run(raw: unknown): Promise<FlowAgentReply> {
    const input = FlowAgentRunSchema.parse(raw)
    const key = this.key(input)
    if (this.admission.has(key)) throw new AgentRuntimeError('AGENT_TASK_BUSY', 'admission')
    this.admission.add(key)
    const controller = new AbortController()
    this.controllers.set(key, controller)
    let runtime: AgentRuntime | undefined
    try {
      this.saved(input)
      const old = this.latest(input)
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
        !['completed', 'cancelled', 'failed'].includes(old.state)
      )
        throw new AgentRuntimeError('AGENT_TASK_OCCUPIED', 'admission')
      if (input.action === 'continue' && (!old || old.state !== 'waiting' || !input.eventId))
        throw new AgentRuntimeError('AGENT_NOT_WAITING', 'resume')
      const snapshot = input.action === 'continue' ? old!.snapshot : this.bind(input)
      const telemetry = createAgentTelemetry(snapshot)
      if (input.action === 'start')
        this.store.create(snapshot, this.skills.bind(snapshot.config.skills, snapshot.config.tools))
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
      const record =
        input.action === 'start'
          ? await runtime.start()
          : await runtime.resume({
              taskId: snapshot.taskId,
              semanticRevision: snapshot.semanticRevision,
              waitRevision: old!.waitRevision,
              eventId: input.eventId ?? randomUUID(),
              kind: old!.waitKind,
              ...(old!.waitKind === 'human' ? { accepted: true } : {})
            })
      return this.reply(record)
    } catch (error) {
      const record = this.latest(input)
      if (record?.state === 'cancelled') return this.reply(record)
      if (record && record.state === 'ready') {
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
