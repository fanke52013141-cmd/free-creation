import { z } from 'zod'

/**
 * BL-11 / G7：FlowGraph 节点的 `params` 公开配置子集。
 *
 * 这里只登记执行链能够兑现的字段。兼容别名在编译期转换为执行器真正读取的配置；
 * 无法无损转换的字段或枚举必须在 validate/compile 阶段以 CAPABILITY_PARAMS_UNSUPPORTED
 * 拒绝，不能留给 parser 静默丢弃或收敛成另一种操作。
 *
 * 约定：
 * - 未登记的类型/字段不接受 params（CAPABILITY_PARAMS_UNSUPPORTED）；
 * - 值类型、范围或字段组合错误使用 CAPABILITY_PARAMS_INVALID；
 * - 不接收正文（用户提示词走 props.text / FlowNode.goal），不接收密钥。
 */
const featureKey = z.string().trim().min(1).max(80)
const modelKey = z.string().trim().min(1).max(200)

/** speech/tts 的旧 modelKey 只有在能唯一拆成 providerId/modelId 时才兼容。 */
const bindingModelKey = modelKey.refine((value) => {
  const parts = value.split('::')
  return parts.length === 2 && parts.every((part) => part.length > 0)
}, 'modelKey must have exactly one :: separator and non-empty provider/model ids')

const imageGeneration = z
  .object({
    featureKey: featureKey.optional(),
    modelKey: modelKey.optional(),
    size: z.string().trim().min(1).max(40).optional(),
    aspectRatio: z.string().trim().min(1).max(20).optional(),
    resolution: z.enum(['1k', '1.5k', '2k', '4k']).optional(),
    background: z.enum(['transparent']).optional(),
    count: z.number().int().min(1).max(4).optional()
    // providerKey / seed / retry：当前生图执行链不能逐项兑现，明确拒绝。
  })
  .strict()

const videoGeneration = z
  .object({
    featureKey: featureKey.optional(),
    modelKey: modelKey.optional(),
    mode: z.enum(['text', 'first-frame', 'first-last-frame', 'reference']).optional(),
    params: z
      .object({
        ratio: z.string().trim().min(1).max(20).optional(),
        duration: z.number().positive().max(120).optional(),
        resolution: z.string().trim().min(1).max(20).optional(),
        generateAudio: z.boolean().optional(),
        seed: z.number().int().optional(),
        watermark: z.boolean().optional()
      })
      .strict()
      .optional()
    // providerKey：视频执行器不按供应商 ID 选择模型，明确拒绝。
  })
  .strict()

const imageEdit = z
  .object({
    featureKey: featureKey.optional(),
    modelKey: modelKey.optional(),
    size: z.string().trim().min(1).max(40).optional(),
    aspectRatio: z.string().trim().min(1).max(20).optional(),
    instruction: z.string().max(4000).optional()
    // providerKey：P 图执行器只按 featureKey/modelKey 解析，明确拒绝。
  })
  .strict()

const speech = z
  .object({
    featureKey: featureKey.optional(),
    modelKey: bindingModelKey.optional(),
    backend: z.literal('minimax').optional(),
    voice: z.string().trim().min(1).max(200).optional(),
    speed: z.number().min(0.5).max(2).optional()
  })
  .strict()

const tts = z
  .object({
    modelKey: bindingModelKey.optional(),
    backend: z.literal('minimax').optional()
    // featureKey：克隆执行器不使用功能绑定，明确拒绝。
  })
  .strict()

const processor = z
  .object({
    operation: z.enum(['pass', 'template', 'field']).optional(),
    field: z.string().trim().min(1).max(200).optional(),
    template: z.string().max(4096).optional()
  })
  .strict()
  .superRefine((value, context) => {
    if (value.operation === 'field' && !value.field)
      context.addIssue({
        code: 'custom',
        path: ['field'],
        message: 'field operation requires a non-empty field'
      })
    if (value.field !== undefined && value.operation !== 'field')
      context.addIssue({
        code: 'custom',
        path: ['field'],
        message: 'field requires operation=field'
      })
  })

