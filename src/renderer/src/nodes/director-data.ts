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
  scale: number
  color: string
}

export interface DirectorShot {
  id: string
  name: string
  scene: string
  dialogue: string
  referenceMediaIds: string[]
  referenceMediaPaths: string[]
  camera: DirectorCamera
  actors: DirectorActor[]
}

export interface DirectorProjectData {
  version: 1
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

export function createDirectorShot(name = '镜头 01'): DirectorShot {
  return {
    id: createDirectorId('shot'),
    name,
    scene: '',
    dialogue: '',
    referenceMediaIds: [],
    referenceMediaPaths: [],
    camera: defaultDirectorCamera(),
    actors: [
      {
        id: createDirectorId('actor'),
        name: '角色 01',
        pose: '站立',
        x: 50,
        y: 62,
        scale: 1,
        color: '#76d7ea'
      }
    ]
  }
}

export function createDirectorProject(): DirectorProjectData {
  const shot = createDirectorShot()
  return { version: 1, activeShotId: shot.id, shots: [shot] }
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

export function parseDirectorProject(text: string): DirectorProjectData {
  if (!text) return createDirectorProject()
  try {
    const raw = JSON.parse(text) as Partial<DirectorProjectData>
    if (raw.version !== 1 || !Array.isArray(raw.shots) || raw.shots.length === 0) {
      return createDirectorProject()
    }
    const shots = raw.shots.filter(
      (shot): shot is DirectorShot =>
        Boolean(shot) &&
        typeof shot.id === 'string' &&
        typeof shot.name === 'string' &&
        typeof shot.scene === 'string' &&
        typeof shot.dialogue === 'string' &&
        Array.isArray(shot.referenceMediaIds) &&
        Array.isArray(shot.referenceMediaPaths) &&
        Array.isArray(shot.actors) &&
        isCamera(shot.camera)
    )
    if (shots.length === 0) return createDirectorProject()
    const activeShotId = shots.some((shot) => shot.id === raw.activeShotId)
      ? (raw.activeShotId as string)
      : shots[0].id
    return { version: 1, activeShotId, shots }
  } catch {
    return createDirectorProject()
  }
}

export function parseDirectorPublishRecord(value: unknown): DirectorPublishRecord | null {
  if (!value || typeof value !== 'object') return null
  const raw = value as Partial<DirectorPublishRecord>
  if (
    raw.kind !== 'director-publish' ||
    raw.version !== 1 ||
    typeof raw.publishedAt !== 'number' ||
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
    shotId: raw.shotId,
    ...(frame ? { frame } : {}),
    ...(video ? { video } : {}),
    camera: raw.camera
  }
}
