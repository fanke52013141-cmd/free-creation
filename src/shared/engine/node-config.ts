// 节点配置读取（从 renderer/canvas/node-persistence.ts 抽出的纯函数部分）
import type { NodeShape } from './executor-types'

export const CONFIG_NODE_TYPES = new Set([
  'image-gen',
  'image-crop',
  'image-split',
  'image-edit',
  'video',
  'video-frame',
  'video-clip',
  'video-audio',
  'vocal-separate',
  'speech',
  'tts',
  'processor',
  'structured',
  'code',
  'ai-process',
  'iterate',
  'director'
])

export function usesNodeConfig(nodeType: string): boolean {
  return CONFIG_NODE_TYPES.has(nodeType)
}

/** 读取固定配置。 */
export function readNodeConfig(shape: Pick<NodeShape, 'props'>): string {
  return shape.props.config
}
