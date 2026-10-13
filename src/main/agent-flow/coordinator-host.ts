import type Database from 'better-sqlite3'
import { createHash } from 'node:crypto'
import { Annotation, StateGraph, START, END } from '@langchain/langgraph'
import { AsyncLocalStorageProviderSingleton } from '@langchain/core/singletons'
import type { ProjectFile } from '../../shared/types'
import {
  AgentNodeConfigSchema,
  StateMachineNodeConfigSchema
} from '../../shared/agent-flow/node-contracts'
import { AgentRuntimeError } from '../../shared/agent-flow/runtime-contracts'
import type { AgentTaskSnapshot } from '../../shared/agent-flow/runtime-contracts'
import {
  FlowAgentRunSchema,
  type FlowAgentRun,
  type FlowAgentReply,
  type FlowAgentView
} from '../../shared/agent-flow/desktop-tasks'
import {
  CoordinationDecisionSchema,
  type AgentPublication,
  type ModelIdentity
} from '../../shared/agent-flow/coordination'
import {
  canonicalFlowJson,
  semanticProjectPayload
} from '../../shared/agent-flow/semantic-revision'
import type { AgentModelPort } from './runtime'
import type { FlowAgentDesktopHost } from './desktop-host'
import { CoordinationStore, type CoordinationRun } from './coordination-store'
import { FlowAssetStore } from './asset-store'
import { emitGatewayEvent } from '../diagnostics/gateway-events'
import { projectSemanticRevision } from './command-intent'

type Identity = { projectId: string; nodeId: string }
const hash = (value: unknown): string =>
  createHash('sha256').update(canonicalFlowJson(value)).digest('hex')
function scopeRevision(file: ProjectFile, ids: string[]): string {
  const payload = semanticProjectPayload(file) as {
    nodes: Array<{ id: string }>
    edges: Array<{ from: { nodeId: string }; to: { nodeId: string } }>
  }
  return hash({
    nodes: payload.nodes.filter((n) => ids.includes(n.id)),
    edges: payload.edges.filter((e) => ids.includes(e.to.nodeId))
  })
}
function shape(
  file: ProjectFile,
  id: string
): { props: { nodeType: string; config: string; text: string }; meta?: Record<string, unknown> } {
  const item = (file.tldrawSnapshot as { store: Record<string, ReturnType<typeof shape>> }).store[
    id
  ]
  if (!item) throw new AgentRuntimeError('FLOW_NODE_MISSING', 'scope')
  return item
}
const terminal = (run: CoordinationRun): boolean =>
  ['completed', 'cancelled', 'failed'].includes(run.state)

