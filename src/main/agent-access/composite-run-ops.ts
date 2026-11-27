import { randomUUID } from 'node:crypto'
import type { CompositeManifest } from '../../shared/composite/manifest'
import { validateCompositeManifest } from '../../shared/composite/validate'
import { HumanTaskNodeConfigSchema, HumanTaskValueSchema } from '../../shared/agent-flow/node-contracts'
import { validateNodeSchema } from '../../shared/node-schemas'
import { getDb } from '../store/db'
import { getCompositeCapability, getCompositeVersion } from '../store/composite.repo'
import {
  countCompositeRetries,
  getCompositeRun,
  getCompositeStepOutputs,
  resubmitCompositeRun
} from '../store/composite-run.repo'
import {
  getLatestCompositeRunWait,
  getSatisfiedHumanSubmissions,
  satisfyCompositeRunWait
} from '../store/composite-run-wait.repo'
import { getMediaAsset, listMedia } from '../store/media.repo'
import { AccessFailure, type AccessDiagnosticsContext } from './access-failure'
import { normalizeCompositeOutputPortId, projectCompositeRunRecord } from './composite-ops'
import { DesktopAccessError, type AccessDesktop } from './desktop'
import { previewValue, requestHumanDecision } from './human-decision'

export interface CompositeRunOpsContext {
  activeProjectId: () => string | null
  desktop?: AccessDesktop
}

function restoreCompositeInputs(
  values: Record<string, unknown>,
  manifest: CompositeManifest
): Array<{ portId: string; value: unknown }> {
  const restored: Array<{ portId: string; value: unknown }> = []
  for (const [portId, raw] of Object.entries(values)) {
    const input = manifest.inputs.find(
      (candidate) => portId === `in-${candidate.id}` || portId === candidate.id
    )
    if (!input) throw new AccessFailure('INVALID_INPUT', 'precheck', 'composite-input-port')
    const candidates = input.cardinality === 'many' && Array.isArray(raw) ? raw : [raw]
    for (const value of candidates) {
      if (
        value === null ||
        typeof value !== 'object' ||
        (!('kind' in value && value.kind === 'media') && !('mediaPath' in value))
      ) {
        restored.push({ portId, value })
        continue
      }
      const mediaId = 'mediaId' in value && typeof value.mediaId === 'string' ? value.mediaId : ''
      const asset = getMediaAsset(mediaId)
      if (!asset) throw new AccessFailure('NOT_FOUND', 'precheck', `media:${mediaId}`)
      restored.push({
        portId,
        value: { kind: asset.kind, mediaId: asset.id, mediaPath: asset.path, mime: asset.mime }
      })
    }
  }
  return restored
}

export async function executeCompositeHeadlessOp(
  ctx: CompositeRunOpsContext,
  input: Record<string, unknown>
): Promise<unknown> {
  if (input.confirmCost !== true)
    throw new AccessFailure(
      'COST_CONFIRM_REQUIRED',
      'precheck',
      'headless flow may invoke paid model calls; pass confirmCost=true to authorize'
    )
  if (!ctx.desktop)
    throw new AccessFailure(
      'DESKTOP_UNAVAILABLE',
      'desktop-ownership',
      'headless execute requires the desktop host running'
    )
  const capabilityId = String(input.capabilityId ?? '')
  const capability = getCompositeCapability(capabilityId)
  if (!capability) throw new AccessFailure('NOT_FOUND', 'read', 'capability')
  const version = typeof input.version === 'string' ? input.version : capability.latestVersion
  if (!version) throw new AccessFailure('NOT_FOUND', 'read', 'published-version')
  const record = getCompositeVersion(capabilityId, version)
  if (!record) throw new AccessFailure('NOT_FOUND', 'read', 'published-version')
  const validation = validateCompositeManifest(record.manifest)
  if (!validation.ok) throw new AccessFailure('STORAGE_INCONSISTENT', 'read', 'manifest-invalid')
  const runId = randomUUID()
  const headlessScope = `headless-${runId}`
  const resolvedInputs: Array<{ portId: string; value: unknown }> = []
  const rawInputs =
    (input.inputs as Array<{ portId: string; value: { kind: string; mediaId?: string } }> | undefined) ??
    []
  for (const entry of rawInputs) {
    if (entry.value?.kind === 'media') {
      const asset = getMediaAsset(String(entry.value.mediaId ?? ''))
      if (!asset)
        throw new AccessFailure('NOT_FOUND', 'precheck', `media:${entry.value.mediaId}`)
      resolvedInputs.push({
        portId: entry.portId,
        value: {
          kind: asset.kind,
          mediaId: asset.id,
          mediaPath: asset.path,
          mime: asset.mime
        }
      })
    } else {
      resolvedInputs.push({ portId: entry.portId, value: entry.value })
    }
  }
  try {
    await ctx.desktop.run({
      action: 'execute-composite-headless',
      projectId: headlessScope,
      compositeManifest: record.manifest,
      compositeInputs: resolvedInputs,
      ownRunId: runId,
      compositeInputValues: Object.fromEntries(
        resolvedInputs.map((entry) => [entry.portId, entry.value])
      )
    })
  } catch (error) {
    if (error instanceof DesktopAccessError && !error.unknownOutcome)
      throw new AccessFailure(error.code, 'execute-handshake', error.detail)
    throw error
  }
  return { runId, capabilityId, version, status: 'running' }
}

