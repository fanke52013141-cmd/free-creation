// @vitest-environment jsdom
import { beforeAll, describe, expect, it, vi } from 'vitest'
import { registerAllNodeTypes } from './helpers/registerNodes'
import { getNodeType } from '@renderer/nodes/registry'
import { projectNodeOutputs } from '@renderer/nodes/nodeValues'
import { silenceTrimExecutor } from '@shared/engine/executors/silenceTrim'
import {
  DEFAULT_SILENCE_TRIM_CONFIG,
  gapsFromSpeechIntervals,
  gapCutsFromGaps,
  keepIntervalsFromCuts,
  parseSilenceTrimConfig,
  parseSilencedetectEvents,
  selectExpressionForKeeps,
  silenceTrimSummary,
  speechIntervalsFromProbabilities
} from '@shared/silence-trim'
import type { NodeExecutionContext } from '@shared/engine/executor-types'
import type { GatewayClient } from '@shared/engine/gateway-client'
import type { NodeCardShape } from '@renderer/canvas/NodeCardShape'
import type { MediaAsset } from '@shared/types'

beforeAll(registerAllNodeTypes)

function context(config: string, capabilities?: Partial<Record<string, unknown>>): {
  ctx: NodeExecutionContext
  result: { value: string }
  artifacts: unknown[]
  trim: ReturnType<typeof vi.fn>
} {
  const result = { value: '' }
  const artifacts: unknown[] = []
  const asset = {
    id: 'trimmed-media', path: 'projects/p1/media/trimmed.m4a', mime: 'audio/mp4', name: '去气口音频'
  } as MediaAsset
  const trim = vi.fn(async () => ({ ok: true as const, data: asset }))
  const packet = {
    type: 'audio',
    value: { kind: 'audio', mediaId: 'source-audio', mediaPath: 'projects/p1/media/source.wav', mime: 'audio/wav' },
    source: { nodeId: 'shape:audio', portId: 'out-audio', runId: 'upstream' },
    createdAt: 1
  }
  const inputs = new Map<string, unknown[]>([['in-audio', [packet]]])
  const shape = {
    id: 'shape:trim',
    props: {
      w: 340, h: 260, nodeType: 'silence-trim', title: '去气口', config, text: '',
      mediaId: '', mediaPath: '', mediaMime: '', exec: 'idle'
    },
    meta: {}
  } as unknown as NodeCardShape
  const ctx = {
    node: { id: shape.id, type: 'silence-trim' },
    shape,
    inputs,
    projectId: 'p1',
    runId: 'run-trim',
    providers: [],
    signal: { cancelled: false },
    gateway: {
      silenceTrim: trim,
      getLocalMediaCapabilities: vi.fn(async () => ({
        ok: true,
        data: {
          ffmpeg: { available: true, message: '已就绪' },
          ffprobe: { available: true, message: '已就绪' },
          sileroVad: { available: true, message: '已就绪' },
          ...capabilities
        }
      }))
    } as unknown as GatewayClient,
    updateProps: vi.fn(),
    updateResult: (value: string) => { result.value = value },
    emitArtifact: (value: unknown) => artifacts.push(value)
  } as unknown as NodeExecutionContext
  return { ctx, result, artifacts, trim }
}

