// ===== 自定义节点的类型注册（遵循《开发规范-铁律v1.0》第四部分）=====
// 关键：通过 module augmentation 把自定义 shape 类型注册进 tldraw 的类型系统。

import type { TLBaseShape } from 'tldraw'

/** 单条聊天消息 */
export interface ChatMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
  /** 该消息是否引用了上游节点的输出（用于溯源展示）*/
  fromRef?: boolean
}

// 节点类型常量
export const CHAT_TYPE = 'chat-node' as const
export const TEXT_TYPE = 'text-asset' as const

/** 聊天节点 props */
export interface ChatNodeProps {
  w: number
  h: number
  title: string
  systemPrompt: string
  modelId: string
  temperature: number
  maxTokens: number
  messagesJson: string
  contextRef: string
  runState: string
  lastError: string
}

/** 文本资产节点 props */
export interface TextAssetProps {
  w: number
  h: number
  text: string
}

// 模块增强：把自定义 shape 的 props 注册进 tldraw schema
declare module '@tldraw/tlschema' {
  export interface TLGlobalShapePropsMap {
    [CHAT_TYPE]: ChatNodeProps
    [TEXT_TYPE]: TextAssetProps
  }
}

/** 聊天节点 shape（对话沉淀于此）*/
export type ChatNodeShape = TLBaseShape<typeof CHAT_TYPE, ChatNodeProps>

/** 文本资产节点 shape */
export type TextAssetShape = TLBaseShape<typeof TEXT_TYPE, TextAssetProps>

/** 所有自定义 shape 类型名（工具栏用）*/
export const NODE_TYPES = {
  CHAT: CHAT_TYPE,
  TEXT: TEXT_TYPE,
} as const

/** 解析消息 JSON */
export function parseMessages(json: string): ChatMessage[] {
  if (!json) return []
  try {
    const arr = JSON.parse(json)
    return Array.isArray(arr) ? arr : []
  } catch {
    return []
  }
}

/** 序列化消息 JSON */
export function stringifyMessages(msgs: ChatMessage[]): string {
  return JSON.stringify(msgs)
}
