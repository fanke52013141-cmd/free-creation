import { describe, expect, it } from 'vitest'
import { selectedSuccessMediaResult } from '../src/shared/engine/deterministic-projections'

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
  it('成功运行：取当前选中的媒体结果', () => {
    const item = selectedSuccessMediaResult(shapeWith({ nodeResult: results, nodeRun: run('success') }))
    expect(item?.mediaId).toBe('m1')
    expect(item?.mediaPath).toBe('projects/p/media/m1.png')
  })

  it('失败运行：不展示上一次的残留结果', () => {
    expect(selectedSuccessMediaResult(shapeWith({ nodeResult: results, nodeRun: run('failed') }))).toBeNull()
  })

  it('旧结果没有选中项时使用最后一个结果', () => {
    const legacy = JSON.parse(results)
    delete legacy.selectedMediaId
    expect(selectedSuccessMediaResult(shapeWith({
      nodeResult: JSON.stringify(legacy),
      nodeRun: run('success')
    }))?.mediaId).toBe('m2')
  })

  it('从未运行：不展示结果（保持「打开工作台」入口）', () => {
    expect(selectedSuccessMediaResult(shapeWith({ nodeResult: results }))).toBeNull()
  })

  it('结果为空：返回 null，不伪造媒体', () => {
    const empty = JSON.stringify({ kind: 'media-source', version: 1, results: [] })
    expect(selectedSuccessMediaResult(shapeWith({ nodeResult: empty, nodeRun: run('success') }))).toBeNull()
  })
})
