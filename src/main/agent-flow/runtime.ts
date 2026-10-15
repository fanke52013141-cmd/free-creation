import { Annotation, StateGraph, START, END, Command, interrupt } from '@langchain/langgraph'
import { createHash } from 'node:crypto'
import {
  AgentDecisionSchema,
  AgentRuntimeError,
  type AgentDecision,
  type AgentTaskSnapshot,
  type AgentResume,
  type FixedSkill
} from '../../shared/agent-flow/runtime-contracts'
import type { FlowCommandReceipt } from '../../shared/agent-flow/commands'
import { FlowCommandError } from '../../shared/agent-flow/commands'
import { FlowAssetError } from '../../shared/agent-flow/assets'
import { canonicalFlowJson } from '../../shared/agent-flow/semantic-revision'
import { FlowSqliteSaver } from './checkpoint'
import { FlowTaskStore, agentThread, type AgentTaskRecord } from './task-store'
import type { FlowSkillStore } from './skill-store'
import type { AgentTelemetry } from './runtime-diagnostics'
import type { AgentToolPort } from './ledger-tool'
import type {
  CoordinationContext,
  CoordinationDecision
} from '../../shared/agent-flow/coordination'

export interface AgentModelContext {
  goal: string
  mode: AgentTaskSnapshot['config']['interactionMode']
  targets: AgentTaskSnapshot['targets']
  directInputs?: AgentTaskSnapshot['directInputs']
  skills: Array<
    Pick<FixedSkill, 'id' | 'version' | 'name' | 'description' | 'contentHash'> & {
      resources?: string[]
    }
  >
  loaded: Record<string, string>
  receipts: FlowCommandReceipt[]
  humanAccepted: boolean
  humanFeedback?: string
  rework?: AgentTaskSnapshot['rework']
  selectedOutputs?: AgentTaskRecord['outputRefs']
}
export interface AgentModelPort {
  review?(
    input: import('../../shared/agent-flow/review').ReviewContext,
    signal: AbortSignal
  ): Promise<import('../../shared/agent-flow/review').ReviewModelVerdict>
  build?(
    input: import('../../shared/agent-flow/builder').BuildContext,
    signal: AbortSignal
  ): Promise<import('../../shared/agent-flow/builder').BuildPlan>
  coordinate?(input: CoordinationContext, signal: AbortSignal): Promise<CoordinationDecision>
  decide(input: AgentModelContext, signal: AbortSignal): Promise<AgentDecision>
  discuss?(
    goal: string,
    history: Array<{ text: string; reply?: string }>,
    message: string,
    signal: AbortSignal
  ): Promise<string>
}
export interface AgentRuntime {
  start(): Promise<AgentTaskRecord>
  inspect(): AgentTaskRecord
  resume(raw: unknown): Promise<AgentTaskRecord>
  cancel(): AgentTaskRecord
}
const State = Annotation.Root({
  decision: Annotation<AgentDecision>(),
  receipts: Annotation<FlowCommandReceipt[]>({ default: () => [], reducer: (_, next) => next }),
  loaded: Annotation<Record<string, string>>({ default: () => ({}), reducer: (_, next) => next }),
  humanAccepted: Annotation<boolean>({ default: () => false, reducer: (_, next) => next }),
  humanFeedback: Annotation<string>({ default: () => '', reducer: (_, next) => next }),
  selectedOutputs: Annotation<AgentTaskRecord['outputRefs']>({
    default: () => [],
    reducer: (_, next) => next
  }),
  retryTool: Annotation<boolean>({ default: () => false, reducer: (_, next) => next })
})
const busy = new WeakMap<object, Set<string>>()
const cancellations = new WeakMap<object, Map<string, AbortController>>()

