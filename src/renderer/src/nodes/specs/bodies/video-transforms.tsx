import { useEffect, useRef, useState } from 'react'
import { stopEventPropagation, useEditor } from 'tldraw'
import type { NodeBodyProps, NodeSettingsProps } from '../../registry'
import { mediaUrl } from '../../registry'
import { gatherUpstreamMedia } from '../../../canvas/graph'
import { markUndoPoint } from '../../../canvas/history'
import { readNodeConfig } from '../../../canvas/node-persistence'
import { useNodePanelStore } from '../../../stores/nodePanel'
import { useAppStore } from '../../../stores/app'
import { Icon } from '../../../components/Icon'
import { AppSelect } from '../../../components/AppSelect'
import {
  MediaFileActions,
  MediaSourceBadge,
  useClickGuard,
  createImageContinuation,
  createVideoContinuation,
  createAudioContinuation
} from './shared'
import {
  parseVideoFrameConfig,
  parseVideoClipConfig,
  parseVideoAudioConfig,
  serializeVideoFrameConfig,
  serializeVideoClipConfig,
  serializeVideoAudioConfig
} from '@shared/video-transform'
import type {
  VideoFrameConfig,
  VideoClipConfig,
  VideoAudioConfig,
  ClipQuality,
  AudioFormat
} from '@shared/video-transform'

type BodyMode = 'frame' | 'clip' | 'audio'

const clamp = (value: number, max: number): number => Math.min(Math.max(0, value), max)
const timeLabel = (value: number): string => `${(value / 1000).toFixed(2)}s`

/** 格式化时间码 mm:ss.mmm */
function timecode(ms: number): string {
  const totalSec = ms / 1000
  const mm = Math.floor(totalSec / 60)
  const ss = Math.floor(totalSec % 60)
  const mmm = Math.round((totalSec % 1) * 1000)
  return `${String(mm).padStart(2, '0')}:${String(ss).padStart(2, '0')}.${String(mmm).padStart(3, '0')}`
}

// ── 统一时间轴组件 ──

/** 手动时间码输入：接受 mm:ss.mmm 或纯秒数 */
function TimeInput({
  label,
  valueMs,
  max,
  onCommit
}: {
  label?: string
  valueMs: number
  max: number
  onCommit: (ms: number) => void
}): React.JSX.Element {
  const [text, setText] = useState(timecode(valueMs))

  const parseTimecode = (s: string): number | null => {
    const parts = s.trim().split(':')
    if (parts.length === 1) {
      const sec = parseFloat(parts[0])
      return Number.isNaN(sec) ? null : Math.round(sec * 1000)
    }
    if (parts.length === 2) {
      const mm = parseInt(parts[0], 10)
      const ss = parseFloat(parts[1])
      return Number.isNaN(mm) || Number.isNaN(ss) ? null : Math.round((mm * 60 + ss) * 1000)
    }
    return null
  }

  const handleBlur = (): void => {
    const ms = parseTimecode(text)
    if (ms !== null) {
      onCommit(clamp(ms, max))
    } else {
      setText(timecode(valueMs))
    }
  }

  return (
    <label className="video-timeline-input">
      {label && <span>{label}</span>}
      <input
        type="text"
        value={text}
        onPointerDown={stopEventPropagation}
        onChange={(event): void => setText(event.currentTarget.value)}
        onBlur={handleBlur}
        onKeyDown={(event): void => {
          if (event.key === 'Enter') event.currentTarget.blur()
          if (event.key === 'Escape') {
            setText(timecode(valueMs))
            event.currentTarget.blur()
          }
        }}
      />
    </label>
  )
}

