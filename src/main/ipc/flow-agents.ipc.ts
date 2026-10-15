import { supportsSampledVideoReview } from '../../shared/agent-flow/video-review'
import { supportsReviewAudioInput } from '../../shared/agent-flow/media-review'
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
import { FlowCoordinatorHost } from '../agent-flow/coordinator-host'
import type { ModelIdentity } from '../../shared/agent-flow/coordination'
import type { AgentModelPort } from '../agent-flow/runtime'
import { FlowBuilderHost } from '../agent-flow/builder-host'
import { BuildRequestSchema } from '../../shared/agent-flow/builder'
import { FlowReviewHost } from '../agent-flow/review-host'
import { FlowReviewStore, reviewBinding } from '../agent-flow/review-store'
import { readStoredNodeRunStatus } from '../../shared/engine/run-status'

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
  const resolveModel = async (
    snapshot: ModelIdentity,
    signal: AbortSignal
  ): Promise<AgentModelPort> => {
    const definition = await catalog.getModel(snapshot.config.modelDefinitionId ?? '')
    if (
      !definition?.enabled ||
      !definition.capabilities.some((capability) => capability.operation === 'text.generate')
    )
      throw new AgentRuntimeError('AGENT_MODEL_UNAVAILABLE', 'model-capability')
    if (snapshot.requiresImageInput && !supportsSampledVideoReview(definition))
      throw new AgentRuntimeError('FLOW_VIDEO_REVIEW_MODEL_UNVERIFIED', 'model-capability')
    if (snapshot.requiresAudioInput && !supportsReviewAudioInput(definition))
      throw new AgentRuntimeError('FLOW_AUDIO_REVIEW_MODEL_UNVERIFIED', 'model-capability')
    const connection = await catalog.getConnection(definition.connectionId)
    if (
      !connection?.enabled ||
      !['openai', 'openai-compatible', 'openrouter', 'toapis'].includes(connection.protocol)
    )
      throw new AgentRuntimeError('AGENT_MODEL_PROTOCOL', 'model-capability')
    let address: URL
    try {
      address = new URL(connection.baseUrl)
    } catch {
      throw new AgentRuntimeError('AGENT_MODEL_PROTOCOL', 'model-capability')
    }
    const secret = await catalog.readSecret(connection.id)
    const local = ['localhost', '127.0.0.1', '[::1]'].includes(address.hostname)
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
    // Seed 2.1 thinking can consume the entire bounded discussion timeout.
    // Discussion and single-result builder/review opt out; task decisions retain their defaults.
    const discussionProviderOptions =
      address.hostname === 'ark.cn-beijing.volces.com' &&
      /^doubao-seed-2-1-(turbo|pro)-\d{6}$/.test(definition.modelId)
        ? { [connection.id]: { thinking: { type: 'disabled' } } }
        : undefined
    return new AgentSdkModel(model, snapshot.projectId, assets, context, discussionProviderOptions)
  }
  const host = new FlowAgentDesktopHost(getDb(), openProject, desktop, resolveModel)
  const builder = new FlowBuilderHost(getDb(), openProject, desktop.isActive, resolveModel)
  const review = new FlowReviewHost(getDb(), openProject, desktop.isActive, resolveModel)
  host.setCoordinator(
    new FlowCoordinatorHost(
      getDb(),
      openProject,
      desktop.isActive,
      host,
      resolveModel,
      async (grant, signal) => {
        const active = window()
        if (!active || active.isDestroyed() || !desktop.isActive(grant.projectId))
          throw new AgentRuntimeError('FLOW_PROJECT_INACTIVE', 'publication')
        active.webContents.send(IPC.flowAgents.publication, grant)
        const deadline = Date.now() + 30000
        while (!signal.aborted && Date.now() < deadline && desktop.isActive(grant.projectId)) {
          const file = openProject(grant.projectId)
          const shape = (
            file?.tldrawSnapshot as {
              store?: Record<string, { meta?: { agentTask?: string; nodeResult?: string } }>
            }
          )?.store?.[grant.nodeId]
          try {
            const task = JSON.parse(shape?.meta?.agentTask ?? '{}')
            const result = JSON.parse(shape?.meta?.nodeResult ?? '{}')
            if (grant.kind === 'review') {
              const record =
                new FlowReviewStore(getDb()).forRequest(grant.projectId, grant.taskId) ??
                new FlowReviewStore(getDb()).latest(grant.projectId, grant.nodeId)
              const nodeRun = (shape?.meta as Record<string, unknown>)?.nodeRun
              if (
                file &&
                record &&
                record.signature === reviewBinding(file, grant.nodeId).signature &&
                record.decision.reviewId === result.reviewId &&
                readStoredNodeRunStatus(nodeRun) === 'success' &&
                (nodeRun as { runId: string }).runId === grant.taskId
              )
                return
            }
            if (
              task.taskId === grant.taskId &&
              ['success', 'skipped'].includes(
                readStoredNodeRunStatus((shape?.meta as Record<string, unknown>)?.nodeRun) ?? ''
              ) &&
              ((shape?.meta as Record<string, unknown>)?.nodeRun as { runId?: string } | undefined)
                ?.runId === grant.taskId &&
              (task.state === 'waiting' ||
                (task.state === 'completed' && result.taskId === grant.taskId))
            )
              return
          } catch {
            /* Wait only for the saved public projection. */
          }
          await new Promise((done) => setTimeout(done, 100))
        }
        throw new AgentRuntimeError('FLOW_PUBLICATION_UNCONFIRMED', 'publication')
      },
      (projectId, nodeId) => review.cancel(projectId, nodeId)
    )
  )
  for (const phase of [
    'run',
    'build',
    'review',
    'inspect',
    'stop',
    'pause',
    'catalog',
    'collaboration',
    'cooperate'
  ] as const) {
    ipcMain.handle(IPC.flowAgents[phase], async (event, raw): Promise<IpcEnvelope<unknown>> => {
      const context = { traceId: newTraceId(), spanId: newSpanId() }
      const query = FlowAgentQuerySchema.safeParse(
        ['run', 'cooperate', 'build', 'review'].includes(phase) && raw && typeof raw === 'object'
          ? { projectId: raw.projectId, nodeId: raw.nodeId }
          : raw
      )
      if (query.success)
        Object.assign(context, { projectId: query.data.projectId, nodeId: query.data.nodeId })
      const collaboration =
        phase === 'cooperate' ? FlowAgentCollaborationSchema.safeParse(raw) : null
      const build = phase === 'build' ? BuildRequestSchema.safeParse(raw) : null
      const action = build?.success
        ? build.data.action
        : collaboration?.success
          ? collaboration.data.action
          : undefined
      if (collaboration?.success) Object.assign(context, { taskId: collaboration.data.taskId })
      const log = phase !== 'inspect' && !(phase === 'build' && action === 'inspect')
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
          phase === 'review'
            ? await review.run(raw)
            : phase === 'build'
              ? await builder.handle(raw)
              : phase === 'run'
                ? await host.run(raw)
                : phase === 'cooperate'
                  ? await host.cooperate(raw)
                  : phase === 'collaboration'
                    ? host.collaboration(query.data)
                    : phase === 'stop'
                      ? host.stop(query.data)
                      : phase === 'pause'
                        ? host.pause(query.data)
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
                                .map((model) => ({
                                  id: model.id,
                                  name: model.name,
                                  imageInput: supportsSampledVideoReview(model),
                                  audioInput: supportsReviewAudioInput(model)
                                }))
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
