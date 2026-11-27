import {
  parseStateMachineInstance,
  parseStateMachinePending
} from '../../shared/engine/executors/agentFlow'
import {
  HumanTaskInstanceSchema,
  HumanTaskNodeConfigSchema,
  HumanTaskPendingSchema,
  HumanTaskValueSchema
} from '../../shared/agent-flow/node-contracts'
import * as projects from '../store/projects.repo'
import { listMedia } from '../store/media.repo'
import { AccessFailure, type AccessDiagnosticsContext } from './access-failure'
import type { AccessDesktop } from './desktop'
import { previewValue, requestHumanDecision } from './human-decision'

export interface FlowStateHumanOpsContext {
  activeProjectId: () => string | null
  desktop?: AccessDesktop
}

export async function executeStateMachineEventOp(
  ctx: FlowStateHumanOpsContext,
  id: string,
  activeId: string | null | undefined,
  input: Record<string, unknown>,
  diagnostics: AccessDiagnosticsContext
): Promise<unknown> {
  if (id !== activeId)
    throw new AccessFailure(
      'ACTIVE_PROJECT_REQUIRED',
      'desktop-ownership',
      'project.open the target canvas first, then retry flowStateMachine.submitEvent'
    )
  const current = projects.openProject(id)
  if (!current) throw new AccessFailure('NOT_FOUND', 'read')
  const nodeId = input.nodeId as string
  const node = current.nodes.find((item) => item.id === nodeId)
  if (!node) throw new AccessFailure('NODE_NOT_FOUND', 'precheck', nodeId.slice(0, 60))
  if (node.type !== 'state-machine')
    throw new AccessFailure('INVALID_INPUT', 'precheck', 'state-machine-node-required')
  const decision = await requestHumanDecision({
    operation: 'flowStateMachine.submitEvent',
    desktop: ctx.desktop,
    projectId: id,
    activeProjectId: activeId ?? null,
    prompt: {
      title: '外部 Agent 请求代你提交状态机事件',
      message: `外部 Agent 想向状态机节点「${node.title}」提交人工事件「${String(input.event ?? '')}」。只有你点「允许提交」才会写入待处理事件。`,
      confirmText: '允许提交'
    },
    diagnostics
  })
  if (!decision.ok) throw new AccessFailure(decision.code, 'human-decision', decision.detail)
  if (!ctx.desktop)
    throw new AccessFailure('DESKTOP_UNAVAILABLE', 'human-decision', 'desktop host is not available')
  const reply = await ctx.desktop.run(
    {
      action: 'state-machine-event',
      projectId: id,
      nodeId,
      stateMachineEvent: input.event as string,
      stateMachineExpectedRevision: input.expectedRevision as number,
      stateMachineEventSource: 'human',
      ...(typeof input.eventId === 'string' ? { stateMachineEventId: input.eventId } : {})
    },
    (version) => {
      if (ctx.activeProjectId() !== id)
        throw new AccessFailure('RESOURCE_BUSY', 'desktop-ownership')
      const admitted = projects.openProject(id)
      if (!admitted || admitted.meta.graphVersion !== version)
        throw new AccessFailure('REVISION_CONFLICT', 'event-admission')
      return admitted.meta
    },
    30000
  )
  const saved = projects.openProject(id)
  if (!saved) throw new AccessFailure('REVISION_CONFLICT', 'event-verify')
  const payload = (reply.result ?? {}) as {
    revision?: number
    eventId?: string
    event?: string
  }
  const shape = (
    saved.tldrawSnapshot as { store: Record<string, { meta?: Record<string, unknown> }> }
  ).store[nodeId]
  const pendingRaw = shape?.meta?.stateMachinePending
  const pending =
    typeof pendingRaw === 'string'
      ? (JSON.parse(pendingRaw) as {
          eventId?: string
          event?: string
          expectedRevision?: number
        })
      : null
  if (
    !pending ||
    pending.event !== (input.event as string) ||
    pending.expectedRevision !== (input.expectedRevision as number) ||
    (payload.eventId !== undefined && pending.eventId !== payload.eventId)
  )
    throw new AccessFailure('STORAGE_INCONSISTENT', 'event-verify')
  return {
    projectId: id,
    nodeId,
    graphVersion: saved.meta.graphVersion,
    revision: payload.revision ?? (input.expectedRevision as number),
    eventId: pending.eventId ?? '',
    event: pending.event ?? (input.event as string),
    pending: true
  }
}

