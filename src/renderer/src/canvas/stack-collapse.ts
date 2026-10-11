// 组合折叠：把分组内的节点卡片在画布上收拢成堆叠呈现。
// 纯呈现层调整——只改形状位置、z 序和 meta 标记，不改图模型、连线与运行契约。
// 展开前的布局保存在 group.meta.stackLayout，随画布文档持久化，重载后仍可展开。
import type { Editor, TLShapeId } from 'tldraw'
import type { NodeCardShape } from './NodeCardShape'
import { markUndoPoint } from './history'

/** 堆叠时相邻卡片的错位步长（屏幕像素恒定，按 zoom 换算为页单位）。 */
const STACK_STEP_PX = 20

/** 成员卡被拖离堆叠的判定容差（屏幕像素）。 */
const FREE_PX = 48

/** group.meta 里保存的展开布局条目。type 别名（非 interface）才能赋给 JsonValue。 */
type StackLayoutEntry = {
  id: string
  x: number
  y: number
}

/** 折叠时被隐藏的组内连线（展开时恢复）。 */
type StackArrowEntry = {
  id: string
  opacity: number
}

function nodeCardsInGroup(editor: Editor, groupId: TLShapeId): NodeCardShape[] {
  return editor
    .getSortedChildIdsForParent(groupId)
    .map((id) => editor.getShape<NodeCardShape>(id))
    .filter((shape): shape is NodeCardShape => shape?.type === 'node-card')
}

function readLayout(editor: Editor, groupId: TLShapeId): StackLayoutEntry[] {
  const meta = editor.getShape(groupId)?.meta as Record<string, unknown> | undefined
  const layout = meta?.stackLayout
  if (!Array.isArray(layout)) return []
  return layout.filter(
    (item): item is StackLayoutEntry =>
      typeof item === 'object' &&
      item !== null &&
      typeof (item as StackLayoutEntry).id === 'string' &&
      typeof (item as StackLayoutEntry).x === 'number' &&
      typeof (item as StackLayoutEntry).y === 'number'
  )
}

function readHiddenArrows(editor: Editor, groupId: TLShapeId): StackArrowEntry[] {
  const meta = editor.getShape(groupId)?.meta as Record<string, unknown> | undefined
  const arrows = meta?.stackArrows
  if (!Array.isArray(arrows)) return []
  return arrows.filter(
    (item): item is StackArrowEntry =>
      typeof item === 'object' &&
      item !== null &&
      typeof (item as StackArrowEntry).id === 'string' &&
      typeof (item as StackArrowEntry).opacity === 'number'
  )
}

export function isGroupCollapsed(editor: Editor, groupId: TLShapeId): boolean {
  const meta = editor.getShape(groupId)?.meta as Record<string, unknown> | undefined
  return meta?.collapsed === true
}

/** 组内两两相连的 arrow：折叠时压到卡片之下，避免短线头浮在堆叠表面。 */
function arrowsTouchingMembers(editor: Editor, memberIds: Set<TLShapeId>): TLShapeId[] {
  const ids: TLShapeId[] = []
  for (const shape of editor.getCurrentPageShapes()) {
    if (shape.type !== 'arrow') continue
    const bindings = editor.getBindingsFromShape(shape.id, 'arrow')
    if (bindings.some((binding) => memberIds.has(binding.toId))) ids.push(shape.id)
  }
  return ids
}

