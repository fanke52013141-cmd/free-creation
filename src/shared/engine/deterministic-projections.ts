import type { NodeShape } from './executor-types'
import { parseStoredNodeValue, type RawNodeOutputs } from './values'

// These exact functions are registered by the desktop NodeTypeSpecs.
export const projectTextOutputs = (shape: NodeShape): RawNodeOutputs =>
  shape.props.text.trim() ? { 'out-text': { kind: 'text', text: shape.props.text.trim() } } : {}

export const projectJsonOutputs = (shape: NodeShape): RawNodeOutputs => {
  try {
    return shape.props.text.trim()
      ? { 'out-json': { kind: 'json', data: JSON.parse(shape.props.text) } }
      : {}
  } catch {
    return {}
  }
}

export const projectProcessorOutputs = (shape: NodeShape): RawNodeOutputs => {
  const result = parseStoredNodeValue(shape.meta?.nodeResult ?? '')
  return result ? { 'out-value': result } : {}
}

export const DETERMINISTIC_PROJECTIONS = {
  text: projectTextOutputs,
  json: projectJsonOutputs,
  processor: projectProcessorOutputs
} as const

export function readPinnedOutputs(stored: unknown): RawNodeOutputs | null {
  if (typeof stored !== 'string') return null
  try {
    const parsed = JSON.parse(stored)
    if (
      parsed?.version !== 1 ||
      !parsed.outputs ||
      typeof parsed.outputs !== 'object' ||
      Array.isArray(parsed.outputs)
    )
      return null
    const outputs: RawNodeOutputs = {}
    for (const [portId, value] of Object.entries(parsed.outputs)) {
      const validated = parseStoredNodeValue(JSON.stringify(value))
      if (!validated) return null
      outputs[portId] = validated
    }
    return Object.keys(outputs).length ? outputs : null
  } catch {
    return null
  }
}
