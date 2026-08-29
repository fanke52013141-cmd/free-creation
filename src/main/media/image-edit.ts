import { createCanvas, loadImage } from '@napi-rs/canvas'
import { readFile } from 'fs/promises'
import type { ImageEditInput } from '../../shared/contracts'
import {
  parseImageEditConfig,
  validateImageEditConfig,
  type ImageEditAnnotation
} from '../../shared/image-edit'
import type { MediaAsset } from '../../shared/types'
import { getDb } from '../store/db'
import { getMediaAbsPath } from '../store/media.repo'
import { generateImageEditToAsset } from '../gateway/image'

const MAX_IMAGE_PIXELS = 64 * 1024 * 1024
const MAX_EXPORT_PIXELS = 16 * 1024 * 1024
const MAX_EXPORT_DIMENSION = 4096

/** 图片修改：将标注绘制成临时参考图，再交给图片模型生成新资产。 */
export async function transformImageEdit(input: ImageEditInput): Promise<MediaAsset> {
  if (!input.projectId || !input.sourceMediaId) throw new Error('缺少项目或源图片')
  const config = parseImageEditConfig(JSON.stringify(input.config))
  const invalid = validateImageEditConfig(config)
  if (invalid) throw new Error(invalid)
  const projectPrefix = `projects/${input.projectId}/media/`
  const source = getDb()
    .prepare(
      'SELECT path, mime, kind, size_bytes FROM media WHERE id = ? AND substr(path, 1, length(?)) = ? LIMIT 1'
    )
    .get(input.sourceMediaId, projectPrefix, projectPrefix) as
    { path: string; mime: string; kind: string; size_bytes: number } | undefined
  if (!source || source.kind !== 'image' || !source.mime.startsWith('image/')) {
    throw new Error('输入图片不存在，或不属于当前项目')
  }
  if (source.size_bytes > 100 * 1024 * 1024) throw new Error('图片超过 100MB，暂不支持图片修改')
  const sourcePath = getMediaAbsPath(source.path)
  if (!sourcePath) throw new Error('输入图片路径无效')
  const image = await loadImage(await readFile(sourcePath))
  if (!image.width || !image.height) throw new Error('无法读取图片尺寸')
  if (image.width * image.height > MAX_IMAGE_PIXELS) throw new Error('图片解码后超过 6400 万像素')
  const reference = renderAnnotatedReference(image, config.annotations)
  return generateImageEditToAsset(
    { ...input, config, size: config.size, prompt: input.prompt.trim() },
    reference
  )
}

type CanvasImage = Awaited<ReturnType<typeof loadImage>>

export function renderAnnotatedReference(
  image: CanvasImage,
  annotations: ImageEditAnnotation[]
): Buffer {
  const scale = Math.min(
    1,
    MAX_EXPORT_DIMENSION / image.width,
    MAX_EXPORT_DIMENSION / image.height,
    Math.sqrt(MAX_EXPORT_PIXELS / (image.width * image.height))
  )
  const width = Math.max(1, Math.round(image.width * scale))
  const height = Math.max(1, Math.round(image.height * scale))
  const canvas = createCanvas(width, height)
  const ctx = canvas.getContext('2d')
  ctx.drawImage(image, 0, 0, width, height)
  const colors: Record<string, string> = { red: '#ef4444', yellow: '#facc15', orange: '#f97316' }
  for (const annotation of annotations) {
    const color = colors[annotation.color] ?? colors.red
    const points = annotation.points.map((p) => ({ x: p.x * width, y: p.y * height }))
    ctx.strokeStyle = color
    ctx.fillStyle = color
    ctx.lineWidth = Math.max(1, (annotation.strokeWidth ?? 3) * scale)
    ctx.lineCap = 'round'
    ctx.lineJoin = 'round'
    if (annotation.type === 'rect' && points.length >= 2) {
      const x = Math.min(points[0].x, points[1].x)
      const y = Math.min(points[0].y, points[1].y)
      const width = Math.abs(points[1].x - points[0].x)
      const height = Math.abs(points[1].y - points[0].y)
      ctx.strokeRect(x, y, width, height)
    } else if (annotation.type === 'text' && points[0]) {
      const fontSize = Math.max(14, Math.round(24 * scale))
      ctx.font = `${fontSize}px sans-serif`
      const text = annotation.text ?? ''
      const metrics = ctx.measureText(text)
      ctx.fillStyle = 'rgba(0,0,0,0.62)'
      ctx.fillRect(points[0].x - 4, points[0].y - fontSize - 5, metrics.width + 8, fontSize + 8)
      ctx.fillStyle = color
      ctx.fillText(text, points[0].x, points[0].y)
    } else if (points.length >= 2) {
      ctx.beginPath()
      ctx.moveTo(points[0].x, points[0].y)
      for (const p of points.slice(1)) ctx.lineTo(p.x, p.y)
      ctx.stroke()
      if (annotation.type === 'arrow') {
        const end = points[points.length - 1]
        const prev = points[Math.max(0, points.length - 2)]
        const angle = Math.atan2(end.y - prev.y, end.x - prev.x)
        const size = Math.max(8, 12 * scale)
        ctx.beginPath()
        ctx.moveTo(end.x, end.y)
        ctx.lineTo(
          end.x - size * Math.cos(angle - Math.PI / 6),
          end.y - size * Math.sin(angle - Math.PI / 6)
        )
        ctx.lineTo(
          end.x - size * Math.cos(angle + Math.PI / 6),
          end.y - size * Math.sin(angle + Math.PI / 6)
        )
        ctx.closePath()
        ctx.fill()
      }
    }
  }
  return canvas.toBuffer('image/png')
}
