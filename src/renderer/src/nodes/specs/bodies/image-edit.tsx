import { useEffect, useRef, useState } from 'react'
import { stopEventPropagation } from 'tldraw'
import {
  parseImageEditConfig,
  serializeImageEditConfig,
  validateImageEditConfig,
  type ImageEditAnnotation,
  type ImageEditAnnotationType,
  type ImageEditColor,
  type ImageEditConfig,
  type ImageEditPoint
} from '@shared/image-edit'
import { gatherUpstreamMedia } from '../../../canvas/graph'
import { readNodeConfig } from '../../../canvas/node-persistence'
import { runNodeManually } from '../../../engine/executor'
import { modelsByModality, useGatewayStore } from '../../../stores/gateway'
import { useNodePanelStore } from '../../../stores/nodePanel'
import { Icon } from '../../../components/Icon'
import { mediaUrl, type NodeBodyProps, type NodeSettingsProps } from '../../registry'
import {
  MediaFileActions,
  MediaSourceBadge,
  ModelSelect,
  NoModelHint,
  useClickGuard
} from './shared'

const COLORS: Array<{ id: ImageEditColor; label: string }> = [
  { id: 'red', label: '红' },
  { id: 'yellow', label: '黄' },
  { id: 'orange', label: '橙' }
]
const TOOLS: Array<{ id: ImageEditAnnotationType; label: string; icon: 'crop' | 'edit' | 'text' }> =
  [
    { id: 'arrow', label: '箭头', icon: 'edit' },
    { id: 'rect', label: '矩形', icon: 'crop' },
    { id: 'brush', label: '画笔', icon: 'edit' },
    { id: 'text', label: '文字', icon: 'text' }
  ]

export function ImageEditBody({ shape, openPreview }: NodeBodyProps): React.JSX.Element {
  const guard = useClickGuard()
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
        <MediaSourceBadge shape={shape} fallback="图片修改" />
        <MediaFileActions shape={shape} />
      </div>
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

export function ImageEditSettings({
  shape,
  editor,
  projectId
}: NodeSettingsProps): React.JSX.Element {
  const previewRef = useRef<HTMLDivElement>(null)
  const draft = useRef<ImageEditAnnotation | null>(null)
  const [config, setConfig] = useState(() => parseImageEditConfig(readNodeConfig(shape)))
  const [tool, setTool] = useState<ImageEditAnnotationType>('arrow')
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
  const start = (event: React.PointerEvent<HTMLDivElement>): void => {
    stopEventPropagation(event)
    const el = previewRef.current
    if (!el) return
    const startPoint = pointFromEvent(event, el)
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
    if (!draft.current || !previewRef.current) return
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
    if (!draft.current) return
    const next = draft.current
    draft.current = null
    const valid =
      next.type === 'rect' || next.type === 'arrow'
        ? next.points.length >= 2
        : next.points.length >= 2
    if (!valid) return
    save({ ...config, annotations: [...config.annotations.filter((a) => a.id !== next.id), next] })
  }
  const removeLast = (): void => save({ ...config, annotations: config.annotations.slice(0, -1) })
  const run = async (): Promise<void> => {
    const invalid = validateImageEditConfig(config)
    if (invalid) return
    setBusy(true)
    try {
      await runNodeManually(editor, projectId, providers, shape.id)
    } finally {
      setBusy(false)
    }
  }
  const invalid =
    config.annotations.length === 0 && !config.instruction.trim()
      ? '请填写修改说明或添加标注'
      : null
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
              {config.annotations.map((a) => {
                const pts = a.points.map((p) => `${p.x * 100},${p.y * 100}`).join(' ')
                if (a.type === 'rect' && a.points[1])
                  return (
                    <rect
                      key={a.id}
                      x={a.points[0].x * 100}
                      y={a.points[0].y * 100}
                      width={(a.points[1].x - a.points[0].x) * 100}
                      height={(a.points[1].y - a.points[0].y) * 100}
                      className={`image-edit-mark ${a.color}`}
                      style={{ fill: 'none' }}
                    />
                  )
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
          <option value="auto">默认尺寸</option>
          <option value="1024x1024">1024x1024</option>
          <option value="1536x1024">1536x1024</option>
          <option value="1024x1536">1024x1536</option>
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
        disabled={busy || !source || !options.length}
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
