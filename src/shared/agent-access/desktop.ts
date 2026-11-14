import { z } from 'zod'
import { SkillAgentConfigSchema } from '../skill-agent'
import { GraphPatchOpsSchema, GRAPH_VIEW_MAX_NODES, mediaResolutionSchema } from './graph-ops'
import { compositeManifestSchema } from '../composite/manifest'
import { PublishModeSchema, publishRequestIdSchema } from './publish'
import { NODE_EXECUTE_MAX_NODES, WorkflowInputsSchema } from './run-ops'

export const ACCESS_DESKTOP_REQUEST = 'local-agent:desktop-request'
export const ACCESS_DESKTOP_REPLY = 'local-agent:desktop-reply'
export const ACCESS_DESKTOP_COMMIT = 'local-agent:desktop-commit'
export const ACCESS_TASK_REPORT = 'local-agent:task-report'
export const DesktopRequestSchema = z
  .object({
    requestId: z.string().uuid(),
    expiresAt: z.number().int().positive(),
    projectId: z.string().regex(/^[a-zA-Z0-9_-]{1,80}$/),
    action: z.enum([
      'open',
      'flush',
      'rename',
      'bind-skills',
      'graph-patch',
      // L2：智能整理（拓扑分层/角色泳道/网格），与 GUI 同一 layoutGraph 纯函数。
      'graph-layout',
      // C3：状态机人工事件提交（与 GUI 提交事件按钮同一 meta.stateMachinePending 写入）。
      'state-machine-event',
      // C4：纯人工任务结果提交（与 GUI 提交结果按钮同一 meta.humanTaskPending 写入）。
      'human-task-submit',
      'read-graph',
      'workflow-run-plan',
      'execute-nodes',
      'cancel-run',
      // F6 收尾：manual-publish 的等待/继续。
      // publish-authorize 由人在 GUI 上亲眼确认（交互式请求，不占用写入槽）；
      // director-publish 只在人工授权后执行，复用 GUI 同一发布服务。
      'publish-authorize',
      'director-publish',
      // F8 收官：把已持久化的 Flow 建图预览交给渲染器权威动作提交到画布
      // （commitFlowBuild：authorize/confirm + 单撤销步 + 保存屏障）。
      'flow-build',
      // P5.3：外部 FlowGraph 建图预览经渲染器权威 commitFlowGraph 落画布（同一内核）。
      'flow-graph',
      // F2：历史撤销/重做与关闭项目。
      // 撤销重做必须由权威宿主执行——历史栈在 editor 里，main 自己维护一份必然与 GUI 分叉；
      // 关闭项目需要 renderer 先保存再回到项目列表（否则关掉画布会丢未保存编辑）。
      'history',
      'close-project',
      // F9 收尾：敏感动作（凭据包导入等）由**人在 GUI 亲眼确认**后才放行。
      'confirm-sensitive',
      // F9 收尾：取节点的运行记录（含历史），供外部导出节点诊断用。
      'read-node-runs',
      // headless 节点流执行：脱离项目/画布，渲染层隔离 editor 异步运行，台账轮询终态。
      'execute-composite-headless'
    ]),
    nodeId: z.string().optional(),
    agent: SkillAgentConfigSchema.optional(),
    name: z.string().trim().min(1).max(200).optional(),
    /** graph-patch：类型化画布编辑批次（renderer 权威校验并原子应用）。 */
    ops: GraphPatchOpsSchema.optional(),
    /** graph.patch 提交方期望的图版本；权威宿主在保存未保存内容后核对。 */
    expectedGraphVersion: z.number().int().nonnegative().optional(),
    /** graph-layout：布局模式（auto/flow/lanes/grid）；nodeIds 复用为可选作用域。 */
    layoutMode: z.enum(['auto', 'flow', 'lanes', 'grid']).optional(),
    /** graph.patch：应用后在同一撤销步内智能整理坐标（L2，只改位置不改配置）。 */
    autoLayout: z.boolean().optional(),
    /** state-machine-event：人工事件与观察到的实例修订（C3）；eventId 缺省由宿主生成。 */
    stateMachineEvent: z.string().trim().min(1).max(120).optional(),
    stateMachineExpectedRevision: z.number().int().min(1).optional(),
    stateMachineEventId: z.string().min(1).max(160).optional(),
    /**
     * O1：state-machine-event 事件来源。human=人工提交（外部接口唯一允许值）；
     * agent=协调器可信投影（仅内部 desktop 调用，来源限定账本回执/资产/审核事实）。
     * 缺省 human（存量兼容）。外部 flowStateMachine.submitEvent 强制 human。
     */
    stateMachineEventSource: z.enum(['human', 'agent']).optional(),
    /** human-task-submit：人工结果与观察到的实例修订（C4）；submissionId 缺省由宿主生成。 */
    humanTaskExpectedRevision: z.number().int().min(1).optional(),
    humanTaskSubmissionId: z.string().min(1).max(160).optional(),
    humanTaskValue: z
      .discriminatedUnion('kind', [
        z.object({ kind: z.literal('text'), text: z.string().max(1048576) }).strict(),
        z.object({ kind: z.literal('json'), data: z.unknown() }).strict()
      ])
      .optional(),
    /** read-graph：latest 视图分页参数。 */
    offset: z.number().int().min(0).max(100000).optional(),
    limit: z.number().int().min(1).max(GRAPH_VIEW_MAX_NODES).optional(),
    /** execute-nodes：外部执行任务（账本已受理）。 */
    taskId: z.string().max(160).optional(),
    mode: z.enum(['single', 'subgraph']).optional(),
    nodeIds: z.array(z.string().max(180)).min(1).max(NODE_EXECUTE_MAX_NODES).optional(),
    confirmPaidRerun: z.boolean().optional(),
    inputs: WorkflowInputsSchema.optional(),
    /** execute-composite-headless：要执行的已发布节点流 manifest（main 已从能力仓库解析核对）。 */
    compositeManifest: compositeManifestSchema.optional(),
    /** execute-composite-headless：按公开输入端口喂值（main 已按 op 契约校验）。 */
    compositeInputs: z
      .array(z.object({ portId: z.string().min(1).max(100), value: z.unknown() }).strict())
      .max(64)
      .optional(),
    /** execute-composite-headless：main 预分配的运行 ID（台账轮询用）。 */
    ownRunId: z.string().min(1).max(120).optional(),
    /** execute-composite-headless：W4 公开输入值（创建运行时原子落盘，供受控重试复跑）。 */
    compositeInputValues: z.record(z.string(), z.unknown()).optional(),
    /** execute-composite-headless：W4 重试链根运行 ID（受控上限按根计数）。 */
    compositeRetryOf: z.string().min(1).max(120).optional(),
    /** AF-07：续跑同一运行（人工等待满足后），复用既有 runId。 */
    compositeResumeRunId: z.string().min(1).max(120).optional(),
    /** AF-07：已满足的人工提交值（按内部节点 ID），续跑消费为人工任务输出。 */
    compositeHumanSubmissions: z.record(z.string(), z.unknown()).optional(),
    /** AF-07：续跑时已完成的内部节点 ID（跳过重跑）。 */
    compositeCompletedSteps: z.array(z.string().min(1).max(120)).max(256).optional(),
    /** AF-07：已完成节点运行结果回放（nodeId → {nodeResult,nodeRun}）。 */
    compositeStepOutputs: z.record(z.string(), z.unknown()).optional(),
    /** graph-patch：main 预检解析的素材事实（按 mediaId 注入，外部输入不可携带路径）。 */
    mediaResolutions: z.record(z.string(), mediaResolutionSchema).optional(),
    /** graph-patch：main 预解析的组合固定版本快照（W3 引用形态；外部输入只携带引用）。 */
    compositeResolutions: z
      .record(
        z.string(),
        z.object({
          manifest: compositeManifestSchema,
          contentHash: z.string().regex(/^[a-f0-9]{64}$/)
        })
      )
      .optional(),
    /** 发布授权协议：待授权请求、发布模式与镜头；方向由 main 决定，外部不可自造授权。 */
    publishRequestId: publishRequestIdSchema.optional(),
    publishMode: PublishModeSchema.optional(),
    shotId: z.string().min(1).max(80).optional(),
    /** flow-build：要提交的已持久化建图预览 ID；预览内容由 main 侧的宿主提供，外部不可自带。 */
    buildId: z
      .string()
      .min(1)
      .max(160)
      .regex(/^[a-zA-Z0-9_.:-]+$/)
      .optional(),
    /** history：撤销还是重做。 */
    direction: z.enum(['undo', 'redo']).optional(),
    /** confirm-sensitive：确认框文案（只承载人读文本，不含密钥/路径敏感信息）。 */
    confirmTitle: z.string().max(120).optional(),
    confirmMessage: z.string().max(1000).optional(),
    confirmText: z.string().max(40).optional(),
    cancelText: z.string().max(40).optional()
  })
  .strict()
export type DesktopRequest = z.infer<typeof DesktopRequestSchema>
export const DesktopReplySchema = z
  .object({
    requestId: z.string().uuid(),
    projectId: z.string(),
    ok: z.boolean(),
    graphVersion: z.number().int().nonnegative().optional(),
    /** ok=false 且 validated=true：失败发生在任何变更之前，main 可安全返回 failed 而非 unknown。 */
    validated: z.boolean().optional(),
    errorCode: z.string().max(80).optional(),
    errorDetail: z.string().max(300).optional(),
    /** read-graph / graph-patch 的结果载荷（DTO 与 created 映射）。 */
    result: z.unknown().optional()
  })
  .strict()
export const DesktopCommitSchema = z
  .object({
    requestId: z.string().uuid(),
    projectId: z.string(),
    graphVersion: z.number().int().nonnegative()
  })
  .strict()
