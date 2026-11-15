import type { FlowRunOverview } from '@shared/agent-flow/run-overview'

/** 流程总览：把运行事实（children/reviews）映射回声明式图结构，得到逐步可读的流程。 */
export type FlowStepState =
  | 'completed'
  | 'running'
  | 'waiting-human'
  | 'waiting-reconcile'
  | 'review-pending'
  | 'review-passed'
  | 'rejected'
  | 'blocked'
  | 'failed'
  | 'gated'
  | 'idle'

export interface FlowStep {
  nodeId: string
  title: string
  kind: string
  participation: string
  state: FlowStepState
  roleLabel: string
  detail?: string
  needsYou: boolean
  review?: { round: number; maxReworks: number; feedback?: string; state: string }
  gatedBy?: string
}

export interface FlowNow {
  nodeId: string | null
  title: string
  detail: string
  tone: 'human' | 'review' | 'running' | 'done' | 'failed' | 'idle'
  action: 'collaborate' | 'locate' | null
}

const KIND_ROLE: Record<string, string> = {
  agent: '专业',
  capability: '能力',
  'human-task': '人工',
  review: '审核',
  'state-machine': '状态'
}

export const STATE_META: Record<FlowStepState, { label: string; glyph: string; color: string }> = {
  completed: { label: '已完成', glyph: '✓', color: '#34d399' },
  running: { label: '执行中', glyph: '●', color: '#fbbf24' },
  'waiting-human': { label: '等待人工', glyph: '◐', color: '#E0A458' },
  'waiting-reconcile': { label: '等待核对', glyph: '◐', color: '#fbbf24' },
  'review-pending': { label: '审核中', glyph: '●', color: '#00AEBD' },
  'review-passed': { label: '审核通过', glyph: '✓', color: '#34d399' },
  rejected: { label: '已驳回→返工', glyph: '⛔', color: '#ff6b6b' },
  blocked: { label: '已阻断', glyph: '⛔', color: '#ff6b6b' },
  failed: { label: '执行失败', glyph: '✕', color: '#ff6b6b' },
  gated: { label: '门禁拦截', glyph: '🔒', color: '#737f8e' },
  idle: { label: '待执行', glyph: '○', color: '#6b7280' }
}

/** 依据边做拓扑排序（Kahn），保持声明顺序作为并列节点的稳定次序。 */
function topoOrder(overview: FlowRunOverview): string[] {
  const graph = overview.graph
  if (!graph) return overview.children.map((child) => child.nodeId)
  const ids = graph.nodes.map((node) => node.nodeId)
  const indegree = new Map<string, number>(ids.map((id) => [id, 0]))
  const next = new Map<string, string[]>(ids.map((id) => [id, []]))
  for (const edge of graph.edges) {
    if (!indegree.has(edge.from) || !indegree.has(edge.to)) continue
    indegree.set(edge.to, (indegree.get(edge.to) ?? 0) + 1)
    next.get(edge.from)!.push(edge.to)
  }
  const queue = ids.filter((id) => (indegree.get(id) ?? 0) === 0)
  const order: string[] = []
  while (queue.length) {
    const id = queue.shift()!
    order.push(id)
    for (const target of next.get(id) ?? []) {
      const remaining = (indegree.get(target) ?? 1) - 1
      indegree.set(target, remaining)
      if (remaining === 0) queue.push(target)
    }
  }
  // 环或不可达节点兜底：按声明顺序补齐，避免总览丢节点。
  for (const id of ids) if (!order.includes(id)) order.push(id)
  return order
}

