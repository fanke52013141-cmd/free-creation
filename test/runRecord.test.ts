import { describe, expect, it } from 'vitest'
import {
  appendNodeRunTrace,
  appendNodeRunHistory,
  readNodeRunHistory,
  type NodeRunRecord
} from '@renderer/engine/runRecord'

function record(runId: string, status: NodeRunRecord['status'] = 'success'): NodeRunRecord {
  return { runId, status, startedAt: 1, finishedAt: 2, durationMs: 1, inputs: {} }
}

describe('节点运行历史', () => {
  it('只保留有效的已完成记录，按最新在前排序', () => {
    const history = appendNodeRunHistory([record('old'), { runId: 'bad' }], record('new', 'failed'))
    expect(history.map((item) => item.runId)).toEqual(['new', 'old'])
    expect(history[0].status).toBe('failed')
  })

  it('相同 runId 会被完成记录替换，运行中记录不进入历史', () => {
    const prior = [record('same', 'failed')]
    const final = appendNodeRunHistory(prior, record('same'))
    expect(final).toEqual([expect.objectContaining({ runId: 'same', status: 'success' })])
    expect(readNodeRunHistory([...final, record('working', 'running')])).toHaveLength(1)
  })

  it('运行轨迹只记录脱敏的阶段信息，并限制单次记录长度', () => {
    let next = record('trace')
    for (let index = 0; index < 30; index += 1) {
      next = appendNodeRunTrace(next, 'execution', index === 29 ? 'error' : 'info', `步骤 ${index}`)
    }
    expect(next.trace).toHaveLength(24)
    expect(next.trace?.[0]?.message).toBe('步骤 6')
    expect(next.trace?.at(-1)).toMatchObject({ level: 'error', message: '步骤 29' })
  })
})
