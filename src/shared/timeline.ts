// 时间线数据模型（时间线节点唯一真值）
//
// 存放位置：节点 `props.text` 的 JSON 字符串（与分镜板同构），不新增 tldraw shape prop——
// 新增 prop 需要改 NodeCardProps + 迁移序列 + 快照 schema，代价远大于收益。
//
// 设计约束（对应 docs 与 NODE_CONTRACT_SPEC）：
// 1. 时间单位一律整数毫秒；任何 UI 交互都换算成毫秒再写模型。
// 2. 媒体引用必须是独立字符串字段 `mediaId` / `mediaPath`，项目包导入的重映射按字符串
//    精确值替换（src/shared/media-reference-remap.ts）；拼成 "id|path" 会漏映射。
// 3. 分割不复制媒体文件：一段切两段，共享 mediaId，各自不同的 inMs。
// 4. 同一条视频轨不允许片段重叠；音频轨允许重叠（混音）。
// 5. 本模块必须是纯函数：不碰 React、不碰 DOM、不碰 IPC，执行器与单元测试共用。
import type { PortType } from './types'

export const TIMELINE_SCHEMA_VERSION = 1

/** 轨道种类：视频轨承载画面（图片/视频），音频轨承载声音。 */
/** 片段种类决定合成方式（画面 / 图片静帧 / 音频）；轨道本身不绑定类型。 */
export type TimelineClipKind = 'video' | 'image' | 'audio'

/**
 * 轨道是「通用轨道」：不区分视频轨/音频轨，放进去什么素材就按素材类型处理
 * （视频/图片走画面与静帧，音频走声音）。2026-11-02 用户裁决：不要给轨道规定类型。
 */
export interface TimelineTrack {
  id: string
  name: string
  muted: boolean
  locked: boolean
  visible: boolean
}

export interface TimelineClip {
  id: string
  trackId: string
  kind: TimelineClipKind
  /** 媒体引用：必须是独立字符串，供项目包导入时重映射。 */
  mediaId: string
  mediaPath: string
  name: string
  /** 时间线上的起点（毫秒） */
  startMs: number
  /** 在时间线上的长度（毫秒） */
  durationMs: number
  /** 源素材内的起点（毫秒）；图片恒为 0。 */
  inMs: number
  /** 源素材总时长（毫秒）；图片为 0，表示无源时长约束。 */
  sourceDurationMs: number
  /** 音量 0..1（音频片段与视频原音都适用）。 */
  volume: number
}

/**
 * 引用素材（2026-11-03 用户裁决）：左侧面板展示的是「与轨道线连接的素材」，
 * 不是整个项目素材库。连线进来的、以及从本地/画布导入的素材都记在这里，
 * 用户点选或长按拖入轨道后才产生片段。
 */
export interface TimelineReference {
  mediaId: string
  mediaPath: string
  name: string
  kind: TimelineClipKind
}

export interface TimelineData {
  schemaVersion: typeof TIMELINE_SCHEMA_VERSION
  /** 合成基准帧率；只影响成片，不影响编辑坐标。 */
  frameRate: number
  tracks: TimelineTrack[]
  clips: TimelineClip[]
  /** 引用素材池：只存媒体引用与名称，不产生片段。 */
  references: TimelineReference[]
}

export type TimelineParseResult =
  | { ok: true; data: TimelineData; empty: boolean }
  | { ok: false; reason: string }

export const TIMELINE_LIMITS = {
  maxTracks: 12,
  maxClips: 500,
  maxReferences: 200,
  minClipMs: 100,
  /** 图片片段的默认时长（用户拖入图片时使用） */
  defaultImageClipMs: 4000,
  maxFrameRate: 60,
  minFrameRate: 1
} as const

export const DEFAULT_TIMELINE_FRAME_RATE = 30

