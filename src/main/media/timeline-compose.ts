// 主进程：多素材时间线合成（M4）。
//
// 职责边界：本模块只做「时间线片段 → 一条 MP4」，不解析项目快照、不落库、不接 IPC。
// 调用方（节点执行器）负责把时间线节点解析成 clips/audioClips，并决定产物如何记账。
//
// 合成策略（三步）：
// 1) 归一化：每个画面片段先转成参数完全一致的中间 MP4 —— 统一分辨率（等比缩放 + 居中补边）、
//    统一 SAR/像素格式/帧率，并且**一律带一条 48kHz 立体声音轨**（源无音轨时用 anullsrc 补静音）。
//    只要有一段的流结构或时间基不一致，下一步的 `-c copy` 拼接就会直接失败。
// 2) 拼接：concat demuxer 先按时间顺序写列表文件（时间线上的空档补黑帧 + 静音，保证 startMs
//    有意义），优先 `-c copy` 无损拼接；失败（容器/时间基差异）再回退为一次重编码拼接，
//    回退对调用方不可见。
// 3) 混音 / 封装：视频轨原音 + audioClips（各自 `adelay=startMs|startMs` 对齐、`volume` 增益）
//    走 amix，统一 `-ar 48000 -ac 2`，画面直接 copy，最后 `-movflags +faststart` 输出 H.264 + AAC。
//
// 其它约定：
// - 中间产物只落在 os.tmpdir() 下的唯一目录，成功失败都在 finally 清理。
// - 子进程统一走 ./ffmpeg-runner（进度 / 取消登记复用公共执行件），本模块不自己 spawn。
// - 阶段之间检查 isMediaCancelled() 提前退出；停止工作流时主进程 kill 子进程。
// - 任何失败都翻译成返回值，绝不向调用方抛错；ENOENT 单独标记 missingTool。
// - 禁止 console 输出：诊断走调用方 trace / 诊断 IPC（本模块只返回结构化 reason）。
import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { isMediaCancelled } from './cancellation'
import {
  FFMPEG_MISSING_HINT,
  FFPROBE_MISSING_HINT,
  resolveFfprobeBinary,
  runFfmpeg,
  runProcess
} from './ffmpeg-runner'

export interface TimelineComposeClip {
  kind: 'video' | 'image' | 'audio'
  /** 绝对路径 */
  sourcePath: string
  /** 时间线上的起点（毫秒） */
  startMs: number
  /** 在时间线上的长度（毫秒） */
  durationMs: number
  /** 源素材内起点（毫秒），视频/音频裁剪用；图片忽略 */
  inMs?: number
  /** 源素材总时长，用于把 inMs+durationMs 夹到源尾 */
  sourceDurationMs?: number
  /** 0..1，缺省 1 */
  volume?: number
}

export interface TimelineComposeInput {
  outputPath: string
  width: number
  height: number
  frameRate: number
  /** 视频轨（含图片），我会按 startMs 升序传给你 */
  clips: TimelineComposeClip[]
  /** 音频轨，各自按 startMs 对齐混入 */
  audioClips?: TimelineComposeClip[]
  /** 片段级进度：stage 变化 + done/total + 0..1 */
  onProgress?: (p: {
    stage: 'prepare' | 'render' | 'mux'
    done: number
    total: number
    ratio: number | null
  }) => void
}

export type TimelineComposeResult =
  | { ok: true; outputPath: string; durationMs: number }
  | { ok: false; reason: string; missingTool: boolean }

const CANCELLED_REASON = '时间线合成已停止'
/** 小于该值的「空档」直接并进相邻片段，不值得生成一段黑帧（低于一帧的缝隙）。 */
const GAP_TOLERANCE_MS = 20

type ComposeProgress = {
  stage: 'prepare' | 'render' | 'mux'
  done: number
  total: number
  ratio: number | null
}

interface ResolvedClip {
  inMs: number
  durationMs: number
  hasAudio: boolean
}

interface RenderOptions {
  width: number
  height: number
  frameRate: number
}

