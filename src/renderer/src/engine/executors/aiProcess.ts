// AI 处理节点执行器（路线图 R3 / 契约规范 P3）
//
// 做「一次性、可复跑」的工作流转换：把上游文本/JSON 交给文本模型，按输出模式
// 产出 text / markdown / 指定 Schema 的 json。与对话节点不同，它不保留多轮历史，
// 只做单次转换，输出可验证、可单独调试，不把普通文本伪装成 JSON。
//
// 配置存储在 shape.props.text（JSON 字符串）：
//   { modelKey, system, mode: 'text'|'markdown'|'json', jsonSchema?, temperature, maxTokens,
//     result?: { kind, text?/data? } }
import { inputJson, inputText } from '../contracts'
import type { NodeExecutionContext, NodeExecutionResult } from '../executor-types'
import { validateNodeSchema } from '@shared/node-schemas'
import type { PortSchemaRef } from '@shared/types'
import { findTextModel, parseJsonObj, waitForChat } from './shared'

export type AiOutputMode = 'text' | 'markdown' | 'json'

export interface AiProcessConfig {
  modelKey: string
  system: string
  mode: AiOutputMode
  /** json 模式必须显式选择的 Schema；text/markdown 模式忽略。 */
  jsonSchema?: PortSchemaRef
  temperature: number
  maxTokens: number
  /** 上次运行结果，供输出投影读取。 */
  result?: { kind: 'text' | 'markdown' | 'json'; text?: string; data?: unknown }
}

export function parseAiProcess(text: string): AiProcessConfig {
  const value = parseJsonObj(text)
  const mode: AiOutputMode =
    value?.mode === 'json' || value?.mode === 'markdown' ? value.mode : 'text'
  const rawSchema = value?.jsonSchema as Record<string, unknown> | undefined
  const jsonSchema =
    rawSchema && typeof rawSchema.id === 'string' && typeof rawSchema.version === 'number'
      ? { id: rawSchema.id, version: rawSchema.version }
      : undefined
  const rawResult = value?.result as Record<string, unknown> | undefined
  const result =
    rawResult && typeof rawResult.kind === 'string'
      ? ({
          ...rawResult,
          kind: rawResult.kind,
          ...(typeof rawResult.text === 'string' ? { text: rawResult.text } : {}),
          ...('data' in rawResult ? { data: rawResult.data } : {})
        } as AiProcessConfig['result'])
      : undefined
  return {
    modelKey: typeof value?.modelKey === 'string' ? value.modelKey : '',
    system: typeof value?.system === 'string' ? value.system : '',
    mode,
    jsonSchema,
    temperature: typeof value?.temperature === 'number' ? value.temperature : 0.7,
    maxTokens: typeof value?.maxTokens === 'number' ? value.maxTokens : 4096,
    result
  }
}

/** 把 AI 返回文本按输出模式规范化成可投影的结果；失败时走 reject，不伪装成 JSON。 */
function normalizeResult(
  raw: string,
  mode: AiOutputMode,
  jsonSchema?: PortSchemaRef
): { kind: 'text' | 'markdown' | 'json'; text?: string; data?: unknown } {
  if (mode === 'text') return { kind: 'text', text: raw.trim() }
  if (mode === 'markdown') return { kind: 'markdown', text: raw.trim() }
  // json 模式：必须显式选 Schema；解析失败直接报错，不把普通文本伪装成 JSON。
  if (!jsonSchema) throw new Error('JSON 输出模式必须选择输出 Schema')
  let data: unknown
  try {
    data = JSON.parse(raw)
  } catch {
    throw new Error('模型返回的不是合法 JSON')
  }
  const validation = validateNodeSchema(jsonSchema, data)
  if (!validation.ok) {
    throw new Error(
      `JSON 不符合 ${jsonSchema.id}@${jsonSchema.version}：${validation.errors.join('；')}`
    )
  }
  return { kind: 'json', data }
}

export const aiProcessExecutor = async (
  ctx: NodeExecutionContext
): Promise<NodeExecutionResult> => {
  const config = parseAiProcess(ctx.shape.props.text)
  const option = findTextModel(ctx.providers, config.modelKey)
  if (!option) return { status: 'skipped', reason: '未选择可用文本模型' }

  // 组装一次性的用户消息：优先用上游文本；上游 JSON 作为补充上下文注入。
  const textInput = inputText(ctx.inputs, 'in-text').trim()
  const jsonInputs = inputJson(ctx.inputs, 'in-json')
  const userContent = [
    textInput,
    ...(jsonInputs.length > 0
      ? [`上下文 JSON：\n${JSON.stringify(jsonInputs.length === 1 ? jsonInputs[0] : jsonInputs)}`]
      : [])
  ]
    .filter(Boolean)
    .join('\n\n')
  if (!userContent) {
    return { status: 'skipped', reason: 'AI 处理节点没有输入文本或 JSON' }
  }

  const reply = await waitForChat(
    {
      providerId: option.provider.id,
      modelId: option.model.id,
      system: config.system || undefined,
      messages: [{ role: 'user', content: userContent }],
      temperature: config.temperature,
      maxTokens: config.maxTokens
    },
    ctx.signal
  )
  if (ctx.signal.cancelled) return { status: 'skipped', reason: '已取消' }

  let result: AiProcessConfig['result']
  try {
    result = normalizeResult(reply, config.mode, config.jsonSchema)
  } catch (error) {
    return { status: 'failed', reason: error instanceof Error ? error.message : String(error) }
  }

  // 写回运行结果到 meta（配置/结果分离）；props.text 只存用户配置，不再混入 result。
  // 输出投影（nodeValues.ts）据此产出对应端口输出。
  ctx.updateResult(JSON.stringify(result))
  return { status: 'done' }
}
