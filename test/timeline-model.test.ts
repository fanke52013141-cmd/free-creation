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

function videoTrackId(data: TimelineData): string {
  return data.tracks.find((track) => track.kind === 'video')!.id
}

function audioTrackId(data: TimelineData): string {
  return data.tracks.find((track) => track.kind === 'audio')!.id
}

function withVideo(data: TimelineData, durationMs = 10000, startMs?: number): {
  data: TimelineData
  clipId: string
} {
  const result = addClip(data, {
    trackId: videoTrackId(data),
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

describe('时间线数据模型 · 解析与规整', () => {
  it('空卡片是正常空态，不是错误', () => {
    const parsed = parseTimeline('')
    expect(parsed.ok).toBe(true)
    if (parsed.ok) {
      expect(parsed.empty).toBe(true)
      expect(parsed.data.tracks.length).toBe(2)
      expect(parsed.data.clips).toEqual([])
    }
  })

  it('坏 JSON 要报错，让用户知道数据需要修', () => {
    const parsed = parseTimeline('{ not json')
    expect(parsed.ok).toBe(false)
  })

  it('缺 tracks/clips 的对象被判为结构错误', () => {
    const parsed = parseTimeline(JSON.stringify({ hello: 1 }))
    expect(parsed.ok).toBe(false)
  })

  it('孤儿片段（轨道不存在）与错误轨道类型的片段被丢弃', () => {
    const data = normalizeTimeline({
      tracks: [{ id: 't1', kind: 'video', name: '视频 1' }],
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
        },
        { id: 'c2', trackId: 'missing', kind: 'video', durationMs: 1000 },
        { id: 'c3', trackId: 't1', kind: 'audio', durationMs: 1000 }
      ]
    })
    expect(data.clips.map((clip) => clip.id)).toEqual(['c1'])
    expect(data.clips[0].volume).toBe(1)
  })

  it('序列化后再解析保持不变（往返稳定）', () => {
    const { data } = withVideo(base(), 8000)
    const round = parseTimeline(serializeTimeline(data))
    expect(round.ok).toBe(true)
    if (round.ok) expect(round.data).toEqual(data)
  })
})

describe('时间线数据模型 · 片段摆放', () => {
  it('追加片段放到轨道末端，长度取源全长', () => {
    const first = withVideo(base(), 8000)
    const second = withVideo(first.data, 5000)
    const clips = clipsOfTrack(second.data, videoTrackId(second.data))
    expect(clips).toHaveLength(2)
    expect(clips[0].startMs).toBe(0)
    expect(clips[0].durationMs).toBe(8000)
    expect(clips[1].startMs).toBe(8000)
    expect(clips[1].durationMs).toBe(5000)
    expect(timelineDurationMs(second.data)).toBe(13000)
  })

  it('图片片段使用默认时长，且没有源内起点', () => {
    const data = base()
    const result = addClip(data, {
      trackId: videoTrackId(data),
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
      trackId: videoTrackId(data),
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
      trackId: videoTrackId(data),
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

  it('音频片段不能放到视频轨（反之亦然）', () => {
    const data = base()
    const wrong = addClip(data, {
      trackId: videoTrackId(data),
      kind: 'audio',
      mediaId: 'a',
      mediaPath: 'p',
      name: 'a',
      sourceDurationMs: 5000
    })
    expect(wrong.ok).toBe(false)
  })

  it('视频轨不允许重叠，音频轨允许重叠（混音）', () => {
    const first = withVideo(base(), 5000)
    const overlap = addClip(first.data, {
      trackId: videoTrackId(first.data),
      kind: 'video',
      mediaId: 'm2',
      mediaPath: 'p2',
      name: 'v2',
      sourceDurationMs: 5000,
      startMs: 2000
    })
    expect(overlap.ok).toBe(false)

    const data = base()
    const audio1 = addClip(data, {
      trackId: audioTrackId(data),
      kind: 'audio',
      mediaId: 'a1',
      mediaPath: 'p1',
      name: 'bgm1',
      sourceDurationMs: 10000,
      startMs: 0
    })
    expect(audio1.ok).toBe(true)
    if (!audio1.ok) return
    const audio2 = addClip(audio1.data, {
      trackId: audioTrackId(audio1.data),
      kind: 'audio',
      mediaId: 'a2',
      mediaPath: 'p2',
      name: 'bgm2',
      sourceDurationMs: 10000,
      startMs: 3000
    })
    expect(audio2.ok).toBe(true)
    if (audio2.ok) {
      expect(overlappingClips(audio2.data, { trackId: audioTrackId(audio2.data), startMs: 0, durationMs: 1000 })).toEqual([])
    }
  })
})

describe('时间线数据模型 · 移动 / 裁剪 / 分割 / 删除', () => {
  it('移动片段改起点并保持按时间排序', () => {
    const first = withVideo(base(), 4000)
    const moved = moveClip(first.data, first.clipId, { startMs: 6000 })
    expect(moved.ok).toBe(true)
    if (moved.ok) {
      expect(findClip(moved.data, first.clipId)!.startMs).toBe(6000)
      expect(timelineDurationMs(moved.data)).toBe(10000)
    }
  })

  it('移动后与同轨片段重叠会被拒绝（调用方据此回弹）', () => {
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

    // 向左拉回：源内起点已经用掉 2 秒，因此最多只能回到 startMs=0 / inMs=0（即恢复整段）
    const back = trimClip(shifted.data, first.clipId, 'start', 0)
    expect(back.ok).toBe(true)
    if (back.ok) {
      const again = findClip(back.data, first.clipId)!
      expect(again.startMs).toBe(0)
      expect(again.inMs).toBe(0)
      expect(again.durationMs).toBe(10000)
    }
    // 再往左拉已经到源起点，不会产生负的 inMs
    if (back.ok) {
      const beyond = trimClip(back.data, first.clipId, 'start', -500)
      expect(beyond.ok).toBe(true)
      if (beyond.ok) expect(findClip(beyond.data, first.clipId)!.inMs).toBe(0)
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
    const clips = clipsOfTrack(split.data, videoTrackId(split.data))
    expect(clips).toHaveLength(2)
    expect(clips[0]).toMatchObject({ startMs: 0, durationMs: 4000, inMs: 0, mediaId: 'm1' })
    expect(clips[1]).toMatchObject({ startMs: 4000, durationMs: 6000, inMs: 4000, mediaId: 'm1' })
    expect(timelineDurationMs(split.data)).toBe(10000)
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
    const dropped = removeTrack(withClips.data, videoTrackId(withClips.data))
    expect(dropped.ok).toBe(true)
    if (dropped.ok) {
      expect(dropped.data.tracks.some((track) => track.kind === 'video')).toBe(false)
      expect(dropped.data.clips).toHaveLength(0)
    }
  })

  it('不能删掉最后一条轨道', () => {
    let data = base()
    const audioTrack = audioTrackId(data)
    const first = removeTrack(data, audioTrack)
    expect(first.ok).toBe(true)
    if (!first.ok) return
    data = first.data
    const only = data.tracks[0].id
    expect(removeTrack(data, only).ok).toBe(false)
  })

  it('新增轨道后编号递增、数量受上限约束', () => {
    let data = base()
    const track = addTrack(data, 'video')
    expect(track.ok).toBe(true)
    if (!track.ok) return
    expect(track.data.tracks.filter((item) => item.kind === 'video')).toHaveLength(2)
    data = track.data
    while (data.tracks.length < TIMELINE_LIMITS.maxTracks) {
      const next = addTrack(data, 'audio')
      if (!next.ok) break
      data = next.data
    }
    expect(addTrack(data, 'video').ok).toBe(false)
  })
})

describe('时间线数据模型 · 刻度与时间码', () => {
  it('时间码按 mm:ss 输出', () => {
    expect(formatTimecode(0)).toBe('00:00')
    expect(formatTimecode(24_000)).toBe('00:24')
    expect(formatTimecode(61_000)).toBe('01:01')
  })

  it('刻度步长随缩放变大，标签不会挤在一起', () => {
    const zoomIn = rulerStepMs(160)
    const zoomOut = rulerStepMs(10)
    expect(zoomIn).toBeLessThanOrEqual(zoomOut)
    expect(zoomIn).toBeGreaterThan(0)
  })

  it('片段末端 = 起点 + 时长', () => {
    const first = withVideo(base(), 3000, 1500)
    expect(clipEndMs(findClip(first.data, first.clipId)!)).toBe(4500)
  })
})
