import { Annotation, StateGraph, START, END, Command, interrupt } from '@langchain/langgraph'
import {
  C0DecisionSchema,
  C0InputSchema,
  C0ResumeSchema,
  C0Error,
  type C0Decision,
  type C0ModelPort,
  type C0Output,
  type C0Scope,
  type C0Transport
} from '../../../shared/agent-flow/c0-contracts'
import { C0SqliteSaver } from './checkpoint'
import { C0CommandLedger } from './command-ledger'
import type { C0Telemetry } from './diagnostics'

const State = Annotation.Root({
  text: Annotation<string>(),
  mode: Annotation<'autonomous' | 'collaborative'>(),
  revision: Annotation<number>(),
  rounds: Annotation<number>({ default: () => 0, reducer: (_, next) => next }),
  outputs: Annotation<C0Output[]>({ default: () => [], reducer: (_, next) => next }),
  humanAccepted: Annotation<boolean | null>({ default: () => null, reducer: (_, next) => next }),
  decision: Annotation<C0Decision>(),
  finalOutput: Annotation<C0Output>()
})

export interface C0RuntimeOptions {
  scope: C0Scope
  saver: C0SqliteSaver
  ledger: C0CommandLedger
  model: C0ModelPort
  transport: C0Transport
  telemetry: C0Telemetry
  maxRounds?: number
}

interface C0Result {
  status: 'waiting' | 'completed'
  output?: C0Output
}
export interface C0Runtime {
  start(text: string, mode: 'autonomous' | 'collaborative'): Promise<C0Result>
  resume(raw: unknown): Promise<C0Result>
  inspect(): Promise<{ checkpointPresent: boolean; waiting: boolean }>
}

export function createC0Runtime(options: C0RuntimeOptions): C0Runtime {
  const { scope, saver, ledger, model, transport, telemetry } = options
  const graph = new StateGraph(State)
    .addNode('decide', async (state, config) => {
      if (state.revision !== scope.revision) throw new C0Error('REVISION_CONFLICT')
      if (state.rounds >= (options.maxRounds ?? 12)) throw new C0Error('BUDGET_EXHAUSTED')
      const decision = C0DecisionSchema.parse(await model.decide(state, config.signal))
      if (decision.kind === 'wait' && state.mode === 'autonomous')
        throw new C0Error('HUMAN_WAIT_DENIED')
      if (decision.kind === 'finish' && !state.outputs.length) throw new C0Error('NO_TOOL_RECEIPT')
      return { decision, rounds: state.rounds + 1 }
    })
    .addNode('tool', async (state) => {
      if (state.decision.kind !== 'tool') throw new C0Error('INVALID_DECISION')
      const output = await ledger.execute(
        {
          commandId: `${scope.taskId}:tool:${state.outputs.length}`,
          projectId: scope.projectId,
          agentNodeId: scope.agentNodeId,
          taskId: scope.taskId,
          targetNodeId: state.decision.targetNodeId,
          expectedRevision: state.revision,
          input: state.decision.input
        },
        scope,
        transport
      )
      return { outputs: [...state.outputs, output] }
    })
    .addNode('wait', (state) => {
      const response = C0ResumeSchema.parse(
        interrupt({ taskId: scope.taskId, expectedRevision: state.revision, kind: 'c0-review' })
      )
      if (response.taskId !== scope.taskId || response.expectedRevision !== state.revision)
        throw new C0Error('RESUME_CONFLICT')
      if (!response.accepted) throw new C0Error('HUMAN_REJECTED')
      return { humanAccepted: response.accepted }
    })
    .addNode('finish', (state) => {
      if (state.decision.kind !== 'finish') throw new C0Error('INVALID_DECISION')
      // C0 completion must agree with a real tool receipt, not a model assertion.
      if (state.decision.output.text !== state.outputs.at(-1)?.text)
        throw new C0Error('OUTPUT_MISMATCH')
      return { finalOutput: state.decision.output }
    })
    .addEdge(START, 'decide')
    .addConditionalEdges('decide', (state) => state.decision.kind, {
      tool: 'tool',
      wait: 'wait',
      finish: 'finish'
    })
    .addEdge('tool', 'decide')
    .addEdge('wait', 'decide')
    .addEdge('finish', END)
    .compile({ checkpointer: saver })
  const config = {
    configurable: {
      thread_id: `${scope.projectId}:${scope.agentNodeId}:${scope.taskId}`,
      checkpoint_ns: ''
    },
    recursionLimit: 64,
    callbacks: []
  }

  async function execute(
    input: Parameters<typeof graph.invoke>[0]
  ): Promise<{ status: 'waiting' | 'completed'; output?: C0Output }> {
    telemetry(
      input instanceof Command ? 'resumed' : 'started',
      input instanceof Command ? 'resume' : 'start'
    )
    try {
      const result = await graph.invoke(input, config)
      const snapshot = await graph.getState(config)
      if (snapshot.tasks.some((task) => task.interrupts?.length)) {
        telemetry('waiting', 'human')
        return { status: 'waiting' }
      }
      telemetry('completed', 'finish')
      return { status: 'completed', output: result.finalOutput }
    } catch (error) {
      telemetry('failed', 'runtime', error instanceof C0Error ? error.code : 'RUNTIME_FAILED')
      throw error
    }
  }
  return {
    inspect: async () => {
      const snapshot = await graph.getState(config)
      return {
        checkpointPresent: Boolean(snapshot.createdAt),
        waiting: snapshot.tasks.some((task) => task.interrupts?.length)
      }
    },
    start: async (text: string, mode: 'autonomous' | 'collaborative') => {
      C0InputSchema.parse({ text })
      if (await saver.getTuple(config)) throw new C0Error('TASK_ALREADY_EXISTS')
      return execute({ text, mode, revision: scope.revision })
    },
    resume: async (raw: unknown) => {
      const response = C0ResumeSchema.parse(raw)
      if (response.taskId !== scope.taskId || response.expectedRevision !== scope.revision)
        throw new C0Error('RESUME_CONFLICT')
      const snapshot = await graph.getState(config)
      if (!snapshot.tasks.some((task) => task.interrupts?.length)) throw new C0Error('NOT_WAITING')
      return execute(new Command({ resume: response }))
    }
  }
}
