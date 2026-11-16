// 循环扇出排布：以循环为中心上下对称均分；奇数项中间分支对齐循环中心；
// 产物挂在生图快照卡右侧；快照卡身份按 meta.iterationLaneRole 覆盖。
import { describe, expect, it } from 'vitest'
import {
  ITERATION_LANE_BRANCH_H,
  ITERATION_LANE_GAP_V,
  iterationFanoutLayout,
  iterationLaneArtifactPosition,
  iterationLaneOrigin,
  readIterationSnapshot
} from '@renderer/canvas/iteration-lanes'
import type { NodeCardShape } from '@renderer/canvas/NodeCardShape'

function loop(): NodeCardShape {
  return { x: 100, y: 200, props: { w: 340, h: 300 } } as unknown as NodeCardShape
}

describe('循环扇出对称排布', () => {
  it('分支以循环中心为轴上下对称均分', () => {
    const count = 4
    const layout = iterationFanoutLayout(loop(), count)
    const centerY = 200 + 300 / 2
    expect(layout.centerY).toBe(centerY)
    expect(layout.tops).toHaveLength(count)
    const pitch = ITERATION_LANE_BRANCH_H + ITERATION_LANE_GAP_V
    for (let i = 1; i < layout.tops.length; i += 1) {
      expect(layout.tops[i] - layout.tops[i - 1]).toBe(pitch)
    }
    // 整体块关于循环中心对称
    expect(layout.fanTop + layout.fanBottom).toBe(2 * centerY)
    expect(layout.originX).toBeGreaterThan(100 + 340)
  })

  it('奇数项中间分支与循环居中对齐', () => {
    const layout = iterationFanoutLayout(loop(), 3)
    const middleTop = layout.tops[1]
    expect(middleTop + ITERATION_LANE_BRANCH_H / 2).toBe(layout.centerY)
  })

  it('偶数项分支跨在循环中心两侧', () => {
    const layout = iterationFanoutLayout(loop(), 2)
    expect(layout.tops[0] + ITERATION_LANE_BRANCH_H).toBeLessThan(layout.centerY)
    expect(layout.tops[1]).toBeGreaterThan(layout.centerY)
  })

  it('iterationLaneOrigin 与扇出布局一致', () => {
    const layout = iterationFanoutLayout(loop(), 3)
    const origin = iterationLaneOrigin(loop(), 1, 3)
    expect(origin.x).toBe(layout.originX)
    expect(origin.y).toBe(layout.tops[1])
  })

  it('分支内多产物横向排开且不越回生图卡', () => {
    const gen = { x: 600, y: 540, props: { w: 340, h: 300 } } as unknown as NodeCardShape
    const first = iterationLaneArtifactPosition(gen, 0)
    const second = iterationLaneArtifactPosition(gen, 1)
    expect(first.x).toBeGreaterThan(600 + 340)
    expect(second.x).toBeGreaterThan(first.x)
    expect(first.y).toBe(gen.y)
    expect(second.y).toBe(gen.y)
  })
})

describe('循环分支快照身份', () => {
  it('文本节点带 iterationLaneRole 时按产出身份识别', () => {
    const shape = {
      props: { nodeType: 'text' },
      meta: { iterationLaneRole: 'ai-process', iterationLaneIndex: 2 }
    } as unknown as NodeCardShape
    expect(readIterationSnapshot(shape)).toEqual({ role: 'ai-process', index: 2 })
  })

  it('普通文本节点与非文本节点不识别为快照', () => {
    const plain = { props: { nodeType: 'text' }, meta: {} } as unknown as NodeCardShape
    expect(readIterationSnapshot(plain)).toBeNull()
    const image = {
      props: { nodeType: 'image' },
      meta: { iterationLaneRole: 'image-gen' }
    } as unknown as NodeCardShape
    expect(readIterationSnapshot(image)).toBeNull()
  })
})
