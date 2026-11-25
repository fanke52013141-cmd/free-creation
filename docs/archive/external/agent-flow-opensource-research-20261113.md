# Agent Flow 开源项目深度调研报告（2026-11-13 核实更新版）

> 调研目标：在 GitHub 与海外开源社区中，寻找与你的 Agent Flow 设想契合的项目，逐一深挖，明确**哪些项目可以借鉴、借鉴什么、为什么需要借鉴、对本项目的增益是什么**。
> 你的设想（5 命题）：① 外部"上帝 Agent"动态构建 flow ② 主 Agent 流转 + 显式节点状态机 ③ 节点三形态（纯 AI / 人机协作 / 纯人）④ 每节点最小且必要输入 + 输出落盘 + 上下文隔离 ⑤ 人充分发挥主观能动性 + 单模型注意力集中。
> 你的核心论点：**上下文爆炸会拉低大模型输出质量；用 sub-agent 保证"最小且必要输入"，比在拥挤上下文里产出质量更高；很多环节必须由人深度参与，而现有 Agent 产品忽视了人的主观能动性。**
> 配套文档：《可行性 + 差距分析报告》（agent-flow-feasibility-analysis-20261112.md）、上一版《开源项目深度调研报告》（agent-flow-opensource-research-20261112.md）。

---

## 〇、先说三句实话（本报告与上一版的关系）

1. **昨天（11-12）已经有一份很完整的调研报告和可行性分析。** 本报告不是推倒重来，而是**核实 + 纠错 + 补强**：上一版结论总体成立，但个别 star 数失真、个别近况需要更新；本版用 2026-10/11 的一手来源重新核对，并补上了上一版缺失的**质量论据**（这正是你整个设想的地基）。
2. **你的核心论点这次拿到了硬证据。** "上下文越长质量越差"不是直觉，是被 Chroma（18 个模型全退化）、Lost-in-the-Middle、Anthropic 多代理实验（+90.2%）反复测量过的现象。你的"最小必要输入 + 隔离"方向在学术和工程上都站得住。详见第二节。
3. **有一个最强反方观点必须正视：Cognition《Don't Build Multi-Agents》。** 它反对的恰恰是"把任务拆给多个 sub-agent"。但仔细读会发现，它反对的是**并行自主决策**，而你的设计是**串行 + 人把关 + 显式产物契约**——恰好落在它认可的安全区。第二节给出完整 reconcile，这是你对外讲方案时必须能回答的质疑。

**一句话总判断（与上一版一致，本版补充证据）**：没有任何单一开源项目同时具备你的 4 个核心要素；业界是四种"残缺拼图"。你已完成的运行时（命令账本 / 上下文隔离 / 固定输入清单 / 协调宿主）恰好是最难拼的几块。**"纯人节点（human-as-executor）"全网开源空白，是你的差异化；"可序列化 flow 定义 → 编译成状态图执行"全网无现成品，是你最能建壁垒的位置。**

---

## 一、关键事实核实与纠错（2026-11-13）

> 方法：直接抓取 GitHub 官方公告 / 官方文档 / 2026-10 月第三方横评（数据源自 GitHub API）。GitHub REST API 本机直连被限流（403），故 star 数采用第三方追踪的 2026-10 约数，**标注为约值，非当日精确值**。

### 1.1 必须纠正/更新的近况

| 项目 | 上一版说法 | 本版核实结论 | 对你的影响 |
|---|---|---|---|
| **Flowise** | 已归档（2026-08），不可用 | **属实，且补充细节**：2025-08 被 Workday 收购；2026-07-29 代码冻结、2026-08-13 仓库归档、2026-08-31 EOL；最后版本 3.1.4；Apache-2.0 代码可 fork，社区维护分支 Flow-Wiser。**官方关停理由原话："开发者越来越依赖 coding agent，僵化的低代码 workflow 在复杂任务上很快触顶。"** | 不能作基座；但 **Agentflow V2 的设计（HITL 节点 / Flow State / checkpoint / AI 生成）仍是极佳参考**。其关停理由反而印证你的判断：僵化低代码不行，要"AI 动态生成 + 人深度参与"的 flow。 |
| **AutoGen** | microsoft/autogen 已归档 | **属实**：进入维护模式（只修 bug），最后 release 0.7.5（2025-09-30）。继任者 **Microsoft Agent Framework（MAF）1.0 于 2026-04-03 GA**，合并 AutoGen + Semantic Kernel；社区分叉 AG2 继续。OpenAI Swarm 也已归档→Agents SDK。 | 选型避开 AutoGen 本体；若要参考微软系编排，看 MAF。 |
| **star 数** | LangGraph 48.2k、CrewAI 60.8k 等 | **上一版部分数字失真**。2026-10 第三方约值：LangChain ~137k、LangGraph ~33k、CrewAI ~38k、AutoGen ~48k（归档）、Dify ~159k、n8n ~208k、Langflow ~156k、Flowise ~55.5k（归档）、OpenAI Agents SDK ~19k、Semantic Kernel ~28k、Mastra ~21k。 | 选项目看思维模型与生产实践，**不要按 star 选**（AutoGen 48k 却已维护模式）。 |
| **AFlow** | 提及（ICLR 2025 oral） | **核实并补全**：ICLR 2025，MCTS 在"代码表示的 workflow"空间搜索；节点(Node)+算子(Operator)+边(Edge)；代码 github.com/FoundationAgents/AFlow。6 基准平均超人工设计 +5.7%、超自动方法 +19.5%；让小模型以 GPT-4o **4.55% 的成本**在特定任务超越它。 | 这是"AI 动态生成 flow"（你的命题①）**最正式的学术验证**，可直接引用为你的方案背书。 |

### 1.2 上一版正确、本版确认的关键结论

- **没有任何编排框架原生支持"外部 Agent 动态构建 flow"**：LangGraph/CrewAI 拓扑须代码编译，Send 只能动态分支数量、不能动态发明节点；SDK/deepagents 是模型隐式驱动。最接近的正式尝试是 AFlow（学术，未产品化）。→ 你的"flow 解释器"是空白位。
- **"human-as-executor（人作为节点主执行者）"全网开源空白**：现有范式只有 human-in-the-loop（人审批）/ human-on-the-loop（人监督）/ human-as-tool（AI 把人当工具）。你的"纯人节点"是第四形态。
- 你的 harness 本身就是 **LangGraph JS**（StateGraph/interrupt/Command + SQLite checkpointer），所以 LangGraph 不是"要不要引入"，而是"用对了没、还有什么没吃到"。

---

## 二、质量论据：为什么"最小必要输入 + 隔离"是对的（本版新增，你设想的地基）

> 这一节回答你最根本的问题：**凭什么说上下文爆炸会降低质量、最小输入会提高质量？** 下面全部是可引用的一手证据。

### 2.1 上下文腐烂（Context Rot）—— 你的论点的最强实证

- **Chroma《Context Rot》（2025-07，代码 github.com/chroma-core/context-rot）**：测了 18 个前沿模型（GPT-4.1、Claude Opus 4、Gemini 2.5 Pro、Qwen3 等），**每一个**都随输入变长而退化，连"复制重复单词"这种简单任务都退化。关键发现：
  - **聚焦 ~300 token 的提示，在 LongMemEval 会话问答上显著优于 ~113K token 的完整历史**——同样的信息，上下文越小质量越高。这就是你"最小必要输入"的直接实验证据。
  - 干扰项（语义相近但无关的内容）会叠加退化；**结构连贯的文本反而比打乱的文本更难检索**（因为制造了更多"看似合理"的干扰）。
- **Lost in the Middle（Liu et al., TACL 2023/2024, arXiv:2307.03172）**：性能呈 U 形——开头/结尾好、中间差；关键信息放中间比放两端**准确率掉 30%+**。→ 把全部历史塞进一个窗口，关键指令会落在"注意力盲区"。
- **Same Task, More Tokens（arXiv:2402.14848）**：同一任务，输入到 3000 token 时平均准确率 **0.92→0.68**；甚至"完全重复的填充文本"都会降质。
- **GSM-IC（arXiv:2302.00093）**：往数学题里加无关句子，准确率骤降。→ 主 Agent 上下文里堆满别的节点的中间产物，就是"无关句子"。
- **机制（Anthropic 口径）**：自注意力是 n² 的两两关系，softmax 把固定注意力权重摊到所有 token 上——**每多一个 token，真正重要的证据被分到的注意力就更少**（"attention budget"）。这是架构属性，不是训练能解决的，**更大窗口治不了**（1M 窗口在 50K 就退化）。

**结论**：你"主 Agent 装太多多余信息→上下文爆炸→质量下降"的判断，与上述测量完全一致。**"最小且必要输入"不是审美偏好，是对抗 context rot 的工程必需。**

### 2.2 Anthropic 多代理研究系统 —— "隔离 + 只回摘要"被量化验证

