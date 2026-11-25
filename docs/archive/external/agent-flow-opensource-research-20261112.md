# Agent Flow 开源项目深度调研报告

> 调研目标：全网寻找与你的 Agent Flow 设想契合/相似的开源项目，逐一深挖（不是过一眼），明确"哪些机制能直接吸收进 Canvas Studio"。
> 调研基准（你的设想）：① 外部 Agent 动态构建 flow ② 主 Agent 流转 + 显式节点状态机 ③ 节点三形态（纯AI / 人机协作 / 纯人）④ 最小且必要输入 + 输出落盘 + 上下文隔离 ⑤ 人的深度参与 + 注意力集中
> 调研日期：2026-11-12（star 数为当日 GitHub 实际抓取值）
> 每个项目均实际阅读了 GitHub 仓库 / 官方文档 / 关键源码页面，来源 URL 已附。
> 配套文档：《可行性 + 差距分析报告》（agent-flow-feasibility-analysis-20261112.md）

---

## 总览：三组调研对象

- **组 A 编排框架类**：LangGraph、CrewAI Flows、AutoGen/AG2、AgentScope、MetaGPT、OpenAI Agents SDK、deepagents —— 详见第三节
- **组 B 可视化工作流/平台类**：n8n、Dify、Coze Studio、FastGPT、Bisheng、Flowise/Langflow、Temporal、Inngest agent-kit、XState —— 详见第四节
- **组 C 子代理/上下文/人机协作协议类**：Claude Code Subagents、claude-flow、HumanLayer/12-Factor Agents、A2A、MCP、Letta、OpenHands、GPT-Pilot、AI 共编文档（AFFiNE/BlockNote）、人机范式综述 —— 详见第五节

**先给最重要的总判断**：

> **没有任何单一开源项目同时具备你的 4 个核心要素**（AI 生成 flow + 显式节点状态机 + 三形态执行 + 节点上下文隔离）。业界现状是四种"残缺拼图"：隔离但人不在环内（Claude subagents）、人在环但只有审批（Letta/OpenHands/A2A 实现）、状态机但无隔离（A2A 裸协议）、人深度参与但无 AI 自主（GPT-Pilot）。**你的"纯人节点（human-as-executor）"在全网开源方案中是空白** —— 这既是差异化机会，也意味着要自己定义协议。

---

## 一、横向总对比表

评级：极强/强/中/低/无。★ 为 2026-11-12 抓取值。

| 项目 | 状态机表达 | HITL 深度 | 上下文隔离 | AI 动态构建 flow | 最小输入 | 成熟度 | 组 |
|---|---|---|---|---|---|---|---|
| **LangGraph（你在用）** | **极强（channel+reducer+super-step 快照、Send、Command、子图 namespace checkpoint、全历史可回放）** | **极强（interrupt/Command(resume)：改状态/改参数/接管 + response_schema 校验 + 人可改 checkpoint）** | 强（Send 最小注入、子图私有 key、多 schema；压缩靠上层） | 中低（拓扑须代码定义，Send 仅动态分支数） | 强 | 极高（48.2k★ 双语版，生产广泛采用） | A |
| CrewAI Flows | 中（事件流装饰器+router，@persist SQLite 快照/分叉；无节点级状态流水） | 中低（human_input 终稿审阅 + @human_feedback 自由文本→LLM 归类 outcome） | 低（共享大 state 为主） | 低（flow 手写） | 低 | 高（60.8k★，极活跃但 API 迭代快） | A |
| AutoGen/AG2 | 低（会话/消息驱动，无显式状态机；0.4 Actor runtime 事件化） | 中（人可作完整会话伙伴；v1.0 context.input+hitl_hook 暂停恢复+超时异常语义） | 低（全量历史共享；嵌套聊天封箱） | 低 | 低 | **microsoft/autogen 已归档**，AG2 5.1k★ 活跃 | A |
| AgentScope | 中（显式 pipeline/分支/循环 + StateModule；无任意点恢复） | 中（UserAgent 完整参与 + 中断即事件、保留半截产物） | 中（显式单 Msg 传参、MsgHub 可选加入） | 无 | 低 | 中高（35.8k★，阿里活跃） | A |
| MetaGPT | 中（SOP 固定流水线 + 订阅因果触发；流程写死） | 极低（仅入口需求） | 中（订阅制投递 + 结构化制品契约） | 中（同团队 AFlow 研究 MCTS 生成 workflow，未产品化） | 中 | **71.2k★ 但维护停滞**，重心转商业 MGX | A |
| OpenAI Agents SDK | 低（agent loop + handoff 即流程） | 中低（needs_approval 谓词级审批 + RunState 跨进程恢复；只有 approve/reject） | 中（input_filter/nest_handoff_history 交接裁剪） | 低 | 中 | 高（30.6k★，OpenAI 背书） | A |
| deepagents | 低（ReAct 循环；todos channel 是唯一显式任务状态） | 强（interrupt_on：approve/edit/reject/respond + when 谓词 + 批量审批） | **极强（isolated/fork 子代理、摘要回传、卸载到虚拟 FS）** | 中低（动态子代理 beta，非流程生成） | 强 | 高（31.2k★，2025 爆火，极活跃） | A |
| n8n | 低 | 中（Wait+表单/审批链接） | 低 | 低（JSON 公开稳定） | 低 | 极高（fair-code） | B |
| **Dify** | 中（YAML DSL） | **较深（预填编辑产出物+多按钮分支+超时分支+邮件外链）** | 中 | 低 | 中 | 极高 | B |
| **Coze Studio** | **强（InterruptEvent 显式中断实体，可嵌套）** | 中（问答/输入+resume API） | **强（InputSources 逐字段映射）** | 低 | **强** | 中高 | B |
| FastGPT | 中（连线三态 waiting/active/skip） | 中（userSelect/formInput） | 中 | **高（辅助生成三步法，仅商业版）** | 中 | 高 | B |
| Bisheng | 中 | 较深（dialog/form 双模式+引擎挂起） | 中 | 低 | 中 | 中 | B |
| Flowise | — | — | — | — | — | **已归档（2026-08），不可用** | B |
| Langflow | 低 | 低 | 低 | 低 | 低 | 高 | B |
| **Temporal** | **极强（Event History+replay+Entity Workflow）** | 中（Signal 等审批，UI 自建） | **强（Activity 边界）** | 中 | 中 | 极高（生产级） | B |
| Inngest agent-kit | 强（step 持久化+typed state machine） | 中（waitForEvent+onRoute 卡点） | 强 | 低 | 中 | 中（年轻） | B |
| **XState + @statelyai/agent** | **极强（层级/并行状态图+actor+snapshot）** | 中（getInteraction 收敛人为事件） | **强（actor 消息传递）** | **高（decideNext 约束生成）** | 强 | 高（库级） | B |
| **Claude Code Subagents** | 粗（共享 task list 四态） | 中（审批+中断+信箱，无纯人节点） | **最强（独立窗口+返回摘要+防注入）** | **强（md/JSON 定义 AI 可写）** | **强（委派消息即最小输入）** | 官方（teams 实验） | C |
| claude-flow/Ruflo | 中（SQLite 会话/任务） | 弱 | 中（稳定性存疑） | 中 | 弱 | 81.5k★，营销过重 | C |
| **HumanLayer 12-Factor** | **强（事件 reducer，方法论级）** | 强（request_human_input 事件对） | 弱（单 agent 视角） | 强 | **强** | 方法论 27.1k★ | C |
| **A2A 协议** | **强（协议级 9 态 Task，含 input-required）** | 中（协议级，实现自由） | 中（contextId 分组） | 中（AgentCard 发现） | **强（artifact 契约）** | 26.5k★，Linux 基金会 | C |
| MCP | 无（工具层） | 弱（elicitation 微确认） | 不适用 | 无 | 工具 schema 约束 | 事实标准 | C |
| Letta/MemGPT | 弱（approval 暂停点） | 中（approve/deny+reason 回喂） | 中（记忆块层隔离） | 弱 | 强（block 按需注入） | 25.4k★（API 迁移期） | C |
| **OpenHands SDK** | **强（事件溯源重放，工程最强）** | 中（确认模式+UserReject） | 强（沙箱+事件日志） | 中 | 中 | 93.2k★，极活跃 | C |
| GPT-Pilot | 低（线性步骤） | **理念深（逐步确认+答疑）** | 低 | 无 | 中 | 33.6k★，**已弃维+供应链投毒** | C |
| AFFiNE / BlockNote | 无 | **产物级共编（块级 diff 接受/拒绝）** | 不适用 | 无 | 文档上下文 | 74.5k★ / 组件级 | C |

