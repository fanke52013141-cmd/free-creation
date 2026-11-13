// O2：只读"待你处理"收件箱聚合。从画布节点派生等待人工的节点清单——
// 纯函数，不写任何状态、不改交互；仅供侧栏收件箱展示与导航。
// 两类来源：human-task 节点（status=pending 待提交结果）、collaborative Agent 节点
// （任务 waiting 且 waitKind=human 待人工确认/讨论）。
import { AgentNodeConfigSchema, HumanTaskInstanceSchema } from './node-contracts'

export interface HumanInboxShape {
  id: string
  props: { nodeType: string; title?: string; config?: string }
  meta?: Record<string, unknown>
}

export interface HumanInboxItem {
  nodeId: string
  title: string
  kind: 'human-task' | 'collaborative-agent'
  reason: string
}

function parseJson(raw: unknown): unknown {
  if (typeof raw !== 'string' || !raw.trim()) return null
  try {
    return JSON.parse(raw)
  } catch {
    return null
  }
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
      if (!config.success || config.data.interactionMode !== 'collaborative') continue
      const task = parseJson(shape.meta?.agentTask) as {
        state?: string
        waitKind?: string
      } | null
      if (task?.state === 'waiting' && task?.waitKind === 'human') {
        items.push({
          nodeId: shape.id,
          title,
          kind: 'collaborative-agent',
          reason: '待人工确认 / 讨论'
        })
      }
    }
  }
  return items
}