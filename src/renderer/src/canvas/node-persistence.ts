// 节点持久化字段的唯一访问入口。
//
// text 是用户正文；config 是节点可编辑的固定配置；nodeRun/nodeResult 位于 meta。
// 本项目尚未产生需要迁移的用户数据，因此不保留旧字段回退。
//
// CONFIG_NODE_TYPES / usesNodeConfig 的唯一事实来源在 @shared/engine/node-config。
// 此前 renderer 维护了第二份清单且漏掉 'tts'（shared 17 项 / renderer 16 项），
// TTS 节点的固定配置可能因此不随图持久化——已统一为单一导出，禁止再造副本。
import type { NodeCardShape } from './NodeCardShape'

export { CONFIG_NODE_TYPES, usesNodeConfig } from '@shared/engine/node-config'

/** 读取固定配置。 */
export function readNodeConfig(shape: Pick<NodeCardShape, 'props'>): string {
  return shape.props.config
}
