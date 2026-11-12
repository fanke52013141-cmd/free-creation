import { assignCoordinates } from './coordinates'
import { gridLayout } from './grid'
import { detectAgentFlow, layoutLanes } from './lanes'
import { assignRanks, groupByRank } from './layering'
import { orderRanks } from './ordering'
import type {
  LaneId,
  LayoutEdge,
  LayoutMode,
  LayoutNode,
  LayoutOptions,
  LayoutResult,
  ResolvedLayoutMode
} from './types'

export * from './types'
export { detectAgentFlow } from './lanes'

/**
 * 画布布局唯一入口（GUI 智能整理 / graph.layout / graph.patch autoLayout / 内置构建器共用）。
 * auto：存在 agent/state-machine/ai-review → lanes；有数据边 → flow；否则 grid。
 * 空图返回空结果；单节点保持原位。只产出坐标，不修改业务配置。
 */
export function layoutGraph(
  nodes: readonly LayoutNode[],
  edges: readonly LayoutEdge[],
  mode: LayoutMode = 'auto',
  opts: LayoutOptions = {}
): LayoutResult {
  const resolved: ResolvedLayoutMode =
    mode !== 'auto'
      ? mode
      : detectAgentFlow(nodes)
        ? 'lanes'
        : edges.length > 0
          ? 'flow'
          : 'grid'

  const ranks: Record<string, number> = {}
  const lanes: Record<string, LaneId> = {}
  if (nodes.length === 0) return { mode: resolved, positions: [], ranks, lanes }
  if (nodes.length === 1) {
    const only = nodes[0]!
    return {
      mode: resolved,
      positions: [{ id: only.id, x: only.x, y: only.y }],
      ranks: { [only.id]: 0 },
      lanes: { [only.id]: 'none' }
    }
  }

  if (resolved === 'lanes') return layoutLanes(nodes, edges, opts)

  if (resolved === 'grid') {
    const positions = gridLayout(nodes)
    for (const node of nodes) {
      ranks[node.id] = 0
      lanes[node.id] = 'none'
    }
    return { mode: 'grid', positions, ranks, lanes }
  }

  // flow：最长路径分层 + 重心法排序 + 真实尺寸坐标。
  const subRanks = assignRanks(nodes, edges)
  const layers = orderRanks(nodes, edges, groupByRank(nodes, subRanks))
  const inputMinX = Math.min(...nodes.map((node) => node.x))
  const inputMinY = Math.min(...nodes.map((node) => node.y))
  const origin = opts.origin ?? { x: inputMinX, y: inputMinY }
  const assignment = assignCoordinates(layers, nodes, origin, opts)
  for (const node of nodes) {
    ranks[node.id] = subRanks.get(node.id) ?? 0
    lanes[node.id] = 'none'
  }
  return { mode: 'flow', positions: assignment.positions, ranks, lanes }
}