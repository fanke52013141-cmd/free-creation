import { z } from 'zod'
import { canonicalFlowJson } from './semantic-revision'

/**
 * AF-01 阶段契约（声明式，纯共享协议；main 不导入 React）。
 * 阶段目标/完成条件/进入条件来自固定图配置，运行时不由模型重写。
 * 条件解释器只支持声明式比较，不执行任意用户脚本。
 */
const id = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[a-zA-Z0-9_.:-]+$/)

// 与 node-contracts.AgentFlowAssetRefSchema 同构（本地定义避免循环导入）。
const assetRef = z
  .object({ assetId: id, versionId: id, sourceNodeId: id, sourcePortId: id })
  .strict()

/**
 * 首版进入条件（方案 §4.3）：字段存在/类型/值比较、集合大小、
 * 所引用交付是否已采用（人工决定）、指定版本审核是否通过。
 */
export const StageConditionSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('output-field'),
      /** 已交付阶段的 stageKey；条件针对该阶段正式交付的输出值。 */
      stageKey: id,
      /** 点路径（数组下标为数字段）；文本/markdown 交付的根为 { text }。 */
      path: z.string().min(1).max(256),
      op: z.enum(['exists', 'missing', 'equals', 'type']),
      value: z.unknown().optional(),
      valueType: z.enum(['string', 'number', 'boolean', 'object', 'array']).optional()
    })
    .strict()
    .superRefine((condition, context) => {
      if (condition.op === 'equals' && condition.value === undefined)
        context.addIssue({ code: 'custom', message: 'equals requires a value' })
      if (condition.op === 'type' && !condition.valueType)
        context.addIssue({ code: 'custom', message: 'type requires valueType' })
    }),
  z
    .object({
      kind: z.literal('output-count'),
      stageKey: id,
      op: z.enum(['gte', 'lte']),
      count: z.number().int().min(0).max(128)
    })
    .strict(),
  z.object({ kind: z.literal('human-decision'), stageKey: id }).strict(),
  z.object({ kind: z.literal('review-passed'), reviewNodeId: id }).strict()
])
export type StageCondition = z.infer<typeof StageConditionSchema>

/**
 * AF-02 输入编制：阶段只读取声明范围内的内容（字段/片段），而非全部上游历史。
 * 选择器指向已交付阶段的输出；path 为点路径（空=整值），文本交付的根为 { text }。
 */
export const ContextSelectorSchema = z
  .object({
    sourceStageKey: id,
    path: z.string().max(256).default(''),
    required: z.boolean().default(true),
    purpose: z.string().max(256).optional()
  })
  .strict()
export type ContextSelector = z.infer<typeof ContextSelectorSchema>

export const StageInputsSchema = z
  .object({
    selectors: z.array(ContextSelectorSchema).min(1).max(32),
    /** 阶段输入预算（字节）；与模型容量取较小值由宿主负责，此处为声明上限。 */
    budgetBytes: z.number().int().min(1024).max(1048576).default(131072)
  })
  .strict()
  .superRefine((inputs, context) => {
    const keys = inputs.selectors.map((s) => JSON.stringify([s.sourceStageKey, s.path]))
    if (new Set(keys).size !== keys.length)
      context.addIssue({ code: 'custom', message: 'Duplicate context selectors' })
  })
export type StageInputs = z.infer<typeof StageInputsSchema>

/** AF-02：ContextManifest 持久化 Schema（renderer 安全；hash 由宿主编制器计算）。 */
export const ContextManifestEntrySchema = z
  .object({
    sourceStageKey: id,
    path: z.string().max(256),
    kind: z.enum(['text', 'markdown', 'json', 'image', 'audio', 'video']),
    value: z.unknown(),
    bytes: z.number().int().nonnegative(),
    required: z.boolean(),
    purpose: z.string().max(256).optional(),
    contentHash: z.string().regex(/^sha256:[a-f0-9]{64}$/)
  })
  .strict()
export type ContextManifestEntry = z.infer<typeof ContextManifestEntrySchema>

export const ContextMissingSchema = z
  .object({
    sourceStageKey: id,
    path: z.string().max(256),
    required: z.boolean(),
    code: z.enum(['DELIVERY_MISSING', 'FIELD_MISSING'])
  })
  .strict()

