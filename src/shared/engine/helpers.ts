// 节点执行器共享工具（从 renderer/engine/executors/shared.ts 移入共享层）
//
// 关键变化：waitForChat / waitForVideo 通过参数注入 GatewayClient 和定时器，
// 不再直接访问 window.api 和 window.setInterval。
import type { ChatMessage, ProviderSummary, VideoGenParams } from '../types'
import type { GatewayClient } from './gateway-client'
import { modelsByModality, type ModelOption } from './models'
import type { CancelSignal } from './executor-types'

/** 把可能为 JSON 对象的文本解析为对象；非对象 / 解析失败返回 null。 */
export function parseJsonObj(text: string): Record<string, unknown> | null {
  if (!text) return null
  try {
    const value = JSON.parse(text)
    return typeof value === 'object' && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null
  } catch {
    return null
  }
}

export interface ShotShape {
  id: string
  scene: string
  dialogue: string
  duration: string
  [key: string]: unknown
}

/** 把任意镜头值归一化成带稳定字段的分镜对象；缺字段补空，缺 id 生成短随机 id。 */
export function normalizeShot(value: unknown): ShotShape {
  const shot = typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {}
  return {
    ...shot,
    id: typeof shot.id === 'string' ? shot.id : Math.random().toString(36).slice(2, 9),
    scene: typeof shot.scene === 'string' ? shot.scene : '',
    dialogue: typeof shot.dialogue === 'string' ? shot.dialogue : '',
    duration: typeof shot.duration === 'string' ? shot.duration : ''
  }
}

/** 从模型返回的文本中尽力提取一个分镜数组；支持纯 JSON 数组或含前后文字的片段。 */
export function extractShots(raw: string): ShotShape[] | null {
  const trimmed = raw.trim()
  const candidates = [trimmed]
  const start = trimmed.indexOf('[')
  const end = trimmed.lastIndexOf(']')
  if (start >= 0 && end > start) candidates.push(trimmed.slice(start, end + 1))
  for (const candidate of candidates) {
    try {
      const value = JSON.parse(candidate)
      if (Array.isArray(value)) return value.map(normalizeShot)
    } catch {
      // 尝试下一个候选 JSON 块。
    }
  }
  return null
}

export type VariableValueType = 'string' | 'number' | 'boolean' | 'object' | 'array' | 'any'

/** 节点运行会持久化文本/脚本内容；合并提示词时去掉已存在的前缀，避免重复累积。 */
export function mergedPrompt(nodeValue: string, upstreamValue: string): string {
  if (!upstreamValue.trim()) return nodeValue
  if (!nodeValue.trim()) return upstreamValue
  const prefix = `${upstreamValue}\n\n---\n\n`
  return nodeValue.startsWith(prefix) ? nodeValue : `${prefix}${nodeValue}`
}

/** 从已通过 prompt.bundle@1 输入校验的 JSON 提取模型可用的正向提示词。 */
export function promptBundleText(value: unknown): string {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return ''
  const data = value as Record<string, unknown>
  return [data.prompt, data.style]
    .filter((item): item is string => typeof item === 'string' && Boolean(item.trim()))
    .join('\n')
}

export interface ChatInput {
  providerId: string
  modelId: string
  system?: string
  messages: ChatMessage[]
  temperature?: number
  maxTokens?: number
}

/**
 * 发起一轮流式对话并等待完成；持有取消令牌，取消时主动 chatCancel。
 * 通过参数注入 GatewayClient，不再直接访问 window.api。
 */
