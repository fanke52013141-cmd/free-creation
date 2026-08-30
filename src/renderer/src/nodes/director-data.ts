// 导演台的纯数据协议。UI、节点投影、执行器共用，避免把导演工程结构散落在组件里。
export interface DirectorCamera {
  /** Stable camera identity. A shot owns one active camera in v2; the sequence owns the cut order. */
  id: string
  name: string
  x: number
  y: number
  z: number
  heading: number
  pitch: number
  focalLengthMm: number
  aspectRatio: '16:9' | '9:16' | '4:3' | '3:4'
  durationSec: number
  fps: 24 | 25 | 30
  /** Optional target used by the simple follow / look-at presets. */
  targetActorId?: string
  followActorId?: string
}

export interface DirectorActor {
  id: string
  name: string
  pose: '站立' | '行走' | '坐姿' | '招手' | '奔跑'
  x: number
  y: number
  /** 3D 白模的纵深位置；2D 预演忽略此字段。 */
  z: number
  scale: number
  color: string
  /** Ground-plane facing direction; optional for v1 project compatibility. */
  heading?: number
}

/** 2D 预演构图辅助；仅影响工作区观察，不会伪装为场景或媒体资产。 */
export interface DirectorGuides {
  thirds: boolean
  safeFrame: boolean
  eyeline: boolean
}

export interface DirectorKeyframe<T> {
  timeSec: number
  value: T
  easing?: 'linear' | 'smooth'
}

export type DirectorCameraMotion = Pick<
  DirectorCamera,
  'x' | 'y' | 'z' | 'heading' | 'pitch' | 'focalLengthMm'
>
export type DirectorActorMotion = Pick<
  DirectorActor,
  'x' | 'y' | 'z' | 'scale' | 'pose' | 'heading'
>

/** 镜头动画仅描述可随时间变化的空间参数；画幅、帧率和时长仍属于镜头固定配置。 */
export interface DirectorShotTimeline {
  version: 1
  camera: DirectorKeyframe<DirectorCameraMotion>[]
  actors: Record<string, DirectorKeyframe<DirectorActorMotion>[]>
}

export type DirectorSpaceStatus = 'empty' | 'generating' | 'ready' | 'failed'
/**
 * local-whitebox is the default low-cost blockout. image-depth is a local 2.5D backdrop
 * that derives an approximate depth field from the source image luminance. provider-whitebox
 * remains reserved for an optional external adapter and is never required by the editor.
 */
export type DirectorSpaceMode = 'manual' | 'local-whitebox' | 'image-depth' | 'provider-whitebox'
export type DirectorDepthSource = 'none' | 'heuristic-luminance' | 'estimated'

/**
 * A deliberately small, portable whitebox description. We retain primitives instead of serialising
 * a binary 3D file so the project stays inspectable, versionable and safe to pass through a node port.
 */
export interface DirectorWhiteboxPrimitive {
  id: string
  kind: 'wall' | 'box' | 'platform'
  x: number
  y: number
  z: number
  width: number
  height: number
  depth: number
}

export interface DirectorSpace {
  id: string
  status: DirectorSpaceStatus
  mode: DirectorSpaceMode
  sourceMediaIds: string[]
  sourceMediaPaths: string[]
  /** Primary image used by the local 2.5D backdrop. Kept optional for v1/v2 whitebox projects. */
  backgroundMediaId?: string
  backgroundMediaPath?: string
  /** A future persisted depth-map asset can be attached without changing the node contract. */
  depthMediaId?: string
  depthMediaPath?: string
  depthSource?: DirectorDepthSource
  /** 0..1 visual displacement amount for image-depth mode. */
  parallaxStrength?: number
  message?: string
  primitives: DirectorWhiteboxPrimitive[]
}

/** A sequence is intentionally only a list of hard cuts. It is not a video editor or compositor. */
export interface DirectorSequenceCut {
  id: string
  shotId: string
  durationSec: number
}

