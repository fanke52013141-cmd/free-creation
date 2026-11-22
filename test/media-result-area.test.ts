import { describe, expect, it } from 'vitest'
import { latestSuccessMediaResult } from '../src/shared/engine/deterministic-projections'

const results = JSON.stringify({
  kind: 'media-source',
  version: 1,
  results: [
    { mediaId: 'm1', mediaPath: 'projects/p/media/m1.png', mime: 'image/png', createdAt: 1 },
    { mediaId: 'm2', mediaPath: 'projects/p/media/m2.png', mime: 'image/png', createdAt: 2 }
  ],
  selectedMediaId: 'm1'
})

const shapeWith = (meta: Record<string, unknown>) => ({ props: {}, meta }) as never
const run = (status: string) => ({ runId: 'r1', status, startedAt: 1, inputs: {} })

describe('操作节点卡内结果区数据源（D-08）', () => {
  it('成功运行：取最近一条媒体结果', () => {
    const item = latestSuccessMediaResult(shapeWith({ nodeResult: results, nodeRun: run('success') }))
    expect(item?.mediaId).toBe('m2')
    expect(item?.mediaPath).toBe('projects/p/media/m2.png')
  })

  it('失败运行：不展示上一次的残留结果', () => {
    expect(latestSuccessMediaResult(shapeWith({ nodeResult: results, nodeRun: run('failed') }))).toBeNull()
  })

  it('从未运行：不展示结果（保持「打开工作台」入口）', () => {
    expect(latestSuccessMediaResult(shapeWith({ nodeResult: results }))).toBeNull()
  })

  it('结果为空：返回 null，不伪造媒体', () => {
    const empty = JSON.stringify({ kind: 'media-source', version: 1, results: [] })
    expect(latestSuccessMediaResult(shapeWith({ nodeResult: empty, nodeRun: run('success') }))).toBeNull()
  })
})