export const ContextManifestSchema = z
  .object({
    schemaVersion: z.literal(1),
    stageKey: id,
    entries: z.array(ContextManifestEntrySchema).max(128),
    missing: z.array(ContextMissingSchema).max(128),
    dropped: z.array(ContextMissingSchema).max(128),
    budget: z
      .object({
        limitBytes: z.number().int().positive(),
        usedBytes: z.number().int().nonnegative(),
        exceeded: z.boolean()
      })
      .strict(),
    manifestHash: z.string().regex(/^sha256:[a-f0-9]{64}$/)
  })
  .strict()
export type ContextManifest = z.infer<typeof ContextManifestSchema>

/**
 * AF-05：阶段交付验收记录。绑定定义修订/阶段/task/清单 hash/方法 hash/候选产物/
 * 人工决定/审核结论与提交时间。引用既有不可变资产，不复制全文；程序据此确定下游可用版本。
 * stale=true 表示上游返工后本交付过期，禁止当作新版本交付。
 */
export const StageDeliveryRecordSchema = z
  .object({
    schemaVersion: z.literal(1),
    stageKey: id,
    nodeId: id,
    taskId: id,
    outputRefs: z.array(assetRef).min(1).max(128),
    contextManifestHash: z
      .string()
      .regex(/^sha256:[a-f0-9]{64}$/)
      .optional(),
    envelopeHash: z
      .string()
      .regex(/^sha256:[a-f0-9]{64}$/)
      .optional(),
    humanDecided: z.boolean(),
    reviewPassed: z.boolean(),
    definitionRevision: z.string().regex(/^sha256:[a-f0-9]{64}$/),
    acceptedAt: z.number().int().nonnegative(),
    stale: z.boolean().default(false)
  })
  .strict()
export type StageDeliveryRecord = z.infer<typeof StageDeliveryRecordSchema>

export const FlowStageSchema = z
  .object({
    /** 稳定阶段身份；运行事实与交付记录都引用它。 */
    stageKey: id,
    /** 承载阶段的真实专业 Agent 子节点（必须在主控 allowedNodeIds 内）。 */
    nodeId: id,
    /** 固定阶段目标：分派时逐字使用，不由模型补写。 */
    goal: z.string().min(1).max(8192),
    /** 固定完成条件说明：随分派下发，验收以交付事实为准。 */
    completion: z.string().min(1).max(4096),
    /** 本阶段交付必须存在显式人工采用（accepted=true 的 human 续接）。 */
    requireHumanDecision: z.boolean().default(false),
    /** 进入条件：全部满足才允许分派；缺失时不能越过该阶段。 */
    entry: z.array(StageConditionSchema).max(16).default([]),
    /** AF-02：声明式输入编制；缺省=沿用固定上游输入（旧语义）。 */
    inputs: StageInputsSchema.optional(),
    /** AF-03：固定方法指令；随执行信封传到公共内容执行器（缺省=无额外方法）。 */
    method: z
      .object({ instructions: z.string().max(8192).optional() })
      .strict()
      .optional()
  })
  .strict()
export type FlowStage = z.infer<typeof FlowStageSchema>

export const FlowStagesSchema = z
  .array(FlowStageSchema)
  .min(1)
  .max(32)
  .superRefine((stages, context) => {
    if (
      new Set(stages.map((stage) => stage.stageKey)).size !== stages.length ||
      new Set(stages.map((stage) => stage.nodeId)).size !== stages.length
    )
      context.addIssue({
        code: 'custom',
        message: 'Stage keys and carrier nodes must be unique'
      })
    const keys = new Set(stages.map((stage) => stage.stageKey))
    for (const stage of stages) {
      for (const condition of stage.entry)
        if (
          (condition.kind === 'output-field' ||
            condition.kind === 'output-count' ||
            condition.kind === 'human-decision') &&
          !keys.has(condition.stageKey)
        )
          context.addIssue({
            code: 'custom',
            message: 'Entry conditions must reference declared stages'
          })
      for (const selector of stage.inputs?.selectors ?? [])
        if (!keys.has(selector.sourceStageKey))
          context.addIssue({
            code: 'custom',
            message: 'Context selectors must reference declared stages'
          })
    }
  })

