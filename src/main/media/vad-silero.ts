// 主进程 Silero VAD 推理（去气口节点的 vad 引擎）。
//
// 模型分发：silero_vad.onnx（Silero VAD v5，MIT 协议，约 2.1MB）随仓库入库于
// resources/models/，经 electron-builder 的 files 白名单（resources/**）随包分发，
// 开发态与发行包都从 app 根解析——与 resources/skills、resources/video-conversion
// 同一运行时读取模式；体积原因不入库的 FFmpeg 二进制走的是另一条 extraResources 路径。
//
// 模型接口（v5 无状态 ONNX，经 onnxruntime-node 1.31 实测）：
// - input  float32 [1, 576]   = 64 采样上下文 + 512 采样块（16kHz 单声道）
// - state  float32 [2, 1, 128]（随输出 stateN 滚动）
// - sr     int64 标量（16000）
// → output float32 [1, 1]（语音概率）、stateN。
//
// 取消：分块推理循环每块轮询 isMediaCancelled()，停止时抛「媒体处理已被停止」，
// 与 ffmpeg 作业走同一失败通道（runCancellableTransform 统一转 MEDIA_TRANSFORM_CANCELLED）。
//
// onnxruntime-node 是本仓库第一个进程内原生推理依赖；动态 import 加载，
// 加载/会话创建失败以 Error 抛出，由调用方所在的节点报告为普通失败。
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { app } from 'electron'
import { isMediaCancelled } from './cancellation'
import type { Tensor } from 'onnxruntime-node'

/** 16kHz 单声道下每块采样数；Silero v5 帧长 32ms。 */
export const SILERO_VAD_CHUNK_SAMPLES = 512
/** 16kHz 每块毫秒数。 */
export const SILERO_VAD_FRAME_MS = 32
const CONTEXT_SAMPLES = 64
const SAMPLE_RATE = 16_000
const STATE_ELEMENTS = 2 * 1 * 128

/** 解析 silero_vad.onnx 路径；缺失返回 null（能力探测据此提示）。 */
export function resolveSileroVadModelPath(): string | null {
  const configured = process.env.CANVAS_STUDIO_SILERO_VAD_MODEL?.trim()
  if (configured) return existsSync(configured) ? configured : null
  try {
    // 仓库内 resources/models/ 随 files 白名单分发；开发态与发行包都从 app 根解析。
    const candidate = join(app.getAppPath(), 'resources', 'models', 'silero_vad.onnx')
    if (existsSync(candidate)) return candidate
    // 兼容手工部署的 extraResources 位置（resources/models/）。
    if (app.isPackaged) {
      const bundled = join(process.resourcesPath, 'models', 'silero_vad.onnx')
      if (existsSync(bundled)) return bundled
    }
  } catch {
    // app 未就绪等场景按缺失处理，调用方给出安装提示。
  }
  return null
}

/** 能力探测：ONNX 运行时原生绑定可加载且模型文件存在；不创建会话。 */
export async function sileroVadAvailable(): Promise<{ available: boolean; message: string }> {
  const modelPath = resolveSileroVadModelPath()
  if (!modelPath) {
    return {
      available: false,
      message:
        '未找到 silero_vad.onnx。请设置 CANVAS_STUDIO_SILERO_VAD_MODEL 指向模型文件，或重新安装应用。'
    }
  }
  try {
    await import('onnxruntime-node')
    return { available: true, message: '已就绪' }
  } catch (error) {
    return {
      available: false,
      message: `ONNX 运行时加载失败：${error instanceof Error ? error.message : String(error)}`
    }
  }
}

export interface SileroVadSession {
  /** 输入恰好 512 个 16kHz 单声道采样；返回该帧语音概率（0..1）。 */
  detectChunk(samples: Float32Array): Promise<number>
  /** 重置内部上下文与循环状态；同一会话换音频时必须调用。 */
  reset(): void
  close(): Promise<void>
}

export async function createSileroVadSession(): Promise<SileroVadSession> {
  const modelPath = resolveSileroVadModelPath()
  if (!modelPath) {
    throw new Error(
      '未找到 Silero VAD 模型文件（silero_vad.onnx）。请设置 CANVAS_STUDIO_SILERO_VAD_MODEL，或重新安装应用。'
    )
  }
  const ort = await import('onnxruntime-node').catch((error: unknown) => {
    throw new Error(
      `ONNX 运行时加载失败：${error instanceof Error ? error.message : String(error)}`
    )
  })
  const session = await ort.InferenceSession.create(modelPath)
  const srTensor = new ort.Tensor('int64', BigInt64Array.from([BigInt(SAMPLE_RATE)]), [])
  // session.run 返回的是宽类型 Tensor；state 显式放宽，避免每次赋值 stateN 收窄失败。
  let state: Tensor = new ort.Tensor('float32', new Float32Array(STATE_ELEMENTS), [2, 1, 128])
  let context = new Float32Array(CONTEXT_SAMPLES)

  const sessionLike: SileroVadSession = {
    async detectChunk(samples: Float32Array): Promise<number> {
      if (samples.length !== SILERO_VAD_CHUNK_SAMPLES) {
        throw new Error(
          `VAD 输入块大小错误：期望 ${SILERO_VAD_CHUNK_SAMPLES} 采样，实际 ${samples.length}`
        )
      }
      if (isMediaCancelled()) throw new Error('媒体处理已被停止')
      const input = new Float32Array(CONTEXT_SAMPLES + SILERO_VAD_CHUNK_SAMPLES)
      input.set(context, 0)
      input.set(samples, CONTEXT_SAMPLES)
      const results = await session.run({
        input: new ort.Tensor('float32', input, [1, input.length]),
        state,
        sr: srTensor
      })
      state = results.stateN
      context.set(samples.subarray(SILERO_VAD_CHUNK_SAMPLES - CONTEXT_SAMPLES))
      const probability = results.output.data[0]
      return typeof probability === 'number' && Number.isFinite(probability) ? probability : 0
    },
    reset(): void {
      state = new ort.Tensor('float32', new Float32Array(STATE_ELEMENTS), [2, 1, 128])
      context = new Float32Array(CONTEXT_SAMPLES)
    },
    async close(): Promise<void> {
      await session.release().catch(() => undefined)
    }
  }
  return sessionLike
}

/** 整段 16kHz 单声道 PCM → 逐帧语音概率；取消在块间轮询，停止时抛错。 */
export async function detectSpeechProbabilities(
  samples: Float32Array,
  session?: SileroVadSession
): Promise<number[]> {
  const owned = !session
  const vad = session ?? (await createSileroVadSession())
  try {
    vad.reset()
    const frameCount = Math.floor(samples.length / SILERO_VAD_CHUNK_SAMPLES)
    const probs: number[] = new Array(frameCount)
    for (let frame = 0; frame < frameCount; frame++) {
      const start = frame * SILERO_VAD_CHUNK_SAMPLES
      probs[frame] = await vad.detectChunk(samples.subarray(start, start + SILERO_VAD_CHUNK_SAMPLES))
    }
    return probs
  } finally {
    if (owned) await vad.close()
  }
}
