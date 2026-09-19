import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { stopEventPropagation, useEditor, type Editor } from 'tldraw'
import {
  parseImageEditConfig,
  serializeImageEditConfig,
  validateImageEditConfig,
  type ImageEditAnnotation,
  type ImageEditAnnotationType,
  type ImageEditColor,
  type ImageEditConfig,
  type ImageEditPoint,
  type ImageEditAspectRatio,
  type ImageEditResolution
} from '@shared/image-edit'
import { resolveImageModelOption } from '@shared/engine/models'
import {
  imageCapabilitiesFor,
  imageEditSendsAspectRatio,
  imageEditSendsMask
} from '@shared/image-capabilities'
import { gatherUpstreamMedia } from '../../../canvas/graph'
import { readNodeConfig } from '../../../canvas/node-persistence'
import type { NodeCardShape } from '../../../canvas/NodeCardShape'
import { runNodeManually } from '../../../engine/executor'
import { modelsByModality, useGatewayStore } from '../../../stores/gateway'
import { useAppStore } from '../../../stores/app'
import { toast } from '../../../stores/toast'
import { Icon } from '../../../components/Icon'
import { AppSelect } from '../../../components/AppSelect'
import { mediaUrl, type NodeBodyProps, type NodeSettingsProps } from '../../registry'
import {
  clearSelectedMediaHistory,
  ImageContinuationActions,
  MediaFileActions,
  MediaResultGrid,
  MediaSourceBadge,
  ModelSelect,
  NoModelHint,
  removeMediaResultFromShape,
  selectMediaResult,
  useClickGuard,
  useSourceWiringNotice,
  useStoredNodeConfig
} from './shared'
import { markUndoPoint } from '../../../canvas/history'

const COLORS: Array<{ id: ImageEditColor; label: string }> = [
  { id: 'red', label: '红 · 修改' },
  { id: 'blue', label: '蓝 · 替换' },
  { id: 'yellow', label: '黄 · 保留' }
]
type ImageEditTool = ImageEditAnnotationType | 'mask' | 'move'
type MoveTarget = { kind: 'annotation'; id: string } | { kind: 'mask'; index: number }

