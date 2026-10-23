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
    throw new ViduCliError('VIDU_MODEL_UNSUPPORTED', '当前 Vidu 仅支持 Q4（3.4）参考生视频与 Q3（3.2）首尾帧')
  const frames = input.modelId === VIDU_Q3_MODEL
  if (input.mode !== (frames ? 'first-last-frame' : 'reference'))
    throw new ViduCliError('INVALID_INPUT', frames ? 'Vidu Q3 仅开放首尾帧生视频' : 'Vidu Q4 官方 CLI 暂不支持首尾帧；请显式选择 Q3 首尾帧模型')
  if (!input.prompt.trim()) throw new ViduCliError('INVALID_INPUT', '提示词不能为空')
  if (!Number.isInteger(input.duration) || input.duration < 1 || input.duration > 10)
    throw new ViduCliError('INVALID_INPUT', 'Vidu 视频时长必须为 1–10 秒的整数')
  if (!(frames ? ['1080p'] : VIDU_RESOLUTIONS).includes(input.resolution))
    throw new ViduCliError('INVALID_INPUT', 'Vidu 清晰度无效')
  if (input.ratio && !VIDU_RATIOS.includes(input.ratio))
    throw new ViduCliError('INVALID_INPUT', 'Vidu 画幅无效')
  if (frames ? input.imagePaths.length !== 2 : !input.imagePaths.length || input.imagePaths.length > 7)
    throw new ViduCliError('INVALID_INPUT', frames ? 'Vidu 首尾帧需要按顺序连接 2 张图片' : 'Vidu 参考生视频需要 1–7 张图片')
  return [
    'task', 'submit', '--type', frames ? 'headtailimg2video' : 'character2video', '--model-version', input.modelId,
    `--prompt=${input.prompt.trim()}`, '--duration', String(input.duration),
    '--resolution', input.resolution,
    ...(frames ? ['--transition', 'pro'] : ['--aspect-ratio', input.ratio || '16:9']),
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
  return { status: 'unknown' }
}
