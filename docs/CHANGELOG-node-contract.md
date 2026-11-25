# 节点契约变更历史

现行规则见 [节点输入输出契约规范](../NODE_CONTRACT_SPEC.md)。

2026-10-16 工作区接续：video@7 Agent 调度接入已有 in-prompt 的 prompt.bundle@1，专业任务和命令准入均验证正文结构；reference 模式支持有序多路视频/音频，结构上限 30，所选模型的实际较低上限继续强制校验。返工 execute_node 可提交有界 prompt 修订指令，只限原 video 返工目标；固定于 videoRework 命令并参与意图签名，原目标/输入/反馈不改写，unknown 沿原命令接回。同一控制范围的多个审核等待不遮挡其他已完成成果的收集。节点端口/版本不变；实际验证与未完成范围见 [39](canvas-agent-flow/39-parallel-review-rework.md)、[40](canvas-agent-flow/40-multi-reference-prompt-bundle.md) 和[总台账](canvas-agent-flow/38-agent-completion-plan.md)，不能将仍在运行的完整门禁标为通过。

2026-10-15 并行媒体：agent@1 主控可选 maxParallelTasks=1/2，默认顺序；SDK 显式两项派发，main 校验独立写范围、固定输入和额外预算。两路各自保留真实固定视频资产，主控输出端口/基数不变；未连线固定展示副本不改程序语义版本，连入数据边后严格校验。停止终止本地任务且保留未知命令占用，核对/继续只接原任务。验收与限制见 [37 包](canvas-agent-flow/37-parallel-media-stop-recovery.md)。

2026-10-15 视频有界自动返工：sampled-video 可绑定专业 Agent 所控制的唯一 video@7 out-video 来源；审核直接复用当前 committed 命令的固定输出，结论须属于该专业任务。rework 快照增加可选 videoTargetNodeId，node.execute 增加可选 videoRework（reviewId/round）并进入意图签名，main 核对冻结反馈并限定每轮一个视频命令，unknown 不开新轮。未改节点端口或 contractVersion；普通素材人工复审保持。验收与边界见 [36 包](canvas-agent-flow/36-video-review-bounded-rework.md)。

2026-10-15 视频抽帧审核：ai-review@1 可显式选择 sampled-video，唯一 out-video → in-video，冻结单路 MP4 并发送四张真实 JPEG；review.decision@1 增加可选 videoEvidence，严格限定 sampled 范围、时间和摘要。文本/JSON 默认与旧配置保持，门禁由 main 已保存报告和固定视频完整性共同裁决；主控自动视频返工暂拒绝。验收与限制见 [抽帧审核包](canvas-agent-flow/35-sampled-video-review.md)。

2026-10-15 单路参考音频：video@7 的 Agent reference 模式接受一路固定 audio/out-audio → in-reference-audio（最多 20 MiB），可组合已支持图片/视频/文本，继续校验模型能力、固定摘要、实际发送字节与原任务音频列表。固定音频项目包与预览同步扩展；验收状态和边界见 [音频参考包](canvas-agent-flow/34-video-audio-reference-adapter.md)。

2026-10-15 Agent 视频运动参考：video@7 的 reference 模式新增一路固定视频 in-reference-video（普通 video-asset 自动固定摘要，首版最多 20 MiB），可加已有有序图片和一路文本；依所选模型能力校验，音频/多路视频/提示词包仍拒绝。普通端口、contractVersion 和手动能力不变。固定版本、实际发送字节与原任务视频列表均校验；历史未带摘要的生成成果仍可预览/连接，但不能直接当作可信运动参考。验收与边界见 canvas-agent-flow/32-video-motion-reference-adapter.md。

2026-10-15 Agent 视频图片参考适配：video@7 的 reference 模式仅接受有序固定图片 in-images（1–30 的公共硬界，实际依已选模型能力更低上限）和最多一路文本；混入其他媒体/提示词包拒绝。固定来源、版本与实际编码字节均校验，原命令恢复绑定有序媒体列表，不重发生成。既有端口/contractVersion 和手动行为保持。验收边界见 canvas-agent-flow/31-video-reference-images-adapter.md。

2026-10-13 C3.3 接续：builder@agent 通过公共 executor 生成有限文本模板图提案，main 固定预览/语义修订，人明确提交后复用正式节点注册和 createEdge 保存同一画布图；提案不是业务成功或输出。ai-review@1 接入公共 executor 与 main 固定版本审核，out-review/out-feedback 由同一权威 ReviewDecision 投影；否是业务结论、执行仍 success，技术失败没有有效结论。下游手动/Agent 共用门禁，要求同规则、来源、运行身份、资产版本与报告；人工新版本复审按 maxReworks 有界。主控自动审核、纯 AI/人机协作返工任务未支持，详见 canvas-agent-flow/17-c33-builder-review.md；下段首包说明为历史基线。