export interface DirectorShot {
  id: string
  name: string
  scene: string
  dialogue: string
  referenceMediaIds: string[]
  referenceMediaPaths: string[]
  /** 参考图只作为工作区叠加，不会被写入正式帧/视频。 */
  referenceOpacity: number
  guides: DirectorGuides
  timeline: DirectorShotTimeline
  camera: DirectorCamera
  actors: DirectorActor[]
}

export interface DirectorProjectData {
  version: 2
  /** 会影响已发布画面/机位的工程修订号。 */
  revision: number
  activeShotId: string
  shots: DirectorShot[]
  space: DirectorSpace
  sequence: {
    version: 1
    cuts: DirectorSequenceCut[]
  }
}

export interface DirectorAssetRef {
  mediaId: string
  mediaPath: string
  mime: string
}

export interface DirectorPublishRecord {
  kind: 'director-publish'
  version: 1
  publishedAt: number
  /** 发布时导演工程的语义修订号。 */
  projectRevision: number
  shotId: string
  frame?: DirectorAssetRef
  video?: DirectorAssetRef
  camera: DirectorCamera
}

export function createDirectorId(prefix: string): string {
  return `${prefix}-${Math.random().toString(36).slice(2, 9)}`
}

export function defaultDirectorCamera(): DirectorCamera {
  return {
    id: createDirectorId('camera'),
    name: '机位 A',
    x: 0,
    y: 1.6,
    z: 5,
    heading: 0,
    pitch: 0,
    focalLengthMm: 35,
    aspectRatio: '16:9',
    durationSec: 5,
    fps: 25
  }
}

export function createEmptyDirectorSpace(): DirectorSpace {
  return {
    id: createDirectorId('space'),
    status: 'empty',
    mode: 'manual',
    sourceMediaIds: [],
    sourceMediaPaths: [],
    primitives: []
  }
}

/**
 * A local, deterministic fallback used when an external image-to-space provider is unavailable.
 * It intentionally produces a light-weight spatial blockout, never claims to be an AI reconstruction.
 */
export function createLocalWhiteboxSpace(
  sourceMediaIds: string[],
  sourceMediaPaths: string[]
): DirectorSpace {
  const room = sourceMediaIds.length > 0
  const primitives: DirectorWhiteboxPrimitive[] = room
    ? [
        {
          id: createDirectorId('wall'),
          kind: 'wall',
          x: 0,
          y: 1.5,
          z: -7,
          width: 14,
          height: 3,
          depth: 0.25
        },
        {
          id: createDirectorId('wall'),
          kind: 'wall',
          x: -7,
          y: 1.5,
          z: 0,
          width: 0.25,
          height: 3,
          depth: 14
        },
        {
          id: createDirectorId('wall'),
          kind: 'wall',
          x: 7,
          y: 1.5,
          z: 0,
          width: 0.25,
          height: 3,
          depth: 14
        },
        {
          id: createDirectorId('box'),
          kind: 'box',
          x: -2.4,
          y: 0.55,
          z: -1.6,
          width: 1.8,
          height: 1.1,
          depth: 1.2
        }
      ]
    : []
  return {
    id: createDirectorId('space'),
    status: 'ready',
    mode: 'local-whitebox',
    sourceMediaIds,
    sourceMediaPaths,
    message: room
      ? '已依据连接的参考图建立本地白模。接入空间生成服务后可替换为自动重建结果。'
      : '当前为空白预演空间；可直接布置人物和机位。',
    primitives
  }
}

/**
 * Build a local 2.5D stage from one real image. No network call or model is required: the
 * viewport samples luminance as an approximate depth field and applies a restrained parallax.
 * The shape stores the source media reference so projects remain portable and inspectable.
 */