/** A single bounded decision loop. The editable flow remains the saved canvas. */
export function createAgentRuntime(options: {
  snapshot: AgentTaskSnapshot
  store: FlowTaskStore
  skills: FlowSkillStore
  model: AgentModelPort
  tools: AgentToolPort
  assertRevision: (snapshot: AgentTaskSnapshot) => void
  telemetry: AgentTelemetry
  diagnostics?: { traceId: string; spanId: string }
}): AgentRuntime {
  const { store, model, tools, assertRevision } = options
  const thread = agentThread(options.snapshot)
  const telemetry: AgentTelemetry = (...args) => {
    try {
      options.telemetry(...args)
    } catch {
      /* Non-fatal. */
    }
  }
  const config = {
    configurable: { thread_id: thread, checkpoint_ns: '' },
    recursionLimit: 256,
    callbacks: []
  }
  let signal: AbortSignal
  function valid(): AgentTaskRecord {
    const record = store.read(thread)
    if (record.state === 'cancelled' || signal?.aborted)
      throw new AgentRuntimeError('AGENT_CANCELLED', 'runtime')
    assertRevision(record.snapshot)
    return record
  }
  async function timed<T>(run: () => Promise<T>): Promise<T> {
    const begin = performance.now()
    try {
      const result = await new Promise<T>((resolve, reject) => {
        const abort = (): void =>
          reject(new AgentRuntimeError('AGENT_CANCELLED_OR_TIMED_OUT', 'runtime'))
        signal.addEventListener('abort', abort, { once: true })
        if (signal.aborted) abort()
        else
          run()
            .then(resolve, reject)
            .finally(() => signal.removeEventListener('abort', abort))
      })
      valid()
      return result
    } finally {
      store.charge(thread, performance.now() - begin)
    }
  }
  function wait(kind: 'human' | 'reconcile'): AgentResume {
    const before = valid()
    const revision =
      before.state === 'waiting' && before.waitKind === kind
        ? before.waitRevision
        : store.wait(thread, kind)
    const response = interrupt({
      taskId: before.snapshot.taskId,
      waitRevision: revision,
      kind
    }) as AgentResume
    if (
      response.taskId !== before.snapshot.taskId ||
      response.waitRevision !== revision ||
      response.kind !== kind
    )
      throw new AgentRuntimeError('RESUME_CONFLICT', 'resume')
    store.setState(thread, 'running')
    return response
  }
  const graph = new StateGraph(State)
    .addNode('decide', async (state) => {
      const record = valid()
      store.setState(thread, 'running')
      store.reserve(thread, 'decisions')
      const decision = AgentDecisionSchema.parse(
        await timed(() =>
          model.decide(
            {
              goal: record.snapshot.goal,
              mode: record.snapshot.config.interactionMode,
              targets: record.snapshot.targets,
              directInputs: record.snapshot.directInputs,
              skills: record.skills.map(
                ({ id, version, name, description, contentHash, resources }) => ({
                  id,
                  version,
                  name,
                  description,
                  contentHash,
                  resources: ['SKILL.md', ...Object.keys(resources)]
                })
              ),
              loaded: state.loaded,
              receipts: state.receipts,
              humanAccepted: state.humanAccepted,
              humanFeedback: state.humanFeedback || record.snapshot.humanFeedback,
              rework: record.snapshot.rework,
              selectedOutputs: state.selectedOutputs
            },
            signal
          )
        )
      )
      if (decision.kind === 'wait' && record.snapshot.config.interactionMode === 'autonomous')
        throw new AgentRuntimeError('HUMAN_WAIT_DENIED', 'decision')
      return { decision }
    })
    .addNode('skill', (state) => {
      const record = valid()
      store.setState(thread, 'running')
      store.reserve(thread, 'tools')
      if (state.decision.kind !== 'load-skill')
        throw new AgentRuntimeError('INVALID_DECISION', 'skill')
      const decision = state.decision
      const fixed = record.skills.find((item) => item.id === decision.skillId)
      if (!fixed) throw new AgentRuntimeError('SKILL_NOT_BOUND', 'skill-load')
      if (
        decision.resource !== undefined &&
        decision.resource !== 'SKILL.md' &&
        !Object.prototype.hasOwnProperty.call(fixed.resources, decision.resource)
      )
        throw new AgentRuntimeError('SKILL_RESOURCE_DENIED', 'skill-load')
      const content =
        decision.resource === undefined || decision.resource === 'SKILL.md'
          ? fixed.instructions
          : fixed.resources[decision.resource]
      if (content === undefined) throw new AgentRuntimeError('SKILL_RESOURCE_DENIED', 'skill-load')
      const loaded = {
        ...state.loaded,
        [`${fixed.id}@${fixed.version}:${decision.resource ?? 'instructions'}`]: content
      }
      if (Buffer.byteLength(JSON.stringify(loaded)) > 131072)
        throw new AgentRuntimeError('SKILL_CONTEXT_TOO_LARGE', 'skill-load')
      telemetry('skill_loaded', 'skill-load')
      return { loaded }
    })
    .addNode('tool', async (state) => {
      const record = valid()
      if (state.decision.kind !== 'execute') throw new AgentRuntimeError('INVALID_DECISION', 'tool')
      const decision = state.decision
      const target = record.snapshot.targets.find((item) => item.nodeId === decision.targetNodeId)
      if (
        !target ||
        (decision.prompt !== undefined &&
          (record.snapshot.rework?.videoTargetNodeId !== target.nodeId ||
            target.contractVersion !== 7)) ||
        !record.snapshot.config.tools.some(
          (item) => item.id === 'node.execute' && item.version === '1'
        )
      )
        throw new AgentRuntimeError('AGENT_TOOL_DENIED', 'tool-scope')
      // Only the observed sequence enters the ID; checkpoint re-entry must reuse it.
      const commandId = `agent:${createHash('sha256').update(`${thread}:${state.receipts.length}`).digest('hex')}`
      store.reserveCommand(thread, commandId)
      const receipt = await timed(() =>
        tools.execute(
          {
            schemaVersion: 1,
            kind: 'node.execute',
            commandId,
            projectId: record.snapshot.projectId,
            taskId: record.snapshot.taskId,
            agentNodeId: record.snapshot.agentNodeId,
            targetNodeId: target.nodeId,
            contractVersion: target.contractVersion,
            inputs: target.inputs,
            ...(record.snapshot.rework?.videoTargetNodeId === target.nodeId
              ? {
                  videoRework: {
                    reviewId: record.snapshot.rework.reviewId,
                    round: record.snapshot.rework.round,
                    ...(decision.prompt !== undefined ? { prompt: decision.prompt } : {})
                  }
                }
              : {}),
            expectedSemanticRevision: record.snapshot.semanticRevision,
            traceId: options.diagnostics?.traceId ?? record.snapshot.traceId,
            spanId: options.diagnostics?.spanId ?? record.snapshot.spanId
          },
          signal
        )
      )
      if (
        receipt.commandId !== commandId ||
        receipt.projectId !== record.snapshot.projectId ||
        receipt.taskId !== record.snapshot.taskId ||
        receipt.targetNodeId !== target.nodeId ||
        canonicalFlowJson(receipt.inputs) !== canonicalFlowJson(target.inputs)
      )
        throw new AgentRuntimeError('AGENT_RECEIPT_INVALID', 'receipt')
      if (receipt.state === 'pending' || receipt.state === 'unknown') {
        wait('reconcile')
        // Re-enter through the same command ID and read its ledger, never replay a grant.
        return { retryTool: true }
      }
      store.setState(thread, 'running')
      return { receipts: [...state.receipts, receipt], retryTool: false }
    })
    .addNode('human', (state) => {
      const response = wait('human')
      if (!response.accepted) throw new AgentRuntimeError('HUMAN_REJECTED', 'human')
      const available = state.receipts
        .filter((item) => item.state === 'committed')
        .flatMap((item) => item.outputRefs)
      if (
        response.selectedOutputs?.some(
          (ref) => !available.some((item) => canonicalFlowJson(item) === canonicalFlowJson(ref))
        )
      )
        throw new AgentRuntimeError('AGENT_OUTPUT_UNVERIFIED', 'human-selection')
      if (
        response.selectedOutputs &&
        new Set(response.selectedOutputs.map(canonicalFlowJson)).size !==
          response.selectedOutputs.length
      )
        throw new AgentRuntimeError('AGENT_OUTPUT_UNVERIFIED', 'human-selection')
      return {
        humanAccepted: true,
        humanFeedback: response.feedback ?? '',
        selectedOutputs: response.selectedOutputs ?? []
      }
    })
    .addNode('finish', (state) => {
      valid()
      if (state.decision.kind !== 'finish')
        throw new AgentRuntimeError('INVALID_DECISION', 'finish')
      const refs = state.receipts
        .filter((item) => item.state === 'committed')
        .flatMap((item) => item.outputRefs)
      if (
        state.decision.outputs.some(
          (output) => !refs.some((ref) => canonicalFlowJson(ref) === canonicalFlowJson(output))
        )
      )
        throw new AgentRuntimeError('AGENT_OUTPUT_UNVERIFIED', 'finish')
      if (
        state.selectedOutputs.length &&
        canonicalFlowJson(state.decision.outputs) !== canonicalFlowJson(state.selectedOutputs)
      )
        throw new AgentRuntimeError('AGENT_SELECTION_CONFLICT', 'finish')
      return {}
    })
    .addEdge(START, 'decide')
    .addConditionalEdges('decide', (state) => state.decision.kind, {
      execute: 'tool',
      'load-skill': 'skill',
      wait: 'human',
      finish: 'finish'
    })
    .addConditionalEdges('tool', (state) => (state.retryTool ? 'tool' : 'decide'), {
      tool: 'tool',
      decide: 'decide'
    })
    .addEdge('skill', 'decide')
    .addEdge('human', 'decide')
    .addEdge('finish', END)
    .compile({ checkpointer: new FlowSqliteSaver(store.db, telemetry) })

  async function execute(
    input: Parameters<typeof graph.invoke>[0],
    stage: 'started' | 'resumed'
  ): Promise<AgentTaskRecord> {
    let locks = busy.get(store.db)
    if (!locks) busy.set(store.db, (locks = new Set()))
    if (locks.has(thread)) throw new AgentRuntimeError('AGENT_TASK_BUSY', 'runtime')
    locks.add(thread)
    const controller = new AbortController()
    let controllers = cancellations.get(store.db)
    if (!controllers) cancellations.set(store.db, (controllers = new Map()))
    controllers.set(thread, controller)
    signal = controller.signal
    const remaining = store.read(thread).snapshot.maxActiveMs - store.read(thread).activeMs
    const timer = setTimeout(() => controller.abort(), Math.max(1, remaining))
    timer.unref()
    telemetry(stage, stage === 'started' ? 'start' : 'resume')
    try {
      valid()
      const result = await graph.invoke(input, { ...config, signal })
      const state = await graph.getState(config)
      valid()
      if (state.tasks.some((task) => task.interrupts?.length)) {
        telemetry('waiting', store.read(thread).waitKind ?? 'wait')
      } else {
        if (result.decision?.kind !== 'finish')
          throw new AgentRuntimeError('AGENT_FINISH_MISSING', 'finish')
        store.setState(thread, 'completed', undefined, result.decision.outputs)
        telemetry('completed', 'finish')
      }
    } catch (error) {
      const record = store.read(thread)
      if (record.state === 'cancelled') return record
      const code = controller.signal.aborted
        ? 'AGENT_CANCELLED_OR_TIMED_OUT'
        : error instanceof AgentRuntimeError ||
            error instanceof FlowCommandError ||
            error instanceof FlowAssetError
          ? error.code
          : 'AGENT_RUNTIME_FAILED'
      const phase =
        error instanceof AgentRuntimeError ||
        error instanceof FlowCommandError ||
        error instanceof FlowAssetError
          ? (error.phase ?? 'asset')
          : 'runtime'
      store.setState(thread, 'blocked', code)
      telemetry('blocked', phase, code)
    } finally {
      clearTimeout(timer)
      locks.delete(thread)
      controllers.delete(thread)
    }
    return store.read(thread)
  }
  return {
    start: async (): Promise<AgentTaskRecord> => {
      // Duplicate starts read existing facts and never cause a second invocation.
      let record: AgentTaskRecord
      try {
        record = store.read(thread)
      } catch (error) {
        if (!(error instanceof AgentRuntimeError) || error.code !== 'AGENT_TASK_MISSING')
          throw error
        telemetry('admission_started', 'task-bind')
        try {
          assertRevision(options.snapshot)
          if (
            options.snapshot.config.tools.some(
              (tool) => tool.id !== 'node.execute' || tool.version !== '1'
            )
          )
            throw new AgentRuntimeError('AGENT_TOOL_UNSUPPORTED', 'task-bind')
          record = store.create(
            options.snapshot,
            options.skills.bind(options.snapshot.config.skills, options.snapshot.config.tools)
          )
          telemetry('admission_completed', 'task-bind')
        } catch (error) {
          const code =
            error instanceof AgentRuntimeError ||
            error instanceof FlowCommandError ||
            error instanceof FlowAssetError
              ? error.code
              : 'AGENT_ADMISSION_FAILED'
          telemetry('admission_failed', 'task-bind', code)
          throw error instanceof AgentRuntimeError
            ? error
            : new AgentRuntimeError(code, 'task-bind')
        }
      }
      if (record.state !== 'ready') return record
      store.setState(thread, 'running')
      return execute({}, 'started')
    },
    inspect: (): AgentTaskRecord => store.read(thread),
    resume: async (raw: unknown): Promise<AgentTaskRecord> => {
      telemetry('resume_check_started', 'resume-validation')
      try {
        assertRevision(store.read(thread).snapshot)
        if (busy.get(store.db)?.has(thread))
          throw new AgentRuntimeError('AGENT_TASK_BUSY', 'resume')
        const { response, replay } = store.response(thread, raw)
        const state = await graph.getState(config)
        telemetry('resume_check_completed', 'resume-validation')
        if (replay && !state.tasks.some((task) => task.interrupts?.length))
          return store.read(thread)
        if (replay && store.read(thread).waitRevision !== response.waitRevision)
          return store.read(thread)
        return execute(new Command({ resume: response }), 'resumed')
      } catch (error) {
        const code =
          error instanceof AgentRuntimeError ||
          error instanceof FlowCommandError ||
          error instanceof FlowAssetError
            ? error.code
            : 'AGENT_RESUME_INVALID'
        telemetry('resume_check_failed', 'resume-validation', code)
        throw error instanceof AgentRuntimeError
          ? error
          : new AgentRuntimeError(code, 'resume-validation')
      }
    },
    cancel: (): AgentTaskRecord => {
      const record = store.read(thread)
      if (['completed', 'failed', 'cancelled'].includes(record.state)) return record
      store.setState(thread, 'cancelled', 'AGENT_CANCELLED')
      cancellations.get(store.db)?.get(thread)?.abort()
      telemetry('cancelled', 'cancel')
      return store.read(thread)
    }
  }
}