/**
 * 把多轨时间线合成为一条 MP4。
 * 无论 FFmpeg 缺失、素材损坏还是被用户停止，都以返回值收尾，不向调用方抛错。
 */
export async function composeTimeline(input: TimelineComposeInput): Promise<TimelineComposeResult> {
  let tempDir: string | null = null
  try {
    tempDir = await mkdtemp(join(tmpdir(), 'canvas-studio-timeline-'))
    return await composeInTempDir(input, tempDir)
  } catch (error) {
    if (isMediaCancelled()) {
      return { ok: false, missingTool: false, reason: CANCELLED_REASON }
    }
    const reason = error instanceof Error ? error.message.trim() : String(error)
    if (isMissingToolMessage(reason)) {
      // ENOENT：FFmpeg/FFprobe 都不在 PATH 或配置路径上。两者通常同包安装，统一给 FFmpeg 提示。
      return { ok: false, missingTool: true, reason: FFMPEG_MISSING_HINT }
    }
    return { ok: false, missingTool: false, reason: reason || '时间线合成失败' }
  } finally {
    if (tempDir) await rm(tempDir, { recursive: true, force: true }).catch(() => undefined)
  }
}

async function composeInTempDir(
  input: TimelineComposeInput,
  tempDir: string
): Promise<TimelineComposeResult> {
  const outputPath = typeof input.outputPath === 'string' ? input.outputPath.trim() : ''
  if (!outputPath) return { ok: false, missingTool: false, reason: '缺少时间线输出路径' }

  const clips = normalizeClipList(input.clips)
  if (clips.length === 0) {
    return { ok: false, missingTool: false, reason: '时间线上没有画面片段，无法生成视频' }
  }
  const audioClips = normalizeClipList(input.audioClips ?? [])
  const width = normalizeDimension(input.width)
  const height = normalizeDimension(input.height)
  if (!width || !height) {
    return { ok: false, missingTool: false, reason: '时间线画布尺寸无效，请检查宽高' }
  }
  const frameRate = normalizeFrameRate(input.frameRate)
  const renderOptions: RenderOptions = { width, height, frameRate }

  // ── 阶段 1：归一化画面片段（含时间线空档的黑帧填充）──
  const total = clips.length
  const segments: string[] = []
  let cursorMs = 0
  let gapIndex = 0
  for (let index = 0; index < clips.length; index++) {
    if (isMediaCancelled()) throw new Error(CANCELLED_REASON)
    const clip = clips[index]
    const resolved = await resolveClip(clip)
    if (resolved.durationMs <= 0) {
      throw new Error(`第 ${index + 1} 个画面片段的起点已超出源素材时长，请调整起点或时长。`)
    }

    const startMs = Math.max(0, Math.round(clip.startMs))
    const gapMs = startMs - cursorMs
    if (gapMs > GAP_TOLERANCE_MS) {
      const gapPath = join(tempDir, `gap-${padded(gapIndex++)}.mp4`)
      await renderFiller(gapPath, gapMs, renderOptions)
      segments.push(gapPath)
      cursorMs += gapMs
    }

    const segmentPath = join(tempDir, `clip-${padded(index)}.mp4`)
    await renderClip(clip, resolved, segmentPath, renderOptions)
    segments.push(segmentPath)
    cursorMs += resolved.durationMs
    emitProgress(input, {
      stage: 'prepare',
      done: index + 1,
      total,
      ratio: total > 0 ? (index + 1) / total : null
    })
  }

  const durationMs = cursorMs
  if (durationMs <= 0) {
    return { ok: false, missingTool: false, reason: '时间线总时长为 0，无法生成视频' }
  }

  // ── 阶段 2：拼接视频轨（先 copy，失败静默回退重编码）──
  if (isMediaCancelled()) throw new Error(CANCELLED_REASON)
  const listPath = join(tempDir, 'concat.txt')
  await writeFile(listPath, `${segments.map(concatEntry).join('\n')}\n`, 'utf8')
  const videoTrackPath = join(tempDir, 'video-track.mp4')
  emitProgress(input, { stage: 'mux', done: 1, total: 1, ratio: 0 })

  try {
    await runFfmpeg(
      ['-f', 'concat', '-safe', '0', '-i', listPath, '-c', 'copy', '-y', videoTrackPath],
      {
        totalMs: durationMs,
        onProgress: (progress) =>
          emitProgress(input, {
            stage: 'mux',
            done: 1,
            total: 1,
            ratio: progress.ratio === null ? null : progress.ratio * 0.2
          })
      }
    )
  } catch {
    if (isMediaCancelled()) throw new Error(CANCELLED_REASON)
    // 归一化参数已对齐，copy 失败通常来自容器时间基差异。重编码兜底，不把中间失败暴露给用户。
    await runFfmpeg(
      [
        '-f',
        'concat',
        '-safe',
        '0',
        '-i',
        listPath,
        '-c:v',
        'libx264',
        '-crf',
        '18',
        '-preset',
        'veryfast',
        '-pix_fmt',
        'yuv420p',
        '-c:a',
        'aac',
        '-ar',
        '48000',
        '-ac',
        '2',
        '-y',
        videoTrackPath
      ],
      {
        totalMs: durationMs,
        onProgress: (progress) =>
          emitProgress(input, {
            stage: 'mux',
            done: 1,
            total: 1,
            ratio: progress.ratio === null ? null : 0.2 + progress.ratio * 0.2
          })
      }
    )
  }

  // ── 阶段 3：混音 + 最终封装 ──
  if (isMediaCancelled()) throw new Error(CANCELLED_REASON)
  const audioTracks: Array<{
    sourcePath: string
    inMs: number
    durationMs: number
    startMs: number
    volume: number
  }> = []
  for (const clip of audioClips) {
    if (clip.kind === 'image') continue
    const resolved = await resolveClip(clip)
    if (resolved.durationMs <= 0 || !resolved.hasAudio) continue
    audioTracks.push({
      sourcePath: clip.sourcePath,
      inMs: resolved.inMs,
      durationMs: resolved.durationMs,
      startMs: Math.max(0, Math.round(clip.startMs)),
      volume: normalizeVolume(clip.volume)
    })
  }

  const args: string[] = ['-i', videoTrackPath]
  const audioInputs: string[] = []
  const filterParts: string[] = []
  const mixLabels: string[] = []
  audioTracks.forEach((track, index) => {
    const inputIndex = index + 1
    audioInputs.push(
      '-ss',
      seconds(track.inMs),
      '-t',
      seconds(track.durationMs),
      '-i',
      track.sourcePath
    )
    // 先统一为 48kHz 立体声，再按 startMs 延迟：adelay 的双通道写法要求输入已是双声道，
    // 单声道素材直接写 `x|x` 会落到不存在的第二通道上。
    filterParts.push(
      `[${inputIndex}:a]aresample=48000,aformat=channel_layouts=stereo,` +
        `volume=${track.volume.toFixed(3)},adelay=${track.startMs}|${track.startMs}[a${index}]`
    )
    mixLabels.push(`[a${index}]`)
  })

  if (mixLabels.length > 0) {
    // [0:a] 是视频轨原音（已按时间线顺序排好）；amix 不归一化，保留各轨原始电平。
    const filter = [
      '[0:a]anull[a0]',
      ...filterParts,
      `[a0]${mixLabels.join('')}amix=inputs=${mixLabels.length + 1}:` +
        'duration=longest:dropout_transition=0:normalize=0[aout]'
    ].join(';')
    args.push(...audioInputs, '-filter_complex', filter, '-map', '0:v:0', '-map', '[aout]')
  } else {
    args.push('-map', '0:v:0', '-map', '0:a:0')
  }

  args.push(
    '-c:v',
    'copy',
    '-c:a',
    'aac',
    '-b:a',
    '192k',
    '-ar',
    '48000',
    '-ac',
    '2',
    '-t',
    seconds(durationMs),
    '-movflags',
    '+faststart',
    '-y',
    outputPath
  )

  await mkdir(dirname(outputPath), { recursive: true })
  await runFfmpeg(args, {
    totalMs: durationMs,
    onProgress: (progress) =>
      emitProgress(input, {
        stage: 'mux',
        done: 1,
        total: 1,
        ratio: progress.ratio === null ? null : 0.4 + progress.ratio * 0.6
      })
  })

  const created = await stat(outputPath).catch(() => null)
  if (!created?.isFile() || created.size === 0) {
    throw new Error('时间线合成没有生成有效视频文件')
  }
  // 时长以产物为准（片段被源尾截断、帧对齐都会带来几帧偏差）；探测失败时退回时间线口径。
  const actualDurationMs = (await probeDurationMs(outputPath)) ?? durationMs
  emitProgress(input, { stage: 'mux', done: 1, total: 1, ratio: 1 })
  return { ok: true, outputPath, durationMs: actualDurationMs }
}

