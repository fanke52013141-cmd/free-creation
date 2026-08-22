// 视频合成：使用系统 ffmpeg 将多个视频片段拼接为一个
// 通过 child_process.execFile 调用 ffmpeg，采用 concat demuxer 方式
// 若各片段编码不同则自动 re-encode 以确保兼容性
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { writeFile, unlink, mkdir, access } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { nanoid } from 'nanoid'
import type { ComposeVideosInput } from '../../shared/contracts'
import type { MediaAsset } from '../../shared/types'
import { getDb } from '../store/db'
import { saveBufferAsset } from '../store/media.repo'
import { GatewayError } from './factory'

const execFileAsync = promisify(execFile)
const COMPOSE_TIMEOUT_MS = 5 * 60 * 1000

/** 查找系统可用的 ffmpeg 可执行文件 */
async function findFfmpeg(): Promise<string> {
  // Windows 常见路径
  const candidates = [
    'ffmpeg',
    'ffmpeg.exe',
    // winget 安装路径
    ...(process.env.PATH?.split(';')
      .filter(Boolean)
      .map((d) => join(d, 'ffmpeg.exe')) ?? [])
  ]
  for (const cmd of candidates) {
    try {
      await execFileAsync(cmd, ['-version'], { timeout: 5000, shell: true })
      return cmd
    } catch {
      // 继续尝试下一个
    }
  }
  throw new GatewayError('FFMPEG_NOT_FOUND', '系统中未找到 ffmpeg，请安装后重试')
}

interface MediaRow {
  id: string
  path: string
  mime: string
}

function getMediaPath(mediaId: string): string {
  const row = getDb().prepare('SELECT path, mime FROM media WHERE id = ?').get(mediaId) as
    MediaRow | undefined
  if (!row) throw new GatewayError('MEDIA_NOT_FOUND', `媒体文件不存在：${mediaId}`)
  return row.path
}

export async function composeVideosToAsset(input: ComposeVideosInput): Promise<MediaAsset> {
  if (!input.mediaIds?.length) throw new GatewayError('INVALID_INPUT', '没有视频片段可合成')
  if (input.mediaIds.length < 2) throw new GatewayError('INVALID_INPUT', '至少需要 2 个视频片段')

  const ffmpeg = await findFfmpeg()
  const paths = input.mediaIds.map(getMediaPath)

  // 验证所有文件存在
  for (const p of paths) {
    try {
      await access(p)
    } catch {
      throw new GatewayError('FILE_NOT_FOUND', `文件不存在：${p}`)
    }
  }

  // 创建临时 concat 列表文件
  const tmpDir = join(dirname(paths[0]), '.compose-tmp')
  await mkdir(tmpDir, { recursive: true })
  const listFile = join(tmpDir, `list-${nanoid(6)}.txt`)
  const outputFile = join(tmpDir, `composed-${nanoid(6)}.mp4`)

  // concat demuxer 格式
  const listContent = paths.map((p) => `file '${p.replace(/\\/g, '/')}'`).join('\n')
  await writeFile(listFile, listContent, 'utf-8')

  try {
    // 尝试 concat demuxer + stream copy（快速，要求编码一致）
    try {
      await execFileAsync(
        ffmpeg,
        ['-f', 'concat', '-safe', '0', '-i', listFile, '-c', 'copy', '-y', outputFile],
        { timeout: COMPOSE_TIMEOUT_MS, maxBuffer: 10 * 1024 * 1024 }
      )
    } catch {
      // 快速拼接失败（编码不一致），回退到 re-encode
      await execFileAsync(
        ffmpeg,
        [
          '-f',
          'concat',
          '-safe',
          '0',
          '-i',
          listFile,
          '-c:v',
          'libx264',
          '-preset',
          'fast',
          '-crf',
          '23',
          '-c:a',
          'aac',
          '-b:a',
          '128k',
          '-pix_fmt',
          'yuv420p',
          '-y',
          outputFile
        ],
        { timeout: COMPOSE_TIMEOUT_MS, maxBuffer: 10 * 1024 * 1024 }
      )
    }

    // 读取结果并入库
    const { readFile } = await import('node:fs/promises')
    const buf = await readFile(outputFile)
    if (!buf.length) throw new GatewayError('COMPOSE_FAILED', '合成结果为空')

    const asset = await saveBufferAsset(input.projectId, buf, '.mp4', '视频合成')
    return asset
  } finally {
    // 清理临时文件
    await unlink(listFile).catch(() => {})
    await unlink(outputFile).catch(() => {})
  }
}
