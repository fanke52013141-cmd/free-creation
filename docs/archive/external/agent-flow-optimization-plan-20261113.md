# Agent Flow 优化方案（2026-11-13，基于源码核实 + 开源调研）

> 目的：回答"我们这套 agent flow 还有什么不完整、怎么优化、优化目的是什么、能不能保证你想要的效果"。
> 方法：本方案的每条"现状"都尽量落到源码证据（file:line），不空谈。配套《开源调研报告 20261113》《可行性分析 20261112》。
> 性质：**这是方案，不是代码改动**。按你的惯例，先列方案与决策点，你拍板后再动代码。
> 工程约束（来自 source/AGENTS.md，必须遵守）：① GUI/CLI/MCP 三入口铁律（同一次提交改完 + `npm run guard:agent-parity`）② 日志是交付的一部分（LOGGING_SPEC/LOGGING_COVERAGE）③ 节点强制协议（NODE_CONTRACT_SPEC）④ 画布语义图是唯一可编辑流程定义 ⑤ 执行事实来自真实运行记录，模型/聊天文字不能直接赋成功 ⑥ 专业 Agent 不读全图、主 Agent 只协调授权范围。

---

## 〇、先回答你最关心的："能不能保证我想要的效果？"

**必须分三类诚实回答，不能打包票：**

| 你想要的效果 | 能不能保证 | 凭什么 / 为什么 |
|---|---|---|
| **工程完整性**（4 个缺口补齐、三入口一致、可恢复可审计） | **能保证** | 可用定向行为测试 + `npm run verify` + 画布用户路径验收证明。这是确定性工程，做完即成立。 |
| **机制上对抗上下文爆炸**（最小输入 + 隔离 + 摘要回传） | **能保证机制成立** | 有 Chroma/Anthropic/Manus 证据支撑（见调研报告第二节）；机制是否正确实现可用测试验证。 |
| **每个垂类任务的实际产出质量 / 你的审美满意度** | **不能先验保证** | 质量 = 模型能力 × 上下文质量 × 人把关。工程只能保证"人能在高杠杆节点介入、上下文不被污染"，**不能保证每篇产出都达到你的审美**。这必须用真实任务实测（你自己跑 3–5 篇），不是纸面能承诺的。 |
| **"人的主观能动性深度参与"好不好用** | **机制能实现，体验需验证** | 纯人节点 + 收件箱 + 决策集能把"人深度参与"做成一等公民；但"参与感顺不顺"必须真实任务验证。GPT-Pilot 的教训：参与太碎反而流失。 |

**一句话**：我能保证"把缺的补齐、把机制做对、把质量地基打牢"，并给你可验收的证据；我**不能**保证"产品一定好用、产出一定符合你审美"——那一部分只能靠真实任务验证，谁先验承诺谁就是在骗你。下面每条优化都标注它服务于哪个效果、保证到什么程度、怎么验收。

---

## 一、现状盘点：已干 vs 未干（源码核实）

### 1.1 已经做得很扎实的（不要重复造，要在其上补）

| 能力 | 源码证据 | 评价 |
|---|---|---|
| **命令账本 + unknown≠failed** | `command-ledger.ts`：state=pending/committed/unknown/skipped，receipt_json，owner_session 租约，崩溃转 `FLOW_RESULT_UNCONFIRMED`（unknown）强制核对不重放 | 生产级，是全项目最强部分之一。事件溯源的变体已就位。 |
| **状态机语义骨架** | `executors/agentFlow.ts:225-346`：单一权威实例 meta.stateMachine、revision CAS、lastEventId 去重、history(≤200)、配置漂移显式失败、out-state 投影 flow.state@1 | 语义正确且严谨。**缺的不是骨架，是事件源**（见缺口①）。 |
| **固定输入清单 + 不可变资产版本** | `commands.ts` FixedNodeInputSchema；资产 sha256 寻址、父版本/输入版本引用 | 命题④"最小必要输入"已落地，全项目最强。 |
| **上下文隔离** | per-task snapshot/session/预算；专业 Agent 不读全图（approved-plan §4）；决策输入只含 goal/mode/targets/directInputs/skills/loaded/receipts（runtime.ts） | 命题⑤已落地。 |
| **建图预览管线** | `builder-host.ts:207-244`：propose/inspect/confirm/discard，semanticRevision CAS，占用检查，"以保存的图证明 commit" | **"AI 提案→预览→确认"骨架已存在**（比可行性报告说的更完整）。缺的是表达力与校验（见缺口②）。 |
| **建图已自动生成状态机节点** | `builder-host.ts:406-437`：生成 idle/active/waiting/completed + agent.completed/review.passed/human.wait 等转换 | 声明已生成，但运行时不会自动喂事件（见缺口①的根因）。 |
| **显式关系 + 审核 gate + 有界返工** | `node-contracts.ts:28` relations=controls/observes/review-gate/rework；`:95-96` maxReworks 0-10、rejectPolicy rework/stop | 控制/状态关系与数据 DAG 分离，审核返工有界。 |
| **确定性执行模式（新发现）** | `node-contracts.ts:50-52` AF-01 `executionMode:'model'\|'fixed-order'` + stages | fixed-order=按声明阶段确定性推进、主控不调模型补写目标。**这是朝"确定性 flow"已迈出的一步，优化要复用它。** |

