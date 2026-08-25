// 对话节点执行器：把上游文本作为本轮用户消息，追加到历史后发起一轮对话。
import type { ChatMessage } from '@shared/types'
import { inputText } from '../contracts'
import type { NodeExecutionContext, NodeExecutionResult } from '../executor-types'
import { findTextModel, parseJsonObj, waitForChat } from './shared'

export function parseChat(text: string): {
  system: string
  modelKey: string
  messages: ChatMessage[]
} {
  const value = parseJsonObj(text)
  if (value && Array.isArray(value.messages)) {
    const messages = value.messages
      .map((message) => message as { role?: unknown; content?: unknown })
      .filter(
        (message): message is { role: 'user' | 'assistant'; content: string } =>
          (message.role === 'user' || message.role === 'assistant') &&
          typeof message.content === 'string'
      )
    return {
      system: typeof value.system === 'string' ? value.system : '',
      modelKey: typeof value.modelKey === 'string' ? value.modelKey : '',
      messages
    }
  }
  return { system: '', modelKey: '', messages: [] }
}

export const chatExecutor = async (ctx: NodeExecutionContext): Promise<NodeExecutionResult> => {
  const data = parseChat(ctx.shape.props.text)
  const option = findTextModel(ctx.providers, data.modelKey)
  if (!option) return { status: 'skipped', reason: '未选择可用对话模型' }
  const textInput = inputText(ctx.inputs, 'in-text')
  if (!textInput.trim() && data.messages.length > 0) return { status: 'done' }
  const messages: ChatMessage[] = [
    ...data.messages,
    { role: 'user', content: textInput || '（开始对话）' }
  ]
  const reply = await waitForChat(
    { providerId: option.provider.id, modelId: option.model.id, system: data.system, messages },
    ctx.signal
  )
  if (ctx.signal.cancelled) return { status: 'skipped', reason: '已取消' }
  ctx.updateProps({
    text: JSON.stringify({
      ...data,
      modelKey: option.key,
      messages: [...messages, { role: 'assistant', content: reply }]
    })
  })
  return { status: 'done' }
}
