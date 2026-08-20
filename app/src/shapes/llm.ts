// ===== LLM 调用助手（OpenAI 兼容格式）=====
// 铁律§6.3：模型接入走中转站统一入口。MVP 阶段直连浏览器侧调用。

import type { ModelConfig } from '../types'
import type { ChatMessage } from './types'

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
  if (!model.baseUrl) throw new Error('模型未配置 Base URL')
  if (!model.apiKey) throw new Error('模型未配置 API Key')
  if (!model.modelId) throw new Error('模型未配置模型 ID')

  const url = model.baseUrl.replace(/\/$/, '') + '/chat/completions'

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${model.apiKey}`,
    },
    body: JSON.stringify({
      model: model.modelId,
      messages: messages.map((m) => ({ role: m.role, content: m.content })),
      temperature: temperature ?? model.temperature ?? 0.7,
      max_tokens: maxTokens ?? model.maxTokens ?? 2048,
    }),
    signal,
  })

  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new Error(`接口返回 ${res.status}：${body.slice(0, 200) || res.statusText}`)
  }

  const data = await res.json()
  const content: string | undefined = data?.choices?.[0]?.message?.content
  if (!content) throw new Error('返回内容为空')
  return content
}
