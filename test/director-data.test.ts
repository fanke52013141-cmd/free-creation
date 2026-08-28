import { describe, expect, it } from 'vitest'
import {
  createDirectorProject,
  createDirectorPublishRecord,
  createDirectorShot,
  directorCameraFov,
  directorCameraTarget,
  evaluateDirectorShot,
  moveDirectorShot,
  nextDirectorProjectRevision,
  parseDirectorProject,
  recordDirectorActorKeyframe,
  recordDirectorCameraKeyframe,
  removeDirectorShot,
  type DirectorPublishRecord
} from '@renderer/nodes/director-data'

describe('导演台发布记录', () => {
  it('工程语义编辑会递增修订，纯镜头选择不会使发布结果失效', () => {
    const project = createDirectorProject()
    const semantic = nextDirectorProjectRevision(project, {
      ...project,
      shots: project.shots.map((shot) => ({ ...shot, scene: '雨夜街口' }))
    })
    const selection = nextDirectorProjectRevision(
      semantic,
      { ...semantic, activeShotId: semantic.activeShotId },
      false
    )
    expect(semantic.revision).toBe(2)
    expect(selection.revision).toBe(2)
  })

  it('不同镜头发布时不能保留上一镜头的帧或视频', () => {
    const project = createDirectorProject()
    const firstShot = project.shots[0]
    const previous: DirectorPublishRecord = createDirectorPublishRecord(project, firstShot, null, {
      frame: { mediaId: 'frame-a', mediaPath: 'projects/a.png', mime: 'image/png' },
      video: { mediaId: 'video-a', mediaPath: 'projects/a.webm', mime: 'video/webm' }
    })
    const nextShot = createDirectorShot('镜头 02')
    const published = createDirectorPublishRecord(project, nextShot, previous, {
      frame: { mediaId: 'frame-b', mediaPath: 'projects/b.png', mime: 'image/png' }
    })
    expect(published.frame?.mediaId).toBe('frame-b')
    expect(published.video).toBeUndefined()
  })

  it('同镜头同修订补发视频时保留同一镜头的帧', () => {
    const project = createDirectorProject()
    const shot = project.shots[0]
    const previous = createDirectorPublishRecord(project, shot, null, {
      frame: { mediaId: 'frame-a', mediaPath: 'projects/a.png', mime: 'image/png' }
    })
    const published = createDirectorPublishRecord(project, shot, previous, {
      video: { mediaId: 'video-a', mediaPath: 'projects/a.webm', mime: 'video/webm' }
    })
    expect(published.frame?.mediaId).toBe('frame-a')
    expect(published.video?.mediaId).toBe('video-a')
  })
})

describe('导演台 2D 预演数据', () => {
  it('3D 预演与发布使用同一套焦段和机位朝向语义', () => {
    const camera = { ...createDirectorShot().camera, heading: 90, pitch: 0, focalLengthMm: 50 }
    expect(directorCameraFov(50)).toBe(43.25)
    expect(directorCameraTarget(camera)).toEqual([8, 1.6, expect.closeTo(5)])
  })

  it('按时间线插值相机和角色，并保持姿态为上一关键帧', () => {
    const base = createDirectorShot()
    const cameraAtZero = recordDirectorCameraKeyframe(base, 0)
    const withCamera = recordDirectorCameraKeyframe(
      { ...cameraAtZero, camera: { ...cameraAtZero.camera, x: 10, focalLengthMm: 55 } },
      4
    )
    const actorAtZero = recordDirectorActorKeyframe(withCamera, withCamera.actors[0].id, 0)
    const withActor = recordDirectorActorKeyframe(
      { ...actorAtZero, actors: [{ ...actorAtZero.actors[0], x: 80, pose: '奔跑' }] },
      actorAtZero.actors[0].id,
      4
    )
    const sampled = evaluateDirectorShot(withActor, 2)
    expect(sampled.camera.x).toBe(5)
    expect(sampled.camera.focalLengthMm).toBe(45)
    expect(sampled.actors[0].x).toBe(65)
    expect(sampled.actors[0].pose).toBe('站立')
  })

  it('新镜头默认具备构图辅助和参考图透明度', () => {
    const shot = createDirectorShot()
    expect(shot.guides).toEqual({ thirds: true, safeFrame: true, eyeline: true })
    expect(shot.referenceOpacity).toBe(0.42)
    expect(shot.actors[0].z).toBe(0)
  })

  it('读取工程时规范化构图配置与透明度边界', () => {
    const project = createDirectorProject()
    const raw = {
      ...project,
      shots: [
        {
          ...project.shots[0],
          guides: { thirds: false, safeFrame: true, eyeline: false },
          referenceOpacity: 4
        }
      ]
    }
    const parsed = parseDirectorProject(JSON.stringify(raw))
    expect(parsed.shots[0].guides).toEqual({ thirds: false, safeFrame: true, eyeline: false })
    expect(parsed.shots[0].referenceOpacity).toBe(1)
  })

  it('拒绝不符合 3D 角色空间协议的镜头', () => {
    const project = createDirectorProject()
    const valid = createDirectorShot('合规镜头')
    const parsed = parseDirectorProject(
      JSON.stringify({
        ...project,
        shots: [
          { ...project.shots[0], actors: [{ ...project.shots[0].actors[0], z: 'near' }] },
          valid
        ]
      })
    )
    expect(parsed.shots).toEqual([valid])
  })

  it('镜头可重排和删除，删除当前镜头会选择相邻镜头', () => {
    const project = createDirectorProject()
    const second = createDirectorShot('镜头 02')
    const third = createDirectorShot('镜头 03')
    const full = { ...project, activeShotId: second.id, shots: [project.shots[0], second, third] }
    expect(moveDirectorShot(full.shots, third.id, -1).map((shot) => shot.id)).toEqual([
      project.shots[0].id,
      third.id,
      second.id
    ])
    const deleted = removeDirectorShot(full, second.id)
    expect(deleted?.shots.map((shot) => shot.id)).toEqual([project.shots[0].id, third.id])
    expect(deleted?.activeShotId).toBe(third.id)
    expect(removeDirectorShot(project, project.activeShotId)).toBeNull()
  })
})
