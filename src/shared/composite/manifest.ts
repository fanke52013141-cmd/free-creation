import { z } from 'zod'
import type { PortCardinality, PortType } from '../types'

/**
 * 组合能力 manifest（P1）。
 *
 * 这是一份“发布后不可变”的契约：公开端口、内部稳定图、显式映射与依赖都在里面。
 * 画布 composite 节点只保存 capabilityId + version + 这份快照的摘要；运行器按快照执行。
 *
 * 说明：本文件只定义数据形状与静态校验，不依赖 renderer 节点注册表；端口是否存在、
 * 类型是否兼容由 renderer 的 validateCompositeAgainstSpecs() 完成（P1 后续实现）。
 */
export const COMPOSITE_SCHEMA_VERSION = 1

/**
 * 运行语义版本（W1）：
 * - 1（缺省，历史版本）：外部文本直接替换文本节点正文；公开输出只收集首个媒体结果。
 * - 2：外部文本作为虚拟上游接入契约声明的 `in-text`，沿用普通文本节点的合并/投影；
 *   公开输出按本次运行的映射结果收集，支持文本与 JSON。
 *
 * 历史已发布版本不写该字段，继续按 1 运行；新封装/新发布写 2。字段是加性的，
 * schemaVersion 保持 1，旧客户端忽略它即可。
 */
export const COMPOSITE_RUNTIME_VERSION_LEGACY = 1
export const COMPOSITE_RUNTIME_VERSION = 2
export const COMPOSITE_RUNTIME_VERSIONS = [
  COMPOSITE_RUNTIME_VERSION_LEGACY,
  COMPOSITE_RUNTIME_VERSION
] as const

export const COMPOSITE_PORT_TYPES = [
  'text',
  'markdown',
  'json',
  'image',
  'video',
  'audio',
  'file',
  'any'
] as const satisfies readonly PortType[]

export const compositePortTypeSchema = z.enum(COMPOSITE_PORT_TYPES)
export const compositeCardinalitySchema = z.enum(['one', 'many']) satisfies z.ZodType<PortCardinality>

/** 稳定的公开端口 ID：小写字母/数字/短横线，发布后不可复用。 */
const publicPortIdSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z][a-z0-9-]*$/, '公开端口 ID 必须以小写字母开头，只允许小写字母/数字/短横线')

/** 内部节点稳定 ID：由保存时生成，发布后不可改；数组下标不能作为长期身份。 */
const internalNodeIdSchema = z
  .string()
  .min(1)
  .max(80)
  .regex(/^[a-zA-Z0-9][a-zA-Z0-9._:-]*$/, '内部节点 ID 只能包含字母/数字/._:-')

const internalPortIdSchema = z.string().min(1).max(80)

export const compositeTargetSchema = z
  .object({
    nodeId: internalNodeIdSchema,
    portId: internalPortIdSchema
  })
  .strict()

export const compositePortSchema = z
  .object({
    id: publicPortIdSchema,
    label: z.string().trim().min(1).max(80),
    type: compositePortTypeSchema,
    required: z.boolean(),
    cardinality: compositeCardinalitySchema,
    description: z.string().trim().max(300).optional(),
    /** JSON Schema 片段；复杂类型用它约束 GUI 控件与 CLI/MCP 值。 */
    schema: z.record(z.string(), z.unknown()).optional(),
    /** 项目 PortDecl 的 JSON 结构引用（JSON 端口必须命中 node-schemas 白名单）。 */
    schemaRef: z.object({ id: z.string().min(1).max(80), version: z.number().int().positive() }).strict().optional(),
    defaultValue: z.unknown().optional()
  })
  .strict()

export const compositeInputSchema = compositePortSchema
  .extend({
    /** 一个公开输入可以广播给多个兼容内部目标（第一版允许）。 */
    targets: z.array(compositeTargetSchema).min(1)
  })
  .strict()

export const compositeOutputSchema = compositePortSchema
  .extend({
    /** 第一版每个公开输出绑定一个内部输出。 */
    source: compositeTargetSchema
  })
  .strict()

