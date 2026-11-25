/**
 * BL-24：MiniMax 克隆参考音频约束（10 秒～5 分钟 / ≤20MB / mp3·m4a·wav）
 * 必须在请求供应商之前由主进程拒绝，并对「连线输入」与「节点上传」两种来源一致生效。
 *
 * 本文件只测编排层（transformTts → cloneMiniMaxVoice 之前的所有校验），
 * 网关层（voice.ts）的同名校验在 test/voice-clone-response.test.ts 覆盖。
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, open, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { TtsConfig } from '../src/shared/tts'
import {
  DEFAULT_TTS_CONFIG,
  MINIMAX_CLONE_MAX_BYTES,
  MINIMAX_CLONE_MAX_SECONDS,
  MINIMAX_CLONE_MIMES,
  MINIMAX_CLONE_MIN_SECONDS,
  formatReferenceAudioDurationIssue
} from '../src/shared/tts'
import { mimeForExtension } from '../src/shared/mime'

interface CloneEvent {
  message: string
  level?: string
  phase?: string
  attributes?: Record<string, unknown>
}

const h = vi.hoisted(() => ({
  media: new Map<string, { mime: string; path: string }>(),
  durations: new Map<string, number>(),
  probes: [] as string[],
  lookups: [] as string[],
  cloneCalls: 0,
  fetchCalls: 0,
  events: [] as CloneEvent[]
}))

vi.mock('../src/main/store/db', () => ({
  getDb: () => ({
    prepare: () => ({
      get: (id: string) => {
        h.lookups.push(id)
        return h.media.get(id)
      }
    })
  })
}))

vi.mock('../src/main/store/media.repo', () => ({
  getMediaAbsPath: (relPath: string) => relPath
}))

vi.mock('../src/main/gateway/providers.repo', () => ({
  getProvider: async () => ({
    id: 'p-minimax',
    name: 'MiniMax',
    specId: 'minimax',
    baseURL: 'http://127.0.0.1:9',
    apiKey: 'test-key'
  })
}))

vi.mock('../src/main/gateway/voice', () => ({
  cloneMiniMaxVoice: async () => {
    h.cloneCalls += 1
    return 'canvas-voice-mock'
  }
}))

vi.mock('../src/main/media/video-transform', () => ({
  probeMediaDurationMs: async (absPath: string) => {
    h.probes.push(absPath)
    return h.durations.get(absPath) ?? 0
  }
}))

vi.mock('../src/main/diagnostics/gateway-events', () => ({
  emitGatewayEvent: (
    _event: string,
    message: string,
    _correlation: Record<string, unknown>,
    options: { level?: string; phase?: string; attributes?: Record<string, unknown> }
  ) => {
    h.events.push({ message, level: options?.level, phase: options?.phase, attributes: options?.attributes })
  }
}))

const { transformTts } = await import('../src/main/media/tts-transform')

const dirs: string[] = []
let mediaDir = ''
const fileOf = (name: string): string => join(mediaDir, name)

async function makeTinyFile(name: string): Promise<string> {
  const path = fileOf(name)
  await writeFile(path, Buffer.alloc(64))
  return path
}

async function makeOversizedFile(name: string): Promise<string> {
  const path = fileOf(name)
  const handle = await open(path, 'w')
  try {
    await handle.truncate(MINIMAX_CLONE_MAX_BYTES + 1)
  } finally {
    await handle.close()
  }
  return path
}

const runClone = (
  referenceAudioId: string,
  overrides: Partial<TtsConfig> = {}
): ReturnType<typeof transformTts> =>
  transformTts({
    projectId: 'p1',
    runId: 'run-1',
    nodeId: 'shape:tts',
    traceId: 'trace-bl24',
    referenceAudioId,
    config: {
      ...DEFAULT_TTS_CONFIG,
      backend: 'minimax',
      providerId: 'p-minimax',
      modelId: 'speech-2.8-turbo',
      ...overrides
    }
  })

beforeAll(async () => {
  mediaDir = await mkdtemp(join(tmpdir(), 'bl24-clone-'))
  dirs.push(mediaDir)

  const ok = await makeTinyFile('ok-12s.wav')
  const nine = await makeTinyFile('nine-9s.wav')
  const long = await makeTinyFile('long-360s.wav')
  const lower = await makeTinyFile('lower-10s.wav')
  const upper = await makeTinyFile('upper-300s.wav')
  const noProbe = await makeTinyFile('ffprobe-missing.wav')
  const mp4Connected = await makeTinyFile('connected-ref.wav')
  const mp4Upload = await makeTinyFile('uploaded-ref.wav')
  const huge = await makeOversizedFile('huge.wav')

  h.media.set('m-ok-12s', { mime: 'audio/wav', path: ok })
  h.media.set('m-9s', { mime: 'audio/wav', path: nine })
  h.media.set('m-360s', { mime: 'audio/wav', path: long })
  h.media.set('m-10s', { mime: 'audio/wav', path: lower })
  h.media.set('m-300s', { mime: 'audio/wav', path: upper })
  h.media.set('m-ffprobe-missing', { mime: 'audio/wav', path: noProbe })
  h.media.set('m-connected-mp4', { mime: 'video/mp4', path: mp4Connected })
  h.media.set('m-upload-mp4', { mime: 'video/mp4', path: mp4Upload })
  h.media.set('m-huge', { mime: 'audio/wav', path: huge })

  h.durations.set(ok, 12_000)
  h.durations.set(nine, 9_000)
  h.durations.set(long, 360_000)
  h.durations.set(lower, 10_000)
  h.durations.set(upper, 300_000)
  h.durations.set(mp4Connected, 12_000)
  h.durations.set(mp4Upload, 12_000)
})

afterAll(async () => {
  for (const dir of dirs) await rm(dir, { recursive: true, force: true })
})

beforeEach(() => {
  h.probes.length = 0
  h.lookups.length = 0
  h.cloneCalls = 0
  h.fetchCalls = 0
  h.events.length = 0
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => {
      h.fetchCalls += 1
      throw new Error('NETWORK_MUST_NOT_BE_REACHED')
    })
  )
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('BL-24 复刻参考音频约束（主进程、请求供应商之前）', () => {
  it('MIME 不在白名单时直接拒绝，不读时长、不上传、不发起网络', async () => {
    await expect(runClone('m-connected-mp4')).rejects.toMatchObject({
      code: 'INVALID_INPUT',
      message: 'MiniMax 复刻参考音频仅支持 mp3、m4a 或 wav'
    })
    expect(h.probes).toHaveLength(0)
    expect(h.cloneCalls).toBe(0)
    expect(h.fetchCalls).toBe(0)
  })

  it('超过 20MB 时直接拒绝，不读时长、不上传、不发起网络', async () => {
    await expect(runClone('m-huge')).rejects.toMatchObject({
      code: 'INVALID_INPUT',
      message: 'MiniMax 复刻参考音频不能超过 20MB'
    })
    expect(h.probes).toHaveLength(0)
    expect(h.cloneCalls).toBe(0)
    expect(h.fetchCalls).toBe(0)
  })

  it.each([
    ['m-9s', '9.0 秒（少于下限）'],
    ['m-360s', '360.0 秒（超过上限）']
  ])('时长越界（%s）给出可操作文案，且不上传、不发起网络', async (mediaId, expected) => {
    await expect(runClone(mediaId)).rejects.toMatchObject({
      code: 'INVALID_INPUT',
      message: expect.stringContaining(expected)
    })
    expect(h.probes).toHaveLength(1)
    expect(h.cloneCalls).toBe(0)
    expect(h.fetchCalls).toBe(0)
  })

  it.each([['m-10s'], ['m-300s']])('边界值（%s）可进入克隆', async (mediaId) => {
    await expect(runClone(mediaId)).resolves.toEqual({ voiceId: 'canvas-voice-mock' })
    expect(h.cloneCalls).toBe(1)
  })

  it('本机无法检测时长时跳过本地检查、交给服务端（不与网关层硬拒绝混淆）', async () => {
    await expect(runClone('m-ffprobe-missing')).resolves.toEqual({ voiceId: 'canvas-voice-mock' })
    const messages = h.events.map((event) => event.message)
    expect(messages).toContain('本机无法检测参考音频时长，将由服务端继续校验')
    expect(messages).not.toContain('参考音频时长已检测')
    expect(h.cloneCalls).toBe(1)
  })

  it('连线输入与节点上传共用同一条准入：主进程只认 referenceAudioId，不回退到 refMediaId', async () => {
    // 连线提供的参考音频非法：即使节点上还留着一份合法上传，也不能回退。
    await expect(runClone('m-connected-mp4', { refMediaId: 'm-ok-12s' })).rejects.toMatchObject({
      code: 'INVALID_INPUT'
    })
    expect(h.lookups).toEqual(['m-connected-mp4'])

    h.lookups.length = 0
    // 节点上传的参考音频非法：同样在准入处被拒。
    await expect(runClone('m-upload-mp4', { refMediaId: 'm-ok-12s' })).rejects.toMatchObject({
      code: 'INVALID_INPUT'
    })
    expect(h.lookups).toEqual(['m-upload-mp4'])
    expect(h.cloneCalls).toBe(0)
    expect(h.fetchCalls).toBe(0)
  })

  it('时长越界是阶段态失败：reference-audio 阶段、error 级别、未进入登记环节', async () => {
    await expect(runClone('m-9s')).rejects.toMatchObject({ code: 'INVALID_INPUT' })
    const messages = h.events.map((event) => event.message)
    expect(messages).toContain('开始 MiniMax 语音克隆')
    expect(messages).toContain('开始读取参考音频')
    expect(messages).toContain('参考音频已读取')
    expect(messages).toContain('参考音频时长已检测')
    expect(messages).not.toContain('开始向 MiniMax 登记参考音色')
    const last = h.events.at(-1)
    expect(last?.level).toBe('error')
    expect(last?.phase).toBe('reference-audio')
    expect(last?.attributes?.operation).toBe('voice.clone')
    // 日志不得泄漏本地绝对路径或文件名。
    const serialized = JSON.stringify(h.events)
    expect(serialized).not.toContain(mediaDir)
    expect(serialized).not.toContain('nine-9s.wav')
  })

  it('文案格式化：向下取一位，避免 9999ms 显示成「10.0 秒」', () => {
    expect(formatReferenceAudioDurationIssue(9.999)).toBe(
      `参考音频需 ${MINIMAX_CLONE_MIN_SECONDS} 秒～${MINIMAX_CLONE_MAX_SECONDS / 60} 分钟，当前约 9.9 秒（少于下限）`
    )
    expect(formatReferenceAudioDurationIssue(300.001)).toBe(
      `参考音频需 ${MINIMAX_CLONE_MIN_SECONDS} 秒～${MINIMAX_CLONE_MAX_SECONDS / 60} 分钟，当前约 300.0 秒（超过上限）`
    )
  })

  it('白名单与本地扩展名映射不漂移：mp3 / m4a / wav 都在允许集合内', () => {
    for (const ext of ['.mp3', '.m4a', '.wav']) {
      expect(MINIMAX_CLONE_MIMES).toContain(mimeForExtension(ext))
    }
  })
})