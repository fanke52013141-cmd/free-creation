// 本地 ComfyUI IndexTTS-2.5 语音复刻：
// 上传参考音频 → 组装 IndexTTS 工作流 → 排队执行 → 轮询结果 → 下载产物落盘入库。
// 节点端口的输入（参考音频 / 文本）在渲染层执行器已解析为 mediaId 与合并文本。
import { randomUUID } from 'crypto'
import { readFile } from 'fs/promises'
import { extname } from 'path'
import type { TtsGenerateInput, VoiceCloneResult } from '../../shared/contracts'
import {
  MINIMAX_CLONE_MAX_BYTES,
  MINIMAX_CLONE_MAX_SECONDS,
  MINIMAX_CLONE_MIMES,
  MINIMAX_CLONE_MIN_SECONDS,
  isValidMiniMaxVoiceId
} from '../../shared/tts'
import { getDb } from '../store/db'
import { getMediaAbsPath, saveBufferAsset } from '../store/media.repo'
import { getProvider } from '../gateway/providers.repo'
import { generateAudioToAsset } from '../gateway/audio'
import { cloneMiniMaxVoice } from '../gateway/voice'
import { probeMediaDurationMs } from './video-transform'
import { GatewayError } from '../gateway/factory'
import {
  ComfyuiError,
  comfyuiFetchHistory,
  comfyuiFetchView,
  comfyuiHasNodeClass,
  comfyuiQueuePrompt,
  comfyuiSystemStats,
  comfyuiUploadFile,
  type ComfyuiOutputFile
} from '../comfyui/client'
import { getComfyuiBaseUrl } from '../comfyui/settings'

// BSAI_ComfyUI_IndexTTS-2.5 的节点类名（保持与 custom_nodes 安装包一致）
const NODE_LOAD_AUDIO = 'BSAI_IndexTTS2.5LoadAudio'
const NODE_LOADER = 'BSAI_IndexTTS2.5Loader'
const NODE_SYNTHESIS = 'BSAI_IndexTTS2.5Synthesis'
const NODE_SAVE_AUDIO = 'BSAI_IndexTTS2.5SaveAudio'

const POLL_INTERVAL_MS = 1500
const POLL_TIMEOUT_MS = 15 * 60 * 1000

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * 组装 IndexTTS-2.5 工作流（ComfyUI API JSON 格式）。
 * 节点类与输入参数名来自 BSAI_IndexTTS.py 的 NODE_CLASS_MAPPINGS / INPUT_TYPES，
 * 参数名带中文后缀是该自定义节点的既定契约，不可改写。
 */
export function buildTtsWorkflow(
  uploadedAudioName: string,
  text: string,
  config: TtsGenerateInput['config']
): Record<string, unknown> {
  return {
    load_audio: {
      class_type: NODE_LOAD_AUDIO,
      inputs: { audio_音频: uploadedAudioName }
    },
    load_model: {
      class_type: NODE_LOADER,
      inputs: {
        use_bf16_使用BF16: true,
        device_设备: 'auto'
      }
    },
    synthesis: {
      class_type: NODE_SYNTHESIS,
      inputs: {
        tts_model_TTS模型: ['load_model', 0],
        text_文本: text,
        reference_audio_参考音频: ['load_audio', 0],
        lang_语言: config.lang,
        duration_factor_语速因子: config.speed,
        emo_alpha_情绪强度: config.emotion
      }
    },
    save_audio: {
      class_type: NODE_SAVE_AUDIO,
      inputs: {
        audio_音频: ['synthesis', 0],
        filename_prefix_文件名前缀: 'canvas_tts',
        format_格式: config.format
      }
    }
  }
}

/** 从任务历史中提取 SaveAudio 节点产出的音频文件描述。 */
export function extractOutputAudio(entry: {
  outputs: Record<string, Record<string, unknown>>
}): ComfyuiOutputFile | null {
  for (const output of Object.values(entry.outputs)) {
    const audio = output.audio
    if (Array.isArray(audio) && audio.length > 0) {
      const first = audio[0] as Partial<ComfyuiOutputFile>
      if (typeof first.filename === 'string') {
        return {
          filename: first.filename,
          subfolder: typeof first.subfolder === 'string' ? first.subfolder : '',
          type: typeof first.type === 'string' ? first.type : 'output'
        }
      }
    }
  }
  return null
}

