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
export const ONE_SHOT_TYPE = 'one-shot' as const
export const SPLIT_TYPE = 'split' as const
export const MERGE_TYPE = 'merge' as const
export const IMAGE_ASSET_TYPE = 'image-asset' as const
export const IMAGE_GEN_TYPE = 'image-gen' as const
export const VIDEO_GEN_TYPE = 'video-gen' as const
export type NodeRunState = 'idle' | 'dirty' | 'queued' | 'running' | 'done' | 'error' | 'canceled'

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

export interface OneShotNodeProps {
  w: number
  h: number
  title: string
  promptTemplate: string
  modelId: string
  temperature: number
  maxTokens: number
  inputRef: string
  outputText: string
  runState: string
  lastError: string
}

export interface SplitNodeProps {
  w: number
  h: number
  inputRef: string
  delimiter: string
  itemsJson: string
  runState: string
  lastError: string
}

export interface MergeNodeProps {
  w: number
  h: number
  inputRef: string
  separator: string
  outputText: string
  runState: string
  lastError: string
}

export interface ImageAssetProps {
  w: number
  h: number
  title: string
  sourceUrl: string
  lastError: string
}

export interface ImageGenNodeProps {
  w: number
  h: number
  title: string
  prompt: string
  promptRef: string
  referenceRef: string
  modelId: string
  size: string
  quality: string
  resultUrlsJson: string
  runState: string
  lastError: string
}

export interface VideoGenNodeProps {
  w: number
  h: number
  title: string
  prompt: string
  promptRef: string
  referenceRef: string
  modelId: string
  resolution: string
  duration: number
  taskId: string
  resultUrlsJson: string
  runState: string
  progress: number
  lastError: string
}

// 模块增强：把自定义 shape 的 props 注册进 tldraw schema
declare module '@tldraw/tlschema' {
  export interface TLGlobalShapePropsMap {
    [CHAT_TYPE]: ChatNodeProps
    [TEXT_TYPE]: TextAssetProps
    [ONE_SHOT_TYPE]: OneShotNodeProps
    [SPLIT_TYPE]: SplitNodeProps
    [MERGE_TYPE]: MergeNodeProps
    [IMAGE_ASSET_TYPE]: ImageAssetProps
    [IMAGE_GEN_TYPE]: ImageGenNodeProps
    [VIDEO_GEN_TYPE]: VideoGenNodeProps
  }
}

/** 聊天节点 shape（对话沉淀于此）*/
export type ChatNodeShape = TLBaseShape<typeof CHAT_TYPE, ChatNodeProps>

/** 文本资产节点 shape */
export type TextAssetShape = TLBaseShape<typeof TEXT_TYPE, TextAssetProps>
export type OneShotNodeShape = TLBaseShape<typeof ONE_SHOT_TYPE, OneShotNodeProps>
export type SplitNodeShape = TLBaseShape<typeof SPLIT_TYPE, SplitNodeProps>
export type MergeNodeShape = TLBaseShape<typeof MERGE_TYPE, MergeNodeProps>
export type ImageAssetShape = TLBaseShape<typeof IMAGE_ASSET_TYPE, ImageAssetProps>
export type ImageGenNodeShape = TLBaseShape<typeof IMAGE_GEN_TYPE, ImageGenNodeProps>
export type VideoGenNodeShape = TLBaseShape<typeof VIDEO_GEN_TYPE, VideoGenNodeProps>

/** 所有自定义 shape 类型名（工具栏用）*/
export const NODE_TYPES = {
  CHAT: CHAT_TYPE,
  TEXT: TEXT_TYPE,
  ONE_SHOT: ONE_SHOT_TYPE,
  SPLIT: SPLIT_TYPE,
  MERGE: MERGE_TYPE,
  IMAGE_ASSET: IMAGE_ASSET_TYPE,
  IMAGE_GEN: IMAGE_GEN_TYPE,
  VIDEO_GEN: VIDEO_GEN_TYPE,
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
