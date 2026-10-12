import { afterEach, describe, expect, it, vi } from 'vitest'
import Database from 'better-sqlite3'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname, resolve, basename } from 'node:path'
import { createOpenAICompatible } from '@ai-sdk/openai-compatible'
import { emptyCheckpoint } from '@langchain/langgraph-checkpoint'
import { C0SqliteSaver } from '../src/main/agent-flow/c0/checkpoint'
import { C0CommandLedger } from '../src/main/agent-flow/c0/command-ledger'
import { createC0Runtime } from '../src/main/agent-flow/c0/runtime'
import { C0SdkModel } from '../src/main/agent-flow/c0/model'
import { createC0Telemetry } from '../src/main/agent-flow/c0/diagnostics'
import { setGatewayEventSink } from '../src/main/diagnostics/gateway-events'
import type { C0Command, C0ModelPort, C0Scope } from '../src/shared/agent-flow/c0-contracts'
import type { DiagnosticsEventInput } from '../src/shared/observability'

const scope: C0Scope = {
  projectId: 'p',
  agentNodeId: 'agent',
  taskId: 'task',
  revision: 1,
  allowedNodeIds: ['processor']
}
const command: C0Command = {
  projectId: 'p',
  agentNodeId: 'agent',
  taskId: 'task',
  commandId: 'command',
  targetNodeId: 'processor',
  expectedRevision: 1,
  input: { text: 'private fixture' }
}
const databases: Database.Database[] = []
const directories: string[] = []
const noop = (): void => undefined
const db = (path = ':memory:') => {
  const value = new Database(path)
  databases.push(value)
  return value
}
afterEach(() => {
  setGatewayEventSink(null)
  for (const value of databases.splice(0)) if (value.open) value.close()
  for (const directory of directories.splice(0)) {
    if (
      dirname(resolve(directory)) !== resolve(tmpdir()) ||
      !basename(directory).startsWith('canvas-agent-c0-')
    )
      throw new Error('Unsafe test cleanup')
    rmSync(directory, { recursive: true, force: true })
  }
})

const fixtureModel: C0ModelPort = {
  decide: async (input) =>
    !input.outputs.length
      ? { kind: 'tool', targetNodeId: 'processor', input: { text: input.text } }
      : input.mode === 'collaborative' && input.humanAccepted === null
        ? { kind: 'wait' }
        : { kind: 'finish', output: input.outputs[0] }
}
const runtime = (
  database: Database.Database,
  execute = vi.fn(async () => ({ text: 'RESULT' })),
  model = fixtureModel,
  maxRounds = 12
) =>
  createC0Runtime({
    scope,
    saver: new C0SqliteSaver(database, noop),
    ledger: new C0CommandLedger(database, noop),
    transport: { execute },
    model,
    telemetry: noop,
    maxRounds
  })

describe('C0 receipt boundary', () => {
  it('deduplicates identical simultaneous and completed commands', async () => {
    const ledger = new C0CommandLedger(db(), noop)
    const execute = vi.fn(async () => ({ text: 'RESULT' }))
    const first = ledger.execute(command, scope, { execute })
    const second = ledger.execute(command, scope, { execute })
    expect(await first).toEqual(await second)
    await ledger.execute(command, scope, { execute })
    expect(execute).toHaveBeenCalledTimes(1)
  })
  it('rejects out-of-scope, stale revision and reused IDs with different input', async () => {
    const ledger = new C0CommandLedger(db(), noop)
    const execute = vi.fn(async () => ({ text: 'RESULT' }))
    expect(() => ledger.execute({ ...command, targetNodeId: 'other' }, scope, { execute })).toThrow(
      'SCOPE_DENIED'
    )
    expect(() => ledger.execute({ ...command, expectedRevision: 2 }, scope, { execute })).toThrow(
      'REVISION_CONFLICT'
    )
    await ledger.execute(command, scope, { execute })
    expect(() =>
      ledger.execute({ ...command, input: { text: 'changed' } }, scope, { execute })
    ).toThrow('COMMAND_CONFLICT')
    expect(execute).toHaveBeenCalledTimes(1)
  })
  it('never retries timed-out effects after a new ledger is created', async () => {
    const database = db()
    const execute = vi.fn(() => new Promise<never>(() => undefined))
    await expect(
      new C0CommandLedger(database, noop).execute(command, scope, { execute }, 5)
    ).rejects.toThrow('OUTCOME_UNKNOWN')
    expect(() => new C0CommandLedger(database, noop).execute(command, scope, { execute })).toThrow(
      'OUTCOME_UNKNOWN'
    )
    expect(() =>
      new C0CommandLedger(database, noop).execute({ ...command, commandId: 'another' }, scope, {
        execute
      })
    ).toThrow('NODE_BUSY')
    expect(execute).toHaveBeenCalledTimes(1)
  })
  it('does not turn malformed receipts or receipt write gaps into safe retries', async () => {
    const database = db()
    const execute = vi.fn(async () => ({ invalid: true }))
    await expect(
      new C0CommandLedger(database, noop).execute(command, scope, { execute })
    ).rejects.toThrow('OUTCOME_UNKNOWN')
    expect(() => new C0CommandLedger(database, noop).execute(command, scope, { execute })).toThrow(
      'OUTCOME_UNKNOWN'
    )
  })
  it('keeps a pending receipt when the effect finishes but completion persistence fails', async () => {
    const database = db()
    const ledger = new C0CommandLedger(database, noop)
    database.exec(
      "CREATE TRIGGER fail_receipt BEFORE UPDATE ON c0_commands BEGIN SELECT RAISE(ABORT,'PRIVATE_DATABASE_ERROR'); END;"
    )
    const execute = vi.fn(async () => ({ text: 'RESULT' }))
    await expect(ledger.execute(command, scope, { execute })).rejects.toThrow('OUTCOME_UNKNOWN')
    database.exec('DROP TRIGGER fail_receipt')
    expect(() => new C0CommandLedger(database, noop).execute(command, scope, { execute })).toThrow(
      'OUTCOME_UNKNOWN'
    )
    expect(execute).toHaveBeenCalledTimes(1)
  })
  it('records one command terminal and never leaks private input/output into diagnostics', async () => {
    const events: DiagnosticsEventInput[] = []
    const telemetry = createC0Telemetry(
      {
        emit: (event) => {
          if (event) events.push(event)
        }
      },
      { projectId: 'p', traceId: 'trace', taskId: 'task' }
    )
    const ledger = new C0CommandLedger(db(), telemetry)
    const transport = { execute: async () => ({ text: 'PRIVATE_RESULT_c0' }) }
    await ledger.execute(command, scope, transport)
    await ledger.execute(command, scope, transport)
    expect(events.filter((event) => event.status === 'success')).toHaveLength(1)
    expect(events[0].attributes).toMatchObject({ commandId: 'command', targetNodeId: 'processor' })
    expect(JSON.stringify(events)).not.toContain(command.input.text)
    expect(JSON.stringify(events)).not.toContain('PRIVATE_RESULT_c0')
  })
})