/** 收拢分组：顶层卡片留在原位，其余成员向右下角逐层错位堆叠，只露最上层完整卡片。 */
export function collapseGroup(editor: Editor, groupId: TLShapeId, label?: string): void {
  const cards = nodeCardsInGroup(editor, groupId)
  if (cards.length < 2) return
  const group = editor.getShape(groupId)
  if (!group) return

  markUndoPoint(editor, 'before-collapse-group')
  const zoom = editor.getCamera().z || 1
  const step = STACK_STEP_PX / zoom
  editor.run(() => {
    const layout: StackLayoutEntry[] = cards.map((card) => ({ id: card.id, x: card.x, y: card.y }))
    // getSortedChildIdsForParent 按 index 升序返回（画布从底到顶）。
    // 首位卡必须是视觉最上层（数组末位，z 序天然最高），否则它会被
    // 成员卡盖住，"折叠节点"的摘要永远看不见。
    const topCard = cards[cards.length - 1]
    const base = cards[0]
    const members = cards.filter((card) => card.id !== topCard.id)
    editor.updateShapes([
      ...members.map((card, index) => ({
        id: card.id,
        type: 'node-card' as const,
        x: base.x + (index + 1) * step,
        y: base.y + (index + 1) * step,
        meta: {
          ...card.meta,
          stackRole: 'member',
          // meta 必须是纯 JSON：undefined 会让 tldraw 校验拒绝整次更新。
          // 成员卡不消费该值，占位 0 即可。
          stackCount: card.meta.stackCount ?? 0
        }
      })),
      {
        id: topCard.id,
        type: 'node-card' as const,
        x: base.x,
        y: base.y,
        meta: { ...topCard.meta, stackRole: 'top', stackCount: cards.length }
      }
    ])
    // 组内连线整体隐形：折叠态是节点状态，连线两端只剩线头露出，很难看。
    // 原 opacity 记录在 group.meta.stackArrows，展开时恢复。
    const memberIds = new Set(cards.map((card) => card.id))
    const hiddenArrows: StackArrowEntry[] = arrowsTouchingMembers(editor, memberIds).map((id) => ({
      id,
      opacity: editor.getShape(id)?.opacity ?? 1
    }))
    if (hiddenArrows.length > 0) {
      editor.updateShapes(
        hiddenArrows.map((arrow) => ({
          id: arrow.id as TLShapeId,
          type: 'arrow' as const,
          opacity: 0
        }))
      )
    }
    editor.updateShape({
      id: groupId,
      type: 'group',
      meta: {
        ...group.meta,
        collapsed: true,
        stackLayout: layout,
        stackArrows: hiddenArrows,
        stackZoom: zoom,
        ...(label ? { label } : {})
      }
    })
  })
  markUndoPoint(editor, 'collapse-group')
}

/** 展开分组：按折叠前保存的布局还原位置，恢复卡片标题与端口。 */
export function expandGroup(editor: Editor, groupId: TLShapeId): void {
  const cards = nodeCardsInGroup(editor, groupId)
  const layout = readLayout(editor, groupId)
  if (cards.length < 2 || layout.length === 0) return
  const group = editor.getShape(groupId)
  if (!group) return

  markUndoPoint(editor, 'before-expand-group')
  editor.run(() => {
    const restore = new Map(layout.map((entry) => [entry.id, entry]))
    editor.updateShapes(
      cards.map((card) => {
        const saved = restore.get(card.id)
        return {
          id: card.id,
          type: 'node-card' as const,
          x: saved?.x ?? card.x,
          y: saved?.y ?? card.y,
          // updateShape 的 meta 是合并语义，无法通过缺省键删除字段；显式写失效值。
          meta: { ...card.meta, stackRole: '' }
        }
      })
    )
    editor.updateShape({
      id: groupId,
      type: 'group',
      meta: { ...group.meta, collapsed: false }
    })
    const hiddenArrows = readHiddenArrows(editor, groupId)
    if (hiddenArrows.length > 0) {
      editor.updateShapes(
        hiddenArrows.map((arrow) => ({
          id: arrow.id as TLShapeId,
          type: 'arrow' as const,
          opacity: arrow.opacity
        }))
      )
    }
  })
  markUndoPoint(editor, 'expand-group')
}

/** 把当前选中的多个节点先打组再收拢（保存为可复用内容后的默认呈现）。 */
export function collapseSelection(
  editor: Editor,
  nodeIds: TLShapeId[],
  label?: string
): TLShapeId | null {
  const cards = nodeIds
    .map((id) => editor.getShape<NodeCardShape>(id))
    .filter((shape): shape is NodeCardShape => shape?.type === 'node-card')
  if (cards.length < 2) return null

  // parentId 可能是页面 id（未打组）或 group id；只按 group 处理。
  let groupId: TLShapeId | undefined =
    editor.getShape<NodeCardShape>(cards[0].id)?.type === 'node-card'
      ? (cards[0].parentId as TLShapeId)
      : undefined
  if (!groupId || editor.getShape(groupId)?.type !== 'group') {
    editor.groupShapes(cards.map((card) => card.id))
    groupId = editor.getShape<NodeCardShape>(cards[0].id)?.parentId as TLShapeId
  }
  if (!groupId || editor.getShape(groupId)?.type !== 'group') return null
  collapseGroup(editor, groupId, label)
  return groupId
}

