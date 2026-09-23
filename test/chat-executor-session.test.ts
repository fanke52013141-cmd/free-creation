import { describe, expect, it, vi } from 'vitest'
import type { ProviderSummary } from '../src/shared/types'
import type { NodeExecutionContext } from '../src/shared/engine/executor-types'
import type { GatewayClient } from '../src/shared/engine/gateway-client'
import { chatExecutor } from '../src/shared/engine/executors/chat'

const provider = {
  id: 'provider-1',
  name: '测试供应商',
  specId: 'relay',
  baseURL: 'https://example.invalid',
  hasApiKey: true,
  createdAt: 0,
  models: [{ id: 'text-model', name: '文本模型', modality: 'text', providerId: 'provider-1' }]
} as ProviderSummary

describe('对话执行器的当前会话', () => {
  it('只读取 activeConversationId 对应的消息，并把回复写回同一会话', async () => {
    let listener: ((event: { kind: string; taskId: string; text?: string }) => void) | undefined
    const gateway = {
      chatStart: vi.fn().mockResolvedValue({ ok: true, data: { taskId: 'chat-session-1' } }),
      chatCancel: vi.fn(),
      onEvent: vi.fn((next) => {
        listener = next
        return () => undefined
      })
    } as unknown as GatewayClient
    const saved: { text?: string } = {}
    const config = JSON.stringify({
      modelKey: 'provider-1::text-model',
      messages: [{ role: 'user', content: '旧镜像，不应被执行' }],
      activeConversationId: 'active',
      conversations: [
        {
          id: 'older',
          title: '旧会话',
          messages: [{ role: 'user', content: '旧会话问题' }],
          createdAt: 1,
          updatedAt: 1
        },
        {
          id: 'active',
          title: '当前会话',
          messages: [{ role: 'user', content: '当前问题' }],
          createdAt: 2,
          updatedAt: 2
        }
      ]
    })
    const ctx = {
      shape: { props: { text: config } },
      inputs: new Map(),
      providers: [provider],
      signal: { cancelled: false },
      gateway,
      updateProps: (patch) => Object.assign(saved, patch)
    } as unknown as NodeExecutionContext

    const pending = chatExecutor(ctx)
    await vi.waitFor(() => expect(listener).toBeTypeOf('function'))
    expect(gateway.chatStart).toHaveBeenCalledWith(
      expect.objectContaining({ messages: [{ role: 'user', content: '当前问题' }] })
    )
    listener?.({ kind: 'chat-delta', taskId: 'chat-session-1', text: '当前回答' })
    listener?.({ kind: 'chat-done', taskId: 'chat-session-1' })
    await expect(pending).resolves.toEqual({ status: 'done' })
    const persisted = JSON.parse(saved.text ?? '{}')
    expect(persisted.messages.at(-1)).toEqual({ role: 'assistant', content: '当前回答' })
    expect(persisted.conversations.find((item: { id: string }) => item.id === 'active').messages.at(-1)).toEqual({
      role: 'assistant',
      content: '当前回答'
    })
    expect(persisted.conversations.find((item: { id: string }) => item.id === 'older').messages).toEqual([
      { role: 'user', content: '旧会话问题' }
    ])
  })
})