---

## 二、可直接吸收进 Canvas Studio 的机制清单（按你的缺口组织）

这是本报告的核心产出：**每个机制 → 来源项目 → 对应你的哪个缺口 → 怎么落地**。

### 吸收清单 1：状态机协议骨架（对应缺口：状态机自动闭环）

1. **A2A Task 9 态生命周期**（来源：A2A 协议，Linux 基金会）
   - `submitted / working / completed / failed / canceled / **input-required** / auth-required / rejected / unspecified`
   - `input-required` 就是"人机协作"的协议化表达：agent 中途把任务转此状态，客户端携相同 `taskId + contextId` 发消息恢复。
   - **落地建议**：你的任务级状态机（ready/running/waiting/blocked/…）已很接近；建议对齐 A2A 命名，并**扩展两个自定义态**：`human-working`（纯人节点执行中）与 `input-required`（等待人提供输入），A2A 有正式 extensions 机制（`extensions` URI 字段）支持这样扩展。
   - 来源：https://github.com/a2aproject/A2A 、https://a2a-protocol.org/latest/specification/

2. **Coze Studio InterruptEvent + ResumeRequest**（来源：coze-dev/coze-studio，Go 源码）
   - 中断事件带 `NodeKey / NodeType / NodePath（嵌套路径）/ NestedInterruptInfo`，恢复用 `ExecuteID + EventID + ResumeData` 拼唯一恢复 ID。
   - **落地建议**：你的声明式状态机节点接入账本回执事件时，事件结构可参考这个（带节点路径、可嵌套、可序列化、有唯一恢复 ID）。
   - 来源：`backend/domain/workflow/entity/interrupt_event.go`

3. **OpenHands 事件溯源 + 三方归因**（来源：All-Hands-AI/OpenHands software-agent-sdk）
   - 事件是不可变 Pydantic 模型的 append-only log，每个事件带 `source: user | agent | environment`。
   - **落地建议**：你的三形态（纯AI/人机/纯人）可直接映射为事件 source 枚举扩展；把"人节点的开始/产出/驳回"也设计成事件类型（对齐 `UserRejectObservation` 的做法），状态机 = 事件日志的投影。
   - 来源：https://docs.openhands.dev/sdk/arch/events 、SDK 论文 arXiv:2511.03690

### 吸收清单 2：人机协作协议（对应缺口：纯人任务形式化）

1. **HumanLayer 12-Factor Factor 7 的 `request_human_input` 事件对**（方法论仓库 27.1k★）
   ```python
   class RequestHumanInput:
       intent: "request_human_input"
       question: str
       context: str
       options: Options  # urgency: low/medium/high; format: free_text/yes_no/multiple_choice; choices
   # 循环中：保存状态 → 通知人 → 退出循环，等 webhook 带回 response_from_human 事件恢复
   ```
   - **落地建议**：直接照抄 `human_input_requested → response_from_human` 事件对作为人机协作节点的事件骨架；人的输入是事件流中又一个结构化事件，与 agent 动作同构，天然支持异步/审计。
   - 来源：https://github.com/humanlayer/12-factor-agents （Factor 7）

2. **Dify Human Input 节点**（161k★，"人编辑产出物"最完整实现）
   - 表单三要素：Markdown 说明 + 变量引用（把上游 LLM 草稿直接渲染进表单）+ 字段（**Paragraph 可用上游变量预填 = 人在改 AI 的稿子**）；多按钮 `__action_id` 各连不同下游分支（Approve / Apply Edit / Regenerate）；**超时分支**是流程图一等公民；邮件外链免账号回复。
   - **落地建议**：你的 AgentCollaborationPanel 已有 discuss/revise/submit，可补三件事：按钮→分支映射、超时分支、"预填产出物供直接编辑"的交互。
   - 来源：https://docs.dify.ai/en/guides/workflow/node/human-input

3. **Letta approval 的"驳回带 reason 回喂"**（25.4k★）
   - 人拒绝时 `reason` 变成 tool error 回喂模型，官方建议写具体指令（如"先用只读查询验证数据再删除"）。
   - **落地建议**：你的返工机制中，人工驳回意见应结构化回喂给下游 agent；GPT-Pilot 的 Troubleshooter 模式（专设角色帮人把模糊不满转成结构化反馈）可作为"改稿意见结构化节点"。
   - 来源：https://docs.letta.com/guides/agents/human-in-the-loop

4. **deepagents decisions 协议（approve / edit / reject / respond + when 谓词）**（31.2k★，LangChain 官方）
   - 它就是 LangGraph interrupt 之上的人机决策"标准答案"：approve（放行）/ edit（人改参数）/ reject（带 message 驳回）/ respond（人的话直接作为工具结果，即人接管输出）；`when` 谓词按工具调用内容动态决定是否需要人（如"写工作区之外才要人审"）。
   - **落地建议**：直接作为你 harness"人机协作节点"的决策 schema——你的 AgentCollaborationPanel 已有 discuss/revise/submit，可对齐这套四档决策 + `when` 谓词（风险分级，不必每节点都要人）。
   - 来源：https://docs.langchain.com/oss/python/deepagents/human-in-the-loop

5. **CrewAI `@human_feedback(emit=[...])` 模式**（60.8k★）
   - 人给自由文本反馈 → LLM 把反馈解析成枚举 outcome → 驱动路由。比裸 approve/reject 更发挥人的表达力，实现成本低。
   - 来源：https://docs.crewai.com/concepts/flows

6. **AgentScope"中断即事件 + 保留半截产物"**（35.8k★）
   - 人打断 AI 时，LLM 半截回复、被打断的工具输出都保留进 memory 并打上中断标注，agent 可带着上下文续跑/改向。
   - **落地建议**：你的人中断 AI 节点时不要丢弃半成品——存档 + 标注 + 作为返工上下文。
   - 来源：https://arxiv.org/html/2508.16279v1

7. **Bisheng Input 节点 dialog/form 双模式 + LLM 生成推荐问题**（12.3k★）
   - 既能填表也能多轮对话补信息，且 LLM 生成 guide questions 降低人的负担；节点用 `get_input_schema()` 自描述输入契约，前端据此渲染人机协作 UI。
   - 来源：https://github.com/dataelement/bisheng

### 吸收清单 3：最小必要输入与上下文隔离（对应缺口：验证你的既有强项）

