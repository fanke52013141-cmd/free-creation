// 对话节点执行器：把显式输入端口或已持久化的待发送消息作为本轮用户消息。
import { inputText } from '../inputs'
import type { NodeExecutionContext, NodeExecutionResult } from '../executor-types'
import { parseChat } from '../chat-data'
import { featureKeyOf, findTextModel, modelKeyOf, resolveFeatureOption } from '../models'
import { waitForChat } from '../helpers'
import { buildChatCompressionPrompt, splitChatForCompression } from '../chat-memory'
import { isReasoningModelId } from '../../model-reasoning'

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
  const option = ctx.gateway.resolveModelFeature
    ? await resolveFeatureOption(
        ctx.gateway,
        ctx.providers,
        featureKeyOf(data, 'chat.generate'),
        'text.generate',
        modelKeyOf(data)
      )
    : findTextModel(ctx.providers, data.modelKey)
  if (!option) return { status: 'skipped', reason: '功能 chat.generate 尚未绑定已验证文本模型' }
  const textInput = inputText(ctx.inputs, 'in-text').trim()
  const hasPendingUserMessage = data.messages.at(-1)?.role === 'user'
  const messages = hasPendingUserMessage
    ? data.messages
    : textInput
      ? [...data.messages, { role: 'user' as const, content: textInput }]
      : []
  if (!messages.length) return { status: 'skipped', reason: '请输入消息或连接“文本输入”端口' }
  let streamedText = ''
  let streamedReasoning = ''
  const persistStreamingReply = (): void => {
    ctx.updateProps({
      text: JSON.stringify({
        ...data,
        modelKey: option.key,
        messages: [
          ...messages,
          {
            role: 'assistant' as const,
            content: streamedText,
            ...(streamedReasoning ? { reasoning: streamedReasoning } : {})
          }
        ]
      })
    })
  }
  const reply = await waitForChat(
    ctx.gateway,
    {
      providerId: option.provider.id,
      modelId: option.model.id,
      system: effectiveSystem(data),
      messages,
      temperature: data.temperature,
      maxTokens: data.maxTokens,
      reasoningEffort:
        data.reasoningEffort !== 'off' && isReasoningModelId(option.model.id) ? 'high' : undefined
    },
    ctx.signal,
    (progress) => {
      streamedText = progress.text
      streamedReasoning = progress.reasoning
      // 每个已抵达的分片立即写入节点，右侧对话面板订阅节点数据后逐字呈现。
      persistStreamingReply()
    }
  )
  if (ctx.signal.cancelled) return { status: 'skipped', reason: '已取消' }
  const completedMessages = [
    ...messages,
    {
      role: 'assistant' as const,
      content: reply,
      ...(streamedReasoning ? { reasoning: streamedReasoning } : {})
    }
  ]
  let summary = data.summary ?? ''
  let persistedMessages = completedMessages
  // 第 21 轮完成后才开始压缩：此前最多 40 条原始 user / assistant 消息完全保留。
  const compression = data.autoCompress ? splitChatForCompression(completedMessages) : null
  if (compression && !ctx.signal.cancelled) {
    try {
      summary = await waitForChat(
        ctx.gateway,
        {
          providerId: option.provider.id,
          modelId: option.model.id,
          messages: [
            { role: 'user', content: buildChatCompressionPrompt(summary, compression.earlier) }
          ],
          temperature: 0,
          maxTokens: Math.min(data.maxTokens, 2048)
        },
        ctx.signal
      )
      persistedMessages = compression.recent
    } catch {
      // 主回复已经成功；摘要失败时绝不丢历史，下一轮可重试压缩。
    }
  }
  ctx.updateProps({
    text: JSON.stringify({
      ...data,
      modelKey: option.key,
      summary,
      messages: persistedMessages
    })
  })
  return { status: 'done' }
}
