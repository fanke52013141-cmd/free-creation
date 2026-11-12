import type { LayoutEdge, LayoutNode } from './types'

/**
 * 最长路径分层（Sugiyama 第一步）。
 * - DAG：rank(v) = max(rank(u)+1)，源节点 rank=0。
 * - 环：Kahn 剩余节点（环内/环下游）统一排到已分层最大值 +1，布局不报错
 *   （执行校验仍按既有口径拒绝环，职责不变）。
 * - 孤立节点（无任何边）：排到最右列（当前最大 rank +1）。
 * 只保留两端都存在的边；自环按环处理。
 */
export function assignRanks(
  nodes: readonly LayoutNode[],
  edges: readonly LayoutEdge[]
): Map<string, number> {
  const ids = new Set(nodes.map((node) => node.id))
  const valid = edges.filter((edge) => ids.has(edge.from) && ids.has(edge.to))
  const outgoing = new Map<string, string[]>()
  const incoming = new Map<string, string[]>()
  const indegree = new Map<string, number>()
  for (const node of nodes) {
    outgoing.set(node.id, [])
    incoming.set(node.id, [])
    indegree.set(node.id, 0)
  }
  for (const edge of valid) {
    outgoing.get(edge.from)!.push(edge.to)
    incoming.get(edge.to)!.push(edge.from)
    indegree.set(edge.to, (indegree.get(edge.to) ?? 0) + 1)
  }

  const ranks = new Map<string, number>()
  // 确定性起点：id 字典序入队。
  const queue = nodes
    .filter((node) => (indegree.get(node.id) ?? 0) === 0)
    .map((node) => node.id)
    .sort()
  for (const id of queue) ranks.set(id, 0)
  while (queue.length > 0) {
    const id = queue.shift()!
    const rank = ranks.get(id) ?? 0
    for (const next of outgoing.get(id) ?? []) {
      ranks.set(next, Math.max(ranks.get(next) ?? 0, rank + 1))
      const left = (indegree.get(next) ?? 1) - 1
      indegree.set(next, left)
      if (left === 0) queue.push(next)
    }
  }

  const assigned = [...ranks.values()]
  const maxAssigned = assigned.length > 0 ? Math.max(...assigned) : -1
  // 环内/环下游节点：统一一层，保持确定性。
  const cyclic = nodes.filter((node) => !ranks.has(node.id)).map((node) => node.id).sort()
  for (const id of cyclic) ranks.set(id, maxAssigned + 1)

  const connected = new Set<string>()
  for (const edge of valid) {
    connected.add(edge.from)
    connected.add(edge.to)
  }
  const afterCyclic = Math.max(...[...ranks.values()], -1)
  const isolated = nodes
    .filter((node) => !connected.has(node.id))
    .map((node) => node.id)
    .sort()
  for (const id of isolated) ranks.set(id, afterCyclic + 1)
  return ranks
}

/** 按 rank 分组（层号连续化，空层不产生）。 */
export function groupByRank(
  nodes: readonly LayoutNode[],
  ranks: Map<string, number>
): string[][] {
  const used = [...new Set(nodes.map((node) => ranks.get(node.id) ?? 0))].sort((a, b) => a - b)
  const remap = new Map(used.map((rank, index) => [rank, index]))
  const layers: string[][] = used.map(() => [])
  for (const node of nodes) {
    const layer = remap.get(ranks.get(node.id) ?? 0) ?? 0
    layers[layer]!.push(node.id)
  }
  return layers
}