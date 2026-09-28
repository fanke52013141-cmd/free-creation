// @vitest-environment jsdom
import { beforeAll, describe, expect, it, vi } from 'vitest'
import { registerAllNodeTypes } from './helpers/registerNodes'
import { getNodeType } from '@renderer/nodes/registry'
import { projectNodeOutputs } from '@renderer/nodes/nodeValues'
import { soundAdjustExecutor } from '@shared/engine/executors/soundAdjust'
import { parseSoundAdjustConfig, soundAdjustRate, soundAtempoFilters } from '@shared/sound-adjust'
import type { NodeExecutionContext } from '@shared/engine/executor-types'
import type { GatewayClient } from '@shared/engine/gateway-client'
import type { NodeCardShape } from '@renderer/canvas/NodeCardShape'
import type { MediaAsset } from '@shared/types'

beforeAll(registerAllNodeTypes)

function context(kind: 'audio' | 'video' | 'both' | 'none', config: string): {
  ctx: NodeExecutionContext
  result: { value: string }
  artifacts: unknown[]
  adjust: ReturnType<typeof vi.fn>
} {
  const result = { value: '' }
  const artifacts: unknown[] = []
  const asset = {
    id: 'new-media', path: 'projects/p1/media/new.m4a', mime: 'audio/mp4', name: '调整后音频'
  } as MediaAsset
  const adjust = vi.fn(async () => ({ ok: true as const, data: asset }))
  const packet = (type: 'audio' | 'video') => ({
    type,
    value: { kind: type, mediaId: `source-${type}`, mediaPath: `projects/p1/media/source.${type}`, mime: `${type}/test` },
    source: { nodeId: `shape:${type}`, portId: `out-${type}`, runId: 'upstream' },
    createdAt: 1
  })
  const inputs = new Map<string, unknown[]>()
  if (kind === 'audio' || kind === 'both') inputs.set('in-audio', [packet('audio')])
  if (kind === 'video' || kind === 'both') inputs.set('in-video', [packet('video')])
  const shape = {
    id: 'shape:adjust',
    props: {
      w: 340, h: 260, nodeType: 'sound-adjust', title: '声音调整', config, text: '',
      mediaId: '', mediaPath: '', mediaMime: '', exec: 'idle'
    },
    meta: {}
  } as unknown as NodeCardShape
  const ctx = {
    node: { id: shape.id, type: 'sound-adjust' },
    shape,
    inputs,
    projectId: 'p1',
    runId: 'run-adjust',
    providers: [],
    signal: { cancelled: false },
    gateway: {
      soundAdjust: adjust,
      getLocalMediaCapabilities: vi.fn(async () => ({
        ok: true,
        data: { ffmpeg: { available: true }, ffprobe: { available: true } }
      }))
    } as unknown as GatewayClient,
    updateProps: vi.fn(),
    updateResult: (value: string) => { result.value = value },
    emitArtifact: (value: unknown) => artifacts.push(value)
  } as unknown as NodeExecutionContext
  return { ctx, result, artifacts, adjust }
}

describe('声音调整节点契约与持久化', () => {
  it('端口区分音频与视频，版本与右侧配置入口稳定', () => {
    const spec = getNodeType('sound-adjust')!
    expect(spec.contractVersion).toBe(1)
    expect(spec.ports.in.map(({ id, type, required, cardinality }) => ({ id, type, required, cardinality }))).toEqual([
      { id: 'in-audio', type: 'audio', required: false, cardinality: 'one' },
      { id: 'in-video', type: 'video', required: false, cardinality: 'one' }
    ])
    expect(spec.ports.out.map(({ id, type, required }) => ({ id, type, required }))).toEqual([
      { id: 'out-audio', type: 'audio', required: false },
      { id: 'out-video', type: 'video', required: false }
    ])
    expect(spec.SettingsPanel).toBeTypeOf('function')
  })

  it('配置可从 JSON 恢复，目标时长换算倍率，极端倍率明确失败', () => {
    const config = parseSoundAdjustConfig(JSON.stringify({
      version: 1, mode: 'duration', rate: 1, targetDurationMs: 4000, volumePercent: 65
    }))
    expect(config).toEqual({ version: 1, mode: 'duration', rate: 1, targetDurationMs: 4000, volumePercent: 65 })
    expect(soundAdjustRate(config, 2000)).toBe(0.5)
    expect(() => soundAdjustRate(config, 100)).toThrow('0.25–4')
    expect(soundAtempoFilters(0.25)).toEqual(['atempo=0.500000', 'atempo=0.500000'])
    expect(soundAtempoFilters(4)).toEqual(['atempo=2.000000', 'atempo=2.000000'])
  })

  it('恰好一条媒体输入才执行；本次音频产物只投影音频端口并物化资产', async () => {
    const config = JSON.stringify(parseSoundAdjustConfig(''))
    for (const kind of ['none', 'both'] as const) {
      const { ctx, adjust } = context(kind, config)
      expect(await soundAdjustExecutor(ctx)).toMatchObject({ status: 'failed' })
      expect(adjust).not.toHaveBeenCalled()
    }
    const { ctx, result, artifacts, adjust } = context('audio', config)
    expect(await soundAdjustExecutor(ctx)).toEqual({ status: 'done' })
    expect(adjust).toHaveBeenCalledWith({
      projectId: 'p1', sourceMediaId: 'source-audio', kind: 'audio', config: parseSoundAdjustConfig(config)
    })
    expect(ctx.shape.props.config).toBe(config)
    expect(artifacts).toMatchObject([{ kind: 'audio', portId: 'out-audio', mediaId: 'new-media' }])
    const shape = {
      ...ctx.shape,
      meta: {
        nodeResult: result.value,
        nodeRun: { runId: 'run-adjust', status: 'success', startedAt: 1, inputs: {} }
      }
    } as NodeCardShape
    const outputs = projectNodeOutputs(shape)
    expect(outputs['out-audio']).toMatchObject({ kind: 'audio', mediaId: 'new-media' })
    expect(outputs['out-video']).toBeUndefined()
  })

  it('重复运行更换媒体类型时，不暴露上次的另一种输出', () => {
    const collection = JSON.stringify({
      kind: 'media-source',
      version: 1,
      results: [
        { mediaId: 'old-audio', mediaPath: 'old.m4a', mime: 'audio/mp4', createdAt: 1 },
        { mediaId: 'new-video', mediaPath: 'new.mp4', mime: 'video/mp4', createdAt: 2 }
      ]
    })
    const shape = {
      props: { nodeType: 'sound-adjust', title: '声音调整' },
      meta: {
        nodeResult: collection,
        nodeRun: { runId: 'run-video', status: 'success', startedAt: 1, inputs: {} }
      }
    } as NodeCardShape
    const outputs = projectNodeOutputs(shape)
    expect(outputs['out-video']).toMatchObject({ kind: 'video', mediaId: 'new-video' })
    expect(outputs['out-audio']).toBeUndefined()
  })
})
