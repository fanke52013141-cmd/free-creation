// 音频去气口（静音/呼吸剪辑）本地变换。
//
// 双引擎共用「气口区间 → 保留区间 → select 拼接」管线：
// - silence：FFmpeg silencedetect 滤镜（info 级 stderr 逐行解析，见 ffmpeg-runner onStderr）；
// - vad：解码 16kHz 单声道 PCM 后由 Silero VAD 逐帧判定，非语音段（含呼吸声）为气口。
//
// 区间裁剪语义（margin/minGap/keepGap）在 @shared/silence-trim 纯函数中定义，
// 主进程只负责音频解码、区间检测与 ffmpeg 输出；产物始终是独立新资产。
import { mkdtemp, readFile, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import type { MediaAsset } from '../../shared/types'
import type { SilenceTrimTransformInput } from '../../shared/contracts'
import {
  gapCutsFromGaps,
  keepIntervalsFromCuts,
  parseSilenceTrimConfig,
  parseSilencedetectEvents,
  selectExpressionForKeeps,
  speechIntervalsFromProbabilities,
  gapsFromSpeechIntervals,
  type MsInterval,
  type SilenceTrimConfig
} from '../../shared/silence-trim'
import { FFMPEG_MISSING_HINT, resolveFfmpegBinary, runFfmpeg, runProcess } from './ffmpeg-runner'
import { probeMediaDurationMs, resolveAudioSource, runToAsset } from './video-transform'
import { SILERO_VAD_FRAME_MS, detectSpeechProbabilities } from './vad-silero'

export interface SilenceTrimOutcome {
  asset: MediaAsset
  engine: SilenceTrimConfig['engine']
  /** 检测到的气口数量。 */
  gapCount: number
  /** 剪掉的总时长（毫秒）。 */
  removedMs: number
}

export async function transformSilenceTrim(input: SilenceTrimTransformInput): Promise<SilenceTrimOutcome> {
  const config = parseSilenceTrimConfig(JSON.stringify(input.config))
  const source = await resolveAudioSource(input.projectId, input.sourceMediaId)
  const dir = await mkdtemp(join(tmpdir(), 'canvas-studio-silence-trim-'))
  try {
    const { gaps, totalMs } =
      config.engine === 'vad'
        ? await detectGapsWithVad(source.path, dir, config)
        : await detectGapsWithSilencedetect(source.path, config)
    const cuts = gapCutsFromGaps(gaps, totalMs, config)
    const keeps = keepIntervalsFromCuts(cuts, totalMs)
    const asset = await trimToAsset(input.projectId, source.path, dir, keeps)
    const keptMs = keeps.reduce((sum, keep) => sum + (keep.endMs - keep.startMs), 0)
    return { asset, engine: config.engine, gapCount: gaps.length, removedMs: Math.max(0, totalMs - keptMs) }
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined)
  }
}

/** silence 引擎：silencedetect 检测低于阈值的静音段；结果在 info 级 stderr。 */
async function detectGapsWithSilencedetect(
  sourcePath: string,
  config: SilenceTrimConfig
): Promise<{ gaps: MsInterval[]; totalMs: number }> {
  const durationMs = await probeMediaDurationMs(sourcePath)
  // 检测日志按气口数量增长（每气口两行），不会随音频时长线性膨胀。
  let detectionLog = ''
  let pending = ''
  await runProcess(
    resolveFfmpegBinary(),
    [
      '-hide_banner', '-nostats', '-loglevel', 'info',
      '-i', sourcePath, '-vn',
      '-af', `silencedetect=noise=${config.thresholdDb}dB:d=${(config.minGapMs / 1000).toFixed(3)}`,
      '-f', 'null', '-'
    ],
    FFMPEG_MISSING_HINT,
    {
      captureStdout: false,
      onStderr: (chunk) => {
        pending += chunk
        const lines = pending.split(/\r?\n/)
        pending = lines.pop() ?? ''
        detectionLog += `${lines.join('\n')}\n`
      }
    }
  )
  detectionLog += pending
  return { gaps: parseSilencedetectEvents(detectionLog, durationMs), totalMs: durationMs }
}

/** vad 引擎：解码 16kHz 单声道 PCM → Silero VAD 逐帧语音概率 → 非语音段为气口。 */
async function detectGapsWithVad(
  sourcePath: string,
  dir: string,
  config: SilenceTrimConfig
): Promise<{ gaps: MsInterval[]; totalMs: number }> {
  const pcmPath = join(dir, 'source-16k.pcm')
  await runFfmpeg([
    '-i', sourcePath, '-vn', '-ac', '1', '-ar', '16000',
    '-f', 's16le', '-c:a', 'pcm_s16le', '-y', pcmPath
  ])
  const pcm = await readFile(pcmPath)
  const samples = new Float32Array(Math.floor(pcm.byteLength / 2))
  const view = new Int16Array(pcm.buffer, pcm.byteOffset, samples.length)
  for (let i = 0; i < samples.length; i++) samples[i] = view[i] / 32768
  const totalMs = Math.round((samples.length / 16000) * 1000)
  // 会话在 finally 中释放；取消由分块循环轮询媒体作用域标记。
  const probabilities = await detectSpeechProbabilities(samples)
  const speech = speechIntervalsFromProbabilities(probabilities, SILERO_VAD_FRAME_MS, config.vadThreshold)
  return { gaps: gapsFromSpeechIntervals(speech, totalMs), totalMs }
}

/** 按保留区间拼接输出；aselect 表达式写 filter_complex_script 文件，规避 Windows 命令行长度上限。
 * 音频域必须用 aselect（select 在 filter_complex 里默认协商成视频域），asetpts 按采样率重排时间戳。 */
async function trimToAsset(
  projectId: string,
  sourcePath: string,
  dir: string,
  keeps: MsInterval[]
): Promise<MediaAsset> {
  const scriptPath = join(dir, 'trim-select.txt')
  const script = `[0:a]aselect='${selectExpressionForKeeps(keeps)}',asetpts=N/SR/TB[aout]\n`
  await writeFile(scriptPath, script, 'utf8')
  return runToAsset(projectId, 'trimmed.m4a', '.m4a', '去气口音频', [
    '-i', sourcePath, '-vn',
    '-filter_complex_script', scriptPath,
    '-map', '[aout]',
    '-c:a', 'aac', '-b:a', '192k'
  ])
}