/** 载体类型 → 公开参数 Schema（只登记已验收的媒体/文本能力）。 */
export const NODE_PARAMS_SCHEMAS: Record<string, z.ZodTypeAny> = {
  'image-gen': imageGeneration,
  video: videoGeneration,
  'image-edit': imageEdit,
  speech,
  tts,
  processor
}

export type NodeParamsErrorCode = 'CAPABILITY_PARAMS_INVALID' | 'CAPABILITY_PARAMS_UNSUPPORTED'
export type NodeParamsFailure = {
  ok: false
  code: NodeParamsErrorCode
  message: string
}
export type NodeParamsValidation = { ok: true } | NodeParamsFailure
export type NodeParamsResolution = { ok: true; params: Record<string, unknown> } | NodeParamsFailure

function splitBindingModelKey(value: string): { providerId: string; modelId: string } {
  const [providerId, modelId] = value.split('::')
  return { providerId: providerId!, modelId: modelId! }
}

/**
 * 校验并生成执行器配置补丁。返回新对象，不修改公开 params。
 * 只有下列无损别名会保留兼容：
 * - processor operation=field + field → operation=pick + path；
 * - speech/tts modelKey → providerId + modelId；
 * - speech voice → voiceId。
 */
export function resolveNodeParams(
  typeId: string,
  params: unknown,
  carrierConfig?: string
): NodeParamsResolution {
  const schema = NODE_PARAMS_SCHEMAS[typeId]
  if (!schema)
    return {
      ok: false,
      code: 'CAPABILITY_PARAMS_UNSUPPORTED',
      message: `node type ${typeId} does not accept params`
    }
  const parsed = schema.safeParse(params)
  if (!parsed.success) {
    const issue = parsed.error.issues[0]
    const unsupported = issue?.code === 'unrecognized_keys' || issue?.code === 'invalid_value'
    return {
      ok: false,
      code: unsupported ? 'CAPABILITY_PARAMS_UNSUPPORTED' : 'CAPABILITY_PARAMS_INVALID',
      message: `${issue?.path.join('.') ?? 'params'}: ${issue?.message ?? 'invalid'}`
    }
  }
  const value = parsed.data as Record<string, unknown>
  if (typeId === 'processor' && value.template !== undefined && value.operation !== 'template') {
    let defaultOperation: unknown
    try {
      defaultOperation = (JSON.parse(carrierConfig ?? '{}') as Record<string, unknown>).operation
    } catch {
      defaultOperation = undefined
    }
    // text-template 的载体默认就是 template，单独覆盖模板是既有有效路径；
    // text-pass 或其他操作下该字段会被忽略，必须在编译前拒绝。
    if (value.operation !== undefined || defaultOperation !== 'template')
      return {
        ok: false,
        code: 'CAPABILITY_PARAMS_INVALID',
        message: 'template: template requires operation=template (or a template carrier default)'
      }
  }
  if (typeId === 'processor' && value.operation === 'field') {
    const { field, ...rest } = value
    return { ok: true, params: { ...rest, operation: 'pick', path: field } }
  }
  if (typeId === 'speech' || typeId === 'tts') {
    const mapped = { ...value }
    if (typeof value.modelKey === 'string') {
      Object.assign(mapped, splitBindingModelKey(value.modelKey))
      delete mapped.modelKey
    }
    if (typeId === 'speech' && typeof value.voice === 'string') {
      mapped.voiceId = value.voice
      delete mapped.voice
    }
    return { ok: true, params: mapped }
  }
  return { ok: true, params: value }
}

/** 按载体类型校验 params；不改变既有调用方的成功返回形状。 */
export function validateNodeParams(
  typeId: string,
  params: unknown,
  carrierConfig?: string
): NodeParamsValidation {
  const resolved = resolveNodeParams(typeId, params, carrierConfig)
  return resolved.ok ? { ok: true } : resolved
}
