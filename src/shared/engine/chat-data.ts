// 聊天数据解析（从 renderer/nodes/chatData.ts 移入共享层，纯函数无环境依赖）
import type { ChatMessage } from '../types'

export interface ChatDocument {
  name: string
  content: string
}

/**
 * A conversation is deliberately part of the node text rather than a separate
 * application store.  That keeps the currently selected conversation, its
 * history and its output reproducible when a project is reopened or exported.
 */
export interface ChatConversation {
  id: string
  title: string
  messages: ChatMessage[]
  summary?: string
  createdAt: number
  updatedAt: number
}

export interface ChatData {
  system: string
  modelKey: string
  messages: ChatMessage[]
  temperature: number
  maxTokens: number
  /** 推理模型的思考强度；普通模型会忽略此配置。 */
  reasoningEffort?: 'off' | 'high'
  documents?: ChatDocument[]
  summary?: string
  autoCompress?: boolean
  /** Optional because pre-session chat nodes stored only `messages`. */
  conversations?: ChatConversation[]
  activeConversationId?: string
}

const EMPTY_CHAT: ChatData = {
  system: '',
  modelKey: '',
  messages: [],
  temperature: 0.7,
  maxTokens: 4096,
  reasoningEffort: 'high',
  documents: [],
  summary: '',
  autoCompress: true
}

const LEGACY_CONVERSATION_ID = 'legacy-current'

function messagesFrom(value: unknown): ChatMessage[] {
  if (!Array.isArray(value)) return []
  return value
    .map((message) => message as { role?: unknown; content?: unknown; reasoning?: unknown })
    .filter(
      (
        message
      ): message is {
        role: 'user' | 'assistant'
        content: string
        reasoning?: unknown
      } =>
        (message.role === 'user' || message.role === 'assistant') &&
        typeof message.content === 'string'
    )
    .map((message) => ({
      role: message.role,
      content: message.content,
      ...(typeof message.reasoning === 'string' && message.reasoning.trim()
        ? { reasoning: message.reasoning }
        : {})
    }))
}

function conversationsFrom(value: unknown): ChatConversation[] {
  if (!Array.isArray(value)) return []
  const ids = new Set<string>()
  return value.flatMap((item) => {
    const conversation = item as Record<string, unknown>
    if (
      typeof conversation.id !== 'string' ||
      !conversation.id ||
      ids.has(conversation.id) ||
      typeof conversation.title !== 'string'
    ) {
      return []
    }
    ids.add(conversation.id)
    return [
      {
        id: conversation.id,
        title: conversation.title || '未命名会话',
        messages: messagesFrom(conversation.messages),
        ...(typeof conversation.summary === 'string' && conversation.summary.trim()
          ? { summary: conversation.summary }
          : {}),
        createdAt: typeof conversation.createdAt === 'number' ? conversation.createdAt : 0,
        updatedAt: typeof conversation.updatedAt === 'number' ? conversation.updatedAt : 0
      }
    ]
  })
}

/** 兼容旧画布中保存的聊天配置，损坏内容安全降级为空会话。 */
export function parseChat(text: string): ChatData {
  try {
    const value = JSON.parse(text) as Record<string, unknown>
    if (typeof value !== 'object' || value === null || !Array.isArray(value.messages)) {
      return { ...EMPTY_CHAT }
    }
    const messages = messagesFrom(value.messages)
    const documents = (Array.isArray(value.documents) ? value.documents : [])
      .map((document) => document as { name?: unknown; content?: unknown })
      .filter(
        (document): document is ChatDocument =>
          typeof document.name === 'string' && typeof document.content === 'string'
      )
    const conversations = conversationsFrom(value.conversations)
    const activeConversationId =
      typeof value.activeConversationId === 'string' &&
      conversations.some((conversation) => conversation.id === value.activeConversationId)
        ? value.activeConversationId
        : conversations[0]?.id
    const activeConversation = conversations.find(
      (conversation) => conversation.id === activeConversationId
    )
    return {
      system: typeof value.system === 'string' ? value.system : '',
      modelKey: typeof value.modelKey === 'string' ? value.modelKey : '',
      // Keep top-level fields in sync with the active conversation.  They are
      // the established executor format and retain compatibility for current
      // canvases that have not created a second conversation yet.
      messages: activeConversation?.messages ?? messages,
      temperature: typeof value.temperature === 'number' ? value.temperature : 0.7,
      maxTokens: typeof value.maxTokens === 'number' ? value.maxTokens : 4096,
      reasoningEffort: value.reasoningEffort === 'off' ? 'off' : 'high',
      documents,
      summary: activeConversation?.summary ?? (typeof value.summary === 'string' ? value.summary : ''),
      autoCompress: typeof value.autoCompress === 'boolean' ? value.autoCompress : true,
      ...(conversations.length ? { conversations, activeConversationId } : {})
    }
  } catch {
    return { ...EMPTY_CHAT }
  }
}

