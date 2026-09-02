import { describe, expect, it, vi, afterEach } from 'vitest'
import { imageGenExecutor } from '@renderer/engine/executors/imageGen'
import { parseMediaResultCollection } from '@renderer/nodes/nodeValues'
import type { NodeExecutionContext } from '@renderer/engine/executor-types'
import type { GatewayClient } from '@shared/engine/gateway-client'
import type { NodeCardShape } from '@renderer/canvas/NodeCardShape'
import type { ProviderConfig } from '@shared/types'

const provider: ProviderConfig = {
  id: 'p1',
  name: '测试供应商',
  specId: 'openai-compatible',
  baseURL: 'https://example.com',
  apiKey: 'local-test-key',
  createdAt: 0,
  models: [{ id: 'img-1', name: '图片模型', modality: 'image', providerId: 'p1' }]
}

let currentGateway: Record<string, unknown> = {}

function makeContext(
  nodeResult = '',
  runId = 'run-default'
): {
  ctx: NodeExecutionContext
  result: { value: string | null }
} {
  const result = { value: null as string | null }
  const shape = {
    id: 'shape:media-result',
    type: 'node-card',
    x: 0,
    y: 0,
    rotation: 0,
    index: 'a1',
    isLocked: false,
    props: {
      w: 340,
      h: 260,
      nodeType: 'image-gen',
      title: '生图',
      config: JSON.stringify({ prompt: '画面', modelKey: 'p1::img-1', size: 'auto' }),
      text: '',
      mediaId: '',
      mediaPath: '',
      mediaMime: '',
      exec: 'idle'
    },
    meta: nodeResult ? { nodeResult } : {}
  } as unknown as NodeCardShape
  const ctx: NodeExecutionContext = {
    node: {
      id: 'shape:media-result',
      type: 'image-gen',
      contractVersion: 1,
      title: '生图',
      x: 0,
      y: 0,
      w: 340,
      h: 260,
      ports: [],
      params: {},
      content: { kind: 'empty' },
      exec: { status: 'idle' },
      meta: { source: 'input', createdAt: 0 }
    },
    shape,
    inputs: new Map(),
    projectId: 'p1',
    runId,
    providers: [provider],
    signal: { cancelled: false },
    gateway: currentGateway as unknown as GatewayClient,
    updateProps: () => undefined,
    updateResult: (value) => {
      result.value = value
    }
  }
  return { ctx, result }
}

afterEach(() => {
  vi.restoreAllMocks()
  currentGateway = {}
})

describe('imageGenExecutor · 媒体结果集合', () => {
  it('第一次写入、第二次追加；取消和失败不追加', async () => {
    let count = 0
    currentGateway = {
      imageGenerate: vi.fn(async () => {
        count += 1
        if (count === 3) return { ok: false, error: { message: '供应商失败' } }
        return {
          ok: true,
          data: {
            id: `img-${count}`,
            path: `/tmp/img-${count}.png`,
            mime: 'image/png',
            name: `图片 ${count}`
          }
        }
      })
    }

    const first = makeContext('', 'run-first')
    expect((await imageGenExecutor(first.ctx)).status).toBe('done')
    expect(parseMediaResultCollection(first.result.value ?? '')?.results).toEqual([
      expect.objectContaining({ mediaId: 'img-1', runId: 'run-first' })
    ])

    const second = makeContext(first.result.value ?? '', 'run-second')
    expect((await imageGenExecutor(second.ctx)).status).toBe('done')
    expect(parseMediaResultCollection(second.result.value ?? '')?.results).toEqual([
      expect.objectContaining({ mediaId: 'img-1', runId: 'run-first' }),
      expect.objectContaining({ mediaId: 'img-2', runId: 'run-second' })
    ])

    const cancelled = makeContext(second.result.value ?? '')
    cancelled.ctx.signal = { cancelled: true }
    expect((await imageGenExecutor(cancelled.ctx)).status).toBe('skipped')
    expect(cancelled.result.value).toBeNull()

    const failed = makeContext(second.result.value ?? '')
    expect((await imageGenExecutor(failed.ctx)).status).toBe('failed')
    expect(failed.result.value).toBeNull()
  })
})
