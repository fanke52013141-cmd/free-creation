import { useEffect, useState, type RefObject } from 'react'
import {
  useEditor,
  useValue,
  type Editor,
  type TLSelectionBackgroundProps,
  type TLShapeId
} from 'tldraw'
import { markUndoPoint } from './history'
import { beginConnectionDrag } from './connection-drag'
import { batchConnectionFromSelection } from './batch-connection'
import type { ConnectionFrom } from '../stores/connection'

interface GroupOutlineLayerProps {
  editor: Editor
  hostRef: RefObject<HTMLDivElement | null>
}

interface GroupOutline {
  id: TLShapeId
  left: number
  top: number
  width: number
  height: number
  count: number
  label: string
  zoom: number
}

interface SelectionOutline {
  left: number
  top: number
  width: number
  height: number
  batchSource: ConnectionFrom | null
}

interface PageBoundsLike {
  x: number
  y: number
  maxX: number
  maxY: number
}

interface ScreenPoint {
  x: number
  y: number
}

interface SelectionGeometry {
  left: number
  top: number
  width: number
  height: number
}

// 选区框是纯视觉背景，固定为屏幕空间的留白，避免缩放后显得忽大忽小。
export const SELECTION_FRAME_OUTSET_PX = 24

/**
 * Derive every selection decoration from one page -> screen conversion. Do not add padding
 * here: tldraw's resize targets remain based on the unpadded bounds. The visual frame itself
 * has a separate fixed screen-space outset so it reads as a container around the selected nodes.
 */
function selectionGeometryFromPageBounds(
  bounds: PageBoundsLike,
  hostBounds: Pick<DOMRect, 'left' | 'top'>,
  pageToScreen: (point: ScreenPoint) => ScreenPoint
): SelectionGeometry {
  const topLeft = pageToScreen({ x: bounds.x, y: bounds.y })
  const bottomRight = pageToScreen({ x: bounds.maxX, y: bounds.maxY })
  const left = topLeft.x - hostBounds.left - SELECTION_FRAME_OUTSET_PX
  const top = topLeft.y - hostBounds.top - SELECTION_FRAME_OUTSET_PX
  const width = bottomRight.x - topLeft.x + SELECTION_FRAME_OUTSET_PX * 2
  const height = bottomRight.y - topLeft.y + SELECTION_FRAME_OUTSET_PX * 2

  return {
    left,
    top,
    width,
    height
  }
}

/**
 * 多选的磨砂框必须处于节点之下。把它挂到 tldraw 的 SelectionBackground 插槽，
 * 而不是作为 CanvasEditor 的兄弟覆盖层，才能维持正确的渲染顺序。
 */
export function CanvasSelectionBackground({
  bounds,
  rotation
}: TLSelectionBackgroundProps): React.JSX.Element | null {
  const editor = useEditor()
  const selectedCount = useValue(
    'selected node count for selection backdrop',
    () => selectedNodeIds(editor).length,
    [editor]
  )
  const zoom = useValue('selection backdrop zoom', () => editor.getCamera().z || 1, [editor])

  if (selectedCount < 2) return null

  const outset = SELECTION_FRAME_OUTSET_PX / zoom
  return (
    <div
      className="canvas-selection-underlay"
      aria-hidden="true"
      draggable={false}
      style={{
        width: bounds.width + outset * 2,
        height: bounds.height + outset * 2,
        transform: `translate(${bounds.x}px, ${bounds.y}px) rotate(${rotation}rad) translate(${-outset}px, ${-outset}px)`
      }}
    />
  )
}

function batchKey(source: ConnectionFrom | null): string {
  return source ? `${source.portId}:${source.memberIds?.join(':') ?? source.shapeId}` : ''
}

function selectedNodeIds(editor: Editor): TLShapeId[] {
  const ids = new Set<TLShapeId>()
  for (const shape of editor.getSelectedShapes()) {
    if (shape.type === 'node-card') ids.add(shape.id)
    if (shape.type === 'group') {
      for (const childId of editor.getSortedChildIdsForParent(shape.id)) {
        if (editor.getShape(childId)?.type === 'node-card') ids.add(childId)
      }
    }
  }
  return [...ids]
}

function outlinesEqual(left: GroupOutline[], right: GroupOutline[]): boolean {
  return (
    left.length === right.length &&
    left.every((item, index) => {
      const other = right[index]
      return (
        item.id === other.id &&
        item.left === other.left &&
        item.top === other.top &&
        item.width === other.width &&
        item.height === other.height &&
        item.count === other.count &&
        item.label === other.label &&
        item.zoom === other.zoom
      )
    })
  )
}

