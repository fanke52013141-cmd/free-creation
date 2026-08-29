import { describe, expect, it } from 'vitest'
import { mediaKindForMime, mimeForExtension } from '@shared/mime'

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
