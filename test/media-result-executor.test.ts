import { describe, expect, it, vi, afterEach } from 'vitest'
import { imageGenExecutor } from '@renderer/engine/executors/imageGen'
import { parseMediaResultCollection } from '@renderer/nodes/nodeValues'
import type { NodeExecutionContext } from '@renderer/engine/executor-types'
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

function makeContext(nodeResult = ''): {
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
    providers: [provider],
    signal: { cancelled: false },
    updateProps: () => undefined,
    updateResult: (value) => {
      result.value = value
    }
  }
  return { ctx, result }
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('imageGenExecutor · 媒体结果集合', () => {
  it('第一次写入、第二次追加；取消和失败不追加', async () => {
    let count = 0
    globalThis.window = {
      api: {
        gateway: {
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
      }
    } as unknown as Window & typeof globalThis

    const first = makeContext()
    expect((await imageGenExecutor(first.ctx)).status).toBe('done')
    expect(parseMediaResultCollection(first.result.value ?? '')?.results).toHaveLength(1)

    const second = makeContext(first.result.value ?? '')
    expect((await imageGenExecutor(second.ctx)).status).toBe('done')
    expect(
      parseMediaResultCollection(second.result.value ?? '')?.results.map((item) => item.mediaId)
    ).toEqual(['img-1', 'img-2'])

    const cancelled = makeContext(second.result.value ?? '')
    cancelled.ctx.signal = { cancelled: true }
    expect((await imageGenExecutor(cancelled.ctx)).status).toBe('skipped')
    expect(cancelled.result.value).toBeNull()

    const failed = makeContext(second.result.value ?? '')
    expect((await imageGenExecutor(failed.ctx)).status).toBe('failed')
    expect(failed.result.value).toBeNull()
  })
})
