import { describe, expect, it } from 'vitest'
import { generatePrevisSpace } from '@renderer/nodes/previs-space-generator'

describe('预演空间生成适配边界', () => {
  it('默认本地适配器最多消费三张真实参考并输出可保存白模', async () => {
    const space = await generatePrevisSpace({
      referenceMediaIds: ['a', 'b', 'c', 'd'],
      referenceMediaPaths: ['a.png', 'b.png', 'c.png', 'd.png']
    })
    expect(space.mode).toBe('local-whitebox')
    expect(space.sourceMediaIds).toEqual(['a', 'b', 'c'])
    expect(space.primitives.length).toBeGreaterThan(0)
  })

  it('图片视差适配器只消费首张图片并保留可替换的深度来源', async () => {
    const space = await generatePrevisSpace({
      mode: 'image-depth',
      referenceMediaIds: ['hero', 'ignored'],
      referenceMediaPaths: ['projects/demo/media/hero.png', 'projects/demo/media/ignored.png']
    })
    expect(space.mode).toBe('image-depth')
    expect(space.status).toBe('ready')
    expect(space.backgroundMediaId).toBe('hero')
    expect(space.backgroundMediaPath).toBe('projects/demo/media/hero.png')
    expect(space.depthSource).toBe('heuristic-luminance')
    expect(space.parallaxStrength).toBe(0.28)
    expect(space.sourceMediaIds).toEqual(['hero'])
  })

  it('图片视差没有来源时返回失败空间而不是制造空结果', async () => {
    const space = await generatePrevisSpace({
      mode: 'image-depth',
      referenceMediaIds: [],
      referenceMediaPaths: []
    })
    expect(space.status).toBe('failed')
    expect(space.message).toContain('缺少参考图')
  })
})
