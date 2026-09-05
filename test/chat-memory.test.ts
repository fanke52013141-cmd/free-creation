import { describe, expect, it } from 'vitest'
import {
  CHAT_UNCOMPRESSED_MESSAGES,
  CHAT_UNCOMPRESSED_ROUNDS,
  buildChatCompressionPrompt,
  splitChatForCompression
} from '../src/shared/engine/chat-memory'

function rounds(count: number) {
  return Array.from({ length: count * 2 }, (_, index) => ({
    role: index % 2 === 0 ? ('user' as const) : ('assistant' as const),
    content: `消息 ${index + 1}`
  }))
}

describe('对话压缩边界', () => {
  it('20 轮以内不压缩，保留全部原始消息', () => {
    expect(CHAT_UNCOMPRESSED_ROUNDS).toBe(20)
    expect(CHAT_UNCOMPRESSED_MESSAGES).toBe(40)
    expect(splitChatForCompression(rounds(20))).toBeNull()
  })

  it('第 21 轮完成后仅压缩较早一轮，保留最近 20 轮', () => {
    const result = splitChatForCompression(rounds(21))
    expect(result?.earlier).toHaveLength(2)
    expect(result?.recent).toHaveLength(40)
    expect(result?.recent[0]?.content).toBe('消息 3')
  })

  it('压缩提示词保留已有摘要和对话角色', () => {
    const prompt = buildChatCompressionPrompt('用户在制作视频', rounds(1))
    expect(prompt).toContain('用户在制作视频')
    expect(prompt).toContain('用户：消息 1')
    expect(prompt).toContain('助手：消息 2')
  })
})
