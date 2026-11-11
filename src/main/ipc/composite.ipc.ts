import { ipcMain } from 'electron'
import { IPC } from '../../shared/contracts'
import type { IpcEnvelope } from '../../shared/contracts'
import type {
  CompositeCapabilitySummary,
  CompositeDraftRecord,
  CompositeDraftSaveInput,
  CompositePublishInput,
  CompositeSearchInput,
  CompositeVersionRecord
} from '../../shared/composite/types'
import { validateCompositeManifest } from '../../shared/composite/validate'
import type { CompositeValidationResult } from '../../shared/composite/validate'
import {
  archiveCompositeCapability,
  listCompositeVersions,
  getCompositeDraft,
  getCompositeVersion,
  listCompositeCapabilities,
  publishCompositeVersion,
  saveCompositeDraft,
  verifyCompositeVersion
} from '../store/composite.repo'
import {
  createCompositeRun,
  finishCompositeRun,
  getCompositeRun,
  listCompositeRuns,
  recordCompositeRunStep
} from '../store/composite-run.repo'
import {
  compositeErrorCode
} from '../../shared/composite/errors'
import { emitGatewayEvent } from '../diagnostics/gateway-events'
import { previewCompositeUpgrade, findCompositeReferences, deleteCompositeCapabilityChecked } from '../agent-access/composite-ops'
import { newSpanId } from '../../shared/observability'
import type { GatewayDiagnosticsContext } from '../../shared/contracts'

function ok<T>(data: T): IpcEnvelope<T> {
  return { ok: true, data }
}

function failure(error: unknown): IpcEnvelope<never> {
  return {
    ok: false,
    error: {
      code: compositeErrorCode(error, 'COMPOSITE_ERROR'),
      message: error instanceof Error ? error.message : String(error)
    }
  }
}

/**
 * 运行事件上下文：以节点流 runId 作 traceId，实例节点与项目用于定位；
 * 不携带错误正文、输入正文或媒体路径。
 */
function runDiagnostics(runId: string): GatewayDiagnosticsContext {
  const record = getCompositeRun(runId)?.run
  return {
    traceId: runId,
    spanId: newSpanId(),
    ...(record?.projectId ? { projectId: record.projectId } : {}),
    ...(record?.instanceNodeId ? { nodeId: record.instanceNodeId } : {})
  }
}