- 架构：Opus 4 主代理派 3–5 个 Sonnet 4 子代理并行，每个子代理在**自己的窗口**里探索/试错/丢弃死路，**只回 1–2K token 的摘要**给主代理。
- 结果：在研究评测上**比单 Opus 4 代理高 90.2%**；token 用量 alone 解释 80% 的性能方差；总 token 约为单聊天的 **15×**，但关键在"这些 token 分布在隔离窗口里，而不是挤在一个窗口"。
- Anthropic《Effective Context Engineering for AI Agents》三招：**compaction（旧轮次压成摘要）/ structured notes（窗外笔记，用时读回）/ sub-agents（各自窗口探索、回摘要）**；定义 context engineering = "在每次调用时， curated 出最小的高信号 token 集合"。
- 《Building Effective Agents》六模式：prompt chaining / routing / parallelization / **orchestrator-workers** / evaluator-optimizer / agents；人介入 = "在 checkpoint 暂停等人反馈"——**checkpoint 思维：人在关键点深度介入，而非每步点头**。

**对你的增益**：你的 per-task snapshot/session（命题④⑤）正是这套"隔离 + 摘要回传"的落地。可补的一条：**节点输出进入状态机前先做摘要压缩 + 指令扫描**（防子代理输出伪造成系统提醒，Claude Code 已这么做）。

### 2.3 Manus 上下文工程六原则 —— 与你的设计几乎逐条同构

> 来源：manus.im/blog/Context-Engineering-for-AI-Agents-Lessons-from-Building-Manus（Manus 2025-12 被 Meta 以 ~$2B 收购）。

| Manus 原则 | 内容 | 对应你的设计 |
|---|---|---|
| ① 围绕 KV-cache 设计 | 前缀稳定、append-only、不在系统提示放时间戳（缓存命中是生产 agent 第一指标，缓存/未缓存成本差 10×） | 你的固定输入清单冻结 = 稳定前缀 |
| ② Mask 而非 Remove | 不动态删工具（破坏缓存），用 logit mask | 节点工具按阶段遮蔽 |
| ③ **文件系统即外部记忆** | "上下文=RAM（易失有限），文件系统=Disk（持久无限）"；压缩必须可还原（留 URL/路径指针） | **你的"输出落盘 + sha256 资产版本"= 这条的工业级实现** |
| ④ **用复述操纵注意力** | 不断重读 task_plan.md，把全局目标推回"最近注意力区"，对抗 ~50 次工具调用后的 lost-in-the-middle | **你的状态机每次流转把"目标+当前节点+合法转换"重新注入主 Agent = 复述** |
| ⑤ 保留错误轨迹 | 失败动作+stack trace 留在上下文，让模型隐式更新信念、少重复犯错 | 你的返工/驳回带 reason 回喂 |
| ⑥ 别被 few-shot 化 | 重复 action-observation 对会漂移/幻觉，引入受控变化 | 节点提示避免千篇一律 |

- 三策略：**Reduction（旧工具结果压成引用，近期保留全文）/ Isolation（planner→executor 子代理，各自窗口）/ Offloading（<20 个原子工具，全量结果落盘、上下文只留引用，glob/grep 按需取）**。
- 关键演进：Manus  originally 用 todo.md 做规划，发现 **~33% 的动作花在更新 todo 上**，于是改成**专职 planner agent 调用 executor 子代理**。→ 印证你"主 Agent 只协调、不亲自干活"的分工。

**对你的增益**：Manus 是你命题④⑤最贴近的工程范本，且它的"文件系统即记忆 + 复述 + 隔离"三件套，你已分别用"资产落盘 + 状态机重注入 + per-task 隔离"实现了。**这是你对外讲"为什么这样设计"时最有力的同行背书。**

### 2.4 最强反方：Cognition《Don't Build Multi-Agents》—— 必须能回答的质疑

> 来源：cognition.ai/blog/dont-build-multi-agents（Walden Yan，2025-06-12，Devin 团队）。

- 两条原则：**① 共享上下文，且共享完整 agent 轨迹而非孤立消息；② 行动承载隐性决策，冲突的决策导致糟糕结果。**
- 反例（Flappy Bird）：把任务拆给两个并行子代理，一个把背景做成超级马里奥、一个把鸟做得不像游戏素材——**子代理彼此看不到对方、隐性假设冲突**，主代理只能整合两个错误。结论：默认用**单线程线性 agent**，超长任务用**专门的压缩模型**而非粗暴分包。
- 但注意：**Cognition 自己也用子代理做"搜索隔离"（SWE-grep）**——把检索/探索放进独立窗口，只回精确结果。它反对的是**并行自主决策**，不是**隔离检索**。

**与你的设计 reconcile（关键，对外必答）**：

| Cognition 担心的失败模式 | 你的设计为什么避开了它 |
|---|---|
| 并行子代理各自做隐性决策、互相冲突 | 你的节点是**串行流转 + 状态机驱动**，不是并行自主分包；并行只用于无决策冲突的 fan-out |
| 子代理看不到彼此、上下文割裂 | 你有**命令账本 + 不可变资产版本 + 固定输入清单**作为"共享上下文"的权威载体——Cognition 要的"共享完整轨迹"，你用**产物契约 + 事件日志**实现，而不是靠塞满一个窗口 |
| 隐性决策冲突 | 你的**高杠杆节点由人把关**（选题/框架/终审），把"隐性决策"变成"显式人工决策"；节点输出是**版本化结构物**，下游只拿契约字段，不靠猜 |
| 上下文溢出 | 你用**隔离 + 落盘 + 摘要回传**（Manus/Anthropic 同款），而非单窗口硬塞 |

**一句话**：Cognition 反对的是"无人把关的并行自主多代理"；你做的是"有人把关的串行最小输入 flow"。**你的隔离是为了对抗 context rot（质量），不是为了并行决策（它反对的那个）。** 这两件事不矛盾，而且 Cognition 自己的搜索隔离恰恰支持你。把这段写进你的方案文档，能挡掉绝大多数"多代理不可靠"的质疑。

---

## 三、横向总对比表（2026-11-13 更新版）

> 评级：极强/强/中/低/无。★ 为 2026-10 第三方约值（非当日精确）。"组"见第四节。

