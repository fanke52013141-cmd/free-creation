// 工作区模板与项目历史版本 IPC：所有持久化由主进程 SQLite 执行。
import { ipcMain } from 'electron'
import { IPC } from '../../shared/contracts'
import type {
  HistorySnapshotRecord,
  GenerationTimingSample,
  ImageGenerationTimingSample,
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
  getImageGenerationTimings,
  getGenerationTimings,
  listHistorySnapshots,
  listWorkflowTemplates,
  renameWorkflowTemplate,
  savePalettePreferences,
  saveHistorySnapshot,
  recordImageGenerationTiming,
  recordGenerationTiming,
  saveWorkflowTemplate,
  updateWorkflowTemplateContent
} from '../store/workspace-state.repo'
import { emitDomainEvent, safeErrorDetail } from '../diagnostics/ipc-domain-events'

function ok<T>(data: T): IpcEnvelope<T> {
  return { ok: true, data }
}

function err(code: string, message: string): IpcEnvelope<never> {
  return { ok: false, error: { code, message } }
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
  // 节点库条目改名（GUI 入口）：与外部 node.library.update 同一个 repo 事务与校验。
  // 正式域事件只记条目 ID 与终态，不记录新旧名称正文（脱敏规则同 project-rename）。
  ipcMain.handle(
    IPC.workspace.renameTemplate,
    (_event, input: { id: string; name: string }): IpcEnvelope<WorkflowTemplateRecord | null> => {
      const entryId = typeof input?.id === 'string' ? input.id : ''
      if (!entryId || !input?.name?.trim()) return err('INVALID_INPUT', '参数不完整')
      emitDomainEvent('workspace.template.rename.started', '节点库条目改名保存开始', {
        attributes: { entryId, operation: 'node-library-rename' }
      })
      try {
        const record = renameWorkflowTemplate(entryId, input.name)
        emitDomainEvent('workspace.template.rename.completed', '节点库条目改名保存完成', {
          status: record ? 'success' : 'skipped',
          attributes: { entryId, operation: 'node-library-rename' }
        })
        return ok(record)
      } catch (error) {
        emitDomainEvent('workspace.template.rename.failed', '节点库条目改名保存失败', {
          status: 'failed',
          error: safeErrorDetail(error),
          attributes: { entryId, operation: 'node-library-rename' }
        })
        return err('RENAME_FAILED', error instanceof Error ? error.message : String(error))
      }
    }
  )
  // 节点库条目内容更新（GUI「编辑节点」入口）：与外部 node.library.replace 同一个
  // repo 写口；事件只记条目 ID 与终态，不记录节点正文/配置（脱敏规则同 rename）。
  ipcMain.handle(
    IPC.workspace.updateTemplate,
    (
      _event,
      input: { id: string; nodes: unknown[]; edges: unknown[]; nodeCount: number }
    ): IpcEnvelope<WorkflowTemplateRecord | null> => {
      const entryId = typeof input?.id === 'string' ? input.id : ''
      if (!entryId || !Array.isArray(input?.nodes)) return err('INVALID_INPUT', '参数不完整')
      emitDomainEvent('workspace.template.update.started', '节点库条目内容更新开始', {
        attributes: { entryId, operation: 'node-library-replace' }
      })
      try {
        const record = updateWorkflowTemplateContent(entryId, {
          nodes: input.nodes,
          edges: input.edges,
          nodeCount: input.nodeCount
        })
        emitDomainEvent('workspace.template.update.completed', '节点库条目内容更新完成', {
          status: record ? 'success' : 'skipped',
          attributes: { entryId, operation: 'node-library-replace' }
        })
        return ok(record)
      } catch (error) {
        emitDomainEvent('workspace.template.update.failed', '节点库条目内容更新失败', {
          status: 'failed',
          error: safeErrorDetail(error),
          attributes: { entryId, operation: 'node-library-replace' }
        })
        return err('UPDATE_FAILED', error instanceof Error ? error.message : String(error))
      }
    }
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
  ipcMain.handle(
    IPC.workspace.recordImageGenerationTiming,
    (_event, input: ImageGenerationTimingSample): IpcEnvelope<ImageGenerationTimingSample[]> =>
      wrap(() => recordImageGenerationTiming(input))
  )
  ipcMain.handle(
    IPC.workspace.getImageGenerationTimings,
    (): IpcEnvelope<ImageGenerationTimingSample[]> => wrap(getImageGenerationTimings)
  )
  ipcMain.handle(
    IPC.workspace.recordGenerationTiming,
    (_event, input: GenerationTimingSample): IpcEnvelope<GenerationTimingSample[]> =>
      wrap(() => recordGenerationTiming(input))
  )
  ipcMain.handle(
    IPC.workspace.getGenerationTimings,
    (): IpcEnvelope<GenerationTimingSample[]> => wrap(getGenerationTimings)
  )
}
