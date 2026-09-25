import type { MediaKind } from './types'

/** 本地媒体识别的唯一来源：导入、bundle 重建与 media:// 协议必须共用。 */
export const MIME_BY_EXTENSION: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.bmp': 'image/bmp',
  '.svg': 'image/svg+xml',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mov': 'video/quicktime',
  '.mkv': 'video/x-matroska',
  '.avi': 'video/x-msvideo',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
  '.opus': 'audio/ogg',
  '.m4a': 'audio/mp4',
  '.flac': 'audio/flac',
  '.aac': 'audio/aac',
  '.pcm': 'audio/pcm',
  '.ulaw': 'audio/basic',
  // 文件节点（2026-09-18）：常见文档格式也要能被识别为 file 媒体，
  // 否则 mime 会退化成 application/octet-stream，节点无法如实展示类型。
  '.pdf': 'application/pdf',
  '.doc': 'application/msword',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xls': 'application/vnd.ms-excel',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.ppt': 'application/vnd.ms-powerpoint',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.csv': 'text/csv',
  '.txt': 'text/plain',
  '.md': 'text/markdown',
  '.json': 'application/json',
  '.zip': 'application/zip'
}

export function mimeForExtension(extension: string): string {
  return MIME_BY_EXTENSION[extension.toLowerCase()] ?? 'application/octet-stream'
}

/**
 * 反向还原扩展名：媒体路径不一定带扩展名（浏览器验收页把小文件存成 data URL），
 * 只看路径会让文件节点把支持的文档说成「该格式不在画布内解析」。
 * 同 mime 多个扩展名时取表里第一个（image/jpeg → .jpg）。
 */
export function extensionForMime(mime: string): string {
  if (!mime || mime === 'application/octet-stream') return ''
  const entry = Object.entries(MIME_BY_EXTENSION).find(([, value]) => value === mime)
  return entry?.[0] ?? ''
}

/** 可直接按 UTF-8 读出的文本扩展名；文件节点的 out-text 第一类来源。 */
export const INLINE_TEXT_EXTS: readonly string[] = ['.txt', '.md', '.markdown', '.csv', '.json']

/**
 * OOXML 文档（zip + XML）：由主进程 `media/document-text.ts` 抽取正文后同样进 out-text。
 * 刻意不含 .doc/.xls/.ppt 旧二进制格式。
 */
export const OOXML_DOC_EXTS: readonly string[] = ['.docx', '.xlsx', '.pptx']

/** PDF：同一份抽取器用 pdf.js（`unpdf`）逐页取文字，与 Office 共用 out-text 通道。 */
export const PDF_DOC_EXTS: readonly string[] = ['.pdf']

/** 主进程能抽出正文的二进制文档（Office + PDF）；导入判定与节点展示共用这一份清单。 */
export const BINARY_DOC_EXTS: readonly string[] = [...OOXML_DOC_EXTS, ...PDF_DOC_EXTS]

export function mediaKindForMime(mime: string): MediaKind {
  if (mime.startsWith('image/')) return 'image'
  if (mime.startsWith('video/')) return 'video'
  if (mime.startsWith('audio/')) return 'audio'
  return 'file'
}
