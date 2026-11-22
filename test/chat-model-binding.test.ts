import { describe, expect, it } from 'vitest'
import { serializeChat } from '../src/shared/engine/chat-data'
import { CHAT_FEATURE_KEY } from '../src/shared/engine/models'
import { chatModelBinding } from '../src/renderer/src/canvas/chat-readiness'

describe('对话节点模型就绪读法（与执行器同源）', () => {
  it('模型选择存在会话数据里时能读到，功能键默认 chat.generate', () => {
    const text = serializeChat({
      system: '',
      modelKey: 'openai:gpt-4o-mini',
      messages: [],
      temperature: 0.7,
      maxTokens: 4096
    })
    expect(chatModelBinding(text)).toEqual({
      featureKey: CHAT_FEATURE_KEY,
      modelKey: 'openai:gpt-4o-mini'
    })
  })

  it('会话数据不参与功能键自定义：始终为 chat.generate（与执行器一致）', () => {
    const text = JSON.stringify({
      modelKey: 'openai:gpt-4o-mini',
      featureKey: 'text.chat.legacy',
      messages: []
    })
    expect(chatModelBinding(text)).toEqual({
      featureKey: CHAT_FEATURE_KEY,
      modelKey: 'openai:gpt-4o-mini'
    })
  })

  it('空正文/坏 JSON 回到默认功能键且没有模型', () => {
    expect(chatModelBinding('')).toEqual({ featureKey: CHAT_FEATURE_KEY, modelKey: undefined })
    expect(chatModelBinding('{bad').featureKey).toBe(CHAT_FEATURE_KEY)
  })

  it('旧功能键不再是默认值（防止就绪检查与执行器分叉）', () => {
    expect(CHAT_FEATURE_KEY).toBe('chat.generate')
    expect(chatModelBinding('{}').featureKey).not.toBe('text.chat')
  })
})