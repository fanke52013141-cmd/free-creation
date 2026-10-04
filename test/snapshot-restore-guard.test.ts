// T05（F02）：快照恢复媒体预检的纯函数测试。
// 五步恢复流程（检查点→预检→应用→验证→回滚）在 CanvasSidePanel 中，纯逻辑在此固化。
import { describe, expect, it } from 'vitest'
import {
  checkSnapshotMedia,
  extractSnapshotMediaIds,
  diffSnapshotMedia
} from '@renderer/canvas/snapshot-restore'

const makeSnapshot = (mediaIds: Array<string | undefined>) => ({
  store: Object.fromEntries(
    mediaIds.map((id, i) => [
      `shape:node-${i}`,
      {
        type: 'node-card',
        props: { nodeType: 'image', mediaId: id, mediaPath: id ? `projects/p/media/${id}.png` : '' }
      }
    ])
  )
})

describe('extractSnapshotMediaIds', () => {
  it('提取全部节点引用的媒体 ID 并去重', () => {
    expect(extractSnapshotMediaIds(makeSnapshot(['m1', 'm2', 'm1']))).toEqual(['m1', 'm2'])
  })

  it('空 mediaId（未生成结果的节点）被跳过', () => {
    expect(extractSnapshotMediaIds(makeSnapshot([undefined, 'm1', '']))).toEqual(['m1'])
  })

  it('快照缺少 store 字段时返回空数组而非抛错', () => {
    expect(extractSnapshotMediaIds(null)).toEqual([])
    expect(extractSnapshotMediaIds({})).toEqual([])
  })
})

describe('diffSnapshotMedia', () => {
  it('按可用集合划分 available / missing', () => {
    const r = diffSnapshotMedia(['a', 'b', 'c'], new Set(['a', 'c']))
    expect(r.available).toEqual(['a', 'c'])
    expect(r.missing).toEqual(['b'])
  })
})

describe('checkSnapshotMedia', () => {
  it('完整流程：快照引用 3 个媒体，其中 1 个缺失', () => {
    const r = checkSnapshotMedia(makeSnapshot(['ok1', 'gone', 'ok2']), new Set(['ok1', 'ok2']))
    expect(r.available).toEqual(['ok1', 'ok2'])
    expect(r.missing).toEqual(['gone'])
  })
})
