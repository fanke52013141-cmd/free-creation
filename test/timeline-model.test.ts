import { describe, expect, it } from 'vitest'
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
  normalizeTimeline,
  overlappingClips,
  parseTimeline,
  removeClip,
  removeTrack,
  rulerStepMs,
  serializeTimeline,
  splitClip,
  timelineDurationMs,
  trimClip,
  type TimelineData
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
  it('空卡片是正常空态：默认两条通用轨道', () => {
    const parsed = parseTimeline('')
    expect(parsed.ok).toBe(true)
    if (parsed.ok) {
      expect(parsed.empty).toBe(true)
      expect(parsed.data.tracks).toHaveLength(2)
      expect(parsed.data.tracks.map((track) => track.name)).toEqual(['轨道 1', '轨道 2'])
      expect(parsed.data.clips).toEqual([])
    }
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
      expect(dropped.data.tracks).toHaveLength(1)
      expect(dropped.data.clips).toHaveLength(0)
    }
  })

  it('不能删掉最后一条轨道', () => {
    let data = base()
    const first = removeTrack(data, trackB(data))
    expect(first.ok).toBe(true)
    if (!first.ok) return
    data = first.data
    expect(removeTrack(data, data.tracks[0].id).ok).toBe(false)
  })

  it('加轨道按顺序命名，数量受上限约束', () => {
    let data = base()
    const added = addTrack(data)
    expect(added.ok).toBe(true)
    if (!added.ok) return
    expect(added.data.tracks).toHaveLength(3)
    expect(added.data.tracks[2].name).toBe('轨道 3')
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
