import {
  AgentNodeConfigSchema,
  ReviewNodeConfigSchema,
  StateMachineNodeConfigSchema
} from './node-contracts'

export interface FlowDeclarationNode {
  id: string
  type: string
  config: string
  outputPortIds: readonly string[]
}
export interface FlowDeclarationEdge {
  from: { nodeId: string; portId: string }
  to: { nodeId: string; portId: string }
}
export type ControlKind = 'controls' | 'observes' | 'review-gate' | 'rework'
export const CONTROL_LABELS: Record<ControlKind, string> = {
  controls: '允许处理',
  observes: '观察状态',
  'review-gate': '审核放行',
  rework: '反馈返工'
}
export interface FlowControlRelation {
  id: string
  ownerNodeId: string
  sourceNodeId: string
  targetNodeId: string
  kind: ControlKind
}
export interface FlowDeclarationResult {
  relations: FlowControlRelation[]
  issues: string[]
}

/** Derives views from config only; never changes data edges, grants permissions or executes work. */
export function resolveFlowDeclaration(
  owner: FlowDeclarationNode,
  nodes: readonly FlowDeclarationNode[],
  edges: readonly FlowDeclarationEdge[] = []
): FlowDeclarationResult {
  const result: FlowDeclarationResult = { relations: [], issues: [] }
  const schema =
    owner.type === 'agent'
      ? AgentNodeConfigSchema
      : owner.type === 'ai-review'
        ? ReviewNodeConfigSchema
        : owner.type === 'state-machine'
          ? StateMachineNodeConfigSchema
          : null
  if (!schema) return result
  let raw: unknown
  try {
    raw = JSON.parse(owner.config)
  } catch {
    result.issues.push('配置不是有效 JSON')
    return result
  }
  const parsed = schema.safeParse(raw)
  if (!parsed.success) {
    result.issues.push('配置格式或状态转换无效')
    return result
  }
  const config = parsed.data
  const byId = new Map(nodes.map((node) => [node.id, node]))
  const signatures = new Set<string>()
  const relationIds = new Set<string>()
  const add = (kind: ControlKind, targetNodeId: string, relationId: string): void => {
    if (targetNodeId === owner.id || !byId.has(targetNodeId)) {
      result.issues.push('关系目标已删除或指向自身')
      return
    }
    const signature = JSON.stringify([kind, targetNodeId])
    if (signatures.has(signature)) return
    signatures.add(signature)
    result.relations.push({
      id: JSON.stringify([owner.id, relationId]),
      ownerNodeId: owner.id,
      sourceNodeId: owner.id,
      targetNodeId,
      kind
    })
  }
  if ('allowedNodeIds' in config) {
    if (new Set(config.allowedNodeIds).size !== config.allowedNodeIds.length)
      result.issues.push('允许处理的节点重复')
    config.allowedNodeIds.forEach((target) => add('controls', target, `scope:${target}`))
  }
  if ('gatedNodeIds' in config) {
    if (new Set(config.gatedNodeIds).size !== config.gatedNodeIds.length)
      result.issues.push('等待审核的节点重复')
    config.gatedNodeIds.forEach((target) => add('review-gate', target, `gate:${target}`))
    if (config.responsibleNodeId) {
      if (config.rejectPolicy === 'rework') add('rework', config.responsibleNodeId, 'responsible')
      else if (config.responsibleNodeId === owner.id || !byId.has(config.responsibleNodeId))
        result.issues.push('负责修订的节点已删除或指向自身')
    }
    const subjects = new Set<string>()
    for (const source of config.subjectSources) {
      const key = JSON.stringify([source.nodeId, source.portId])
      if (subjects.has(key)) result.issues.push('审核对象来源重复')
      subjects.add(key)
      if (
        !byId.get(source.nodeId)?.outputPortIds.includes(source.portId) ||
        !edges.some(
          (edge) =>
            edge.from.nodeId === source.nodeId &&
            edge.from.portId === source.portId &&
            edge.to.nodeId === owner.id
        )
      ) {
        result.issues.push('审核对象未通过真实数据连接接入')
      }
    }
  }
  for (const relation of config.relations) {
    if (relationIds.has(relation.relationId)) {
      result.issues.push('关系标识重复')
      continue
    }
    relationIds.add(relation.relationId)
    const declared =
      relation.kind === 'observes' ||
      (relation.kind === 'controls' &&
        'allowedNodeIds' in config &&
        config.allowedNodeIds.includes(relation.targetNodeId)) ||
      (relation.kind === 'review-gate' &&
        'gatedNodeIds' in config &&
        config.gatedNodeIds.includes(relation.targetNodeId)) ||
      (relation.kind === 'rework' &&
        'responsibleNodeId' in config &&
        config.rejectPolicy === 'rework' &&
        config.responsibleNodeId === relation.targetNodeId)
    if (relation.sourceNodeId !== owner.id || !declared) {
      result.issues.push('关系来源或控制范围与节点配置不一致')
      continue
    }
    add(relation.kind, relation.targetNodeId, relation.relationId)
  }
  result.issues = [...new Set(result.issues)]
  return result
}
