import { describe, expect, it } from 'vitest'
import { operationPatchViolation } from '@shared/engine/node-invariants'

describe('节点身份不变式', () => {
  it('拒绝操作节点在运行时变成媒体资产或改写运行标题', () => {
    expect(operationPatchViolation('image-gen', { mediaId: 'new-image' })).toContain('emitArtifact')
    expect(operationPatchViolation('video', { mediaPath: '/result.mp4' })).toContain('不得')
    expect(operationPatchViolation('image-edit', { title: '结果图' })).toContain('不得')
  })

  it('允许资产节点持有自己的媒体引用，并允许操作节点写入非身份运行数据', () => {
    expect(operationPatchViolation('image', { mediaId: 'asset-1' })).toBeNull()
    expect(operationPatchViolation('video-asset', { mediaPath: '/asset.mp4' })).toBeNull()
    expect(
      operationPatchViolation('image-gen', { config: '{"modelKey":"relay::image"}' })
    ).toBeNull()
  })
})
