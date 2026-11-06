import { afterEach, describe, expect, it } from 'vitest'
import { emitGatewayEvent, setGatewayEventSink } from '../src/main/diagnostics/gateway-events'

afterEach(() => setGatewayEventSink(null))
describe('provider export diagnostics', () => {
  it('keeps unregistered credential and path fields out of the event', () => {
    const events: unknown[] = []
    setGatewayEventSink({ emit: (event) => events.push(event) })
    emitGatewayEvent(
      'provider.export.completed',
      '供应商导出完成',
      { traceId: 'trace-test', spanId: 'span-test' },
      {
        phase: 'write',
        attributes: {
          count: 1,
          password: 'private-password',
          apiKey: 'private-secret',
          path: 'private-path'
        }
      }
    )
    expect(events).toHaveLength(1)
    const serialized = JSON.stringify(events)
    expect(serialized).not.toContain('private-password')
    expect(serialized).not.toContain('private-secret')
    expect(serialized).not.toContain('private-path')
    expect(serialized).toContain('provider.export.completed')
  })
  it('does not throw when the diagnostic sink fails', () => {
    setGatewayEventSink({
      emit: () => {
        throw new Error('sink failure')
      }
    })
    expect(() =>
      emitGatewayEvent('provider.export.started', '开始导出供应商配置', { traceId: 'trace-test' })
    ).not.toThrow()
  })
})
