// AI 处理节点执行器（路线图 R3 / 契约规范 P3）
//
// 做「一次性、可复跑」的工作流转换：把上游文本/JSON 交给文本模型，按输出模式
// 产出 text / markdown / 指定 Schema 的 json。与对话节点不同，它不保留多轮历史，
// 只做单次转换，输出可验证、可单独调试，不把普通文本伪装成 JSON。
//
// 配置存储在 shape.props.config（JSON 字符串）：
//   { modelKey, system, mode: 'text'|'markdown'|'json', jsonSchema?, temperature, maxTokens,
//     result?: { kind, text?/data? } }
import { inputJson, inputText } from '../inputs'
import type { NodeExecutionContext, NodeExecutionResult } from '../executor-types'
import { validateNodeSchema } from '@shared/node-schemas'
import type { PortSchemaRef } from '@shared/types'
import { featureKeyOf, modelKeyOf, resolveFeatureOption } from '../models'
import { parseJsonObj, waitForChat } from '../helpers'
import { readNodeConfig } from '../node-config'
import { parseRetryConfig, withRetry, type RetryConfig } from '../retry'

export type AiOutputMode = 'text' | 'markdown' | 'json'

export interface AiProcessConfig {
  modelKey: string
  /** Selected verified model profile; raw provider/model are never execution inputs. */
  featureKey?: string
  system: string
  mode: AiOutputMode
  /**
   * json 模式的输出 Schema；未显式选择时默认 json.any（宽容校验），用户可换
   * storyboard.shots 等业务 Schema 收紧。text/markdown 模式忽略。
   */
  jsonSchema?: PortSchemaRef
  temperature: number
  maxTokens: number
  /** 供应商波动（空返回 / 坏 JSON / 瞬时网络错误）的自动重试配置（W1）。 */
  retry: RetryConfig
  /** 上次运行结果，供输出投影读取。 */
  result?: { kind: 'text' | 'markdown' | 'json'; text?: string; data?: unknown }
}

export function parseAiProcess(text: string): AiProcessConfig {
  const value = parseJsonObj(text)
  const mode: AiOutputMode =
    value?.mode === 'json' || value?.mode === 'markdown' ? value.mode : 'text'
  const rawSchema = value?.jsonSchema as Record<string, unknown> | undefined
  // W9：json 模式未显式选 Schema 时默认 json.any——把「忘选 Schema 就运行报错」
  // 换成「默认宽容校验、需要严格结构时再选业务 Schema」；失败语义仍由校验器把守。
  const jsonSchema =
    rawSchema && typeof rawSchema.id === 'string' && typeof rawSchema.version === 'number'
      ? { id: rawSchema.id, version: rawSchema.version }
      : mode === 'json'
        ? { id: 'json.any', version: 1 }
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
    ...(typeof value?.featureKey === 'string' ? { featureKey: value.featureKey } : {}),
    system: typeof value?.system === 'string' ? value.system : '',
    mode,
    jsonSchema,
    temperature: typeof value?.temperature === 'number' ? value.temperature : 0.7,
    maxTokens: typeof value?.maxTokens === 'number' ? value.maxTokens : 4096,
    retry: parseRetryConfig(value),
    result
  }
}

/**
 * 剥离模型输出中包裹 JSON 的 markdown 围栏与前后缀说明文字（glm 系模型高频带 ```json 围栏）。
 * 只做解析前的宽容提取，不改变失败语义：提取不出候选 JSON 时原样交给 JSON.parse 报错。
 */
export function stripJsonFences(raw: string): string {
  const trimmed = raw.trim()
  const fenced = trimmed.match(/^```[a-zA-Z0-9]*\s*([\s\S]*?)\s*```$/)
  if (fenced) return fenced[1].trim()
  // 无围栏但前后有说明文字：取首个 { 或 [ 到最后一个 } 或 ] 的区间
  const start = trimmed.search(/[{[]/)
  if (start > 0) {
    const end = Math.max(trimmed.lastIndexOf('}'), trimmed.lastIndexOf(']'))
    if (end > start) return trimmed.slice(start, end + 1)
  }
  return trimmed
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
    data = JSON.parse(stripJsonFences(raw))
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
  const config = parseAiProcess(readNodeConfig(ctx.shape))
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
  // Compatibility for offline executor tests only. Desktop always provides the feature resolver
  // and therefore ignores legacy node-level modelKey values.
  if (!ctx.gateway.resolveModelFeature && !config.modelKey) {
    return { status: 'skipped', reason: '未选择可用文本模型' }
  }
  const option = await resolveFeatureOption(
    ctx.gateway,
    ctx.providers,
    featureKeyOf(config, 'text.process'),
    'text.generate',
    modelKeyOf(config)
  )
  if (!option) return { status: 'skipped', reason: '功能 text.process 尚未绑定已验证文本模型' }

  // W1：模型调用与输出规范化整体纳入重试。可重试错误（空返回 / 坏 JSON / Schema
  // 校验不过 / 瞬时网络错误）按指数退避重试；配置类错误立即失败。取消随时生效。
  let result: AiProcessConfig['result']
  try {
    const normalized = await withRetry(
      async () => {
        const reply = await waitForChat(
          ctx.gateway,
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
        if (ctx.signal.cancelled) throw new Error('已取消')
        // text/markdown 模式空回复不得标成功：零输出会把错误推迟到下游 skipped，
        // 难以定位（R-19）；json 模式的空回复会在 normalizeResult 里报「不是合法 JSON」。
        // 两者都属可重试的模型随机性失败，交给 withRetry 分类处理。
        if (config.mode !== 'json' && !reply.trim()) throw new Error('模型返回为空')
        return { reply, result: normalizeResult(reply, config.mode, config.jsonSchema) }
      },
      {
        retry: config.retry,
        signal: ctx.signal,
        onRetry: (attempt, reason, delayMs) =>
          ctx.trace?.('request', 'info', `第 ${attempt} 次尝试失败（${reason}），${delayMs}ms 后自动重试`)
      }
    )
    result = normalized.result
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (message === '已取消' || ctx.signal.cancelled) {
      return { status: 'skipped', reason: '已取消' }
    }
    return { status: 'failed', reason: message }
  }

  // 写回运行结果到 meta（配置/结果分离）；props.config 不再混入 result。
  // 输出投影（nodeValues.ts）据此产出对应端口输出。
  ctx.updateResult(JSON.stringify(result))
  return { status: 'done', artifactOutputPorts: [`out-${config.mode}`] }
}
