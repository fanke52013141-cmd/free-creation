import { describe, expect, it, vi } from 'vitest'
import { compositeExecutor } from '../src/shared/engine/executors/composite'
import type { CompositeManifest } from '../src/shared/composite/manifest'
import type { NodeExecutionContext } from '../src/shared/engine/executor-types'

const manifest: CompositeManifest = {
  schemaVersion: 1,
  capabilityId: 'character-design',
  version: '1.0',
  name: '人物设计',
  inputs: [],
  outputs: [
    {
      id: 'portrait',
      label: '人物设计图',
      type: 'image',
      required: true,
      cardinality: 'one',
      source: { nodeId: 'n1', portId: 'out-image' }
    }
  ],
  graph: {
    nodes: [
      {
        id: 'n1',
        nodeType: 'image-gen',
        contractVersion: 1,
        title: '出图',
        dx: 0,
        dy: 0,
        w: 340,
        h: 260
      }
    ],
    edges: []
  }
}

function context(overrides: Partial<NodeExecutionContext> = {}): NodeExecutionContext {
  return {
    node: { id: 'shape:composite', type: 'composite', title: '人物设计', contractVersion: 1 } as never,
    shape: {
      id: 'shape:composite',
      type: 'node-card',
      props: { nodeType: 'composite', title: '人物设计', config: JSON.stringify({ manifest }) }
    } as never,
    inputs: new Map(),
    projectId: 'project',
    providers: [],
    signal: { cancelled: false, paused: false, onCancel: () => () => undefined } as never,
    gateway: {} as never,
    updateProps: vi.fn(),
    updateResult: vi.fn(),
    runComposite: vi.fn(async () => ({
      status: 'done' as const,
      media: { mediaId: 'media-1', mediaPath: 'projects/a.png', mime: 'image/png' },
      stepCount: 1
    })),
    ...overrides
  }
}

describe('composite executor（P2）', () => {
  it('把隔离执行返回的公开媒体写回组合节点 nodeResult', async () => {
    const ctx = context()
    const result = await compositeExecutor(ctx)
    expect(result.status).toBe('done')
    const written = vi.mocked(ctx.updateResult).mock.calls[0]?.[0]
    expect(String(written)).toContain('media-1')
    expect(String(written)).toContain('projects/a.png')
  })

  it('没有注入隔离执行服务时失败而不是伪造成功', async () => {
    const ctx = context({ runComposite: undefined })
    const result = await compositeExecutor(ctx)
    expect(result.status).toBe('failed')
    expect(result.reason).toContain('组合执行服务未注册')
  })

  it('内部失败透传原因，不写产物', async () => {
    const ctx = context({
      runComposite: vi.fn(async () => ({ status: 'failed' as const, reason: '内部节点失败：n1' }))
    })
    const result = await compositeExecutor(ctx)
    expect(result).toMatchObject({ status: 'failed', reason: '内部节点失败：n1' })
    expect(ctx.updateResult).not.toHaveBeenCalled()
  })

  it('W4：内部失败的结构化节点/端口透传到执行器结果，不在边界丢弃', async () => {
    const ctx = context({
      runComposite: vi.fn(async () => ({
        status: 'failed' as const,
        reason: '内部节点失败：n1',
        failure: { code: 'NODE_FAILED', phase: 'step' as const, nodeId: 'n1', portId: 'out-text' }
      }))
    })
    const result = await compositeExecutor(ctx)
    expect(result.status).toBe('failed')
    expect(result.failureNodeId).toBe('n1')
    expect(result.failurePortId).toBe('out-text')
    expect(result.diagnosticPhase).toBe('execution')
  })

  it('W4：输出阶段失败携带节点/端口，diagnosticPhase 归 output', async () => {
    const ctx = context({
      runComposite: vi.fn(async () => ({
        status: 'failed' as const,
        reason: '公开输出缺失',
        failure: {
          code: 'REQUIRED_OUTPUT_MISSING',
          phase: 'output' as const,
          nodeId: 'n1',
          portId: 'out-image'
        }
      }))
    })
    const result = await compositeExecutor(ctx)
    expect(result.diagnosticPhase).toBe('output')
    expect(result.failureNodeId).toBe('n1')
    expect(result.failurePortId).toBe('out-image')
  })
})
