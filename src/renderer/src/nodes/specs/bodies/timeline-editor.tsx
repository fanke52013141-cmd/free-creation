// 轨道线全屏编辑器（2026-11-03）：CapCut / 剪映 形态的「素材库 + 预览 + 时间轴」三段式。
//
// 视觉规范来自 Stitch「Calibrated Studio Workspace」：画布 #0E1116 / 面板 #191D24 /
// 描边 rgb(255 255 255 / 7%) / 强调 #239AD3 / 8px 网格 / 面板 12px、片段 4px 圆角。
//
// 交互要点（2026-11-03 用户裁决，同日二次裁决统一为拖拽落轨）：
// - 素材库支持多选（Ctrl/⌘+点击、Shift+点击范围），**先选中的排前面**；
// - 单击只选中，**不直接落轨**：按住直接拖到目标轨道，按落点插入，带浮层预览；
// - 已移除「加入轨道」按钮与双击追加，引用素材条使用同一套手势；
// - 预览支持播放/暂停、比例切换、音量、全屏播放；导出成片走节点运行链路。
import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { stopEventPropagation } from 'tldraw'

import {
  clipsOfTrack,
  formatTimecode,
  timelineDurationMs,
  type TimelineClip,
  type TimelineData
} from '@shared/timeline'
import { Icon } from '../../../components/Icon'
import { mediaUrl } from '../../registry'
import { toast } from '../../../stores/toast'
import { clipCovers, type TimelineEditorAsset } from './timeline-editor-shared'
import { VideoThumb } from './media-thumbnail'

const KIND_LABEL: Record<TimelineEditorAsset['kind'], string> = {
  video: '视频',
  image: '图片',
  audio: '音频'
}

const FILTERS: ReadonlyArray<{ id: 'all' | TimelineEditorAsset['kind']; label: string }> = [
  { id: 'all', label: '全部' },
  { id: 'image', label: '图片' },
  { id: 'video', label: '视频' },
  { id: 'audio', label: '音频' }
]

const ASPECTS: ReadonlyArray<{ id: string; label: string; ratio: string }> = [
  { id: '16:9', label: '16:9', ratio: '16 / 9' },
  { id: '9:16', label: '9:16', ratio: '9 / 16' },
  { id: '1:1', label: '1:1', ratio: '1 / 1' },
  { id: '4:3', label: '4:3', ratio: '4 / 3' }
]

/** 播放条时间码：HH:MM:SS（与剪映一致）。 */
function formatClock(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000))
  const hours = Math.floor(total / 3600)
  const minutes = Math.floor((total % 3600) / 60)
  const seconds = total % 60
  return [hours, minutes, seconds].map((value) => String(value).padStart(2, '0')).join(':')
}

/** 播放头位置上最上层的画面片段（音频不参与预览画面）。 */
function visualClipAtPlayhead(data: TimelineData, playheadMs: number): TimelineClip | null {
  for (let index = data.tracks.length - 1; index >= 0; index -= 1) {
    const track = data.tracks[index]
    if (!track.visible) continue
    const clips = clipsOfTrack(data, track.id).filter(
      (clip) => clip.kind !== 'audio' && clipCovers(clip, playheadMs)
    )
    if (clips.length > 0) return clips[clips.length - 1]
  }
  return null
}

/** 播放头位置上的音频片段（跳过静音/隐藏轨道）：用于全屏预览的音频播放。 */
export function audioClipAtPlayhead(data: TimelineData, playheadMs: number): TimelineClip | null {
  for (let index = data.tracks.length - 1; index >= 0; index -= 1) {
    const track = data.tracks[index]
    if (!track.visible || track.muted) continue
    const clips = clipsOfTrack(data, track.id).filter(
      (clip) => clip.kind === 'audio' && clipCovers(clip, playheadMs)
    )
    if (clips.length > 0) return clips[clips.length - 1]
  }
  return null
}

function sourceTimeAt(clip: TimelineClip, playheadMs: number): number {
  return Math.max(0, playheadMs - clip.startMs + clip.inMs)
}

export interface TimelineEditorStageProps {
  projectId: string
  data: TimelineData
  resolution: string
  playheadMs: number
  onSeek: (ms: number) => void
  /** 左侧面板内容：与轨道线连接的引用素材（连线 + 本地/画布导入）。 */
  references: TimelineEditorAsset[]
  mediaTitles: Record<string, string>
  /** 多选素材按顺序落轨：assets 顺序即用户选择顺序；startMs 提供时依次紧挨着摆放。 */
  onAddAssets: (assets: TimelineEditorAsset[], trackId?: string, startMs?: number) => void
  onImportLocal: () => void
  onImportCanvas: () => void
  onExport: () => void
  onClose: () => void
  exporting: boolean
}

