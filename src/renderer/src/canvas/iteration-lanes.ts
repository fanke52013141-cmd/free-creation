// 循环扇出泳道：循环节点居扇出纵向正中央，N 项分支上下对称均分。
// 每条分支呈现完整「AI 处理 → 生图 → 预览」链的观感：两张只读运行快照卡
// （以产出节点身份呈现）+ 自动落位的产物卡。快照卡内核仍是文本节点（不新增
// 节点类型、不动执行契约），通过 meta.iterationLaneRole 在呈现层覆盖身份。
// 泳道节点是运行投影（溯源关系），不是 DAG 数据边：不参与排序、不会被当成循环体。
// 排布规范（用户 2026-11-16）：循环居中、分支等距对称；奇数项中间分支与循环居中对齐。
import { createShapeId, type Editor, type TLShapeId } from 'tldraw'
import { getNodeType } from '../nodes/registry'
import type { NodeCardShape } from './NodeCardShape'
import { NODE_UI } from './node-ui-tokens'
import { collapseGroup } from './stack-collapse'

/** 泳道起点相对循环节点右侧的水平偏移。 */
export const ITERATION_LANE_OFFSET_X = 120
/** 相邻分支行的垂直净间距（等距）。 */
export const ITERATION_LANE_GAP_V = 120
/** 分支内相邻卡片的水平间距。 */
export const ITERATION_LANE_INNER_GAP = 80
/** 分支卡片统一采用默认档宽高（呈现规范 H0），超高内容内部滚动。 */
export const ITERATION_LANE_BRANCH_W = NODE_UI.width
export const ITERATION_LANE_BRANCH_H = NODE_UI.height.default

/** 快照卡身份角色：呈现层据此覆盖图标/身份色/标题语义。 */
export type IterationSnapshotRole = 'ai-process' | 'image-gen'

/** 分支项运行状态（预铺骨架→逐项填充→终态），呈现层据此显示状态徽标。 */
export type IterationLaneStatus = 'pending' | 'running' | 'done' | 'failed' | 'skipped'

export interface IterationFanoutLayout {
  originX: number
  centerY: number
  tops: number[]
  fanTop: number
  fanBottom: number
  pitch: number
}

/** 以循环中心为轴，把 N 条分支上下对称均分；奇数项中间分支正好对齐循环中心。 */
export function iterationFanoutLayout(
  loop: NodeCardShape,
  count: number,
  anchor?: { x: number; y: number; w: number; h: number }
): IterationFanoutLayout {
  const base = anchor ?? { x: loop.x, y: loop.y, w: loop.props.w, h: loop.props.h }
  const n = Math.max(1, Math.floor(count))
  const centerY = base.y + base.h / 2
  const pitch = ITERATION_LANE_BRANCH_H + ITERATION_LANE_GAP_V
  const total = n * ITERATION_LANE_BRANCH_H + (n - 1) * ITERATION_LANE_GAP_V
  const fanTop = centerY - total / 2
  const tops = Array.from({ length: n }, (_, index) => fanTop + index * pitch)
  return {
    originX: base.x + base.w + ITERATION_LANE_OFFSET_X,
    centerY,
    tops,
    fanTop,
    fanBottom: fanTop + total,
    pitch
  }
}

/** 第 index 项分支头卡（AI 处理快照）左上角坐标。 */
export function iterationLaneOrigin(
  loop: NodeCardShape,
  index: number,
  count: number,
  anchor?: { x: number; y: number; w: number; h: number }
): { x: number; y: number } {
  const layout = iterationFanoutLayout(loop, count, anchor)
  const clamped = Math.max(0, Math.min(index, layout.tops.length - 1))
  return { x: layout.originX, y: layout.tops[clamped] }
}

