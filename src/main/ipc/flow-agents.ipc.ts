import { ipcMain, type BrowserWindow } from 'electron'
import { IPC, type IpcEnvelope } from '../../shared/contracts'
import {
  FlowAgentQuerySchema,
  FlowAgentCollaborationSchema
} from '../../shared/agent-flow/desktop-tasks'
import { AgentRuntimeError } from '../../shared/agent-flow/runtime-contracts'
import { flowAgentFailureMessage } from '../../shared/agent-flow/failure-messages'
import { FlowCommandError } from '../../shared/agent-flow/commands'
import { FlowAssetError } from '../../shared/agent-flow/assets'
import { FlowAgentDesktopHost } from '../agent-flow/desktop-host'
import type { FlowCommandDesktop } from './flow-commands.ipc'
import { getDb } from '../store/db'
import { openProject } from '../store/projects.repo'
import { SqliteModelHost } from '../model-host/sqlite-model-host'
import { createCatalogChatModel } from '../gateway/factory'
import { AgentSdkModel } from '../agent-flow/runtime-model'
import { FlowAssetStore } from '../agent-flow/asset-store'
import { probeAgentModel } from '../agent-flow/model-probe'
import { emitGatewayEvent } from '../diagnostics/gateway-events'
import { newTraceId, newSpanId } from '../../shared/observability'

export function registerFlowAgentsIpc(
  window: () => BrowserWindow | null,
  desktop: FlowCommandDesktop
): FlowAgentDesktopHost {
  process.env.LANGSMITH_TRACING = 'false'
  process.env.LANGCHAIN_TRACING_V2 = 'false'
  const catalog = new SqliteModelHost(getDb())
  const assets = new FlowAssetStore(getDb(), openProject)
  const verified = new Set<string>()
  const inspectFailures = new Map<string, number>()
  const host = new FlowAgentDesktopHost(getDb(), openProject, desktop, async (snapshot, signal) => {
    const definition = await catalog.getModel(snapshot.config.modelDefinitionId ?? '')
    if (
      !definition?.enabled ||
      !definition.capabilities.some((capability) => capability.operation === 'text.generate')
    )
      throw new AgentRuntimeError('AGENT_MODEL_UNAVAILABLE', 'model-capability')
    const connection = await catalog.getConnection(definition.connectionId)
    if (
      !connection?.enabled ||
      !['openai', 'openai-compatible', 'openrouter', 'toapis'].includes(connection.protocol)
    )
      throw new AgentRuntimeError('AGENT_MODEL_PROTOCOL', 'model-capability')
    const secret = await catalog.readSecret(connection.id)
    const local = ['localhost', '127.0.0.1', '[::1]'].includes(new URL(connection.baseUrl).hostname)
    if (!secret && !local) throw new AgentRuntimeError('AGENT_MODEL_KEY_UNAVAILABLE', 'credentials')
    const model = createCatalogChatModel({
      connectionId: connection.id,
      baseURL: connection.baseUrl,
      apiKey: secret ?? undefined,
      headers: connection.headers,
      modelId: definition.modelId
    })
    const context = {
      traceId: snapshot.traceId,
      spanId: snapshot.spanId,
      projectId: snapshot.projectId,
      nodeId: snapshot.agentNodeId,
      taskId: snapshot.taskId
    }
    const signature = JSON.stringify([definition, connection.updatedAt, connection.baseUrl])
    if (!verified.has(signature)) {
      const report = await probeAgentModel(model, context, signal, {
        providerId: connection.id,
        modelId: definition.id
      })
      if (report.structuredToolCall !== 'verified' || report.toolResultRoundTrip !== 'verified')
        throw new AgentRuntimeError('AGENT_MODEL_TOOL_UNVERIFIED', 'model-capability')
      verified.add(signature)
    }
    return new AgentSdkModel(model, snapshot.projectId, assets, context)
  })
  for (const phase of [
    'run',
    'inspect',
    'stop',
    'catalog',
    'collaboration',
    'cooperate'
  ] as const) {
    ipcMain.handle(IPC.flowAgents[phase], async (event, raw): Promise<IpcEnvelope<unknown>> => {
      const context = { traceId: newTraceId(), spanId: newSpanId() }
      const query = FlowAgentQuerySchema.safeParse(
        ['run', 'cooperate'].includes(phase) && raw && typeof raw === 'object'
          ? { projectId: raw.projectId, nodeId: raw.nodeId }
          : raw
      )
      if (query.success)
        Object.assign(context, { projectId: query.data.projectId, nodeId: query.data.nodeId })
      const collaboration =
        phase === 'cooperate' ? FlowAgentCollaborationSchema.safeParse(raw) : null
      const action = collaboration?.success ? collaboration.data.action : undefined
      if (collaboration?.success) Object.assign(context, { taskId: collaboration.data.taskId })
      const log = phase !== 'inspect'
      if (log)
        emitGatewayEvent('agent.desktop.started', '画布 Agent 操作开始', context, {
          attributes: { phase, action }
        })
      try {
        const active = window()
        if (
          !active ||
          active.isDestroyed() ||
          event.sender !== active.webContents ||
          event.senderFrame !== event.sender.mainFrame
        )
          throw new AgentRuntimeError('FLOW_SENDER_REJECTED', 'authorize')
        if (!query.success) throw new AgentRuntimeError('AGENT_INPUT_INVALID', 'validation')
        const data =
          phase === 'run'
            ? await host.run(raw)
            : phase === 'cooperate'
              ? await host.cooperate(raw)
              : phase === 'collaboration'
                ? host.collaboration(query.data)
                : phase === 'stop'
                  ? host.stop(query.data)
                  : phase === 'inspect'
                    ? host.inspect(query.data)
                    : host.catalog(
                        query.data,
                        catalog
                          .listModels()
                          .filter(
                            (model) =>
                              model.enabled &&
                              model.capabilities.some(
                                (capability) => capability.operation === 'text.generate'
                              )
                          )
                          .map(({ id, name }) => ({ id, name }))
                      )
        if (log)
          emitGatewayEvent('agent.desktop.completed', '画布 Agent 操作完成', context, {
            status: 'success',
            attributes: { phase, action }
          })
        return { ok: true, data }
      } catch (error) {
        const code =
          error instanceof AgentRuntimeError ||
          error instanceof FlowCommandError ||
          error instanceof FlowAssetError
            ? error.code
            : 'AGENT_DESKTOP_FAILED'
        if (!log && code === 'AGENT_DESKTOP_FAILED') {
          const key = query.success ? JSON.stringify(query.data) : 'invalid'
          if (Date.now() - (inspectFailures.get(key) ?? 0) >= 30000) {
            if (inspectFailures.size >= 128) inspectFailures.clear()
            inspectFailures.set(key, Date.now())
            emitGatewayEvent('agent.desktop.inspect_failed', 'Agent 任务状态读取失败', context, {
              attributes: { phase, code }
            })
          }
        }
        if (log)
          emitGatewayEvent('agent.desktop.failed', '画布 Agent 操作失败', context, {
            status: 'failed',
            attributes: { phase, code, action }
          })
        return {
          ok: false,
          error: {
            code,
            message: flowAgentFailureMessage(code)
          }
        }
      }
    })
  }
  return host
}