/** 与 tldraw/Node 侧 ID 习惯一致；crypto 不可用时退化为随机串（单机场景足够）。 */
export function timelineId(prefix: string): string {
  const uuid = globalThis.crypto?.randomUUID?.()
  const suffix = uuid ? uuid.slice(0, 8) : Math.random().toString(36).slice(2, 10)
  return `${prefix}-${suffix}`
}

export function createEmptyTimeline(): TimelineData {
  // 2026-11-02 用户裁决：默认两条通用轨道（可放任何素材），高度按两条轨道算。
  const tracks: TimelineTrack[] = [1, 2].map((index) => ({
    id: timelineId('t'),
    name: `轨道 ${index}`,
    muted: false,
    locked: false,
    visible: true
  }))
  return {
    schemaVersion: TIMELINE_SCHEMA_VERSION,
    frameRate: DEFAULT_TIMELINE_FRAME_RATE,
    tracks,
    clips: [],
    references: []
  }
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const asInt = (value: unknown, fallback: number): number =>
  typeof value === 'number' && Number.isFinite(value) ? Math.round(value) : fallback

const asBool = (value: unknown, fallback: boolean): boolean =>
  typeof value === 'boolean' ? value : fallback

const asString = (value: unknown, fallback = ''): string =>
  typeof value === 'string' ? value : fallback

const CLIP_KINDS: readonly TimelineClipKind[] = ['video', 'image', 'audio']

const REFERENCE_KIND_LABEL: Record<TimelineClipKind, string> = {
  video: '视频',
  image: '图片',
  audio: '音频'
}

/** 画面类片段：同一轨道内不允许重叠（重叠语义不明确）。 */
function isVisualKind(kind: TimelineClipKind): boolean {
  return kind === 'video' || kind === 'image'
}

/**
 * 把任意来源的数据规整成合法时间线：丢弃孤儿片段、夹取时长、排序、去重。
 * 这是“读”的唯一入口，卡片与执行器都必须经过它，避免两边口径不一致。
 */
export function normalizeTimeline(raw: unknown): TimelineData {
  const fallback = createEmptyTimeline()
  if (!isObject(raw)) return fallback
  const rawTracks = Array.isArray(raw.tracks) ? raw.tracks : []
  const tracks: TimelineTrack[] = []
  for (const item of rawTracks.slice(0, TIMELINE_LIMITS.maxTracks)) {
    if (!isObject(item)) continue
    const id = asString(item.id).trim()
    if (!id || tracks.some((track) => track.id === id)) continue
    tracks.push({
      id,
      // 旧数据里的 kind（视频轨/音频轨）不再参与判定：轨道是通用的，读到就丢弃。
      name: asString(item.name, `轨道 ${tracks.length + 1}`),
      muted: asBool(item.muted, false),
      locked: asBool(item.locked, false),
      visible: asBool(item.visible, true)
    })
  }
  const trackById = new Map(tracks.map((track) => [track.id, track]))
  const clips: TimelineClip[] = []
  const rawClips = Array.isArray(raw.clips) ? raw.clips : []
  for (const item of rawClips.slice(0, TIMELINE_LIMITS.maxClips)) {
    if (!isObject(item)) continue
    const id = asString(item.id).trim()
    const trackId = asString(item.trackId).trim()
    if (!id || clips.some((clip) => clip.id === id)) continue
    const track = trackById.get(trackId)
    if (!track) continue
    const kind = CLIP_KINDS.includes(item.kind as TimelineClipKind)
      ? (item.kind as TimelineClipKind)
      : 'video'
    const sourceDurationMs = Math.max(0, asInt(item.sourceDurationMs, 0))
    const durationMs = Math.max(TIMELINE_LIMITS.minClipMs, asInt(item.durationMs, 1000))
    const inMs = Math.max(0, asInt(item.inMs, 0))
    clips.push({
      id,
      trackId,
      kind,
      mediaId: asString(item.mediaId).trim(),
      mediaPath: asString(item.mediaPath).trim(),
      name: asString(item.name, '素材'),
      startMs: Math.max(0, asInt(item.startMs, 0)),
      durationMs,
      // 图片没有源时长约束；视频/音频按源尾截断。
      inMs: kind === 'image' ? 0 : inMs,
      sourceDurationMs: kind === 'image' ? 0 : sourceDurationMs,
      volume: Math.min(1, Math.max(0, typeof item.volume === 'number' ? item.volume : 1))
    })
  }
  const references: TimelineReference[] = []
  const rawReferences = Array.isArray(raw.references) ? raw.references : []
  for (const item of rawReferences.slice(0, TIMELINE_LIMITS.maxReferences)) {
    if (!isObject(item)) continue
    const mediaId = asString(item.mediaId).trim()
    const mediaPath = asString(item.mediaPath).trim()
    const kind = CLIP_KINDS.includes(item.kind as TimelineClipKind)
      ? (item.kind as TimelineClipKind)
      : null
    if (!mediaId || !mediaPath || !kind) continue
    if (references.some((reference) => reference.mediaId === mediaId)) continue
    references.push({
      mediaId,
      mediaPath,
      kind,
      name: asString(item.name, REFERENCE_KIND_LABEL[kind])
    })
  }
  return {
    schemaVersion: TIMELINE_SCHEMA_VERSION,
    frameRate: Math.min(
      TIMELINE_LIMITS.maxFrameRate,
      Math.max(
        TIMELINE_LIMITS.minFrameRate,
        asInt(raw.frameRate, DEFAULT_TIMELINE_FRAME_RATE) || DEFAULT_TIMELINE_FRAME_RATE
      )
    ),
    tracks,
    clips: sortClips(clips),
    references
  }
}

/** 空卡片与坏 JSON 是两件事：前者是正常空态，后者要让用户看到“需要修数据”。 */
export function parseTimeline(text: string): TimelineParseResult {
  const trimmed = (text ?? '').trim()
  if (!trimmed) return { ok: true, data: createEmptyTimeline(), empty: true }
  let raw: unknown
  try {
    raw = JSON.parse(trimmed)
  } catch {
    return { ok: false, reason: '时间线数据不是合法 JSON' }
  }
  if (!isObject(raw) || (!Array.isArray(raw.tracks) && !Array.isArray(raw.clips))) {
    return { ok: false, reason: '时间线数据缺少 tracks/clips 字段' }
  }
  return { ok: true, data: normalizeTimeline(raw), empty: false }
}

export function serializeTimeline(data: TimelineData): string {
  return JSON.stringify(normalizeTimeline(data))
}

function sortClips(clips: TimelineClip[]): TimelineClip[] {
  return [...clips].sort((a, b) => a.startMs - b.startMs || a.id.localeCompare(b.id))
}

export function clipEndMs(clip: TimelineClip): number {
  return clip.startMs + clip.durationMs
}

/** 时间线总时长 = 所有片段末端的最大值（毫秒）。 */
export function timelineDurationMs(data: TimelineData): number {
  return data.clips.reduce((max, clip) => Math.max(max, clipEndMs(clip)), 0)
}

export function findTrack(data: TimelineData, trackId: string): TimelineTrack | undefined {
  return data.tracks.find((track) => track.id === trackId)
}

export function findClip(data: TimelineData, clipId: string): TimelineClip | undefined {
  return data.clips.find((clip) => clip.id === clipId)
}

export function clipsOfTrack(data: TimelineData, trackId: string): TimelineClip[] {
  return sortClips(data.clips.filter((clip) => clip.trackId === trackId))
}

/**
 * 同轨冲突检查：画面片段（视频/图片）不允许重叠；音频片段允许重叠（混音）。
 * 轨道本身不再区分类型，所以判定依据是「候选片段的种类」，不是轨道。
 */
export function overlappingClips(
  data: TimelineData,
  candidate: {
    trackId: string
    startMs: number
    durationMs: number
    kind?: TimelineClipKind
  },
  ignoreClipId?: string
): TimelineClip[] {
  if (!findTrack(data, candidate.trackId)) return []
  if (candidate.kind && !isVisualKind(candidate.kind)) return []
  const start = candidate.startMs
  const end = candidate.startMs + candidate.durationMs
  return data.clips.filter((clip) => {
    if (clip.trackId !== candidate.trackId) return false
    if (!isVisualKind(clip.kind)) return false
    if (ignoreClipId && clip.id === ignoreClipId) return false
    return clip.startMs < end && clipEndMs(clip) > start
  })
}

export type TimelineEditResult =
  | { ok: true; data: TimelineData; clipId?: string; trackId?: string }
  | { ok: false; reason: string }

// ── 轨道操作 ──

// ── 引用素材池 ──

/** 追加引用素材：按传入顺序去重，不产生片段。 */
export function addReferences(
  data: TimelineData,
  refs: TimelineReference[]
): TimelineEditResult {
  const existing = new Set(data.references.map((reference) => reference.mediaId))
  const next = [...data.references]
  for (const ref of refs) {
    if (next.length >= TIMELINE_LIMITS.maxReferences) break
    if (existing.has(ref.mediaId)) continue
    existing.add(ref.mediaId)
    next.push(ref)
  }
  if (next.length === data.references.length) return { ok: true, data }
  return { ok: true, data: { ...data, references: next } }
}

/** 移除一条引用素材（不影响已经在轨道上的片段）。 */
export function removeReference(data: TimelineData, mediaId: string): TimelineEditResult {
  if (!data.references.some((reference) => reference.mediaId === mediaId)) {
    return { ok: false, reason: '引用素材不存在' }
  }
  return {
    ok: true,
    data: {
      ...data,
      references: data.references.filter((reference) => reference.mediaId !== mediaId)
    }
  }
}

export function addTrack(data: TimelineData, name?: string): TimelineEditResult {
  if (data.tracks.length >= TIMELINE_LIMITS.maxTracks) {
    return { ok: false, reason: `最多 ${TIMELINE_LIMITS.maxTracks} 条轨道` }
  }
  const track: TimelineTrack = {
    id: timelineId('t'),
    name: name?.trim() || `轨道 ${data.tracks.length + 1}`,
    muted: false,
    locked: false,
    visible: true
  }
  return {
    ok: true,
    trackId: track.id,
    data: { ...data, tracks: [...data.tracks, track] }
  }
}

/**
 * 轨道拖动排序（2026-11-03）：把某条轨道移动到目标下标，片段跟着轨道走。
 * 用户预期是「轨道整体换位置」，不是把片段挤到别的轨道里。
 */
export function moveTrack(
  data: TimelineData,
  trackId: string,
  toIndex: number
): TimelineEditResult {
  const from = data.tracks.findIndex((track) => track.id === trackId)
  if (from < 0) return { ok: false, reason: '轨道不存在' }
  const index = Math.max(0, Math.min(data.tracks.length - 1, Math.round(toIndex)))
  if (index === from) return { ok: true, data }
  const tracks = [...data.tracks]
  const [moved] = tracks.splice(from, 1)
  tracks.splice(index, 0, moved)
  return { ok: true, trackId: moved.id, data: { ...data, tracks } }
}

export function removeTrack(data: TimelineData, trackId: string): TimelineEditResult {
  if (!findTrack(data, trackId)) return { ok: false, reason: '轨道不存在' }
  if (data.tracks.length <= 1) return { ok: false, reason: '至少保留一条轨道' }
  return {
    ok: true,
    data: {
      ...data,
      tracks: data.tracks.filter((track) => track.id !== trackId),
      clips: data.clips.filter((clip) => clip.trackId !== trackId)
    }
  }
}

export function updateTrack(
  data: TimelineData,
  trackId: string,
  patch: Partial<Pick<TimelineTrack, 'name' | 'muted' | 'locked' | 'visible'>>
): TimelineEditResult {
  if (!findTrack(data, trackId)) return { ok: false, reason: '轨道不存在' }
  return {
    ok: true,
    data: {
      ...data,
      tracks: data.tracks.map((track) => (track.id === trackId ? { ...track, ...patch } : track))
    }
  }
}

// ── 片段操作 ──

export interface AddClipInput {
  trackId: string
  kind: TimelineClipKind
  mediaId: string
  mediaPath: string
  name: string
  sourceDurationMs: number
  /** 缺省：视频/音频用源全长，图片用默认时长 */
  durationMs?: number
  /** 缺省：追加到该轨末端 */
  startMs?: number
  inMs?: number
}

/** 视频/音频在源尾被截断后、放上时间线的实际可用长度。 */
export function availableSourceMs(kind: TimelineClipKind, inMs: number, sourceDurationMs: number): number {
  if (kind === 'image') return Infinity
  if (sourceDurationMs <= 0) return Infinity
  return Math.max(0, sourceDurationMs - inMs)
}

export function addClip(data: TimelineData, input: AddClipInput): TimelineEditResult {
  if (data.clips.length >= TIMELINE_LIMITS.maxClips) {
    return { ok: false, reason: `最多 ${TIMELINE_LIMITS.maxClips} 个片段` }
  }
  const track = findTrack(data, input.trackId)
  if (!track) return { ok: false, reason: '目标轨道不存在' }
  const sourceDurationMs = Math.max(0, Math.round(input.sourceDurationMs))
  const inMs = Math.max(0, Math.round(input.inMs ?? 0))
  if (input.kind !== 'image' && sourceDurationMs > 0 && inMs >= sourceDurationMs) {
    return { ok: false, reason: '源内起点超出素材时长' }
  }
  const available = availableSourceMs(input.kind, inMs, sourceDurationMs)
  // 源时长未知（未探测到）时不能把片段长度算成 Infinity：给一个可编辑的占位长度，
  // 用户之后可以裁剪；探测到真实时长后 addClip 会按源尾截断。
  const fallbackMs = input.kind === 'image' ? TIMELINE_LIMITS.defaultImageClipMs : 5000
  const requested =
    input.durationMs ??
    (Number.isFinite(available) ? available : fallbackMs)
  const bounded = Number.isFinite(requested) ? requested : fallbackMs
  const durationMs = Math.max(
    TIMELINE_LIMITS.minClipMs,
    Math.round(Number.isFinite(available) ? Math.min(bounded, available) : bounded)
  )
  const startMs =
    input.startMs !== undefined
      ? Math.max(0, Math.round(input.startMs))
      : clipsOfTrack(data, input.trackId).reduce((end, clip) => Math.max(end, clipEndMs(clip)), 0)
  const clip: TimelineClip = {
    id: timelineId('c'),
    trackId: input.trackId,
    kind: input.kind,
    mediaId: input.mediaId.trim(),
    mediaPath: input.mediaPath.trim(),
    name: input.name.trim() || '素材',
    startMs,
    durationMs,
    inMs: input.kind === 'image' ? 0 : inMs,
    sourceDurationMs: input.kind === 'image' ? 0 : sourceDurationMs,
    volume: 1
  }
  if (overlappingClips(data, clip).length > 0) {
    return { ok: false, reason: '该位置已有片段，请拖到空格或换轨' }
  }
  return {
    ok: true,
    clipId: clip.id,
    data: { ...data, clips: sortClips([...data.clips, clip]) }
  }
}

/** 移动片段（可跨轨）。同轨重叠会被拒绝，调用方据此回弹。 */
export function moveClip(
  data: TimelineData,
  clipId: string,
  target: { trackId?: string; startMs: number }
): TimelineEditResult {
  const clip = findClip(data, clipId)
  if (!clip) return { ok: false, reason: '片段不存在' }
  const trackId = target.trackId ?? clip.trackId
  const track = findTrack(data, trackId)
  if (!track) return { ok: false, reason: '目标轨道不存在' }
  const startMs = Math.max(0, Math.round(target.startMs))
  if (
    overlappingClips(
      data,
      { trackId, startMs, durationMs: clip.durationMs, kind: clip.kind },
      clipId
    ).length > 0
  ) {
    return { ok: false, reason: '与同轨片段重叠' }
  }
  return {
    ok: true,
    clipId,
    data: {
      ...data,
      clips: sortClips(
        data.clips.map((item) => (item.id === clipId ? { ...item, trackId, startMs } : item))
      )
    }
  }
}

/** 裁剪：左边缘改变 inMs 与时长，右边缘只改时长。两端都被源素材夹住。 */
export function trimClip(
  data: TimelineData,
  clipId: string,
  edge: 'start' | 'end',
  timeMs: number
): TimelineEditResult {
  const clip = findClip(data, clipId)
  if (!clip) return { ok: false, reason: '片段不存在' }
  if (clip.kind === 'image') {
    // 图片没有源时长约束，只能拉长度，不能改变“源内起点”。
    if (edge === 'start') {
      const end = clipEndMs(clip)
      const nextStart = Math.max(0, Math.min(Math.round(timeMs), end - TIMELINE_LIMITS.minClipMs))
      return {
        ok: true,
        clipId,
        data: {
          ...data,
          clips: sortClips(
            data.clips.map((item) =>
              item.id === clipId
                ? { ...item, startMs: nextStart, durationMs: end - nextStart }
                : item
            )
          )
        }
      }
    }
    const durationMs = Math.max(
      TIMELINE_LIMITS.minClipMs,
      Math.round(timeMs) - clip.startMs
    )
    return {
      ok: true,
      clipId,
      data: {
        ...data,
        clips: sortClips(
          data.clips.map((item) => (item.id === clipId ? { ...item, durationMs } : item))
        )
      }
    }
  }
  const sourceRemain = availableSourceMs(clip.kind, clip.inMs, clip.sourceDurationMs)
  if (edge === 'start') {
    const end = clipEndMs(clip)
    const rawStart = Math.round(timeMs)
    // 左边缘向右最多拉到“保留最短片段”，向左最多回到源起点。
    const minStart = Math.max(0, clip.startMs - clip.inMs)
    const maxStart = end - TIMELINE_LIMITS.minClipMs
    const nextStart = Math.max(minStart, Math.min(rawStart, maxStart))
    const delta = nextStart - clip.startMs
    const nextIn = clip.inMs + delta
    const nextDuration = Math.max(
      TIMELINE_LIMITS.minClipMs,
      Math.min(end - nextStart, sourceRemain - delta)
    )
    return {
      ok: true,
      clipId,
      data: {
        ...data,
        clips: sortClips(
          data.clips.map((item) =>
            item.id === clipId
              ? { ...item, startMs: nextStart, inMs: nextIn, durationMs: nextDuration }
              : item
          )
        )
      }
    }
  }
  const rawEnd = Math.round(timeMs)
  const maxDuration = Math.min(rawEnd - clip.startMs, Number.isFinite(sourceRemain) ? sourceRemain : Infinity)
  const durationMs = Math.max(TIMELINE_LIMITS.minClipMs, maxDuration)
  return {
    ok: true,
    clipId,
    data: {
      ...data,
      clips: sortClips(
        data.clips.map((item) => (item.id === clipId ? { ...item, durationMs } : item))
      )
    }
  }
}

/**
 * 在播放头处分割。分割点必须落在片段内部（留出最小片段长度），
 * 两段共享同一 mediaId，靠不同的 inMs 指向各自源区间。
 */
export function splitClip(data: TimelineData, clipId: string, atMs: number): TimelineEditResult {
  const clip = findClip(data, clipId)
  if (!clip) return { ok: false, reason: '片段不存在' }
  const offset = Math.round(atMs) - clip.startMs
  if (offset < TIMELINE_LIMITS.minClipMs || clip.durationMs - offset < TIMELINE_LIMITS.minClipMs) {
    return { ok: false, reason: '分割点太靠近片段边缘' }
  }
  const left: TimelineClip = { ...clip, durationMs: offset }
  const right: TimelineClip = {
    ...clip,
    id: timelineId('c'),
    startMs: clip.startMs + offset,
    durationMs: clip.durationMs - offset,
    inMs: clip.kind === 'image' ? 0 : clip.inMs + offset
  }
  return {
    ok: true,
    clipId: right.id,
    data: {
      ...data,
      clips: sortClips(data.clips.flatMap((item) => (item.id === clipId ? [left, right] : [item])))
    }
  }
}

/**
 * 分割并删掉一侧（2026-11-03 用户裁决，剪映三态分割）：
 * - keep='left'（向左分割）：保留切点左边的片段，右边删掉；
 * - keep='right'（向右分割）：保留切点右边的片段，左边删掉。
 * 与普通 splitClip（两边都留）共用同一套边界校验。
 */
export function splitClipKeep(
  data: TimelineData,
  clipId: string,
  atMs: number,
  keep: 'left' | 'right'
): TimelineEditResult {
  const clip = findClip(data, clipId)
  if (!clip) return { ok: false, reason: '片段不存在' }
  const offset = Math.round(atMs) - clip.startMs
  if (offset < TIMELINE_LIMITS.minClipMs) return { ok: false, reason: '切点太靠近片段起点' }
  if (clip.durationMs - offset < TIMELINE_LIMITS.minClipMs) {
    return { ok: false, reason: '切点太靠近片段终点' }
  }
  const kept: TimelineClip =
    keep === 'left'
      ? { ...clip, durationMs: offset }
      : {
          ...clip,
          startMs: clip.startMs + offset,
          durationMs: clip.durationMs - offset,
          inMs: clip.kind === 'image' ? 0 : clip.inMs + offset
        }
  return {
    ok: true,
    clipId: kept.id,
    data: {
      ...data,
      clips: sortClips(data.clips.map((item) => (item.id === clipId ? kept : item)))
    }
  }
}

export function removeClip(data: TimelineData, clipId: string): TimelineEditResult {
  if (!findClip(data, clipId)) return { ok: false, reason: '片段不存在' }
  return { ok: true, data: { ...data, clips: data.clips.filter((clip) => clip.id !== clipId) } }
}

/** 找到播放头所在位置的片段（用于“分割”按钮的默认目标）。 */
export function clipAtTime(
  data: TimelineData,
  trackId: string,
  timeMs: number
): TimelineClip | undefined {
  return clipsOfTrack(data, trackId).find(
    (clip) => timeMs > clip.startMs && timeMs < clipEndMs(clip)
  )
}

/** 时间码：时间线刻度用 mm:ss；不足一小时不显示小时位。 */
export function formatTimecode(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000))
  const minutes = Math.floor(total / 60)
  const seconds = total % 60
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`
}

/** 刻度步长：按缩放级别选一个“整”间隔，避免刻度标签挤在一起。 */
export function rulerStepMs(pixelsPerSecond: number, minLabelPx = 72): number {
  const candidates = [500, 1000, 2000, 5000, 10000, 15000, 30000, 60000, 120000, 300000]
  const perMs = pixelsPerSecond / 1000
  return candidates.find((step) => step * perMs >= minLabelPx) ?? candidates[candidates.length - 1]
}

/** 片段 kind → 端口/媒体类型，做连线与素材校验时共用。 */
export function clipPortType(kind: TimelineClipKind): PortType {
  return kind === 'image' ? 'image' : kind === 'audio' ? 'audio' : 'video'
}

/** 统计：给卡片摘要与执行器日志用，不参与业务判断。 */
export function timelineSummary(data: TimelineData): {
  trackCount: number
  clipCount: number
  durationMs: number
} {
  return {
    trackCount: data.tracks.length,
    clipCount: data.clips.length,
    durationMs: timelineDurationMs(data)
  }
}
