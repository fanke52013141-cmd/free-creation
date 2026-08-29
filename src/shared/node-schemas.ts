import type { PortSchemaRef } from './types'

export interface SchemaValidationResult {
  ok: boolean
  errors: string[]
}

export function nodeSchemaRegistered(schema: PortSchemaRef): boolean {
  return (
    `${schema.id}@${schema.version}` === 'json.any@1' ||
    `${schema.id}@${schema.version}` === 'storyboard.shots@1' ||
    `${schema.id}@${schema.version}` === 'list.items@1' ||
    `${schema.id}@${schema.version}` === 'character.profile@1' ||
    `${schema.id}@${schema.version}` === 'scene.definition@1' ||
    `${schema.id}@${schema.version}` === 'shot.definition@1' ||
    `${schema.id}@${schema.version}` === 'prompt.bundle@1' ||
    `${schema.id}@${schema.version}` === 'previs.camera@1' ||
    `${schema.id}@${schema.version}` === 'previs.project@1'
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

function objectValue(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  return value as Record<string, unknown>
}

function requiredString(data: Record<string, unknown>, field: string, errors: string[]): void {
  if (typeof data[field] !== 'string' || !data[field].trim()) {
    errors.push(`${field} 必须是非空字符串`)
  }
}

function optionalString(data: Record<string, unknown>, field: string, errors: string[]): void {
  if (data[field] !== undefined && typeof data[field] !== 'string') {
    errors.push(`${field} 必须是字符串`)
  }
}

function optionalStringList(data: Record<string, unknown>, field: string, errors: string[]): void {
  if (data[field] === undefined) return
  if (
    !Array.isArray(data[field]) ||
    !(data[field] as unknown[]).every((item) => typeof item === 'string')
  ) {
    errors.push(`${field} 必须是字符串数组`)
  }
}

/** 角色设定：稳定 ID、名称与人物描述是所有下游提示词/分镜引用的最小公共字段。 */
function validateCharacterProfile(value: unknown): string[] {
  const data = objectValue(value)
  if (!data) return ['根值必须是对象']
  const errors: string[] = []
  requiredString(data, 'id', errors)
  requiredString(data, 'name', errors)
  requiredString(data, 'description', errors)
  for (const field of ['appearance', 'persona', 'voice'] as const)
    optionalString(data, field, errors)
  for (const field of ['tags', 'referenceImageIds'] as const)
    optionalStringList(data, field, errors)
  return errors
}

/** 场景设定：不把媒体二进制塞进数据流，只保存可追溯的媒体 ID 列表。 */
function validateSceneDefinition(value: unknown): string[] {
  const data = objectValue(value)
  if (!data) return ['根值必须是对象']
  const errors: string[] = []
  requiredString(data, 'id', errors)
  requiredString(data, 'name', errors)
  requiredString(data, 'description', errors)
  for (const field of ['location', 'timeOfDay', 'mood'] as const)
    optionalString(data, field, errors)
  for (const field of ['tags', 'referenceImageIds'] as const)
    optionalStringList(data, field, errors)
  return errors
}

/** 单镜头定义：与 storyboard.shots 的单条 shot 对齐，便于后续组装为镜头列表。 */
function validateShotDefinition(value: unknown): string[] {
  const data = objectValue(value)
  if (!data) return ['根值必须是对象']
  const errors: string[] = []
  requiredString(data, 'id', errors)
  requiredString(data, 'scene', errors)
  for (const field of ['dialogue', 'sound', 'camera', 'duration'] as const)
    optionalString(data, field, errors)
  return errors
}

/** 提示词包：文本提示词是唯一必填字段，其余字段是可选、可组合的生成约束。 */
function validatePromptBundle(value: unknown): string[] {
  const data = objectValue(value)
  if (!data) return ['根值必须是对象']
  const errors: string[] = []
  requiredString(data, 'prompt', errors)
  for (const field of ['negativePrompt', 'style', 'aspectRatio'] as const)
    optionalString(data, field, errors)
  if (data.seed !== undefined && (typeof data.seed !== 'number' || !Number.isFinite(data.seed))) {
    errors.push('seed 必须是有限数字')
  }
  optionalStringList(data, 'referenceImageIds', errors)
  return errors
}

/** 导演台摄像机参数：下游生图/视频可直接复用画幅、焦距和镜头节奏。 */
function validatePrevisCamera(value: unknown): string[] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return ['根值必须是对象']
  const data = value as Record<string, unknown>
  const errors: string[] = []
  for (const field of [
    'x',
    'y',
    'z',
    'heading',
    'pitch',
    'focalLengthMm',
    'durationSec'
  ] as const) {
    if (typeof data[field] !== 'number' || !Number.isFinite(data[field])) {
      errors.push(`${field} 必须是有限数字`)
    }
  }
  if (!['16:9', '9:16', '4:3', '3:4'].includes(data.aspectRatio as string)) {
    errors.push('aspectRatio 必须是 16:9、9:16、4:3 或 3:4')
  }
  if (![24, 25, 30].includes(data.fps as number)) errors.push('fps 必须是 24、25 或 30')
  return errors
}

/** 导演工程的轻量可交换摘要；不把二进制模型或图片写入 JSON 数据流。 */
function validatePrevisProject(value: unknown): string[] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return ['根值必须是对象']
  const data = value as Record<string, unknown>
  if (data.version !== 1) return ['version 必须为 1']
  if (!Array.isArray(data.shots)) return ['shots 必须是数组']
  const errors: string[] = []
  data.shots.forEach((shot, index) => {
    if (!shot || typeof shot !== 'object' || Array.isArray(shot)) {
      errors.push(`shots[${index}] 必须是对象`)
      return
    }
    const item = shot as Record<string, unknown>
    if (typeof item.id !== 'string') errors.push(`shots[${index}].id 必须是字符串`)
    if (typeof item.name !== 'string') errors.push(`shots[${index}].name 必须是字符串`)
    const cameraErrors = validatePrevisCamera(item.camera)
    errors.push(...cameraErrors.map((error) => `shots[${index}].camera.${error}`))
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
    case 'character.profile@1':
      errors = [...jsonSerializable(value), ...validateCharacterProfile(value)]
      break
    case 'scene.definition@1':
      errors = [...jsonSerializable(value), ...validateSceneDefinition(value)]
      break
    case 'shot.definition@1':
      errors = [...jsonSerializable(value), ...validateShotDefinition(value)]
      break
    case 'prompt.bundle@1':
      errors = [...jsonSerializable(value), ...validatePromptBundle(value)]
      break
    case 'previs.camera@1':
      errors = [...jsonSerializable(value), ...validatePrevisCamera(value)]
      break
    case 'previs.project@1':
      errors = [...jsonSerializable(value), ...validatePrevisProject(value)]
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
