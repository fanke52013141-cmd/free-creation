// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import type { MediaAsset } from '@shared/types'
import type { NodeCardShape } from '@renderer/canvas/NodeCardShape'
import {
  buildMediaAssetIndex,
  filterMediaAssets,
  mediaSourceOptions
} from '@renderer/assets/media-index'

function asset(id: string, createdAt: number): MediaAsset {
  return {
    id,
    kind: 'image',
    mime: 'image/png',
    path: `/media/${id}.png`,
    sizeBytes: 100,
    createdAt,
    name: id
  }
}

function shape(
  id: string,
  props: Partial<NodeCardShape['props']>,
  meta: Record<string, unknown> = {}
): NodeCardShape {
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
      title: '生图',
      config: '',
      text: '',
      mediaId: '',
      mediaPath: '',
      mediaMime: '',
      exec: 'idle',
      ...props
    },
    meta
  }
}

describe('项目媒体索引', () => {
  const now = new Date('2026-08-29T12:00:00+08:00').getTime()
  const assets = [
    asset('img-old', now - 8 * 24 * 60 * 60 * 1000),
    asset('img-current', now),
    asset('upload', now)
  ]
  const shapes = [
    shape(
      'shape:generate',
      { mediaId: 'img-current', mediaPath: '/media/img-current.png', mediaMime: 'image/png' },
      {
        nodeResult: JSON.stringify({
          kind: 'media-source',
          version: 1,
          nodeId: 'shape:generate',
          modelKey: 'local::image-model',
          selectedMediaId: 'img-current',
          results: [
            {
              mediaId: 'img-old',
              mediaPath: '/media/img-old.png',
              mime: 'image/png',
              createdAt: now - 8_000,
              runId: 'run-image'
            },
            {
              mediaId: 'img-current',
              mediaPath: '/media/img-current.png',
              mime: 'image/png',
              createdAt: now,
              runId: 'run-image'
            }
          ]
        }),
        nodeRun: {
          runId: 'run-later-failed',
          status: 'failed',
          startedAt: now + 100,
          inputs: {},
          error: { phase: 'execution', reason: '后续失败' }
        },
        nodeRunHistory: [
          {
            runId: 'run-image',
            status: 'success',
            startedAt: now - 500,
            finishedAt: now,
            inputs: { 'in-text': [{ nodeId: 'shape:text', portId: 'out-text' }] }
          }
        ]
      }
    ),
    shape('shape:upload', { nodeType: 'image', title: '参考图', mediaId: 'upload' })
  ]

  it('从结果集合和媒体节点推导来源，不修改资产本身', () => {
    const indexed = buildMediaAssetIndex(assets, shapes)
    const current = indexed.find((item) => item.id === 'img-current')
    const old = indexed.find((item) => item.id === 'img-old')
    const upload = indexed.find((item) => item.id === 'upload')

    expect(current?.source).toMatchObject({
      nodeId: 'shape:generate',
      modelKey: 'local::image-model',
      resultCount: 2,
      isCurrentOutput: true,
      runId: 'run-image',
      runStatus: 'success'
    })
    expect(old?.source?.isCurrentOutput).toBe(false)
    expect(upload?.source?.nodeId).toBe('shape:upload')
    expect(upload?.source?.runStatus).toBeUndefined()
    expect(assets[0]).not.toHaveProperty('source')
  })

  it('按来源、状态、时间和安全关键词组合筛选', () => {
    const indexed = buildMediaAssetIndex(assets, shapes)
    expect(
      filterMediaAssets(
        indexed,
        {
          filter: 'all',
          keyword: 'image-model',
          sourceNodeId: 'all',
          runStatus: 'success',
          timeRange: 'all'
        },
        now
      ).map((item) => item.id)
    ).toEqual(['img-current', 'img-old'])

    expect(
      filterMediaAssets(
        indexed,
        {
          filter: 'all',
          keyword: '',
          sourceNodeId: 'all',
          runStatus: 'unavailable',
          timeRange: 'today'
        },
        now
      ).map((item) => item.id)
    ).toEqual(['upload'])
  })

  it('来源筛选值使用稳定 nodeId，标题只用于显示', () => {
    const options = mediaSourceOptions(buildMediaAssetIndex(assets, shapes))
    expect(new Set(options.map((item) => item.nodeId))).toEqual(
      new Set(['shape:generate', 'shape:upload'])
    )
    expect(options.find((item) => item.nodeId === 'shape:generate')?.nodeTitle).toBe('生图')
  })
})
