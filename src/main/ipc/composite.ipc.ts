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

function ok<T>(data: T): IpcEnvelope<T> {
  return { ok: true, data }
}

function failure(error: unknown): IpcEnvelope<never> {
  return {
    ok: false,
    error: {
      code: 'COMPOSITE_ERROR',
      message: error instanceof Error ? error.message : String(error)
    }
  }
}

export function registerCompositeIpc(): void {
  ipcMain.handle(
    IPC.composite.runStart,
    (_event, input: Parameters<typeof createCompositeRun>[0]): IpcEnvelope<unknown> => {
      try {
        return ok(createCompositeRun(input))
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
        finishCompositeRun(input)
        return ok(true)
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
        return ok(await publishCompositeVersion(input?.manifest, input?.publishedBy))
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
}