export function TimelineEditorStage({
  data,
  resolution,
  playheadMs,
  onSeek,
  references,
  mediaTitles,
  onAddAssets,
  onImportLocal,
  onImportCanvas,
  onExport,
  onClose,
  exporting
}: TimelineEditorStageProps): React.JSX.Element {
  const [filter, setFilter] = useState<'all' | TimelineEditorAsset['kind']>('all')
  const [selectedIds, setSelectedIds] = useState<string[]>([])
  const lastClickedRef = useRef<string | null>(null)
  const [playing, setPlaying] = useState(false)
  const [aspect, setAspect] = useState('16:9')
  const [volume, setVolume] = useState(80)
  const [layout, setLayout] = useState<'left' | 'right' | 'hidden'>('left')
  const [importMenuOpen, setImportMenuOpen] = useState(false)
  const [draggingIds, setDraggingIds] = useState<string[]>([])
  const [ghost, setGhost] = useState<{
    x: number
    y: number
    asset: TimelineEditorAsset
    count: number
  } | null>(null)
  const videoRef = useRef<HTMLVideoElement | null>(null)
  const audioRef = useRef<HTMLAudioElement | null>(null)
  const stageRef = useRef<HTMLDivElement | null>(null)
  const ghostRef = useRef<{ x: number; y: number; assets: TimelineEditorAsset[] } | null>(null)
  const playStartedAtRef = useRef(0)
  const playBaseRef = useRef(0)

  const importedAssets = references
  const visible = filter === 'all' ? importedAssets : importedAssets.filter((a) => a.kind === filter)
  const totalMs = timelineDurationMs(data)
  const clip = visualClipAtPlayhead(data, playheadMs)
  const previewUrl = clip?.mediaPath ? mediaUrl(clip.mediaPath) : null
  const audioClip = audioClipAtPlayhead(data, playheadMs)
  const audioUrl = audioClip?.mediaPath ? mediaUrl(audioClip.mediaPath) : null
  const aspectRatio = ASPECTS.find((item) => item.id === aspect)?.ratio ?? '16 / 9'

  // 播放推进：以墙钟时间为准，视频只做低频纠偏（避免每帧 seek 造成卡顿）。
  useEffect(() => {
    if (!playing) return
    playStartedAtRef.current = performance.now()
    playBaseRef.current = playheadMs
    let frame = 0
    const tick = (): void => {
      const elapsed = performance.now() - playStartedAtRef.current
      const next = playBaseRef.current + elapsed
      if (next >= totalMs) {
        onSeek(totalMs)
        setPlaying(false)
        return
      }
      onSeek(next)
      frame = requestAnimationFrame(tick)
    }
    frame = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(frame)
    // playheadMs 只在开始播放时作为基准，否则每次 seek 都会重置计时。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playing, totalMs])

  useEffect(() => {
    const video = videoRef.current
    if (!video || !clip || clip.kind !== 'video') return
    const target = sourceTimeAt(clip, playheadMs) / 1000
    if (Math.abs(video.currentTime - target) > 0.35) {
      try {
        video.currentTime = target
      } catch {
        // 元数据未就绪时忽略，下一帧再同步。
      }
    }
    if (playing) void video.play().catch(() => undefined)
    else video.pause()
  }, [clip, playheadMs, playing])

  useEffect(() => {
    if (videoRef.current) videoRef.current.volume = volume / 100
    if (audioRef.current) audioRef.current.volume = volume / 100
  }, [volume, previewUrl, audioUrl])

  // 音频轨在全屏预览里也要出声：跟随播放头 seek，播放/暂停与视频一致。
  useEffect(() => {
    const audio = audioRef.current
    if (!audio || !audioClip) return
    const target = sourceTimeAt(audioClip, playheadMs) / 1000
    if (Math.abs(audio.currentTime - target) > 0.35) {
      try {
        audio.currentTime = target
      } catch {
        // 元数据未就绪时忽略，下一次播放头变化再同步。
      }
    }
    if (playing) void audio.play().catch(() => undefined)
    else audio.pause()
  }, [audioClip, playheadMs, playing])

  // ── 多选（保持点击顺序）与长按拖动 ────────────────────────────────
  const orderOf = (id: string): number => selectedIds.indexOf(id)
  const toggleSelect = (event: React.MouseEvent, id: string): void => {
    if (event.shiftKey && lastClickedRef.current) {
      const pool = visible.map((asset) => asset.mediaId)
      const from = pool.indexOf(lastClickedRef.current)
      const to = pool.indexOf(id)
      if (from >= 0 && to >= 0) {
        const range = pool.slice(Math.min(from, to), Math.max(from, to) + 1)
        setSelectedIds((prev) => {
          const next = [...prev]
          for (const item of range) if (!next.includes(item)) next.push(item)
          return next
        })
        return
      }
    }
    if (event.ctrlKey || event.metaKey) {
      setSelectedIds((prev) =>
        prev.includes(id) ? prev.filter((item) => item !== id) : [...prev, id]
      )
      lastClickedRef.current = id
      return
    }
    setSelectedIds([id])
    lastClickedRef.current = id
  }

  const assetsToDrag = (asset: TimelineEditorAsset): TimelineEditorAsset[] => {
    const picked = selectedIds
      .map((id) => importedAssets.find((item) => item.mediaId === id))
      .filter((item): item is TimelineEditorAsset => Boolean(item))
    if (picked.some((item) => item.mediaId === asset.mediaId)) return picked
    return [asset]
  }

  const laneFromPoint = (
    x: number,
    y: number
  ): { trackId: string; startMs: number } | null => {
    const scope = document.querySelector<HTMLElement>('.tl-modal')
    const lanes = Array.from(
      (scope ?? document).querySelectorAll<HTMLElement>('[data-timeline-lane]')
    )
    let element = document.elementFromPoint(x, y)?.closest<HTMLElement>('[data-timeline-lane]')
    if (element && scope && !scope.contains(element)) element = null
    // 兜底：落点偏到刻度尺/行间隙时取纵向最近的一条轨道，避免「拖到空白处没反应」。
    if (!element && lanes.length > 0) {
      element = lanes.reduce((best, lane) => {
        const rect = lane.getBoundingClientRect()
        const distance = y < rect.top ? rect.top - y : y > rect.bottom ? y - rect.bottom : 0
        const bestRect = best.getBoundingClientRect()
        const bestDistance =
          y < bestRect.top ? bestRect.top - y : y > bestRect.bottom ? y - bestRect.bottom : 0
        return distance < bestDistance ? lane : best
      })
    }
    if (!element) return null
    const trackId = element.dataset.timelineLane ?? ''
    const pps = Number(element.dataset.timelinePps ?? '0')
    if (!trackId || !pps) return null
    const rect = element.getBoundingClientRect()
    const clampedX = Math.min(Math.max(x, rect.left), Math.max(rect.left, rect.right - 1))
    return { trackId, startMs: Math.max(0, Math.round(((clampedX - rect.left) / pps) * 1000)) }
  }

  // 2026-11-03 用户裁决：不再长按等待——按下后直接拖动即可，单击（位移 ≤4px）仍是选中。
  const beginAssetDrag = (event: React.PointerEvent, asset: TimelineEditorAsset): void => {
    if (event.button !== 0) return
    const assetsToDrop = assetsToDrag(asset)
    const origin = { x: event.clientX, y: event.clientY }
    ghostRef.current = { ...origin, assets: assetsToDrop }
    const onMove = (moveEvent: PointerEvent): void => {
      if (!ghostRef.current) return
      const moved =
        Math.abs(moveEvent.clientX - origin.x) + Math.abs(moveEvent.clientY - origin.y) > 4
      const started = document.body.classList.contains('tl-asset-dragging')
      if (!started) {
        if (!moved) return
        if (!selectedIds.includes(asset.mediaId)) {
          setSelectedIds(assetsToDrop.map((item) => item.mediaId))
        }
        setGhost({ x: moveEvent.clientX, y: moveEvent.clientY, asset, count: assetsToDrop.length })
        setDraggingIds(assetsToDrop.map((item) => item.mediaId))
        document.body.classList.add('tl-asset-dragging')
      }
      setGhost((prev) => (prev ? { ...prev, x: moveEvent.clientX, y: moveEvent.clientY } : prev))
    }
    const onUp = (upEvent: PointerEvent): void => {
      const dropping = ghostRef.current && document.body.classList.contains('tl-asset-dragging')
      if (dropping) {
        const target = laneFromPoint(upEvent.clientX, upEvent.clientY)
        if (target) {
          onAddAssets(ghostRef.current!.assets, target.trackId, target.startMs)
          setSelectedIds([])
        } else {
          toast('没放到轨道上：请把素材拖到下方时间轴的空白处')
        }
      }
      ghostRef.current = null
      setGhost(null)
      setDraggingIds([])
      document.body.classList.remove('tl-asset-dragging')
      cleanup()
    }
    const cleanup = (): void => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      window.removeEventListener('pointercancel', onUp)
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    window.addEventListener('pointercancel', onUp)
  }

  return (
    <div className={`tl-editor is-aspect-${aspect.replace(':', '-')}`}>
      <header className="tl-editor-head">
        <span className="tl-editor-brand">
          <span className="tl-editor-glyph">
            <Icon name="timeline" size={16} />
          </span>
          <strong>轨道线</strong>
          <span className="tl-editor-meta">
            {data.tracks.length} 条轨道 · {data.clips.length} 个片段 · {formatTimecode(totalMs)}
          </span>
        </span>
        <span className="tl-editor-actions">
          <button
            type="button"
            className="tl-editor-layout"
            data-node-pointer="control"
            data-layout={layout}
            title="切换布局：素材库在左 / 在右 / 收起"
            aria-label="切换布局"
            onClick={() =>
              setLayout((value) => (value === 'left' ? 'right' : value === 'right' ? 'hidden' : 'left'))
            }
          >
            <Icon name="layers" size={13} />
            {layout === 'left' ? '素材在左' : layout === 'right' ? '素材在右' : '素材收起'}
          </button>
          <button
            type="button"
            className="tl-editor-export"
            data-node-pointer="control"
            disabled={exporting || data.clips.length === 0}
            onClick={onExport}
          >
            <Icon name="download" size={14} />
            {exporting ? '合成中…' : '导出成片'}
          </button>
          <button
            type="button"
            className="tl-editor-close"
            data-node-pointer="control"
            aria-label="关闭轨道线编辑"
            title="关闭（Esc）"
            onClick={onClose}
          >
            <Icon name="close" size={15} />
          </button>
        </span>
      </header>

      <div
        className={`tl-editor-main is-bin-${layout}`}
      >
        <aside className="tl-bin" aria-label="素材库" data-selected-ids={selectedIds.join(',')}>
          <div className="tl-bin-filters">
            <div className="tl-bin-filter-group" role="tablist" aria-label="素材类型">
              {FILTERS.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  role="tab"
                  aria-selected={filter === item.id}
                  className={filter === item.id ? 'active' : ''}
                  data-node-pointer="control"
                  onClick={() => setFilter(item.id)}
                >
                  {item.label}
                </button>
              ))}
            </div>
            <div className="tl-bin-import-wrap">
              <button
                type="button"
                className="tl-bin-import"
                data-node-pointer="control"
                aria-expanded={importMenuOpen}
                onPointerDown={(event) => stopEventPropagation(event)}
                onClick={() => setImportMenuOpen((open) => !open)}
              >
                <Icon name="add" size={12} />
                导入
              </button>
              {importMenuOpen ? (
                <div className="tl-import-menu" role="menu" data-node-pointer="control">
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => {
                      setImportMenuOpen(false)
                      onImportLocal()
                    }}
                  >
                    从本地导入
                  </button>
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => {
                      setImportMenuOpen(false)
                      onImportCanvas()
                    }}
                  >
                    从画布导入
                  </button>
                </div>
              ) : null}
            </div>
          </div>
          <div className="tl-bin-grid">
            {visible.length === 0 ? (
              <p className="tl-bin-empty">
                还没有引用素材：先点「导入」添加，再直接拖到轨道
              </p>
            ) : (
              visible.map((asset) => {
                const order = orderOf(asset.mediaId)
                return (
                  <button
                    key={`${asset.mediaId}-${asset.mediaPath}`}
                    type="button"
                    className={`tl-asset is-${asset.kind}${order >= 0 ? ' is-selected' : ''}${draggingIds.includes(asset.mediaId) ? ' is-dragging' : ''}`}
                    data-media-id={asset.mediaId}
                    data-node-pointer="control"
                    onPointerDown={(event) => {
                      stopEventPropagation(event)
                      beginAssetDrag(event, asset)
                    }}
                    onClick={(event) => {
                      event.stopPropagation()
                      toggleSelect(event, asset.mediaId)
                    }}
                  >
                    {order >= 0 ? <span className="tl-asset-order">{order + 1}</span> : null}
                    <span className="tl-asset-thumb">
                      {asset.kind === 'image' ? (
                        <img src={mediaUrl(asset.mediaPath)} alt="" draggable={false} />
                      ) : asset.kind === 'video' ? (
                        <VideoThumb path={asset.mediaPath} />
                      ) : (
                        <Icon name="audio" size={18} />
                      )}
                      <span className="tl-asset-kind">{KIND_LABEL[asset.kind]}</span>
                      {typeof asset.durationMs === 'number' ? (
                        <span className="tl-asset-duration">{formatTimecode(asset.durationMs)}</span>
                      ) : null}
                    </span>
                    <span className="tl-asset-name">{mediaTitles[asset.mediaId] ?? asset.name}</span>
                  </button>
                )
              })
            )}
          </div>
        </aside>

        <section className="tl-preview" aria-label="成片预览">
          <div className="tl-preview-stage">
            <div className="tl-preview-frame" style={{ aspectRatio }} ref={stageRef}>
              {previewUrl && clip ? (
                clip.kind === 'image' ? (
                  <img
                    className="tl-preview-media"
                    src={previewUrl}
                    alt="预览画面"
                    draggable={false}
                  />
                ) : (
                  <video
                    ref={videoRef}
                    className="tl-preview-media"
                    src={previewUrl}
                    playsInline
                    preload="auto"
                  />
                )
              ) : audioClip && audioUrl ? (
                <div className="tl-preview-audio" aria-label="音频预览">
                  <span className="tl-preview-audio-icon">
                    <Icon name="audio" size={30} />
                  </span>
                  <span className="tl-preview-audio-name">{audioClip.name}</span>
                  <span className="tl-preview-audio-hint">音频轨 · 播放时出声</span>
                </div>
              ) : (
                <p className="tl-preview-empty">没有媒体可供预览</p>
              )}
              <audio ref={audioRef} src={audioUrl ?? undefined} preload="auto" hidden />
            </div>
            <span className="tl-preview-badge">{resolution}</span>
          </div>
          {/* 播放条独立占位在视频下方（2026-11-03 用户裁决：不要浮在画面上挡住视频） */}
          <div className="tl-transport">
              <button
                type="button"
                className="tl-transport-play"
                data-node-pointer="control"
                title={playing ? '暂停' : '播放'}
                aria-label={playing ? '暂停' : '播放'}
                onClick={() => {
                  if (totalMs === 0) return
                  if (!playing && playheadMs >= totalMs) onSeek(0)
                  setPlaying((value) => !value)
                }}
              >
                <Icon name={playing ? 'pause' : 'play'} size={14} />
              </button>
              <span className="tl-transport-time">
                {formatClock(playheadMs)}
                <i>/</i>
                {formatClock(totalMs)}
              </span>
              <span className="tl-transport-spacer" />
              <label className="tl-transport-ratio" title="预览比例（只影响预览，不影响成片）">
                <Icon name="rectangle" size={12} />
                <select
                  aria-label="预览比例"
                  data-node-pointer="control"
                  value={aspect}
                  onChange={(event) => setAspect(event.target.value)}
                >
                  {ASPECTS.map((item) => (
                    <option key={item.id} value={item.id}>
                      {item.label}
                    </option>
                  ))}
                </select>
              </label>
              <span className="tl-transport-volume">
                <Icon name={volume === 0 ? 'volume-off' : 'volume'} size={13} />
                <input
                  type="range"
                  aria-label="预览音量"
                  data-node-pointer="control"
                  min={0}
                  max={100}
                  step={5}
                  value={volume}
                  onChange={(event) => setVolume(Number(event.target.value))}
                />
              </span>
              <button
                type="button"
                className="tl-transport-btn"
                data-node-pointer="control"
                title="全屏播放预览"
                aria-label="全屏播放预览"
                onClick={() => {
                  const host = stageRef.current
                  if (!host) return
                  if (document.fullscreenElement) void document.exitFullscreen()
                  else void host.requestFullscreen?.().catch(() => undefined)
                }}
              >
                <Icon name="fullscreen" size={13} />
              </button>
          </div>
        </section>
      </div>

      {ghost
        ? createPortal(
            <div
              className="tl-asset-ghost"
              style={{ left: ghost.x, top: ghost.y }}
              aria-hidden="true"
            >
              <span className="tl-asset-ghost-thumb">
                {ghost.asset.kind === 'image' ? (
                  <img src={mediaUrl(ghost.asset.mediaPath)} alt="" draggable={false} />
                ) : ghost.asset.kind === 'video' ? (
                  <VideoThumb path={ghost.asset.mediaPath} />
                ) : (
                  <Icon name="audio" size={16} />
                )}
              </span>
              <span className="tl-asset-ghost-name">{ghost.asset.name}</span>
              {ghost.count > 1 ? (
                <span className="tl-asset-ghost-count">{ghost.count}</span>
              ) : null}
            </div>,
            document.body
          )
        : null}
    </div>
  )
}
