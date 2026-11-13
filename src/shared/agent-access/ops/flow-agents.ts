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
 * cooperate / review / build 提交 / publication —— 协作事件没有外部主体身份维度
 * （外部写 note/submit 会与人工输入不可区分）、审核与建图提交还需要同一宿主模型端口
 * 与新的渲染器权威动作。
 *
 * F8 第二批已开放 run / pause / stop：它们**复用 flow-agents IPC 创建的那一个宿主实例**
 * （经 src/main/agent-access/flow-bridge.ts 的窄接口发布），不另建宿主、不伪造内部身份；
 * start/continue 仍先走与 IPC 入口同一的模型工具调用预检。
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

/**
 * F8 收官：建图预览/提交与模型审核。两者都只经由 flow-bridge 发布的同一宿主实例
 * （FlowBuilderHost / FlowReviewHost）执行，不另建实例、不伪造运行身份：
 * - inspect 只读已持久化预览，不调模型、不改画布；
 * - propose 走与 IPC 入口相同的模型工具调用预检，预检失败时零模型请求；
 * - commit 只按 buildId 交给渲染器权威动作（commitFlowBuild：单撤销步 + 保存屏障 +
 *   authorize/confirm），外部不能自带预览内容，也不能把未预览的图直接写进画布；
 * - review 的结论由模型产生，外部只能提交与读取，**不能改写通过/不通过**。
 * 未登记的原因见 41 号台账第 5 节：cooperate（协作事件无外部主体身份维度）与
 * publication（发布需要人工授权 + 渲染器等待/继续协议）。
 */
const buildId = flowId
const buildStepDto = z
  .object({
    title: z.string().max(120),
    goal: z.string().max(4096),
    mode: z.enum(['autonomous', 'collaborative']),
    capability: z.string().max(80)
  })
  .strict()
const buildNodeDto = z
  .object({
    nodeId: flowId,
    type: z.string().max(40),
    title: z.string().max(120),
    contractVersion: z.number().int().nonnegative(),
    x: z.number(),
    y: z.number()
  })
  .strict()
const buildPreviewDto = z
  .object({
    buildId,
    projectId: identifier,
    nodeId,
    semanticRevision: flowId,
    state: z.enum(['preview', 'committed', 'discarded']),
    plan: z
      .object({
        title: z.string().max(120),
        topology: z.enum(['sequential', 'parallel-fork']),
        steps: z.array(buildStepDto).max(4)
      })
      .strict(),
    /** 只给节点身份与几何；正文/配置属于建图内容，不进入外部响应与日志。 */
    nodes: z.array(buildNodeDto).max(64),
    edges: z
      .array(
        z
          .object({
            from: z.object({ nodeId: flowId, portId: flowId }).strict(),
            to: z.object({ nodeId: flowId, portId: flowId }).strict()
          })
          .strict()
      )
      .max(128)
  })
  .strict()
