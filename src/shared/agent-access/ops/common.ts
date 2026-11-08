import { z } from 'zod'
import { SkillBindingSchema } from '../../agent-flow/runtime-contracts'

/**
 * 外部接入 Registry 的公共字段 Schema。
 *
 * 拆分为按族模块（F6 收尾起）是为了让每个业务族在自己的文件里增删操作，
 * 避免所有维护者都改同一个 800 行文件；Registry 的对外产物
 * （operationDirectory / 契约快照）必须保持等价，任何 Schema 变化仍要
 * 走 check-agent-access.cjs --write --accept-contract-change。
 */
export const identifier = z.string().regex(/^[a-zA-Z0-9_-]{1,80}$/)
export const empty = z.object({}).strict()
export const project = z.object({ projectId: identifier }).strict()
export const revision = project.extend({ expectedGraphVersion: z.number().int().nonnegative() }).strict()
export const page = z
  .object({
    offset: z.number().int().min(0).max(100000).default(0),
    limit: z.number().int().min(1).max(100).default(50)
  })
  .strict()

export const nodeId = z.string().regex(/^shape:[a-zA-Z0-9_-]{1,160}$/)
export const skillSummary = z
  .object({
    id: z.string(),
    version: z.string(),
    name: z.string(),
    description: z.string(),
    contentHash: z.string()
  })
  .strict()
export const bindings = z.array(SkillBindingSchema).max(8)
export const templateSummary = z
  .object({
    id: identifier,
    name: z.string(),
    createdAt: z.number(),
    nodeCount: z.number().int().nonnegative()
  })
  .strict()

export const metadata = z
  .object({
    id: identifier,
    name: z.string(),
    createdAt: z.number(),
    updatedAt: z.number(),
    graphVersion: z.number().int().nonnegative(),
    coverMediaId: z.string().optional()
  })
  .strict()
export const savedMetadata = z.object({ meta: metadata, saved: z.literal(true) }).strict()

/** 业务族在 Registry 中登记的形态：effect + 描述 + 严格输入 Schema。 */
export type AccessOperationSpec = {
  readonly effect: 'read' | 'write' | 'export' | 'delete' | 'execute'
  readonly description: string
  readonly input: z.ZodType
}