/** One coordinator owns the saved scope. Specialists keep their own tasks and checkpoints. */
export class FlowCoordinatorHost {
  readonly store: CoordinationStore
  private readonly assets: FlowAssetStore
  private readonly active = new Map<string, AbortController>()
  constructor(
    db: Database.Database,
    private readonly open: (id: string) => ProjectFile | null,
    private readonly isActive: (id: string) => boolean,
    private readonly specialists: FlowAgentDesktopHost,
    private readonly model: (
      identity: ModelIdentity,
      signal: AbortSignal
    ) => Promise<AgentModelPort>,
    private readonly publish: (input: AgentPublication, signal: AbortSignal) => Promise<void>
  ) {
    this.store = new CoordinationStore(db)
    this.assets = new FlowAssetStore(db, open)
  }
  private file(input: Identity): ProjectFile {
    const file = this.open(input.projectId)
    if (!this.isActive(input.projectId) || !file)
      throw new AgentRuntimeError('FLOW_PROJECT_INACTIVE', 'coordination')
    return file
  }
  private check(run: CoordinationRun): ProjectFile {
    const file = this.file(run)
    if (scopeRevision(file, run.scopeIds) !== run.scopeRevision)
      throw new AgentRuntimeError('FLOW_REVISION_CONFLICT', 'coordination')
    return file
  }
  private view(run: CoordinationRun): FlowAgentView {
    return {
      taskId: run.taskId,
      state: run.state,
      waitKind: run.state === 'waiting' ? 'human' : null,
      waitRevision: run.waitRevision,
      decisions: run.decisions,
      tools: run.children.length,
      code: run.code,
      phase: run.phase,
      children: run.children.map(({ nodeId, taskId, state }) => ({ nodeId, taskId, state }))
    }
  }
  inspect(input: Identity): FlowAgentView | null {
    this.file(input)
    const run = this.store.latest(input.projectId, input.nodeId)
    if (!run) return null
    if (run.state === 'running' && !this.active.has(run.taskId)) {
      run.state = 'blocked'
      run.code = 'AGENT_SESSION_LOST'
      this.store.save(run)
    }
    return this.view(run)
  }
  pause(input: Identity): FlowAgentView | null {
    this.file(input)
    const run = this.store.latest(input.projectId, input.nodeId)
    if (!run || terminal(run)) return run ? this.view(run) : null
    run.paused = true
    this.store.save(run)
    return this.view(run)
  }
  stop(input: Identity): FlowAgentView | null {
    this.file(input)
    const run = this.store.latest(input.projectId, input.nodeId)
    if (!run || terminal(run)) return run ? this.view(run) : null
    this.active.get(run.taskId)?.abort()
    for (const child of run.children.filter(
      (c) => !['completed', 'cancelled', 'failed'].includes(c.state)
    ))
      this.specialists.stop({ projectId: run.projectId, nodeId: child.nodeId })
    run.state = 'cancelled'
    run.code = 'AGENT_CANCELLED'
    this.store.save(run)
    this.store.release(run)
    return this.view(run)
  }
  private bind(input: FlowAgentRun): CoordinationRun {
    const file = this.file(input),
      root = shape(file, input.nodeId)
    const config = AgentNodeConfigSchema.parse(JSON.parse(root.props.config))
    if (
      root.props.nodeType !== 'agent' ||
      config.role !== 'coordinator' ||
      !root.props.text.trim() ||
      !config.modelDefinitionId
    )
      throw new AgentRuntimeError('FLOW_COORDINATOR_CONFIG_INVALID', 'admission')
    if (
      !config.tools.some((t) => t.id === 'agent.dispatch' && t.version === '1') ||
      config.tools.some((t) => t.id !== 'agent.dispatch' || t.version !== '1') ||
      config.skills.length
    )
      throw new AgentRuntimeError('AGENT_TOOL_UNSUPPORTED', 'admission')
    if (
      !config.allowedNodeIds.length ||
      new Set(config.allowedNodeIds).size !== config.allowedNodeIds.length
    )
      throw new AgentRuntimeError('FLOW_COORDINATOR_SCOPE_INVALID', 'scope')
    const controls = new Set([input.nodeId])
    for (const id of config.allowedNodeIds) {
      const child = shape(file, id),
        cfg = AgentNodeConfigSchema.parse(JSON.parse(child.props.config))
      if (child.props.nodeType !== 'agent' || cfg.role !== 'specialist' || id === input.nodeId)
        throw new AgentRuntimeError('FLOW_COORDINATOR_SCOPE_INVALID', 'scope')
      for (const target of [id, ...cfg.allowedNodeIds]) {
        if (controls.has(target)) throw new AgentRuntimeError('FLOW_CONTROL_OCCUPIED', 'scope')
        controls.add(target)
      }
      const task = this.specialists.inspect({ projectId: input.projectId, nodeId: id })
      if (task && !['completed', 'cancelled', 'failed'].includes(task.state))
        throw new AgentRuntimeError('AGENT_TASK_OCCUPIED', 'scope')
    }
    const states = config.relations.filter(
      (r) =>
        r.kind === 'observes' &&
        r.sourceNodeId === input.nodeId &&
        shape(file, r.targetNodeId).props.nodeType === 'state-machine'
    )
    if (states.length !== 1) throw new AgentRuntimeError('FLOW_STATE_REQUIRED', 'scope')
    const stateNodeId = states[0].targetNodeId
    const stateConfig = StateMachineNodeConfigSchema.parse(
      JSON.parse(shape(file, stateNodeId).props.config)
    )
    controls.add(stateNodeId)
    const scopeIds = [
      ...new Set([
        ...controls,
        ...file.edges.filter((e) => controls.has(e.to.nodeId)).map((e) => e.from.nodeId)
      ])
    ]
    const run: CoordinationRun = {
      projectId: input.projectId,
      nodeId: input.nodeId,
      taskId: input.requestId,
      goal: root.props.text,
      config,
      stateNodeId,
      stateConfig,
      scopeIds,
      scopeRevision: scopeRevision(file, scopeIds),
      childIds: config.allowedNodeIds,
      state: 'running',
      phase: stateConfig.initialState,
      revision: 0,
      waitRevision: 0,
      decisions: 0,
      paused: false,
      children: [],
      outputs: [],
      traceId: input.traceId,
      spanId: input.spanId
    }
    this.store.create(run, [...controls])
    return run
  }
  private reply(run: CoordinationRun): FlowAgentReply {
    const outputs: FlowAgentReply['outputs'] = {}
    if (run.state === 'completed')
      for (const ref of run.outputs) {
        const value = this.assets.resolveInputs(run.projectId, [ref])[0].value
        const key = value.kind === 'json' ? 'out-json' : 'out-text'
        if (outputs[key]) throw new AgentRuntimeError('AGENT_OUTPUT_CARDINALITY', 'output')
        outputs[key] = value.kind === 'markdown' ? { kind: 'text', text: value.text } : value
      }
    return { task: this.view(run), refs: run.state === 'completed' ? run.outputs : [], outputs }
  }
  async run(raw: unknown): Promise<FlowAgentReply> {
    const input = FlowAgentRunSchema.parse(raw)
    this.file(input)
    let run = this.store.latest(input.projectId, input.nodeId)
    if (run && input.action === 'start' && run.taskId === input.requestId) return this.reply(run)
    if (run && !terminal(run) && input.action === 'start')
      throw new AgentRuntimeError('AGENT_TASK_OCCUPIED', 'admission')
    if (input.action === 'continue') {
      if (
        !run ||
        run.state !== 'waiting' ||
        run.taskId !== input.expectedTaskId ||
        run.waitRevision !== input.expectedWaitRevision
      )
        throw new AgentRuntimeError('RESUME_CONFLICT', 'resume')
      this.check(run)
    } else run = this.bind(input)
    const fixed = run!
    if (this.active.has(fixed.taskId))
      throw new AgentRuntimeError('AGENT_TASK_BUSY', 'coordination')
    const controller = new AbortController()
    this.active.set(fixed.taskId, controller)
    const context = {
      projectId: fixed.projectId,
      nodeId: fixed.nodeId,
      taskId: fixed.taskId,
      traceId: input.traceId,
      spanId: input.spanId
    }
    emitGatewayEvent('agent.coordination.started', '主 Agent 协调开始', context)
    try {
      const event = input.action === 'start' ? 'flow.started' : 'human.continue'
      this.store.event(fixed, input.eventId ?? `${fixed.taskId}:start`, event, fixed.revision)
      fixed.state = 'running'
      fixed.paused = false
      this.store.save(fixed, false)
      const model = await this.model({ ...fixed, agentNodeId: fixed.nodeId }, controller.signal)
      if (!model.coordinate) throw new AgentRuntimeError('AGENT_TOOL_UNSUPPORTED', 'coordination')
      const Graph = Annotation.Root({
        again: Annotation<boolean>({ reducer: (_, value) => value, default: () => true })
      })
      const graph = new StateGraph(Graph)
        .addNode('coordinate', async () => ({
          again: await this.step(fixed, input, model, controller.signal)
        }))
        .addEdge(START, 'coordinate')
        .addConditionalEdges('coordinate', (state) => (state.again ? 'coordinate' : END))
        .compile()
      await graph.invoke({}, { recursionLimit: 130 })
      const current = this.store.latest(fixed.projectId, fixed.nodeId)!
      if (terminal(current)) this.store.release(current)
      emitGatewayEvent('agent.coordination.completed', '主 Agent 协调结束', context, {
        status: 'success'
      })
      return this.reply(current)
    } catch (error) {
      const current = this.store.latest(fixed.projectId, fixed.nodeId)!
      if (current.state !== 'cancelled') {
        current.state = 'blocked'
        current.code = error instanceof AgentRuntimeError ? error.code : 'FLOW_COORDINATION_FAILED'
        this.store.save(current)
      }
      emitGatewayEvent('agent.coordination.failed', '主 Agent 协调未确认', context, {
        status: 'failed',
        attributes: { phase: 'coordination', code: current.code }
      })
      if (current.state === 'cancelled') return this.reply(current)
      throw error
    } finally {
      this.active.delete(fixed.taskId)
    }
  }
  private async step(
    run: CoordinationRun,
    input: FlowAgentRun,
    model: AgentModelPort,
    signal: AbortSignal
  ): Promise<boolean> {
    const stored = this.store.latest(run.projectId, run.nodeId)!
    if (signal.aborted || stored.state === 'cancelled') return false
    this.check(run)
    const pending = run.children.find((c) => c.state === 'waiting')
    if (pending) {
      const state = this.specialists.inspect({ projectId: run.projectId, nodeId: pending.nodeId })
      if (state?.taskId !== pending.taskId)
        throw new AgentRuntimeError('RESUME_CONFLICT', 'handoff')
      if (state.state === 'waiting') return this.wait(run, 'human.wait')
      if (state.state !== 'completed')
        throw new AgentRuntimeError(state.code ?? 'FLOW_CHILD_BLOCKED', 'handoff')
      const reply = await this.specialists.run({
        projectId: run.projectId,
        traceId: run.traceId,
        spanId: run.spanId,
        nodeId: pending.nodeId,
        action: 'start',
        requestId: pending.taskId,
        expectedTaskId: pending.taskId
      })
      await this.publishChild(run, pending.nodeId, reply, signal)
      pending.state = reply.task.state
      pending.outputs = reply.refs
      this.store.save(run)
      this.store.event(run, `${pending.taskId}:completed`, 'agent.completed', run.revision)
    }
    if (stored.paused) return this.wait(run, 'flow.paused')
    if (run.decisions >= run.config.maxSteps)
      throw new AgentRuntimeError('AGENT_BUDGET_EXHAUSTED', 'coordination')
    const available = [] as Array<{ nodeId: string; goal: string; inputs: FlowAgentReply['refs'] }>
    const candidates = new Map<string, AgentTaskSnapshot>()
    for (const id of run.childIds.filter((id) => !run.children.some((c) => c.nodeId === id))) {
      try {
        const child = this.specialists.describeAssignment({
          ...input,
          nodeId: id,
          action: 'start',
          requestId: hash([run.taskId, id])
        })
        candidates.set(id, child)
        available.push({ nodeId: id, goal: child.goal, inputs: child.directInputs })
      } catch (error) {
        if (!(error instanceof Error) || error.message !== 'ASSET_OUTPUT_UNAVAILABLE') throw error
      }
    }
    run.decisions++
    this.store.save(run)
    let timeout: ReturnType<typeof setTimeout> | undefined
    const decision = CoordinationDecisionSchema.parse(
      await Promise.race([
        model.coordinate!(
          {
            goal: run.goal,
            mode: run.config.interactionMode,
            available,
            completed: run.children
              .filter((c) => c.state === 'completed')
              .map((c) => ({ nodeId: c.nodeId, taskId: c.taskId, outputs: c.outputs }))
          },
          signal
        ),
        new Promise<never>((_, reject) => {
          timeout = setTimeout(
            () => reject(new AgentRuntimeError('AGENT_MODEL_FAILED', 'coordination-timeout')),
            30000
          )
          timeout.unref()
        })
      ]).finally(() => {
        if (timeout) clearTimeout(timeout)
      })
    )
    this.check(run)
    if (signal.aborted || this.store.latest(run.projectId, run.nodeId)!.state === 'cancelled')
      return false
    if (this.store.latest(run.projectId, run.nodeId)!.paused) return this.wait(run, 'flow.paused')
    if (decision.kind === 'wait') {
      if (run.config.interactionMode !== 'collaborative')
        throw new AgentRuntimeError('HUMAN_WAIT_DENIED', 'coordination')
      return this.wait(run, 'human.wait')
    }
    if (decision.kind === 'finish') {
      const allowed = new Set(
        run.children
          .filter((c) => c.state === 'completed')
          .flatMap((c) => c.outputs)
          .map(canonicalFlowJson)
      )
      if (
        run.children.length !== run.childIds.length ||
        run.children.some((c) => c.state !== 'completed') ||
        decision.outputs.some((r) => !allowed.has(canonicalFlowJson(r))) ||
        new Set(decision.outputs.map(canonicalFlowJson)).size !== decision.outputs.length
      )
        throw new AgentRuntimeError('AGENT_OUTPUT_UNVERIFIED', 'coordination')
      run.outputs = decision.outputs
      this.store.event(run, `${run.taskId}:completed`, 'flow.completed', run.revision)
      run.state = 'completed'
      this.store.save(run)
      return false
    }
    const candidate = available.find((c) => c.nodeId === decision.nodeId)
    if (
      !candidate ||
      decision.inputs.some(
        (ref) => !candidate.inputs.some((r) => canonicalFlowJson(r) === canonicalFlowJson(ref))
      ) ||
      new Set(decision.inputs.map(canonicalFlowJson)).size !== decision.inputs.length
    )
      throw new AgentRuntimeError('FLOW_HANDOFF_INPUT_REJECTED', 'handoff')
    const taskId = hash([run.taskId, decision.nodeId])
    const child = {
      nodeId: decision.nodeId,
      taskId,
      goal: decision.goal,
      completion: decision.completion,
      inputs: decision.inputs,
      state: 'ready',
      outputs: [] as FlowAgentReply['refs']
    }
    run.children.push(child)
    this.store.event(run, `${taskId}:dispatch`, 'agent.dispatched', run.revision)
    // A specialist owns a root task/checkpointer, not a LangGraph subgraph of this controller.
    const reply = await AsyncLocalStorageProviderSingleton.runWithConfig(
      {},
      () =>
        this.specialists.runAssignment(
          {
            projectId: run.projectId,
            action: 'start',
            nodeId: child.nodeId,
            requestId: taskId,
            traceId: run.traceId,
            spanId: run.spanId
          },
          child,
          run.taskId,
          candidates.get(child.nodeId)
        ),
      true
    )
    if (signal.aborted || this.store.latest(run.projectId, run.nodeId)!.state === 'cancelled')
      return false
    await this.publishChild(run, child.nodeId, reply, signal)
    child.state = reply.task.state
    child.outputs = reply.refs
    this.store.save(run)
    if (child.state === 'waiting') return this.wait(run, 'human.wait')
    if (child.state !== 'completed')
      throw new AgentRuntimeError(reply.task.code ?? 'FLOW_CHILD_BLOCKED', 'handoff')
    this.store.event(run, `${taskId}:completed`, 'agent.completed', run.revision)
    return true
  }
  private wait(run: CoordinationRun, event: string): false {
    this.store.event(run, `${run.taskId}:wait:${run.waitRevision + 1}`, event, run.revision)
    run.state = 'waiting'
    run.waitRevision++
    this.store.save(run)
    return false
  }
  private async publishChild(
    run: CoordinationRun,
    nodeId: string,
    reply: FlowAgentReply,
    signal: AbortSignal
  ): Promise<void> {
    await this.publish(
      {
        projectId: run.projectId,
        nodeId,
        taskId: reply.task.taskId,
        semanticRevision: projectSemanticRevision(this.check(run)),
        traceId: run.traceId,
        spanId: run.spanId
      },
      signal
    )
    this.check(run)
  }
}
