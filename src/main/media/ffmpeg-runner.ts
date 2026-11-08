// 主进程 FFmpeg/FFprobe 公共执行件。
//
// 抽取原因（2026-11-02 时间线节点 M3/M4）：媒体元数据探测与时间线合成都要 spawn 本机
// FFmpeg，而 video-transform.ts 里的 runProcess/runFfmpeg 是模块私有实现。再抄一份会形成
// 第二套取消链，停止工作流时会漏杀子进程。本模块只承载「二进制解析 + spawn + 取消登记 +
// 进度解析」，业务参数仍由调用方拼装。
//
// 约定：
// - FFmpeg 解析顺序：环境变量 → 发行包内副本（resources/bin）→ 系统 PATH。
//   2026-11-08 起发行安装包随带 FFmpeg（gyan.dev essentials 构建），客户开箱即用。
// - 子进程终止句柄必须登记进媒体作用域（trackMediaJob），停止工作流时由主进程统一 kill。
// - 失败一律以 Error 抛出，missingHint 用于把 ENOENT 翻译成用户可操作的提示；
//   是否显示为阻塞态由调用方决定，本模块不做产品判断。
import { spawn } from 'child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { app } from 'electron'
import { isMediaCancelled, trackMediaJob } from './cancellation'

/** 发行包内的 FFmpeg 副本（extraResources → resources/bin）；未打包或缺失时返回 null。 */
function bundledFfmpegPath(name: string): string | null {
  try {
    if (!app.isPackaged) return null
    const candidate = join(process.resourcesPath, 'bin', name)
    return existsSync(candidate) ? candidate : null
  } catch {
    return null
  }
}

export const FFMPEG_MISSING_HINT =
  '未找到本机 FFmpeg。请安装 FFmpeg 并加入 PATH，或设置 CANVAS_STUDIO_FFMPEG_PATH。'
export const FFPROBE_MISSING_HINT =
  '未找到本机 FFprobe。请安装 FFmpeg 并加入 PATH，或设置 CANVAS_STUDIO_FFMPEG_PATH。'

/** 配置路径优先级：CANVAS_STUDIO_FFMPEG_PATH > 包内副本 > 系统 PATH 中的 ffmpeg。 */
export function resolveFfmpegBinary(): string {
  const configured = process.env.CANVAS_STUDIO_FFMPEG_PATH?.trim()
  if (configured) return configured
  return bundledFfmpegPath('ffmpeg.exe') ?? 'ffmpeg'
}

/** FFprobe 与 FFmpeg 同目录；配置了 ffmpeg 路径时按文件名替换推导。 */
export function resolveFfprobeBinary(): string {
  const configured = process.env.CANVAS_STUDIO_FFMPEG_PATH?.trim()
  if (configured) return configured.replace(/ffmpeg(\.exe)?$/i, 'ffprobe$1')
  return bundledFfmpegPath('ffprobe.exe') ?? 'ffprobe'
}

export interface RunProcessOptions {
  /** 需要实时读取 stdout（FFmpeg 的 -progress pipe:1 走这里）。 */
  onStdout?: (chunk: string) => void
  /**
   * stdout 是否累积后作为返回值。
   * 默认：没有 onStdout 时累积（调用方通常就是要返回值，如 ffprobe 探测）；
   * 提供 onStdout 时默认不累积（进度流会很大，不保留）。
   * 2026-11-03 修正：原先默认 false，导致 ffprobe 探测拿到空串——时间线合成因此
   * 把所有素材判成「无音轨」，成片整条静音。
   */
  captureStdout?: boolean
  timeoutMs?: number
}

/**
 * 执行一个子进程并返回 stdout。子进程在媒体作用域内会被登记为可终止作业。
 * 取消与失败使用同一失败通道：取消时子进程被 kill，随后以非零退出码失败。
 */
