import { AIMessage, HumanMessage, SystemMessage } from 'langchain'
import type { ChatMessage } from '../types'

/** 20 轮 = 最多保留 40 条 user / assistant 原始消息。 */
export const CHAT_UNCOMPRESSED_ROUNDS = 20
export const CHAT_UNCOMPRESSED_MESSAGES = CHAT_UNCOMPRESSED_ROUNDS * 2

/**
 * 使用 LangChain 的标准消息对象建立可摘要的对话文本。
 * 模型请求仍经由本产品现有网关完成，密钥不会进入渲染进程或 LangChain 初始化配置。
 */
export function langChainTranscript(messages: ChatMessage[]): string {
  return messages
    .map((message) => {
      const item =
        message.role === 'user' ? new HumanMessage(message.content) : new AIMessage(message.content)
      const role = item.getType() === 'human' ? '用户' : '助手'
      return `${role}：${typeof item.content === 'string' ? item.content : JSON.stringify(item.content)}`
    })
    .join('\n\n')
}

export function buildChatCompressionPrompt(summary: string, messages: ChatMessage[]): string {
  const system = new SystemMessage(
    '你是对话记忆压缩器。保留用户目标、已确认事实、约束、决定、未完成事项和必要上下文；不要杜撰，不要输出寒暄。'
  )
  const prior = summary.trim() ? `已有摘要：\n${summary.trim()}\n\n` : ''
  return `${system.content}\n\n${prior}请压缩以下较早对话：\n${langChainTranscript(messages)}`
}

export function splitChatForCompression(messages: ChatMessage[]): {
  earlier: ChatMessage[]
  recent: ChatMessage[]
} | null {
  if (messages.length <= CHAT_UNCOMPRESSED_MESSAGES) return null
  return {
    earlier: messages.slice(0, -CHAT_UNCOMPRESSED_MESSAGES),
    recent: messages.slice(-CHAT_UNCOMPRESSED_MESSAGES)
  }
}
