import { useRef, useState } from 'react'
import { stopEventPropagation } from 'tldraw'
import type { ImageCropConfig, NormalizedPoint } from '@shared/image-crop'
import {
  DEFAULT_IMAGE_CROP_CONFIG,
  parseImageCropConfig,
  serializeImageCropConfig,
  validateImageCropConfig
} from '@shared/image-crop'
import { gatherUpstreamMedia } from '../../../canvas/graph'
import { markUndoPoint } from '../../../canvas/history'
import { mediaUrl, type NodeBodyProps, type NodeSettingsProps } from '../../registry'
import { readNodeConfig } from '../../../canvas/node-persistence'
import { useNodePanelStore } from '../../../stores/nodePanel'
import { Icon } from '../../../components/Icon'
import { MediaFileActions, MediaSourceBadge, useClickGuard } from './shared'

type DragTarget = { kind: 'rect'; corner: 0 | 1 | 2 | 3 } | { kind: 'quad'; point: 0 | 1 | 2 | 3 }

const clamp = (value: number): number => Math.min(1, Math.max(0, value))

function updateRect(
  config: ImageCropConfig,
  corner: 0 | 1 | 2 | 3,
  point: NormalizedPoint
): ImageCropConfig {
  const min = 0.02
  const { x, y, width, height } = config.rect
  const right = x + width
  const bottom = y + height
  const next = { ...config.rect }
  if (corner === 0) {
    next.x = Math.min(point.x, right - min)
    next.y = Math.min(point.y, bottom - min)
    next.width = right - next.x
    next.height = bottom - next.y
  } else if (corner === 1) {
    next.y = Math.min(point.y, bottom - min)
    next.width = Math.max(min, point.x - x)
    next.height = bottom - next.y
  } else if (corner === 2) {
    next.x = Math.min(point.x, right - min)
    next.width = right - next.x
    next.height = Math.max(min, point.y - y)
  } else {
    next.width = Math.max(min, point.x - x)
    next.height = Math.max(min, point.y - y)
  }
  return parseImageCropConfig(JSON.stringify({ ...config, rect: next }))
}

function rectCorners(config: ImageCropConfig): NormalizedPoint[] {
  const { x, y, width, height } = config.rect
  return [
    { x, y },
    { x: x + width, y },
    { x, y: y + height },
    { x: x + width, y: y + height }
  ]
}

