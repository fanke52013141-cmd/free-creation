import { useRef, useState } from 'react'
import { stopEventPropagation } from 'tldraw'
import type { ImageCropAspectRatio, ImageCropConfig, NormalizedPoint } from '@shared/image-crop'
import {
  DEFAULT_IMAGE_CROP_CONFIG,
  IMAGE_CROP_ASPECT_RATIOS,
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

const COMMON_ASPECT_RATIOS: readonly ImageCropAspectRatio[] = [
  'free',
  '1:1',
  '16:9',
  '9:16',
  '4:3',
  '3:4'
]

const EXTRA_ASPECT_RATIOS: readonly ImageCropAspectRatio[] = [
  '3:2',
  '2:3',
  '21:9',
  '9:21',
  '5:4',
  '4:5'
]

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

/**
 * 固定比例拖拽：始终以对角为锚点，用户拖动任意一个圆点即可等比例放大或缩小。
 * ratio 是图片像素比例；归一化坐标需要除以 sourceAspect 才能保持视觉比例正确。
 */
function updateRectWithAspect(
  config: ImageCropConfig,
  corner: 0 | 1 | 2 | 3,
  point: NormalizedPoint,
  ratio: number,
  sourceAspect: number
): ImageCropConfig {
  const { x, y, width, height } = config.rect
  const right = x + width
  const bottom = y + height
  const anchor =
    corner === 0
      ? { x: right, y: bottom }
      : corner === 1
        ? { x, y: bottom }
        : corner === 2
          ? { x: right, y }
          : { x, y }
  const xDirection = corner === 0 || corner === 2 ? -1 : 1
  const yDirection = corner === 0 || corner === 1 ? -1 : 1
  const normalizedRatio = ratio / Math.max(0.0001, sourceAspect)
  const desiredWidth = Math.abs(point.x - anchor.x)
  const desiredHeight = Math.abs(point.y - anchor.y)
  let nextWidth = desiredWidth
  let nextHeight = desiredHeight
  if (desiredHeight === 0 || desiredWidth / desiredHeight >= normalizedRatio) {
    nextHeight = desiredWidth / normalizedRatio
  } else {
    nextWidth = desiredHeight * normalizedRatio
  }

  const availableWidth = xDirection > 0 ? 1 - anchor.x : anchor.x
  const availableHeight = yDirection > 0 ? 1 - anchor.y : anchor.y
  const maxWidth = Math.min(availableWidth, availableHeight * normalizedRatio)
  if (maxWidth <= 0) return config
  nextWidth = Math.min(nextWidth, maxWidth)
  nextHeight = nextWidth / normalizedRatio
  if (nextWidth < 0.02 || nextHeight < 0.02) return config

  return parseImageCropConfig(
    JSON.stringify({
      ...config,
      rect: {
        x: xDirection > 0 ? anchor.x : anchor.x - nextWidth,
        y: yDirection > 0 ? anchor.y : anchor.y - nextHeight,
        width: nextWidth,
        height: nextHeight
      }
    })
  )
}

/** 切换比例时以原选区中心为基准，内接到新比例，绝不越过原图。 */
function fitRectToAspect(config: ImageCropConfig, ratio: number, sourceAspect: number): ImageCropConfig {
  const normalizedRatio = ratio / Math.max(0.0001, sourceAspect)
  let width = config.rect.width
  let height = config.rect.height
  if (width / height > normalizedRatio) width = height * normalizedRatio
  else height = width / normalizedRatio
  const centerX = config.rect.x + config.rect.width / 2
  const centerY = config.rect.y + config.rect.height / 2
  const x = clamp(Math.min(centerX - width / 2, 1 - width))
  const y = clamp(Math.min(centerY - height / 2, 1 - height))
  return parseImageCropConfig(JSON.stringify({ ...config, rect: { x, y, width, height } }))
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
    if (target.kind === 'rect') {
      const ratio = IMAGE_CROP_ASPECT_RATIOS[config.aspectRatio]
      save(
        ratio
          ? updateRectWithAspect(config, target.corner, point, ratio, previewAspect ?? 1)
          : updateRect(config, target.corner, point)
      )
    }
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
  const setAspectRatio = (aspectRatio: ImageCropAspectRatio): void => {
    const ratio = IMAGE_CROP_ASPECT_RATIOS[aspectRatio]
    const base: ImageCropConfig = { ...config, mode: 'rect', aspectRatio }
    const next = ratio ? fitRectToAspect(base, ratio, previewAspect ?? 1) : base
    save(next)
    markUndoPoint(editor, 'image-crop-aspect-ratio')
  }

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
      {config.mode === 'rect' && (
        <div className="crop-aspect-settings">
          <span className="crop-aspect-label">裁剪比例</span>
          <div className="crop-aspect-shortcuts" role="group" aria-label="常用裁剪比例">
            {COMMON_ASPECT_RATIOS.map((aspectRatio) => (
              <button
                key={aspectRatio}
                type="button"
                className={config.aspectRatio === aspectRatio ? 'active' : ''}
                onClick={() => setAspectRatio(aspectRatio)}
              >
                {aspectRatio === 'free' ? '自由' : aspectRatio}
              </button>
            ))}
          </div>
          <label className="crop-aspect-more">
            更多比例
            <select
              value={EXTRA_ASPECT_RATIOS.includes(config.aspectRatio) ? config.aspectRatio : ''}
              onChange={(event) => {
                const value = event.currentTarget.value as ImageCropAspectRatio
                if (value) setAspectRatio(value)
              }}
            >
              <option value="">选择比例</option>
              {EXTRA_ASPECT_RATIOS.map((aspectRatio) => (
                <option key={aspectRatio} value={aspectRatio}>
                  {aspectRatio}
                </option>
              ))}
            </select>
          </label>
          <small>
            {config.aspectRatio === 'free'
              ? '自由拖动：四个角点可分别调整宽高。'
              : `固定 ${config.aspectRatio}：拖动任意角点，选区会等比例缩放。`}
          </small>
        </div>
      )}
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
        坐标以原图比例保存；矩形模式支持自由或固定比例，四角透视用于校正倾斜画面。运行后输出 PNG 图片。
      </p>
    </section>
  )
}
