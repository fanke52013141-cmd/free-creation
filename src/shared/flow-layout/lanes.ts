import { assignCoordinates } from './coordinates'
import { gridLayout } from './grid'
import { assignRanks, groupByRank } from './layering'
import { orderRanks } from './ordering'
import {
  FLOW_LAYOUT_DEFAULTS,
  type LaneId,
  type LayoutEdge,
  type LayoutNode,
  type LayoutOptions,
  type LayoutResult
} from './types'

const AGENT_FLOW_TYPES = new Set(['agent', 'state-machine', 'ai-review'])

export function detectAgentFlow(nodes: readonly LayoutNode[]): boolean {
  return nodes.some((node) => AGENT_FLOW_TYPES.has(node.type))
}

function laneOf(node: LayoutNode): LaneId {
  if (node.type === 'state-machine') return 'control'
  if (node.type === 'ai-review') return 'review'
  if (node.type === 'agent')
    return node.role === 'coordinator' || node.role === 'builder' ? 'control' : 'execution'
  return 'output'
}

interface Placed {
  id: string
  x: number
  y: number
  w: number
  h: number
}

/** 带内水平排布：按期望中心排序，逐个落位并保证不重叠（间距 rowGap）。 */
function placeRow(
  members: readonly LayoutNode[],
  desiredCenter: (node: LayoutNode) => number,
  rowGap: number
): Placed[] {
  const sorted = [...members].sort((a, b) => {
    const diff = desiredCenter(a) - desiredCenter(b)
    if (diff !== 0) return diff
    if (a.title !== b.title) return a.title < b.title ? -1 : 1
    return a.id < b.id ? -1 : 1
  })
  const placed: Placed[] = []
  let prevRight = -Infinity
  for (const node of sorted) {
    const x = Math.max(desiredCenter(node) - node.w / 2, prevRight + rowGap)
    placed.push({ id: node.id, x, y: 0, w: node.w, h: node.h })
    prevRight = x + node.w
  }
  return placed
}

/**
 * agent flow 角色泳道布局：
 * 控制带（状态机+主控/搭建）→ 执行带（专业 Agent，对齐其控制的成果节点）→
 * 成果带（数据链左→右分层，"看得见的流程"）→ 审核带（对齐被门禁节点）。
 * 只产出坐标；角色识别只读 type/role/controls，不修改任何配置。
 */
