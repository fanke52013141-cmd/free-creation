import { describe, expect, it } from 'vitest'
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
  normalizeTimeline,
  overlappingClips,
  padTimelineTracks,
  parseTimeline,
  removeClip,
  removeTrack,
  removeReference,
  resolveClipDurationMs,
  resolveMoveStartMs,
  snapDropStartMs,
  rulerStepMs,
  serializeTimeline,
  splitClip,
  splitClipKeep,
  timelineDurationMs,
  trimClip,
  type TimelineData,
  type TimelineReference
} from '@shared/timeline'

function base(): TimelineData {
  return createEmptyTimeline()
}

/** 轨道是通用的：第 1 条 / 第 2 条，没有视频轨/音频轨之分。 */
function trackA(data: TimelineData): string {
  return data.tracks[0].id
}

function trackB(data: TimelineData): string {
  return data.tracks[1].id
}

function withVideo(
  data: TimelineData,
  durationMs = 10000,
  startMs?: number
): { data: TimelineData; clipId: string } {
  const result = addClip(data, {
    trackId: trackA(data),
    kind: 'video',
    mediaId: 'm1',
    mediaPath: 'projects/p/media/m1.mp4',
    name: '镜头1.mp4',
    sourceDurationMs: durationMs,
    ...(startMs === undefined ? {} : { startMs })
  })
  if (!result.ok) throw new Error(result.reason)
  return { data: result.data, clipId: result.clipId! }
}

function withAudio(data: TimelineData, startMs = 0, durationMs = 5000): {
  data: TimelineData
  clipId: string
} {
  const result = addClip(data, {
    trackId: trackA(data),
    kind: 'audio',
    mediaId: 'a1',
    mediaPath: 'projects/p/media/a1.wav',
    name: '配乐.wav',
    sourceDurationMs: 60000,
    startMs,
    durationMs
  })
  if (!result.ok) throw new Error(result.reason)
  return { data: result.data, clipId: result.clipId! }
}

describe('轨道线数据模型 · 解析与规整', () => {
  it('空卡片是正常空态：默认三条通用轨道（2026-11-03 用户裁决）', () => {
    const parsed = parseTimeline('')
    expect(parsed.ok).toBe(true)
    if (parsed.ok) {
      expect(parsed.empty).toBe(true)
      expect(parsed.data.tracks).toHaveLength(3)
      expect(parsed.data.tracks.map((track) => track.name)).toEqual(['轨道 1', '轨道 2', '轨道 3'])
      expect(parsed.data.clips).toEqual([])
    }
  })

  it('旧项目只有两条轨道时补齐到三条，不删除已有轨道', () => {
    const legacy = createEmptyTimeline()
    legacy.tracks = legacy.tracks.slice(0, 2)
    const padded = padTimelineTracks(legacy, 3)
    expect(padded.added).toBe(1)
    expect(padded.data.tracks).toHaveLength(3)
    expect(padded.data.tracks[2].name).toBe('轨道 3')
    // 已经是三条时不重复补
    expect(padTimelineTracks(padded.data, 3).added).toBe(0)
  })

  it('轨道没有类型字段：旧数据里的 kind 读入后被丢弃，不做任何限制', () => {
    const data = normalizeTimeline({
      tracks: [{ id: 't1', kind: 'audio', name: '旧音频轨' }],
      clips: [
        {
          id: 'c1',
          trackId: 't1',
          kind: 'video',
          mediaId: 'm',
          mediaPath: 'p',
          startMs: 0,
          durationMs: 1000,
          inMs: 0,
          sourceDurationMs: 5000
        }
      ]
    })
    expect(data.tracks[0]).not.toHaveProperty('kind')
    // 旧音频轨上的视频片段不再被丢弃：轨道通用。
    expect(data.clips.map((clip) => clip.id)).toEqual(['c1'])
  })

  it('坏 JSON 要报错，缺 tracks/clips 的对象判为结构错误', () => {
    expect(parseTimeline('{ not json').ok).toBe(false)
    expect(parseTimeline(JSON.stringify({ hello: 1 })).ok).toBe(false)
  })

  it('孤儿片段（轨道不存在）被丢弃', () => {
    const data = normalizeTimeline({
      tracks: [{ id: 't1', name: '轨道 1' }],
      clips: [{ id: 'c2', trackId: 'missing', kind: 'video', durationMs: 1000 }]
    })
    expect(data.clips).toHaveLength(0)
  })

  it('序列化后再解析保持不变（往返稳定）', () => {
    const { data } = withVideo(base(), 8000)
    const round = parseTimeline(serializeTimeline(data))
    expect(round.ok).toBe(true)
    if (round.ok) expect(round.data).toEqual(data)
  })
})

