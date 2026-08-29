import { useEffect, useRef, useState } from 'react'
import { stopEventPropagation, useEditor } from 'tldraw'
import {
  parseImageEditConfig,
  serializeImageEditConfig,
  validateImageEditConfig,
  type ImageEditAnnotation,
  type ImageEditAnnotationType,
  type ImageEditColor,
  type ImageEditConfig,
  type ImageEditPoint,
  IMAGE_EDIT_SIZES
} from '@shared/image-edit'
import { gatherUpstreamMedia } from '../../../canvas/graph'
import { readNodeConfig } from '../../../canvas/node-persistence'
import { runNodeManually } from '../../../engine/executor'
import { modelsByModality, useGatewayStore } from '../../../stores/gateway'
import { useNodePanelStore } from '../../../stores/nodePanel'
import { toast } from '../../../stores/toast'
import { Icon } from '../../../components/Icon'
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
  useClickGuard
} from './shared'
import { markUndoPoint } from '../../../canvas/history'

const COLORS: Array<{ id: ImageEditColor; label: string }> = [
  { id: 'red', label: '红' },
  { id: 'yellow', label: '黄' },
  { id: 'orange', label: '橙' }
]
type ImageEditTool = ImageEditAnnotationType | 'mask'
const TOOLS: Array<{ id: ImageEditTool; label: string; icon: 'crop' | 'edit' | 'text' }> = [
  { id: 'arrow', label: '箭头', icon: 'edit' },
  { id: 'rect', label: '矩形', icon: 'crop' },
  { id: 'brush', label: '画笔', icon: 'edit' },
  { id: 'text', label: '文字', icon: 'text' },
  { id: 'mask', label: '遮罩', icon: 'crop' }
]
const ANNOTATION_PRESETS: Array<{
  id: string
  label: string
  instruction: string
  annotation: Omit<ImageEditAnnotation, 'id'>
}> = [
  {
    id: 'subject',
    label: '主体框选',
    instruction: '保留框选主体，优先修改主体以外的区域。',
    annotation: {
      type: 'rect',
      color: 'yellow',
      points: [
        { x: 0.2, y: 0.15 },
        { x: 0.8, y: 0.85 }
      ],
      strokeWidth: 3
    }
  },
  {
    id: 'focus',
    label: '焦点箭头',
    instruction: '请重点修改箭头指向的位置。',
    annotation: {
      type: 'arrow',
      color: 'red',
      points: [
        { x: 0.16, y: 0.2 },
        { x: 0.5, y: 0.5 }
      ],
      strokeWidth: 3
    }
  }
]