export function waitForChat(
  gateway: GatewayClient,
  input: ChatInput,
  signal: CancelSignal
): Promise<string> {
  return new Promise((resolve, reject) => {
    let taskId = ''
    let text = ''
    let done = false
    const finish = (): void => {
      if (done) return
      done = true
      off()
      clearInterval(cancelTimer)
    }
    const off = gateway.onEvent((event) => {
      if (!taskId || event.taskId !== taskId) return
      if (event.kind === 'chat-delta') text += event.text
      if (event.kind === 'chat-done') {
        finish()
        resolve(text)
      }
      if (event.kind === 'chat-error') {
        finish()
        reject(new Error(event.error))
      }
    })
    const cancelTimer = setInterval(() => {
      if (!signal.cancelled) return
      if (taskId) void gateway.chatCancel(taskId)
      finish()
      reject(new Error('已取消'))
    }, 400)
    void gateway
      .chatStart(input)
      .then((result) => {
        if (result.ok) taskId = result.data.taskId
        else {
          finish()
          reject(new Error(result.error.message))
        }
      })
      .catch((error) => {
        finish()
        reject(error instanceof Error ? error : new Error(String(error)))
      })
  })
}

export interface VideoMedia {
  mediaId: string
  mediaPath: string
  name: string
  mime: string
}

/** 每 3 秒轮询视频任务状态；成功取媒体，失败/取消走 reject，10 分钟超时兜底。 */
export function waitForVideo(
  gateway: GatewayClient,
  taskId: string,
  signal: CancelSignal
): Promise<VideoMedia> {
  return new Promise((resolve, reject) => {
    let stopped = false
    let timeout: ReturnType<typeof setTimeout> | undefined
    const stop = (): void => {
      stopped = true
      clearInterval(timer)
      if (timeout !== undefined) clearTimeout(timeout)
    }
    const timer = setInterval(async () => {
      if (signal.cancelled) {
        stop()
        void gateway.videoCancel(taskId)
        reject(new Error('已取消'))
        return
      }
      const result = await gateway.videoTask(taskId)
      if (!result.ok || !result.data) return
      if (result.data.status === 'success' && result.data.mediaPath) {
        stop()
        resolve({
          mediaId: result.data.mediaId ?? '',
          mediaPath: result.data.mediaPath,
          name: 'video',
          mime: 'video/mp4'
        })
      } else if (result.data.status === 'failed' || result.data.status === 'cancelled') {
        stop()
        reject(new Error(result.data.error ?? '视频生成失败'))
      }
    }, 3_000)
    timeout = setTimeout(() => {
      if (!stopped) {
        stop()
        reject(new Error('视频生成超时（10 分钟）'))
      }
    }, 600_000)
  })
}

/** 视频生成解析出的配置（来自视频节点的持久化文本）。 */
export interface VideoGenData {
  prompt: string
  modelKey: string
  params: VideoGenParams
  taskId: string
}

export function parseVideoGen(text: string): VideoGenData {
  const value = parseJsonObj(text)
  if (value && typeof value.prompt === 'string') {
    const rawParams = parseJsonObj(JSON.stringify(value.params ?? {})) ?? {}
    return {
      prompt: value.prompt,
      modelKey: typeof value.modelKey === 'string' ? value.modelKey : '',
      params: {
        ratio: typeof rawParams.ratio === 'string' ? rawParams.ratio : undefined,
        duration: typeof rawParams.duration === 'number' ? rawParams.duration : undefined,
        resolution: typeof rawParams.resolution === 'string' ? rawParams.resolution : undefined,
        generateAudio:
          typeof rawParams.generateAudio === 'boolean' ? rawParams.generateAudio : undefined,
        seed: typeof rawParams.seed === 'number' ? rawParams.seed : undefined,
        watermark: typeof rawParams.watermark === 'boolean' ? rawParams.watermark : undefined
      },
      taskId: typeof value.taskId === 'string' ? value.taskId : ''
    }
  }
  return { prompt: text, modelKey: '', params: {}, taskId: '' }
}

/** 在全部供应商里按 key 查文本模型；allowDefault 为真时可回落到第一个可用选项。 */
export function findTextModelShared(
  providers: ProviderSummary[],
  modelKey: string,
  allowDefault = false
): ModelOption | undefined {
  const options = modelsByModality(providers, 'text')
  return (
    options.find((option) => option.key === modelKey) ?? (allowDefault ? options[0] : undefined)
  )
}
