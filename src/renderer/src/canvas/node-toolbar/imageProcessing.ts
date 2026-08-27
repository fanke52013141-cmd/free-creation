// 节点图片快捷工具的前端处理管线（借鉴 infinite-atelier canvas-image-data.ts）：
// 全部走 Canvas2D，无后端依赖；处理产物以 dataUrl 返回，由调用方入库并生成新节点。

export interface CropRect {
  x: number
  y: number
  w: number
  h: number
}

const MAX_LONG_EDGE = 4096

export function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.decoding = 'async'
    img.onload = () => resolve(img)
    img.onerror = () => reject(new Error('图片加载失败'))
    img.src = src
  })
}

function canvasToDataUrl(canvas: HTMLCanvasElement): string {
  return canvas.toDataURL('image/png')
}

export async function cropToDataUrl(img: HTMLImageElement, rect: CropRect): Promise<string> {
  const canvas = document.createElement('canvas')
  canvas.width = Math.max(1, Math.round(rect.w))
  canvas.height = Math.max(1, Math.round(rect.h))
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('画布不可用')
  ctx.drawImage(img, rect.x, rect.y, rect.w, rect.h, 0, 0, canvas.width, canvas.height)
  return canvasToDataUrl(canvas)
}

export async function splitToDataUrls(
  img: HTMLImageElement,
  cols: number,
  rows: number
): Promise<string[]> {
  const cellW = img.naturalWidth / cols
  const cellH = img.naturalHeight / rows
  const results: string[] = []
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      results.push(await cropToDataUrl(img, { x: c * cellW, y: r * cellH, w: cellW, h: cellH }))
    }
  }
  return results
}

// 逐级 2 倍放大（drawImage 高质量平滑）避免单次大跨度重采样造成的糊边，长边封顶 4096
export async function upscaleToDataUrl(img: HTMLImageElement, scale: number): Promise<string> {
  let current: HTMLImageElement | HTMLCanvasElement = img
  let width = img.naturalWidth
  let height = img.naturalHeight
  const targetW = Math.min(Math.round(width * scale), MAX_LONG_EDGE)
  const targetH = Math.min(Math.round(height * scale), MAX_LONG_EDGE)
  while (width * 2 <= targetW || height * 2 <= targetH) {
    const next = document.createElement('canvas')
    next.width = Math.min(width * 2, targetW)
    next.height = Math.min(height * 2, targetH)
    const ctx = next.getContext('2d')
    if (!ctx) throw new Error('画布不可用')
    ctx.imageSmoothingEnabled = true
    ctx.imageSmoothingQuality = 'high'
    ctx.drawImage(current, 0, 0, next.width, next.height)
    current = next
    width = next.width
    height = next.height
  }
  const canvas = document.createElement('canvas')
  canvas.width = targetW
  canvas.height = targetH
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('画布不可用')
  ctx.imageSmoothingEnabled = true
  ctx.imageSmoothingQuality = 'high'
  ctx.drawImage(current, 0, 0, targetW, targetH)
  return canvasToDataUrl(canvas)
}

export async function dataUrlToBytes(dataUrl: string): Promise<Uint8Array> {
  const response = await fetch(dataUrl)
  return new Uint8Array(await response.arrayBuffer())
}