### 1.2 未干 / 不完整的（按严重度，本方案要解决的）

| # | 不完整点 | 源码证据 | 影响的期望效果 |
|---|---|---|---|
| **G1** | **状态机只接受人工事件，节点完成不会自动推进它** | `executors/agentFlow.ts:139-147` 注释明言"事件来源首版仅限人工提交"；executor 只消费 `meta.stateMachinePending` | ②主 Agent 流转 + 状态机自动闭环 |
| **G2** | **建图生成的状态机是"哑巴"**：声明了 agent.completed 等转换，但没有任何可信事件源自动喂它 | `builder-host.ts:406-437` 生成转换 vs G1 无自动事件源 | ②（生成的 flow 状态机需人手动逐个提交事件才动） |
| **G3** | **参与方式只有两态，纯人节点未形式化** | `node-contracts.ts:39` interactionMode 仅 collaborative/autonomous；纯人靠普通 text/file/image 节点手动操作，无统一 Participation、无 HumanTask 收件箱 | ③三形态、⑤人的主观能动性 |
| **G4** | **FlowRun 无权威实体、无事件日志表** | `db-migrations.ts` 只有 flow_agent_tasks/flow_coordination_scope/flow_builds/composite_runs/flow_commands，**无 flow_runs/flow_events**；运行态分散三处 | ②可暂停/恢复/总览/回放 |
| **G5** | **建图表达力封闭 + 校验不足** | `builder-host.ts:30-99` 能力目录仅 6 项；`:301` 拓扑仅 sequential/parallel-fork；`:264-271` 源必须是单个 text 节点 v3；无 condition/loop/subflow；BuildPlanSchema 仅 zod，缺端口类型/环/Participation 静态校验 | ①外部 Agent 构建任意垂类 flow |
| **G6** | **质量护城河缺最后几道闸** | 节点输出入状态机前无摘要压缩/防注入扫描；进下一节点入口无显式 history 裁剪；大产物可能进 SQLite checkpoint；JS recursionLimit 默认 25 | ④⑤最小输入 + 注意力集中 |
| **G7** | **人机协作交互不够深** | 协作面板有 discuss/revise/submit，但缺标准决策集（approve/edit/reject/respond）、预填编辑产出物、超时分支、驳回 reason 结构化回喂、人中断保留半成品 | ③⑤人深度参与 |

> 说明：G1/G2/G3/G5/G6/G7 我已直接读源码核实；G4 的表结构已核实，"运行态分散三处"沿用可行性报告（待动代码前再复核 task-store/coordinator-host）。

---

## 二、优化方案（逐项：改什么 / 怎么改 / 目的 / 服务哪个效果 / 能否保证 + 验收 / 约束）

> 优先级：P0=立刻吃（地基/同栈/低风险）、P1=补闭环（核心卖点）、P2=建壁垒（表达力）。每项都遵守三入口铁律 + 日志覆盖 + 节点协议。

### O1【P1】状态机自动闭环：把"可信事实"接成事件源（解决 G1+G2）

- **改什么**：给 `stateMachineExecutor` 增加**可信事件源**，让"节点完成/审核通过/人工等待"自动产生状态机事件，而不是只能人手提交。
- **怎么改**（借鉴 Coze InterruptEvent + A2A Task 态 + OpenHands 事件溯源）：
  1. 定义可信事件源 = **命令账本回执（committed）+ 资产版本登记 + 审核结论（review.decision@1）**。绝不接受模型自述/聊天文字（守住 approved-plan §3 铁律）。
  2. 在 coordinator-host 的"节点完成→账本回执"路径上，发射结构化事件 `{event, sourceNodeId, nodePath, taskId, expectedRevision, eventId}`（结构照 Coze InterruptEvent，带节点路径、可嵌套、唯一恢复 ID）。
  3. 状态机执行器消费这些事件（与人工事件同一通道、同一 revision CAS / 去重语义），自动迁移并释放下游 review-gate。
  4. 扩展状态：对齐 A2A，增加 `input-required`（等人输入）与 `human-working`（纯人执行中）两个自定义态（A2A extensions 机制）。
  5. 建图生成的状态机（builder-host.ts:406-437）从此被自动驱动，不再是哑巴。