export async function waitCompositeHeadlessOp(input: Record<string, unknown>): Promise<unknown> {
  const runId = String(input.runId ?? '')
  const timeoutMs = typeof input.timeoutMs === 'number' ? input.timeoutMs : 30000
  const deadline = Date.now() + timeoutMs
  let record = getCompositeRun(runId)?.run
  while (
    record &&
    (record.status === 'accepted' || record.status === 'running') &&
    Date.now() < deadline
  ) {
    await new Promise((resolve) => setTimeout(resolve, 500))
    record = getCompositeRun(runId)?.run
  }
  if (!record) throw new AccessFailure('NOT_FOUND', 'read', 'composite-run')
  const projected = projectCompositeRunRecord(record)
  return {
    runId,
    status: projected.status,
    ...(projected.outputValues ? { outputs: projected.outputValues } : {}),
    ...(record.errorMessage ? { reason: record.errorMessage } : {}),
    ...(record.manualSubmission ? { manualSubmission: true } : {}),
    ...(record.retryOf ? { retryOf: record.retryOf } : {}),
    ...(record.failurePhase
      ? {
          failure: {
            code: record.errorCode ?? 'FAILED',
            phase: record.failurePhase,
            ...(record.failureNodeId ? { nodeId: record.failureNodeId } : {}),
            ...(record.failurePortId ? { portId: record.failurePortId } : {})
          }
        }
      : {})
  }
}

