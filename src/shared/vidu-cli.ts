import type { VideoGenerationMode } from './types'

/** Vidu Q4 is CLI model version 3.4. No model fallback is permitted. */
export const VIDU_Q4_MODEL = '3.4'
export const VIDU_Q3_MODEL = '3.2'
export const VIDU_MODELS = [VIDU_Q4_MODEL, VIDU_Q3_MODEL]
export const VIDU_BASE_URL = 'https://service.vidu.cn'
export const VIDU_RESOLUTIONS = ['540p', '720p', '1080p', '2k', '4k']
export const VIDU_RATIOS = ['16:9', '9:16', '1:1', '4:3', '3:4']

export class ViduCliError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message)
    this.name = 'ViduCliError'
  }
}

export interface ViduVideoArgs {
  modelId: string
  mode: VideoGenerationMode
  prompt: string
  duration: number
  resolution: string
  ratio?: string
  imagePaths: string[]
}

export function buildViduVideoArgs(input: ViduVideoArgs): string[] {
  if (!VIDU_MODELS.includes(input.modelId))
    throw new ViduCliError('VIDU_MODEL_UNSUPPORTED', '当前 Vidu 仅支持 Q4（3.4）参考生视频与 Q3（3.2）文生/首帧/首尾帧/参考生视频')
  const q4 = input.modelId === VIDU_Q4_MODEL
  if (q4 && input.mode !== 'reference')
    throw new ViduCliError('INVALID_INPUT', 'Vidu Q4 官方 CLI 仅开放参考生视频（character2video）；首帧/首尾帧请选 Q3')
  if (!input.prompt.trim()) throw new ViduCliError('INVALID_INPUT', '提示词不能为空')
  if (!Number.isInteger(input.duration) || input.duration < 1 || input.duration > 16)
    throw new ViduCliError('INVALID_INPUT', 'Vidu 视频时长必须为 1–16 秒的整数')
  if (!(q4 ? VIDU_RESOLUTIONS : ['1080p']).includes(input.resolution))
    throw new ViduCliError('INVALID_INPUT', 'Vidu 清晰度无效')
  if (input.ratio && !VIDU_RATIOS.includes(input.ratio))
    throw new ViduCliError('INVALID_INPUT', 'Vidu 画幅无效')
  const expectedImages =
    input.mode === 'text' ? 0 : input.mode === 'first-frame' ? 1 : input.mode === 'first-last-frame' ? 2 : -1
  if (expectedImages >= 0 ? input.imagePaths.length !== expectedImages : !input.imagePaths.length || input.imagePaths.length > 7)
    throw new ViduCliError(
      'INVALID_INPUT',
      input.mode === 'text'
        ? 'Vidu 文生视频不能连接图片'
        : input.mode === 'first-frame'
          ? 'Vidu 首帧生视频需要 1 张图片'
          : input.mode === 'first-last-frame'
            ? 'Vidu 首尾帧需要按顺序连接 2 张图片'
            : 'Vidu 参考生视频需要 1–7 张图片'
    )
  const type =
    input.mode === 'text'
      ? 'text2video'
      : input.mode === 'first-frame'
        ? 'img2video'
        : input.mode === 'first-last-frame'
          ? 'headtailimg2video'
          : 'character2video'
  return [
    'task', 'submit', '--type', type, '--model-version', input.modelId,
    `--prompt=${input.prompt.trim()}`, '--duration', String(input.duration),
    '--resolution', input.resolution,
    // 首帧/首尾帧按图片推导画幅；文生和参考模式显式传画幅。
    ...(type === 'img2video' || type === 'headtailimg2video' ? [] : ['--aspect-ratio', input.ratio || '16:9']),
    // 3.1/3.2 的图片类任务要求 transition，纯文生（3.2）也支持。
    // Q4（3.4）**明确不接受** transition：CLI 会返回
    // "Q4 should not include transition"（client_error，本地即失败，不会产生任务）。
    ...(type === 'text2video' || input.modelId === VIDU_Q4_MODEL ? [] : ['--transition', 'pro']),
    '--schedule-mode', 'normal', '--sample-count', '1', '--codec', 'h264',
    ...input.imagePaths.flatMap((path) => [`--image=${path}`])
  ]
}

export function parseViduOutput(raw: string): Record<string, unknown> {
  try {
    const data: unknown = JSON.parse(raw.trim())
    if (data && typeof data === 'object' && !Array.isArray(data)) return data as Record<string, unknown>
  } catch { /* Never return raw stdout: it may contain prompts, credentials or signed URLs. */ }
  throw new ViduCliError('VIDU_BAD_OUTPUT', 'Vidu CLI 返回了无法解析的结果，请核对原任务，避免重复提交')
}

export function classifyViduTask(data: Record<string, unknown>): {
  status: 'running' | 'succeeded' | 'failed' | 'cancelled' | 'unknown'
  url?: string
  error?: string
} {
  if (data.state === 'success') {
    const creations = Array.isArray(data.creations) ? data.creations : []
    const first = creations[0] as Record<string, unknown> | undefined
    const url = first?.nomark_uri || first?.download_uri || first?.uri
    if (typeof url === 'string' && /^https?:\/\//i.test(url)) return { status: 'succeeded', url }
    return { status: 'unknown' }
  }
  if (data.state === 'failed') return { status: 'failed', error: 'Vidu 远端生成失败，请查看任务状态' }
  if (data.state === 'canceled' || data.state === 'cancelled') return { status: 'cancelled' }
  if (['created', 'queueing', 'queued', 'processing', 'running'].includes(String(data.state)))
    return { status: 'running' }
  // 文档之外的状态值（或暂时缺 state 的响应）按仍在运行处理：任务已在上游计费运行，
  // 误判成 unknown 会立刻终止轮询，远端成功后本地再也取不回结果（Vidu Q4 实测踩坑）。
  return { status: 'running' }
}