// 分组框上边距：节点标题栏（node-header）高 29px 悬浮在卡片上方，分组框必须整体
// 越过它，否则会框住最上一排节点的标题/正文（用户反馈的“框到节点信息”）。
const OUTLINE_TOP_PAD = 44
const OUTLINE_SIDE_PAD = 12
// 标签条带：显示在分组框上边缘外，双击进入重命名（window 捕获命中带，不拦截常规画布交互）
const LABEL_BAND_TOP = 26
const LABEL_BAND_HEIGHT = 20

/**
 * tldraw 原生 group 是一种父子状态，不是业务节点；这里仅补一层常驻视觉框。
 * 实际选择、移动、撤销和嵌套仍全部由 tldraw 的 groupShapes 管理。
 * 分组名保存在 group 形状的 meta.label（与 meta.nodeRun 等运行数据同层互不干扰）。
 */
export function GroupOutlineLayer({ editor, hostRef }: GroupOutlineLayerProps): React.JSX.Element {
  const [outlines, setOutlines] = useState<GroupOutline[]>([])
  const [selection, setSelection] = useState<SelectionOutline | null>(null)
  const [editingId, setEditingId] = useState<TLShapeId | null>(null)

  useEffect(() => {
    let frame = 0
    const updateNow = (): void => {
      const host = hostRef.current
      if (!host) return
      const hostBounds = host.getBoundingClientRect()
      const zoom = editor.getCamera().z || 1
      // 分组线框属于 page 几何的一部分：边距、圆角与标题都必须随画布缩放。
      // 原先在屏幕像素上固定 44px 顶部留白，缩小画布后它会远大于组内节点，造成
      // “分组变成细长胶囊”的错觉。
      const sidePad = OUTLINE_SIDE_PAD * zoom
      const topPad = OUTLINE_TOP_PAD * zoom
      const next: GroupOutline[] = []

      for (const shape of editor.getCurrentPageShapes()) {
        if (shape.type !== 'group') continue
        const bounds = editor.getShapePageBounds(shape.id)
        if (!bounds) continue
        const topLeft = editor.pageToScreen({ x: bounds.x, y: bounds.y })
        const bottomRight = editor.pageToScreen({ x: bounds.maxX, y: bounds.maxY })
        const count = editor
          .getSortedChildIdsForParent(shape.id)
          .filter((id) => editor.getShape(id)?.type === 'node-card').length
        if (count < 2) continue
        const meta = shape.meta as Record<string, unknown> | undefined
        const label = typeof meta?.label === 'string' ? meta.label : ''
        next.push({
          id: shape.id,
          left: topLeft.x - hostBounds.left - sidePad,
          top: topLeft.y - hostBounds.top - topPad,
          width: bottomRight.x - topLeft.x + sidePad * 2,
          height: bottomRight.y - topLeft.y + topPad + sidePad,
          count,
          label,
          zoom
        })
      }
      setOutlines((current) => (outlinesEqual(current, next) ? current : next))

      // 多选不是分组：只在 2 个以上节点被同时选中时绘制细虚线范围框，
      // 让它和常驻的分组容器维持完全不同的视觉语义。
      const selectedIds = selectedNodeIds(editor)
      if (selectedIds.length < 2) {
        setSelection((current) => (current === null ? current : null))
        return
      }
      const bounds = selectedIds
        .map((id) => editor.getShapePageBounds(id))
        .filter((bound): bound is NonNullable<typeof bound> => Boolean(bound))
      if (bounds.length < 2) return
      const minX = Math.min(...bounds.map((bound) => bound.x))
      const minY = Math.min(...bounds.map((bound) => bound.y))
      const maxX = Math.max(...bounds.map((bound) => bound.maxX))
      const maxY = Math.max(...bounds.map((bound) => bound.maxY))
      const geometry = selectionGeometryFromPageBounds(
        { x: minX, y: minY, maxX, maxY },
        hostBounds,
        (point) => editor.pageToScreen(point)
      )
      const nextSelection = {
        ...geometry,
        batchSource: batchConnectionFromSelection(editor, selectedIds)
      }
      setSelection((current) =>
        current &&
        current.left === nextSelection.left &&
        current.top === nextSelection.top &&
        current.width === nextSelection.width &&
        current.height === nextSelection.height &&
        batchKey(current.batchSource) === batchKey(nextSelection.batchSource)
          ? current
          : nextSelection
      )
    }

    // 拖动时 document/session 会在同一帧内连续变化；每帧最多计算一次分组框，
    // 避免额外的 pageToScreen 与 React state 更新拖慢节点拖拽。
    const update = (): void => {
      if (frame) return
      frame = requestAnimationFrame(() => {
        frame = 0
        updateNow()
      })
    }

    updateNow()
    const offDocument = editor.store.listen(update, { scope: 'document' })
    const offSession = editor.store.listen(update, { scope: 'session' })
    window.addEventListener('resize', update)
    return () => {
      offDocument()
      offSession()
      if (frame) cancelAnimationFrame(frame)
      window.removeEventListener('resize', update)
    }
  }, [editor, hostRef])

  // 双击分组名进入重命名：捕获阶段在 tldraw / 画布双击逻辑之前命中标签条带。
  // 常规单击/拖拽完全不受影响（本层 pointer-events: none，双击检测不占用任何交互）。
  useEffect(() => {
    const onDblClick = (e: MouseEvent): void => {
      if (editingId !== null) return
      const host = hostRef.current
      if (!host) return
      const hostBounds = host.getBoundingClientRect()
      const x = e.clientX - hostBounds.left
      const y = e.clientY - hostBounds.top
      for (const outline of outlines) {
        const hit =
          x >= outline.left &&
          x <= outline.left + outline.width &&
          y >= outline.top - LABEL_BAND_TOP * outline.zoom - 4 &&
          y <= outline.top - LABEL_BAND_TOP * outline.zoom + LABEL_BAND_HEIGHT * outline.zoom + 4
        if (hit) {
          e.preventDefault()
          e.stopPropagation()
          setEditingId(outline.id)
          return
        }
      }
    }
    window.addEventListener('dblclick', onDblClick, { capture: true })
    return () => window.removeEventListener('dblclick', onDblClick, { capture: true })
  }, [outlines, editingId, hostRef])

  const commitGroupName = (id: TLShapeId, next: string): void => {
    const trimmed = next.trim()
    const shape = editor.getShape(id)
    if (trimmed && shape) {
      editor.updateShape({ id, type: 'group', meta: { ...shape.meta, label: trimmed } })
      markUndoPoint(editor, 'rename-group')
    }
    setEditingId(null)
  }

  return (
    <div className="canvas-group-outline-layer">
      {outlines.map((outline) => (
        <div
          key={outline.id}
          className="canvas-group-outline"
          style={{
            left: outline.left,
            top: outline.top,
            width: outline.width,
            height: outline.height,
            ['--group-zoom' as string]: outline.zoom
          }}
        >
          {editingId === outline.id ? (
            <input
              className="canvas-group-name-input"
              aria-label="分组名称"
              defaultValue={outline.label || '分组'}
              autoFocus
              onFocus={(e) => e.currentTarget.select()}
              onBlur={(e) => commitGroupName(outline.id, e.currentTarget.value)}
              onKeyDown={(e) => {
                e.stopPropagation()
                if (e.key === 'Enter') commitGroupName(outline.id, e.currentTarget.value)
                else if (e.key === 'Escape') setEditingId(null)
              }}
            />
          ) : (
            <span>
              {outline.label
                ? `${outline.label} · ${outline.count} 个节点`
                : `分组 · ${outline.count} 个节点`}
            </span>
          )}
        </div>
      ))}
      {selection && (
        <>
          {selection.batchSource && (
            <>
              <span
                className="canvas-selection-batch-connector"
                aria-hidden="true"
                style={{
                  left: selection.left + selection.width,
                  top: selection.top + selection.height / 2
                }}
              />
              <button
                type="button"
                className="canvas-selection-batch-port"
                aria-label={`批量连接 ${selection.batchSource.memberIds?.length ?? 0} 个节点`}
                title="拖动此端口，将所有已选同类节点连接到目标的多值输入"
                style={{
                  // 端口和容器之间由细断续线相连，既保持轻盈，也明确它属于此选区。
                  left: selection.left + selection.width,
                  top: selection.top + selection.height / 2
                }}
                onPointerDown={(event) => {
                  event.preventDefault()
                  event.stopPropagation()
                  beginConnectionDrag(selection.batchSource!, {
                    x: event.clientX,
                    y: event.clientY
                  })
                }}
              >
                <span>{selection.batchSource.memberIds?.length}</span>
              </button>
            </>
          )}
        </>
      )}
    </div>
  )
}