export async function executeCompositeRunRetryOp(
  ctx: CompositeRunOpsContext,
  input: Record<string, unknown>
): Promise<unknown> {
  if (!ctx.desktop)
    throw new AccessFailure(
      'DESKTOP_UNAVAILABLE',
      'desktop-ownership',
      'retry requires the desktop host running'
    )
  const runId = String(input.runId ?? '')
  const detail = getCompositeRun(runId)
  if (!detail) throw new AccessFailure('NOT_FOUND', 'read', 'composite-run')
  const existing = detail.run
  if (existing.status !== 'failed' && existing.status !== 'interrupted')
    throw new AccessFailure('RUN_NOT_RETRYABLE', 'precheck', `status:${existing.status}`)
  const rootRunId = existing.retryOf ?? existing.id
  const retriesUsed = countCompositeRetries(rootRunId)
  if (retriesUsed >= 3)
    throw new AccessFailure('RETRY_LIMIT_EXCEEDED', 'precheck', 'max 3 retries per root run')
  const record = getCompositeVersion(existing.capabilityId, existing.capabilityVersion)
  if (!record || record.contentHash !== existing.contentHash)
    throw new AccessFailure('VERSION_NOT_PUBLISHED', 'precheck', 'published-version')
  const preExecutionFailure =
    existing.status === 'failed' && existing.failurePhase === 'input' && detail.steps.length === 0
  const localOnly = record.manifest.graph.nodes.every(({ nodeType }) =>
    ['text', 'json', 'processor'].includes(nodeType)
  )
  if (!preExecutionFailure && !localOnly)
    throw new AccessFailure(
      'RUN_RETRY_REQUIRES_RECONCILIATION',
      'precheck',
      'Previous effects are unconfirmed. Check the run and existing deliveries before starting another run.'
    )
  const validation = validateCompositeManifest(record.manifest)
  if (!validation.ok) throw new AccessFailure('STORAGE_INCONSISTENT', 'read', 'manifest-invalid')
  if (!existing.inputValues)
    throw new AccessFailure('INPUTS_NOT_RECORDED', 'precheck', 'run predates input persistence')
  const resolvedInputs = restoreCompositeInputs(existing.inputValues, record.manifest)
  const newRunId = randomUUID()
  try {
    await ctx.desktop.run({
      action: 'execute-composite-headless',
      projectId: `headless-${newRunId}`,
      compositeManifest: record.manifest,
      compositeInputs: resolvedInputs,
      ownRunId: newRunId,
      compositeInputValues: Object.fromEntries(
        resolvedInputs.map((entry) => [entry.portId, entry.value])
      ),
      compositeRetryOf: rootRunId
    })
  } catch (error) {
    if (error instanceof DesktopAccessError && !error.unknownOutcome)
      throw new AccessFailure(error.code, 'execute-handshake', error.detail)
    throw error
  }
  return {
    runId: newRunId,
    retryOf: rootRunId,
    capabilityId: existing.capabilityId,
    version: existing.capabilityVersion,
    status: 'running',
    retriesUsed: retriesUsed + 1
  }
}

export async function executeCompositeSubmitHumanOp(
  ctx: CompositeRunOpsContext,
  input: Record<string, unknown>,
  diagnostics: AccessDiagnosticsContext
): Promise<unknown> {
  const runId = String(input.runId ?? '')
  const nodeId = String(input.nodeId ?? '')
  const existing = getCompositeRun(runId)?.run
  if (!existing) throw new AccessFailure('NOT_FOUND', 'read', 'composite-run')
  if (existing.status !== 'waiting-input')
    throw new AccessFailure('RUN_NOT_WAITING', 'precheck', `status:${existing.status}`)
  const wait = getLatestCompositeRunWait(runId)
  if (!wait || wait.stepKey !== nodeId)
    throw new AccessFailure('HUMAN_WAIT_NOT_FOUND', 'precheck', `node:${nodeId}`)
  const version = getCompositeVersion(existing.capabilityId, existing.capabilityVersion)
  const node = version?.manifest.graph.nodes.find((step) => step.id === nodeId)
  if (!version || version.contentHash !== existing.contentHash || node?.nodeType !== 'human-task')
    throw new AccessFailure('VERSION_NOT_PUBLISHED', 'precheck', 'published-human-task')
  const config = HumanTaskNodeConfigSchema.safeParse(JSON.parse(node.config || '{}'))
  const value = HumanTaskValueSchema.parse(input.value)
  if (!config.success || value.kind !== config.data.outputType)
    throw new AccessFailure('INVALID_INPUT', 'precheck', 'human-task-output-type-mismatch')
  if (
    (value.kind === 'image' || value.kind === 'video') &&
    !listMedia(existing.projectId).some(
      (asset) => asset.id === value.mediaId && asset.kind === value.kind
    )
  )
    throw new AccessFailure('INVALID_INPUT', 'precheck', 'human-task-project-media-required')
  const decision = await requestHumanDecision({
    operation: 'composite.run.submitHuman',
    desktop: ctx.desktop,
    projectId: existing.projectId,
    activeProjectId: ctx.activeProjectId(),
    headless: existing.instanceNodeId === null && existing.parentRunId === null,
    prompt: {
      title: '外部 Agent 请求代你提交节点流人工结果',
      message: `外部 Agent 想为节点流「${version.manifest.name}」的运行 ${runId} 提交人工节点「${node.title}」的结果。只有你点「允许提交」才会生效。\\n\\n内容：${previewValue(value)}`,
      confirmText: '允许提交'
    },
    diagnostics
  })
  if (!decision.ok) throw new AccessFailure(decision.code, 'human-decision', decision.detail)
  const satisfied = satisfyCompositeRunWait({
    requestId: wait.requestId,
    revision: wait.revision,
    value,
    submittedBy: 'external'
  })
  if (!satisfied.ok)
    throw new AccessFailure(satisfied.reason ?? 'HUMAN_WAIT_REJECTED', 'precheck', 'wait')
  return { runId, nodeId, satisfied: true }
}