export function ImageCropBody({ shape, openPreview }: NodeBodyProps): React.JSX.Element {
  const guard = useClickGuard()
  const openSettings = (): void => useNodePanelStore.getState().open('contract', shape.id)
  if (!shape.props.mediaPath) {
    return (
      <div className="asset-empty crop-empty">
        <Icon name="crop" size={24} />
        <span>图片裁剪</span>
        <small>连接一张图片后，在右侧详情中框选区域，再运行生成新的图片资产。</small>
        <button
          className="btn-ghost small"
          onPointerDown={stopEventPropagation}
          onClick={(event) => {
            stopEventPropagation(event)
            openSettings()
          }}
        >
          配置裁剪
        </button>
      </div>
    )
  }
  return (
    <div className="node-media-wrap">
      <div
        className="node-media"
        onPointerDown={guard.onPointerDown}
        onClick={(event) =>
          guard.onClick(event, () =>
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
          onClick={(event) => {
            stopEventPropagation(event)
            openSettings()
          }}
        >
          <Icon name="edit" size={13} /> 调整裁剪
        </button>
        <MediaSourceBadge shape={shape} fallback="本地裁剪" />
        <MediaFileActions shape={shape} />
      </div>
      <button
        className="btn-ghost small crop-run-hint"
        onPointerDown={stopEventPropagation}
        onClick={(event) => {
          stopEventPropagation(event)
          openSettings()
        }}
      >
        在右侧「运行」中重新裁剪
      </button>
    </div>
  )
}

/** M1：节点自有的裁剪工作台；所有参数最终仅写入 props.config。 */
export function ImageCropSettings({ shape, editor }: NodeSettingsProps): React.JSX.Element {
  const previewRef = useRef<HTMLDivElement>(null)
  const drag = useRef<DragTarget | null>(null)
  const [config, setConfig] = useState(() => parseImageCropConfig(readNodeConfig(shape)))
  const [previewAspect, setPreviewAspect] = useState<number | null>(null)
  const source = gatherUpstreamMedia(editor, shape.id, 'in-image', 'image')

  const save = (next: ImageCropConfig): void => {
    setConfig(next)
    editor.updateShape({
      id: shape.id,
      type: 'node-card',
      props: { config: serializeImageCropConfig(next) }
    })
  }
  const pointForEvent = (event: React.PointerEvent): NormalizedPoint | null => {
    const bounds = previewRef.current?.getBoundingClientRect()
    if (!bounds || bounds.width <= 0 || bounds.height <= 0) return null
    return {
      x: clamp((event.clientX - bounds.left) / bounds.width),
      y: clamp((event.clientY - bounds.top) / bounds.height)
    }
  }
  const onMove = (event: React.PointerEvent<HTMLDivElement>): void => {
    const target = drag.current
    const point = target ? pointForEvent(event) : null
    if (!target || !point) return
    if (target.kind === 'rect') save(updateRect(config, target.corner, point))
    else {
      const points = config.points.map((item, index) =>
        index === target.point ? point : item
      ) as ImageCropConfig['points']
      save(parseImageCropConfig(JSON.stringify({ ...config, points })))
    }
  }
  const finishDrag = (): void => {
    if (!drag.current) return
    drag.current = null
    markUndoPoint(editor, 'image-crop-config')
  }
  const begin = (target: DragTarget, event: React.PointerEvent<HTMLButtonElement>): void => {
    stopEventPropagation(event)
    drag.current = target
    event.currentTarget.setPointerCapture(event.pointerId)
  }
  const handles = config.mode === 'rect' ? rectCorners(config) : config.points
  const invalid = validateImageCropConfig(config)

  return (
    <section className="contract-section crop-settings">
      <h4>图片裁剪</h4>
      <p className="contract-settings-hint">
        原图来自 in-image 连线；裁剪结果是新的图片资产，不会改写原图。
      </p>
      <div className="crop-mode-row" role="group" aria-label="裁剪方式">
        <button
          className={config.mode === 'rect' ? 'active' : ''}
          onClick={() => save({ ...config, mode: 'rect' })}
        >
          矩形裁剪
        </button>
        <button
          className={config.mode === 'quad' ? 'active' : ''}
          onClick={() => save({ ...config, mode: 'quad' })}
        >
          四角透视
        </button>
        <button onClick={() => save(structuredClone(DEFAULT_IMAGE_CROP_CONFIG))}>重置</button>
      </div>
      {source ? (
        <>
          <div
            ref={previewRef}
            className="crop-preview"
            style={{ aspectRatio: previewAspect ?? 16 / 10 }}
            onPointerMove={onMove}
            onPointerUp={finishDrag}
            onPointerCancel={finishDrag}
          >
            <img
              key={source.mediaId}
              src={mediaUrl(source.mediaPath)}
              alt="待裁剪原图"
              draggable={false}
              onLoad={(event) => {
                const image = event.currentTarget
                if (image.naturalWidth && image.naturalHeight) {
                  setPreviewAspect(image.naturalWidth / image.naturalHeight)
                }
              }}
            />
            {config.mode === 'rect' ? (
              <div
                className="crop-rect-overlay"
                style={{
                  left: `${config.rect.x * 100}%`,
                  top: `${config.rect.y * 100}%`,
                  width: `${config.rect.width * 100}%`,
                  height: `${config.rect.height * 100}%`
                }}
              />
            ) : (
              <svg className="crop-quad-overlay" viewBox="0 0 100 100" preserveAspectRatio="none">
                <polygon
                  points={config.points
                    .map((point) => `${point.x * 100},${point.y * 100}`)
                    .join(' ')}
                />
              </svg>
            )}
            {handles.map((point, index) => (
              <button
                type="button"
                key={index}
                className="crop-handle"
                aria-label={`调整${config.mode === 'rect' ? '矩形' : '透视'}角点 ${index + 1}`}
                style={{ left: `${point.x * 100}%`, top: `${point.y * 100}%` }}
                onPointerDown={(event) =>
                  begin(
                    config.mode === 'rect'
                      ? { kind: 'rect', corner: index as 0 | 1 | 2 | 3 }
                      : { kind: 'quad', point: index as 0 | 1 | 2 | 3 },
                    event
                  )
                }
              />
            ))}
          </div>
          <small className="crop-source-label">
            输入：{source.mime} · {source.mediaId}
          </small>
        </>
      ) : (
        <div className="crop-no-source">请从图片或生图节点连线到左侧“原图”端口。</div>
      )}
      {invalid && <p className="crop-invalid">{invalid}</p>}
      <p className="crop-coordinate-hint">
        坐标以原图比例保存；拖动四个圆点即可调整。运行后输出 PNG 图片。
      </p>
    </section>
  )
}
