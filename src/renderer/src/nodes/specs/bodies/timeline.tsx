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
import { useEditor } from 'tldraw'
import {
  TIMELINE_LIMITS,
  addClip,
  addTrack,
  clipEndMs,
  clipsOfTrack,
  createEmptyTimeline,
  findClip,
  formatTimecode,
  moveClip,
  parseTimeline,
  removeClip,
  removeTrack,
  rulerStepMs,
  serializeTimeline,
  splitClip,
  timelineDurationMs,
  trimClip,
  trackKindForClip,
  type TimelineClip,
  type TimelineClipKind,
  type TimelineData,
  type TimelineTrackKind
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
  onSplit: () => void
  onDeleteClip: () => void
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
  onSplit,
  onDeleteClip,
  onToggleFullscreen,
  fullscreen = false
}: SurfaceProps): React.JSX.Element {
  const [drag, setDrag] = useState<DragState | null>(null)
  const dragRef = useRef<DragState | null>(null)
  const [trackMenuOpen, setTrackMenuOpen] = useState(false)
  // 拖动过程中事件处理器必须读到最新值，但渲染期间不能写 ref——
  // 因此统一走 updateDrag：先同步 ref 再触发渲染。
  const updateDrag = (next: DragState | null): void => {
    dragRef.current = next
    setDrag(next)
  }

  const pxPerMs = pixelsPerSecond / 1000
  const durationMs = timelineDurationMs(data)
  const visibleMs = Math.max(durationMs + TIMELINE_UI.tailPaddingMs, 8000)
  const contentWidth = Math.max(320, Math.round(visibleMs * pxPerMs))
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
        updateDrag({
          ...current,
          trackId,
          startMs: Math.max(0, Math.round(current.original.startMs + deltaMs))
        })
        return
      }
      const targetMs =
        current.mode === 'start'
          ? current.original.startMs + deltaMs
          : current.original.startMs + current.original.durationMs + deltaMs
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
  }, [drag?.clipId, drag?.mode, data, pxPerMs])

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
    <div className={`tl-surface${fullscreen ? ' is-fullscreen' : ''}`}>
      <div className="tl-toolbar">
        <button
          type="button"
          className="tl-btn"
          data-node-pointer="control"
          title="在播放头处分割选中片段（Ctrl/⌘+B）"
          disabled={!selected}
          onClick={onSplit}
        >
          <Icon name="crop" size={13} />
          分割
        </button>
        <button
          type="button"
          className="tl-btn"
          data-node-pointer="control"
          title="删除选中片段（Delete）"
          disabled={!selected}
          onClick={onDeleteClip}
        >
          <Icon name="trash" size={13} />
          删除
        </button>
        <div className="tl-menu-wrap">
          <button
            type="button"
            className="tl-btn"
            data-node-pointer="control"
            onClick={() => setTrackMenuOpen((open) => !open)}
          >
            <Icon name="add" size={13} />
            轨道
          </button>
          {trackMenuOpen ? (
            <div className="tl-menu" data-node-pointer="control" role="menu">
              {(['video', 'audio'] as TimelineTrackKind[]).map((kind) => (
                <button
                  key={kind}
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    setTrackMenuOpen(false)
                    const result = addTrack(data, kind)
                    if (!result.ok) return toast(result.reason)
                    onCommit(result.data, 'timeline-add-track')
                  }}
                >
                  {kind === 'video' ? '视频轨' : '音频轨'}
                </button>
              ))}
            </div>
          ) : null}
        </div>
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
        <button
          type="button"
          className="tl-btn is-icon"
          data-node-pointer="control"
          title="时间轴缩小"
          onClick={() => {
            const steps = TIMELINE_UI.pixelsPerSecondSteps
            const index = steps.indexOf(pixelsPerSecond as never)
            onZoom(steps[Math.max(0, index - 1)] ?? steps[0])
          }}
        >
          <Icon name="zoom-out" size={13} />
        </button>
        <button
          type="button"
          className="tl-btn is-icon"
          data-node-pointer="control"
          title="时间轴放大"
          onClick={() => {
            const steps = TIMELINE_UI.pixelsPerSecondSteps
            const index = steps.indexOf(pixelsPerSecond as never)
            onZoom(steps[Math.min(steps.length - 1, index + 1)] ?? steps[steps.length - 1])
          }}
        >
          <Icon name="zoom-in" size={13} />
        </button>
        {onToggleFullscreen ? (
          <button
            type="button"
            className="tl-btn"
            data-node-pointer="control"
            title={fullscreen ? '退出全屏编辑（Esc）' : '全屏编辑'}
            onClick={onToggleFullscreen}
          >
            <Icon name="fullscreen" size={13} />
            {fullscreen ? '退出' : '全屏编辑'}
          </button>
        ) : null}
      </div>

      <div className="tl-scroll">
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

          {data.tracks.map((track) => {
            const clips = clipsOfTrack(data, track.id)
            return (
              <div
                className="tl-row"
                key={track.id}
                data-timeline-track={track.id}
                style={{ height: TIMELINE_UI.trackHeight }}
              >
                <div className="tl-row-header" style={{ width: TIMELINE_UI.trackHeaderWidth }}>
                  <Icon name={track.kind === 'video' ? 'video' : 'audio'} size={13} />
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
                >
                  {clips.map((clip) => {
                    const dragging = drag?.clipId === clip.id
                    const left = (dragging ? drag.startMs : clip.startMs) * pxPerMs
                    const width = (dragging ? drag.durationMs : clip.durationMs) * pxPerMs
                    const isSelected = clip.id === selectedClipId
                    const imageThumb =
                      clip.kind === 'image' && clip.mediaPath ? mediaUrl(clip.mediaPath) : null
                    return (
                      <div
                        key={clip.id}
                        className={`tl-clip${isSelected ? ' is-selected' : ''}${
                          dragging ? ' is-dragging' : ''
                        }${clip.kind === 'audio' ? ' is-audio' : ''}`}
                        data-node-pointer="control"
                        data-kind={clip.kind}
                        style={{ left: Math.round(left), width: Math.max(12, Math.round(width)) }}
                        onPointerDown={(event) => beginClipDrag(event, clip, 'move')}
                        title={`${clip.name} · ${formatTimecode(clip.durationMs)}`}
                      >
                        {imageThumb ? (
                          <span
                            className="tl-clip-thumb"
                            style={{ backgroundImage: `url(${imageThumb})` }}
                          />
                        ) : null}
                        <span className="tl-clip-label">
                          <Icon name={CLIP_KIND_ICON[clip.kind]} size={11} />
                          <span className="tl-clip-name">{clip.name}</span>
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
                  {clips.length === 0 ? (
                    <button
                      type="button"
                      className="tl-lane-empty"
                      data-node-pointer="control"
                      onClick={() => onAddMedia(track.id)}
                    >
                      <Icon name="add" size={13} />
                      添加素材到{track.kind === 'video' ? '视频' : '音频'}轨
                    </button>
                  ) : null}
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
        if (trackKindForClip(kind) !== track.kind) {
          toast(`${asset.name ?? CLIP_KIND_LABEL[kind]} 不能放进${track.kind === 'video' ? '视频' : '音频'}轨`)
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
        toast('已添加到时间线')
      }
    } catch (error) {
      toast(`导入失败：${error instanceof Error ? error.message : String(error)}`)
    }
  }

  const splitAtPlayhead = (): void => {
    const target =
      (selectedClipId ? findClip(data, selectedClipId) : undefined) ??
      data.clips.find((clip) => playheadMs > clip.startMs && playheadMs < clipEndMs(clip))
    if (!target) return toast('请先选中一个片段，并把播放头移到片段内部')
    const result = splitClip(data, target.id, playheadMs)
    if (!result.ok) return toast(result.reason)
    commit(result.data, 'timeline-split-clip')
    setSelectedClipId(result.clipId ?? null)
  }

  const deleteSelected = (): void => {
    if (!selectedClipId) return
    const result = removeClip(data, selectedClipId)
    if (!result.ok) return toast(result.reason)
    commit(result.data, 'timeline-remove-clip')
    setSelectedClipId(null)
  }

  // 上游素材只自动导入一次：用户已经编辑过时间线（或手动清空）后不再被覆盖。
  // 与分镜板同构——连线是“首次铺素材”的便捷入口，不是每次渲染都重写的真值来源。
  const upstreamImportedRef = useRef(false)
  useEffect(() => {
    if (upstreamImportedRef.current || !project) return
    if (data.clips.length > 0) {
      upstreamImportedRef.current = true
      return
    }
    const connected = readConnectedNodeInputs(editor, shape.id)
    const media = connected
      .map((input) => ({ input, value: mediaValueOf(input.value) }))
      .filter((entry): entry is { input: (typeof connected)[number]; value: NonNullable<ReturnType<typeof mediaValueOf>> } => Boolean(entry.value))
    if (media.length === 0) return
    upstreamImportedRef.current = true
    void (async () => {
      const bridge = probeBridge()
      let next = data
      for (const { value } of media) {
        const track = next.tracks.find((item) =>
          value.kind === 'audio' ? item.kind === 'audio' : item.kind === 'video'
        )
        if (!track) continue
        let durationMs: number | null = null
        if (value.kind !== 'image' && bridge.probeMediaMetadata) {
          const probe = await bridge.probeMediaMetadata({
            projectId: project.id,
            mediaId: value.mediaId
          })
          if (probe.ok && probe.data) durationMs = probe.data.durationMs
        }
        const added = addClip(next, {
          trackId: track.id,
          kind: value.kind,
          mediaId: value.mediaId,
          mediaPath: value.mediaPath,
          name: value.name ?? CLIP_KIND_LABEL[value.kind],
          sourceDurationMs: durationMs ?? 0
        })
        if (added.ok) next = added.data
      }
      if (next !== data) commit(next, 'timeline-import-upstream')
    })()
  }, [data, editor, project, shape.id])

  // 快捷键只在鼠标位于本卡片内时接管，避免抢走画布全局 Delete。
  const surfaceRef = useRef<HTMLDivElement | null>(null)
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      const host = surfaceRef.current
      if (!host) return
      if (!host.contains(document.activeElement) && !host.matches(':hover')) return
      const modifier = event.ctrlKey || event.metaKey
      if (modifier && event.key.toLowerCase() === 'b') {
        event.preventDefault()
        event.stopPropagation()
        splitAtPlayhead()
        return
      }
      if (event.key === 'Delete' || event.key === 'Backspace') {
        if (!selectedClipId) return
        event.preventDefault()
        event.stopPropagation()
        deleteSelected()
      }
    }
    window.addEventListener('keydown', onKeyDown, true)
    return () => window.removeEventListener('keydown', onKeyDown, true)
  })

  const surface = (
    <TimelineSurface
      data={data}
      selectedClipId={selectedClipId}
      onSelectClip={setSelectedClipId}
      playheadMs={playheadMs}
      onSeek={setPlayheadMs}
      pixelsPerSecond={pixelsPerSecond}
      onZoom={setPixelsPerSecond}
      onCommit={commit}
      onAddMedia={(trackId) => void importMediaToTrack(trackId)}
      onSplit={splitAtPlayhead}
      onDeleteClip={deleteSelected}
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
          重置时间线
        </button>
      </div>
    )
  }

  return (
    <div className="tl-body" ref={surfaceRef}>
      {surface}
      {fullscreen
        ? createPortal(
            <div
              className="tl-modal-mask"
              onPointerDown={(event) => {
                if (event.target === event.currentTarget) setFullscreen(false)
              }}
            >
              <div className="tl-modal" onPointerDown={(event) => event.stopPropagation()}>
                <div className="tl-modal-head">
                  <strong>时间线编辑</strong>
                  <button
                    type="button"
                    className="tl-btn"
                    data-node-pointer="control"
                    onClick={() => setFullscreen(false)}
                  >
                    <Icon name="close" size={13} />
                    关闭
                  </button>
                </div>
                {surface}
              </div>
            </div>,
            document.body
          )
        : null}
    </div>
  )
}

export const TIMELINE_BODY_LIMITS = TIMELINE_LIMITS
