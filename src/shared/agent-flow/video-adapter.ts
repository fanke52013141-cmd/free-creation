import type { CanvasNode, PortDecl } from '../types'
import type { FlowAssetValue } from './assets'
import { validateNodeSchema } from '../node-schemas'
import { PROCESSOR_PORTS } from './processor-contract'
import { parseImageEditConfig, validateImageEditConfig } from '../image-edit'
import { parseTtsConfig } from '../tts'

/** Structural ceiling; the selected provider's lower reference limits also apply. */
export const VIDEO_FLOW_MAX_REFERENCES = 30

/** Validate structured prompt content at both task and command admission. */
export function videoFlowAssetValid(portId: string, value: FlowAssetValue): boolean {
  return (
    portId !== 'in-prompt' ||
    (value.kind === 'json' &&
      validateNodeSchema({ id: 'prompt.bundle', version: 1 }, value.data).ok)
  )
}

/** Video adapter: fixed prompt bundles/frames and ordered media references. */
export function flowTargetContract(node: CanvasNode): { inputs: string[]; output: string } | null {
  if (node.type === 'processor' && node.contractVersion === 1)
    return { inputs: ['in-value'], output: 'out-value' }
  if (node.type === 'video' && node.contractVersion === 7)
    return {
      inputs: ['in-text', 'in-prompt', 'in-images', 'in-reference-video', 'in-reference-audio'],
      output: 'out-video'
    }
  if (node.type === 'image-gen' && node.contractVersion === 3)
    return { inputs: ['in-images', 'in-prompt', 'in-text'], output: 'out-image' }
  if (node.type === 'image-edit' && node.contractVersion === 2)
    return { inputs: ['in-image', 'in-text'], output: 'out-image' }
  if (node.type === 'speech' && node.contractVersion === 4)
    return { inputs: ['in-text', 'in-voice', 'in-audio'], output: 'out-audio' }
  if (node.type === 'tts' && node.contractVersion === 4)
    return { inputs: ['in-audio'], output: 'out-json' }
  return null
}

export interface FlowInputValues {
  targetPortId: string
  values: FlowAssetValue[]
}

/** Validate the immutable input manifest for the Agent-supported image generator. */
export function imageGenFlowInputsValid(inputs: FlowInputValues[]): boolean {
  if (new Set(inputs.map((input) => input.targetPortId)).size !== inputs.length) return false
  return inputs.every(({ targetPortId, values }) => {
    if (targetPortId === 'in-text')
      return (
        values.length > 0 &&
        values.every((value) => value.kind === 'text' || value.kind === 'markdown')
      )
    if (targetPortId === 'in-prompt')
      return (
        values.length === 1 &&
        values[0].kind === 'json' &&
        validateNodeSchema({ id: 'prompt.bundle', version: 1 }, values[0].data).ok
      )
    if (targetPortId === 'in-images')
      return (
        values.length > 0 &&
        values.length <= 6 &&
        values.every((value) => value.kind === 'image' && Boolean(value.contentSha256)) &&
        new Set(values.map((value) => (value.kind === 'image' ? value.mediaId : ''))).size ===
          values.length
      )
    return false
  })
}

/** Image editing requires one immutable original image; text guidance may be ordered and many. */
export function imageEditFlowInputsValid(inputs: FlowInputValues[]): boolean {
  if (new Set(inputs.map((input) => input.targetPortId)).size !== inputs.length) return false
  const source = inputs.find((input) => input.targetPortId === 'in-image')
  if (
    !source ||
    source.values.length !== 1 ||
    source.values[0].kind !== 'image' ||
    !source.values[0].contentSha256
  )
    return false
  return inputs.every(({ targetPortId, values }) =>
    targetPortId === 'in-image'
      ? values.length === 1 && values[0].kind === 'image'
      : targetPortId === 'in-text' &&
        values.length > 0 &&
        values.every((value) => value.kind === 'text' || value.kind === 'markdown')
  )
}

/** Voice clone always reads a single fixed audio edge and never an uploaded config path. */
export function ttsFlowInputsValid(config: unknown, inputs: FlowInputValues[]): boolean {
  if (
    !ttsFlowConfigValid(config) ||
    new Set(inputs.map((input) => input.targetPortId)).size !== inputs.length
  )
    return false
  const audio = inputs.find((input) => input.targetPortId === 'in-audio')
  return (
    Boolean(audio) &&
    audio!.values.length === 1 &&
    audio!.values[0].kind === 'audio' &&
    Boolean(audio!.values[0].contentSha256) &&
    inputs.every((input) => input.targetPortId === 'in-audio')
  )
}

