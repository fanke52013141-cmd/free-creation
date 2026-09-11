import { describe, expect, it } from 'vitest'
import { videoReferenceAssetIssues } from '@shared/video-reference-validation'

const mib = 1024 * 1024

describe('视频参考素材本地校验', () => {
  it('H3 在请求前拦截单个素材类型、大小和编码后总量风险', () => {
    const assets = new Map([
      ['image-large', { id: 'image-large', kind: 'image', sizeBytes: 31 * mib }],
      ['video-large', { id: 'video-large', kind: 'video', sizeBytes: 51 * mib }],
      ['audio-large', { id: 'audio-large', kind: 'audio', sizeBytes: 16 * mib }]
    ])
    expect(
      videoReferenceAssetIssues(
        'minimax',
        'MiniMax-H3',
        [
          { id: 'image-large', expectedKind: 'image' },
          { id: 'video-large', expectedKind: 'video' },
          { id: 'audio-large', expectedKind: 'audio' }
        ],
        assets
      )
    ).toEqual([
      '参考图片 image-large 超过 30MB 上限',
      '参考视频 video-large 超过 50MB 上限',
      '参考音频 audio-large 超过 15MB 上限',
      'MiniMax H3 的参考素材合计不能超过 46MB，以预留 Data URL 编码后的 64MB 请求体空间'
    ])
  })

  it('仅由真实模型 profile 启用；不会向未验证的供应商硬塞 H3 限制', () => {
    const assets = new Map([['ref', { id: 'ref', kind: 'image', sizeBytes: 80 * mib }]])
    expect(
      videoReferenceAssetIssues(
        'seedance',
        'Seedance-2.0',
        [{ id: 'ref', expectedKind: 'image' }],
        assets
      )
    ).toEqual([])
  })
})