/** 归一化单个画面片段：分辨率/SAR/帧率/音轨结构全部抹平，供 concat -c copy 使用。 */
async function renderClip(
  clip: TimelineComposeClip,
  resolved: ResolvedClip,
  outputPath: string,
  options: RenderOptions
): Promise<void> {
  const videoFilter = buildVideoFilter(options)
  const volume = normalizeVolume(clip.volume).toFixed(3)
  const audioChain = resolved.hasAudio
    ? `[0:a]volume=${volume},aresample=48000,aformat=channel_layouts=stereo,apad[a]`
    : 'anullsrc=r=48000:cl=stereo[a]'
  const inputArgs =
    clip.kind === 'image'
      ? [
          '-loop',
          '1',
          '-framerate',
          String(options.frameRate),
          '-t',
          seconds(resolved.durationMs),
          '-i',
          clip.sourcePath
        ]
      : [
          '-ss',
          seconds(resolved.inMs),
          '-t',
          seconds(resolved.durationMs),
          '-i',
          clip.sourcePath
        ]

  await runFfmpeg(
    [
      ...inputArgs,
      '-filter_complex',
      `[0:v]${videoFilter}[v];${audioChain}`,
      '-map',
      '[v]',
      '-map',
      '[a]',
      '-c:v',
      'libx264',
      '-crf',
      '18',
      '-preset',
      'veryfast',
      '-pix_fmt',
      'yuv420p',
      '-c:a',
      'aac',
      '-ar',
      '48000',
      '-ac',
      '2',
      '-t',
      seconds(resolved.durationMs),
      '-avoid_negative_ts',
      'make_zero',
      '-y',
      outputPath
    ],
    { totalMs: resolved.durationMs }
  )
}

