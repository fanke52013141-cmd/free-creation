import { beforeEach, describe, expect, it, vi } from 'vitest'

// BL-01 回归：人工决定未生效时必须有唯一终态诊断事件，且只记操作身份/错误码/原因，
// 不把确认框里的业务内容、提示词或密钥写进日志。写入失败也不能改变业务结果。
interface EmittedEvent {
  event: string
  message: string
  options: { status?: string; attributes?: Record<string, unknown> }
}

const hoisted = vi.hoisted(() => ({
  emitted: [] as EmittedEvent[],
  failWrites: { value: false }
}))

vi.mock('../src/main/diagnostics/ipc-domain-events', () => ({
  emitDomainEvent: (event: string, message: string, options: EmittedEvent['options']) => {
    if (hoisted.failWrites.value) throw new Error('diagnostics unavailable')
    hoisted.emitted.push({ event, message, options })
  }
}))

import { requestHumanDecision } from '../src/main/agent-access/human-decision'

const PROMPT_TEXT = '人工任务「人工审核」的正文：这段内容不应进入日志'

function desktop(reply: unknown): never {
  return { ask: vi.fn(async () => reply) } as never
}

function call(options: {
  desktopValue?: never
  activeProjectId?: string | null
  timeoutMs?: number
  headless?: boolean
}): ReturnType<typeof requestHumanDecision> {
  return requestHumanDecision({
    operation: 'humanTask.submit',
    desktop: options.desktopValue,
    projectId: 'project-1',
    activeProjectId: options.activeProjectId === undefined ? 'project-1' : options.activeProjectId,
    prompt: {
      title: '外部 Agent 请求代你提交人工任务',
      message: PROMPT_TEXT,
      confirmText: '允许提交'
    },
    ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
    ...(options.headless !== undefined ? { headless: options.headless } : {})
  })
}

describe('人工决定的唯一终态诊断事件', () => {
  beforeEach(() => {
    hoisted.emitted.length = 0
    hoisted.failWrites.value = false
  })

  it('人拒绝：返回 HUMAN_DENIED 并记录操作身份/错误码/原因', async () => {
    const result = await call({ desktopValue: desktop({ authorized: false }) })
    expect(result).toMatchObject({ ok: false, code: 'HUMAN_DENIED' })
    expect(hoisted.emitted).toHaveLength(1)
    expect(hoisted.emitted[0]).toMatchObject({
      event: 'agent.human_decision.rejected',
      options: {
        status: 'failed',
        attributes: { operation: 'humanTask.submit', code: 'HUMAN_DENIED', reason: 'denied' }
      }
    })
  })

  it('真正确认超时：返回 HUMAN_DECISION_TIMEOUT，原因记为 timeout', async () => {
    const result = await call({
      desktopValue: desktop({ authorized: false, code: 'PUBLISH_AUTHORIZATION_EXPIRED' })
    })
    expect(result).toMatchObject({ ok: false, code: 'HUMAN_DECISION_TIMEOUT' })
    expect(hoisted.emitted[0]?.options.attributes).toMatchObject({ reason: 'timeout' })
  })

  it('桌面丢失不是人工超时：返回 DESKTOP_UNAVAILABLE/unavailable', async () => {
    const result = await call({
      desktopValue: desktop({ authorized: false, code: 'DESKTOP_LOST' })
    })
    expect(result).toMatchObject({ ok: false, code: 'DESKTOP_UNAVAILABLE' })
    expect(hoisted.emitted[0]?.options.attributes).toMatchObject({ reason: 'unavailable' })
  })

  it('pure headless 允许 activeProjectId=null，且明确使用 headless 桌面路由', async () => {
    const ask = vi.fn(async () => ({ authorized: true }))
    const result = await requestHumanDecision({
      operation: 'composite.run.submitHuman',
      desktop: { ask } as never,
      projectId: 'headless-run-1',
      activeProjectId: null,
      headless: true,
      prompt: { title: 'headless', message: 'material', confirmText: '允许' }
    })
    expect(result).toEqual({ ok: true })
    expect(ask).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'confirm-sensitive', headless: true }),
      expect.any(Number)
    )
    expect(hoisted.emitted).toEqual([])
  })

  it('没有桌面宿主：返回 DESKTOP_UNAVAILABLE，原因记为 unavailable', async () => {
    const result = await call({ desktopValue: undefined })
    expect(result).toMatchObject({ ok: false, code: 'DESKTOP_UNAVAILABLE' })
    expect(hoisted.emitted[0]?.options.attributes).toMatchObject({ reason: 'unavailable' })
  })

  it('目标画布未打开：返回 ACTIVE_PROJECT_REQUIRED，原因记为 active-project-required', async () => {
    const result = await call({
      desktopValue: desktop({ authorized: false }),
      activeProjectId: 'other'
    })
    expect(result).toMatchObject({ ok: false, code: 'ACTIVE_PROJECT_REQUIRED' })
    expect(hoisted.emitted[0]?.options.attributes).toMatchObject({
      reason: 'active-project-required'
    })
  })

  it('人允许后不记录拒绝事件', async () => {
    const result = await call({ desktopValue: desktop({ authorized: true }) })
    expect(result).toEqual({ ok: true })
    expect(hoisted.emitted).toHaveLength(0)
  })

  it('诊断写入失败不改变业务结果', async () => {
    hoisted.failWrites.value = true
    const result = await call({ desktopValue: desktop({ authorized: false }) })
    expect(result).toMatchObject({ ok: false, code: 'HUMAN_DENIED' })
  })

  it('事件不含确认框正文（提示词/业务内容不进入日志）', async () => {
    await call({ desktopValue: desktop({ authorized: false }) })
    expect(JSON.stringify(hoisted.emitted)).not.toContain(PROMPT_TEXT)
    expect(JSON.stringify(hoisted.emitted)).not.toContain('人工审核')
  })
})
