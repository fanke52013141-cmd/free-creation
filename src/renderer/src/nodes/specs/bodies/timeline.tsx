// 时间线节点 Body（M2）
//
// 交互契约（NODE_UI_STANDARD §19）：
// - 刻度尺、片段条、片段裁剪手柄、轨道头按钮是「实际控件」，标 data-node-pointer="control"，
//   指针归它们自己；卡片内其它空白不拦截，仍可单击选中、按住拖动整张卡片。
// - 拖动片段走 window 级 pointermove + 本地预览状态，**拖动过程中不写 tldraw 文档**，
//   松手时一次性提交并 markUndoPoint —— 一次拖动 = 一步撤销，也不会逐帧重排整卡。
// - 删除/分割是离散操作，每次各自形成一步撤销。
import { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useEditor, useValue } from 'tldraw'
import {
  TIMELINE_LIMITS,
  addClip,
  addReferences,
  addTrack,
  clipEndMs,
  clipsOfTrack,
  createEmptyTimeline,
  findClip,
  formatTimecode,
  freeStartMsFor,
  moveClip,
  moveTrack,
  parseTimeline,
  removeClip,
  removeTrack,
  resolveMoveStartMs,
  rulerStepMs,
  snapDropStartMs,
  resolveClipDurationMs,
  serializeTimeline,
  splitClip,
  splitClipKeep,
  timelineDurationMs,
  trimClip,
  type TimelineClip,
  type TimelineClipKind,
  type TimelineData
} from '@shared/timeline'
import { TIMELINE_UI } from '../../../canvas/node-ui-tokens'
import { markUndoPoint } from '../../../canvas/history'
import { readConnectedNodeInputs } from '../../../canvas/graph'
import type { NodeValue } from '@shared/engine/values'
import type { NodeBodyProps } from '../../registry'
import { mediaUrl } from '../../registry'
import { Icon } from '../../../components/Icon'
import { toast } from '../../../stores/toast'
import { useAppStore } from '../../../stores/app'
import { useGatewayStore } from '../../../stores/gateway'
import { runNodeManually } from '../../../engine/executor'
import { VideoThumb } from './media-thumbnail'
import { TimelineEditorStage } from './timeline-editor'
import {
  TIMELINE_ASSET_DRAG_TYPE,
  parseTimelineAssetPayload,
  type TimelineEditorAsset
} from './timeline-editor-shared'
import './timeline.css'

/** 主进程探测接口（M3 接线后可用）；未接线时返回 null，调用方按未知时长处理。 */
interface MediaProbeBridge {
  probeMediaMetadata?: (input: { projectId: string; mediaId: string }) => Promise<{
    ok: boolean
    data?: {
      kind: string
      durationMs: number | null
      width: number | null
      height: number | null
    }
    error?: { message: string }
  }>
}

function probeBridge(): MediaProbeBridge {
  return window.api as unknown as MediaProbeBridge
}

const CLIP_KIND_LABEL: Record<TimelineClipKind, string> = {
  video: '视频',
  image: '图片',
  audio: '音频'
}

const CLIP_KIND_ICON: Record<TimelineClipKind, 'video' | 'image' | 'audio'> = {
  video: 'video',
  image: 'image',
  audio: 'audio'
}

/** 素材种类：优先用库里的 kind，缺失时按 mime 兜底。 */
function assetKind(asset: { kind?: string; mime?: string }): TimelineClipKind | null {
  if (asset.kind === 'image' || asset.kind === 'video' || asset.kind === 'audio') return asset.kind
  const mime = asset.mime ?? ''
  if (mime.startsWith('image/')) return 'image'
  if (mime.startsWith('video/')) return 'video'
  if (mime.startsWith('audio/')) return 'audio'
  return null
}

/** 只有媒体类 NodeValue 能落到轨道；文本/JSON 连线不参与时间线。 */
function mediaValueOf(
  value: NodeValue | null
): { kind: TimelineClipKind; mediaId: string; mediaPath: string; name?: string } | null {
  if (!value) return null
  if (value.kind === 'image' || value.kind === 'video' || value.kind === 'audio') {
    return {
      kind: value.kind,
      mediaId: value.mediaId,
      mediaPath: value.mediaPath,
      ...(value.name ? { name: value.name } : {})
    }
  }
  return null
}

interface DragState {
  clipId: string
  mode: 'move' | 'start' | 'end'
  pointerStartX: number
  original: TimelineClip
  trackId: string
  startMs: number
  durationMs: number
  inMs: number
}

interface SurfaceProps {
  data: TimelineData
  selectedClipId: string | null
  onSelectClip: (clipId: string | null) => void
  playheadMs: number
  onSeek: (ms: number) => void
  pixelsPerSecond: number
  onZoom: (next: number) => void
  onCommit: (next: TimelineData, label: string) => void
  onAddMedia: (trackId: string) => void
  /** 从素材库拖到轨道：由调用方按落点时间插入片段。 */
  onDropAsset?: (asset: TimelineEditorAsset, trackId: string, startMs: number) => void
  onSplit: () => void
  /** 向左分割（保留左边）/ 向右分割（保留右边）。 */
  onSplitKeep: (side: 'left' | 'right') => void
  onDeleteClip: () => void
  /** 撤销 / 重做（走画布历史）。 */
  onUndo: () => void
  onRedo: () => void
  /** 自动吸附：默认开启，拖动/裁剪时贴合相邻片段边缘与播放头。 */
  snapEnabled: boolean
  onToggleSnap: () => void
  /** 媒体 id → 画布节点标题：视频/图片改名后，轨道片段与引用条同步显示新名字。 */
  mediaTitles: Record<string, string>
  onToggleFullscreen?: () => void
  fullscreen?: boolean
}

