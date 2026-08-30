import { useState } from 'react'
import { stopEventPropagation, useEditor } from 'tldraw'
import {
  buildImageSplitTiles,
  imageSplitCount,
  parseImageSplitConfig,
  serializeImageSplitConfig,
  type ImageSplitConfig
} from '@shared/image-split'
import { gatherUpstreamMedia } from '../../../canvas/graph'
import { markUndoPoint } from '../../../canvas/history'
import { readNodeConfig } from '../../../canvas/node-persistence'
import { mediaUrl, type NodeBodyProps, type NodeSettingsProps } from '../../registry'
import { useNodePanelStore } from '../../../stores/nodePanel'
import { Icon } from '../../../components/Icon'
import {
  MediaFileActions,
  MediaResultGrid,
  MediaSourceBadge,
  selectMediaResult,
  useClickGuard
} from './shared'

function positiveInteger(value: string, fallback: number): number {
  const number = Number(value)
  return Number.isFinite(number) ? Math.max(1, Math.round(number)) : fallback
}

export function ImageSplitBody({ shape, openPreview }: NodeBodyProps): React.JSX.Element {
  const guard = useClickGuard()
  const editor = useEditor()
  const openSettings = (): void => useNodePanelStore.getState().open('contract', shape.id)
  if (!shape.props.mediaPath) {
    return (
      <div className="asset-empty crop-empty">
        <Icon name="grid" size={24} />
        <span>图片拆分</span>
        <small>连接一张原图后，按行列拆成多张独立图片；在右侧配置后运行。</small>
        <button
          className="btn-ghost small"
          onPointerDown={stopEventPropagation}
          onClick={(event) => {
            stopEventPropagation(event)
            openSettings()
          }}
        >
          配置拆分
        </button>
      </div>
    )
  }

  const chooseResult = (item: Parameters<typeof selectMediaResult>[1]): void => {
    const selected = selectMediaResult(shape, item)
    editor.updateShape({
      id: shape.id,
      type: 'node-card',
      props: selected.props,
      meta: { ...(shape.meta ?? {}), nodeResult: selected.nodeResult }
    })
    markUndoPoint(editor, 'image-split-select-result')
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
          <Icon name="grid" size={13} /> 调整拆分
        </button>
        <MediaSourceBadge shape={shape} fallback="本地宫格拆分" />
        <MediaFileActions shape={shape} />
      </div>
      <MediaResultGrid
        shape={shape}
        kind="image"
        onSelect={chooseResult}
        openPreview={(item) =>
          openPreview({ kind: 'image', url: mediaUrl(item.mediaPath), title: shape.props.title })
        }
      />
    </div>
  )
}

/** 图片拆分的右侧工作台：不在画布卡片中塞参数，避免破坏统一节点尺寸。 */
export function ImageSplitSettings({ shape, editor }: NodeSettingsProps): React.JSX.Element {
  const [config, setConfig] = useState(() => parseImageSplitConfig(readNodeConfig(shape)))
  const [previewAspect, setPreviewAspect] = useState<number | null>(null)
  const source = gatherUpstreamMedia(editor, shape.id, 'in-image', 'image')
  const tiles = buildImageSplitTiles(config)
  const linearPercent = Math.sqrt(config.scalePercent / 100) * 100

  const save = (partial: Partial<ImageSplitConfig>, reason: string): void => {
    const next = parseImageSplitConfig(JSON.stringify({ ...config, ...partial }))
    setConfig(next)
    editor.updateShape({
      id: shape.id,
      type: 'node-card',
      props: { config: serializeImageSplitConfig(next) }
    })
    markUndoPoint(editor, reason)
  }

  return (
    <section className="contract-section image-split-settings">
      <h4>图片宫格拆分</h4>
      <p className="contract-settings-hint">
        原图来自 in-image 连线。每一格都会生成独立 PNG 资产，原图保持不变。
      </p>
      <div className="image-split-controls">
        <label>
          行数
          <input
            type="number"
            min="1"
            max="64"
            value={config.rows}
            onChange={(event) => save({ rows: positiveInteger(event.currentTarget.value, config.rows) }, 'image-split-rows')}
          />
        </label>
        <label>
          列数
          <input
            type="number"
            min="1"
            max="64"
            value={config.columns}
            onChange={(event) => save({ columns: positiveInteger(event.currentTarget.value, config.columns) }, 'image-split-columns')}
          />
        </label>
        <label>
          面积缩放
          <span className="image-split-percent-input">
            <input
              type="number"
              min="1"
              max="100"
              value={config.scalePercent}
              onChange={(event) =>
                save(
                  { scalePercent: Math.min(100, positiveInteger(event.currentTarget.value, config.scalePercent)) },
                  'image-split-scale'
                )
              }
            />
            <b>%</b>
          </span>
        </label>
      </div>
      <p className="image-split-summary">
        <strong>
          {config.rows} × {config.columns} = {imageSplitCount(config)} 份
        </strong>
        <span>
          每格以自身中心缩放；面积为原格的 {config.scalePercent}%（边长约 {linearPercent.toFixed(1)}%）。
        </span>
      </p>
      {source ? (
        <div
          className="image-split-preview"
          style={{ aspectRatio: previewAspect ?? 16 / 10 }}
          aria-label={`${config.rows} 行 ${config.columns} 列拆分预览`}
        >
          <img
            src={mediaUrl(source.mediaPath)}
            alt="待拆分原图"
            draggable={false}
            onLoad={(event) => {
              const image = event.currentTarget
              if (image.naturalWidth && image.naturalHeight) {
                setPreviewAspect(image.naturalWidth / image.naturalHeight)
              }
            }}
          />
          {tiles.map((tile) => (
            <span
              className="image-split-preview-tile"
              key={tile.index}
              style={{
                left: `${tile.rect.x * 100}%`,
                top: `${tile.rect.y * 100}%`,
                width: `${tile.rect.width * 100}%`,
                height: `${tile.rect.height * 100}%`
              }}
            >
              <em>{tile.index + 1}</em>
            </span>
          ))}
        </div>
      ) : (
        <div className="crop-no-source">请从图片或生图节点连线到左侧“原图”端口。</div>
      )}
      <p className="crop-coordinate-hint">
        输出「图片集合」可连接到循环节点批处理；「当前图片」是从集合中选中的一格，可直接接生图、裁剪或视频。
      </p>
    </section>
  )
}
