// 轨道线全屏编辑器（2026-11-03）：CapCut / 剪映 形态的「素材库 + 预览 + 时间轴」三段式。
//
// 视觉规范来自 Stitch「Calibrated Studio Workspace」：画布 #0E1116 / 面板 #191D24 /
// 描边 rgb(255 255 255 / 7%) / 强调 #239AD3 / 8px 网格 / 面板 12px、片段 4px 圆角。
//
// 交互要点（2026-11-03 用户裁决）：
// - 素材库支持多选（Ctrl/⌘+点击、Shift+点击范围），**先选中的排前面**，按顺序落轨；
// - 素材长按（或直接拖）到轨道上可按落点插入；长按 220ms 起拖，带浮层预览；
// - 预览支持播放/暂停、比例切换、音量、全屏播放；导出成片走节点运行链路。
import { useEffect, useMemo, useRef, useState } from 'react'
import { stopEventPropagation } from 'tldraw'
import type { MediaAsset } from '@shared/types'
import {
  clipsOfTrack,
  formatTimecode,
  timelineDurationMs,
  type TimelineClip,
  type TimelineData
} from '@shared/timeline'
import { Icon } from '../../../components/Icon'
import { useMediaStore } from '../../../stores/media'
import { mediaUrl } from '../../registry'
import { clipCovers, type TimelineEditorAsset } from './timeline-editor-shared'

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

/** 长按起拖的判定时间（毫秒）。 */
const LONG_PRESS_MS = 220

