import type { CanvasNode, PortDecl } from '../types'
import type { FlowAssetValue } from './assets'
/** Video adapter: fixed text/frames, ordered images, and one optional motion reference. */
export function flowTargetContract(node: CanvasNode): { inputs: string[]; output: string } | null {
  if (node.type === 'processor' && node.contractVersion === 1)
    return { inputs: ['in-value'], output: 'out-value' }
  if (node.type === 'video' && node.contractVersion === 7)
    return { inputs: ['in-text', 'in-images', 'in-reference-video'], output: 'out-video' }
  return null
}
export function agentOutputValue(
  value: FlowAssetValue
): Exclude<FlowAssetValue, { kind: 'video' } | { kind: 'image' }> {
  if (value.kind === 'video' || value.kind === 'image') return { kind: 'json', data: value }
  return value.kind === 'markdown' ? { kind: 'text', text: value.text } : value
}
export const VIDEO_FLOW_PORTS: PortDecl[] = [
  {
    id: 'in-images',
    name: '图片',
    description: '有序参考图片。',
    dir: 'in',
    type: 'image',
    required: false,
    cardinality: 'many'
  },
  {
    id: 'in-reference-video',
    name: '运动参考',
    description: '视频运动参考。',
    dir: 'in',
    type: 'video',
    required: false,
    cardinality: 'many'
  },
  {
    id: 'in-reference-audio',
    name: '参考音频',
    description: '音频参考。',
    dir: 'in',
    type: 'audio',
    required: false,
    cardinality: 'many'
  },
  {
    id: 'in-prompt',
    name: '提示词包',
    description: '提示词包。',
    dir: 'in',
    type: 'json',
    required: false,
    cardinality: 'one',
    schema: { id: 'prompt.bundle', version: 1 }
  },
  {
    id: 'in-text',
    name: '提示词',
    description: '生成提示文本。',
    dir: 'in',
    type: 'text',
    required: false,
    cardinality: 'many'
  },
  {
    id: 'out-video',
    name: '视频',
    description: '已保存的视频引用。',
    dir: 'out',
    type: 'video',
    required: true,
    cardinality: 'one'
  }
]

/** One text source, mode-specific ordered images, and at most one video in reference mode. */
export function videoFlowInputsValid(
  mode: unknown,
  inputs: { targetPortId: string; kinds: string[] }[]
): boolean {
  if (!['text', 'first-frame', 'first-last-frame', 'reference'].includes(String(mode))) return false
  if (new Set(inputs.map((input) => input.targetPortId)).size !== inputs.length) return false
  if (
    inputs.some((input) =>
      input.targetPortId === 'in-text'
        ? input.kinds.length !== 1 || !['text', 'markdown'].includes(input.kinds[0])
        : input.targetPortId === 'in-reference-video'
          ? mode !== 'reference' || input.kinds.length !== 1 || input.kinds[0] !== 'video'
          : input.targetPortId !== 'in-images' ||
            (mode === 'reference'
              ? input.kinds.length < 1 || input.kinds.length > 30
              : input.kinds.length !== (mode === 'first-last-frame' ? 2 : 1)) ||
            input.kinds.some((kind) => kind !== 'image')
    )
  )
    return false
  const hasMedia = inputs.some((input) =>
    ['in-images', 'in-reference-video'].includes(input.targetPortId)
  )
  return mode === 'text' ? !hasMedia : hasMedia
}
