import type { AccessDesktop } from './desktop'
import { DesktopAccessError } from './desktop'

/**
 * BL-01 / AF-1.5 / AF-17.2：人工决定类动作必须由人在 GUI 亲眼确认。
 *
 * 外部 Agent（CLI/MCP）调用下列动作时，main 在**任何副作用之前**经 `desktop.ask`
 * 发起 `confirm-sensitive` 交互式请求（复用 GUI 既有确认弹窗；不占用唯一写入槽）：
 * - `flowGraph.confirm`        外部建图落画布
 * - `flowAgent.build.commit`   builder 建图落画布
 * - `humanTask.submit`         代人提交人工任务结果
 * - `flowAgent.cooperate`      协作节点的人工决定（action=submit 或 accepted=true）
 *
 * 只有人点「允许」才继续执行原有同一实现；拒绝/超时/桌面不可用 → 生效前失败（零副作用），
 * 外部拿到稳定错误码。外部没有伪造这一步的通道：确认只来自 renderer 回复通道。
 * 迟到的允许不生效：超时后 requestId 已出队，renderer 的回复被丢弃。
 */
export const HUMAN_DECISION_TIMEOUT_MS = 5 * 60 * 1000

export type HumanDecisionOutcome =
  | { ok: true }
  | { ok: false; code: 'ACTIVE_PROJECT_REQUIRED' | 'DESKTOP_UNAVAILABLE' | 'HUMAN_DENIED' | 'HUMAN_DECISION_TIMEOUT'; detail: string }

export interface HumanDecisionPrompt {
  title: string
  message: string
  confirmText: string
}

const clip = (value: string, max: number): string =>
  value.length > max ? `${value.slice(0, Math.max(0, max - 1))}…` : value

/** 展示给人的内容摘要：只用于确认框（人需要看到才能决定），不进入日志或诊断事件。 */
export function previewValue(value: unknown, max = 300): string {
  if (typeof value === 'string') return clip(value.trim(), max)
  try {
    return clip(JSON.stringify(value), max)
  } catch {
    return '（无法预览）'
  }
}

/** cooperate 只有「提交成果 / 采纳意见」才是人工决定；note/discuss/revise 是交流。 */
export function cooperateIsHumanDecision(input: { action?: unknown; accepted?: unknown }): boolean {
  return input.action === 'submit' || input.accepted === true
}

export async function requestHumanDecision(options: {
  desktop: AccessDesktop | null | undefined
  projectId: string
  activeProjectId: string | null
  prompt: HumanDecisionPrompt
  timeoutMs?: number
}): Promise<HumanDecisionOutcome> {
  const { desktop, projectId, activeProjectId, prompt } = options
  if (activeProjectId !== projectId)
    return {
      ok: false,
      code: 'ACTIVE_PROJECT_REQUIRED',
      detail: 'a human decision needs the target canvas open on the desktop (project.open first)'
    }
  if (!desktop)
    return { ok: false, code: 'DESKTOP_UNAVAILABLE', detail: 'no desktop to ask a human for this decision' }
  let reply: Awaited<ReturnType<AccessDesktop['ask']>>
  try {
    reply = await desktop.ask(
      {
        action: 'confirm-sensitive',
        projectId,
        confirmTitle: clip(prompt.title, 120),
        confirmMessage: clip(prompt.message, 1000),
        confirmText: clip(prompt.confirmText, 40),
        cancelText: '拒绝'
      } as never,
      options.timeoutMs ?? HUMAN_DECISION_TIMEOUT_MS
    )
  } catch (error) {
    if (error instanceof DesktopAccessError)
      return { ok: false, code: 'DESKTOP_UNAVAILABLE', detail: error.code }
    throw error
  }
  if (reply.authorized) return { ok: true }
  if (reply.code === 'PUBLISH_AUTHORIZATION_EXPIRED' || reply.code === 'DESKTOP_LOST')
    return {
      ok: false,
      code: 'HUMAN_DECISION_TIMEOUT',
      detail: 'nobody confirmed this decision on the desktop in time; nothing was changed'
    }
  return { ok: false, code: 'HUMAN_DENIED', detail: 'the user rejected this decision in the GUI; nothing was changed' }
}
