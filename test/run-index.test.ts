import { describe, expect, it } from 'vitest'
import type { NodeCardShape } from '@renderer/canvas/NodeCardShape'
import { buildRunIndex, filterRunIndex } from '@renderer/engine/run-index'

function shape(id: string, title: string, meta: Record<string, unknown>): NodeCardShape {
  return {
    id: id as never,
    type: 'node-card',
    x: 0,
    y: 0,
    rotation: 0,
    index: 'a1' as never,
    isLocked: false,
    props: {
      w: 340,
      h: 260,
      nodeType: 'image-gen',
      title,
      config: '',
      text: '',
      mediaId: '',
      mediaPath: '',
      mediaMime: '',
      exec: 'idle'
    },
    meta
  }
}

const successfulRun = {
  runId: 'run-success',
  status: 'success',
  startedAt: 300,
  finishedAt: 400,
  durationMs: 100,
  inputs: { 'in-text': [{ nodeId: 'shape:text', portId: 'out-text' }] },
  outputPorts: ['out-image']
}

describe('跨节点运行索引', () => {
  it('合并最近记录与历史记录，并按 runId 去重、按时间排序', () => {
    const entries = buildRunIndex([
      shape('shape:image', '生图', {
        nodeRun: successfulRun,
        nodeRunHistory: [
          successfulRun,
          {
            runId: 'run-failed',
            status: 'failed',
            startedAt: 100,
            finishedAt: 200,
            inputs: {},
            error: { phase: 'execution', reason: '供应商失败' }
          }
        ]
      }),
      shape('shape:video', '视频', {
        nodeRun: { runId: 'run-running', status: 'running', startedAt: 500, inputs: {} }
      })
    ])

    expect(entries.map((entry) => entry.runId)).toEqual([
      'run-running',
      'run-success',
      'run-failed'
    ])
    expect(entries.find((entry) => entry.runId === 'run-success')).toMatchObject({
      nodeId: 'shape:image',
      isLatest: true
    })
  })

  it('按状态、节点、运行 ID 和安全端口关键词筛选', () => {
    const entries = buildRunIndex([
      shape('shape:image', '生图', { nodeRun: successfulRun }),
      shape('shape:video', '视频', {
        nodeRun: { runId: 'run-failed', status: 'failed', startedAt: 500, inputs: {} }
      })
    ])
    expect(
      filterRunIndex(entries, { status: 'success', keyword: 'out-text' }).map(
        (entry) => entry.runId
      )
    ).toEqual(['run-success'])
    expect(
      filterRunIndex(entries, { status: 'all', keyword: '', nodeId: 'shape:video' })
    ).toHaveLength(1)
    expect(
      filterRunIndex(entries, { status: 'all', keyword: '', runId: 'run-success' })
    ).toHaveLength(1)
  })
})