/** 波形画布组件：接收归一化峰值数组并在 canvas 上绘制竖条 */
function Waveform({
  peaks,
  durationMs,
  startMs,
  endMs
}: {
  peaks: number[]
  durationMs: number
  startMs?: number
  endMs?: number
}): React.JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement>(null)

  useEffect((): void => {
    const canvas = canvasRef.current
    if (!canvas || peaks.length === 0) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    const dpr = window.devicePixelRatio || 1
    const rect = canvas.getBoundingClientRect()
    if (rect.width === 0 || rect.height === 0) return
    canvas.width = rect.width * dpr
    canvas.height = rect.height * dpr
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)

    const w = rect.width
    const h = rect.height
    const midY = h / 2
    const max = Math.max(1, durationMs)
    const startX = startMs !== undefined ? (startMs / max) * w : 0
    const endX = endMs !== undefined ? (endMs / max) * w : w

    ctx.clearRect(0, 0, w, h)

    const barWidth = w / peaks.length
    const gap = Math.max(0.5, barWidth * 0.15)

    for (let i = 0; i < peaks.length; i++) {
      const x = i * barWidth
      const inRegion = x + barWidth / 2 >= startX && x + barWidth / 2 <= endX
      const amplitude = Math.max(0.5, peaks[i] * (h * 0.42))
      ctx.fillStyle = inRegion ? '#f472b6' : 'rgba(148, 163, 184, 0.3)'
      ctx.fillRect(x + gap / 2, midY - amplitude, barWidth - gap, amplitude * 2)
    }
  }, [peaks, durationMs, startMs, endMs])

  return <canvas ref={canvasRef} className="video-timeline-waveform" />
}