export function createImageDepthSpace(
  sourceMediaId: string,
  sourceMediaPath: string,
  parallaxStrength = 0.28
): DirectorSpace {
  const hasSource = Boolean(sourceMediaId || sourceMediaPath)
  const clampedStrength = Math.max(
    0,
    Math.min(1, Number.isFinite(parallaxStrength) ? parallaxStrength : 0.28)
  )
  return {
    id: createDirectorId('space'),
    status: hasSource ? 'ready' : 'failed',
    mode: 'image-depth',
    sourceMediaIds: sourceMediaId ? [sourceMediaId] : [],
    sourceMediaPaths: sourceMediaPath ? [sourceMediaPath] : [],
    ...(sourceMediaId ? { backgroundMediaId: sourceMediaId } : {}),
    ...(sourceMediaPath ? { backgroundMediaPath: sourceMediaPath } : {}),
    depthSource: 'heuristic-luminance',
    parallaxStrength: clampedStrength,
    message: hasSource
      ? '已建立本地图片视差空间；深度由图像亮度近似，不产生额外费用。'
      : '图片视差空间缺少参考图，请先连接一个图片节点。',
    primitives: []
  }
}

/** 统一焦段到预演透视相机 FOV 的换算，2D/3D 预演和发布共用这一语义。 */
export function directorCameraFov(focalLengthMm: number): number {
  return Math.max(18, Math.min(85, 50 - (focalLengthMm - 35) * 0.45))
}

/** 根据导演机位的方位与俯仰计算注视点，避免预演和发布使用不同朝向。 */
export function directorCameraTarget(
  camera: DirectorCamera,
  distance = 8
): [number, number, number] {
  const heading = (camera.heading * Math.PI) / 180
  const pitch = (camera.pitch * Math.PI) / 180
  return [
    camera.x + Math.sin(heading) * Math.cos(pitch) * distance,
    camera.y + Math.sin(pitch) * distance,
    camera.z - Math.cos(heading) * Math.cos(pitch) * distance
  ]
}

function emptyDirectorTimeline(): DirectorShotTimeline {
  return { version: 1, camera: [], actors: {} }
}

export function createDirectorShot(name = '镜头 01'): DirectorShot {
  return {
    id: createDirectorId('shot'),
    name,
    scene: '',
    dialogue: '',
    referenceMediaIds: [],
    referenceMediaPaths: [],
    referenceOpacity: 0.42,
    guides: { thirds: true, safeFrame: true, eyeline: true },
    timeline: emptyDirectorTimeline(),
    camera: defaultDirectorCamera(),
    actors: [
      {
        id: createDirectorId('actor'),
        name: '角色 01',
        pose: '站立',
        x: 50,
        y: 62,
        z: 0,
        scale: 1,
        color: '#76d7ea',
        heading: 0
      }
    ]
  }
}

function normalizeGuides(value: unknown): DirectorGuides {
  const source = value && typeof value === 'object' ? (value as Partial<DirectorGuides>) : {}
  return {
    thirds: source.thirds !== false,
    safeFrame: source.safeFrame !== false,
    eyeline: source.eyeline !== false
  }
}

function isDirectorActor(value: unknown): value is DirectorActor {
  if (!value || typeof value !== 'object') return false
  const actor = value as Record<string, unknown>
  return (
    typeof actor.id === 'string' &&
    typeof actor.name === 'string' &&
    (actor.pose === '站立' ||
      actor.pose === '行走' ||
      actor.pose === '坐姿' ||
      actor.pose === '招手' ||
      actor.pose === '奔跑') &&
    ['x', 'y', 'z', 'scale'].every(
      (key) => typeof actor[key] === 'number' && Number.isFinite(actor[key])
    ) &&
    typeof actor.color === 'string'
  )
}

function normalizeDirectorActor(actor: DirectorActor): DirectorActor {
  return {
    ...actor,
    heading: typeof actor.heading === 'number' && Number.isFinite(actor.heading) ? actor.heading : 0
  }
}

function isKeyframe<T>(
  value: unknown,
  isValue: (item: unknown) => item is T
): value is DirectorKeyframe<T> {
  if (!value || typeof value !== 'object') return false
  const frame = value as Partial<DirectorKeyframe<T>>
  return typeof frame.timeSec === 'number' && Number.isFinite(frame.timeSec) && isValue(frame.value)
}

function isCameraMotion(value: unknown): value is DirectorCameraMotion {
  if (!value || typeof value !== 'object') return false
  const motion = value as Record<string, unknown>
  return ['x', 'y', 'z', 'heading', 'pitch', 'focalLengthMm'].every(
    (key) => typeof motion[key] === 'number' && Number.isFinite(motion[key])
  )
}

