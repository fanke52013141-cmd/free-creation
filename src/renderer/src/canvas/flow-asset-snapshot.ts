import { AgentFlowAssetRefSchema } from '@shared/agent-flow/node-contracts'
import type { FlowAssetValue } from '@shared/agent-flow/assets'
import { readPinnedOutputs } from '@shared/engine/deterministic-projections'
import type { NodeCardShape } from './NodeCardShape'

export function readFlowAssetSnapshot(shape: NodeCardShape): FlowAssetValue | null {
  const ref = shape.meta?.flowAssetRef
  if (
    !['text', 'json', 'image', 'video-asset'].includes(shape.props.nodeType) ||
    typeof ref !== 'string'
  )
    return null
  try {
    AgentFlowAssetRefSchema.parse(JSON.parse(ref))
    const value = readPinnedOutputs(shape.meta?.pinnedOutput)?.[
      shape.props.nodeType === 'image'
        ? 'out-image'
        : shape.props.nodeType === 'video-asset'
          ? 'out-video'
          : shape.props.nodeType === 'text'
            ? 'out-text'
            : 'out-json'
    ]
    if (!value) return null
    if (shape.props.nodeType === 'image')
      return value.kind === 'image' && value.contentSha256
        ? { ...value, contentSha256: value.contentSha256 }
        : null
    if (shape.props.nodeType === 'video-asset') return value.kind === 'video' ? value : null
    if (shape.props.nodeType === 'json') return value.kind === 'json' ? value : null
    return value.kind === 'text' || value.kind === 'markdown' ? value : null
  } catch {
    return null
  }
}