export function readStateMachineOp(id: string, input: Record<string, unknown>): unknown {
  const file = projects.openProject(id)
  if (!file) throw new AccessFailure('NOT_FOUND', 'read')
  const nodeId = input.nodeId as string
  const node = file.nodes.find((item) => item.id === nodeId)
  if (!node) throw new AccessFailure('NODE_NOT_FOUND', 'read', nodeId.slice(0, 60))
  if (node.type !== 'state-machine')
    throw new AccessFailure('INVALID_INPUT', 'read', 'state-machine-node-required')
  const shape = (
    file.tldrawSnapshot as {
      store: Record<string, { props?: { config?: string }; meta?: Record<string, unknown> }>
    }
  ).store[nodeId]
  let config: {
    initialState?: string
    transitions?: Array<{ from: string; event: string; to: string }>
  }
  try {
    config = JSON.parse(shape?.props?.config || '{}')
  } catch {
    throw new AccessFailure('INVALID_INPUT', 'read', 'state-machine-config-invalid')
  }
  const instance = parseStateMachineInstance(shape?.meta?.stateMachine)
  const state = instance?.state ?? String(config.initialState ?? '')
  const revision = instance?.revision ?? 1
  const legalEvents = [
    ...new Set(
      (Array.isArray(config.transitions) ? config.transitions : [])
        .filter((transition) => transition.from === state)
        .map((transition) => transition.event)
    )
  ]
  const pending = parseStateMachinePending(shape?.meta?.stateMachinePending)
  return {
    projectId: id,
    nodeId,
    state,
    revision,
    legalEvents,
    pending: pending
      ? {
          eventId: pending.eventId,
          event: pending.event,
          expectedRevision: pending.expectedRevision
        }
      : null
  }
}

