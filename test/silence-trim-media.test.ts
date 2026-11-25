// 去气口节点真实 FFmpeg / 真实 Silero VAD 验收。
//
// 执行器单测（test/silence-trim-node.test.ts）证明「参数拼对、产物记账正确」；
// silencedetect 的 stderr 解析、filter_complex_script 拼接、onnxruntime 推理这些环节
// 只有真二进制/真模型面前才会暴露问题。这里沿用 video-transform-real-media 的口径：
// 只 mock 持久层（media.repo 落盘 + db 查询）与 electron app 路径，FFmpeg 与模型都是真的。
// 语音样本 test/assets/speech-sample.wav 取自 silero-vad 仓库（MIT）自带测试音频，
// 裁为 3 秒 16kHz 单声道；合成波形（正弦）会被 VAD 正确判为非语音，不能当语音 fixture。
import { copyFile, mkdtemp, rm } from 'fs/promises'
import { spawnSync } from 'child_process'
import { tmpdir } from 'os'
import { join, resolve } from 'path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type { MediaAsset } from '@shared/types'
import { runProcess } from '../src/main/media/ffmpeg-runner'
import { transformSilenceTrim } from '../src/main/media/silence-trim'

const appRoot = process.cwd()

vi.mock('electron', () => ({
  app: { getAppPath: () => appRoot, isPackaged: false }
}))

const h = vi.hoisted(() => ({
  dataDir: '',
  saved: [] as Array<{ path: string; name: string; ext: string }>,
  /** 媒体 ID → 磁盘上的真文件；beforeAll 灌入，两份 mock 共用。 */
  byId: new Map<string, { abs: string; rel: string; kind: string; mime: string }>(),
  byRel: new Map<string, string>()
}))

vi.mock('../src/main/store/db', () => ({
  getDb: () => ({
    prepare: () => ({
      get: (mediaId: string) => {
        const item = h.byId.get(mediaId)
        if (!item) return undefined
        return { path: item.rel, mime: item.mime, kind: item.kind, size_bytes: 1 }
      }
    })
  })
}))

vi.mock('../src/main/store/media.repo', () => ({
  getMediaAbsPath: (relPath: string) => h.byRel.get(relPath),
  saveFileAsset: async (_projectId: string, srcAbs: string, ext: string, name: string) => {
    const dest = join(h.dataDir, `${h.saved.length}${ext}`)
    await copyFile(srcAbs, dest)
    h.saved.push({ path: dest, name, ext })
    return {
      id: `asset-${h.saved.length}`,
      path: `projects/p1/media/asset-${h.saved.length}${ext}`,
      name
    } as MediaAsset
  },
  deleteMedia: () => undefined
}))

const ffmpeg = spawnSync('ffmpeg', ['-version'], { encoding: 'utf8' })
const ffprobe = spawnSync('ffprobe', ['-version'], { encoding: 'utf8' })
const speechSource = resolve(appRoot, 'test/assets/speech-sample.wav')
const modelReady = spawnSync('node', ['-e', "require('onnxruntime-node')"], { encoding: 'utf8' })
const toolsReady = ffmpeg.status === 0 && ffprobe.status === 0
const vadReady =
  modelReady.status === 0 && spawnSync('ffmpeg', ['-version'], { encoding: 'utf8' }).status === 0

function durationMs(file: string): number {
  const res = spawnSync(
    'ffprobe',
    ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', file],
    { encoding: 'utf8' }
  )
  expect(res.status, res.stderr).toBe(0)
  return Math.round(Number(res.stdout.trim()) * 1000)
}

/** 最长静音段（毫秒）：判断输出里是否还残留成句的气口。 */
function longestSilenceMs(file: string): number {
  const res = spawnSync(
    'ffmpeg',
    ['-hide_banner', '-nostats', '-loglevel', 'info', '-i', file, '-af', 'silencedetect=noise=-35dB:d=0.3', '-f', 'null', '-'],
    { encoding: 'utf8' }
  )
  const durations = [...res.stderr.matchAll(/silence_duration:\s*(-?[\d.]+)/g)].map((m) => Number(m[1]) * 1000)
  return durations.length ? Math.max(...durations) : 0
}

function runFfmpegOrThrow(args: string[]): void {
  const res = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args], {
    encoding: 'utf8'
  })
  expect(res.status, res.stderr).toBe(0)
}

const baseConfig = {
  version: 1 as const,
  thresholdDb: -35,
  vadThreshold: 0.5,
  minGapMs: 300,
  marginMs: 80,
  keepGapMs: 0
}

