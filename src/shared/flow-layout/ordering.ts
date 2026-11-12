import type { LayoutEdge, LayoutNode } from './types'

/**
 * 层内排序（Sugiyama 第二步）：重心法 4 轮往返扫描最小化交叉。
 * 初始序与所有 tie-break 均按 (title, id) 字典序——同输入必同输出。
 * 无邻居的节点以当前索引为重心，保持相对位置稳定。
 */
export function orderRanks(
  nodes: readonly LayoutNode[],
  edges: readonly LayoutEdge[],
  layers: readonly string[][]
): string[][] {
  const ids = new Set(nodes.map((node) => node.id))
  const valid = edges.filter((edge) => ids.has(edge.from) && ids.has(edge.to))
  const byId = new Map(nodes.map((node) => [node.id, node]))
  const predecessors = new Map<string, string[]>()
  const successors = new Map<string, string[]>()
  for (const node of nodes) {
    predecessors.set(node.id, [])
    successors.set(node.id, [])
  }
  for (const edge of valid) {
    successors.get(edge.from)!.push(edge.to)
    predecessors.get(edge.to)!.push(edge.from)
  }

  const ordered = layers.map((layer) => [...layer])
  const compare = (a: string, b: string): number => {
    const na = byId.get(a)
    const nb = byId.get(b)
    const ta = na?.title ?? ''
    const tb = nb?.title ?? ''
    if (ta !== tb) return ta < tb ? -1 : 1
    return a < b ? -1 : a > b ? 1 : 0
  }
  for (const layer of ordered) layer.sort(compare)

  const sweep = (forward: boolean): void => {
    const range = forward
      ? Array.from({ length: ordered.length }, (_, i) => i)
      : Array.from({ length: ordered.length }, (_, i) => ordered.length - 1 - i)
    for (const r of range) {
      const neighborLayer = ordered[forward ? r - 1 : r + 1]
      if (!neighborLayer || neighborLayer.length === 0) continue
      const position = new Map(neighborLayer.map((id, index) => [id, index]))
      const neighbors = forward ? predecessors : successors
      const barycenter = new Map<string, number>()
      for (const [index, id] of ordered[r]!.entries()) {
        const near = (neighbors.get(id) ?? []).filter((n) => position.has(n))
        barycenter.set(
          id,
          near.length > 0
            ? near.reduce((sum, n) => sum + (position.get(n) ?? 0), 0) / near.length
            : index
        )
      }
      ordered[r]!.sort((a, b) => {
        const diff = (barycenter.get(a) ?? 0) - (barycenter.get(b) ?? 0)
        return diff !== 0 ? diff : compare(a, b)
      })
    }
  }
  for (let round = 0; round < 4; round++) {
    sweep(true)
    sweep(false)
  }
  return ordered
}