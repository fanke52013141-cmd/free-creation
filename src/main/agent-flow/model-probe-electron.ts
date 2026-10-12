import { app } from 'electron'
import Database from 'better-sqlite3'
import { basename, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { writeFile } from 'node:fs/promises'
import { SqliteModelHost } from '../model-host/sqlite-model-host'
import { createCatalogChatModel } from '../gateway/factory'
import { probeAgentModel } from './model-probe'
import { initDiagnosticsService } from '../diagnostics/service'
import { emitGatewayEvent, setGatewayEventSink } from '../diagnostics/gateway-events'

// Opt-in diagnostic entry, never imported by the desktop application.
const directory = process.argv.find((arg) => arg.startsWith('--probe-dir='))?.slice(12)
const targetId = process.argv.find((arg) => arg.startsWith('--target-id='))?.slice(12)
const allowCost = process.argv.includes('--allow-cost')
const source = join(app.getPath('appData'), 'canvas-studio', 'data', 'app.db')
if (
  !directory ||
  resolve(directory, '..') !== resolve(tmpdir()) ||
  !basename(directory).startsWith('canvas-agent-probe-')
) {
  app.exit(2)
} else {
  app.setPath('userData', directory)
  void app.whenReady().then(async () => {
    let db: Database.Database | undefined
    let diagnostics: Awaited<ReturnType<typeof initDiagnosticsService>> | undefined
    let code = 0
    let phase = 'diagnostics'
    const context = {
      traceId: `agent-probe-${Date.now()}`,
      spanId: 'agent-probe-setup',
      projectId: 'agent-probe-fixture'
    }
    try {
      diagnostics = await initDiagnosticsService({ dataDir: directory, disableTimers: true })
      setGatewayEventSink({
        emit: (event) => {
          if (event) diagnostics?.emit(event)
        }
      })
      emitGatewayEvent('agent.probe.started', 'Agent 能力探测准备', context, { phase })
      phase = 'catalog-open'
      const ephemeral = process.env.CANVAS_AGENT_PROBE_KEY && process.env.CANVAS_AGENT_PROBE_MODEL
      if (!ephemeral) db = new Database(source, { readonly: true, fileMustExist: true })
      const host = db ? new SqliteModelHost(db) : undefined
      phase = 'catalog-target'
      const eligible = (host?.listModels() ?? []).filter(
        (model) =>
          model.enabled && model.capabilities.some((cap) => cap.operation === 'text.generate')
      )
      const binding = host?.listBindings().find((item) => item.target.operation === 'text.generate')
      const definition = ephemeral
        ? {
            id: 'ephemeral-doubao',
            connectionId: 'ephemeral-ark',
            modelId: process.env.CANVAS_AGENT_PROBE_MODEL!
          }
        : targetId
          ? eligible.find((model) => model.id === targetId)
          : (eligible.find((model) => model.id === binding?.modelDefinitionId) ?? eligible[0])
      if (!definition) throw new Error('PROBE_TARGET_UNAVAILABLE')
      const connection = ephemeral
        ? {
            id: 'ephemeral-ark',
            enabled: true,
            protocol: 'openai-compatible',
            baseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
            headers: {},
            updatedAt: undefined
          }
        : await host!.getConnection(definition.connectionId)
      phase = 'protocol'
      if (
        !connection?.enabled ||
        !['openai', 'openai-compatible', 'openrouter', 'toapis'].includes(connection.protocol)
      )
        throw new Error('PROBE_PROTOCOL_UNSUPPORTED')
      const url = new URL(connection.baseUrl)
      phase = 'cost-guard'
      const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
      if (!local && !allowCost) throw new Error('PROBE_COST_OPT_IN_REQUIRED')
      const secret = ephemeral
        ? process.env.CANVAS_AGENT_PROBE_KEY
        : await host!.readSecret(connection.id)
      phase = 'credentials'
      if (!secret && !local) throw new Error('PROBE_KEY_UNAVAILABLE')
      const model = createCatalogChatModel({
        connectionId: connection.id,
        baseURL: connection.baseUrl,
        apiKey: secret ?? undefined,
        headers: connection.headers,
        modelId: definition.modelId
      })
      phase = 'request'
      const report = await probeAgentModel(
        model,
        {
          traceId: context.traceId,
          spanId: 'agent-model-probe-request',
          projectId: 'agent-probe-fixture'
        },
        undefined,
        { providerId: connection.id, modelId: definition.id }
      )
      phase = 'report-save'
      await writeFile(
        join(directory, 'report.json'),
        JSON.stringify(
          {
            checkedAt: new Date().toISOString(),
            traceId: context.traceId,
            connectionId: connection.id,
            modelDefinitionId: definition.id,
            connectionUpdatedAt: connection.updatedAt,
            adapter: 'openai-compatible-chat',
            sourceReadOnly: true,
            ephemeralCredentials: Boolean(ephemeral),
            ...report
          },
          null,
          2
        )
      )
      if (report.toolResultRoundTrip !== 'verified') code = 1
      emitGatewayEvent(
        code ? 'agent.probe.failed' : 'agent.probe.completed',
        'Agent 能力探测结束',
        context,
        { phase, status: code ? 'failed' : 'success' }
      )
    } catch {
      emitGatewayEvent('agent.probe.failed', 'Agent 能力探测失败', context, {
        phase,
        status: 'failed',
        error: new Error('PROBE_SETUP_FAILED')
      })
      // No raw provider/DB exception, credential, endpoint or message is persisted.
      await writeFile(
        join(directory, 'report.json'),
        JSON.stringify({ status: 'setup-failed', code: 'PROBE_SETUP_FAILED', phase })
      )
      code = 1
    } finally {
      setGatewayEventSink(null)
      db?.close()
      await diagnostics?.flushOnQuit()
      app.exit(code)
    }
  })
}
