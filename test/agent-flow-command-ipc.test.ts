import { afterEach, describe, expect, it, vi } from 'vitest'
import Database from 'better-sqlite3'
import type { ProjectFile, CanvasNode } from '../src/shared/types'
import { PROCESSOR_PORTS } from '../src/shared/agent-flow/processor-contract'
import { projectSemanticRevision } from '../src/main/agent-flow/command-intent'
import { FlowAssetStore } from '../src/main/agent-flow/asset-store'
import { migrateDatabase } from '../src/main/store/db-migrations'
import { registerFlowCommandsIpc } from '../src/main/ipc/flow-commands.ipc'
import { registerFlowAgentsIpc } from '../src/main/ipc/flow-agents.ipc'
import { registerFlowAssetsIpc } from '../src/main/ipc/flow-assets.ipc'
import { setGatewayEventSink } from '../src/main/diagnostics/gateway-events'
import { SqliteModelHost } from '../src/main/model-host/sqlite-model-host'
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
  },
  // Production binds renderer-loss recovery to every window creation; tests
  // only exercise registered handlers, so app event wiring is a no-op here.
  app: { on: (): void => {} }
}))
vi.mock('../src/main/store/db', () => ({ getDb: () => state.db }))
vi.mock('../src/main/store/projects.repo', () => ({
  openProject: (id: string) => (state.file?.meta.id === id ? state.file : null),
  // The publication wait stat-gates on this path; a missing file falls back to
  // openProject on every tick, matching the pre-gate behavior in tests.
  projectJsonPath: (id: string) => `projects/${id}/project.json`
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
  return { db, file, window, contents, event, call, ledger, command, events }
}
describe('desktop command IPC lifecycle and recovery', () => {
  it.each(['submit', 'list', 'read'] as const)('SEC-05 trusted-window asset %s cannot resolve an unknown project', async (operation) => {
    const f = fixture()
    registerFlowAssetsIpc(() => f.window as never)
    const original = f.db.prepare('SELECT version_id,digest FROM flow_asset_versions ORDER BY version_id').all()
    const version = original[0] as { version_id: string }
    const input = operation === 'read' ? { projectId: 'foreign-project', versionId: version.version_id }
      : operation === 'list' ? { projectId: 'foreign-project', nodeId: 'shape:source', portId: 'out-text' }
      : { projectId: 'foreign-project', nodeId: 'shape:source', portId: 'out-text', submissionId: 'foreign-submit', expectedGraphVersion: 1, traceId: 'trace', spanId: 'span' }
    expect(await state.handlers.get(IPC.flowAssets[operation])!(f.event, input)).toMatchObject({ ok: false, error: { code: 'ASSET_PROJECT_MISSING' } })
    expect(f.db.prepare('SELECT version_id,digest FROM flow_asset_versions ORDER BY version_id').all()).toEqual(original)
    expect(f.contents.send).not.toHaveBeenCalled()
    expect(JSON.stringify(f.events)).not.toContain('private-fixture')
  })
  it.each(['run', 'build', 'review', 'inspect', 'stop', 'pause', 'catalog', 'collaboration', 'cooperate'] as const)('SEC-01 blocks foreign sources on Agent %s before task effects', async (operation) => {
    const f = fixture()
    registerFlowAgentsIpc(() => f.window as never, { ledger: f.ledger, isActive: () => true, deliver: async () => { throw new Error('must not dispatch') } })
    for (const source of [{ sender: {}, senderFrame: {} }, { sender: f.contents, senderFrame: {} }]) {
      const result = await state.handlers.get(IPC.flowAgents[operation])!(source, { projectId: 'p', nodeId: 'shape:agent' })
      expect(result).toMatchObject({ ok: false, error: { code: 'FLOW_SENDER_REJECTED' } })
    }
    expect(f.db.prepare('SELECT COUNT(*) AS n FROM flow_agent_tasks').get()).toEqual({ n: 0 })
    expect(f.db.prepare('SELECT COUNT(*) AS n FROM flow_commands').get()).toEqual({ n: 0 })
    expect(f.contents.send).not.toHaveBeenCalled()
  })
  it('CFG-03 rejects an unverified text-only model before creating an Agent task or model request', async () => {
    const f = fixture()
    const snapshot = f.file.tldrawSnapshot as {
      store: Record<string, { props: { config: string } }>
    }
    const config = JSON.parse(snapshot.store['shape:agent'].props.config) as Record<string, unknown>
    config.modelDefinitionId = 'text-only-model'
    snapshot.store['shape:agent'].props.config = JSON.stringify(config)

    const modelHost = new SqliteModelHost(f.db)
    modelHost.saveConnection({
      id: 'test-connection',
      name: 'local text-only fixture',
      protocol: 'openai-compatible',
      baseUrl: 'http://127.0.0.1:5200/v1'
    })
    modelHost.saveModel({
      id: 'text-only-model',
      connectionId: 'test-connection',
      modelId: 'text-only',
      name: 'text-only',
      capabilities: [{
        operation: 'text.generate',
        asynchronous: false,
        streaming: true,
        acceptedAssetKinds: [],
        producedAssetKinds: [],
        controls: {}
      }]
    })
    registerFlowAgentsIpc(() => f.window as never, {
      ledger: f.ledger,
      isActive: () => true,
      deliver: async () => { throw new Error('must not dispatch') }
    })
    const fetchSpy = vi.fn(async () => new Response('{}', { status: 200 }))
    vi.stubGlobal('fetch', fetchSpy)
    f.events.length = 0

    const result = await state.handlers.get(IPC.flowAgents.run)!(f.event, {
      projectId: 'p',
      nodeId: 'shape:agent',
      action: 'start',
      requestId: 'request-cfg03',
      traceId: 'trace-cfg03',
      spanId: 'span-cfg03'
    }) as { ok: boolean; error?: { code: string } }

    expect(result).toMatchObject({ ok: false, error: { code: 'AGENT_MODEL_TOOL_UNVERIFIED' } })
    expect(f.db.prepare('SELECT COUNT(*) AS n FROM flow_agent_tasks').get()).toEqual({ n: 0 })
    expect(f.db.prepare('SELECT COUNT(*) AS n FROM flow_commands').get()).toEqual({ n: 0 })
    expect(f.file.meta.graphVersion).toBe(1)
    expect(fetchSpy).not.toHaveBeenCalled()
    expect(f.events.some((event) => event.event.startsWith('workflow.'))).toBe(false)
    expect(f.events.some((event) => event.event.startsWith('model.request.'))).toBe(false)
    expect(f.events.some((event) => event.event === 'node.started')).toBe(false)
  })
  it.each(['submit', 'list', 'read'] as const)('SEC-01 blocks foreign sources on asset %s before version effects', async (operation) => {
    const f = fixture()
    registerFlowAssetsIpc(() => f.window as never)
    const before = f.db.prepare('SELECT COUNT(*) AS n FROM flow_asset_versions').get()
    for (const source of [{ sender: {}, senderFrame: {} }, { sender: f.contents, senderFrame: {} }]) {
      expect(await state.handlers.get(IPC.flowAssets[operation])!(source, { projectId: 'p' })).toMatchObject({ ok: false, error: { code: 'ASSET_SENDER_REJECTED' } })
    }
    expect(f.db.prepare('SELECT COUNT(*) AS n FROM flow_asset_versions').get()).toEqual(before)
    expect(f.contents.send).not.toHaveBeenCalled()
  })
  it.each(['prepare', 'dispatch', 'check', 'commit', 'lookup', 'unknown', 'abort', 'availability', 'attach', 'detach'] as const)('SEC-01 rejects foreign window and child-frame calls to %s without side effects', (operation) => {
    const f = fixture()
    const input = ['prepare', 'dispatch'].includes(operation) ? f.command
      : ['check', 'unknown', 'abort'].includes(operation) ? { projectId: 'p', commandId: 'cmd', leaseId: 'lease' }
      : operation === 'availability' ? { projectId: 'p', nodeId: 'shape:target' }
      : ['attach', 'detach'].includes(operation) ? { projectId: 'p' }
      : { projectId: 'p', commandId: 'cmd' }
    for (const source of [{ sender: {}, senderFrame: {} }, { sender: f.contents, senderFrame: {} }]) {
      expect(f.call(IPC.flowCommands[operation], input, source)).toMatchObject({ ok: false, error: { code: 'FLOW_SENDER_REJECTED' } })
    }
    expect(f.db.prepare('SELECT COUNT(*) AS n FROM flow_commands').get()).toEqual({ n: 0 })
    expect(f.contents.send).not.toHaveBeenCalled()
    const starts = f.events.filter(event => event.event === 'command.operation.started')
    const ends = f.events.filter(event => event.event === 'command.operation.failed')
    expect(starts).toHaveLength(2)
    for (const start of starts) expect(ends.filter(end => end.traceId === start.traceId && end.spanId === start.spanId)).toHaveLength(1)
    // Unauthorized attach/detach must not change the active project's owner.
    expect(f.call(IPC.flowCommands.availability, { projectId: 'p', nodeId: 'shape:target' }).ok).toBe(true)
  })
  it.each(['long-id', 'unknown-key', 'prototype-key', 'duplicate-port', 'too-many-refs', 'self-target'])('SEC-02 rejects %s at command IPC without persistence or dispatch', (variant) => {
    const f = fixture()
    let command: unknown = f.command
    if (variant === 'long-id') command = { ...f.command, commandId: 'x'.repeat(129) }
    if (variant === 'unknown-key') command = { ...f.command, executeShell: true }
    if (variant === 'prototype-key') command = JSON.parse(JSON.stringify(f.command).slice(0, -1) + ',"__proto__":{"polluted":true}}')
    if (variant === 'duplicate-port') command = { ...f.command, inputs: [f.command.inputs[0], f.command.inputs[0]] }
    if (variant === 'too-many-refs') command = { ...f.command, inputs: [{ ...f.command.inputs[0], assets: Array(129).fill(f.command.inputs[0].assets[0]) }] }
    if (variant === 'self-target') command = { ...f.command, targetNodeId: f.command.agentNodeId }
    const result = f.call(IPC.flowCommands.dispatch, command)
    if (variant === 'prototype-key') {
      // Confirm the malformed value carries an own key so the IPC boundary is
      // tested against the raw object, not merely inherited prototype state.
      expect(Object.prototype.hasOwnProperty.call(command, '__proto__')).toBe(true)
      expect(({} as Record<string, unknown>).polluted).toBeUndefined()
      expect(result).toMatchObject({ ok: false, error: { code: 'FLOW_INPUT_INVALID' } })
      expect(JSON.stringify(result)).not.toContain('polluted')
    }
    expect(result.ok).toBe(false)
    expect(f.db.prepare('SELECT COUNT(*) AS n FROM flow_commands').get()).toEqual({ n: 0 })
    expect(f.contents.send).not.toHaveBeenCalled()
    expect(({} as Record<string, unknown>).polluted).toBeUndefined()
    expect(JSON.stringify(f.events)).not.toContain('executeShell')
    if (variant === 'prototype-key') {
      expect(JSON.stringify(f.events)).not.toContain('__proto__')
      expect(JSON.stringify(f.events)).not.toContain('polluted')
    }
  })
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
