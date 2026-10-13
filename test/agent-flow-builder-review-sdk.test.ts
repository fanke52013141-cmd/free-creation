import { afterEach, expect, it, vi } from 'vitest'
import { createOpenAICompatible } from '@ai-sdk/openai-compatible'
import { AgentSdkModel } from '../src/main/agent-flow/runtime-model'
import { setGatewayEventSink } from '../src/main/diagnostics/gateway-events'
import type { DiagnosticsEventInput } from '../src/shared/observability'
afterEach(() => setGatewayEventSink(null))
function fixture(name: string, args: unknown, empty = false) {
  const requests: Record<string, unknown>[] = [],
    events: DiagnosticsEventInput[] = []
  setGatewayEventSink({
    emit: (event) => {
      if (event) events.push(event)
    }
  })
  const model = createOpenAICompatible({
    name: 'fixture',
    baseURL: 'http://localhost/v1',
    fetch: async (_, init) => {
      requests.push(JSON.parse(String(init?.body)))
      const chunk = (delta: unknown, finish_reason: string | null) =>
        JSON.stringify({
          id: 'fixture',
          object: 'chat.completion.chunk',
          created: 1,
          model: 'fixture',
          choices: [{ index: 0, delta, finish_reason }]
        })
      return new Response(
        `data: ${chunk(empty ? { role: 'assistant', content: '' } : { tool_calls: [{ index: 0, id: 'call-1', type: 'function', function: { name, arguments: JSON.stringify(args) } }] }, null)}\n\ndata: ${chunk({}, 'tool_calls')}\n\ndata: [DONE]\n\n`,
        { headers: { 'content-type': 'text/event-stream' } }
      )
    }
  }).chatModel('fixture')
  const assets = { resolveInputs: vi.fn(() => []) }
  const port = new AgentSdkModel(
    model,
    'p',
    assets,
    { projectId: 'p', nodeId: 'node', taskId: 'task', traceId: 'trace', spanId: 'span' },
    { fixture: { thinking: { type: 'disabled' } } }
  )
  return { port, requests, events, assets }
}
it('single-result builder uses a named proposal tool and logs no goal or material', async () => {
  const plan = {
    title: '流程',
    steps: [{ title: '步骤', goal: '加工并交付', mode: 'autonomous', template: '{{value}}' }]
  }
  const f = fixture('propose_flow', plan)
  expect(
    await f.port.build(
      { goal: 'private-sdk-goal', capability: 'sequential-text-template@1' },
      new AbortController().signal
    )
  ).toEqual(plan)
  expect(f.requests).toHaveLength(1)
  expect(f.requests[0].tool_choice).toEqual({
    type: 'function',
    function: { name: 'propose_flow' }
  })
  expect(f.assets.resolveInputs).not.toHaveBeenCalled()
  expect(f.events.map((e) => e.event)).toEqual(['model.request.started', 'model.request.completed'])
  expect(JSON.stringify(f.events)).not.toContain('private-sdk-goal')
})
it('review accepts a negative verdict as a valid result, sends complete text/JSON and excludes bodies from diagnostics', async () => {
  const verdict = {
    passed: false,
    feedback: 'private-sdk-feedback',
    issues: [{ subjectIndex: 0, feedback: '补标题' }]
  }
  const f = fixture('review_assets', verdict)
  expect(
    await f.port.review(
      {
        criteria: 'private-sdk-criteria',
        subjects: [
          { kind: 'text', text: 'private-sdk-material' },
          { kind: 'json', data: { full: 'private-sdk-json' } }
        ]
      },
      new AbortController().signal
    )
  ).toEqual(verdict)
  const request = JSON.stringify(f.requests)
  for (const word of ['private-sdk-material', 'private-sdk-json', 'private-sdk-criteria'])
    expect(request).toContain(word)
  expect(f.events.map((e) => e.event)).toEqual(['model.request.started', 'model.request.completed'])
  expect(JSON.stringify(f.events)).not.toContain('private-sdk')
})
it('empty tool terminal and forged schema cannot become a build or an approval', async () => {
  const f = fixture('review_assets', {}, true)
  await expect(
    f.port.review(
      { criteria: '标准', subjects: [{ kind: 'text', text: '材料' }] },
      new AbortController().signal
    )
  ).rejects.toMatchObject({ code: 'AGENT_MODEL_ACTION_INVALID' })
  expect(f.events.map((e) => e.event)).toEqual(['model.request.started', 'model.request.failed'])
  expect(f.events.at(-1)?.attributes).toMatchObject({ toolCallCount: 0 })
  const forged = fixture('review_assets', { passed: 'yes', feedback: 'bad', issues: [] })
  await expect(
    forged.port.review(
      { criteria: '标准', subjects: [{ kind: 'text', text: '材料' }] },
      new AbortController().signal
    )
  ).rejects.toMatchObject({ code: 'AGENT_MODEL_ACTION_INVALID' })
})