export const compositeGraphNodeSchema = z
  .object({
    id: internalNodeIdSchema,
    nodeType: z.string().min(1).max(60),
    /** 固定内部节点契约版本；端口快照必须能按该版本复现。 */
    contractVersion: z.number().int().positive(),
    title: z.string().trim().max(200),
    dx: z.number(),
    dy: z.number(),
    w: z.number().positive(),
    h: z.number().positive(),
    text: z.string().optional(),
    config: z.string().optional(),
    /** 端口快照：发布后不依赖当前节点注册表也能校验映射。 */
    ports: z
      .array(
        z
          .object({
            id: z.string().min(1).max(80),
            name: z.string().min(1).max(80),
            dir: z.enum(['in', 'out']),
            type: compositePortTypeSchema,
            required: z.boolean(),
            cardinality: compositeCardinalitySchema,
            schemaRef: z
              .object({ id: z.string().min(1).max(80), version: z.number().int().positive() })
              .strict()
              .optional()
          })
          .strict()
      )
      .optional(),
    /** 固定媒体依赖：只保存引用，不复制二进制。 */
    mediaRefs: z
      .array(
        z
          .object({
            mediaId: z.string().min(1).max(120),
            mediaPath: z.string().min(1).max(500),
            mime: z.string().min(1).max(120)
          })
          .strict()
      )
      .optional()
  })
  .strict()

export const compositeGraphEdgeSchema = z
  .object({
    from: compositeTargetSchema,
    to: compositeTargetSchema
  })
  .strict()

export const compositeDependencySchema = z
  .object({
    kind: z.enum(['node', 'capability', 'media', 'model']),
    id: z.string().min(1).max(120),
    /** 节点契约版本或组合固定版本；media 依赖可省略。 */
    version: z.string().min(1).max(40).optional(),
    contractVersion: z.number().int().positive().optional()
  })
  .strict()

export const compositeExecutionPolicySchema = z
  .object({
    timeoutMs: z.number().int().positive().max(24 * 60 * 60 * 1000).optional(),
    maxDepth: z.number().int().positive().max(16).optional(),
    maxExpandedNodes: z.number().int().positive().max(500).optional(),
    maxExpandedEdges: z.number().int().positive().max(1500).optional(),
    /** 是否允许运行中暂停等待补输入。 */
    waitForInput: z.boolean().optional(),
    /** 内部节点如含人工发布/审核，必须在能力描述中标记。 */
    requiresManualGate: z.boolean().optional()
  })
  .strict()

export const compositeManifestSchema = z
  .object({
    schemaVersion: z.literal(COMPOSITE_SCHEMA_VERSION),
    /** 缺省=1（历史运行语义）；新发布使用 2。 */
    runtimeVersion: z.number().int().min(1).max(2).optional(),
    capabilityId: z
      .string()
      .min(1)
      .max(80)
      .regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/, 'capabilityId 只能包含字母/数字/._-'),
    version: z
      .string()
      .regex(/^\d+\.0(\.0)?$/, '版本必须为主版本整数（例如 1.0、2.0、3.0）'),
    name: z.string().trim().min(1).max(120),
    description: z.string().trim().max(600).optional(),
    tags: z.array(z.string().trim().min(1).max(40)).max(20).optional(),
    inputs: z.array(compositeInputSchema).max(32),
    outputs: z.array(compositeOutputSchema).min(1).max(32),
    graph: z
      .object({
        nodes: z.array(compositeGraphNodeSchema).min(1).max(200),
        edges: z.array(compositeGraphEdgeSchema).max(500)
      })
      .strict(),
    dependencies: z.array(compositeDependencySchema).max(200).optional(),
    executionPolicy: compositeExecutionPolicySchema.optional(),
    /** 发布时计算；草稿可为空。用于完整性校验，不参与语义。 */
    contentHash: z.string().regex(/^[a-f0-9]{64}$/).optional()
  })
  .strict()

export type CompositeTarget = z.infer<typeof compositeTargetSchema>
export type CompositePort = z.infer<typeof compositePortSchema>
export type CompositeInput = z.infer<typeof compositeInputSchema>
export type CompositeOutput = z.infer<typeof compositeOutputSchema>
export type CompositeGraphNode = z.infer<typeof compositeGraphNodeSchema>
export type CompositeGraphEdge = z.infer<typeof compositeGraphEdgeSchema>
export type CompositeDependency = z.infer<typeof compositeDependencySchema>
export type CompositeExecutionPolicy = z.infer<typeof compositeExecutionPolicySchema>
export type CompositeManifest = z.infer<typeof compositeManifestSchema>

