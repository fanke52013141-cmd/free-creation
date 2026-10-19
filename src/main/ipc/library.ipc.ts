import { materializeResource, discardMaterialization } from '../store/library-materialization.repo'
import { listCategories, saveCategory } from '../store/library-categories.repo'
import { dialog, ipcMain } from 'electron'
import { IPC, type IpcEnvelope } from '../../shared/contracts'
import type {
  CreateLibraryCollectionInput,
  CreateLibraryFolderInput,
  RenameLibraryFolderInput,
  CreateLibraryResourceInput,
  CaptureProjectMediaInput,
  CaptureProjectNodesInput,
  LibraryResourceDetail,
  PublishLibraryRevisionInput
} from '../../shared/library/types'
import * as library from '../store/library.repo'
import { emitDomainEvent } from '../diagnostics/ipc-domain-events'
import { existsSync } from 'fs'
import { join } from 'path'
import { getDataDir } from '../store/db'
import { newTraceId, newSpanId } from '../../shared/observability'

function categoryOperation<T>(operation: 'list' | 'save', action: () => T): IpcEnvelope<T> {
  const context = { traceId: newTraceId(), spanId: newSpanId() }
  const attributes = { operation }
  emitDomainEvent('library.category.started', '素材分类操作开始', { context, attributes })
  try {
    const result = action()
    emitDomainEvent('library.category.completed', '素材分类操作完成', {
      context,
      attributes,
      status: 'success'
    })
    return ok(result)
  } catch (error) {
    emitDomainEvent('library.category.failed', '素材分类操作失败', {
      context,
      attributes: {
        ...attributes,
        phase: 'repository',
        code: operation === 'list' ? 'READ_FAILED' : 'SAVE_FAILED'
      },
      status: 'failed',
      // Repository validation can contain private labels. Log only this boundary's fixed code.
      error: Object.assign(new Error('素材分类操作未完成'), {
        code: operation === 'list' ? 'READ_FAILED' : 'SAVE_FAILED'
      })
    })
    return err(operation === 'list' ? 'READ_FAILED' : 'SAVE_FAILED', error)
  }
}

function ok<T>(data: T): IpcEnvelope<T> {
  return { ok: true, data }
}

function err(code: string, error: unknown): IpcEnvelope<never> {
  return {
    ok: false,
    error: { code, message: error instanceof Error ? error.message : String(error) }
  }
}

async function packageTransfer<T>(
  operation: 'import' | 'export',
  selectPath: () => Promise<string | undefined>,
  execute: (path: string) => T
): Promise<IpcEnvelope<T>> {
  const context = { traceId: newTraceId(), spanId: newSpanId() }
  let phase: 'dialog' | 'repository' = 'dialog'
  emitDomainEvent('library.transfer.started', '资产包操作开始', {
    context,
    attributes: { operation }
  })
  try {
    const path = await selectPath()
    if (!path) {
      emitDomainEvent('library.transfer.cancelled', '资产包操作已取消', {
        context,
        status: 'cancelled',
        attributes: { operation, phase }
      })
      return err('CANCELLED', operation === 'export' ? '已取消导出' : '已取消导入')
    }
    phase = 'repository'
    const result = execute(path)
    emitDomainEvent('library.transfer.completed', '资产包操作完成', {
      context,
      status: 'success',
      attributes: { operation }
    })
    return ok(result)
  } catch (error) {
    const code = operation === 'export' ? 'EXPORT_FAILED' : 'IMPORT_FAILED'
    emitDomainEvent('library.transfer.failed', '资产包操作失败', {
      context,
      status: 'failed',
      attributes: { operation, phase, code },
      error: Object.assign(new Error('资产包操作未完成'), { code })
    })
    return err(code, error)
  }
}