/** 从任务状态消息中提取执行错误描述（execution_error 事件）。 */
export function extractExecutionError(entry: { status: { messages?: unknown[] } }): string | null {
  const messages = entry.status.messages
  if (!Array.isArray(messages)) return null
  for (const message of messages) {
    if (!Array.isArray(message) || message[0] !== 'execution_error') continue
    const detail = message[1] as Record<string, unknown> | undefined
    if (!detail) continue
    const parts = [detail.exception_message, detail.node_type].filter(
      (item): item is string => typeof item === 'string' && Boolean(item)
    )
    return parts.join('（节点：') + (parts.length > 1 ? '）' : '')
  }
  return null
}

async function pollUntilDone(
  baseUrl: string,
  promptId: string
): Promise<{ outputs: Record<string, Record<string, unknown>>; status: { messages?: unknown[] } }> {
  const deadline = Date.now() + POLL_TIMEOUT_MS
  while (Date.now() < deadline) {
    const entry = await comfyuiFetchHistory(baseUrl, promptId)
    if (entry) {
      if (entry.status.status_str === 'error') {
        const reason = extractExecutionError(entry)
        throw new ComfyuiError('EXECUTION_ERROR', reason || 'ComfyUI 工作流执行失败')
      }
      if (entry.status.completed) {
        return { outputs: entry.outputs, status: entry.status }
      }
    }
    await sleep(POLL_INTERVAL_MS)
  }
  throw new ComfyuiError('TIMEOUT', `语音合成超时（${POLL_TIMEOUT_MS / 60000} 分钟）`)
}

export async function transformTts(input: TtsGenerateInput): Promise<VoiceCloneResult> {
  if (!input.text?.trim()) throw new ComfyuiError('INVALID_INPUT', '朗读文本不能为空')
  const config = input.config
  if (config.backend === 'minimax') return transformMiniMaxTts(input)

  const baseUrl = getComfyuiBaseUrl()
  const stats = await comfyuiSystemStats(baseUrl)
  if (!stats.online) throw new ComfyuiError('OFFLINE', 'ComfyUI 未启动')

  const ttsNodeReady = await comfyuiHasNodeClass(baseUrl, NODE_SYNTHESIS)
  if (!ttsNodeReady) {
    throw new ComfyuiError(
      'NODE_MISSING',
      'ComfyUI 未安装 BSAI_IndexTTS2.5 自定义节点，请先在 custom_nodes 中安装 IndexTTS-2.5'
    )
  }

  const reference = await readReferenceAudio(input.referenceAudioId)
  const uploadName = `canvas_tts_ref_${randomUUID().slice(0, 8)}${extname(reference.path) || '.wav'}`
  const uploaded = await comfyuiUploadFile(baseUrl, uploadName, reference.buf, reference.mime)

  const workflow = buildTtsWorkflow(uploaded.name || uploadName, input.text.trim(), config)
  const promptId = await comfyuiQueuePrompt(baseUrl, workflow)
  const finished = await pollUntilDone(baseUrl, promptId)

  const outputFile = extractOutputAudio(finished)
  if (!outputFile) throw new ComfyuiError('EMPTY_RESULT', '工作流完成但没有产出音频')

  const audioBuf = await comfyuiFetchView(baseUrl, outputFile)
  const asset = await saveBufferAsset(
    input.projectId,
    audioBuf,
    `.${config.format}`,
    input.text.trim().slice(0, 24)
  )
  // 本地 IndexTTS 是「就地克隆」，没有可复用的服务端音色标识——返回空串而不是
  // 编造一个 voice_id 让下游误以为可以引用。
  return { asset, voiceId: '' }
}

/**
 * MiniMax 快速复刻的正式链路：上传本地参考音频 → 登记 voice_id → 用该音色调用
 * T2A。clone 接口只负责登记音色（和可选试听），真正的运行产物必须由 T2A 落入
 * 本地资产库，才能和其他音频节点保持同一种输出语义。
 */
