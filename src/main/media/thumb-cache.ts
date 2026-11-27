import { createHash } from 'crypto'
import { mkdirSync, statSync } from 'fs'
import { readFile, writeFile } from 'fs/promises'
import { extname, join } from 'path'
import { nativeImage } from 'electron'
import { getDataDir } from '../store/db'

const ALLOWED_WIDTHS = new Set([128, 680, 1024])
const RASTER_EXTS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.bmp'])

/**
 * 2x Retina 缩略图缓存（主进程原生 nativeImage 缩放，不引入 sharp 外部依赖）。
 * 仅对栅格图生效；GIF/SVG/视频或超小原图直接返回 null（由调用方回退原图）。
 */
export async function getOrCreateThumb(
  sourcePath: string,
  requestedWidth: number
): Promise<Buffer | null> {
  if (!ALLOWED_WIDTHS.has(requestedWidth)) return null
  const ext = extname(sourcePath).toLowerCase()
  if (!RASTER_EXTS.has(ext)) return null

  let st: { size: number; mtimeMs: number }
  try {
    st = statSync(sourcePath)
  } catch {
    return null
  }

  const cacheDir = join(getDataDir(), '.thumb-cache')
  mkdirSync(cacheDir, { recursive: true })
  const key = createHash('sha1')
    .update(`${sourcePath}|${st.size}|${st.mtimeMs}|${requestedWidth}`)
    .digest('hex')
  const cachePath = join(cacheDir, `${key}.jpg`)

  try {
    return await readFile(cachePath)
  } catch {
    // cache miss
  }

  try {
    const img = nativeImage.createFromPath(sourcePath)
    if (img.isEmpty()) return null
    const size = img.getSize()
    if (size.width <= requestedWidth) return null
    const resized = img.resize({ width: requestedWidth, quality: 'good' })
    const jpeg = resized.toJPEG(82)
    void writeFile(cachePath, jpeg).catch(() => undefined)
    return jpeg
  } catch {
    return null
  }
}
