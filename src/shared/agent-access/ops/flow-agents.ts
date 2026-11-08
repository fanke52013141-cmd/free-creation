import { z } from 'zod'
import { identifier, nodeId, project } from './common'

/**
 * 内部 Agent Flow 的**观察**操作（F8，flowAgents 族）。
 *
 * 本文件只登记"不伪造内部运行身份即可安全开放"的动作：读取 Flow 任务的持久化观察视图、
 * 读取画布能力目录、读取协作记录。三入口共用同一业务实现：
 * - inspect 走 `FlowAgentDesktopHost.inspect`（与 GUI 面板同一方法），只有在会触发
 *   GUI 宿主本地"会话丢失"判定的运行中状态才降级为只读账本投影（不写账本）；
 * - catalog 走 `FlowAgentDesktopHost.catalog`（与 GUI 同一目录投影）；
 * - collaboration 走 `FlowAgentDesktopHost.collaboration`（只读，不写人工意见/选择）。
 *
 * 未登记（原因见 docs/local-agent-access/28-flow-agents-delivery.md 第 5 节）：
 * run / pause / stop / cooperate / review / build 提交 / publication —— 它们的权威
 * 宿主是 flow-agents.ipc 里创建的桌面实例（模型端口、命令交付通道、进行中运行上下文），
 * 外部进程内另建实例会与内部运行身份竞争并改写账本事实；建图提交还要新增权威宿主
 * 桌面动作。需要后续包先注入共享宿主句柄再逐项开放。
 *
 * 新增操作的方法：在本文件的 `FLOW_AGENTS_OPERATIONS` 里登记
 * { effect, description, input }，并在 `FLOW_AGENTS_OUTPUTS` 里给出输出 Schema
 * （registry.ts 用 satisfies Record<AccessOperationId, z.ZodType> 强制成对），
 * 再到 src/main/agent-access/flow-agents-ops.ts 给实现。
 * 共享字段请从 ./common 引入；不要用 .refine()（registry 会对输入 Schema 跑
 * z.toJSONSchema，二选一等约束在执行层校验）。
 */
/** Flow 内部 ID：与 shared/agent-flow/* 的 `id` 规则一致（含 `shape:` 前缀、点与冒号）。 */
const flowId = z
  .string()
  .min(1)
  .max(160)
  .regex(/^[a-zA-Z0-9_.:-]+$/)
const flowAssetRef = z
  .object({
    assetId: flowId,
    versionId: flowId,
    sourceNodeId: flowId,
    sourcePortId: flowId
  })
  .strict()
const flowTaskView = z
  .object({
    taskId: flowId,
    state: z.enum(['ready', 'running', 'waiting', 'blocked', 'completed', 'failed', 'cancelled']),
    waitKind: z.enum(['human', 'reconcile']).nullable(),
    waitRevision: z.number().int().nonnegative(),
    decisions: z.number().int().nonnegative(),
    tools: z.number().int().nonnegative(),
    code: z.string().max(120).optional(),
    prepared: z.boolean().optional(),
    phase: z.string().max(80).optional(),
    recovery: z
      .object({ reasons: z.array(z.string().max(80)).max(8), canRestore: z.boolean() })
      .strict()
      .optional(),
    reviewFeedback: z
      .object({
        reviewNodeId: flowId,
        reviewId: flowId,
        feedback: z.string().max(16384),
        round: z.number().int().nonnegative(),
        state: z.string().max(40),
        subjects: z.array(flowAssetRef).max(128)
      })
      .strict()
      .optional()
  })
  .strict()

export const FLOW_AGENTS_OPERATIONS = {
  'flowAgent.inspect': {
    effect: 'read',
    description:
      '读取已保存 Agent Flow 任务的观察视图（状态/等待/决策与工具计数/审核反馈）；只读账本事实，不判定会话存活、不触发会话恢复、不改写任务状态',
    input: project.extend({ nodeId }).strict()
  },
  'flowAgent.catalog': {
    effect: 'read',
    description:
      '读取当前打开画布的 Agent 能力目录（可用文本模型、受控工具、固定版本技能摘要）；要求项目已在桌面打开，不返回技能指令正文',
    input: project
  },
  'flowAgent.collaboration': {
    effect: 'read',
    description:
      '读取指定 Agent 任务的协作记录（目标/消息/固定输入/候选成果）；只读，不接受外部代替人填写意见、选择或继续',
    input: project.extend({ nodeId }).strict()
  }
} as const

export const FLOW_AGENTS_OUTPUTS = {
  'flowAgent.inspect': z
    .object({
      projectId: identifier,
      nodeId,
      graphVersion: z.number().int().nonnegative(),
      /**
       * desktop-host：权威宿主判定（含会话恢复提示）；ledger-only：任务处于运行/待启动，
       * 外部只读账本事实，不判定 AGENT_SESSION_LOST（那是桌面宿主本地知识）。
       */
      ownership: z.enum(['desktop-host', 'ledger-only']),
      task: flowTaskView.nullable()
    })
    .strict(),
  'flowAgent.catalog': z
    .object({
      projectId: identifier,
      graphVersion: z.number().int().nonnegative(),
      models: z
        .array(
          z
            .object({
              id: z.string().max(200),
              name: z.string().max(200),
              imageInput: z.boolean().optional(),
              audioInput: z.boolean().optional()
            })
            .strict()
        )
        .max(100),
      tools: z
        .array(
          z
            .object({
              id: z.string().max(80),
              version: z.string().max(40),
              name: z.string().max(200)
            })
            .strict()
        )
        .max(50),
      skills: z
        .array(
          z
            .object({
              id: flowId,
              version: flowId,
              name: z.string().max(120),
              description: z.string().max(1000)
            })
            .strict()
        )
        .max(200)
    })
    .strict(),
  'flowAgent.collaboration': z
    .object({
      projectId: identifier,
      nodeId,
      graphVersion: z.number().int().nonnegative(),
      task: flowTaskView,
      goal: z.string().max(32768),
      revision: z.number().int().nonnegative(),
      messages: z
        .array(
          z
            .object({
              eventId: flowId,
              kind: z.string().max(40),
              text: z.string().max(4096),
              reply: z.string().max(4096).optional()
            })
            .strict()
        )
        .max(100),
      inputs: z.array(flowAssetRef).max(256),
      candidates: z.array(flowAssetRef).max(128)
    })
    .strict()
} as const
