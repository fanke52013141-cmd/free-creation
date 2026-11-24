// O2：只读"待你处理"收件箱聚合。从画布节点派生等待人工的节点清单——
// 纯函数，不写任何状态、不改交互；仅供侧栏收件箱展示与导航。
//
// A1：来源扩到三类，且只认"真的在等人"：
//  1) human-task 节点（status=pending 待提交结果）；
//  2) collaborative 专业 Agent（任务 waiting 且 waitReason/waitKind=human 待人工确认/讨论）；
//  3) 主控 Agent（任务 waiting 且 waitReason=human，即阶段待人工采用或人工确认）。
// A3 引入的 waitReason 优先于旧 waitKind：'active-child'/'pending-review'/'blocked'/'paused'
// 都不是人工待办，不能出现在收件箱里，否则人会一直被迫盯着"假待办"。
import { AgentNodeConfigSchema, HumanTaskInstanceSchema } from './node-contracts'

export interface HumanInboxShape {
  id: string
  props: { nodeType: string; title?: string; config?: string }
  meta?: Record<string, unknown>
}

export interface HumanInboxItem {
  nodeId: string
  title: string
  kind: 'human-task' | 'collaborative-agent' | 'coordinator' | 'review' | 'input'
  reason: string
}

/** 运行总览里"需要你处理"的一步（deriveFlowSteps 的子集，便于纯函数复用）。 */
export interface HumanInboxStep {
  nodeId: string
  title: string
  kind: string
  state?: string
  needsYou?: boolean
}

/** A1：把运行总览里 needsYou 的步骤转成收件箱条目（审核人工复审、返工确认等不在画布 meta 里的事实）。 */
export function humanInboxFromSteps(steps: readonly HumanInboxStep[]): HumanInboxItem[] {
  const items: HumanInboxItem[] = []
  for (const step of steps) {
    if (!step.needsYou) continue
    if (step.kind === 'review') {
      items.push({
        nodeId: step.nodeId,
        title: step.title,
        kind: 'review',
        reason: '待人工复审 / 返工确认'
      })
      continue
    }
    if (step.kind === 'human-task') {
      items.push({ nodeId: step.nodeId, title: step.title, kind: 'human-task', reason: '待提交人工结果' })
      continue
    }
    items.push({
      nodeId: step.nodeId,
      title: step.title,
      kind: 'collaborative-agent',
      reason: '待人工确认 / 讨论'
    })
  }
  return items
}

/** 合并两路来源并按节点去重：前者优先（画布实时事实优先于上一帧总览）。 */
export function mergeHumanInbox(
  primary: readonly HumanInboxItem[],
  extra: readonly HumanInboxItem[]
): HumanInboxItem[] {
  const seen = new Set(primary.map((item) => item.nodeId))
  return [...primary, ...extra.filter((item) => !seen.has(item.nodeId))]
}

/**
 * 需要人补材料的稳定错误码：这些是"流程停在这里等人给输入"，不是技术失败。
 * 只有命中它们才进收件箱，避免把普通失败也变成假待办。
 */
const MISSING_INPUT_CODES = new Set([
  'FLOW_CONTEXT_REQUIRED_MISSING',
  'FLOW_CONTEXT_OVER_BUDGET',
  'FLOW_STAGE_ENTRY_UNMET',
  'AGENT_INPUT_INVALID',
  'FLOW_INPUT_REQUIRED'
])

/** A1：运行总览 → 收件箱。needsYou 的步骤按类型归类；缺必需材料的阻塞单独标"待补输入"。 */
export function humanInboxFromOverview(
  overview: { nodeId: string; state?: string; code?: string },
  steps: readonly HumanInboxStep[]
): HumanInboxItem[] {
  const items = humanInboxFromSteps(steps)
  if (overview.code && MISSING_INPUT_CODES.has(overview.code) && overview.state === 'blocked') {
    items.push({
      nodeId: overview.nodeId,
      title: '主控流程',
      kind: 'input',
      reason: `待补充输入（${overview.code}）`
    })
  }
  return items
}

function parseJson(raw: unknown): unknown {
  if (typeof raw !== 'string' || !raw.trim()) return null
  try {
    return JSON.parse(raw)
  } catch {
    return null
  }
}

/** 任务是否真的在等人：waitReason 优先，缺省回退到旧 waitKind。 */
function waitsForHuman(
  task: { state?: string; waitKind?: string; waitReason?: string } | null
): boolean {
  if (!task || task.state !== 'waiting') return false
  if (typeof task.waitReason === 'string') return task.waitReason === 'human'
  return task.waitKind === 'human'
}

/** 派生等待人工的节点清单（只读）。顺序保持画布形状顺序，便于稳定渲染。 */
export function deriveHumanInbox(shapes: readonly HumanInboxShape[]): HumanInboxItem[] {
  const items: HumanInboxItem[] = []
  for (const shape of shapes) {
    const title = shape.props.title?.trim() || shape.id
    if (shape.props.nodeType === 'human-task') {
      const parsed = HumanTaskInstanceSchema.safeParse(parseJson(shape.meta?.humanTask))
      // 无实例视为尚未提交（pending）；已完成不进入收件箱。
      const status = parsed.success ? parsed.data.status : 'pending'
      if (status === 'pending') {
        items.push({ nodeId: shape.id, title, kind: 'human-task', reason: '待提交人工结果' })
      }
      continue
    }
    if (shape.props.nodeType === 'agent') {
      const config = AgentNodeConfigSchema.safeParse(parseJson(shape.props.config))
      if (!config.success) continue
      const task = parseJson(shape.meta?.agentTask) as {
        state?: string
        waitKind?: string
        waitReason?: string
      } | null
      if (!waitsForHuman(task)) continue
      if (config.data.role === 'coordinator') {
        items.push({
          nodeId: shape.id,
          title,
          kind: 'coordinator',
          reason: '阶段待人工采用 / 确认'
        })
        continue
      }
      if (config.data.interactionMode !== 'collaborative') continue
      items.push({
        nodeId: shape.id,
        title,
        kind: 'collaborative-agent',
        reason: '待人工确认 / 讨论'
      })
    }
  }
  return items
}