// 对话节点执行器：把显式输入端口或已持久化的待发送消息作为本轮用户消息。
import { inputText } from '../inputs'
import type { NodeExecutionContext, NodeExecutionResult } from '../executor-types'
import { parseChat } from '../chat-data'
import { findTextModel } from '../models'
import { waitForChat } from '../helpers'

function effectiveSystem(data: ReturnType<typeof parseChat>): string {
  const sections = [data.system.trim()]
  if (data.documents?.length) {
    sections.push(
      `以下是用户提供的参考文档：\n\n${data.documents
        .map((document) => `【文档：${document.name}】\n${document.content}`)
        .join('\n\n---\n\n')}`
    )
  }
  if (data.summary?.trim()) sections.push(`[对话历史摘要]\n${data.summary.trim()}`)
  return sections.filter(Boolean).join('\n\n')
}

export const chatExecutor = async (ctx: NodeExecutionContext): Promise<NodeExecutionResult> => {
  const data = parseChat(ctx.shape.props.text)
  const option = findTextModel(ctx.providers, data.modelKey)
  if (!option) return { status: 'skipped', reason: '未选择可用对话模型' }
  const textInput = inputText(ctx.inputs, 'in-text').trim()
  const hasPendingUserMessage = data.messages.at(-1)?.role === 'user'
  const messages = hasPendingUserMessage
    ? data.messages
    : textInput
      ? [...data.messages, { role: 'user' as const, content: textInput }]
      : []
  if (!messages.length) return { status: 'skipped', reason: '请输入消息或连接“文本输入”端口' }
  const reply = await waitForChat(
    ctx.gateway,
    {
      providerId: option.provider.id,
      modelId: option.model.id,
      system: effectiveSystem(data),
      messages,
      temperature: data.temperature,
      maxTokens: data.maxTokens
    },
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
