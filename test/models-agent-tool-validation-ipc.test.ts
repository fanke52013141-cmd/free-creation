import { afterEach, describe, expect, it, vi } from 'vitest'
import Database from 'better-sqlite3'
import { createOpenAICompatible } from '@ai-sdk/openai-compatible'
import type { ModelRuntime } from '@free-creation/model-runtime'
import { registerModelIpc } from '../src/main/ipc/models.ipc'
import { migrateDatabase } from '../src/main/store/db-migrations'
import { SqliteModelHost } from '../src/main/model-host/sqlite-model-host'
import { setGatewayEventSink } from '../src/main/diagnostics/gateway-events'
import { IPC } from '../src/shared/contracts'
import type { DiagnosticsEventInput } from '../src/shared/observability'

const state = vi.hoisted(() => ({
  db: null as Database.Database | null,
  handlers: new Map<string, (_event: unknown, input: unknown) => unknown>(),
  model: null as unknown
}))

vi.mock('electron', () => ({
  ipcMain: {
    handle: (name: string, run: (_event: unknown, input: unknown) => unknown) =>
      state.handlers.set(name, run)
  }
}))
vi.mock('../src/main/store/db', () => ({ getDb: () => state.db }))
vi.mock('../src/main/gateway/factory', () => ({ createCatalogChatModel: () => state.model }))

function fixture(options: { wrongReceipt?: boolean } = {}) {
  const requests: Array<Record<string, unknown>> = []
  const model = createOpenAICompatible({
    name: 'agent-tool-validation-fixture',
    baseURL: 'http://127.0.0.1:5200/v1',
    apiKey: 'fixture-key',
    fetch: async (_url, init) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>
      requests.push(body)
      const toolName = (
        (body.tool_choice as { function: { name: string } }).function.name
      )
      const receipt = toolName === 'probe_done' && !options.wrongReceipt
      const chunks = [
        {
          id: 'fixture',
          object: 'chat.completion.chunk',
          created: 1,
          model: 'fixture',
          choices: [{
            index: 0,
            delta: {
              tool_calls: [{
                index: 0,
                id: `call-${requests.length}`,
                type: 'function',
                function: {
                  name: toolName,
                  arguments: JSON.stringify({
                    marker: receipt ? 'receipt-only' : 'probe-ok',
                    count: receipt ? 13 : 7
                  })
                }
              }]
            },
            finish_reason: null
          }]
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
  return { model, requests }
}

function setup() {
  const db = new Database(':memory:')
  state.db = db
  migrateDatabase(db)
  const host = new SqliteModelHost(db)
  host.saveConnection({
    id: 'connection-1',
    name: 'loopback fixture',
    protocol: 'openai-compatible',
    baseUrl: 'http://127.0.0.1:5200/v1'
  })
  host.saveModel({
    id: 'model-1',
    connectionId: 'connection-1',
    name: 'tool fixture',
    modelId: 'fixture',
    capabilities: [{
      operation: 'text.generate',
      asynchronous: false,
      streaming: true,
      acceptedAssetKinds: [],
      producedAssetKinds: [],
      controls: {}
    }]
  })
  registerModelIpc(host, {} as ModelRuntime)
  const events: DiagnosticsEventInput[] = []
  setGatewayEventSink({ emit: (event) => { if (event) events.push(event) } })
  return { db, host, events }
}

afterEach(() => {
  state.db?.close()
  state.db = null
  state.model = null
  state.handlers.clear()
  setGatewayEventSink(null)
})

describe('Agent tool-call validation IPC', () => {
  it('requires explicit cost confirmation and sends no request without it', async () => {
    const { host, events } = setup()
    const mock = fixture()
    state.model = mock.model
    const result = await state.handlers.get(IPC.models.validateAgentToolCalling)!(null, {
      connectionId: 'connection-1',
      modelDefinitionId: 'model-1',
      allowCost: false
    }) as { ok: boolean }

    expect(result.ok).toBe(false)
    expect(mock.requests).toHaveLength(0)
    expect(host.listModels()[0].agentToolCallingValidation?.status).not.toBe('verified')
    expect(events.map((event) => event.event)).toEqual([
      'configuration.validation_started',
      'configuration.validation_failed'
    ])
    expect(events.some((event) => event.event.startsWith('model.request.'))).toBe(false)
  })

  it('persists verification after exactly two synthetic tool requests and logs their lifecycle', async () => {
    const { host, events } = setup()
    const mock = fixture()
    state.model = mock.model
    const result = await state.handlers.get(IPC.models.validateAgentToolCalling)!(null, {
      connectionId: 'connection-1',
      modelDefinitionId: 'model-1',
      allowCost: true
    }) as { ok: boolean; data?: { status: string } }

    expect(result).toMatchObject({ ok: true, data: { status: 'verified' } })
    expect(mock.requests).toHaveLength(2)
    expect(host.listModels()[0].agentToolCallingValidation?.status).toBe('verified')
    expect(events.filter((event) => event.event === 'model.request.started')).toHaveLength(2)
    expect(events.filter((event) => event.event === 'model.request.completed')).toHaveLength(2)
    expect(events.map((event) => event.event)).toContain('configuration.validation_completed')
    expect(JSON.stringify(events)).not.toContain('fixture-key')
    expect(JSON.stringify(events)).not.toContain('probe-ok')
  })

  it('does not certify a model that fails the tool-result round trip', async () => {
    const { host, events } = setup()
    const mock = fixture({ wrongReceipt: true })
    state.model = mock.model
    const result = await state.handlers.get(IPC.models.validateAgentToolCalling)!(null, {
      connectionId: 'connection-1',
      modelDefinitionId: 'model-1',
      allowCost: true
    }) as { ok: boolean; data?: { status: string } }

    expect(result).toMatchObject({ ok: true, data: { status: 'failed' } })
    expect(mock.requests).toHaveLength(2)
    expect(host.listModels()[0].agentToolCallingValidation?.status).toBe('failed')
    expect(events.filter((event) => event.event === 'model.request.completed')).toHaveLength(1)
    expect(events.filter((event) => event.event === 'model.request.failed')).toHaveLength(1)
  })
})