export function layoutLanes(
  nodes: readonly LayoutNode[],
  edges: readonly LayoutEdge[],
  opts: LayoutOptions = {}
): LayoutResult {
  const columnGap = opts.columnGap ?? FLOW_LAYOUT_DEFAULTS.columnGap
  const rowGap = opts.rowGap ?? FLOW_LAYOUT_DEFAULTS.rowGap
  const bandGap = rowGap * FLOW_LAYOUT_DEFAULTS.bandGapFactor
  const byId = new Map(nodes.map((node) => [node.id, node]))
  const lanes: Record<string, LaneId> = {}
  const bands: Record<'control' | 'execution' | 'output' | 'review', LayoutNode[]> = {
    control: [],
    execution: [],
    output: [],
    review: []
  }
  for (const node of nodes) {
    const lane = laneOf(node)
    lanes[node.id] = lane
    if (lane !== 'none') bands[lane].push(node)
  }

  const ranks: Record<string, number> = {}
  const placed = new Map<string, Placed>()

  // ── 成果带：数据子图 flow 分层（左→右主链）──
  const outputIds = new Set(bands.output.map((node) => node.id))
  const outputEdges = edges.filter((edge) => outputIds.has(edge.from) && outputIds.has(edge.to))
  if (bands.output.length > 0) {
    const subRanks = assignRanks(bands.output, outputEdges)
    const layers = orderRanks(bands.output, outputEdges, groupByRank(bands.output, subRanks))
    const assignment = assignCoordinates(layers, bands.output, { x: 0, y: 0 }, opts)
    for (const pos of assignment.positions) {
      const node = byId.get(pos.id)!
      placed.set(pos.id, { id: pos.id, x: pos.x, y: pos.y, w: node.w, h: node.h })
      ranks[pos.id] = subRanks.get(pos.id) ?? 0
    }
  }
  const centerOf = (id: string): number | null => {
    const p = placed.get(id)
    return p ? p.x + p.w / 2 : null
  }
  const outputRight = Math.max(
    ...[...placed.values()].filter((p) => outputIds.has(p.id)).map((p) => p.x + p.w),
    0
  )

  // ── 执行带：specialist 对齐其控制的成果节点重心 ──
  if (bands.execution.length > 0) {
    if (bands.output.length > 0) {
      const row = placeRow(
        bands.execution,
        (node) => {
          const centers = (node.controls ?? [])
            .map((id) => centerOf(id))
            .filter((c): c is number => c !== null)
          return centers.length > 0
            ? centers.reduce((sum, c) => sum + c, 0) / centers.length
            : outputRight + columnGap + node.w / 2
        },
        rowGap
      )
      for (const p of row) placed.set(p.id, p)
    } else {
      // 无成果节点：执行带自身按数据子图分层。
      const executionIds = new Set(bands.execution.map((node) => node.id))
      const subEdges = edges.filter(
        (edge) => executionIds.has(edge.from) && executionIds.has(edge.to)
      )
      const subRanks = assignRanks(bands.execution, subEdges)
      const layers = orderRanks(bands.execution, subEdges, groupByRank(bands.execution, subRanks))
      const assignment = assignCoordinates(layers, bands.execution, { x: 0, y: 0 }, opts)
      for (const pos of assignment.positions) {
        const node = byId.get(pos.id)!
        placed.set(pos.id, { id: pos.id, x: pos.x, y: pos.y, w: node.w, h: node.h })
      }
    }
  }

  // ── 控制带：状态机 → 主控 → 搭建，左→右 ──
  if (bands.control.length > 0) {
    const order = [...bands.control].sort((a, b) => {
      const rank = (n: LayoutNode): number =>
        n.type === 'state-machine' ? 0 : n.role === 'coordinator' ? 1 : 2
      const diff = rank(a) - rank(b)
      if (diff !== 0) return diff
      if (a.title !== b.title) return a.title < b.title ? -1 : 1
      return a.id < b.id ? -1 : 1
    })
    let x = 0
    for (const node of order) {
      placed.set(node.id, { id: node.id, x, y: 0, w: node.w, h: node.h })
      x += node.w + columnGap
    }
  }

  // ── 审核带：对齐被门禁节点重心 ──
  if (bands.review.length > 0) {
    const row = placeRow(
      bands.review,
      (node) => {
        const centers = (node.controls ?? [])
          .map((id) => centerOf(id))
          .filter((c): c is number => c !== null)
        return centers.length > 0
          ? centers.reduce((sum, c) => sum + c, 0) / centers.length
          : outputRight + columnGap + node.w / 2
      },
      rowGap
    )
    for (const p of row) placed.set(p.id, p)
  }

  // ── 带堆叠：保留带内相对 y（成果带/执行带可能自身分层），带顶对齐 bandTop ──
  const bandOrder: Array<'control' | 'execution' | 'output' | 'review'> = [
    'control',
    'execution',
    'output',
    'review'
  ]
  let bandTop = 0
  for (const band of bandOrder) {
    const members = bands[band]
      .map((node) => placed.get(node.id))
      .filter((p): p is Placed => Boolean(p))
    if (members.length === 0) continue
    const innerMinY = Math.min(...members.map((p) => p.y))
    const innerHeight = Math.max(...members.map((p) => p.y + p.h)) - innerMinY
    for (const p of members) p.y = bandTop + (p.y - innerMinY)
    bandTop += innerHeight + bandGap
  }

  // ── 整体平移到 origin（缺省输入包围盒左上角）──
  const all = [...placed.values()]
  const minX = Math.min(...all.map((p) => p.x))
  const minY = Math.min(...all.map((p) => p.y))
  const inputMinX = Math.min(...nodes.map((node) => node.x))
  const inputMinY = Math.min(...nodes.map((node) => node.y))
  const origin = opts.origin ?? { x: inputMinX, y: inputMinY }
  const positions = all.map((p) => ({
    id: p.id,
    x: Math.round(origin.x + p.x - minX),
    y: Math.round(origin.y + p.y - minY)
  }))
  for (const node of nodes) if (!(node.id in ranks)) ranks[node.id] = 0
  return { mode: 'lanes', positions, ranks, lanes }
}

/** 无 agent flow 节点且无边时的兜底（index 调用）。 */
export function lanesFallbackGrid(nodes: readonly LayoutNode[]): LayoutResult {
  const positions = gridLayout(nodes)
  const ranks: Record<string, number> = {}
  const lanes: Record<string, LaneId> = {}
  for (const node of nodes) {
    ranks[node.id] = 0
    lanes[node.id] = 'none'
  }
  return { mode: 'grid', positions, ranks, lanes }
}