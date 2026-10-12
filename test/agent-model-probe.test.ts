import { afterEach, describe, expect, it } from 'vitest'
import { createOpenAICompatible } from '@ai-sdk/openai-compatible'
import { probeAgentModel } from '../src/main/agent-flow/model-probe'
import { setGatewayEventSink } from '../src/main/diagnostics/gateway-events'
import type { DiagnosticsEventInput } from '../src/shared/observability'

afterEach(() => setGatewayEventSink(null))
function fixture(options: { wrongReceipt?: boolean; fail?: boolean } = {}) {
  const requests: Record<string, unknown>[] = []
  const model = createOpenAICompatible({
    name: 'probe-fixture',
    baseURL: 'https://fixture.invalid/v1',
    apiKey: 'private-test-key',
    fetch: async (_url, init) => {
      const body = JSON.parse(String(init?.body))
      requests.push(body)
      if (options.fail) throw new Error('private-test-key https://secret.invalid?token=hidden')
      const name = body.tool_choice.function.name
      const receipt = name === 'probe_done' && !options.wrongReceipt
      const chunks = [
        {
          id: 'fixture',
          object: 'chat.completion.chunk',
          created: 1,
          model: 'fixture',
          choices: [
            {
              index: 0,
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    id: `call-${requests.length}`,
                    type: 'function',
                    function: {
                      name,
                      arguments: JSON.stringify({
                        marker: receipt ? 'receipt-only' : 'probe-ok',
                        count: receipt ? 13 : 7
                      })
                    }
                  }
                ]
              },
              finish_reason: null
            }
          ]
        },
        {
          id: 'fixture',
          object: 'chat.completion.chunk',
          created: 1,
          model: 'fixture',
          choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }]
        }
      ]
      return new Response(
        chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join('') + 'data: [DONE]\n\n',
        {
          headers: { 'content-type': 'text/event-stream' }
        }
      )
    }
  }).chatModel('fixture')
  return { model, requests }
}
describe('Agent model capability probe', () => {
  it('verifies forced tools and reads changed tool receipts within two bounded requests', async () => {
    const { model, requests } = fixture()
    const report = await probeAgentModel(model, { traceId: 'probe' })
    expect(report.structuredToolCall).toBe('verified')
    expect(report.toolResultRoundTrip).toBe('verified')
    expect(requests).toHaveLength(2)
    expect(requests[1]).toMatchObject({ max_tokens: 128 })
    expect(JSON.stringify(requests[1])).toContain('receipt-only')
    expect(report.cancellation).toBe('unverified')
  })
  it('does not certify a model that copies original arguments instead of the tool receipt', async () => {
    const { model } = fixture({ wrongReceipt: true })
    expect(await probeAgentModel(model, {})).toMatchObject({
      structuredToolCall: 'verified',
      toolResultRoundTrip: 'failed',
      failurePhase: 'tool-round-trip',
      failureCode: 'PROBE_TOOL_INVALID'
    })
  })
  it('stops on first failed request, emits one terminal and redacts original errors', async () => {
    const events: DiagnosticsEventInput[] = []
    setGatewayEventSink({
      emit: (event) => {
        if (event) events.push(event)
      }
    })
    const { model, requests } = fixture({ fail: true })
    const report = await probeAgentModel(model, { traceId: 'probe' })
    expect(requests).toHaveLength(1)
    expect(report.toolResultRoundTrip).toBe('unverified')
    expect(events.map((event) => event.event)).toEqual([
      'model.request.started',
      'model.request.failed'
    ])
    expect(JSON.stringify({ report, events })).not.toMatch(
      /private-test-key|secret.invalid|token=hidden/
    )
  })
  it('logger failure does not change a valid probe', async () => {
    setGatewayEventSink({
      emit: () => {
        throw new Error('logger down')
      }
    })
    expect((await probeAgentModel(fixture().model, {})).toolResultRoundTrip).toBe('verified')
  })
})
