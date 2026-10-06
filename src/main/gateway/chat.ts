// 聊天链路：主进程 streamText 消费流，经 IPC 事件分片转发渲染端
// L03：请求边界发射 model.request.* 结构化事件（首片/完成/失败/取消），
// 只记录统计与错误码，不记录提示词、回复或 reasoning 正文。
import { streamText, stepCountIs } from 'ai'
import { nanoid } from 'nanoid'
import type { GatewayEvent } from '../../shared/contracts'
import type { ChatStartInput } from '../../shared/contracts'
import { emitGatewayEvent, ensureRequestId } from '../diagnostics/gateway-events'
import { createChatModel, GatewayError } from './factory'
import { createChatImageTool, loadImageSkillInstructions } from './chat-image-skill'

type Send = (e: GatewayEvent) => void

const active = new Map<string, AbortController>()

export function startChat(send: Send, input: ChatStartInput): string {
  if (!input.providerId || !input.modelId) {
    throw new GatewayError('INVALID_INPUT', '未选择模型')
  }
  const taskId = nanoid(10)
  const ctrl = new AbortController()
  active.set(taskId, ctrl)
  const diagnostics = input.diagnostics
  const requestId = ensureRequestId(diagnostics)
  const startedAt = Date.now()
  emitGatewayEvent(
    'model.request.started',
    '对话请求开始',
    { ...diagnostics, requestId },
    {
      attributes: {
        operation: 'chat.generate',
        providerId: input.providerId,
        modelId: input.modelId
      }
    }
  )

  void (async () => {
    let firstChunkAt: number | null = null
    let outputChars = 0
    let generatedImages = 0
    try {
      const result = streamText({
        model: createChatModel(input.providerId, input.modelId),
        system:
          [input.system?.trim(), input.imageSkill ? loadImageSkillInstructions() : '']
            .filter(Boolean)
            .join('\n\n') || undefined,
        ...(input.imageSkill
          ? {
              tools: {
                generate_image: createChatImageTool(
                  input.imageSkill,
                  diagnostics,
                  ctrl.signal,
                  (image) => {
                    generatedImages += 1
                    send({ kind: 'chat-image', taskId, image })
                  }
                )
              },
              stopWhen: stepCountIs(3),
              maxRetries: 0
            }
          : {}),
        messages: input.messages
          .filter((m) => m.content.trim())
          .map((m) => ({ role: m.role, content: m.content })),
        temperature: input.temperature,
        // AI SDK v7 使用 maxOutputTokens；IPC 仍保留 maxTokens 以保持现有 UI 数据兼容。
        maxOutputTokens: input.maxTokens,
        // @ai-sdk/openai-compatible 会将该配置转换为 reasoning_effort；仅由执行器
        // 在确认是推理模型时传入，因此普通模型不会收到未知参数。
        providerOptions: input.reasoningEffort
          ? { [input.providerId]: { reasoningEffort: input.reasoningEffort } }
          : undefined,
        abortSignal: ctrl.signal
      })
      let receivedTextDelta = false
      for await (const part of result.fullStream) {
        if (part.type === 'text-delta') {
          receivedTextDelta = true
          outputChars += part.text.length
          if (firstChunkAt === null) {
            firstChunkAt = Date.now()
            emitGatewayEvent(
              'model.request.first_chunk',
              '收到首个流式分片',
              { ...diagnostics, requestId },
              {
                durationMs: firstChunkAt - startedAt,
                attributes: {
                  operation: 'chat.generate',
                  providerId: input.providerId,
                  modelId: input.modelId
                }
              }
            )
          }
          send({ kind: 'chat-delta', taskId, text: part.text })
        } else if (part.type === 'reasoning-delta') {
          send({ kind: 'chat-reasoning', taskId, text: part.text })
        } else if (part.type === 'error') {
          // 上游/网络错误以 error 分片出现在流中。此前直接忽略，真实原因被吞掉，
          // 兜底的 result.text 只会抛出笼统的「No output generated」（2026-10-05 排查）。
          throw part.error instanceof Error ? part.error : new Error(String(part.error))
        } else if (part.type === 'tool-error') {
          throw part.error instanceof Error ? part.error : new Error('生图工具执行失败')
        }
      }
      // 部分 OpenAI 兼容中转站只在最终聚合结果中给出正文，不发送 text-delta。
      // 若不回退，模型实际已回答，节点却只会收到 chat-done 并显示空白回复。
      if (!receivedTextDelta) {
        const finalText = await result.text
        outputChars += finalText.length
        if (finalText.trim()) send({ kind: 'chat-delta', taskId, text: finalText })
      }
      if (!outputChars && generatedImages) {
        send({ kind: 'chat-delta', taskId, text: '已生成图片。' })
        outputChars += 6
      }
      emitGatewayEvent(
        'model.request.completed',
        '对话请求完成',
        { ...diagnostics, requestId },
        {
          status: 'success',
          durationMs: Date.now() - startedAt,
          attributes: {
            operation: 'chat.generate',
            providerId: input.providerId,
            modelId: input.modelId,
            outputChars
          }
        }
      )
      send({ kind: 'chat-done', taskId })
    } catch (e) {
      // SDK 在「流以错误收场且零正文输出」时抛 AI_NoOutputGeneratedError，真实原因挂在
      // cause（HTTP 状态/响应体/网络错误）。必须解包，否则节点只看到笼统的
      // No output generated。按错误名识别而非 instanceof：ai 包在测试里可能被整体 mock。
      const realError =
        e instanceof Error && e.name === 'AI_NoOutputGeneratedError' && e.cause instanceof Error
          ? e.cause
          : e
      if (ctrl.signal.aborted) {
        // 用户取消：远端是否真正停止未知，不得声称已远端取消。
        emitGatewayEvent(
          'model.request.cancelled',
          '对话请求已取消，远端结果未知',
          { ...diagnostics, requestId },
          {
            status: 'cancelled',
            durationMs: Date.now() - startedAt,
            attributes: {
              operation: 'chat.generate',
              providerId: input.providerId,
              modelId: input.modelId
            }
          }
        )
      } else {
        emitGatewayEvent(
          'model.request.failed',
          '对话请求失败',
          { ...diagnostics, requestId },
          {
            status: 'failed',
            durationMs: Date.now() - startedAt,
            error: realError,
            privateValues: input.messages.map((message) => message.content),
            attributes: {
              operation: 'chat.generate',
              providerId: input.providerId,
              modelId: input.modelId
            }
          }
        )
      }
      send({
        kind: 'chat-error',
        taskId,
        error: realError instanceof Error ? realError.message : String(realError)
      })
    } finally {
      active.delete(taskId)
    }
  })()

  return taskId
}

export function cancelChat(taskId: string): boolean {
  const ctrl = active.get(taskId)
  if (!ctrl) return false
  ctrl.abort()
  active.delete(taskId)
  return true
}
