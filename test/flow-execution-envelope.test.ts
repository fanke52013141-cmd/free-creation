import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  composeExecutionEnvelope,
  envelopeSystemSuffix,
  envelopeUserPrefix,
  ExecutionEnvelopeSchema
} from '../src/shared/agent-flow/execution-envelope'
import { aiProcessExecutor } from '@renderer/engine/executors/aiProcess'
import type { NodeExecutionContext } from '@renderer/engine/executor-types'
import type { GatewayClient } from '@shared/engine/gateway-client'
import type { ProviderConfig } from '@shared/types'
import type { NodeCardShape } from '@renderer/canvas/NodeCardShape'

describe('AF-03 ExecutionEnvelope 纯函数', () => {
  it('全空 → undefined（旧语义不受影响）', () => {
    expect(composeExecutionEnvelope({})).toBeUndefined()
    expect(composeExecutionEnvelope({ stageGoal: '  ' })).toBeUndefined()
  })

  it('构造信封并裁剪空白；Schema 严格', () => {
    const envelope = composeExecutionEnvelope({
      stageGoal: ' 整理材料 ',
      methodInstructions: '先结论后论据',
      humanFeedback: '改用先案例后分析'
    })
    expect(envelope?.stageGoal).toBe('整理材料')
    expect(envelope?.methodInstructions).toBe('先结论后论据')
    expect(ExecutionEnvelopeSchema.safeParse(envelope).success).toBe(true)
    expect(
      ExecutionEnvelopeSchema.safeParse({ schemaVersion: 1, unknown: 'x' }).success
    ).toBe(false)
  })

  it('system 后缀含阶段目标/方法/输出要求；user 前缀含人工意见/返工反馈', () => {
    const envelope = composeExecutionEnvelope({
      stageGoal: '写交付稿',
      methodInstructions: '先案例后分析',
      outputRequirements: '必须含三段',
      humanFeedback: '补充数据来源',
      reworkFeedback: '删除冗余段落'
    })
    const system = envelopeSystemSuffix(envelope)
    expect(system).toContain('写交付稿')
    expect(system).toContain('先案例后分析')
    expect(system).toContain('必须含三段')
    const prefix = envelopeUserPrefix(envelope)
    expect(prefix).toContain('补充数据来源')
    expect(prefix).toContain('删除冗余段落')
    expect(envelopeSystemSuffix(undefined)).toBe('')
    expect(envelopeUserPrefix(undefined)).toBe('')
  })
})

// ── 执行器请求夹具：验证方法/反馈真正进入最终模型请求 ──
const provider: ProviderConfig = {
  id: 'p1',
  name: '测试供应商',
  specId: 'openai-compatible',
  baseURL: 'https://example.com',
  apiKey: 'k',
  models: [{ id: 'm1', name: '模型1', modality: 'text', providerId: 'p1' }]
} as ProviderConfig

let captured: Array<{ system?: string; messages?: Array<{ role: string; content: string }> }> = []
function installCaptureGateway(reply: string): void {
  captured = []
  const gateway = {
    chatStart: vi.fn().mockImplementation(async (request: Record<string, unknown>) => {
      captured.push(request as never)
      return { ok: true, data: { taskId: 'task-1' } }
    }),
    chatCancel: vi.fn().mockResolvedValue({ ok: true, data: true }),
    onEvent: vi.fn((cb: (event: Record<string, unknown>) => void) => {
      setTimeout(() => {
        cb({ kind: 'chat-delta', taskId: 'task-1', text: reply })
        cb({ kind: 'chat-done', taskId: 'task-1' })
      }, 0)
      return () => {}
    })
  }
  currentGateway = gateway as unknown as GatewayClient
}
let currentGateway: GatewayClient = {} as GatewayClient

function makeCtx(envelope?: NodeExecutionContext['executionEnvelope']): NodeExecutionContext {
  const shape = {
    id: 'shape:1',
    type: 'node-card',
    props: {
      w: 340,
      h: 260,
      nodeType: 'ai-process',
      title: 'n',
      config: JSON.stringify({ modelKey: 'p1::m1', system: '你是写作助手', mode: 'text' }),
      text: '',
      mediaId: '',
      mediaPath: '',
      mediaMime: '',
      exec: 'idle'
    },
    meta: {}
  } as unknown as NodeCardShape
  return {
    node: {
      id: 'shape:1',
      type: 'ai-process',
      contractVersion: 1,
      title: 'n',
      x: 0,
      y: 0,
      w: 340,
      h: 260,
      ports: [],
      params: {},
      content: { kind: 'empty' },
      exec: { status: 'idle' },
      meta: { source: 'input', createdAt: 0 }
    },
    shape,
    inputs: new Map([
      [
        'in-text',
        [
          {
            type: 'text',
            value: { kind: 'text', text: '业务材料正文' },
            source: { nodeId: 'u', portId: 'out-text', runId: 'r1' },
            createdAt: 0
          }
        ]
      ]
    ]),
    projectId: 'p1',
    providers: [provider],
    signal: { cancelled: false },
    gateway: currentGateway,
    executionEnvelope: envelope,
    updateProps: () => {},
    updateResult: () => {}
  } as NodeExecutionContext
}

beforeEach(() => {
  vi.restoreAllMocks()
})
afterEach(() => {
  vi.restoreAllMocks()
})

describe('AF-03 ai-process 执行器消费执行信封', () => {
  it('方法/阶段目标进入 system，人工意见/返工反馈置于业务输入之前', async () => {
    installCaptureGateway('成稿正文')
    const envelope = composeExecutionEnvelope({
      stageGoal: '写交付稿',
      methodInstructions: '先案例后分析',
      humanFeedback: '补充数据来源',
      reworkFeedback: '删除冗余段落'
    })
    const result = await aiProcessExecutor(makeCtx(envelope))
    expect(result.status).toBe('done')
    expect(captured.length).toBeGreaterThan(0)
    const request = captured[0]
    expect(request.system).toContain('你是写作助手') // 节点原 system 保留
    expect(request.system).toContain('先案例后分析')
    expect(request.system).toContain('写交付稿')
    const userMessage = request.messages?.find((m) => m.role === 'user')?.content ?? ''
    expect(userMessage).toContain('补充数据来源')
    expect(userMessage).toContain('删除冗余段落')
    expect(userMessage).toContain('业务材料正文')
    // 人工意见在业务输入之前
    expect(userMessage.indexOf('补充数据来源')).toBeLessThan(userMessage.indexOf('业务材料正文'))
  })

  it('无信封 → 请求与旧语义一致（不含阶段指令）', async () => {
    installCaptureGateway('成稿正文')
    const result = await aiProcessExecutor(makeCtx(undefined))
    expect(result.status).toBe('done')
    const request = captured[0]
    expect(request.system).toBe('你是写作助手')
    const userMessage = request.messages?.find((m) => m.role === 'user')?.content ?? ''
    expect(userMessage).toBe('业务材料正文')
  })

  it('改变方法指令 → 实际请求跟着改变', async () => {
    installCaptureGateway('成稿')
    await aiProcessExecutor(
      makeCtx(composeExecutionEnvelope({ methodInstructions: '先结论后论据' }))
    )
    const first = captured[0].system
    installCaptureGateway('成稿')
    await aiProcessExecutor(
      makeCtx(composeExecutionEnvelope({ methodInstructions: '先案例后分析' }))
    )
    const second = captured[0].system
    expect(first).toContain('先结论后论据')
    expect(second).toContain('先案例后分析')
    expect(first).not.toBe(second)
  })
})