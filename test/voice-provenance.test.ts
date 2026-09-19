// @vitest-environment jsdom
// 语音产物的音色溯源（2026-09-19 方案 A）。
//
// 要证明的是整条链：执行器写入 → 序列化往返 → 资产索引透出 → 关键词能搜到。
// 只测集合级字段是不够的——同一个配音节点换音色重跑会留下多条产物，区分它们靠的
// 是逐条 item 上的 voiceId。
import { describe, expect, it } from 'vitest'
import type { MediaAsset } from '@shared/types'
import {
  appendMediaResult,
  parseMediaResultCollection,
  serializeMediaResultCollection
} from '@shared/engine/values'
import type { NodeCardShape } from '@renderer/canvas/NodeCardShape'
import { buildMediaAssetIndex, filterMediaAssets } from '@renderer/assets/media-index'

// MiniMax 音色库里能直接复制的 preset ID 形态：含空格与括号。
const PRESET = 'Chinese (Mandarin)_News_Anchor'

describe('配音产物的音色溯源', () => {
  it('voiceId 逐条记在结果项上，并原样穿过序列化往返', () => {
    let collection = appendMediaResult(
      '',
      { mediaId: 'a1', mediaPath: 'p/a1.mp3', mime: 'audio/mpeg' },
      {
        nodeId: 'shape:speech',
        modelKey: 'speech-2.8-hd',
        prompt: '第一句',
        runId: 'r1',
        voiceId: PRESET
      }
    )
    collection = appendMediaResult(
      serializeMediaResultCollection(collection),
      { mediaId: 'a2', mediaPath: 'p/a2.mp3', mime: 'audio/mpeg' },
      {
        nodeId: 'shape:speech',
        modelKey: 'speech-2.8-hd',
        prompt: '第二句',
        runId: 'r2',
        voiceId: 'male-qn-qingse'
      }
    )

    const parsed = parseMediaResultCollection(serializeMediaResultCollection(collection))
    expect(parsed?.results.map((r) => [r.mediaId, r.voiceId])).toEqual([
      ['a1', PRESET],
      ['a2', 'male-qn-qingse']
    ])
  })

  it('空音色不写入该键，而不是留下空串冒充已溯源', () => {
    const collection = appendMediaResult(
      '',
      { mediaId: 'a1', mediaPath: 'p/a1.mp3', mime: 'audio/mpeg' },
      { nodeId: 'shape:speech', voiceId: '   ' }
    )
    expect('voiceId' in collection.results[0]).toBe(false)
  })
})

function audioAsset(id: string): MediaAsset {
  return {
    id,
    kind: 'audio',
    mime: 'audio/mpeg',
    path: `p/${id}.mp3`,
    sizeBytes: 100,
    createdAt: 1_700_000_000_000,
    name: id
  }
}

describe('资产索引把音色透出到来源摘要', () => {
  const nodeResult = serializeMediaResultCollection(
    appendMediaResult(
      '',
      { mediaId: 'a1', mediaPath: 'p/a1.mp3', mime: 'audio/mpeg' },
      { nodeId: 'shape:speech', modelKey: 'speech-2.8-hd', runId: 'r1', voiceId: PRESET }
    )
  )
  const shapes = [
    {
      id: 'shape:speech',
      type: 'node-card',
      x: 0,
      y: 0,
      rotation: 0,
      index: 'a1',
      isLocked: false,
      props: {
        w: 340,
        h: 260,
        nodeType: 'speech',
        title: '配音',
        config: '',
        text: '',
        mediaId: '',
        mediaPath: '',
        mediaMime: '',
        exec: 'idle'
      },
      meta: { nodeResult }
    }
  ] as unknown as NodeCardShape[]
  const indexed = buildMediaAssetIndex([audioAsset('a1')], shapes)

  it('source.voiceId 与产物实际音色一致', () => {
    expect(indexed[0].source?.voiceId).toBe(PRESET)
    expect(indexed[0].source?.nodeTitle).toBe('配音')
  })

  it('音色 ID 可以按关键词搜到（含空格与括号也能命中）', () => {
    const base = {
      filter: 'all' as const,
      keyword: '',
      sourceNodeId: 'all' as const,
      runStatus: 'all' as const,
      timeRange: 'all' as const
    }
    expect(filterMediaAssets(indexed, { ...base, keyword: 'News_Anchor' })).toHaveLength(1)
    expect(filterMediaAssets(indexed, { ...base, keyword: 'Mandarin' })).toHaveLength(1)
    expect(filterMediaAssets(indexed, { ...base, keyword: '不存在的音色' })).toHaveLength(0)
  })
})