/** 时间线空档：纯黑画面 + 静音，长度精确对齐缺口。 */
async function renderFiller(
  outputPath: string,
  durationMs: number,
  options: RenderOptions
): Promise<void> {
  await runFfmpeg(
    [
      '-f',
      'lavfi',
      '-t',
      seconds(durationMs),
      '-i',
      `color=c=black:s=${options.width}x${options.height}:r=${options.frameRate}`,
      '-filter_complex',
      '[0:v]setsar=1,format=yuv420p[v];anullsrc=r=48000:cl=stereo[a]',
      '-map',
      '[v]',
      '-map',
      '[a]',
      '-c:v',
      'libx264',
      '-crf',
      '18',
      '-preset',
      'veryfast',
      '-pix_fmt',
      'yuv420p',
      '-c:a',
      'aac',
      '-ar',
      '48000',
      '-ac',
      '2',
      '-t',
      seconds(durationMs),
      '-avoid_negative_ts',
      'make_zero',
      '-y',
      outputPath
    ],
    { totalMs: durationMs }
  )
}

/**
 * 解析片段实际可取的长度与音轨情况：
 * - 图片没有时长裁剪与音轨；
 * - 视频/音频把 inMs + durationMs 夹到源尾（用户拖长了就该截断，不报错）；
 * - sourceDurationMs 缺省时用 ffprobe 读一次，避免片段实际短于声明时长导致时间线整体错位。
 */