describe('去气口节点契约与持久化', () => {
  it('单音频输入单音频输出，版本与右侧配置入口稳定', () => {
    const spec = getNodeType('silence-trim')!
    expect(spec.contractVersion).toBe(1)
    expect(spec.ports.in.map(({ id, type, required, cardinality }) => ({ id, type, required, cardinality }))).toEqual([
      { id: 'in-audio', type: 'audio', required: true, cardinality: 'one' }
    ])
    expect(spec.ports.out.map(({ id, type, required }) => ({ id, type, required }))).toEqual([
      { id: 'out-audio', type: 'audio', required: true }
    ])
    expect(spec.SettingsPanel).toBeTypeOf('function')
    expect(spec.category).toBe('audio')
  })

  it('配置可从 JSON 恢复并钳制越界；引擎分派对应能力预检', () => {
    const config = parseSilenceTrimConfig(JSON.stringify({
      version: 1, engine: 'vad', thresholdDb: -20, vadThreshold: 0.6, minGapMs: 500, marginMs: 100, keepGapMs: 200
    }))
    expect(config).toEqual({
      version: 1, engine: 'vad', thresholdDb: -20, vadThreshold: 0.6, minGapMs: 500, marginMs: 100, keepGapMs: 200
    })
    const defaults = parseSilenceTrimConfig('')
    expect(defaults).toEqual(DEFAULT_SILENCE_TRIM_CONFIG)
    // 越界一律钳回边界而不是失败（与声音调整同一容错口径）。
    const clamped = parseSilenceTrimConfig(JSON.stringify({
      engine: ' nonsense', thresholdDb: -99, vadThreshold: 9, minGapMs: -5, marginMs: 99999, keepGapMs: 0.4
    }))
    expect(clamped).toEqual({ version: 1, engine: 'silence', thresholdDb: -60, vadThreshold: 0.95, minGapMs: 0, marginMs: 1000, keepGapMs: 0 })
    expect(silenceTrimSummary(config)).toContain('Silero VAD')
    expect(silenceTrimSummary(defaults)).toContain('静音阈值 -35dB')
  })

  it('silencedetect 解析含尾静音钳制；概率帧切段；气口按边距/最短/中心保留换算剪切区间', () => {
    const events = parseSilencedetectEvents(
      [
        '[silencedetect @ 0x0] silence_start: 1.2',
        '[silencedetect @ 0x0] silence_end: 2.4 | silence_duration: 1.2',
        '[silencedetect @ 0x0] silence_start: 3',
        ''
      ].join('\n'),
      4000
    )
    expect(events).toEqual([{ startMs: 1200, endMs: 2400 }, { startMs: 3000, endMs: 4000 }])

    expect(speechIntervalsFromProbabilities([0.1, 0.9, 0.9, 0.2], 32, 0.5)).toEqual([
      { startMs: 32, endMs: 96 }
    ])
    expect(gapsFromSpeechIntervals([{ startMs: 500, endMs: 1500 }], 2000)).toEqual([
      { startMs: 0, endMs: 500 },
      { startMs: 1500, endMs: 2000 }
    ])

    const config = { minGapMs: 300, marginMs: 80, keepGapMs: 120 }
    // 500ms 气口：边距后候选 [1080,1420]，中心保留 120 → 剪掉两端各 110。
    expect(gapCutsFromGaps([{ startMs: 1000, endMs: 1500 }], 5000, config)).toEqual([
      { startMs: 1080, endMs: 1190 },
      { startMs: 1310, endMs: 1420 }
    ])
    // 短于 minGap 的气口整个保留。
    expect(gapCutsFromGaps([{ startMs: 1000, endMs: 1200 }], 5000, config)).toEqual([])
    // keepGap=0 → 除边距外全剪（两段相邻剪切合并为一段）。
    expect(gapCutsFromGaps([{ startMs: 1000, endMs: 1500 }], 5000, { ...config, keepGapMs: 0 })).toEqual([
      { startMs: 1080, endMs: 1420 }
    ])
    // 中心保留 ≥ 候选长度 → 不剪。
    expect(gapCutsFromGaps([{ startMs: 1000, endMs: 1500 }], 5000, { ...config, keepGapMs: 2000 })).toEqual([])

    const keeps = keepIntervalsFromCuts([{ startMs: 1000, endMs: 1500 }], 2000)
    expect(keeps).toEqual([{ startMs: 0, endMs: 1000 }, { startMs: 1500, endMs: 2000 }])
    expect(selectExpressionForKeeps(keeps)).toBe('between(t,0.000,1.000)+between(t,1.500,2.000)')
    expect(() => selectExpressionForKeeps([])).toThrow('整段都是气口')
  })

  it('恰好一段音频才执行；产物只投影 out-audio 并物化资产', async () => {
    const config = JSON.stringify(parseSilenceTrimConfig(''))
    const empty = context(config)
    ;(empty.ctx.inputs as Map<string, unknown[]>).clear()
    expect(await silenceTrimExecutor(empty.ctx)).toMatchObject({ status: 'failed' })
    expect(empty.trim).not.toHaveBeenCalled()

    const { ctx, result, artifacts, trim } = context(config)
    expect(await silenceTrimExecutor(ctx)).toEqual({ status: 'done' })
    expect(trim).toHaveBeenCalledWith({
      projectId: 'p1', sourceMediaId: 'source-audio', nodeId: 'shape:trim', config: parseSilenceTrimConfig(config)
    })
    expect(ctx.shape.props.config).toBe(config)
    expect(artifacts).toMatchObject([{ kind: 'audio', portId: 'out-audio', mediaId: 'trimmed-media' }])
    const shape = {
      ...ctx.shape,
      meta: {
        nodeResult: result.value,
        nodeRun: { runId: 'run-trim', status: 'success', startedAt: 1, inputs: {} }
      }
    } as NodeCardShape
    const outputs = projectNodeOutputs(shape)
    expect(outputs['out-audio']).toMatchObject({ kind: 'audio', mediaId: 'trimmed-media' })
  })

  it('vad 引擎在模型能力缺失时如实失败，不发起变换', async () => {
    const config = JSON.stringify(parseSilenceTrimConfig(JSON.stringify({ engine: 'vad' })))
    const { ctx, trim } = context(config, {
      sileroVad: { available: false, message: '未找到 silero_vad.onnx' }
    })
    const outcome = await silenceTrimExecutor(ctx)
    expect(outcome).toMatchObject({ status: 'failed' })
    expect((outcome as { reason: string }).reason).toContain('Silero VAD')
    expect(trim).not.toHaveBeenCalled()
  })
})