- **目的**：实现你要的"节点提交→主 Agent 知道完成→改状态机→流转到下一节点"的自动闭环。
- **服务效果**：②主 Agent 流转 + 状态机。**能保证**（确定性工程）。
- **验收**：定向测试"专业节点真实完成→账本 committed→状态机自动 active→completed→下游 gate 释放"；"模型自述完成但无账本回执→状态机不动"；崩溃恢复后 unknown 不重放。`npm run verify` + 画布路径。
- **约束**：事件源只认账本/资产/审核三类可信事实；日志补"状态迁移"开始/终态/关联（沿用 executor 已有 trace，不重复记终态）；三入口同步（GUI 提交事件 / CLI / MCP 同一契约）。
- **风险**：中低。改动集中在一个执行器 + 事件源接入，账本语义已成熟。

### O2【P1】三形态 Participation 统一 + 纯人节点形式化 + HumanTask 收件箱（解决 G3）

- **改什么**：把"两态 interactionMode"升级为**统一 Participation 声明**，并把"纯人节点"做成一等公民。
- **怎么改**（借鉴 HumanLayer Factor7 + deepagents decisions + A2A input-required + Dify Human Input）：
  1. 节点契约增加统一 `participation: 'autonomous' | 'collaborative' | 'human'`（保留 interactionMode 兼容，逐步迁移；**这是契约变更，须三入口同包 + 刷新契约快照 + change-impact.json**）。
  2. **纯人节点形式化**：定义 HumanTask（待办队列 + 任务卡），人拥有节点执行主权——上传/填写/编辑产出物→提交新版本→交回状态机。用 LangGraph `interrupt(response_schema)` 实现"人的产出作为 interrupt 返回值"（节点从函数头重跑，副作用幂等）。
  3. **"待你处理 N 项"收件箱**：统一入口聚合所有 participation=human / waitKind=human 的节点（借鉴 A2A input-required + HumanLayer `human_input_requested→response_from_human` 事件对）。
  4. 人的输入是事件流中又一个结构化事件（source=user），与 agent 动作同构，天然支持异步/审计。
- **目的**：实现你要的"有些节点必须由人完成，人上传产物即可；人深度参与而非弹窗审批"。这是你的**差异化卖点（human-as-executor，全网开源空白）**。
- **服务效果**：③三形态、⑤人的主观能动性。**机制能保证；"参与感好不好用"需真实任务验证**。
- **验收**：纯人节点"人上传→提交版本→状态机 human-working→completed→下游释放"全路径；收件箱聚合正确；过期响应拒绝；三入口一致。
- **约束**：新节点须过 NODE_CONTRACT_SPEC（contractVersion/ports/executor/projectOutputs/契约测试）；收件箱 GUI 必须同包给 CLI/MCP；日志补人工任务开始/终态。
- **风险**：中。契约变更影响面大，须 parity 门禁 + 兼容结论。

### O3【P1】FlowRun 一等实体 + 事件日志（解决 G4）

- **改什么**：建 `flow_runs`（一次运行=一个权威实体）+ `flow_events`（append-only 事件日志），把分散三处的运行态归一投影。
- **怎么改**（借鉴 Temporal Entity Workflow + OpenHands source 三方归因）：
  1. `flow_runs`：聚合 flow_agent_tasks/flow_coordination_scope/composite_runs 的投影，提供 created/running/waiting/paused/completed/failed 总览态（**投影而非第二份权威**，权威仍是账本）。
  2. `flow_events`：每事件带 `source: user|agent|environment`（映射你的三形态），不可变 append-only，状态机=事件日志投影。
  3. 用 LangGraph `get_state_history()` 给前端画"节点状态时间线"（低成本可视化）。
  4. 一次运行可 Signal（暂停/恢复/总览/回放），参考 Temporal Entity Workflow。
