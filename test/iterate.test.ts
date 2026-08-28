// 循环节点执行器测试（原迭代控制节点）
//
// 覆盖 parseIterate / parseIterateResult 配置解析，以及 iterate 执行器的运行时分支：
// 顺序调度、失败策略（skip / fail / retry）、子流程抛错容错、取消、来源追踪、无下游 / 无列表跳过。
// runSubflow 用 mock 注入（返回非空输出视为成功、空输出视为失败、抛错视为子流程崩溃）。
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
  outgoing?: NodeExecutionContext['outgoing']
  runSubflow?: (req: { item: Record<string, unknown>; index: number }) => Promise<SubflowOutput>
  signal?: { cancelled: boolean; paused?: boolean }
  waitForResume?: () => Promise<void>
  previousResult?: string
}): {
  ctx: NodeExecutionContext
  props: Partial<NodeCardShape['props']>
  result: { value: string | null }
  resultUpdates: string[]
} {
  const props: Partial<NodeCardShape['props']> = {}
  const result = { value: null as string | null }
  const resultUpdates: string[] = []
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
      config: over.text ?? '',
      text: '',
      mediaId: '',
      mediaPath: '',
      mediaMime: '',
      exec: 'idle'
    },
    meta: over.previousResult ? { nodeResult: over.previousResult } : {}
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
    signal: over.signal ?? { cancelled: false, paused: false },
    waitForResume: over.waitForResume,
    outgoing: over.outgoing ?? [
      { nodeId: 'node-body', fromPortId: 'out-item', toPortId: 'in-json' }
    ],
    updateProps: (patch) => Object.assign(props, patch),
    updateResult: (r) => {
      result.value = r
      if (r) resultUpdates.push(r)
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
  return { ctx, props, result, resultUpdates }
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
        onFailure: 'retry',
        maxRetries: 3,
        limit: 10
      })
    )
    expect(cfg).toEqual({
      onFailure: 'retry',
      maxRetries: 3,
      limit: 10,
      runMode: 'all'
    })
  })

  it('空文本 / 非法 JSON 安全降级', () => {
    expect(parseIterate('')).toEqual({
      onFailure: 'skip',
      maxRetries: 0,
      limit: 0,
      runMode: 'all'
    })
    expect(parseIterate('{bad')).toEqual({
      onFailure: 'skip',
      maxRetries: 0,
      limit: 0,
      runMode: 'all'
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
  it('顺序处理列表每一项并输出结构化结果', async () => {
    const seen: number[] = []
    const { ctx, props, result } = makeCtx({
      text: JSON.stringify({ limit: 0 }),
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
    // 顺序执行：序号严格递增。
    expect(seen).toEqual([0, 1, 2])
    const data = JSON.parse(result.value as string)
    expect(data.items).toHaveLength(3)
    expect(data.items.every((it: { status: string }) => it.status === 'done')).toBe(true)
    // 来源追踪
    expect(data.items[0].source.itemId).toBe('s1')
    expect(data.items[2].source.index).toBe(2)
    // 配置/结果分离：props.config 只存配置，不含 items
    const configOnly = JSON.parse(props.config as string)
    expect(configOnly.items).toBeUndefined()
    expect(configOnly.limit).toBe(0)
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
    const { ctx, result } = makeCtx({
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
    const items = JSON.parse(result.value as string).items
    expect(items[0].status).toBe('done')
    expect(items[1].status).toBe('failed')
  })

  it('fail：首个失败即中止，其余未开始项标 skipped', async () => {
    const { ctx, result } = makeCtx({
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
    const items = JSON.parse(result.value as string).items
    expect(items[0].status).toBe('failed')
    // 首项失败后中止：后续未开始项 -> skipped
    expect(items[1].status).toBe('skipped')
    expect(items[2].status).toBe('skipped')
  })

  it('retry：失败重试后成功', async () => {
    let calls = 0
    const { ctx, result } = makeCtx({
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
    expect(JSON.parse(result.value as string).items[0].status).toBe('done')
  })
})

describe('iterate 执行器 · 取消 / 跳过条件', () => {
  it('无列表输入 → 跳过', async () => {
    const { ctx } = makeCtx({ text: '{}' })
    const r = await iterateExecutor(ctx)
    expect(r.status).toBe('skipped')
    expect(r.reason).toContain('列表')
  })

  it('没有从当前项端口连接循环体 → 跳过', async () => {
    const { ctx } = makeCtx({ text: '{}', list: [{ id: 'a' }], outgoing: [] })
    const r = await iterateExecutor(ctx)
    expect(r.status).toBe('skipped')
    expect(r.reason).toContain('循环体')
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

  it('仅把 out-item 目标当作循环体，out-items 可安全连接汇总节点', async () => {
    const seen: Array<{ nodeIds: string[]; targets: unknown }> = []
    const { ctx } = makeCtx({
      text: '{}',
      list: [{ id: 'a' }],
      outgoing: [
        { nodeId: 'prompt-node', fromPortId: 'out-item', toPortId: 'in-context' },
        { nodeId: 'summary-node', fromPortId: 'out-items', toPortId: 'in-list' }
      ],
      runSubflow: async (req) => {
        seen.push({ nodeIds: req.nodeIds, targets: req.itemTargets })
        return {
          'prompt-node': {
            out: {
              value: { ok: true },
              type: 'json',
              source: { nodeId: 'n', portId: 'p', runId: 'r' },
              createdAt: 0
            }
          }
        }
      }
    })
    await iterateExecutor(ctx)
    expect(seen).toEqual([
      {
        nodeIds: ['prompt-node'],
        targets: [{ nodeId: 'prompt-node', portId: 'in-context' }]
      }
    ])
  })
})

describe('iterate 执行器 · 严格串行（无并发重叠）', () => {
  it('item 严格按顺序执行', async () => {
    const timeline: Array<{ index: number; phase: 'start' | 'end' }> = []
    const { ctx } = makeCtx({
      text: JSON.stringify({}),
      list: [{ id: 'a' }, { id: 'b' }, { id: 'c' }],
      runSubflow: async (req) => {
        timeline.push({ index: req.index, phase: 'start' })
        await new Promise((r) => setTimeout(r, 5))
        timeline.push({ index: req.index, phase: 'end' })
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
    // 串行：每项的 end 紧随该项 start 之后，下一项 start 不与上一项重叠
    expect(timeline.map((t) => `${t.index}:${t.phase}`).join(',')).toBe(
      '0:start,0:end,1:start,1:end,2:start,2:end'
    )
  })
})

describe('iterate 执行器 · 子流程抛错的容错', () => {
  it('runSubflow 抛错时该项标 failed 并带上错误信息（onFailure=skip，其余继续）', async () => {
    const { ctx, result } = makeCtx({
      text: JSON.stringify({ onFailure: 'skip' }),
      list: [{ id: 'a' }, { id: 'b' }],
      runSubflow: async (req) => {
        if (req.index === 0) throw new Error('子流程内部崩溃')
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
    const r = await iterateExecutor(ctx)
    expect(r.status).toBe('done')
    const items = JSON.parse(result.value as string).items
    expect(items[0].status).toBe('failed')
    expect(items[0].error).toContain('子流程内部崩溃')
    expect(items[1].status).toBe('done')
  })

  it('runSubflow 抛错且 onFailure=fail 时立即中止，剩余项标 skipped', async () => {
    const { ctx, result } = makeCtx({
      text: JSON.stringify({ onFailure: 'fail' }),
      list: [{ id: 'a' }, { id: 'b' }, { id: 'c' }],
      runSubflow: async (req) => {
        if (req.index === 0) throw new Error('崩溃')
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
    const r = await iterateExecutor(ctx)
    expect(r.status).toBe('failed')
    const items = JSON.parse(result.value as string).items
    expect(items[0].status).toBe('failed')
    expect(items[1].status).toBe('skipped')
    expect(items[2].status).toBe('skipped')
  })

  it('runSubflow 抛错且 onFailure=retry 时重试后成功', async () => {
    let calls = 0
    const { ctx, result } = makeCtx({
      text: JSON.stringify({ onFailure: 'retry', maxRetries: 2 }),
      list: [{ id: 'a' }],
      runSubflow: async () => {
        calls += 1
        if (calls < 2) throw new Error('暂时失败')
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
    const r = await iterateExecutor(ctx)
    expect(r.status).toBe('done')
    expect(calls).toBe(2)
    expect(JSON.parse(result.value as string).items[0].status).toBe('done')
  })
})

describe('iterate 执行器 · P3.2 恢复与检查点', () => {
  const outputFor = (index: number): SubflowOutput => ({
    body: {
      out: {
        value: { index },
        type: 'json',
        source: { nodeId: 'body', portId: 'out', runId: 'run' },
        createdAt: 0
      }
    }
  })

  it('运行期间持续写入可观察进度，而不是完成后才出现结果', async () => {
    const { ctx, resultUpdates } = makeCtx({
      list: [{ id: 'a' }, { id: 'b' }],
      runSubflow: async (req) => outputFor(req.index)
    })
    await iterateExecutor(ctx)
    expect(resultUpdates.map((value) => JSON.parse(value).progress.completed)).toEqual([0, 1, 2, 2])
  })

  it('续跑只复用稳定 ID 和内容指纹都匹配的成功项', async () => {
    const first = makeCtx({
      list: [
        { id: 'a', prompt: 'A' },
        { id: 'b', prompt: 'B' }
      ],
      runSubflow: async (req) => (req.index === 0 ? outputFor(req.index) : ({} as SubflowOutput))
    })
    await iterateExecutor(first.ctx)

    const seen: number[] = []
    const resumed = makeCtx({
      text: JSON.stringify({ runMode: 'resume' }),
      list: [
        { id: 'a', prompt: 'A' },
        { id: 'b', prompt: 'B' }
      ],
      previousResult: first.result.value ?? undefined,
      runSubflow: async (req) => {
        seen.push(req.index)
        return outputFor(req.index)
      }
    })
    await iterateExecutor(resumed.ctx)
    const items = JSON.parse(resumed.result.value as string).items
    expect(seen).toEqual([1])
    expect(items[0].status).toBe('reused')
    expect(items[1].status).toBe('done')
  })

  it('同一 ID 的内容已改变时必须重新运行，不能误复用旧产物', async () => {
    const first = makeCtx({
      list: [{ id: 'a', prompt: '旧描述' }],
      runSubflow: async (req) => outputFor(req.index)
    })
    await iterateExecutor(first.ctx)

    const seen: number[] = []
    const resumed = makeCtx({
      text: JSON.stringify({ runMode: 'resume' }),
      list: [{ id: 'a', prompt: '新描述' }],
      previousResult: first.result.value ?? undefined,
      runSubflow: async (req) => {
        seen.push(req.index)
        return outputFor(req.index)
      }
    })
    await iterateExecutor(resumed.ctx)
    expect(seen).toEqual([0])
    expect(JSON.parse(resumed.result.value as string).items[0].status).toBe('done')
  })

  it('已复用的成功项可在下一次续跑继续复用', async () => {
    const first = makeCtx({
      list: [{ id: 'a', prompt: 'A' }],
      runSubflow: async (req) => outputFor(req.index)
    })
    await iterateExecutor(first.ctx)
    const second = makeCtx({
      text: JSON.stringify({ runMode: 'resume' }),
      list: [{ id: 'a', prompt: 'A' }],
      previousResult: first.result.value ?? undefined,
      runSubflow: async (req) => outputFor(req.index)
    })
    await iterateExecutor(second.ctx)

    const thirdCalls: number[] = []
    const third = makeCtx({
      text: JSON.stringify({ runMode: 'resume' }),
      list: [{ id: 'a', prompt: 'A' }],
      previousResult: second.result.value ?? undefined,
      runSubflow: async (req) => {
        thirdCalls.push(req.index)
        return outputFor(req.index)
      }
    })
    await iterateExecutor(third.ctx)
    expect(thirdCalls).toEqual([])
    expect(JSON.parse(third.result.value as string).items[0].status).toBe('reused')
  })

  it('只重跑失败项，不触碰上轮成功或新加入的项', async () => {
    const first = makeCtx({
      list: [{ id: 'a' }, { id: 'b' }],
      runSubflow: async (req) => (req.index === 0 ? outputFor(req.index) : ({} as SubflowOutput))
    })
    await iterateExecutor(first.ctx)

    const seen: number[] = []
    const retry = makeCtx({
      text: JSON.stringify({ runMode: 'failed' }),
      list: [{ id: 'a' }, { id: 'b' }, { id: 'new' }],
      previousResult: first.result.value ?? undefined,
      runSubflow: async (req) => {
        seen.push(req.index)
        return outputFor(req.index)
      }
    })
    await iterateExecutor(retry.ctx)
    const items = JSON.parse(retry.result.value as string).items
    expect(seen).toEqual([1])
    expect(items.map((item: { status: string }) => item.status)).toEqual([
      'skipped',
      'done',
      'skipped'
    ])
  })

  it('每项之间等待恢复信号，暂停不会打断正在执行的项', async () => {
    const waitForResume = vi.fn(async () => undefined)
    const { ctx } = makeCtx({
      list: [{ id: 'a' }, { id: 'b' }],
      waitForResume,
      runSubflow: async (req) => outputFor(req.index)
    })
    await iterateExecutor(ctx)
    expect(waitForResume).toHaveBeenCalledTimes(2)
  })

  it('损坏的历史结果或重复稳定身份都不会被恢复逻辑错误复用', async () => {
    const seen: number[] = []
    const { ctx } = makeCtx({
      text: JSON.stringify({ runMode: 'resume' }),
      list: [
        { id: 'same', prompt: 'A' },
        { id: 'same', prompt: 'A' }
      ],
      previousResult: JSON.stringify({ items: [{ status: 'done' }, null] }),
      runSubflow: async (req) => {
        seen.push(req.index)
        return outputFor(req.index)
      }
    })
    await iterateExecutor(ctx)
    expect(seen).toEqual([0, 1])
  })
})