export async function executeHumanTaskSubmitOp(
  ctx: FlowStateHumanOpsContext,
  id: string,
  activeId: string | null | undefined,
  input: Record<string, unknown>,
  diagnostics: AccessDiagnosticsContext
): Promise<unknown> {
  if (id !== activeId || !ctx.desktop)
    throw new AccessFailure(
      'ACTIVE_PROJECT_REQUIRED',
      'desktop-ownership',
      'project.open the target canvas first, then retry humanTask.submit'
    )
  const current = projects.openProject(id)
  if (!current) throw new AccessFailure('NOT_FOUND', 'read')
  const nodeId = input.nodeId as string
  const node = current.nodes.find((item) => item.id === nodeId)
  if (!node) throw new AccessFailure('NODE_NOT_FOUND', 'precheck', nodeId.slice(0, 60))
  if (node.type !== 'human-task')
    throw new AccessFailure('INVALID_INPUT', 'precheck', 'human-task-node-required')
  const value = HumanTaskValueSchema.parse(input.value)
  const media =
    value.kind === 'image' || value.kind === 'video'
      ? listMedia(id).find((asset) => asset.id === value.mediaId)
      : null
  if ((value.kind === 'image' || value.kind === 'video') && (!media || media.kind !== value.kind))
    throw new AccessFailure('INVALID_INPUT', 'precheck', 'human-task-project-media-required')
  const decision = await requestHumanDecision({
    operation: 'humanTask.submit',
    desktop: ctx.desktop,
    diagnostics,
    projectId: id,
    activeProjectId: activeId ?? null,
    prompt: {
      title: '外部 Agent 请求代你提交人工任务',
      message: `外部 Agent 想替你提交人工任务「${node.title}」的结果。这是人工交付，只有你点「允许提交」才会生效。\n\n内容：${previewValue(
        value.kind === 'text' ? value.text : value.kind === 'json' ? value.data : media?.name
      )}${typeof input.handoffNote === 'string' ? `\n\n交接说明：${input.handoffNote}` : ''}`,
      confirmText: '允许提交'
    }
  })
  if (!decision.ok) throw new AccessFailure(decision.code, 'human-decision', decision.detail)
  const reply = await ctx.desktop.run(
    {
      action: 'human-task-submit',
      projectId: id,
      nodeId,
      humanTaskExpectedRevision: input.expectedRevision as number,
      humanTaskValue: value,
      ...(typeof input.handoffNote === 'string' ? { humanTaskHandoffNote: input.handoffNote } : {}),
      ...(typeof input.submissionId === 'string'
        ? { humanTaskSubmissionId: input.submissionId }
        : {})
    },
    (version) => {
      if (ctx.activeProjectId() !== id)
        throw new AccessFailure('RESOURCE_BUSY', 'desktop-ownership')
      const admitted = projects.openProject(id)
      if (!admitted || admitted.meta.graphVersion !== version)
        throw new AccessFailure('REVISION_CONFLICT', 'human-task-admission')
      return admitted.meta
    },
    30000
  )
  const saved = projects.openProject(id)
  if (!saved) throw new AccessFailure('REVISION_CONFLICT', 'human-task-verify')
  const payload = (reply.result ?? {}) as { revision?: number; submissionId?: string }
  const shape = (
    saved.tldrawSnapshot as { store: Record<string, { meta?: Record<string, unknown> }> }
  ).store[nodeId]
  const pendingRaw = shape?.meta?.humanTaskPending
  const pending =
    typeof pendingRaw === 'string' && pendingRaw.trim()
      ? (JSON.parse(pendingRaw) as { submissionId?: string; expectedRevision?: number })
      : null
  if (
    !pending ||
    pending.expectedRevision !== (input.expectedRevision as number) ||
    (payload.submissionId !== undefined && pending.submissionId !== payload.submissionId)
  )
    throw new AccessFailure('STORAGE_INCONSISTENT', 'human-task-verify')
  return {
    projectId: id,
    nodeId,
    graphVersion: saved.meta.graphVersion,
    revision: payload.revision ?? (input.expectedRevision as number),
    submissionId: pending.submissionId ?? '',
    pending: true
  }
}

export function readHumanTaskOp(id: string, input: Record<string, unknown>): unknown {
  const file = projects.openProject(id)
  if (!file) throw new AccessFailure('NOT_FOUND', 'read')
  const nodeId = input.nodeId as string
  const node = file.nodes.find((item) => item.id === nodeId)
  if (!node) throw new AccessFailure('NODE_NOT_FOUND', 'read', nodeId.slice(0, 60))
  if (node.type !== 'human-task')
    throw new AccessFailure('INVALID_INPUT', 'read', 'human-task-node-required')
  const shape = (
    file.tldrawSnapshot as {
      store: Record<string, { props?: { config?: string }; meta?: Record<string, unknown> }>
    }
  ).store[nodeId]
  const config = HumanTaskNodeConfigSchema.safeParse(
    (() => {
      try {
        return JSON.parse(shape?.props?.config || '{}')
      } catch {
        return null
      }
    })()
  )
  const outputType = config.success ? config.data.outputType : 'text'
  const instance = HumanTaskInstanceSchema.safeParse(
    (() => {
      try {
        return JSON.parse(String(shape?.meta?.humanTask ?? ''))
      } catch {
        return null
      }
    })()
  )
  const status = instance.success ? instance.data.status : 'pending'
  const revision = instance.success ? instance.data.revision : 1
  const result =
    instance.success && instance.data.status === 'completed'
      ? (instance.data.result ?? null)
      : null
  const pending = HumanTaskPendingSchema.safeParse(
    (() => {
      try {
        return JSON.parse(String(shape?.meta?.humanTaskPending ?? ''))
      } catch {
        return null
      }
    })()
  )
  return {
    projectId: id,
    nodeId,
    status,
    revision,
    outputType,
    result,
    ...(instance.success && instance.data.handoffNote ? { handoffNote: instance.data.handoffNote } : {}),
    pending: pending.success
      ? {
          submissionId: pending.data.submissionId,
          expectedRevision: pending.data.expectedRevision
        }
      : null
  }
}
