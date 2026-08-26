import type { PortSchemaRef } from './types'

export interface SchemaValidationResult {
  ok: boolean
  errors: string[]
}

export function nodeSchemaRegistered(schema: PortSchemaRef): boolean {
  return (
    `${schema.id}@${schema.version}` === 'json.any@1' ||
    `${schema.id}@${schema.version}` === 'storyboard.shots@1' ||
    `${schema.id}@${schema.version}` === 'list.items@1'
  )
}

function jsonSerializable(value: unknown): string[] {
  if (value === undefined) return ['值不能是 undefined']
  try {
    const encoded = JSON.stringify(value)
    return encoded === undefined ? ['值不是可序列化的 JSON'] : []
  } catch (error) {
    return [error instanceof Error ? error.message : '值不是可序列化的 JSON']
  }
}

function validateStoryboardShots(value: unknown): string[] {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return ['根值必须是对象']
  }
  const shots = (value as Record<string, unknown>).shots
  if (!Array.isArray(shots)) return ['shots 必须是数组']

  const errors: string[] = []
  shots.forEach((shot, index) => {
    if (typeof shot !== 'object' || shot === null || Array.isArray(shot)) {
      errors.push(`shots[${index}] 必须是对象`)
      return
    }
    const item = shot as Record<string, unknown>
    for (const field of ['id', 'scene', 'dialogue', 'duration'] as const) {
      if (item[field] !== undefined && typeof item[field] !== 'string') {
        errors.push(`shots[${index}].${field} 必须是字符串`)
      }
    }
  })
  return errors
}

/**
 * 列表协议 list.items@1：根值必须是数组，每个元素必须是对象（允许任意业务字段，
 * 建议带稳定 id）。供循环/批处理节点输入输出，使批量结果仍是可连接的结构化列表，
 * 而不是把几十个生成资产藏进一个不可连接的节点内部。
 */
function validateListItems(value: unknown): string[] {
  if (!Array.isArray(value)) return ['根值必须是数组']
  const errors: string[] = []
  value.forEach((item, index) => {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) {
      errors.push(`items[${index}] 必须是对象`)
    }
  })
  return errors
}

/**
 * JSON Schema 的轻量版本化仓库。这里返回可直接展示给用户的字段级错误；
 * 新增业务 Schema 时必须同时补充 NODE_CONTRACT_SPEC.md 中的结构说明。
 */
export function validateNodeSchema(schema: PortSchemaRef, value: unknown): SchemaValidationResult {
  let errors: string[]
  switch (`${schema.id}@${schema.version}`) {
    case 'json.any@1':
      errors = jsonSerializable(value)
      break
    case 'storyboard.shots@1':
      errors = [...jsonSerializable(value), ...validateStoryboardShots(value)]
      break
    case 'list.items@1':
      errors = [...jsonSerializable(value), ...validateListItems(value)]
      break
    default:
      errors = [`未注册的 Schema：${schema.id}@${schema.version}`]
  }
  return { ok: errors.length === 0, errors }
}

/**
 * 连线阶段的 Schema 兼容规则：通用 JSON 可与具体 Schema 相连，但会在运行时按
 * 目标 Schema 验证；具体业务 Schema 必须使用完全相同的 ID 与版本。
 */
export function nodeSchemasCompatible(
  source: PortSchemaRef | undefined,
  target: PortSchemaRef | undefined
): boolean {
  if (!source || !target) return false
  if (source.id === 'json.any' || target.id === 'json.any') return true
  return source.id === target.id && source.version === target.version
}
