// 循环扇出泳道：循环节点每处理一项，在画布上落一条「输入/提示词 → 产物」的可视分支。
// 泳道节点是运行投影（溯源关系），不是 DAG 数据边：不参与排序、不会被当成循环体。
// 排布规范（用户 2026-11-16）：以循环节点为起点，N 项自上而下等距排布 N 条分支。
import { createShapeId, type Editor, type TLShapeId } from 'tldraw'
import { getNodeType } from '../nodes/registry'
import type { NodeCardShape } from './NodeCardShape'

/** 相邻泳道的垂直间距（等距）。 */
export const ITERATION_LANE_GAP = 480
/** 泳道起点相对循环节点右下角的水平偏移。 */
export const ITERATION_LANE_OFFSET_X = 120
/** 首条泳道相对循环节点底部的垂直偏移（避开循环体定义链所在行）。 */
export const ITERATION_LANE_OFFSET_Y = 80
/** 泳道内提示词卡与产物卡的水平间距。 */
export const ITERATION_LANE_INNER_GAP = 80

export function iterationLaneOrigin(
  loop: NodeCardShape,
  index: number,
  anchor?: { x: number; y: number; w: number; h: number }
): { x: number; y: number } {
  const base = anchor ?? { x: loop.x, y: loop.y, w: loop.props.w, h: loop.props.h }
  return {
    x: base.x + base.w + ITERATION_LANE_OFFSET_X,
    y: base.y + base.h + ITERATION_LANE_OFFSET_Y + index * ITERATION_LANE_GAP
  }
}

/** 创建第 index 项的泳道头卡（文本节点：先放当前项 JSON，拿到提示词后替换）。 */
export function createIterationLane(
  editor: Editor,
  loop: NodeCardShape,
  index: number,
  item: Record<string, unknown>,
  runId: string,
  anchor?: { x: number; y: number; w: number; h: number }
): TLShapeId {
  const spec = getNodeType('text')
  const origin = iterationLaneOrigin(loop, index, anchor)
  const id = createShapeId()
  editor.createShape({
    id,
    type: 'node-card',
    x: origin.x,
    y: origin.y,
    props: {
      nodeType: 'text',
      title: `镜头 ${index + 1} · 输入`,
      text: JSON.stringify(item, null, 2),
      w: spec?.defaultSize.w ?? 320,
      h: spec?.defaultSize.h ?? 240
    },
    meta: {
      artifactProducerId: loop.id,
      artifactProducerPortId: 'out-item',
      artifactRunId: runId,
      runGroupId: runId,
      iterationLaneLoopId: loop.id,
      iterationLaneIndex: index,
      artifactCreatedAt: Date.now()
    }
  })
  return id
}

/** 循环体产出文本（提示词）后，把泳道头卡替换为提示词正文。 */
export function updateIterationLanePrompt(editor: Editor, laneId: TLShapeId, prompt: string): void {
  const current = editor.getShape<NodeCardShape>(laneId)
  if (!current || current.props.text === prompt) return
  const index = (current.meta as Record<string, unknown> | undefined)?.iterationLaneIndex
  editor.updateShape({
    id: laneId,
    type: 'node-card',
    props: {
      text: prompt,
      title: `镜头 ${typeof index === 'number' ? index + 1 : ''} · 提示词`
    }
  })
}

/** 泳道内第 siblingCount 个产物卡的位置（多产物横向排开）。 */
export function iterationLaneArtifactPosition(
  lane: NodeCardShape,
  siblingCount: number
): { x: number; y: number } {
  const spec = getNodeType('image')
  const width = spec?.defaultSize.w ?? 320
  return {
    x: lane.x + lane.props.w + ITERATION_LANE_INNER_GAP + siblingCount * (width + 60),
    y: lane.y
  }
}

/** 重跑前清掉该循环上一轮的泳道投影（媒体本体保留在素材库）。 */
export function clearIterationLanes(editor: Editor, loopId: string): void {
  const stale = editor
    .getCurrentPageShapes()
    .filter(
      (shape) =>
        shape.type === 'node-card' &&
        (shape.meta as Record<string, unknown> | undefined)?.iterationLaneLoopId === loopId
    )
    .map((shape) => shape.id)
  if (stale.length > 0) editor.deleteShapes(stale)
}