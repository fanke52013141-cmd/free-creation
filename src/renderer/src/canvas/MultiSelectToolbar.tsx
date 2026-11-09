import { useEffect, useState } from 'react'
import type { Editor, TLShapeId } from 'tldraw'
import { Icon } from '../components/Icon'
import {
  BACKDROP_COLOR_KEYS,
  BACKDROP_PALETTE,
  type BackdropColorKey,
  type BackdropShape
} from './BackdropShape'

interface MultiSelectToolbarProps {
  editor: Editor
  onRunFlow: (ids: TLShapeId[]) => void
  onSaveWorkflow: (ids: TLShapeId[]) => void
}

type AlignMode = 'left' | 'right' | 'center-h' | 'center-v' | 'distribute-h' | 'distribute-v'

interface ShapeBounds {
  id: TLShapeId
  x: number
  y: number
  w: number
  h: number
}

export function MultiSelectToolbar({
  editor,
  onRunFlow,
  onSaveWorkflow
}: MultiSelectToolbarProps): React.JSX.Element | null {
  const [selectedIds, setSelectedIds] = useState<TLShapeId[]>([])
  const [selectedGroupIds, setSelectedGroupIds] = useState<TLShapeId[]>([])
  const [selectedBackdropIds, setSelectedBackdropIds] = useState<TLShapeId[]>([])

  useEffect((): (() => void) => {
    const update = (): void => {
      const selected = editor.getSelectedShapes()
      setSelectedIds(selected.filter((s) => s.type === 'node-card').map((s) => s.id))
      // 选中的 tldraw group：包含节点子项时提供「拆分」入口。
      setSelectedGroupIds(
        selected
          .filter(
            (s) =>
              s.type === 'group' &&
              editor
                .getSortedChildIdsForParent(s.id)
                .some((id) => editor.getShape(id)?.type === 'node-card')
          )
          .map((s) => s.id)
      )
      // 单独选中背景板时给颜色/删除操作（背景板可自由改色与缩放）。
      setSelectedBackdropIds(selected.filter((s) => s.type === 'backdrop').map((s) => s.id))
    }
    update()
    const unsub = editor.store.listen(update, { scope: 'session' })
    return unsub
  }, [editor])

  // 单选节点时没有任何批量操作；但选中背景板时仍有"改色/删除"可用。
  if (selectedIds.length < 2 && selectedGroupIds.length === 0 && selectedBackdropIds.length === 0)
    return null

  const getBounds = (): ShapeBounds[] =>
    selectedIds.map((id) => {
      const s = editor.getShape(id)
      const w = (s?.props as { w?: number })?.w ?? 200
      const h = (s?.props as { h?: number })?.h ?? 120
      return { id, x: s?.x ?? 0, y: s?.y ?? 0, w, h }
    })

  const applyAlign = (mode: AlignMode): void => {
    const bounds = getBounds()
    if (bounds.length < 2) return

    editor.markHistoryStoppingPoint('align-nodes')

    const minX = Math.min(...bounds.map((b) => b.x))
    const maxX = Math.max(...bounds.map((b) => b.x + b.w))
    const minY = Math.min(...bounds.map((b) => b.y))
    const maxY = Math.max(...bounds.map((b) => b.y + b.h))
    const totalW = maxX - minX
    const totalH = maxY - minY

    switch (mode) {
      case 'left':
        bounds.forEach((b) => editor.updateShape({ id: b.id, type: 'node-card', x: minX }))
        break
      case 'right':
        bounds.forEach((b) => editor.updateShape({ id: b.id, type: 'node-card', x: maxX - b.w }))
        break
      case 'center-h': {
        const cx = (minX + maxX) / 2
        bounds.forEach((b) => editor.updateShape({ id: b.id, type: 'node-card', x: cx - b.w / 2 }))
        break
      }
      case 'center-v': {
        const cy = (minY + maxY) / 2
        bounds.forEach((b) => editor.updateShape({ id: b.id, type: 'node-card', y: cy - b.h / 2 }))
        break
      }
      case 'distribute-h': {
        // 横向均分：按 x 排序后等间距排列
        const sorted = [...bounds].sort((a, b) => a.x - b.x)
        const totalNodeW = sorted.reduce((sum, b) => sum + b.w, 0)
        const gap = sorted.length > 1 ? (totalW - totalNodeW) / (sorted.length - 1) : 0
        let cursor = minX
        sorted.forEach((b) => {
          editor.updateShape({ id: b.id, type: 'node-card', x: cursor })
          cursor += b.w + gap
        })
        break
      }
      case 'distribute-v': {
        // 纵向均分：按 y 排序后等间距排列
        const sorted = [...bounds].sort((a, b) => a.y - b.y)
        const totalNodeH = sorted.reduce((sum, b) => sum + b.h, 0)
        const gap = sorted.length > 1 ? (totalH - totalNodeH) / (sorted.length - 1) : 0
        let cursor = minY
        sorted.forEach((b) => {
          editor.updateShape({ id: b.id, type: 'node-card', y: cursor })
          cursor += b.h + gap
        })
        break
      }
    }
  }

  const handleGroup = (): void => {
    editor.markHistoryStoppingPoint('group-nodes')
    editor.groupShapes(selectedIds)
  }

  /**
   * 背景板（2026-11-09 用户需求）：
   * 把所选节点铺到一块**淡色可伸缩矩形**上做归类。矩形位于节点下方、可自由拖拽变宽变高；
   * 与「组合」不同，它不会给节点盖蒙版，也不会把节点变成子元素（节点保持独立清晰）。
   */
  const handleCreateBackdrop = (): void => {
    const bounds = getBounds()
    if (!bounds.length) return
    const PAD_X = 44
    const PAD_TOP = 56
    const PAD_BOTTOM = 36
    const minX = Math.min(...bounds.map((b) => b.x))
    const minY = Math.min(...bounds.map((b) => b.y))
    const maxX = Math.max(...bounds.map((b) => b.x + b.w))
    const maxY = Math.max(...bounds.map((b) => b.y + b.h))
    // 已有背景板覆盖同一区域时不再叠新板，改成把节点"塞进"那块板的范围（更符合归类直觉）。
    const existing = editor
      .getCurrentPageShapes()
      .filter((shape): shape is BackdropShape => shape.type === 'backdrop')
      .find((shape) => {
        const box = editor.getShapePageBounds(shape.id)
        return box && box.x <= minX + 8 && box.y <= minY + 8 && box.maxX >= maxX - 8 && box.maxY >= maxY - 8
      })
    editor.markHistoryStoppingPoint('create-backdrop')
    if (existing && existing.props.w >= maxX - minX + 2 * PAD_X) {
      editor.select(...selectedIds)
      return
    }
    const color: BackdropColorKey =
      BACKDROP_COLOR_KEYS[editor.getCurrentPageShapes().filter((s) => s.type === 'backdrop').length % BACKDROP_COLOR_KEYS.length] ?? 'teal'
    const backdrop = editor.createShape<BackdropShape>({
      type: 'backdrop',
      x: minX - PAD_X,
      y: minY - PAD_TOP,
      props: {
        w: maxX - minX + PAD_X * 2,
        h: maxY - minY + PAD_TOP + PAD_BOTTOM,
        color,
        label: '背景板'
      }
    })
    editor.sendToBack([backdrop.id as TLShapeId])
    // 创建后保持原有节点选择，方便继续操作。
    editor.select(...selectedIds)
  }

  const handleBackdropColor = (color: BackdropColorKey): void => {
    if (!selectedBackdropIds.length) return
    editor.markHistoryStoppingPoint('backdrop-color')
    editor.updateShapes(
      selectedBackdropIds.map((id) => ({ id, type: 'backdrop' as const, props: { color } }))
    )
  }

  const handleDeleteBackdrop = (): void => {
    if (!selectedBackdropIds.length) return
    editor.markHistoryStoppingPoint('delete-backdrop')
    editor.deleteShapes(selectedBackdropIds)
  }

  const handleUngroup = (): void => {
    if (!selectedGroupIds.length) return
    editor.markHistoryStoppingPoint('ungroup-nodes')
    editor.ungroupShapes(selectedGroupIds)
  }

  return (
    <div className="multiselect-toolbar">
      <div className="multiselect-toolbar__entrance">
        <div className="multiselect-toolbar__island">
          {selectedIds.length > 1 && (
            <>
              <button
                className="ms-btn"
                data-tool="align-left"
                aria-label="左对齐"
                onClick={() => applyAlign('left')}
              >
                <Icon name="align-left" size={16} />
              </button>
              <button
                className="ms-btn"
                data-tool="align-right"
                aria-label="右对齐"
                onClick={() => applyAlign('right')}
              >
                <Icon name="align-right" size={16} />
              </button>
              <button
                className="ms-btn"
                data-tool="align-center"
                aria-label="水平居中"
                onClick={() => applyAlign('center-h')}
              >
                <Icon name="align-horizontal" size={16} />
              </button>
              <button
                className="ms-btn"
                data-tool="align-middle"
                aria-label="垂直居中"
                onClick={() => applyAlign('center-v')}
              >
                <Icon name="align-vertical" size={16} />
              </button>
              <span className="ms-divider" />
              <button
                className="ms-btn"
                data-tool="distribute-h"
                aria-label="横向均分"
                onClick={() => applyAlign('distribute-h')}
              >
                <Icon name="distribute-horizontal" size={16} />
              </button>
              <button
                className="ms-btn"
                data-tool="distribute-v"
                aria-label="纵向均分"
                onClick={() => applyAlign('distribute-v')}
              >
                <Icon name="distribute-vertical" size={16} />
              </button>
              <span className="ms-divider" />
              <button
                className="ms-btn ms-group"
                data-tool="group"
                aria-label="组合"
                title="组合所选节点"
                onClick={handleGroup}
              >
                <Icon name="group" size={16} />
              </button>
              <button
                className="ms-btn ms-backdrop"
                data-tool="backdrop"
                aria-label="背景板"
                title="把所选节点铺到一块淡色背景板上（可自由拉伸，用于归类）"
                onClick={handleCreateBackdrop}
              >
                <Icon name="frame" size={16} />
              </button>
              <span className="ms-divider" />
              <button
                className="ms-btn ms-run"
                data-tool="run"
                aria-label="运行"
                onClick={() => onRunFlow(selectedIds)}
              >
                <Icon name="play" size={16} />
              </button>
            </>
          )}
          {/* 选中背景板时：改色 + 删除（不与节点多选操作混在一起）。 */}
          {selectedBackdropIds.length > 0 && (
            <>
              {BACKDROP_COLOR_KEYS.map((key) => (
                <button
                  key={key}
                  type="button"
                  className="ms-swatch"
                  aria-label={`背景板颜色 ${key}`}
                  title={`背景板颜色：${key}`}
                  onClick={() => handleBackdropColor(key)}
                  style={{ background: BACKDROP_PALETTE[key].dot }}
                />
              ))}
              <button
                className="ms-btn ms-backdrop-delete"
                type="button"
                aria-label="删除背景板"
                title="删除背景板（不会删除节点）"
                onClick={handleDeleteBackdrop}
              >
                <Icon name="close" size={16} />
              </button>
            </>
          )}
          {selectedIds.length > 1 && (
            <button
              className="ms-btn ms-template"
              data-tool="node-library"
              aria-label="保存节点"
              onClick={() => onSaveWorkflow(selectedIds)}
            >
              <Icon name="node-library" size={16} />
            </button>
          )}
          {selectedGroupIds.length > 0 && (
            <button
              className="ms-btn ms-ungroup"
              data-tool="ungroup"
              aria-label="取消组合"
              title="取消组合"
              onClick={handleUngroup}
            >
              <Icon name="ungroup" size={16} />
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