function laneMeta(
  loop: NodeCardShape,
  index: number,
  runId: string,
  role: IterationSnapshotRole
): Record<string, unknown> {
  return {
    artifactProducerId: loop.id,
    artifactProducerPortId: 'out-item',
    // 快照卡的溯源关系只供追溯查询，不画「循环→快照」的自动溯源线：
    // 分支连线统一由显式泳道箭头表达（循环→AI处理→生图→预览），
    // 否则 DataEdgeLayer 会按 artifactProducerId 再画一遍，出现重复且语义错误的线。
    artifactLinkHidden: true,
    artifactRunId: runId,
    runGroupId: runId,
    iterationLaneLoopId: loop.id,
    iterationLaneIndex: index,
    iterationLaneRole: role,
    iterationLaneStatus: 'pending' as IterationLaneStatus,
    artifactCreatedAt: Date.now()
  }
}

/** 泳道视觉箭头：只有绑定、没有端口 meta，因此不是数据边、不参与执行。
 *  本应用 tldraw 箭头本体是隐藏载体（ui-surfaces.css opacity:0），可见线由
 *  DataEdgeLayer 按 meta.iterationProvenance 统一绘制。 */
function createLaneArrow(
  editor: Editor,
  source: NodeCardShape,
  targetId: TLShapeId,
  loopId: string,
  index: number
): void {
  const arrowId = createShapeId()
  const start = { x: source.x + source.props.w, y: source.y + source.props.h / 2 }
  const target = editor.getShape<NodeCardShape>(targetId)
  const end = target
    ? { x: target.x, y: target.y + target.props.h / 2 }
    : { x: start.x + ITERATION_LANE_OFFSET_X, y: start.y }
  editor.createShape({
    id: arrowId,
    type: 'arrow',
    x: start.x,
    y: start.y,
    props: {
      kind: 'arc',
      color: 'grey',
      fill: 'none',
      dash: 'solid',
      size: 's',
      font: 'sans',
      arrowheadStart: 'none',
      arrowheadEnd: 'arrow',
      start: { x: 0, y: 0 },
      end: { x: end.x - start.x, y: end.y - start.y },
      bend: 0,
      labelPosition: 0.5,
      scale: 1
    },
    meta: {
      iterationProvenance: loopId,
      iterationLaneLoopId: loopId,
      iterationLaneIndex: index
    }
  })
  editor.createBinding({
    type: 'arrow',
    fromId: arrowId,
    toId: source.id,
    props: {
      terminal: 'start',
      normalizedAnchor: { x: 1, y: 0.5 },
      isExact: false,
      isPrecise: true,
      snap: 'none'
    }
  })
  editor.createBinding({
    type: 'arrow',
    fromId: arrowId,
    toId: targetId,
    props: {
      terminal: 'end',
      normalizedAnchor: { x: 0, y: 0.5 },
      isExact: false,
      isPrecise: true,
      snap: 'none'
    }
  })
}

export interface IterationLaneCards {
  aiCardId: TLShapeId
  genCardId: TLShapeId
}

/** 创建第 index 项分支：AI 处理快照头卡 + 生图快照卡 + 串行视觉箭头。
 *  连线语义（用户 2026-11-16）：循环 → AI 处理 → 生图 → 预览，一条分支一条串行链；
 *  生图 → 预览一段由产物落位时的溯源关系呈现（producerId=生图快照卡）。 */
export function createIterationLane(
  editor: Editor,
  loop: NodeCardShape,
  index: number,
  item: Record<string, unknown>,
  runId: string,
  count: number,
  anchor?: { x: number; y: number; w: number; h: number }
): IterationLaneCards {
  const layout = iterationFanoutLayout(loop, count, anchor)
  const y = layout.tops[Math.max(0, Math.min(index, layout.tops.length - 1))]
  const aiCardId = createShapeId()
  const genCardId = createShapeId()
  const genX = layout.originX + ITERATION_LANE_BRANCH_W + ITERATION_LANE_INNER_GAP
  editor.createShape({
    id: aiCardId,
    type: 'node-card',
    x: layout.originX,
    y,
    props: {
      nodeType: 'text',
      title: `AI 处理 · 镜头 ${index + 1}`,
      text: Object.keys(item).length > 0 ? JSON.stringify(item, null, 2) : '待处理…',
      w: ITERATION_LANE_BRANCH_W,
      h: ITERATION_LANE_BRANCH_H
    },
    meta: { ...laneMeta(loop, index, runId, 'ai-process'), nodeHeightMode: 'manual' }
  })
  editor.createShape({
    id: genCardId,
    type: 'node-card',
    x: genX,
    y,
    props: {
      nodeType: 'text',
      title: `生图 · 镜头 ${index + 1}`,
      text: '等待生成…',
      w: ITERATION_LANE_BRANCH_W,
      h: ITERATION_LANE_BRANCH_H
    },
    meta: { ...laneMeta(loop, index, runId, 'image-gen'), nodeHeightMode: 'manual' }
  })
  createLaneArrow(editor, loop, aiCardId, loop.id, index)
  const aiShape = editor.getShape<NodeCardShape>(aiCardId)
  if (aiShape) createLaneArrow(editor, aiShape, genCardId, loop.id, index)
  return { aiCardId, genCardId }
}

