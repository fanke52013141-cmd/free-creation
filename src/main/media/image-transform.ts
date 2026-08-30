import { createCanvas, loadImage } from '@napi-rs/canvas'
import { readFile } from 'fs/promises'
import { getDb } from '../store/db'
import { deleteMedia, getMediaAbsPath, saveBufferAsset } from '../store/media.repo'
import {
  parseImageCropConfig,
  type ImageCropConfig,
  type NormalizedPoint,
  validateImageCropConfig
} from '../../shared/image-crop'
import type { MediaAsset } from '../../shared/types'
import { sampleBilinear, solveHomography, transformPoint } from '../../shared/image-perspective'
import { buildImageSplitTiles, parseImageSplitConfig } from '../../shared/image-split'

export interface ImageCropTransformInput {
  projectId: string
  sourceMediaId: string
  config: ImageCropConfig
}

export interface ImageSplitTransformInput {
  projectId: string
  sourceMediaId: string
  config: import('../../shared/image-split').ImageSplitConfig
}

const MAX_IMAGE_PIXELS = 64 * 1024 * 1024

/** M0 本地媒体变换服务：输入只接受已登记的项目媒体 ID，输出始终是新的 MediaAsset。 */
export async function transformImageCrop(input: ImageCropTransformInput): Promise<MediaAsset> {
  const config = parseImageCropConfig(JSON.stringify(input.config))
  const invalid = validateImageCropConfig(config)
  if (invalid) throw new Error(invalid)
  const image = await loadProjectImage(input.projectId, input.sourceMediaId)
  const output =
    config.mode === 'rect' ? renderRect(image, config) : renderPerspective(image, config.points)
  return saveBufferAsset(input.projectId, output, '.png', '裁剪图片')
}

/**
 * 宫格拆分：单个源图一次派生 N 个 PNG。任何一格落盘失败时清理本次已写入资产，
 * 不以半套结果覆盖节点当前输出，避免失败污染画布。
 */
export async function transformImageSplit(input: ImageSplitTransformInput): Promise<MediaAsset[]> {
  const config = parseImageSplitConfig(JSON.stringify(input.config))
  const image = await loadProjectImage(input.projectId, input.sourceMediaId)
  const created: MediaAsset[] = []
  try {
    for (const tile of buildImageSplitTiles(config)) {
      const output = renderRect(image, {
        rect: tile.rect
      })
      created.push(
        await saveBufferAsset(
          input.projectId,
          output,
          '.png',
          `拆分图-R${tile.row}C${tile.column}`
        )
      )
    }
    return created
  } catch (error) {
    await Promise.all(created.map((asset) => deleteMedia(asset.id).catch(() => false)))
    throw error
  }
}

type CanvasImage = Awaited<ReturnType<typeof loadImage>>

async function loadProjectImage(projectId: string, sourceMediaId: string): Promise<CanvasImage> {
  if (!projectId || !sourceMediaId) throw new Error('缺少项目或源图片')
  // 不使用 LIKE：projectId 来自 IPC，通配符不能被解释为跨项目匹配。
  const projectPrefix = `projects/${projectId}/media/`
  const source = getDb()
    .prepare(
      'SELECT path, mime, kind, size_bytes FROM media WHERE id = ? AND substr(path, 1, length(?)) = ? LIMIT 1'
    )
    .get(sourceMediaId, projectPrefix, projectPrefix) as
    { path: string; mime: string; kind: string; size_bytes: number } | undefined
  if (!source || source.kind !== 'image' || !source.mime.startsWith('image/')) {
    throw new Error('输入图片不存在，或不属于当前项目')
  }
  if (source.size_bytes > 100 * 1024 * 1024) throw new Error('图片超过 100MB，暂不支持本地裁剪')
  const sourcePath = getMediaAbsPath(source.path)
  if (!sourcePath) throw new Error('输入图片路径无效')
  const image = await loadImage(await readFile(sourcePath))
  if (!image.width || !image.height) throw new Error('无法读取图片尺寸')
  if (image.width * image.height > MAX_IMAGE_PIXELS) {
    throw new Error('图片解码后超过 6400 万像素，暂不支持本地裁剪')
  }
  return image
}

function renderRect(image: CanvasImage, config: Pick<ImageCropConfig, 'rect'>): Buffer {
  const { x, y, width, height } = config.rect
  const sourceX = Math.floor(image.width * x)
  const sourceY = Math.floor(image.height * y)
  const sourceW = Math.max(1, Math.floor(image.width * width))
  const sourceH = Math.max(1, Math.floor(image.height * height))
  const canvas = createCanvas(sourceW, sourceH)
  const ctx = canvas.getContext('2d')
  ctx.imageSmoothingEnabled = true
  ctx.imageSmoothingQuality = 'high'
  ctx.drawImage(image, sourceX, sourceY, sourceW, sourceH, 0, 0, sourceW, sourceH)
  return canvas.toBuffer('image/png')
}

/**
 * 四角透视：以输出矩形反向映射回原图四边形，再进行双线性采样。
 * 这是严格的单应变换（homography），而不是取四点的外接矩形或仿射近似。
 */
function renderPerspective(
  image: CanvasImage,
  normalizedPoints: ImageCropConfig['points']
): Buffer {
  const points = normalizedPoints.map((point) => ({
    x: point.x * image.width,
    y: point.y * image.height
  })) as [NormalizedPoint, NormalizedPoint, NormalizedPoint, NormalizedPoint]
  const [tl, tr, bl, br] = points
  const outW = Math.max(1, Math.round((distance(tl, tr) + distance(bl, br)) / 2))
  const outH = Math.max(1, Math.round((distance(tl, bl) + distance(tr, br)) / 2))
  if (outW * outH > MAX_IMAGE_PIXELS) throw new Error('裁剪输出超过 6400 万像素')

  const sourceCanvas = createCanvas(image.width, image.height)
  const sourceCtx = sourceCanvas.getContext('2d')
  sourceCtx.drawImage(image, 0, 0)
  const sourcePixels = sourceCtx.getImageData(0, 0, image.width, image.height).data
  const outputCanvas = createCanvas(outW, outH)
  const outputCtx = outputCanvas.getContext('2d')
  const output = outputCtx.createImageData(outW, outH)
  const matrix = solveHomography(
    [
      { x: 0, y: 0 },
      { x: Math.max(0, outW - 1), y: 0 },
      { x: 0, y: Math.max(0, outH - 1) },
      { x: Math.max(0, outW - 1), y: Math.max(0, outH - 1) }
    ],
    points
  )

  for (let y = 0; y < outH; y += 1) {
    for (let x = 0; x < outW; x += 1) {
      const { x: sx, y: sy } = transformPoint(matrix, x, y)
      sampleBilinear(
        sourcePixels,
        image.width,
        image.height,
        sx,
        sy,
        output.data,
        (y * outW + x) * 4
      )
    }
  }
  outputCtx.putImageData(output, 0, 0)
  return outputCanvas.toBuffer('image/png')
}

function distance(a: NormalizedPoint, b: NormalizedPoint): number {
  return Math.hypot(a.x - b.x, a.y - b.y)
}
