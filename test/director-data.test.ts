import { describe, expect, it } from 'vitest'
import {
  createDirectorProject,
  createDirectorPublishRecord,
  createDirectorShot,
  createImageDepthSpace,
  createLocalWhiteboxSpace,
  directorShotWarnings,
  directorSequenceDuration,
  directorCameraFov,
  directorCameraTarget,
  directorPublishDrift,
  directorPublishStateText,
  DIRECTOR_DURATION_RANGE_SEC,
  DIRECTOR_FOCAL_RANGE_MM,
  evaluateDirectorShot,
  moveDirectorShot,
  nextDirectorProjectRevision,
  parseDirectorProject,
  recordDirectorActorKeyframe,
  recordDirectorCameraKeyframe,
  removeDirectorShot,
  syncDirectorSequence,
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

  it('没编辑过的导演卡：重复解析默认工程不会把刚发布的帧说成「另一个镜头」', () => {
    // config 为空时每次渲染都重新解析默认工程；id 一旦随机，发布记录里的 shotId
    // 就永远对不上，卡片会对没动过的用户谎报漂移。
    const first = parseDirectorProject('')
    const published = createDirectorPublishRecord(first, first.shots[0], null, {
      frame: { mediaId: 'frame-default', mediaPath: 'projects/default.png', mime: 'image/png' }
    })
    const again = parseDirectorProject('')
    expect(again.activeShotId).toBe(first.activeShotId)
    expect(again.sequence.cuts.map((cut) => cut.id)).toEqual(
      first.sequence.cuts.map((cut) => cut.id)
    )
    expect(directorPublishDrift(again, published, again.activeShotId)).toBe('current')
  })
})

