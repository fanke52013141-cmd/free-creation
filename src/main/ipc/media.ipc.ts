// 媒体 IPC：拖拽导入 + 系统对话框选择导入（见《技术框架与规范》§10）
import { ipcMain, dialog } from 'electron'
import { IPC } from '../../shared/contracts'
import type { IpcEnvelope } from '../../shared/contracts'
import type { MediaAsset, MediaImportError, MediaImportResult } from '../../shared/types'
import { deleteMedia, importMedia, listMedia } from '../store/media.repo'

function ok<T>(data: T): IpcEnvelope<T> {
  return { ok: true, data }
}

function err(code: string, message: string): IpcEnvelope<never> {
  return { ok: false, error: { code, message } }
}

const MEDIA_FILTERS = [
  {
    name: '媒体文件',
    extensions: [
      'png',
      'jpg',
      'jpeg',
      'webp',
      'gif',
      'bmp',
      'svg',
      'mp4',
      'webm',
      'mov',
      'mkv',
      'mp3',
      'wav',
      'ogg',
      'm4a',
      'flac',
      'aac',
      'txt',
      'md',
      'json'
    ]
  }
]

async function importAll(projectId: string, paths: string[]): Promise<MediaImportResult> {
  const assets: MediaAsset[] = []
  const errors: MediaImportError[] = []
  for (const p of paths) {
    const r = await importMedia(projectId, p)
    if (r.ok) assets.push(r.asset)
    else errors.push({ path: p, reason: r.reason })
  }
  return { assets, errors }
}

export function registerMediaIpc(): void {
  ipcMain.handle(
    IPC.media.import,
    async (
      _e,
      input: { projectId: string; paths: string[] }
    ): Promise<IpcEnvelope<MediaImportResult>> => {
      if (!input?.projectId || !Array.isArray(input.paths))
        return err('INVALID_INPUT', '参数不完整')
      return ok(await importAll(input.projectId, input.paths))
    }
  )

  ipcMain.handle(
    IPC.media.pick,
    async (_e, projectId: string): Promise<IpcEnvelope<MediaImportResult>> => {
      if (!projectId) return err('INVALID_INPUT', '参数不完整')
      const result = await dialog.showOpenDialog({
        title: '选择要上传的文件',
        properties: ['openFile', 'multiSelections'],
        filters: MEDIA_FILTERS
      })
      if (result.canceled || result.filePaths.length === 0) return ok({ assets: [], errors: [] })
      return ok(await importAll(projectId, result.filePaths))
    }
  )

  ipcMain.handle(IPC.media.list, (_e, projectId: string): IpcEnvelope<MediaAsset[]> => {
    if (!projectId) return err('INVALID_INPUT', '参数不完整')
    return ok(listMedia(projectId))
  })

  ipcMain.handle(IPC.media.delete, async (_e, mediaId: string): Promise<IpcEnvelope<boolean>> => {
    if (!mediaId) return err('INVALID_INPUT', '参数不完整')
    const deleted = await deleteMedia(mediaId)
    return ok(deleted)
  })
}
