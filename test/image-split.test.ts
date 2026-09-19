import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  buildImageSplitTiles,
  DEFAULT_IMAGE_SPLIT_CONFIG,
  imageSplitCount,
  maxImageSplitColumns,
  parseImageSplitConfig,
  MAX_IMAGE_SPLIT_TILES
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

  it('100% 宫格的导出区域首尾相接但绝不重叠', () => {
    const tiles = buildImageSplitTiles({
      ...DEFAULT_IMAGE_SPLIT_CONFIG,
      rows: 3,
      columns: 3,
      scalePercent: 100
    })

    expect(tiles).toHaveLength(9)
    for (const tile of tiles) {
      expect(tile.rect.x).toBeGreaterThanOrEqual(0)
      expect(tile.rect.y).toBeGreaterThanOrEqual(0)
      expect(tile.rect.x + tile.rect.width).toBeLessThanOrEqual(1)
      expect(tile.rect.y + tile.rect.height).toBeLessThanOrEqual(1)
    }
    for (let index = 0; index < tiles.length; index += 1) {
      for (let compare = index + 1; compare < tiles.length; compare += 1) {
        const first = tiles[index]!.rect
        const second = tiles[compare]!.rect
        const overlapWidth = Math.max(
          0,
          Math.min(first.x + first.width, second.x + second.width) - Math.max(first.x, second.x)
        )
        const overlapHeight = Math.max(
          0,
          Math.min(first.y + first.height, second.y + second.height) - Math.max(first.y, second.y)
        )
        expect(overlapWidth * overlapHeight).toBeCloseTo(0)
      }
    }
  })

  it('把异常行列与面积参数收敛到安全上限', () => {
    const config = parseImageSplitConfig(
      JSON.stringify({ rows: 99, columns: 99, scalePercent: 300 })
    )
    expect(config.rows * config.columns).toBeLessThanOrEqual(64)
    expect(config.scalePercent).toBe(100)
  })

  it('列数输入框的上限就是解析真正接受的上限', () => {
    expect(maxImageSplitColumns(1)).toBe(MAX_IMAGE_SPLIT_TILES)
    expect(maxImageSplitColumns(8)).toBe(8)
    expect(maxImageSplitColumns(64)).toBe(1)
    // 界面按 maxImageSplitColumns 放行过的列数，解析后必须原样保留：两处只要各写一份数字就会漂移。
    for (let rows = 1; rows <= MAX_IMAGE_SPLIT_TILES; rows++) {
      const columns = maxImageSplitColumns(rows)
      const config = parseImageSplitConfig(JSON.stringify({ rows, columns }))
      expect(config.rows).toBe(rows)
      expect(config.columns).toBe(columns)
    }
    // 超限时保持行数、下调列数，而不是整份配置回默认。
    const clamped = parseImageSplitConfig(
      JSON.stringify({ rows: 8, columns: MAX_IMAGE_SPLIT_TILES })
    )
    expect(clamped.rows).toBe(8)
    expect(clamped.columns).toBe(maxImageSplitColumns(8))
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
    const artifacts: unknown[] = []
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
      gateway: { splitImageGrid },
      updateProps: (next: Record<string, unknown>) => Object.assign(props, next),
      updateResult: (value: string) => {
        result.value = value
      },
      emitArtifact: (artifact: unknown) => artifacts.push(artifact)
    } as unknown as NodeExecutionContext

    await expect(imageSplitExecutor(ctx)).resolves.toEqual({ status: 'done' })
    expect(splitImageGrid).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: 'project-a',
        sourceMediaId: 'source-image',
        config: { version: 1, rows: 2, columns: 2, scalePercent: 90 }
      })
    )
    expect(props).toMatchObject({ mediaId: '', mediaMime: '' })
    expect(artifacts).toHaveLength(4)
    // §16.24：拆图按原图命名并编号，来源摘要不写内部 mediaId；缺标题时回退到类型词。
    expect(artifacts[0]).toMatchObject({ title: '图片 · 第 1 格' })
    expect(parseMediaResultCollection(result.value)?.prompt).toBe('拆图 图片 · 2×2 · 面积 90%')
    expect(result.value).not.toContain('source-image')
    expect(parseMediaResultCollection(result.value)?.results).toHaveLength(4)
  })
})
