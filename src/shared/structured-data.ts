import type { PortSchemaRef } from './types'

export interface StructuredDataConfig {
  schema: PortSchemaRef
}

const JSON_ANY_OPTION = {
  schema: { id: 'json.any', version: 1 },
  label: '通用 JSON',
  hint: '任意 JSON 数据'
} satisfies { schema: PortSchemaRef; label: string; hint: string }

export const STRUCTURED_SCHEMA_OPTIONS: Array<{
  schema: PortSchemaRef
  label: string
  hint: string
}> = [
  {
    schema: { id: 'character.profile', version: 1 },
    label: '角色设定',
    hint: '角色 ID、名称、描述'
  },
  {
    schema: { id: 'scene.definition', version: 1 },
    label: '场景设定',
    hint: '场景 ID、名称、描述'
  },
  { schema: { id: 'shot.definition', version: 1 }, label: '镜头定义', hint: '镜头 ID、画面描述' },
  { schema: { id: 'prompt.bundle', version: 1 }, label: '提示词包', hint: '提示词与可选生成约束' },
  {
    schema: { id: 'storyboard.shots', version: 1 },
    label: '分镜列表',
    hint: '可交给分镜板或导演台'
  },
  { schema: { id: 'list.items', version: 1 }, label: '对象列表', hint: '可交给循环节点批处理' },
  JSON_ANY_OPTION
]

const FALLBACK_SCHEMA: PortSchemaRef = JSON_ANY_OPTION.schema

export function schemaKey(schema: PortSchemaRef): string {
  return `${schema.id}@${schema.version}`
}

export function schemaOption(schema: PortSchemaRef): (typeof STRUCTURED_SCHEMA_OPTIONS)[number] {
  return (
    STRUCTURED_SCHEMA_OPTIONS.find((option) => schemaKey(option.schema) === schemaKey(schema)) ??
    JSON_ANY_OPTION
  )
}

export function parseStructuredDataConfig(text: string): StructuredDataConfig {
  try {
    const value = JSON.parse(text) as { schema?: unknown }
    const schema = value.schema as Partial<PortSchemaRef> | undefined
    if (
      schema &&
      typeof schema.id === 'string' &&
      typeof schema.version === 'number' &&
      STRUCTURED_SCHEMA_OPTIONS.some(
        (option) => schemaKey(option.schema) === `${schema.id}@${schema.version}`
      )
    ) {
      return { schema: { id: schema.id, version: schema.version } }
    }
  } catch {
    // 缺失或损坏配置安全回退为通用 JSON；不猜测业务结构。
  }
  return { schema: FALLBACK_SCHEMA }
}

function valueAtPath(value: unknown, path: string): unknown {
  return path
    .split('.')
    .filter(Boolean)
    .reduce<unknown>((current, key) => {
      if (!current || typeof current !== 'object' || Array.isArray(current)) return undefined
      return (current as Record<string, unknown>)[key]
    }, value)
}

function stringifyInterpolation(value: unknown): string {
  if (value === undefined || value === null) return ''
  return typeof value === 'string' ? value : JSON.stringify(value)
}

/**
 * 仅从本节点已声明的 in-context / in-text 输入解析模板变量，绝不扫描上游节点。
 * 完整占位符会保留对象或数组本身；嵌入字符串则序列化为可读文本。
 */
export function interpolateStructuredValue(
  value: unknown,
  contexts: unknown[],
  text: string
): unknown {
  if (Array.isArray(value))
    return value.map((item) => interpolateStructuredValue(item, contexts, text))
  if (!value || typeof value !== 'object') {
    if (typeof value !== 'string') return value
    const whole = value.match(/^\{\{\s*(text|input\[(\d+)\]((?:\.[A-Za-z0-9_-]+)*)?)\s*\}\}$/)
    const resolve = (token: string): unknown => {
      if (token === 'text') return text
      const match = token.match(/^input\[(\d+)\]((?:\.[A-Za-z0-9_-]+)*)?$/)
      if (!match) return undefined
      const context = contexts[Number(match[1])]
      return valueAtPath(context, match[2]?.slice(1) ?? '')
    }
    if (whole) return resolve(whole[1]!)
    return value.replace(/\{\{\s*(text|input\[\d+\](?:\.[A-Za-z0-9_-]+)*)\s*\}\}/g, (_, token) =>
      stringifyInterpolation(resolve(token))
    )
  }
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([key, item]) => [
      key,
      interpolateStructuredValue(item, contexts, text)
    ])
  )
}
