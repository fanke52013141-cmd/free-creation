import { streamText, tool, stepCountIs, type LanguageModel, type ModelMessage } from 'ai'
import { z } from 'zod'
import type { GatewayDiagnosticsContext } from '../../shared/contracts'
import { emitGatewayEvent, ensureRequestId } from '../diagnostics/gateway-events'

const argumentsSchema = z.object({ marker: z.string().max(128), count: z.number().int() }).strict()
export interface AgentModelProbeReport {
  version: 1
  structuredToolCall: 'verified' | 'failed' | 'unverified'
  toolResultRoundTrip: 'verified' | 'failed' | 'unverified'
  requests: number
  failurePhase?: 'structured-tool' | 'tool-round-trip'
  failureCode?: 'PROBE_CANCELLED' | 'PROBE_REQUEST_FAILED' | 'PROBE_TOOL_INVALID'
  cancellation: 'unverified'
  parallelTools: 'unverified'
  media: 'unverified'
}

/** Two bounded synthetic requests; no tool is executed by the model SDK. */
export async function probeAgentModel(
  model: LanguageModel,
  diagnostics: GatewayDiagnosticsContext,
  signal?: AbortSignal,
  target?: { providerId: string; modelId: string }
): Promise<AgentModelProbeReport> {
  const report: AgentModelProbeReport = {
    version: 1,
    structuredToolCall: 'unverified',
    toolResultRoundTrip: 'unverified',
    requests: 0,
    cancellation: 'unverified',
    parallelTools: 'unverified',
    media: 'unverified'
  }
  let messages: ModelMessage[] = [
    { role: 'user', content: 'Call probe_echo with marker probe-ok and count 7.' }
  ]
  for (const phase of ['structured-tool', 'tool-round-trip'] as const) {
    const toolName = phase === 'structured-tool' ? 'probe_echo' : 'probe_done'
    const context = { ...diagnostics, requestId: ensureRequestId(undefined) }
    const attributes = { operation: 'agent.capability.probe', ...target }
    const started = Date.now()
    let code: AgentModelProbeReport['failureCode'] = 'PROBE_REQUEST_FAILED'
    report.requests++
    emitGatewayEvent('model.request.started', 'Agent 能力探测开始', context, { attributes, phase })
    try {
      const result = streamText({
        // SDK default onError prints the raw provider error; the safe terminal below owns diagnostics.
        onError: () => {},
        model,
        messages,
        tools: {
          [toolName]: tool({
            description: 'Return the observed synthetic marker and count.',
            inputSchema: argumentsSchema
          })
        },
        toolChoice: { type: 'tool', toolName },
        maxOutputTokens: 128,
        maxRetries: 0,
        timeout: 30_000,
        abortSignal: signal,
        stopWhen: stepCountIs(1),
        experimental_telemetry: { isEnabled: false }
      })
      let first = false
      for await (const part of result.fullStream) {
        if (part.type === 'error') throw new Error('PROBE_REQUEST_FAILED')
        if (!first && ['text-delta', 'tool-input-delta', 'tool-call'].includes(part.type)) {
          first = true
          emitGatewayEvent('model.request.first_chunk', 'Agent 能力探测收到分片', context, {
            attributes,
            phase,
            durationMs: Date.now() - started
          })
        }
      }
      const calls = await result.toolCalls
      code = 'PROBE_TOOL_INVALID'
      if (calls.length !== 1 || calls[0]?.toolName !== toolName) throw new Error(code)
      const parsed = argumentsSchema.parse(calls[0].input)
      const expected =
        phase === 'structured-tool'
          ? { marker: 'probe-ok', count: 7 }
          : { marker: 'receipt-only', count: 13 }
      if (parsed.marker !== expected.marker || parsed.count !== expected.count)
        throw new Error(code)
      if (phase === 'structured-tool') {
        report.structuredToolCall = 'verified'
        messages = [
          ...messages,
          {
            role: 'assistant',
            content: [
              {
                type: 'tool-call',
                toolCallId: calls[0].toolCallId,
                toolName,
                input: calls[0].input
              }
            ]
          },
          {
            role: 'tool',
            content: [
              {
                type: 'tool-result',
                toolCallId: calls[0].toolCallId,
                toolName,
                output: { type: 'json', value: { marker: 'receipt-only', count: 13 } }
              }
            ]
          },
          {
            role: 'user',
            content: 'Read the tool result and call probe_done with its marker and count.'
          }
        ]
      } else report.toolResultRoundTrip = 'verified'
      emitGatewayEvent('model.request.completed', 'Agent 能力探测通过', context, {
        attributes,
        phase,
        status: 'success',
        durationMs: Date.now() - started
      })
    } catch {
      const cancelled = Boolean(signal?.aborted)
      report.failurePhase = phase
      report.failureCode = cancelled ? 'PROBE_CANCELLED' : code
      if (phase === 'structured-tool') report.structuredToolCall = 'failed'
      else report.toolResultRoundTrip = 'failed'
      emitGatewayEvent(
        cancelled ? 'model.request.cancelled' : 'model.request.failed',
        'Agent 能力探测结束',
        context,
        {
          attributes,
          phase,
          status: cancelled ? 'cancelled' : 'failed',
          durationMs: Date.now() - started,
          error: new Error(report.failureCode)
        }
      )
      break
    }
  }
  return report
}
