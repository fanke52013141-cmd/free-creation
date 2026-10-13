import type { RawNodeOutputs } from '../engine/values'
import type { NodeShape } from '../engine/executor-types'
import { parseStoredNodeValue } from '../engine/values'

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
