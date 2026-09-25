import { useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { stopEventPropagation, useEditor, type Editor, type TLShapeId } from 'tldraw'
import type { NodeBodyProps, NodeSettingsProps } from '../../registry'
import { mediaUrl } from '../../registry'
import { gatherUpstreamMedia, countIncomingConnections } from '../../../canvas/graph'
import { markUndoPoint } from '../../../canvas/history'
import { readNodeConfig } from '../../../canvas/node-persistence'
import type { NodeCardShape } from '../../../canvas/NodeCardShape'
import { useAppStore } from '../../../stores/app'
import { useGatewayStore } from '../../../stores/gateway'
import { toast } from '../../../stores/toast'
import { runNodeManually } from '../../../engine/executor'
import { Icon } from '../../../components/Icon'
import { AppSelect } from '../../../components/AppSelect'
import { projectNodeOutputs } from '../../nodeValues'
import {
  MediaFileActions,
  MediaSourceBadge,
  useClickGuard,
  createImageContinuation,
  createVideoContinuation,
  createVocalSeparationContinuation,
  createAudioContinuation
} from './shared'
import {
  parseVideoFrameConfig,
  parseVideoClipConfig,
  parseVideoAudioConfig,
  parseVocalSeparationConfig,
  serializeVideoFrameConfig,
  serializeVideoClipConfig,
  serializeVideoAudioConfig,
  serializeVocalSeparationConfig
} from '@shared/video-transform'
import type {
  VideoFrameConfig,
  VideoClipConfig,
  VideoAudioConfig,
  ClipQuality,
  AudioFormat,
  VocalSeparationConfig,
  VocalMode
} from '@shared/video-transform'
import './node-workbench.css'

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

function playbackTime(ms: number): string {
  const seconds = Math.floor(Math.max(0, ms) / 1000)
  const hours = Math.floor(seconds / 3600)
  const minutes = Math.floor((seconds % 3600) / 60)
  const remainder = seconds % 60
  return hours > 0
    ? `${hours}:${String(minutes).padStart(2, '0')}:${String(remainder).padStart(2, '0')}`
    : `${String(minutes).padStart(2, '0')}:${String(remainder).padStart(2, '0')}`
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
        onPointerDown={(e) => e.stopPropagation()}
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

  // 统一坐标系：手柄中心与粉色柱边界用同一 `value / max` 百分比定位，
  // 拖动时二者恒等对齐（修复手柄与柱间距随位置漂移的问题）。
  const trackRef = useRef<HTMLDivElement>(null)

  const clientXToMs = (clientX: number): number => {
    const el = trackRef.current
    if (!el) return 0
    const rect = el.getBoundingClientRect()
    const ratio = rect.width > 0 ? (clientX - rect.left) / rect.width : 0
    return clamp(ratio * max, max)
  }

  const dragHandle = (kind: 'point' | 'start' | 'end', startClientX: number): void => {
    const el = trackRef.current
    if (!el) return
    const fromMs = kind === 'point' ? currentPoint : kind === 'start' ? currentStart : currentEnd
    let lastMs = fromMs
    const move = (event: PointerEvent): void => {
      let ms = clientXToMs(event.clientX)
      if (kind === 'start') ms = Math.min(ms, currentEnd - 1)
      else if (kind === 'end') ms = Math.max(ms, currentStart + 1)
      lastMs = ms
      onSeek(ms)
      if (kind === 'point') onPoint?.(ms)
      else if (kind === 'start') onRange?.(ms, currentEnd)
      else onRange?.(currentStart, ms)
    }
    const up = (): void => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      if (kind === 'point') onPoint?.(lastMs)
      else if (kind === 'start') onRange?.(lastMs, currentEnd)
      else onRange?.(currentStart, lastMs)
      onCommit()
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
    void startClientX
  }

  // 点击轨道：单点模式直接设定；双游标模式移动最近的手柄。
  const handleTrackPointerDown = (event: React.PointerEvent): void => {
    stopEventPropagation(event)
    const ms = clientXToMs(event.clientX)
    onSeek(ms)
    if (isPoint) {
      onPoint?.(ms)
      dragHandle('point', event.clientX)
    } else {
      const kind: 'start' | 'end' =
        Math.abs(ms - currentStart) <= Math.abs(ms - currentEnd) ? 'start' : 'end'
      if (kind === 'start') onRange?.(Math.min(ms, currentEnd - 1), currentEnd)
      else onRange?.(currentStart, Math.max(ms, currentStart + 1))
      dragHandle(kind, event.clientX)
    }
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

      {/* 滑块轨道：手柄与粉色柱共用同一百分比坐标系 */}
      <div
        ref={trackRef}
        className="video-timeline-track"
        data-point={isPoint || undefined}
        style={
          isPoint
            ? ({ '--point': percent(currentPoint) } as React.CSSProperties)
            : ({
                '--start': percent(currentStart),
                '--end': percent(currentEnd)
              } as React.CSSProperties)
        }
        onPointerDown={handleTrackPointerDown}
      >
        {isPoint ? (
          <div
            className="video-timeline-handle"
            style={{ left: percent(currentPoint) }}
            role="slider"
            aria-label="取帧位置"
            aria-valuemin={0}
            aria-valuemax={max}
            aria-valuenow={currentPoint}
          />
        ) : (
          <>
            <div
              className="video-timeline-handle"
              style={{ left: percent(currentStart) }}
              role="slider"
              aria-label="起始时间"
              aria-valuemin={0}
              aria-valuemax={max}
              aria-valuenow={currentStart}
            />
            <div
              className="video-timeline-handle"
              style={{ left: percent(currentEnd) }}
              role="slider"
              aria-label="结束时间"
              aria-valuemin={0}
              aria-valuemax={max}
              aria-valuenow={currentEnd}
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

// ── 裁剪工作台弹窗（A2：抽帧/截视频/截音频从右侧面板改为弹窗，看得更清晰）──

function VideoTrimWorkbench({
  shape,
  editor,
  projectId,
  mode,
  onClose
}: {
  shape: NodeCardShape
  editor: Editor
  projectId: string
  mode: BodyMode
  onClose: () => void
}): React.JSX.Element {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [onClose])
  const title = mode === 'frame' ? '抽帧' : mode === 'clip' ? '视频截取' : '截音频'
  return createPortal(
    <div
      className="director-studio-mask video-trim-workbench-mask"
      role="dialog"
      aria-modal="true"
      aria-label={`${title}工作台`}
      onPointerDown={(event) => stopEventPropagation(event)}
      onClick={(event) => {
        stopEventPropagation(event)
        if (event.target === event.currentTarget) onClose()
      }}
    >
      <div className="video-trim-workbench">
        <header className="video-trim-workbench-head">
          <div className="video-trim-workbench-title">
            <Icon
              name={mode === 'frame' ? 'frame' : mode === 'clip' ? 'clip' : 'audio'}
              size={15}
            />
            <span>{title}工作台</span>
          </div>
          <button
            className="btn-ghost small"
            onPointerDown={stopEventPropagation}
            onClick={(event) => {
              stopEventPropagation(event)
              onClose()
            }}
          >
            <Icon name="close" size={14} />
          </button>
        </header>
        <div className="video-trim-workbench-body">
          <VideoTransformSettings
            shape={shape}
            editor={editor}
            projectId={projectId}
            mode={mode}
            onRunSubmitted={onClose}
          />
        </div>
      </div>
    </div>,
    document.body
  )
}

type VideoOperationMode = 'clip' | 'frame'
type ClipOutput = 'video-only' | 'audio-only' | 'video-with-audio'

/** 从视频来源统一打开的工作台；配置先保存在弹窗状态，确认后才创建真实节点。 */
export function VideoOperationsWorkbench({
  source,
  editor,
  initialMode = 'clip',
  onClose
}: {
  source: NodeCardShape
  editor: Editor
  initialMode?: VideoOperationMode
  onClose: () => void
}): React.JSX.Element {
  const videoRef = useRef<HTMLVideoElement>(null)
  const previewWrapRef = useRef<HTMLDivElement>(null)
  const playerRef = useRef<HTMLDivElement>(null)
  const project = useAppStore((state) => state.currentProject)
  const providers = useGatewayStore((state) => state.providers)
  const videoOutput = projectNodeOutputs(source)['out-video']
  const sourceMediaId =
    videoOutput?.kind === 'video' ? videoOutput.mediaId : (source.props.mediaId ?? '')
  const sourceMediaPath =
    videoOutput?.kind === 'video' ? videoOutput.mediaPath : (source.props.mediaPath ?? '')

  const [mode, setMode] = useState<VideoOperationMode>(initialMode)
  const [durationMs, setDurationMs] = useState(0)
  const [currentTimeMs, setCurrentTimeMs] = useState(0)
  const [previewBounds, setPreviewBounds] = useState({ width: 0, height: 0 })
  const [fps, setFps] = useState<number | null>(null)
  const [videoAspectRatio, setVideoAspectRatio] = useState<number | null>(null)
  const [isPlaying, setIsPlaying] = useState(false)
  const [isMuted, setIsMuted] = useState(false)
  const [volume, setVolume] = useState(1)
  const [isFullscreen, setIsFullscreen] = useState(false)
  const [clipCfg, setClipCfg] = useState<VideoClipConfig>(() => parseVideoClipConfig(''))
  const [frameCfg, setFrameCfg] = useState<VideoFrameConfig>(() => parseVideoFrameConfig(''))
  const [clipOutput, setClipOutput] = useState<ClipOutput>('video-with-audio')
  const [extractVocals, setExtractVocals] = useState(false)
  const [vocalCfg, setVocalCfg] = useState<VocalSeparationConfig>(() => ({
    ...parseVocalSeparationConfig(''),
    mode: 'quality',
    outputAccompaniment: false
  }))
  const [localCapabilities, setLocalCapabilities] = useState<Awaited<
    ReturnType<typeof window.api.getLocalMediaCapabilities>
  > | null>(null)
  const [submitting, setSubmitting] = useState(false)

  const max = Math.max(durationMs, clipCfg.endMs, frameCfg.timeMs + 1, 1000)
  const fittedPlayerWidth =
    videoAspectRatio && previewBounds.width > 0 && previewBounds.height > 0
      ? Math.min(previewBounds.width, previewBounds.height * videoAspectRatio)
      : null
  const playerFrameStyle = fittedPlayerWidth
    ? {
        width: `${fittedPlayerWidth}px`,
        height: `${fittedPlayerWidth / videoAspectRatio!}px`,
        aspectRatio: String(videoAspectRatio)
      }
    : undefined
  const needsVocalSeparation = mode === 'clip' && clipOutput === 'audio-only' && extractVocals
  const ffmpegAvailable = localCapabilities?.ok ? localCapabilities.data.ffmpeg.available : null
  const separatorAvailable = localCapabilities?.ok
    ? localCapabilities.data.audioSeparator.available
    : null
  const syncDuration = useCallback((nextDurationMs: number): void => {
    if (nextDurationMs <= 0) return
    setDurationMs(nextDurationMs)
    setClipCfg((previous) => ({
      ...previous,
      startMs: Math.min(previous.startMs, nextDurationMs - 1),
      endMs:
        previous.endMs <= 1000 || previous.endMs > nextDurationMs ? nextDurationMs : previous.endMs
    }))
    setFrameCfg((previous) => ({
      ...previous,
      timeMs: Math.min(previous.timeMs, Math.max(0, nextDurationMs - 1))
    }))
  }, [])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [onClose])

  useEffect(() => {
    let active = true
    void window.api.getLocalMediaCapabilities().then((result) => {
      if (active) setLocalCapabilities(result)
    })
    return () => {
      active = false
    }
  }, [])

  useEffect(() => {
    const wrap = previewWrapRef.current
    if (!wrap) return
    const updateBounds = (): void => {
      const width = wrap.clientWidth
      const height = wrap.clientHeight
      setPreviewBounds((previous) =>
        previous.width === width && previous.height === height ? previous : { width, height }
      )
    }
    updateBounds()
    const observer = new ResizeObserver(updateBounds)
    observer.observe(wrap)
    return () => observer.disconnect()
  }, [])

  useEffect(() => {
    const updateFullscreen = (): void =>
      setIsFullscreen(document.fullscreenElement === playerRef.current)
    document.addEventListener('fullscreenchange', updateFullscreen)
    return () => document.removeEventListener('fullscreenchange', updateFullscreen)
  }, [])

  useEffect(() => {
    if (!project || !sourceMediaId) return
    let active = true
    void window.api.probeVideo({ projectId: project.id, sourceMediaId }).then((result) => {
      if (!active || !result.ok) return
      syncDuration(result.data.durationMs)
      setFps(result.data.fps)
    })
    return () => {
      active = false
    }
  }, [project, sourceMediaId, syncDuration])

  const seek = (timeMs: number): void => {
    const safeTime = clamp(Math.round(timeMs), Math.max(0, durationMs))
    const video = videoRef.current
    if (video) video.currentTime = safeTime / 1000
    setCurrentTimeMs(safeTime)
  }
  const saveRange = (startMs: number, endMs: number): void => {
    const start = Math.round(clamp(startMs, Math.max(0, max - 1)))
    const end = Math.round(Math.max(start + 1, clamp(endMs, max)))
    setClipCfg((previous) => ({ ...previous, startMs: start, endMs: end }))
  }
  const savePoint = (timeMs: number): void =>
    setFrameCfg((previous) => ({
      ...previous,
      mode: 'custom',
      timeMs: Math.round(clamp(timeMs, Math.max(0, max - 1)))
    }))
  const handleTimeUpdate = (): void => {
    const video = videoRef.current
    if (!video) return
    setCurrentTimeMs(Math.round(video.currentTime * 1000))
  }
  const jumpBy = (deltaMs: number): void => {
    const nextTime = clamp(
      Math.round((videoRef.current?.currentTime ?? currentTimeMs / 1000) * 1000) + deltaMs,
      Math.max(0, durationMs)
    )
    seek(nextTime)
    if (mode === 'frame') savePoint(nextTime)
  }
  const togglePlayback = (): void => {
    const video = videoRef.current
    if (!video) return
    if (video.paused) void video.play().catch(() => toast('视频暂时无法播放'))
    else video.pause()
  }
  const toggleMute = (): void => {
    const video = videoRef.current
    if (!video) return
    if (video.muted || video.volume === 0) {
      if (video.volume === 0) video.volume = 1
      video.muted = false
    } else {
      video.muted = true
    }
    setIsMuted(video.muted)
  }
  const toggleFullscreen = (): void => {
    const player = playerRef.current
    if (!player) return
    const action =
      document.fullscreenElement === player ? document.exitFullscreen() : player.requestFullscreen()
    void action.catch(() => toast('无法切换全屏播放'))
  }

  const makeOperation = (): void => {
    if (!project) return toast('项目未就绪')
    if (!sourceMediaId || !sourceMediaPath) return toast('当前视频没有可用的媒体文件')
    setSubmitting(true)
    let clipNodeId: TLShapeId | null = null
    let vocalNodeId: TLShapeId | null = null
    let targetNodeId: TLShapeId | null = null

    editor.run(() => {
      if (mode === 'frame') {
        targetNodeId = createVideoContinuation(editor, source, 'video-frame', {
          config: serializeVideoFrameConfig(frameCfg)
        })
        return
      }

      const clipConfig: VideoClipConfig = {
        ...clipCfg,
        keepVideo: clipOutput !== 'audio-only',
        keepAudio: clipOutput === 'audio-only',
        includeAudio: clipOutput === 'video-with-audio',
        audioFormat: needsVocalSeparation ? 'wav' : clipCfg.audioFormat
      }
      clipNodeId = createVideoContinuation(editor, source, 'video-clip', {
        title: clipOutput === 'audio-only' ? '提取音频' : '视频截取',
        config: serializeVideoClipConfig(clipConfig)
      })
      if (!clipNodeId) return
      targetNodeId = clipNodeId

      if (needsVocalSeparation) {
        const clipShape = editor.getShape(clipNodeId)
        if (clipShape?.type !== 'node-card') {
          editor.deleteShape(clipNodeId)
          clipNodeId = null
          targetNodeId = null
          return
        }
        vocalNodeId = createVocalSeparationContinuation(editor, clipShape as NodeCardShape, {
          config: serializeVocalSeparationConfig(vocalCfg)
        })
        if (!vocalNodeId) {
          editor.deleteShape(clipNodeId)
          clipNodeId = null
          targetNodeId = null
          return
        }
        targetNodeId = vocalNodeId
      }
    })

    if (!targetNodeId) {
      setSubmitting(false)
      return toast('无法创建视频操作节点，请检查来源视频与连线')
    }
    markUndoPoint(editor, 'video-operation-create')
    const clipId = clipNodeId
    const vocalId = vocalNodeId
    const targetId = targetNodeId
    onClose()
    window.setTimeout(() => {
      if (clipId) {
        void runNodeManually(editor, project.id, providers, clipId).then((result) => {
          if (result.status === 'done' && vocalId)
            void runNodeManually(editor, project.id, providers, vocalId)
        })
      } else {
        void runNodeManually(editor, project.id, providers, targetId)
      }
    }, 0)
  }

  const separatorUnavailable =
    needsVocalSeparation && vocalCfg.mode === 'quality' && separatorAvailable === false

  return createPortal(
    <div
      className="director-studio-mask video-trim-workbench-mask video-operations-mask"
      role="dialog"
      aria-modal="true"
      aria-label="视频操作工作台"
      onPointerDown={(event) => stopEventPropagation(event)}
      onClick={(event) => {
        stopEventPropagation(event)
        if (event.target === event.currentTarget) onClose()
      }}
    >
      <div className="video-trim-workbench video-operations-dialog">
        <header className="video-trim-workbench-head video-operations-head">
          <div className="video-operations-title">
            <Icon name="video-asset" size={17} />
            <span>视频操作</span>
            <span className={`video-operations-status ${ffmpegAvailable === false ? 'warn' : ''}`}>
              <i />
              {ffmpegAvailable === null
                ? '检测本机媒体工具…'
                : ffmpegAvailable
                  ? 'FFmpeg 已就绪'
                  : 'FFmpeg 不可用'}
            </span>
          </div>
          <div className="video-operations-tabs" role="tablist" aria-label="视频操作类型">
            {(
              [
                ['clip', '视频截取'],
                ['frame', '抽帧']
              ] as const
            ).map(([value, label]) => (
              <button
                key={value}
                type="button"
                role="tab"
                aria-selected={mode === value}
                className={mode === value ? 'active' : ''}
                onClick={() => setMode(value)}
              >
                {label}
              </button>
            ))}
          </div>
          <button
            className="btn-ghost small video-operations-close"
            aria-label="关闭工作台"
            onClick={onClose}
          >
            <Icon name="close" size={15} />
          </button>
        </header>

        <div className="video-operations-body">
          <div ref={playerRef} className="video-operations-player" aria-label="视频播放器">
            <div
              ref={previewWrapRef}
              className={`video-operations-preview-wrap ${videoAspectRatio !== null && videoAspectRatio < 1 ? 'portrait' : 'landscape'}`}
            >
              {sourceMediaPath ? (
                <div className="video-operations-player-frame" style={playerFrameStyle}>
                  <video
                    ref={videoRef}
                    className="video-operations-preview"
                    src={mediaUrl(sourceMediaPath)}
                    preload="metadata"
                    playsInline
                    aria-label="视频预览，点击播放或暂停"
                    onClick={togglePlayback}
                    onLoadedMetadata={(event) => {
                      const video = event.currentTarget
                      const seconds = video.duration
                      if (Number.isFinite(seconds) && seconds > 0)
                        syncDuration(Math.round(seconds * 1000))
                      setCurrentTimeMs(Math.round(video.currentTime * 1000))
                      if (video.videoWidth > 0 && video.videoHeight > 0)
                        setVideoAspectRatio(video.videoWidth / video.videoHeight)
                    }}
                    onPlay={() => setIsPlaying(true)}
                    onPause={() => setIsPlaying(false)}
                    onTimeUpdate={handleTimeUpdate}
                    onSeeked={(event) => {
                      const timeMs = Math.round(event.currentTarget.currentTime * 1000)
                      setCurrentTimeMs(timeMs)
                      if (mode === 'frame') savePoint(timeMs)
                    }}
                    onVolumeChange={(event) => {
                      setVolume(event.currentTarget.volume)
                      setIsMuted(event.currentTarget.muted)
                    }}
                    onEnded={() => setIsPlaying(false)}
                  />
                </div>
              ) : (
                <div className="video-operations-no-source">当前视频无法预览</div>
              )}
            </div>
            <div className="video-operations-player-controls">
              <button
                type="button"
                className="video-operations-player-button primary"
                aria-label={isPlaying ? '暂停' : '播放'}
                title={isPlaying ? '暂停' : '播放'}
                disabled={!sourceMediaPath}
                onClick={togglePlayback}
              >
                <Icon name={isPlaying ? 'pause' : 'play'} size={18} />
              </button>
              <button
                type="button"
                className="video-operations-player-button"
                aria-label="后退 5 秒"
                title="后退 5 秒"
                disabled={durationMs <= 0}
                onClick={() => jumpBy(-5000)}
              >
                −5
              </button>
              <button
                type="button"
                className="video-operations-player-button"
                aria-label="快进 5 秒"
                title="快进 5 秒"
                disabled={durationMs <= 0}
                onClick={() => jumpBy(5000)}
              >
                +5
              </button>
              <span className="video-operations-player-time">{playbackTime(currentTimeMs)}</span>
              <input
                className="video-operations-player-progress"
                type="range"
                aria-label="播放进度"
                min={0}
                max={Math.max(1, durationMs)}
                step={1}
                value={Math.min(currentTimeMs, Math.max(1, durationMs))}
                disabled={durationMs <= 0}
                style={
                  {
                    '--played': `${durationMs > 0 ? (Math.min(currentTimeMs, durationMs) / durationMs) * 100 : 0}%`
                  } as React.CSSProperties
                }
                onChange={(event) => seek(Number(event.currentTarget.value))}
              />
              <span className="video-operations-player-time">{playbackTime(durationMs)}</span>
              <button
                type="button"
                className="video-operations-player-button"
                aria-label={isMuted || volume === 0 ? '取消静音' : '静音'}
                title={isMuted || volume === 0 ? '取消静音' : '静音'}
                disabled={!sourceMediaPath}
                onClick={toggleMute}
              >
                <Icon name={isMuted || volume === 0 ? 'volume-off' : 'volume'} size={17} />
              </button>
              <input
                className="video-operations-player-volume"
                type="range"
                aria-label="音量"
                min={0}
                max={1}
                step={0.05}
                value={isMuted ? 0 : volume}
                disabled={!sourceMediaPath}
                onChange={(event) => {
                  const nextVolume = Number(event.currentTarget.value)
                  const video = videoRef.current
                  if (!video) return
                  video.volume = nextVolume
                  video.muted = false
                  setVolume(nextVolume)
                  setIsMuted(false)
                }}
              />
              <button
                type="button"
                className="video-operations-player-button"
                aria-label={isFullscreen ? '退出全屏' : '全屏'}
                title={isFullscreen ? '退出全屏' : '全屏'}
                disabled={!sourceMediaPath}
                onClick={toggleFullscreen}
              >
                <Icon name={isFullscreen ? 'fullscreen-exit' : 'fullscreen'} size={17} />
              </button>
            </div>
          </div>

          <div className="video-operations-timeline">
            {mode === 'frame' ? (
              <MediaTimeline
                durationMs={max}
                pointMs={
                  frameCfg.mode === 'first'
                    ? 0
                    : frameCfg.mode === 'last'
                      ? max - 1
                      : frameCfg.timeMs
                }
                fps={fps}
                onSeek={seek}
                onPoint={savePoint}
                onCommit={() => undefined}
              />
            ) : (
              <MediaTimeline
                durationMs={max}
                startMs={clipCfg.startMs}
                endMs={clipCfg.endMs}
                fps={fps}
                onSeek={seek}
                onRange={saveRange}
                onCommit={() => undefined}
              />
            )}
          </div>

          <section className="video-operations-options">
            {ffmpegAvailable === false && (
              <div className="local-capability-alert" role="alert">
                <strong>本机未检测到 FFmpeg</strong>
                <span>视频截取与抽帧需要 FFmpeg；安装后即可执行。</span>
              </div>
            )}

            {mode === 'frame' ? (
              <div className="video-operations-option-line">
                <span className="video-operations-option-label">取帧位置</span>
                <div className="video-operations-choice-row" role="group" aria-label="取帧位置">
                  {(
                    [
                      ['first', '首帧'],
                      ['last', '尾帧'],
                      ['custom', '指定时刻']
                    ] as const
                  ).map(([value, label]) => (
                    <button
                      key={value}
                      type="button"
                      className={`btn-ghost small frame-preset-btn ${frameCfg.mode === value ? 'active' : ''}`}
                      disabled={value === 'last' && durationMs <= 0}
                      onClick={() => {
                        const timeMs =
                          value === 'first' ? 0 : value === 'last' ? max - 1 : frameCfg.timeMs
                        setFrameCfg((previous) => ({ ...previous, mode: value, timeMs }))
                        seek(timeMs)
                      }}
                    >
                      {label}
                    </button>
                  ))}
                </div>
                <label className="video-operations-inline-select">
                  格式
                  <AppSelect
                    value={frameCfg.format}
                    onChange={(event) => {
                      const format = event.currentTarget.value as 'png' | 'jpg'
                      setFrameCfg((previous) => ({ ...previous, format }))
                    }}
                  >
                    <option value="png">PNG（无损）</option>
                    <option value="jpg">JPG（体积小）</option>
                  </AppSelect>
                </label>
              </div>
            ) : (
              <div className="video-operations-clip-options">
                <div className="video-operations-option-line">
                  <span className="video-operations-option-label">保留内容</span>
                  <div className="video-operations-choice-row" role="group" aria-label="保留内容">
                    {(
                      [
                        ['video-only', '仅画面'],
                        ['audio-only', '仅音频'],
                        ['video-with-audio', '画面 + 音频']
                      ] as const
                    ).map(([value, label]) => (
                      <button
                        key={value}
                        type="button"
                        className={clipOutput === value ? 'active' : ''}
                        aria-pressed={clipOutput === value}
                        onClick={() => {
                          setClipOutput(value)
                          if (value !== 'audio-only') setExtractVocals(false)
                        }}
                      >
                        {label}
                      </button>
                    ))}
                  </div>
                </div>
                {clipOutput === 'audio-only' && (
                  <div className="video-operations-option-line">
                    <span className="video-operations-option-label">音频处理</span>
                    <div className="video-operations-choice-row" role="group" aria-label="音频处理">
                      <button
                        type="button"
                        className={!extractVocals ? 'active' : ''}
                        aria-pressed={!extractVocals}
                        onClick={() => setExtractVocals(false)}
                      >
                        保留原音频
                      </button>
                      <button
                        type="button"
                        className={extractVocals ? 'active' : ''}
                        aria-pressed={extractVocals}
                        onClick={() => setExtractVocals(true)}
                      >
                        原音频 + 提取人声
                      </button>
                    </div>
                  </div>
                )}
                {needsVocalSeparation && (
                  <div className="video-operations-option-line">
                    <span className="video-operations-option-label">分离方式</span>
                    <label className="video-operations-inline-select">
                      <AppSelect
                        value={vocalCfg.mode}
                        onChange={(event) => {
                          const nextMode = event.currentTarget.value as VocalMode
                          setVocalCfg((previous) => ({ ...previous, mode: nextMode }))
                        }}
                      >
                        <option value="quality">高质量分离（本地 AI）</option>
                        <option value="fast">快速人声增强（效果有限）</option>
                      </AppSelect>
                    </label>
                  </div>
                )}
                {separatorUnavailable && (
                  <div className="video-operations-capability" role="alert">
                    本机缺少高质量分离器；可安装 audio-separator，或选择快速人声增强。
                  </div>
                )}
                <details className="video-operations-advanced">
                  <summary>输出设置</summary>
                  <div className="video-operations-advanced-fields">
                    {clipOutput === 'audio-only' ? (
                      <>
                        <label className="video-operations-inline-select">
                          音频格式
                          <AppSelect
                            value={needsVocalSeparation ? 'wav' : clipCfg.audioFormat}
                            disabled={needsVocalSeparation}
                            onChange={(event) => {
                              const audioFormat = event.currentTarget.value as AudioFormat
                              setClipCfg((previous) => ({ ...previous, audioFormat }))
                            }}
                          >
                            <option value="wav">WAV（无损）</option>
                            <option value="m4a">M4A（体积小）</option>
                          </AppSelect>
                        </label>
                        <label className="video-operations-inline-select">
                          采样率
                          <AppSelect
                            value={String(clipCfg.audioSampleRate)}
                            onChange={(event) => {
                              const audioSampleRate =
                                event.currentTarget.value === '48000' ? 48000 : 44100
                              setClipCfg((previous) => ({ ...previous, audioSampleRate }))
                            }}
                          >
                            <option value="44100">44.1 kHz</option>
                            <option value="48000">48 kHz</option>
                          </AppSelect>
                        </label>
                      </>
                    ) : (
                      <label className="video-operations-inline-select">
                        编码质量
                        <AppSelect
                          value={clipCfg.quality}
                          onChange={(event) => {
                            const quality = event.currentTarget.value as ClipQuality
                            setClipCfg((previous) => ({ ...previous, quality }))
                          }}
                        >
                          <option value="fast">快速复制（边界可能不精确）</option>
                          <option value="balanced">平衡（CRF 18）</option>
                          <option value="high">高质量（CRF 14）</option>
                        </AppSelect>
                      </label>
                    )}
                  </div>
                </details>
              </div>
            )}
          </section>
        </div>

        <footer className="video-operations-footer">
          <button className="btn-ghost small" onClick={onClose} disabled={submitting}>
            取消
          </button>
          <button
            className="btn-primary video-operations-submit"
            onClick={makeOperation}
            disabled={
              submitting ||
              !project ||
              !sourceMediaId ||
              ffmpegAvailable === false ||
              separatorUnavailable
            }
          >
            <Icon
              name={mode === 'frame' ? 'frame' : clipOutput === 'audio-only' ? 'audio' : 'clip'}
              size={15}
            />
            {submitting
              ? '正在创建…'
              : mode === 'frame'
                ? '抽取当前帧'
                : clipOutput === 'audio-only'
                  ? extractVocals
                    ? '提取音频和人声'
                    : '提取原音频'
                  : clipOutput === 'video-only'
                    ? '截取画面'
                    : '截取画面和音频'}
          </button>
        </footer>
      </div>
    </div>,
    document.body
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
  const projectId = useAppStore((s) => s.currentProject?.id ?? '')
  const [workbenchOpen, setWorkbenchOpen] = useState(false)
  const [operationsOpen, setOperationsOpen] = useState(false)
  // 执行器（videoFrameExecutor / videoClipExecutor / videoAudioExecutor）只看 in-video 连线；
  // 卡片历史结果 mediaPath 不是运行条件，所以判据按连线给出。
  const sourceCount = countIncomingConnections(editor, shape.id, 'in-video')
  const sourceWiring = (
    <span className={`node-wiring ${sourceCount === 0 ? 'warn' : 'ok'}`}>
      {sourceCount === 0
        ? '源视频（in-video）未连线，运行会跳过'
        : `源视频（in-video）：${sourceCount} 个`}
    </span>
  )
  // 空态文案与节点 label / 视频节点底部按钮保持同一套命名（用户 2026-09-18 拍板）。
  const label = mode === 'frame' ? '抽帧' : mode === 'clip' ? '视频截取' : '截音频'
  const workbenchEl = workbenchOpen ? (
    <VideoTrimWorkbench
      shape={shape}
      editor={editor}
      projectId={projectId}
      mode={mode}
      onClose={() => setWorkbenchOpen(false)}
    />
  ) : null
  const operationsEl = operationsOpen ? (
    <VideoOperationsWorkbench
      source={shape}
      editor={editor}
      onClose={() => setOperationsOpen(false)}
    />
  ) : null
  if (!shape.props.mediaPath) {
    return (
      <div className="asset-empty crop-empty">
        <Icon name={mode === 'frame' ? 'frame' : mode === 'clip' ? 'clip' : 'audio'} size={24} />
        <span>{label}</span>
        <button
          className="btn-ghost small"
          onPointerDown={stopEventPropagation}
          onClick={(event) => {
            stopEventPropagation(event)
            setWorkbenchOpen(true)
          }}
        >
          配置{label}
        </button>
        {sourceWiring}
        {workbenchEl}
        {operationsEl}
      </div>
    )
  }
  const previewKind = mode === 'frame' ? 'image' : mode === 'clip' ? 'video' : 'audio'
  return (
    <div className="node-media-wrap">
      <div
        className="node-media"
        data-node-interactive="media-preview"
        onPointerDown={guard.onPointerDown}
        onDoubleClick={(event) =>
          guard.onDoubleClick(event, () =>
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
          <div className="node-audio-thumb">
            <Icon name="audio" size={30} />
          </div>
        )}
        {mode === 'clip' && <span className="play-badge">▶</span>}
      </div>
      {mode === 'audio' && (
        <audio
          className="node-inline-audio"
          controls
          preload="metadata"
          src={mediaUrl(shape.props.mediaPath)}
          onPointerDown={stopEventPropagation}
        />
      )}
      <div className="node-media-actions">
        <button
          className="btn-ghost small"
          onPointerDown={stopEventPropagation}
          onClick={(event) => {
            stopEventPropagation(event)
            setWorkbenchOpen(true)
          }}
        >
          调整
        </button>
        <MediaSourceBadge shape={shape} fallback="本地视频处理" />
        <MediaFileActions shape={shape} />
      </div>
      {sourceWiring}
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
            修改
          </button>
          <button
            className="btn-ghost small"
            onPointerDown={stopEventPropagation}
            onClick={(event) => {
              stopEventPropagation(event)
              createImageContinuation(editor, shape, 'image-gen')
            }}
          >
            继续生图
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
              setOperationsOpen(true)
            }}
          >
            视频操作
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
            人声分离
          </button>
        </div>
      )}
      {workbenchEl}
      {operationsEl}
    </div>
  )
}

