import { TEXT_MERGE_SEPARATOR } from '../helpers'
// 对话节点执行器：把显式输入端口或已持久化的待发送消息作为本轮用户消息。
import { inputText } from '../inputs'
import type { NodeExecutionContext, NodeExecutionResult } from '../executor-types'
import { gatewayDiagnostics } from '../executor-diagnostics'
import {
  activeChatConversation,
  parseChat,
  serializeChat,
  updateActiveChatConversation
} from '../chat-data'
import { featureKeyOf, findTextModel, modelKeyOf, resolveFeatureOption } from '../models'
import { waitForChat } from '../helpers'
import { buildChatCompressionPrompt, splitChatForCompression } from '../chat-memory'
import { isReasoningModelId } from '../../model-reasoning'
import type { ChatImageAttachment } from '../../types'
import { chatImageInput, resolveChatImageTarget } from '../chat-image'

function effectiveSystem(data: ReturnType<typeof parseChat>): string {
  const sections = [data.system.trim()]
  if (data.documents?.length) {
    sections.push(
      `以下是用户提供的参考文档：\n\n${data.documents
        .map((document) => `【文档：${document.name}】\n${document.content}`)
        .join(TEXT_MERGE_SEPARATOR)}`
    )
  }
  if (data.summary?.trim()) sections.push(`[对话历史摘要]\n${data.summary.trim()}`)
  return sections.filter(Boolean).join('\n\n')
}

export const chatExecutor = async (ctx: NodeExecutionContext): Promise<NodeExecutionResult> => {
  const savedData = parseChat(ctx.shape.props.text)
  // The executor has one unambiguous source of context: the active session
  // mirrored in props.text. It never scans a different conversation or calls
  // the model from a React component.
  const activeConversation = activeChatConversation(savedData)
  const data = {
    ...savedData,
    messages: activeConversation.messages,
    summary: activeConversation.summary ?? savedData.summary ?? ''
  }
  const pendingImage =
    data.messages.at(-1)?.role === 'user' && data.messages.at(-1)?.intent === 'image'
  // Explicit skill entry works even when the text provider lacks tool calling.
  if (pendingImage) {
    const resolved = await resolveChatImageTarget(ctx, data)
    if (!resolved) return { status: 'skipped', reason: '请启用生图技能并选择已验证图片模型' }
    const { target, option: imageOption } = resolved
    const input = chatImageInput(target, imageOption, data.messages.at(-1)!.content)
    if (ctx.signal.cancelled) return { status: 'skipped', reason: '已取消' }
    ctx.setDiagnosticTarget?.({
      operation: 'image.generate',
      featureKey: 'image.generate',
      providerId: target.providerId,
      modelId: target.modelId
    })
    ctx.trace?.('capability', 'info', '已解析对话生图技能与图片模型')
    const result = await ctx.gateway.imageGenerate({
      ...input,
      diagnostics: gatewayDiagnostics(ctx)
    })
    if (!result.ok) return { status: 'failed', reason: result.error.message }
    const image = result.data
    // Persist an accepted result before checking local cancellation; paid output must not disappear.
    const next = updateActiveChatConversation(savedData, [
      ...data.messages,
      {
        role: 'assistant',
        content: '已生成图片。',
        images: [
          {
            mediaId: image.id,
            mediaPath: image.path,
            mime: image.mime,
            name: image.name || '生成图片'
          }
        ]
      }
    ])
    ctx.updateProps({ text: serializeChat(next) })
    ctx.trace?.('result', 'info', '对话图片已保存为独立项目资产')
    return ctx.signal.cancelled
      ? { status: 'skipped', reason: '已取消；已完成的图片已保留' }
      : { status: 'done' }
  }
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
  // L03：能力解析阶段与目标身份；只记 provider/model 标识，不读对话正文。
  ctx.trace?.('capability', 'info', '已解析对话模型能力')
  ctx.setDiagnosticTarget?.({
    operation: 'chat.generate',
    featureKey: featureKeyOf(data, 'chat.generate'),
    providerId: option.provider.id,
    providerName: option.provider.name,
    modelId: option.model.id,
    modelName: option.model.name
  })
  const requestDiagnostics = gatewayDiagnostics(ctx)
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
  let streamedImages: ChatImageAttachment[] = []
  const persistStreamingReply = (): void => {
    const next = updateActiveChatConversation(savedData, [
      ...messages,
      {
        role: 'assistant' as const,
        content: streamedText,
        ...(streamedImages.length ? { images: streamedImages } : {}),
        ...(streamedReasoning ? { reasoning: streamedReasoning } : {})
      }
    ])
    ctx.updateProps({
      text: serializeChat({ ...next, modelKey: option.key })
    })
  }
  const imageSkill = ctx.providers.some((provider) =>
    provider.models.some((model) => model.modality === 'image')
  )
    ? await resolveChatImageTarget(ctx, data)
    : null
  const reply = await waitForChat(
    ctx.gateway,
    {
      providerId: option.provider.id,
      modelId: option.model.id,
      system: effectiveSystem(data),
      messages:
        data.autoCompress && data.summary && messages.some((message) => message.images?.length)
          ? messages.slice(-40)
          : messages,
      temperature: data.temperature,
      maxTokens: data.maxTokens,
      reasoningEffort:
        data.reasoningEffort !== 'off' && isReasoningModelId(option.model.id) ? 'high' : undefined,
      diagnostics: requestDiagnostics,
      ...(imageSkill ? { imageSkill: imageSkill.target } : {})
    },
    ctx.signal,
    (progress) => {
      streamedText = progress.text
      streamedReasoning = progress.reasoning
      streamedImages = progress.images ?? streamedImages
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
      ...(streamedImages.length ? { images: streamedImages } : {}),
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
          maxTokens: Math.min(data.maxTokens, 2048),
          // 摘要是第二次独立逻辑请求：requestId 由帮手重新生成。
          diagnostics: gatewayDiagnostics(ctx)
        },
        ctx.signal
      )
      // Keep generated images visible even when older text history is summarized.
      persistedMessages = [
        ...compression.earlier.filter((message) => message.images?.length),
        ...compression.recent
      ]
    } catch (error) {
      // 取消落在摘要阶段不能被吞掉（否则本轮取消被记成 done）；先于「不丢历史」
      // 兜底处理：确属取消则本节点标 skipped（R-14）。
      const message = error instanceof Error ? error.message : String(error)
      if (ctx.signal.cancelled || message === '已取消') {
        return { status: 'skipped', reason: '已取消' }
      }
      // 主回复已经成功；摘要失败时绝不丢历史，下一轮可重试压缩。
    }
  }
  const next = updateActiveChatConversation(savedData, persistedMessages, summary)
  ctx.updateProps({ text: serializeChat({ ...next, modelKey: option.key }) })
  return { status: 'done' }
}