/** 已交付阶段的运行时事实（由权威资产解析结果构造，不接受调用方正文）。 */
export interface StageDeliveryFact {
  stageKey: string
  nodeId: string
  /** 正式交付的固定输出值（json 用 data；text/markdown 用 text）。 */
  outputs: Array<{ kind: string; data?: unknown; text?: string }>
  /** 存在显式人工采用（accepted=true 的 human 续接记录）。 */
  humanDecided: boolean
}
export interface StageEntryFacts {
  deliveries: StageDeliveryFact[]
  reviews: Array<{ nodeId: string; state: string }>
}
export type StageEntryReasonCode =
  | 'STAGE_ENTRY_DELIVERY_MISSING'
  | 'STAGE_ENTRY_FIELD_UNMET'
  | 'STAGE_ENTRY_COUNT_UNMET'
  | 'STAGE_ENTRY_HUMAN_DECISION_MISSING'
  | 'STAGE_ENTRY_REVIEW_NOT_PASSED'
export interface StageEntryReason {
  stageKey: string
  /** 未满足条件在 entry 数组中的下标。 */
  condition: number
  code: StageEntryReasonCode
}
export type StageEntryResult = { ok: true } | { ok: false; reasons: StageEntryReason[] }

function resolvePath(root: unknown, path: string): { found: boolean; value?: unknown } {
  let current: unknown = root
  for (const segment of path.split('.')) {
    if (current === null || typeof current !== 'object') return { found: false }
    const record = current as Record<string, unknown>
    if (!Object.prototype.hasOwnProperty.call(record, segment)) return { found: false }
    current = record[segment]
  }
  return { found: true, value: current }
}

function fieldSatisfied(
  condition: Extract<StageCondition, { kind: 'output-field' }>,
  fact: StageDeliveryFact
): boolean {
  const roots = fact.outputs.map((output) =>
    output.kind === 'json' ? output.data : { text: output.text ?? '' }
  )
  if (condition.op === 'missing')
    return roots.length > 0 && roots.every((root) => !resolvePath(root, condition.path).found)
  return roots.some((root) => {
    const resolved = resolvePath(root, condition.path)
    if (!resolved.found) return false
    if (condition.op === 'exists') return true
    if (condition.op === 'equals')
      return canonicalFlowJson(resolved.value) === canonicalFlowJson(condition.value)
    const actual = Array.isArray(resolved.value) ? 'array' : typeof resolved.value
    return actual === condition.valueType
  })
}

/**
 * 声明式进入条件解释器（纯函数，GUI/CLI/MCP 与宿主共用口径）。
 * 只读已交付事实；任何缺项都给出稳定原因，不静默放行。
 */
export function evaluateStageEntry(stage: FlowStage, facts: StageEntryFacts): StageEntryResult {
  const reasons: StageEntryReason[] = []
  stage.entry.forEach((condition, index) => {
    const fail = (code: StageEntryReasonCode): void => {
      reasons.push({ stageKey: stage.stageKey, condition: index, code })
    }
    if (condition.kind === 'review-passed') {
      const review = facts.reviews.find((item) => item.nodeId === condition.reviewNodeId)
      if (!review || review.state !== 'passed') fail('STAGE_ENTRY_REVIEW_NOT_PASSED')
      return
    }
    const fact = facts.deliveries.find((item) => item.stageKey === condition.stageKey)
    if (!fact) {
      fail('STAGE_ENTRY_DELIVERY_MISSING')
      return
    }
    if (condition.kind === 'human-decision') {
      if (!fact.humanDecided) fail('STAGE_ENTRY_HUMAN_DECISION_MISSING')
      return
    }
    if (condition.kind === 'output-count') {
      const satisfied =
        condition.op === 'gte'
          ? fact.outputs.length >= condition.count
          : fact.outputs.length <= condition.count
      if (!satisfied) fail('STAGE_ENTRY_COUNT_UNMET')
      return
    }
    if (!fieldSatisfied(condition, fact)) fail('STAGE_ENTRY_FIELD_UNMET')
  })
  return reasons.length ? { ok: false, reasons } : { ok: true }
}
