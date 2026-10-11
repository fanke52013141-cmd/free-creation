// 组合折叠：把分组内的节点卡片在画布上收拢成堆叠呈现。
// 纯呈现层调整——只改形状位置、z 序和 meta 标记，不改图模型、连线与运行契约。
// 展开前的布局保存在 group.meta.stackLayout，随画布文档持久化，重载后仍可展开。
import type { Editor, TLShapeId } from 'tldraw'
import type { NodeCardShape } from './NodeCardShape'
import { markUndoPoint } from './history'

/** 堆叠时相邻卡片的错位步长（页单位），向右下角逐层递进，露出层级边缘。 */
const STACK_STEP = 18

/** group.meta 里保存的展开布局条目。type 别名（非 interface）才能赋给 JsonValue。 */
type StackLayoutEntry = {
  id: string
  x: number
  y: number
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
  editor.run(() => {
    const layout: StackLayoutEntry[] = cards.map((card) => ({ id: card.id, x: card.x, y: card.y }))
    const base = cards[0]
    editor.updateShapes(
      cards.map((card, index) => ({
        id: card.id,
        type: 'node-card' as const,
        x: base.x + index * STACK_STEP,
        y: base.y + index * STACK_STEP,
        meta: { ...card.meta, stackRole: index === 0 ? 'top' : 'member' }
      }))
    )
    editor.updateShape({
      id: groupId,
      type: 'group',
      meta: {
        ...group.meta,
        collapsed: true,
        stackLayout: layout,
        ...(label ? { label } : {})
      }
    })
    const arrows = arrowsTouchingMembers(editor, new Set(cards.map((card) => card.id)))
    if (arrows.length > 0) editor.sendToBack(arrows)
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

/** 展开/收拢切换：分组标签条上的图标按钮使用。 */
export function toggleGroupCollapse(editor: Editor, groupId: TLShapeId): void {
  if (isGroupCollapsed(editor, groupId)) expandGroup(editor, groupId)
  else collapseGroup(editor, groupId)
}