function assetOfMedia(media: MediaAsset): TimelineEditorAsset | null {
  if (media.kind !== 'image' && media.kind !== 'video' && media.kind !== 'audio') return null
  return {
    mediaId: media.id,
    mediaPath: media.path,
    name: media.name ?? media.path.split(/[\\/]/).pop() ?? '素材',
    kind: media.kind,
    durationMs:
      typeof media.durationSec === 'number' && media.durationSec > 0
        ? Math.round(media.durationSec * 1000)
        : undefined
  }
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

function sourceTimeAt(clip: TimelineClip, playheadMs: number): number {
  return Math.max(0, playheadMs - clip.startMs + clip.inMs)
}

export interface TimelineEditorStageProps {
  projectId: string
  data: TimelineData
  resolution: string
  playheadMs: number
  onSeek: (ms: number) => void
  /** 多选素材按顺序落轨：assets 顺序即用户选择顺序；startMs 提供时依次紧挨着摆放。 */
  onAddAssets: (assets: TimelineEditorAsset[], trackId?: string, startMs?: number) => void
  onImportFiles: () => void
  onExport: () => void
  onClose: () => void
  exporting: boolean
}

export function TimelineEditorStage({
  projectId,
  data,
  resolution,
  playheadMs,
  onSeek,
  onAddAssets,
  onImportFiles,
  onExport,
  onClose,
  exporting
}: TimelineEditorStageProps): React.JSX.Element {
  const assets = useMediaStore((state) => state.assets)
  const loaded = useMediaStore((state) => state.loaded)
  const load = useMediaStore((state) => state.load)
  const [filter, setFilter] = useState<'all' | TimelineEditorAsset['kind']>('all')
  const [selectedIds, setSelectedIds] = useState<string[]>([])
  const lastClickedRef = useRef<string | null>(null)
  const [playing, setPlaying] = useState(false)
  const [aspect, setAspect] = useState('16:9')
  const [volume, setVolume] = useState(80)
  const [layout, setLayout] = useState<'left' | 'right' | 'hidden'>('left')
  const [ghost, setGhost] = useState<{ x: number; y: number; asset: TimelineEditorAsset } | null>(
    null
  )
  const videoRef = useRef<HTMLVideoElement | null>(null)
  const stageRef = useRef<HTMLDivElement | null>(null)
  const longPressTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const ghostRef = useRef<{ x: number; y: number; assets: TimelineEditorAsset[] } | null>(null)
  const playStartedAtRef = useRef(0)
  const playBaseRef = useRef(0)

  useEffect(() => {
    if (!loaded) void load(projectId)
  }, [loaded, load, projectId])

  const importedAssets = useMemo(
    () => assets.map(assetOfMedia).filter((asset): asset is TimelineEditorAsset => asset !== null),
    [assets]
  )
  const visible = filter === 'all' ? importedAssets : importedAssets.filter((a) => a.kind === filter)
  const selectedAssets = useMemo(
    () =>
      selectedIds
        .map((id) => importedAssets.find((asset) => asset.mediaId === id))
        .filter((asset): asset is TimelineEditorAsset => Boolean(asset)),
    [selectedIds, importedAssets]
  )
  const totalMs = timelineDurationMs(data)
  const clip = visualClipAtPlayhead(data, playheadMs)
  const previewUrl = clip?.mediaPath ? mediaUrl(clip.mediaPath) : null
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
  }, [volume, previewUrl])

  const seekBy = (deltaMs: number): void => {
    onSeek(Math.min(totalMs, Math.max(0, playheadMs + deltaMs)))
  }

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
    const element = document.elementFromPoint(x, y)?.closest<HTMLElement>('[data-timeline-lane]')
    if (!element) return null
    const trackId = element.dataset.timelineLane ?? ''
    const pps = Number(element.dataset.timelinePps ?? '0')
    if (!trackId || !pps) return null
    const rect = element.getBoundingClientRect()
    return { trackId, startMs: Math.max(0, Math.round(((x - rect.left) / pps) * 1000)) }
  }

  const beginLongPressDrag = (event: React.PointerEvent, asset: TimelineEditorAsset): void => {
    if (event.button !== 0) return
    const assetsToDrop = assetsToDrag(asset)
    const origin = { x: event.clientX, y: event.clientY }
    ghostRef.current = { ...origin, assets: assetsToDrop }
    longPressTimerRef.current = setTimeout(() => {
      setGhost({ ...origin, asset })
      document.body.classList.add('tl-asset-dragging')
    }, LONG_PRESS_MS)
    const onMove = (moveEvent: PointerEvent): void => {
      const moved =
        Math.abs(moveEvent.clientX - origin.x) + Math.abs(moveEvent.clientY - origin.y) > 6
      if (!ghostRef.current) return
      ghostRef.current = { ...ghostRef.current, x: moveEvent.clientX, y: moveEvent.clientY }
      const started = document.body.classList.contains('tl-asset-dragging')
      if (longPressTimerRef.current) {
        // 未到长按时长就移动：视为滚动/点选，取消起拖。
        if (moved && !started) {
          clearTimeout(longPressTimerRef.current)
          longPressTimerRef.current = null
          ghostRef.current = null
          cleanup()
          return
        }
      }
      setGhost((prev) => (prev ? { ...prev, x: moveEvent.clientX, y: moveEvent.clientY } : prev))
    }
    const onUp = (upEvent: PointerEvent): void => {
      if (longPressTimerRef.current) {
        clearTimeout(longPressTimerRef.current)
        longPressTimerRef.current = null
      }
      const dropping = ghostRef.current && document.body.classList.contains('tl-asset-dragging')
      if (dropping) {
        const target = laneFromPoint(upEvent.clientX, upEvent.clientY)
        if (target) onAddAssets(ghostRef.current!.assets, target.trackId, target.startMs)
      }
      ghostRef.current = null
      setGhost(null)
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
          <label className="tl-editor-aspect" title="预览比例（只影响预览，不影响成片）">
            <Icon name="rectangle" size={13} />
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
            <button
              type="button"
              className="tl-bin-import"
              data-node-pointer="control"
              onPointerDown={(event) => stopEventPropagation(event)}
              onClick={onImportFiles}
            >
              <Icon name="add" size={12} />
              导入
            </button>
          </div>
          <div className="tl-bin-grid">
            {visible.length === 0 ? (
              <p className="tl-bin-empty">将文件拖至此处添加</p>
            ) : (
              visible.map((asset) => {
                const order = orderOf(asset.mediaId)
                return (
                  <button
                    key={`${asset.mediaId}-${asset.mediaPath}`}
                    type="button"
                    className={`tl-asset is-${asset.kind}${order >= 0 ? ' is-selected' : ''}`}
                    data-media-id={asset.mediaId}
                    data-node-pointer="control"
                    title={`${asset.name} · ${KIND_LABEL[asset.kind]}（点击追加；Ctrl/⌘ 多选，长按拖到轨道）`}
                    onPointerDown={(event) => {
                      stopEventPropagation(event)
                      beginLongPressDrag(event, asset)
                    }}
                    onClick={(event) => {
                      event.stopPropagation()
                      toggleSelect(event, asset.mediaId)
                    }}
                    onDoubleClick={(event) => {
                      event.stopPropagation()
                      onAddAssets([asset])
                    }}
                  >
                    {order >= 0 ? <span className="tl-asset-order">{order + 1}</span> : null}
                    <span className="tl-asset-thumb">
                      {asset.kind === 'image' ? (
                        <img src={mediaUrl(asset.mediaPath)} alt="" draggable={false} />
                      ) : (
                        <Icon name={asset.kind === 'video' ? 'video' : 'audio'} size={18} />
                      )}
                      <span className="tl-asset-kind">{KIND_LABEL[asset.kind]}</span>
                      {typeof asset.durationMs === 'number' ? (
                        <span className="tl-asset-duration">{formatTimecode(asset.durationMs)}</span>
                      ) : null}
                    </span>
                    <span className="tl-asset-name">{asset.name}</span>
                  </button>
                )
              })
            )}
          </div>
          <div className="tl-bin-footer">
            <span className="tl-bin-hint">
              点击多选（按选择顺序排列）；长按拖到轨道可指定位置
            </span>
            <button
              type="button"
              className="tl-bin-append"
              data-node-pointer="control"
              disabled={selectedAssets.length === 0}
              onClick={() => {
                onAddAssets(selectedAssets.length > 0 ? selectedAssets : [])
                setSelectedIds([])
              }}
            >
              加入轨道{selectedAssets.length > 0 ? `（${selectedAssets.length}）` : ''}
            </button>
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
              ) : (
                <p className="tl-preview-empty">没有媒体可供预览</p>
              )}
            </div>
            <span className="tl-preview-badge">{resolution}</span>
            <button
              type="button"
              className="tl-preview-fullscreen"
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
                {formatTimecode(playheadMs)}
                <i>/</i>
                {formatTimecode(totalMs)}
              </span>
              <span className="tl-transport-divider" />
              <button
                type="button"
                className="tl-transport-btn"
                data-node-pointer="control"
                title="后退 1 秒"
                aria-label="后退 1 秒"
                onClick={() => seekBy(-1000)}
              >
                <Icon name="undo" size={13} />
              </button>
              <button
                type="button"
                className="tl-transport-btn"
                data-node-pointer="control"
                title="前进 1 秒"
                aria-label="前进 1 秒"
                onClick={() => seekBy(1000)}
              >
                <Icon name="redo" size={13} />
              </button>
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
            </div>
          </div>
        </section>
      </div>

      {ghost ? (
        <div
          className="tl-asset-ghost"
          style={{ left: ghost.x + 14, top: ghost.y + 12 }}
          aria-hidden="true"
        >
          <Icon
            name={ghost.asset.kind === 'video' ? 'video' : ghost.asset.kind === 'audio' ? 'audio' : 'image'}
            size={14}
          />
          {ghost.asset.name}
        </div>
      ) : null}
    </div>
  )
}