2026-10-13 C3.3 首包：agent@1 的 coordinator 接入顺序派发专业任务；专业任务固定最小输入、完成条件、独立预算/上下文/checkpoint，成果仍经公共 Agent executor/投影/固定资产。状态机绑定主控运行并呈现持久阶段，只接受声明事件的合法迁移；独立 state-machine executor/out-state 投影仍未开放。控制范围独占、人工等待、暂停派发、停止和重开继续见 canvas-agent-flow/16-c33-sequential-coordination.md；builder 建图和 ai-review 返工仍待后续，不能宣称整个 C3.3 完成。

2026-10-13 C3.2：agent@1 增加节点协作分页和显式目标修订，不增加数据端口或自动业务输出。讨论存任务关联事件，不投影成资产；人工继续绑定 task/wait revision 与固定选择，完成必须匹配真实回执及人工选择。新目标采用准备新的不可变任务实例，旧 snapshot/nodeResult/资产不改写；范围变更拒绝。详见 canvas-agent-flow/15-c32-collaboration.md，验收以开发台账为准。

2026-10-13 C3.1b：agent@1 的专业角色接入公共 executor → main 可信任务宿主 → C2 命令桥。out-text/out-json 输出已确认任务资产，公共执行器落固定资产节点；main 发布版本核对 completed 任务及真实固定引用。文本/JSON 直接输入按保存画布的真实端口固定版本，媒体输入拒绝自动运行。人工等待保留 main 任务及 checkpoint，公共原子运行不伪造成功。state-machine/ai-review 及 builder/coordinator 自主执行仍待接入。详见 canvas-agent-flow/14-c3-canvas-agent.md；下段 C1 说明为历史基线。

2026-10-12 C1（**历史基线，已被 C2/C3.x 取代**：三类节点的真实执行器与输出投影现已接入，见本节上方 2026-10-13 各段与 §4.6；"执行器明确 skipped、投影为空"不再是现状）：新增配置阶段的 `agent`、`state-machine`、`ai-review`（contractVersion=1）。配置与正文分别保存到 props.config/props.text；配置可保存恢复。当时执行器明确 skipped，投影为空，禁止从任务目标、阶段配置或旧 meta 捏造运行结果。`review.decision@1` 校验固定资产版本、规则版本、审核修订、结论与反馈；`flow.state@1` 校验 task/stateNode/revision/state。定义见 src/shared/agent-flow/node-contracts.ts。控制关系保存在 config，不能当作普通数据边形成反向 DAG。

2026-10-05 契约补充：`PortDecl.exclusiveGroup` 声明同组输入合计必须恰好一个，声音调整的音频/视频共用 source-media 组，输入收集与 UI 预检均检查该规则。多个同类型动态端口（例如代码节点）是受控例外，布局可合并锚点，但逻辑端口 ID 和契约仍独立。

2026-10-14 Agent Flow 返工补充：主控仅可通过声明的 `review.execute@1` 权限和控制范围触发公共审核 executor。拒绝结果绑定固定资产版本、规则版本与报告身份；Agent 返工创建独立任务快照，保留原输入、目标节点权限、旧任务和回执，反馈作为显式 `rework` 上下文，不直接改写能力节点配置。人机协作返工准备后须明确启动；文本/JSON 人工返工须明确提交新资产版本，审核使用所提交的固定版本。审核成功运行可以产生质量拒绝；技术失败没有结论，不能释放下游。控制占用、总步数、返工轮次、停止、未知结果和修订冲突继续由可信 main 宿主裁决。现有节点端口与 contractVersion 不变；未适配媒体与并行能力不得通过此路径调度。验收及边界见 `docs/canvas-agent-flow/19-c33-review-rework.md`。

2026-10-14 C4 恢复补充：公共 Agent executor 的 reconcile 只核对保存事实，restore 只补呈现已提交任务/审核结果，未知结果不得调用模型或重放业务。恢复命令绑定 taskId 与等待修订；冲突成果拒绝覆盖。项目迁移携带经过完整性验证的固定资产、重映射结构化引用，但不携带旧任务/审批权威；结构模板只携带声明配置。现有端口与 contractVersion 不变，验收边界见 `docs/canvas-agent-flow/20-c4-recovery-transfer.md`。