function MediaTimeline({
  durationMs,
  pointMs,
  startMs,
  endMs,
  fps,
  thumbnails,
  waveform,
  isPlaying,
  loopEnabled,
  onSeek,
  onPoint,
  onRange,
  onCommit,
  onPlayPause,
  onToggleLoop
}: {
  durationMs: number
  /** 单游标模式（取帧）传入此值 */
  pointMs?: number
  /** 双游标模式（截取/提音）传入这两个值 */
  startMs?: number
  endMs?: number
  fps: number | null
  /** 8~12 张缩略图 data URL 数组 */
  thumbnails?: string[]
  /** 归一化音频峰值数组（仅提音模式传入） */
  waveform?: number[]
  /** 当前是否播放中 */
  isPlaying?: boolean
  /** 区间循环是否启用（仅双游标模式） */
  loopEnabled?: boolean
  onSeek: (timeMs: number) => void
  onPoint?: (timeMs: number) => void
  onRange?: (startMs: number, endMs: number) => void
  onCommit: () => void
  /** 播放/暂停回调 */
  onPlayPause?: () => void
  /** 切换区间循环 */
  onToggleLoop?: () => void
}): React.JSX.Element {
  const max = Math.max(1, durationMs)
  const isPoint = typeof pointMs === 'number'
  const currentStart = clamp(startMs ?? 0, Math.max(0, max - 1))
  const currentEnd = Math.max(currentStart + 1, clamp(endMs ?? max, max))
  const currentPoint = clamp(pointMs ?? 0, max)
  const percent = (value: number): string => `${(value / max) * 100}%`
  const frameInterval = fps ? 1000 / fps : null
  const frameAt = (ms: number): number => (fps ? Math.round((ms / 1000) * fps) + 1 : 0)
  const hasFrames = !!frameInterval

  const stepFrame = (current: number, dir: 1 | -1): number =>
    frameInterval ? clamp(current + dir * frameInterval, max) : current

  const handleBtn =
    (fn: () => void) =>
    (event: React.MouseEvent): void => {
      stopEventPropagation(event)
      fn()
    }

  // 取帧逐帧
  const prevPoint = (): void => {
    const t = stepFrame(currentPoint, -1)
    onSeek(t)
    onPoint?.(t)
    onCommit()
  }
  const nextPoint = (): void => {
    const t = stepFrame(currentPoint, 1)
    onSeek(t)
    onPoint?.(t)
    onCommit()
  }

  // 截取/提音起点逐帧
  const prevStart = (): void => {
    const t = stepFrame(currentStart, -1)
    onSeek(t)
    onRange?.(t, currentEnd)
    onCommit()
  }
  const nextStart = (): void => {
    const t = Math.min(stepFrame(currentStart, 1), currentEnd - 1)
    onSeek(t)
    onRange?.(t, currentEnd)
    onCommit()
  }

  // 截取/提音终点逐帧
  const prevEnd = (): void => {
    const t = Math.max(stepFrame(currentEnd, -1), currentStart + 1)
    onSeek(t)
    onRange?.(currentStart, t)
    onCommit()
  }
  const nextEnd = (): void => {
    const t = stepFrame(currentEnd, 1)
    onSeek(t)
    onRange?.(currentStart, t)
    onCommit()
  }

  return (
    <div className="video-timeline" aria-label="媒体时间轴">
      {/* 缩略图条 */}
      {thumbnails && thumbnails.length > 0 && (
        <div className="video-timeline-thumbnails">
          {thumbnails.map((src, i) => (
            <img key={i} src={src} alt="" draggable={false} />
          ))}
        </div>
      )}

      {/* 波形（仅提音模式传入 peaks 时渲染） */}
      {waveform && waveform.length > 0 && (
        <Waveform
          peaks={waveform}
          durationMs={max}
          startMs={isPoint ? undefined : currentStart}
          endMs={isPoint ? undefined : currentEnd}
        />
      )}

      {/* 时间标签 */}
      <div className="video-timeline-ruler">
        <span>00:00.000</span>
        <span>{timecode(max)}</span>
      </div>

      {/* 滑块轨道 */}
      <div
        className="video-timeline-track"
        style={
          isPoint
            ? ({ '--point': percent(currentPoint) } as React.CSSProperties)
            : ({
                '--start': percent(currentStart),
                '--end': percent(currentEnd)
              } as React.CSSProperties)
        }
      >
        {isPoint ? (
          <input
            type="range"
            min="0"
            max={max}
            step={frameInterval ?? 1}
            value={currentPoint}
            onInput={(event) => {
              const value = Number(event.currentTarget.value)
              onSeek(value)
              onPoint?.(value)
            }}
            onPointerUp={onCommit}
            onKeyUp={(event) => event.key.startsWith('Arrow') && onCommit()}
          />
        ) : (
          <>
            <input
              className="video-range-start"
              type="range"
              min="0"
              max={max - 1}
              step={frameInterval ?? 1}
              value={currentStart}
              onInput={(event) => {
                const value = Number(event.currentTarget.value)
                onSeek(value)
                onRange?.(value, currentEnd)
              }}
              onPointerUp={onCommit}
              onKeyUp={(event) => event.key.startsWith('Arrow') && onCommit()}
            />
            <input
              className="video-range-end"
              type="range"
              min="1"
              max={max}
              step={frameInterval ?? 1}
              value={currentEnd}
              onInput={(event) => {
                const value = Number(event.currentTarget.value)
                onSeek(value)
                onRange?.(currentStart, value)
              }}
              onPointerUp={onCommit}
              onKeyUp={(event) => event.key.startsWith('Arrow') && onCommit()}
            />
          </>
        )}
      </div>

      {/* 控制按钮 */}
      <div className="video-timeline-controls">
        {onPlayPause && (
          <button
            type="button"
            className="video-timeline-btn"
            onPointerDown={stopEventPropagation}
            onClick={handleBtn(onPlayPause)}
            title={isPlaying ? '暂停' : '播放'}
          >
            {isPlaying ? '\u23F8' : '\u25B6'}
          </button>
        )}
        {onToggleLoop && (
          <button
            type="button"
            className={`video-timeline-btn ${loopEnabled ? 'active' : ''}`}
            onPointerDown={stopEventPropagation}
            onClick={handleBtn(onToggleLoop)}
            title={loopEnabled ? '关闭区间循环' : '开启区间循环'}
          >
            {'\u21BB'}
          </button>
        )}
        {isPoint ? (
          <>
            <button
              type="button"
              className="video-timeline-btn"
              disabled={!hasFrames}
              onPointerDown={stopEventPropagation}
              onClick={handleBtn(prevPoint)}
              title="上一帧"
            >
              {'\u23EE'}
            </button>
            <button
              type="button"
              className="video-timeline-btn"
              disabled={!hasFrames}
              onPointerDown={stopEventPropagation}
              onClick={handleBtn(nextPoint)}
              title="下一帧"
            >
              {'\u23ED'}
            </button>
            <TimeInput
              key={`point-${currentPoint}`}
              valueMs={currentPoint}
              max={max}
              onCommit={(ms): void => {
                onSeek(ms)
                onPoint?.(ms)
                onCommit()
              }}
            />
          </>
        ) : (
          <>
            {hasFrames && (
              <>
                <button
                  type="button"
                  className="video-timeline-btn"
                  onPointerDown={stopEventPropagation}
                  onClick={handleBtn(prevStart)}
                  title="起点上一帧"
                >
                  {'\u23EE'}
                </button>
                <button
                  type="button"
                  className="video-timeline-btn"
                  onPointerDown={stopEventPropagation}
                  onClick={handleBtn(nextStart)}
                  title="起点下一帧"
                >
                  {'\u23ED'}
                </button>
              </>
            )}
            <TimeInput
              key={`start-${currentStart}`}
              label="起"
              valueMs={currentStart}
              max={max}
              onCommit={(ms): void => {
                const t = Math.min(ms, currentEnd - 1)
                onSeek(t)
                onRange?.(t, currentEnd)
                onCommit()
              }}
            />
            {hasFrames && (
              <>
                <button
                  type="button"
                  className="video-timeline-btn"
                  onPointerDown={stopEventPropagation}
                  onClick={handleBtn(prevEnd)}
                  title="终点上一帧"
                >
                  {'\u23EE'}
                </button>
                <button
                  type="button"
                  className="video-timeline-btn"
                  onPointerDown={stopEventPropagation}
                  onClick={handleBtn(nextEnd)}
                  title="终点下一帧"
                >
                  {'\u23ED'}
                </button>
              </>
            )}
            <TimeInput
              key={`end-${currentEnd}`}
              label="终"
              valueMs={currentEnd}
              max={max}
              onCommit={(ms): void => {
                const t = Math.max(ms, currentStart + 1)
                onSeek(t)
                onRange?.(currentStart, t)
                onCommit()
              }}
            />
          </>
        )}
      </div>

      {/* 读数 */}
      <div className="video-timeline-readout">
        {isPoint ? (
          <strong>{timecode(currentPoint)}</strong>
        ) : (
          <strong>
            {timecode(currentStart)} — {timecode(currentEnd)}
          </strong>
        )}
        <span>
          {fps ? `${fps.toFixed(2)} fps · ` : ''}
          {isPoint
            ? `第 ${frameAt(currentPoint)} 帧`
            : `时长 ${timeLabel(currentEnd - currentStart)}`}
        </span>
      </div>
    </div>
  )
}