export async function executeCompositeRunResumeOp(
  ctx: CompositeRunOpsContext,
  input: Record<string, unknown>
): Promise<unknown> {
  if (!ctx.desktop)
    throw new AccessFailure(
      'DESKTOP_UNAVAILABLE',
      'desktop-ownership',
      'resume requires the desktop host running'
    )
  const runId = String(input.runId ?? '')
  const existing = getCompositeRun(runId)?.run
  if (!existing) throw new AccessFailure('NOT_FOUND', 'read', 'composite-run')
  if (existing.status !== 'waiting-input' && existing.status !== 'interrupted')
    throw new AccessFailure('RUN_NOT_WAITING', 'precheck', `status:${existing.status}`)
  if (
    existing.parentRunId &&
    getDb()
      .prepare(
        'SELECT 1 FROM flow_commands WHERE run_id = ? AND project_id = ? AND target_node_id = ?'
      )
      .get(existing.parentRunId, existing.projectId, existing.instanceNodeId)
  )
    throw new AccessFailure('PARENT_RESUME_REQUIRED', 'precheck', 'continue the parent Agent Flow')
  if (existing.status === 'interrupted') {
    const restored = getDb()
      .prepare(
        `
        UPDATE composite_runs
        SET status='waiting-input', finished_at=NULL, error_code=NULL, error_message=NULL
        WHERE id=? AND status='interrupted' AND error_code='HOST_RESTARTED'
          AND (SELECT state FROM composite_run_waits WHERE run_id=composite_runs.id
            ORDER BY revision DESC LIMIT 1)='satisfied'
          AND NOT EXISTS (SELECT 1 FROM composite_run_steps
            WHERE run_id=composite_runs.id AND status='running')
      `
      )
      .run(runId).changes
    if (!restored) {
      throw new AccessFailure(
        'RUN_RECOVERY_REQUIRES_RECONCILIATION',
        'precheck',
        'interrupted run needs a satisfied wait and no unresolved running step'
      )
    }
  }
  const record = getCompositeVersion(existing.capabilityId, existing.capabilityVersion)
  if (!record) throw new AccessFailure('VERSION_NOT_PUBLISHED', 'precheck', 'published-version')
  const validation = validateCompositeManifest(record.manifest)
  if (!validation.ok) throw new AccessFailure('STORAGE_INCONSISTENT', 'read', 'manifest-invalid')
  const steps = getCompositeRun(runId)?.steps ?? []
  const stepOutputs = getCompositeStepOutputs(runId)
  const completedSteps = steps
    .filter(
      (step) => step.status === 'completed' || (step.status === 'skipped' && stepOutputs[step.stepKey])
    )
    .map((step) => step.stepKey)
  const humanSubmissions = getSatisfiedHumanSubmissions(runId)
  const resolvedInputs = restoreCompositeInputs(existing.inputValues ?? {}, record.manifest)
  const canvasResume = Boolean(existing.instanceNodeId)
  try {
    await ctx.desktop.run({
      action: canvasResume ? 'resume-composite-canvas' : 'execute-composite-headless',
      projectId: existing.projectId,
      ...(canvasResume
        ? {
            nodeId: existing.instanceNodeId ?? undefined,
            compositeResumeInputValues: resolvedInputs
          }
        : {
            compositeManifest: record.manifest,
            compositeInputs: resolvedInputs,
            ownRunId: runId
          }),
      compositeResumeRunId: runId,
      compositeHumanSubmissions: humanSubmissions,
      compositeCompletedSteps: completedSteps,
      compositeStepOutputs: stepOutputs
    })
  } catch (error) {
    if (error instanceof DesktopAccessError && !error.unknownOutcome)
      throw new AccessFailure(error.code, 'execute-handshake', error.detail)
    throw error
  }
  return {
    runId,
    capabilityId: existing.capabilityId,
    version: existing.capabilityVersion,
    status: 'running'
  }
}