const TOOLS: Array<{
  id: ImageEditTool
  label: string
  icon: 'move' | 'arrow' | 'rectangle' | 'brush' | 'text' | 'mask'
}> = [
  { id: 'move', label: '移动', icon: 'move' },
  { id: 'arrow', label: '箭头', icon: 'arrow' },
  { id: 'rect', label: '矩形', icon: 'rectangle' },
  { id: 'brush', label: '画笔', icon: 'brush' },
  { id: 'text', label: '文字', icon: 'text' },
  { id: 'mask', label: '遮罩', icon: 'mask' }
]
export function ImageEditBody({ shape, openPreview }: NodeBodyProps): React.JSX.Element {
  const guard = useClickGuard()
  const editor = useEditor()
  const source = gatherUpstreamMedia(editor, shape.id, 'in-image', 'image')
  const noSourceLine = useSourceWiringNotice(editor, shape.id, 'in-image', '原图')
  const [compareSource, setCompareSource] = useState(false)
  const [workbenchOpen, setWorkbenchOpen] = useState(false)
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState('')
  const instruction = parseImageEditConfig(readNodeConfig(shape)).instruction

  // 卸载时清理 tldraw 编辑态，防止键盘事件被画布扣留。
  useEffect(() => {
    return () => {
      if (editor.getEditingShapeId() === shape.id) editor.setEditingShape(null)
    }
  }, [editor, shape.id])

  const enterInlineEdit = (): void => {
    setDraft(instruction)
    setEditing(true)
    editor.setEditingShape(shape.id)
  }
  const exitInlineEdit = (): void => {
    setEditing(false)
    editor.setEditingShape(null)
  }
  const commitInline = (): void => {
    exitInlineEdit()
    if (draft === instruction) return
    editor.updateShape({
      id: shape.id,
      type: 'node-card',
      props: {
        config: serializeImageEditConfig({
          ...parseImageEditConfig(readNodeConfig(shape)),
          instruction: draft.slice(0, 4000)
        })
      }
    })
    markUndoPoint(editor, 'image-edit-inline-instruction')
  }

  const workbench = workbenchOpen ? (
    <ImageEditWorkbench shape={shape} editor={editor} onClose={() => setWorkbenchOpen(false)} />
  ) : null

  if (!shape.props.mediaPath)
    return (
      <div className="asset-empty image-edit-empty">
        <Icon name="image" size={40} />
        <span>P图</span>
        <span className="node-wiring warn">{noSourceLine}</span>
        <button
          className="btn-ghost small"
          onPointerDown={stopEventPropagation}
          onClick={(e) => {
            stopEventPropagation(e)
            setWorkbenchOpen(true)
          }}
        >
          打开工作台
        </button>
        {workbench}
      </div>
    )
  const chooseResult = (item: Parameters<typeof selectMediaResult>[1]): void => {
    const selected = selectMediaResult(shape, item)
    editor.updateShape({
      id: shape.id,
      type: 'node-card',
      props: selected.props,
      meta: { ...(shape.meta ?? {}), nodeResult: selected.nodeResult }
    })
    markUndoPoint(editor, 'image-edit-select-result')
  }
  return (
    <div className="node-media-wrap">
      <div
        className="node-media"
        data-node-interactive="media-preview"
        onPointerDown={guard.onPointerDown}
        onDoubleClick={(e) =>
          guard.onDoubleClick(e, () =>
            openPreview({
              kind: 'image',
              url: mediaUrl(shape.props.mediaPath),
              title: shape.props.title
            })
          )
        }
      >
        <img src={mediaUrl(shape.props.mediaPath)} alt={shape.props.title} draggable={false} />
      </div>
      <div className="node-media-actions">
        <button
          className="btn-ghost small"
          onPointerDown={stopEventPropagation}
          onClick={(e) => {
            stopEventPropagation(e)
            setWorkbenchOpen(true)
          }}
        >
          <Icon name="edit" size={13} /> 调整修改
        </button>
        {source ? (
          <button
            className={`btn-ghost small ${compareSource ? 'active' : ''}`}
            onPointerDown={stopEventPropagation}
            onClick={(event) => {
              stopEventPropagation(event)
              setCompareSource((current) => !current)
            }}
          >
            <Icon name="compare" size={13} /> {compareSource ? '收起对比' : '对比原图'}
          </button>
        ) : null}
        <MediaSourceBadge shape={shape} fallback="P图" />
        <MediaFileActions shape={shape} />
      </div>
      <div className="image-edit-inline">
        {editing ? (
          <textarea
            className="gen-prompt image-edit-inline-input"
            rows={2}
            value={draft}
            placeholder="描述需要修改的内容…"
            autoFocus
            onChange={(e) => setDraft(e.target.value)}
            onBlur={commitInline}
            onKeyDown={(e) => {
              if (e.key === 'Escape') {
                setDraft(instruction)
                exitInlineEdit()
              }
              if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') commitInline()
            }}
            onPointerDown={(e) => e.stopPropagation()}
            onMouseDown={(e) => e.stopPropagation()}
            onDoubleClick={(e) => e.stopPropagation()}
            onContextMenu={(e) => e.stopPropagation()}
          />
        ) : (
          <button
            className="image-edit-inline-btn"
            onPointerDown={(e) => e.stopPropagation()}
            onClick={(e) => {
              e.stopPropagation()
              enterInlineEdit()
            }}
          >
            <Icon name="edit" size={12} />
            <span className="image-edit-inline-text">{instruction || '点击输入 P 图说明…'}</span>
          </button>
        )}
      </div>
      {compareSource && source ? (
        <div className="image-edit-source-compare" aria-label="原图与修改结果对比">
          <figure>
            <img src={mediaUrl(source.mediaPath)} alt="原图" draggable={false} />
            <figcaption>原图</figcaption>
          </figure>
          <figure>
            <img src={mediaUrl(shape.props.mediaPath)} alt="修改结果" draggable={false} />
            <figcaption>修改结果</figcaption>
          </figure>
        </div>
      ) : null}
      <ImageContinuationActions editor={editor} shape={shape} />
      <MediaResultGrid
        shape={shape}
        kind="image"
        onSelect={chooseResult}
        onDelete={(item) => {
          const nodeResult = removeMediaResultFromShape(shape, item)
          if (!nodeResult) return
          editor.updateShape({
            id: shape.id,
            type: 'node-card',
            meta: { ...(shape.meta ?? {}), nodeResult }
          })
          markUndoPoint(editor, 'image-edit-delete-result')
        }}
        onClear={() => {
          const nodeResult = clearSelectedMediaHistory(shape)
          if (!nodeResult) return
          editor.updateShape({
            id: shape.id,
            type: 'node-card',
            meta: { ...(shape.meta ?? {}), nodeResult }
          })
          markUndoPoint(editor, 'image-edit-clear-result-history')
        }}
        openPreview={(item) =>
          openPreview({ kind: 'image', url: mediaUrl(item.mediaPath), title: shape.props.title })
        }
      />
      {workbench}
    </div>
  )
}

