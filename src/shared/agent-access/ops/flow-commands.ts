import { z } from 'zod'
import { AgentFlowAssetRefSchema } from '../../agent-flow/node-contracts'
import { identifier, nodeId, project } from './common'

/**
 * 内部 Agent Flow 的**命令账本协作**操作（F8，flowCommands 族）。
 *
 * 目标：把 GUI「Agent Flow 命令」已有的查询/核对/按已保存事实结算动作开放给外部，
 * 同时**不**向外部开放会创建命令或租约的写口（prepare/dispatch/grant/cancel/check/
 * abort/attach/detach），因此外部无法伪造内部 Agent 会话身份。完整论证见
 * docs/local-agent-access/29-flow-commands-delivery.md 第 1、3 节。
 *
 * 新增操作的方法：在本文件的 `FLOW_COMMANDS_OPERATIONS` 里登记
 * { effect, description, input }，并在 `FLOW_COMMANDS_OUTPUTS` 里给出输出 Schema
 * （registry.ts 用 satisfies Record<AccessOperationId, z.ZodType> 强制成对），
 * 再到 src/main/agent-access/service.ts 的 dispatch 给实现。
 * 共享字段请从 ./common 引入；不要用 .refine()。
 */
const commandId = z.string().regex(/^[a-zA-Z0-9_.:-]{1,128}$/)
const targetNodeId = z.string().min(1).max(180)
const flowCommandState = z.enum([
  'pending',
  'unknown',
  'committed',
  'failed',
  'cancelled',
  'skipped'
])

/** 账本回执的外部投影：只含受控 ID/状态/输出引用，不含命令输入清单与用户正文。 */
const flowCommandReceipt = z
  .object({
    projectId: identifier,
    commandId,
    taskId: commandId,
    targetNodeId,
    state: flowCommandState,
    runId: commandId,
    nodeExecutionId: z.string().min(1).max(160).optional(),
    inputFingerprint: z.string().regex(/^v1:[0-9a-f]{16}$/).optional(),
    outputRefs: z.array(AgentFlowAssetRefSchema).max(8),
    graphVersion: z.number().int().nonnegative().optional(),
    code: z.string().min(1).max(80).optional()
  })
  .strict()

export const FLOW_COMMANDS_OPERATIONS = {
  'flow.command.lookup': {
    effect: 'read',
    description:
      '按项目与 commandId 读取既有 Flow 命令的账本回执（状态/运行/输出版本引用）；只读事实，不创建、不结算、不改写命令',
    input: project.extend({ commandId }).strict()
  },
  'flow.command.availability': {
    effect: 'read',
    description:
      '核对节点当前是否可执行：复用账本同一占用、协调控制范围与审核门禁；只读检查，不占用、不执行。不可用时返回与 GUI 相同的稳定拒绝码',
    input: project.extend({ nodeId }).strict()
  },
  'flow.command.reconcile': {
    effect: 'write',
    description:
      '按已保存运行事实核对既有 Flow 命令并结算账本回执；只有运行记录的 runId/命令/租约/输入指纹全部一致时才推进状态，无法确认时保持 pending/unknown 并回传稳定原因，绝不把 unknown 报成成功；需要幂等键',
    input: project.extend({ commandId }).strict()
  }
} as const

export const FLOW_COMMANDS_OUTPUTS = {
  'flow.command.lookup': flowCommandReceipt,
  'flow.command.availability': z
    .object({
      projectId: identifier,
      nodeId: targetNodeId,
      graphVersion: z.number().int().nonnegative(),
      available: z.literal(true)
    })
    .strict(),
  'flow.command.reconcile': z
    .object({
      projectId: identifier,
      commandId,
      state: flowCommandState,
      /** 本次是否尝试过账本 commit（终态命令无需再结算）。 */
      commitAttempted: z.boolean(),
      /** 结算被拒绝时的稳定账本原因码（如 FLOW_SAVED_RUN_MISMATCH）；不代表命令失败。 */
      reason: z.string().min(1).max(80).optional(),
      receipt: flowCommandReceipt
    })
    .strict()
} as const
