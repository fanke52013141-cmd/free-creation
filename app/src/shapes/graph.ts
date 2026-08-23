import type { TLShape } from 'tldraw'
import { getDependencyMeta, getInputPort, getNodeInputRefs, isCompatible } from './dependencies'
import { isNodeShape } from './nodeDefinitions'

export type GraphIssueLevel = 'error' | 'warning'

export interface GraphIssue {
  level: GraphIssueLevel
  message: string
}

export interface GraphReport {
  nodeCount: number
  edgeCount: number
  issues: GraphIssue[]
}

export function inspectDataGraph(shapes: TLShape[]): GraphReport {
  const nodes = shapes.filter(isNodeShape)
  const nodeById = new Map<string, TLShape>(nodes.map((node) => [node.id, node]))
  const edges = shapes.map(getDependencyMeta).filter((edge): edge is NonNullable<typeof edge> => Boolean(edge))
  const issues: GraphIssue[] = []

  for (const edge of edges) {
    const source = nodeById.get(edge.sourceId)
    const target = nodeById.get(edge.targetId)
    if (!source || !target) {
      issues.push({ level: 'error', message: '发现指向已删除节点的断链，请在目标节点设置中重新选择输入。' })
      continue
    }
    if (!getInputPort(target.type, edge.targetPort) || !isCompatible(source, target.type, edge.targetPort)) {
      issues.push({ level: 'error', message: `连接 ${source.type} → ${target.type} 的端口类型不兼容。` })
    }
    const expectedRef = getNodeInputRefs(target).find((input) => input.port === edge.targetPort)?.sourceId
    if (expectedRef !== edge.sourceId) {
      issues.push({ level: 'error', message: `连接 ${source.type} → ${target.type} 与目标节点保存的输入引用不一致。` })
    }
  }

  for (const target of nodes) {
    for (const input of getNodeInputRefs(target)) {
      const source = nodeById.get(input.sourceId)
      if (!source) {
        issues.push({ level: 'error', message: `${target.type} 存在已删除的上游输入。` })
        continue
      }
      const hasEdge = edges.some((edge) => edge.sourceId === source.id && edge.targetId === target.id && edge.targetPort === input.port)
      if (!hasEdge) {
        issues.push({ level: 'warning', message: `${target.type} 的 ${input.port} 输入没有对应的数据连线。` })
      }
    }
  }

  const adjacency = new Map<string, string[]>()
  for (const edge of edges) {
    const targets = adjacency.get(edge.sourceId) ?? []
    targets.push(edge.targetId)
    adjacency.set(edge.sourceId, targets)
  }
  const visited = new Set<string>()
  const active = new Set<string>()
  const walk = (nodeId: string): boolean => {
    if (active.has(nodeId)) return true
    if (visited.has(nodeId)) return false
    visited.add(nodeId)
    active.add(nodeId)
    const circular = (adjacency.get(nodeId) ?? []).some(walk)
    active.delete(nodeId)
    return circular
  }
  if (nodes.some((node) => walk(node.id))) {
    issues.push({ level: 'error', message: '发现环路依赖，节点无法按拓扑顺序执行。' })
  }

  return { nodeCount: nodes.length, edgeCount: edges.length, issues }
}