function pointFromEvent(event: React.PointerEvent, element: HTMLDivElement): ImageEditPoint {
  const bounds = element.getBoundingClientRect()
  return {
    x: Math.min(1, Math.max(0, (event.clientX - bounds.left) / bounds.width)),
    y: Math.min(1, Math.max(0, (event.clientY - bounds.top) / bounds.height))
  }
}

function arrowHead(
  points: ImageEditPoint[],
  strokeWidth = 3
): { polygon: string; lineEnd: { x: number; y: number } } | null {
  const end = points[points.length - 1]
  const previous = points[points.length - 2]
  if (!end || !previous) return null
  const dx = (end.x - previous.x) * 100
  const dy = (end.y - previous.y) * 100
  const dist = Math.hypot(dx, dy)
  if (dist < 0.2) return null
  const angle = Math.atan2(dy, dx)
  // 流线型倒钩箭头：长度随画笔粗细自适应，夹角约 26°，尾部做内凹倒钩
  const length = Math.min(dist * 0.42, Math.max(2.6, strokeWidth * 0.85 + 1.8))
  const theta = (26 * Math.PI) / 180
  const indent = length * 0.26
  const tip = { x: end.x * 100, y: end.y * 100 }
  const left = {
    x: tip.x - length * Math.cos(angle - theta),
    y: tip.y - length * Math.sin(angle - theta)
  }
  const right = {
    x: tip.x - length * Math.cos(angle + theta),
    y: tip.y - length * Math.sin(angle + theta)
  }
  const notch = {
    x: tip.x - (length - indent) * Math.cos(angle),
    y: tip.y - (length - indent) * Math.sin(angle)
  }
  const polygon = [tip, left, notch, right]
    .map((p) => `${p.x.toFixed(2)},${p.y.toFixed(2)}`)
    .join(' ')
  return { polygon, lineEnd: notch }
}

function normalizedRect(
  points: ImageEditPoint[]
): { x: number; y: number; width: number; height: number } | null {
  const start = points[0]
  const end = points[1]
  if (!start || !end) return null
  return {
    x: Math.min(start.x, end.x) * 100,
    y: Math.min(start.y, end.y) * 100,
    width: Math.abs(end.x - start.x) * 100,
    height: Math.abs(end.y - start.y) * 100
  }
}

const clampUnit = (value: number): number => Math.min(1, Math.max(0, value))

function distanceToSegment(
  point: ImageEditPoint,
  start: ImageEditPoint,
  end: ImageEditPoint
): number {
  const dx = end.x - start.x
  const dy = end.y - start.y
  const lengthSquared = dx * dx + dy * dy
  if (!lengthSquared) return Math.hypot(point.x - start.x, point.y - start.y)
  const t = clampUnit(((point.x - start.x) * dx + (point.y - start.y) * dy) / lengthSquared)
  return Math.hypot(point.x - (start.x + dx * t), point.y - (start.y + dy * t))
}

function annotationHit(annotation: ImageEditAnnotation, point: ImageEditPoint): boolean {
  const tolerance = Math.max(0.018, (annotation.strokeWidth ?? 3) / 260)
  if (annotation.type === 'text') {
    const anchor = annotation.points[0]
    if (!anchor) return false
    // SVG text 的锚点在左下角，不能只命中一个极小的点；按真实文本宽度和基线
    // 命中，文字中间任意位置都可被移动工具拖住。
    const width = Math.max(0.075, (annotation.text?.length ?? 1) * 0.036)
    const height = Math.max(0.055, tolerance * 3)
    return (
      point.x >= anchor.x - tolerance &&
      point.x <= anchor.x + width + tolerance &&
      point.y >= anchor.y - height - tolerance &&
      point.y <= anchor.y + tolerance
    )
  }
  if (annotation.type === 'rect') {
    const rect = normalizedRect(annotation.points)
    if (!rect) return false
    const x = point.x * 100
    const y = point.y * 100
    const pad = tolerance * 100
    return (
      x >= rect.x - pad &&
      x <= rect.x + rect.width + pad &&
      y >= rect.y - pad &&
      y <= rect.y + rect.height + pad
    )
  }
  return annotation.points.some((current, index, points) => {
    const previous = points[index - 1]
    return previous ? distanceToSegment(point, previous, current) <= tolerance : false
  })
}

function translatePoints(points: ImageEditPoint[], dx: number, dy: number): ImageEditPoint[] {
  return points.map((point) => ({ x: clampUnit(point.x + dx), y: clampUnit(point.y + dy) }))
}

function sameMoveTarget(left: MoveTarget | null, right: MoveTarget | null): boolean {
  if (!left || !right) return left === right
  return (
    left.kind === right.kind &&
    (left.kind === 'annotation' && right.kind === 'annotation'
      ? left.id === right.id
      : left.kind === 'mask' && right.kind === 'mask' && left.index === right.index)
  )
}

