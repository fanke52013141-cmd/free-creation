import { useEffect, useState } from 'react'
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
import { Icon } from '../../../components/Icon'
import { useClickGuard } from './shared'

function positiveInteger(value: string, fallback: number): number {
  const number = Number(value)
  return Number.isFinite(number) ? Math.max(1, Math.round(number)) : fallback
}

export function ImageSplitBody({ shape, openPreview }: NodeBodyProps): React.JSX.Element {
  const editor = useEditor()
  const guard = useClickGuard()
  const source = gatherUpstreamMedia(editor, shape.id, 'in-image', 'image')
  const config = parseImageSplitConfig(readNodeConfig(shape))
  const tiles = buildImageSplitTiles(config)
  const [previewAspect, setPreviewAspect] = useState<number | null>(null)

  // 移除卡片底部的按钮后，将旧卡片也只压缩一次为原高的 5/6；元数据标记避免
  // 后续刷新或用户手动改变尺寸时再次缩小。'快速拆分' 仍由卡片右上角统一运行按钮执行。
  useEffect(() => {
    if (shape.meta?.splitCompactApplied || shape.props.h <= 220) return
    editor.updateShape({
      id: shape.id,
      type: 'node-card',
      props: { h: Math.max(220, Math.round(shape.props.h * (5 / 6))) },
      meta: { ...(shape.meta ?? {}), splitCompactApplied: true }
    })
  }, [editor, shape.id, shape.meta, shape.props.h])

  const save = (partial: Partial<ImageSplitConfig>, reason: string): void => {
    const next = parseImageSplitConfig(JSON.stringify({ ...config, ...partial }))
    editor.updateShape({
      id: shape.id,
      type: 'node-card',
      props: { config: serializeImageSplitConfig(next) }
    })
    markUndoPoint(editor, reason)
  }

  return (
    <div className="image-split-quick">
      <div className="image-split-quick-controls" aria-label="快速拆分设置">
        <label>
          行数
          <input
            type="number"
            min="1"
            max="64"
            value={config.rows}
            onPointerDown={stopEventPropagation}
            onChange={(event) =>
              save({ rows: positiveInteger(event.currentTarget.value, config.rows) }, 'image-split-rows')
            }
          />
        </label>
        <label>
          列数
          <input
            type="number"
            min="1"
            max="64"
            value={config.columns}
            onPointerDown={stopEventPropagation}
            onChange={(event) =>
              save(
                { columns: positiveInteger(event.currentTarget.value, config.columns) },
                'image-split-columns'
              )
            }
          />
        </label>
        <label>
          面积
          <span className="image-split-percent-input">
            <input
              type="number"
              min="1"
              max="100"
              value={config.scalePercent}
              onPointerDown={stopEventPropagation}
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
      <div
        className="image-split-quick-grid"
        style={{ aspectRatio: previewAspect ?? 16 / 10 }}
        aria-label={`${config.rows} 行 ${config.columns} 列拆分预览`}
        data-node-interactive="media-preview"
        role="button"
        tabIndex={source ? 0 : -1}
        title={source ? '双击预览原图' : '请先连接原图'}
        onPointerDown={guard.onPointerDown}
        onDoubleClick={(event) => {
          if (!source) return
          guard.onDoubleClick(event, () =>
            openPreview({ kind: 'image', url: mediaUrl(source.mediaPath), title: '待拆分原图' })
          )
        }}
      >
        {source ? (
          <img
            src={mediaUrl(source.mediaPath)}
            alt="拆分范围预览"
            draggable={false}
            onLoad={(event) => {
              const image = event.currentTarget
              if (image.naturalWidth && image.naturalHeight) setPreviewAspect(image.naturalWidth / image.naturalHeight)
            }}
          />
        ) : (
          <span className="image-split-quick-empty"><Icon name="image" size={19} /> 连接原图</span>
        )}
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
      <span className="image-split-quick-summary">
        {source ? `${config.rows} × ${config.columns}，共 ${imageSplitCount(config)} 张；右上角运行即可拆分` : '连接原图后可从右上角运行'}
      </span>
    </div>
  )
}

/** 右侧仅保留高级说明；行列、面积、预览和拆分入口均在节点卡片中。 */
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
            onChange={(event) =>
              save(
                { rows: positiveInteger(event.currentTarget.value, config.rows) },
                'image-split-rows'
              )
            }
          />
        </label>
        <label>
          列数
          <input
            type="number"
            min="1"
            max="64"
            value={config.columns}
            onChange={(event) =>
              save(
                { columns: positiveInteger(event.currentTarget.value, config.columns) },
                'image-split-columns'
              )
            }
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
                  {
                    scalePercent: Math.min(
                      100,
                      positiveInteger(event.currentTarget.value, config.scalePercent)
                    )
                  },
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
          每格以自身中心缩放；面积为原格的 {config.scalePercent}%（边长约 {linearPercent.toFixed(1)}
          %）。
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
