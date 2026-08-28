import type { CanvasEdge, CanvasNode } from '@shared/types'

/**
 * 返回工作流的拓扑执行顺序；存在环或孤立边引用时返回 null。
 * 使用索引指针出队，复杂度为 O(V + E)，供执行器和性能基准共用同一实现。
 */
export function topoSort(graph: { nodes: CanvasNode[]; edges: CanvasEdge[] }): CanvasNode[] | null {
  const byId = new Map(graph.nodes.map((node) => [node.id, node]))
  const indegree = new Map(graph.nodes.map((node) => [node.id, 0]))
  const adjacency = new Map<string, string[]>()

  for (const edge of graph.edges) {
    if (!byId.has(edge.from.nodeId) || !byId.has(edge.to.nodeId)) continue
    indegree.set(edge.to.nodeId, (indegree.get(edge.to.nodeId) ?? 0) + 1)
    const next = adjacency.get(edge.from.nodeId) ?? []
    next.push(edge.to.nodeId)
    adjacency.set(edge.from.nodeId, next)
  }

  const queue = graph.nodes.filter((node) => indegree.get(node.id) === 0).map((node) => node.id)
  const ordered: string[] = []
  let head = 0

  while (head < queue.length) {
    const id = queue[head++]
    ordered.push(id)
    for (const next of adjacency.get(id) ?? []) {
      indegree.set(next, (indegree.get(next) ?? 1) - 1)
      if (indegree.get(next) === 0) queue.push(next)
    }
  }

  return ordered.length === graph.nodes.length ? ordered.map((id) => byId.get(id)!) : null
}