// ── 卡片 Body（画布上展示）──

export function VideoTransformBody({
  shape,
  openPreview,
  mode
}: NodeBodyProps & { mode: BodyMode }): React.JSX.Element {
  const guard = useClickGuard()
  const editor = useEditor()
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
      {/* 输出后续操作快捷入口 */}
      {mode === 'frame' && (
        <div className="node-media-next-actions" aria-label="图片后续操作">
          <button
            className="btn-ghost small"
            onPointerDown={stopEventPropagation}
            onClick={(event) => {
              stopEventPropagation(event)
              createImageContinuation(editor, shape, 'image-edit')
            }}
          >
            <Icon name="edit" size={12} /> 修改
          </button>
          <button
            className="btn-ghost small"
            onPointerDown={stopEventPropagation}
            onClick={(event) => {
              stopEventPropagation(event)
              createImageContinuation(editor, shape, 'image-gen')
            }}
          >
            <Icon name="spark" size={12} /> 继续生图
          </button>
        </div>
      )}
      {mode === 'clip' && (
        <div className="node-media-next-actions" aria-label="视频后续操作">
          <button
            className="btn-ghost small"
            onPointerDown={stopEventPropagation}
            onClick={(event) => {
              stopEventPropagation(event)
              createVideoContinuation(editor, shape, 'video-frame')
            }}
          >
            <Icon name="frame" size={12} /> 取帧
          </button>
          <button
            className="btn-ghost small"
            onPointerDown={stopEventPropagation}
            onClick={(event) => {
              stopEventPropagation(event)
              createVideoContinuation(editor, shape, 'video-audio')
            }}
          >
            <Icon name="audio" size={12} /> 提音
          </button>
        </div>
      )}
      {mode === 'audio' && (
        <div className="node-media-next-actions" aria-label="音频后续操作">
          <button
            className="btn-ghost small"
            onPointerDown={stopEventPropagation}
            onClick={(event) => {
              stopEventPropagation(event)
              createAudioContinuation(editor, shape, 'vocal-separate')
            }}
          >
            <Icon name="audio" size={12} /> 人声分离
          </button>
        </div>
      )}
    </div>
  )
}