function isActorMotion(value: unknown): value is DirectorActorMotion {
  if (!value || typeof value !== 'object') return false
  const motion = value as Record<string, unknown>
  return (
    ['x', 'y', 'z', 'scale'].every(
      (key) => typeof motion[key] === 'number' && Number.isFinite(motion[key])
    ) &&
    (motion.pose === '站立' ||
      motion.pose === '行走' ||
      motion.pose === '坐姿' ||
      motion.pose === '招手' ||
      motion.pose === '奔跑')
  )
}

function isTimeline(value: unknown): value is DirectorShotTimeline {
  if (!value || typeof value !== 'object') return false
  const timeline = value as Partial<DirectorShotTimeline>
  return (
    timeline.version === 1 &&
    Array.isArray(timeline.camera) &&
    timeline.camera.every((frame) => isKeyframe(frame, isCameraMotion)) &&
    Boolean(timeline.actors) &&
    typeof timeline.actors === 'object' &&
    Object.values(timeline.actors).every(
      (frames) => Array.isArray(frames) && frames.every((frame) => isKeyframe(frame, isActorMotion))
    )
  )
}

function normalizeDirectorShot(value: unknown): DirectorShot | null {
  if (!value || typeof value !== 'object') return null
  const shot = value as Partial<DirectorShot>
  if (
    typeof shot.id !== 'string' ||
    typeof shot.name !== 'string' ||
    typeof shot.scene !== 'string' ||
    typeof shot.dialogue !== 'string' ||
    !Array.isArray(shot.referenceMediaIds) ||
    !Array.isArray(shot.referenceMediaPaths) ||
    !Array.isArray(shot.actors) ||
    shot.actors.length === 0 ||
    !shot.actors.every(isDirectorActor) ||
    !isTimeline(shot.timeline) ||
    !isCamera(shot.camera)
  ) {
    return null
  }
  const camera = normalizeDirectorCamera(shot.camera)
  if (!camera) return null
  return {
    id: shot.id,
    name: shot.name,
    scene: shot.scene,
    dialogue: shot.dialogue,
    referenceMediaIds: shot.referenceMediaIds,
    referenceMediaPaths: shot.referenceMediaPaths,
    referenceOpacity:
      typeof shot.referenceOpacity === 'number' && Number.isFinite(shot.referenceOpacity)
        ? Math.max(0, Math.min(1, shot.referenceOpacity))
        : 0.42,
    guides: normalizeGuides(shot.guides),
    timeline: shot.timeline,
    camera,
    actors: shot.actors.map(normalizeDirectorActor)
  }
}

export function createDirectorProject(): DirectorProjectData {
  const shot = createDirectorShot()
  return {
    version: 2,
    revision: 1,
    activeShotId: shot.id,
    shots: [shot],
    space: createEmptyDirectorSpace(),
    sequence: {
      version: 1,
      cuts: [{ id: createDirectorId('cut'), shotId: shot.id, durationSec: shot.camera.durationSec }]
    }
  }
}

/** 仅镜头选择等不改变画面内容的 UI 状态不应使已发布媒体失效。 */
export function nextDirectorProjectRevision(
  previous: DirectorProjectData,
  next: Omit<DirectorProjectData, 'revision'>,
  affectsPublish = true
): DirectorProjectData {
  return { ...next, revision: affectsPublish ? previous.revision + 1 : previous.revision }
}

function isCamera(value: unknown): value is DirectorCamera {
  if (!value || typeof value !== 'object') return false
  const v = value as Record<string, unknown>
  const numeric = ['x', 'y', 'z', 'heading', 'pitch', 'focalLengthMm', 'durationSec']
  return (
    numeric.every((key) => typeof v[key] === 'number' && Number.isFinite(v[key])) &&
    (v.aspectRatio === '16:9' ||
      v.aspectRatio === '9:16' ||
      v.aspectRatio === '4:3' ||
      v.aspectRatio === '3:4') &&
    (v.fps === 24 || v.fps === 25 || v.fps === 30)
  )
}