1. **Claude Code Subagents 三件套**（Anthropic 官方）
   - 每个子代理独立全新上下文窗口，只拿自己的系统提示词 + 主 Agent 写的委派消息（= 最小输入），不继承对话历史；**返回给主 Agent 的只有摘要**；返回文本被扫描转义防注入。
   - Anthropic 工程博客量化结论：多代理比聊天多耗 ~15× token，"搜索即压缩"，subagent 是 "intelligent filters"，委派提示必须含"目标、输出格式、工具边界"。
   - **落地建议**：你的 per-task snapshot/session 已做到隔离；可补"节点输出入状态机前做摘要压缩 + 指令扫描"。
   - 来源：https://code.claude.com/docs/en/sub-agents 、https://www.anthropic.com/engineering/multi-agent-research-system

2. **Coze Studio InputSources 逐字段映射**
   - 每个节点的每个输入字段都声明"来自哪个前驱节点的哪个输出字段"或常量——字面意义的"最小且必要输入"。
   - **落地建议**：你的 `FixedNodeInputSchema`（targetPortId + asset 引用）已同构；若要更细，可学习它的"字段级映射"粒度。
   - 来源：coze-studio Wiki《新增工作流节点类型（后端）》

3. **XState @statelyai/agent 的 describeMachine**
   - 把状态机渲染为纯文本给模型看（喂给模型的流程上下文是精简结构描述而非全量历史）；`decideNext` 让模型只输出该机器实际接受的事件——**"The machine decides which work is legal; the host executes model calls"**。
   - **落地建议**：你的协调宿主（coordinator-host）喂给主 Agent 的上下文可用同样原则：只给机器的合法转换集合，不给全量历史。
   - 来源：https://stately.ai/docs/packages/agent

4. **OpenHands Condensation 三件套**（CondensationRequest → 记录 forgotten_event_ids + summary → CondensationSummaryEvent）
   - 历史压缩是一等事件、可重放/审计。**落地建议**：节点结束后上游上下文的清理可用此模式。
   - 来源：https://docs.openhands.dev/sdk/arch/events

5. **OpenAI Agents SDK `input_filter` / `nest_handoff_history`**（30.6k★）
   - handoff 时用显式过滤函数裁剪新 agent 看到的历史（`handoff_filters.remove_all_tools` 等），或把历史折叠成摘要段——**交接点的"最小历史注入"原语**。
   - **落地建议**：所有"进入下一节点"的入口都过一道显式 history 裁剪函数——上下文不爆炸的第一道闸。
   - 来源：https://openai.github.io/openai-agents-python/handoffs/

### 吸收清单 4：AI 动态构建 flow（对应缺口：开放流程构建管线）

1. **FastGPT 辅助生成三步法**（仅商业版，思想可借鉴）
   - ① 用户自然语言描述 → AI 返回**流程图+方案说明**供检查/修改；② AI 搭建并执行**配置校验**，生成"尚未写入画布"的版本；③ 用户点"应用到画布"后替换并自动排版。支持增量修改。
   - **落地建议**：这正是你缺口 2 要做的"AI 提案→静态校验→影响预览→用户确认"管线的产品化范本，你的 BuildPreview（preview→authorize→confirm→discard）生命周期已经把骨架搭好了。
   - 来源：https://doc.fastgpt.io/zh-CN/guide/build/workflow/assisted-generation

2. **Claude Code subagents frontmatter 作为节点 DSL**
   - `name / description / tools / model / permissionMode / maxTurns / memory / hooks / isolation` + 正文系统提示词，是"AI 可生成且人可读改"的成熟文件协议。
   - **落地建议**：你的 SkillPackageSchema 已非常接近（id/version/name/description/instructions/requiredTools/resources）；可对照补 `description` 的"何时委派"语义（Claude 靠它决定何时委派）。
   - 来源：https://code.claude.com/docs/en/sub-agents

3. **A2A AgentCard 作为"节点能力菜单"**
   - `name/description/skills/capabilities/securitySchemes` = 流程构建方动态选择节点的数据结构。
   - **落地建议**：你的 agent-access registry（~130 操作）+ 上帝 Agent 能力目录可统一成 AgentCard 式的能力发现格式，让外部 Agent 构建流程时有"菜单"可查。

4. **n8n workflow JSON 的 `typeVersion` 机制**
   - 节点定义带 typeVersion，引擎演进时不破坏旧流程。
   - **落地建议**：你的节点契约已带 schema version；跨节点引用（composite 发布版本钉定）已做，此条为确认而非新增。

### 吸收清单 5：执行语义与可靠性（对应缺口：FlowRun 一等实体）

1. **Temporal Event History + Entity Workflow**
   - 每步记录状态、失败后从最后事件恢复；长等待不占资源；Entity Workflow = 每个流程实例一台持久化状态机，Signals/Updates 驱动状态转换。
   - **落地建议**：你的命令账本（pending/prepared/committed/unknown）在语义上已是事件溯源的变体；FlowRun 一等实体可参考 Entity Workflow："一次运行 = 一个可 Signal 的实体"。
   - 来源：https://docs.temporal.io/durable-execution 、https://docs.temporal.io/ai.md

2. **Inngest agent-kit 的 `network.state.kv` + 代码路由 + `onRoute` 人工卡点**
   - 路由器显式化为可编程函数（"谁下一个执行"可审计）；`onRoute` 回调天然适合插入人机协作卡点。
   - 来源：https://github.com/inngest/agent-kit

3. **FastGPT 连接线三态（waiting / active / skip）+ `INTERACTIVE_NODE_TYPES` 引擎级约束**
   - "可暂停节点"是引擎全局概念（并行体内禁用、循环内允许），而非单节点行为。
   - **落地建议**：你的 composite/并行分波调度中，对含 human waitKind 的节点应有同样的调度约束检查。

4. **LangGraph JS 工程细节（你的 harness 直接相关）**
   - **UntrackedValue**：不写进 checkpoint 的临时 channel——把大体积中间产物（草稿、原始抓取）标记为不进 SQLite checkpointer，防膨胀。
   - **recursionLimit 默认 25**（JS）vs 10007（Python）：JS 版长流程容易被误杀，需在 config 显式调高。
   - `get_state_history()` 可直接给前端画"节点状态时间线"。
   - 来源：https://docs.langchain.com/oss/javascript/langgraph/graph-api

5. **AutoGen AG2 超时异常语义（"人不在场"是一等状态）**
   - `context.input(timeout=)` 无人应答时 turn 以 `HumanInputTimeoutError / NotProvidedError / FailedError` 结束，框架故意不伪装成工具失败，防止模型绕路。
   - **落地建议**：你的纯人节点/人机协作节点的超时语义照此设计——超时是显式可编程状态，可接通知/重试/超时分支（参考 Dify 超时分支）。
   - 来源：https://docs.ag2.ai/docs/user-guide/context/human_in_the_loop

---

## 三、组 A：编排框架类（详细）

> 特别说明：Canvas Studio 的 harness 本身就是 LangGraph JS（StateGraph/interrupt/Command + SQLite checkpointer），所以 LangGraph 是你已经在用的底座——本节重点回答"你的 harness 用对了吗、还有什么没吃到"。

### 3.1 LangGraph（langchain-ai/langgraph + langgraphjs，~48k★ 合计，极活跃）

**定位**：低层"有状态 Agent 编排框架"（README 原话），被 Replit、Uber、LinkedIn、GitLab 生产使用。**是目前唯一把"流程 = 显式状态图 + 持久化检查点 + 可恢复中断"做成一等公民的框架。**

