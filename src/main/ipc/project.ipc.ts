// 项目 IPC handlers（信封规范见《技术框架与规范》§10）
import { ipcMain, dialog } from 'electron'
import { IPC } from '../../shared/contracts'
import type { ExportCanvasStructureInput, IpcEnvelope, SaveProjectInput } from '../../shared/contracts'
import type { ProjectFile, ProjectMeta } from '../../shared/types'
import {
  GraphVersionConflictError,
  GraphWriteInProgressError
} from '../../shared/graph-snapshot-sync'
import { getSetting, setSetting } from '../store/db'
import * as repo from '../store/projects.repo'
import { exportProject, importProject } from '../store/transfer'
import {
  exportCanvasStructure,
  importCanvasStructure
} from '../store/canvas-structure-transfer'
import { ProjectFileWatcher } from './project-watcher'

function ok<T>(data: T): IpcEnvelope<T> {
  return { ok: true, data }
}

function err(code: string, message: string): IpcEnvelope<never> {
  return { ok: false, error: { code, message } }
}

export function registerProjectIpc(watcher?: ProjectFileWatcher): void {
  ipcMain.handle(IPC.app.bootstrap, (): IpcEnvelope<{ lastProjectId: string | null }> => {
    return ok({ lastProjectId: getSetting('lastProjectId') })
  })

  ipcMain.handle(IPC.project.list, (): IpcEnvelope<ProjectMeta[]> => {
    return ok(repo.listProjects())
  })

  ipcMain.handle(IPC.project.create, (_e, name: string): IpcEnvelope<ProjectMeta> => {
    if (!name || !name.trim()) return err('INVALID_NAME', '项目名不能为空')
    return ok(repo.createProject(name.trim()))
  })

  ipcMain.handle(
    IPC.project.rename,
    (_e, input: { id: string; name: string }): IpcEnvelope<ProjectMeta | null> => {
      if (!input?.id || !input?.name?.trim()) return err('INVALID_INPUT', '参数不完整')
      return ok(repo.renameProject(input.id, input.name.trim()))
    }
  )

  ipcMain.handle(IPC.project.remove, (_e, id: string): IpcEnvelope<boolean> => {
    if (!id) return err('INVALID_INPUT', '参数不完整')
    return ok(repo.deleteProject(id))
  })

  ipcMain.handle(IPC.project.open, (_e, id: string): IpcEnvelope<ProjectFile | null> => {
    const file = repo.openProject(id)
    if (file) {
      setSetting('lastProjectId', id)
      watcher?.startWatching(id)
    } else {
      setSetting('lastProjectId', '')
      watcher?.stopWatching()
    }
    return ok(file)
  })

  ipcMain.handle(
    IPC.project.save,
    (_e, input: SaveProjectInput): IpcEnvelope<{ graphVersion: number } | null> => {
      if (!input?.id) return err('INVALID_INPUT', '参数不完整')
      try {
        const result = repo.saveProject(input)
        if (result) watcher?.notifySelfSave(result.graphVersion)
        return ok(result)
      } catch (e) {
        if (e instanceof GraphVersionConflictError) {
          return err('REVISION_CONFLICT', e.message)
        }
        if (e instanceof GraphWriteInProgressError) {
          return err('REVISION_CONFLICT', '项目正在被另一项写入操作更新，请稍后重试')
        }
        return err('SAVE_FAILED', e instanceof Error ? e.message : String(e))
      }
    }
  )

  ipcMain.handle(IPC.project.close, (): IpcEnvelope<true> => {
    setSetting('lastProjectId', '')
    watcher?.stopWatching()
    return ok(true)
  })

  // 导出项目到用户选择的 .canvasbundle 文件
  ipcMain.handle(
    IPC.project.export,
    async (_e, input: { id: string; name?: string }): Promise<IpcEnvelope<{ path: string }>> => {
      if (!input?.id) return err('INVALID_INPUT', '参数不完整')
      const result = await dialog.showSaveDialog({
        title: '导出项目',
        defaultPath: `${input.name || 'project'}.canvasbundle`,
        filters: [{ name: 'Canvas Studio 项目备份', extensions: ['canvasbundle'] }]
      })
      if (result.canceled || !result.filePath) return err('CANCELLED', '已取消导出')
      try {
        const path = exportProject(input.id, result.filePath)
        return ok({ path })
      } catch (e) {
        return err('EXPORT_FAILED', e instanceof Error ? e.message : String(e))
      }
    }
  )

  // 从 .canvasbundle 文件导入项目
  ipcMain.handle(IPC.project.import, async (): Promise<IpcEnvelope<ProjectMeta>> => {
    const result = await dialog.showOpenDialog({
      title: '导入项目备份',
      properties: ['openFile'],
      filters: [{ name: 'Canvas Studio 项目备份', extensions: ['canvasbundle'] }]
    })
    if (result.canceled || result.filePaths.length === 0) return err('CANCELLED', '已取消导入')
    try {
      const meta = importProject(result.filePaths[0])
      return ok(meta as ProjectMeta)
    } catch (e) {
      return err('IMPORT_FAILED', e instanceof Error ? e.message : String(e))
    }
  })

  ipcMain.handle(
    IPC.project.exportStructure,
    async (_e, input: ExportCanvasStructureInput): Promise<IpcEnvelope<{ path: string; nodeCount: number }>> => {
      if (!input?.id || !input.name || !input.snapshot || !input.graph) {
        return err('INVALID_INPUT', '画布结构参数不完整')
      }
      const defaultName = input.name.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '-').slice(0, 100)
      const result = await dialog.showSaveDialog({
        title: '导出画布结构',
        defaultPath: `${defaultName || '画布'}.canvasflow`,
        filters: [{ name: 'Canvas Studio 画布结构', extensions: ['canvasflow'] }]
      })
      if (result.canceled || !result.filePath) return err('CANCELLED', '已取消导出')
      try {
        return ok(exportCanvasStructure(result.filePath, input))
      } catch (error) {
        return err('EXPORT_FAILED', error instanceof Error ? error.message : String(error))
      }
    }
  )

  ipcMain.handle(IPC.project.importStructure, async (): Promise<IpcEnvelope<ProjectMeta>> => {
    const result = await dialog.showOpenDialog({
      title: '导入画布结构',
      properties: ['openFile'],
      filters: [{ name: 'Canvas Studio 画布结构', extensions: ['canvasflow'] }]
    })
    if (result.canceled || result.filePaths.length === 0) return err('CANCELLED', '已取消导入')
    try {
      return ok(importCanvasStructure(result.filePaths[0]))
    } catch (error) {
      return err('IMPORT_FAILED', error instanceof Error ? error.message : String(error))
    }
  })

  // 同步保存：渲染进程 beforeunload 时用 sendSync 保证落盘后才销毁页面。
  // F02/F03 修复：语义与异步 save 对齐 —— expectedGraphVersion 原样透传，冲突时
  // 返回 REVISION_CONFLICT 信封（含服务端最新版本），由渲染层决定是否接受覆盖。
  // 不再在主进程里剥离乐观锁，也不再把失败伪装成 ok:true。
  ipcMain.on(IPC.project.saveSync, (e, input: SaveProjectInput) => {
    try {
      const result = repo.saveProject(input)
      if (result) watcher?.notifySelfSave(result.graphVersion)
      e.returnValue = ok(result)
    } catch (saveErr) {
      if (saveErr instanceof GraphVersionConflictError) {
        e.returnValue = err('REVISION_CONFLICT', saveErr.message)
      } else if (saveErr instanceof GraphWriteInProgressError) {
        e.returnValue = err('REVISION_CONFLICT', '项目正在被另一项写入操作更新，请稍后重试')
      } else {
        e.returnValue = err(
          'SAVE_FAILED',
          saveErr instanceof Error ? saveErr.message : String(saveErr)
        )
      }
    }
  })
}