async function resolveClip(clip: TimelineComposeClip): Promise<ResolvedClip> {
  if (clip.kind === 'image') {
    return {
      inMs: 0,
      durationMs: Math.max(1, Math.round(clip.durationMs)),
      hasAudio: false
    }
  }
  const inMs = Math.max(0, Math.round(clip.inMs ?? 0))
  const requestedMs = Math.max(1, Math.round(clip.durationMs))
  const declaredMs =
    typeof clip.sourceDurationMs === 'number' &&
    Number.isFinite(clip.sourceDurationMs) &&
    clip.sourceDurationMs > 0
      ? Math.round(clip.sourceDurationMs)
      : await probeDurationMs(clip.sourcePath)
  const availableMs = declaredMs && declaredMs > 0 ? declaredMs - inMs : requestedMs
  const durationMs = Math.max(0, Math.min(requestedMs, availableMs))
  const hasAudio = await probeHasAudio(clip.sourcePath)
  return { inMs, durationMs, hasAudio }
}

function buildVideoFilter(options: RenderOptions): string {
  const { width, height, frameRate } = options
  return (
    `scale=${width}:${height}:force_original_aspect_ratio=decrease,` +
    `pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=${frameRate},format=yuv420p`
  )
}

// ── FFprobe ──

async function probeHasAudio(filePath: string): Promise<boolean> {
  const stdout = await runProcess(
    resolveFfprobeBinary(),
    [
      '-v',
      'error',
      '-select_streams',
      'a:0',
      '-show_entries',
      'stream=index',
      '-of',
      'csv=p=0',
      filePath
    ],
    FFPROBE_MISSING_HINT
  )
  return stdout.trim().length > 0
}

/** 只读时长（毫秒）。探测失败返回 null：截断兜底可以不做，但不能因此中断合成。 */
async function probeDurationMs(filePath: string): Promise<number | null> {
  try {
    const stdout = await runProcess(
      resolveFfprobeBinary(),
      ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', filePath],
      FFPROBE_MISSING_HINT
    )
    const ms = Math.round(Number(stdout.trim()) * 1000)
    return Number.isFinite(ms) && ms > 0 ? ms : null
  } catch {
    return null
  }
}

// ── 工具函数 ──

function normalizeClipList(list: TimelineComposeClip[] | undefined): TimelineComposeClip[] {
  return [...(list ?? [])]
    .filter(
      (clip) =>
        Boolean(clip) &&
        typeof clip.sourcePath === 'string' &&
        clip.sourcePath.trim().length > 0 &&
        Number.isFinite(clip.startMs)
    )
    .map((clip) => ({ ...clip }))
    .sort((a, b) => a.startMs - b.startMs)
}

function normalizeDimension(value: number): number {
  if (!Number.isFinite(value)) return 0
  const rounded = Math.round(value)
  if (rounded < 2) return 0
  // H.264 yuv420p 要求偶数边长；超长边夹到 8K，避免误传巨大尺寸把内存打穿。
  const bounded = Math.min(7680, rounded)
  return bounded % 2 === 0 ? bounded : bounded - 1
}

function normalizeFrameRate(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 30
  return Math.min(120, Math.max(1, Math.round(value * 1000) / 1000))
}

function normalizeVolume(value: number | undefined): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 1
  return Math.min(1, Math.max(0, value))
}

function seconds(timeMs: number): string {
  return (Math.max(0, timeMs) / 1000).toFixed(3)
}

function padded(index: number): string {
  return String(index).padStart(3, '0')
}

/** concat demuxer 的列表项：统一正斜杠，并转义路径里的单引号。 */
function concatEntry(path: string): string {
  return `file '${path.replace(/\\/g, '/').replace(/'/g, "'\\''")}'`
}

function isMissingToolMessage(message: string): boolean {
  return (
    message === FFMPEG_MISSING_HINT ||
    message === FFPROBE_MISSING_HINT ||
    /未找到本机 (FFmpeg|FFprobe)/.test(message) ||
    /\bENOENT\b/.test(message)
  )
}

function emitProgress(input: TimelineComposeInput, progress: ComposeProgress): void {
  try {
    input.onProgress?.(progress)
  } catch {
    // 进度订阅方异常不能改变合成结果（与「日志失败不改变业务结果」同一原则）。
  }
}
