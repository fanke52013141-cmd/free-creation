import { z } from 'zod'
import { identifier, nodeId, project } from './common'
import { FlowDefinitionSchema } from '../../agent-flow/flow-definition'
import { FlowGraphSchema } from '../../agent-flow/flow-graph'

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
/** P5：外部建图预览 DTO（不含节点正文/配置，建图内容是业务正文；与 buildPreviewDto 同口径）。 */
const graphPreviewView = z
  .object({
    buildId: flowId,
    projectId: identifier,
    nodeId: flowId,
    semanticRevision: z.string().max(128),
    state: z.enum(['preview', 'committed', 'discarded']),
    coordinatorNodeId: flowId,
    stateNodeId: flowId,
    graph: z.object({ graphId: flowId, name: z.string().max(200) }).strict(),
    nodes: z
      .array(
        z
          .object({
            nodeId: flowId,
            type: z.string().max(40),
            title: z.string().max(200),
            contractVersion: z.number().int().nonnegative(),
            x: z.number(),
            y: z.number()
          })
          .strict()
      )
      .max(128),
    edges: z
      .array(
        z
          .object({
            from: z.object({ nodeId: flowId, portId: flowId }).strict(),
            to: z.object({ nodeId: flowId, portId: flowId }).strict()
          })
          .strict()
      )
      .max(256)
  })
  .strict()