export function registerCompositeIpc(): void {
  ipcMain.handle(
    IPC.composite.runStart,
    (_event, input: Parameters<typeof createCompositeRun>[0]): IpcEnvelope<unknown> => {
      try {
        const record = createCompositeRun(input)
        emitGatewayEvent(
          'composite.run.started',
          '节点流运行开始',
          {
            traceId: record.id,
            spanId: newSpanId(),
            projectId: record.projectId,
            ...(record.instanceNodeId ? { nodeId: record.instanceNodeId } : {})
          },
          {
            phase: 'run',
            attributes: {
              capabilityId: record.capabilityId,
              capabilityVersion: record.capabilityVersion,
              ...(record.parentRunId ? { parentRunId: record.parentRunId } : {}),
              ...(record.instanceNodeId ? { instanceNodeId: record.instanceNodeId } : {})
            }
          }
        )
        return ok(record)
      } catch (error) {
        return failure(error)
      }
    }
  )
  ipcMain.handle(
    IPC.composite.runStep,
    (_event, input: Parameters<typeof recordCompositeRunStep>[0]): IpcEnvelope<boolean> => {
      try {
        recordCompositeRunStep(input)
        if (input.status === 'failed') {
          const context = runDiagnostics(input.runId)
          emitGatewayEvent(
            'composite.run.step_failed',
            '节点流内部步骤失败',
            context,
            {
              phase: 'step',
              attributes: {
                code: 'STEP_FAILED',
                stepKey: input.stepKey,
                nodeType: input.nodeType
              }
            }
          )
        }
        return ok(true)
      } catch (error) {
        return failure(error)
      }
    }
  )
  ipcMain.handle(
    IPC.composite.runFinish,
    (_event, input: Parameters<typeof finishCompositeRun>[0]): IpcEnvelope<boolean> => {
      try {
        const changed = finishCompositeRun(input)
        if (changed) {
          const context = runDiagnostics(input.runId)
          const record = getCompositeRun(input.runId)?.run
          const event =
            input.status === 'completed'
              ? 'composite.run.completed'
              : input.status === 'cancelled'
                ? 'composite.run.cancelled'
                : 'composite.run.failed'
          emitGatewayEvent(event, input.status === 'completed' ? '节点流运行完成' : '节点流运行结束', context, {
            phase: input.failurePhase ?? 'run',
            attributes: {
              ...(input.errorCode ? { code: input.errorCode } : {}),
              ...(record?.capabilityId ? { capabilityId: record.capabilityId } : {}),
              ...(record?.capabilityVersion
                ? { capabilityVersion: record.capabilityVersion }
                : {}),
              outputPortCount: input.outputPorts?.length ?? 0
            }
          })
        }
        return ok(changed)
      } catch (error) {
        return failure(error)
      }
    }
  )
  ipcMain.handle(
    IPC.composite.runGet,
    (_event, runId: string): IpcEnvelope<unknown> => {
      try {
        return ok(getCompositeRun(runId ?? ''))
      } catch (error) {
        return failure(error)
      }
    }
  )
  ipcMain.handle(
    IPC.composite.runList,
    (_event, input: { projectId: string; limit?: number }): IpcEnvelope<unknown> => {
      try {
        return ok(listCompositeRuns(input?.projectId ?? '', input?.limit))
      } catch (error) {
        return failure(error)
      }
    }
  )

  ipcMain.handle(
    IPC.composite.search,
    (_event, input: CompositeSearchInput = {}): IpcEnvelope<CompositeCapabilitySummary[]> => {
      try {
        return ok(listCompositeCapabilities(input))
      } catch (error) {
        return failure(error)
      }
    }
  )
  ipcMain.handle(
    IPC.composite.draftGet,
    (_event, capabilityId: string): IpcEnvelope<CompositeDraftRecord | null> => {
      try {
        return ok(getCompositeDraft(capabilityId ?? ''))
      } catch (error) {
        return failure(error)
      }
    }
  )
  ipcMain.handle(
    IPC.composite.draftSave,
    async (_event, input: CompositeDraftSaveInput): Promise<IpcEnvelope<CompositeDraftRecord>> => {
      try {
        return ok(await saveCompositeDraft(input?.manifest, input?.expectedRevision))
      } catch (error) {
        return failure(error)
      }
    }
  )
  ipcMain.handle(
    IPC.composite.validate,
    (_event, input: { manifest: unknown }): IpcEnvelope<CompositeValidationResult> => {
      try {
        return ok(validateCompositeManifest(input?.manifest))
      } catch (error) {
        return failure(error)
      }
    }
  )
  ipcMain.handle(
    IPC.composite.publish,
    async (
      _event,
      input: CompositePublishInput
    ): Promise<IpcEnvelope<{ record: CompositeVersionRecord; created: boolean }>> => {
      try {
        return ok(
          await publishCompositeVersion(input?.manifest, {
            publishedBy: input?.publishedBy,
            expectedRevision: input?.expectedRevision
          })
        )
      } catch (error) {
        return failure(error)
      }
    }
  )
  ipcMain.handle(
    IPC.composite.versionGet,
    (
      _event,
      input: { capabilityId: string; version: string }
    ): IpcEnvelope<CompositeVersionRecord | null> => {
      try {
        return ok(getCompositeVersion(input?.capabilityId ?? '', input?.version ?? ''))
      } catch (error) {
        return failure(error)
      }
    }
  )
  ipcMain.handle(
    IPC.composite.versionList,
    (_event, capabilityId: string): IpcEnvelope<unknown> => {
      try {
        return ok(listCompositeVersions(capabilityId ?? ''))
      } catch (error) {
        return failure(error)
      }
    }
  )
  ipcMain.handle(
    IPC.composite.archive,
    (_event, input: { capabilityId: string; archived?: boolean }): IpcEnvelope<boolean> => {
      try {
        return ok(archiveCompositeCapability(input?.capabilityId ?? '', input?.archived ?? true))
      } catch (error) {
        return failure(error)
      }
    }
  )
  // W3：GUI 删除前引用检查与 CLI/MCP composite.references 共用同一实现。
  ipcMain.handle(
    IPC.composite.references,
    (_event, input: { capabilityId: string }): IpcEnvelope<unknown> => {
      try {
        return ok(findCompositeReferences(input?.capabilityId ?? ''))
      } catch (error) {
        return failure(error)
      }
    }
  )
  // W3：GUI 物理删除与 CLI/MCP composite.delete 共用同一引用保护。
  ipcMain.handle(
    IPC.composite.delete,
    (_event, input: { capabilityId: string }): IpcEnvelope<unknown> => {
      try {
        return ok(deleteCompositeCapabilityChecked(input?.capabilityId ?? ''))
      } catch (error) {
        return failure(error)
      }
    }
  )
  ipcMain.handle(
    IPC.composite.verify,
    async (
      _event,
      input: { capabilityId: string; version: string }
    ): Promise<IpcEnvelope<{ ok: boolean; reason?: string }>> => {
      try {
        return ok(await verifyCompositeVersion(input?.capabilityId ?? '', input?.version ?? ''))
      } catch (error) {
        return failure(error)
      }
    }
  )
  // W3：GUI 升级预检与 CLI/MCP composite.upgrade.preview 共用同一实现。
  ipcMain.handle(
    IPC.composite.upgradePreview,
    (
      _event,
      input: { projectId: string; nodeId: string; nextManifest: unknown }
    ): IpcEnvelope<unknown> => {
      try {
        const preview = previewCompositeUpgrade(
          input?.projectId ?? '',
          input?.nodeId ?? '',
          input?.nextManifest
        )
        return ok({
          previousVersion: preview.previousVersion,
          nextVersion: preview.nextVersion,
          ok: preview.ok,
          ...(preview.runtimeVersion !== undefined ? { runtimeVersion: preview.runtimeVersion } : {}),
          ...(preview.issues ? { issues: preview.issues } : {}),
          impact: preview.impact
        })
      } catch (error) {
        return failure(error)
      }
    }
  )
}