async function transformMiniMaxTts(input: TtsGenerateInput): Promise<VoiceCloneResult> {
  const config = input.config
  if (!config.providerId) throw new GatewayError('INVALID_INPUT', '请选择 MiniMax 供应商')
  const provider = getProvider(config.providerId)
  if (!provider) throw new GatewayError('PROVIDER_NOT_FOUND', 'MiniMax 供应商不存在')
  if (provider.specId !== 'minimax') {
    throw new GatewayError('INVALID_INPUT', '语音克隆只能选择 MiniMax 供应商')
  }

  const reference = await readReferenceAudio(input.referenceAudioId)
  if (!MINIMAX_CLONE_MIMES.includes((reference.mime || '').toLowerCase())) {
    throw new GatewayError('INVALID_INPUT', 'MiniMax 复刻参考音频仅支持 mp3、m4a 或 wav')
  }
  if (reference.buf.length > MINIMAX_CLONE_MAX_BYTES) {
    throw new GatewayError('INVALID_INPUT', 'MiniMax 复刻参考音频不能超过 20MB')
  }
  // 参考音频必须 10 秒～5 分钟：不先量时长，用户只会收到一句英文的
  // "voice duration too short"。本机没有 FFprobe 时跳过这道检查，交给上游判断。
  const durationMs = await probeMediaDurationMs(reference.abs).catch(() => 0)
  if (durationMs > 0) {
    const seconds = durationMs / 1000
    if (seconds < MINIMAX_CLONE_MIN_SECONDS || seconds > MINIMAX_CLONE_MAX_SECONDS) {
      throw new GatewayError(
        'INVALID_INPUT',
        `参考音频需 ${MINIMAX_CLONE_MIN_SECONDS} 秒～${MINIMAX_CLONE_MAX_SECONDS / 60} 分钟，当前约 ${seconds.toFixed(1)} 秒`
      )
    }
  }
  if (config.voiceId.trim() && !isValidMiniMaxVoiceId(config.voiceId.trim())) {
    throw new GatewayError(
      'INVALID_INPUT',
      '自定义 Voice ID 需 8～256 位、以字母开头、只含字母数字与 - _、且末位不能是 - 或 _'
    )
  }

  const promptAudio = config.promptMediaId
    ? await readReferenceAudio(config.promptMediaId, '克隆提示音')
    : null

  const voiceId = await cloneMiniMaxVoice({
    providerId: provider.id,
    reference: {
      buf: reference.buf,
      mime: reference.mime,
      fileName: `canvas_clone_${randomUUID().slice(0, 12)}${extname(reference.path) || '.wav'}`
    },
    prompt: promptAudio
      ? {
          buf: promptAudio.buf,
          mime: promptAudio.mime,
          fileName: `canvas_prompt_${randomUUID().slice(0, 12)}${extname(promptAudio.path) || '.wav'}`,
          text: config.promptText
        }
      : null,
    config
  })

  const asset = await generateAudioToAsset({
    projectId: input.projectId,
    providerId: provider.id,
    modelId: config.modelId || 'speech-2.8-turbo',
    text: input.text.trim(),
    voice: voiceId,
    format: config.format,
    aigcWatermark: config.aigcWatermark
  })
  return { asset, voiceId }
}

interface ReferenceAudioPayload {
  buf: Buffer
  mime: string
  path: string
  abs: string
}

/** 读取本地图库中的参考音频；mediaId 无效或文件丢失时抛出明确错误。 */
async function readReferenceAudio(
  mediaId: string,
  label = '参考音频'
): Promise<ReferenceAudioPayload> {
  if (!mediaId) throw new ComfyuiError('INVALID_INPUT', `缺少${label}`)
  const row = getDb().prepare('SELECT mime, path FROM media WHERE id = ?').get(mediaId) as
    { mime: string; path: string } | undefined
  if (!row) throw new ComfyuiError('MEDIA_NOT_FOUND', `${label}不存在或已删除`)
  const abs = getMediaAbsPath(row.path)
  if (!abs) throw new ComfyuiError('MEDIA_NOT_FOUND', `${label}路径不合法`)
  let buf: Buffer
  try {
    buf = await readFile(abs)
  } catch {
    throw new ComfyuiError('MEDIA_NOT_FOUND', `${label}文件读取失败`)
  }
  return { buf, mime: row.mime || 'audio/wav', path: row.path, abs }
}
