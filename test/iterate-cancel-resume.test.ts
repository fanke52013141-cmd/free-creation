// 循环节点取消语义（F08）：
// 迭代体中途取消时，当前项必须被标记为「已取消」（skipped），绝不能因为
// 部分输出非空而被标 done——否则 resume 模式会把残缺产物当作完整结果复用。
//
// 配套实现：
// - renderer/engine/executor.ts 的 runSubflowForIterate：取消时抛错，不返回部分输出；
// - shared/engine/executors/iterate.ts 的 runItem：捕获到异常时若已取消，
//   该项按取消处理（不参与 onFailure 重试，不标 done）。
// 本文件直接驱动 iterateExecutor，用会抛「取消错误」的 runSubflow 模拟渲染层行为。
import { describe, expect, it } from 'vitest'
import { iterateExecutor } from '@shared/engine/executors/iterate'
import type { NodeExecutionContext } from '@shared/engine/executor-types'
import type { CanvasNode } from '@shared/types'
import type { NodeValuePacket } from '@shared/engine/inputs'

interface RunState {
  subflowRuns: number
  results: string[]
}

interface CtxOptions {
  items: unknown[]
  /** 第几次 runSubflow 调用时触发取消（1 起算）；不设则全程不取消。 */
  cancelAtRun?: number
  runMode?: 'all' | 'resume' | 'failed'
  onFailure?: 'skip' | 'fail' | 'retry'
  previousResult?: string
}

function makeContext(options: CtxOptions): { ctx: NodeExecutionContext; state: RunState } {
  const state: RunState = { subflowRuns: 0, results: [] }
  const signal = { cancelled: false }
  const ctx = {
    node: { id: 'iterate-1', type: 'iterate', title: '循环' } as unknown as CanvasNode,
    shape: {
      props: {
        nodeType: 'iterate',
        title: '循环',
        config: JSON.stringify({
          onFailure: options.onFailure ?? 'skip',
          maxRetries: 2,
          limit: 0,
          runMode: options.runMode ?? 'all'
        }),
        text: '',
        mediaId: '',
        mediaPath: '',
        mediaMime: '',
        exec: '',
        w: 300,
        h: 200
      },
      meta: options.previousResult ? { nodeResult: options.previousResult } : {}
    },
    inputs: new Map<string, readonly NodeValuePacket[]>([
      [
        'in-list',
        [
          {
            type: 'json',
            value: { kind: 'json', data: options.items },
            source: { nodeId: 'upstream-1', portId: 'out-json', runId: 'run-0' },
            createdAt: 0
          }
        ]
      ]
    ]),
    projectId: 'project-1',
    providers: [],
    signal,
    gateway: {} as NodeExecutionContext['gateway'],
    updateProps: () => {},
    updateResult: (result: string | null) => {
      if (result) state.results.push(result)
    },
    outgoing: [{ nodeId: 'body-1', fromPortId: 'out-item', toPortId: 'in-item' }],
    runSubflow: async () => {
      state.subflowRuns += 1
      if (options.cancelAtRun !== undefined && state.subflowRuns >= options.cancelAtRun) {
        signal.cancelled = true
        throw new Error('迭代体执行已取消')
      }
      return {
        'body-1': {
          'out-image': [
            {
              type: 'image',
              value: {
                kind: 'image',
                mediaId: `m-${state.subflowRuns}`,
                mediaPath: 'p',
                mime: 'image/png'
              },
              source: {
                nodeId: 'body-1',
                portId: 'out-image',
                runId: `run-${state.subflowRuns}`
              },
              createdAt: 0
            }
          ]
        }
      }
    }
  } as unknown as NodeExecutionContext
  return { ctx, state }
}

function lastResult(state: RunState): { items: Array<{ status: string; error?: string }> } {
  return JSON.parse(state.results[state.results.length - 1]) as {
    items: Array<{ status: string; error?: string }>
  }
}

const ITEMS = [
  { id: 'a', label: '甲' },
  { id: 'b', label: '乙' },
  { id: 'c', label: '丙' }
]

describe('循环节点：中途取消语义（F08）', () => {
  it('中途取消的项标记为已取消，不得因部分输出非空而标 done', async () => {
    const { ctx, state } = makeContext({ items: ITEMS, cancelAtRun: 2 })
    const result = await iterateExecutor(ctx)
    expect(result).toEqual({ status: 'skipped', reason: '已取消' })
    const data = lastResult(state)
    expect(data.items.map((item) => item.status)).toEqual(['done', 'skipped', 'skipped'])
    expect(data.items[1].error).toContain('已取消')
  })

  it('resume 模式不复用被取消的项：仅复用已完成项，其余重跑', async () => {
    // 第一轮：第 2 项中途取消
    const first = makeContext({ items: ITEMS, cancelAtRun: 2 })
    await iterateExecutor(first.ctx)
    const firstFinal = first.state.results[first.state.results.length - 1]

    // 第二轮：resume，全程不取消；只有第 1 项可复用，第 2、3 项必须重跑
    const second = makeContext({ items: ITEMS, runMode: 'resume', previousResult: firstFinal })
    const result = await iterateExecutor(second.ctx)
    expect(result).toEqual({ status: 'done' })
    const data = lastResult(second.state)
    expect(data.items.map((item) => item.status)).toEqual(['reused', 'done', 'done'])
    expect(second.state.subflowRuns).toBe(2)
  })

  it('取消不参与 onFailure=retry 重试', async () => {
    const { ctx, state } = makeContext({
      items: ITEMS,
      cancelAtRun: 1,
      onFailure: 'retry'
    })
    const result = await iterateExecutor(ctx)
    expect(result).toEqual({ status: 'skipped', reason: '已取消' })
    expect(state.subflowRuns).toBe(1)
    expect(lastResult(state).items[0].status).toBe('skipped')
  })
})