/** Speech target ports depend on the saved backend and never use mutable uploaded audio IDs. */
export function speechFlowInputsValid(config: unknown, inputs: FlowInputValues[]): boolean {
  if (!speechFlowConfigValid(config)) return false
  const record = config as Record<string, unknown>
  const backend = record.backend === 'volc' ? 'volc' : 'minimax'
  if (backend === 'volc' && (record.referenceAudioId || record.referenceAudioPath)) return false
  if (new Set(inputs.map((input) => input.targetPortId)).size !== inputs.length) return false
  return inputs.every(({ targetPortId, values }) => {
    if (targetPortId === 'in-text')
      return (
        values.length > 0 &&
        values.every((value) => value.kind === 'text' || value.kind === 'markdown')
      )
    if (backend === 'minimax' && targetPortId === 'in-voice')
      return (
        values.length === 1 &&
        values[0].kind === 'json' &&
        validateNodeSchema({ id: 'voice.profile', version: 1 }, values[0].data).ok
      )
    if (backend === 'volc' && targetPortId === 'in-audio')
      return (
        values.length > 0 &&
        values.length <= 3 &&
        values.every((value) => value.kind === 'audio' && Boolean(value.contentSha256))
      )
    return false
  })
}

export function imageGenFlowConfigValid(config: unknown): boolean {
  if (!config || typeof config !== 'object' || Array.isArray(config)) return false
  const record = config as Record<string, unknown>
  const rawCount = typeof record.count === 'number' ? record.count : Number(record.count)
  const count = Number.isFinite(rawCount) ? Math.max(1, Math.min(9, Math.trunc(rawCount))) : 1
  const retry = record.retry
  const configuredRetries =
    retry && typeof retry === 'object' && !Array.isArray(retry)
      ? (retry as Record<string, unknown>).maxRetries
      : 0
  const rawRetries =
    typeof configuredRetries === 'number' ? configuredRetries : Number(configuredRetries)
  const maxRetries = Number.isFinite(rawRetries)
    ? Math.min(5, Math.max(0, Math.round(rawRetries)))
    : 0
  return count === 1 && maxRetries === 0
}

export function imageEditFlowConfigValid(config: unknown): boolean {
  if (!config || typeof config !== 'object' || Array.isArray(config)) return false
  try {
    return validateImageEditConfig(parseImageEditConfig(JSON.stringify(config))) === null
  } catch {
    return false
  }
}

export function ttsFlowConfigValid(config: unknown): boolean {
  if (!config || typeof config !== 'object' || Array.isArray(config)) return false
  const record = config as Record<string, unknown>
  if (record.backend !== undefined && record.backend !== 'minimax') return false
  if (['refMediaId', 'refMediaPath', 'promptMediaId', 'promptMediaPath'].some((key) => record[key]))
    return false
  try {
    const parsed = parseTtsConfig(JSON.stringify(config))
    return (
      parsed.backend === 'minimax' &&
      !parsed.refMediaId &&
      !parsed.refMediaPath &&
      !parsed.promptMediaId &&
      !parsed.promptMediaPath
    )
  } catch {
    return false
  }
}

