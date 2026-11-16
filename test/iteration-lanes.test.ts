// 循环泳道排布：N 项自上而下等距；产物挂在泳道头卡右侧。
import { describe, expect, it } from 'vitest'
import {
  ITERATION_LANE_GAP,
  iterationLaneArtifactPosition,
  iterationLaneOrigin
} from '@renderer/canvas/iteration-lanes'
import type { NodeCardShape } from '@renderer/canvas/NodeCardShape'

function loop(): NodeCardShape {
  return { x: 100, y: 200, props: { w: 340, h: 260 } } as unknown as NodeCardShape
}

describe('循环扇出泳道排布', () => {
  it('N 条分支自上而下等距排布', () => {
    const origins = [0, 1, 2, 3, 4].map((index) => iterationLaneOrigin(loop(), index))
    for (let i = 1; i < origins.length; i += 1) {
      expect(origins[i].y - origins[i - 1].y).toBe(ITERATION_LANE_GAP)
      expect(origins[i].x).toBe(origins[0].x)
    }
    expect(origins[0].x).toBeGreaterThan(100 + 340)
    expect(origins[0].y).toBeGreaterThan(200 + 260)
  })

  it('泳道内多产物横向排开且不越回头卡', () => {
    const lane = { x: 600, y: 540, props: { w: 320, h: 240 } } as unknown as NodeCardShape
    const first = iterationLaneArtifactPosition(lane, 0)
    const second = iterationLaneArtifactPosition(lane, 1)
    expect(first.x).toBeGreaterThan(600 + 320)
    expect(second.x).toBeGreaterThan(first.x)
    expect(first.y).toBe(lane.y)
    expect(second.y).toBe(lane.y)
  })
})