const graphError = z
  .object({
    code: z.string().max(80),
    nodeId: flowId.optional(),
    message: z.string().max(512)
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

/** AF-06：流程定义版本 DTO（不可变定义快照，与运行分离）。 */
const flowDefinitionDto = FlowDefinitionSchema

export const FLOW_AGENTS_OPERATIONS = {
  'flowAgent.inspect': {
    effect: 'read',
    description:
      '读取已保存 Agent Flow 任务的观察视图（状态/等待/决策与工具计数/审核反馈）；只读账本事实，不判定会话存活、不触发会话恢复、不改写任务状态',
    input: project.extend({ nodeId }).strict()
  },
  // AF-02：阶段输入编制预览（只读）。默认返回摘要与大小，正文需 includeBody 显式读取；
  // 与 GUI 阶段详情同一宿主方法，不另写编制器。
  'flowStage.context.preview': {
    effect: 'read',
    description:
      '预览固定顺序主控某阶段的输入编制清单（当前已交付事实下会采用的字段/片段、缺项、预算）；只读，默认不含正文，includeBody=true 才返回内容；无运行或无阶段输入声明返回 null',
    input: project
      .extend({ nodeId, stageKey: flowId, includeBody: z.boolean().optional() })
      .strict()
  },
  // AF-05：局部返工（写）。从指定阶段起重跑，仅影响该阶段及下游；上游不重跑；
  // 旧交付保留为历史，下游标过期；有界轮次；在途命令未结算时拒绝。与 GUI 同一宿主方法。
  'flowStage.rework': {
    effect: 'write',
    description:
      '对固定顺序主控从指定阶段局部返工：移除该阶段及下游子任务并以新轮次重跑，上游已完成阶段不重跑；旧交付移入历史、下游标过期；返工轮次上限 10，在途 pending/unknown 命令未结算时拒绝；非固定顺序/非主控如实拒绝',
    input: project.extend({ nodeId, stageKey: flowId }).strict()
  },
  // AF-06：流程定义版本（与运行分离）。定义为固定顺序主控的可复用快照，不可变。
  'flowDefinition.publish': {
    effect: 'write',
    description:
      '从固定顺序主控的已保存配置发布一个不可变流程定义版本（阶段/方法/输入/进入条件快照，版本递增）；只存定义内容，不存运行正文/产物；非固定顺序如实拒绝',
    input: project
      .extend({ definitionId: flowId, name: z.string().min(1).max(120), coordinatorNodeId: nodeId })
      .strict()
  },
  'flowDefinition.list': {
    effect: 'read',
    description: '列出项目各流程定义的最新版本（只读定义快照，不含运行产物）',
    input: project
  },
  'flowDefinition.get': {
    effect: 'read',
    description: '读取某流程定义指定版本（缺省最新）；不存在返回 null',
    input: project
      .extend({ definitionId: flowId, version: z.number().int().positive().optional() })
      .strict()
  },
  'flowDefinition.diff': {
    effect: 'read',
    description: '差异预览：比较同一流程定义两个版本的名称/目标/阶段增删改及变更字段（只读）',
    input: project
      .extend({
        definitionId: flowId,
        versionA: z.number().int().positive(),
        versionB: z.number().int().positive()
      })
      .strict()
  },
  'flowRun.overview': {
    effect: 'read',
    description:
      'O3：读取某协调运行的一次流程运行统一总览（状态/阶段/修订/子任务 + 可回放事件时间线，事件来源 user/agent 归因）；只读投影，权威仍是命令账本与运行实例；不存在返回 null',
    input: project.extend({ nodeId: flowId }).strict()
  },
  'flowGraph.validate': {
    effect: 'read',
    description:
      'O4-P5：静态校验外部生成的 FlowGraph（引用/参与合法性/环须有界/可达/预算），返回 ok 与稳定错误码；只读，不写画布、不执行',
    input: z.object({ graph: FlowGraphSchema }).strict()
  },
  'flowGraph.compile': {
    effect: 'read',
    description:
      'O4-P5：把 FlowGraph 编译为画布图预览（节点配置+边+派生状态机，与建图预览同构）；只读预览不写画布；非法图返回 ok=false 与错误',
    input: z.object({ graph: FlowGraphSchema }).strict()
  },
  'flowGraph.propose': {
    effect: 'write',
    description:
      'P5：外部已生成 FlowGraph 的建图提案——校验+编译+持久化预览（flow_builds source=graph，锚点=编译 coordinator）；不调模型、不写画布；同图同 requestId 幂等返回同 buildId；落画布须人在 GUI 确认（flowGraph.confirm），外部不能自确认',
    input: project.extend({ graph: FlowGraphSchema, requestId: flowId.optional() }).strict()
  },
  'flowGraph.preview': {
    effect: 'read',
    description:
      'P5：读取外部建图预览（最近一次或指定 buildId）；只读，不调模型不改画布；已保存图含预览节点时自动 promote committed',
    input: project.extend({ buildId: flowId.optional() }).strict()
  },
  'flowGraph.list': {
    effect: 'read',
    description: 'P5：列出本项目的外部建图预览（含 preview/committed/discarded）；只读',
    input: project
  },
  'flowGraph.discard': {
    effect: 'write',
    description: 'P5：取消外部建图预览（置 discarded）；已 committed 的预览幂等返回 committed，不可取消',
    input: project.extend({ buildId: flowId }).strict()
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
  'flowStage.context.preview': z
    .object({
      projectId: identifier,
      nodeId,
      preview: z
        .object({
          stageKey: flowId,
          manifestHash: z.string().max(80),
          entries: z
            .array(
              z
                .object({
                  sourceStageKey: flowId,
                  path: z.string().max(256),
                  kind: z.string().max(20),
                  bytes: z.number().int().nonnegative(),
                  required: z.boolean(),
                  purpose: z.string().max(256).optional(),
                  value: z.unknown().optional()
                })
                .strict()
            )
            .max(128),
          missing: z.array(z.record(z.string(), z.unknown())).max(128),
          dropped: z.array(z.record(z.string(), z.unknown())).max(128),
          budget: z
            .object({
              limitBytes: z.number().int().positive(),
              usedBytes: z.number().int().nonnegative(),
              exceeded: z.boolean()
            })
            .strict(),
          blocking: z.boolean()
        })
        .strict()
        .nullable()
    })
    .strict(),
  'flowStage.rework': z
    .object({
      projectId: identifier,
      nodeId,
      task: flowTaskView.nullable()
    })
    .strict(),
  'flowDefinition.publish': z
    .object({ projectId: identifier, definition: flowDefinitionDto })
    .strict(),
  'flowDefinition.list': z
    .object({ projectId: identifier, definitions: z.array(flowDefinitionDto).max(256) })
    .strict(),
  'flowDefinition.get': z
    .object({ projectId: identifier, definition: flowDefinitionDto.nullable() })
    .strict(),
  'flowDefinition.diff': z
    .object({
      projectId: identifier,
      definitionId: flowId,
      diff: z
        .object({
          nameChanged: z.boolean(),
          goalChanged: z.boolean(),
          stages: z
            .array(
              z
                .object({
                  stageKey: flowId,
                  change: z.enum(['added', 'removed', 'changed']),
                  fields: z.array(z.string().max(40)).max(16).optional()
                })
                .strict()
            )
            .max(64)
        })
        .strict()
    })
    .strict(),
  'flowRun.overview': z
    .object({
      projectId: identifier,
      overview: z
        .object({
          projectId: identifier,
          nodeId: flowId,
          taskId: flowId,
          state: z.enum([
            'ready',
            'running',
            'waiting',
            'blocked',
            'completed',
            'failed',
            'cancelled'
          ]),
          phase: z.string().max(80),
          revision: z.number().int().nonnegative(),
          goal: z.string().max(16384),
          paused: z.boolean(),
          code: z.string().max(120).optional(),
          children: z
            .array(
              z
                .object({ nodeId: flowId, taskId: flowId, state: z.string().max(40) })
                .strict()
            )
            .max(128),
          events: z
            .array(
              z
                .object({
                  eventId: flowId,
                  revision: z.number().int().nonnegative(),
                  event: z.string().max(120),
                  state: z.string().max(80),
                  source: z.enum(['user', 'agent'])
                })
                .strict()
            )
            .max(2000)
        })
        .strict()
        .nullable()
    })
    .strict(),
  'flowGraph.validate': z
    .object({
      ok: z.boolean(),
      errors: z
        .array(
          z
            .object({
              code: z.string().max(80),
              nodeId: flowId.optional(),
              message: z.string().max(512)
            })
            .strict()
        )
        .max(64)
    })
    .strict(),
  'flowGraph.compile': z
    .object({
      ok: z.boolean(),
      compiled: z
        .object({
          nodes: z
            .array(
              z
                .object({
                  id: flowId,
                  type: z.string().max(40),
                  title: z.string().max(200),
                  text: z.string().max(65536),
                  config: z.string().max(262144),
                  contractVersion: z.number().int().nonnegative(),
                  x: z.number(),
                  y: z.number()
                })
                .strict()
            )
            .max(128),
          edges: z
            .array(
              z
                .object({
                  from: z.object({ nodeId: flowId, portId: flowId }).strict(),
                  to: z.object({ nodeId: flowId, portId: flowId }).strict()
                })
                .strict()
            )
            .max(256),
          coordinatorNodeId: flowId,
          stateNodeId: flowId
        })
        .strict()
        .nullable(),
      errors: z
        .array(
          z
            .object({
              code: z.string().max(80),
              nodeId: flowId.optional(),
              message: z.string().max(512)
            })
            .strict()
        )
        .max(64)
    })
    .strict(),
  'flowGraph.propose': z
    .object({
      ok: z.boolean(),
      preview: graphPreviewView.nullable(),
      errors: z.array(graphError).max(64)
    })
    .strict(),
  'flowGraph.preview': z
    .object({ projectId: identifier, preview: graphPreviewView.nullable() })
    .strict(),
  'flowGraph.list': z
    .object({ projectId: identifier, previews: z.array(graphPreviewView).max(64) })
    .strict(),
  'flowGraph.discard': z
    .object({ projectId: identifier, preview: graphPreviewView })
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
      candidates: z.array(flowAssetRef).max(128),
      /** AF-04：当前工作稿正文（最近一次已提交候选成果）；无候选时缺省。加性可选字段。 */
      workingDraft: z.string().max(1048576).optional()
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
  'flowAgent.pause': z.object({ projectId: identifier, nodeId, task: flowTaskView }).strict(),
  'flowAgent.stop': z.object({ projectId: identifier, nodeId, task: flowTaskView }).strict(),
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
        .object({
          eventId: flowId,
          event: z.string().max(120),
          expectedRevision: z.number().int().min(1)
        })
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
