import type { CanvasNode, PortDecl } from '../types'
import type { FlowAssetValue } from './assets'
import { validateNodeSchema } from '../node-schemas'
import { PROCESSOR_PORTS } from './processor-contract'
import { parseImageEditConfig, validateImageEditConfig } from '../image-edit'
import { parseTtsConfig } from '../tts'
import { parseImageCropConfig, validateImageCropConfig } from '../image-crop'
import { parseImageSplitConfig } from '../image-split'
import {
  codeParamPortId,
  mapVarTypeToPortType,
  outputFieldPortId,
  parseCodeConfigs
} from '../engine/executors/code'

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
  // P2-B：本地媒体与代码目标。端口静态/可从配置精确重建，执行走公共执行器，
  // 取消走媒体取消作用域；code 限单参数单输出形态以保持固定输入/输出。
  if (node.type === 'image-crop' && node.contractVersion === 2)
    return { inputs: ['in-image'], output: 'out-image' }
  if (node.type === 'image-split' && node.contractVersion === 3)
    return { inputs: ['in-image'], output: 'out-image' }
  if (node.type === 'code' && node.contractVersion === 3) {
    if (!codeFlowSingleOutputConfig(node.params.config)) return null
    return { inputs: codeFlowInputPortIds(node.params.config), output: codeFlowOutputPortId(node.params.config) }
  }
  return null
}

/** Agent 调度的 code 目标只接受单参数、单输出（single 模式）配置。 */
export function codeFlowSingleOutputConfig(rawConfig: unknown): boolean {
  let config
  try {
    config = parseCodeConfigs(typeof rawConfig === 'string' ? rawConfig : JSON.stringify(rawConfig ?? {}))
  } catch {
    return false
  }
  if (config.outputMode !== 'single') return false
  if (config.params.length !== 1) return false
  return config.outputType === 'string' || config.outputType === 'json'
}

function codeFlowParsed(rawConfig: unknown): ReturnType<typeof parseCodeConfigs> {
  return parseCodeConfigs(typeof rawConfig === 'string' ? rawConfig : JSON.stringify(rawConfig ?? {}))
}

export function codeFlowInputPortIds(rawConfig: unknown): string[] {
  const config = codeFlowParsed(rawConfig)
  return config.params.map((param) => codeParamPortId(param))
}