function normalizeDirectorCamera(
  value: unknown,
  fallback = defaultDirectorCamera()
): DirectorCamera | null {
  if (!isCamera(value)) return null
  const camera = value as Partial<DirectorCamera>
  return {
    ...fallback,
    ...camera,
    id: typeof camera.id === 'string' && camera.id ? camera.id : fallback.id,
    name: typeof camera.name === 'string' && camera.name ? camera.name : fallback.name,
    ...(typeof camera.targetActorId === 'string' ? { targetActorId: camera.targetActorId } : {}),
    ...(typeof camera.followActorId === 'string' ? { followActorId: camera.followActorId } : {})
  }
}

function normalizedTimelineTime(timeSec: number, durationSec: number): number {
  return Math.round(Math.max(0, Math.min(durationSec, timeSec)) * 1000) / 1000
}

function upsertKeyframe<T>(
  frames: DirectorKeyframe<T>[],
  frame: DirectorKeyframe<T>
): DirectorKeyframe<T>[] {
  const index = frames.findIndex((item) => item.timeSec === frame.timeSec)
  const next = [...frames]
  if (index >= 0) next[index] = frame
  else next.push(frame)
  return next.sort((left, right) => left.timeSec - right.timeSec)
}

export function recordDirectorCameraKeyframe(shot: DirectorShot, timeSec: number): DirectorShot {
  const time = normalizedTimelineTime(timeSec, shot.camera.durationSec)
  const { x, y, z, heading, pitch, focalLengthMm } = shot.camera
  return {
    ...shot,
    timeline: {
      ...shot.timeline,
      camera: upsertKeyframe(shot.timeline.camera, {
        timeSec: time,
        value: { x, y, z, heading, pitch, focalLengthMm }
      })
    }
  }
}

export function recordDirectorActorKeyframe(
  shot: DirectorShot,
  actorId: string,
  timeSec: number
): DirectorShot {
  const actor = shot.actors.find((item) => item.id === actorId)
  if (!actor) return shot
  const time = normalizedTimelineTime(timeSec, shot.camera.durationSec)
  const { x, y, z, scale, pose, heading = 0 } = actor
  return {
    ...shot,
    timeline: {
      ...shot.timeline,
      actors: {
        ...shot.timeline.actors,
        [actorId]: upsertKeyframe(shot.timeline.actors[actorId] ?? [], {
          timeSec: time,
          value: { x, y, z, scale, pose, heading }
        })
      }
    }
  }
}

function interpolateNumber(left: number, right: number, progress: number): number {
  return left + (right - left) * progress
}

function evaluateMotion<T extends Record<string, unknown>>(
  base: T,
  frames: DirectorKeyframe<T>[],
  timeSec: number,
  numericKeys: (keyof T)[]
): T {
  const sorted = [...frames].sort((left, right) => left.timeSec - right.timeSec)
  const previous = [...sorted].reverse().find((frame) => frame.timeSec <= timeSec)
  const next = sorted.find((frame) => frame.timeSec >= timeSec)
  if (!previous && !next) return base
  if (!previous) return { ...base, ...next!.value }
  if (!next || next.timeSec === previous.timeSec) return { ...base, ...previous.value }
  const rawProgress = (timeSec - previous.timeSec) / (next.timeSec - previous.timeSec)
  // Keyframes default to smooth movement. Explicit linear is useful for mechanical blocking.
  const progress =
    (next.easing ?? 'smooth') === 'smooth'
      ? rawProgress * rawProgress * (3 - 2 * rawProgress)
      : rawProgress
  const value = { ...base, ...previous.value }
  for (const key of numericKeys) {
    const left = previous.value[key]
    const right = next.value[key]
    if (typeof left === 'number' && typeof right === 'number') {
      value[key] = interpolateNumber(left, right, progress) as T[keyof T]
    }
  }
  return value
}