| 项目 | 状态机表达 | HITL 深度 | 上下文隔离 | AI 动态构建 flow | 最小输入 | 成熟度/近况 | 组 |
|---|---|---|---|---|---|---|---|
| **LangGraph（你在用）** | 极强（channel+reducer+super-step 快照、Send、Command、子图 namespace checkpoint、全历史可回放） | 极强（interrupt/Command(resume)：改状态/改参数/接管 + response_schema 校验） | 强（Send 最小注入、子图私有 key） | 中低（拓扑须代码编译） | 强 | 极高 ~33k★，1.0（2025-10），生产广泛 | A |
| **deepagents（LangChain）** | 低（ReAct + todos channel） | 强（approve/edit/reject/respond + when 谓词 + 批量） | **极强（isolated/fork 子代理、摘要回传、虚拟 FS 卸载）** | 中低（动态子代理 beta） | 强 | 高 ~31k★（2025 爆火，极活跃） | A |
| CrewAI Flows | 中（事件流装饰器+router，@persist 快照/分叉） | 中低（human_input 终稿 + @human_feedback 自由文本→LLM 归类） | 低（共享大 state） | 低 | 低 | 高 ~38k★，1.0，API 迭代快 | A |
| Microsoft Agent Framework | 中（SK 基座 + AutoGen 图工作流） | 中 | 中 | 低 | 中 | 新（2026-04 GA，AutoGen+SK 继任） | A |
| AgentScope | 中（pipeline/分支/循环 + StateModule） | 中（UserAgent 完整参与 + 中断即事件、保留半截产物） | 中（单 Msg 传参、MsgHub 可选加入） | 无 | 低 | 中高 ~36k★，阿里活跃 | A |
| MetaGPT / AFlow | 中（SOP 固定流水线 + 订阅因果触发） | 极低（仅入口需求） | 中（订阅制投递 + 结构化制品契约） | **AFlow 高（MCTS 生成 workflow，学术）** | 中 | ~71k★ 但开源停滞→MGX；AFlow 活跃 | A/D |
| OpenAI Agents SDK | 低（agent loop + handoff） | 中低（needs_approval 谓词 + RunState 跨进程恢复；只 approve/reject） | 中（input_filter/nest_handoff_history 交接裁剪） | 低 | 中 | 高 ~19k★，Swarm 继任 | A |
| Mastra（TS 原生） | 中（图 then/branch/parallel + suspend/resume） | 中（挂起/恢复 HITL） | 中（四层记忆） | 低 | 中 | 高 ~21k★，TS 生态，与你同栈 | A |
| n8n | 低 | 中（Wait+表单/审批链接 resumeUrl） | 低 | 低（JSON 公开稳定 typeVersion） | 低 | 极高 ~208k★，fair-code | B |
| **Dify** | 中（YAML DSL） | **较深（预填编辑产出物+多按钮分支+超时分支+邮件外链）** | 中 | 低 | 中 | 极高 ~159k★ | B |
| **Coze Studio** | **强（InterruptEvent 显式中断实体，可嵌套）** | 中（问答/输入+resume API） | **强（InputSources 逐字段映射）** | 低 | **强** | 中高 ~22k★，字节 Apache-2.0 | B |
| FastGPT | 中（连线三态 waiting/active/skip） | 中（userSelect/formInput） | 中 | **高（辅助生成三步法，仅商业版）** | 中 | 高 ~30k★ | B |
| Bisheng | 中 | 较深（dialog/form 双模式+引擎挂起+自描述输入契约） | 中 | 低 | 中 | 中 ~12k★ | B |
| Flowise | — | — | — | — | — | **EOL（2026-08-31），仅设计参考/fork** | B |
| Langflow | 低 | 低 | 低 | 低（flow 即 JSON、可 MCP 化） | 低 | 高 ~156k★，MIT，IBM/DataStax | B |
| **Temporal** | **极强（Event History+replay+Entity Workflow）** | 中（Signal 等审批，UI 自建） | **强（Activity 边界）** | 中 | 中 | 极高 ~24k★，生产级 | B |
| Inngest agent-kit | 强（step 持久化+typed state machine） | 中（waitForEvent+onRoute 卡点） | 强 | 低 | 中 | 中（年轻） | B |
| **XState + @statelyai/agent** | **极强（层级/并行状态图+actor+snapshot）** | 中（getInteraction 收敛人为事件） | **强（actor 消息传递）** | **高（decideNext 约束生成 + describeMachine）** | 强 | 高 ~30k★，库级 | B |
| **Claude Code Subagents** | 粗（共享 task list 四态） | 中（审批+中断+文件信箱，无纯人节点） | **最强（独立窗口+返回摘要+防注入）** | **强（md/JSON frontmatter，AI 可写）** | **强（委派消息即最小输入）** | 官方（Teams 实验） | C |
| **HumanLayer 12-Factor** | **强（事件 reducer，方法论级）** | 强（request_human_input 事件对） | 弱（单 agent 视角） | 强 | **强** | 方法论 ~27k★；产品已转型 Riptide | C |
| **A2A 协议** | **强（协议级 9 态 Task，含 input-required）** | 中（协议级，实现自由） | 中（contextId 分组） | 中（AgentCard 发现） | **强（artifact 契约）** | ~26.5k★，Linux 基金会 | C |
| Letta/MemGPT | 弱（approval 暂停点） | 中（approve/deny+reason 回喂） | 中（记忆块层隔离） | 弱 | 强（block 按需注入） | ~25k★（API 迁移期） | C |
| **OpenHands SDK** | **强（事件溯源重放，工程最强）** | 中（确认模式+UserReject） | 强（沙箱+事件日志） | 中 | 中 | ~93k★，极活跃 | C |
| GPT-Pilot | 低（线性步骤） | 理念深（逐步确认+答疑） | 低 | 无 | 中 | ~33k★，**已弃维+供应链投毒，只读不部署** | C |
| AFFiNE / BlockNote | 无 | **产物级共编（块级 diff 接受/拒绝）** | 不适用 | 无 | 文档上下文 | ~74k★ / 组件级 | C |

---

## 四、分组深挖：每个项目借鉴什么 / 为什么 / 增益

> 体例：【是什么】【核心机制】【对应你哪条命题】【借鉴什么】【为什么】【对本项目增益】。你的项目现状锚点来自可行性报告：LangGraph JS harness、命令账本（pending/prepared/committed/unknown）、FixedNodeInputSchema、composite 子流程、coordinator-host、32 节点/3 Agent 节点、~130 agent-access 操作、4 个缺口（①状态机自动闭环 ②开放流程构建 ③FlowRun 一等实体 ④纯人任务形式化）。

### 组 A：编排框架类

#### A1. LangGraph（langchain-ai/langgraph + langgraphjs，~33k★，1.0）—— 你的底座，重点回答"用对了没"

- 【核心机制】StateGraph（add_node/edge/conditional_edges/compile）；状态=channel 体系（默认 last-write-wins，`Annotated[list, operator.add]` 声明 reducer，`add_messages` 支持 HITL 原地改消息）；Pregel super-step，**每个 super-step 边界落一个 checkpoint**；`Command(update={...}, goto="node")` 同时改状态+决定走向；**Send（动态并行 map-reduce，每分支注入自己的最小 per-item 状态）**；子图私有 key + 独立 namespace checkpoint；StateSnapshot={values,next,config,metadata{source,**writes**,step},tasks}，`get_state_history()` 拿全历史，`update_state()` 人工改状态再续跑（官方称 checkpointer 是"人/agent 协作的 scratchpad"）。
- 【HITL】`interrupt(payload)` 任意位置挂起→payload 经 checkpoint 持久化→`Command(resume=X)` 恢复，**X 成为 interrupt() 返回值，节点从函数头重跑**（interrupt 前副作用必须幂等；别裸 try/except 包住它）；新版 `response_schema=`（JSON Schema）对 resume 输入做类型校验（≥1.2.12）；官方枚举交互形态：approve/reject、**review & edit state（人直接改状态字段）**、review tool calls、多轮对话；静态 interrupt_before/after 仅调试用。
- 【JS 特有，对你重要】`UntrackedValue`（不写进 checkpoint 的临时 channel，防大产物撑爆 SQLite）；用 Command 的节点须在 addNode 传 `ends`；**默认 recursionLimit 只有 25（Python 是 10007）**，长流程须显式调高。
- 【对应命题】②（checkpointer=节点状态流水账，metadata.writes+get_state_history 现成）③（纯 AI 不 interrupt / 人机 edit-review / **纯人=人给出 interrupt 返回值**）⑤（update_state 让人在任意 checkpoint 改状态，超越 approve/reject）。**做不到①**：拓扑代码编译，Send 只能动态分支数、不能动态发明节点。
- 【借鉴什么/为什么/增益】
  1. **把 interrupt 两条铁律固化为你 harness 的节点编写规范**（人的答复=interrupt 返回值；interrupt 前副作用幂等），并给 interrupt 加 `response_schema` 做结构化人输入校验。→ 直接补齐缺口④"纯人节点"的原生实现路径，不用引外部框架。
  2. **分发多 worker 一律走 Send**（每分支最小注入）→ 强化命题④，天然最小输入。
  3. **每节点/子代理一层 StateGraph 包裹**获得稳定 namespace+私有状态 → 强化命题⑤隔离。
  4. **UntrackedValue 防大产物撑爆 SQLite checkpointer** → 你已落盘资产，但中间草稿/原始抓取应标 UntrackedValue，这是你 harness 立刻能吃的工程细节。
  5. **get_state_history() 直接给前端画"节点状态时间线"** → 缺口③的低成本可视化。
  6. **recursionLimit 显式调高** → 你的长 flow 不被 JS 默认 25 误杀（自查项）。

#### A2. deepagents（langchain-ai/deepagents，~31k★，2025 爆火）—— 上下文隔离 + HITL 决策协议最佳参照

- 【核心机制】"batteries-included agent harness"，跑在 LangGraph runtime 上，两层（LangGraph 管 durable execution/streaming/HITL；harness 叠 middleware）。四件套：①Planning（`write_todos`，todo 列表 pending/in_progress/completed **持久化在 state 的 todos channel**）②虚拟文件系统（大工具结果卸载到 FS）③Subagents（`task` 工具派生，同步/异步、可 mid-flight steering）④详细系统提示 + Skills/AGENTS.md + 上下文管理（SummarizationMiddleware 摘要压缩+卸载）。
- 【HITL】`create_deep_agent(interrupt_on={工具名:{allowed_decisions:[approve/**edit（人改参数）**/reject（带 message）/**respond（人的话直接作为工具结果）**], when:谓词}})`；恢复 `Command(resume={"decisions":[...]})`，decisions 与 action_requests 一一对应、可批处理；子代理可自带 interrupt_on 覆盖父级（中断冒泡）；`FilesystemPermission(mode="interrupt")` 敏感路径写入触发审批。
- 【上下文管理】**isolated 模式**（默认，"子代理只看到被委派的任务"，父上下文零泄漏）/ **fork 模式**（beta，继承父历史+continuation preamble）；`response_format`（Pydantic）结构化回传；官方 best practice："让子代理回简洁摘要而非原始数据"。
- 【对应命题】③④⑤。
- 【借鉴什么/为什么/增益】
  1. **decisions 协议（approve/edit/reject/respond + when 谓词）直接移植为你 harness"人机协作节点"的决策 schema**——它就是 LangGraph interrupt 之上的"标准答案"。你的 AgentCollaborationPanel 已有 discuss/revise/submit，对齐这四档 + when 谓词（风险分级，不必每节点都要人）。→ 缺口④。
  2. **todos channel = 把计划持久化在 state 里暴露给前端**（节点状态可视化的低成本近似）。→ 缺口③。
  3. **isolated/fork 双模式 + "子代理只回摘要"作为默认上下文策略** → 命题⑤，与 Manus/Anthropic 一致。
  4. **文件系统卸载层：大产物落盘、上下文只留引用** → 命题④，你已做资产落盘，可补"上下文只留引用"。