export async function executeCompositeRunResubmitOp(
  ctx: CompositeRunOpsContext,
  input: Record<string, unknown>,
  diagnostics: AccessDiagnosticsContext
): Promise<unknown> {
  const runId = String(input.runId ?? '')
  const existing = getCompositeRun(runId)?.run
  if (!existing) throw new AccessFailure('NOT_FOUND', 'read', 'composite-run')
  if (existing.status !== 'failed' && existing.status !== 'interrupted')
    throw new AccessFailure('RUN_NOT_RESUBMITTABLE', 'precheck', `status:${existing.status}`)
  const record = getCompositeVersion(existing.capabilityId, existing.capabilityVersion)
  if (!record) throw new AccessFailure('VERSION_NOT_PUBLISHED', 'precheck', 'published-version')
  const outputs = (
    (input.outputs ?? []) as Array<{
      portId: string
      value: { kind: 'text' | 'markdown' | 'json'; text?: string; data?: unknown }
    }>
  ).map((entry) => ({
    ...entry,
    portId: normalizeCompositeOutputPortId(record.manifest, String(entry.portId ?? '')).id
  }))
  const declared = record.manifest.outputs
  const submittedIds = outputs.map((entry) => entry.portId)
  if (
    submittedIds.some((portId) => !portId) ||
    new Set(submittedIds).size !== submittedIds.length ||
    submittedIds.length !== declared.length ||
    declared.some((port) => !submittedIds.includes(port.id))
  )
    throw new AccessFailure(
      'OUTPUT_PORTS_MISMATCH',
      'precheck',
      'all public outputs required exactly once'
    )
  const outputValues: Record<string, unknown> = {}
  for (const entry of outputs) {
    const port = declared.find((item) => item.id === entry.portId)!
    const kind = entry.value.kind
    const compatible =
      port.type === 'any' || port.type === kind || (port.type === 'text' && kind === 'markdown')
    if (!compatible)
      throw new AccessFailure('OUTPUT_TYPE_INVALID', 'precheck', `${entry.portId}:${port.type}`)
    if (kind === 'json' && port.schemaRef) {
      const validation = validateNodeSchema(port.schemaRef, entry.value.data)
      if (!validation.ok)
        throw new AccessFailure('OUTPUT_VALUE_INVALID', 'precheck', `${entry.portId}:schema`)
    }
    outputValues[entry.portId] = entry.value
  }
  const decision = await requestHumanDecision({
    operation: 'composite.run.resubmit',
    desktop: ctx.desktop,
    projectId: existing.projectId,
    activeProjectId: ctx.activeProjectId(),
    headless: existing.instanceNodeId === null && existing.parentRunId === null,
    prompt: {
      title: '外部 Agent 请求补交节点流输出',
      message: `外部 Agent 想为节点流「${record.manifest.name}」的运行 ${runId} 补交正式输出。只有你点「允许补交」才会生效。\\n\\n输出：${previewValue(outputValues)}`,
      confirmText: '允许补交'
    },
    diagnostics
  })
  if (!decision.ok) throw new AccessFailure(decision.code, 'human-decision', decision.detail)
  const changed = resubmitCompositeRun({
    runId,
    outputPorts: declared.map((port) => ({
      portId: port.id,
      kind: outputValues[port.id] ? (outputValues[port.id] as { kind: string }).kind : 'text'
    })),
    outputValues
  })
  if (!changed) throw new AccessFailure('RUN_NOT_RESUBMITTABLE', 'precheck', 'state-race')
  return {
    runId,
    status: 'completed',
    manualSubmission: true,
    outputPorts: submittedIds.map((id) => `out-${id}`)
  }
}
