# Agent Flow 可行性与差距分析报告

> 评估对象：Canvas Studio（`D:\Program Files (x86)\canvas-studio\source`，git main @ db91832，2026-11-12）
> 评估基准：你口述的 Agent Flow 设想（外部 Agent 构建 flow → 主 Agent 流转 → 状态机记录节点状态 → 三种节点执行形态 → 最小且必要输入 → 输出落盘 → 推动任务完成）
> 报告日期：2026-11-12
> 配套文档：《开源项目深度调研报告》（agent-flow-opensource-research-20261112.md）

---

## 一、先把你的设想翻译成可检验的命题

你的口述可以归纳为 **5 个核心命题**：

| 命题 | 内容 | 对应的业界概念 |
|---|---|---|
| P1 构建方 | 外部 Agent 作为构建方，动态构建 agent flow（流程定义可由 AI 生成） | flow-as-data、AI 生成流程 DSL |
| P2 流转方 | 主 Agent 负责流程扭转 + 显式状态机记录每个节点状态 | orchestrator + durable state machine |
| P3 三形态 | 每个节点 = 纯 AI / 人机协作 / 纯人 三种执行形态之一 | human-in-the-loop / human-as-tool / **human-as-executor** |
| P4 最小输入 | 每个环节保证"最小且必要输入"，输出被记录、可回溯 | context isolation、artifact passing |
| P5 目标 | 人充分发挥主观能动性 + 上下文不爆炸、单模型注意力集中 | mixed-initiative、sub-agent 隔离 |

你的公众号文章例子（选题聊天 → 资料搜索专家 → 框架专家 → 写作专家，每步开新会话、手动传最小输入）本质上就是：**把人肉多会话工作流产品化，人肉流程中"复制粘贴最小输入"这个动作，由状态机 + 固定输入清单自动完成**。

**一个重要的业界对照结论（来自调研，详见配套报告）**：业界现有范式只有三种——human-in-the-loop（人审批每步）、human-on-the-loop（人监督可打断）、human-as-tool（AI 把人当工具调用）。**没有任何主流开源框架实现"human-as-executor"（人作为一个节点的主执行者，拥有节点、深度工作、产出 artifact 后交回状态机）**。你设想中的"纯人节点"是业界空白，这是你的差异化所在，也侧面说明这条路没有现成竞品可以直接抄。

---

## 二、项目现状盘点：它已经不是方案稿，而是一个跑通了全链路的系统

### 2.1 它现在是什么

Canvas Studio = **本地单用户的"无限画布 AI 创作平台" + 画布原生 Agent Flow 运行时**，Electron 桌面产品。关键事实：

- 技术栈：Electron + electron-vite + React + tldraw（画布）+ better-sqlite3（存储）+ **LangGraph JS（`@langchain/langgraph`）+ Vercel AI SDK** + zod 全量契约校验（`source/package.json`、`source/src/main/agent-flow/runtime.ts:1-8`）
- **32 种可创建节点**，其中 Agent 系节点 3 种：`agent` / `state-machine` / `ai-review`（`source/src/shared/types/index.ts:11-43`）
- **三入口一致性**：GUI / CLI / MCP 共享同一业务实现，~130 个 agent-access 操作，铁律见 `source/AGENT_PARITY_SPEC.md`（"不允许任何『人能做、Agent 不能做』的缺口"）
- **验收状态**：2026-10-26 独立 worktree（`agent-flow-test-fdea986`）全量复验：207 文件 / 2575 单测通过、22 项浏览器门禁、状态机/Skill/媒体/主链路/协调/建图/审核/返工/恢复全部退出码 0，**零功能缺陷**（`source/docs/AGENT_FLOW_TEST_REPORT_2026_10_26.md`）
- 代码审查（2026-10-25）：无 P0，4 个 P1、14 个 P2（`agent-code-review-report-20261025.md`）

### 2.2 两份方案文档的关系（你自己可能都容易混淆）