/** 预演和导出唯一使用的时间采样函数，保证同一时刻画面与发布机位一致。 */
export function evaluateDirectorShot(shot: DirectorShot, timeSec: number): DirectorShot {
  const time = normalizedTimelineTime(timeSec, shot.camera.durationSec)
  const camera = evaluateMotion<DirectorCameraMotion>(shot.camera, shot.timeline.camera, time, [
    'x',
    'y',
    'z',
    'heading',
    'pitch',
    'focalLengthMm'
  ])
  return {
    ...shot,
    camera: { ...shot.camera, ...camera },
    actors: shot.actors.map((actor) => ({
      ...actor,
      ...evaluateMotion<DirectorActorMotion>(actor, shot.timeline.actors[actor.id] ?? [], time, [
        'x',
        'y',
        'z',
        'scale',
        'heading'
      ])
    }))
  }
}

function normalizeDirectorSpace(value: unknown): DirectorSpace {
  const empty = createEmptyDirectorSpace()
  if (!value || typeof value !== 'object' || Array.isArray(value)) return empty
  const raw = value as Partial<DirectorSpace>
  const primitives = Array.isArray(raw.primitives)
    ? raw.primitives.filter((item): item is DirectorWhiteboxPrimitive => {
        if (!item || typeof item !== 'object') return false
        const candidate = item as Partial<DirectorWhiteboxPrimitive>
        return (
          typeof candidate.id === 'string' &&
          (candidate.kind === 'wall' ||
            candidate.kind === 'box' ||
            candidate.kind === 'platform') &&
          ['x', 'y', 'z', 'width', 'height', 'depth'].every(
            (key) => typeof candidate[key as keyof DirectorWhiteboxPrimitive] === 'number'
          )
        )
      })
    : []
  const status: DirectorSpaceStatus =
    raw.status === 'generating' || raw.status === 'ready' || raw.status === 'failed'
      ? raw.status
      : 'empty'
  return {
    id: typeof raw.id === 'string' && raw.id ? raw.id : empty.id,
    status,
    mode:
      raw.mode === 'local-whitebox' ||
      raw.mode === 'image-depth' ||
      raw.mode === 'provider-whitebox'
        ? raw.mode
        : 'manual',
    sourceMediaIds: Array.isArray(raw.sourceMediaIds)
      ? raw.sourceMediaIds.filter((item): item is string => typeof item === 'string')
      : [],
    sourceMediaPaths: Array.isArray(raw.sourceMediaPaths)
      ? raw.sourceMediaPaths.filter((item): item is string => typeof item === 'string')
      : [],
    ...(typeof raw.backgroundMediaId === 'string' && raw.backgroundMediaId
      ? { backgroundMediaId: raw.backgroundMediaId }
      : {}),
    ...(typeof raw.backgroundMediaPath === 'string' && raw.backgroundMediaPath
      ? { backgroundMediaPath: raw.backgroundMediaPath }
      : {}),
    ...(typeof raw.depthMediaId === 'string' && raw.depthMediaId
      ? { depthMediaId: raw.depthMediaId }
      : {}),
    ...(typeof raw.depthMediaPath === 'string' && raw.depthMediaPath
      ? { depthMediaPath: raw.depthMediaPath }
      : {}),
    ...(raw.depthSource === 'heuristic-luminance' || raw.depthSource === 'estimated'
      ? { depthSource: raw.depthSource }
      : {}),
    ...(typeof raw.parallaxStrength === 'number' && Number.isFinite(raw.parallaxStrength)
      ? { parallaxStrength: Math.max(0, Math.min(1, raw.parallaxStrength)) }
      : {}),
    ...(typeof raw.message === 'string' ? { message: raw.message } : {}),
    primitives
  }
}

