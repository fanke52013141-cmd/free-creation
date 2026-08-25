// 迭代控制节点执行器测试（路线图 R4 / 契约规范 P3）
//
// 覆盖 parseIterate / parseIterateResult 配置解析，以及 iterate 执行器的运行时分支：
// 并发调度、失败策略（skip / fail / retry）、取消、来源追踪、无下游 / 无列表跳过。
// runSubflow 用 mock 注入（返回非空输出视为成功、空输出视为失败）。
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  parseIterate,
  parseIterateResult,
  iterateExecutor
} from '@renderer/engine/executors/iterate'
import type { NodeExecutionContext, SubflowOutput } from '@renderer/engine/executor-types'
import type { NodeCardShape } from '@renderer/canvas/NodeCardShape'

function makeCtx(over: {
  text?: string
  list?: unknown
  downstream?: string[]
  runSubflow?: (req: { item: Record<string, unknown>; index: number }) => Promise<SubflowOutput>
  signal?: { cancelled: boolean }
}): {
  ctx: NodeExecutionContext
  props: Partial<NodeCardShape['props']>
  result: { value: string | null }
} {
  const props: Partial<NodeCardShape['props']> = {}
  const result = { value: null as string | null }
  const shape = {
    id: 'shape:1',
    type: 'node-card',
    x: 0,
    y: 0,
    rotation: 0,
    index: 'a1',
    isLocked: false,
    props: {
      w: 340,
      h: 260,
      nodeType: 'iterate',
      title: 'n',
      text: over.text ?? '',
      mediaId: '',
      mediaPath: '',
      mediaMime: '',
      exec: 'idle'
    },
    meta: {}
  } as unknown as NodeCardShape
  const inputs = new Map<
    string,
    Array<{ type: string; value: unknown; source: unknown; createdAt: number }>
  >()
  if (over.list !== undefined) {
    inputs.set('in-list', [
      {
        type: 'json',
        value: { kind: 'json', data: over.list },
        source: { nodeId: 'u', portId: 'out-items', runId: 'r1' },
        createdAt: 0
      }
    ])
  }
  const ctx: NodeExecutionContext = {
    node: {
      id: 'shape:1',
      type: 'iterate',
      contractVersion: 1,
      title: 'n',
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
    inputs: inputs as NodeExecutionContext['inputs'],
    projectId: 'p1',
    providers: [],
    signal: over.signal ?? { cancelled: false },
    downstream: over.downstream ?? ['node-body'],
    updateProps: (patch) => Object.assign(props, patch),
    updateResult: (r) => {
      result.value = r
    },
    runSubflow: (req) =>
      over.runSubflow
        ? over.runSubflow(req)
        : Promise.resolve({
            'node-body': {
              'out-x': {
                value: { ok: true },
                type: 'json',
                source: { nodeId: 'n', portId: 'p', runId: 'r' },
                createdAt: 0
              }
            }
          })
  }
  return { ctx, props, result }
}

beforeEach(() => {
  vi.restoreAllMocks()
})
afterEach(() => {
  vi.restoreAllMocks()
})

describe('parseIterate · 配置解析', () => {
  it('解析完整配置', () => {
    const cfg = parseIterate(
      JSON.stringify({
        itemVar: 'shot',
        onFailure: 'retry',
        maxRetries: 3,
        concurrency: 4,
        limit: 10
      })
    )
    expect(cfg).toEqual({
      itemVar: 'shot',
      onFailure: 'retry',
      maxRetries: 3,
      concurrency: 4,
      limit: 10
    })
  })

  it('空文本 / 非法 JSON 安全降级', () => {
    expect(parseIterate('')).toEqual({
      itemVar: 'item',
      onFailure: 'skip',
      maxRetries: 0,
      concurrency: 2,
      limit: 0
    })
    expect(parseIterate('{bad')).toEqual({
      itemVar: 'item',
      onFailure: 'skip',
      maxRetries: 0,
      concurrency: 2,
      limit: 0
    })
  })
})

describe('parseIterateResult · 结果读取', () => {
  it('解析带 items 的结果', () => {
    const text = JSON.stringify({
      items: [{ status: 'done', source: { index: 0, itemId: 's1' } }]
    })
    expect(parseIterateResult(text)?.items).toHaveLength(1)
  })

  it('无 items / 非法 JSON 返回 null', () => {
    expect(parseIterateResult('{}')).toBeNull()
    expect(parseIterateResult('{bad')).toBeNull()
    expect(parseIterateResult('')).toBeNull()
  })
})

describe('iterate 执行器 · 成功批量', () => {
  it('并发调度列表每一项并输出结构化结果', async () => {
    const seen: number[] = []
    const { ctx, props, result } = makeCtx({
      text: JSON.stringify({ concurrency: 2, limit: 0 }),
      list: [{ id: 's1' }, { id: 's2' }, { id: 's3' }],
      runSubflow: async (req) => {
        seen.push(req.index)
        return {
          'node-body': {
            'out-x': {
              value: { idx: req.index },
              type: 'json',
              source: { nodeId: 'n', portId: 'p', runId: 'r' },
              createdAt: 0
            }
          }
        }
      }
    })
    const r = await iterateExecutor(ctx)
    expect(r.status).toBe('done')
    expect(seen.sort((a, b) => a - b)).toEqual([0, 1, 2])
    const data = JSON.parse(props.text as string)
    expect(data.items).toHaveLength(3)
    expect(data.items.every((it: { status: string }) => it.status === 'done')).toBe(true)
    // 来源追踪
    expect(data.items[0].source.itemId).toBe('s1')
    expect(data.items[2].source.index).toBe(2)
    // updateResult 也写入
    expect(JSON.parse(result.value as string).items).toHaveLength(3)
  })

  it('limit 限制只处理前 N 条', async () => {
    const seen: number[] = []
    const { ctx } = makeCtx({
      text: JSON.stringify({ limit: 2 }),
      list: [{ id: 'a' }, { id: 'b' }, { id: 'c' }],
      runSubflow: async (req) => {
        seen.push(req.index)
        return {
          'node-body': {
            'out-x': {
              value: 1,
              type: 'json',
              source: { nodeId: 'n', portId: 'p', runId: 'r' },
              createdAt: 0
            }
          }
        }
      }
    })
    await iterateExecutor(ctx)
    expect(seen.sort()).toEqual([0, 1])
  })
})

describe('iterate 执行器 · 失败策略', () => {
  const noOutput = (): Promise<SubflowOutput> => Promise.resolve({})

  it('skip：失败项标 failed，其余继续', async () => {
    const { ctx, props } = makeCtx({
      text: JSON.stringify({ onFailure: 'skip' }),
      list: [{ id: 'a' }, { id: 'b' }],
      runSubflow: async (req) =>
        req.index === 1
          ? noOutput()
          : Promise.resolve({
              n: {
                out: {
                  value: 1,
                  type: 'json',
                  source: { nodeId: 'n', portId: 'p', runId: 'r' },
                  createdAt: 0
                }
              }
            })
    })
    const r = await iterateExecutor(ctx)
    expect(r.status).toBe('done')
    const items = JSON.parse(props.text as string).items
    expect(items[0].status).toBe('done')
    expect(items[1].status).toBe('failed')
  })

  it('fail：首个失败即中止，其余未开始项标 skipped', async () => {
    const { ctx, props } = makeCtx({
      text: JSON.stringify({ onFailure: 'fail', concurrency: 1 }),
      list: [{ id: 'a' }, { id: 'b' }, { id: 'c' }],
      runSubflow: async (req) =>
        req.index === 0
          ? noOutput()
          : Promise.resolve({
              n: {
                out: {
                  value: 1,
                  type: 'json',
                  source: { nodeId: 'n', portId: 'p', runId: 'r' },
                  createdAt: 0
                }
              }
            })
    })
    const r = await iterateExecutor(ctx)
    expect(r.status).toBe('failed')
    const items = JSON.parse(props.text as string).items
    expect(items[0].status).toBe('failed')
    // 首项失败后中止：后续未开始项 -> skipped
    expect(items[1].status).toBe('skipped')
    expect(items[2].status).toBe('skipped')
  })

  it('retry：失败重试后成功', async () => {
    let calls = 0
    const { ctx, props } = makeCtx({
      text: JSON.stringify({ onFailure: 'retry', maxRetries: 2 }),
      list: [{ id: 'a' }],
      runSubflow: async () => {
        calls += 1
        if (calls < 2) return noOutput()
        return {
          n: {
            out: {
              value: 1,
              type: 'json',
              source: { nodeId: 'n', portId: 'p', runId: 'r' },
              createdAt: 0
            }
          }
        }
      }
    })
    const r = await iterateExecutor(ctx)
    expect(r.status).toBe('done')
    expect(calls).toBe(2)
    expect(JSON.parse(props.text as string).items[0].status).toBe('done')
  })
})

describe('iterate 执行器 · 取消 / 跳过条件', () => {
  it('无列表输入 → 跳过', async () => {
    const { ctx } = makeCtx({ text: '{}' })
    const r = await iterateExecutor(ctx)
    expect(r.status).toBe('skipped')
    expect(r.reason).toContain('列表')
  })

  it('无下游迭代体 → 跳过', async () => {
    const { ctx } = makeCtx({ text: '{}', list: [{ id: 'a' }], downstream: [] })
    const r = await iterateExecutor(ctx)
    expect(r.status).toBe('skipped')
    expect(r.reason).toContain('迭代体')
  })

  it('已取消信号 → 跳过', async () => {
    const { ctx } = makeCtx({
      text: '{}',
      list: [{ id: 'a' }],
      signal: { cancelled: true },
      runSubflow: async () => ({
        n: {
          out: {
            value: 1,
            type: 'json',
            source: { nodeId: 'n', portId: 'p', runId: 'r' },
            createdAt: 0
          }
        }
      })
    })
    const r = await iterateExecutor(ctx)
    expect(r.status).toBe('skipped')
  })
})
