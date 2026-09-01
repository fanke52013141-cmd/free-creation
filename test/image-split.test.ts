import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  buildImageSplitTiles,
  DEFAULT_IMAGE_SPLIT_CONFIG,
  imageSplitCount,
  parseImageSplitConfig
} from '@shared/image-split'
import { imageSplitExecutor } from '@renderer/engine/executors/imageSplit'
import { parseMediaResultCollection } from '@renderer/nodes/nodeValues'
import type { NodeCardShape } from '@renderer/canvas/NodeCardShape'
import type { NodeExecutionContext } from '@renderer/engine/executor-types'

afterEach(() => vi.restoreAllMocks())

describe('图片宫格拆分配置', () => {
  it('2×2 产生 4 格，3×3 产生 9 格', () => {
    expect(imageSplitCount({ ...DEFAULT_IMAGE_SPLIT_CONFIG, rows: 2, columns: 2 })).toBe(4)
    expect(imageSplitCount(DEFAULT_IMAGE_SPLIT_CONFIG)).toBe(9)
  })

  it('面积缩放以格子中心为锚点，90% 面积使用 sqrt(0.9) 的边长比例', () => {
    const [first] = buildImageSplitTiles({
      ...DEFAULT_IMAGE_SPLIT_CONFIG,
      rows: 2,
      columns: 2,
      scalePercent: 90
    })
    const expectedSide = 0.5 * Math.sqrt(0.9)
    expect(first!.rect.width).toBeCloseTo(expectedSide)
    expect(first!.rect.height).toBeCloseTo(expectedSide)
    expect(first!.rect.x).toBeCloseTo((0.5 - expectedSide) / 2)
    expect(first!.rect.y).toBeCloseTo((0.5 - expectedSide) / 2)
    expect(first!.rect.width * first!.rect.height).toBeCloseTo(0.25 * 0.9)
  })

  it('把异常行列与面积参数收敛到安全上限', () => {
    const config = parseImageSplitConfig(
      JSON.stringify({ rows: 99, columns: 99, scalePercent: 300 })
    )
    expect(config.rows * config.columns).toBeLessThanOrEqual(64)
    expect(config.scalePercent).toBe(100)
  })
})

describe('imageSplitExecutor', () => {
  it('只消费真实原图，并把每个格子记录为可选择的图片结果', async () => {
    const splitImageGrid = vi.fn(async () => ({
      ok: true as const,
      data: Array.from({ length: 4 }, (_, index) => ({
        id: `grid-${index + 1}`,
        path: `projects/project-a/media/grid-${index + 1}.png`,
        mime: 'image/png',
        name: `拆分图-${index + 1}`,
        kind: 'image' as const,
        sizeBytes: 12,
        createdAt: 1
      }))
    }))
    globalThis.window = { api: { splitImageGrid } } as unknown as Window & typeof globalThis
    const props: Record<string, unknown> = {
      w: 340,
      h: 260,
      nodeType: 'image-split',
      title: '拆分',
      config: JSON.stringify({ rows: 2, columns: 2, scalePercent: 90 }),
      text: '',
      mediaId: '',
      mediaPath: '',
      mediaMime: '',
      exec: 'idle'
    }
    const result = { value: '' }
    const ctx = {
      node: {
        id: 'shape:split',
        type: 'image-split',
        contractVersion: 1,
        title: '拆分',
        x: 0,
        y: 0,
        w: 340,
        h: 260,
        ports: [],
        params: {},
        content: { kind: 'empty' },
        exec: { status: 'idle' },
        meta: { source: 'derive', createdAt: 0 }
      },
      shape: {
        id: 'shape:split',
        type: 'node-card',
        x: 0,
        y: 0,
        rotation: 0,
        index: 'a1',
        isLocked: false,
        props,
        meta: {}
      } as unknown as NodeCardShape,
      inputs: new Map([
        [
          'in-image',
          [
            {
              type: 'image',
              value: {
                kind: 'image',
                mediaId: 'source-image',
                mediaPath: 'projects/project-a/media/source.png',
                mime: 'image/png'
              },
              source: { nodeId: 'source', portId: 'out-image', runId: 'source-run' },
              createdAt: 0
            }
          ]
        ]
      ]),
      projectId: 'project-a',
      runId: 'split-run',
      providers: [],
      signal: { cancelled: false },
      updateProps: (next: Record<string, unknown>) => Object.assign(props, next),
      updateResult: (value: string) => {
        result.value = value
      }
    } as unknown as NodeExecutionContext

    await expect(imageSplitExecutor(ctx)).resolves.toEqual({ status: 'done' })
    expect(splitImageGrid).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: 'project-a',
        sourceMediaId: 'source-image',
        config: { version: 1, rows: 2, columns: 2, scalePercent: 90 }
      })
    )
    expect(props).toMatchObject({ mediaId: 'grid-1', mediaMime: 'image/png' })
    expect(parseMediaResultCollection(result.value)?.results).toHaveLength(4)
  })
})