#### A3. CrewAI Flows（~38k★，1.0）—— 事件流 + fork 分叉 + 自由文本反馈归类

- 【核心机制】装饰器事件流 `@start()/@listen(method)/@router()`，`or_()/and_()` 组合触发；状态 `self.state` 或 `Flow[PydanticState]` 结构化；`@persist` SQLite 持久化，`kickoff(restore_from_state_id=uuid)` 从快照**分叉**出全新 state.id（轻量 checkpointer + fork 语义）。
- 【HITL】Task 级 `human_input=True` 只审最终答案；Flow 级 `@human_feedback(message, emit=["approved","rejected"], llm)`：暂停等人给自由文本→LLM 解析成枚举 outcome 用于路由。
- 【借鉴/为什么/增益】①`@human_feedback(emit=[...])`：人给自由文本→LLM 归类枚举→驱动路由，比裸 approve/reject 更发挥人的表达力且成本低（缺口④交互）。②`restore_from_state_id` **fork 语义**：从历史快照分叉平行试跑、原流程不污染——适合"人给多个方案各跑一支"（命题③人机协作的试错）。③结构化 Flow[PydanticState] 强制状态 schema 化便于前端渲染。

#### A4. Microsoft Agent Framework（MAF，2026-04 GA）/ AgentScope（~36k★）/ OpenAI Agents SDK（~19k★）/ Mastra（~21k★，TS）

- **MAF**：AutoGen+Semantic Kernel 继任，SK 提供生产基座（遥测/企业集成），AutoGen 贡献图工作流；.NET+Python 统一 SDK。【增益】若未来要企业级持久化/合规审计可参考；**当前不必引入**（你已有 LangGraph）。
- **AgentScope**：显式控制流（SequentialPipeline/分支/循环/MsgHub 广播域可选加入）；`Msg` 最小传递单元；StateModule 嵌套 state；**"中断即事件"**——人打断 AI 时，LLM 半截回复、被打断的工具输出**保留进 memory 并打中断标注**，agent 带上下文续跑/改向。【增益】**人中断 AI 节点时把 partial output 存档标注而非丢弃**（命题③人机协作 UX 关键细节）；StateModule 嵌套状态范式。
- **OpenAI Agents SDK**：刻意少抽象，Handoffs=控制权交接即工具调用；`@tool(needs_approval=True)` 或异步谓词（fail-closed）；`RunState.to_json/from_json` 跨进程恢复；**`input_filter` 过滤交接时新 agent 视野、`nest_handoff_history` 把历史折叠成摘要段**。【增益】**所有"进入下一节点"的入口都过一道显式 history 裁剪函数**（上下文不爆炸第一道闸，命题④）；needs_approval 异步谓词=风险分级审批；RunState 序列化暂停恢复协议（缺口③）。
- **Mastra（与你同为 TS 栈，值得重点关注）**：图工作流 then()/branch()/parallel() + **suspend/resume 做 HITL**；`.network()` 把任意 agent 变成向子 agent 派活的 router；四层记忆（消息历史/工作记忆/语义召回/RAG）；MCP 原生、Zod schema 校验、内置追踪评测。【增益】你是 Electron+TS，Mastra 的 **suspend/resume HITL + Zod 契约 + .network() router** 与你现有 zod 全量校验、coordinator-host 同栈同构，是"TS 原生 how-to"的最佳参照（比 Python 框架更可直接抄代码）。

### 组 B：可视化工作流 / 平台类

#### B1. Dify（~159k★）—— "人编辑 AI 产出物"做得最完整

- 【核心机制】应用 DSL=YAML；Chatflow vs Workflow 节点不互通；变量引用取数；Human Input 节点处暂停，Service API（submit-human-input-form）提交后恢复。
- 【HITL】表单三要素（Markdown 说明 / 变量引用渲染上游草稿 / **Paragraph 可用变量预填=人在改 AI 的稿子**）+ 多按钮 `__action_id` 各连不同下游分支（Approve/Apply Edit/Regenerate）+ **超时分支**（默认 3 天，超时走兜底）+ 邮件外链免账号。警示：issue #32303 显示 2026-01 曾回滚修补，仍在打磨。
- 【借鉴/为什么/增益】你的 AgentCollaborationPanel 补三件事：**按钮→分支映射、超时分支、"预填产出物供直接编辑"**（缺口④交互）。预填 Paragraph 是最低成本"人编辑 AI 产出物"；`__action_id` 让人工动作成为下游可编程变量；超时分支让"人不在场"成为一等状态。**注意：头部产品的人机协作节点也在摸索，你并不算晚。**

#### B2. Coze Studio（~22k★，字节，Apache-2.0，Go/Eino）—— 中断/恢复数据模型范本 + 最小输入最强实现

- 【核心机制】前端画布 vo.Node 带 inputs/outputs，后端 NodeAdaptor 转 NodeSchema（含 **InputSources**：前驱节点输出字段映射 / InputTypes / 静态固定值）；节点执行体只需 `Invoke(ctx, input map) (output map)`——**输入就是"声明的字段映射合并后的 map"**（字面意义的最小且必要输入）；SettingOnError（重试/超时/降级/异常分支）声明即生效。
- 【HITL】**InterruptEvent 显式中断实体**（NodeKey/InterruptData/NodeType/**NodePath 嵌套路径**/SubWorkflowInterruptInfo）；恢复协议 **ResumeRequest**（ExecuteID+EventID+ResumeData，唯一恢复 ID `ExecuteID_EventID`）。
- 【借鉴/为什么/增益】①**InterruptEvent+ResumeRequest 模型**与你"显式状态机记录节点状态"几乎同构——缺口①接入账本回执事件时，事件结构照此（带节点路径、可嵌套、可序列化、唯一恢复 ID）。②**InputSources 逐字段映射**：你的 FixedNodeInputSchema（targetPortId+asset 引用）已同构，若要更细可学它的字段级粒度（命题④）。③SettingOnError 声明式异常策略。

#### B3. FastGPT（~30k★）—— AI 生成流程的三步交互范本（缺口②的产品化样板）

- 【核心机制】节点含输入（手动/变量引用）/输出/触发器；**连接线三态 waiting/active/skip**（前置线有 waiting 则等、有 active 则执行、皆无则跳过）；`INTERACTIVE_NODE_TYPES`（userSelect/formInput/agent）引擎级特殊调度（并行体禁用、循环内允许）。
- 【AI 生成】**辅助生成三步**（仅商业版，思想可借鉴）：①自然语言→AI 返回**流程图+方案说明**供检查修改；②AI 搭建+**配置校验**，生成"尚未写入画布"的版本；③用户"应用到画布"。支持增量修改。
- 【借鉴/为什么/增益】**这正是你缺口②要做的"AI 提案→静态校验→影响预览→用户确认"管线的产品化范本**；你的 BuildPreview（preview→authorize→confirm→discard）骨架已搭好。连线三态语义、"可中断节点集合"引擎级约束（你的 composite/并行分波对含 human waitKind 的节点应有同样调度约束检查）。

#### B4. n8n（~208k★，fair-code）/ Langflow（~156k★，MIT）/ Bisheng（~12k★）/ Flowise（EOL，设计参考）

