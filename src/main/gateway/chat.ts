// 聊天链路：主进程 streamText 消费流，经 IPC 事件分片转发渲染端
import { streamText } from 'ai'
import { nanoid } from 'nanoid'
import type { GatewayEvent } from '../../shared/contracts'
import type { ChatStartInput } from '../../shared/contracts'
import { createChatModel, GatewayError } from './factory'

type Send = (e: GatewayEvent) => void

const active = new Map<string, AbortController>()

export function startChat(send: Send, input: ChatStartInput): string {
  if (!input.providerId || !input.modelId) {
    throw new GatewayError('INVALID_INPUT', '未选择模型')
  }
  const taskId = nanoid(10)
  const ctrl = new AbortController()
  active.set(taskId, ctrl)

  void (async () => {
    try {
      const result = streamText({
        model: createChatModel(input.providerId, input.modelId),
        system: input.system?.trim() || undefined,
        messages: input.messages
          .filter((m) => m.content.trim())
          .map((m) => ({ role: m.role, content: m.content })),
        temperature: input.temperature,
        // AI SDK v7 使用 maxOutputTokens；IPC 仍保留 maxTokens 以保持现有 UI 数据兼容。
        maxOutputTokens: input.maxTokens,
        abortSignal: ctrl.signal
      })
      for await (const part of result.fullStream) {
        if (part.type === 'text-delta') {
          send({ kind: 'chat-delta', taskId, text: part.text })
        } else if (part.type === 'reasoning-delta') {
          send({ kind: 'chat-reasoning', taskId, text: part.text })
        }
      }
      send({ kind: 'chat-done', taskId })
    } catch (e) {
      send({
        kind: 'chat-error',
        taskId,
        error: e instanceof Error ? e.message : String(e)
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
