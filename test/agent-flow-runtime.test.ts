import { afterEach, describe, expect, it, vi } from 'vitest'
import Database from 'better-sqlite3'
import { createOpenAICompatible } from '@ai-sdk/openai-compatible'
import { AgentSdkModel } from '../src/main/agent-flow/runtime-model'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, dirname, basename } from 'node:path'
import { migrateDatabase } from '../src/main/store/db-migrations'
import { FlowSkillStore, BUILTIN_FLOW_SKILLS } from '../src/main/agent-flow/skill-store'
import { FlowTaskStore, agentThread } from '../src/main/agent-flow/task-store'
import {
  createAgentRuntime,
  type AgentModelPort,
  type AgentModelContext
} from '../src/main/agent-flow/runtime'
import { createLedgerToolPort, type AgentToolPort } from '../src/main/agent-flow/ledger-tool'
import { createAgentTelemetry } from '../src/main/agent-flow/runtime-diagnostics'
import {
  AgentTaskSnapshotSchema,
  AgentRuntimeError,
  type AgentTaskSnapshot
} from '../src/shared/agent-flow/runtime-contracts'
import type { FlowCommandReceipt, NodeExecuteCommand } from '../src/shared/agent-flow/commands'
import { FlowCommandError } from '../src/shared/agent-flow/commands'
import type { FlowCommandLedger } from '../src/main/agent-flow/command-ledger'
import { setGatewayEventSink } from '../src/main/diagnostics/gateway-events'
import type { DiagnosticsEventInput } from '../src/shared/observability'

const databases: Database.Database[] = []
const dirs: string[] = []
afterEach(() => {
  setGatewayEventSink(null)
  for (const db of databases.splice(0)) if (db.open) db.close()
  for (const directory of dirs.splice(0)) {
    if (
      dirname(resolve(directory)) !== resolve(tmpdir()) ||
      !basename(directory).startsWith('canvas-c3-')
    )
      throw new Error('Unsafe cleanup')
    rmSync(directory, { recursive: true, force: true })
  }
})
const output = {
  assetId: 'asset-output',
  versionId: 'v-output',
  sourceNodeId: 'processor',
  sourcePortId: 'out-value'
}
const noop = (): void => {}
function snapshot(mode: 'autonomous' | 'collaborative' = 'autonomous'): AgentTaskSnapshot {
  return AgentTaskSnapshotSchema.parse({
    runtimeVersion: 1,
    projectId: 'p',
    agentNodeId: 'agent',
    taskId: 'task',
    semanticRevision: `sha256:${'a'.repeat(64)}`,
    goal: 'private-goal fake-secret',
    config: {
      schemaVersion: 1,
      role: 'specialist',
      interactionMode: mode,
      skills: [{ id: 'result-check', version: '1' }],
      tools: [{ id: 'node.execute', version: '1' }],
      allowedNodeIds: ['processor'],
      maxSteps: 12,
      relations: []
    },
    targets: [{ nodeId: 'processor', contractVersion: 1, inputs: [] }],
    traceId: 'trace',
    spanId: 'span'
  })
}
function fixture(path = ':memory:') {
  const db = new Database(path)
  db.pragma('foreign_keys=ON')
  databases.push(db)
  migrateDatabase(db)
  db.prepare(
    "INSERT OR IGNORE INTO projects(id,name,created_at,updated_at) VALUES ('p','fixture',0,0)"
  ).run()
  const skills = new FlowSkillStore(db)
  for (const item of BUILTIN_FLOW_SKILLS) skills.import(item)
  return { db, skills, store: new FlowTaskStore(db) }
}
function receipt(
  command: NodeExecuteCommand,
  state: FlowCommandReceipt['state'] = 'committed'
): FlowCommandReceipt {
  return {
    commandId: command.commandId,
    projectId: command.projectId,
    taskId: command.taskId,
    targetNodeId: command.targetNodeId,
    runId: 'run',
    state,
    inputs: command.inputs,
    outputRefs: state === 'committed' ? [output] : []
  }
}
const model: AgentModelPort = {
  decide: async (input) =>
    !Object.keys(input.loaded).length
      ? { kind: 'load-skill', skillId: 'result-check' }
      : input.receipts.length < 2
        ? { kind: 'execute', targetNodeId: 'processor' }
        : input.mode === 'collaborative' && !input.humanAccepted
          ? { kind: 'wait' }
          : { kind: 'finish', outputs: [output] }
}
function runtime(
  f = fixture(),
  task = snapshot(),
  overrides: Partial<Parameters<typeof createAgentRuntime>[0]> = {}
) {
  return createAgentRuntime({
    snapshot: task,
    ...f,
    model,
    tools: { execute: vi.fn(async (command) => receipt(command)) },
    assertRevision: noop,
    telemetry: noop,
    ...overrides
  })
}

