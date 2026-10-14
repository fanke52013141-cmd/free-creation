import type { Editor, TLShapeId } from 'tldraw'
import type { ProjectFile, ProviderSummary } from '@shared/types'
import type {
  NodeExecuteCommand,
  FlowCommandReceipt,
  FlowCommandGrant
} from '@shared/agent-flow/commands'
import { canonicalFlowJson, semanticProjectPayload } from '@shared/agent-flow/semantic-revision'
import type { IpcEnvelope } from '@shared/contracts'
import { deriveGraph } from '../canvas/graph'
import { ensureCanvasSaved } from '../canvas/flow-asset-actions'
import { runNodeManually } from './executor'
import { readNodeRunRecord } from './runRecord'
import type { NodeCardShape } from '../canvas/NodeCardShape'
import { useEditorStore } from '../stores/editor'
import { useAppStore } from '../stores/app'
import { DiagnosticsProducer, newProducerId, newTraceId, newSpanId } from '@shared/observability'
import { emitDiagnosticsEvent } from './diagnosticsReporter'
import type { AgentPublication } from '@shared/agent-flow/coordination'

const producer = new DiagnosticsProducer({
  process: 'renderer',
  producerId: newProducerId('renderer')
})
export function reportFlowCanvasBindingFailure(projectId: string, phase: string): void {
  emitDiagnosticsEvent(
    producer.build(
      'command.canvas_binding_failed',
      undefined,
      '画布执行桥绑定未确认',
      {
        traceId: newTraceId(),
        spanId: newSpanId(),
        projectId
      },
      { status: 'failed', attributes: { phase } }
    )
  )
}
export function reportFlowBridgeFailure(grant: FlowCommandGrant): void {
  const command = grant.command
  emitDiagnosticsEvent(
    producer.build(
      'command.bridge.failed',
      undefined,
      '执行桥结果未确认，请核对原命令',
      {
        traceId: command.traceId,
        spanId: command.spanId,
        projectId: command.projectId,
        nodeId: command.targetNodeId,
        taskId: command.taskId,
        runId: grant.runId
      },
      { status: 'failed', attributes: { commandId: command.commandId, phase: 'bridge' } }
    )
  )
}

function assertActiveProject(editor: Editor, projectId: string): void {
  if (
    useEditorStore.getState().editor !== editor ||
    useAppStore.getState().currentProject?.id !== projectId
  )
    throw new Error('FLOW_PROJECT_CONFLICT')
}
function freeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const child of Object.values(value)) freeze(child)
    Object.freeze(value)
  }
  return value
}

const active = new Map<string, { intent: string; promise: Promise<FlowCommandReceipt> }>()
function data<T>(result: IpcEnvelope<T>): T {
  if (!result.ok) throw new Error(result.error.code)
  return result.data
}

/** Replays an authoritative child task through its public executor to publish saved outputs. */
export async function publishFlowAgent(editor: Editor, grant: AgentPublication): Promise<void> {
  try {
    assertActiveProject(editor, grant.projectId)
    const file = data(await window.api.openProject(grant.projectId))
    if (!file || (await canvasSemanticRevision(editor, file)) !== grant.semanticRevision)
      throw new Error('FLOW_REVISION_CONFLICT')
    if (grant.kind === 'review') {
      const shape = editor.getShape<NodeCardShape>(grant.nodeId as TLShapeId)
      if (!shape || shape.props.nodeType !== 'ai-review') throw new Error('FLOW_NODE_MISSING')
      const result = await runNodeManually(editor, grant.projectId, [], shape.id, undefined, grant)
      if (result.status !== 'done') throw new Error('FLOW_REVIEW_EXECUTION_FAILED')
      assertActiveProject(editor, grant.projectId)
      await ensureCanvasSaved()
      return
    }
    const task = data(
      await window.api.inspectFlowAgent({ projectId: grant.projectId, nodeId: grant.nodeId })
    )
    if (!task || task.taskId !== grant.taskId || !['completed', 'waiting'].includes(task.state))
      throw new Error('FLOW_TASK_CONFLICT')
    assertActiveProject(editor, grant.projectId)
    const shape = editor.getShape<NodeCardShape>(grant.nodeId as TLShapeId)
    if (!shape || shape.props.nodeType !== 'agent') throw new Error('FLOW_NODE_MISSING')
    editor.updateShape({
      id: shape.id,
      type: 'node-card',
      meta: { ...shape.meta, agentTask: JSON.stringify(task) }
    })
    await runNodeManually(editor, grant.projectId, [], shape.id, undefined, grant)
    assertActiveProject(editor, grant.projectId)
    await ensureCanvasSaved()
  } catch {
    emitDiagnosticsEvent(
      producer.build(
        'agent.publication.failed',
        undefined,
        '专业 Agent 成果呈现未确认',
        {
          projectId: grant.projectId,
          nodeId: grant.nodeId,
          taskId: grant.taskId,
          traceId: grant.traceId,
          spanId: grant.spanId
        },
        { status: 'failed', attributes: { phase: 'publication' } }
      )
    )
  }
}
function currentIntent(editor: Editor, file: ProjectFile): string {
  return canonicalFlowJson(
    semanticProjectPayload({
      ...file,
      ...deriveGraph(editor),
      tldrawSnapshot: editor.store.getStoreSnapshot('document')
    })
  )
}
export async function canvasSemanticRevision(editor: Editor, file: ProjectFile): Promise<string> {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(currentIntent(editor, file))
  )
  return `sha256:${Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('')}`
}