- 顶层 `Agent-Flow-方案包-v1.0\`（2026-09-26）是**早期设计稿**，自己声明"待实施……未修改应用逻辑"。里面的 TaskDefinition/FlowRun/HumanTask 表设计**多数未按原样落地**。
- 真正被确认并实施的是 `source/docs/canvas-agent-flow/00-approved-plan.md`（2026-10-12 你确认，C0–C4 授权开发）。实施路径是**画布原生 Agent Flow**：画布语义图本身就是唯一可编辑的流程定义（`source/AGENTS.md:93-109`）。

**结论：不要按方案包 v1.0 评估项目，它已被 approved-plan 取代。**

### 2.3 已有的五个架构亮点（这些是别人没有的）

1. **一份业务契约，三个入口**：`src/shared/agent-access/registry.ts` 同时是 CLI 命令目录、MCP 工具描述、JSON Schema、契约快照的唯一来源，配 `guard:agent-parity` 机器门禁。"外部 Agent 作为构建方"（P1）最现实的通道就是它——外部 Agent 已经能做约 130 种操作。
2. **幂等命令账本 + unknown ≠ failed**：pending/prepared/committed/unknown 回执、语义修订 CAS、崩溃转 unknown 强制核对不重放（`source/src/main/agent-flow/command-ledger.ts`）。审查报告评价"unknown 语义与恢复设计达到可审计水准"。
3. **固定资产 + 固定输入清单**：所有交接以不可变版本（sha256 寻址）进行，审核放行绑定精确版本集合；`FixedNodeInputSchema`（targetPortId + asset 引用列表，`commands.ts:12-47`）、输入清单一次执行内冻结。**这正是你 P4"最小且必要输入"的落地形态，而且是全项目最强的部分。**
4. **组合节点（composite）= 可复用子流程**：内部图 ≤200 节点、草稿→发布不可变版本→实例钉版本，`composite_run_waits`（kind='input'|'human'）已支持**运行中人工补输入**——这几乎就是你的 P3/P4 在子流程层的落地。
5. **测试纪律罕见**：`npm run verify` 串 30+ 条桌面双进程验收路径，日志脱敏逐事件断言。

---

## 三、逐条差距对照表（你的 8 点设想 vs 代码现实）

| # | 你的设想 | 状态 | 证据与说明 |
|---|---|---|---|
| 1 | 外部 Agent 构建流程 | 🟡 部分具备（**受限构建器**） | ①"上帝 Agent"建图：能力目录仅 6 项（text-template/image-gen/image-edit/video/speech/tts），拓扑仅 sequential / parallel-fork、**1–4 步**（`builder.ts:4-59`）；②外部 Agent 通用路径：graph.patch 等 ~130 个操作开放，但缺"AI 提案→静态校验→影响预览→用户确认"的完整端到端管线 |
| 2 | 主 Agent 负责流转 | 🟢 已具备（生产级） | Agent 节点 role=coordinator（`node-contracts.ts:37`）；协调决策协议 dispatch/dispatch-many/finish/wait（`coordination.ts:6-39`）；协调宿主 `coordinator-host.ts`（39KB，含 263 行恢复逻辑），并行分波 FIFO、4 路上限 |
| 3 | 状态机记录节点状态 | 🟡 有实现但**缺自动闭环** | ①任务级状态机：`flow_agent_tasks` 表，ready/running/waiting/blocked/completed/failed/cancelled + waitKind=human/reconcile（`task-store.ts:19`）；②声明式状态机节点：states/transitions 严格校验、revision CAS、事件去重（`executors/agentFlow.ts:139-346`）。**局限：状态机节点的事件首版仅限人工提交**，模型/上游完成不会自动推进它（agentFlow.ts:139-147 注释明言） |
| 4 | 三种执行形态 | 🟡 大部分具备，**未统一声明** | 纯 AI：interactionMode=autonomous；人机协作：collaborative + discuss/revise/submit（`AgentCollaborationPanel.tsx:61-100`）；纯人：既有 text/file/image 节点人工填写/上传/编辑提交。**差距：没有统一的 Participation 字段声明在每个任务上**，三种形态分散在不同节点类型的配置里，用户感知不到"这个节点是人还是 AI 干" |
| 5 | 最小且必要输入 + 输出落盘可回溯 | 🟢 已具备（生产级，全项目最强） | 固定输入清单冻结、不可变资产版本（contentHash/来源/父版本/输入版本引用）、输出 refs 枚举防伪造（`runtime-model.ts:33-45`）、审核只对完全一致的版本集合有效（`node-contracts.ts:177-203`） |
| 6 | 节点完成触发状态机更新 | 🟡 缺最后一公里 | 任务完成→命令账本回执→固定资产登记→下游准入由 ledger 推动已通；但**声明式状态机节点不自动消费节点完成事件**；FlowRun 级聚合状态（方案包设想的 created/running/waiting/paused…）没有独立权威实体 |
| 7 | 节点如 sub agent、上下文隔离 | 🟢 已具备（生产级） | 每任务独立 snapshot/session/预算；"专业 Agent 不读取全图或其他会话；主 Agent 只协调授权范围"（approved-plan.md:45）；模型决策输入只含 goal/mode/targets/directInputs/skills/loaded/receipts（`runtime.ts:25-41`）；上下文超限硬约束（262KB 技能上限、12 步决策/20 工具/10 分钟预算） |
| 8 | Skill 规范 + 现成框架做 harness | 🟢 已具备 | SkillPackageSchema + SQLite `flow_skill_versions` 内容寻址不可变版本（`skill-store.ts:70-90`）；SKILL.md frontmatter 解析 + 目录包（≤16 个 .md、128KiB 限、防路径穿越）；harness 就是 LangGraph JS StateGraph/interrupt/Command + SQLite checkpointer——正是你说的"现成 Agent 框架" |

**汇总：8 点中 2、5、7、8 达到生产级实现；4 大部分实现；1、3、6 有真实实现但闭环缺最后一环。**

---

## 四、最关键的缺口（按重要性排序，附难度评估）

### 缺口 1：状态机与节点完成的自动闭环 ⭐ 最重要，难度：中低

状态机节点首版只接受人工提交事件（`executors/agentFlow.ts:139-147`）。"节点完成 → 状态机自动迁移 → 释放下游"这最后一公里没有接线。

**修法方向**：把**命令账本回执 / 资产版本登记**这类可信事实作为合法事件源接入状态机执行器——注意要守住"模型文字不能赋成功"的铁律（只认账本回执，不认模型自述）。

### 缺口 2：外部 Agent 动态构建流程受限 ⭐ 你设想的核心卖点，难度：中高

上帝 Agent 建图能力目录封闭（6 项）、拓扑仅两种、≤4 步、无条件/循环/子流程。通用图编辑虽开放，但缺"AI 提案 → 静态校验 → 影响预览 → 用户确认"完整管线（方案包 02 文档 §10 的第三期设计未实施）。

**修法方向**：扩充 BuildPlan 能力目录 + 拓扑（条件/循环/子流程）、给"AI 生成 flow"加静态校验器（类型/端口/环检测）+ 差异预览 UI。FastGPT 的"方案图→校验→应用画布"三步法和 n8n 的 workflow JSON 是现成参考。**战略级建议（来自组 A 调研）：全网没有编排框架原生支持"外部 Agent 动态构建 flow"——LangGraph 的拓扑必须代码编译，Send 只能动态分支数量不能动态发明节点。你的机会是在现有 LangGraph harness 上定义一个可序列化的 flow 定义 schema（节点三形态 + 各自最小输入 schema + interrupt 决策集），让外部 Agent 产出该 JSON，harness 编译成 StateGraph 执行——把底座变成"flow 解释器"，这是全网空白的壁垒位置。**

### 缺口 3：FlowDefinition / FlowRun 一等抽象不存在，难度：中

流程 = 画布图本身，运行态分散在 `flow_agent_tasks` / `flow_coordination_scope` / `composite_runs` 三处，没有 `flow_runs` / `task_runs` / `flow_events` 全套表。"一次流程运行"的暂停/恢复/聚合状态总览是投影而非权威实体。

**修法方向**：不一定照搬方案包的表设计——但至少要有一个 `flow_run` 聚合视图 + 事件日志（参考 OpenHands 的事件溯源 / Temporal 的 Event History 思想，见配套报告）。

### 缺口 4：纯人任务未形式化 ⭐ 你的差异化卖点，难度：中

没有 HumanTask 待办队列/任务卡；纯人工参与依赖用户自己操作普通节点，没有"待你处理 N 项"的统一入口。人机协作面板已经很深（讨论/改目标/选输入输出版本），但它挂在 Agent 节点上，不是通用任务待办。

**修法方向**：给节点加统一 `Participation`（autonomous / collaborative / human）声明 + HumanTask 队列（"待你处理"收件箱）。参考 A2A 的 `input-required` 状态、HumanLayer 的 `human_input_requested → response_from_human` 事件对、Dify 的"预填编辑产出物"交互。

### 缺口 5：工程尾边，难度：低但要排期

- 4 个 P1 待复核：同步 IO 热路径（`projects.repo.ts:131-154` 每步全图哈希）、恢复监听只挂首窗口（`flow-commands.ipc.ts:98-100`）等
- R09 物理掉电/真实磁盘耐久、R11 真实供应商付费链路明确未做（38-agent-completion-plan.md）

---

## 五、可行性判断：能不能做？难度高不高？

### 5.1 总判断：**能做，而且你已经做完了最难的部分**

你的设想不是空中楼阁——它由业界已验证的积木组成（详见配套报告）：

| 你的命题 | 业界验证 | 结论 |
|---|---|---|
| P1 AI 生成流程定义 | FastGPT 辅助生成（方案图→校验→应用）、Claude Code subagents（AI 可写 frontmatter 定义）、XState（AI 生成状态机） | 已验证 |
| P2 状态机记录节点状态 | LangGraph checkpointer（你在用）、A2A Task 9 态、Temporal Event History、XState snapshot | 已验证 |
| P3 三形态执行 | 纯 AI / 人机协作（Dify 预填编辑最接近）/ 纯人 = **业界空白，你的机会** | 2/3 已验证 |
| P4 最小必要输入 | Coze Studio InputSources 逐字段映射、Claude Code 委派消息即最小输入、你的固定输入清单已经做到 | 已验证 |
| P5 注意力集中 | Claude Code subagent"独立窗口+仅返回摘要"被 Anthropic 官方博客验证有效；你的 per-task snapshot/session 已做到 | 已验证 |

### 5.2 剩余工作的难度分级

- **缺口 1（状态机自动闭环）**：改动集中在一个执行器 + 事件源接入，涉及账本语义，中低难度，~1-2 周量级。
- **缺口 3（FlowRun 一等实体）**：数据建模 + 三处运行态归一投影，中难度，~2-3 周量级。
- **缺口 4（纯人任务形式化）**：Participation 声明 + HumanTask 队列 + 收件箱 UI，中难度，~2-3 周量级。
- **缺口 2（开放流程构建管线）**：能力目录扩充、拓扑扩展（条件/循环）、静态校验器、预览确认 UI，中高难度，~4-6 周量级。可以后做，因为通用图编辑已可用。

**没有一项是"研究级难题"，都是工程整合工作。** 这也解释了为什么验收能跑通——基础运行时（账本、隔离、Skill、协调宿主）是整个系统里最难的 70%，你已经完成。

### 5.3 你的想法现实吗？有没有被验证过？

现实。三个层面的证据：

1. **产品层**：LangGraph（你在用）的 interrupt/Command 就是为"人介入状态机"设计的；Dify 2025 年的 Human Input 节点把"人编辑 AI 产出物"做成了一等公民；Coze Studio 的 InterruptEvent/ResumeRequest 与你的账本+等待设计同构。
2. **工程方法论层**：HumanLayer《12-Factor Agents》（27k stars）的 Factor 5/6/7/10/12 与你的设计几乎一一对应（统一执行状态与业务状态 / 简单 API 暂停恢复 / 用工具调用联系人类 / 小而聚焦的 agent / agent 是无状态 reducer）。
3. **理论层**：mixed-initiative interaction（Horvitz, CHI'99）支持"人主动与 AI 主动都是一等公民"——你的"纯人节点"正是这个理论的工程化，且业界没人做。

### 5.4 真正的风险（不是技术，是产品）

1. **验证缺失本身是最大风险**：你说了"没有做一些验证"。全链路验收跑通 ≠ 真实垂类任务好用。**建议立刻做一个真实公众号文章端到端 demo**（选题→搜索→框架→写作→配图→审核→发布），用你自己当用户跑 3-5 篇，记录：哪里想介入但介入不了、哪里输入不够"最小"、哪里状态机没推进。
2. **人的参与深度 ≠ 参与频率**：GPT-Pilot 的教训（每步都要人确认 → 用户流失，且项目已死）反证：人的介入必须落在**高杠杆节点**（选题、框架、终审），而不是每步点头。你的设计里要把"哪些节点该人做"交给 flow 构建方声明，而不是全默认人机协作。
3. **AI 生成 flow 的质量风险**：放开能力目录和拓扑后，AI 生成的流程可能产生类型不匹配/死循环。必须配套静态校验（端口类型、环检测、Participation 合法性），参考 FastGPT"生成→校验→应用"三步。
4. **单一用户本地产品的天花板**：当前是本地单用户，若未来要协作/云端，账本和 SQLite 层需要迁移设计（现在不用管，但别把 SQL 方言写死）。

---

## 六、结论与建议路线

### 一句话结论

**你的设想完全现实、且你的项目已经完成了约 70%（恰好是最难的基础运行时 70%）。剩下 30% 是四件明确的工程整合工作：状态机自动闭环、FlowRun 一等实体、纯人任务形式化、开放流程构建管线。其中"纯人节点（human-as-executor）"是全网开源方案都没有的空白点——这是你的差异化，也是你最应该先验证的卖点。**

### 建议路线（按优先级）

| 阶段 | 内容 | 产出 |
|---|---|---|
| **第 0 步：验证**（立即，1-2 周） | 用现有系统手工搭一个"公众号文章 flow"（chat 选题 → agent 搜索 → collaborative 框架 → agent 写作 → ai-review → 纯人终审），你自己当用户跑 3-5 篇真实文章 | 缺陷清单 + 参与度体验记录，直接决定缺口 1/4 的优先级 |
| **第 1 步：补闭环**（1-2 周） | 把账本回执接入声明式状态机节点的事件源；给节点统一 Participation 声明 | 节点完成自动推进状态机；"谁在干活"一目了然 |
| **第 2 步：人工待办**（2-3 周） | HumanTask 队列 + "待你处理"收件箱；人驳回带 reason 回喂（参考 Letta） | 纯人节点成为一等公民，人的参与有统一入口 |
| **第 3 步：FlowRun 实体**（2-3 周） | flow_run 聚合视图 + 事件日志（source: user/agent/environment 三方归因，参考 OpenHands） | 一次流程运行可暂停/恢复/总览/回放 |
| **第 4 步：开放构建**（4-6 周） | 扩 BuildPlan 能力目录与拓扑、静态校验器、AI 提案→预览→确认管线 | 外部 Agent 真正"构建方"化，覆盖任意垂类 |

### 吸收开源优点的对应关系（详见配套报告）

- 状态机协议骨架 → **A2A Task 9 态**（input-required）+ 扩展 human-working 态
- 人机协作事件对 → **HumanLayer 12-Factor Factor 7** 的 `human_input_requested / response_from_human`
- 人机协作决策集 → **deepagents allowed_decisions（approve/edit/reject/respond + when 谓词）**——可直接落在你现有的 LangGraph harness 上，是 interrupt 之上的"标准答案"
- 纯人节点接管 → **LangGraph interrupt(response_schema)**：人的产出作为 interrupt() 返回值，节点从函数头重跑（注意副作用幂等）；这就是"纯人节点"的原生实现路径，不用引外部框架
- 事件溯源与三方归因 → **OpenHands SDK** 的 source: user|agent|environment
- AI 生成流程的三步交互 → **FastGPT 辅助生成**（方案图→校验→应用画布）
- 最小输入的字段级映射 → **Coze Studio InputSources**
- 人编辑产出物的交互 → **Dify Human Input**（变量预填 + 多按钮分支 + 超时分支）
- 驳回带 reason 回喂 → **Letta approval**
- 上下文精简喂给模型 → **XState @statelyai/agent 的 describeMachine**
- LangGraph JS 工程细节（自查清单）→ **UntrackedValue** 防大产物撑爆 SQLite checkpointer；**recursionLimit 默认仅 25**（JS）长流程需显式调高；`get_state_history()` 可直接画"节点状态时间线"