describe('C3 immutable content Skills', () => {
  it('keeps versions immutable, requires exact dependencies, refuses path and payload escapes', () => {
    const f = fixture()
    const skill = BUILTIN_FLOW_SKILLS[0]
    const saved = f.skills.import(skill)
    expect(f.skills.import(skill)).toEqual(saved)
    expect(() => f.skills.import({ ...skill, instructions: 'changed' })).toThrow(
      'SKILL_VERSION_IMMUTABLE'
    )
    expect(() => f.skills.bind([{ id: skill.id, version: '1' }], [])).toThrow('SKILL_TOOL_MISSING')
    expect(() =>
      f.skills.import({ ...skill, version: '2', resources: { '../escape.md': 'secret' } })
    ).toThrow('SKILL_PACKAGE_INVALID')
    expect(() => f.skills.import({ ...skill, version: '2', scripts: ['evil'] })).toThrow(
      'SKILL_PACKAGE_INVALID'
    )
    f.skills.setEnabled(skill.id, '1', false)
    expect(() => f.skills.bind([{ id: skill.id, version: '1' }], skill.requiredTools)).toThrow(
      'SKILL_DISABLED'
    )
  })
  it('pins task content across disabled/edited library versions and loads only chosen resources', async () => {
    const f = fixture()
    const r = runtime(f, snapshot('collaborative'))
    expect((await r.start()).state).toBe('waiting')
    const before = r.inspect().skills
    f.skills.setEnabled('result-check', '1', false)
    f.skills.import({ ...BUILTIN_FLOW_SKILLS[2], version: '2', instructions: 'new instructions' })
    const next = runtime(f, snapshot('collaborative'))
    const result = await next.resume({
      taskId: 'task',
      semanticRevision: snapshot().semanticRevision,
      waitRevision: 1,
      eventId: 'accepted',
      kind: 'human',
      accepted: true
    })
    expect(result.state).toBe('completed')
    expect(result.skills).toEqual(before)
  })
})