// ── 右侧详情面板 ──

function VideoTransformSettings({
  shape,
  editor,
  mode
}: NodeSettingsProps & { mode: BodyMode }): React.JSX.Element {
  const videoRef = useRef<HTMLVideoElement>(null)
  const [durationMs, setDurationMs] = useState(0)
  const [fps, setFps] = useState<number | null>(null)
  const project = useAppStore((state) => state.currentProject)
  const source = gatherUpstreamMedia(editor, shape.id, 'in-video', 'video')

  // 各模式独立配置状态
  const [frameCfg, setFrameCfg] = useState<VideoFrameConfig>(() =>
    parseVideoFrameConfig(readNodeConfig(shape))
  )
  const [clipCfg, setClipCfg] = useState<VideoClipConfig>(() =>
    parseVideoClipConfig(readNodeConfig(shape))
  )
  const [audioCfg, setAudioCfg] = useState<VideoAudioConfig>(() =>
    parseVideoAudioConfig(readNodeConfig(shape))
  )
  const frameRef = useRef(frameCfg)
  const clipRef = useRef(clipCfg)
  const audioRef = useRef(audioCfg)

  // 缩略图和播放状态
  const [thumbnails, setThumbnails] = useState<string[]>([])
  const [waveform, setWaveform] = useState<number[]>([])
  const [isPlaying, setIsPlaying] = useState(false)
  const [loopEnabled, setLoopEnabled] = useState(false)
  const [localCapabilities, setLocalCapabilities] = useState<Awaited<
    ReturnType<typeof window.api.getLocalMediaCapabilities>
  > | null>(null)

  const isFrame = mode === 'frame'
  const isClip = mode === 'clip'
  const label = isFrame ? '视频取帧' : isClip ? '视频截取' : '提取音频'

  useEffect(() => {
    let active = true
    void window.api.getLocalMediaCapabilities().then((result) => {
      if (active) setLocalCapabilities(result)
    })
    return () => {
      active = false
    }
  }, [])

  const mediaEngineReady = localCapabilities?.ok ? localCapabilities.data.ffmpeg.available : null

  // 当前模式的有效时间上限
  const max = Math.max(
    1,
    durationMs ||
      (isFrame ? frameCfg.timeMs + 1000 : isClip ? clipCfg.endMs + 1000 : audioCfg.endMs + 1000)
  )

  // 探测视频元数据
  useEffect(() => {
    if (!project || !source?.mediaId) return
    let active = true
    void window.api
      .probeVideo({ projectId: project.id, sourceMediaId: source.mediaId })
      .then((result) => {
        if (!active || !result.ok) return
        setDurationMs(result.data.durationMs)
        setFps(result.data.fps)
      })
    return () => {
      active = false
    }
  }, [project, source?.mediaId])

  // 缩略图拉取（durationMs 就绪后触发一次）
  useEffect(() => {
    if (!project || !source?.mediaId || durationMs <= 0) return
    let active = true
    void window.api
      .generateVideoThumbnails({
        projectId: project.id,
        sourceMediaId: source.mediaId,
        count: 10
      })
      .then((result) => {
        if (!active || !result.ok) return
        setThumbnails(result.data.thumbnails)
      })
    return () => {
      active = false
    }
  }, [project, source?.mediaId, durationMs])

  // 波形数据拉取（仅提音模式需要）
  useEffect(() => {
    if (!project || !source?.mediaId || isFrame || isClip) return
    let active = true
    void window.api
      .generateAudioWaveform({
        projectId: project.id,
        sourceMediaId: source.mediaId,
        samples: 300
      })
      .then((result) => {
        if (!active || !result.ok) return
        setWaveform(result.data.peaks)
      })
    return () => {
      active = false
    }
  }, [project, source?.mediaId, isFrame, isClip])

  // ── 取帧配置操作 ──
  const saveFrame = (timeMs: number): void => {
    const next: VideoFrameConfig = {
      ...frameRef.current,
      timeMs: Math.round(clamp(timeMs, max))
    }
    frameRef.current = next
    setFrameCfg(next)
  }
  const setFrameMode = (frameMode: VideoFrameConfig['mode']): void => {
    const next: VideoFrameConfig = { ...frameRef.current, mode: frameMode }
    frameRef.current = next
    setFrameCfg(next)
  }
  const setFrameFormat = (format: 'png' | 'jpg'): void => {
    const next: VideoFrameConfig = { ...frameRef.current, format }
    frameRef.current = next
    setFrameCfg(next)
    editor.updateShape({
      id: shape.id,
      type: 'node-card',
      props: { config: serializeVideoFrameConfig(next) }
    })
    markUndoPoint(editor, 'video-frame-format')
  }
  const persistFrame = (): void => {
    editor.updateShape({
      id: shape.id,
      type: 'node-card',
      props: { config: serializeVideoFrameConfig(frameRef.current) }
    })
    markUndoPoint(editor, 'video-frame-config')
  }

  // ── 截取配置操作 ──
  const saveClip = (startMs: number, endMs: number): void => {
    const start = Math.round(clamp(startMs, Math.max(0, max - 1)))
    const end = Math.round(Math.max(start + 1, clamp(endMs, max)))
    const next: VideoClipConfig = { ...clipRef.current, startMs: start, endMs: end }
    clipRef.current = next
    setClipCfg(next)
  }
  const setClipQuality = (quality: ClipQuality): void => {
    const next: VideoClipConfig = { ...clipRef.current, quality }
    clipRef.current = next
    setClipCfg(next)
    editor.updateShape({
      id: shape.id,
      type: 'node-card',
      props: { config: serializeVideoClipConfig(next) }
    })
    markUndoPoint(editor, 'video-clip-quality')
  }
  const toggleClipAudio = (includeAudio: boolean): void => {
    const next: VideoClipConfig = { ...clipRef.current, includeAudio }
    clipRef.current = next
    setClipCfg(next)
    editor.updateShape({
      id: shape.id,
      type: 'node-card',
      props: { config: serializeVideoClipConfig(next) }
    })
    markUndoPoint(editor, 'video-clip-audio')
  }
  const persistClip = (): void => {
    editor.updateShape({
      id: shape.id,
      type: 'node-card',
      props: { config: serializeVideoClipConfig(clipRef.current) }
    })
    markUndoPoint(editor, 'video-clip-config')
  }

  // ── 提音配置操作 ──
  const saveAudio = (startMs: number, endMs: number): void => {
    const start = Math.round(clamp(startMs, Math.max(0, max - 1)))
    const end = Math.round(Math.max(start + 1, clamp(endMs, max)))
    const next: VideoAudioConfig = { ...audioRef.current, startMs: start, endMs: end }
    audioRef.current = next
    setAudioCfg(next)
  }
  const setAudioFormat = (format: AudioFormat): void => {
    const next: VideoAudioConfig = { ...audioRef.current, format }
    audioRef.current = next
    setAudioCfg(next)
    editor.updateShape({
      id: shape.id,
      type: 'node-card',
      props: { config: serializeVideoAudioConfig(next) }
    })
    markUndoPoint(editor, 'video-audio-format')
  }
  const setAudioSampleRate = (sampleRate: 44100 | 48000): void => {
    const next: VideoAudioConfig = { ...audioRef.current, sampleRate }
    audioRef.current = next
    setAudioCfg(next)
    editor.updateShape({
      id: shape.id,
      type: 'node-card',
      props: { config: serializeVideoAudioConfig(next) }
    })
    markUndoPoint(editor, 'video-audio-samplerate')
  }
  const persistAudio = (): void => {
    editor.updateShape({
      id: shape.id,
      type: 'node-card',
      props: { config: serializeVideoAudioConfig(audioRef.current) }
    })
    markUndoPoint(editor, 'video-audio-config')
  }

  const togglePlay = (): void => {
    const video = videoRef.current
    if (!video) return
    if (video.paused) {
      // 截取/提音模式下，启用循环时从起点开始播放
      if (!isFrame && loopEnabled) {
        const start = isClip ? clipRef.current.startMs : audioRef.current.startMs
        video.currentTime = start / 1000
      }
      void video.play()
    } else {
      video.pause()
    }
  }

  // 区间循环：播放到达 endMs 时回跳到 startMs
  const handleTimeUpdate = (): void => {
    const video = videoRef.current
    if (!video || !loopEnabled || isFrame || video.paused) return
    const currentMs = video.currentTime * 1000
    const endMs = isClip ? clipRef.current.endMs : audioRef.current.endMs
    const startMs = isClip ? clipRef.current.startMs : audioRef.current.startMs
    if (currentMs >= endMs) {
      video.currentTime = startMs / 1000
    }
  }

  const toggleLoop = (): void => {
    setLoopEnabled((prev) => !prev)
  }

  const seek = (timeMs: number): void => {
    const video = videoRef.current
    if (video) video.currentTime = timeMs / 1000
  }

  const commit = (): void => {
    if (isFrame) persistFrame()
    else if (isClip) persistClip()
    else persistAudio()
  }

  return (
    <section className="contract-section video-transform-settings">
      <h4>{label}</h4>
      <p className="contract-settings-hint">
        源视频来自 in-video
        连线；时间以毫秒保存。拖动滑块会立即定位预览，松开后才写入配置，原视频不会被改写。
      </p>
      {mediaEngineReady === false && (
        <div className="local-capability-alert" role="alert">
          <strong>本机媒体引擎未就绪</strong>
          <span>
            {localCapabilities?.ok
              ? localCapabilities.data.ffmpeg.message
              : '无法读取本机工具状态。'}
          </span>
          <small>本节点不会修改原视频；安装或配置 FFmpeg 后重新打开此面板即可再次检测。</small>
        </div>
      )}
      {mediaEngineReady === true && <div className="local-capability-ok">本机 FFmpeg 已就绪</div>}
      {source ? (
        <>
          {/* 第一层：视频预览 */}
          <video
            ref={videoRef}
            className="video-transform-preview"
            src={mediaUrl(source.mediaPath)}
            muted
            preload="metadata"
            onLoadedMetadata={(event) =>
              setDurationMs(Math.round(event.currentTarget.duration * 1000))
            }
            onPlay={() => setIsPlaying(true)}
            onPause={() => setIsPlaying(false)}
            onTimeUpdate={handleTimeUpdate}
          />

          {isFrame ? (
            <>
              {/* 取帧模式选择 */}
              <div className="frame-preset-row">
                <button
                  type="button"
                  className={`btn-ghost small frame-preset-btn ${frameCfg.mode === 'first' ? 'active' : ''}`}
                  onPointerDown={stopEventPropagation}
                  onClick={(event) => {
                    stopEventPropagation(event)
                    setFrameMode('first')
                    seek(0)
                    persistFrame()
                  }}
                >
                  首帧
                </button>
                <button
                  type="button"
                  className={`btn-ghost small frame-preset-btn ${frameCfg.mode === 'last' ? 'active' : ''}`}
                  disabled={durationMs <= 0}
                  onPointerDown={stopEventPropagation}
                  onClick={(event) => {
                    stopEventPropagation(event)
                    setFrameMode('last')
                    const last = Math.max(0, max - 1)
                    seek(last)
                    saveFrame(last)
                    persistFrame()
                  }}
                >
                  尾帧
                </button>
                <button
                  type="button"
                  className={`btn-ghost small frame-preset-btn ${frameCfg.mode === 'custom' ? 'active' : ''}`}
                  onPointerDown={stopEventPropagation}
                  onClick={(event) => {
                    stopEventPropagation(event)
                    setFrameMode('custom')
                    persistFrame()
                  }}
                >
                  自定义
                </button>
              </div>

              {/* 自定义模式才显示时间轴 */}
              {frameCfg.mode === 'custom' && (
                <MediaTimeline
                  durationMs={max}
                  pointMs={frameCfg.timeMs}
                  fps={fps}
                  thumbnails={thumbnails}
                  isPlaying={isPlaying}
                  onSeek={seek}
                  onPoint={saveFrame}
                  onCommit={commit}
                  onPlayPause={togglePlay}
                />
              )}

              {/* 格式选择 */}
              <label className="audio-isolation-mode">
                输出格式
                <AppSelect
                  value={frameCfg.format}
                  onChange={(event) => setFrameFormat(event.currentTarget.value as 'png' | 'jpg')}
                >
                  <option value="png">PNG（无损）</option>
                  <option value="jpg">JPG（体积小）</option>
                </AppSelect>
              </label>
            </>
          ) : isClip ? (
            <>
              <MediaTimeline
                durationMs={max}
                startMs={clipCfg.startMs}
                endMs={clipCfg.endMs}
                fps={fps}
                thumbnails={thumbnails}
                isPlaying={isPlaying}
                loopEnabled={loopEnabled}
                onSeek={seek}
                onRange={saveClip}
                onCommit={commit}
                onPlayPause={togglePlay}
                onToggleLoop={toggleLoop}
              />
              <label className="audio-isolation-mode">
                编码质量
                <AppSelect
                  value={clipCfg.quality}
                  onChange={(event) => setClipQuality(event.currentTarget.value as ClipQuality)}
                >
                  <option value="fast">快速（关键帧复制，边界可能不精确）</option>
                  <option value="balanced">平衡（重编码 CRF 18）</option>
                  <option value="high">高质量（重编码 CRF 14）</option>
                </AppSelect>
              </label>
              <label className="audio-checkbox-row">
                <input
                  type="checkbox"
                  checked={clipCfg.includeAudio}
                  onChange={(event) => toggleClipAudio(event.currentTarget.checked)}
                />
                保留音轨
              </label>
            </>
          ) : (
            <>
              <MediaTimeline
                durationMs={max}
                startMs={audioCfg.startMs}
                endMs={audioCfg.endMs}
                fps={fps}
                thumbnails={thumbnails}
                waveform={waveform}
                isPlaying={isPlaying}
                loopEnabled={loopEnabled}
                onSeek={seek}
                onRange={saveAudio}
                onCommit={commit}
                onPlayPause={togglePlay}
                onToggleLoop={toggleLoop}
              />
              <label className="audio-isolation-mode">
                输出格式
                <AppSelect
                  value={audioCfg.format}
                  onChange={(event) => setAudioFormat(event.currentTarget.value as AudioFormat)}
                >
                  <option value="m4a">M4A（体积小）</option>
                  <option value="wav">WAV（无损，适合后续人声分离）</option>
                </AppSelect>
              </label>
              <label className="audio-isolation-mode">
                采样率
                <AppSelect
                  value={audioCfg.sampleRate}
                  onChange={(event) =>
                    setAudioSampleRate(Number(event.currentTarget.value) as 44100 | 48000)
                  }
                >
                  <option value={44100}>44100 Hz</option>
                  <option value={48000}>48000 Hz</option>
                </AppSelect>
              </label>
              <small className="crop-coordinate-hint">
                提音只忠实提取原始音频，不做降噪或人声分离。如需分离，请将输出连到独立的“人声分离”节点。
              </small>
            </>
          )}
        </>
      ) : (
        <div className="crop-no-source">请从视频节点连线到左侧“源视频”端口。</div>
      )}
      <p className="crop-coordinate-hint">
        {isFrame
          ? `运行后输出 ${frameCfg.format.toUpperCase()} 图片。`
          : isClip
            ? `运行后${clipCfg.quality === 'fast' ? '快速复制' : '精确重编码'}为 MP4 片段。`
            : `运行后输出 ${audioCfg.format.toUpperCase()} 音频。`}
      </p>
    </section>
  )
}

// ── 导出：每种模式的 Body 和 Settings ──

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