- **n8n**：Workflow=纯 JSON（nodes[]+connections，公开稳定，适合 AI 生成后 API 导入）；Wait 节点四式 Resume（时间/指定时间/Webhook/**Form Submitted**），审批用 `$execution.resumeUrl` 一次性恢复链接；`typeVersion` 兼容机制。【增益】Wait 四式（尤其 resumeUrl）、表单字段规范、typeVersion（你节点契约已带 schema version，此条为确认）、"审批结果→IF/Switch 显式分支"。注意 Sustainable Use License 非纯开源。
- **Langflow**：组件级可视化，flows 可导出 JSON、**可部署为 MCP server（把整个 flow 暴露为工具）**，playground 逐步调试。【增益】flow 即 JSON 的可导出性 + MCP 化（你的 flow 未来可暴露为 MCP 工具给外部 Agent 调用）。注意 OSS 版 RBAC 不强制、编辑器跑任意 Python，多租户需自行隔离。
- **Bisheng**：不区分 chatflow/workflow（多轮对话与自动化可混排）；InputNode 双模式 dialog（LLM 生成推荐问题）/form；节点 `get_input_schema()` **自描述输入契约→前端据此渲染协作 UI**；用户输入 `save_context(msg_sender="human")` 写回会话历史（人是对话参与者）。【增益】**节点自描述输入契约→前端生成协作 UI**（缺口④：你的节点契约可驱动人机协作面板自动渲染）；dialog/form 双模式；LLM 推荐问题降低人的负担。
- **Flowise（EOL，仅设计参考）**：Agentflow V2 的 **Human Input 节点（暂停不阻塞线程、checkpoint 保存、重启可恢复）/ Flow State（$flow.state 运行时 KV，Start 节点声明 schema、操作节点只能更新预定义 key）/ Execute Flow（子流程调用）/ Condition Agent（LLM 路由）/ AI 生成 flow**。【增益/为什么】虽已 EOL，但它的 **Flow State"先声明 schema、只能更新预定义 key"** 与你 FixedNodeInputSchema 思路一致，可作"显式状态载体"的设计参考；其关停理由（僵化低代码触顶）反证你"AI 动态生成 + 人深度参与"的方向。**不要部署，只读设计。**

#### B5. Temporal（~24k★，生产级）/ Inngest agent-kit / XState + @statelyai/agent（~30k★）

- **Temporal**：**Event History**（每步记录状态、失败从最后事件恢复、Worker 无状态重放重建）；**Entity Workflow**（每个业务实体一个长生命周期 Workflow，Signals/Updates 驱动状态转换=每个流程实例一台持久化状态机）；官方 AI 页把 Agent 列首位（长时运行、有状态、等人介入、失败恢复）。【增益/为什么】**你的命令账本（pending/prepared/committed/unknown）语义上已是事件溯源变体**；缺口③ FlowRun 一等实体可参考 Entity Workflow："一次运行=一个可 Signal 的实体"；Signal=人机协作持久化原语；Activity 边界=上下文隔离（LLM 调用放 Activity 可重试可恢复）。
- **Inngest agent-kit**：`step.run` 切步、每步输出写 State store、断点续跑；`waitForEvent` 暂停等事件、`cancelOn` 取消；`createNetwork`（共享 network.state.kv + 消息历史，"带完全类型化状态机的对话历史"）；路由两种（代码路由函数 + Supervisor 路由 agent）；`onRoute` 生命周期回调保留人工控制点。【增益】typed state machine 状态载体、路由显式化可审计、onRoute=流转层人工卡点（缺口①③）。
- **XState + @statelyai/agent**：createMachine 纯 JS 嵌套对象（但 guards/actions 内联函数不可直接序列化→**AI 生成流程需把 guard/action 外置为具名实现，或"AI 只生成结构、宿主注入行为"**）；Actor model（每节点一个 actor=上下文隔离的结构对应物）；snapshot 持久化恢复；Stately Studio 可视化、Stately AI 可生成/修改机器、提供 MCP。@statelyai/agent 哲学："**The machine decides which work is legal; the host executes model calls**"：`decideNext`（让模型只输出该机器实际接受的事件，LLM 自由度被约束在合法转换集合内）、`describeMachine`（把机器渲染为纯文本给模型看=精简注意力上下文）、`getInteraction/eventFromInteraction`（渲染并校验人类交互，人通过标准 send 事件介入）、`isAgentIdle`（区分"机器在等人"vs"机器卡死"）、`log.replay/forkEventLog`。【增益/为什么】**decideNext+describeMachine 是"外部 Agent 动态构建/驱动 flow"最成熟的工程模式**（缺口②）；getInteraction 把人的输入统一收敛为机器事件（缺口④）；层级/并行状态图可表达三形态；snapshot+事件日志支撑显式状态机（缺口①③）。**describeMachine 直接解决你"喂给主 Agent 的上下文要精简"——只给机器的合法转换集合，不给全量历史（命题⑤）。**

### 组 C：子代理 / 上下文 / 人机协作协议类

#### C1. Claude Code Subagents / Agent SDK / Agent Teams（Anthropic 官方）—— "AI 生成节点定义 + 上下文隔离"现成实现

- 【核心机制】子代理定义=**Markdown+YAML frontmatter**（name/description/tools/disallowedTools/model/permissionMode/maxTurns/memory/hooks/isolation:worktree + 正文系统提示词），`.claude/agents/` 热加载——**"AI 生成 agent 定义"的现成文件协议**；SDK 程序化 `query({agents:Record<string,AgentDefinition>})`，流程定义可完全由 AI 产出 JSON。Agent Teams（实验）：lead+teammates 独立会话，通信走**文件信箱** `~/.claude/teams/{team}/inboxes/{agent}.json`；共享任务清单 pending/in progress/completed/blocked（依赖自动解锁）+文件锁防抢占。
- 【上下文管理】教科书级：每子代理**独立全新窗口**，只拿系统提示词+委派消息+CLAUDE.md 快照，**不继承对话历史和已读文件**；返回只有**摘要**；返回文本扫描转义防注入。并行上限 20、嵌套深度 3。委派提示四要素（目标、输出格式、工具边界）。
- 【人的参与】审批范式但介入点丰富：后台子代理权限提示冒泡回主会话并标注来源；teammate 可被中断/查看/发消息/停止；hooks ~30 种事件（PreToolUse 可 allow/deny/ask/defer、TaskCreated/TaskCompleted、TeammateIdle），exit code 2=阻断+stderr 回喂模型。**没有人作为节点执行者的形态。**
- 【借鉴/为什么/增益】①**frontmatter 作为节点 DSL**：你的 SkillPackageSchema 已非常接近（id/version/name/description/instructions/requiredTools/resources），可对照补 description 的"何时委派"语义（Claude 靠它决定何时委派）→ 缺口②。②**委派消息即最小输入 + 只回摘要 + 防注入扫描** → 命题④⑤，你 per-task 隔离已做，可补"输出入状态机前摘要压缩+指令扫描"。③**文件信箱 + 共享任务清单四态** → 缺口③④的轻量参照。

#### C2. HumanLayer + 12-Factor Agents（方法论 ~27k★）—— 方法论层最贴合你的项目

- 【核心机制】原为审批 SDK（human_as_tool，YC F24），已转型 Riptide。**方法论遗产 12-factor agents 是业界引用最多的 agent 工程方法论**：1 自然语言→工具调用；2 自有提示词；3 **自有上下文窗口**；4 工具即结构化输出；5 **统一执行状态与业务状态**；6 **简单 API 启动/暂停/恢复**；7 **用工具调用联系人类**；8 **自有控制流**；9 错误压缩回上下文；10 **小而聚焦的 agent**；11 从任意渠道触发；12 **agent 是无状态 reducer（状态=事件历史）**。
- 【Factor 7 代码】`RequestHumanInput{intent, question, context, options{urgency, format:free_text/yes_no/multiple_choice, choices}}`；循环中：保存状态→通知人→退出循环，等 webhook 带回 `response_from_human` 事件恢复。
- 【借鉴/为什么/增益】**Factor 5/6/8/12 拼起来就是你要的"显式状态机+可暂停恢复+AI 也可写控制流"**；Factor 7 是人机协作节点的协议模板（缺口④：直接照抄 `human_input_requested→response_from_human` 事件对，人的输入是事件流中又一个结构化事件，与 agent 动作同构，天然支持异步/审计）；Factor 10 支持你"每节点像 sub agent"。**但人仍是被召唤的 tool，没有"人拥有节点主动工作后交接"的形态——你的纯人节点是它的下一步。**

#### C3. A2A 协议（~26.5k★，Linux 基金会）—— 节点状态机最权威的协议级蓝本

- 【核心机制】Task=核心执行单元（id/contextId/status/artifacts[]/history[]/metadata）；**9 态生命周期**（submitted/working/completed/failed/canceled/**input-required**/auth-required/rejected/unspecified）；Message（role/parts[]/referenceTaskIds）；**Artifact**（artifactId/name/description/parts[]）=节点输出产物一等公民；AgentCard=能力发现；传输 JSON-RPC/gRPC/REST+SSE+webhook。官方对 MCP 分工："A2A 连接 agent 彼此；MCP 连接每个 agent 与自己的工具。两者并用。"
- 【借鉴/为什么/增益】**你的节点状态机几乎可直接用 Task 9 态做子集**（缺口①：对齐 A2A 命名，扩展 `human-working`（纯人执行中）与 `input-required`（等人输入），A2A 有正式 extensions URI 机制支持）；**Artifact=最小输入载体**（下游只拿 artifact+description 不拿上游全文，命题④）；`taskId+contextId` 双 ID 正好对应 run/node 两层状态（缺口③）；AgentCard 作"节点能力菜单"供外部 Agent 构建 flow 时查询（缺口②）。

#### C4. Letta/MemGPT（~25k★）/ OpenHands SDK（~93k★）/ GPT-Pilot（~33k★，反面）/ AFFiNE+BlockNote（产物共编）

