import { z } from 'zod'
import { AgentFlowAssetRefSchema } from '../../agent-flow/node-contracts'
import { identifier, nodeId, project } from './common'

/**
 * 内部 Agent Flow 的**命令账本协作**操作（F8，flowCommands 族）。
 *
 * 目标：把 GUI「Agent Flow 命令」已有的查询/核对/结算/派发/放弃动作开放给外部，
 * 同时保持"外部主体可区分、不伪造内部会话"：
 * - 读/结算类只操作**既有**命令（lookup / availability / reconcile / check）；
 * - 派发（dispatch）经共享权威端口创建一条 `principal='external'` 的命令，沿用既有
 *   账本会话与渲染器 grant 通道，身份与运行标识全部由 main 生成；
 * - 放弃（abort）只允许外部主体放弃自己创建且**从未准入**的命令。
 * 完整论证见 docs/local-agent-access/29-flow-commands-delivery.md 第 1、3、9 节。
 *
 * `flow.command.check` 是只读核对：它只读既有命令，并在**回滚事务**内用账本自己的
 * commit 规则预演"现在结算会得到什么"，不落账、不改写任何命令事实；真正落账仍必须
 * 经 `flow.command.reconcile`（写、需要幂等键）。
 *
 * 新增操作的方法：在本文件的 `FLOW_COMMANDS_OPERATIONS` 里登记
 * { effect, description, input }，并在 `FLOW_COMMANDS_OUTPUTS` 里给出输出 Schema
 * （registry.ts 用 satisfies Record<AccessOperationId, z.ZodType> 强制成对），
 * 再到 src/main/agent-access/service.ts 的 dispatch 给实现。
 * 共享字段请从 ./common 引入；不要用 .refine()。
 */
const commandId = z.string().regex(/^[a-zA-Z0-9_.:-]{1,128}$/)
const portId = z.string().regex(/^[a-zA-Z0-9_.:-]{1,128}$/)
const targetNodeId = z.string().min(1).max(180)
const flowCommandState = z.enum([
  'pending',
  'unknown',
  'committed',
  'failed',
  'cancelled',
  'skipped'
])
/** 命令的固定输入端口与资产引用（外部只能引用本机已登记媒体/固定资产的受控引用）。 */
const fixedInput = z
  .object({
    targetPortId: portId,
    assets: z.array(AgentFlowAssetRefSchema).min(1).max(64)
  })
  .strict()

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
  },
  'flow.command.check': {
    effect: 'read',
    description:
      '只读核对既有 Flow 命令：读取账本回执，并在回滚事务内用同一账本结算规则预演"现在结算会得到什么状态"（不落账、不改写命令、不产生输出版本）；无法结算时回传稳定原因，供 reconcile 决定是否提交',
    input: project.extend({ commandId }).strict()
  },
  'flow.command.dispatch': {
    effect: 'execute',
    description:
      '把一条外部派发请求交给当前活动画布执行：main 生成命令/任务/运行身份并先保存画布，按已保存图计算语义版本，账本记录 principal=external 后经既有渲染器 grant 通道执行；受理只表示已交给渲染器，最终状态用 lookup/check 读、reconcile 结算；付费目标必须 confirmPaidTarget=true',
    input: project
      .extend({
        agentNodeId: nodeId,
        targetNodeId: nodeId,
        contractVersion: z.number().int().positive(),
        inputs: z.array(fixedInput).max(16),
        confirmPaidTarget: z.boolean().default(false)
      })
      .strict()
  },
  'flow.command.abort': {
    effect: 'write',
    description:
      '放弃一条外部派发且**从未准入**的 Flow 命令（principal=external、admitted=0、pending/unknown）；已准入或已终态一律拒绝，绝不改写已执行事实；需要幂等键',
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
    .strict(),
  'flow.command.check': z
    .object({
      projectId: identifier,
      commandId,
      /** 当前账本回执状态（预演不会改变它）。 */
      state: flowCommandState,
      /** 命令已是终态，无需再结算。 */
      alreadySettled: z.boolean(),
      /** 现在调用 reconcile 是否会让账本推进（预演结果）。 */
      wouldSettle: z.boolean(),
      /** wouldSettle=true 时账本将结算到的状态（不含预演中生成、已随事务回滚的输出版本）。 */
      wouldResultState: flowCommandState.optional(),
      /** wouldSettle=false 时的稳定账本原因码；不代表命令失败。 */
      reason: z.string().min(1).max(80).optional(),
      receipt: flowCommandReceipt
    })
    .strict(),
  'flow.command.dispatch': z
    .object({
      projectId: identifier,
      /** main 生成的命令身份；外部不可自造，后续 lookup/check/reconcile 用它定位。 */
      commandId,
      taskId: commandId,
      runId: commandId,
      targetNodeId,
      /** 派发前保存画布的版本（语义版本对应的已保存图）。 */
      graphVersion: z.number().int().nonnegative(),
      /** 仅表示命令已持久受理并交给渲染器，不表示执行完成。 */
      accepted: z.literal(true),
      state: z.literal('pending')
    })
    .strict(),
  'flow.command.abort': flowCommandReceipt
} as const