describe('C0 LangGraph SQLite resume', () => {
  it('fails safely on checkpoint write rejection without exposing the database error', async () => {
    const database = db()
    const saver = new C0SqliteSaver(database, noop)
    database.exec(
      "CREATE TRIGGER fail_checkpoint BEFORE INSERT ON c0_checkpoints BEGIN SELECT RAISE(ABORT,'PRIVATE_DATABASE_ERROR'); END;"
    )
    await expect(
      saver.put({ configurable: { thread_id: 'thread' } }, emptyCheckpoint(), {
        source: 'input',
        step: -1,
        parents: {}
      })
    ).rejects.toThrow('CHECKPOINT_WRITE_FAILED')
  })
  it('persists intermediate writes atomically and honors list filters', async () => {
    const database = db()
    const saver = new C0SqliteSaver(database, noop)
    const config = await saver.put({ configurable: { thread_id: 'thread' } }, emptyCheckpoint(), {
      source: 'input',
      step: -1,
      parents: {}
    })
    database.exec(
      "CREATE TRIGGER fail_write BEFORE INSERT ON c0_checkpoint_writes WHEN NEW.idx=1 BEGIN SELECT RAISE(ABORT,'PRIVATE_DATABASE_ERROR'); END;"
    )
    await expect(
      saver.putWrites(
        config,
        [
          ['one', { text: 'private' }],
          ['two', 2]
        ],
        'task'
      )
    ).rejects.toThrow('CHECKPOINT_WRITE_FAILED')
    expect((await saver.getTuple(config))?.pendingWrites).toEqual([])
    database.exec('DROP TRIGGER fail_write')
    await saver.putWrites(config, [['one', { text: 'private' }]], 'task')
    expect((await saver.getTuple(config))?.pendingWrites).toEqual([
      ['task', 'one', { text: 'private' }]
    ])
    const listed = []
    for await (const tuple of saver.list(config, { filter: { source: 'input' }, limit: 1 }))
      listed.push(tuple)
    expect(listed).toHaveLength(1)
    await saver.deleteThread('thread')
    expect(await saver.getTuple(config)).toBeUndefined()
  })
  it('persists an interrupt across DB close/reopen without rerunning the tool', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'canvas-agent-c0-'))
    directories.push(directory)
    const path = join(directory, 'experiment.db')
    const execute = vi.fn(async () => ({ text: 'RESULT' }))
    const firstDb = db(path)
    const first = runtime(firstDb, execute)
    expect(await first.start('private fixture', 'collaborative')).toEqual({ status: 'waiting' })
    firstDb.close()
    const second = runtime(db(path), execute)
    expect(await second.resume({ taskId: 'task', expectedRevision: 1, accepted: true })).toEqual({
      status: 'completed',
      output: { text: 'RESULT' }
    })
    expect(execute).toHaveBeenCalledTimes(1)
    await expect(
      second.resume({ taskId: 'task', expectedRevision: 1, accepted: true })
    ).rejects.toThrow('NOT_WAITING')
  })
  it('rejects stale human responses and leaves the actual wait resumable', async () => {
    const runner = runtime(db())
    await runner.start('private fixture', 'collaborative')
    await expect(
      runner.resume({ taskId: 'task', expectedRevision: 9, accepted: true })
    ).rejects.toThrow('RESUME_CONFLICT')
    await expect(
      runner.resume({ taskId: 'wrong', expectedRevision: 1, accepted: true })
    ).rejects.toThrow('RESUME_CONFLICT')
    expect(
      (await runner.resume({ taskId: 'task', expectedRevision: 1, accepted: true })).status
    ).toBe('completed')
  })
  it('autonomous tasks finish without an artificial human wait', async () => {
    expect((await runtime(db()).start('input', 'autonomous')).status).toBe('completed')
    await expect(
      runtime(db(), undefined, { decide: async () => ({ kind: 'wait' }) }).start(
        'input',
        'autonomous'
      )
    ).rejects.toThrow('HUMAN_WAIT_DENIED')
  })
  it('requires receipts and an exact result; model prose cannot claim success', async () => {
    await expect(
      runtime(db(), undefined, {
        decide: async () => ({ kind: 'finish', output: { text: 'invented' } })
      }).start('input', 'autonomous')
    ).rejects.toThrow('NO_TOOL_RECEIPT')
    const model: C0ModelPort = {
      decide: async (input) =>
        input.outputs.length
          ? { kind: 'finish', output: { text: 'invented' } }
          : fixtureModel.decide(input)
    }
    await expect(runtime(db(), undefined, model).start('input', 'autonomous')).rejects.toThrow(
      'OUTPUT_MISMATCH'
    )
  })
  it('bounds repeated tool decisions and rejects restarts of the same task', async () => {
    const model: C0ModelPort = {
      decide: async () => ({ kind: 'tool', targetNodeId: 'processor', input: { text: 'input' } })
    }
    const execute = vi.fn(async () => ({ text: 'RESULT' }))
    const runner = runtime(db(), execute, model, 2)
    await expect(runner.start('input', 'autonomous')).rejects.toThrow('BUDGET_EXHAUSTED')
    expect(execute).toHaveBeenCalledTimes(2)
    await expect(runner.start('input', 'autonomous')).rejects.toThrow('TASK_ALREADY_EXISTS')
  })
})