export function registerLibraryIpc(): void {
  ipcMain.handle(
    IPC.library.previewFiles,
    (_event, input: { resourceId: string; revisionId: string; componentIds: string[] }) => {
      try {
        const detail = library.getResourceDetail(input.resourceId, input.revisionId)
        if (
          !detail ||
          !Array.isArray(input.componentIds) ||
          new Set(input.componentIds).size !== input.componentIds.length ||
          input.componentIds.some(
            (id) => !detail.components.some((component) => component.id === id)
          )
        )
          throw new Error('资源版本或组件无效')
        const missing = detail.components
          .filter(
            (component) =>
              input.componentIds.includes(component.id) &&
              component.blobPath &&
              !existsSync(join(getDataDir(), component.blobPath))
          )
          .map((component) => component.id)
        emitDomainEvent('library.reuse_preview', '复用文件预检完成', {
          resourceId: input.resourceId,
          status: missing.length ? 'failed' : 'success',
          attributes: { missingCount: missing.length }
        })
        return ok({ missingComponentIds: missing })
      } catch {
        emitDomainEvent('library.reuse_preview', '复用文件预检失败', { status: 'failed' })
        return err('PREVIEW_FAILED', '资源文件预检失败')
      }
    }
  )
  ipcMain.handle(IPC.library.listCategories, () => {
    return categoryOperation('list', () => listCategories())
  })
  ipcMain.handle(IPC.library.saveCategory, (_event, input) => {
    return categoryOperation('save', () => saveCategory(input))
  })
  ipcMain.handle(IPC.library.discardMaterialization, async (_event, input) => {
    try {
      return ok(await discardMaterialization(input))
    } catch (error) {
      return err('DISCARD_FAILED', error)
    }
  })
  ipcMain.handle(IPC.library.search, (_event, input) => {
    try {
      return ok(library.searchResources(input))
    } catch (error) {
      return err('SEARCH_FAILED', error)
    }
  })
  ipcMain.handle(
    IPC.library.detail,
    (
      _event,
      input: { resourceId: string; revisionId?: string }
    ): IpcEnvelope<LibraryResourceDetail | null> => {
      if (!input?.resourceId) return err('INVALID_INPUT', '资源 ID 不完整')
      try {
        return ok(library.getResourceDetail(input.resourceId, input.revisionId))
      } catch (error) {
        return err('READ_FAILED', error)
      }
    }
  )
  ipcMain.handle(
    IPC.library.create,
    (_event, input: CreateLibraryResourceInput): IpcEnvelope<LibraryResourceDetail> => {
      try {
        return ok(library.createResource(input))
      } catch (error) {
        return err('CREATE_FAILED', error)
      }
    }
  )
  ipcMain.handle(
    IPC.library.captureProjectMedia,
    (_event, input: CaptureProjectMediaInput): IpcEnvelope<LibraryResourceDetail> => {
      try {
        const result = library.captureProjectMedia(input)
        emitDomainEvent('library.materialization_completed', '项目媒体已采集入库', {
          status: 'success',
          resourceId: result?.id
        })
        return ok(result)
      } catch (error) {
        emitDomainEvent('library.materialization_failed', '项目媒体采集失败', { error })
        return err('CAPTURE_FAILED', error)
      }
    }
  )
  ipcMain.handle(
    IPC.library.captureProjectNodes,
    (_event, input: CaptureProjectNodesInput): IpcEnvelope<LibraryResourceDetail> => {
      try {
        return ok(library.captureProjectNodes(input))
      } catch (error) {
        return err('CAPTURE_FAILED', error)
      }
    }
  )
  ipcMain.handle(
    IPC.library.publishRevision,
    (_event, input: PublishLibraryRevisionInput): IpcEnvelope<LibraryResourceDetail> => {
      try {
        const result = library.publishRevision(input)
        emitDomainEvent('library.revision_published', '素材修订已发布', {
          status: 'success',
          resourceId: input?.resourceId
        })
        return ok(result)
      } catch (error) {
        emitDomainEvent('library.mutation_failed', '素材修订发布失败', {
          error,
          resourceId: input?.resourceId
        })
        return err('REVISION_FAILED', error)
      }
    }
  )
  ipcMain.handle(
    IPC.library.archive,
    (_event, input: { resourceId: string; archived: boolean }) => {
      if (!input?.resourceId || typeof input.archived !== 'boolean')
        return err('INVALID_INPUT', '归档参数不完整')
      try {
        return ok(library.archiveResource(input.resourceId, input.archived))
      } catch (error) {
        return err('ARCHIVE_FAILED', error)
      }
    }
  )
  ipcMain.handle(IPC.library.listCollections, () => {
    try {
      return ok(library.listCollections())
    } catch (error) {
      return err('READ_FAILED', error)
    }
  })
  ipcMain.handle(IPC.library.createCollection, (_event, input: CreateLibraryCollectionInput) => {
    try {
      return ok(library.createCollection(input))
    } catch (error) {
      return err('CREATE_FAILED', error)
    }
  })
  ipcMain.handle(
    IPC.library.setCollections,
    (_event, input: { resourceId: string; collectionIds: string[] }) => {
      if (!input?.resourceId || !Array.isArray(input.collectionIds))
        return err('INVALID_INPUT', '收藏集参数不完整')
      try {
        return ok(library.setResourceCollections(input))
      } catch (error) {
        return err('UPDATE_FAILED', error)
      }
    }
  )
  ipcMain.handle(IPC.library.listFolders, () => {
    try {
      return ok(library.listFolders())
    } catch (error) {
      return err('READ_FAILED', error)
    }
  })
  ipcMain.handle(IPC.library.createFolder, (_event, input: CreateLibraryFolderInput) => {
    try {
      return ok(library.createFolder(input))
    } catch (error) {
      return err('CREATE_FAILED', error)
    }
  })
  ipcMain.handle(IPC.library.renameFolder, (_event, input: RenameLibraryFolderInput) => {
    try {
      return ok(library.renameFolder(input))
    } catch (error) {
      return err('RENAME_FAILED', error)
    }
  })
  ipcMain.handle(IPC.library.deleteFolder, (_event, folderId: string) => {
    if (!folderId) return err('INVALID_INPUT', '文件夹 ID 不完整')
    try {
      return ok(library.deleteFolder(folderId))
    } catch (error) {
      return err('DELETE_FAILED', error)
    }
  })
  ipcMain.handle(
    IPC.library.setResourceFolder,
    (_event, input: { resourceId: string; folderId?: string | null }) => {
      if (!input?.resourceId) return err('INVALID_INPUT', '资源 ID 不完整')
      try {
        return ok(library.setResourceFolder(input))
      } catch (error) {
        return err('UPDATE_FAILED', error)
      }
    }
  )
  ipcMain.handle(IPC.library.listBoards, () => {
    try {
      return ok(library.listBoards())
    } catch (error) {
      return err('READ_FAILED', error)
    }
  })
  ipcMain.handle(
    IPC.library.createBoard,
    (_event, input: { title: string; description?: string }) => {
      try {
        return ok(library.createBoard(input))
      } catch (error) {
        return err('CREATE_FAILED', error)
      }
    }
  )
  ipcMain.handle(IPC.library.getBoardItems, (_event, boardId: string) => {
    if (!boardId) return err('INVALID_INPUT', '展板 ID 不完整')
    try {
      return ok(library.getBoardItems(boardId))
    } catch (error) {
      return err('READ_FAILED', error)
    }
  })
  ipcMain.handle(IPC.library.saveBoard, (_event, input) => {
    if (!input?.boardId || !Array.isArray(input.items))
      return err('INVALID_INPUT', '展板内容不完整')
    try {
      return ok(library.saveBoard(input))
    } catch (error) {
      return err('SAVE_FAILED', error)
    }
  })
  ipcMain.handle(IPC.library.materialize, async (_event, input) => {
    if (
      !input?.projectId ||
      !input.resourceId ||
      !input.revisionId ||
      !Array.isArray(input.componentIds)
    ) {
      return err('INVALID_INPUT', '资源使用参数不完整')
    }
    try {
      return ok(await materializeResource(input))
    } catch (error) {
      return err('MATERIALIZE_FAILED', error)
    }
  })
  ipcMain.handle(IPC.library.export, async (_event, input: { resourceIds?: string[] }) => {
    return packageTransfer(
      'export',
      async () => {
        const result = await dialog.showSaveDialog({
          title: '导出资产包',
          defaultPath: 'Canvas Studio 资产包.canvaslib',
          filters: [{ name: 'Canvas Studio 资产包', extensions: ['canvaslib'] }]
        })
        return result.canceled ? undefined : result.filePath
      },
      (path) => ({ path: library.exportResourcePackage(path, input?.resourceIds) })
    )
  })
  ipcMain.handle(IPC.library.import, async () => {
    return packageTransfer(
      'import',
      async () => {
        const result = await dialog.showOpenDialog({
          title: '导入资产包',
          properties: ['openFile'],
          filters: [{ name: 'Canvas Studio 资产包', extensions: ['canvaslib'] }]
        })
        return result.canceled ? undefined : result.filePaths[0]
      },
      (path) => ({ imported: library.importResourcePackage(path) })
    )
  })
}