- **目的**：实现"一次流程运行可暂停/恢复/总览/回放"，让你的状态机有权威载体。
- **服务效果**：②可恢复可审计。**能保证**。
- **验收**：崩溃重开后 flow_run 总览正确、事件日志可回放、unknown 不重放；三入口查询一致。
- **约束**：SQLite 方言别写死（为未来迁移留口）；日志覆盖；事件日志不记正文/提示词/Key（LOGGING_SPEC）。
- **风险**：中。数据建模 + 三处归一，须保证账本仍是唯一副作用权威。

### O4【P2】开放流程构建：扩表达力 + 静态校验 + 影响预览（解决 G5）

- **改什么**：把建图从"6 能力 / 2 拓扑 / 单 text 源"扩到"任意垂类 flow"，并补全静态校验。
- **怎么改**（借鉴 FastGPT 三步法 + Claude frontmatter DSL + A2A AgentCard + XState decideNext + AFlow）：
  1. **扩能力目录 + 拓扑**：增加 condition/loop/subflow（composite 已有子流程基础）；源不限于单 text 节点。
  2. **静态校验器**：BuildPlanSchema 之外补端口类型匹配 / 环检测 / Participation 合法性 / 预算合法性（防 AI 生成死循环/类型不匹配）。
  3. **影响预览 UI**：建图预览已有（builder-host），补"AI 提案→静态校验→差异预览→用户确认"的差异展示（FastGPT 三步法的产品化）。
  4. **flow 解释器 schema（战略壁垒）**：定义可序列化 flow 定义（节点三形态 + 各自最小输入 schema + interrupt 决策集），外部 Agent 产 JSON → harness 编译成 StateGraph 执行。**全网无现成品**（AFlow 仅学术）。复用 AF-01 fixed-order/stages 作确定性底座。
  5. 能力菜单用 A2A AgentCard 式格式，让外部 Agent 构建时有"菜单"可查（你的 agent-access registry ~130 操作可统一成此格式）。
- **目的**：实现你要的"上帝 Agent 按垂类动态构建 flow"，覆盖任意任务而非硬编码。
- **服务效果**：①外部 Agent 构建。**能保证机制；AI 生成 flow 的质量需静态校验 + 试跑反馈兜底**。
- **验收**：AI 生成含条件/循环的 flow→静态校验拦截非法→预览确认→真实跑通；非法 flow 被拒。
- **约束**：画布语义图仍是唯一可编辑流程定义（不建第二份拓扑）；三入口；日志。
- **风险**：中高。表达力放开后质量风险上升，**静态校验是必配项，不是可选**。

### O5【P0】质量护城河：补最后几道闸（解决 G6）

- **改什么/怎么改**（借鉴 Manus + Anthropic + Claude subagents + OpenAI input_filter + XState describeMachine + LangGraph JS）：
  1. **节点输出入状态机前做摘要压缩 + 指令扫描转义**（防子代理输出伪造成系统提醒，Claude Code 已这么做）。
  2. **所有"进入下一节点"入口过一道显式 history 裁剪函数**（OpenAI input_filter/nest_handoff_history）——上下文不爆炸第一道闸。
  3. **大产物标 LangGraph `UntrackedValue`**（不进 SQLite checkpoint，防膨胀）；你已资产落盘，中间草稿/原始抓取应标 Untracked。
  4. **显式调高 JS `recursionLimit`**（默认仅 25，长 flow 会被误杀）——自查项。
  5. **主 Agent 上下文用 describeMachine 原则**：只喂"机器合法转换集合 + 目标 + 当前节点"，不喂全量历史（XState）；状态机每次流转重注入目标（Manus 复述，对抗 lost-in-the-middle）。
  6. 关键指令放节点提示首尾（Lost-in-the-Middle U 形曲线）。
- **目的**：把你"最小必要输入→高质量"的论点落到每一道闸，对抗 context rot。
- **服务效果**：④⑤最小输入 + 注意力集中。**机制能保证；单任务质量提升幅度需实测**。
- **验收**：大产物不进 checkpoint（查 SQLite 体积）；长 flow 不被 recursionLimit 误杀；交接历史被裁剪；主 Agent 上下文 token 数受控。
- **约束**：你 harness 已在 LangGraph JS 上，这些是配置/小改，低风险。
- **风险**：低。**这是性价比最高的一组，建议最先做。**

### O6【P1】人机协作深化（解决 G7）

