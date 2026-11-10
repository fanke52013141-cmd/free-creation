import type { Editor, TLShapeId } from 'tldraw'
import type { BackdropShape } from './BackdropShape'
import { NODE_PORT_OUTSET, NODE_PORT_SIZE } from './edge-geometry'

const ARRANGE_GAP = 24
const MIN_SIDE_PADDING = NODE_PORT_OUTSET + NODE_PORT_SIZE / 2 + 8

export function moveBackdrop(
  editor: Editor,
  board: BackdropShape,
  dx: number,
  dy: number,
  alreadyMoving: readonly TLShapeId[] = []
): void {
  if (dx === 0 && dy === 0) return
  const moving = new Set(alreadyMoving)
  const updates = [...new Set(board.props.memberIds)].flatMap((id) => {
    const member = editor.getShape(id)
    if (
      member?.type !== 'node-card' ||
      moving.has(id) ||
      editor.getShapeAncestors(member).some((ancestor) => moving.has(ancestor.id))
    ) return []
    const origin = editor.getShapePageTransform(member)?.point()
    if (!origin) return []
    const point = editor.getPointInParentSpace(member, { x: origin.x + dx, y: origin.y + dy })
    return [{ id, type: 'node-card' as const, x: point.x, y: point.y }]
  })
  if (moving.has(board.id)) {
    editor.updateShapes(updates)
    return
  }
  const origin = editor.getShapePageTransform(board)?.point()
  if (!origin) return
  const point = editor.getPointInParentSpace(board, { x: origin.x + dx, y: origin.y + dy })
  editor.updateShapes([...updates, { id: board.id, type: 'backdrop', x: point.x, y: point.y }])
}

export function arrangeBackdrop(
  editor: Editor,
  board: BackdropShape,
  layout: 'grid' | 'horizontal' | 'vertical' = 'grid'
): void {
  const members = board.props.memberIds.flatMap((id) => {
    const shape = editor.getShape(id)
    const bounds = editor.getShapePageBounds(id)
    return shape?.type === 'node-card' && bounds ? [{ shape, bounds }] : []
  })
  if (members.length < 2) return

  // 横排/纵排：忽略原有行列，按阅读方向把所有成员排成一行或一列。
  if (layout === 'horizontal' || layout === 'vertical') {
    const horizontal = layout === 'horizontal'
    members.sort((a, b) =>
      horizontal
        ? a.bounds.x - b.bounds.x || a.bounds.y - b.bounds.y
        : a.bounds.y - b.bounds.y || a.bounds.x - b.bounds.x
    )
    const left = Math.min(...members.map(({ bounds }) => bounds.x))
    const top = Math.min(...members.map(({ bounds }) => bounds.y))
    let cursor = horizontal ? left : top
    const updates = members.map(({ shape, bounds }) => {
      const origin = editor.getShapePageTransform(shape)?.point()
      const pageX = horizontal ? cursor : left
      const pageY = horizontal ? top : cursor
      cursor += (horizontal ? bounds.w : bounds.h) + ARRANGE_GAP
      const point = editor.getPointInParentSpace(shape, {
        x: pageX + (origin?.x ?? bounds.x) - bounds.x,
        y: pageY + (origin?.y ?? bounds.y) - bounds.y
      })
      return { id: shape.id, type: 'node-card' as const, x: point.x, y: point.y }
    })
    editor.updateShapes(updates)
    return
  }

  members.sort((a, b) => a.bounds.y - b.bounds.y || a.bounds.x - b.bounds.x)
  const rows: Array<typeof members> = []
  for (const member of members) {
    const row = rows.at(-1)
    const first = row?.[0].bounds
    if (row && first && member.bounds.y < first.y + first.h / 2) row.push(member)
    else rows.push([member])
  }
  const columnWidths: number[] = []
  for (const row of rows) {
    row.sort((a, b) => a.bounds.x - b.bounds.x)
    row.forEach(({ bounds }, column) => {
      columnWidths[column] = Math.max(columnWidths[column] ?? 0, bounds.w)
    })
  }
  let left = Math.min(...members.map(({ bounds }) => bounds.x))
  const columnPositions = columnWidths.map((width) => {
    const x = left
    left += width + ARRANGE_GAP
    return x
  })
  let y = members[0].bounds.y
  const updates = rows.flatMap((row) => {
    const positions = row.map(({ shape, bounds }, column) => {
      const origin = editor.getShapePageTransform(shape)?.point()
      const point = editor.getPointInParentSpace(shape, {
        x: columnPositions[column] + (origin?.x ?? bounds.x) - bounds.x,
        y: y + (origin?.y ?? bounds.y) - bounds.y
      })
      return { id: shape.id, type: 'node-card' as const, x: point.x, y: point.y }
    })
    y += Math.max(...row.map(({ bounds }) => bounds.h)) + ARRANGE_GAP
    return positions
  })
  editor.updateShapes(updates)
}

export function createBackdrop(editor: Editor, id: TLShapeId, memberIds: TLShapeId[]): void {
  const transferred = new Set(memberIds)
  for (const shape of editor.getCurrentPageShapes()) {
    if (shape.type !== 'backdrop') continue
    const remaining = shape.props.memberIds.filter((member) => !transferred.has(member))
    if (remaining.length !== shape.props.memberIds.length)
      editor.updateShape({ id: shape.id, type: 'backdrop', props: { memberIds: remaining } })
  }
  editor.createShape({
    id,
    type: 'backdrop',
    parentId: editor.getCurrentPageId(),
    props: { memberIds }
  })
  editor.sendToBack([id])
}

/** Reconcile stored board geometry with its live, page-space member bounds. */
export function syncBackdropLayouts(editor: Editor): void {
  for (const shape of editor.getCurrentPageShapes()) {
    if (shape.type !== 'backdrop') continue
    if (editor.isIn('select.translating') && editor.getSelectedShapeIds().includes(shape.id)) continue
    const memberIds: BackdropShape['props']['memberIds'] = []
    let left = Infinity
    let top = Infinity
    let right = -Infinity
    let bottom = -Infinity

    for (const id of new Set(shape.props.memberIds)) {
      if (
        editor.getShape(id)?.type !== 'node-card' ||
        editor.getAncestorPageId(id) !== shape.parentId
      )
        continue
      const bounds = editor.getShapePageBounds(id)
      if (!bounds) continue
      memberIds.push(id)
      left = Math.min(left, bounds.x)
      top = Math.min(top, bounds.y)
      right = Math.max(right, bounds.maxX)
      bottom = Math.max(bottom, bounds.maxY)
    }

    const { padding, w, h } = shape.props
    const leftPadding = Math.max(padding.left, MIN_SIDE_PADDING)
    const rightPadding = Math.max(padding.right, MIN_SIDE_PADDING)
    const x = memberIds.length ? left - leftPadding : shape.x
    const y = memberIds.length ? top - padding.top : shape.y
    const width = memberIds.length ? right - left + leftPadding + rightPadding : w
    const height = memberIds.length ? bottom - top + padding.top + padding.bottom : h
    if (
      x === shape.x &&
      y === shape.y &&
      width === w &&
      height === h &&
      memberIds.length === shape.props.memberIds.length
    )
      continue

    editor.updateShape({
      id: shape.id,
      type: 'backdrop',
      x,
      y,
      props: { w: width, h: height, memberIds }
    })
  }
}
