// 脚本节点执行器（旧版兼容）：剧本文本拆解为分镜 JSON；已有分镜则仅合并文本。
import { inputText } from '../contracts'
import type { NodeExecutionContext, NodeExecutionResult } from '../executor-types'
import {
  extractShots,
  findTextModel,
  mergedPrompt,
  normalizeShot,
  parseJsonObj,
  waitForChat
} from './shared'

export interface ScriptShot {
  id: string
  scene: string
  dialogue: string
  duration: string
  [key: string]: unknown
}

export interface ScriptOutputField {
  path: string
  label: string
  type: string
  description?: string
}

export interface ScriptData {
  source: string
  shots: ScriptShot[]
  modelKey?: string
  outputFields: ScriptOutputField[]
}

const DEFAULT_SCRIPT_FIELDS: ScriptOutputField[] = [
  { path: 'scene', label: '画面描述', type: 'string' },
  { path: 'dialogue', label: '台词', type: 'string' },
  { path: 'sound', label: '音效', type: 'string' },
  { path: 'duration', label: '时长', type: 'string' }
]

function scriptSystemPrompt(fields: ScriptOutputField[]): string {
  const rows = fields
    .map((field) => `- ${field.path} (${field.type})：${field.description || field.label}`)
    .join('\n')
  return `你是一位专业的影视分镜导演。请将剧本文本拆解为分镜 JSON 数组。
只输出 JSON 数组，不要添加 Markdown。每个元素必须严格使用以下字段；点号表示嵌套层级：
${rows}`
}

export function parseScript(text: string): ScriptData {
  const value = parseJsonObj(text)
  if (value && Array.isArray(value.shots)) {
    const outputFields = Array.isArray(value.outputFields)
      ? value.outputFields
          .map((field) => field as Partial<ScriptOutputField>)
          .filter(
            (field): field is ScriptOutputField =>
              typeof field.path === 'string' &&
              typeof field.label === 'string' &&
              typeof field.type === 'string'
          )
      : DEFAULT_SCRIPT_FIELDS
    return {
      source: typeof value.source === 'string' ? value.source : '',
      shots: value.shots.map(normalizeShot as (v: unknown) => ScriptShot),
      modelKey: typeof value.modelKey === 'string' ? value.modelKey : undefined,
      outputFields: outputFields.length > 0 ? outputFields : DEFAULT_SCRIPT_FIELDS
    }
  }
  return { source: text, shots: [], outputFields: DEFAULT_SCRIPT_FIELDS }
}

export const scriptExecutor = async (ctx: NodeExecutionContext): Promise<NodeExecutionResult> => {
  const data = parseScript(ctx.shape.props.text)
  const source = mergedPrompt(data.source, inputText(ctx.inputs, 'in-text'))
  if (!source.trim()) return { status: 'skipped', reason: '无剧本文本' }
  if (data.shots.length > 0) {
    if (source !== data.source) ctx.updateProps({ text: JSON.stringify({ ...data, source }) })
    return { status: 'done' }
  }
  const option = findTextModel(ctx.providers, data.modelKey ?? '', true)
  if (!option) return { status: 'skipped', reason: 'AI 拆解需要可用对话模型' }
  const reply = await waitForChat(
    {
      providerId: option.provider.id,
      modelId: option.model.id,
      system: scriptSystemPrompt(data.outputFields),
      messages: [{ role: 'user', content: source }]
    },
    ctx.signal
  )
  const shots = extractShots(reply)
  if (!shots?.length) return { status: 'failed', reason: '模型未返回可解析的分镜 JSON' }
  ctx.updateProps({
    text: JSON.stringify({
      source,
      shots,
      modelKey: option.key,
      outputFields: data.outputFields
    })
  })
  return { status: 'done' }
}
