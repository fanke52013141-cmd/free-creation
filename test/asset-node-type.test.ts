// 拖入/产出的媒体落在哪种卡上，是导入语义的一部分。
import { describe, expect, it } from 'vitest'
import { assetNodeTypeFor } from '@renderer/canvas/asset-node-type'

describe('assetNodeTypeFor · 媒体资产的落点节点', () => {
  it.each([
    ['image', 'image'],
    ['video', 'video-asset'],
    ['audio', 'audio'],
    ['file', 'file']
  ] as const)('%s 资产落在 %s 节点上', (kind, nodeType) => {
    expect(assetNodeTypeFor(kind)).toBe(nodeType)
  })

  it('视频不能落在「生视频」节点上：那张卡要选模型、能发起计费请求', () => {
    expect(assetNodeTypeFor('video')).not.toBe('video')
  })
})
