// 外部 chat.patch 的权威应用层（F6）。
// main 预检节点类型；这里用与 GUI 同一 chat-data 解析/变更函数应用会话操作，
// 生成新的节点正文（props.text）。任何一项失败整批拒绝，不留下半次会话变更。
import type { ChatMessage } from '@shared/types'
import {
  activeChatConversation,
  chatConversations,
  createChatConversation,
  editChatMessage,
  parseChat,
  selectChatConversation,
  serializeChat,
  updateActiveChatConversation,
  type ChatData
} from '@shared/engine/chat-data'
import type { ChatPatchOp } from '@shared/agent-access/chat-ops'

export interface ChatPatchIssue {
  index: number
  code: string
}

export type ChatPatchPlanResult =
  | { ok: true; nextText: string }
  | { ok: false; issue: ChatPatchIssue }

const fail = (index: number, code: string): ChatPatchPlanResult => ({ ok: false, issue: { index, code } })

function appendMessage(data: ChatData, message: ChatMessage): ChatData {
  const active = activeChatConversation(data)
  return updateActiveChatConversation(data, [...active.messages, message])
}

function deleteConversation(data: ChatData, sessionId: string): ChatData | null {
  const conversations = chatConversations(data)
  const remaining = conversations.filter((conversation) => conversation.id !== sessionId)
  if (remaining.length === conversations.length) return null
  const fallback = remaining.at(-1)
  const next: ChatData = {
    ...data,
    conversations: remaining,
    activeConversationId: fallback?.id
  }
  // 空会话集回落：直接构造单一空白会话（与 GUI 删除最后会话后的用户预期一致）。
  // 不能复用 createChatConversation——sessionized 会先从镜像字段再造 legacy-current。
  if (remaining.length === 0) {
    const id = `chat-${Date.now()}`
    const conversation = {
      id,
      title: '新会话 1',
      messages: [] as ChatMessage[],
      createdAt: Date.now(),
      updatedAt: Date.now()
    }
    return {
      ...data,
      conversations: [conversation],
      activeConversationId: id,
      messages: [],
      summary: ''
    }
  }
  return { ...next, messages: fallback?.messages ?? [] }
}

function renameConversation(data: ChatData, sessionId: string, title: string): ChatData | null {
  const conversations = chatConversations(data)
  if (!conversations.some((conversation) => conversation.id === sessionId)) return null
  return {
    ...data,
    conversations: conversations.map((conversation) =>
      conversation.id === sessionId
        ? { ...conversation, title: title.trim(), updatedAt: Date.now() }
        : conversation
    )
  }
}

/** 按顺序应用 chat.* 操作；任何失败返回带序号的稳定错误码。 */
export function planChatPatch(rawText: string, ops: readonly ChatPatchOp[]): ChatPatchPlanResult {
  let data: ChatData
  try {
    data = parseChat(rawText)
  } catch {
    return fail(0, 'CHAT_DATA_INVALID')
  }
  for (let index = 0; index < ops.length; index++) {
    const op = ops[index]
    switch (op.action) {
      case 'chat.session.create': {
        data = createChatConversation(data)
        if (op.title && op.title.trim()) {
          const conversations = chatConversations(data)
          const activeId = data.activeConversationId
          data = {
            ...data,
            conversations: conversations.map((conversation) =>
              conversation.id === activeId
                ? { ...conversation, title: op.title!.trim(), updatedAt: Date.now() }
                : conversation
            )
          }
        }
        break
      }
      case 'chat.session.select': {
        const conversations = chatConversations(data)
        if (!conversations.some((conversation) => conversation.id === op.sessionId))
          return fail(index, 'SESSION_NOT_FOUND')
        data = selectChatConversation(data, op.sessionId)
        break
      }
      case 'chat.session.rename': {
        const renamed = renameConversation(data, op.sessionId, op.title)
        if (!renamed) return fail(index, 'SESSION_NOT_FOUND')
        data = renamed
        break
      }
      case 'chat.session.delete': {
        const removed = deleteConversation(data, op.sessionId)
        if (!removed) return fail(index, 'SESSION_NOT_FOUND')
        data = removed
        break
      }
      case 'chat.message.append': {
        const message: ChatMessage = {
          role: 'user',
          content: op.message.content,
          ...(op.message.intent ? { intent: op.message.intent } : {}),
          ...(op.message.images?.length
            ? {
                images: op.message.images.map((image) => ({
                  mediaId: image.mediaId,
                  mediaPath: '',
                  name: image.name ?? image.mediaId,
                  mime: ''
                }))
              }
            : {})
        }
        data = appendMessage(data, message)
        break
      }
      case 'chat.message.edit': {
        const edited = editChatMessage(data, op.index, op.content)
        if (!edited) return fail(index, 'MESSAGE_INDEX_INVALID')
        data = edited
        break
      }
      case 'chat.message.truncate': {
        const messages = activeChatConversation(data).messages
        if (op.index < 0 || op.index >= messages.length) return fail(index, 'MESSAGE_INDEX_INVALID')
        data = updateActiveChatConversation(data, messages.slice(0, op.index), '')
        break
      }
    }
  }
  // parseChat 原样返回已保存数据；此前所有变更都经 updateActiveChatConversation /
  // selectChatConversation / createChatConversation，active 镜像字段已同步。
  return { ok: true, nextText: serializeChat(data) }
}