export function codeFlowOutputPortId(rawConfig: unknown): string {
  const config = codeFlowParsed(rawConfig)
  return outputFieldPortId({ name: config.outputName, type: config.outputType })
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

/** 裁剪/拆图目标端口与注册表一致（in-image 必填单值；拆图另暴露集合口）。 */
export const CROP_FLOW_PORTS: PortDecl[] = [
  {
    id: 'in-image',
    name: '原图',
    dir: 'in',
    type: 'image',
    description: '必须连接的一张源图片。',
    required: true,
    cardinality: 'one'
  },
  {
    id: 'out-image',
    name: '裁剪图',
    dir: 'out',
    type: 'image',
    description: '本地裁剪完成并落盘的新图片资产。',
    required: true,
    cardinality: 'one'
  }
]

export const SPLIT_FLOW_PORTS: PortDecl[] = [
  CROP_FLOW_PORTS[0],
  {
    id: 'out-image',
    name: '当前图片',
    dir: 'out',
    type: 'image',
    description: '从图片集合中选中的一格。',
    required: true,
    cardinality: 'one'
  },
  {
    id: 'out-images',
    name: '图片集合',
    dir: 'out',
    type: 'json',
    description: '所有格子对应的真实图片资产引用列表。',
    required: true,
    cardinality: 'one',
    schema: { id: 'list.items', version: 1 }
  }
]

/** 重建 code 节点在 single 模式下的解析端口；portIdentity 准入依赖逐字段一致。 */
function codeFlowPorts(rawConfig: unknown): PortDecl[] {
  if (!codeFlowSingleOutputConfig(rawConfig)) return []
  const config = codeFlowParsed(rawConfig)
  const param = config.params[0]
  const paramType = mapVarTypeToPortType(param.type)
  const outputType = mapVarTypeToPortType(config.outputType)
  return [
    {
      id: 'in-text',
      name: '文本输入',
      dir: 'in',
      type: 'text',
      description: '代码运行时 input.text 读取的合并文本。',
      required: false,
      cardinality: 'many'
    },
    {
      id: 'in-json',
      name: '数据输入',
      dir: 'in',
      type: 'json',
      description: '代码运行时 input.json 读取的结构化值列表。',
      required: false,
      cardinality: 'many',
      schema: { id: 'json.any', version: 1 }
    },
    {
      id: codeParamPortId(param),
      name: param.name,
      dir: 'in',
      type: paramType,
      description: `自定义参数：${param.name}（${param.type}）`,
      required: false,
      cardinality: param.cardinality ?? 'one',
      ...(paramType === 'json' ? { schema: { id: 'json.any', version: 1 } as const } : {}),
      ...(paramType === 'camera' ? { schema: { id: 'previs.camera', version: 1 } as const } : {})
    },
    {
      id: outputFieldPortId({ name: config.outputName, type: config.outputType }),
      name: config.outputName,
      dir: 'out',
      type: outputType,
      description: `代码 return 对象字段 ${config.outputName}（${config.outputType}）。`,
      required: true,
      cardinality: 'one',
      ...(outputType === 'json' ? { schema: { id: 'json.any', version: 1 } as const } : {}),
      ...(outputType === 'camera' ? { schema: { id: 'previs.camera', version: 1 } as const } : {})
    }
  ]
}

/** 裁剪/拆图：唯一 in-image，单张带固定版本摘要的图片。 */
export function localImageFlowInputsValid(inputs: FlowInputValues[]): boolean {
  if (new Set(inputs.map((input) => input.targetPortId)).size !== inputs.length) return false
  const source = inputs.find((input) => input.targetPortId === 'in-image')
  return Boolean(
    source &&
      inputs.length === 1 &&
      source.values.length === 1 &&
      source.values[0].kind === 'image' &&
      source.values[0].contentSha256
  )
}

/** 裁剪配置：与主进程 IPC 相同的 parse→validate 两步；归一化后再校验几何。 */
export function cropFlowConfigValid(rawConfig: unknown): boolean {
  if (typeof rawConfig !== 'string' && (rawConfig === null || typeof rawConfig !== 'object')) {
    return false
  }
  try {
    const text = typeof rawConfig === 'string' ? rawConfig : JSON.stringify(rawConfig)
    return validateImageCropConfig(parseImageCropConfig(text)) === null
  } catch {
    return false
  }
}

export function splitFlowConfigValid(rawConfig: unknown): boolean {
  if (typeof rawConfig !== 'string' && (rawConfig === null || typeof rawConfig !== 'object')) {
    return false
  }
  try {
    parseImageSplitConfig(typeof rawConfig === 'string' ? rawConfig : JSON.stringify(rawConfig))
    return true
  } catch {
    return false
  }
}

/** code 目标输入：唯一参数端口，值类型与 inputType 匹配。 */
export function codeFlowInputsValid(rawConfig: unknown, inputs: FlowInputValues[]): boolean {
  if (!codeFlowSingleOutputConfig(rawConfig)) return false
  const config = codeFlowParsed(rawConfig)
  if (new Set(inputs.map((input) => input.targetPortId)).size !== inputs.length) return false
  if (inputs.length !== 1) return false
  const input = inputs[0]
  if (input.targetPortId !== codeParamPortId(config.params[0])) return false
  if (input.values.length !== 1) return false
  const value = input.values[0]
  switch (config.params[0].type) {
    case 'string':
      return value.kind === 'text' || value.kind === 'markdown'
    case 'number':
    case 'boolean':
    case 'object':
    case 'array':
      return value.kind === 'json'
    case 'any':
      return ['text', 'markdown', 'json'].includes(value.kind)
    default:
      return false
  }
}

export function flowTargetPorts(node: CanvasNode): PortDecl[] {
  if (node.type === 'processor') return [...PROCESSOR_PORTS.in, ...PROCESSOR_PORTS.out]
  if (node.type === 'image-crop') return CROP_FLOW_PORTS
  if (node.type === 'image-split') return SPLIT_FLOW_PORTS
  if (node.type === 'code') return codeFlowPorts(node.params.config)
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
