import { z } from 'zod'

/**
 * AF-03 真实内容指令（ExecutionEnvelope）：把阶段目标、固定方法、已采用人工意见与返工反馈
 * 真正传到公共内容执行器（ai-process 等）。宿主从已保存配置与任务快照构造并校验；
 * 不允许模型传任意 system prompt 覆盖对象/工具权限/节点配置。
 *
 * 优先关系（方案 §6.1）：系统/安全边界 → 固定阶段职责与硬约束 → 已采用决定/返工反馈 → 业务输入。
 * 正文属于业务内容，不入日志/诊断（宿主仅记 hash 与计数）。
 */
export const ExecutionEnvelopeSchema = z
  .object({
    schemaVersion: z.literal(1),
    /** 固定阶段目标（来自主控阶段声明，逐字）。 */
    stageGoal: z.string().max(8192).optional(),
    /** 固定方法指令（阶段方法版本）。 */
    methodInstructions: z.string().max(8192).optional(),
    /** 已采用人工意见（显式采用，非聊天猜测）。 */
    humanFeedback: z.string().max(4096).optional(),
    /** 当前返工反馈（审核拒绝/返工指令）。 */
    reworkFeedback: z.string().max(16384).optional(),
    /** 输出要求（格式/必需项约束说明）。 */
    outputRequirements: z.string().max(4096).optional()
  })
  .strict()
export type ExecutionEnvelope = z.infer<typeof ExecutionEnvelopeSchema>

/** 从阶段声明与任务事实构造信封；全空返回 undefined（旧语义不受影响）。 */
export function composeExecutionEnvelope(input: {
  stageGoal?: string
  methodInstructions?: string
  humanFeedback?: string
  reworkFeedback?: string
  outputRequirements?: string
}): ExecutionEnvelope | undefined {
  const trim = (value?: string): string | undefined => {
    const trimmed = value?.trim()
    return trimmed ? trimmed : undefined
  }
  const fields = {
    stageGoal: trim(input.stageGoal),
    methodInstructions: trim(input.methodInstructions),
    humanFeedback: trim(input.humanFeedback),
    reworkFeedback: trim(input.reworkFeedback),
    outputRequirements: trim(input.outputRequirements)
  }
  if (!Object.values(fields).some(Boolean)) return undefined
  return ExecutionEnvelopeSchema.parse({
    schemaVersion: 1,
    ...Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== undefined))
  })
}

/** 固定阶段职责/方法/输出约束 → 追加到 system（不覆盖节点原 system 的安全边界）。 */
export function envelopeSystemSuffix(envelope: ExecutionEnvelope | undefined): string {
  if (!envelope) return ''
  const parts: string[] = []
  if (envelope.stageGoal) parts.push(`本阶段目标：${envelope.stageGoal}`)
  if (envelope.methodInstructions) parts.push(`固定工作方法：${envelope.methodInstructions}`)
  if (envelope.outputRequirements) parts.push(`输出要求：${envelope.outputRequirements}`)
  return parts.join('\n')
}

/** 已采用人工意见/返工反馈 → 置于业务输入之前（ adopted 决定优先于材料）。 */
export function envelopeUserPrefix(envelope: ExecutionEnvelope | undefined): string {
  if (!envelope) return ''
  const parts: string[] = []
  if (envelope.humanFeedback) parts.push(`已采用的人工意见（必须落实）：${envelope.humanFeedback}`)
  if (envelope.reworkFeedback) parts.push(`本次返工反馈（必须修正）：${envelope.reworkFeedback}`)
  return parts.join('\n')
}
