import { afterEach, describe, expect, it, vi } from 'vitest'
import Database from 'better-sqlite3'
import type { ProjectFile, CanvasNode } from '../src/shared/types'
import { PROCESSOR_PORTS } from '../src/shared/agent-flow/processor-contract'
import { projectSemanticRevision } from '../src/main/agent-flow/command-intent'
import { FlowAssetStore } from '../src/main/agent-flow/asset-store'
import { migrateDatabase } from '../src/main/store/db-migrations'
import { registerFlowCommandsIpc } from '../src/main/ipc/flow-commands.ipc'
import { setGatewayEventSink } from '../src/main/diagnostics/gateway-events'
import { IPC } from '../src/shared/contracts'
import type { DiagnosticsEventInput } from '../src/shared/observability'

const state = vi.hoisted(() => ({
  db: null as Database.Database | null,
  file: null as ProjectFile | null,
  handlers: new Map<string, (event: unknown, input: unknown) => unknown>()
}))
vi.mock('electron', () => ({
  ipcMain: {
    handle: (name: string, run: (event: unknown, input: unknown) => unknown) =>
      state.handlers.set(name, run)
  }
}))
vi.mock('../src/main/store/db', () => ({ getDb: () => state.db }))
vi.mock('../src/main/store/projects.repo', () => ({
  openProject: (id: string) => (state.file?.meta.id === id ? state.file : null)
}))
afterEach(() => {
  vi.clearAllTimers()
  vi.useRealTimers()
  state.db?.close()
  state.db = null
  setGatewayEventSink(null)
  state.handlers.clear()
})
function fixture() {
  vi.useFakeTimers()
  const db = new Database(':memory:')
  state.db = db
  migrateDatabase(db)
  db.prepare('INSERT INTO projects(id,name,created_at,updated_at) VALUES (?, ?, 0, 0)').run(
    'p',
    'fixture'
  )
  const node = (id: string, type: string, config = '', text = '') => ({
    id,
    type: 'node-card',
    props: {
      nodeType: type,
      config,
      text,
      title: type,
      mediaId: '',
      mediaPath: '',
      mediaMime: '',
      exec: 'idle',
      w: 340,
      h: 260
    },
    meta: {}
  })
  const shapes = [
    node('shape:source', 'text', '', 'private-fixture-body'),
    node('shape:target', 'processor'),
    node(
      'shape:agent',
      'agent',
      JSON.stringify({
        schemaVersion: 1,
        role: 'specialist',
        interactionMode: 'autonomous',
        skills: [],
        tools: [],
        allowedNodeIds: ['shape:target'],
        maxSteps: 4,
        relations: []
      }),
      'private-fixture-goal'
    )
  ]
  const file: ProjectFile = {
    version: 1,
    meta: { id: 'p', name: 'fixture', graphVersion: 1, createdAt: 0, updatedAt: 0 },
    groups: [],
    edges: [],
    nodes: shapes.map((shape): CanvasNode => ({
      id: shape.id,
      type: shape.props.nodeType as CanvasNode['type'],
      contractVersion: 1,
      title: shape.props.title,
      x: 0,
      y: 0,
      w: 340,
      h: 260,
      params: {},
      content: { kind: 'empty' },
      ports:
        shape.props.nodeType === 'processor' ? [...PROCESSOR_PORTS.in, ...PROCESSOR_PORTS.out] : [],
      exec: { status: 'idle' },
      meta: { source: 'input', createdAt: 0 }
    })),
    tldrawSnapshot: { store: Object.fromEntries(shapes.map((shape) => [shape.id, shape])) }
  }
  state.file = file
  const assets = new FlowAssetStore(db, (id) => (id === 'p' ? file : null))
  const asset = assets.submit({
    projectId: 'p',
    nodeId: 'shape:source',
    portId: 'out-text',
    submissionId: 'source',
    expectedGraphVersion: 1,
    traceId: 'trace',
    spanId: 'span'
  })
  const events: DiagnosticsEventInput[] = []
  setGatewayEventSink({
    emit: (event) => {
      if (event) events.push(event)
    }
  })
  const contents = { mainFrame: {}, on: vi.fn(), send: vi.fn() }
  const window = { isDestroyed: () => false, webContents: contents }
  const ledger = registerFlowCommandsIpc(() => window as never)
  const event = { sender: contents, senderFrame: contents.mainFrame }
  const call = (channel: string, input: unknown, sender: unknown = event) =>
    state.handlers.get(channel)!(sender, input) as {
      ok: boolean
      data?: { state?: string }
      error?: { code: string }
    }
  const command = {
    schemaVersion: 1,
    kind: 'node.execute',
    commandId: 'cmd',
    projectId: 'p',
    taskId: 'task',
    agentNodeId: 'shape:agent',
    targetNodeId: 'shape:target',
    expectedSemanticRevision: projectSemanticRevision(file),
    contractVersion: 1,
    inputs: [{ targetPortId: 'in-value', assets: [asset.ref] }],
    traceId: 'trace-command',
    spanId: 'span-command'
  }
  call(IPC.flowCommands.attach, { projectId: 'p' })
  events.length = 0
  return { db, window, contents, event, call, ledger, command, events }
}
describe('desktop command IPC lifecycle and recovery', () => {
  it('rejects inactive projects before reserving or dispatching a command', () => {
    const f = fixture()
    f.call(IPC.flowCommands.detach, { projectId: 'p' })
    expect(f.call(IPC.flowCommands.dispatch, f.command).error?.code).toBe('FLOW_PROJECT_INACTIVE')
    expect(f.db.prepare('SELECT COUNT(*) n FROM flow_commands').get()).toEqual({ n: 0 })
    expect(f.contents.send).not.toHaveBeenCalled()
  })
  it('rejects foreign windows and child frames with one terminal and no private body', () => {
    const f = fixture(),
      input = { projectId: 'p', commandId: 'cmd' }
    expect(
      f.call(IPC.flowCommands.lookup, input, { sender: {}, senderFrame: {} }).error?.code
    ).toBe('FLOW_SENDER_REJECTED')
    expect(
      f.call(IPC.flowCommands.lookup, input, { sender: f.contents, senderFrame: {} }).error?.code
    ).toBe('FLOW_SENDER_REJECTED')
    const starts = f.events.filter((event) => event.event === 'command.operation.started')
    const ends = f.events.filter((event) => event.event === 'command.operation.failed')
    expect(starts).toHaveLength(2)
    expect(ends).toHaveLength(2)
    for (const start of starts)
      expect(
        ends.filter((end) => end.spanId === start.spanId && end.traceId === start.traceId)
      ).toHaveLength(1)
    expect(JSON.stringify(f.events)).not.toContain('private-fixture')
  })
  it('persists before dispatch, does not redispatch duplicates, and expires pending to unknown', () => {
    const f = fixture()
    expect(f.call(IPC.flowCommands.dispatch, f.command).data?.state).toBe('pending')
    expect(f.ledger.lookup({ projectId: 'p', commandId: 'cmd' }).state).toBe('pending')
    f.call(IPC.flowCommands.dispatch, { ...f.command, traceId: 'retry' })
    expect(f.contents.send).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(60000)
    expect(f.ledger.lookup({ projectId: 'p', commandId: 'cmd' }).state).toBe('unknown')
    expect(
      f.call(IPC.flowCommands.availability, { projectId: 'p', nodeId: 'shape:target' }).error?.code
    ).toBe('FLOW_NODE_OCCUPIED')
    expect(
      f.events.some(
        (event) => event.event === 'command.recovered' && event.attributes?.phase === 'timeout'
      )
    ).toBe(true)
  })
  it('keeps business reservation and response intact when the diagnostic sink throws', () => {
    const f = fixture()
    setGatewayEventSink({
      emit: () => {
        throw new Error('fake-secret-key')
      }
    })
    expect(f.call(IPC.flowCommands.dispatch, f.command).ok).toBe(true)
    expect(f.ledger.lookup({ projectId: 'p', commandId: 'cmd' }).state).toBe('pending')
    expect(f.contents.send).toHaveBeenCalledTimes(1)
  })
  it('logs a startup recovery failure without replay or exposing the database error', () => {
    const f = fixture()
    f.call(IPC.flowCommands.prepare, f.command)
    f.db.exec(
      "CREATE TRIGGER fail_recovery BEFORE UPDATE ON flow_commands WHEN NEW.state = 'unknown' BEGIN SELECT RAISE(ABORT, 'fake-secret-key'); END"
    )
    registerFlowCommandsIpc(() => f.window as never)
    f.call(IPC.flowCommands.attach, { projectId: 'p' })
    expect(
      f.events.some(
        (event) =>
          event.event === 'command.recovery_failed' && event.attributes?.phase === 'startup'
      )
    ).toBe(true)
    expect(f.call(IPC.flowCommands.dispatch, f.command).data?.state).toBe('pending')
    expect(f.contents.send).not.toHaveBeenCalled()
    expect(JSON.stringify(f.events)).not.toContain('fake-secret-key')
  })
})
