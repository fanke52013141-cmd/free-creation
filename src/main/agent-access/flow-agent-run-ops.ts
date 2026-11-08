// F8（第二批）flowAgents 运行控制：flowAgent.run / pause / stop。
//
// 与 F8 第一批（只读观察）的关键区别：这三个动作会**推进内部 Agent 任务**，
// 所以必须使用启动时创建的那一个宿主实例（见 ./flow-bridge.ts），
// 绝不能另建实例——否则外部与 GUI 会各持一个运行上下文，互相覆盖任务事实。
//
// 安全与准入（与 IPC 入口保持同一套）：
// - run 要求目标项目就是当前活动画布：宿主把命令交付给渲染器，没有活动宿主就没有执行者；
// - start/continue 先执行与 IPC 入口相同的 `assertAgentScopeToolCalling` 预检
//   （技能范围内模型必须已通过工具调用验证）——预检失败发生在任何模型请求之前，
//   付费路径不会被偷偷触发；
// - 请求 schema 直接复用内部的 FlowAgentRunSchema / FlowAgentQuerySchema，
//   包括 continue/reconcile/restore 必须携带观测到的任务与等待修订号；
// - 请求 ID / trace / span 由 main 生成，外部不能自造运行身份。
import { randomUUID } from 'node:crypto'
import {
  FlowAgentQuerySchema,
  FlowAgentRunSchema,
  type FlowAgentView
} from '../../shared/agent-flow/desktop-tasks'
import { AgentRuntimeError } from '../../shared/agent-flow/runtime-contracts'
import type { AccessOperationId } from '../../shared/agent-access/registry'
import { DesktopAccessError } from './desktop'
import { flowAgentAccessPort } from './flow-bridge'

/** 本模块负责的操作；service.ts 只做一次分组委托。 */
export const FLOW_AGENT_RUN_OPERATION_IDS: ReadonlySet<AccessOperationId> = new Set([
  'flowAgent.run',
  'flowAgent.pause',
  'flowAgent.stop'
] as AccessOperationId[])

export interface FlowAgentRunContext {
  activeProjectId: () => string | null
}

/** 准入前失败：明确错误码、无副作用（service 映射为 failed）。 */
function refuse(code: string, detail?: string): never {
  throw new DesktopAccessError(code, false, detail)
}

function fail(error: unknown): never {
  if (error instanceof DesktopAccessError) throw error
  if (error instanceof AgentRuntimeError) throw new DesktopAccessError(error.code, false, error.phase)
  throw error
}

/** 宿主返回 null = 账本里没有这条任务；如实 NOT_FOUND，不编造一个空视图。 */
function requireTask(view: FlowAgentView | null): FlowAgentView {
  if (!view) refuse('NOT_FOUND', 'agent task not found')
  return view
}

export async function runFlowAgentRunOperation(
  operationId: AccessOperationId,
  input: Record<string, unknown>,
  context: FlowAgentRunContext
): Promise<unknown> {
  const port = flowAgentAccessPort()
  if (!port) refuse('FLOW_AGENTS_UNAVAILABLE', 'flow agent host is not running in this instance')
  const projectId = input.projectId as string
  const nodeId = input.nodeId as string

  if (operationId === 'flowAgent.run') {
    // 运行需要渲染器在场：换项目/未打开时如实拒绝，而不是在没有执行者的情况下伪造受理。
    if (context.activeProjectId() !== projectId)
      refuse('ACTIVE_PROJECT_REQUIRED', 'project.open the target canvas first, then retry flowAgent.run')
    const raw = {
      projectId,
      nodeId,
      action: input.action,
      ...(input.eventId !== undefined ? { eventId: input.eventId } : {}),
      ...(input.expectedTaskId !== undefined ? { expectedTaskId: input.expectedTaskId } : {}),
      ...(input.expectedWaitRevision !== undefined
        ? { expectedWaitRevision: input.expectedWaitRevision }
        : {}),
      // 运行身份由 main 生成：外部不能自造 requestId/traceId/spanId。
      requestId: randomUUID(),
      traceId: randomUUID(),
      spanId: randomUUID()
    }
    const parsed = FlowAgentRunSchema.safeParse(raw)
    if (!parsed.success)
      refuse('INVALID_INPUT', parsed.error.issues[0]?.path.join('.') ?? 'flowAgent.run')
    if (['start', 'continue'].includes(parsed.data.action)) {
      try {
        await port.assertAgentScopeToolCalling(projectId, nodeId)
      } catch (error) {
        // 预检失败 = 未发生任何模型请求；如实返回同一错误码（与 GUI 一致）。
        fail(error)
      }
    }
    let reply: unknown
    try {
      reply = await port.run(parsed.data)
    } catch (error) {
      fail(error)
    }
    const shaped = reply as { task?: FlowAgentView; refs?: unknown; outputs?: unknown } | null
    if (!shaped || !shaped.task || typeof shaped.task !== 'object')
      refuse('FLOW_AGENT_REPLY_INVALID', 'host reply missing task view')
    return {
      projectId,
      nodeId,
      task: shaped.task,
      refs: Array.isArray(shaped.refs) ? shaped.refs.slice(0, 64) : [],
      outputs:
        shaped.outputs && typeof shaped.outputs === 'object'
          ? (shaped.outputs as Record<string, unknown>)
          : {}
    }
  }

  // pause / stop：只按 (projectId, nodeId) 定位账本里的那条任务。
  const query = FlowAgentQuerySchema.safeParse({ projectId, nodeId })
  if (!query.success) refuse('INVALID_INPUT', 'projectId/nodeId')
  let view: FlowAgentView | null
  try {
    view = (operationId === 'flowAgent.pause'
      ? port.pause(query.data)
      : port.stop(query.data)) as FlowAgentView | null
  } catch (error) {
    fail(error)
  }
  return { projectId, nodeId, task: requireTask(view) }
}
