import { useRef, useState } from 'react'
import { stopEventPropagation } from 'tldraw'
import type { NodeBodyProps, NodeSettingsProps } from '../../registry'
import { mediaUrl } from '../../registry'
import { gatherUpstreamMedia } from '../../../canvas/graph'
import { markUndoPoint } from '../../../canvas/history'
import { readNodeConfig } from '../../../canvas/node-persistence'
import { useNodePanelStore } from '../../../stores/nodePanel'
import { Icon } from '../../../components/Icon'
import { MediaFileActions, MediaSourceBadge, useClickGuard } from './shared'
import {
  parseVideoFrameConfig,
  parseVideoRangeConfig,
  serializeVideoConfig,
  type VideoTransformKind
} from '@shared/video-transform'

type BodyMode = VideoTransformKind

const clamp = (value: number, max: number): number => Math.min(Math.max(0, value), max)
const timeLabel = (value: number): string => `${(value / 1000).toFixed(2)}s`

export function VideoTransformBody({
  shape,
  openPreview,
  mode
}: NodeBodyProps & { mode: BodyMode }): React.JSX.Element {
  const guard = useClickGuard()
  const label = mode === 'frame' ? '视频取帧' : mode === 'clip' ? '视频截取' : '提取音频'
  const openSettings = (): void => useNodePanelStore.getState().open('contract', shape.id)
  if (!shape.props.mediaPath) {
    return (
      <div className="asset-empty crop-empty">
        <Icon name={mode === 'frame' ? 'frame' : mode === 'clip' ? 'clip' : 'audio'} size={24} />
        <span>{label}</span>
        <small>连接源视频后，在右侧详情中定位时间；运行会生成可连接的新媒体资产。</small>
        <button
          className="btn-ghost small"
          onPointerDown={stopEventPropagation}
          onClick={(event) => {
            stopEventPropagation(event)
            openSettings()
          }}
        >
          配置{label}
        </button>
      </div>
    )
  }
  const previewKind = mode === 'frame' ? 'image' : mode === 'clip' ? 'video' : 'audio'
  return (
    <div className="node-media-wrap">
      <div
        className="node-media"
        onPointerDown={guard.onPointerDown}
        onClick={(event) =>
          guard.onClick(event, () =>
            openPreview({
              kind: previewKind,
              url: mediaUrl(shape.props.mediaPath),
              title: shape.props.title
            })
          )
        }
      >
        {mode === 'frame' ? (
          <img src={mediaUrl(shape.props.mediaPath)} alt={shape.props.title} draggable={false} />
        ) : mode === 'clip' ? (
          <video src={mediaUrl(shape.props.mediaPath)} muted preload="metadata" playsInline />
        ) : (
          <Icon name="audio" size={36} />
        )}
        {mode === 'clip' && <span className="play-badge">▶</span>}
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
          <Icon name="edit" size={13} /> 调整
        </button>
        <MediaSourceBadge shape={shape} fallback="本地视频处理" />
        <MediaFileActions shape={shape} />
      </div>
    </div>
  )
}

