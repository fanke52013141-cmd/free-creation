import type { NodeShape } from './executor-types'

/** 只有这些节点可以把媒体引用作为自身定义的一部分持久化。 */
const ASSET_NODE_TYPES = new Set(['image', 'audio', 'video-asset'])
const OPERATION_FORBIDDEN_FIELDS: Array<keyof NodeShape['props']> = [
  'mediaId',
  'mediaPath',
  'mediaMime',
  'title'
]

/**
 * 执行器写回底线：操作节点的身份与配置不能被某次运行结果替换。
 * 返回原因而不是抛错，便于 renderer/headless 使用各自的错误通道处理。
 */
export function operationPatchViolation(
  nodeType: string,
  patch: Partial<NodeShape['props']>
): string | null {
  if (ASSET_NODE_TYPES.has(nodeType)) return null
  const fields = OPERATION_FORBIDDEN_FIELDS.filter((field) => field in patch)
  return fields.length > 0
    ? `操作节点“${nodeType}”不得在执行时写回 ${fields.join('、')}；请通过 emitArtifact 创建独立资产节点`
    : null
}

export function isAssetNodeType(nodeType: string): boolean {
  return ASSET_NODE_TYPES.has(nodeType)
}