function TimelineSurface({
  data,
  selectedClipId,
  onSelectClip,
  playheadMs,
  onSeek,
  pixelsPerSecond,
  onZoom,
  onCommit,
  onAddMedia,
  onDropAsset,
  onSplit,
  onSplitKeep,
  onDeleteClip,
  onUndo,
  onRedo,
  snapEnabled,
  onToggleSnap,
  onToggleFullscreen,
  mediaTitles,
  fullscreen = false
}: SurfaceProps): React.JSX.Element {
  const [drag, setDrag] = useState<DragState | null>(null)
  const [trackDrag, setTrackDrag] = useState<{
    trackId: string
    from: number
    to: number
  } | null>(null)
  const dragRef = useRef<DragState | null>(null)
  // 拖动过程中事件处理器必须读到最新值，但渲染期间不能写 ref——
  // 因此统一走 updateDrag：先同步 ref 再触发渲染。
  const updateDrag = (next: DragState | null): void => {
    dragRef.current = next
    setDrag(next)
  }

  const pxPerMs = pixelsPerSecond / 1000
  // 缩放：按钮按倍数微调，Ctrl/⌘+滚轮按 1.12 倍细调，范围见 TIMELINE_UI。
  const ZOOM_BUTTON_FACTOR = 1.3
  const ZOOM_WHEEL_FACTOR = 1.12
  const clampZoom = (value: number): number =>
    Math.min(
      TIMELINE_UI.pixelsPerSecondMax,
      Math.max(TIMELINE_UI.pixelsPerSecondMin, Math.round(value))
    )
  const durationMs = timelineDurationMs(data)
  // 时间轴宽度跟随卡片可用宽度：横向拉宽时逐步显示后面的时间，而不是留一片空白；
  // 只有内容比视口长时才出现横向滚动。
  const [viewportWidth, setViewportWidth] = useState(0)
  const scrollRef = useRef<HTMLDivElement | null>(null)
  useEffect(() => {
    const host = scrollRef.current
    if (!host) return
    const update = (): void => setViewportWidth(host.clientWidth)
    update()
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(update)
    observer.observe(host)
    return () => observer.disconnect()
  }, [])
  const laneViewport = Math.max(240, viewportWidth - TIMELINE_UI.trackHeaderWidth)
  const naturalWidth = Math.round((durationMs + TIMELINE_UI.tailPaddingMs) * pxPerMs)
  const contentWidth = Math.max(320, laneViewport, naturalWidth)
  const visibleMs = contentWidth / pxPerMs
  const stepMs = rulerStepMs(pixelsPerSecond)
  const ticks = useMemo(() => {
    const list: number[] = []
    for (let t = 0; t <= visibleMs; t += stepMs) list.push(t)
    return list
  }, [visibleMs, stepMs])

  const clientXToMs = (clientX: number, lane: HTMLElement): number => {
    const rect = lane.getBoundingClientRect()
    return Math.max(0, (clientX - rect.left) / pxPerMs)
  }
  const laneRef = useRef<HTMLDivElement | null>(null)

  // 自动吸附：把拖动/裁剪的目标时间吸到「同轨相邻片段边缘、时间线起点、播放头」。
  // 阈值按像素算（12px）；拖动整段时起点或末端都会参与吸附，重叠时直接贴到最近边缘。
  const SNAP_PX = 12
  const snapPointsFor = (trackId: string, clipId: string): number[] => {
    const points = [0, playheadMs]
    for (const clip of clipsOfTrack(data, trackId)) {
      if (clip.id === clipId) continue
      points.push(clip.startMs, clip.startMs + clip.durationMs)
    }
    return points
  }
  const snapMs = (value: number, points: number[]): number => {
    const threshold = SNAP_PX / pxPerMs
    let best: number | null = null
    for (const point of points) {
      if (Math.abs(point - value) > threshold) continue
      if (best === null || Math.abs(point - value) < Math.abs(best - value)) best = point
    }
    return best === null ? value : Math.max(0, Math.round(best))
  }

  // 拖动：整个过程只更新本地预览，松手才提交。
  useEffect(() => {
    if (!drag) return
    const onMove = (event: PointerEvent): void => {
      const current = dragRef.current
      if (!current) return
      const deltaMs = (event.clientX - current.pointerStartX) / pxPerMs
      if (current.mode === 'move') {
        const row = document
          .elementFromPoint(event.clientX, event.clientY)
          ?.closest<HTMLElement>('[data-timeline-track]')
        const trackId = row?.dataset.timelineTrack ?? current.trackId
        const rawStart = Math.max(0, Math.round(current.original.startMs + deltaMs))
        const nextStart = resolveMoveStartMs({
          data,
          trackId,
          clipId: current.clipId,
          rawStartMs: rawStart,
          durationMs: current.original.durationMs,
          snapPointsMs: snapPointsFor(trackId, current.clipId),
          thresholdMs: SNAP_PX / pxPerMs,
          snapEnabled
        })
        updateDrag({
          ...current,
          trackId,
          startMs: nextStart
        })
        return
      }
      const rawTarget =
        current.mode === 'start'
          ? current.original.startMs + deltaMs
          : current.original.startMs + current.original.durationMs + deltaMs
      const targetMs = snapEnabled
        ? snapMs(rawTarget, snapPointsFor(current.trackId, current.clipId))
        : rawTarget
      const preview = trimClip(data, current.clipId, current.mode, targetMs)
      if (!preview.ok) return
      const clip = preview.data.clips.find((item) => item.id === current.clipId)
      if (!clip) return
      updateDrag({
        ...current,
        startMs: clip.startMs,
        durationMs: clip.durationMs,
        inMs: clip.inMs
      })
    }
    const onUp = (): void => {
      const current = dragRef.current
      updateDrag(null)
      if (!current) return
      const moved =
        current.startMs !== current.original.startMs ||
        current.trackId !== current.original.trackId
      if (current.mode === 'move') {
        if (!moved) return
        const result = moveClip(data, current.clipId, {
          trackId: current.trackId,
          startMs: current.startMs
        })
        if (!result.ok) {
          toast(result.reason)
          return
        }
        onCommit(result.data, 'timeline-move-clip')
        return
      }
      const trimmed =
        current.durationMs !== current.original.durationMs ||
        current.inMs !== current.original.inMs ||
        current.startMs !== current.original.startMs
      if (!trimmed) return
      const result = trimClip(
        data,
        current.clipId,
        current.mode,
        current.mode === 'start'
          ? current.startMs
          : current.startMs + current.durationMs
      )
      if (!result.ok) {
        toast(result.reason)
        return
      }
      onCommit(result.data, 'timeline-trim-clip')
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    window.addEventListener('pointercancel', onUp)
    return () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      window.removeEventListener('pointercancel', onUp)
    }
    // drag 的引用变化不重建监听：拖动过程只更新 dragRef，避免每帧重挂事件。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [drag?.clipId, drag?.mode, data, pxPerMs, playheadMs, snapEnabled])

  /** 拖动轨道头排序：只换轨道顺序，片段跟着自己的轨道一起移动。 */
  const beginTrackDrag = (
    event: React.PointerEvent,
    trackId: string,
    fromIndex: number
  ): void => {
    if (event.button !== 0) return
    if (event.target instanceof Element && event.target.closest('button')) return
    event.stopPropagation()
    event.preventDefault()
    let to = fromIndex
    setTrackDrag({ trackId, from: fromIndex, to })
    const rows = (): HTMLElement[] =>
      Array.from(document.querySelectorAll<HTMLElement>('.tl-surface .tl-row[data-timeline-track]'))
    const onMove = (moveEvent: PointerEvent): void => {
      const list = rows()
      let next = fromIndex
      for (let index = 0; index < list.length; index += 1) {
        const rect = list[index].getBoundingClientRect()
        if (moveEvent.clientY < rect.top + rect.height / 2) {
          next = index
          break
        }
        next = index
      }
      to = next
      setTrackDrag({ trackId, from: fromIndex, to: next })
    }
    const cleanup = (): void => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      window.removeEventListener('pointercancel', onUp)
    }
    const onUp = (): void => {
      cleanup()
      setTrackDrag(null)
      if (to === fromIndex) return
      const result = moveTrack(data, trackId, to)
      if (!result.ok) {
        toast(result.reason)
        return
      }
      onCommit(result.data, 'timeline-move-track')
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    window.addEventListener('pointercancel', onUp)
  }

  const beginClipDrag = (
    event: React.PointerEvent,
    clip: TimelineClip,
    mode: DragState['mode']
  ): void => {
    event.stopPropagation()
    event.preventDefault()
    onSelectClip(clip.id)
    updateDrag({
      clipId: clip.id,
      mode,
      pointerStartX: event.clientX,
      original: clip,
      trackId: clip.trackId,
      startMs: clip.startMs,
      durationMs: clip.durationMs,
      inMs: clip.inMs
    })
  }

  const beginRulerDrag = (event: React.PointerEvent<HTMLDivElement>): void => {
    event.stopPropagation()
    event.preventDefault()
    const lane = laneRef.current
    if (!lane) return
    onSeek(clientXToMs(event.clientX, lane))
    const onMove = (moveEvent: PointerEvent): void => {
      onSeek(clientXToMs(moveEvent.clientX, lane))
    }
    const onUp = (): void => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
  }

  const playheadLeft = Math.round(playheadMs * pxPerMs)
  const selected = selectedClipId ? findClip(data, selectedClipId) : undefined

  return (
    <div
      className={`tl-surface${fullscreen ? ' is-fullscreen' : ''}`}
      // 节点内真正的控件（按钮/菜单项）必须在冒泡到画布前拦住 pointerdown：
      // 否则 tldraw 会把它当成画布按下（并 preventDefault），按钮的 click 永远不触发。
      // 只拦控件，不拦片段条/刻度尺/空白，避免把「空白拖动整卡」也一起吞掉。
      onPointerDownCapture={(event) => {
        const target = event.target
        if (target instanceof Element && target.closest('button, [role="menuitem"]')) {
          event.stopPropagation()
        }
      }}
      // Ctrl/⌘ + 滚轮：细粒度缩放时间轴（2026-11-03 用户裁决）
      onWheelCapture={(event) => {
        if (!event.ctrlKey && !event.metaKey) return
        event.preventDefault()
        event.stopPropagation()
        const factor = event.deltaY < 0 ? ZOOM_WHEEL_FACTOR : 1 / ZOOM_WHEEL_FACTOR
        onZoom(clampZoom(pixelsPerSecond * factor))
      }}
    >
      <div className="tl-toolbar">
        <button
          type="button"
          className="tl-btn is-icon"
          data-node-pointer="control"
          title="撤销（Ctrl/⌘+Z）"
          onClick={onUndo}
        >
          <Icon name="undo" size={13} />
        </button>
        <button
          type="button"
          className="tl-btn is-icon"
          data-node-pointer="control"
          title="重做（Ctrl/⌘+Shift+Z）"
          onClick={onRedo}
        >
          <Icon name="redo" size={13} />
        </button>
        <button
          type="button"
          className="tl-btn is-icon"
          data-node-pointer="control"
          title="在播放头处分割选中片段（Ctrl/⌘+B）"
          aria-label="分割"
          disabled={!selected}
          onClick={onSplit}
        >
          <Icon name="split" size={13} />
        </button>
        <button
          type="button"
          className="tl-btn is-icon"
          data-node-pointer="control"
          title="向左分割：保留切点左侧，删除右侧"
          aria-label="向左分割"
          disabled={!selected}
          onClick={() => onSplitKeep('left')}
        >
          <Icon name="split-left" size={13} />
        </button>
        <button
          type="button"
          className="tl-btn is-icon"
          data-node-pointer="control"
          title="向右分割：保留切点右侧，删除左侧"
          aria-label="向右分割"
          disabled={!selected}
          onClick={() => onSplitKeep('right')}
        >
          <Icon name="split-right" size={13} />
        </button>
        <button
          type="button"
          className="tl-btn is-icon"
          data-node-pointer="control"
          title="删除选中片段（Delete）"
          aria-label="删除片段"
          disabled={!selected}
          onClick={onDeleteClip}
        >
          <Icon name="trash" size={13} />
        </button>
        <button
          type="button"
          className="tl-btn is-icon"
          data-node-pointer="control"
          data-tl-snap={snapEnabled ? 'on' : 'off'}
          aria-pressed={snapEnabled}
          aria-label={snapEnabled ? '自动吸附：开' : '自动吸附：关'}
          onClick={onToggleSnap}
        >
          <Icon name={snapEnabled ? 'link' : 'link-off'} size={13} />
        </button>
        <button
          type="button"
          className="tl-btn"
          data-node-pointer="control"
          title="再加一条通用轨道"
          onClick={() => {
            const result = addTrack(data)
            if (!result.ok) return toast(result.reason)
            onCommit(result.data, 'timeline-add-track')
          }}
        >
          <Icon name="add" size={13} />
          轨道
        </button>
        <button
          type="button"
          className="tl-btn"
          data-node-pointer="control"
          onClick={() => onAddMedia(selected?.trackId ?? data.tracks[0]?.id ?? '')}
        >
          <Icon name="upload" size={13} />
          添加素材
        </button>
        <span className="tl-toolbar-spacer" />
        <span className="tl-timecode" data-node-pointer="control">
          {formatTimecode(playheadMs)} / {formatTimecode(durationMs)}
        </span>
        {/* 时间轴缩放：连续缩放（Ctrl+滚轮可细调，2026-11-03 用户裁决） */}
        <span className="tl-zoom" data-node-pointer="control">
          <button
            type="button"
            className="tl-zoom-step"
            aria-label="时间轴缩小"
            onClick={() => onZoom(clampZoom(pixelsPerSecond / ZOOM_BUTTON_FACTOR))}
          >
            <Icon name="zoom-out" size={16} />
          </button>
          <input
            type="range"
            aria-label="时间轴缩放"
            min={TIMELINE_UI.pixelsPerSecondMin}
            max={TIMELINE_UI.pixelsPerSecondMax}
            step={1}
            value={Math.round(pixelsPerSecond)}
            onPointerDown={(event) => event.stopPropagation()}
            onChange={(event) => onZoom(clampZoom(Number(event.target.value)))}
          />
          <button
            type="button"
            className="tl-zoom-step"
            aria-label="时间轴放大"
            onClick={() => onZoom(clampZoom(pixelsPerSecond * ZOOM_BUTTON_FACTOR))}
          >
            <Icon name="zoom-in" size={16} />
          </button>
        </span>
        {onToggleFullscreen ? (
          <button
            type="button"
            className="tl-btn"
            data-node-pointer="control"
            data-tl-fullscreen-toggle="true"
            title={fullscreen ? '退出全屏编辑（Esc）' : '全屏编辑'}
            onClick={onToggleFullscreen}
          >
            <Icon name="fullscreen" size={13} />
            {fullscreen ? '退出' : '全屏编辑'}
          </button>
        ) : null}
      </div>

      <div className="tl-scroll" ref={scrollRef}>
        <div className="tl-inner" style={{ width: TIMELINE_UI.trackHeaderWidth + contentWidth }}>
          <div className="tl-ruler-row" style={{ width: TIMELINE_UI.trackHeaderWidth + contentWidth }}>
            <div className="tl-corner" style={{ width: TIMELINE_UI.trackHeaderWidth }}>
              <Icon name="timeline" size={13} />
            </div>
            <div
              className="tl-ruler"
              data-node-pointer="control"
              ref={laneRef}
              style={{ width: contentWidth }}
              onPointerDown={beginRulerDrag}
            >
              {ticks.map((tick) => (
                <div key={tick} className="tl-tick" style={{ left: Math.round(tick * pxPerMs) }}>
                  <span>{formatTimecode(tick)}</span>
                </div>
              ))}
            </div>
          </div>

          {data.tracks.map((track, index) => {
            const clips = clipsOfTrack(data, track.id)
            const dropTarget = trackDrag && trackDrag.trackId !== track.id && trackDrag.to === index
            return (
              <div
                className={`tl-row${dropTarget ? ' is-drop-target' : ''}${
                  trackDrag?.trackId === track.id ? ' is-track-dragging' : ''
                }`}
                key={track.id}
                data-timeline-track={track.id}
                style={{ height: TIMELINE_UI.trackHeight }}
              >
                <div
                  className="tl-row-header"
                  style={{ width: TIMELINE_UI.trackHeaderWidth }}
                  title="拖动轨道头可调整轨道顺序"
                  data-node-pointer="control"
                  onPointerDown={(event) => beginTrackDrag(event, track.id, index)}
                >
                  <Icon name="layers" size={13} />
                  <span className="tl-row-title" title={track.name}>
                    {track.name}
                  </span>
                  <button
                    type="button"
                    className="tl-row-btn"
                    data-node-pointer="control"
                    title={track.muted ? '取消静音' : '静音'}
                    onClick={() => {
                      onCommit(
                        {
                          ...data,
                          tracks: data.tracks.map((item) =>
                            item.id === track.id ? { ...item, muted: !item.muted } : item
                          )
                        },
                        'timeline-toggle-mute'
                      )
                    }}
                  >
                    <Icon name={track.muted ? 'volume-off' : 'volume'} size={12} />
                  </button>
                  <button
                    type="button"
                    className="tl-row-btn"
                    data-node-pointer="control"
                    title="删除轨道"
                    disabled={data.tracks.length <= 1}
                    onClick={() => {
                      const result = removeTrack(data, track.id)
                      if (!result.ok) return toast(result.reason)
                      onCommit(result.data, 'timeline-remove-track')
                    }}
                  >
                    <Icon name="trash" size={12} />
                  </button>
                </div>
                <div
                  className={`tl-lane${track.muted ? ' is-muted' : ''}`}
                  style={{ width: contentWidth }}
                  data-timeline-lane={track.id}
                  data-timeline-pps={pixelsPerSecond}
                  onDragOver={(event) => {
                    if (!onDropAsset) return
                    if (!event.dataTransfer.types.includes(TIMELINE_ASSET_DRAG_TYPE)) return
                    event.preventDefault()
                    event.dataTransfer.dropEffect = 'copy'
                  }}
                  onDrop={(event) => {
                    if (!onDropAsset) return
                    const raw = event.dataTransfer.getData(TIMELINE_ASSET_DRAG_TYPE)
                    const asset = raw ? parseTimelineAssetPayload(raw) : null
                    if (!asset) return
                    event.preventDefault()
                    event.stopPropagation()
                    const rect = event.currentTarget.getBoundingClientRect()
                    const offsetPx = Math.max(0, event.clientX - rect.left)
                    onDropAsset(asset, track.id, Math.round(offsetPx / pxPerMs))
                  }}
                >
                  {clips.map((clip) => {
                    const dragging = drag?.clipId === clip.id
                    const left = (dragging ? drag.startMs : clip.startMs) * pxPerMs
                    const width = (dragging ? drag.durationMs : clip.durationMs) * pxPerMs
                    const isSelected = clip.id === selectedClipId
                    const displayName = mediaTitles[clip.mediaId] ?? clip.name
                    return (
                      <div
                        key={clip.id}
                        className={`tl-clip${isSelected ? ' is-selected' : ''} is-kind-${clip.kind}${
                          dragging ? ' is-dragging' : ''
                        }${clip.kind === 'audio' ? ' is-audio' : ''}`}
                        data-node-pointer="control"
                        data-kind={clip.kind}
                        data-media-id={clip.mediaId}
                        style={{ left: Math.round(left), width: Math.max(12, Math.round(width)) }}
                        onPointerDown={(event) => beginClipDrag(event, clip, 'move')}
                      >
                        {clip.kind === 'image' && clip.mediaPath ? (
                          <span
                            className="tl-clip-thumb"
                            style={{ backgroundImage: `url(${mediaUrl(clip.mediaPath)})` }}
                          />
                        ) : clip.kind === 'video' && clip.mediaPath ? (
                          <VideoThumb path={clip.mediaPath} className="tl-clip-thumb-img" />
                        ) : null}
                        <span className="tl-clip-label">
                          <Icon name={CLIP_KIND_ICON[clip.kind]} size={11} />
                          <span className="tl-clip-name">{displayName}</span>
                        </span>
                        <span
                          className="tl-clip-handle is-start"
                          data-node-pointer="control"
                          onPointerDown={(event) => beginClipDrag(event, clip, 'start')}
                        />
                        <span
                          className="tl-clip-handle is-end"
                          data-node-pointer="control"
                          onPointerDown={(event) => beginClipDrag(event, clip, 'end')}
                        />
                      </div>
                    )
                  })}

                </div>
              </div>
            )
          })}

          <div
            className="tl-playhead"
            style={{
              left: TIMELINE_UI.trackHeaderWidth + playheadLeft,
              height:
                TIMELINE_UI.rulerHeight + data.tracks.length * TIMELINE_UI.trackHeight
            }}
          />
        </div>
      </div>
    </div>
  )
}

/**
 * 引用素材条（2026-11-03 用户裁决）：连线进来的图片/视频/音频先作为「引用」展示，
 * 不再自动铺到轨道。单击只选中（Ctrl/⌘ 多选、Shift 连选）；按住直接拖到目标轨道即落轨，
 * 落点即开始位置（无需长按）。素材库使用同一套手势。
 */
function TimelineRefStrip({
  assets,
  mediaTitles,
  surfaceRef,
  onAddAssets
}: {
  assets: TimelineEditorAsset[]
  mediaTitles: Record<string, string>
  surfaceRef?: React.RefObject<HTMLDivElement | null>
  onAddAssets: (assets: TimelineEditorAsset[], trackId: string, startMs: number) => void
}): React.JSX.Element | null {
  const [ghost, setGhost] = useState<{
    x: number
    y: number
    asset: TimelineEditorAsset
    count: number
  } | null>(null)
  const [selectedIds, setSelectedIds] = useState<string[]>([])
  const [draggingIds, setDraggingIds] = useState<string[]>([])
  const pressRef = useRef<{
    asset: TimelineEditorAsset
    drag: TimelineEditorAsset[]
    originX: number
    originY: number
    x: number
    y: number
    started: boolean
  } | null>(null)
  if (assets.length === 0) return null

  const laneAt = (x: number, y: number): { trackId: string; startMs: number } | null => {
    const scope = surfaceRef?.current ?? null
    const lanes = scope
      ? Array.from(scope.querySelectorAll<HTMLElement>('[data-timeline-lane]'))
      : []
    let element = document.elementFromPoint(x, y)?.closest<HTMLElement>('[data-timeline-lane]')
    if (element && scope && !scope.contains(element)) element = null
    // 兜底：落点稍微偏到刻度尺/行间隙时，取纵向最近的一条轨道，避免「拖到空白处没反应」。
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

  /** 按选择顺序取出要一起拖动的素材；按下的不是已选项时只拖它自己。 */
  const assetsToDrag = (asset: TimelineEditorAsset): TimelineEditorAsset[] => {
    if (!selectedIds.includes(asset.mediaId)) return [asset]
    const picked = selectedIds
      .map((id) => assets.find((item) => item.mediaId === id))
      .filter((item): item is TimelineEditorAsset => Boolean(item))
    return picked.length > 0 ? picked : [asset]
  }

  /** 单击选中（Ctrl/⌘ 切换，Shift 从最后一个选中项起连选），不再直接追加到轨道。 */
  const applySelection = (event: PointerEvent, asset: TimelineEditorAsset): void => {
    if (event.ctrlKey || event.metaKey) {
      setSelectedIds((prev) =>
        prev.includes(asset.mediaId) ? prev.filter((id) => id !== asset.mediaId) : [...prev, asset.mediaId]
      )
      return
    }
    if (event.shiftKey) {
      const pool = assets.map((item) => item.mediaId)
      setSelectedIds((prev) => {
        const anchor = prev[prev.length - 1]
        const from = anchor ? pool.indexOf(anchor) : -1
        const to = pool.indexOf(asset.mediaId)
        if (from < 0 || to < 0) return [asset.mediaId]
        const range = pool.slice(Math.min(from, to), Math.max(from, to) + 1)
        const next = [...prev]
        for (const id of range) if (!next.includes(id)) next.push(id)
        return next
      })
      return
    }
    setSelectedIds([asset.mediaId])
  }

  // 2026-11-03 用户裁决：不再长按等待——按下后直接拖动即可，单击（位移 ≤4px）仍是选中。
  const DRAG_THRESHOLD_PX = 4
  const startPress = (event: React.PointerEvent, asset: TimelineEditorAsset): void => {
    if (event.button !== 0) return
    event.stopPropagation()
    const state = {
      asset,
      drag: assetsToDrag(asset),
      originX: event.clientX,
      originY: event.clientY,
      x: event.clientX,
      y: event.clientY,
      started: false
    }
    pressRef.current = state
    const beginDrag = (): void => {
      state.started = true
      if (!selectedIds.includes(asset.mediaId)) setSelectedIds(state.drag.map((item) => item.mediaId))
      setGhost({ x: state.x, y: state.y, asset, count: state.drag.length })
      setDraggingIds(state.drag.map((item) => item.mediaId))
      document.body.classList.add('tl-asset-dragging')
    }
    const cleanup = (): void => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      window.removeEventListener('pointercancel', onUp)
    }
    const onMove = (moveEvent: PointerEvent): void => {
      const current = pressRef.current
      if (!current) return
      current.x = moveEvent.clientX
      current.y = moveEvent.clientY
      if (!current.started) {
        const moved =
          Math.abs(moveEvent.clientX - current.originX) +
            Math.abs(moveEvent.clientY - current.originY) >
          DRAG_THRESHOLD_PX
        if (!moved) return
        beginDrag()
      }
      setGhost((prev) => (prev ? { ...prev, x: current.x, y: current.y } : prev))
    }
    const onUp = (upEvent: PointerEvent): void => {
      const current = pressRef.current
      pressRef.current = null
      const dragging = Boolean(current?.started)
      if (dragging) {
        const target = laneAt(upEvent.clientX, upEvent.clientY)
        if (target) {
          onAddAssets(current?.drag ?? [asset], target.trackId, target.startMs)
          setSelectedIds([])
        } else {
          toast('没放到轨道上：请把素材拖到轨道的时间轴空白处')
        }
      } else if (current) {
        applySelection(upEvent, asset)
      }
      setGhost(null)
      setDraggingIds([])
      document.body.classList.remove('tl-asset-dragging')
      cleanup()
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    window.addEventListener('pointercancel', onUp)
  }

  return (
    <div className="tl-refs" data-node-pointer="control" aria-label="引用素材">
      <span className="tl-refs-title">引用素材</span>
      <div className="tl-refs-list">
        {assets.map((asset) => (
          <button
            key={`${asset.mediaId}-${asset.mediaPath}`}
            type="button"
            className={`tl-ref is-${asset.kind}${selectedIds.includes(asset.mediaId) ? ' is-selected' : ''}${draggingIds.includes(asset.mediaId) ? ' is-dragging' : ''}`}
            data-node-pointer="control"
            data-media-id={asset.mediaId}
            aria-pressed={selectedIds.includes(asset.mediaId)}
            onPointerDown={(event) => startPress(event, asset)}
          >
            <span className="tl-ref-thumb">
              {asset.kind === 'image' ? (
                <img src={mediaUrl(asset.mediaPath)} alt="" draggable={false} />
              ) : asset.kind === 'video' ? (
                <VideoThumb path={asset.mediaPath} />
              ) : (
                <Icon name="audio" size={13} />
              )}
            </span>
            <span className="tl-ref-name">{mediaTitles[asset.mediaId] ?? asset.name}</span>
          </button>
        ))}
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

export function TimelineBody({ shape }: NodeBodyProps): React.JSX.Element {
  const editor = useEditor()
  const project = useAppStore((store) => store.currentProject)
  const parsed = useMemo(() => parseTimeline(shape.props.text), [shape.props.text])
  const data = parsed.ok ? parsed.data : createEmptyTimeline()
  const [selectedClipId, setSelectedClipId] = useState<string | null>(null)
  const [playheadMs, setPlayheadMs] = useState(0)
  const [pixelsPerSecond, setPixelsPerSecond] = useState<number>(
    TIMELINE_UI.defaultPixelsPerSecond
  )
  const [fullscreen, setFullscreen] = useState(false)
  const [exporting, setExporting] = useState(false)
  const [snapEnabled, setSnapEnabled] = useState(true)
  // 全屏编辑时时间轴区的高度（像素）：默认三条轨道，可拖动分隔条调整（2026-11-03 用户裁决）。
  const [timelineHeightPx, setTimelineHeightPx] = useState<number>(
    TIMELINE_UI.fullscreenPaneHeight
  )
  const providers = useGatewayStore((store) => store.providers)
  const loadProviders = useGatewayStore((store) => store.load)

  useEffect(() => {
    void loadProviders()
  }, [loadProviders])

  const commit = (next: TimelineData, label: string): void => {
    editor.updateShape({ id: shape.id, type: 'node-card', props: { text: serializeTimeline(next) } })
    markUndoPoint(editor, label)
  }

  const importMediaToTrack = async (trackId: string): Promise<void> => {
    if (!project) return toast('项目未就绪')
    const track = data.tracks.find((item) => item.id === trackId)
    if (!track) return toast('请先选择一条轨道')
    try {
      const response = await window.api.pickMedia(project.id)
      if (!response.ok) return toast(`导入失败：${response.error.message}`)
      const imported = response.data.assets
      if (response.data.errors.length > 0) {
        toast(`${response.data.errors[0].reason}`)
      }
      if (imported.length === 0) return
      let next = data
      const bridge = probeBridge()
      for (const asset of imported) {
        const kind = assetKind(asset)
        if (!kind) {
          toast(`${asset.name ?? '该文件'} 不是图片/视频/音频`)
          continue
        }
        let durationMs: number | null =
          typeof asset.durationSec === 'number' && asset.durationSec > 0
            ? Math.round(asset.durationSec * 1000)
            : null
        if (kind !== 'image' && bridge.probeMediaMetadata) {
          const probe = await bridge.probeMediaMetadata({ projectId: project.id, mediaId: asset.id })
          if (probe.ok && probe.data) durationMs = probe.data.durationMs ?? durationMs
        }
        const added = addClip(next, {
          trackId,
          kind,
          mediaId: asset.id,
          mediaPath: asset.path,
          name: asset.name ?? CLIP_KIND_LABEL[kind],
          sourceDurationMs: durationMs ?? 0
        })
        if (!added.ok) {
          toast(added.reason)
          continue
        }
        next = added.data
      }
      if (next !== data) {
        commit(next, 'timeline-add-media')
        toast('已添加到轨道线')
      }
    } catch (error) {
      toast(`导入失败：${error instanceof Error ? error.message : String(error)}`)
    }
  }

  // 素材库/引用素材 → 轨道：按住直接拖到目标轨道才落轨（2026-11-03 用户裁决），
  // activeTrackId 仅用于「添加素材到这条轨道」按钮与工具栏既有入口。
  const activeTrackId =
    (selectedClipId ? findClip(data, selectedClipId)?.trackId : undefined) ?? data.tracks[0]?.id ?? ''
  // 成片分辨率标签（全屏预览角标）：读节点 config 的 render 配置，缺省 1920×1080。
  const resolutionLabel = useMemo(() => {
    try {
      const config = JSON.parse(shape.props.config || '{}') as {
        render?: { width?: number; height?: number }
      }
      const width = config.render?.width ?? 1920
      const height = config.render?.height ?? 1080
      return `${width}×${height}`
    } catch {
      return '1920×1080'
    }
  }, [shape.props.config])
  /**
   * 素材库 → 轨道（支持多选，按传入顺序依次落位）。
   * 2026-11-03 用户裁决：一次框选多个素材时，先选中的排前面，后选中的依次跟在后面。
   */
  /** 从本地导入到「引用素材」池（不自动铺轨，由用户拖入轨道）。 */
  const importLocalReferences = async (): Promise<void> => {
    if (!project) return toast('项目未就绪')
    try {
      const response = await window.api.pickMedia(project.id)
      if (!response.ok) return toast(`导入失败：${response.error.message}`)
      if (response.data.errors.length > 0) toast(response.data.errors[0].reason)
      const refs: TimelineEditorAsset[] = []
      for (const asset of response.data.assets) {
        const kind = assetKind(asset)
        if (!kind) continue
        refs.push({
          mediaId: asset.id,
          mediaPath: asset.path,
          name: asset.name ?? CLIP_KIND_LABEL[kind],
          kind
        })
      }
      if (refs.length === 0) return
      const result = addReferences(data, refs)
      if (!result.ok) return toast(result.reason)
      commit(result.data, 'timeline-import-local-references')
      toast(`已导入 ${refs.length} 个素材到引用素材`)
    } catch (error) {
      toast(`导入失败：${error instanceof Error ? error.message : String(error)}`)
    }
  }

  /** 从画布导入：优先取选中的媒体节点；没选中时导入画布上全部媒体节点。 */
  const importCanvasSelection = (): void => {
    const collect = (shapes: ReturnType<typeof editor.getSelectedShapes>): TimelineEditorAsset[] => {
      const refs: TimelineEditorAsset[] = []
      const seen = new Set<string>()
      for (const candidate of shapes) {
        if (candidate.type !== 'node-card') continue
        const props = candidate.props as unknown as {
          mediaId?: string
          mediaPath?: string
          mediaMime?: string
          title?: string
        }
        const mediaId = typeof props.mediaId === 'string' ? props.mediaId : ''
        const mediaPath = typeof props.mediaPath === 'string' ? props.mediaPath : ''
        if (!mediaId || !mediaPath || seen.has(mediaId)) continue
        const mime = typeof props.mediaMime === 'string' ? props.mediaMime : ''
        const kind = mime.startsWith('video/')
          ? 'video'
          : mime.startsWith('audio/')
            ? 'audio'
            : mime.startsWith('image/')
              ? 'image'
              : null
        if (!kind) continue
        seen.add(mediaId)
        refs.push({
          mediaId,
          mediaPath,
          name: (typeof props.title === 'string' && props.title) || '画布素材',
          kind
        })
      }
      return refs
    }
    let refs = collect(editor.getSelectedShapes())
    if (refs.length === 0) {
      refs = collect(editor.getCurrentPageShapes())
      if (refs.length > 0) toast('未选中素材，已导入画布上全部素材')
    }
    if (refs.length === 0) return toast('画布上还没有可导入的图片/视频/音频素材')
    const result = addReferences(data, refs)
    if (!result.ok) return toast(result.reason)
    commit(result.data, 'timeline-import-canvas-references')
    toast(`已从画布导入 ${refs.length} 个素材`)
  }

  const addAssetsToTrack = async (
    assets: TimelineEditorAsset[],
    trackId?: string,
    startMs?: number
  ): Promise<void> => {
    if (!project) return toast('项目未就绪')
    const targetTrackId = trackId ?? activeTrackId
    if (!targetTrackId) return toast('请先添加一条轨道')
    const bridge = probeBridge()
    let next = data
    // 显式给起点：多个素材按顺序首尾相接，不依赖 addClip 各自的「追加到末尾」推算。
    let cursor = startMs ?? timelineDurationMs(data)
    let firstClipId: string | null = null
    for (const asset of assets) {
      let durationMs = asset.durationMs ?? 0
      if (asset.kind !== 'image' && bridge.probeMediaMetadata) {
        const probe = await bridge.probeMediaMetadata({
          projectId: project.id,
          mediaId: asset.mediaId
        })
        if (probe.ok && probe.data?.durationMs) durationMs = probe.data.durationMs
      }
      const input = {
        trackId: targetTrackId,
        kind: asset.kind,
        mediaId: asset.mediaId,
        mediaPath: asset.mediaPath,
        name: asset.name,
        sourceDurationMs: durationMs,
        startMs: cursor
      }
      const duration = resolveClipDurationMs(input)
      // 吸附开启：磁吸到最近的片段边缘（首尾相连）；关闭：保持落点，只避开重叠。
      const placeStart = snapEnabled
        ? snapDropStartMs({
            data: next,
            trackId: targetTrackId,
            rawStartMs: cursor,
            durationMs: duration,
            kind: asset.kind
          })
        : freeStartMsFor(next, targetTrackId, cursor, duration, asset.kind)
      const added = addClip(next, { ...input, startMs: placeStart })
      if (!added.ok) {
        toast(added.reason)
        continue
      }
      next = added.data
      if (!firstClipId) firstClipId = added.clipId ?? null
      const placed = findClip(next, added.clipId ?? '')
      cursor = placeStart + (placed?.durationMs ?? 0)
    }
    if (next === data) return
    commit(next, 'timeline-add-asset')
    setSelectedClipId(firstClipId)
  }

  const addAssetToTrack = (
    asset: TimelineEditorAsset,
    trackId?: string,
    startMs?: number
  ): Promise<void> => addAssetsToTrack([asset], trackId, startMs)

  const exportComposition = async (): Promise<void> => {
    if (!project || exporting) return
    if (data.clips.length === 0) return toast('先把素材放到轨道上')
    setExporting(true)
    try {
      await runNodeManually(editor, project.id, providers, shape.id)
    } catch (error) {
      toast(`合成失败：${error instanceof Error ? error.message : String(error)}`)
    } finally {
      setExporting(false)
    }
  }

  const splitAtPlayhead = (): void => {
    const target =
      (activeClipId ? findClip(data, activeClipId) : undefined) ??
      data.clips.find((clip) => playheadMs > clip.startMs && playheadMs < clipEndMs(clip))
    if (!target) return toast('请先选中一个片段，并把播放头移到片段内部')
    const result = splitClip(data, target.id, playheadMs)
    if (!result.ok) return toast(result.reason)
    commit(result.data, 'timeline-split-clip')
    setSelectedClipId(result.clipId ?? null)
  }

  /** 向左/向右分割：切一刀并删掉另一侧（剪映三态分割）。 */
  const splitKeepAtPlayhead = (side: 'left' | 'right'): void => {
    const target =
      (activeClipId ? findClip(data, activeClipId) : undefined) ??
      data.clips.find((clip) => playheadMs > clip.startMs && playheadMs < clipEndMs(clip))
    if (!target) return toast('请先选中一个片段，并把播放头移到片段内部')
    const result = splitClipKeep(data, target.id, playheadMs, side)
    if (!result.ok) return toast(result.reason)
    commit(result.data, side === 'left' ? 'timeline-split-keep-left' : 'timeline-split-keep-right')
    setSelectedClipId(result.clipId ?? null)
  }

  const deleteSelected = (): void => {
    if (!activeClipId) return
    const result = removeClip(data, activeClipId)
    if (!result.ok) return toast(result.reason)
    commit(result.data, 'timeline-remove-clip')
    setSelectedClipId(null)
  }


  const undo = (): void => {
    editor.undo()
  }
  const redo = (): void => {
    editor.redo()
  }

  // 上游素材不再自动铺轨（2026-11-03 用户裁决）：连线只是「引用」，
  // 由用户从引用素材条点选或长按拖到轨道上，顺序与落点都由用户决定。
  const inputVersion = useValue(
    'timeline connected inputs',
    () => editor.getCurrentPageShapes().filter((item) => item.type === 'arrow').length,
    [editor]
  )

  // 媒体 id → 画布节点标题：视频/图片改名后，轨道片段与引用条同步显示新名字。
  const mediaTitlesJson = useValue(
    'timeline media titles',
    () => {
      const map: Record<string, string> = {}
      for (const candidate of editor.getCurrentPageShapes()) {
        if (candidate.type !== 'node-card') continue
        const props = candidate.props as unknown as { mediaId?: string; title?: string }
        const mediaId = typeof props.mediaId === 'string' ? props.mediaId : ''
        const title = typeof props.title === 'string' ? props.title.trim() : ''
        if (mediaId && title) map[mediaId] = title
      }
      return JSON.stringify(map)
    },
    [editor]
  )
  const mediaTitles = useMemo<Record<string, string>>(
    () => JSON.parse(mediaTitlesJson) as Record<string, string>,
    [mediaTitlesJson]
  )

  // 连线素材（运行时派生，不落盘）：与 data.references 合并后就是左侧「引用素材」池。
  const connectedRefs = useMemo<TimelineEditorAsset[]>(() => {
    const connected = readConnectedNodeInputs(editor, shape.id)
    const seen = new Set<string>()
    const found: TimelineEditorAsset[] = []
    for (const input of connected) {
      const value = mediaValueOf(input.value)
      if (!value || seen.has(value.mediaId)) continue
      seen.add(value.mediaId)
      found.push({
        mediaId: value.mediaId,
        mediaPath: value.mediaPath,
        name: value.name ?? CLIP_KIND_LABEL[value.kind],
        kind: value.kind
      })
    }
    return found
    // inputVersion 让连线增删后重新取引用；shape.props.text 变化时也刷新名称。
  }, [editor, shape.id, inputVersion, shape.props.text])

  // 引用素材池 = 已落盘引用（本地/画布导入） ∪ 当前连线素材（按连线顺序）。
  const allRefs = useMemo<TimelineEditorAsset[]>(() => {
    const out: TimelineEditorAsset[] = []
    const seen = new Set<string>()
    for (const reference of data.references) {
      if (seen.has(reference.mediaId)) continue
      seen.add(reference.mediaId)
      out.push({
        mediaId: reference.mediaId,
        mediaPath: reference.mediaPath,
        name: mediaTitles[reference.mediaId] ?? reference.name,
        kind: reference.kind
      })
    }
    for (const reference of connectedRefs) {
      if (seen.has(reference.mediaId)) continue
      seen.add(reference.mediaId)
      out.push({ ...reference, name: mediaTitles[reference.mediaId] ?? reference.name })
    }
    return out
  }, [data.references, connectedRefs, mediaTitles])

  // 快捷键：选中片段时 Delete/Backspace 只删片段；节点失去选中时片段选中态随之清空，
  // 画布的全局 Delete 恢复原样。作用域判断不参与删除决策——单击片段已经把上下文说清楚了。
  const surfaceRef = useRef<HTMLDivElement | null>(null)
  const nodeSelected = useValue(
    'timeline node selected',
    () => editor.getSelectedShapeIds().includes(shape.id),
    [editor, shape.id]
  )
  // 节点失去选中态即视为没有片段上下文：用派生值而不是在 effect 里清 state，
  // 避免级联渲染，也保证「点击画布空白后 Delete 回到画布的删除语义」。
  const activeClipId = nodeSelected ? selectedClipId : null

  // 选中片段期间让画布进入「编辑态」：tldraw 在编辑态会关闭自己的键盘快捷键，
  // 这样 Delete 不会被画布拿去删节点，只由时间线自己处理片段删除。
  useEffect(() => {
    if (activeClipId) editor.setEditingShape(shape.id)
    else if (editor.getEditingShapeId() === shape.id) editor.setEditingShape(null)
    return () => {
      if (editor.getEditingShapeId() === shape.id) editor.setEditingShape(null)
    }
  }, [activeClipId, editor, shape.id])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      const host = surfaceRef.current
      if (!host) return
      if (event.key === 'Delete' || event.key === 'Backspace') {
        if (!activeClipId) return
        event.preventDefault()
        event.stopPropagation()
        deleteSelected()
        return
      }
      const ownsScope =
        host.contains(document.activeElement) ||
        host.matches(':hover') ||
        nodeSelected
      if (!ownsScope) return
      const modifier = event.ctrlKey || event.metaKey
      if (modifier && event.key.toLowerCase() === 'b') {
        event.preventDefault()
        event.stopPropagation()
        splitAtPlayhead()
      }
    }
    window.addEventListener('keydown', onKeyDown, true)
    return () => window.removeEventListener('keydown', onKeyDown, true)
  })

  // 全屏编辑：Esc 关闭。遮罩挂在 document.body 上，画布自己的 Esc 处理够不到它。
  useEffect(() => {
    if (!fullscreen) return
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      event.stopPropagation()
      setFullscreen(false)
    }
    window.addEventListener('keydown', onKeyDown, true)
    return () => window.removeEventListener('keydown', onKeyDown, true)
  }, [fullscreen])

  // 全屏编辑：拖动分隔条调整时间轴高度（默认正好三条轨道，范围 1 条轨道 ~ 视口的 62%）。
  const beginTimelineResize = (event: React.PointerEvent<HTMLDivElement>): void => {
    event.preventDefault()
    event.stopPropagation()
    const modal = event.currentTarget.closest('.tl-modal')
    if (!modal) return
    const rect = modal.getBoundingClientRect()
    const minHeight = TIMELINE_UI.rulerHeight + TIMELINE_UI.trackHeight + TIMELINE_UI.toolbarHeight
    const maxHeight = rect.height * 0.62
    const onMove = (moveEvent: PointerEvent): void => {
      const next = rect.bottom - 8 - moveEvent.clientY
      setTimelineHeightPx(Math.round(Math.min(maxHeight, Math.max(minHeight, next))))
    }
    const cleanup = (): void => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', cleanup)
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', cleanup)
  }

  const surface = (
    <TimelineSurface
      data={data}
      selectedClipId={activeClipId}
      onSelectClip={setSelectedClipId}
      playheadMs={playheadMs}
      onSeek={setPlayheadMs}
      pixelsPerSecond={pixelsPerSecond}
      onZoom={setPixelsPerSecond}
      onCommit={commit}
      onAddMedia={(trackId) => void importMediaToTrack(trackId)}
      onDropAsset={(asset, trackId, startMs) => void addAssetToTrack(asset, trackId, startMs)}
      onSplit={splitAtPlayhead}
      onSplitKeep={splitKeepAtPlayhead}
      onDeleteClip={deleteSelected}
      onUndo={undo}
      onRedo={redo}
      snapEnabled={snapEnabled}
      onToggleSnap={() => setSnapEnabled((value) => !value)}
      mediaTitles={mediaTitles}
      onToggleFullscreen={() => setFullscreen((open) => !open)}
      fullscreen={fullscreen}
    />
  )

  if (!parsed.ok) {
    return (
      <div className="tl-error" data-node-pointer="control">
        <p>{parsed.reason}</p>
        <button
          type="button"
          className="btn-ghost"
          data-node-pointer="control"
          onClick={() => {
            commit(createEmptyTimeline(), 'timeline-reset')
            setSelectedClipId(null)
            setPlayheadMs(0)
          }}
        >
          重置轨道线
        </button>
      </div>
    )
  }

  return (
    <div className="tl-body" ref={surfaceRef}>
      {fullscreen ? null : (
        <TimelineRefStrip
          assets={allRefs}
          mediaTitles={mediaTitles}
          surfaceRef={surfaceRef}
          onAddAssets={(assets, trackId, startMs) =>
            void addAssetsToTrack(assets, trackId, startMs)
          }
        />
      )}
      {fullscreen ? null : surface}
      {fullscreen
        ? createPortal(
            <div
              className="tl-modal-mask"
              onPointerDown={(event) => {
                if (event.target === event.currentTarget) setFullscreen(false)
              }}
            >
              <div
                className="tl-modal"
                onPointerDown={(event) => event.stopPropagation()}
                // 全屏区域内任意位置 Ctrl/⌘ + 滚轮都能细调时间轴缩放
                onWheelCapture={(event) => {
                  if (!event.ctrlKey && !event.metaKey) return
                  if (event.defaultPrevented) return
                  event.preventDefault()
                  const factor = event.deltaY < 0 ? 1.12 : 1 / 1.12
                  setPixelsPerSecond((current) =>
                    Math.min(
                      TIMELINE_UI.pixelsPerSecondMax,
                      Math.max(TIMELINE_UI.pixelsPerSecondMin, Math.round(current * factor))
                    )
                  )
                }}
              >
                <TimelineEditorStage
                  projectId={project?.id ?? ''}
                  data={data}
                  resolution={resolutionLabel}
                  playheadMs={playheadMs}
                  onSeek={setPlayheadMs}
                  onAddAssets={(assets, trackId, startMs) =>
                    void addAssetsToTrack(assets, trackId, startMs)
                  }
                  references={allRefs}
                  mediaTitles={mediaTitles}
                  onImportLocal={() => void importLocalReferences()}
                  onImportCanvas={importCanvasSelection}
                  onExport={() => void exportComposition()}
                  onClose={() => setFullscreen(false)}
                  exporting={exporting}
                />
                <div className="tl-timeline-splitter" role="separator" aria-label="调整时间轴高度" onPointerDown={beginTimelineResize} />
                <div className="tl-timeline-pane" style={{ height: `${timelineHeightPx}px` }}>
                  {surface}
                </div>
              </div>
            </div>,
            document.body
          )
        : null}
    </div>
  )
}

export const TIMELINE_BODY_LIMITS = TIMELINE_LIMITS
