// 工作区模板与项目历史版本 IPC：所有持久化由主进程 SQLite 执行。
import { ipcMain } from 'electron'
import { IPC } from '../../shared/contracts'
import type {
  HistorySnapshotRecord,
  IpcEnvelope,
  PalettePreferences,
  SaveHistorySnapshotInput,
  SaveWorkflowTemplateInput,
  WorkflowTemplateRecord
} from '../../shared/contracts'
import {
  deleteHistorySnapshot,
  deleteWorkflowTemplate,
  getPalettePreferences,
  listHistorySnapshots,
  listWorkflowTemplates,
  savePalettePreferences,
  saveHistorySnapshot,
  saveWorkflowTemplate
} from '../store/workspace-state.repo'

function ok<T>(data: T): IpcEnvelope<T> {
  return { ok: true, data }
}

function wrap<T>(fn: () => T): IpcEnvelope<T> {
  try {
    return ok(fn())
  } catch (error) {
    return {
      ok: false,
      error: {
        code: 'WORKSPACE_STATE_ERROR',
        message: error instanceof Error ? error.message : String(error)
      }
    }
  }
}

export function registerWorkspaceStateIpc(): void {
  ipcMain.handle(IPC.workspace.listTemplates, (): IpcEnvelope<WorkflowTemplateRecord[]> =>
    wrap(listWorkflowTemplates)
  )
  ipcMain.handle(
    IPC.workspace.saveTemplate,
    (_event, input: SaveWorkflowTemplateInput): IpcEnvelope<WorkflowTemplateRecord> =>
      wrap(() => saveWorkflowTemplate(input))
  )
  ipcMain.handle(IPC.workspace.deleteTemplate, (_event, id: string): IpcEnvelope<boolean> =>
    wrap(() => deleteWorkflowTemplate(id ?? ''))
  )
  ipcMain.handle(
    IPC.workspace.listSnapshots,
    (_event, projectId: string): IpcEnvelope<HistorySnapshotRecord[]> =>
      wrap(() => listHistorySnapshots(projectId ?? ''))
  )
  ipcMain.handle(
    IPC.workspace.saveSnapshot,
    (_event, input: SaveHistorySnapshotInput): IpcEnvelope<HistorySnapshotRecord> =>
      wrap(() => saveHistorySnapshot(input))
  )
  ipcMain.handle(
    IPC.workspace.deleteSnapshot,
    (_event, input: { projectId: string; id: string }): IpcEnvelope<boolean> =>
      wrap(() => deleteHistorySnapshot(input?.projectId ?? '', input?.id ?? ''))
  )
  ipcMain.handle(IPC.workspace.getPalettePreferences, (): IpcEnvelope<PalettePreferences> =>
    wrap(getPalettePreferences)
  )
  ipcMain.handle(
    IPC.workspace.savePalettePreferences,
    (_event, input: PalettePreferences): IpcEnvelope<PalettePreferences> =>
      wrap(() => savePalettePreferences(input))
  )
}