/** 展开/收拢切换：折叠节点右上角的展开图标使用。 */
export function toggleGroupCollapse(editor: Editor, groupId: TLShapeId): void {
  if (isGroupCollapsed(editor, groupId)) expandGroup(editor, groupId)
  else collapseGroup(editor, groupId)
}

/** 折叠组合内成员卡的呈现与位置校正：
 *  - zoom 变化：堆叠偏移按屏幕像素恒定换算，把仍在堆叠位的成员重排
 *    （不入撤销历史，缩放不算用户操作）；
 *  - zoom 未变：按相对位置判定成员是否被单独拖离堆叠，拖离则清除
 *    呈现标记恢复标题/端口。相对判定保证拖动整个组合不会误判。 */
export function reconcileCollapsedStacks(editor: Editor): void {
  const zoom = editor.getCamera().z || 1
  for (const shape of editor.getCurrentPageShapes()) {
    if (shape.type !== 'group' || !isGroupCollapsed(editor, shape.id)) continue
    const cards = nodeCardsInGroup(editor, shape.id)
    const top = cards.find(
      (card) => (card.meta as Record<string, unknown> | undefined)?.stackRole === 'top'
    )
    if (!top) continue
    const members = cards.filter(
      (card) => (card.meta as Record<string, unknown> | undefined)?.stackRole === 'member'
    )
    const groupMeta = shape.meta as Record<string, unknown> | undefined
    const lastZoom = typeof groupMeta?.stackZoom === 'number' ? groupMeta.stackZoom : zoom

    if (Math.abs(lastZoom - zoom) > 0.001) {
      // zoom 变化：把仍贴在堆叠期望位的成员搬新期望位；被拖离的不动。
      const oldStep = STACK_STEP_PX / lastZoom
      const newStep = STACK_STEP_PX / zoom
      const tol = 4 / lastZoom
      const moves = members
        .map((card, index) => ({ card, index }))
        .filter(({ card, index }) => {
          const dx = card.x - top.x
          const dy = card.y - top.y
          return (
            Math.abs(dx - (index + 1) * oldStep) <= tol &&
            Math.abs(dy - (index + 1) * oldStep) <= tol
          )
        })
        .map(({ card, index }) => ({
          id: card.id,
          type: 'node-card' as const,
          x: top.x + (index + 1) * newStep,
          y: top.y + (index + 1) * newStep
        }))
      editor.run(
        () => {
          if (moves.length > 0) editor.updateShapes(moves)
          editor.updateShape({
            id: shape.id,
            type: 'group',
            meta: { ...shape.meta, stackZoom: zoom }
          })
        },
        { history: 'ignore' }
      )
      continue
    }

    // zoom 未变：拖离判定（相对 top 的偏移，容差按屏幕像素换算）。
    const tol = FREE_PX / zoom
    const step = STACK_STEP_PX / zoom
    const metaUpdatesForGroup: {
      id: TLShapeId
      type: 'node-card'
      meta: Record<string, string | number | boolean | null>
    }[] = []
    for (const [index, card] of members.entries()) {
      const dx = card.x - top.x
      const dy = card.y - top.y
      if (
        Math.abs(dx - (index + 1) * step) > tol ||
        Math.abs(dy - (index + 1) * step) > tol
      ) {
        metaUpdatesForGroup.push({
          id: card.id,
          type: 'node-card',
          meta: { ...card.meta, stackRole: '' }
        })
      }
    }
    if (metaUpdatesForGroup.length > 0) editor.updateShapes(metaUpdatesForGroup)
  }
}

/** 折叠组合当前包含的节点（运行入口使用；被拖离的成员不计入）。 */
export function collapsedGroupNodeIds(editor: Editor, groupId: TLShapeId): TLShapeId[] {
  const cards = nodeCardsInGroup(editor, groupId)
  const top = cards.find(
    (card) => (card.meta as Record<string, unknown> | undefined)?.stackRole === 'top'
  )
  if (!top) return cards.map((card) => card.id)
  return cards
    .filter((card) => {
      const role = (card.meta as Record<string, unknown> | undefined)?.stackRole
      return role === 'top' || role === 'member'
    })
    .map((card) => card.id)
}