describe('导演台 2D 预演数据', () => {
  it('v1 工程会规范化为携带空间和镜头序列的 v2 工程', () => {
    const v1 = {
      version: 1,
      revision: 3,
      activeShotId: 'shot-1',
      shots: [{ ...createDirectorShot(), id: 'shot-1' }]
    }
    const parsed = parseDirectorProject(JSON.stringify(v1))
    expect(parsed.version).toBe(2)
    expect(parsed.space.status).toBe('empty')
    expect(parsed.sequence.cuts[0]?.shotId).toBe('shot-1')
  })

  it('本地白模只保存轻量 primitive 与来源 ID，不嵌入媒体二进制', () => {
    const space = createLocalWhiteboxSpace(['image-a'], ['projects/a.png'])
    expect(space.status).toBe('ready')
    expect(space.mode).toBe('local-whitebox')
    expect(space.primitives.length).toBeGreaterThan(0)
    expect(JSON.stringify(space)).not.toContain('base64')
  })

  it('图片视差空间只保存真实来源引用并限制视差强度', () => {
    const space = createImageDepthSpace('image-a', 'projects/a.png', 3)
    expect(space.mode).toBe('image-depth')
    expect(space.backgroundMediaId).toBe('image-a')
    expect(space.backgroundMediaPath).toBe('projects/a.png')
    expect(space.depthSource).toBe('heuristic-luminance')
    expect(space.parallaxStrength).toBe(1)
    expect(JSON.stringify(space)).not.toContain('data:image')
  })

  it('镜头顺序变化会同步硬切序列并计算总时长', () => {
    const project = createDirectorProject()
    const second = createDirectorShot('镜头 02')
    const full = { ...project, shots: [project.shots[0], second] }
    const sequence = syncDirectorSequence(full)
    expect(sequence.cuts.map((cut) => cut.shotId)).toEqual([project.shots[0].id, second.id])
    expect(directorSequenceDuration({ ...full, sequence })).toBeGreaterThan(0)
  })

  it('白模碰撞和过长镜头只给出非阻断预警', () => {
    const project = createDirectorProject()
    const shot = { ...project.shots[0], camera: { ...project.shots[0].camera, durationSec: 13 } }
    const warnings = directorShotWarnings(
      { ...project, space: createLocalWhiteboxSpace(['image-a'], ['projects/a.png']) },
      shot
    )
    expect(warnings.some((warning) => warning.includes('12 秒'))).toBe(true)
  })

  it('过长镜头的告警说明导出截断后果，而不是只喊「太长」', () => {
    const project = createDirectorProject()
    const shot = {
      ...project.shots[0],
      camera: { ...project.shots[0].camera, durationSec: DIRECTOR_DURATION_RANGE_SEC[1] + 8 }
    }
    const [warning] = directorShotWarnings(project, shot).filter((item) => item.includes('秒超过'))
    expect(warning).toContain(`导出只取前 ${DIRECTOR_DURATION_RANGE_SEC[1]} 秒`)
    expect(warning).toContain(`${shot.camera.durationSec} 秒`)
  })

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

describe('导演台参数范围与发布状态语义', () => {
  it('焦段上限就是画面停止变化的那一个整数，超过它任何值都渲染同一帧', () => {
    const [, maxFocal] = DIRECTOR_FOCAL_RANGE_MM
    // 上限之内必须还在变，否则这个控件本身就是装饰。
    expect(directorCameraFov(maxFocal)).toBeGreaterThan(18)
    expect(directorCameraFov(maxFocal)).toBeLessThan(directorCameraFov(maxFocal - 1))
    // 上限之外 FOV 已经饱和：界面此前放行到 200mm，用户改的是无效数字。
    expect(directorCameraFov(maxFocal + 1)).toBe(18)
    expect(directorCameraFov(500)).toBe(18)
  })

  it('序列切片把越界时长夹回界面同一个区间', () => {
    const project = createDirectorProject()
    const clamp = (durationSec: number): number =>
      syncDirectorSequence({
        ...project,
        shots: [{ ...project.shots[0], camera: { ...project.shots[0].camera, durationSec } }]
      }).cuts[0]!.durationSec
    // 旧序列上限 30 秒：切出来的片段会比界面允许的最长镜头还长。
    expect(clamp(DIRECTOR_DURATION_RANGE_SEC[1] * 3)).toBe(DIRECTOR_DURATION_RANGE_SEC[1])
    expect(clamp(0)).toBe(DIRECTOR_DURATION_RANGE_SEC[0])
    expect(clamp(5)).toBe(5)
  })

  it('旧工程存着的切片时长在读取时跟镜头重算，切片只保留身份', () => {
    const project = createDirectorProject()
    const first = project.shots[0]
    const parsed = parseDirectorProject(
      JSON.stringify({
        ...project,
        shots: [{ ...first, camera: { ...first.camera, durationSec: 9 } }],
        // 现场复现：镜头 9 秒，切片还留着旧上限 30 秒——「导出整段」会按 30 秒走。
        sequence: { version: 1, cuts: [{ id: 'cut-keep', shotId: first.id, durationSec: 30 }] }
      })
    )
    expect(parsed.sequence.cuts[0]?.id).toBe('cut-keep')
    expect(parsed.sequence.cuts[0]?.durationSec).toBe(9)
    expect(directorSequenceDuration(parsed)).toBe(9)
  })

  it('发布偏差分四种，「没发布」「改过」「发布的是别的镜头」不再混成一句', () => {
    const project = createDirectorProject()
    const first = project.shots[0]
    const second = createDirectorShot('镜头 02')
    const full = { ...project, shots: [first, second] }
    const published = createDirectorPublishRecord(full, second, null, {
      frame: { mediaId: 'frame-b', mediaPath: 'projects/b.png', mime: 'image/png' }
    })
    expect(directorPublishDrift(full, published, second.id)).toBe('current')
    expect(directorPublishDrift(full, published, first.id)).toBe('other-shot')
    expect(directorPublishDrift(full, null, first.id)).toBe('unpublished')
    const edited = nextDirectorProjectRevision(full, {
      ...full,
      shots: full.shots.map((shot) => ({ ...shot, scene: '雨夜街口' }))
    })
    expect(directorPublishDrift(edited, published, second.id)).toBe('edited')
  })

  it('卡片与预演台共用同一句发布状态，另一个镜头要点名', () => {
    const project = createDirectorProject()
    const first = project.shots[0]
    const second = createDirectorShot('镜头 02')
    const full = { ...project, shots: [first, second] }
    const published = createDirectorPublishRecord(full, second, null, {
      frame: { mediaId: 'frame-b', mediaPath: 'projects/b.png', mime: 'image/png' }
    })
    expect(directorPublishStateText(full, published, second.id)).toContain('当前镜头已发布')
    expect(directorPublishStateText(full, published, first.id)).toContain('镜头 02')
    expect(directorPublishStateText(full, null, first.id)).toBe('尚未发布输出')
    const edited = nextDirectorProjectRevision(full, {
      ...full,
      shots: full.shots.map((shot) => ({ ...shot, scene: '雨夜街口' }))
    })
    expect(directorPublishStateText(edited, published, second.id)).toContain('需重新发布')
  })
})
