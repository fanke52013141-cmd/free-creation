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
import { runNodeManually } from '../../../engine/executor'
import { useAppStore } from '../../../stores/app'
import { useGatewayStore } from '../../../stores/gateway'
import { toast } from '../../../stores/toast'
import { Icon } from '../../../components/Icon'
import { useClickGuard } from './shared'

function positiveInteger(value: string, fallback: number): number {
  const number = Number(value)
  return Number.isFinite(number) ? Math.max(1, Math.round(number)) : fallback
}

export function ImageSplitBody({ shape, openPreview }: NodeBodyProps): React.JSX.Element {
  const editor = useEditor()
  const guard = useClickGuard()
  const project = useAppStore((state) => state.currentProject)
  const providers = useGatewayStore((state) => state.providers)
  const source = gatherUpstreamMedia(editor, shape.id, 'in-image', 'image')
  const config = parseImageSplitConfig(readNodeConfig(shape))
  const tiles = buildImageSplitTiles(config)
  const [previewAspect, setPreviewAspect] = useState<number | null>(null)
  const [busy, setBusy] = useState(false)

  const save = (partial: Partial<ImageSplitConfig>, reason: string): void => {
    const next = parseImageSplitConfig(JSON.stringify({ ...config, ...partial }))
    editor.updateShape({
      id: shape.id,
      type: 'node-card',
      props: { config: serializeImageSplitConfig(next) }
    })
    markUndoPoint(editor, reason)
  }

  const split = async (): Promise<void> => {
    if (!source) return toast('请先连接一张原图')
    if (!project) return toast('项目未就绪')
    setBusy(true)
    try {
      await runNodeManually(editor, project.id, providers, shape.id)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="image-split-quick">
      <div className="image-split-quick-head">
        <div
          className={`image-split-quick-preview${source ? '' : ' is-empty'}`}
          data-node-interactive="media-preview"
          role="button"
          tabIndex={0}
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
              alt="待拆分原图"
              draggable={false}
              onLoad={(event) => {
                const image = event.currentTarget
                if (image.naturalWidth && image.naturalHeight) {
                  setPreviewAspect(image.naturalWidth / image.naturalHeight)
                }
              }}
            />
          ) : (
            <span><Icon name="image" size={20} /> 连接原图</span>
          )}
        </div>
      </div>
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
      >
        {source && <img src={mediaUrl(source.mediaPath)} alt="拆分范围预览" draggable={false} />}
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
      <div className="image-split-quick-footer">
        <span>{config.rows} × {config.columns}，共 {imageSplitCount(config)} 张</span>
        <button
          className="btn-primary small"
          disabled={!source || busy}
          onPointerDown={stopEventPropagation}
          onClick={(event) => {
            stopEventPropagation(event)
            void split()
          }}
        >
          <Icon name="grid" size={14} /> {busy ? '拆分中…' : '快速拆分'}
        </button>
      </div>
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