function VideoTransformSettings({
  shape,
  editor,
  mode
}: NodeSettingsProps & { mode: BodyMode }): React.JSX.Element {
  const videoRef = useRef<HTMLVideoElement>(null)
  const [durationMs, setDurationMs] = useState(0)
  const source = gatherUpstreamMedia(editor, shape.id, 'in-video', 'video')
  const [frameConfig, setFrameConfig] = useState(() => parseVideoFrameConfig(readNodeConfig(shape)))
  const [rangeConfig, setRangeConfig] = useState(() => parseVideoRangeConfig(readNodeConfig(shape)))
  const frameConfigRef = useRef(frameConfig)
  const rangeConfigRef = useRef(rangeConfig)
  const isFrame = mode === 'frame'
  const label = isFrame ? '视频取帧' : mode === 'clip' ? '视频截取' : '提取音频'
  const max = Math.max(
    1,
    durationMs || (isFrame ? frameConfig.timeMs + 1000 : rangeConfig.endMs + 1000)
  )
  const saveFrame = (timeMs: number): void => {
    const next = { version: 1 as const, timeMs: Math.round(clamp(timeMs, max)) }
    frameConfigRef.current = next
    setFrameConfig(next)
  }
  const persistFrame = (): void => {
    editor.updateShape({
      id: shape.id,
      type: 'node-card',
      props: { config: serializeVideoConfig(frameConfigRef.current) }
    })
    markUndoPoint(editor, `video-${mode}-config`)
  }
  const saveRange = (startMs: number, endMs: number): void => {
    const start = Math.round(clamp(startMs, Math.max(0, max - 1)))
    const end = Math.round(Math.max(start + 1, clamp(endMs, max)))
    const next = { version: 1 as const, startMs: start, endMs: end }
    rangeConfigRef.current = next
    setRangeConfig(next)
  }
  const persistRange = (): void => {
    editor.updateShape({
      id: shape.id,
      type: 'node-card',
      props: { config: serializeVideoConfig(rangeConfigRef.current) }
    })
    markUndoPoint(editor, `video-${mode}-config`)
  }
  const seek = (timeMs: number): void => {
    const video = videoRef.current
    if (video) video.currentTime = timeMs / 1000
  }
  const finish = (): void => {
    if (isFrame) persistFrame()
    else persistRange()
  }

  return (
    <section className="contract-section video-transform-settings">
      <h4>{label}</h4>
      <p className="contract-settings-hint">
        源视频来自 in-video 连线；时间以毫秒保存。拖动滑块会立即定位预览，原视频不会被改写。
      </p>
      {source ? (
        <>
          <video
            ref={videoRef}
            className="video-transform-preview"
            src={mediaUrl(source.mediaPath)}
            muted
            controls
            preload="metadata"
            onLoadedMetadata={(event) =>
              setDurationMs(Math.round(event.currentTarget.duration * 1000))
            }
          />
          {isFrame ? (
            <label className="video-time-control">
              取帧位置 <strong>{timeLabel(frameConfig.timeMs)}</strong>
              <input
                type="range"
                min="0"
                max={max}
                step="1"
                value={clamp(frameConfig.timeMs, max)}
                onInput={(event) => {
                  const value = Number(event.currentTarget.value)
                  seek(value)
                  saveFrame(value)
                }}
                onPointerUp={finish}
                onKeyUp={(event) => {
                  if (event.key.startsWith('Arrow')) finish()
                }}
              />
            </label>
          ) : (
            <>
              <label className="video-time-control">
                开始 <strong>{timeLabel(rangeConfig.startMs)}</strong>
                <input
                  type="range"
                  min="0"
                  max={max}
                  step="1"
                  value={clamp(rangeConfig.startMs, max - 1)}
                  onInput={(event) => {
                    const value = Number(event.currentTarget.value)
                    seek(value)
                    saveRange(value, rangeConfig.endMs)
                  }}
                  onPointerUp={finish}
                  onKeyUp={(event) => {
                    if (event.key.startsWith('Arrow')) finish()
                  }}
                />
              </label>
              <label className="video-time-control">
                结束 <strong>{timeLabel(rangeConfig.endMs)}</strong>
                <input
                  type="range"
                  min="1"
                  max={max}
                  step="1"
                  value={clamp(rangeConfig.endMs, max)}
                  onInput={(event) => {
                    const value = Number(event.currentTarget.value)
                    seek(value)
                    saveRange(rangeConfig.startMs, value)
                  }}
                  onPointerUp={finish}
                  onKeyUp={(event) => {
                    if (event.key.startsWith('Arrow')) finish()
                  }}
                />
              </label>
              <small className="video-range-summary">
                时长：{timeLabel(Math.max(1, rangeConfig.endMs - rangeConfig.startMs))}
              </small>
            </>
          )}
        </>
      ) : (
        <div className="crop-no-source">请从视频节点连线到左侧“源视频”端口。</div>
      )}
      <p className="crop-coordinate-hint">
        {isFrame
          ? '运行后输出 PNG 图片。'
          : mode === 'clip'
            ? '运行后精确重编码为 MP4 片段。'
            : '运行后输出 M4A 音频。'}
      </p>
    </section>
  )
}

export const VideoFrameBody = (props: NodeBodyProps): React.JSX.Element => (
  <VideoTransformBody {...props} mode="frame" />
)
export const VideoClipBody = (props: NodeBodyProps): React.JSX.Element => (
  <VideoTransformBody {...props} mode="clip" />
)
export const VideoAudioBody = (props: NodeBodyProps): React.JSX.Element => (
  <VideoTransformBody {...props} mode="audio" />
)
export const VideoFrameSettings = (props: NodeSettingsProps): React.JSX.Element => (
  <VideoTransformSettings {...props} mode="frame" />
)
export const VideoClipSettings = (props: NodeSettingsProps): React.JSX.Element => (
  <VideoTransformSettings {...props} mode="clip" />
)
export const VideoAudioSettings = (props: NodeSettingsProps): React.JSX.Element => (
  <VideoTransformSettings {...props} mode="audio" />
)