/** 运行启动即按完整 N 预铺所有分支骨架（待处理态），让用户立刻看到总量与对称布局；
 *  并发逐项填充时复用各自骨架，布局整轮固定不漂移。返回 index → 卡片 id 映射。 */
export function prelayoutIterationLanes(
  editor: Editor,
  loop: NodeCardShape,
  count: number,
  runId: string,
  anchor?: { x: number; y: number; w: number; h: number }
): Map<number, IterationLaneCards> {
  const map = new Map<number, IterationLaneCards>()
  const n = Math.max(1, Math.floor(count))
  for (let index = 0; index < n; index += 1) {
    map.set(index, createIterationLane(editor, loop, index, {}, runId, n, anchor))
  }
  return map
}

/** 更新分支头卡（AI 处理快照）的运行状态徽标。 */
export function setIterationLaneStatus(
  editor: Editor,
  aiCardId: TLShapeId,
  status: IterationLaneStatus
): void {
  const current = editor.getShape<NodeCardShape>(aiCardId)
  if (!current) return
  const meta = current.meta as Record<string, unknown>
  if (meta.iterationLaneStatus === status) return
  editor.updateShape({
    id: aiCardId,
    type: 'node-card',
    meta: { ...meta, iterationLaneStatus: status }
  })
}

/** 循环体产出文本（提示词）后，把 AI 处理快照卡正文替换为该轮提示词。 */
export function updateIterationLanePrompt(
  editor: Editor,
  aiCardId: TLShapeId,
  prompt: string
): void {
  const current = editor.getShape<NodeCardShape>(aiCardId)
  if (!current || current.props.text === prompt) return
  editor.updateShape({ id: aiCardId, type: 'node-card', props: { text: prompt } })
}

/** 生图快照卡：显示该轮提交摘要 + 提示词正文（只读投影）。 */
export function updateIterationLaneGen(
  editor: Editor,
  genCardId: TLShapeId,
  prompt: string,
  summary: string
): void {
  const current = editor.getShape<NodeCardShape>(genCardId)
  const text = summary ? `${summary}\n\n${prompt}` : prompt
  if (!current || current.props.text === text) return
  editor.updateShape({ id: genCardId, type: 'node-card', props: { text } })
}

/** 分支内第 siblingCount 个产物卡的位置：挂在生图快照卡右侧，多产物横向排开。 */
export function iterationLaneArtifactPosition(
  genCard: NodeCardShape,
  siblingCount: number
): { x: number; y: number } {
  const spec = getNodeType('image')
  const width = spec?.defaultSize.w ?? NODE_UI.width
  return {
    x: genCard.x + genCard.props.w + ITERATION_LANE_INNER_GAP + siblingCount * (width + 60),
    y: genCard.y
  }
}

/** 读取快照卡身份角色；非快照卡返回 null。 */
export function readIterationSnapshot(
  shape: NodeCardShape
): { role: IterationSnapshotRole; index: number } | null {
  if (shape.props.nodeType !== 'text') return null
  const meta = shape.meta as Record<string, unknown> | undefined
  const role = meta?.iterationLaneRole
  if (role !== 'ai-process' && role !== 'image-gen') return null
  const index = typeof meta?.iterationLaneIndex === 'number' ? meta.iterationLaneIndex : 0
  return { role, index }
}

