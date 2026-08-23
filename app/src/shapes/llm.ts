// ===== LLM 调用助手（P3 后端模型网关）=====

import type { ModelConfig } from '../types'
import type { ChatMessage } from './types'
import { callGatewayChat } from '../services/gateway'

interface CallOptions {
  model: ModelConfig
  messages: ChatMessage[]
  temperature?: number
  maxTokens?: number
  /** 中止信号 */
  signal?: AbortSignal
}

/**
 * 调用 OpenAI 兼容的 /chat/completions 接口。
 * 失败时抛出带友好信息的 Error。
 */
export async function callChatCompletion({
  model,
  messages,
  temperature,
  maxTokens,
  signal,
}: CallOptions): Promise<string> {
  return callGatewayChat({
    profileId: model.id,
    messages,
    temperature: temperature ?? model.temperature ?? 0.7,
    maxTokens: maxTokens ?? model.maxTokens ?? 2048,
    signal,
  })
}
