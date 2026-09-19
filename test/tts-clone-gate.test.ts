// MiniMax 快速复刻的执行前门禁：参考音频时长必须在 10 秒～5 分钟内。
//
// 这条区间此前只是 shared/tts.ts 里两个没人用的常量：真跑时我们拿着一段 2.3 秒的
// 合成音频去克隆，上游回了一句英文的 `2037 voice duration too short`（音色没登记、
// 但文件已经上传）。网关把英文错误码翻译成中文提示是最后一道，真正该做的是在花钱
// 上传之前就拦住。这里用真 FFmpeg 合成的长短两份音频跑真代码，只 mock 网络与落盘。
import { mkdtemp, rm } from 'fs/promises'
import { spawnSync } from 'child_process'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type { MediaAsset } from '@shared/types'
import { DEFAULT_TTS_CONFIG } from '@shared/tts'

const ffmpeg = spawnSync('ffmpeg', ['-version'], { encoding: 'utf8' })
const ffprobe = spawnSync('ffprobe', ['-version'], { encoding: 'utf8' })
const toolsReady = ffmpeg.status === 0 && ffprobe.status === 0

const h = vi.hoisted(() => ({
  dataDir: '',
  byId: new Map<string, { mime: string; rel: string }>(),
  byRel: new Map<string, string>(),
  cloneCalls: 0,
  synthCalls: 0
}))

vi.mock('../src/main/store/db', () => ({
  getDb: () => ({
    prepare: () => ({
      get: (mediaId: string) => {
        const item = h.byId.get(mediaId)
        return item ? { mime: item.mime, path: item.rel } : undefined
      }
    })
  })
}))

vi.mock('../src/main/store/media.repo', () => ({
  getMediaAbsPath: (rel: string) => h.byRel.get(rel),
  saveBufferAsset: async (): Promise<MediaAsset> => {
    throw new Error('这条链路不该落盘')
  }
}))

vi.mock('../src/main/gateway/providers.repo', () => ({
  getProvider: (id: string) =>
    id === 'p-minimax'
      ? {
          id: 'p-minimax',
          name: 'MiniMax',
          specId: 'minimax',
          baseURL: 'https://api.minimaxi.com',
          apiKey: 'unused-in-this-test',
          models: [],
          createdAt: 0
        }
      : undefined
}))

vi.mock('../src/main/gateway/voice', () => ({
  cloneMiniMaxVoice: async () => {
    h.cloneCalls += 1
    return 'canvas-voice-mock'
  }
}))

vi.mock('../src/main/gateway/audio', () => ({
  generateAudioToAsset: async (): Promise<MediaAsset> => {
    h.synthCalls += 1
    return {
      id: 'asset-1',
      kind: 'audio',
      mime: 'audio/mpeg',
      path: 'projects/p1/media/asset.mp3',
      name: '克隆合成',
      sizeBytes: 1
    } as MediaAsset
  }
}))

/** 用 lavfi 正弦波合成一份指定时长的 wav，不引入任何外部素材。 */
function makeWav(abs: string, seconds: number): void {
  const res = spawnSync(
    'ffmpeg',
    [
      '-hide_banner',
      '-loglevel',
      'error',
      '-y',
      '-f',
      'lavfi',
      '-i',
      `sine=frequency=440:duration=${seconds}`,
      abs
    ],
    { encoding: 'utf8' }
  )
  expect(res.status, res.stderr).toBe(0)
}

function runClone(referenceMediaId: string) {
  return import('../src/main/media/tts-transform').then((m) =>
    m.transformTts({
      projectId: 'p1',
      referenceAudioId: referenceMediaId,
      text: '这是一次复刻门禁验收。',
      config: { ...DEFAULT_TTS_CONFIG, backend: 'minimax', providerId: 'p-minimax' }
    })
  )
}

describe.skipIf(!toolsReady)('MiniMax 复刻的参考音频时长门禁', () => {
  beforeAll(async () => {
    h.dataDir = await mkdtemp(join(tmpdir(), 'tts-clone-gate-'))
    const shortAbs = join(h.dataDir, 'short.wav')
    const longAbs = join(h.dataDir, 'long.wav')
    makeWav(shortAbs, 2)
    makeWav(longAbs, 12)
    h.byId.set('m-short', { mime: 'audio/wav', rel: 'short.wav' })
    h.byId.set('m-long', { mime: 'audio/wav', rel: 'long.wav' })
    h.byRel.set('short.wav', shortAbs)
    h.byRel.set('long.wav', longAbs)
  })

  afterAll(async () => {
    await rm(h.dataDir, { recursive: true, force: true }).catch(() => undefined)
  })

  it('参考音频不足 10 秒时直接拒绝，不上传也不登记音色', async () => {
    await expect(runClone('m-short')).rejects.toThrow(/10 秒～5 分钟/)
    expect(h.cloneCalls).toBe(0)
    expect(h.synthCalls).toBe(0)
  })

  it('时长达标时照常复刻并合成一次', async () => {
    const result = await runClone('m-long')
    expect(result.voiceId).toBe('canvas-voice-mock')
    expect(result.asset.id).toBe('asset-1')
    expect(h.cloneCalls).toBe(1)
    expect(h.synthCalls).toBe(1)
  })

  it('参考音频记录缺失时报的是「不存在或已删除」，不是探测超时的误导提示', async () => {
    await expect(runClone('m-missing')).rejects.toThrow(/参考音频不存在或已删除/)
  })
})