export function ImageEditSettings({
  shape,
  editor,
  projectId
}: NodeSettingsProps): React.JSX.Element {
  return (
    <section className="contract-section">
      <h4>P图</h4>
      <p className="contract-settings-hint">
        原图来自 in-image；标注仅作为修改参考，运行后输出新的图片资产。
      </p>
      <ImageEditEditorCore shape={shape} editor={editor} projectId={projectId} />
    </section>
  )
}

/** 标注编辑器核心：画布、工具、预设、颜色、遮罩、模型与运行。设置面板与弹窗工作台共用。 */
function ImageEditEditorCore({
  shape,
  editor,
  projectId,
  workbench = false
}: NodeSettingsProps & { workbench?: boolean }): React.JSX.Element {
  const previewRef = useRef<HTMLDivElement>(null)
  const textEntryRef = useRef<HTMLInputElement>(null)
  const draft = useRef<ImageEditAnnotation | null>(null)
  const maskDraft = useRef<ImageEditPoint[] | null>(null)
  const maskBase = useRef<ImageEditPoint[][]>([])
  const moveDraft = useRef<{
    target: MoveTarget
    start: ImageEditPoint
    base: ImageEditConfig
    latest: ImageEditConfig
  } | null>(null)
  // 卡片上可以直接改「修改说明」，弹窗工作台与设置面板也是同一份配置的两份视图，所以
  // 这里读文档而不是拷一份挂载时的镜像；overlay 只活在一次绘制手势里（见 save/finish）。
  const docConfig = parseImageEditConfig(useStoredNodeConfig(editor, shape.id))
  const [overlay, setOverlay] = useState<ImageEditConfig | null>(null)
  const config = overlay ?? docConfig
  const [storedTool, setStoredTool] = useState<ImageEditTool>('arrow')
  const [color, setColor] = useState<ImageEditColor>('red')
  const [aspect, setAspect] = useState(16 / 10)
  const [busy, setBusy] = useState(false)
  const [redoAnnotations, setRedoAnnotations] = useState<ImageEditAnnotation[]>([])
  const [textEntry, setTextEntry] = useState<{ point: ImageEditPoint; value: string } | null>(null)
  const [brushSize, setBrushSize] = useState(4)
  const [selectedMoveTarget, setSelectedMoveTarget] = useState<MoveTarget | null>(null)
  const source = gatherUpstreamMedia(editor, shape.id, 'in-image', 'image')
  const noSourceLine = useSourceWiringNotice(editor, shape.id, 'in-image', '原图')
  const providers = useGatewayStore((s) => s.providers)
  const options = modelsByModality(providers, 'image')
  const loaded = useGatewayStore((s) => s.loaded)
  const load = useGatewayStore((s) => s.load)
  const openProviderSettings = useGatewayStore((s) => s.openSettings)
  useEffect(() => {
    if (!loaded) void load()
  }, [loaded, load])

  const save = (next: ImageEditConfig, preserveRedo = false): void => {
    // 落库即交还给文档真值，overlay 只负责绘制手势中的即时预览。
    setOverlay(null)
    if (!preserveRedo) setRedoAnnotations([])
    editor.updateShape({
      id: shape.id,
      type: 'node-card',
      props: { config: serializeImageEditConfig(next) }
    })
  }

  const selectedOption =
    options.find((item) => item.key === config.modelKey) ?? resolveImageModelOption(options, config)
  const capabilities = selectedOption
    ? imageCapabilitiesFor(selectedOption.provider.specId, selectedOption.model.id)
    : null
  // 控件是否呈现由「网关会不会把这个字段发出去」决定（NODE_UI_SPEC §16.15）：TOAPIS 的
  // 异步任务端点没有 mask 字段，也不接收画幅遮罩，所以那条通道上连遮罩工具都不出现。
  const sendsMask = capabilities ? imageEditSendsMask(capabilities) : false
  const sendsRatio = capabilities ? imageEditSendsAspectRatio(capabilities) : false
  const ratioOptions: ImageEditAspectRatio[] = capabilities?.ratios ?? ['auto']
  const currentRatio: ImageEditAspectRatio = ratioOptions.includes(config.aspectRatio ?? 'auto')
    ? (config.aspectRatio ?? 'auto')
    : 'auto'
  const visibleTools = sendsMask ? TOOLS : TOOLS.filter((item) => item.id !== 'mask')
  // 切到不接收遮罩的通道时按渲染期派生回箭头，而不是在 effect 里补一次 setState。
  const tool: ImageEditTool = sendsMask || storedTool !== 'mask' ? storedTool : 'arrow'

  useEffect(() => {
    if (!textEntry) return
    const frame = requestAnimationFrame(() => textEntryRef.current?.focus())
    return () => cancelAnimationFrame(frame)
  }, [textEntry])
  const add = (annotation: ImageEditAnnotation): void =>
    save({ ...config, annotations: [...config.annotations, annotation].slice(-64) })
  const findMoveTarget = (point: ImageEditPoint): MoveTarget | null => {
    const annotation = [...config.annotations].reverse().find((item) => annotationHit(item, point))
    if (annotation) return { kind: 'annotation', id: annotation.id }
    const mask = config.mask
    if (!mask?.enabled) return null
    const tolerance = Math.max(0.025, mask.brushSize / 2)
    for (let index = mask.strokes.length - 1; index >= 0; index -= 1) {
      const stroke = mask.strokes[index]
      if (
        stroke?.some((current, pointIndex, points) => {
          const previous = points[pointIndex - 1]
          return previous ? distanceToSegment(point, previous, current) <= tolerance : false
        })
      ) {
        return { kind: 'mask', index }
      }
    }
    return null
  }
  const commitTextEntry = (): void => {
    if (!textEntry) return
    const text = textEntry.value.trim()
    const point = textEntry.point
    setTextEntry(null)
    if (!text) return
    add({
      id: `annotation-${Date.now()}`,
      type: 'text',
      color,
      points: [point],
      text,
      strokeWidth: brushSize
    })
  }
  const start = (event: React.PointerEvent<HTMLDivElement>): void => {
    stopEventPropagation(event)
    const el = previewRef.current
    if (!el) return
    const startPoint = pointFromEvent(event, el)
    if (tool === 'move') {
      const target = findMoveTarget(startPoint)
      if (!target) {
        setSelectedMoveTarget(null)
        return
      }
      moveDraft.current = { target, start: startPoint, base: config, latest: config }
      setSelectedMoveTarget(target)
      el.setPointerCapture(event.pointerId)
      return
    }
    if (tool === 'mask') {
      maskBase.current = config.mask?.strokes ?? []
      maskDraft.current = [startPoint]
      el.setPointerCapture(event.pointerId)
      return
    }
    if (tool === 'text') {
      setTextEntry({ point: startPoint, value: '' })
      return
    }
    draft.current = {
      id: `annotation-${Date.now()}`,
      type: tool,
      color,
      points: [startPoint],
      strokeWidth: brushSize
    }
    el.setPointerCapture(event.pointerId)
  }
  const move = (event: React.PointerEvent<HTMLDivElement>): void => {
    if (!previewRef.current) return
    if (maskDraft.current) {
      const next = [...maskDraft.current, pointFromEvent(event, previewRef.current)]
      maskDraft.current = next
      setOverlay({
        ...config,
        mask: {
          enabled: true,
          strokes: [...maskBase.current, next],
          brushSize: config.mask?.brushSize ?? 0.08,
          invert: config.mask?.invert ?? false
        }
      })
      return
    }
    if (moveDraft.current) {
      const active = moveDraft.current
      const point = pointFromEvent(event, previewRef.current)
      const dx = point.x - active.start.x
      const dy = point.y - active.start.y
      let next: ImageEditConfig
      if (active.target.kind === 'annotation') {
        const annotationId = active.target.id
        next = {
          ...active.base,
          annotations: active.base.annotations.map((annotation) =>
            annotation.id === annotationId
              ? { ...annotation, points: translatePoints(annotation.points, dx, dy) }
              : annotation
          )
        }
      } else {
        const maskIndex = active.target.index
        next = {
          ...active.base,
          mask: active.base.mask
            ? {
                ...active.base.mask,
                strokes: active.base.mask.strokes.map((stroke, index) =>
                  index === maskIndex ? translatePoints(stroke, dx, dy) : stroke
                )
              }
            : active.base.mask
        }
      }
      active.latest = next
      setOverlay(next)
      return
    }
    if (!draft.current) return
    const endPoint = pointFromEvent(event, previewRef.current)
    const next = {
      ...draft.current,
      // 箭头和矩形只需要起止点；保留 brush 的完整轨迹，避免画成闭合填充面。
      points:
        draft.current.type === 'arrow' || draft.current.type === 'rect'
          ? [draft.current.points[0], endPoint]
          : [...draft.current.points, endPoint]
    }
    draft.current = next
    setOverlay({
      ...config,
      annotations: [...config.annotations.filter((a) => a.id !== next.id), next]
    })
  }
  const finish = (): void => {
    if (maskDraft.current) {
      const stroke = maskDraft.current
      maskDraft.current = null
      if (stroke.length < 2) {
        // 起笔后又抬手：不落库，但预览残影必须交还给文档，否则会一直挂在图上。
        setOverlay(null)
        return
      }
      save({
        ...config,
        mask: {
          enabled: true,
          strokes: [...maskBase.current, stroke],
          brushSize: config.mask?.brushSize ?? 0.08,
          invert: config.mask?.invert ?? false
        }
      })
      return
    }
    if (moveDraft.current) {
      const next = moveDraft.current.latest
      moveDraft.current = null
      save(next)
      return
    }
    if (!draft.current) return
    const next = draft.current
    draft.current = null
    if (next.points.length < 2) {
      setOverlay(null)
      return
    }
    save({ ...config, annotations: [...config.annotations.filter((a) => a.id !== next.id), next] })
  }
  const removeLast = (): void => {
    const last = config.annotations.at(-1)
    if (!last) return
    setRedoAnnotations((items) => [last, ...items].slice(0, 64))
    save({ ...config, annotations: config.annotations.slice(0, -1) }, true)
  }
  const restoreLast = (): void => {
    const [next, ...rest] = redoAnnotations
    if (!next) return
    setRedoAnnotations(rest)
    save({ ...config, annotations: [...config.annotations, next].slice(-64) }, true)
  }
  const validationError = validateImageEditConfig(config)
  const run = async (): Promise<void> => {
    if (validationError) {
      toast(validationError)
      return
    }
    setBusy(true)
    try {
      await runNodeManually(editor, projectId, providers, shape.id)
    } finally {
      setBusy(false)
    }
  }
  const invalid = validationError
  return (
    <div className={`image-edit-settings ${workbench ? 'image-edit-settings-workbench' : ''}`}>
      {!source ? (
        <div className="crop-no-source">{noSourceLine}</div>
      ) : (
        <>
          <div
            ref={previewRef}
            className={`image-edit-preview tool-${tool}`}
            style={{ aspectRatio: aspect }}
            onPointerDown={start}
            onPointerMove={move}
            onPointerUp={finish}
            onPointerCancel={finish}
          >
            <img
              src={mediaUrl(source.mediaPath)}
              alt="待修改原图"
              draggable={false}
              onLoad={(e) => {
                if (e.currentTarget.naturalWidth)
                  setAspect(e.currentTarget.naturalWidth / e.currentTarget.naturalHeight)
              }}
            />
            <svg className="image-edit-overlay" viewBox="0 0 100 100" preserveAspectRatio="none">
              {config.mask?.enabled &&
                config.mask.strokes.map((stroke, index) => (
                  <polyline
                    key={`mask-${index}`}
                    points={stroke.map((p) => `${p.x * 100},${p.y * 100}`).join(' ')}
                    className={`image-edit-mask-mark ${sameMoveTarget(selectedMoveTarget, { kind: 'mask', index }) ? 'selected' : ''}`}
                    style={{ strokeWidth: Math.max(1, (config.mask?.brushSize ?? 0.08) * 100) }}
                  />
                ))}
              {config.annotations.map((a) => {
                const pts = a.points.map((p) => `${p.x * 100},${p.y * 100}`).join(' ')
                const selected = sameMoveTarget(selectedMoveTarget, {
                  kind: 'annotation',
                  id: a.id
                })
                if (a.type === 'rect') {
                  const rect = normalizedRect(a.points)
                  if (rect)
                    return (
                      <rect
                        key={a.id}
                        {...rect}
                        rx="1.5"
                        ry="1.5"
                        className={`image-edit-mark ${a.color} ${selected ? 'selected' : ''}`}
                        style={{ fill: 'none', strokeWidth: a.strokeWidth ?? 3 }}
                      />
                    )
                }
                if (a.type === 'text') {
                  const x = a.points[0].x * 100
                  const y = a.points[0].y * 100
                  return (
                    <g key={a.id} className={`image-edit-text-group ${selected ? 'selected' : ''}`}>
                      <text x={x} y={y} className={`image-edit-text ${a.color}`}>
                        {a.text}
                      </text>
                    </g>
                  )
                }
                if (a.type === 'arrow') {
                  const arrowInfo = arrowHead(a.points, a.strokeWidth ?? 3)
                  return (
                    <g key={a.id} className={selected ? 'selected' : ''}>
                      <line
                        x1={a.points[0].x * 100}
                        y1={a.points[0].y * 100}
                        x2={arrowInfo ? arrowInfo.lineEnd.x : a.points[a.points.length - 1].x * 100}
                        y2={arrowInfo ? arrowInfo.lineEnd.y : a.points[a.points.length - 1].y * 100}
                        className={`image-edit-mark ${a.color} ${selected ? 'selected' : ''}`}
                        style={{ strokeWidth: a.strokeWidth ?? 3, strokeLinecap: 'round' }}
                      />
                      {arrowInfo ? (
                        <polygon
                          points={arrowInfo.polygon}
                          className={`image-edit-arrow-head ${a.color} ${selected ? 'selected' : ''}`}
                        />
                      ) : null}
                    </g>
                  )
                }
                return (
                  <polyline
                    key={a.id}
                    points={pts}
                    className={`image-edit-mark ${a.color} ${selected ? 'selected' : ''}`}
                    style={{
                      strokeWidth: a.strokeWidth ?? 3,
                      strokeLinecap: 'round',
                      strokeLinejoin: 'round'
                    }}
                  />
                )
              })}
            </svg>
            {textEntry && (
              <input
                ref={textEntryRef}
                className="image-edit-text-entry"
                style={{ left: `${textEntry.point.x * 100}%`, top: `${textEntry.point.y * 100}%` }}
                value={textEntry.value}
                aria-label="输入图片标注文字"
                placeholder="输入文字后回车"
                onPointerDown={(event) => event.stopPropagation()}
                onChange={(event) =>
                  setTextEntry((current) =>
                    current ? { ...current, value: event.target.value.slice(0, 120) } : current
                  )
                }
                onBlur={commitTextEntry}
                onKeyDown={(event) => {
                  event.stopPropagation()
                  if (event.key === 'Enter') {
                    event.preventDefault()
                    commitTextEntry()
                  }
                  if (event.key === 'Escape') setTextEntry(null)
                }}
              />
            )}
          </div>
          <div className="image-edit-tools">
            {visibleTools.map((item) => (
              <button
                key={item.id}
                className={tool === item.id ? 'active' : ''}
                title={item.label}
                aria-pressed={tool === item.id}
                onPointerDown={stopEventPropagation}
                onClick={() => {
                  setStoredTool(item.id)
                  if (item.id !== 'move') setSelectedMoveTarget(null)
                }}
              >
                <Icon name={item.icon} size={13} />
                {item.label}
              </button>
            ))}
            <button
              title="撤销上一步标注"
              aria-label="撤销上一步标注"
              disabled={!config.annotations.length}
              onPointerDown={stopEventPropagation}
              onClick={removeLast}
            >
              <Icon name="undo" size={14} />
            </button>
            <button
              title="重做上一步标注"
              aria-label="重做上一步标注"
              disabled={!redoAnnotations.length}
              onPointerDown={stopEventPropagation}
              onClick={restoreLast}
            >
              <Icon name="redo" size={14} />
            </button>
            <button
              onPointerDown={stopEventPropagation}
              onClick={() => save({ ...config, annotations: [] })}
            >
              清空
            </button>
            {config.mask?.strokes.length ? (
              <button
                onPointerDown={stopEventPropagation}
                onClick={() => save({ ...config, mask: { ...config.mask!, strokes: [] } })}
              >
                清空遮罩
              </button>
            ) : null}
          </div>
          <div className="image-edit-colors">
            {COLORS.map((item) => (
              <button
                key={item.id}
                className={`image-edit-color ${item.id} ${color === item.id ? 'active' : ''}`}
                onPointerDown={stopEventPropagation}
                onClick={() => setColor(item.id)}
              >
                {item.label}
              </button>
            ))}
          </div>
          {(tool === 'brush' || tool === 'mask') && (
            <label className="image-edit-size-control">
              <span>{tool === 'mask' ? '遮罩大小' : '画笔粗细'}</span>
              <input
                type="range"
                min={tool === 'mask' ? '0.02' : '1'}
                max={tool === 'mask' ? '0.3' : '12'}
                step={tool === 'mask' ? '0.01' : '1'}
                value={tool === 'mask' ? (config.mask?.brushSize ?? 0.08) : brushSize}
                onPointerDown={(event) => event.stopPropagation()}
                onChange={(event) => {
                  const value = Number(event.target.value)
                  if (tool === 'mask') {
                    save({
                      ...config,
                      mask: {
                        ...(config.mask ?? {
                          enabled: true,
                          strokes: [],
                          brushSize: 0.08,
                          invert: false
                        }),
                        brushSize: value
                      }
                    })
                  } else {
                    setBrushSize(value)
                  }
                }}
              />
              <output>
                {tool === 'mask'
                  ? `${Math.round((config.mask?.brushSize ?? 0.08) * 100)}%`
                  : brushSize}
              </output>
            </label>
          )}
          {sendsMask && (
            <div className="image-edit-mask-options">
              <label>
                <input
                  type="checkbox"
                  checked={config.mask?.enabled ?? false}
                  onPointerDown={(e) => e.stopPropagation()}
                  onChange={(event) =>
                    save({
                      ...config,
                      mask: {
                        enabled: event.target.checked,
                        strokes: config.mask?.strokes ?? [],
                        brushSize: config.mask?.brushSize ?? 0.08,
                        invert: config.mask?.invert ?? false
                      }
                    })
                  }
                />
                启用遮罩
              </label>
              <label>
                <input
                  type="checkbox"
                  checked={config.mask?.invert ?? false}
                  disabled={!config.mask?.enabled}
                  onPointerDown={(e) => e.stopPropagation()}
                  onChange={(event) =>
                    save({
                      ...config,
                      mask: {
                        ...(config.mask ?? { enabled: true, strokes: [], brushSize: 0.08 }),
                        invert: event.target.checked
                      }
                    })
                  }
                />
                反选区域
              </label>
            </div>
          )}
          {!sendsMask && config.mask?.strokes.length ? (
            <p className="node-wiring warn">
              已画遮罩，但当前模型通道不接收遮罩字段，这次运行只按标注与修改说明处理。
            </p>
          ) : null}
        </>
      )}
      <div className="gen-row">
        <ModelSelect
          // 未显式选择模型时下拉直接落在解析出的默认模型上（ToAPIS 优先），
          // 用户 2026-09-18 拍板：图片节点默认就是 TOAPIS。
          value={config.modelKey || (selectedOption?.key ?? '')}
          options={options}
          onChange={(modelKey) => save({ ...config, modelKey })}
        />
        {sendsRatio && (
          <AppSelect
            className="gen-select w92"
            value={currentRatio}
            onPointerDown={(e) => e.stopPropagation()}
            onChange={(e) => {
              const val = e.target.value as ImageEditAspectRatio
              save({ ...config, aspectRatio: val })
            }}
            aria-label="选择画幅比例"
          >
            {ratioOptions.map((ratio) => (
              <option key={ratio} value={ratio}>
                {ratio === 'auto' ? '默认比例' : ratio}
              </option>
            ))}
          </AppSelect>
        )}
        {capabilities && capabilities.resolutions.length > 0 && (
          <AppSelect
            className="gen-select w86"
            value={config.resolution ?? capabilities.resolutions[0]}
            onPointerDown={(e) => e.stopPropagation()}
            onChange={(e) => save({ ...config, resolution: e.target.value as ImageEditResolution })}
            aria-label="选择分辨率"
          >
            {capabilities.resolutions.map((res) => (
              <option key={res} value={res}>
                {res}
              </option>
            ))}
          </AppSelect>
        )}
      </div>
      <textarea
        className="gen-prompt image-edit-instruction-input"
        rows={5}
        value={config.instruction}
        placeholder="描述需要修改的内容…"
        onPointerDown={(e) => e.stopPropagation()}
        onChange={(e) => save({ ...config, instruction: e.target.value.slice(0, 4000) })}
      />
      {invalid && <p className="crop-invalid">{invalid}</p>}
      {!options.length && (
        <NoModelHint onOpen={openProviderSettings} presetIds={['toapis', 'relay']} />
      )}
      <button
        className="btn-primary small gen-go"
        disabled={busy || !source || !options.length || Boolean(invalid)}
        onPointerDown={stopEventPropagation}
        onClick={(e) => {
          e.stopPropagation()
          void run()
        }}
      >
        {busy ? (
          '修改中…'
        ) : (
          <>
            <Icon name="spark" size={14} />
            运行 P 图
          </>
        )}
      </button>
    </div>
  )
}

/** P图工作台：全屏弹窗，复用标注编辑器核心。 */
function ImageEditWorkbench({
  shape,
  editor,
  onClose
}: {
  shape: NodeCardShape
  editor: Editor
  onClose: () => void
}): React.JSX.Element {
  const projectId = useAppStore((s) => s.currentProject)?.id ?? ''
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [onClose])
  return createPortal(
    <div
      className="director-studio-mask image-edit-workbench-mask"
      role="dialog"
      aria-modal="true"
      aria-label="P图工作台"
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose()
      }}
    >
      <div className="image-edit-workbench">
        <header className="image-edit-workbench-head">
          <div className="image-edit-workbench-title">
            <Icon name="edit" size={15} />
            <span>P图工作台</span>
          </div>
          <button
            className="btn-ghost small"
            onPointerDown={stopEventPropagation}
            onClick={(event) => {
              stopEventPropagation(event)
              onClose()
            }}
          >
            <Icon name="close" size={14} />
          </button>
        </header>
        <div className="image-edit-workbench-body">
          <ImageEditEditorCore shape={shape} editor={editor} projectId={projectId} workbench />
        </div>
      </div>
    </div>,
    document.body
  )
}