/** 解析运行语义版本；历史 manifest 缺省按 1 处理。 */
export function compositeRuntimeVersion(
  manifest: Pick<CompositeManifest, 'runtimeVersion'>
): 1 | 2 {
  return manifest.runtimeVersion === COMPOSITE_RUNTIME_VERSION
    ? COMPOSITE_RUNTIME_VERSION
    : COMPOSITE_RUNTIME_VERSION_LEGACY
}

export interface CompositeManifestIssue {
  path: string
  message: string
}

export type CompositeManifestParseResult =
  | { ok: true; manifest: CompositeManifest }
  | { ok: false; issues: CompositeManifestIssue[] }

/** 解析并做不依赖节点注册表的静态一致性检查。 */
export function parseCompositeManifest(value: unknown): CompositeManifestParseResult {
  const parsed = compositeManifestSchema.safeParse(value)
  if (!parsed.success) {
    return {
      ok: false,
      issues: parsed.error.issues.map((issue) => ({
        path: issue.path.map(String).join('.'),
        message: issue.message
      }))
    }
  }
  const issues = validateCompositeManifestStructure(parsed.data)
  return issues.length > 0 ? { ok: false, issues } : { ok: true, manifest: parsed.data }
}

/** 不需要知道节点 Spec 就能判定的结构错误。 */
export function validateCompositeManifestStructure(
  manifest: CompositeManifest
): CompositeManifestIssue[] {
  const issues: CompositeManifestIssue[] = []
  const nodeIds = new Set<string>()
  for (const node of manifest.graph.nodes) {
    if (nodeIds.has(node.id)) issues.push({ path: `graph.nodes.${node.id}`, message: '内部节点 ID 重复' })
    nodeIds.add(node.id)
  }
  const edgeIds = new Set<string>()
  for (const [index, edge] of manifest.graph.edges.entries()) {
    for (const end of [edge.from, edge.to]) {
      if (!nodeIds.has(end.nodeId))
        issues.push({ path: `graph.edges.${index}`, message: `连线引用了不存在的内部节点 ${end.nodeId}` })
    }
    const key = `${edge.from.nodeId}:${edge.from.portId}->${edge.to.nodeId}:${edge.to.portId}`
    if (edgeIds.has(key)) issues.push({ path: `graph.edges.${index}`, message: '重复连线' })
    edgeIds.add(key)
  }
  const inputIds = new Set<string>()
  for (const [index, input] of manifest.inputs.entries()) {
    if (inputIds.has(input.id)) issues.push({ path: `inputs.${index}`, message: '公开输入 ID 重复' })
    inputIds.add(input.id)
    for (const target of input.targets) {
      if (!nodeIds.has(target.nodeId))
        issues.push({ path: `inputs.${index}.targets`, message: `映射到不存在的内部节点 ${target.nodeId}` })
    }
  }
  const outputIds = new Set<string>()
  for (const [index, output] of manifest.outputs.entries()) {
    if (outputIds.has(output.id)) issues.push({ path: `outputs.${index}`, message: '公开输出 ID 重复' })
    outputIds.add(output.id)
    if (!nodeIds.has(output.source.nodeId))
      issues.push({ path: `outputs.${index}.source`, message: `来源是不存在的内部节点 ${output.source.nodeId}` })
  }
  // 公开输出必须来自内部图；P1 的端口存在性由 renderer 校验补足。
  if (manifest.outputs.length === 0) issues.push({ path: 'outputs', message: '至少需要一个公开输出' })
  return issues
}

/** 规范化后用于内容摘要；排除 contentHash 自身。 */
export function canonicalCompositeJson(manifest: CompositeManifest): string {
  const { contentHash: _contentHash, ...rest } = manifest
  void _contentHash
  return stableStringify(rest)
}

/** SHA-256 内容摘要（发布/导入校验用）。Web 与 Node 22 都提供 globalThis.crypto.subtle。 */
export async function compositeContentHash(manifest: CompositeManifest): Promise<string> {
  const bytes = new TextEncoder().encode(canonicalCompositeJson(manifest))
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes)
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('')
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`
  const record = value as Record<string, unknown>
  const keys = Object.keys(record).sort()
  return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`).join(',')}}`
}
