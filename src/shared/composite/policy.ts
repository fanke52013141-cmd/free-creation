import type { CompositeExecutionPolicy, CompositeManifest } from './manifest'

/** NF-8.4 / NF-8.5 的运行策略解析：GUI 隔离执行与测试共用同一份缺省。 */
export type CompositeBranchFailure = 'fail-fast' | 'continue'

export interface ResolvedCompositeExecutionPolicy {
  onBranchFailure: CompositeBranchFailure
  maxConcurrency: number
}

/** 与 NODE_FLOW_SPEC NF-8.5 一致：内部并发的硬上限。 */
export const COMPOSITE_MAX_CONCURRENCY = 4

export function resolveCompositeExecutionPolicy(
  policy?: CompositeExecutionPolicy
): ResolvedCompositeExecutionPolicy {
  const onBranchFailure: CompositeBranchFailure =
    policy?.onBranchFailure === 'continue' ? 'continue' : 'fail-fast'
  const raw = policy?.maxConcurrency ?? 1
  const maxConcurrency = Math.min(
    COMPOSITE_MAX_CONCURRENCY,
    Math.max(1, Number.isFinite(raw) ? Math.floor(raw) : 1)
  )
  return { onBranchFailure, maxConcurrency }
}

/** 内部节点 → 直接前驱集合；只统计图内数据边，忽略图外节点。 */
export function compositePredecessors(
  graph: Pick<CompositeManifest, 'graph'>
): Map<string, Set<string>> {
  const predecessors = new Map<string, Set<string>>()
  for (const node of graph.graph.nodes) predecessors.set(node.id, new Set())
  for (const edge of graph.graph.edges) {
    const set = predecessors.get(edge.to.nodeId)
    if (set) set.add(edge.from.nodeId)
  }
  return predecessors
}

/**
 * 失败节点的传递下游（含直接下游）。continue 策略下这些节点不再调度，
 * 因为它们的输入来自失败分支；无关分支继续执行。
 */
export function compositeDownstreamOf(
  nodeId: string,
  predecessors: ReadonlyMap<string, Set<string>>
): Set<string> {
  const children = new Map<string, Set<string>>()
  for (const [child, parents] of predecessors) {
    for (const parent of parents) {
      const set = children.get(parent) ?? new Set<string>()
      set.add(child)
      children.set(parent, set)
    }
  }
  const downstream = new Set<string>()
  const queue = [nodeId]
  while (queue.length > 0) {
    const current = queue.shift()!
    for (const child of children.get(current) ?? []) {
      if (downstream.has(child)) continue
      downstream.add(child)
      queue.push(child)
    }
  }
  return downstream
}

/**
 * 按拓扑顺序挑选下一批可调度节点（最多 limit 个）。
 * 已落定（settled）、已阻塞（blocked）或正在运行（running）的节点会被跳过；
 * 只有全部前驱已落定的节点才就绪。返回顺序与拓扑顺序一致，与并发完成顺序无关。
 */
export function nextSchedulableNodes(
  topologicalOrder: readonly string[],
  predecessors: ReadonlyMap<string, Set<string>>,
  state: {
    settled: ReadonlySet<string>
    blocked: ReadonlySet<string>
    running: ReadonlySet<string>
    limit: number
  }
): string[] {
  const ready: string[] = []
  if (state.limit <= 0) return ready
  for (const nodeId of topologicalOrder) {
    if (ready.length >= state.limit) break
    if (state.settled.has(nodeId) || state.blocked.has(nodeId) || state.running.has(nodeId)) continue
    const parents = predecessors.get(nodeId) ?? new Set<string>()
    let readyNow = true
    for (const parent of parents) {
      if (!state.settled.has(parent)) {
        readyNow = false
        break
      }
    }
    if (readyNow) ready.push(nodeId)
  }
  return ready
}