describe('C3 bounded LangGraph task loop', () => {
  it('loads a Skill, invokes two stable commands, checks receipts and finishes only with fixed assets', async () => {
    const f = fixture()
    const execute = vi.fn(async (command: NodeExecuteCommand) => receipt(command))
    const r = runtime(f, snapshot(), { tools: { execute } })
    const result = await r.start()
    expect(result.state).toBe('completed')
    expect(result.outputRefs).toEqual([output])
    expect(result.decisions).toBe(4)
    expect(result.tools).toBe(3)
    expect(execute.mock.calls[0][0].commandId).not.toBe(execute.mock.calls[1][0].commandId)
    await r.start()
    expect(execute).toHaveBeenCalledTimes(2)
    expect(f.db.prepare('SELECT COUNT(*) AS n FROM flow_agent_checkpoints').get()).toMatchObject({
      n: expect.any(Number)
    })
  })
  it('restores persisted human interrupts after closing the DB; duplicate responses do not advance twice', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'canvas-c3-'))
    dirs.push(directory)
    const path = join(directory, 'state.sqlite')
    const f = fixture(path)
    const task = snapshot('collaborative')
    expect((await runtime(f, task).start()).state).toBe('waiting')
    f.db.close()
    const next = fixture(path)
    const tools = { execute: vi.fn(async (command: NodeExecuteCommand) => receipt(command)) }
    const r = runtime(next, task, { tools })
    const response = {
      taskId: 'task',
      semanticRevision: task.semanticRevision,
      waitRevision: 1,
      eventId: 'continue',
      kind: 'human',
      accepted: true
    }
    expect((await r.resume(response)).state).toBe('completed')
    expect((await r.resume(response)).state).toBe('completed')
    expect(tools.execute).not.toHaveBeenCalled()
    await expect(r.resume({ ...response, accepted: false })).rejects.toThrow(
      'RESUME_INTENT_CONFLICT'
    )
  })
  it('rejects stale human events and changed canvas revisions before advancing', async () => {
    const f = fixture()
    const task = snapshot('collaborative')
    const r = runtime(f, task)
    await r.start()
    await expect(
      r.resume({
        taskId: 'task',
        semanticRevision: task.semanticRevision,
        waitRevision: 2,
        eventId: 'stale',
        kind: 'human',
        accepted: true
      })
    ).rejects.toThrow('RESUME_CONFLICT')
    const changed = runtime(f, task, {
      assertRevision: () => {
        throw new AgentRuntimeError('FLOW_REVISION_CONFLICT', 'revision')
      }
    })
    await expect(
      changed.resume({
        taskId: 'task',
        semanticRevision: task.semanticRevision,
        waitRevision: 1,
        eventId: 'new',
        kind: 'human',
        accepted: true
      })
    ).rejects.toThrow('FLOW_REVISION_CONFLICT')
    expect(r.inspect().state).toBe('waiting')
  })
  it('blocks unsupported tools, unbound Skill reads and fabricated completion', async () => {
    const unknown = snapshot()
    unknown.config.tools = [{ id: 'shell', version: '1' }]
    await expect(runtime(fixture(), unknown).start()).rejects.toThrow('AGENT_TOOL_UNSUPPORTED')
    expect(
      (
        await runtime(fixture(), snapshot(), {
          model: { decide: async () => ({ kind: 'finish', outputs: [output] }) }
        }).start()
      ).code
    ).toBe('AGENT_OUTPUT_UNVERIFIED')
    expect(
      (
        await runtime(fixture(), snapshot(), {
          model: { decide: async () => ({ kind: 'load-skill', skillId: 'other' }) }
        }).start()
      ).code
    ).toBe('SKILL_NOT_BOUND')
  })
  it('does not force human participation on autonomous tasks', async () => {
    const r = runtime(fixture(), snapshot(), { model: { decide: async () => ({ kind: 'wait' }) } })
    expect((await r.start()).code).toBe('HUMAN_WAIT_DENIED')
  })
  it('loads only explicitly declared resources, including rejection of inherited object names', async () => {
    for (const resource of ['../secret.md', 'constructor', 'toString', 'missing.md']) {
      const r = runtime(fixture(), snapshot(), {
        model: { decide: async () => ({ kind: 'load-skill', skillId: 'result-check', resource }) }
      })
      expect((await r.start()).code).toBe('SKILL_RESOURCE_DENIED')
    }
  })
  it('reserves durable decision budgets before requests and never loops indefinitely', async () => {
    const f = fixture()
    const task = snapshot()
    task.maxDecisions = 2
    const r = runtime(f, task, {
      model: { decide: async () => ({ kind: 'execute', targetNodeId: 'processor' }) }
    })
    const result = await r.start()
    expect(result.code).toBe('AGENT_BUDGET_EXHAUSTED')
    expect(result.decisions).toBe(2)
    expect((await runtime(f, task).start()).decisions).toBe(2)
  })
  it('keeps unknown effects in an explicit reconciliation wait and reuses the same command ID', async () => {
    const f = fixture()
    let resolved = false
    const execute = vi.fn(async (command: NodeExecuteCommand) =>
      receipt(command, resolved ? 'committed' : 'unknown')
    )
    const r = runtime(f, snapshot(), { tools: { execute } })
    expect((await r.start()).waitKind).toBe('reconcile')
    const first = execute.mock.calls[0][0].commandId
    resolved = true
    expect(
      (
        await r.resume({
          taskId: 'task',
          semanticRevision: snapshot().semanticRevision,
          waitRevision: 1,
          eventId: 'reconcile',
          kind: 'reconcile'
        })
      ).state
    ).toBe('completed')
    expect(execute.mock.calls[1][0].commandId).toBe(first)
    expect(r.inspect().tools).toBe(3)
  })
  it('cancels in-flight requests and rejects late completion without modifying terminal task facts', async () => {
    const f = fixture()
    let release!: (decision: { kind: 'finish'; outputs: (typeof output)[] }) => void
    const r = runtime(f, snapshot(), {
      model: {
        decide: () =>
          new Promise((resolve) => {
            release = resolve
          })
      }
    })
    const running = r.start()
    await vi.waitFor(() => expect(release).toBeTypeOf('function'))
    expect(r.cancel().state).toBe('cancelled')
    expect((await running).state).toBe('cancelled')
    release({ kind: 'finish', outputs: [output] })
    await new Promise((resolve) => setTimeout(resolve, 5))
    expect(r.inspect().outputRefs).toEqual([])
  })
  it('times out even when a model does not honor its abort signal', async () => {
    const task = snapshot()
    task.maxActiveMs = 10
    const r = runtime(fixture(), task, { model: { decide: () => new Promise(() => {}) } })
    expect((await r.start()).code).toMatch(/TIMED_OUT/)
  })
  it('blocks concurrent task ownership and cascades project-scoped checkpoint deletion', async () => {
    const f = fixture()
    const r = runtime(f, snapshot('collaborative'))
    await r.start()
    const other = snapshot()
    other.taskId = 'other-task'
    await expect(runtime(f, other).start()).rejects.toThrow('AGENT_TASK_OCCUPIED')
    f.db.prepare("DELETE FROM projects WHERE id='p'").run()
    expect(f.db.prepare('SELECT COUNT(*) AS n FROM flow_agent_checkpoints').get()).toEqual({ n: 0 })
    expect(() => f.store.read(agentThread(snapshot()))).toThrow('AGENT_TASK_MISSING')
  })
  it('records safe lifecycle correlation and never lets failing diagnostics change results', async () => {
    const events: DiagnosticsEventInput[] = []
    setGatewayEventSink({
      emit: (event) => {
        if (event) events.push(event)
      }
    })
    const task = snapshot()
    expect(
      (await runtime(fixture(), task, { telemetry: createAgentTelemetry(task) }).start()).state
    ).toBe('completed')
    const serialized = JSON.stringify(events)
    expect(serialized).not.toContain('private-goal')
    expect(serialized).not.toContain('fake-secret')
    expect(events.filter((event) => event.event === 'agent.runtime.completed')).toHaveLength(1)
    expect(
      events
        .filter((event) => event.event.startsWith('agent.runtime.'))
        .every((event) => event.taskId === 'task' && event.projectId === 'p')
    ).toBe(true)
    const before = events.length
    const collaborative = snapshot('collaborative')
    const r = runtime(fixture(), collaborative, { telemetry: createAgentTelemetry(collaborative) })
    await r.start()
    await r.resume({
      taskId: 'task',
      semanticRevision: collaborative.semanticRevision,
      waitRevision: 1,
      eventId: 'resume-trace',
      kind: 'human',
      accepted: true
    })
    const resumed = events.slice(before).find((event) => event.event === 'agent.runtime.resumed')!
    expect(resumed.traceId).not.toBe(collaborative.traceId)
    expect(resumed.attributes?.resumesTraceId).toBe(collaborative.traceId)
    setGatewayEventSink({
      emit: () => {
        throw new Error('private logger fault')
      }
    })
    expect(
      (await runtime(fixture(), task, { telemetry: createAgentTelemetry(task) }).start()).state
    ).toBe('completed')
  })
})

