// 节点持久化字段的唯一访问入口。
//
// text 是用户正文；config 是节点可编辑的固定配置；nodeRun/nodeResult 位于 meta。
// 本项目尚未产生需要迁移的用户数据，因此不保留旧字段回退。
import type { NodeCardShape } from './NodeCardShape'

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
export function readNodeConfig(shape: Pick<NodeCardShape, 'props'>): string {
  return shape.props.config
}
