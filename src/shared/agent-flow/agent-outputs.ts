import type { RawNodeOutputs } from '../engine/values'
import type { NodeShape } from '../engine/executor-types'
import { parseStoredNodeValue } from '../engine/values'
import { z } from 'zod'
import { AgentFlowAssetRefSchema } from './node-contracts'
import type { FlowAssetValue } from './assets'
import { canonicalFlowJson } from './semantic-revision'

export const AgentOutputSetSchema = z
  .object({
    schemaVersion: z.literal(1),
    kind: z.literal('flow.agent-output-set'),
    outputs: z
      .array(
        z
          .object({
            ref: AgentFlowAssetRefSchema,
            assetKind: z.enum(['text', 'markdown', 'json', 'image', 'video', 'audio'])
          })
          .strict()
      )
      .min(2)
      .max(128)
  })
  .strict()

export function agentReplyOutputProjection(
  refs: Array<z.infer<typeof AgentFlowAssetRefSchema>>,
  values: FlowAssetValue[]
): Partial<Record<'out-text' | 'out-json', FlowAssetValue>> {
  if (
    !refs.length ||
    refs.length !== values.length ||
    refs.length > 128 ||
    new Set(refs.map((ref) => JSON.stringify(ref))).size !== refs.length
  )
    return {}

  const normalized = values.map((value) =>
    ['image', 'video', 'audio'].includes(value.kind)
      ? { kind: 'json' as const, data: value }
      : value.kind === 'markdown'
        ? { kind: 'text' as const, text: value.text }
        : value
  )
  const ports = normalized.map((value) => (value.kind === 'json' ? 'out-json' : 'out-text'))
  if (normalized.length > 2 || new Set(ports).size !== ports.length) {
    return {
      'out-json': {
        kind: 'json',
        data: AgentOutputSetSchema.parse({
          schemaVersion: 1,
          kind: 'flow.agent-output-set',
          outputs: refs.map((ref, index) => ({ ref, assetKind: values[index].kind }))
        })
      }
    }
  }

  return Object.fromEntries(normalized.map((value, index) => [ports[index], value])) as Partial<
    Record<'out-text' | 'out-json', FlowAssetValue>
  >
}

/** Verify an aggregate output against the ordered, fixed asset facts that produced it. */
export function agentOutputSetMatchesAssets(
  output: unknown,
  rawRefs: unknown,
  values: readonly FlowAssetValue[]
): boolean {
  if (!output || typeof output !== 'object' || Array.isArray(output)) return false
  const candidate = output as Record<string, unknown>
  if (candidate.kind !== 'json') return false
  const refs = z.array(AgentFlowAssetRefSchema).min(2).max(128).safeParse(rawRefs)
  const outputSet = AgentOutputSetSchema.safeParse(candidate.data)
  if (!refs.success || !outputSet.success) return false
  const expected = agentReplyOutputProjection(refs.data, [...values])['out-json']
  return Boolean(expected && canonicalFlowJson(expected) === canonicalFlowJson(output))
}

export function projectAgentOutputs(shape: NodeShape): RawNodeOutputs {
  try {
    const result = JSON.parse(shape.meta?.nodeResult ?? '')
    if (result.schemaVersion !== 1 || typeof result.taskId !== 'string' || !result.outputs)
      return {}
    const outputs: RawNodeOutputs = {}
    for (const port of ['out-text', 'out-json']) {
      if (!Object.prototype.hasOwnProperty.call(result.outputs, port)) continue
      const value = parseStoredNodeValue(JSON.stringify(result.outputs[port]))
      if (
        value &&
        ((port === 'out-json' && value.kind === 'json') ||
          (port === 'out-text' && value.kind === 'text'))
      )
        outputs[port] = value
    }
    return outputs
  } catch {
    return {}
  }
}