describe('C0 model protocol and diagnostics', () => {
  const privateText = 'PRIVATE_PROMPT_c0_secret'
  function sdkModel(
    name = 'execute_node',
    args: unknown = { targetNodeId: 'processor', input: { text: privateText } }
  ) {
    const requests: unknown[] = []
    const model = createOpenAICompatible({
      name: 'fixture',
      baseURL: 'https://example.invalid/v1',
      fetch: async (_, init) => {
        requests.push(JSON.parse(String(init?.body)))
        const chunks = [
          {
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
                      function: { name, arguments: JSON.stringify(args) }
                    }
                  ]
                },
                finish_reason: null
              }
            ]
          },
          {
            id: 'fixture',
            object: 'chat.completion.chunk',
            created: 1,
            model: 'fixture',
            choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }]
          }
        ]
        return new Response(
          chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join('') + 'data: [DONE]\n\n',
          { headers: { 'content-type': 'text/event-stream' } }
        )
      }
    }).chatModel('fixture')
    return {
      port: new C0SdkModel(model, {
        projectId: 'p',
        nodeId: 'agent',
        taskId: 'task',
        traceId: 'trace'
      }),
      requests
    }
  }
  it('consumes real SDK structured tool calls in a single request and logs no bodies', async () => {
    const events: DiagnosticsEventInput[] = []
    setGatewayEventSink({
      emit: (event) => {
        if (event) events.push(event)
      }
    })
    const { port, requests } = sdkModel()
    expect(
      await port.decide({ text: privateText, outputs: [], mode: 'autonomous', humanAccepted: null })
    ).toEqual({ kind: 'tool', targetNodeId: 'processor', input: { text: privateText } })
    expect(requests).toHaveLength(1)
    expect(events.map((event) => event.event)).toEqual([
      'model.request.started',
      'model.request.first_chunk',
      'model.request.completed'
    ])
    expect(JSON.stringify(events)).not.toContain(privateText)
  })
  it('rejects undeclared model tools rather than guessing from text', async () => {
    const { port } = sdkModel('hidden_tool')
    await expect(
      port.decide({ text: privateText, outputs: [], mode: 'autonomous', humanAccepted: null })
    ).rejects.toThrow('MODEL_STEP_FAILED')
  })
  it('does not change command/checkpoint results when the diagnostic sink throws', async () => {
    const telemetry = createC0Telemetry(
      {
        emit: () => {
          throw new Error(privateText)
        }
      },
      { projectId: 'p', traceId: 'trace' }
    )
    const database = db()
    const runner = createC0Runtime({
      scope,
      saver: new C0SqliteSaver(database, telemetry),
      ledger: new C0CommandLedger(database, telemetry),
      model: fixtureModel,
      transport: { execute: async () => ({ text: 'RESULT' }) },
      telemetry
    })
    expect((await runner.start('private fixture', 'autonomous')).status).toBe('completed')
  })
})