- 【核心机制】
  - **StateGraph**：add_node/add_edge/add_conditional_edges/compile；路由函数可返回节点名、END、名字列表（fan-out）或 **Send 对象**。官方警告：同一节点不要混用静态边和动态路由（"Mixing them can run both paths"）。
  - **状态 = channel 体系**：schema 字段即 channel，默认 last-write-wins；`Annotated[list, operator.add]` 声明 reducer；`add_messages` 专门支持 HITL 时**原地编辑已有消息**；节点只返回 partial update。
  - **执行模型**：Pregel 式 super-step，**每个 super-step 边界落一个 checkpoint**。
  - **Command**：一个节点同时"改状态 + 决定走向"——`Command(update={...}, goto="node")`；子图内跳父图 `graph=Command.PARENT`。
  - **Send（动态并行 map-reduce）**：条件边返回 `[Send("node", {最小per-item状态}) ...]`——**每个并行分支注入自己的最小状态**，天然实现"最小且必要输入"。
  - **子图（subgraph）**：私有 key 对父图不可见（multi-agent 各持私有消息历史）；带 checkpointer 时子图在自己 namespace 下落 checkpoint（`checkpoint_ns = "node_name:uuid"`）。
  - **Checkpointer**：StateSnapshot = {values, next, config, metadata{source, **writes（节点输出）**, step}, tasks(interrupts)}；`get_state_history()` 拿到每一步完整历史；`update_state()` 以新 checkpoint 形式人工改状态——**checkpointer 被官方称为 "a scratchpad for human/agent collaboration"**。JS 侧 SQLite 包 `@langchain/langgraph-checkpoint-sqlite` 正是你的 harness 在用的。
  - **JS 特有差异（对你重要）**：新 API `StateSchema/ReducedValue/MessagesValue/UntrackedValue`（**UntrackedValue 是不写进 checkpoint 的临时 channel**）；用 Command 的节点须在 addNode 时传 `ends` 声明去向；**默认 recursionLimit 只有 25（Python 是 10007）**。
- 【HITL 机制】
  - `interrupt(payload)`：节点任意位置调用 → runtime 挂起图 → payload 经 checkpoint 持久化；恢复时 `graph.invoke(Command(resume=X))`，**X 成为 interrupt() 的返回值**，节点从函数头**重新执行**（interrupt 前副作用必须幂等；不要裸 try/except 包住它）。
  - 交互形态官方枚举：approve/reject、**review & edit state（人直接改写状态字段再续跑）**、review tool calls（人可覆盖工具参数）、多轮对话；新版本 `response_schema=`（JSON Schema）对 resume 输入做**类型校验**（langgraph ≥1.2.12）。
  - 静态 `interrupt_before/after` 仅推荐调试用，官方明言"not recommended for human-in-the-loop workflows"。
  - 多中断：并行分支同时挂起，用 `{interrupt_id: answer}` map 批量 resume。
- 【上下文管理】Send 最小注入、子图 wrapper 窄接口（输入映射+输出映射）、input/output schema 窄化 + 私有 channel。核心库不做自动压缩（压缩在上层 deepagents）。
- 【映射】设想 2（节点状态流水账）= checkpointer 的 metadata.writes + get_state_history 现成实现；设想 3 三形态原生覆盖：纯AI（不 interrupt）/ 人机协作（edit/review）/ **纯人（人接管节点返回值 = interrupt 的返回值由人给出）**；设想 5 = update_state 让人在任意 checkpoint 改状态再续跑，超越 approve/reject。**做不到**：设想 1——图拓扑是代码编译出来的，不提供"运行时由外部 Agent 生成新拓扑"的 API（Send 只能动态分支数量，不能动态发明节点）。
- 【可借鉴】①interrupt()/Command(resume) 协议两条铁律固化为你 harness 的节点编写规范（人的答复=interrupt 返回值；interrupt 前副作用幂等），并给 interrupt 加 response_schema 做结构化人输入校验；②"分发给多个 worker"一律走 Send；③每个节点/子代理一层 StateGraph 包裹获得稳定 namespace+私有状态；④**UntrackedValue 防大体积中间产物撑爆 SQLite checkpointer**；⑤配合 get_state_history 给前端画"节点状态时间线"。

### 3.2 CrewAI Flows（~60.8k★，极活跃但 API 迭代快）

- 【核心机制】装饰器事件流：`@start()` / `@listen(method)`（上游输出作为参数传入）/ `@router()` 分支 / `or_()` `and_()` 组合触发；状态 `self.state`（dict）或 `Flow[PydanticState]` 结构化；`@persist` SQLite 持久化，`kickoff(restore_from_state_id=uuid)` 从快照**分叉**出全新 state.id（轻量 checkpointer + fork 语义）。
- 【HITL】Task 级 `human_input=True` 只让人审**最终答案**（文档仅一句话定义）；Flow 级 `@human_feedback(message, emit=["approved","rejected"], llm)`：暂停等人给自由文本反馈，由 LLM 把反馈**解析成枚举 outcome 用于路由**。
- 【映射】事件流可表达"固定环节+分支"，但无节点级状态记录、共享大 state 无隔离、AI 不生成 flow。
- 【可借鉴】①`@human_feedback(emit=[...])` 模式：人给自由文本→LLM 归类为枚举 outcome→驱动路由，比裸 approve/reject 更发挥人的表达力且成本低；②`restore_from_state_id` **fork 语义**：从历史快照分叉平行试跑，原流程不受污染——适合"人给多个方案各跑一支"；③结构化 Flow[PydanticState] 强制状态 schema 化便于前端渲染。

### 3.3 AutoGen / AG2（microsoft/autogen 61.8k★ **已官方归档**；AG2 5.1k★ 活跃）

- 【重大近况】microsoft/autogen 宣布不再维护，继任为 Microsoft Agent Framework 1.0；社区延续 AG2（v1.0 "AgentOS"）。生态撕裂是最大减分项——**选型避开**。
- 【核心机制】0.4+ = 事件驱动 Actor 模型 + runtime；经典 = ConversableAgent/UserProxyAgent/GroupChat（LLM 选发言人=运行时动态编排）。AG2 v1.0：Agent+@tool+Network（类型化通道）+ `hitl_hook`；内存侧 `CompactTrigger(max_events=8)` 按事件数触发压缩。
- 【HITL】经典 `human_input_mode=ALWAYS/TERMINATE/NEVER`——人可作为**完整会话参与者**（能改正、能续聊，强于纯审批）；v1.0 工具内 `await context.input("...", timeout=60.0)` 暂停等人；无人应答 turn 以 `HumanInputTimeoutError/NotProvidedError/FailedError` 结束（**框架故意不伪装成工具失败，防模型绕路**）。
- 【可借鉴】①`context.input(timeout=)`+显式异常分类——"人不在场"必须是可编程处理的一等状态（你的纯人节点超时语义可参考）；②TERMINATE 模式：把"人的否决权"放在终止点上作为低成本兜底 HITL；③CompactTrigger 按事件数触发压缩的简单启发式。

### 3.4 AgentScope（~35.8k★，阿里，活跃，当前 2.0）