/**
 * 把循环体定义链（AI 处理/生图模板节点）抬到扇出上方当模板行，
 * 让出中心行给分支（奇数项中间分支需与循环居中对齐）。保留各节点横向位置。
 */
export function liftIterationBodyDefinition(
  editor: Editor,
  bodyNodeIds: string[],
  fanTop: number
): void {
  const shapes = bodyNodeIds
    .map((id) => editor.getShape<NodeCardShape>(id as TLShapeId))
    .filter((shape): shape is NodeCardShape => shape !== undefined && shape.type === 'node-card')
  if (shapes.length === 0) return
  const maxH = Math.max(...shapes.map((shape) => shape.props.h))
  const targetY = fanTop - maxH - 60
  const updates = shapes
    .filter((shape) => shape.y > targetY)
    .map((shape) => ({ id: shape.id, type: 'node-card' as const, y: targetY }))
  if (updates.length > 0) editor.run(() => editor.updateShapes(updates), { history: 'ignore' })
}

/** 循环体模板组合框：把循环体定义节点收拢成「循环体 · 模板」组合，置于循环节点上方，
 *  虚线关联循环（本体一份紧凑模具，过程项实例链从循环右侧扇出）。复用组合折叠设施，
 *  展开即编辑真实定义节点；纯呈现，不改图模型与执行契约。 */
export function setupIterationTemplateGroup(
  editor: Editor,
  loop: NodeCardShape,
  bodyNodeIds: string[],
  anchor?: { x: number; y: number; w: number; h: number }
): void {
  const cards = bodyNodeIds
    .map((id) => editor.getShape<NodeCardShape>(id as TLShapeId))
    .filter((shape): shape is NodeCardShape => shape !== undefined && shape.type === 'node-card')
  if (cards.length === 0) return
  const base = anchor ?? { x: loop.x, y: loop.y, w: loop.props.w, h: loop.props.h }
  let group = editor
    .getCurrentPageShapes()
    .find(
      (shape) =>
        shape.type === 'group' &&
        (shape.meta as Record<string, unknown>)?.iterationTemplateLoopId === loop.id
    )
  if (
    !group &&
    cards.length >= 2 &&
    typeof editor.groupShapes === 'function' &&
    typeof editor.getShapePageBounds === 'function'
  ) {
    editor.groupShapes(cards.map((card) => card.id))
    const groupId = editor.getShape<NodeCardShape>(cards[0].id)?.parentId as TLShapeId
    if (groupId && editor.getShape(groupId)?.type === 'group') {
      collapseGroup(editor, groupId, '循环体 · 模板')
      const g = editor.getShape(groupId)
      editor.updateShape({
        id: groupId,
        type: 'group',
        meta: { ...(g?.meta ?? {}), iterationTemplateLoopId: loop.id }
      })
      group = editor.getShape(groupId)
    }
  }
  if (group) {
    const bounds = editor.getShapePageBounds(group.id)
    if (bounds) {
      const dx = base.x + base.w / 2 - (bounds.x + bounds.width / 2)
      const dy = base.y - 48 - bounds.maxY
      editor.updateShape({
        id: group.id,
        type: 'group',
        x: (group.x ?? 0) + dx,
        y: (group.y ?? 0) + dy
      })
    }
  } else {
    const maxH = Math.max(...cards.map((card) => card.props.h))
    const targetY = base.y - maxH - 48
    editor.run(
      () =>
        editor.updateShapes(
          cards
            .filter((card) => card.y > targetY)
            .map((card) => ({ id: card.id, type: 'node-card' as const, y: targetY }))
        ),
      { history: 'ignore' }
    )
  }
}

export function clearIterationLanes(editor: Editor, loopId: string): void {
  const stale = editor
    .getCurrentPageShapes()
    .filter((shape) => {
      const meta = shape.meta as Record<string, unknown> | undefined
      return (
        (shape.type === 'node-card' || shape.type === 'arrow') &&
        meta?.iterationLaneLoopId === loopId
      )
    })
    .map((shape) => shape.id)
  if (stale.length > 0) editor.deleteShapes(stale)
}
