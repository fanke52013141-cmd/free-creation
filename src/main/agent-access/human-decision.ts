import type { AccessDesktop } from './desktop'
import { DesktopAccessError } from './desktop'
import { emitDomainEvent } from '../diagnostics/ipc-domain-events'
import { HUMAN_DECISION_TIMEOUT_MS } from '../../shared/agent-access/interactive'

export { HUMAN_DECISION_TIMEOUT_MS }

/**
 * BL-01 / AF-1.5 / AF-17.2：人工决定类动作必须由人在 GUI 亲眼确认。
 *
 * 外部 Agent（CLI/MCP）调用下列动作时，main 在**任何副作用之前**经 `desktop.ask`
 * 发起 `confirm-sensitive` 交互式请求（复用 GUI 既有确认弹窗；不占用唯一写入槽）：
 * - `flowGraph.confirm`        外部建图落画布
 * - `flowAgent.build.commit`   builder 建图落画布
 * - `humanTask.submit`         代人提交人工任务结果
 * - `flowAgent.cooperate`      协作节点的人工决定（action=submit 或 accepted=true）
 * - `flowAgent.run`            人工等待中的任务继续（action=continue）
 *
 * 只有人点「允许」才继续执行原有同一实现；拒绝/超时/桌面不可用 → 生效前失败（零副作用），
 * 外部拿到稳定错误码。外部没有伪造这一步的通道：确认只来自 renderer 回复通道。
 * 迟到的允许不生效：超时后 requestId 已出队，renderer 的回复被丢弃。
 *
 * 等待上限见 shared/agent-access/interactive：CLI 客户端必须按交互式操作等待，
 * 否则会在人点确认之前用 15s 默认超时误报 OUTCOME_UNKNOWN。
 */

export type HumanDecisionOutcome =
  | { ok: true }
  | {
      ok: false
      code:
        | 'ACTIVE_PROJECT_REQUIRED'
        | 'DESKTOP_UNAVAILABLE'
        | 'HUMAN_DENIED'
        | 'HUMAN_DECISION_TIMEOUT'
      detail: string
    }

/** 拒绝原因（稳定枚举，进入诊断事件；确认框里的业务内容不进入日志）。 */
export type HumanDecisionReason = 'denied' | 'timeout' | 'unavailable' | 'active-project-required'

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

/**
 * 人工决定未生效时的唯一终态：先发诊断事件，再返回稳定错误码。
 * 事件只带操作身份、错误码与原因枚举；不记确认框里的业务内容、提示词或密钥。
 * 诊断写入失败不能改变拒绝本身（业务结果优先）。
 */
function rejection(
  operation: string,
  code: Extract<HumanDecisionOutcome, { ok: false }>['code'],
  reason: HumanDecisionReason,
  detail: string
): HumanDecisionOutcome {
  try {
    emitDomainEvent(
      'agent.human_decision.rejected',
      '人工决定未生效：被拒绝或未在时限内确认，操作没有产生副作用',
      { status: 'failed', attributes: { operation, code, reason } }
    )
  } catch {
    // 诊断不可用不改变业务结果。
  }
  return { ok: false, code, detail }
}

export async function requestHumanDecision(options: {
  /** 外部操作身份（稳定 ID），只用于关联诊断，不含业务内容。 */
  operation: string
  desktop: AccessDesktop | null | undefined
  projectId: string
  activeProjectId: string | null
  prompt: HumanDecisionPrompt
  timeoutMs?: number
}): Promise<HumanDecisionOutcome> {
  const { desktop, projectId, activeProjectId, prompt, operation } = options
  if (activeProjectId !== projectId)
    return rejection(
      operation,
      'ACTIVE_PROJECT_REQUIRED',
      'active-project-required',
      'a human decision needs the target canvas open on the desktop (project.open first)'
    )
  if (!desktop)
    return rejection(
      operation,
      'DESKTOP_UNAVAILABLE',
      'unavailable',
      'no desktop to ask a human for this decision'
    )
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
      return rejection(operation, 'DESKTOP_UNAVAILABLE', 'unavailable', error.code)
    throw error
  }
  if (reply.authorized) return { ok: true }
  if (reply.code === 'PUBLISH_AUTHORIZATION_EXPIRED' || reply.code === 'DESKTOP_LOST')
    return rejection(
      operation,
      'HUMAN_DECISION_TIMEOUT',
      'timeout',
      'nobody confirmed this decision on the desktop in time; nothing was changed'
    )
  return rejection(
    operation,
    'HUMAN_DENIED',
    'denied',
    'the user rejected this decision in the GUI; nothing was changed'
  )
}