- 【核心机制】显式控制流哲学：SequentialPipeline/条件分支/循环/`MsgHub` 广播域（可选加入，不加入不收广播）；`Msg` 为最小传递单元；`StateModule` 嵌套 state_dict 存取；hooks 前后事件可改输入输出。
- 【HITL】`UserAgent` 人作为对话对手完整参与；**"中断即事件"**（论文强调）：asyncio 取消触发 `handle_interrupt`，**LLM 半截回复、被打断的工具输出都保留进 memory 并打上中断标注**，agent 可带着上下文续跑/改向。
- 【可借鉴】①**人打断 AI 时把 partial output 存档标注而不是丢弃**——人机协作 UX 的关键细节（你的人中断 AI 节点时应保留半成品并标注）；②StateModule 嵌套状态存取范式；③Studio（项目面板+trace+可选广播域）监控形态。

### 3.5 MetaGPT（~71.2k★，**开源框架实质停滞**）—— 思想最像，工程勿依赖

- 【定位】"Code = SOP(Team)"：软件公司 SOP 固化为角色流水线（产品经理→架构师→项目经理→工程师→QA），与"垂类任务拆解为固定环节"最像。**但团队 2025-02 转向商业产品 MGX（$1M ARR/月），承诺的开源 v1.0 从未发布**；第三方评估指南建议"视为参考架构而非可依赖的供应商"。衰落归因：SOP 卖点被通用编排框架 + Coding Agent 两头挤压，**"固定环节"不适合泛化任务——这反过来印证你的"每个垂类任务一个 flow"思路必须让 flow 可由 AI 按垂类生成，而非平台硬编码**。
- 【核心机制】角色按 SOP 接力，交接物是**结构化制品**（PRD→设计→任务单，"Structured Communication Interfaces" 明确为防链式幻觉）；**共享消息池 + 发布/订阅**：agent 按角色兴趣订阅，"收到全部前置依赖才激活"——因果触发流水线。研究线 **AFlow**（同团队，ICLR 2025 oral，top 1.8%）：MCTS 自动搜索生成 workflow——"AI 动态构建 flow"方向最正式的学术成果。
- 【可借鉴】①**角色订阅过滤**：每个节点声明"依赖哪些前置产物的哪些字段"，框架据此投递（把 pub/sub 升级成 schema 级）；②**制品契约**：节点输出定义为版本化结构物，人可中途替换/批注制品再放行——人机协作节点的理想载体；③AFlow 思路：LLM 生成 + 试跑反馈即可，不必照搬 MCTS。

### 3.6 OpenAI Agents SDK（~30.6k★，活跃）

- 【核心机制】刻意少抽象：`Agent(instructions, tools, handoffs, guardrails, output_type)` + Runner；**Handoffs = 控制权交接即工具调用**（transfer_to_x）。
- 【HITL】`@tool(needs_approval=True)` 或**异步谓词**（收 run context+已解析参数，**fail-closed**：参数无法安全检查时强制人工）；暂停时 `RunResult.interruptions`；`state.approve/reject`（粘性决策+rejection_message）；**RunState.to_json/from_json 跨进程恢复**、未决审批分批处理。
- 【上下文管理】`input_filter` 过滤交接时的新 agent 视野（`handoff_filters.remove_all_tools` 等）——**交接点的"最小历史注入"原语**；`nest_handoff_history` 把历史折叠成摘要段；Session 只取最近 N 条 + `responses.compact` 自动压缩。
- 【更正】官方从未直接点名对比 LangGraph（常见横评说法是第三方转述）；官方口径是"想自己管 loop/tool dispatch/state 就用裸 API，想交给 runtime 就用 SDK"。
- 【可借鉴】①所有"进入下一节点"的入口都过一道显式 history 裁剪函数（上下文不爆炸第一道闸）；②needs_approval 异步谓词=风险分级审批（按参数内容决定是否要人，比全局开关聪明）；③RunState 序列化暂停恢复协议。

### 3.7 LangChain deepagents（~31.2k★，2025 爆火，极活跃）—— 上下文隔离与 HITL 决策协议最佳参照

- 【核心机制】"batteries-included agent harness"，跑在 LangGraph runtime 上，两层架构（LangGraph 管 durable execution/streaming/HITL；harness 层叠 middleware）。四件套：①**Planning**：`write_todos` 工具，todo 列表（pending/in_progress/completed）**持久化在 agent state 的 todos channel**；②**虚拟文件系统**（内存/磁盘/store 可换，大工具结果卸载到文件系统）；③**Subagents**：`task` 工具派生子代理，同步/异步（可并行、可 mid-flight steering）；④详细系统提示 + Skills/AGENTS.md + 上下文管理（摘要压缩+卸载）。
- 【HITL】`create_deep_agent(interrupt_on={工具名: {allowed_decisions: [approve / **edit（人改参数）** / reject（带 message）/ **respond（人的话直接作为工具结果）**], when: 谓词}})`；恢复 `Command(resume={"decisions":[...]})`，decisions 与 action_requests 一一对应、可批处理；子代理可自带 interrupt_on 覆盖父级（中断冒泡）；`FilesystemPermission(mode="interrupt")` 敏感路径写入触发审批。
- 【上下文管理】**isolated 模式**（默认，"the subagent only sees the delegated task"，父上下文零泄漏）/ **fork 模式**（beta，继承父历史+continuation preamble）；`response_format`（Pydantic）结构化回传；官方 best practice："instruct subagents to return concise summaries rather than raw data"。
- 【可借鉴】①**decisions 协议（approve/edit/reject/respond + when 谓词）直接可移植为你 harness "人机协作节点"的决策 schema**——它就是 LangGraph interrupt 之上的标准答案；②todos channel 设计=把计划持久化在 state 里暴露给前端渲染（节点状态可视化的低成本近似）；③isolated/fork 双模式+"子代理只回摘要"作为默认上下文策略；④文件系统卸载层：大产物落盘、上下文只留引用。

### 组 A 小结

- **契合度排序**：LangGraph（几乎逐条对应，且你的 harness 已在其上）> deepagents（隔离+HITL 决策协议最佳参照）> MetaGPT（垂类 SOP+订阅式最小投递思想）> AgentScope（显式控制流+中断即事件）> OpenAI SDK（交接裁剪+可序列化暂停）> CrewAI（事件流+fork 分叉）> AG2（会话式 HITL）。
- **没有一个框架原生支持"外部 Agent 动态构建 flow"**：拓扑要么编译自代码（LangGraph/CrewAI），要么模型隐式驱动（SDK/deepagents/AG2）。最接近的正式尝试是 MetaGPT 团队的 AFlow（ICLR 2025 oral）。
- **落地建议（对你的项目最关键的一条）**：在你的 LangGraph harness 上定义一个**可序列化的 flow 定义 schema**（节点类型：纯AI/人机协作/纯人 + 各自最小输入 schema + interrupt 决策集），让外部 Agent 产出该 JSON，harness 负责编译成 StateGraph 并跑——**这正好把你已有的 StateGraph/interrupt/Command/SqliteSaver 底座变成"flow 解释器"，而这一层全网没有现成品**。

---

## 四、组 B：可视化工作流 / 平台类（详细）

### 4.1 n8n（~210k★，fair-code，活跃）

**定位**：工作流自动化平台，AI 原生。注意许可证是 Sustainable Use License，非纯开源。

