// L01 schema 与安全序列化测试（LOGGING_SPEC.md §5/§8 / 验收 A15）。
// 只用假凭据/假提示词 fixture；断言实际构造出的事件，而不是只测正则函数。
import { describe, expect, it } from 'vitest'
import {
  DiagnosticsProducer,
  DIAGNOSTICS_EVENTS,
  isRegisteredEvent,
  normalizeDiagnosticError,
  safeStack,
  type DiagnosticContext
} from '@shared/observability'

const baseContext: DiagnosticContext = {
  traceId: 'trace-1',
  spanId: 'span-1',
  runId: 'run-1',
  nodeExecutionId: 'nexec-1',
  projectId: 'project-1',
  nodeId: 'shape:1',
  nodeType: 'chat'
}

function producer(): DiagnosticsProducer {
  return new DiagnosticsProducer({
    process: 'renderer',
    producerId: 'renderer-test',
    now: () => 1_700_000_000_000
  })
}

describe('事件注册表与 producer 构造', () => {
  it('注册表内每个事件都有 family/owner/attributes 定义，event 名不带动态值', () => {
    expect(Object.keys(DIAGNOSTICS_EVENTS).length).toBeGreaterThan(40)
    for (const [name, definition] of Object.entries(DIAGNOSTICS_EVENTS)) {
      expect(definition.family.length).toBeGreaterThan(0)
      expect(definition.owner.length).toBeGreaterThan(0)
      expect(name).toMatch(/^[a-z][a-z0-9_.]*$/)
    }
    expect(isRegisteredEvent('node.completed')).toBe(true)
    expect(isRegisteredEvent('node.completed.failed')).toBe(false)
  })

  it('未知事件名被拒绝（返回 null），不接受任意字符串冒充事件', () => {
    expect(producer().build('chat.node.did.something', undefined, 'x', baseContext)).toBeNull()
  })

  it('attributes 白名单之外的字段被丢弃并计数，不记录原值', () => {
    const event = producer().build(
      'model.request.started',
      undefined,
      '开始请求',
      baseContext,
      {
        attributes: {
          modelId: 'model-a',
          // 非白名单字段：尝试夹带提示词与密钥
          prompt: '这是假提示词 SHOULD_NOT_APPEAR',
          apiKey: 'sk-fake-should-not-appear-000123',
          providerId: 'provider-a'
        }
      }
    )
    expect(event).not.toBeNull()
    expect(event!.attributes).toEqual({ modelId: 'model-a', providerId: 'provider-a' })
    expect(event!.producerMeta?.droppedKeys).toBe(2)
    expect(JSON.stringify(event)).not.toContain('SHOULD_NOT_APPEAR')
  })

  it('错误类型的 attribute 值（对象/数组）被丢弃，不序列化原始对象', () => {
    const event = producer().build('model.request.started', undefined, '开始请求', baseContext, {
      attributes: {
        // @ts-expect-error 故意传入非法类型验证运行时防线
        modelId: { nested: 'object' },
        providerId: 'provider-a'
      }
    })
    expect(event!.attributes).toEqual({ providerId: 'provider-a' })
    expect(event!.producerMeta?.droppedKeys).toBe(1)
  })

  it('message 中的密钥/Bearer/私有值在构造期被脱敏（最后一道防线）', () => {
    const event = producer().build(
      'node.stage',
      'info',
      '请求失败：api_key=fakevalue123456 Bearer eyJhbGciOi 独立密钥 sk-abcdefghijklmnopqrstuvwxyz123456 假提示词内容',
      baseContext,
      { privateValues: ['假提示词内容'] }
    )
    expect(event!.message).toContain('[REDACTED]')
    expect(event!.message).toContain('[REDACTED_KEY]')
    expect(event!.message).toContain('[REDACTED_INPUT]')
    expect(event!.message).not.toContain('fakevalue123456')
    expect(event!.message).not.toContain('sk-abcdefghij')
  })

  it('序列化尺寸受 16KiB 上限约束（message/attributes 截断）', () => {
    const event = producer().build('model.request.started', undefined, 'x'.repeat(2000), baseContext)
    expect((event!.message ?? '').length).toBeLessThanOrEqual(500)
    expect(Buffer.byteLength(JSON.stringify(event), 'utf8')).toBeLessThan(16 * 1024)
  })
})

describe('错误归一化', () => {
  it('HTTP 状态映射：401→AUTH_FAILED 不可重试，429→RATE_LIMITED 可重试，5xx→UPSTREAM_FAILED', () => {
    expect(normalizeDiagnosticError({ statusCode: 401 })).toMatchObject({
      code: 'AUTH_FAILED',
      retryable: false,
      httpStatus: 401
    })
    expect(normalizeDiagnosticError({ statusCode: 429 })).toMatchObject({
      code: 'RATE_LIMITED',
      retryable: true
    })
    expect(normalizeDiagnosticError({ statusCode: 502 })).toMatchObject({
      code: 'UPSTREAM_FAILED',
      retryable: true
    })
  })

  it('既有业务错误码稳定映射（TIMEOUT→REQUEST_TIMEOUT），不把一切归 UNKNOWN', () => {
    expect(normalizeDiagnosticError({ code: 'TIMEOUT' })).toMatchObject({
      code: 'REQUEST_TIMEOUT',
      category: 'network',
      retryable: true
    })
    expect(normalizeDiagnosticError({ code: 'INVALID_INPUT' })).toMatchObject({
      code: 'INPUT_INVALID',
      category: 'input'
    })
  })

  it('cause 链根因被保留为 causeCode；未知对象兜底 UNKNOWN 且不含原始正文', () => {
    const nested = new Error('root-cause-detail', { cause: { code: 'UPSTREAM_RATE_LIMIT' } })
    expect(normalizeDiagnosticError(nested)).toMatchObject({ causeCode: 'UPSTREAM_RATE_LIMIT' })
    const unknown = normalizeDiagnosticError('纯字符串错误')
    expect(unknown.code).toBe('UNKNOWN')
    expect(JSON.stringify(unknown)).not.toContain('纯字符串错误')
  })

  it('safeStack 去除绝对路径与换行，保留错误类型', () => {
    const error = new Error('boom')
    error.stack = 'Error: boom\n    at C:\\Users\\Administrator\\project\\src\\a.ts:1:1'
    const stack = safeStack(error)
    expect(stack).not.toContain('C:\\Users')
    expect(stack).toContain('Error: boom')
  })
})
