// 真实图片变换验收：源图与产物都真的落盘，像素真的由 @napi-rs/canvas 解码/重采样。
//
// `transformImageCrop` 与 `transformImageSplit` 此前一次都没被执行过（测试里只有 image-edit 的
// 两个纯渲染函数见过真像素）。图片裁剪节点的矩形裁剪、四角透视和宫格拆分走的都是这条 IPC，
// 光测纯函数（buildImageSplitTiles / solveHomography）证明不了「采样坐标算错了没人发现」。
// 这里检查的是产物像素：格子之间不能互相渗入邻格残影，透视裁剪必须按四角语义映射而不是取外接矩形。
//
// 只 mock SQLite 与媒体仓库的索引写入；读写文件、PNG 编解码、单应矩阵采样全用真的。
import { createCanvas, loadImage } from '@napi-rs/canvas'
import { mkdir, mkdtemp, readFile, rm, unlink, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { dirname, join } from 'path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { DEFAULT_IMAGE_CROP_CONFIG, type ImageCropConfig } from '../src/shared/image-crop'
import type { ImageSplitConfig } from '../src/shared/image-split'
import type { MediaAsset } from '../src/shared/types'

interface FakeRow {
  id: string
  kind: string
  mime: string
  path: string
  size_bytes: number
}

const h = vi.hoisted(() => ({
  dataDir: '',
  seq: 0,
  rows: [] as FakeRow[],
  savedPaths: [] as string[],
  deletedIds: [] as string[],
  /** >0 时，第 N 个产物之后 saveBufferAsset 抛错，用来验证拆分的回滚。 */
  failSavingAfter: 0
}))

vi.mock('../src/main/store/db', () => ({
  getDataDir: () => h.dataDir,
  getDb: () => ({
    prepare: (sql: string) => ({
      run: (...args: unknown[]) => {
        const [id, kind, mime, path, size] = args as [string, string, string, string, number]
        h.rows.push({ id, kind, mime, path, size_bytes: size })
        return { changes: 1 }
      },
      // 复刻真实查询的项目前缀约束：substr(path, 1, length(?)) = ?
      get: (...args: unknown[]) => {
        const [id, prefix] = args as [string, string]
        const row = h.rows.find(
          (item) => item.id === id && item.path.slice(0, prefix.length) === prefix
        )
        return row && { path: row.path, mime: row.mime, kind: row.kind, size_bytes: row.size_bytes }
      },
      all: () => []
    })
  })
}))

vi.mock('../src/main/store/media.repo', () => ({
  getMediaAbsPath: (relPath: string) => join(h.dataDir, relPath),
  saveBufferAsset: async (
    projectId: string,
    buf: Buffer,
    ext: string,
    name: string
  ): Promise<MediaAsset> => {
    if (h.failSavingAfter > 0 && h.savedPaths.length >= h.failSavingAfter) {
      throw new Error('磁盘写入失败')
    }
    const id = `asset-${++h.seq}`
    const relPath = `projects/${projectId}/media/${id}${ext}`
    const abs = join(h.dataDir, relPath)
    await mkdir(dirname(abs), { recursive: true })
    await writeFile(abs, buf)
    h.savedPaths.push(relPath)
    h.rows.push({ id, kind: 'image', mime: 'image/png', path: relPath, size_bytes: buf.length })
    return {
      id,
      kind: 'image',
      mime: 'image/png',
      path: relPath,
      sizeBytes: buf.length,
      createdAt: 1,
      name: name.replace(/[\\/:*?"<>|\s]+/g, '-').slice(0, 40) || id
    }
  },
  deleteMedia: async (mediaId: string) => {
    h.deletedIds.push(mediaId)
    const index = h.rows.findIndex((row) => row.id === mediaId)
    if (index < 0) return false
    const [row] = h.rows.splice(index, 1)
    await unlink(join(h.dataDir, row.path)).catch(() => undefined)
    return true
  }
}))

type Rgb = readonly [number, number, number]

const RED: Rgb = [220, 30, 30]
const GREEN: Rgb = [30, 200, 60]
const BLUE: Rgb = [40, 80, 220]
const YELLOW: Rgb = [230, 210, 40]
const MAGENTA: Rgb = [210, 40, 200]
const CYAN: Rgb = [30, 190, 210]

/** 把纯色块拼成源图并登记为「已导入的项目图片」，返回媒体 ID（真实 PNG 已在磁盘上）。 */
async function stageImage(
  id: string,
  width: number,
  height: number,
  cells: { x: number; y: number; w: number; h: number; color: Rgb }[]
): Promise<string> {
  const canvas = createCanvas(width, height)
  const ctx = canvas.getContext('2d')
  ctx.fillStyle = '#000000'
  ctx.fillRect(0, 0, width, height)
  for (const cell of cells) {
    ctx.fillStyle = `rgb(${cell.color[0]}, ${cell.color[1]}, ${cell.color[2]})`
    ctx.fillRect(cell.x, cell.y, cell.w, cell.h)
  }
  const buf = canvas.toBuffer('image/png')
  const relPath = `projects/p1/media/${id}.png`
  const abs = join(h.dataDir, relPath)
  await mkdir(dirname(abs), { recursive: true })
  await writeFile(abs, buf)
  h.rows.push({ id, kind: 'image', mime: 'image/png', path: relPath, size_bytes: buf.length })
  return id
}

/** 60×40：左上红、右上绿、左下蓝、右下黄。 */
function quadrants(): { x: number; y: number; w: number; h: number; color: Rgb }[] {
  return [
    { x: 0, y: 0, w: 30, h: 20, color: RED },
    { x: 30, y: 0, w: 30, h: 20, color: GREEN },
    { x: 0, y: 20, w: 30, h: 20, color: BLUE },
    { x: 30, y: 20, w: 30, h: 20, color: YELLOW }
  ]
}

async function decode(buf: Buffer | MediaAsset) {
  const bytes = Buffer.isBuffer(buf) ? buf : await readFile(join(h.dataDir, buf.path))
  const image = await loadImage(bytes)
  const canvas = createCanvas(image.width, image.height)
  const ctx = canvas.getContext('2d')
  ctx.drawImage(image, 0, 0)
  return {
    width: image.width,
    height: image.height,
    at: (x: number, y: number): Rgb => {
      const d = ctx.getImageData(x, y, 1, 1).data
      return [d[0], d[1], d[2]]
    }
  }
}

function cropConfig(overrides: Partial<ImageCropConfig>): ImageCropConfig {
  return { ...structuredClone(DEFAULT_IMAGE_CROP_CONFIG), ...overrides }
}

beforeAll(async () => {
  h.dataDir = await mkdtemp(join(tmpdir(), 'canvas-studio-transform-'))
})

afterAll(async () => {
  await rm(h.dataDir, { recursive: true, force: true }).catch(() => undefined)
})

function resetTransformState() {
  h.rows.length = 0
  h.savedPaths.length = 0
  h.deletedIds.length = 0
  h.failSavingAfter = 0
  h.seq = 0
}

describe('真实矩形裁剪', () => {
  it('按归一化 rect 采样，产物真的写成项目内的新 PNG 资产', async () => {
    resetTransformState()
    const sourceId = await stageImage('src-rect', 60, 40, quadrants())
    const asset = await (
      await import('../src/main/media/image-transform')
    ).transformImageCrop({
      projectId: 'p1',
      sourceMediaId: sourceId,
      config: cropConfig({ rect: { x: 0.1, y: 0.1, width: 0.3, height: 0.3 } })
    })
    expect(asset.kind).toBe('image')
    expect(asset.mime).toBe('image/png')
    expect(asset.path).toBe(`projects/p1/media/${asset.id}.png`)
    // 落盘字节与返回值一致：节点渲染的是磁盘上那份，不是内存里的临时 buffer。
    const rendered = await decode(asset)
    expect(rendered.width).toBe(18)
    expect(rendered.height).toBe(12)
    expect(rendered.at(0, 0)).toEqual(RED)
    expect(rendered.at(17, 11)).toEqual(RED)
    expect(rendered.at(9, 6)).toEqual(RED)
  })

  it('裁剪到右下象限不会串到左上：源坐标真的按 rect 平移', async () => {
    resetTransformState()
    const sourceId = await stageImage('src-rect2', 60, 40, quadrants())
    const asset = await (
      await import('../src/main/media/image-transform')
    ).transformImageCrop({
      projectId: 'p1',
      sourceMediaId: sourceId,
      config: cropConfig({ rect: { x: 0.5, y: 0.5, width: 0.5, height: 0.5 } })
    })
    const rendered = await decode(asset)
    expect([rendered.width, rendered.height]).toEqual([30, 20])
    expect(rendered.at(0, 0)).toEqual(YELLOW)
    expect(rendered.at(29, 19)).toEqual(YELLOW)
  })

  it('零宽高会被配置层收成 1px 细条而不是报错；自交四边形才在执行前挡住', async () => {
    resetTransformState()
    const sourceId = await stageImage('src-guard', 60, 40, quadrants())
    const transform = await import('../src/main/media/image-transform')
    // parseImageCropConfig 把宽高下限锁在 1/10000，所以 validate 的「裁剪区域不能为零」
    // 在节点链路上不可达：真实行为是产出极细的 1px 条，而不是报错。
    const sliver = await transform.transformImageCrop({
      projectId: 'p1',
      sourceMediaId: sourceId,
      config: cropConfig({ rect: { x: 0.2, y: 0.2, width: 0, height: 0.5 } })
    })
    const renderedSliver = await decode(sliver)
    expect(renderedSliver.width).toBe(1)
    expect(renderedSliver.height).toBe(20)
    // 四点自交（左上→右上→左下→右下的顺序被打乱成蝴蝶形）
    await expect(
      transform.transformImageCrop({
        projectId: 'p1',
        sourceMediaId: sourceId,
        config: cropConfig({
          mode: 'quad',
          points: [
            { x: 0.1, y: 0.1 },
            { x: 0.9, y: 0.9 },
            { x: 0.9, y: 0.1 },
            { x: 0.1, y: 0.9 }
          ]
        })
      })
    ).rejects.toThrow('四个角点必须形成非交叉、非退化的区域')
    expect(h.savedPaths).toHaveLength(1)
  })

  it('源素材不属于当前项目 / 不是图片时拒绝执行，不读跨项目文件', async () => {
    resetTransformState()
    const transform = await import('../src/main/media/image-transform')
    // 别的项目的图片：路径前缀不匹配，等价于「不存在」。
    h.rows.push({
      id: 'other',
      kind: 'image',
      mime: 'image/png',
      path: 'projects/p2/media/other.png',
      size_bytes: 10
    })
    await expect(
      transform.transformImageCrop({
        projectId: 'p1',
        sourceMediaId: 'other',
        config: cropConfig({})
      })
    ).rejects.toThrow('输入图片不存在，或不属于当前项目')
    h.rows.push({
      id: 'clip',
      kind: 'video',
      mime: 'video/mp4',
      path: 'projects/p1/media/clip.mp4',
      size_bytes: 10
    })
    await expect(
      transform.transformImageCrop({
        projectId: 'p1',
        sourceMediaId: 'clip',
        config: cropConfig({})
      })
    ).rejects.toThrow('输入图片不存在，或不属于当前项目')
    h.rows.push({
      id: 'huge',
      kind: 'image',
      mime: 'image/png',
      path: 'projects/p1/media/huge.png',
      size_bytes: 101 * 1024 * 1024
    })
    await expect(
      transform.transformImageCrop({
        projectId: 'p1',
        sourceMediaId: 'huge',
        config: cropConfig({})
      })
    ).rejects.toThrow('图片超过 100MB，暂不支持本地裁剪')
    await expect(
      transform.transformImageCrop({
        projectId: 'p1',
        sourceMediaId: 'missing',
        config: cropConfig({})
      })
    ).rejects.toThrow('输入图片不存在，或不属于当前项目')
    expect(h.savedPaths).toEqual([])
  })
})

describe('真实四角透视裁剪', () => {
  it('输出按四角语义映射，而不是取四点的外接矩形', async () => {
    resetTransformState()
    const sourceId = await stageImage('src-quad', 60, 40, quadrants())
    // 四角顺序为左上、右上、左下、右下：这里故意把源图的正方形区域旋转 90° 指派给输出矩形。
    // 外接矩形实现会得到「左上=红」，真单应变换得到「左上=绿」。
    const asset = await (
      await import('../src/main/media/image-transform')
    ).transformImageCrop({
      projectId: 'p1',
      sourceMediaId: sourceId,
      config: cropConfig({
        mode: 'quad',
        points: [
          { x: 0.75, y: 0.25 },
          { x: 0.75, y: 0.75 },
          { x: 0.25, y: 0.25 },
          { x: 0.25, y: 0.75 }
        ]
      })
    })
    const rendered = await decode(asset)
    // 输出尺寸取上下边与左右边长度的平均：源区为 20×30。
    expect([rendered.width, rendered.height]).toEqual([20, 30])
    expect(rendered.at(5, 7)).toEqual(GREEN)
    expect(rendered.at(15, 7)).toEqual(YELLOW)
    expect(rendered.at(5, 22)).toEqual(RED)
    expect(rendered.at(15, 22)).toEqual(BLUE)
  })

  it('梯形选区只采样四边形内部，不把外接框的邻色拖进来', async () => {
    resetTransformState()
    const sourceId = await stageImage('src-trap', 60, 40, quadrants())
    const asset = await (
      await import('../src/main/media/image-transform')
    ).transformImageCrop({
      projectId: 'p1',
      sourceMediaId: sourceId,
      config: cropConfig({
        mode: 'quad',
        points: [
          { x: 0.6, y: 0.05 },
          { x: 0.95, y: 0.12 },
          { x: 0.55, y: 0.4 },
          { x: 0.95, y: 0.45 }
        ]
      })
    })
    const rendered = await decode(asset)
    expect(rendered.width).toBeGreaterThan(10)
    expect(rendered.height).toBeGreaterThan(10)
    // 整个四边形都落在右上绿象限内（x∈[33,57]、y∈[2,18] 都在 x≥30、y<20 区域）。
    for (let y = 0; y < rendered.height; y += 3) {
      for (let x = 0; x < rendered.width; x += 3) {
        expect(rendered.at(x, y), `${x},${y}`).toEqual(GREEN)
      }
    }
  })
})

describe('真实宫格拆分', () => {
  const cells = () => [
    { x: 0, y: 0, w: 40, h: 30, color: RED },
    { x: 40, y: 0, w: 40, h: 30, color: GREEN },
    { x: 80, y: 0, w: 40, h: 30, color: BLUE },
    { x: 0, y: 30, w: 40, h: 30, color: YELLOW },
    { x: 40, y: 30, w: 40, h: 30, color: MAGENTA },
    { x: 80, y: 30, w: 40, h: 30, color: CYAN }
  ]

  function splitConfig(overrides: Partial<ImageSplitConfig>): ImageSplitConfig {
    return { version: 1, rows: 2, columns: 3, scalePercent: 100, ...overrides }
  }

  it('3×2 拆出 6 张独立 PNG：每格恰好 40×30、只含自己那格的颜色', async () => {
    resetTransformState()
    const sourceId = await stageImage('src-split', 120, 60, cells())
    const assets = await (
      await import('../src/main/media/image-transform')
    ).transformImageSplit({
      projectId: 'p1',
      sourceMediaId: sourceId,
      config: splitConfig({})
    })
    expect(assets).toHaveLength(6)
    const expected = [RED, GREEN, BLUE, YELLOW, MAGENTA, CYAN]
    for (const [index, asset] of assets.entries()) {
      const row = Math.floor(index / 3) + 1
      const column = (index % 3) + 1
      expect(asset.name).toBe(`拆分图-R${row}C${column}`)
      expect(asset.path).toBe(`projects/p1/media/${asset.id}.png`)
      const rendered = await decode(asset)
      // 四角与中心都必须是本格颜色：任何一角发灰/混色，就说明采样读到了格外的邻格像素。
      expect([rendered.width, rendered.height], asset.name).toEqual([40, 30])
      for (const [x, y] of [
        [0, 0],
        [39, 0],
        [0, 29],
        [39, 29],
        [20, 15]
      ]) {
        expect(rendered.at(x, y), `${asset.name} @${x},${y}`).toEqual(expected[index])
      }
    }
    // 6 个产物互不覆盖：ID 与路径各不相同。
    expect(new Set(assets.map((asset) => asset.path)).size).toBe(6)
  })

  it('scalePercent 是面积比例：25% 面积只把边长缩一半，且以格中心为锚点', async () => {
    resetTransformState()
    const sourceId = await stageImage('src-scale', 120, 60, cells())
    const assets = await (
      await import('../src/main/media/image-transform')
    ).transformImageSplit({
      projectId: 'p1',
      sourceMediaId: sourceId,
      config: splitConfig({ scalePercent: 25 })
    })
    for (const [index, asset] of assets.entries()) {
      const rendered = await decode(asset)
      // 面积 25% ⇒ 边长 50%：40×30 的格缩成 20×15，且仍以格中心为锚点。
      expect([rendered.width, rendered.height], asset.name).toEqual([20, 15])
      expect(rendered.at(0, 0), asset.name).toEqual(
        [RED, GREEN, BLUE, YELLOW, MAGENTA, CYAN][index]
      )
      expect(rendered.at(19, 14), asset.name).toEqual(
        [RED, GREEN, BLUE, YELLOW, MAGENTA, CYAN][index]
      )
    }
  })

  it('中途写盘失败时回滚本次已生成的格子，不给节点留半套输出', async () => {
    resetTransformState()
    const sourceId = await stageImage('src-rollback', 120, 60, cells())
    h.failSavingAfter = 3
    const transform = await import('../src/main/media/image-transform')
    await expect(
      transform.transformImageSplit({
        projectId: 'p1',
        sourceMediaId: sourceId,
        config: splitConfig({})
      })
    ).rejects.toThrow('磁盘写入失败')
    expect(h.deletedIds).toHaveLength(3)
    for (const id of h.deletedIds) {
      await expect(readFile(join(h.dataDir, `projects/p1/media/${id}.png`))).rejects.toThrow()
    }
    // 回滚后索引里只剩源图，不会有半套拆分产物被下游引用。
    expect(h.rows.map((row) => row.id)).toEqual([sourceId])
  })

  it('行数与列数越界会被收敛，不会拆出天量资产', async () => {
    resetTransformState()
    const sourceId = await stageImage('src-capped', 120, 60, cells())
    const assets = await (
      await import('../src/main/media/image-transform')
    ).transformImageSplit({
      projectId: 'p1',
      sourceMediaId: sourceId,
      config: splitConfig({ rows: 200, columns: 200 })
    })
    expect(assets.length).toBeLessThanOrEqual(64)
    // 保行数、下调列数：64 格上限下 200 行只能 1 列 → 64 格。
    expect(assets.length).toBe(64)
    expect(assets[0].name).toBe('拆分图-R1C1')
    expect(assets[63].name).toBe('拆分图-R64C1')
  })
})