describe('轨道线数据模型 · 片段摆放', () => {
  it('追加片段放到轨道末端，长度取源全长', () => {
    const first = withVideo(base(), 8000)
    const second = withVideo(first.data, 5000)
    const clips = clipsOfTrack(second.data, trackA(second.data))
    expect(clips).toHaveLength(2)
    expect(clips[0].startMs).toBe(0)
    expect(clips[1].startMs).toBe(8000)
    expect(clips[1].durationMs).toBe(5000)
    expect(timelineDurationMs(second.data)).toBe(13000)
  })

  it('任意轨道都能放任意素材：音频可以放在同一条轨道上', () => {
    const first = withVideo(base(), 3000)
    const audio = addClip(first.data, {
      trackId: trackA(first.data),
      kind: 'audio',
      mediaId: 'a1',
      mediaPath: 'p',
      name: '配乐',
      sourceDurationMs: 10000,
      startMs: 3000
    })
    expect(audio.ok).toBe(true)
    if (audio.ok) expect(audio.data.clips).toHaveLength(2)
  })

  it('图片片段使用默认时长，且没有源内起点', () => {
    const data = base()
    const result = addClip(data, {
      trackId: trackA(data),
      kind: 'image',
      mediaId: 'img',
      mediaPath: 'projects/p/media/img.png',
      name: '封面.png',
      sourceDurationMs: 0
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const clip = findClip(result.data, result.clipId!)!
    expect(clip.durationMs).toBe(TIMELINE_LIMITS.defaultImageClipMs)
    expect(clip.inMs).toBe(0)
    expect(clip.sourceDurationMs).toBe(0)
  })

  it('请求长度超过源素材时按源尾截断，而不是报错', () => {
    const data = base()
    const result = addClip(data, {
      trackId: trackA(data),
      kind: 'video',
      mediaId: 'm',
      mediaPath: 'p',
      name: 'v',
      sourceDurationMs: 3000,
      inMs: 1000,
      durationMs: 9000
    })
    expect(result.ok).toBe(true)
    if (result.ok) expect(findClip(result.data, result.clipId!)!.durationMs).toBe(2000)
  })

  it('源时长未知时给可编辑占位长度，而不是 Infinity', () => {
    const data = base()
    const result = addClip(data, {
      trackId: trackA(data),
      kind: 'video',
      mediaId: 'm',
      mediaPath: 'p',
      name: '未探测素材',
      sourceDurationMs: 0
    })
    expect(result.ok).toBe(true)
    if (result.ok) {
      const clip = findClip(result.data, result.clipId!)!
      expect(clip.durationMs).toBe(5000)
      expect(Number.isFinite(clip.durationMs)).toBe(true)
    }
  })

  it('同一条轨道上的画面片段不允许重叠；音频片段可以重叠（混音）', () => {
    const first = withVideo(base(), 5000)
    const overlap = addClip(first.data, {
      trackId: trackA(first.data),
      kind: 'video',
      mediaId: 'm2',
      mediaPath: 'p2',
      name: 'v2',
      sourceDurationMs: 5000,
      startMs: 2000
    })
    expect(overlap.ok).toBe(false)

    const audio1 = withAudio(base(), 0, 5000)
    const audio2 = addClip(audio1.data, {
      trackId: trackA(audio1.data),
      kind: 'audio',
      mediaId: 'a2',
      mediaPath: 'p2',
      name: 'bgm2',
      sourceDurationMs: 5000,
      startMs: 3000
    })
    expect(audio2.ok).toBe(true)
    if (audio2.ok) {
      expect(
        overlappingClips(audio2.data, {
          trackId: trackA(audio2.data),
          startMs: 0,
          durationMs: 1000,
          kind: 'audio'
        })
      ).toEqual([])
    }
  })
})

describe('轨道线数据模型 · 轨道排序与分割三态', () => {
  it('轨道拖到最前：轨道顺序变化，片段仍跟着原轨道', () => {
    const data = base()
    const first = withVideo(data, 5000) // 片段放在轨道 1
    const target = moveTrack(first.data, trackB(first.data), 0)
    expect(target.ok).toBe(true)
    if (!target.ok) return
    expect(target.data.tracks[0].id).toBe(trackB(first.data))
    // 片段还在原轨道（轨道 1），没有被挤到别的轨道
    expect(target.data.clips[0].trackId).toBe(trackA(first.data))
  })

  it('轨道自身移动到末尾保持顺序稳定', () => {
    const data = base()
    const moved = moveTrack(data, trackA(data), 1)
    expect(moved.ok).toBe(true)
    if (moved.ok) expect(moved.data.tracks[1].id).toBe(trackA(data))
  })

  it('向左分割：保留左边、删掉右边', () => {
    const first = withVideo(base(), 10000)
    const result = splitClipKeep(first.data, first.clipId, 4000, 'left')
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const clips = clipsOfTrack(result.data, trackA(result.data))
    expect(clips).toHaveLength(1)
    expect(clips[0]).toMatchObject({ startMs: 0, durationMs: 4000, inMs: 0 })
  })

  it('向右分割：保留右边、删掉左边，源内起点随切点前移', () => {
    const first = withVideo(base(), 10000)
    const result = splitClipKeep(first.data, first.clipId, 4000, 'right')
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const clips = clipsOfTrack(result.data, trackA(result.data))
    expect(clips).toHaveLength(1)
    expect(clips[0]).toMatchObject({ startMs: 4000, durationMs: 6000, inMs: 4000 })
  })

  it('分割三态都拒绝贴边切点', () => {
    const first = withVideo(base(), 5000)
    expect(splitClipKeep(first.data, first.clipId, 10, 'left').ok).toBe(false)
    expect(splitClipKeep(first.data, first.clipId, 4990, 'right').ok).toBe(false)
  })
})

describe('轨道线数据模型 · 引用素材池', () => {
  const ref = (id: string, kind: 'video' | 'image' | 'audio' = 'video'): TimelineReference => ({
    mediaId: id,
    mediaPath: `projects/p/media/${id}.mp4`,
    name: id,
    kind
  })

  it('追加引用按传入顺序去重，不产生片段', () => {
    const base0 = base()
    const added = addReferences(base0, [ref('a'), ref('b'), ref('a')])
    expect(added.ok).toBe(true)
    if (!added.ok) return
    expect(added.data.references.map((item) => item.mediaId)).toEqual(['a', 'b'])
    expect(added.data.clips).toHaveLength(0)
  })

  it('引用素材经过序列化往返不丢', () => {
    const added = addReferences(base(), [ref('a', 'image')])
    if (!added.ok) return
    const round = parseTimeline(serializeTimeline(added.data))
    expect(round.ok).toBe(true)
    if (round.ok) expect(round.data.references).toEqual(added.data.references)
  })

  it('移除引用不影响已铺到轨道的片段', () => {
    const added = addReferences(base(), [ref('a')])
    if (!added.ok) return
    const withClip = addClip(added.data, {
      trackId: trackA(added.data),
      kind: 'video',
      mediaId: 'a',
      mediaPath: 'projects/p/media/a.mp4',
      name: 'a',
      sourceDurationMs: 4000
    })
    if (!withClip.ok) return
    const removed = removeReference(withClip.data, 'a')
    expect(removed.ok).toBe(true)
    if (removed.ok) {
      expect(removed.data.references).toEqual([])
      expect(removed.data.clips).toHaveLength(1)
    }
  })
})

describe('轨道线数据模型 · 移动 / 裁剪 / 分割 / 删除', () => {
  it('移动片段改起点并保持按时间排序', () => {
    const first = withVideo(base(), 4000)
    const moved = moveClip(first.data, first.clipId, { startMs: 6000 })
    expect(moved.ok).toBe(true)
    if (moved.ok) {
      expect(findClip(moved.data, first.clipId)!.startMs).toBe(6000)
      expect(timelineDurationMs(moved.data)).toBe(10000)
    }
  })

  it('片段可以跨轨道移动（轨道不再分类型）', () => {
    const first = withVideo(base(), 4000)
    const moved = moveClip(first.data, first.clipId, { trackId: trackB(first.data), startMs: 0 })
    expect(moved.ok).toBe(true)
    if (moved.ok) expect(findClip(moved.data, first.clipId)!.trackId).toBe(trackB(first.data))
  })

  it('移动后与同轨画面片段重叠会被拒绝（调用方据此回弹）', () => {
    const first = withVideo(base(), 4000)
    const second = withVideo(first.data, 4000)
    const clash = moveClip(second.data, second.clipId, { startMs: 1000 })
    expect(clash.ok).toBe(false)
  })

  it('左边缘裁剪同时改变源内起点，且不会超出源起点', () => {
    const first = withVideo(base(), 10000)
    const shifted = trimClip(first.data, first.clipId, 'start', 2000)
    expect(shifted.ok).toBe(true)
    if (!shifted.ok) return
    const clip = findClip(shifted.data, first.clipId)!
    expect(clip.inMs).toBe(2000)
    expect(clip.startMs).toBe(2000)
    expect(clip.durationMs).toBe(8000)

    const back = trimClip(shifted.data, first.clipId, 'start', 0)
    expect(back.ok).toBe(true)
    if (back.ok) {
      const again = findClip(back.data, first.clipId)!
      expect(again.startMs).toBe(0)
      expect(again.inMs).toBe(0)
      expect(again.durationMs).toBe(10000)
    }
  })

  it('右边缘裁剪被源素材剩余长度限制', () => {
    const first = withVideo(base(), 5000)
    const result = trimClip(first.data, first.clipId, 'end', 9000)
    expect(result.ok).toBe(true)
    if (result.ok) expect(findClip(result.data, first.clipId)!.durationMs).toBe(5000)
  })

  it('分割产生两段共享同一媒体、源内起点连续', () => {
    const first = withVideo(base(), 10000)
    const split = splitClip(first.data, first.clipId, 4000)
    expect(split.ok).toBe(true)
    if (!split.ok) return
    const clips = clipsOfTrack(split.data, trackA(split.data))
    expect(clips).toHaveLength(2)
    expect(clips[0]).toMatchObject({ startMs: 0, durationMs: 4000, inMs: 0, mediaId: 'm1' })
    expect(clips[1]).toMatchObject({ startMs: 4000, durationMs: 6000, inMs: 4000, mediaId: 'm1' })
  })

  it('分割点贴边会被拒绝', () => {
    const first = withVideo(base(), 5000)
    expect(splitClip(first.data, first.clipId, 0).ok).toBe(false)
    expect(splitClip(first.data, first.clipId, 4990).ok).toBe(false)
  })

  it('删除片段与删除轨道（连带片段）', () => {
    const first = withVideo(base(), 4000)
    const removed = removeClip(first.data, first.clipId)
    expect(removed.ok).toBe(true)
    if (removed.ok) expect(removed.data.clips).toHaveLength(0)

    const withClips = withVideo(base(), 4000)
    const dropped = removeTrack(withClips.data, trackA(withClips.data))
    expect(dropped.ok).toBe(true)
    if (dropped.ok) {
      expect(dropped.data.tracks).toHaveLength(2)
      expect(dropped.data.clips).toHaveLength(0)
    }
  })

  it('不能删掉最后一条轨道', () => {
    let data = base()
    while (data.tracks.length > 1) {
      const next = removeTrack(data, data.tracks[data.tracks.length - 1].id)
      if (!next.ok) break
      data = next.data
    }
    expect(data.tracks).toHaveLength(1)
    expect(removeTrack(data, data.tracks[0].id).ok).toBe(false)
  })

  it('加轨道按顺序命名，数量受上限约束', () => {
    let data = base()
    const added = addTrack(data)
    expect(added.ok).toBe(true)
    if (!added.ok) return
    expect(added.data.tracks).toHaveLength(4)
    expect(added.data.tracks[3].name).toBe('轨道 4')
    data = added.data
    while (data.tracks.length < TIMELINE_LIMITS.maxTracks) {
      const next = addTrack(data)
      if (!next.ok) break
      data = next.data
    }
    expect(addTrack(data).ok).toBe(false)
  })
})

describe('轨道线数据模型 · 刻度与时间码', () => {
  it('时间码按 mm:ss 输出', () => {
    expect(formatTimecode(0)).toBe('00:00')
    expect(formatTimecode(24_000)).toBe('00:24')
    expect(formatTimecode(61_000)).toBe('01:01')
  })

  it('刻度步长随缩放变大，标签不会挤在一起', () => {
    expect(rulerStepMs(160)).toBeLessThanOrEqual(rulerStepMs(10))
    expect(rulerStepMs(10)).toBeGreaterThan(0)
  })

  it('片段末端 = 起点 + 时长', () => {
    const first = withVideo(base(), 3000, 1500)
    expect(clipEndMs(findClip(first.data, first.clipId)!)).toBe(4500)
  })
})

describe('轨道线数据模型 · 落轨避让（2026-11-03 用户反馈）', () => {
  it('拖到已被占用的位置时顺延到后方空档，而不是拒绝落轨', () => {
    const first = withVideo(base(), 10_000)
    const trackId = trackA(first.data)
    // 期望起点 5000 落在 0..10000 的片段里 → 顺延到 10000
    expect(freeStartMsFor(first.data, trackId, 5000, 4000, 'video')).toBe(10_000)
    // 期望起点 12000 已经在空档里 → 原样保留
    expect(freeStartMsFor(first.data, trackId, 12_000, 4000, 'video')).toBe(12_000)
    // 片段从 5000 开始：起点 0 位于它之前的空档里 → 原样保留
    const late = withVideo(base(), 4000, 5000)
    expect(freeStartMsFor(late.data, trackA(late.data), 0, 4000, 'image')).toBe(0)
  })

  it('后方放不下时继续顺延到所有片段之后', () => {
    const first = withVideo(base(), 4000)
    let data = first.data
    const second = addClip(data, {
      trackId: trackA(data),
      kind: 'video',
      mediaId: 'm2',
      mediaPath: 'p2',
      name: '视频2',
      sourceDurationMs: 4000,
      startMs: 6000
    })
    expect(second.ok).toBe(true)
    if (!second.ok) return
    data = second.data
    // 期望 3000 落在第一段里；第一段后只有 4000..6000 的 2s 空档，放不下 4000 → 顺延到 10000
    expect(freeStartMsFor(data, trackA(data), 3000, 4000, 'video')).toBe(10_000)
  })

  it('音频允许叠放，不做避让', () => {
    const first = withVideo(base(), 5000)
    expect(freeStartMsFor(first.data, trackA(first.data), 1000, 3000, 'audio')).toBe(1000)
  })

  it('落轨时长与 addClip 内部分配一致', () => {
    const input = {
      trackId: 't',
      kind: 'video' as const,
      mediaId: 'm',
      mediaPath: 'p',
      name: 'n',
      sourceDurationMs: 8000
    }
    expect(resolveClipDurationMs(input)).toBe(8000)
    expect(
      resolveClipDurationMs({ ...input, startMs: 0, durationMs: 20_000 })
    ).toBe(8000)
    expect(
      resolveClipDurationMs({ ...input, kind: 'image', sourceDurationMs: 0 })
    ).toBe(TIMELINE_LIMITS.defaultImageClipMs)
  })
})

describe('轨道线数据模型 · 拖动吸附（2026-11-03 用户反馈「开了吸附却贴不上」）', () => {
  const moveStart = (
    data: TimelineData,
    clipId: string,
    rawStartMs: number,
    durationMs: number,
    snapEnabled = true,
    thresholdMs = 300
  ): number => {
    const trackId = findClip(data, clipId)!.trackId
    const points = clipsOfTrack(data, trackId)
      .filter((clip) => clip.id !== clipId)
      .flatMap((clip) => [clip.startMs, clip.startMs + clip.durationMs])
    return resolveMoveStartMs({
      data,
      trackId,
      clipId,
      rawStartMs,
      durationMs,
      snapPointsMs: points,
      thresholdMs,
      snapEnabled
    })
  }

  it('起点贴到相邻片段末端（首尾相连）', () => {
    const first = withVideo(base(), 4000)
    const second = withVideo(first.data, 2000, 10_000)
    // 原始起点 4020 距离 4000 只有 20ms → 吸附到 4000
    expect(moveStart(second.data, second.clipId, 4020, 2000)).toBe(4000)
  })

  it('末端也会贴到相邻片段起点（从右往左接）', () => {
    const first = withVideo(base(), 2000, 0)
    // 右侧邻居：8000..12000；被拖片段先放在 20000（时长 2000）
    const neighbor = withVideo(first.data, 4000, 8000)
    const movable = withVideo(neighbor.data, 2000, 20_000)
    // 原始起点 5990 → 末端 7990 距离 8000 只有 10ms → 起点吸到 6000
    expect(moveStart(movable.data, movable.clipId, 5990, 2000)).toBe(6000)
  })

  it('拖到片段内部时自动贴到最近的合法边缘，而不是报重叠', () => {
    const first = withVideo(base(), 4000)
    const second = withVideo(first.data, 2000, 10_000)
    // 原始起点 1000 深埋在 0..4000 里 → 贴到 4000
    expect(moveStart(second.data, second.clipId, 1000, 2000)).toBe(4000)
  })

  it('关掉吸附时保留原始位置', () => {
    const first = withVideo(base(), 4000)
    const second = withVideo(first.data, 2000, 10_000)
    expect(moveStart(second.data, second.clipId, 4020, 2000, false)).toBe(4020)
  })
})

describe('轨道线数据模型 · 落轨磁吸（2026-11-03 用户反馈「拖进来没连在一起」）', () => {
  const dropStart = (data: TimelineData, trackId: string, rawStartMs: number, durationMs: number, kind: 'video' | 'audio' = 'video') =>
    snapDropStartMs({ data, trackId, rawStartMs, durationMs, kind })

  it('拖到已占用轨道任意位置都吸到最近的片段边缘', () => {
    const first = withVideo(base(), 4000)
    const trackId = trackA(first.data)
    // 拖到片段内部 → 接到片段末尾
    expect(dropStart(first.data, trackId, 1000, 2000)).toBe(4000)
    // 拖到片段后方的空白 → 依然接到片段末尾（首尾相连）
    expect(dropStart(first.data, trackId, 6000, 2000)).toBe(4000)
  })

  it('落在两个片段之间时吸到最近的合法边缘', () => {
    const first = withVideo(base(), 4000)
    const second = withVideo(first.data, 4000, 10_000)
    const trackId = trackA(second.data)
    // 两个片段之间（4000..10000），放 2000 的片段：最近边缘是 4000（间隔 1000）
    expect(dropStart(second.data, trackId, 5000, 2000)).toBe(4000)
    // 更靠近第二个片段 → 往前插到 8000
    expect(dropStart(second.data, trackId, 9000, 2000)).toBe(8000)
  })

  it('空轨道保持落点原样', () => {
    const data = base()
    expect(dropStart(data, trackA(data), 12_000, 3000)).toBe(12_000)
  })

  it('音频不参与磁吸（允许叠放）', () => {
    const first = withVideo(base(), 4000)
    const trackId = trackA(first.data)
    expect(dropStart(first.data, trackId, 1000, 2000, 'audio')).toBe(1000)
  })
})