describe('C3 tool adapter preserves the C2 ledger authority', () => {
  it('checks existing command intent and reads unknown receipts without resending', async () => {
    const command = {} as NodeExecuteCommand
    const prepare = vi.fn(() => ({ state: 'unknown', receipt: { state: 'unknown' } }))
    const deliver = vi.fn()
    const ledger = { lookup: () => ({ state: 'unknown' }), prepare } as unknown as FlowCommandLedger
    expect(
      (await createLedgerToolPort(ledger, deliver).execute(command, new AbortController().signal))
        .state
    ).toBe('unknown')
    expect(prepare).toHaveBeenCalledTimes(1)
    expect(deliver).not.toHaveBeenCalled()
  })
  it('persists grants before delivery and preserves unknown if delivery or receipt saving fails', async () => {
    const order: string[] = []
    const ledger = {
      lookup: () => {
        throw new FlowCommandError('FLOW_COMMAND_MISSING', 'receipt-read')
      },
      prepare: () => {
        order.push('persist')
        return { state: 'ready', grant: { leaseId: 'lease' } }
      },
      commit: () => {
        order.push('commit')
        throw new Error('storage')
      },
      unknown: () => {
        order.push('unknown')
        return { state: 'unknown' }
      }
    } as unknown as FlowCommandLedger
    const port = createLedgerToolPort(ledger, async () => {
      order.push('deliver')
    })
    expect(
      (
        await port.execute(
          { projectId: 'p', commandId: 'c' } as NodeExecuteCommand,
          new AbortController().signal
        )
      ).state
    ).toBe('unknown')
    expect(order).toEqual(['persist', 'deliver', 'commit', 'unknown'])
  })
})