- 【核心机制】Workflow 定义是纯 JSON（`nodes[]` + `connections`），格式公开稳定，适合 AI 生成后经 API 导入；节点间按 items（`{json, binary}`）流转，**没有"最小必要输入"声明机制**——下游靠表达式 `$json` 自己挑字段。Wait 节点暂停时把 execution data 卸载到数据库，恢复时重载。
- 【HITL】Wait 节点四种 Resume：时间/指定时间/Webhook/**Form Submitted**；审批模式用 `$execution.resumeUrl` 生成唯一恢复链接；2025 年新增 Slack/Gmail/Chat 的 "Send and Wait for Response"。人工形式基本是**点按钮批准 + 填表单**。
- 【映射】可借鉴：Wait 四式（尤其 resumeUrl 一次性恢复链接）、表单字段规范、`typeVersion` 兼容机制、"审批结果→IF/Switch 显式分支"。做不到：无显式状态机、上下文不隔离、人不能富编辑产出物。

### 4.2 Dify（~161k★，Apache 2.0+附加条件，活跃）—— HITL 交互设计最佳

**定位**：开源 LLM 应用开发平台。**Human Input 节点是本次调研中"人工编辑产出物"做得最完整的。**

- 【核心机制】应用 DSL 是 YAML（.ifpkg）；Chatflow vs Workflow 两种应用类型节点不互通；节点通过变量引用取数（声明式但非最小集约束）；Human Input 节点处工作流暂停，Service API（`submit-human-input-form`）提交后恢复。
- 【HITL】表单三要素（Markdown 说明 / 变量引用渲染上游草稿 / **Paragraph 可用变量预填**）+ 多按钮 `__action_id` 各连不同下游分支 + **超时分支**（默认 3 天，超时走兜底分支）+ 邮件外链免账号。官方示例"内容审核工作流"：LLM 起草→邮件→表单预填 `edits` 供直接修改→Approve（原稿）/ Apply Edit（人改后的稿）/ Regenerate（按反馈重写）。**警示**：issue #32303 显示 2026-01 曾回滚修补，仍在打磨。
- 【映射】可借鉴：预填 Paragraph = 最小成本"人编辑 AI 产出物"；`__action_id` 让人工动作成为下游可编程变量；超时分支。做不到：输入非最小集、无显式状态机、人不能中途接管执行。

### 4.3 Coze Studio（~21.8k★，Apache 2.0，字节 2025-07 开源）—— 中断/恢复数据模型范本 + 最小输入最强实现

- 【核心机制】基于自研 Eino 编排框架。前端画布 `vo.Node` 带 `inputs/outputs` 声明，后端 `NodeAdaptor` 转 `NodeSchema`（含 **`InputSources`**（前驱节点输出字段映射）、InputTypes、静态固定值）。节点执行体只需实现 `Invoke(ctx, input map[string]any) (output map[string]any)` —— **输入就是"声明的字段映射合并后的 map"**。这就是显式的、按字段的输入输出契约。`SettingOnError`（重试/超时/降级/异常分支）声明即自动生效。
- 【HITL】**InterruptEvent 显式中断实体**：`NodeKey/InterruptData/NodeType/NodePath（嵌套路径）`、事件类型含 Question/Input/LLM/Tool 与 `SubWorkflowInterruptInfo`；恢复协议 **ResumeRequest**（`ExecuteID + EventID + ResumeData`，唯一恢复 ID `ExecuteID_EventID`）。问答节点支持预置选项+开放式两种。
- 【映射】可借鉴：InterruptEvent+ResumeRequest 模型（与你"显式状态机记录节点状态"的服务端实现几乎同构）、InputSources 逐字段映射（字面意义的"最小且必要输入"）、SettingOnError 声明式异常策略。

### 4.4 FastGPT（~30k★，活跃）—— AI 生成流程的三步交互范本

- 【核心机制】节点含输入（手动/变量引用）/输出/触发器三部分；**连接线三态 `waiting/active/skip`**（"前置线有 waiting 则等待、有 active 则执行、皆无则跳过"）——对"节点状态"的显式建模；`INTERACTIVE_NODE_TYPES`（userSelect、formInput、agent）在引擎级被特殊调度（并行体禁用、循环内允许）。
- 【HITL】userSelect（暂停展示预设选项，每选项连不同分支）、formInput（填表后继续）。
- 【AI 生成】**辅助生成三步**：① 自然语言→AI 返回流程图+方案说明供检查修改；② AI 搭建+配置校验，生成未写入画布的版本；③ 用户"应用到画布"。支持增量修改。**仅商业版。**
- 【映射】可借鉴：连线三态语义、"可中断节点集合"引擎级约束、三步交互+增量修改。

### 4.5 Bisheng 毕昇（~12.3k★，Apache 2.0，活跃）—— HITL 差异化卖点

- 【核心机制】独立 workflow 框架，**不区分 chatflow/workflow**（多轮对话与自动化可混排同一流程），支持成环/并行/批量。节点-边-图三层。
- 【HITL】InputNode 双模式：**dialog**（处理 user_input+文件，LLM 生成推荐问题推前端）/**form**（表单字段定义含文件字段）；节点 `get_input_schema()` 自描述输入契约，前端据此渲染；暂停逻辑在引擎层；用户输入 `save_context(msg_sender="human")` **写回会话历史**——人是对话参与者。
- 【映射】可借鉴：节点自描述输入契约→前端生成协作 UI；dialog/form 双模式；LLM 推荐问题降低人的负担。注意：无独立 approval 节点，HITL 全收敛在 input 节点。

### 4.6 Flowise / Langflow（简要）

- **Flowise（~55.6k★）：已于 2026-08-13 归档（read-only），不可作为参考基座。**
- Langflow（~156.5k★，MIT，活跃）：组件级可视化，flows 可导出 JSON、可部署为 MCP server（把整个 flow 暴露为工具），playground 有逐步调试。最有用：flow 即 JSON 的可导出性 + MCP 化。

### 4.7 Temporal（~24.3k★，MIT，生产级）—— "显式状态机"的最强执行语义参照

- 【核心机制】**Event History**：每一步记录 Workflow 状态，失败后从最后事件恢复；Worker 无状态，重放历史重建内存状态。保证"代码精确执行一次并运行至完成——几秒或几年"。长等待不占资源。**Entity Workflow 模式**：每个业务实体一个长生命周期 Workflow，Signals/Updates 驱动状态转换 = 每个流程实例一台持久化状态机。官方 AI 页把 Agent 场景列为首位："长时间运行、有状态的 agent 循环，等待人类介入，失败后从中断处恢复"；有 human-in-the-loop 可运行示例；与 LangGraph/OpenAI SDK/Claude SDK 集成。
- 【HITL】Workflow 阻塞等 Signal 捕获审批数据；等几天也无妨；交互 UI 全由应用层自建。
- 【映射】可借鉴：事件溯源式节点状态记录（节点开始/完成/等待/失败各为一条可回放事件）、Signal=人机协作持久化原语、Activity 边界=上下文隔离（LLM 调用放 Activity 可重试可恢复）。做不到：无可视化、无流程 DSL（对"AI 生成流程"需自建生成器）、门槛高。

### 4.8 Inngest agent-kit（agent-kit ~963★，Apache 2.0，年轻）

- 【核心机制】`step.run` 切步执行、每步输出写入 State store、断点续跑；`waitForEvent` 暂停等事件、`cancelOn` 表达式取消。agent-kit：`createAgent`（LLM+zod 工具+MCP）、`createNetwork`（多 agent 网络，共享 `network.state.kv` + 消息历史，自述 "conversation history with a fully typed state machine"）；路由两种：**代码路由**（函数读状态决定下一个 agent）+ **Supervisor 路由 agent**（`createRoutingAgent`）；`onRoute` 生命周期回调**保留人工控制点**。
- 【映射】可借鉴：typed state machine 状态载体、路由显式化可审计、onRoute = 流转层人工卡点。

### 4.9 XState + @statelyai/agent（~30.4k★，MIT，活跃）—— 状态机×AI 最直接的理论工具支撑

- 【核心机制】`createMachine` 是纯 JS 嵌套对象（JSON 风格），但 guards/actions 内联函数不可直接序列化——**AI 生成流程定义需把 guard/action 外置为具名实现，或接受"AI 只生成结构、宿主注入行为"**。Actor model：每个节点一个 actor = 节点上下文隔离的结构对应物；snapshot 持久化恢复；Stately Studio 可视化编辑状态机、**Stately AI 可用 AI 生成和修改机器**、提供 MCP 工具。
- 【@statelyai/agent 关键 API】哲学："**The machine decides which work is legal; the host executes model calls**"：
  - `decideNext`：让模型只输出该机器**实际接受的事件**——LLM 自由度被约束在合法转换集合内
  - `describeMachine`：把机器渲染为纯文本给模型看（精简的"注意力上下文"）
  - `getInteraction / eventFromInteraction`：渲染并校验**人类交互**，人通过标准 `send` 事件介入
  - `isAgentIdle`：区分"机器在等人"和"机器卡死"
  - `@statelyai/agent/log`：`replay / forkEventLog` 事件日志回放/分叉
- 【映射】可借鉴：decideNext+describeMachine 组合是"外部 Agent 动态构建/驱动 flow"最成熟的工程模式；getInteraction 把人的输入统一收敛为机器事件；层级/并行状态图可表达三形态（三形态建模为并行 region 或互斥子状态）；snapshot+事件日志支撑显式状态机。做不到：库不是平台，人机 UI/审批路由/运行面板都要自建。

---

## 五、组 C：子代理 / 上下文 / 人机协作协议类（详细）

### 5.1 Claude Code Subagents / Agent SDK / Agent Teams（Anthropic 官方）—— "AI 生成节点定义 + 上下文隔离"的现成实现

- 【核心机制】子代理定义 = **Markdown + YAML frontmatter**（`name / description / tools / disallowedTools / model / permissionMode / maxTurns / memory / hooks / isolation: worktree` + 正文系统提示词），`.claude/agents/` 目录热加载——**"AI 生成 agent 定义"的现成文件协议**。SDK 程序化形态：`query({ agents: Record<string, AgentDefinition> })`，流程定义可完全由 AI 产出 JSON。
- **Agent Teams（实验）**：lead + teammates 独立会话，通信走**文件信箱** `~/.claude/teams/{team}/inboxes/{agent}.json`（写成功即送达）；共享任务清单 `pending/in progress/completed/blocked`（依赖自动解锁）+ 文件锁防抢占。
- 【人的参与】审批范式但介入点丰富：后台子代理权限提示冒泡回主会话并标注来源；teammate 可被中断/查看/发消息/停止；hooks 约 30 种事件（PreToolUse 可 `allow/deny/ask/defer`、TaskCreated/TaskCompleted、TeammateIdle…），exit code 2 = 阻断 + stderr 回喂模型。**没有人作为节点执行者的形态。**
- 【上下文管理】教科书级：每个子代理**独立全新上下文窗口**，只拿系统提示词 + 委派消息 + CLAUDE.md 快照，**不继承对话历史和已读文件**；返回只有**摘要**；返回文本扫描转义防注入（防子代理输出伪造成系统提醒）。并行上限 20、嵌套深度 3。Anthropic 工程博客：多代理比聊天多耗 **~15× token**；"搜索即压缩"；委派提示四要素（目标、输出格式、工具边界）。
- 【映射】命中 ①（AI 生成定义）②粗粒度（task list 四态）④（委派消息即最小输入）。做不到：细粒度节点状态机、纯人节点。

### 5.2 claude-flow / Ruflo（~81.5k★，极活跃但营销过重）—— 反面教材 + 轻量持久化参考

- 【核心机制】Swarm（一次性编排，拓扑 hierarchical/mesh/adaptive）vs Hive-Mind（持久会话，Queen 主脑+共识）；`.hive-mind/memory.db`（SQLite）存会话/任务/claims；AgentDB（HNSW 向量记忆）。
- 【警示】README 自报 benchmark 不可信；issue #530 "Memory is not working at all"、#695 "Fragmented Hive Mind" 表明记忆/持久化层实际不稳定；已更名 Ruflo 并商业化。社区大量"装了它 Claude Code 变笨"反馈——臃肿的 hook/worker 体系增加上下文噪声。
- 【可借鉴】SQLite 存任务/会话的轻量布局；拓扑参数化作为 AI 生成 flow 的枚举项；**反面教训：过度营销 + 自报 benchmark 是选型红旗**。

### 5.3 HumanLayer + 12-Factor Agents（方法论 27.1k★）—— 方法论层最贴合你的项目

- 【核心机制】原为审批 SDK（`human_as_tool`，YC F24），已转型 Riptide（在自家机器跑编码代理、人从一个面板 steer 多个会话）。**方法论遗产 12-factor agents 是业界引用最多的 agent 工程方法论文档**：
  1 自然语言→工具调用；2 自有提示词；3 **自有上下文窗口**；4 工具即结构化输出；5 **统一执行状态与业务状态**；6 **简单 API 启动/暂停/恢复**；7 **用工具调用联系人类**；8 **自有控制流**；9 错误压缩回上下文；10 **小而聚焦的 agent**；11 从任意渠道触发；12 **agent 是无状态 reducer（状态=事件历史）**。
- 【Factor 7 代码】见第二节吸收清单 2.1。
- 【映射】Factor 5/6/8/12 拼起来就是你要的"显式状态机 + 可暂停恢复 + AI 也可写控制流"；Factor 7 是人机协作节点的协议模板；Factor 10 支持你的"每节点像 sub agent"。**但人仍是被召唤的 tool，没有"人拥有节点主动工作后交接"的形态。**

### 5.4 A2A 协议（~26.5k★，Linux 基金会）—— 节点状态机最权威的协议级蓝本

- 【核心机制】Task = 核心执行单元（`id/contextId/status/artifacts[]/history[]/metadata`）。**9 态生命周期**（含 `input-required`/`auth-required`）。Message（`role/parts[]（text/bytes/url/data）/referenceTaskIds`）；**Artifact**（`artifactId/name/description/parts[]`）= 节点输出产物一等公民。AgentCard = 能力发现。传输 JSON-RPC/gRPC/REST + SSE（TaskStatusUpdateEvent/TaskArtifactUpdateEvent）+ webhook。
- 官方对 MCP 分工："A2A connects the agents to each other; MCP connects each agent to its own tools. Use both together."
- 【映射】你的节点状态机几乎可直接用 Task 9 态做子集（加 `human-working` 表达纯人执行中）；Artifact = 最小输入载体（下游只拿 artifact+description 不拿上游全文）；`taskId + contextId` 双 ID 正好对应 run/node 两层状态。它不管单 agent 内部上下文和 UI。

### 5.5 MCP（9.7k★，事实标准，简要）

管"每个节点 agent 的工具接入"，不管节点间流程。对你可以用的是 **Elicitation**（server 向 user 请求输入）和 sampling——工具层的人机交互原语，可作纯 AI 节点内的小型确认点，替代不了节点级人机协作。

### 5.6 Letta / MemGPT（~25.4k★，活跃，API 迁移期）

- 【核心机制】Agent 状态 = system prompt + memory blocks + messages + tools，**全部持久化进数据库**（"淘汰不删除"，out-of-context messages 可检索）。**Memory blocks** 可编辑、可多 agent 共享挂载（shared blocks = 共享状态）。core/archival/recall 三层记忆 + sleep-time agents 后台整理。
- 【HITL】工具标记 `default_requires_approval`；暂停返回 `approval_request_message`；人 POST approval（approve true/false + reason）；**拒绝时 reason 变成 tool error 回喂模型**。
- 【映射】可借鉴：①驳回带 reason 回喂（人机节点"人驳回+说明"的最佳交互细节）；②shared memory block 作节点间"共享草稿板"（选题共识块/框架块可被多节点挂载——比消息传递更适合"共写文章"）；③一切状态入库淘汰不删除；④sleep-time compute：人思考时后台 agent 预整理下一节点输入摘要。

### 5.7 OpenHands（~93.2k★，极活跃）—— 事件溯源工程最强实现

- 【核心机制】事件是不可变 Pydantic 模型 append-only log，兼作记忆与集成点；事件带 `source: user|agent|environment`。事件类型：MessageEvent/ActionEvent（含 thought/security risk）/ObservationEvent/**UserRejectObservation**/PauseEvent/压缩族（CondensationRequest → 记录 forgotten_event_ids+summary → CondensationSummaryEvent）。agent 状态 = 事件历史确定性重放。Docker 沙箱 per conversation。
- 【人的参与】confirmation mode：agent 产出 Action 后暂停等人确认；拒绝产生 UserRejectObservation 回喂模型可改道。
- 【映射】**把"人节点的开始/产出/驳回"也设计成事件类型（source=user），状态机=事件日志投影**；Condensation 三件套用于节点结束后上游上下文清理；source 三方归因映射你的三形态。

