import { createCanvas, loadImage, type SKRSContext2D } from '@napi-rs/canvas'
import { readFile } from 'fs/promises'
import type { ImageEditInput } from '../../shared/contracts'
import {
  parseImageEditConfig,
  validateImageEditConfig,
  type ImageEditAnnotation,
  type ImageEditMask
} from '../../shared/image-edit'
import type { MediaAsset } from '../../shared/types'
import { getDb } from '../store/db'
import { getMediaAbsPath } from '../store/media.repo'
import { generateImageEditToAsset } from '../gateway/image'

const MAX_IMAGE_PIXELS = 64 * 1024 * 1024
const MAX_EXPORT_PIXELS = 16 * 1024 * 1024
const MAX_EXPORT_DIMENSION = 4096

/** 图片修改：原图与标注参考图作为两份输入发送，输出始终保存为新资产。 */
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
  const sourceBuffer = await readFile(sourcePath)
  const image = await loadImage(sourceBuffer)
  if (!image.width || !image.height) throw new Error('无法读取图片尺寸')
  if (image.width * image.height > MAX_IMAGE_PIXELS) throw new Error('图片解码后超过 6400 万像素')
  const reference = renderAnnotatedReference(image, config.annotations)
  const mask = config.mask?.enabled
    ? renderImageEditMask(image.width, image.height, config.mask)
    : undefined
  return generateImageEditToAsset(
    { ...input, config, size: config.size, prompt: input.prompt.trim() },
    [sourceBuffer, reference],
    mask
  )
}

type CanvasImage = Awaited<ReturnType<typeof loadImage>>

function drawRoundedRect(
  ctx: SKRSContext2D,
  x: number,
  y: number,
  width: number,
  height: number,
  radius: number
): void {
  const r = Math.min(radius, width / 2, height / 2)
  ctx.beginPath()
  ctx.moveTo(x + r, y)
  ctx.lineTo(x + width - r, y)
  ctx.arcTo(x + width, y, x + width, y + r, r)
  ctx.lineTo(x + width, y + height - r)
  ctx.arcTo(x + width, y + height, x + width - r, y + height, r)
  ctx.lineTo(x + r, y + height)
  ctx.arcTo(x, y + height, x, y + height - r, r)
  ctx.lineTo(x, y + r)
  ctx.arcTo(x, y, x + r, y, r)
  ctx.closePath()
}

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
  // 红 / 蓝 / 黄在图片中拥有明显的色相间隔；比红、橙、黄连续色相更容易被视觉模型区分。
  const colors: Record<string, string> = {
    red: '#ff315b',
    blue: '#00b8ff',
    yellow: '#ffd60a',
    orange: '#00b8ff'
  }
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
      const rectWidth = Math.abs(points[1].x - points[0].x)
      const rectHeight = Math.abs(points[1].y - points[0].y)
      drawRoundedRect(ctx, x, y, rectWidth, rectHeight, 4 * scale)
      ctx.stroke()
    } else if (annotation.type === 'text' && points[0]) {
      const fontSize = Math.max(14, Math.round(22 * scale))
      ctx.font = `600 ${fontSize}px sans-serif`
      const text = annotation.text ?? ''
      const metrics = ctx.measureText(text)
      const padX = 7 * scale
      const padY = 4 * scale
      const boxW = metrics.width + padX * 2
      const boxH = fontSize + padY * 2
      const boxX = points[0].x - 2 * scale
      const boxY = points[0].y - fontSize - 2 * scale

      ctx.save()
      ctx.fillStyle = 'rgba(15, 23, 42, 0.88)'
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.25)'
      ctx.lineWidth = 1 * scale
      drawRoundedRect(ctx, boxX, boxY, boxW, boxH, 4 * scale)
      ctx.fill()
      ctx.stroke()
      ctx.fillStyle = color
      ctx.fillText(text, boxX + padX, points[0].y)
      ctx.restore()
    } else if (points.length >= 2) {
      if (annotation.type === 'arrow') {
        const end = points[points.length - 1]
        const prev = points[Math.max(0, points.length - 2)]
        const dx = end.x - prev.x
        const dy = end.y - prev.y
        const dist = Math.hypot(dx, dy)
        if (dist > 1) {
          const angle = Math.atan2(dy, dx)
          const strokeW = Math.max(1, (annotation.strokeWidth ?? 3) * scale)
          const length = Math.min(dist * 0.42, Math.max(14 * scale, strokeW * 3.5 + 8 * scale))
          const theta = (26 * Math.PI) / 180
          const indent = length * 0.26
          const leftX = end.x - length * Math.cos(angle - theta)
          const leftY = end.y - length * Math.sin(angle - theta)
          const rightX = end.x - length * Math.cos(angle + theta)
          const rightY = end.y - length * Math.sin(angle + theta)
          const notchX = end.x - (length - indent) * Math.cos(angle)
          const notchY = end.y - (length - indent) * Math.sin(angle)

          // 绘制线条到倒钩凹槽处，不穿透箭头头部
          ctx.beginPath()
          ctx.moveTo(points[0].x, points[0].y)
          for (const p of points.slice(1, -1)) ctx.lineTo(p.x, p.y)
          ctx.lineTo(notchX, notchY)
          ctx.stroke()

          // 绘制流线型倒钩箭头
          ctx.beginPath()
          ctx.moveTo(end.x, end.y)
          ctx.lineTo(leftX, leftY)
          ctx.lineTo(notchX, notchY)
          ctx.lineTo(rightX, rightY)
          ctx.closePath()
          ctx.fill()
        }
      } else {
        ctx.beginPath()
        ctx.moveTo(points[0].x, points[0].y)
        for (const p of points.slice(1)) ctx.lineTo(p.x, p.y)
        ctx.stroke()
      }
    }
  }
  return canvas.toBuffer('image/png')
}

/** 将遮罩笔画绘制为透明区域；透明部分是 image2 需要重绘的区域。 */
export function renderImageEditMask(width: number, height: number, mask: ImageEditMask): Buffer {
  const scale = Math.min(
    1,
    MAX_EXPORT_DIMENSION / width,
    MAX_EXPORT_DIMENSION / height,
    Math.sqrt(MAX_EXPORT_PIXELS / (width * height))
  )
  const outputWidth = Math.max(1, Math.round(width * scale))
  const outputHeight = Math.max(1, Math.round(height * scale))
  const canvas = createCanvas(outputWidth, outputHeight)
  const ctx = canvas.getContext('2d')
  if (!mask.invert) {
    ctx.fillStyle = '#000'
    ctx.fillRect(0, 0, outputWidth, outputHeight)
    ctx.globalCompositeOperation = 'destination-out'
  } else {
    ctx.clearRect(0, 0, outputWidth, outputHeight)
    ctx.globalCompositeOperation = 'source-over'
  }
  ctx.strokeStyle = '#fff'
  ctx.lineCap = 'round'
  ctx.lineJoin = 'round'
  ctx.lineWidth = Math.max(1, mask.brushSize * Math.min(outputWidth, outputHeight))
  for (const stroke of mask.strokes) {
    if (stroke.length < 2) continue
    ctx.beginPath()
    ctx.moveTo(stroke[0].x * outputWidth, stroke[0].y * outputHeight)
    for (const point of stroke.slice(1)) ctx.lineTo(point.x * outputWidth, point.y * outputHeight)
    ctx.stroke()
  }
  return canvas.toBuffer('image/png')
}
