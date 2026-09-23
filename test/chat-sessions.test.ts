import { describe, expect, it } from 'vitest'
import {
  activeChatConversation,
  chatConversations,
  createChatConversation,
  editChatMessage,
  parseChat,
  prepareChatRegeneration,
  selectChatConversation,
  serializeChat,
  updateActiveChatConversation
} from '../src/shared/engine/chat-data'

const legacyText = JSON.stringify({
  modelKey: 'provider::model',
  messages: [
    { role: 'user', content: '第一问' },
    { role: 'assistant', content: '第一答', reasoning: '模型返回的思考' },
    { role: 'user', content: '第二问' },
    { role: 'assistant', content: '第二答' }
  ]
})

describe('对话节点会话数据', () => {
  it('读取旧 messages 结构时不丢失当前会话或 reasoning', () => {
    const data = parseChat(legacyText)
    expect(data.conversations).toBeUndefined()
    expect(activeChatConversation(data).messages).toHaveLength(4)
    expect(activeChatConversation(data).messages[1]).toMatchObject({
      content: '第一答',
      reasoning: '模型返回的思考'
    })
  })

  it('新建和切换历史会话时，执行器视图始终镜像当前会话', () => {
    const old = parseChat(legacyText)
    const created = createChatConversation(old, 42)
    expect(chatConversations(created)).toHaveLength(2)
    expect(activeChatConversation(created).messages).toEqual([])
    const withDraft = updateActiveChatConversation(created, [{ role: 'user', content: '新会话问题' }], '', 43)
    const switched = selectChatConversation(withDraft, 'legacy-current')
    expect(switched.messages.map((message) => message.content)).toEqual([
      '第一问',
      '第一答',
      '第二问',
      '第二答'
    ])
    const restored = selectChatConversation(switched, 'chat-42')
    expect(restored.messages).toEqual([{ role: 'user', content: '新会话问题' }])
    expect(parseChat(serializeChat(restored)).messages).toEqual([{ role: 'user', content: '新会话问题' }])
  })

  it('修改任意消息会保留修改项并截断后续，同时清除过期摘要', () => {
    const edited = editChatMessage({ ...parseChat(legacyText), summary: '旧摘要' }, 1, '改写后的第一答', 99)
    expect(edited?.messages).toEqual([
      { role: 'user', content: '第一问' },
      { role: 'assistant', content: '改写后的第一答' }
    ])
    expect(edited?.summary).toBe('')
  })

  it('重新生成 assistant 时回到对应 user 消息，让 executor 只读取该分支', () => {
    const regenerated = prepareChatRegeneration(parseChat(legacyText), 3, 100)
    expect(regenerated?.messages).toEqual([
      { role: 'user', content: '第一问' },
      { role: 'assistant', content: '第一答', reasoning: '模型返回的思考' },
      { role: 'user', content: '第二问' }
    ])
    expect(activeChatConversation(regenerated!).messages.at(-1)).toEqual({
      role: 'user',
      content: '第二问'
    })
  })
})