/** Used by desktop Agent tools; ordinary node business behavior remains in executeNodeOnce. */
export function runFlowNodeCommand(
  editor: Editor,
  projectId: string,
  providers: ProviderSummary[],
  command: NodeExecuteCommand
): Promise<FlowCommandReceipt> {
  const key = JSON.stringify([projectId, command.commandId])
  const business = {
    ...command,
    traceId: undefined,
    spanId: undefined,
    inputs: [...command.inputs].sort((a, b) => a.targetPortId.localeCompare(b.targetPortId))
  }
  const intent = canonicalFlowJson(business)
  const previous = active.get(key)
  if (previous) {
    if (previous.intent !== intent) return Promise.reject(new Error('FLOW_COMMAND_CONFLICT'))
    return previous.promise
  }
  const promise = execute(editor, projectId, providers, command).finally(() => active.delete(key))
  active.set(key, { intent, promise })
  return promise
}
async function execute(
  editor: Editor,
  projectId: string,
  providers: ProviderSummary[],
  command: NodeExecuteCommand
): Promise<FlowCommandReceipt> {
  if (command.projectId !== projectId) throw new Error('FLOW_PROJECT_CONFLICT')
  assertActiveProject(editor, projectId)
  await ensureCanvasSaved()
  // A lost prepare response is not retried; lookup/timeout/startup recovery retain the original intent.
  // Main deduplication precedes live revision checks: completed/unknown intents remain readable after edits.
  const prepared = data(await window.api.prepareFlowCommand(command))
  if (prepared.state !== 'ready') return prepared.receipt
  const { grant } = prepared
  return runPreparedFlowNodeCommand(editor, projectId, providers, grant)
}
export async function runPreparedFlowNodeCommand(
  editor: Editor,
  projectId: string,
  providers: ProviderSummary[],
  grant: FlowCommandGrant
): Promise<FlowCommandReceipt> {
  let file: ProjectFile | null = null
  try {
    if (grant.command.projectId !== projectId) throw new Error('FLOW_PROJECT_CONFLICT')
    assertActiveProject(editor, projectId)
    file = data(await window.api.openProject(projectId))
    if (!file) throw new Error('FLOW_PROJECT_MISSING')
  } catch {
    const lease = {
      projectId: grant.command.projectId,
      commandId: grant.command.commandId,
      leaseId: grant.leaseId
    }
    const aborted = await window.api.abortUnstartedFlowCommand(lease).catch(() => null)
    if (aborted?.ok) return aborted.data
    return data(await window.api.markFlowCommandUnknown(lease))
  }
  return finishGrant(editor, projectId, providers, grant, file)
}
async function finishGrant(
  editor: Editor,
  projectId: string,
  providers: ProviderSummary[],
  grant: FlowCommandGrant,
  file: ProjectFile
): Promise<FlowCommandReceipt> {
  const command = grant.command
  const lookup = { projectId, commandId: command.commandId }
  const lease = { ...lookup, leaseId: grant.leaseId }
  try {
    await executeFlowCommandGrant(editor, projectId, providers, grant, file)
    const record = readNodeRunRecord(
      editor.getShape<NodeCardShape>(command.targetNodeId as TLShapeId)?.meta.nodeRun
    )
    if (record?.runId !== grant.runId)
      return data(await window.api.abortUnstartedFlowCommand(lease))
    assertActiveProject(editor, projectId)
    await ensureCanvasSaved()
    return data(await window.api.commitFlowCommand(lookup))
  } catch {
    const aborted = await window.api.abortUnstartedFlowCommand(lease).catch(() => null)
    if (aborted?.ok) return aborted.data
    // Preserve pending/unknown. Even a successful commit can lose its transport response.
    return data(await window.api.markFlowCommandUnknown(lease))
  }
}

/** Separate execution stage enables saved-run reconciliation without repeating business work. */
export async function executeFlowCommandGrant(
  editor: Editor,
  projectId: string,
  providers: ProviderSummary[],
  grant: FlowCommandGrant,
  saved: ProjectFile
): Promise<void> {
  grant = freeze(structuredClone(grant))
  if (grant.command.projectId !== projectId) throw new Error('FLOW_PROJECT_CONFLICT')
  const expected = currentIntent(editor, saved)
  if ((await canvasSemanticRevision(editor, saved)) !== grant.command.expectedSemanticRevision)
    throw new Error('FLOW_REVISION_CONFLICT')
  await runNodeManually(editor, projectId, providers, grant.command.targetNodeId as TLShapeId, {
    grant,
    beforeExecutor: async () => {
      assertActiveProject(editor, projectId)
      if (currentIntent(editor, saved) !== expected) throw new Error('FLOW_REVISION_CONFLICT')
      data(
        await window.api.checkFlowCommand({
          projectId,
          commandId: grant.command.commandId,
          leaseId: grant.leaseId
        })
      )
      assertActiveProject(editor, projectId)
      // No await after this live check: the next executor receives exactly the admitted snapshot.
      if (currentIntent(editor, saved) !== expected) throw new Error('FLOW_REVISION_CONFLICT')
    }
  })
}

/** Read/commit an already saved run only. Never falls back to execute or prepare. */
export async function reconcileFlowNodeCommand(input: {
  projectId: string
  commandId: string
}): Promise<FlowCommandReceipt> {
  const receipt = data(await window.api.lookupFlowCommand(input))
  if (receipt.state !== 'pending' && receipt.state !== 'unknown') return receipt
  const committed = await window.api.commitFlowCommand(input)
  return committed.ok ? committed.data : receipt
}
