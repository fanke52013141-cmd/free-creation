import { beforeEach, describe, expect, it, vi } from 'vitest'

const settings = vi.hoisted(() => new Map<string, string>())

vi.mock('../src/main/store/db', () => ({
  getSetting: (key: string): string | null => settings.get(key) ?? null,
  setSetting: (key: string, value: string): void => {
    settings.set(key, value)
  },
  getDb: () => ({ prepare: () => ({ all: () => [], run: () => ({ changes: 0 }) }) })
}))

import {
  MAX_IMAGE_GENERATION_TIMING_SAMPLES_PER_MODEL,
  getImageGenerationTimings,
  recordImageGenerationTiming
} from '../src/main/store/workspace-state.repo'
import { IPC } from '../src/shared/contracts'

beforeEach(() => settings.clear())

describe('图片生成耗时统计契约', () => {
  it('使用独立 workspace IPC 通道，读取原始受限样本供 renderer 聚合', () => {
    expect(IPC.workspace.recordImageGenerationTiming).toBe('workspace:image-generation-timing:record')
    expect(IPC.workspace.getImageGenerationTimings).toBe('workspace:image-generation-timings:get')
  })

  it('按 provider + model 保存原始样本，读取按记录时间倒序返回', () => {
    recordImageGenerationTiming({
      runId: 'run-1',
      providerKey: 'toapis',
      modelKey: 'gpt-image-2',
      durationMs: 10_000,
      recordedAt: 1_700_000_000_000
    })
    recordImageGenerationTiming({
      runId: 'run-2',
      providerKey: 'toapis',
      modelKey: 'gpt-image-2-vip',
      durationMs: 20_000,
      recordedAt: 1_700_000_001_000
    })

    expect(getImageGenerationTimings()).toEqual([
      expect.objectContaining({ runId: 'run-2', modelKey: 'gpt-image-2-vip' }),
      expect.objectContaining({ runId: 'run-1', modelKey: 'gpt-image-2' })
    ])
  })

  it('每个 provider/model 最多保留最近 20 条，持久化项白名单排除 prompt/API key/媒体字段', () => {
    for (let index = 0; index < MAX_IMAGE_GENERATION_TIMING_SAMPLES_PER_MODEL + 3; index += 1) {
      recordImageGenerationTiming({
        runId: `run-${index}`,
        providerKey: 'relay',
        modelKey: 'gpt-image-2',
        durationMs: 1_000 + index,
        recordedAt: 1_700_000_000_000 + index
      })
    }
    expect(getImageGenerationTimings()).toHaveLength(MAX_IMAGE_GENERATION_TIMING_SAMPLES_PER_MODEL)
    recordImageGenerationTiming({
      runId: 'run-extra-fields',
      providerKey: 'relay',
      modelKey: 'gpt-image-2-vip',
      durationMs: 1_000,
      recordedAt: 1_700_000_100_000,
      prompt: 'must-never-persist',
      apiKey: 'must-never-persist',
      mediaId: 'must-never-persist'
    } as unknown as Parameters<typeof recordImageGenerationTiming>[0])
    const raw = [...settings.values()].join(' ')
    expect(raw).not.toContain('must-never-persist')
  })

  it('同一 runId 幂等去重，重载或重试回调不能重复采样', () => {
    const sample = {
      runId: 'run-once',
      providerKey: 'toapis',
      modelKey: 'gpt-image-2',
      durationMs: 1_000,
      recordedAt: 1_700_000_000_000
    }
    recordImageGenerationTiming(sample)
    recordImageGenerationTiming(sample)
    expect(getImageGenerationTimings()).toEqual([sample])
  })

  it('拒绝异常 key、不合理耗时和无效记录时间', () => {
    expect(() =>
      recordImageGenerationTiming({
        runId: 'r',
        providerKey: 'provider key',
        modelKey: 'm',
        durationMs: 1_000,
        recordedAt: 1_700_000_000_000
      })
    ).toThrow('供应商标识格式无效')
    expect(() =>
      recordImageGenerationTiming({
        runId: 'r',
        providerKey: 'provider',
        modelKey: 'm',
        durationMs: 99,
        recordedAt: 1_700_000_000_000
      })
    ).toThrow('图片生成耗时必须是')
    expect(() =>
      recordImageGenerationTiming({
        runId: 'r',
        providerKey: 'provider',
        modelKey: 'm',
        durationMs: 1_000,
        recordedAt: 0
      })
    ).toThrow('图片生成记录时间格式无效')
  })
})
