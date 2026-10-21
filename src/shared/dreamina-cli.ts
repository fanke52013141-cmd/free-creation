// 即梦 CLI 的纯协议层：子命令组装与 stdout 结果归一化。
//
// 刻意不依赖进程、文件、数据库或 Electron，因此：
//   1. main 侧只有一份实现（gateway/dreamina-cli.ts 负责 spawn 与落盘）；
//   2. 参数组装可以被单测直接覆盖，不需要真的起子进程、也不消耗额度。

export class DreaminaCliError extends Error {
  code: string
  constructor(code: string, message: string) {
    super(message)
    this.name = 'DreaminaCliError'
    this.code = code
  }
}

export interface DreaminaImageArgs {
  modelId: string
  prompt: string
  ratio?: string
  /** CLI 该参数必填；调用方必须给出能力表里的合法档位。 */
  resolution: string
  /** 已解析成本地绝对路径的参考图；空数组表示文生图。 */
  referencePaths: string[]
}

export interface DreaminaVideoArgs {
  modelId: string
  mode: 'text' | 'first-frame' | 'first-last-frame' | 'reference'
  prompt: string
  resolution: string
  ratio?: string
  duration?: number
  firstFramePath?: string
  lastFramePath?: string
  referenceImagePaths?: string[]
  referenceVideoPaths?: string[]
  referenceAudioPaths?: string[]
}

/** 与 video.ts 的 UpstreamState 结构一致，因此可直接交给既有轮询链路。 */
export interface DreaminaTaskState {
  status: 'running' | 'succeeded' | 'failed' | 'cancelled' | 'unknown'
  url?: string
  error?: string
}

/** seedance2.5 在图生/首尾帧下显式拒绝 --ratio：画幅只能跟首帧走。 */
export function isSeedance25(modelId: string): boolean {
  return /seedance\s*2[._-]?5/i.test(modelId)
}

/**
 * 文生图 / 图生图：由"是否连了参考图"决定子命令，不新增任何节点配置项。
 */
export function buildImageArgs(req: DreaminaImageArgs): string[] {
  const args = req.referencePaths.length > 0 ? ['image2image'] : ['text2image']
  args.push(
    `--prompt=${req.prompt}`,
    `--model_version=${req.modelId}`,
    `--resolution_type=${req.resolution}`,
    '--session=0',
    // 不让 CLI 内部阻塞：外层自己轮询，才能响应取消并记录 submit_id。
    '--poll=0'
  )
  if (req.ratio) args.push(`--ratio=${req.ratio}`)
  for (const path of req.referencePaths) args.push(`--images=${path}`)
  return args
}

/**
 * 按既有 VideoGenerationMode 组装子命令，四条路径与 video 节点的 mode 一一对应。
 */
export function buildVideoArgs(args: DreaminaVideoArgs): string[] {
  const common = [
    `--model_version=${args.modelId}`,
    `--video_resolution=${args.resolution}`,
    '--session=0',
    '--poll=0'
  ]
  let command: string[]
  switch (args.mode) {
    case 'text':
      command = ['text2video', `--prompt=${args.prompt}`, ...common]
      break
    case 'first-frame':
      if (!args.firstFramePath)
        throw new DreaminaCliError('INVALID_INPUT', '首帧模式缺少首帧图片')
      command = [
        'image2video',
        `--image=${args.firstFramePath}`,
        `--prompt=${args.prompt}`,
        ...common
      ]
      break
    case 'first-last-frame':
      if (!args.firstFramePath || !args.lastFramePath)
        throw new DreaminaCliError('INVALID_INPUT', '首尾帧模式需要首帧与尾帧两张图片')
      command = [
        'frames2video',
        `--first=${args.firstFramePath}`,
        `--last=${args.lastFramePath}`,
        `--prompt=${args.prompt}`,
        ...common
      ]
      break
    case 'reference': {
      command = ['multimodal2video']
      for (const path of args.referenceImagePaths ?? []) command.push(`--image=${path}`)
      for (const path of args.referenceVideoPaths ?? []) command.push(`--video=${path}`)
      for (const path of args.referenceAudioPaths ?? []) command.push(`--audio=${path}`)
      if (args.prompt) command.push(`--prompt=${args.prompt}`)
      command.push(...common)
      break
    }
    default:
      throw new DreaminaCliError('INVALID_INPUT', '即梦不支持该视频生成模式')
  }
  const framesMode = args.mode === 'first-frame' || args.mode === 'first-last-frame'
  const ratioAllowed = !(framesMode && isSeedance25(args.modelId))
  if (ratioAllowed && args.ratio) command.push(`--ratio=${args.ratio}`)
  if (typeof args.duration === 'number') command.push(`--duration=${args.duration}`)
  return command
}

export function pickMediaUrl(item: unknown): string | undefined {
  if (!item || typeof item !== 'object') return undefined
  const record = item as Record<string, unknown>
  const value = record.video_url ?? record.image_url ?? record.url
  return typeof value === 'string' && value ? value : undefined
}

/**
 * CLI 的 gen_status 是唯一权威：提交成功只代表受理，不代表产物已就绪。
 * 认不出的状态一律按"还在跑"处理，由外层继续轮询直到超时。
 */
export function classifyDreaminaTask(data: Record<string, unknown>): DreaminaTaskState {
  const status = String(data.gen_status ?? data.status ?? '')
    .trim()
    .toLowerCase()
  const result = (data.result_json ?? {}) as Record<string, unknown>
  if (status === 'success') {
    const videos = Array.isArray(result.videos) ? result.videos : []
    const images = Array.isArray(result.images) ? result.images : []
    const url = pickMediaUrl(videos[0]) ?? pickMediaUrl(images[0])
    return url
      ? { status: 'succeeded', url }
      : { status: 'failed', error: '即梦任务成功但未返回产物地址' }
  }
  if (status === 'fail' || status === 'failed') {
    const reason = String(data.fail_reason ?? data.error ?? '').trim()
    return { status: 'failed', error: reason || '即梦生成失败（未返回具体原因）' }
  }
  if (status === 'cancelled' || status === 'canceled') return { status: 'cancelled' }
  // querying / running / queued / 空状态都按"还在跑"处理。
  return { status: 'running' }
}
