import { materializeResource, discardMaterialization } from '../store/library-materialization.repo'
import { listCategories, saveCategory } from '../store/library-categories.repo'
import { dialog, ipcMain } from 'electron'
import { IPC, type IpcEnvelope } from '../../shared/contracts'
import type {
  CreateLibraryCollectionInput,
  CreateLibraryResourceInput,
  CaptureProjectMediaInput,
  LibraryResourceDetail,
  PublishLibraryRevisionInput
} from '../../shared/library/types'
import * as library from '../store/library.repo'

function ok<T>(data: T): IpcEnvelope<T> {
  return { ok: true, data }
}

function err(code: string, error: unknown): IpcEnvelope<never> {
  return { ok: false, error: { code, message: error instanceof Error ? error.message : String(error) } }
}

export function registerLibraryIpc(): void {
  ipcMain.handle(IPC.library.listCategories, () => {
    try { return ok(listCategories()) } catch (error) { return err('READ_FAILED', error) }
  })
  ipcMain.handle(IPC.library.saveCategory, (_event, input) => {
    try { return ok(saveCategory(input)) } catch (error) { return err('SAVE_FAILED', error) }
  })
  ipcMain.handle(IPC.library.discardMaterialization, async (_event, input) => {
    try { return ok(await discardMaterialization(input)) } catch (error) { return err('DISCARD_FAILED', error) }
  })
  ipcMain.handle(IPC.library.search, (_event, input) => {
    try { return ok(library.searchResources(input)) } catch (error) { return err('SEARCH_FAILED', error) }
  })
  ipcMain.handle(IPC.library.detail, (_event, input: { resourceId: string; revisionId?: string }): IpcEnvelope<LibraryResourceDetail | null> => {
    if (!input?.resourceId) return err('INVALID_INPUT', '资源 ID 不完整')
    try { return ok(library.getResourceDetail(input.resourceId, input.revisionId)) } catch (error) { return err('READ_FAILED', error) }
  })
  ipcMain.handle(IPC.library.create, (_event, input: CreateLibraryResourceInput): IpcEnvelope<LibraryResourceDetail> => {
    try { return ok(library.createResource(input)) } catch (error) { return err('CREATE_FAILED', error) }
  })
  ipcMain.handle(IPC.library.captureProjectMedia, (_event, input: CaptureProjectMediaInput): IpcEnvelope<LibraryResourceDetail> => {
    try { return ok(library.captureProjectMedia(input)) } catch (error) { return err('CAPTURE_FAILED', error) }
  })
  ipcMain.handle(IPC.library.publishRevision, (_event, input: PublishLibraryRevisionInput): IpcEnvelope<LibraryResourceDetail> => {
    try { return ok(library.publishRevision(input)) } catch (error) { return err('REVISION_FAILED', error) }
  })
  ipcMain.handle(IPC.library.archive, (_event, input: { resourceId: string; archived: boolean }) => {
    if (!input?.resourceId || typeof input.archived !== 'boolean') return err('INVALID_INPUT', '归档参数不完整')
    try { return ok(library.archiveResource(input.resourceId, input.archived)) } catch (error) { return err('ARCHIVE_FAILED', error) }
  })
  ipcMain.handle(IPC.library.listCollections, () => {
    try { return ok(library.listCollections()) } catch (error) { return err('READ_FAILED', error) }
  })
  ipcMain.handle(IPC.library.createCollection, (_event, input: CreateLibraryCollectionInput) => {
    try { return ok(library.createCollection(input)) } catch (error) { return err('CREATE_FAILED', error) }
  })
  ipcMain.handle(IPC.library.setCollections, (_event, input: { resourceId: string; collectionIds: string[] }) => {
    if (!input?.resourceId || !Array.isArray(input.collectionIds)) return err('INVALID_INPUT', '收藏集参数不完整')
    try { return ok(library.setResourceCollections(input)) } catch (error) { return err('UPDATE_FAILED', error) }
  })
  ipcMain.handle(IPC.library.listBoards, () => {
    try { return ok(library.listBoards()) } catch (error) { return err('READ_FAILED', error) }
  })
  ipcMain.handle(IPC.library.createBoard, (_event, input: { title: string; description?: string }) => {
    try { return ok(library.createBoard(input)) } catch (error) { return err('CREATE_FAILED', error) }
  })
  ipcMain.handle(IPC.library.getBoardItems, (_event, boardId: string) => {
    if (!boardId) return err('INVALID_INPUT', '展板 ID 不完整')
    try { return ok(library.getBoardItems(boardId)) } catch (error) { return err('READ_FAILED', error) }
  })
  ipcMain.handle(IPC.library.saveBoard, (_event, input) => {
    if (!input?.boardId || !Array.isArray(input.items)) return err('INVALID_INPUT', '展板内容不完整')
    try { return ok(library.saveBoard(input)) } catch (error) { return err('SAVE_FAILED', error) }
  })
  ipcMain.handle(IPC.library.materialize, async (_event, input) => {
    if (!input?.projectId || !input.resourceId || !input.revisionId || !Array.isArray(input.componentIds)) {
      return err('INVALID_INPUT', '资源使用参数不完整')
    }
    try { return ok(await materializeResource(input)) } catch (error) { return err('MATERIALIZE_FAILED', error) }
  })
  ipcMain.handle(IPC.library.export, async (_event, input: { resourceIds?: string[] }) => {
    const result = await dialog.showSaveDialog({
      title: '导出资源库',
      defaultPath: 'Canvas Studio 资源库.canvaslib',
      filters: [{ name: 'Canvas Studio 资源包', extensions: ['canvaslib'] }]
    })
    if (result.canceled || !result.filePath) return err('CANCELLED', '已取消导出')
    try { return ok({ path: library.exportResourcePackage(result.filePath, input?.resourceIds) }) } catch (error) { return err('EXPORT_FAILED', error) }
  })
  ipcMain.handle(IPC.library.import, async () => {
    const result = await dialog.showOpenDialog({
      title: '导入资源包',
      properties: ['openFile'],
      filters: [{ name: 'Canvas Studio 资源包', extensions: ['canvaslib'] }]
    })
    if (result.canceled || result.filePaths.length === 0) return err('CANCELLED', '已取消导入')
    try { return ok({ imported: library.importResourcePackage(result.filePaths[0]) }) } catch (error) { return err('IMPORT_FAILED', error) }
  })
}