describe('C3 single-step SDK adapter', () => {
  function sdk(name = 'execute_node') {
    const requests: unknown[] = []
    const model = createOpenAICompatible({
      name: 'fixture',
      baseURL: 'https://example.invalid/v1',
      fetch: async (_, init) => {
        requests.push(JSON.parse(String(init?.body)))
        return new Response(
          `data: ${JSON.stringify({
            id: 'fixture',
            object: 'chat.completion.chunk',
            created: 1,
            model: 'fixture',
            choices: [
              {
                index: 0,
                delta: {
                  tool_calls: [
                    {
                      index: 0,
                      id: 'call-1',
                      type: 'function',
                      function: { name, arguments: JSON.stringify({ targetNodeId: 'processor' }) }
                    }
                  ]
                },
                finish_reason: null
              }
            ]
          })}\n\n` +
            `data: ${JSON.stringify({
              id: 'fixture',
              object: 'chat.completion.chunk',
              created: 1,
              model: 'fixture',
              choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }]
            })}\n\ndata: [DONE]\n\n`,
          { headers: { 'content-type': 'text/event-stream' } }
        )
      }
    }).chatModel('fixture')
    const inputs = { resolveInputs: vi.fn(() => []) }
    return {
      requests,
      inputs,
      port: new AgentSdkModel(model, 'p', inputs, {
        projectId: 'p',
        nodeId: 'agent',
        taskId: 'task',
        traceId: 'trace',
        spanId: 'span'
      })
    }
  }
  const input = (): AgentModelContext => ({
    goal: 'private-goal fake-secret',
    mode: 'autonomous',
    targets: snapshot().targets,
    skills: [],
    loaded: {},
    receipts: [],
    humanAccepted: false
  })
  it('uses one real SDK structured-tool request, with no nested tool execution or diagnostic bodies', async () => {
    const events: DiagnosticsEventInput[] = []
    setGatewayEventSink({
      emit: (event) => {
        if (event) events.push(event)
      }
    })
    const fixture = sdk()
    expect(await fixture.port.decide(input(), new AbortController().signal)).toEqual({
      kind: 'execute',
      targetNodeId: 'processor'
    })
    expect(fixture.requests).toHaveLength(1)
    expect(fixture.inputs.resolveInputs).toHaveBeenCalledWith('p', [])
    expect(events.map((event) => event.event)).toEqual([
      'model.request.started',
      'model.request.first_chunk',
      'model.request.completed'
    ])
    expect(JSON.stringify(events)).not.toContain('private-goal')
    expect(JSON.stringify(events)).not.toContain('fake-secret')
  })
  it('rejects undeclared tools and oversized contexts without guessing from model prose', async () => {
    await expect(sdk('shell').port.decide(input(), new AbortController().signal)).rejects.toThrow(
      'AGENT_MODEL_FAILED'
    )
    const fixture = sdk()
    const tooLarge = input()
    tooLarge.loaded = { private: 'a'.repeat(300000) }
    await expect(fixture.port.decide(tooLarge, new AbortController().signal)).rejects.toThrow(
      'AGENT_CONTEXT_TOO_LARGE'
    )
    expect(fixture.requests).toHaveLength(0)
  })
})
