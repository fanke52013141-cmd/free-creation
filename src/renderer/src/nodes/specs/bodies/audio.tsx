// 音频资产节点 Body：导入本地音频、预览、输出资产。
//
// 通用配音（speech）已拆到 bodies/speech.tsx——它是模型驱动节点，参数分组与端口
// 随所选协议变化，和「导入一段音频素材」不是同一种职责，共用 Body 只会让两边的
// 语义继续分叉（历史遗留的 mode: 'upload' | 'generate' 双形态已删除）。
import { useEffect, useRef, useState } from 'react'
import { stopEventPropagation, useEditor } from 'tldraw'
import { mediaUrl, type NodeBodyProps } from '../../registry'
import { toast } from '../../../stores/toast'
import { markUndoPoint } from '../../../canvas/history'
import { useAppStore } from '../../../stores/app'
import { Icon } from '../../../components/Icon'
import {
  clearSelectedMediaHistory,
  MediaFileActions,
  MediaResultGrid,
  pickImportedAsset,
  removeMediaResultFromShape,
  selectMediaResult,
  useClickGuard
} from './shared'

const AUDIO_WAVEFORM_SAMPLES = 50

const fallbackWaveform = Array.from({ length: AUDIO_WAVEFORM_SAMPLES }, (_, index) => {
  const shape = Math.abs(Math.sin(index * 0.71) * Math.cos(index * 0.19))
  return 0.12 + shape * 0.68
})

function formatAudioTime(value: number): string {
  const seconds = Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0
  const hours = Math.floor(seconds / 3600)
  const minutes = Math.floor((seconds % 3600) / 60)
  const remainder = seconds % 60
  return hours > 0
    ? `${hours}:${String(minutes).padStart(2, '0')}:${String(remainder).padStart(2, '0')}`
    : `${minutes}:${String(remainder).padStart(2, '0')}`
}