- **改什么/怎么改**（借鉴 deepagents decisions + Dify Human Input + Letta reason 回喂 + AgentScope 中断即事件 + Bisheng 自描述 UI）：
  1. **标准决策集**：协作面板对齐 approve/edit/reject/respond + `when` 谓词（风险分级，不必每节点都要人）——直接落在你现有 interrupt 之上。
  2. **预填编辑产出物**：把上游 AI 草稿渲染进表单供人直接改（Dify Paragraph 预填）+ 多按钮→分支映射 + 超时分支。
  3. **驳回带 reason 结构化回喂**下游 agent（Letta）；返工意见结构化（GPT-Pilot Troubleshooter 模式）。
  4. **人中断 AI 时保留半成品**：partial output 存档 + 标注 + 作返工上下文（AgentScope），不丢弃。
  5. **节点自描述输入契约→前端自动渲染协作 UI**（Bisheng get_input_schema）+ LLM 推荐问题降低人的负担。
- **目的**：让人机协作从"能讨论"升级到"人能高效改稿、驳回有回喂、中断不丢活"。
- **服务效果**：③⑤人深度参与。**机制能保证；交互体验需真实任务验证**。
- **验收**：四档决策 + when 谓词路由正确；预填编辑→新版本→重审；超时走兜底分支；中断半成品可续跑。
- **约束**：协作面板 GUI 同包 CLI/MCP；日志；不隐式执行（聊天不自动变资产）。
- **风险**：中。交互细节多，须按 NODE_UI_STANDARD §19 验收。

---

## 三、效果保证矩阵（你的每个期望 → 由哪些优化保证 → 保证程度 → 怎么验收）

| 你的期望效果 | 由哪些优化支撑 | 保证程度 | 验收方法（确定性 vs 需实测） |
|---|---|---|---|
| ① 外部上帝 Agent 动态构建任意垂类 flow | O4 | 机制可保证；生成质量需校验兜底 | 确定性：AI 生成→静态校验→预览→跑通；非法被拒 |
| ② 主 Agent 流转 + 状态机自动闭环 | O1+O3 | **可保证** | 确定性：节点完成→账本→状态机自动迁移→释放下游；崩溃恢复 |
| ③ 节点三形态（纯 AI/人机/纯人） | O2+O6 | 机制可保证；体验需实测 | 确定性：三形态全路径 + 收件箱；实测：参与感 |
| ④ 每节点最小必要输入 + 输出落盘 | O5（已有固定输入清单/资产版本） | **机制可保证** | 确定性：交接裁剪/Untracked/落盘；实测：单任务质量 |
| ⑤ 人深度参与 + 注意力集中 | O2+O5+O6 | 机制可保证；质量/审美需实测 | 确定性：上下文 token 受控；实测：产出质量/审美 |
| 上下文不爆炸 → 高质量 | O5 | 机制可保证；质量幅度需实测 | 实测：同任务 A/B（拥挤 vs 最小输入）对比产出 |

**关键诚实点**：上表"可保证"的都是**工程机制**，能用测试证明；凡是涉及"产出质量/审美/好不好用"的，**只能实测，不能先验承诺**。这不是推脱——是这类产品的客观规律（模型能力 × 上下文 × 人把关共同决定质量）。

---

## 四、优先级与落地路线（结合工程约束）

| 阶段 | 内容 | 为什么这个顺序 | 约束动作 |
|---|---|---|---|
| **第 0 步：真实任务验证**（立即，先于大改） | 用现有系统手工搭"公众号文章 flow"（选题→搜索→框架→写作→配图→审核→发布），你自己跑 3–5 篇 | 验收跑通≠真实好用；先暴露"哪里想介入介入不了/哪里输入不够最小/哪里状态机没推进"，用真实缺陷决定 O1/O2 优先级 | 记录缺陷清单 + 参与度体验 |
| **第 1 步：O5 质量护城河**（P0，低风险高收益） | 摘要回传/防注入/交接裁剪/UntrackedValue/recursionLimit/复述 | 你 harness 已在 LangGraph JS 上，多是配置/小改；立刻强化命题④⑤ | 日志影响检查；定向测试 |
| **第 2 步：O1 状态机闭环**（P1，核心） | 可信事件源接入状态机；扩展 input-required/human-working | 解决最痛的 G1+G2，让生成的 flow 真正自动流转 | 三入口同包 + guard:agent-parity；日志 |
| **第 3 步：O2 纯人节点 + 收件箱**（P1，差异化） | Participation 三态 + HumanTask + interrupt(response_schema) | 你的差异化卖点，须契约变更 | 节点协议 + 契约快照刷新 + change-impact.json + 三入口 |
| **第 4 步：O3 FlowRun 实体**（P1） | flow_runs + flow_events + 时间线 | 让运行可暂停/恢复/总览/回放 | SQLite 方言留口；日志覆盖 |
| **第 5 步：O6 人机协作深化**（P1） | 决策集/预填编辑/超时/驳回回喂/中断保留 | 提升参与体验 | NODE_UI_STANDARD §19 + 三入口 |
| **第 6 步：O4 开放构建 + flow 解释器**（P2，壁垒） | 扩能力/拓扑 + 静态校验 + 影响预览 + 可序列化 flow schema | 表达力放开风险高，放最后；静态校验必配 | 画布唯一流程定义；三入口 |

