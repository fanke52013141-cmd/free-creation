// 导演台的纯数据协议。UI、节点投影、执行器共用，避免把导演工程结构散落在组件里。
export interface DirectorCamera {
  x: number
  y: number
  z: number
  heading: number
  pitch: number
  focalLengthMm: number
  aspectRatio: '16:9' | '9:16' | '4:3' | '3:4'
  durationSec: number
  fps: 24 | 25 | 30
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
}

export type DirectorCameraMotion = Pick<
  DirectorCamera,
  'x' | 'y' | 'z' | 'heading' | 'pitch' | 'focalLengthMm'
>
export type DirectorActorMotion = Pick<DirectorActor, 'x' | 'y' | 'z' | 'scale' | 'pose'>

/** 镜头动画仅描述可随时间变化的空间参数；画幅、帧率和时长仍属于镜头固定配置。 */
export interface DirectorShotTimeline {
  version: 1
  camera: DirectorKeyframe<DirectorCameraMotion>[]
  actors: Record<string, DirectorKeyframe<DirectorActorMotion>[]>
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
  version: 1
  /** 会影响已发布画面/机位的工程修订号。 */
  revision: number
  activeShotId: string
  shots: DirectorShot[]
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
        color: '#76d7ea'
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
    camera: shot.camera,
    actors: shot.actors
  }
}

export function createDirectorProject(): DirectorProjectData {
  const shot = createDirectorShot()
  return { version: 1, revision: 1, activeShotId: shot.id, shots: [shot] }
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
  const { x, y, z, scale, pose } = actor
  return {
    ...shot,
    timeline: {
      ...shot.timeline,
      actors: {
        ...shot.timeline.actors,
        [actorId]: upsertKeyframe(shot.timeline.actors[actorId] ?? [], {
          timeSec: time,
          value: { x, y, z, scale, pose }
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
  const progress = (timeSec - previous.timeSec) / (next.timeSec - previous.timeSec)
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
        'scale'
      ])
    }))
  }
}

export function parseDirectorProject(text: string): DirectorProjectData {
  if (!text) return createDirectorProject()
  try {
    const raw = JSON.parse(text) as Partial<DirectorProjectData>
    if (raw.version !== 1 || !Array.isArray(raw.shots) || raw.shots.length === 0) {
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
      version: 1,
      revision:
        typeof raw.revision === 'number' && Number.isInteger(raw.revision) && raw.revision > 0
          ? raw.revision
          : 1,
      activeShotId,
      shots
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
  return { version: 1, activeShotId, shots }
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
