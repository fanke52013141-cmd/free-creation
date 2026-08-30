// 媒体 IPC：拖拽导入 + 系统对话框选择导入（见《技术框架与规范》§10）
import { ipcMain, dialog, clipboard, shell } from 'electron'
import { constants as fsConstants } from 'fs'
import { copyFile } from 'fs/promises'
import { basename, extname, join } from 'path'
import { IPC } from '../../shared/contracts'
import type { IpcEnvelope } from '../../shared/contracts'
import type {
  AudioWaveformInput,
  AudioWaveformResult,
  ImageCropTransformInput,
  ImageSplitTransformInput,
  ImportMediaBufferInput,
  TtsGenerateInput,
  VideoAudioTransformInput,
  VideoClipTransformInput,
  VideoFrameTransformInput,
  VideoProbeInput,
  VideoThumbnailsInput,
  VideoThumbnailsResult,
  VocalSeparateInput
} from '../../shared/contracts'
import type { MediaAsset, MediaImportError, MediaImportResult } from '../../shared/types'
import {
  deleteMedia,
  getMediaAbsPath,
  importMedia,
  listMedia,
  saveBufferAsset
} from '../store/media.repo'
import { getDb } from '../store/db'
import { transformImageCrop, transformImageSplit } from '../media/image-transform'
import { transformTts } from '../media/tts-transform'
import {
  transformVideoAudio,
  transformVideoClip,
  transformVideoFrame,
  probeVideo,
  separateVocals,
  generateVideoThumbnails,
  generateAudioWaveform,
  getLocalMediaCapabilities
} from '../media/video-transform'

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
    IPC.media.localCapabilities,
    async (): Promise<IpcEnvelope<import('../../shared/contracts').LocalMediaCapabilities>> => {
      try {
        return ok(await getLocalMediaCapabilities())
      } catch (error) {
        return err(
          'LOCAL_CAPABILITIES_FAILED',
          error instanceof Error ? error.message : String(error)
        )
      }
    }
  )
  ipcMain.handle(IPC.media.videoProbe, async (_e, input: VideoProbeInput) => {
    if (!input?.projectId || !input.sourceMediaId) return err('INVALID_INPUT', '缺少视频元数据参数')
    try {
      return ok(await probeVideo(input))
    } catch (error) {
      return err('VIDEO_PROBE_FAILED', error instanceof Error ? error.message : String(error))
    }
  })
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
    IPC.media.imageSplit,
    async (_e, input: ImageSplitTransformInput): Promise<IpcEnvelope<MediaAsset[]>> => {
      if (!input?.projectId || !input.sourceMediaId || !input.config)
        return err('INVALID_INPUT', '缺少图片宫格拆分参数')
      try {
        return ok(await transformImageSplit(input))
      } catch (error) {
        return err('IMAGE_SPLIT_FAILED', error instanceof Error ? error.message : String(error))
      }
    }
  )

  /** 视频处理端点分开声明，与三个独立节点的一一对应关系保持可追溯。 */
  ipcMain.handle(
    IPC.media.videoFrame,
    async (_e, input: VideoFrameTransformInput): Promise<IpcEnvelope<MediaAsset>> => {
      if (!input?.projectId || !input.sourceMediaId || !input.config)
        return err('INVALID_INPUT', '缺少视频取帧参数')
      try {
        return ok(await transformVideoFrame(input))
      } catch (error) {
        return err('VIDEO_FRAME_FAILED', error instanceof Error ? error.message : String(error))
      }
    }
  )
  ipcMain.handle(
    IPC.media.videoClip,
    async (_e, input: VideoClipTransformInput): Promise<IpcEnvelope<MediaAsset>> => {
      if (!input?.projectId || !input.sourceMediaId || !input.config)
        return err('INVALID_INPUT', '缺少视频截取参数')
      try {
        return ok(await transformVideoClip(input))
      } catch (error) {
        return err('VIDEO_CLIP_FAILED', error instanceof Error ? error.message : String(error))
      }
    }
  )
  ipcMain.handle(
    IPC.media.videoAudio,
    async (_e, input: VideoAudioTransformInput): Promise<IpcEnvelope<MediaAsset>> => {
      if (!input?.projectId || !input.sourceMediaId || !input.config)
        return err('INVALID_INPUT', '缺少音频提取参数')
      try {
        return ok(await transformVideoAudio(input))
      } catch (error) {
        return err('VIDEO_AUDIO_FAILED', error instanceof Error ? error.message : String(error))
      }
    }
  )
  /** 时间轴缩略图：均匀采样指定数量的帧，返回 base64 JPEG data URL 数组。 */
  ipcMain.handle(
    IPC.media.videoThumbnails,
    async (_e, input: VideoThumbnailsInput): Promise<IpcEnvelope<VideoThumbnailsResult>> => {
      if (!input?.projectId || !input.sourceMediaId || !input.count)
        return err('INVALID_INPUT', '缺少缩略图参数')
      try {
        return ok(await generateVideoThumbnails(input))
      } catch (error) {
        return err(
          'VIDEO_THUMBNAILS_FAILED',
          error instanceof Error ? error.message : String(error)
        )
      }
    }
  )
  /** 音频波形：解码为 PCM 并采样峰值，返回归一化振幅数组。 */
  ipcMain.handle(
    IPC.media.audioWaveform,
    async (_e, input: AudioWaveformInput): Promise<IpcEnvelope<AudioWaveformResult>> => {
      if (!input?.projectId || !input.sourceMediaId || !input.samples)
        return err('INVALID_INPUT', '缺少波形参数')
      try {
        return ok(await generateAudioWaveform(input))
      } catch (error) {
        return err('AUDIO_WAVEFORM_FAILED', error instanceof Error ? error.message : String(error))
      }
    }
  )
  ipcMain.handle(IPC.media.vocalSeparate, async (_e, input: VocalSeparateInput) => {
    if (!input?.projectId || !input.sourceMediaId || !input.config)
      return err('INVALID_INPUT', '缺少人声分离参数')
    try {
      return ok(await separateVocals(input))
    } catch (error) {
      return err('VOCAL_SEPARATE_FAILED', error instanceof Error ? error.message : String(error))
    }
  })

  ipcMain.handle(
    IPC.media.importBuffer,
    async (_e, input: ImportMediaBufferInput): Promise<IpcEnvelope<MediaAsset>> => {
      if (
        !input?.projectId ||
        (!input.mime?.startsWith('image/') && !input.mime?.startsWith('video/')) ||
        !input.data
      ) {
        return err('INVALID_INPUT', '仅支持图片或视频缓冲数据')
      }
      const buffer = Buffer.from(input.data)
      if (buffer.length === 0 || buffer.length > 200 * 1024 * 1024) {
        return err('INVALID_INPUT', '媒体缓冲为空或超过 200MB')
      }
      const extByMime: Record<string, string> = {
        'image/png': '.png',
        'image/jpeg': '.jpg',
        'image/webp': '.webp',
        'image/gif': '.gif',
        'image/bmp': '.bmp',
        'image/svg+xml': '.svg',
        'video/webm': '.webm',
        'video/mp4': '.mp4'
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

  /** M0：裁剪只接受“当前项目内已登记的图片资产”，不开放任意磁盘路径给渲染进程。 */
  ipcMain.handle(
    IPC.media.imageCrop,
    async (_e, input: ImageCropTransformInput): Promise<IpcEnvelope<MediaAsset>> => {
      if (!input?.projectId || !input.sourceMediaId || !input.config) {
        return err('INVALID_INPUT', '缺少图片裁剪参数')
      }
      try {
        return ok(await transformImageCrop(input))
      } catch (error) {
        return err('IMAGE_CROP_FAILED', error instanceof Error ? error.message : String(error))
      }
    }
  )

  /** 本地 ComfyUI 语音复刻：同步等待合成完成（轮询在主进程内完成）。 */
  ipcMain.handle(
    IPC.media.ttsGenerate,
    async (_e, input: TtsGenerateInput): Promise<IpcEnvelope<MediaAsset>> => {
      if (!input?.projectId || !input.referenceAudioId || !input.text?.trim()) {
        return err('INVALID_INPUT', '缺少参考音频或合成文本')
      }
      if (!input.config || typeof input.config !== 'object') {
        return err('INVALID_INPUT', '合成配置不完整')
      }
      try {
        return ok(await transformTts(input))
      } catch (error) {
        return err('TTS_FAILED', error instanceof Error ? error.message : String(error))
      }
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

  // 批量导出：只允许导出当前项目的资产；以 COPYFILE_EXCL 写入，绝不覆盖目标目录
  // 中已有文件。重名时自动加序号，避免重复导出或同名素材丢失。
  ipcMain.handle(
    IPC.media.batchExport,
    async (
      _e,
      input: { projectId: string; mediaIds?: string[] }
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
      const projectAssets = listMedia(input.projectId)
      const requestedIds = Array.isArray(input.mediaIds)
        ? new Set(
            input.mediaIds.filter((id): id is string => typeof id === 'string' && id.length > 0)
          )
        : null
      const assets = requestedIds
        ? projectAssets.filter((asset) => requestedIds.has(asset.id))
        : projectAssets
      let exported = 0
      let failed = 0
      for (const asset of assets) {
        const src = getMediaAbsPath(asset.path)
        if (!src) {
          failed++
          continue
        }
        const ext = extname(asset.path)
        const rawName = asset.name ? `${asset.name}${ext}` : basename(asset.path)
        const baseName = rawName.replace(/[\\/:*?"<>|]+/g, '-').trim() || `${asset.id}${ext}`
        const extIndex = baseName.lastIndexOf('.')
        const stem = extIndex > 0 ? baseName.slice(0, extIndex) : baseName
        const suffix = extIndex > 0 ? baseName.slice(extIndex) : ''
        let copied = false
        for (let attempt = 0; attempt < 1000; attempt += 1) {
          const destName = attempt === 0 ? `${stem}${suffix}` : `${stem} (${attempt})${suffix}`
          try {
            await copyFile(src, join(targetDir, destName), fsConstants.COPYFILE_EXCL)
            exported++
            copied = true
            break
          } catch (error) {
            const code = (error as NodeJS.ErrnoException).code
            if (code !== 'EEXIST') break
          }
        }
        if (!copied) failed++
      }
      return ok({ exported, failed, targetDir })
    }
  )
}
