import { useEffect, useRef, useState } from 'react'
import { stopEventPropagation, useEditor } from 'tldraw'
import {
  buildImageSplitTiles,
  imageSplitCount,
  maxImageSplitColumns,
  parseImageSplitConfig,
  serializeImageSplitConfig,
  MAX_IMAGE_SPLIT_TILES,
  type ImageSplitConfig
} from '@shared/image-split'
import { gatherUpstreamMedia } from '../../../canvas/graph'
import { markUndoPoint } from '../../../canvas/history'
import { readNodeConfig } from '../../../canvas/node-persistence'
import { mediaUrl, type NodeBodyProps, type NodeSettingsProps } from '../../registry'
import { Icon } from '../../../components/Icon'
import { useClickGuard, useSourceWiringNotice, useStoredNodeConfig } from './shared'

function positiveInteger(value: string, fallback: number): number {
  const number = Number(value)
  return Number.isFinite(number) ? Math.max(1, Math.round(number)) : fallback
}

export function ImageSplitBody({ shape, openPreview }: NodeBodyProps): React.JSX.Element {
  const editor = useEditor()
  const guard = useClickGuard()
  const source = gatherUpstreamMedia(editor, shape.id, 'in-image', 'image')
  const noSourceLine = useSourceWiringNotice(editor, shape.id, 'in-image', '原图')
  const config = parseImageSplitConfig(readNodeConfig(shape))
  const tiles = buildImageSplitTiles(config)
  const [previewAspect, setPreviewAspect] = useState<number | null>(null)
  const previewContainerRef = useRef<HTMLDivElement>(null)
  const [containerSize, setContainerSize] = useState<{ w: number; h: number } | null>(null)

  useEffect(() => {
    const el = previewContainerRef.current
    if (!el) return
    const updateSize = (): void => {
      const rect = el.getBoundingClientRect()
      if (rect.width > 0 && rect.height > 0) {
        setContainerSize({ w: rect.width, h: rect.height })
      }
    }
    updateSize()
    const observer = new ResizeObserver(updateSize)
    observer.observe(el)
    return () => observer.disconnect()
  }, [source?.mediaPath])

  // 快速拆分卡片保持契约统一的 340×260 初始尺寸（呈现规范 §3.1）：
  // 预览网格由 CSS flex + overflow 钳制；旧卡一次性压缩逻辑随"尚无历史用户数据"移除，
  // '快速拆分' 仍由卡片右上角统一运行按钮执行。

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
            max={maxImageSplitColumns(config.rows)}
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
      <div
        ref={previewContainerRef}
        className="image-split-quick-grid"
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
          <div
            className="image-split-canvas"
            style={
              containerSize && previewAspect
                ? containerSize.w / containerSize.h > previewAspect
                  ? {
                      height: `${containerSize.h}px`,
                      width: `${Math.round(containerSize.h * previewAspect)}px`,
                      aspectRatio: previewAspect
                    }
                  : {
                      width: `${containerSize.w}px`,
                      height: `${Math.round(containerSize.w / previewAspect)}px`,
                      aspectRatio: previewAspect
                    }
                : previewAspect
                  ? { aspectRatio: previewAspect }
                  : { width: '100%', height: '100%' }
            }
          >
            <img
              ref={(image) => {
                if (image?.complete && image.naturalWidth && image.naturalHeight) {
                  const aspect = image.naturalWidth / image.naturalHeight
                  if (aspect !== previewAspect) setPreviewAspect(aspect)
                }
              }}
              src={mediaUrl(source.mediaPath)}
              alt="拆分范围预览"
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
          <span className="image-split-quick-empty">
            <Icon name="image" size={19} />
            {noSourceLine}
          </span>
        )}
      </div>
    </div>
  )
}

/** 拆分工作台：与卡片上的快捷输入写同一份 props.config，两边都读文档真值。 */
export function ImageSplitSettings({ shape, editor }: NodeSettingsProps): React.JSX.Element {
  // 卡片上有同一份配置的快捷入口，所以这里读文档而不是拷一份本地镜像：拷镜像会让
  // 「卡片改了行列 → 面板拖面积」把行列写回旧值（NODE_UI_SPEC §16.25）。
  const config = parseImageSplitConfig(useStoredNodeConfig(editor, shape.id))
  const [previewAspect, setPreviewAspect] = useState<number | null>(null)
  const source = gatherUpstreamMedia(editor, shape.id, 'in-image', 'image')
  const noSourceLine = useSourceWiringNotice(editor, shape.id, 'in-image', '原图')
  const tiles = buildImageSplitTiles(config)
  const linearPercent = Math.sqrt(config.scalePercent / 100) * 100
  const columnCap = maxImageSplitColumns(config.rows)

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
            max={columnCap}
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
        {columnCap < MAX_IMAGE_SPLIT_TILES && (
          <span>
            行数 × 列数不超过 {MAX_IMAGE_SPLIT_TILES}，{config.rows} 行时列数最多 {columnCap}。
          </span>
        )}
      </p>
      {source ? (
        <div
          className="image-split-preview"
          style={{ aspectRatio: previewAspect ?? 16 / 10 }}
          aria-label={`${config.rows} 行 ${config.columns} 列拆分预览`}
        >
          <img
            ref={(image) => {
              if (image?.complete && image.naturalWidth && image.naturalHeight) {
                const aspect = image.naturalWidth / image.naturalHeight
                if (aspect !== previewAspect) setPreviewAspect(aspect)
              }
            }}
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
        <div className="crop-no-source">{noSourceLine}</div>
      )}
      <p className="crop-coordinate-hint">
        输出「图片集合」可连接到循环节点批处理；「当前图片」是从集合中选中的一格，可直接接生图、裁剪或视频。
      </p>
    </section>
  )
}