beforeAll(async () => {
  h.dataDir = await mkdtemp(join(tmpdir(), 'canvas-studio-silence-trim-'))
  const files = {
    'speech-gap': { file: 'gap.wav', kind: 'audio', mime: 'audio/wav' },
    'loud-tone': { file: 'sine.wav', kind: 'audio', mime: 'audio/wav' },
    'all-silent': { file: 'silent.wav', kind: 'audio', mime: 'audio/wav' }
  }
  for (const [id, item] of Object.entries(files)) {
    const abs = join(h.dataDir, item.file)
    h.byId.set(id, { abs, rel: `projects/p1/media/${item.file}`, kind: item.kind, mime: item.mime })
    h.byRel.set(`projects/p1/media/${item.file}`, abs)
  }
  if (!toolsReady) return
  // 语音 2 秒 + 静音 0.6 秒 + 语音 2 秒：一段带真实气口的 4.6 秒素材。
  // anullsrc 必须用 d= 给定时长：concat 串接下无限源会永远停在第二段，写盘直至撑爆磁盘。
  // 语音样本自身尾部也有一段非语音，会并入中间气口——断言只约束「剪过且没剪秃」。
  const gapAbs = h.byId.get('speech-gap')?.abs as string
  const speech = resolve(appRoot, 'test/assets/speech-sample.wav')
  runFfmpegOrThrow([
    '-i', speech,
    '-f', 'lavfi', '-i', 'anullsrc=r=16000:cl=mono:d=0.6',
    '-filter_complex', '[0:a]atrim=0:2,asplit=2[a][b];[a][1:a][b]concat=n=3:v=0:a=1',
    '-c:a', 'pcm_s16le', '-ar', '16000', gapAbs
  ])
  runFfmpegOrThrow([
    '-f', 'lavfi', '-i', 'sine=frequency=1000:duration=2',
    '-af', 'volume=10', '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le',
    h.byId.get('loud-tone')?.abs as string
  ])
  runFfmpegOrThrow([
    '-f', 'lavfi', '-i', 'anullsrc=r=16000:cl=mono', '-t', '1',
    '-c:a', 'pcm_s16le', h.byId.get('all-silent')?.abs as string
  ])
})

afterAll(async () => {
  await rm(h.dataDir, { recursive: true, force: true }).catch(() => undefined)
})

describe('去气口本地变换（真实 ffmpeg / 模型）', () => {
  it('runProcess 的 onStderr 回调能逐块拿到 silencedetect 所在的 stderr', async () => {
    const chunks: string[] = []
    await runProcess('node', ['-e', 'console.error("silence_start: 1.5")'], 'node 不可用', {
      captureStdout: false,
      onStderr: (chunk) => chunks.push(chunk)
    })
    expect(chunks.join('')).toContain('silence_start: 1.5')
  })

  it.skipIf(!toolsReady)('silence 引擎：真实气口被剪掉，输出不残留长静音', async () => {
    const inputMs = durationMs(h.byId.get('speech-gap')?.abs as string)
    const outcome = await transformSilenceTrim({
      projectId: 'p1',
      sourceMediaId: 'speech-gap',
      nodeId: 'node:trim',
      config: { ...baseConfig, engine: 'silence' as const }
    })
    expect(outcome.engine).toBe('silence')
    expect(outcome.gapCount).toBeGreaterThanOrEqual(1)
    expect(outcome.removedMs).toBeGreaterThan(0)
    // saveFileAsset mock 的 saved.path 即真实落盘文件。
    const output = h.saved.at(-1)!.path
    const outputMs = durationMs(output)
    // 剪过但没剪秃：气口（含样本尾部非语音）被移除，语音主体保留。
    expect(outputMs).toBeLessThan(inputMs - 300)
    expect(outputMs).toBeGreaterThan(inputMs / 2)
    // keepGap=0 且边距 80：输出里不允许再出现 ≥450ms 的静音段。
    expect(longestSilenceMs(output)).toBeLessThan(450)
  })

  it.skipIf(!vadReady)('vad 引擎：真实 Silero VAD 识别气口并裁剪', async () => {
    const inputMs = durationMs(h.byId.get('speech-gap')?.abs as string)
    const outcome = await transformSilenceTrim({
      projectId: 'p1',
      sourceMediaId: 'speech-gap',
      nodeId: 'node:trim-vad',
      config: { ...baseConfig, engine: 'vad' as const }
    })
    expect(outcome.engine).toBe('vad')
    expect(outcome.gapCount).toBeGreaterThanOrEqual(1)
    const outputMs = durationMs(h.saved.at(-1)!.path)
    expect(outputMs).toBeLessThan(inputMs - 300)
    expect(outputMs).toBeGreaterThan(inputMs / 2)
  })

  it.skipIf(!toolsReady)('连续响音无气口：原样生成新资产，不误剪', async () => {
    const outcome = await transformSilenceTrim({
      projectId: 'p1',
      sourceMediaId: 'loud-tone',
      nodeId: 'node:trim-tone',
      config: { ...baseConfig, engine: 'silence' as const }
    })
    expect(outcome.gapCount).toBe(0)
    expect(outcome.removedMs).toBe(0)
    const outputMs = durationMs(h.saved.at(-1)!.path)
    expect(Math.abs(outputMs - 2000)).toBeLessThan(200)
  })

  it.skipIf(!toolsReady)('整段静音：边距为 0 时没有可保留音频，明确失败；默认边距只留极短首尾', async () => {
    // 边距 0：候选区间覆盖整个气口 → keeps 为空 → 明确失败，不伪造空产物。
    await expect(transformSilenceTrim({
      projectId: 'p1',
      sourceMediaId: 'all-silent',
      nodeId: 'node:trim-silent',
      config: { ...baseConfig, engine: 'silence' as const, marginMs: 0 }
    })).rejects.toThrow('整段都是气口')
    // 默认边距 80：气口两端各留边距，产出极短资产（诚实结果，不是失败也不是原样拷贝）。
    const outcome = await transformSilenceTrim({
      projectId: 'p1',
      sourceMediaId: 'all-silent',
      nodeId: 'node:trim-silent',
      config: { ...baseConfig, engine: 'silence' as const }
    })
    expect(outcome.gapCount).toBe(1)
    expect(outcome.removedMs).toBeGreaterThan(800)
    const outputMs = durationMs(h.saved.at(-1)!.path)
    expect(outputMs).toBeLessThan(300)
  })
})