- **Letta**：Agent 状态=system prompt+memory blocks+messages+tools 全持久化（"淘汰不删除"，out-of-context 可检索）；memory blocks 可编辑、可多 agent 共享挂载（shared blocks=共享状态）；core/archival/recall 三层记忆+sleep-time agents 后台整理；HITL 工具标 default_requires_approval，人 POST approval（approve+reason），**拒绝时 reason 变 tool error 回喂模型**。【增益】①驳回带 reason 回喂（缺口④返工）；②**shared memory block 作节点间"共享草稿板"**（选题共识块/框架块可被多节点挂载——比消息传递更适合"共写文章"，命题③）；③一切状态入库淘汰不删除（缺口③）；④sleep-time compute：人思考时后台 agent 预整理下一节点输入摘要（命题⑤）。注意 API 大迁移期。
- **OpenHands SDK**：事件=不可变 Pydantic append-only log，兼作记忆与集成点；每事件带 **source:user|agent|environment**；事件类型 MessageEvent/ActionEvent/ObservationEvent/**UserRejectObservation**/PauseEvent/压缩族（CondensationRequest→记录 forgotten_event_ids+summary→CondensationSummaryEvent）；agent 状态=事件历史确定性重放；Docker 沙箱 per conversation；confirmation mode 人确认，拒绝产生 UserRejectObservation 回喂可改道。【增益/为什么】**把"人节点的开始/产出/驳回"也设计成事件类型（source=user），状态机=事件日志投影**（缺口①③，三方归因映射你的三形态）；Condensation 三件套用于节点结束后上游上下文清理（命题④，历史压缩是一等事件、可重放/审计）。
- **GPT-Pilot（反面教材）**："AI 写 95% 代码，剩 5% 需开发者"→一步步写一步步确认；角色流水线 Spec Writer→Architect→Tech Lead→Developer→Code Monkey→Reviewer+Debugger/**Troubleshooter（帮人把模糊不满转成结构化反馈）**。【教训/增益】**确认步太碎=用户流失**（反证你的人必须落在高杠杆节点，不是全程点头）；Troubleshooter 模式="改稿意见结构化节点"（缺口④）。**已弃维+2025-08~2026-06 供应链投毒，只读不部署。**
- **AFFiNE（~74k★）/ BlockNote AI**：AFFiNE doc+白板+数据库三合一，CRDT 协同（BlockSuite/y-octo），AFFiNE AI co-writing——**最接近"人与 AI 共改同一产出物"的成熟开源底座**（但 AI 是副驾不是流程节点）；BlockNote `@blocknote/xl-ai`：**AI 建议以块级 diff 呈现、用户接受/拒绝、支持多步 HITL**，模型无关（Vercel AI SDK 之上）。【增益】**最适合做你"写作节点"的嵌入组件**（命题③产物共编）；注意 xl 包 copyleft+商用需付费许可。

### 组 D：质量与理论（本版新增，见第二节展开）

- **Chroma Context Rot / Lost-in-the-Middle / Same-Task-More-Tokens / GSM-IC**：你的命题④⑤的实证地基。
- **Anthropic 多代理研究系统 + Effective Context Engineering + Building Effective Agents**：隔离+摘要+checkpoint 人介入的量化与范式背书。
- **Manus 上下文工程六原则三策略**：与你设计逐条同构的工程范本。
- **Cognition Don't Build Multi-Agents**：最强反方，第二节已 reconcile。
- **AFlow（ICLR 2025）/ ADAS / GPTSwarm / AutoFlow / DSPy**：AI 自动生成 workflow 的学术线（命题①背书）。AFlow 用 MCTS 在代码表示的 workflow 空间搜索，节点+算子+边，小模型以 4.55% 成本超 GPT-4o——**你不必照搬 MCTS，"LLM 生成 + 试跑反馈"即可，但这条线证明"AI 生成 flow"可行且能提质降本。**
- **mixed-initiative（Horvitz, CHI'99, 引用 2500+）**：人与 AI 双方都可主动发起行动；系统用决策理论权衡"行动价值 vs 打断成本"；不抢占注意力、行动可见可逆、支持表达不满并学习。**你的三形态本质是 mixed-initiative 的工程化，且业界没人做"人主动"这一形态。**

---

## 五、核心产出：借鉴清单矩阵（项目 → 借鉴什么 → 为什么 → 对应缺口 → 落地 → 增益）

> 这是本报告的落地核心。按你的 4 个缺口 + 质量护城河组织，每条都回答"为什么需要借鉴"和"对本项目的增益"。优先级：P0=立刻吃（你 harness 已在用/同栈）、P1=补闭环、P2=建壁垒。

### 5.1 缺口①：状态机与节点完成的自动闭环（最重要，难度中低）

| 来源项目 | 借鉴什么 | 为什么需要 | 落地方式 | 对本项目增益 | 优先级 |
|---|---|---|---|---|---|
| **A2A 协议** | Task 9 态生命周期（含 input-required）+ extensions 机制 | 你的任务级状态机已接近，但缺权威命名与"等人"态 | 对齐 A2A 命名，扩展 `human-working`/`input-required` 两态 | 节点状态有协议级蓝本，可对外互通 | P1 |
| **Coze Studio** | InterruptEvent（NodeKey/NodePath 嵌套）+ ResumeRequest（ExecuteID_EventID 唯一恢复 ID） | 你的声明式状态机节点首版只接受人工提交事件，缺可信事件源 | 把**命令账本回执/资产版本登记**作为合法事件源接入状态机执行器，事件结构照 Coze（带节点路径、可嵌套、唯一恢复 ID） | 节点完成→状态机自动迁移→释放下游，守住"只认账本回执不认模型自述"铁律 | P1 |
| **OpenHands SDK** | 事件溯源 + source:user\|agent\|environment 三方归因 | 你的三形态分散在不同节点配置，缺统一事件模型 | 人节点的开始/产出/驳回都设计成事件类型，状态机=事件日志投影 | 三形态可审计、可回放、可归因 | P1 |
| **LangGraph** | checkpointer metadata.writes + get_state_history() | 你已在用但没吃满 | 用 get_state_history 给前端画"节点状态时间线" | 缺口③可视化低成本实现 | P0 |
| **XState** | snapshot + 事件日志 replay/fork | 状态机需可恢复可分叉 | 你的账本已是事件溯源变体，补 snapshot 语义 | 一次运行可暂停/恢复/回放 | P1 |

### 5.2 缺口②：外部 Agent 动态构建 flow（你的核心卖点，难度中高）

| 来源项目 | 借鉴什么 | 为什么需要 | 落地方式 | 对本项目增益 | 优先级 |
|---|---|---|---|---|---|
| **FastGPT** | 辅助生成三步法（方案图→校验→应用画布）+ 增量修改 | 你缺"AI 提案→静态校验→影响预览→用户确认"完整管线 | 你的 BuildPreview（preview→authorize→confirm→discard）骨架已搭好，照三步法补全 | 外部 Agent 真正"构建方"化，且生成质量可控 | P2 |
| **Claude Code Subagents** | frontmatter 节点 DSL（name/description/tools/model/isolation + 正文提示词） | 你的 SkillPackageSchema 已接近，缺"何时委派"语义 | 对照补 description 的委派语义；让外部 Agent 产出该 JSON | AI 可生成且人可读改的成熟文件协议 | P2 |
| **A2A AgentCard** | name/description/skills/capabilities 能力发现格式 | 外部 Agent 构建 flow 时需"能力菜单"可查 | 你的 agent-access registry（~130 操作）+ 上帝 Agent 能力目录统一成 AgentCard 式 | 构建方有菜单可查，覆盖任意垂类 | P2 |
| **XState @statelyai/agent** | decideNext（约束模型只输出合法事件）+ describeMachine（精简上下文） | 放开能力目录/拓扑后 AI 生成的 flow 可能类型不匹配/死循环 | 静态校验器（端口类型/环检测/Participation 合法性）+ describeMachine 喂主 Agent | 生成质量可控 + 主 Agent 注意力集中 | P2 |
| **AFlow（学术）** | "LLM 生成 + 试跑反馈"即可，不必照搬 MCTS | 证明 AI 生成 flow 可行且提质降本 | 你的 flow 解释器 + 试跑反馈循环 | 命题①的学术背书与降本路径 | P2 |
| **n8n** | workflow JSON typeVersion | 引擎演进不破坏旧流程 | 你节点契约已带 schema version（确认而非新增） | 跨版本兼容 | P0 |

> **战略级建议（全网空白，你最能建壁垒）**：在你的 LangGraph harness 上定义一个**可序列化的 flow 定义 schema**（节点三形态 + 各自最小输入 schema + interrupt 决策集），让外部 Agent 产出该 JSON，harness 编译成 StateGraph 执行——**把现有底座变成"flow 解释器"**。全网没有编排框架原生支持"外部 Agent 动态构建 flow"（LangGraph 拓扑须代码编译，Send 只能动态分支数）。这一层没有现成品，是你的壁垒位置。

### 5.3 缺口③：FlowDefinition / FlowRun 一等抽象（难度中）

| 来源项目 | 借鉴什么 | 为什么需要 | 落地方式 | 对本项目增益 | 优先级 |
|---|---|---|---|---|---|
| **Temporal** | Entity Workflow（一次运行=一个可 Signal 的实体）+ Event History | 你的运行态分散在 flow_agent_tasks/flow_coordination_scope/composite_runs 三处，无权威聚合实体 | 建 flow_run 聚合视图 + 事件日志，参考 Entity Workflow | 一次流程运行可暂停/恢复/总览/回放 | P1 |
| **OpenHands** | source 三方归因 + Condensation 三件套 | 运行历史需可审计、上下文需可清理 | 事件日志带 source；节点结束后上游上下文压缩成一等事件 | 运行可回放、上下文不膨胀 | P1 |
| **Inngest agent-kit** | typed state machine + network.state.kv + onRoute 人工卡点 | 路由需显式可审计 | 路由显式化为可编程函数，onRoute 插人机卡点 | "谁下一个执行"可审计 | P1 |
| **Letta** | 一切状态入库、淘汰不删除 | 运行态需持久可检索 | 你的 SQLite 层补 flow_events 全套表 | 状态不丢、可检索 | P1 |

### 5.4 缺口④：纯人任务形式化（你的差异化卖点，难度中）

| 来源项目 | 借鉴什么 | 为什么需要 | 落地方式 | 对本项目增益 | 优先级 |
|---|---|---|---|---|---|
| **HumanLayer 12-Factor** | Factor 7 `human_input_requested→response_from_human` 事件对 | 你的人机协作面板挂在 Agent 节点上，不是通用任务待办 | 照抄事件对作人机协作节点骨架；给节点加统一 Participation（autonomous/collaborative/human）声明 | 纯人节点成为一等公民，人的参与有统一入口 | P1 |
| **deepagents** | decisions 协议（approve/edit/reject/respond + when 谓词） | 你的 discuss/revise/submit 缺标准决策集与风险分级 | 直接落在你现有 LangGraph harness 的 interrupt 之上 | 人机协作决策有"标准答案"，不必每节点都要人 | P0 |
| **Dify** | Human Input（变量预填编辑产出物 + 多按钮分支 + 超时分支） | 人编辑 AI 产出物的交互最完整 | AgentCollaborationPanel 补按钮→分支、超时分支、预填编辑 | "人改 AI 稿子"最低成本实现 | P1 |
| **Letta** | 驳回带 reason 回喂 | 人驳回意见需结构化回喂下游 | 返工机制中人工驳回意见结构化回喂 agent | 返工质量提升 | P1 |
| **LangGraph** | interrupt(response_schema) | 纯人节点需原生实现路径 | 人的产出作为 interrupt() 返回值，节点从函数头重跑（副作用幂等） | 纯人节点不用引外部框架 | P0 |
| **A2A** | input-required 态 + 扩展 human-working | 纯人执行中需协议态 | 状态机扩展两态 | 纯人节点可对外表达 | P1 |
| **Bisheng** | get_input_schema() 自描述→前端渲染协作 UI | 人机协作面板需按节点契约自动生成 | 节点契约驱动面板渲染 + dialog/form 双模式 + LLM 推荐问题 | 协作 UI 自动化、降低人的负担 | P1 |
| **AgentScope** | 中断即事件 + 保留半截产物 | 人中断 AI 时不该丢半成品 | partial output 存档+标注+作返工上下文 | 人机协作 UX 关键细节 | P1 |
| **AFFiNE / BlockNote** | 产物级共编（块级 diff 接受/拒绝） | 写作节点需"人与 AI 共改同一产出物" | BlockNote xl-ai 嵌入写作节点（注意 copyleft+商用许可） | 命题③产物共编的成熟组件 | P2 |

### 5.5 质量护城河（命题④⑤，你已有的强项 + 可补）

| 来源 | 借鉴什么 | 为什么需要 | 落地方式 | 增益 | 优先级 |
|---|---|---|---|---|---|
| **Manus** | 文件系统即记忆 + 复述（重注入目标）+ 隔离 + 压缩可还原 | 对抗 context rot，与你的设计逐条同构 | 你已做资产落盘+状态机重注入+per-task 隔离；补"压缩留指针可还原" | 命题④⑤的工业级背书 | P0 |
| **Anthropic / Claude Subagents** | 子代理只回摘要 + 返回文本防注入扫描 | 节点输出入状态机前需压缩+防注入 | 输出摘要压缩 + 指令扫描转义 | 上下文不爆炸、防伪造系统提醒 | P0 |
| **OpenAI Agents SDK** | input_filter / nest_handoff_history 交接裁剪 | 进入下一节点的入口需裁剪历史 | 所有"进入下一节点"入口过一道显式 history 裁剪函数 | 上下文不爆炸第一道闸 | P0 |
| **OpenHands** | Condensation 三件套（压缩是一等事件、可重放） | 节点结束后上游上下文需清理 | 历史压缩成 CondensationSummaryEvent | 上下文可审计地精简 | P1 |
| **XState** | describeMachine（只给合法转换集合，不给全量历史） | 主 Agent 上下文要精简 | coordinator-host 喂主 Agent 只给机器合法转换集合 | 主 Agent 注意力集中 | P0 |
| **LangGraph JS** | UntrackedValue（大产物不进 checkpoint） | 防大中间产物撑爆 SQLite | 草稿/原始抓取标 UntrackedValue | checkpointer 不膨胀 | P0 |
| **Chroma / Lost-in-Middle** | 关键指令放开头/结尾、最小高信号 token 集 | 注意力 U 形曲线 | 节点提示把目标/约束放首尾，中间放参考 | 单节点产出质量提升 | P0 |

---

## 六、战略建议：三个你能建立的位置

1. **flow 解释器（壁垒）**：可序列化 flow 定义 schema（三形态 + 最小输入 schema + interrupt 决策集）→ 外部 Agent 产出 JSON → harness 编译成 StateGraph 执行。全网无现成品（AFlow 是学术、未产品化；LangGraph 拓扑须代码编译）。**这是你最能建壁垒的位置。**
2. **human-as-executor（差异化）**：纯人节点全网开源空白。最接近的是 LangGraph interrupt（人接管返回值）+ deepagents respond（人的话直接作为工具结果）的组合，但两者都仍把人当"AI 流程的被调用方"，没有人拥有节点的执行主权。配合 mixed-initiative 理论 + AFFiNE/BlockNote 产物共编，**这条路没有现成竞品，建议做成可对外讲的差异化主张。**
3. **质量护城河（可信度）**：你的"最小必要输入 + 隔离 + 产物契约"不是审美，是对抗 context rot 的工程必需，有 Chroma/Anthropic/Manus 三方背书。**对外讲方案时，用第二节证据 + 第 2.4 节 Cognition reconcile，能挡掉绝大多数质疑。**

---

## 七、风险与避坑

### 7.1 选型红旗（不要踩）

- **claude-flow/Ruflo（~81k★）**：记忆层不稳（issue #530/#695）、营销水分大、自报 benchmark 不可信、社区反馈"装了它 Claude Code 变笨"。**反面教材：过度营销+自报 benchmark 是选型红旗。**
- **GPT-Pilot**：已弃维 + 供应链投毒，**只读不部署**。
- **Letta**：API 大迁移期，引入需评估稳定性。
- **HumanLayer**：主体已转型 Riptide，方法论（12-factor）仍可借鉴，产品别依赖。
- **Flowise**：EOL，只读设计/fork，别作基座。
- **AutoGen 本体**：维护模式，新项目看 MAF。
- **MetaGPT 开源**：停滞→MGX，仅作思想参考（SOP/订阅式最小投递/AFlow）。
- **OpenAI Agents SDK HITL**：只有 approve/reject（比 deepagents 少 edit/respond），别指望它做深度人机协作。
- **Dify Human Input**：仍在打磨（2026-01 曾回滚）——说明头部产品也在摸索，你并不算晚。

### 7.2 产品风险（不是技术）

1. **验证缺失是最大风险**：全链路验收跑通 ≠ 真实垂类任务好用。**立刻做一个真实公众号文章端到端 demo**（选题→搜索→框架→写作→配图→审核→发布），你自己当用户跑 3–5 篇，记录：哪里想介入但介入不了、哪里输入不够"最小"、哪里状态机没推进。
2. **人的参与深度 ≠ 参与频率**：GPT-Pilot 教训（每步都要人确认→用户流失）反证：人的介入必须落在**高杠杆节点**（选题/框架/终审），而不是每步点头。把"哪些节点该人做"交给 flow 构建方声明，而不是全默认人机协作。
3. **AI 生成 flow 的质量风险**：放开能力目录/拓扑后可能类型不匹配/死循环。必须配套静态校验（端口类型/环检测/Participation 合法性），参考 FastGPT"生成→校验→应用"。
4. **Cognition 反方**：对外必须能回答"多代理不可靠"——用第 2.4 节 reconcile（你做的是串行+人把关+显式契约，不是并行自主决策）。
5. **单用户本地天花板**：当前本地单用户，若未来协作/云端，账本与 SQLite 层需迁移设计（现在不用管，但别把 SQL 方言写死）。

---

## 八、落地路线（结合你的 4 缺口，按优先级）

| 阶段 | 内容 | 借鉴来源 | 产出 |
|---|---|---|---|
| **第 0 步：验证**（立即） | 用现有系统手工搭"公众号文章 flow"（chat 选题→agent 搜索→collaborative 框架→agent 写作→ai-review→纯人终审），自己跑 3–5 篇真实文章 | — | 缺陷清单 + 参与度体验记录，决定缺口①④优先级 |
| **第 1 步：补闭环** | 账本回执接入声明式状态机事件源；节点统一 Participation 声明；interrupt 加 response_schema；UntrackedValue + recursionLimit 自查 | A2A/Coze/OpenHands/LangGraph/deepagents | 节点完成自动推进状态机；"谁在干活"一目了然 |
| **第 2 步：人工待办** | HumanTask 队列 + "待你处理"收件箱；人驳回带 reason 回喂；预填编辑+超时分支 | HumanLayer Factor7/Dify/Letta/Bisheng | 纯人节点成为一等公民，人的参与有统一入口 |
| **第 3 步：FlowRun 实体** | flow_run 聚合视图 + 事件日志（source 三方归因）；get_state_history 画时间线 | Temporal Entity Workflow/OpenHands/Inngest | 一次运行可暂停/恢复/总览/回放 |
| **第 4 步：开放构建** | 扩 BuildPlan 能力目录与拓扑（条件/循环/子流程）、静态校验器、AI 提案→预览→确认管线；flow 解释器 schema | FastGPT/Claude frontmatter/A2A AgentCard/XState/AFlow | 外部 Agent 真正"构建方"化，覆盖任意垂类 |

> 难度判断（与可行性报告一致）：没有一项是研究级难题，都是工程整合。基础运行时（账本/隔离/Skill/协调宿主）是最难的 70%，你已完成。剩下 30% 是四件明确的工程整合工作。

---

## 九、一句话结论

**你的设想完全现实，且已完成约 70%（恰好是最难的基础运行时）。** 业界没有单一项目等于你的设想，但协议（A2A/12-Factor）、框架（LangGraph/deepagents/XState）、范式（Manus/Anthropic/mixed-initiative）三层都有可直接组合的积木。**你的两个独有位置——"flow 解释器"（全网空白壁垒）与"human-as-executor 纯人节点"（全网空白差异化）——没有现成竞品，建议优先验证并做成对外主张。** 你的"最小必要输入"方向有 Chroma/Anthropic/Manus 硬证据支撑，唯一要正面回答的反方（Cognition）已被你的"串行+人把关+显式契约"设计避开。

---

## 十、来源清单（2026-11-13 核实）

> star 数为 2026-10 第三方追踪约值（GitHub API 本机直连被限流 403，未能取当日精确值）；近况以官方公告/文档为准。

**编排框架（组 A）**
- LangGraph：github.com/langchain-ai/langgraph、langchain-ai/langgraphjs；docs.langchain.com/oss/javascript/langgraph/graph-api（interrupt/Command/UntrackedValue/recursionLimit）
- deepagents：github.com/langchain-ai/deepagents；docs.langchain.com/oss/python/deepagents/human-in-the-loop（decisions/isolated/fork）
- CrewAI：github.com/crewAIInc/crewAI；docs.crewai.com/concepts/flows（@human_feedback/@persist/restore_from_state_id）
- Microsoft Agent Framework：github.com/microsoft/agent-framework；learn.microsoft.com/agent-framework（2026-04-03 GA，AutoGen+SK 继任）
- AgentScope：github.com/agentscope-ai/agentscope；arxiv.org/html/2508.16279v1（中断即事件）
- MetaGPT/AFlow：github.com/FoundationAgents/MetaGPT、FoundationAgents/AFlow；arxiv.org/abs/2410.10762（ICLR 2025）
- OpenAI Agents SDK：github.com/openai/openai-agents-python；openai.github.io/openai-agents-python/handoffs（input_filter/needs_approval/RunState）
- Mastra：github.com/mastra-ai/mastra（TS 原生，suspend/resume HITL、.network()、四层记忆）

**可视化平台（组 B）**
- Dify：github.com/langgenius/dify；docs.dify.ai/en/guides/workflow/node/human-input（预填编辑/多按钮/超时分支）
- Coze Studio：github.com/coze-dev/coze-studio（InterruptEvent/ResumeRequest/InputSources，backend/domain/workflow/entity/interrupt_event.go）
- FastGPT：github.com/labring/FastGPT；doc.fastgpt.io/zh-CN/guide/build/workflow/assisted-generation（三步法/连线三态）
- n8n：github.com/n8n-io/n8n（Wait 四式/resumeUrl/typeVersion，Sustainable Use License）
- Langflow：github.com/langflow-ai/langflow（flow JSON/MCP 化，MIT）
- Bisheng：github.com/dataelement/bisheng（dialog/form/get_input_schema）
- Flowise：github.com/FlowiseAI/Flowise（**EOL**：discussion #6727、flowiseai.com/sunset；2026-07-29 冻结/08-13 归档/08-31 EOL；社区 fork Flow-Wiser）；docs.flowiseai.com/using-flowise/agentflowv2（设计参考）
- Temporal：github.com/temporalio/temporal；docs.temporal.io/durable-execution、docs.temporal.io/ai.md（Event History/Entity Workflow/Signal）
- Inngest agent-kit：github.com/inngest/agent-kit（typed state/network.state.kv/onRoute）
- XState：github.com/statelyai/xstate；stately.ai/docs/packages/agent（decideNext/describeMachine/getInteraction）

**子代理/上下文/协议（组 C）**
- Claude Code Subagents：code.claude.com/docs/en/sub-agents；anthropic.com/engineering/multi-agent-research-system（frontmatter/隔离/摘要/防注入/Teams 文件信箱）
- HumanLayer 12-Factor：github.com/humanlayer/12-factor-agents（Factor 5/6/7/10/12）
- A2A：github.com/a2aproject/A2A；a2a-protocol.org/latest/specification（Task 9 态/Artifact/AgentCard）
- Letta：github.com/letta-ai/letta；docs.letta.com/guides/agents/human-in-the-loop（memory blocks/approval reason 回喂/sleep-time）
- OpenHands：github.com/All-Hands-AI/OpenHands；docs.openhands.dev/sdk/arch/events（source 三方归因/Condensation/UserReject）；arXiv:2511.03690
- GPT-Pilot：github.com/Pythagora-io/gpt-pilot（**弃维+供应链投毒，只读**）
- AFFiNE：github.com/toeverything/AFFiNE；BlockNote：github.com/TypeCellOS/BlockNote（@blocknote/xl-ai 块级 diff HITL）

**质量与理论（组 D）**
- Chroma Context Rot：github.com/chroma-core/context-rot（2025-07，18 模型全退化）
- Lost in the Middle：arxiv.org/abs/2307.03172（Liu et al., TACL）
- Same Task More Tokens：arxiv.org/abs/2402.14848；GSM-IC：arxiv.org/abs/2302.00093
- Anthropic：anthropic.com/engineering/multi-agent-research-system（+90.2%/~15× token）、anthropic.com/engineering/effective-context-engineering-for-ai-agents、anthropic.com/research/building-effective-agents（六模式/orchestrator-workers）
- Manus：manus.im/blog/Context-Engineering-for-AI-Agents-Lessons-from-Building-Manus（六原则三策略）
- Cognition：cognition.ai/blog/dont-build-multi-agents（Walden Yan，2025-06-12）
- AFlow/ADAS/GPTSwarm/AutoFlow/DSPy：arxiv.org/abs/2410.10762、arxiv.org/abs/2408.08435（ADAS）
- mixed-initiative：Horvitz《Principles of Mixed-Initiative User Interfaces》CHI'99

**本项目内部锚点**
- agent-flow-feasibility-analysis-20261112.md（4 缺口/5 命题/现状盘点）
- agent-flow-opensource-research-20261112.md（上一版，本报告核实更新）
- source/docs/canvas-agent-flow/00-approved-plan.md（已确认实施路径）
- source/AGENTS.md、source/AGENT_PARITY_SPEC.md（三入口一致性铁律）

---

*报告完。如需 Word/PDF 版本或针对某一项目（如 Mastra TS 实现、XState flow 解释器 schema）的落地代码草案，可继续展开。*