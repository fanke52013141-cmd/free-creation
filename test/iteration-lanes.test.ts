// 循环扇出排布：以循环为中心上下对称均分；奇数项中间分支对齐循环中心；
// 产物挂在生图快照卡右侧；快照卡身份按 meta.iterationLaneRole 覆盖。
// 分支连线（用户 2026-11-16）：循环→AI处理→生图→预览 一条串行链，
// 快照卡隐藏自动溯源线（artifactLinkHidden），避免重复/错误指向循环的线。
import { describe, expect, it } from 'vitest'
import type { Editor } from 'tldraw'
import {
  ITERATION_LANE_BRANCH_H,
  ITERATION_LANE_GAP_V,
  createIterationLane,
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

describe('循环分支串行连线', () => {
  function mockEditor(): {
    editor: Editor
    shapes: Map<string, Record<string, unknown>>
    bindings: Array<Record<string, unknown>>
  } {
    const shapes = new Map<string, Record<string, unknown>>()
    const bindings: Array<Record<string, unknown>> = []
    const editor = {
      createShape: (shape: { id: string }) => {
        shapes.set(shape.id, shape as unknown as Record<string, unknown>)
      },
      getShape: (id: string) => shapes.get(id),
      createBinding: (binding: Record<string, unknown>) => {
        bindings.push(binding)
      }
    } as unknown as Editor
    return { editor, shapes, bindings }
  }

  function loopShape(): NodeCardShape {
    return {
      id: 'shape:loop',
      x: 100,
      y: 200,
      props: { w: 340, h: 300 }
    } as unknown as NodeCardShape
  }

  it('快照卡隐藏自动溯源线，避免循环→快照的重复/错误连线', () => {
    const { editor, shapes } = mockEditor()
    const cards = createIterationLane(editor, loopShape(), 0, { id: 'shot-1' }, 'run-1', 2)
    for (const id of [cards.aiCardId, cards.genCardId]) {
      const meta = shapes.get(id)?.meta as Record<string, unknown>
      expect(meta.artifactLinkHidden).toBe(true)
      expect(meta.artifactProducerId).toBe('shape:loop')
    }
  })

  it('每条分支恰有两条视觉箭头：循环→AI处理、AI处理→生图，均非数据边', () => {
    const { editor, shapes, bindings } = mockEditor()
    const cards = createIterationLane(editor, loopShape(), 1, { id: 'shot-2' }, 'run-1', 2)
    const arrows = [...shapes.values()].filter((shape) => shape.type === 'arrow')
    expect(arrows).toHaveLength(2)
    for (const arrow of arrows) {
      const meta = arrow.meta as Record<string, unknown>
      expect(meta.fromPort).toBeUndefined()
      expect(meta.toPort).toBeUndefined()
      expect(meta.iterationLaneLoopId).toBe('shape:loop')
      expect(meta.iterationLaneIndex).toBe(1)
    }
    const pairs = bindings
      .filter((binding) => (binding.props as Record<string, unknown>).terminal === 'start')
      .map((binding) => {
        const end = bindings.find(
          (candidate) =>
            candidate.fromId === binding.fromId &&
            (candidate.props as Record<string, unknown>).terminal === 'end'
        )
        return [binding.toId, end?.toId]
      })
    expect(pairs).toContainEqual(['shape:loop', cards.aiCardId])
    expect(pairs).toContainEqual([cards.aiCardId, cards.genCardId])
    // 不允许出现循环直接指向生图快照的箭头
    expect(pairs).not.toContainEqual(['shape:loop', cards.genCardId])
  })
})
