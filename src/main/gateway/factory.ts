// 模型工厂：按供应商配置创建 AI SDK 实例。
// 全部文本/图片走 @ai-sdk/openai-compatible（调研结论：官方厂商端点均 OpenAI 兼容，
// 中转站天然对口）；视频走 video.ts 的任务式适配器，不经 AI SDK。
import { createOpenAICompatible } from '@ai-sdk/openai-compatible'
import type { ImageModel, LanguageModel } from 'ai'
import type { ProviderConfig, ProviderSpecId } from '../../shared/types'
import type { SaveProviderInput } from '../../shared/contracts'
import { getProvider } from './providers.repo'

export class GatewayError extends Error {
  code: string
  constructor(code: string, message: string) {
    super(message)
    this.code = code
  }
}

export function driverForSpec(specId: ProviderSpecId): 'openai-compatible' | 'video' {
  return specId === 'minimax' || specId === 'seedance' ? 'video' : 'openai-compatible'
}

function requireProvider(providerId: string): ProviderConfig {
  const p = getProvider(providerId)
  if (!p) throw new GatewayError('PROVIDER_NOT_FOUND', `供应商不存在：${providerId}`)
  if (!p.baseURL) throw new GatewayError('PROVIDER_NO_URL', `供应商「${p.name}」未配置 Base URL`)
  return p
}

function createCompatible(p: ProviderConfig): ReturnType<typeof createOpenAICompatible> {
  return createOpenAICompatible({
    name: p.id,
    baseURL: p.baseURL,
    apiKey: p.apiKey || undefined
  })
}

export function createChatModel(providerId: string, modelId: string): LanguageModel {
  const p = requireProvider(providerId)
  return createCompatible(p).chatModel(modelId)
}

export function createImageModel(providerId: string, modelId: string): ImageModel {
  const p = requireProvider(providerId)
  return createCompatible(p).imageModel(modelId)
}

// 连通性测试：OpenAI 兼容驱动优先拉 GET /models（兼作「从服务端拉取模型列表」）；
// 部分中转站不实现 /models（如微信 chatapi 返回 400），回退到最小流式对话探测
// （必须 stream:true——实测部分端点非流式请求会挂起到超时）
export async function testProvider(
  input: SaveProviderInput
): Promise<{ models: string[]; message: string }> {
  const baseURL = input.baseURL.trim().replace(/\/+$/, '')
  if (!baseURL) throw new GatewayError('PROVIDER_NO_URL', 'Base URL 不能为空')
  // 已保存供应商的编辑面板不回显密钥；测试未保存的 URL/模型变更时可安全复用主进程密钥。
  const apiKey = input.apiKey?.trim() || (input.id ? (getProvider(input.id)?.apiKey ?? '') : '')
  if (!apiKey) throw new GatewayError('PROVIDER_NO_KEY', 'API Key 不能为空')

  if (driverForSpec(input.specId) === 'video') {
    return { models: [], message: '配置已保存（视频供应商在首次生成时验证）' }
  }

  const res = await fetch(`${baseURL}/models`, {
    headers: { Authorization: `Bearer ${apiKey}` }
  })
  if (res.ok) {
    const json = (await res.json()) as { data?: Array<{ id?: string }> }
    const models = (json.data ?? [])
      .map((m) => (typeof m?.id === 'string' ? m.id : ''))
      .filter(Boolean)
      .sort()
    return { models, message: `连通正常，发现 ${models.length} 个模型` }
  }

  const probeModel = input.models.find((m) => m.id?.trim())?.id.trim()
  if (!probeModel) {
    const body = await res.text().catch(() => '')
    throw new GatewayError(
      'TEST_FAILED',
      `HTTP ${res.status}${body ? `：${body.slice(0, 180)}` : ''}`
    )
  }
  const chatRes = await fetch(`${baseURL}/chat/completions`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      model: probeModel,
      messages: [{ role: 'user', content: 'ping' }],
      stream: true,
      max_tokens: 1
    }),
    signal: AbortSignal.timeout(60_000)
  })
  if (!chatRes.ok) {
    const body = await chatRes.text().catch(() => '')
    throw new GatewayError(
      'TEST_FAILED',
      `HTTP ${chatRes.status}${body ? `：${body.slice(0, 180)}` : ''}`
    )
  }
  await chatRes.body?.cancel().catch(() => {})
  return {
    models: [],
    message: `连通正常（该端点不支持模型列表，已通过模型 ${probeModel} 验证对话）`
  }
}