const reviewDecisionDto = z
  .object({
    reviewId: flowId,
    cycleId: flowId,
    reviewNodeId: flowId,
    reviewRevision: z.number().int().nonnegative(),
    rulesVersion: flowId,
    passed: z.boolean(),
    feedback: z.string().max(16384),
    evidenceScope: z.enum([
      'complete-text-json',
      'complete-image',
      'complete-audio',
      'sampled',
      'audio-video-timeline',
      'partial'
    ]),
    subjects: z.array(flowAssetRef).max(128),
    issues: z
      .array(
        z
          .object({
            assetId: flowId,
            versionId: flowId,
            feedback: z.string().max(4096)
          })
          .strict()
      )
      .max(128)
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
  },
  // F8 收官：协作事件写入（与 GUI 面板同一宿主实例与同一任务表）。
  // 外部主体身份：提交里显式声明 actor=external，落在协作事件上，与人工输入可区分；
  // discuss/revise 会真实调用模型，因此先走与 IPC 入口同一的工具调用预检。
  'flowAgent.cooperate': {
    effect: 'write',
    description:
      '向指定 Agent 任务写入一次协作事件（note/discuss/submit/revise），与 GUI 面板同一宿主实例与同一任务表；discuss/revise 可能真实调用模型，故先做模型工具调用预检；事件带 actor=external 标记，与人工输入可区分；不接受伪造 revision/waitRevision（由宿主核对）',
    input: project
      .extend({
        nodeId,
        taskId: flowId,
        waitRevision: z.number().int().nonnegative(),
        revision: z.number().int().nonnegative(),
        eventId: flowId,
        action: z.enum(['note', 'discuss', 'submit', 'revise']),
        text: z.string().max(4096),
        accepted: z.boolean().optional(),
        selectedOutputs: z.array(flowAssetRef).max(128).optional(),
        selectedInputs: z.array(flowAssetRef).max(128).optional()
      })
      .strict()
  },
  // F8：运行控制。它们只经由"启动时创建的那一个宿主实例"执行（见 flow-bridge），
  // 因此不会出现两个权威；start/continue 的第一道闸门是模型工具调用预检，
  // 预检失败发生在任何模型请求之前（付费路径不会被偷偷触发）。
  'flowAgent.run': {
    effect: 'execute',
    description:
      '在当前打开的 Agent 节点上启动/继续/对账/恢复内部 Agent 运行（与 GUI 面板同一宿主实例与同一任务账本）；start/continue 先做模型工具调用预检，失败发生在任何模型请求之前；不新建宿主、不伪造运行身份',
    input: project
      .extend({
        nodeId,
        action: z.enum(['start', 'continue', 'reconcile', 'restore']),
        eventId: flowId.optional(),
        expectedTaskId: flowId.optional(),
        expectedWaitRevision: z.number().int().nonnegative().optional()
      })
      .strict()
  },
  'flowAgent.pause': {
    effect: 'write',
    description:
      '请求暂停当前打开的 Agent 任务（下一次安全点生效）；任务不存在如实返回 NOT_FOUND，不伪造暂停结果',
    input: project.extend({ nodeId }).strict()
  },
  'flowAgent.stop': {
    effect: 'write',
    description:
      '停止当前打开的 Agent 任务（与 GUI 停止按钮同一宿主方法）；调用后的终态仍以 flowAgent.inspect 读取的账本事实为准',
    input: project.extend({ nodeId }).strict()
  },
  // F8 收官：建图预览/提交（FlowBuilderHost，启动时创建的同一个实例）。
  'flowAgent.build.inspect': {
    effect: 'read',
    description:
      '读取 Flow 建图预览（最近一次或指定 buildId）：buildId/状态/计划步骤/节点身份与几何；只读已持久化预览，不调用模型、不修改画布；要求目标项目已在桌面打开',
    input: project.extend({ nodeId, buildId: flowId.optional() }).strict()
  },
  'flowAgent.build.propose': {
    effect: 'execute',
    description:
      '在 builder 角色的 Agent 节点上提交建图目标，由同一桌面宿主的模型端口生成预览并持久化（不落画布）；需要已验证工具调用能力的模型，模型预检失败时零模型请求；request/trace/span 由 main 生成，外部不能自造',
    input: project.extend({ nodeId }).strict()
  },
  'flowAgent.build.commit': {
    effect: 'write',
    description:
      '按 buildId 把已生成的建图预览提交到当前打开的权威画布（复用 GUI 同一 commitFlowBuild：authorize/confirm + 单撤销步 + 保存屏障）；外部不能自带预览内容；已 committed 的重复提交按持久化事实返回，不重复建节点',
    input: project.extend({ nodeId, buildId }).strict()
  },
  // F8 收官：模型审核（FlowReviewHost，同一实例）。审核结论由模型产生，外部只能提交与读取。
  'flowAgent.review': {
    effect: 'execute',
    description:
      '在 ai-review 节点上提交一次模型审核并读取报告（与 GUI 同一 FlowReviewHost 与同一证据/预算规则）；审核结论由模型产生，外部不能改写为通过；需要已验证工具调用能力的模型，模型预检失败时零模型请求；request/trace/span 由 main 生成',
    input: project.extend({ nodeId }).strict()
  },
  // C3：状态机外部事件——与 GUI「提交事件」按钮同一语义（写 meta.stateMachinePending，
  // 运行节点时由 stateMachineExecutor 校验修订与迁移并推进）；外部不能直接改状态。
  'flowStateMachine.submitEvent': {
    effect: 'write',
    description:
      '向状态机节点提交一个人工事件（与 GUI 提交事件按钮同一待处理写入）；携带观察到的 expectedRevision，过期提交拒绝；事件合法性与迁移在运行节点时由同一执行器校验；要求目标项目已在桌面打开',
    input: project
      .extend({
        nodeId,
        event: z.string().trim().min(1).max(120),
        expectedRevision: z.number().int().min(1),
        eventId: flowId.optional()
      })
      .strict()
  },
  'flowStateMachine.get': {
    effect: 'read',
    description:
      '读取状态机节点的当前阶段/修订/合法出边事件与待处理提交（只读持久化事实；未运行时按配置初始阶段与修订 1 返回）',
    input: project.extend({ nodeId }).strict()
  },
  // C4：纯人工任务外部提交——与 GUI「提交结果」按钮同一语义（写 meta.humanTaskPending，
  // 运行节点时由 humanTaskExecutor 校验修订/去重并交付）；外部不能直接改完成状态。
  'humanTask.submit': {
    effect: 'write',
    description:
      '向人工任务节点提交结果（与 GUI 提交结果按钮同一待处理写入）；携带观察到的 expectedRevision，过期提交拒绝；结果类型须与节点声明一致；完成状态在运行节点时由同一执行器校验；要求目标项目已在桌面打开',
    input: project
      .extend({
        nodeId,
        expectedRevision: z.number().int().min(1),
        submissionId: flowId.optional(),
        value: z.discriminatedUnion('kind', [
          z.object({ kind: z.literal('text'), text: z.string().max(1048576) }).strict(),
          z.object({ kind: z.literal('json'), data: z.unknown() }).strict()
        ])
      })
      .strict()
  },
  'humanTask.get': {
    effect: 'read',
    description:
      '读取人工任务节点的当前状态/修订/已交付结果与待处理提交（只读持久化事实；未运行时按 pending 修订 1 返回）',
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
    .strict(),
  'flowAgent.cooperate': z
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
    .strict(),
  'flowAgent.run': z
    .object({
      projectId: identifier,
      nodeId,
      task: flowTaskView,
      /** 本次运行产生的固定资产引用（结构与宿主持有的一致，外部只读）。 */
      refs: z.array(z.json()).max(64),
      /** out-text / out-json 等端口产物（只读投影，不改画布）。 */
      outputs: z.record(z.string(), z.json())
    })
    .strict(),
  'flowAgent.pause': z
    .object({ projectId: identifier, nodeId, task: flowTaskView })
    .strict(),
  'flowAgent.stop': z
    .object({ projectId: identifier, nodeId, task: flowTaskView })
    .strict(),
  'flowAgent.build.inspect': z
    .object({
      projectId: identifier,
      nodeId,
      graphVersion: z.number().int().nonnegative(),
      build: buildPreviewDto.nullable()
    })
    .strict(),
  'flowAgent.build.propose': z
    .object({
      projectId: identifier,
      nodeId,
      graphVersion: z.number().int().nonnegative(),
      build: buildPreviewDto
    })
    .strict(),
  'flowAgent.build.commit': z
    .object({
      projectId: identifier,
      nodeId,
      graphVersion: z.number().int().nonnegative(),
      build: buildPreviewDto,
      /** 已持久化的建图节点 ID（外部可再用 graph.get/node.get 核对）。 */
      committedNodeIds: z.array(flowId).max(64)
    })
    .strict(),
  'flowAgent.review': z
    .object({
      projectId: identifier,
      nodeId,
      graphVersion: z.number().int().nonnegative(),
      decision: reviewDecisionDto
    })
    .strict(),
  'flowStateMachine.submitEvent': z
    .object({
      projectId: identifier,
      nodeId,
      graphVersion: z.number().int().nonnegative(),
      /** 提交时观察到的实例修订（待处理事件基于它，运行节点时校验）。 */
      revision: z.number().int().min(1),
      eventId: flowId,
      event: z.string().max(120),
      pending: z.literal(true)
    })
    .strict(),
  'flowStateMachine.get': z
    .object({
      projectId: identifier,
      nodeId,
      state: z.string().max(120),
      revision: z.number().int().min(1),
      legalEvents: z.array(z.string().max(120)).max(256),
      pending: z
        .object({ eventId: flowId, event: z.string().max(120), expectedRevision: z.number().int().min(1) })
        .strict()
        .nullable()
    })
    .strict(),
  'humanTask.submit': z
    .object({
      projectId: identifier,
      nodeId,
      graphVersion: z.number().int().nonnegative(),
      revision: z.number().int().min(1),
      submissionId: flowId,
      pending: z.literal(true)
    })
    .strict(),
  'humanTask.get': z
    .object({
      projectId: identifier,
      nodeId,
      status: z.enum(['pending', 'completed']),
      revision: z.number().int().min(1),
      outputType: z.enum(['text', 'json']),
      result: z
        .discriminatedUnion('kind', [
          z.object({ kind: z.literal('text'), text: z.string() }).strict(),
          z.object({ kind: z.literal('json'), data: z.unknown() }).strict()
        ])
        .nullable(),
      pending: z
        .object({ submissionId: flowId, expectedRevision: z.number().int().min(1) })
        .strict()
        .nullable()
    })
    .strict()
} as const
