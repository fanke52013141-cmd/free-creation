import { afterEach, expect, it } from 'vitest'
import { createOpenAICompatible } from '@ai-sdk/openai-compatible'
import { AgentSdkModel } from '../src/main/agent-flow/runtime-model'
import { setGatewayEventSink } from '../src/main/diagnostics/gateway-events'
afterEach(() => setGatewayEventSink(null))
it('constrains coordinator tool choices to supplied nodes and reference fields while retaining host validation', async () => {
  const ref = {
    assetId: 'asset-exact',
    versionId: 'version-exact',
    sourceNodeId: 'source-exact',
    sourcePortId: 'out-text'
  }
  const requests: any[] = []
  const model = createOpenAICompatible({
    name: 'fixture',
    baseURL: 'https://fixture.invalid/v1',
    fetch: async (_url, init) => {
      const body = JSON.parse(String(init?.body))
      requests.push(body)
      const toolName = requests.length === 1 ? 'dispatch_agent' : 'finish_flow'
      const args =
        toolName === 'dispatch_agent'
          ? { nodeId: 'worker', goal: 'task', completion: 'committed output', inputs: [ref] }
          : { outputs: [ref] }
      return new Response(
        `data: ${JSON.stringify({ id: 'test', object: 'chat.completion.chunk', created: 1, model: 'fixture', choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'call', type: 'function', function: { name: toolName, arguments: JSON.stringify(args) } }] }, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ id: 'test', object: 'chat.completion.chunk', created: 1, model: 'fixture', choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] })}\n\ndata: [DONE]\n\n`,
        { headers: { 'content-type': 'text/event-stream' } }
      )
    }
  }).chatModel('fixture')
  const sdk = new AgentSdkModel(model, 'p', { resolveInputs: () => [] }, { traceId: 'trace' })
  const signal = new AbortController().signal
  expect(
    (
      await sdk.coordinate(
        {
          goal: 'task',
          mode: 'autonomous',
          available: [{ nodeId: 'worker', goal: 'task', inputs: [ref] }],
          completed: []
        },
        signal
      )
    ).kind
  ).toBe('dispatch')
  expect(
    (
      await sdk.coordinate(
        {
          goal: 'task',
          mode: 'autonomous',
          available: [],
          completed: [{ nodeId: 'worker', taskId: 't', outputs: [ref] }]
        },
        signal
      )
    ).kind
  ).toBe('finish')
  const dispatch = requests[0].tools.find((value: any) => value.function.name === 'dispatch_agent')
    .function.parameters
  expect(dispatch.type).toBe('object')
  expect(dispatch.properties.nodeId.enum).toEqual(['worker'])
  expect(dispatch.properties.inputs.items.properties.versionId.enum).toEqual(['version-exact'])
  const finish = requests[1].tools.find((value: any) => value.function.name === 'finish_flow')
    .function.parameters
  expect(finish.properties.outputs.items.properties.assetId.enum).toEqual(['asset-exact'])
})