export function ImageEditBody({ shape, openPreview }: NodeBodyProps): React.JSX.Element {
  const guard = useClickGuard()
  const editor = useEditor()
  const source = gatherUpstreamMedia(editor, shape.id, 'in-image', 'image')
  const [compareSource, setCompareSource] = useState(false)
  const openSettings = (): void => useNodePanelStore.getState().open('contract', shape.id)
  if (!shape.props.mediaPath)
    return (
      <div className="asset-empty image-edit-empty">
        <Icon name="edit" size={24} />
        <span>图片修改</span>
        <small>连接图片后，在右侧添加标注和修改说明。</small>
        <button
          className="btn-ghost small"
          onPointerDown={stopEventPropagation}
          onClick={(e) => {
            stopEventPropagation(e)
            openSettings()
          }}
        >
          配置修改
        </button>
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
        onPointerDown={guard.onPointerDown}
        onClick={(e) =>
          guard.onClick(e, () =>
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
            openSettings()
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
        <MediaSourceBadge shape={shape} fallback="图片修改" />
        <MediaFileActions shape={shape} />
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

function arrowHead(points: ImageEditPoint[]): string {
  const end = points[points.length - 1]
  const previous = points[points.length - 2]
  if (!end || !previous) return ''
  const angle = Math.atan2(end.y - previous.y, end.x - previous.x)
  const size = 0.035
  const left = {
    x: end.x - size * Math.cos(angle - Math.PI / 6),
    y: end.y - size * Math.sin(angle - Math.PI / 6)
  }
  const right = {
    x: end.x - size * Math.cos(angle + Math.PI / 6),
    y: end.y - size * Math.sin(angle + Math.PI / 6)
  }
  return [end, left, right].map((p) => `${p.x * 100},${p.y * 100}`).join(' ')
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

export function ImageEditSettings({
  shape,
  editor,
  projectId
}: NodeSettingsProps): React.JSX.Element {
  const previewRef = useRef<HTMLDivElement>(null)
  const draft = useRef<ImageEditAnnotation | null>(null)
  const maskDraft = useRef<ImageEditPoint[] | null>(null)
  const maskBase = useRef<ImageEditPoint[][]>([])
  const [config, setConfig] = useState(() => parseImageEditConfig(readNodeConfig(shape)))
  const [tool, setTool] = useState<ImageEditTool>('arrow')
  const [color, setColor] = useState<ImageEditColor>('red')
  const [aspect, setAspect] = useState(16 / 10)
  const [busy, setBusy] = useState(false)
  const source = gatherUpstreamMedia(editor, shape.id, 'in-image', 'image')
  const providers = useGatewayStore((s) => s.providers)
  const options = modelsByModality(providers, 'image')
  const loaded = useGatewayStore((s) => s.loaded)
  const load = useGatewayStore((s) => s.load)
  const openProviderSettings = useGatewayStore((s) => s.openSettings)
  useEffect(() => {
    if (!loaded) void load()
  }, [loaded, load])
  const save = (next: ImageEditConfig): void => {
    setConfig(next)
    editor.updateShape({
      id: shape.id,
      type: 'node-card',
      props: { config: serializeImageEditConfig(next) }
    })
  }
  const add = (annotation: ImageEditAnnotation): void =>
    save({ ...config, annotations: [...config.annotations, annotation].slice(-64) })
  const applyAnnotationPreset = (
    preset: (typeof ANNOTATION_PRESETS)[number],
    annotationId: string
  ): void => {
    save({
      ...config,
      instruction: config.instruction.trim() || preset.instruction,
      annotations: [...config.annotations, { ...preset.annotation, id: annotationId }].slice(-64)
    })
  }
  const start = (event: React.PointerEvent<HTMLDivElement>): void => {
    stopEventPropagation(event)
    const el = previewRef.current
    if (!el) return
    const startPoint = pointFromEvent(event, el)
    if (tool === 'mask') {
      maskBase.current = config.mask?.strokes ?? []
      maskDraft.current = [startPoint]
      el.setPointerCapture(event.pointerId)
      return
    }
    if (tool === 'text') {
      const text = window.prompt('输入标注文字')?.trim()
      if (text)
        add({
          id: `annotation-${Date.now()}`,
          type: 'text',
          color,
          points: [startPoint],
          text,
          strokeWidth: 3
        })
      return
    }
    draft.current = {
      id: `annotation-${Date.now()}`,
      type: tool,
      color,
      points: [startPoint],
      strokeWidth: 3
    }
    el.setPointerCapture(event.pointerId)
  }
  const move = (event: React.PointerEvent<HTMLDivElement>): void => {
    if (!previewRef.current) return
    if (maskDraft.current) {
      const next = [...maskDraft.current, pointFromEvent(event, previewRef.current)]
      maskDraft.current = next
      setConfig((current) => ({
        ...current,
        mask: {
          enabled: true,
          strokes: [...maskBase.current, next],
          brushSize: current.mask?.brushSize ?? 0.08,
          invert: current.mask?.invert ?? false
        }
      }))
      return
    }
    if (!draft.current) return
    const next = {
      ...draft.current,
      points: [...draft.current.points, pointFromEvent(event, previewRef.current)]
    }
    draft.current = next
    setConfig((current) => ({
      ...current,
      annotations: [...current.annotations.filter((a) => a.id !== next.id), next]
    }))
  }
  const finish = (): void => {
    if (maskDraft.current) {
      const stroke = maskDraft.current
      maskDraft.current = null
      if (stroke.length >= 2)
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
    if (!draft.current) return
    const next = draft.current
    draft.current = null
    const valid = next.points.length >= 2
    if (!valid) return
    save({ ...config, annotations: [...config.annotations.filter((a) => a.id !== next.id), next] })
  }
  const removeLast = (): void => save({ ...config, annotations: config.annotations.slice(0, -1) })
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
    <section className="contract-section image-edit-settings">
      <h4>图片修改</h4>
      <p className="contract-settings-hint">
        原图来自 in-image；标注仅作为修改参考，运行后输出新的图片资产。
      </p>
      {!source ? (
        <div className="crop-no-source">请从图片或生图节点连线到“原图”端口。</div>
      ) : (
        <>
          <div
            ref={previewRef}
            className="image-edit-preview"
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
                    className="image-edit-mask-mark"
                  />
                ))}
              {config.annotations.map((a) => {
                const pts = a.points.map((p) => `${p.x * 100},${p.y * 100}`).join(' ')
                if (a.type === 'rect') {
                  const rect = normalizedRect(a.points)
                  if (rect)
                    return (
                      <rect
                        key={a.id}
                        {...rect}
                        className={`image-edit-mark ${a.color}`}
                        style={{ fill: 'none' }}
                      />
                    )
                }
                if (a.type === 'text')
                  return (
                    <text
                      key={a.id}
                      x={a.points[0].x * 100}
                      y={a.points[0].y * 100}
                      className={`image-edit-text ${a.color}`}
                    >
                      {a.text}
                    </text>
                  )
                if (a.type === 'arrow')
                  return (
                    <g key={a.id}>
                      <polyline points={pts} className={`image-edit-mark ${a.color}`} />
                      <polygon
                        points={arrowHead(a.points)}
                        className={`image-edit-mark ${a.color}`}
                      />
                    </g>
                  )
                return <polyline key={a.id} points={pts} className={`image-edit-mark ${a.color}`} />
              })}
            </svg>
          </div>
          <div className="image-edit-tools">
            {TOOLS.map((item) => (
              <button
                key={item.id}
                className={tool === item.id ? 'active' : ''}
                title={item.label}
                onPointerDown={stopEventPropagation}
                onClick={() => setTool(item.id)}
              >
                <Icon name={item.icon} size={13} />
                {item.label}
              </button>
            ))}
            <button onPointerDown={stopEventPropagation} onClick={removeLast}>
              撤销
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
          <div className="image-edit-presets" aria-label="标注预设">
            <span>标注预设</span>
            {ANNOTATION_PRESETS.map((preset) => (
              <button
                key={preset.id}
                onPointerDown={stopEventPropagation}
                onClick={() =>
                  applyAnnotationPreset(preset, `annotation-${preset.id}-${Date.now()}`)
                }
              >
                {preset.label}
              </button>
            ))}
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
          <div className="image-edit-mask-options">
            <label>
              <input
                type="checkbox"
                checked={config.mask?.enabled ?? false}
                onPointerDown={stopEventPropagation}
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
                onPointerDown={stopEventPropagation}
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
        </>
      )}
      <div className="gen-row">
        <ModelSelect
          value={config.modelKey}
          options={options}
          onChange={(modelKey) => save({ ...config, modelKey })}
        />
        <select
          className="gen-select w92"
          value={config.size}
          onPointerDown={stopEventPropagation}
          onChange={(e) => save({ ...config, size: e.target.value })}
        >
          {IMAGE_EDIT_SIZES.map((size) => (
            <option key={size} value={size}>
              {size === 'auto' ? '默认尺寸' : size}
            </option>
          ))}
        </select>
      </div>
      <textarea
        className="gen-prompt"
        rows={3}
        value={config.instruction}
        placeholder="描述需要修改的内容…"
        onPointerDown={stopEventPropagation}
        onChange={(e) => save({ ...config, instruction: e.target.value.slice(0, 4000) })}
      />
      {invalid && <p className="crop-invalid">{invalid}</p>}
      {!options.length && <NoModelHint onOpen={openProviderSettings} />}
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
            运行图片修改
          </>
        )}
      </button>
    </section>
  )
}
