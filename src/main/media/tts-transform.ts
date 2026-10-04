// MiniMax 云端音色克隆：上传参考音频并登记可复用音色 ID。
import { randomUUID } from 'crypto'
import { readFile } from 'fs/promises'
import { extname } from 'path'
import type { TtsGenerateInput, VoiceCloneResult } from '../../shared/contracts'
import {
  MINIMAX_CLONE_MAX_BYTES,
  MINIMAX_CLONE_MAX_SECONDS,
  MINIMAX_CLONE_MIMES,
  MINIMAX_CLONE_PROMPT_MAX_SECONDS,
  MINIMAX_CLONE_MIN_SECONDS,
  MINIMAX_VOICE_CLONE_MODELS,
  isValidMiniMaxVoiceId
} from '../../shared/tts'
import { emitGatewayEvent } from '../diagnostics/gateway-events'
import { getDb } from '../store/db'
import { getMediaAbsPath } from '../store/media.repo'
import { getProvider } from '../gateway/providers.repo'
import { cloneMiniMaxVoice } from '../gateway/voice'
import { probeMediaDurationMs } from './video-transform'
import { GatewayError } from '../gateway/factory'
export async function transformTts(input: TtsGenerateInput): Promise<VoiceCloneResult> {
  return transformMiniMaxTts(input)
}

/**
 * MiniMax 快速复刻：上传参考音频并登记 voice_id。正式合成由语音合成节点完成。
 */
async function transformMiniMaxTts(input: TtsGenerateInput): Promise<VoiceCloneResult> {
  const config = input.config
  let phase = 'configuration'
  const privateValues = [
    config.promptText,
    config.voiceId,
    input.referenceAudioId,
    config.promptMediaId
  ]
  // L04：语音克隆阶段事件走统一底座（含最后一道脱敏与字段白名单）；
  // 旧 TTS 输入契约只有 runId/nodeId，trace 关联缺失会被显式标记而非补造。
  const report = (level: 'info' | 'error', message: string, fields: Record<string, unknown> = {}): void => {
    emitGatewayEvent('node.stage', message, {
      runId: input.runId,
      nodeId: input.nodeId,
      correlationMissing: true
    }, {
      level,
      phase,
      privateValues,
      attributes: { operation: 'voice.clone', ...fields }
    })
  }
  report('info', '开始 MiniMax 语音克隆', {
    providerId: config.providerId,
    modelId: config.modelId,
    hasPromptAudio: Boolean(config.promptMediaId)
  })
  try {
  if (!config.providerId) throw new GatewayError('INVALID_INPUT', '请选择 MiniMax 供应商')
  if (!MINIMAX_VOICE_CLONE_MODELS.includes(config.modelId)) {
    throw new GatewayError('INVALID_INPUT', `MiniMax 音色克隆不支持模型 ${config.modelId}`)
  }
  const provider = getProvider(config.providerId)
  if (!provider) throw new GatewayError('PROVIDER_NOT_FOUND', 'MiniMax 供应商不存在')
  if (provider.specId !== 'minimax') {
    throw new GatewayError('INVALID_INPUT', '语音克隆只能选择 MiniMax 供应商')
  }

  phase = 'reference-audio'
  report('info', '开始读取参考音频')
  const reference = await readReferenceAudio(input.referenceAudioId)
  report('info', '参考音频已读取', {
    mime: reference.mime,
    bytes: reference.buf.length,
    extension: extname(reference.path).toLowerCase() || 'unknown'
  })
  if (!MINIMAX_CLONE_MIMES.includes((reference.mime || '').toLowerCase())) {
    throw new GatewayError('INVALID_INPUT', 'MiniMax 复刻参考音频仅支持 mp3、m4a 或 wav')
  }
  if (reference.buf.length > MINIMAX_CLONE_MAX_BYTES) {
    throw new GatewayError('INVALID_INPUT', 'MiniMax 复刻参考音频不能超过 20MB')
  }
  // 参考音频必须 10 秒～5 分钟：不先量时长，用户只会收到一句英文的
  // "voice duration too short"。本机没有 FFprobe 时跳过这道检查，交给上游判断。
  const durationMs = await probeMediaDurationMs(reference.abs).catch(() => 0)
  report(
    'info',
    durationMs > 0
      ? '参考音频时长已检测'
      : '本机无法检测参考音频时长，将由服务端继续校验',
    { durationMs: durationMs || undefined }
  )
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
  if (promptAudio) {
    if (!MINIMAX_CLONE_MIMES.includes(promptAudio.mime.toLowerCase())) {
      throw new GatewayError('INVALID_INPUT', 'MiniMax 克隆提示音仅支持 mp3、m4a 或 wav 格式')
    }
    if (promptAudio.buf.length > MINIMAX_CLONE_MAX_BYTES) {
      throw new GatewayError('INVALID_INPUT', 'MiniMax 克隆提示音不能超过 20MB')
    }
    const promptDurationMs = await probeMediaDurationMs(promptAudio.abs).catch(() => 0)
    if (promptDurationMs >= MINIMAX_CLONE_PROMPT_MAX_SECONDS * 1000) {
      throw new GatewayError(
        'INVALID_INPUT',
        `MiniMax 克隆提示音必须小于 ${MINIMAX_CLONE_PROMPT_MAX_SECONDS} 秒`
      )
    }
  }

  phase = 'voice-registration'
  report('info', '开始向 MiniMax 登记参考音色')
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
  report('info', '参考音色登记成功')

  return { voiceId }
  } catch (error) {
    report('error', error instanceof Error ? error.message : String(error))
    throw error
  }
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
  if (!mediaId) throw new GatewayError('INVALID_INPUT', `缺少${label}`)
  const row = getDb().prepare('SELECT mime, path FROM media WHERE id = ?').get(mediaId) as
    { mime: string; path: string } | undefined
  if (!row) throw new GatewayError('MEDIA_NOT_FOUND', `${label}不存在或已删除`)
  const abs = getMediaAbsPath(row.path)
  if (!abs) throw new GatewayError('MEDIA_NOT_FOUND', `${label}路径不合法`)
  let buf: Buffer
  try {
    buf = await readFile(abs)
  } catch {
    throw new GatewayError('MEDIA_NOT_FOUND', `${label}文件读取失败`)
  }
  return { buf, mime: row.mime || 'audio/wav', path: row.path, abs }
}