export function speechFlowConfigValid(config: unknown): boolean {
  if (!config || typeof config !== 'object' || Array.isArray(config)) return false
  const record = config as Record<string, unknown>
  if (record.backend !== undefined && record.backend !== 'minimax' && record.backend !== 'volc')
    return false
  return !(
    record.backend === 'volc' &&
    (Boolean(record.referenceAudioId) || Boolean(record.referenceAudioPath))
  )
}
export function agentOutputValue(
  value: FlowAssetValue
): Exclude<FlowAssetValue, { kind: 'video' } | { kind: 'image' } | { kind: 'audio' }> {
  if (value.kind === 'video' || value.kind === 'image' || value.kind === 'audio')
    return { kind: 'json', data: value }
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

export const IMAGE_GEN_FLOW_PORTS: PortDecl[] = [
  {
    id: 'in-images',
    name: '参考图',
    description: '有序参考图片。',
    dir: 'in',
    type: 'image',
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
    description: '生成图片使用的提示文本。',
    dir: 'in',
    type: 'text',
    required: false,
    cardinality: 'many'
  },
  {
    id: 'out-image',
    name: '图片',
    description: '已保存的图片引用。',
    dir: 'out',
    type: 'image',
    required: true,
    cardinality: 'one'
  }
]

export const IMAGE_EDIT_FLOW_PORTS: PortDecl[] = [
  {
    id: 'in-image',
    name: '原图',
    description: '必须连接的一张固定图片。',
    dir: 'in',
    type: 'image',
    required: true,
    cardinality: 'one'
  },
  {
    id: 'in-text',
    name: '修改说明',
    description: '有序修改文本。',
    dir: 'in',
    type: 'text',
    required: false,
    cardinality: 'many'
  },
  {
    id: 'out-image',
    name: '修改图',
    description: '模型修改并落盘后的固定图片。',
    dir: 'out',
    type: 'image',
    required: true,
    cardinality: 'one'
  }
]

export const SPEECH_FLOW_PORTS: PortDecl[] = [
  {
    id: 'in-text',
    name: '朗读文本',
    description: '朗读文本。',
    dir: 'in',
    type: 'text',
    required: false,
    cardinality: 'many'
  },
  {
    id: 'in-voice',
    name: '音色档案',
    description: 'MiniMax 音色档案。',
    dir: 'in',
    type: 'json',
    required: false,
    cardinality: 'one',
    schema: { id: 'voice.profile', version: 1 }
  },
  {
    id: 'in-audio',
    name: '参考音频',
    description: '火山语音参考音频。',
    dir: 'in',
    type: 'audio',
    required: false,
    cardinality: 'many'
  },
  {
    id: 'out-audio',
    name: '语音',
    description: '已保存的音频引用。',
    dir: 'out',
    type: 'audio',
    required: true,
    cardinality: 'one'
  },
  {
    id: 'out-subtitle',
    name: '字幕时间轴',
    description: '语音字幕时间轴。',
    dir: 'out',
    type: 'json',
    required: false,
    cardinality: 'one',
    schema: { id: 'voice.subtitle', version: 1 }
  }
]

export const TTS_FLOW_PORTS: PortDecl[] = [
  {
    id: 'in-audio',
    name: '参考语音',
    description: '一份固定参考音频；上传路径只允许经资产端口输入。',
    dir: 'in',
    type: 'audio',
    required: false,
    cardinality: 'one'
  },
  {
    id: 'out-json',
    name: '音色档案',
    description: 'MiniMax 登记出的可复用音色档案。',
    dir: 'out',
    type: 'json',
    required: true,
    cardinality: 'one',
    schema: { id: 'voice.profile', version: 1 }
  }
]

export function flowTargetPorts(node: CanvasNode): PortDecl[] {
  if (node.type === 'processor') return [...PROCESSOR_PORTS.in, ...PROCESSOR_PORTS.out]
  if (node.type === 'video') return VIDEO_FLOW_PORTS
  if (node.type === 'image-gen') return IMAGE_GEN_FLOW_PORTS
  if (node.type === 'image-edit') return IMAGE_EDIT_FLOW_PORTS
  if (node.type === 'speech') {
    let backend: unknown
    try {
      const raw = node.params.config
      const config = typeof raw === 'string' ? JSON.parse(raw || '{}') : raw
      backend =
        config && typeof config === 'object'
          ? (config as Record<string, unknown>).backend
          : undefined
    } catch {
      backend = undefined
    }
    const allowed =
      backend === 'volc'
        ? new Set(['in-text', 'in-audio', 'out-audio', 'out-subtitle'])
        : new Set(['in-text', 'in-voice', 'out-audio'])
    return SPEECH_FLOW_PORTS.filter((port) => allowed.has(port.id))
  }
  if (node.type === 'tts') return TTS_FLOW_PORTS
  return []
}

/** One text/bundle source and bounded, ordered media lists in reference mode. */
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
        : input.targetPortId === 'in-prompt'
          ? input.kinds.length !== 1 || input.kinds[0] !== 'json'
          : ['in-reference-video', 'in-reference-audio'].includes(input.targetPortId)
            ? mode !== 'reference' ||
              input.kinds.length < 1 ||
              input.kinds.length > VIDEO_FLOW_MAX_REFERENCES ||
              input.kinds.some(
                (kind) => kind !== (input.targetPortId === 'in-reference-video' ? 'video' : 'audio')
              )
            : input.targetPortId !== 'in-images' ||
              (mode === 'reference'
                ? input.kinds.length < 1 || input.kinds.length > VIDEO_FLOW_MAX_REFERENCES
                : input.kinds.length !== (mode === 'first-last-frame' ? 2 : 1)) ||
              input.kinds.some((kind) => kind !== 'image')
    )
  )
    return false
  const hasMedia = inputs.some((input) =>
    ['in-images', 'in-reference-video', 'in-reference-audio'].includes(input.targetPortId)
  )
  return mode === 'text' ? !hasMedia : hasMedia
}
