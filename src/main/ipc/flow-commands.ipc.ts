import { ipcMain, type BrowserWindow, type IpcMainInvokeEvent } from 'electron'
import type { z } from 'zod'
import { IPC, type IpcEnvelope } from '../../shared/contracts'
import {
  NodeExecuteCommandSchema,
  CommandLeaseSchema,
  CommandLookupSchema,
  NodeAvailabilitySchema,
  FlowCanvasSchema,
  FlowCommandError
} from '../../shared/agent-flow/commands'
import { FlowAssetError } from '../../shared/agent-flow/assets'
import { newSpanId, newTraceId } from '../../shared/observability'
import { emitGatewayEvent } from '../diagnostics/gateway-events'
import { FlowCommandLedger } from '../agent-flow/command-ledger'
import { getDb } from '../store/db'
import { openProject } from '../store/projects.repo'
import { stopAgentVideos } from '../agent-flow/video-tasks'
import type { FlowCommandGrant } from '../../shared/agent-flow/commands'
export interface FlowCommandDesktop {
  ledger: FlowCommandLedger
  isActive(projectId: string): boolean
  deliver(grant: FlowCommandGrant, signal: AbortSignal): Promise<void>
}

/** Desktop-only request/grant bridge; no CLI/headless interface. */
export function registerFlowCommandsIpc(
  window: () => BrowserWindow | null,
  connect?: (desktop: FlowCommandDesktop) => void
): FlowCommandLedger {
  const ledger = new FlowCommandLedger(getDb(), openProject)
  let activeProjectId: string | null = null
  function recover(
    phase: string,
    run: () => import('../../shared/agent-flow/commands').FlowCommandReceipt[]
  ): void {
    const context = { traceId: newTraceId(), spanId: newSpanId() }
    emitGatewayEvent('command.recovery.started', '开始核对失联命令', context, {
      attributes: { phase }
    })
    try {
      const receipts = run()
      for (const receipt of receipts) {
        let resumesTraceId: string | undefined
        try {
          resumesTraceId = ledger.diagnostics({
            projectId: receipt.projectId,
            commandId: receipt.commandId
          }).traceId
        } catch {
          /* Original project may be unavailable. */
        }
        emitGatewayEvent(
          'command.recovered',
          '失联命令保留未知，等待核对',
          {
            ...context,
            spanId: newSpanId(),
            parentSpanId: context.spanId,
            projectId: receipt.projectId,
            taskId: receipt.taskId,
            nodeId: receipt.targetNodeId,
            runId: receipt.runId
          },
          {
            attributes: {
              commandId: receipt.commandId,
              phase,
              state: receipt.state,
              resumesTraceId
            }
          }
        )
      }
      emitGatewayEvent('command.recovery.completed', '失联命令核对结束', context, {
        status: 'success',
        attributes: { phase, commandCount: receipts.length }
      })
    } catch {
      emitGatewayEvent('command.recovery_failed', '失联命令核对失败，保留原记录', context, {
        status: 'failed',
        attributes: { phase, code: 'FLOW_STORAGE_FAILED' }
      })
    }
  }
  function arm(grant: FlowCommandGrant): void {
    const timer = setTimeout(
      () =>
        recover('timeout', () => {
          const input = { projectId: grant.command.projectId, commandId: grant.command.commandId }
          if (ledger.lookup(input).state !== 'pending') return []
          return [ledger.unknown({ ...input, leaseId: grant.leaseId })]
        }),
      60000
    )
    timer.unref()
  }
  window()?.webContents.on('render-process-gone', () =>
    recover('renderer-lost', () => ledger.loseRenderer())
  )
  recover('startup', () => ledger.recoverAbandoned())
  function handle<T extends { projectId: string; commandId?: string; nodeId?: string }, R>(
    channel: string,
    phase: string,
    schema: z.ZodType<T>,
    run: (input: T) => R
  ): void {
    ipcMain.handle(channel, (event: IpcMainInvokeEvent, raw: unknown): IpcEnvelope<R> => {
      const parsed = schema.safeParse(raw)
      const command = NodeExecuteCommandSchema.safeParse(raw)
      const context = {
        traceId: command.success ? command.data.traceId : newTraceId(),
        spanId: newSpanId(),
        parentSpanId: command.success ? command.data.spanId : undefined,
        ...(parsed.success ? { projectId: parsed.data.projectId } : {}),
        ...(parsed.success && parsed.data.nodeId ? { nodeId: parsed.data.nodeId } : {}),
        ...(command.success
          ? { nodeId: command.data.targetNodeId, taskId: command.data.taskId }
          : {})
      }
      const active = window()
      const authorized =
        active &&
        !active.isDestroyed() &&
        event.sender === active.webContents &&
        event.senderFrame === event.sender.mainFrame
      if (authorized && parsed.success && parsed.data.commandId) {
        try {
          const stored = ledger.diagnostics({
            projectId: parsed.data.projectId,
            commandId: parsed.data.commandId
          })
          Object.assign(context, {
            traceId: stored.traceId,
            parentSpanId: stored.spanId,
            taskId: stored.taskId,
            nodeId: stored.targetNodeId,
            runId: stored.runId,
            nodeExecutionId: stored.nodeExecutionId
          })
        } catch {
          /* First prepare or invalid lookup still has its own start/terminal. */
        }
      }
      const attributes = { phase, ...(parsed.success ? { commandId: parsed.data.commandId } : {}) }
      const started = performance.now()
      emitGatewayEvent('command.operation.started', '执行命令操作开始', context, { attributes })
      try {
        if (!authorized) throw new FlowCommandError('FLOW_SENDER_REJECTED', 'authorize')
        if (!parsed.success) throw new FlowCommandError('FLOW_INPUT_INVALID', 'validation')
        if (
          ['prepare', 'dispatch', 'admission', 'manual-occupancy'].includes(phase) &&
          activeProjectId !== parsed.data.projectId
        )
          throw new FlowCommandError('FLOW_PROJECT_INACTIVE', 'active-project')
        const data = run(parsed.data)
        const result = data as { state?: string; outputRefs?: Array<{ versionId: string }> } | null
        emitGatewayEvent('command.operation.completed', '执行命令操作完成', context, {
          status: 'success',
          durationMs: Math.round(performance.now() - started),
          attributes: {
            ...attributes,
            state: result?.state,
            versionId: result?.outputRefs?.[0]?.versionId
          }
        })
        return { ok: true, data }
      } catch (error) {
        const code =
          error instanceof FlowCommandError || error instanceof FlowAssetError
            ? error.code
            : 'FLOW_STORAGE_FAILED'
        emitGatewayEvent('command.operation.failed', '执行命令操作失败', context, {
          status: 'failed',
          durationMs: Math.round(performance.now() - started),
          attributes: {
            ...attributes,
            phase:
              error instanceof FlowCommandError
                ? error.phase
                : error instanceof FlowAssetError
                  ? `asset-${error.phase ?? 'input'}`
                  : phase,
            code
          }
        })
        return {
          ok: false,
          error: { code, message: '命令未确认完成，请查看运行记录并核对原命令。' }
        }
      }
    })
  }
  handle(IPC.flowCommands.attach, 'canvas-attach', FlowCanvasSchema, (input) => {
    if (!openProject(input.projectId))
      throw new FlowCommandError('FLOW_PROJECT_MISSING', 'active-project')
    activeProjectId = input.projectId
    return null
  })
  handle(IPC.flowCommands.detach, 'canvas-detach', FlowCanvasSchema, (input) => {
    if (activeProjectId === input.projectId) activeProjectId = null
    return null
  })
  handle(IPC.flowCommands.prepare, 'prepare', NodeExecuteCommandSchema, (input) => {
    const result = ledger.prepare(input)
    if (result.state === 'ready') arm(result.grant)
    return result
  })
  handle(IPC.flowCommands.check, 'admission', CommandLeaseSchema, (input) => {
    ledger.check(input)
    return null
  })
  handle(IPC.flowCommands.availability, 'manual-occupancy', NodeAvailabilitySchema, (input) => {
    ledger.assertNodeAvailable(input)
    return null
  })
  handle(IPC.flowCommands.dispatch, 'dispatch', NodeExecuteCommandSchema, (input) => {
    const result = ledger.prepare(input)
    if (result.state !== 'ready') return result
    arm(result.grant)
    window()!.webContents.send(IPC.flowCommands.grant, result.grant)
    return {
      state: 'pending' as const,
      receipt: ledger.lookup({ projectId: input.projectId, commandId: input.commandId })
    }
  })
  handle(IPC.flowCommands.commit, 'saved-receipt', CommandLookupSchema, (input) =>
    ledger.commit(input)
  )
  handle(IPC.flowCommands.lookup, 'lookup', CommandLookupSchema, (input) => ledger.lookup(input))
  handle(IPC.flowCommands.unknown, 'unknown', CommandLeaseSchema, (input) => ledger.unknown(input))
  handle(IPC.flowCommands.abort, 'not-started', CommandLeaseSchema, (input) =>
    ledger.abortUnstarted(input)
  )
  connect?.({
    ledger,
    isActive: (projectId) => activeProjectId === projectId,
    deliver: async (grant, signal) => {
      if (activeProjectId !== grant.command.projectId || !window() || window()!.isDestroyed())
        throw new FlowCommandError('FLOW_PROJECT_INACTIVE', 'dispatch')
      arm(grant)
      window()!.webContents.send(IPC.flowCommands.grant, grant)
      const deadline = Date.now() + 60000
      while (true) {
        const receipt = ledger.lookup({
          projectId: grant.command.projectId,
          commandId: grant.command.commandId
        })
        if (receipt.state !== 'pending') return
        if (
          signal.aborted ||
          Date.now() >= deadline ||
          activeProjectId !== grant.command.projectId
        ) {
          if (signal.aborted)
            stopAgentVideos(getDb(), grant.command.projectId, grant.command.taskId)
          ledger.unknown({
            projectId: grant.command.projectId,
            commandId: grant.command.commandId,
            leaseId: grant.leaseId
          })
          return
        }
        await new Promise((done) => setTimeout(done, 100))
      }
    }
  })
  return ledger
}
