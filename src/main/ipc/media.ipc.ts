// 媒体 IPC：拖拽导入 + 系统对话框选择导入（见《技术框架与规范》§10）
import { ipcMain, dialog, clipboard, shell } from 'electron'
import { copyFile } from 'fs/promises'
import { basename, extname, join } from 'path'
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

// 允许 shell.openPath 直接打开的扩展名白名单。
// 拖拽导入（importMedia）不对扩展名做白名单，用户可把 .exe/.bat 等拖入成为
// file 媒体；为避免「系统默认程序打开」执行任意可执行文件，open 操作按媒体类型
// 放行。reveal（资源管理器定位）与 copyPath 仅定位/复制路径、不执行文件，不受限。
const OPENABLE_EXTS = new Set([
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
  'json',
  'pdf'
])

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
    // 安全白名单：拒绝直接打开可执行 / 脚本类文件，避免用户拖入的 .exe/.bat 被执行。
    const ext = extname(abs).slice(1).toLowerCase()
    if (!OPENABLE_EXTS.has(ext)) {
      return err(
        'UNSUPPORTED_TYPE',
        `出于安全考虑不直接打开 .${ext || '未知'} 文件，请改用「在资源管理器中定位」`
      )
    }
    const error = await shell.openPath(abs)
    if (error) return err('OPEN_FAILED', error)
    return ok(true)
  })

  // 批量导出：弹出目录选择对话框，将项目所有媒体文件复制到目标目录
  ipcMain.handle(
    IPC.media.batchExport,
    async (
      _e,
      input: { projectId: string }
    ): Promise<IpcEnvelope<{ exported: number; failed: number; targetDir: string }>> => {
      if (!input?.projectId) return err('INVALID_INPUT', '参数不完整')
      const result = await dialog.showOpenDialog({
        title: '选择导出目录',
        properties: ['openDirectory', 'createDirectory']
      })
      if (result.canceled || result.filePaths.length === 0) {
        return ok({ exported: 0, failed: 0, targetDir: '' })
      }
      const targetDir = result.filePaths[0]
      const assets = listMedia(input.projectId)
      let exported = 0
      let failed = 0
      const used = new Set<string>()
      for (const asset of assets) {
        const src = getMediaAbsPath(asset.path)
        if (!src) {
          failed++
          continue
        }
        const ext = extname(asset.path)
        const baseName = asset.name ? `${asset.name}${ext}` : basename(asset.path)
        let destName = baseName
        if (used.has(destName)) destName = `${asset.name ?? asset.id}_${asset.id}${ext}`
        used.add(destName)
        try {
          await copyFile(src, join(targetDir, destName))
          exported++
        } catch {
          failed++
        }
      }
      return ok({ exported, failed, targetDir })
    }
  )
}
