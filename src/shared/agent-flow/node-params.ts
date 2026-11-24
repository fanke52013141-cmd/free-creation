import { z } from 'zod'

/**
 * BL-11 / G7：FlowGraph 节点的 `params` 公开配置子集。
 *
 * 节点配置的真值在各执行器（`readNodeConfig` + 各 `normalize*`），shared 侧无法直接导入
 * renderer 规格；这里登记的是**可被外部编排覆盖的配置子集**（与执行器读取的字段同名），
 * 由 `validateFlowGraph` 在编译前校验，编译器把 params 合并进固定配置。
 *
 * 约定：
 * - 未登记的类型不接受 params（`CAPABILITY_PARAMS_UNSUPPORTED`），不静默丢弃；
 * - 全部字段可选，缺省沿用节点默认配置；
 * - 不接收正文（用户提示词走 props.text / FlowNode.goal），不接收密钥。
 */
const retry = z
  .object({
    maxRetries: z.number().int().min(0).max(5),
    backoffMs: z.number().int().min(0).max(60_000).optional()
  })
  .strict()

const imageGeneration = z
  .object({
    featureKey: z.string().min(1).max(80).optional(),
    modelKey: z.string().min(1).max(200).optional(),
    providerKey: z.string().min(1).max(200).optional(),
    size: z.string().min(1).max(40).optional(),
    aspectRatio: z.string().min(1).max(20).optional(),
    resolution: z.enum(['1k', '1.5k', '2k', '4k']).optional(),
    background: z.enum(['transparent']).optional(),
    count: z.number().int().min(1).max(4).optional(),
    seed: z.number().int().optional(),
    retry: retry.optional()
  })
  .strict()

const videoGeneration = z
  .object({
    featureKey: z.string().min(1).max(80).optional(),
    modelKey: z.string().min(1).max(200).optional(),
    providerKey: z.string().min(1).max(200).optional(),
    mode: z.enum(['text', 'first-frame', 'first-last-frame', 'reference']).optional(),
    params: z
      .object({
        ratio: z.string().min(1).max(20).optional(),
        duration: z.number().positive().max(120).optional(),
        resolution: z.string().min(1).max(20).optional(),
        generateAudio: z.boolean().optional(),
        seed: z.number().int().optional(),
        watermark: z.boolean().optional()
      })
      .strict()
      .optional()
  })
  .strict()

const imageEdit = z
  .object({
    featureKey: z.string().min(1).max(80).optional(),
    modelKey: z.string().min(1).max(200).optional(),
    providerKey: z.string().min(1).max(200).optional(),
    size: z.string().min(1).max(40).optional(),
    aspectRatio: z.string().min(1).max(20).optional(),
    instruction: z.string().max(4000).optional()
  })
  .strict()

const speech = z
  .object({
    featureKey: z.string().min(1).max(80).optional(),
    modelKey: z.string().min(1).max(200).optional(),
    backend: z.enum(['minimax', 'openai']).optional(),
    voice: z.string().min(1).max(200).optional(),
    speed: z.number().min(0.2).max(3).optional()
  })
  .strict()

const tts = z
  .object({
    featureKey: z.string().min(1).max(80).optional(),
    modelKey: z.string().min(1).max(200).optional(),
    backend: z.enum(['minimax', 'openai']).optional()
  })
  .strict()

const processor = z
  .object({
    operation: z.enum(['pass', 'template', 'field', 'merge']).optional(),
    field: z.string().max(200).optional(),
    template: z.string().max(4096).optional()
  })
  .strict()

/** 载体类型 → 公开参数 Schema（只登记已验收的媒体/文本能力）。 */
export const NODE_PARAMS_SCHEMAS: Record<string, z.ZodTypeAny> = {
  'image-gen': imageGeneration,
  video: videoGeneration,
  'image-edit': imageEdit,
  speech,
  tts,
  processor
}

export type NodeParamsValidation = { ok: true } | { ok: false; message: string }

/** 按载体类型校验 params；未登记类型明确拒绝（不静默忽略）。 */
export function validateNodeParams(typeId: string, params: unknown): NodeParamsValidation {
  const schema = NODE_PARAMS_SCHEMAS[typeId]
  if (!schema) return { ok: false, message: `node type ${typeId} does not accept params` }
  const parsed = schema.safeParse(params)
  if (parsed.success) return { ok: true }
  const issue = parsed.error.issues[0]
  return {
    ok: false,
    message: `${issue?.path.join('.') ?? 'params'}: ${issue?.message ?? 'invalid'}`
  }
}