> 难度判断（与可行性报告一致）：没有研究级难题，都是工程整合。基础运行时（账本/隔离/固定输入/协调宿主）是最难的 70%，已完成；剩下 30% 是上述整合工作。

---

## 五、风险与决策点（需要你拍板）

### 5.1 必须正视的风险

1. **验证缺失是最大风险**：不先做真实任务 demo，所有优化都是纸面。**第 0 步不可跳过。**
2. **参与深度 ≠ 参与频率**：GPT-Pilot 教训（每步都要人确认→流失）。人的介入必须落在**高杠杆节点**（选题/框架/终审），由 flow 构建方声明哪些节点该人做，而非全默认人机协作。
3. **AI 生成 flow 质量风险**：O4 放开表达力后可能类型不匹配/死循环，**静态校验是必配项**。
4. **Cognition 反方**（调研报告 2.4）：对外要能回答"多代理不可靠"——你做的是串行+人把关+显式契约，不是并行自主决策，落在安全区。
5. **契约变更影响面**：O2 的 Participation 是契约变更，须三入口同包 + 兼容结论 + parity 门禁，不能只改 GUI。

### 5.2 决策点（请拍板，我再动代码）

| # | 决策 | 选项 | 我的建议 |
|---|---|---|---|
| D1 | 先验证还是先补闭环？ | A 先做真实 demo / B 先 O5+O1 | **A**：先 demo 暴露真缺陷，避免优化错方向 |
| D2 | Participation 契约怎么迁移？ | A 新增字段保留 interactionMode 兼容 / B 直接替换 | **A**：存量不迁移（与 AF-01 同策略），降风险 |
| D3 | 纯人节点用新节点类型还是复用现有 text/file？ | A 新增 human-task 节点 / B 现有节点加 participation | **B 优先**：复用现有节点 + participation 声明，少造节点；收件箱聚合即可 |
| D4 | flow 解释器 schema 现在做还是后做？ | A 现在 / B O4 阶段 | **B**：先把闭环/纯人/质量做扎实，壁垒后建 |
| D5 | 状态机扩展态命名？ | A 对齐 A2A（input-required）+ 自定义 human-working / B 自拟 | **A**：协议级蓝本，可对外互通 |
| D6 | 优化范围是否含 UI？ | 本方案 O2/O6 涉及协作面板/收件箱 UI | 须按 NODE_UI_STANDARD §19，且**UI 改动不改变既有功能行为**（你的硬约束） |

---

## 六、诚实结论

1. **你的系统已完成约 70%（最难的基础运行时），不完整的是 7 个明确点（G1–G7），全部是工程整合，没有研究级难题。**
2. **能保证的**：把 G1–G7 补齐、三入口一致、可恢复可审计、质量机制做对——这些可用测试 + verify + 画布路径验收证明。
3. **不能先验保证的**：每个垂类任务的实际产出质量、你的审美满意度、参与体验好不好用。**这部分只能靠第 0 步真实任务验证**，任何先验承诺都是不诚实的。
4. **最该立刻做的**：第 0 步真实 demo + 第 1 步 O5 质量护城河（低风险高收益）。**最有差异化价值的**：O2 纯人节点（human-as-executor，全网空白）。**最能建壁垒的**：O4 flow 解释器（全网无现成品）。
5. **你的"最小必要输入→高质量"方向有硬证据支撑**（Chroma/Anthropic/Manus），唯一要正面回答的反方（Cognition）已被你的"串行+人把关+显式契约"设计避开。

> 下一步：请你先就第五节 D1–D6 拍板（尤其 D1 先验证、D3 纯人节点形态）。确认后我按路线动代码，每步遵守三入口铁律 + 日志覆盖 + 节点协议，并给你可验收的证据。

---

*本方案基于源码核实（executors/agentFlow.ts、builder-host.ts、node-contracts.ts、command-ledger.ts、db-migrations.ts）+ 开源调研 20261113。性质为方案，未改动任何代码。*