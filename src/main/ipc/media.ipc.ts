// 媒体 IPC：拖拽导入 + 系统对话框选择导入（见《技术框架与规范》§10）
import { ipcMain, dialog, clipboard, shell } from 'electron'
import { IPC } from '../../shared/contracts'
import type { IpcEnvelope } from '../../shared/contracts'
import type { ImportMediaBufferInput } from '../../shared/contracts'
import type { MediaAsset, MediaImportError, MediaImportResult } from '../../shared/types'
import {
  deleteMedia,
  getMediaAbsPath,
  importMedia,
  listMedia,
  saveBufferAsset
} from '../store/media.repo'
import { getDb } from '../store/db'

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
      'avi',
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
    IPC.media.importBuffer,
    async (_e, input: ImportMediaBufferInput): Promise<IpcEnvelope<MediaAsset>> => {
      if (!input?.projectId || !input.mime?.startsWith('image/') || !input.data) {
        return err('INVALID_INPUT', '仅支持粘贴图片数据')
      }
      const buffer = Buffer.from(input.data)
      if (buffer.length === 0 || buffer.length > 50 * 1024 * 1024) {
        return err('INVALID_INPUT', '粘贴图片为空或超过 50MB')
      }
      const extByMime: Record<string, string> = {
        'image/png': '.png',
        'image/jpeg': '.jpg',
        'image/webp': '.webp',
        'image/gif': '.gif',
        'image/bmp': '.bmp',
        'image/svg+xml': '.svg'
      }
      const ext = extByMime[input.mime] ?? '.png'
      const asset = await saveBufferAsset(
        input.projectId,
        buffer,
        ext,
        input.name?.replace(/\.[^.]+$/, '') || '粘贴图片'
      )
      return ok(asset)
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

  // 从 media.db 查绝对路径（mediaId 需有效），返回 null 表示媒体不存在或路径不合法。
  function resolveAbsPath(mediaId: string): string | null {
    if (!mediaId) return null
    const row = getDb().prepare('SELECT path FROM media WHERE id = ?').get(mediaId) as
      { path: string } | undefined
    if (!row) return null
    return getMediaAbsPath(row.path)
  }

  // 在资源管理器中定位文件（选中，不打开）
  ipcMain.handle(IPC.media.reveal, (_e, mediaId: string): IpcEnvelope<boolean> => {
    const abs = resolveAbsPath(mediaId)
    if (!abs) return err('MEDIA_NOT_FOUND', '媒体文件不存在或路径不合法')
    shell.showItemInFolder(abs)
    return ok(true)
  })

  // 复制文件绝对路径到剪贴板
  ipcMain.handle(IPC.media.copyPath, (_e, mediaId: string): IpcEnvelope<boolean> => {
    const abs = resolveAbsPath(mediaId)
    if (!abs) return err('MEDIA_NOT_FOUND', '媒体文件不存在或路径不合法')
    clipboard.writeText(abs)
    return ok(true)
  })

  // 用系统默认程序打开文件
  ipcMain.handle(IPC.media.open, async (_e, mediaId: string): Promise<IpcEnvelope<boolean>> => {
    const abs = resolveAbsPath(mediaId)
    if (!abs) return err('MEDIA_NOT_FOUND', '媒体文件不存在或路径不合法')
    const error = await shell.openPath(abs)
    if (error) return err('OPEN_FAILED', error)
    return ok(true)
  })
}
