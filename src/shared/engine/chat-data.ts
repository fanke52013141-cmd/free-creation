// 聊天数据解析（从 renderer/nodes/chatData.ts 移入共享层，纯函数无环境依赖）
import type { ChatMessage } from '../types'

export interface ChatDocument {
  name: string
  content: string
}

export interface ChatData {
  system: string
  modelKey: string
  messages: ChatMessage[]
  temperature: number
  maxTokens: number
  documents?: ChatDocument[]
  summary?: string
  autoCompress?: boolean
}

const EMPTY_CHAT: ChatData = {
  system: '',
  modelKey: '',
  messages: [],
  temperature: 0.7,
  maxTokens: 4096,
  documents: [],
  summary: '',
  autoCompress: true
}

/** 兼容旧画布中保存的聊天配置，损坏内容安全降级为空会话。 */
export function parseChat(text: string): ChatData {
  try {
    const value = JSON.parse(text) as Record<string, unknown>
    if (typeof value !== 'object' || value === null || !Array.isArray(value.messages)) {
      return { ...EMPTY_CHAT }
    }
    const messages = value.messages
      .map((message) => message as { role?: unknown; content?: unknown; reasoning?: unknown })
      .filter(
        (
          message
        ): message is {
          role: 'user' | 'assistant'
          content: string
          reasoning?: unknown
        } =>
          (message.role === 'user' || message.role === 'assistant') &&
          typeof message.content === 'string'
      )
      .map((message) => ({
        role: message.role,
        content: message.content,
        ...(typeof message.reasoning === 'string' && message.reasoning.trim()
          ? { reasoning: message.reasoning }
          : {})
      }))
    const documents = (Array.isArray(value.documents) ? value.documents : [])
      .map((document) => document as { name?: unknown; content?: unknown })
      .filter(
        (document): document is ChatDocument =>
          typeof document.name === 'string' && typeof document.content === 'string'
      )
    return {
      system: typeof value.system === 'string' ? value.system : '',
      modelKey: typeof value.modelKey === 'string' ? value.modelKey : '',
      messages,
      temperature: typeof value.temperature === 'number' ? value.temperature : 0.7,
      maxTokens: typeof value.maxTokens === 'number' ? value.maxTokens : 4096,
      documents,
      summary: typeof value.summary === 'string' ? value.summary : '',
      autoCompress: typeof value.autoCompress === 'boolean' ? value.autoCompress : true
    }
  } catch {
    return { ...EMPTY_CHAT }
  }
}