export function AudioBody({ shape, openPreview }: NodeBodyProps): React.JSX.Element {
  const guard = useClickGuard()
  const editor = useEditor()
  const project = useAppStore((s) => s.currentProject)
  const audioRef = useRef<HTMLAudioElement>(null)
  const waveformTrackRef = useRef<HTMLDivElement>(null)
  const seekingRef = useRef(false)
  const [waveform, setWaveform] = useState<number[]>([])
  const [duration, setDuration] = useState(0)
  const [currentTime, setCurrentTime] = useState(0)
  const [playing, setPlaying] = useState(false)
  const [volume, setVolume] = useState(0.75)
  const [muted, setMuted] = useState(false)

  useEffect(() => {
    const projectId = project?.id
    const mediaId = shape.props.mediaId
    if (!projectId || !mediaId || !shape.props.mediaPath) {
      setWaveform([])
      return
    }

    let active = true
    setWaveform([])
    void window.api
      .generateAudioWaveform({
        projectId,
        sourceMediaId: mediaId,
        samples: AUDIO_WAVEFORM_SAMPLES
      })
      .then((result) => {
        if (active && result.ok) setWaveform(result.data.peaks)
      })
      .catch(() => undefined)
    return () => {
      active = false
    }
  }, [project?.id, shape.props.mediaId, shape.props.mediaPath])

  useEffect(() => {
    const audio = audioRef.current
    if (!audio) return
    audio.volume = volume
    audio.muted = muted
  }, [volume, muted])

  useEffect(() => {
    const audio = audioRef.current
    audio?.pause()
    setDuration(0)
    setCurrentTime(0)
    setPlaying(false)
    return () => audio?.pause()
  }, [shape.props.mediaPath])

  const uploadAudio = async (): Promise<void> => {
    if (!project) return toast('项目未就绪')
    try {
      const res = await window.api.pickMedia(project.id)
      if (!res.ok) return toast(`上传失败：${res.error.message}`)
      const audioAsset = pickImportedAsset({
        result: res.data,
        kind: 'audio',
        noun: '一个音频',
        mismatch: '请选择一个音频文件',
        projectId: project.id
      })
      if (!audioAsset) return
      editor.updateShape({
        id: shape.id,
        type: 'node-card',
        props: {
          mediaId: audioAsset.id,
          mediaPath: audioAsset.path,
          mediaMime: audioAsset.mime,
          title: audioAsset.name ?? shape.props.title
        }
      })
      markUndoPoint(editor, 'audio-upload')
    } catch (error) {
      toast(`导入失败：${error instanceof Error ? error.message : String(error)}`)
    }
  }

  const openAudioPreview = (): void => {
    if (!shape.props.mediaPath) return
    openPreview({
      kind: 'audio',
      url: mediaUrl(shape.props.mediaPath),
      title: shape.props.title
    })
  }

  const seekAt = (clientX: number): void => {
    const audio = audioRef.current
    const track = waveformTrackRef.current
    if (!audio || !track || !Number.isFinite(audio.duration) || audio.duration <= 0) return
    const bounds = track.getBoundingClientRect()
    if (bounds.width <= 0) return
    const ratio = Math.max(0, Math.min(1, (clientX - bounds.left) / bounds.width))
    audio.currentTime = ratio * audio.duration
    setCurrentTime(audio.currentTime)
  }

  const togglePlayback = (): void => {
    const audio = audioRef.current
    if (!audio) return
    if (audio.paused) {
      void audio.play().catch(() => toast('无法播放此音频文件'))
    } else {
      audio.pause()
    }
  }

  const handleWaveformKeyDown = (event: React.KeyboardEvent<HTMLDivElement>): void => {
    const audio = audioRef.current
    if (!audio || !Number.isFinite(audio.duration) || audio.duration <= 0) return
    let nextTime: number | null = null
    if (event.key === 'ArrowLeft') nextTime = currentTime - 5
    if (event.key === 'ArrowRight') nextTime = currentTime + 5
    if (event.key === 'Home') nextTime = 0
    if (event.key === 'End') nextTime = audio.duration
    if (nextTime === null) return
    event.preventDefault()
    event.stopPropagation()
    audio.currentTime = Math.max(0, Math.min(audio.duration, nextTime))
    setCurrentTime(audio.currentTime)
  }

  const progress = duration > 0 ? Math.max(0, Math.min(1, currentTime / duration)) : 0
  const progressPercent = `${progress * 100}%`

  // ── 已有音频文件：自绘波形播放器 ──
  if (shape.props.mediaPath) {
    const chooseResult = (item: Parameters<typeof selectMediaResult>[1]): void => {
      const selected = selectMediaResult(shape, item)
      editor.updateShape({
        id: shape.id,
        type: 'node-card',
        props: selected.props,
        meta: { ...(shape.meta ?? {}), nodeResult: selected.nodeResult }
      })
      markUndoPoint(editor, 'audio-select-result')
    }
    return (
      <div className="node-audio-player audio-asset-player">
        <audio
          ref={audioRef}
          className="audio-playback-element"
          preload="metadata"
          src={mediaUrl(shape.props.mediaPath)}
          onLoadedMetadata={(event) => {
            const nextDuration = event.currentTarget.duration
            if (Number.isFinite(nextDuration)) setDuration(nextDuration)
          }}
          onDurationChange={(event) => {
            const nextDuration = event.currentTarget.duration
            if (Number.isFinite(nextDuration)) setDuration(nextDuration)
          }}
          onTimeUpdate={(event) => setCurrentTime(event.currentTarget.currentTime)}
          onPlay={() => setPlaying(true)}
          onPause={() => setPlaying(false)}
          onEnded={() => setPlaying(false)}
        />

        <div className="audio-asset-heading">
          <button
            type="button"
            className="audio-asset-icon-wrap"
            title="双击打开大窗播放器"
            aria-label="打开音频预览"
            onPointerDown={(event) => stopEventPropagation(event)}
            onDoubleClick={(event) => guard.onDoubleClick(event, openAudioPreview)}
            onClick={(event) => event.stopPropagation()}
          >
            <span className="audio-asset-icon-glow" />
            <Icon name="audio" size={24} />
          </button>
          <div className="audio-asset-heading-copy">
            <div className="audio-asset-track-line">
              <button
                type="button"
                className="audio-asset-name"
                title="双击打开音频预览"
                onPointerDown={(event) => stopEventPropagation(event)}
                onDoubleClick={(event) => guard.onDoubleClick(event, openAudioPreview)}
                onClick={(event) => event.stopPropagation()}
              >
                {shape.props.title || '音频文件'}
              </button>
              <span className="audio-asset-timecode" aria-label="当前播放时间与总时长">
                <span>{formatAudioTime(currentTime)}</span>
                <span className="audio-asset-time-divider">/</span>
                <span className="audio-asset-duration">{formatAudioTime(duration)}</span>
              </span>
            </div>
            <span
              className={`audio-asset-status ${playing ? 'is-playing' : ''}`}
              aria-label={playing ? '正在播放' : '音频已就绪'}
            >
              <span className="audio-asset-status-dot" />
              <span>{playing ? '正在播放' : '音频已就绪'}</span>
            </span>
          </div>
        </div>

        <div className="audio-playback-panel">
          <div
            ref={waveformTrackRef}
            className="audio-waveform-track"
            data-node-interactive="media-preview"
            role="slider"
            tabIndex={0}
            aria-label="音频播放进度"
            aria-valuemin={0}
            aria-valuemax={Math.round(duration)}
            aria-valuenow={Math.round(currentTime)}
            aria-valuetext={`${formatAudioTime(currentTime)} / ${formatAudioTime(duration)}`}
            onPointerDown={(event) => {
              if (event.button !== 0) return
              stopEventPropagation(event)
              seekingRef.current = true
              event.currentTarget.setPointerCapture(event.pointerId)
              seekAt(event.clientX)
            }}
            onPointerMove={(event) => {
              if (!seekingRef.current) return
              stopEventPropagation(event)
              seekAt(event.clientX)
            }}
            onPointerUp={(event) => {
              stopEventPropagation(event)
              seekingRef.current = false
              if (event.currentTarget.hasPointerCapture(event.pointerId))
                event.currentTarget.releasePointerCapture(event.pointerId)
            }}
            onPointerCancel={() => {
              seekingRef.current = false
            }}
            onKeyDown={handleWaveformKeyDown}
          >
            <div className="audio-waveform-bars" aria-hidden="true">
              {(waveform.length > 0 ? waveform : fallbackWaveform).map((peak, index) => (
                <span
                  key={index}
                  className={index / AUDIO_WAVEFORM_SAMPLES <= progress ? 'is-played' : ''}
                  style={{ height: `${Math.max(12, peak * 100)}%` }}
                />
              ))}
            </div>
            <span className="audio-waveform-playhead" style={{ left: progressPercent }}>
              <span className="audio-waveform-playhead-cap" />
              <span className="audio-waveform-playhead-tail" />
            </span>
          </div>

          <div
            className="audio-playback-progress"
            aria-hidden="true"
            style={{ ['--audio-progress' as string]: progressPercent }}
          >
            <span />
          </div>

          <div className="audio-playback-controls">
            <button
              type="button"
              className="audio-playback-toggle"
              title={playing ? '暂停' : '播放'}
              aria-label={playing ? '暂停音频' : '播放音频'}
              onPointerDown={(event) => stopEventPropagation(event)}
              onClick={(event) => {
                event.stopPropagation()
                togglePlayback()
              }}
              onKeyDown={(event) => event.stopPropagation()}
            >
              <Icon name={playing ? 'pause' : 'play'} size={16} />
            </button>
            <div className="audio-volume-control">
              <button
                type="button"
                className="audio-mute-toggle"
                title={muted || volume === 0 ? '取消静音' : '静音'}
                aria-label={muted || volume === 0 ? '取消静音' : '静音'}
                onPointerDown={(event) => stopEventPropagation(event)}
                onClick={(event) => {
                  event.stopPropagation()
                  if (muted || volume === 0) {
                    setMuted(false)
                    if (volume === 0) setVolume(0.75)
                  } else {
                    setMuted(true)
                  }
                }}
                onKeyDown={(event) => event.stopPropagation()}
              >
                <Icon name={muted || volume === 0 ? 'volume-off' : 'volume'} size={15} />
              </button>
              <input
                className="audio-volume-slider"
                type="range"
                min={0}
                max={1}
                step={0.01}
                value={muted ? 0 : volume}
                aria-label="音量"
                style={{ ['--audio-volume' as string]: `${(muted ? 0 : volume) * 100}%` }}
                onPointerDown={(event) => stopEventPropagation(event)}
                onClick={(event) => event.stopPropagation()}
                onKeyDown={(event) => event.stopPropagation()}
                onChange={(event) => {
                  setVolume(Number(event.currentTarget.value))
                  setMuted(false)
                }}
              />
            </div>
          </div>
        </div>

        <div className="audio-asset-footer">
          <button
            type="button"
            className="audio-replace-button"
            title="替换音频文件"
            onPointerDown={(event) => stopEventPropagation(event)}
            onClick={(event) => {
              event.stopPropagation()
              void uploadAudio()
            }}
          >
            替换音频
          </button>
          <MediaFileActions shape={shape} />
        </div>
        <MediaResultGrid
          shape={shape}
          kind="audio"
          onSelect={chooseResult}
          onDelete={(item) => {
            const nodeResult = removeMediaResultFromShape(shape, item)
            if (!nodeResult) return
            editor.updateShape({
              id: shape.id,
              type: 'node-card',
              meta: { ...(shape.meta ?? {}), nodeResult }
            })
            markUndoPoint(editor, 'audio-delete-result')
          }}
          onClear={() => {
            const nodeResult = clearSelectedMediaHistory(shape)
            if (!nodeResult) return
            editor.updateShape({
              id: shape.id,
              type: 'node-card',
              meta: { ...(shape.meta ?? {}), nodeResult }
            })
            markUndoPoint(editor, 'audio-clear-result-history')
          }}
          openPreview={(item) =>
            openPreview({ kind: 'audio', url: mediaUrl(item.mediaPath), title: shape.props.title })
          }
        />
      </div>
    )
  }

  // 音频资产节点只有「导入」一种职责；配音与语音克隆各自有独立节点。
  return (
    <div className="node-audio-empty audio-empty-state">
      <button
        type="button"
        className="audio-empty-trigger"
        title="选择本地音频文件"
        onPointerDown={(e) => stopEventPropagation(e)}
        onClick={(e) => {
          e.stopPropagation()
          void uploadAudio()
        }}
      >
        <span className="audio-empty-icon-wrap" aria-hidden="true">
          <span className="audio-empty-icon-glow" />
          <span className="audio-empty-icon">
            <Icon name="audio" size={34} />
          </span>
        </span>
        <span className="audio-empty-copy">
          <span className="audio-empty-title">音频载入</span>
          <span className="audio-empty-hint">支持 mp3 / wav / aac / flac 等</span>
        </span>
        <span className="audio-empty-select">
          <Icon name="add" size={14} />
          <span>选择音频文件</span>
        </span>
      </button>
    </div>
  )
}