### 5.8 GPT-Pilot（~33.6k★，**已弃维 + 2025-08~2026-06 供应链投毒事件，只读不部署**）

- 【核心机制/理念】"AI 写 95% 代码，剩下 5% 需要开发者"→ 一步步写、一步步确认。Agent 层级流水线：Spec Writer（澄清需求）→ Architect → Tech Lead（拆任务）→ Developer（任务→人可读步骤）→ Code Monkey → Reviewer（不合格打回）+ Debugger/**Troubleshooter（帮人把模糊不满转成结构化反馈）**。
- 【教训】任务粒度是显式设计考量（太宽→bug 多，太窄→跑不动）；**确认步太碎 = 用户流失**——反证你的人必须落在高杠杆节点，不是全程点头。
- 【映射】角色流水线 = 你公众号例子的代码领域同构；Troubleshooter 模式 = "改稿意见结构化节点"。

### 5.9 人机范式综述：你的空白点在哪

- **mixed-initiative（混合主动交互）**：Horvitz《Principles of Mixed-Initiative User Interfaces》（CHI'99，引用 2500+）：人与 AI 双方都可主动发起行动；系统用决策理论权衡"行动价值 vs 打断成本"；原则包括不抢占注意力、行动可见可逆、支持表达不满并学习。**"人主动"与"AI 主动"都应是一等公民——你的三形态本质是 mixed-initiative 的工程化。**
- **三种业界范式**：human-in-the-loop（人审批每步）/ human-on-the-loop（AI 自主人监督可打断）/ human-as-tool（AI 把人当资源调用）。**现有开源框架全部停在 HITL 或 human-as-tool。**
- **Anthropic 官方口径**（《Building Effective Agents》）：六模式（prompt chaining/routing/parallelization/**orchestrator-workers**/evaluator-optimizer/agents），强调简单可组合、反对框架黑盒；人介入 = "pause for human feedback at checkpoints"——**checkpoint 思维：人在关键点深度介入，而非每步点头**。
- **结论性观察**：业界没有任何主流框架有 "human-as-executor"（人作为节点的主执行者，产出交回状态机）这个第四形态——**这正是你设想的空白点和差异化所在，且可行性已被各积木分别验证。**