function normalizeDirectorSequence(
  value: unknown,
  shots: DirectorShot[]
): DirectorProjectData['sequence'] {
  const fallback = {
    version: 1 as const,
    cuts: shots.map((shot) => ({
      id: createDirectorId('cut'),
      shotId: shot.id,
      durationSec: shot.camera.durationSec
    }))
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return fallback
  const raw = value as Partial<DirectorProjectData['sequence']>
  if (raw.version !== 1 || !Array.isArray(raw.cuts)) return fallback
  const seen = new Set<string>()
  const cuts = raw.cuts.filter((cut): cut is DirectorSequenceCut => {
    if (!cut || typeof cut !== 'object' || seen.has(cut.shotId)) return false
    if (!shots.some((shot) => shot.id === cut.shotId)) return false
    if (
      typeof cut.id !== 'string' ||
      typeof cut.durationSec !== 'number' ||
      !Number.isFinite(cut.durationSec)
    ) {
      return false
    }
    seen.add(cut.shotId)
    return true
  })
  for (const shot of shots) {
    if (!seen.has(shot.id)) {
      cuts.push({
        id: createDirectorId('cut'),
        shotId: shot.id,
        durationSec: shot.camera.durationSec
      })
    }
  }
  return { version: 1, cuts }
}

export function parseDirectorProject(text: string): DirectorProjectData {
  if (!text) return createDirectorProject()
  try {
    const raw = JSON.parse(text) as {
      version?: number
      revision?: unknown
      activeShotId?: unknown
      shots?: unknown[]
      space?: unknown
      sequence?: unknown
    }
    if (
      (raw.version !== 1 && raw.version !== 2) ||
      !Array.isArray(raw.shots) ||
      raw.shots.length === 0
    ) {
      return createDirectorProject()
    }
    const shots = raw.shots
      .map(normalizeDirectorShot)
      .filter((shot): shot is DirectorShot => Boolean(shot))
    if (shots.length === 0) return createDirectorProject()
    const activeShotId = shots.some((shot) => shot.id === raw.activeShotId)
      ? (raw.activeShotId as string)
      : shots[0].id
    return {
      version: 2,
      revision:
        typeof raw.revision === 'number' && Number.isInteger(raw.revision) && raw.revision > 0
          ? raw.revision
          : 1,
      activeShotId,
      shots,
      space: normalizeDirectorSpace(raw.space),
      sequence: normalizeDirectorSequence(raw.sequence, shots)
    }
  } catch {
    return createDirectorProject()
  }
}

/** 移动镜头顺序，顺序本身属于可发布工程数据。 */
export function moveDirectorShot(
  shots: DirectorShot[],
  shotId: string,
  offset: -1 | 1
): DirectorShot[] {
  const index = shots.findIndex((shot) => shot.id === shotId)
  const target = index + offset
  if (index < 0 || target < 0 || target >= shots.length) return shots
  const next = [...shots]
  ;[next[index], next[target]] = [next[target], next[index]]
  return next
}

/** 删除后自动选择相邻镜头；最后一个镜头不可删除，避免工程成为无效状态。 */
export function removeDirectorShot(
  project: DirectorProjectData,
  shotId: string
): Omit<DirectorProjectData, 'revision'> | null {
  if (project.shots.length <= 1) return null
  const index = project.shots.findIndex((shot) => shot.id === shotId)
  if (index < 0) return null
  const shots = project.shots.filter((shot) => shot.id !== shotId)
  const activeShotId =
    project.activeShotId === shotId
      ? (shots[Math.min(index, shots.length - 1)]?.id ?? shots[0].id)
      : project.activeShotId
  return {
    version: 2,
    activeShotId,
    shots,
    space: project.space,
    sequence: normalizeDirectorSequence(
      { version: 1, cuts: project.sequence.cuts.filter((cut) => cut.shotId !== shotId) },
      shots
    )
  }
}

/** Keep the simple hard-cut sequence in the same order as its visual shot list. */
export function syncDirectorSequence(
  project: DirectorProjectData
): DirectorProjectData['sequence'] {
  const previous = new Map(project.sequence.cuts.map((cut) => [cut.shotId, cut]))
  return {
    version: 1,
    cuts: project.shots.map((shot) => {
      const cut = previous.get(shot.id)
      return {
        id: cut?.id ?? createDirectorId('cut'),
        shotId: shot.id,
        durationSec: Math.max(1, Math.min(30, cut?.durationSec ?? shot.camera.durationSec))
      }
    })
  }
}

export function directorSequenceDuration(project: DirectorProjectData): number {
  return project.sequence.cuts.reduce((total, cut) => total + cut.durationSec, 0)
}

/**
 * Helpful, non-blocking previs warnings. This is deliberately simple AABB checking, not a physics
 * simulation: users get actionable feedback without turning the stage into a complex 3D package.
 */
export function directorShotWarnings(project: DirectorProjectData, shot: DirectorShot): string[] {
  const warnings: string[] = []
  if (shot.camera.durationSec > 12)
    warnings.push('当前镜头超过 12 秒，建议拆分以提高视频模型跟随度。')
  const tracks = [shot.timeline.camera, ...Object.values(shot.timeline.actors)]
  if (
    tracks.some((frames) =>
      frames.some((frame, index) => index >= 6 && frame.timeSec - frames[index - 6]!.timeSec < 1)
    )
  ) {
    warnings.push('1 秒内关键帧过密，运动可能出现抖动。')
  }
  for (const actor of shot.actors) {
    const x = (actor.x - 50) / 10
    const z = (actor.z + actor.y - 62) / 10
    const blocked = project.space.primitives.some(
      (primitive) =>
        primitive.kind !== 'platform' &&
        Math.abs(x - primitive.x) < primitive.width / 2 + 0.28 &&
        Math.abs(z - primitive.z) < primitive.depth / 2 + 0.28
    )
    if (blocked) warnings.push(`${actor.name} 位于白模障碍物内，请调整人物或路线。`)
  }
  return warnings
}

export function parseDirectorPublishRecord(value: unknown): DirectorPublishRecord | null {
  if (!value || typeof value !== 'object') return null
  const raw = value as Partial<DirectorPublishRecord>
  if (
    raw.kind !== 'director-publish' ||
    raw.version !== 1 ||
    typeof raw.publishedAt !== 'number' ||
    typeof raw.projectRevision !== 'number' ||
    !Number.isInteger(raw.projectRevision) ||
    raw.projectRevision < 1 ||
    typeof raw.shotId !== 'string' ||
    !isCamera(raw.camera)
  ) {
    return null
  }
  const asset = (item: unknown): DirectorAssetRef | undefined => {
    if (!item || typeof item !== 'object') return undefined
    const value = item as Partial<DirectorAssetRef>
    return typeof value.mediaId === 'string' &&
      typeof value.mediaPath === 'string' &&
      typeof value.mime === 'string'
      ? { mediaId: value.mediaId, mediaPath: value.mediaPath, mime: value.mime }
      : undefined
  }
  const frame = asset(raw.frame)
  const video = asset(raw.video)
  if (!frame && !video) return null
  return {
    kind: 'director-publish',
    version: 1,
    publishedAt: raw.publishedAt,
    projectRevision: raw.projectRevision,
    shotId: raw.shotId,
    ...(frame ? { frame } : {}),
    ...(video ? { video } : {}),
    camera: raw.camera
  }
}

/** 旧发布记录可留作诊断，但只有当前工程修订的记录才能成为下游输出。 */
export function isDirectorPublishCurrent(
  project: DirectorProjectData,
  publish: DirectorPublishRecord | null
): publish is DirectorPublishRecord {
  return Boolean(publish && publish.projectRevision === project.revision)
}

/**
 * 手动发布的唯一合成规则：只允许在同一镜头、同一工程修订内补充另一种媒体。
 * 因而“镜头 A 的帧 + 镜头 B 的视频”永远不能成为同一份正式发布记录。
 */
export function createDirectorPublishRecord(
  project: DirectorProjectData,
  shot: DirectorShot,
  previous: DirectorPublishRecord | null,
  patch: Pick<DirectorPublishRecord, 'frame' | 'video'>,
  publishedAt = Date.now()
): DirectorPublishRecord {
  const canRetainMedia = isDirectorPublishCurrent(project, previous) && previous.shotId === shot.id
  return {
    kind: 'director-publish',
    version: 1,
    publishedAt,
    projectRevision: project.revision,
    shotId: shot.id,
    ...(canRetainMedia
      ? {
          ...(previous.frame ? { frame: previous.frame } : {}),
          ...(previous.video ? { video: previous.video } : {})
        }
      : {}),
    ...patch,
    camera: shot.camera
  }
}