/** Returns the active conversation without forcing legacy nodes into a new schema. */
export function activeChatConversation(data: ChatData): ChatConversation {
  const active = data.conversations?.find(
    (conversation) => conversation.id === data.activeConversationId
  )
  return (
    active ?? {
      id: LEGACY_CONVERSATION_ID,
      title: '当前会话',
      messages: data.messages,
      ...(data.summary?.trim() ? { summary: data.summary } : {}),
      createdAt: 0,
      updatedAt: 0
    }
  )
}

/** Provides menu data; legacy nodes appear as one normal, non-destructive conversation. */
export function chatConversations(data: ChatData): ChatConversation[] {
  return data.conversations?.length ? data.conversations : [activeChatConversation(data)]
}

function sessionized(data: ChatData): ChatData {
  if (data.conversations?.length) return data
  const legacy = activeChatConversation(data)
  return { ...data, conversations: [legacy], activeConversationId: legacy.id }
}

/** Switches the active session and mirrors it to the executor's established fields. */
export function selectChatConversation(data: ChatData, id: string): ChatData {
  const normalized = sessionized(data)
  const conversation = normalized.conversations?.find((item) => item.id === id)
  if (!conversation) return normalized
  return {
    ...normalized,
    activeConversationId: conversation.id,
    messages: conversation.messages,
    summary: conversation.summary ?? ''
  }
}

/** Writes active messages once, ensuring the session and executor view cannot diverge. */
export function updateActiveChatConversation(
  data: ChatData,
  messages: ChatMessage[],
  summary = data.summary ?? '',
  now = Date.now()
): ChatData {
  const normalized = sessionized(data)
  const activeId = normalized.activeConversationId ?? normalized.conversations?.[0]?.id
  const conversations = (normalized.conversations ?? []).map((conversation) =>
    conversation.id === activeId
      ? {
          ...conversation,
          messages,
          ...(summary.trim() ? { summary } : {}),
          ...(summary.trim() ? {} : { summary: undefined }),
          updatedAt: now
        }
      : conversation
  )
  return {
    ...normalized,
    messages,
    summary,
    conversations,
    activeConversationId: activeId
  }
}

/** Starts a blank session while retaining every existing conversation in node text. */
export function createChatConversation(data: ChatData, now = Date.now()): ChatData {
  const normalized = sessionized(data)
  const existing = normalized.conversations ?? []
  let suffix = 1
  let id = `chat-${now}`
  while (existing.some((conversation) => conversation.id === id)) id = `chat-${now}-${suffix++}`
  const conversation: ChatConversation = {
    id,
    title: `新会话 ${existing.length + 1}`,
    messages: [],
    createdAt: now,
    updatedAt: now
  }
  return {
    ...normalized,
    messages: [],
    summary: '',
    conversations: [...existing, conversation],
    activeConversationId: id
  }
}

/**
 * Editing any message starts a new context branch: retain that message and
 * discard the following turns.  Compression summaries are cleared because they
 * may contain wording from a now-invalid branch.
 */
export function editChatMessage(
  data: ChatData,
  index: number,
  content: string,
  now = Date.now()
): ChatData | null {
  const messages = activeChatConversation(data).messages
  if (index < 0 || index >= messages.length || !content.trim()) return null
  const next = messages.slice(0, index + 1)
  const previous = next[index]
  // Reasoning is an immutable model-originated artifact. Once an assistant
  // message is manually edited it no longer describes that message, so do not
  // misrepresent it as real model reasoning.
  next[index] =
    previous.role === 'assistant'
      ? { role: 'assistant', content: content.trim() }
      : { ...previous, content: content.trim() }
  return updateActiveChatConversation(data, next, '', now)
}

/**
 * Regeneration always restarts from the user turn that produced the assistant
 * reply.  The executor then sees a pending user message and owns model calls.
 */
export function prepareChatRegeneration(
  data: ChatData,
  assistantIndex: number,
  now = Date.now()
): ChatData | null {
  const messages = activeChatConversation(data).messages
  if (messages[assistantIndex]?.role !== 'assistant') return null
  let userIndex = assistantIndex - 1
  while (userIndex >= 0 && messages[userIndex]?.role !== 'user') userIndex -= 1
  if (userIndex < 0) return null
  return updateActiveChatConversation(data, messages.slice(0, userIndex + 1), '', now)
}

export function serializeChat(data: ChatData): string {
  return JSON.stringify(data)
}