### 5.10 AI 人机共编文档 / 共改产出物

- **AFFiNE**（~74.5k★，MIT，活跃）：doc+白板+数据库三合一，CRDT 协同引擎（BlockSuite/y-octo，Rust），AFFiNE AI 提供 co-writing。**最接近"人与 AI 共改同一产出物"的成熟开源底座**，但 AI 是副驾不是流程节点。
- **BlockNote AI**（`@blocknote/xl-ai`）：React 块编辑器 AI 扩展——**AI 建议以块级 diff 呈现、用户接受/拒绝、支持多步 HITL 工作流**，模型无关（Vercel AI SDK 之上）。**最适合做你"写作节点"的嵌入组件**；注意 xl 包 copyleft + 商用需付费许可。
- 研究侧：CoEdIT（Grammarly/UMN）AI 文本编辑；pnucolab/colab-tools 把人机每次交互生成可审计报告（对节点审计有用）。

---

## 六、最终结论

1. **没有单一项目 = 你的设想。** 四种残缺拼图的组合才是完整答案，而你已有的实现恰好覆盖了最难拼的几块（账本、隔离、固定输入、协调宿主）。
2. **协议、框架、范式三个层面都有可直接组合的积木**（见第二节吸收清单）：
   - 状态机：A2A Task 9 态为骨架 + `human-working` 扩展态；OpenHands source 三方归因标注执行形态；12-Factor Factor 7 事件对承载人机协作。
   - 隔离与压缩：Claude subagents 三件套 + OpenHands Condensation。
   - AI 生成 flow：FastGPT 三步交互 + subagents frontmatter DSL + A2A AgentCard 能力菜单。
   - 持久化：你的命令账本已是事件溯源变体，补 FlowRun 聚合即可对齐 Temporal Entity Workflow。
   - **最重要的组 A 结论**：没有一个编排框架原生支持"外部 Agent 动态构建 flow"（拓扑要么编译自代码，要么模型隐式驱动）——最接近的是 MetaGPT 团队的 AFlow 研究（ICLR 2025 oral，未产品化）。**给你的战略建议：在你的 LangGraph harness 上定义一个可序列化的 flow 定义 schema（节点三形态 + 各自最小输入 schema + interrupt 决策集），让外部 Agent 产出该 JSON，harness 编译成 StateGraph 执行——把现有底座变成"flow 解释器"。这一层全网没有现成品，是你最能建立壁垒的位置。**
3. **你的独有空白 = human-as-executor（纯人节点）**：全网开源方案无此形态。最接近的是 LangGraph interrupt（人接管节点返回值）+ deepagents respond 决策（人的话直接作为工具结果）的组合，但两者都仍把人当"AI 流程的被调用方"，没有人拥有节点的执行主权。配合 mixed-initiative 理论与 AFFiNE/BlockNote 的产物共编组件，这条路没有现成竞品。**建议把它做成可对外讲的差异化主张。**
4. **风险提示（选型避坑）**：claude-flow 记忆层不稳且营销水分大；GPT-Pilot 已弃维且曾遭供应链投毒（勿部署）；Letta 处于 API 大迁移期；HumanLayer 主体已转型；Flowise 已归档；**microsoft/autogen 已官方归档（生态撕裂，避选）**；**MetaGPT 开源停滞（仅作思想参考）**；OpenAI Agents SDK 的 HITL 只有 approve/reject（比 deepagents 少 edit/respond）。Dify 的 Human Input 节点仍在打磨期（2026-01 曾回滚）——说明"人机协作节点"即使头部产品也在摸索，你并不算晚。