// ── 右侧详情面板 ──

function VideoTransformSettings({
  shape,
  editor,
  mode,
  onRunSubmitted
}: NodeSettingsProps & { mode: BodyMode; onRunSubmitted?: () => void }): React.JSX.Element {
  const videoRef = useRef<HTMLVideoElement>(null)
  const [durationMs, setDurationMs] = useState(0)
  const [fps, setFps] = useState<number | null>(null)
  const project = useAppStore((state) => state.currentProject)
  const providers = useGatewayStore((state) => state.providers)
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
  const [clipTab, setClipTab] = useState<'video' | 'audio'>('video')
  const [localCapabilities, setLocalCapabilities] = useState<Awaited<
    ReturnType<typeof window.api.getLocalMediaCapabilities>
  > | null>(null)

  const isFrame = mode === 'frame'
  const isClip = mode === 'clip'
  const label = isFrame ? '抽帧' : isClip ? '视频截取' : '截音频'

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

  // 波形数据拉取（提音模式、以及会产出音频的视频截取模式）
  useEffect(() => {
    if (!project || !source?.mediaId || isFrame || (isClip && !clipCfg.keepAudio)) return
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
  }, [project, source?.mediaId, isFrame, isClip, clipCfg.keepAudio])

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
  const patchClip = (patch: Partial<VideoClipConfig>, undoLabel: string): void => {
    const next: VideoClipConfig = { ...clipRef.current, ...patch }
    clipRef.current = next
    setClipCfg(next)
    editor.updateShape({
      id: shape.id,
      type: 'node-card',
      props: { config: serializeVideoClipConfig(next) }
    })
    markUndoPoint(editor, undoLabel)
  }
  const setClipQuality = (quality: ClipQuality): void =>
    patchClip({ quality }, 'video-clip-quality')
  const toggleClipAudio = (includeAudio: boolean): void =>
    patchClip({ includeAudio }, 'video-clip-audio')
  /** 保留内容三态：只画面 / 只音频 / 画面+音频。至少保留一条由调用方保证。 */
  const setClipKeep = (keepVideo: boolean, keepAudio: boolean): void =>
    patchClip({ keepVideo, keepAudio }, 'video-clip-keep')
  const setClipAudioFormat = (audioFormat: AudioFormat): void =>
    patchClip({ audioFormat }, 'video-clip-audio-format')
  const setClipAudioSampleRate = (audioSampleRate: 44100 | 48000): void =>
    patchClip({ audioSampleRate }, 'video-clip-audio-rate')
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

  const submitAndRun = (): void => {
    if (!source) {
      toast('请先连接一段视频')
      return
    }
    if (!project) {
      toast('项目未就绪')
      return
    }
    // 配置先落盘，之后仅通过统一节点运行器执行；工作台不会直接触发媒体转换。
    commit()
    onRunSubmitted?.()
    // 让关闭状态先完成一次 React 提交，下一事件周期再启动节点运行。
    window.setTimeout(() => {
      void runNodeManually(editor, project.id, providers, shape.id)
    }, 0)
  }

  return (
    <section className="contract-section video-transform-settings">
      <h4>{label}</h4>
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
                waveform={clipCfg.keepAudio ? waveform : undefined}
                isPlaying={isPlaying}
                loopEnabled={loopEnabled}
                onSeek={seek}
                onRange={saveClip}
                onCommit={commit}
                onPlayPause={togglePlay}
                onToggleLoop={toggleLoop}
              />
              {/* A3：画面/音频并入同一节点后由「保留内容」决定产出哪几条资产。 */}
              <div className="clip-keep-row" role="group" aria-label="保留内容">
                <span className="clip-keep-label">保留内容</span>
                {(
                  [
                    { v: true, a: false, text: '只保留画面' },
                    { v: false, a: true, text: '只保留音频' },
                    { v: true, a: true, text: '画面 + 音频' }
                  ] as const
                ).map((preset) => (
                  <button
                    key={preset.text}
                    type="button"
                    className={`btn-ghost small frame-preset-btn ${
                      clipCfg.keepVideo === preset.v && clipCfg.keepAudio === preset.a
                        ? 'active'
                        : ''
                    }`}
                    onPointerDown={stopEventPropagation}
                    onClick={(event) => {
                      stopEventPropagation(event)
                      setClipKeep(preset.v, preset.a)
                      setClipTab(preset.v ? 'video' : 'audio')
                    }}
                  >
                    {preset.text}
                  </button>
                ))}
              </div>
              {clipCfg.keepVideo && clipCfg.keepAudio && (
                <div className="clip-tabs" role="tablist" aria-label="截取参数">
                  {(['video', 'audio'] as const).map((tab) => (
                    <button
                      key={tab}
                      type="button"
                      role="tab"
                      aria-selected={clipTab === tab}
                      className={`clip-tab ${clipTab === tab ? 'active' : ''}`}
                      onPointerDown={stopEventPropagation}
                      onClick={(event) => {
                        stopEventPropagation(event)
                        setClipTab(tab)
                      }}
                    >
                      {tab === 'video' ? '画面参数' : '音频参数'}
                    </button>
                  ))}
                </div>
              )}
              {(!clipCfg.keepAudio || clipTab === 'video') && clipCfg.keepVideo && (
                <>
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
                    视频片段内保留原声
                  </label>
                </>
              )}
              {(!clipCfg.keepVideo || clipTab === 'audio') && clipCfg.keepAudio && (
                <>
                  <label className="audio-isolation-mode">
                    音频格式
                    <AppSelect
                      value={clipCfg.audioFormat}
                      onChange={(event) =>
                        setClipAudioFormat(event.currentTarget.value as AudioFormat)
                      }
                    >
                      <option value="wav">WAV（无损，适合人声分离）</option>
                      <option value="m4a">M4A（体积小）</option>
                    </AppSelect>
                  </label>
                  <label className="audio-isolation-mode">
                    采样率
                    <AppSelect
                      value={String(clipCfg.audioSampleRate)}
                      onChange={(event) =>
                        setClipAudioSampleRate(
                          event.currentTarget.value === '48000' ? 48000 : 44100
                        )
                      }
                    >
                      <option value="44100">44.1 kHz</option>
                      <option value="48000">48 kHz</option>
                    </AppSelect>
                  </label>
                </>
              )}
            </>
          ) : (
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
          )}
          <button
            type="button"
            className="btn-primary node-workbench-run"
            onPointerDown={stopEventPropagation}
            onClick={(event) => {
              stopEventPropagation(event)
              submitAndRun()
            }}
          >
            <Icon name={isFrame ? 'frame' : isClip ? 'clip' : 'audio'} size={15} />
            {isFrame ? '开始抽帧' : isClip ? '截取视频' : '截取音频'}
          </button>
        </>
      ) : (
        <div className="crop-no-source">请从视频节点连线到左侧“源视频”端口。</div>
      )}
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
