import { describe, expect, it } from 'vitest'
import { BINARY_DOC_EXTS, extensionForMime, mediaKindForMime, mimeForExtension } from '@shared/mime'

describe('本地媒体 MIME 单一来源', () => {
  it.each([
    ['.mkv', 'video/x-matroska', 'video'],
    ['.avi', 'video/x-msvideo', 'video'],
    ['.flac', 'audio/flac', 'audio'],
    ['.aac', 'audio/aac', 'audio']
  ])('%s 在导入与协议层都能识别', (extension, mime, kind) => {
    expect(mimeForExtension(extension)).toBe(mime)
    expect(mediaKindForMime(mime)).toBe(kind)
  })
})

// 文件节点要在路径不带扩展名时（浏览器验收页存成 data URL）仍然认得出文档类型，
// 否则支持的 Word/PDF 会被显示成「该格式不在画布内解析」。
describe('按 MIME 反查扩展名', () => {
  it('每一种可抽正文的文档都能从自己的 mime 还原回扩展名', () => {
    for (const ext of BINARY_DOC_EXTS) {
      const mime = mimeForExtension(ext)
      expect(mimeForExtension(extensionForMime(mime)), `mime ${mime} 反查失败`).toBe(mime)
    }
  })

  it('未识别的 mime 与空值反查为空串，不猜成某个具体格式', () => {
    expect(extensionForMime('application/octet-stream')).toBe('')
    expect(extensionForMime('application/x-unknown')).toBe('')
    expect(extensionForMime('')).toBe('')
  })
})
