import type { NodeShape } from './executor-types'
import { parseStoredNodeValue, parseMediaResultCollection, type RawNodeOutputs } from './values'
import { projectAgentOutputs } from '../agent-flow/agent-outputs'
import { projectReviewOutputs } from '../agent-flow/review'
import { readStoredNodeRunStatus } from './run-status'

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
  image: projectImageOutputs,
  audio: projectAudioAssetOutputs,
  video: projectVideoOutputs,
  'video-asset': projectVideoAssetOutputs,
  'ai-review': projectReviewOutputs,
  agent: projectAgentOutputs,
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
export function projectVideoOutputs(shape: NodeShape): RawNodeOutputs {
  const item = parseMediaResultCollection(shape.meta?.nodeResult ?? '')?.results.at(-1)
  if (
    !item &&
    !readStoredNodeRunStatus(shape.meta?.nodeRun) &&
    shape.props.mediaId &&
    shape.props.mediaPath
  )
    return {
      'out-video': {
        kind: 'video',
        mediaId: shape.props.mediaId,
        mediaPath: shape.props.mediaPath,
        mime: shape.props.mediaMime || 'video/mp4',
        ...(shape.props.title ? { name: shape.props.title } : {})
      }
    }
  return item
    ? {
        'out-video': {
          kind: 'video',
          mediaId: item.mediaId,
          mediaPath: item.mediaPath,
          mime: item.mime,
          ...(shape.props.title ? { name: shape.props.title } : {})
        }
      }
    : {}
}

export function projectImageOutputs(shape: NodeShape): RawNodeOutputs {
  return shape.props.mediaPath
    ? {
        'out-image': {
          kind: 'image',
          mediaId: shape.props.mediaId,
          mediaPath: shape.props.mediaPath,
          mime: shape.props.mediaMime,
          ...(shape.props.title ? { name: shape.props.title } : {})
        }
      }
    : {}
}

export function projectVideoAssetOutputs(shape: NodeShape): RawNodeOutputs {
  return shape.props.mediaPath
    ? {
        'out-video': {
          kind: 'video',
          mediaId: shape.props.mediaId,
          mediaPath: shape.props.mediaPath,
          mime: shape.props.mediaMime,
          ...(shape.props.title ? { name: shape.props.title } : {})
        }
      }
    : {}
}

export function projectAudioAssetOutputs(shape: NodeShape): RawNodeOutputs {
  return shape.props.mediaPath
    ? {
        'out-audio': {
          kind: 'audio',
          mediaId: shape.props.mediaId,
          mediaPath: shape.props.mediaPath,
          mime: shape.props.mediaMime,
          ...(shape.props.title ? { name: shape.props.title } : {})
        }
      }
    : {}
}
