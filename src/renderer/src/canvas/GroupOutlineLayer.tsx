import { useEffect, useState, type RefObject } from 'react'
import { createPortal } from 'react-dom'
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
import {
  collapsedGroupNodeIds,
  reconcileCollapsedStacks,
  toggleGroupCollapse
} from './stack-collapse'
import { Icon } from '../components/Icon'
import {
  SELECTION_FRAME_OUTSET_PX,
  selectionBoundsUnion,
  selectionGeometryFromPageBounds
} from './selection-geometry'
import type { PageBoundsLike } from './selection-geometry'
import type { ConnectionFrom } from '../stores/connection'

interface GroupOutlineLayerProps {
  editor: Editor
  hostRef: RefObject<HTMLDivElement | null>
  /** 折叠组合右上角"运行"图标：运行组合内全部节点（含依赖）。 */
  onRunFlow: (ids: TLShapeId[]) => void
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

/** 折叠组合：不画分组框，只在堆叠右上角浮【展开】【运行】两个图标。 */
interface CollapsedCombo {
  id: TLShapeId
  left: number
  top: number
  width: number
  height: number
  nodeCount: number
  zoom: number
}

interface SelectionOutline {
  left: number
  top: number
  width: number
  height: number
  hostLeft: number
  hostTop: number
  batchSource: ConnectionFrom | null
}

/**
 * 多选的磨砂框必须处于节点之下。把它挂到 tldraw 的 SelectionBackground 插槽，
 * 而不是作为 CanvasEditor 的兄弟覆盖层，才能维持正确的渲染顺序。
 */
export function CanvasSelectionBackground({
  bounds: _tldrawSelectionBounds,
  rotation: _tldrawSelectionRotation
}: TLSelectionBackgroundProps): React.JSX.Element | null {
  const editor = useEditor()
  // tldraw 的 SelectionBackground bounds 会把已选 arrow / edge 算进去。这里明确从
  // node-card（或所选 group 的直属 node-card 子项）重新计算，避免框选范围吞掉连线。
  const selectedNodeBounds = useValue(
    'selected node-only bounds for selection backdrop',
    () => selectionBoundsForNodes(editor, selectedNodeIds(editor)),
    [editor]
  )
  const zoom = useValue('selection backdrop zoom', () => editor.getCamera().z || 1, [editor])

  // Props 仍由 tldraw 注入；不以它的 bounds/rotation 作为视觉范围，见上方说明。
  void _tldrawSelectionBounds
  void _tldrawSelectionRotation
  if (!selectedNodeBounds) return null

  const outset = SELECTION_FRAME_OUTSET_PX / zoom
  // .node-header is positioned at top: -34px relative to the card. Include it in
  // the multi-selection bounds, with the same 12px breathing room as other edges.
  const headerOverhang = 34
  const topOutset = outset + headerOverhang
  return (
    <div
      className="canvas-selection-underlay"
      aria-hidden="true"
      draggable={false}
      style={{
        width: selectedNodeBounds.maxX - selectedNodeBounds.x + outset * 2,
        height: selectedNodeBounds.maxY - selectedNodeBounds.y + topOutset + outset,
        transform: `translate(${selectedNodeBounds.x}px, ${selectedNodeBounds.y}px) translate(${-outset}px, ${-topOutset}px)`
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

function selectionBoundsForNodes(
  editor: Editor,
  ids: readonly TLShapeId[]
): PageBoundsLike | null {
  if (ids.length < 2) return null
  return selectionBoundsUnion(ids.map((id) => editor.getShapePageBounds(id)))
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

function combosEqual(left: CollapsedCombo[], right: CollapsedCombo[]): boolean {
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
        item.nodeCount === other.nodeCount &&
        item.zoom === other.zoom
      )
    })
  )
}

// 分组框要越过悬浮在卡片上方 34px 的 node-header，再留出固定屏幕边距。
const OUTLINE_HEADER_OVERHANG = 34
const OUTLINE_TOP_PAD = 12
const OUTLINE_SIDE_PAD = 12
// 标签条带：显示在分组框上边缘外，双击进入重命名（window 捕获命中带，不拦截常规画布交互）
const LABEL_BAND_TOP = 26
const LABEL_BAND_HEIGHT = 20

/**
 * tldraw 原生 group 是一种父子状态，不是业务节点；这里仅补一层常驻视觉框。
 * 实际选择、移动、撤销和嵌套仍全部由 tldraw 的 groupShapes 管理。
 * 分组名保存在 group 形状的 meta.label（与 meta.nodeRun 等运行数据同层互不干扰）。
 */
export function GroupOutlineLayer({
  editor,
  hostRef,
  onRunFlow
}: GroupOutlineLayerProps): React.JSX.Element {
  const [outlines, setOutlines] = useState<GroupOutline[]>([])
  const [combos, setCombos] = useState<CollapsedCombo[]>([])
  const [selection, setSelection] = useState<SelectionOutline | null>(null)
  const [editingId, setEditingId] = useState<TLShapeId | null>(null)

  useEffect(() => {
    let frame = 0
    const updateNow = (): void => {
      const host = hostRef.current
      if (!host) return
      // 先校正被拖离堆叠的成员卡（恢复标题/端口），再计算本帧的视觉层。
      reconcileCollapsedStacks(editor)
      const hostBounds = host.getBoundingClientRect()
      const zoom = editor.getCamera().z || 1
      // 线框定位在屏幕覆盖层中，节点 page bounds 先转成屏幕坐标；留白使用固定屏幕像素，
      // 不再乘画布 zoom，避免缩放时框与节点之间的距离跟着变化。
      const sidePad = OUTLINE_SIDE_PAD
      const topPad = OUTLINE_HEADER_OVERHANG * zoom + OUTLINE_TOP_PAD
      const next: GroupOutline[] = []
      const nextCombos: CollapsedCombo[] = []

      for (const shape of editor.getCurrentPageShapes()) {
        if (shape.type !== 'group') continue
        const bounds = editor.getShapePageBounds(shape.id)
        if (!bounds) continue
        const topLeft = editor.pageToScreen({ x: bounds.x, y: bounds.y })
        const bottomRight = editor.pageToScreen({ x: bounds.maxX, y: bounds.maxY })
        const meta = shape.meta as Record<string, unknown> | undefined
        const label = typeof meta?.label === 'string' ? meta.label : ''
        const collapsed = meta?.collapsed === true
        const nodeIds = editor
          .getSortedChildIdsForParent(shape.id)
          .filter((id) => editor.getShape(id)?.type === 'node-card')
        if (nodeIds.length < 2) continue
        // 折叠组合是"节点状态"而非分组：外框按 Stitch 规格渲染（细边框+可复用徽标），
        // 右上角浮【展开】【运行】两个图标。首位卡标题隐藏后不需要 34px 头部缓冲。
        if (collapsed) {
          nextCombos.push({
            id: shape.id,
            left: topLeft.x - hostBounds.left - sidePad,
            top: topLeft.y - hostBounds.top - sidePad,
            width: bottomRight.x - topLeft.x + sidePad * 2,
            height: bottomRight.y - topLeft.y + sidePad * 2,
            nodeCount: collapsedGroupNodeIds(editor, shape.id).length,
            zoom
          })
          continue
        }
        next.push({
          id: shape.id,
          left: topLeft.x - hostBounds.left - sidePad,
          top: topLeft.y - hostBounds.top - topPad,
          width: bottomRight.x - topLeft.x + sidePad * 2,
          height: bottomRight.y - topLeft.y + topPad + sidePad,
          count: nodeIds.length,
          label,
          zoom
        })
      }
      setOutlines((current) => (outlinesEqual(current, next) ? current : next))
      setCombos((current) => (combosEqual(current, nextCombos) ? current : nextCombos))

      // 多选不是分组：只在 2 个以上节点被同时选中时绘制细虚线范围框，
      // 让它和常驻的分组容器维持完全不同的视觉语义。
      const selectedIds = selectedNodeIds(editor)
      if (selectedIds.length < 2) {
        setSelection((current) => (current === null ? current : null))
        return
      }
      const nodeBounds = selectionBoundsForNodes(editor, selectedIds)
      const geometry = selectionGeometryFromPageBounds(
        nodeBounds,
        hostBounds,
        (point) => editor.pageToScreen(point)
      )
      if (!geometry) {
        setSelection((current) => (current === null ? current : null))
        return
      }
      const nextSelection = {
        ...geometry,
        hostLeft: hostBounds.left,
        hostTop: hostBounds.top,
        batchSource: batchConnectionFromSelection(editor, selectedIds)
      }
      setSelection((current) =>
        current &&
        current.left === nextSelection.left &&
        current.top === nextSelection.top &&
        current.width === nextSelection.width &&
        current.height === nextSelection.height &&
        current.hostLeft === nextSelection.hostLeft &&
        current.hostTop === nextSelection.hostTop &&
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
    window.addEventListener('scroll', update, true)
    return () => {
      offDocument()
      offSession()
      if (frame) cancelAnimationFrame(frame)
      window.removeEventListener('resize', update)
      window.removeEventListener('scroll', update, true)
    }
  }, [editor, hostRef])

  // 双击分组名进入重命名：捕获阶段在 tldraw / 画布双击逻辑之前命中标签条带。
  // 折叠/展开按钮上的双击不属于重命名意图，先排除。
  useEffect(() => {
    const onDblClick = (e: MouseEvent): void => {
      if (editingId !== null) return
      if (e.target instanceof Element && e.target.closest('button')) return
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

  const batchPort =
    selection?.batchSource
      ? createPortal(
          <button
            type="button"
            className="canvas-selection-batch-port"
            aria-label={`批量连接 ${selection.batchSource.memberIds?.length ?? 0} 个节点`}
            style={{
              left: selection.hostLeft + selection.left + selection.width,
              top: selection.hostTop + selection.top + selection.height / 2
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
          </button>,
          document.body
        )
      : null

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
          <button
            type="button"
            className="canvas-group-collapse-btn"
            aria-label="折叠组合"
            title="折叠组合"
            onClick={(event) => {
              event.stopPropagation()
              toggleGroupCollapse(editor, outline.id)
            }}
          >
            <Icon name="fold" size={14} />
          </button>
        </div>
      ))}
      {combos.map((combo) => (
        <div
          key={combo.id}
          className="canvas-combo-frame"
          style={{
            left: combo.left,
            top: combo.top,
            width: combo.width,
            height: combo.height,
            ['--combo-zoom' as string]: combo.zoom
          }}
        >
          <span className="canvas-combo-badge" title={`可复用组合 · ${combo.nodeCount} 个节点`}>
            <Icon name="layers" size={12} />
            可复用
          </span>
          <button
            type="button"
            className="canvas-combo-btn"
            aria-label="展开组合"
            title={`展开组合（${combo.nodeCount} 个节点）`}
            onClick={(event) => {
              event.stopPropagation()
              toggleGroupCollapse(editor, combo.id)
            }}
          >
            <Icon name="unfold" size={14} />
          </button>
          <button
            type="button"
            className="canvas-combo-btn canvas-combo-run"
            aria-label="运行组合"
            title={`运行组合内 ${combo.nodeCount} 个节点及依赖`}
            onClick={(event) => {
              event.stopPropagation()
              onRunFlow(collapsedGroupNodeIds(editor, combo.id))
            }}
          >
            <Icon name="play" size={14} />
          </button>
        </div>
      ))}
      {batchPort}
    </div>
  )
}