export function deriveFlowSteps(overview: FlowRunOverview): FlowStep[] {
  const graph = overview.graph
  const childByNode = new Map(overview.children.map((child) => [child.nodeId, child]))
  const reviewByNode = new Map(overview.reviews.map((review) => [review.nodeId, review]))
  const nodeById = new Map((graph?.nodes ?? []).map((node) => [node.nodeId, node]))
  // 每个节点的前驱审核（用于"门禁拦截"判定）。
  const reviewPredecessor = new Map<string, string>()
  for (const edge of graph?.edges ?? []) {
    if (nodeById.get(edge.from)?.kind === 'review') reviewPredecessor.set(edge.to, edge.from)
  }
  const order = topoOrder(overview)
  const steps: FlowStep[] = []
  for (const nodeId of order) {
    const node = nodeById.get(nodeId)
    const kind = node?.kind ?? 'agent'
    const participation = node?.participation ?? 'autonomous'
    const title = node?.title ?? childByNode.get(nodeId)?.goal ?? nodeId
    const roleLabel = kind === 'agent' && participation === 'collaborative' ? '人工协同' : KIND_ROLE[kind] ?? '专业'
    const review = reviewByNode.get(nodeId)
    const child = childByNode.get(nodeId)
    let state: FlowStepState = 'idle'
    let detail: string | undefined
    let needsYou = false
    let reviewInfo: FlowStep['review']
    let gatedBy: string | undefined
    if (kind === 'review') {
      const maxReworks = node?.review?.maxReworks ?? 1
      const round = review?.round ?? 0
      reviewInfo = { round, maxReworks, feedback: review?.feedback, state: review?.state ?? 'ready' }
      if (!review || review.state === 'ready') {
        state = 'idle'
        detail = node?.review?.criteria
      } else if (review.state === 'passed') {
        state = 'review-passed'
      } else if (review.state === 'pending') {
        state = 'review-pending'
      } else if (review.state === 'rejected') {
        state = 'rejected'
        detail = review.feedback ?? '审核未通过，等待返工'
      } else if (review.state === 'human-wait' || review.state === 'manual-wait') {
        state = 'waiting-human'
        needsYou = true
        detail = review.feedback ?? '等待人工返工确认'
      }
    } else if (child) {
      if (child.state === 'completed') state = 'completed'
      else if (child.state === 'running') state = 'running'
      else if (child.state === 'waiting') {
        if (participation === 'collaborative' || kind === 'human-task') {
          state = 'waiting-human'
          needsYou = true
        } else state = 'waiting-reconcile'
      } else if (child.state === 'blocked') state = 'blocked'
      else if (child.state === 'failed') state = 'failed'
      else state = 'idle'
      detail = child.goal
    }
    // 门禁拦截：上游审核未通过且本节点尚未开始。
    const gateReviewId = reviewPredecessor.get(nodeId)
    if (gateReviewId && state === 'idle') {
      const gateReview = reviewByNode.get(gateReviewId)
      if (!gateReview || gateReview.state !== 'passed') {
        state = 'gated'
        gatedBy = nodeById.get(gateReviewId)?.title ?? '审核门禁'
      }
    }
    steps.push({ nodeId, title, kind, participation, state, roleLabel, detail, needsYou, review: reviewInfo, gatedBy })
  }
  return steps
}

export function flowProgress(steps: FlowStep[]): { done: number; total: number; percent: number } {
  const total = steps.length
  const done = steps.filter((step) => step.state === 'completed' || step.state === 'review-passed').length
  return { done, total, percent: total ? Math.round((done / total) * 100) : 0 }
}

/** "当前"横幅：最该被用户看到的一件事（人工阻塞 > 审核返工 > 执行中 > 完成/失败）。 */
export function deriveNow(overview: FlowRunOverview, steps: FlowStep[]): FlowNow {
  const human = steps.find((step) => step.needsYou)
  if (human) {
    return {
      nodeId: human.nodeId,
      title: `${human.title} · ${human.state === 'waiting-human' ? '等待人工' : '需要你处理'}`,
      detail: human.detail ?? '等待你的确认后继续。',
      tone: 'human',
      action: human.kind === 'agent' ? 'collaborate' : 'locate'
    }
  }
  const rejected = steps.find((step) => step.state === 'rejected')
  if (rejected) {
    return {
      nodeId: rejected.nodeId,
      title: `${rejected.title} · 审核驳回，返工中`,
      detail: rejected.detail ?? '审核未通过，等待返工。',
      tone: 'review',
      action: 'locate'
    }
  }
  const running = steps.find((step) => step.state === 'running' || step.state === 'review-pending' || step.state === 'waiting-reconcile')
  if (running) {
    return {
      nodeId: running.nodeId,
      title: `${running.title} · ${STATE_META[running.state].label}`,
      detail: '',
      tone: 'running',
      action: 'locate'
    }
  }
  if (overview.state === 'completed') {
    return { nodeId: null, title: '流程已完成', detail: '', tone: 'done', action: null }
  }
  if (overview.state === 'failed' || overview.state === 'blocked') {
    return { nodeId: overview.nodeId, title: '流程已阻断', detail: overview.code ?? '请核对后重试。', tone: 'failed', action: 'locate' }
  }
  return { nodeId: overview.nodeId, title: overview.paused ? '派发已暂停' : '等待启动', detail: overview.goal, tone: 'idle', action: 'locate' }
}

const EVENT_LABELS: Record<string, string> = {
  'flow.started': '流程启动',
  'flow.completed': '流程完成',
  'flow.paused': '派发暂停',
  'agent.dispatched': '派发子任务',
  'agent.completed': '子任务交付',
  'human.wait': '等待人工',
  'human.continue': '人工继续',
  'review.started': '审核开始',
  'review.passed': '审核通过',
  'review.rejected': '审核驳回',
  'rework.created': '返工任务已创建'
}

export function eventLabel(event: string): string {
  if (EVENT_LABELS[event]) return EVENT_LABELS[event]
  if (event.startsWith('human.')) return '人工操作'
  if (event.includes('review')) return '审核事件'
  if (event.includes('rework')) return '返工事件'
  return event || '协调事件'
}

export function eventTone(event: string, source: 'user' | 'agent'): 'human' | 'review' | 'agent' {
  if (source === 'user' || event.startsWith('human.')) return 'human'
  if (event.includes('review') || event.includes('rework')) return 'review'
  return 'agent'
}