export function runProcess(
  binary: string,
  args: string[],
  missingHint: string,
  options: RunProcessOptions = {}
): Promise<string> {
  const captureStdout = options.captureStdout ?? !options.onStdout
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, { windowsHide: true })
    const untrack = trackMediaJob(() => {
      try {
        child.kill()
      } catch {
        // 终止失败不覆盖真实失败原因；进程退出后按普通失败收尾。
      }
    })
    let stdout = ''
    let stderr = ''
    let settled = false
    const finish = (fn: () => void): void => {
      if (settled) return
      settled = true
      untrack()
      fn()
    }
    child.stdout.on('data', (chunk: Buffer) => {
      const text = chunk.toString()
      if (captureStdout) stdout += text
      options.onStdout?.(text)
    })
    child.stderr.on('data', (chunk: Buffer) => {
      // 只保留尾部，避免长任务把内存吃穿；完整日志不属于产品能力。
      stderr = `${stderr}${chunk.toString()}`.slice(-4000)
    })
    child.once('error', (error) => {
      const code = (error as NodeJS.ErrnoException).code
      finish(() => reject(new Error(code === 'ENOENT' ? missingHint : error.message)))
    })
    child.once('close', (code) => {
      finish(() => {
        if (code === 0) resolve(stdout)
        else reject(new Error(stderr.trim() || `${binary} 退出码 ${code ?? '未知'}`))
      })
    })
    if (options.timeoutMs && options.timeoutMs > 0) {
      const timer = setTimeout(() => {
        try {
          child.kill()
        } catch {
          // 同上：超时也要走统一失败通道。
        }
      }, options.timeoutMs)
      timer.unref?.()
      child.once('close', () => clearTimeout(timer))
    }
  })
}

export interface FfmpegProgress {
  /** 已处理到的毫秒数（解析 -progress 的 out_time / out_time_us）。 */
  outputMs: number
  /** 本次调用名义总时长（毫秒），由调用方给出；缺省为 null。 */
  totalMs: number | null
  /** 0..1；无总时长时为 null。 */
  ratio: number | null
}

export interface RunFfmpegOptions {
  /** 名义总时长，用于把 out_time 换算成比例。 */
  totalMs?: number
  onProgress?: (progress: FfmpegProgress) => void
}

/** 解析 `-progress pipe:1` 的键值行。out_time_ms 历史版本单位是微秒，因此优先 out_time_us。 */
export function parseFfmpegProgressLine(
  line: string,
  totalMs: number | null
): FfmpegProgress | null {
  const trimmed = line.trim()
  const [, key, value] = /^(out_time_us|out_time_ms|out_time)=(.*)$/.exec(trimmed) ?? []
  if (!key || value === undefined) return null
  let outputMs: number
  if (key === 'out_time') {
    const match = /^(\d+):(\d{2}):(\d{2}(?:\.\d+)?)$/.exec(value.trim())
    if (!match) return null
    outputMs =
      (Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3])) * 1000
  } else {
    const us = Number(value.trim())
    if (!Number.isFinite(us) || us < 0) return null
    outputMs = us / 1000
  }
  if (!Number.isFinite(outputMs)) return null
  const ratio = totalMs && totalMs > 0 ? Math.min(1, Math.max(0, outputMs / totalMs)) : null
  return { outputMs: Math.round(outputMs), totalMs, ratio }
}

/**
 * 执行 FFmpeg，自动附加 `-progress pipe:1 -nostats` 并解析进度。
 * 取消时子进程被终止，调用方以普通失败收尾（与既有媒体变换一致）。
 */
export async function runFfmpeg(args: string[], options: RunFfmpegOptions = {}): Promise<void> {
  const totalMs = options.totalMs && options.totalMs > 0 ? options.totalMs : null
  let pending = ''
  await runProcess(
    resolveFfmpegBinary(),
    ['-hide_banner', '-loglevel', 'error', '-progress', 'pipe:1', '-nostats', ...args],
    FFMPEG_MISSING_HINT,
    {
      captureStdout: false,
      onStdout: (chunk) => {
        if (!options.onProgress) return
        pending += chunk
        const lines = pending.split(/\r?\n/)
        pending = lines.pop() ?? ''
        for (const line of lines) {
          const parsed = parseFfmpegProgressLine(line, totalMs)
          if (parsed) options.onProgress(parsed)
        }
      }
    }
  )
  if (isMediaCancelled()) {
    throw new Error('媒体处理已被停止')
  }
}
