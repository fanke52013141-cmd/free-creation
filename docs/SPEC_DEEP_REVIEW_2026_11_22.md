# Canvas Studio 规范体系深度审查报告 · 2026-11-22

> **基线**：`source` 仓库 `main = 99a30b6e`（2026-11-22 00:05）
> **范围**：节点规范 · 节点间对接（连线/数据包）规范 · 节点流（composite）规范 · Agent Flow（上帝 Agent / 主 Agent / 状态机 / 三形态节点 / 最小输入输出）规范 · Agent 对接（CLI/MCP）规范 · UI 规范与 UI 展示规范
> **方法**：逐份阅读权威文档，并把关键条款与 `src/` 实现逐条核对。所有 ❌ 级结论都附 `文件:行号` 证据；无法完全坐实的，标注为「需用例确认」。
> **与 11-20 报告的关系**：不重复罗列 11-20 报告已经列出的条目，只在**这些条目在 main 上的真实状态**有变化时引用（见第一章，变化很大）。

---

## 〇、一页结论

1. **11-20 那轮「P0 全部已实施」的修订，实际不在 main 上。** 2026-11-20 20:02:38 的一次 `reset: moving to origin/main` 丢弃了 5 个未推送的提交（规范修订、P0 代码修复、task-bind 白名单修复、两份门禁测试）。这些提交只保存在 `backup/main-before-sync-20261120-200237` 分支上。结果是 main 上的规范**重新回到了 11-20 审查前的状态**，而且 Agent Flow 里有一个已知 bug 重新出现了。**这是最优先要处理的事项**（第一章）。
2. **你设计的三层模型（基础节点 → 节点流 → Agent Flow），在第 2 层到第 3 层之间是断开的。** Agent Flow 的图编译器只认 7 个硬编码能力；节点流（composite）既不能作为 FlowGraph 能力节点，也不是 Agent 可调度目标。所以「把节点流当成扩展能力交给 Agent Flow 编排」**目前在规范和实现上都做不到**。这是对能力扩展影响最大的一处（A1）。
3. **Agent Flow 的图模式（上帝 Agent 建图 → 声明式路由流转）有 5 处执行语义漏洞，会让流程卡住不动。** 具体包括：条件分支没有「死路径消除」，没有校验分支条件是否互斥，多节点循环无法执行，控制边在校验时有、执行时被丢弃，零输出节点永远不算交付。卡住时，系统统一报成「等待人工」，用户分不清是该自己操作，还是流程已经死锁（第三章）。
4. **（已决策 → 角色化单用户）「人和 AI 在每个节点协作扭转」中的「人」，在规范里只有一个本机用户。** 规范没有参与者、负责人、收件箱或通知模型，这和你说的「多人沟通交流」之间有一处根本性冲突，需要你来决策（A4）。
5. **（补充）外部 Agent 可以自己确认建图落画布，也可以代替人提交人工任务**（A6）。这让「上帝 Agent 只提案、人来确认」和「人独立完成的节点」这两条承诺都失效了，列为 P0。
6. **节点契约和连线规则这一层是整个项目最扎实的部分**：129 项连线矩阵测试、注册期硬校验、不可变资产版本、命令台账幂等、「模型文字不能改路由/不能赋成功」铁律都已经到位。问题集中在三处：**规范文本治理**（变更记录和规范混写、多处同时自称「当前权威」、计数漂移），**组合层的口径不一致**（节点流的连线兼容规则与画布不同），以及**状态语义缺口**（skipped、stale、需核对等状态没有统一定义）。

| 规范域 | 权威文档 | 文本质量 | 与实现一致性 | 对能力扩展的风险 | 结论 |
|---|---|---|---|---|---|
| 节点契约 | NODE_CONTRACT_SPEC.md | ★★☆ 变更记录压正文、编号重复 | 高（核心契约一致），数值有漂移 | 中 | 修订后可冻结 |
| 节点间对接 | NODE_CONTRACT_SPEC §2/§4/§5/§6 | ★★★ | 高（连线矩阵把守） | 低~中（缺 skip/stale 语义） | 补语义后可冻结 |
| 节点流（composite） | NODE_CONTRACT_SPEC §8.0（仅 7 条原则） | ★☆☆ 语义几乎全在代码注释里 | 中（与画布口径不一致） | **高** | 需要独立成文 |
| Agent Flow | 52 份文档 + 仓外 11-14 方案 | ★☆☆ 无单一权威 | 中（图模式有执行漏洞） | **高** | 需要收敛 + 修语义 |
| Agent 对接 | AGENT_ACCESS / AGENT_PARITY | ★★☆ | 骨架高，main 上 P0 回退 | 中 | 先恢复丢失的修复 |
| UI / UI 展示 | NODE_UI_STANDARD 等 | ★☆☆ 9 处「当前权威」叠层 | 中高 | 中（Agent Flow 状态无 UI 规范） | 需重写为单一现行版 |

---

## 一、🚨 P0-0：11-20 的规范修订与修复已经从 main 丢失

### 证据

`.git/logs/HEAD`（reflog）记录了下面这些操作：

```
48833f2c 2026-11-20 01:57:23 test(node-flow): 节点流封装组合端到端集成测试 17 项 + UI/契约守卫断言校准
7baf9d3a 2026-11-20 01:57:40 fix(agent-access): 规范审查 P0 代码修复——幽灵契约清理、MCP 注解如实化、composite.execute 计费门与键约定、outputSource 双表对齐
4e581d58 2026-11-20 01:57:50 fix(agent-flow): runtime task-bind 工具白名单与 desktop 准入同口径
ff54f212 2026-11-20 01:57:59 chore(ui): 旧尺寸时代注释校准
2172c9fe 2026-11-20 01:58:23 docs(specs): 规范体系全面审查修订（四域 P0 全量）+ 报告归档
2172c9fe -> 71facfad 2026-11-20 20:02:38 reset: moving to origin/main        ← 上面 5 个提交被丢弃
```

- 从 `main` 往回走 first-parent 链，找不到上述任何一个提交。
- 这 5 个提交只存在于分支 `backup/main-before-sync-20261120-200237`（指向 `2172c9fe`）。
- 规范文件的修改时间正好都是 `2026-11-20 20:02:38`，和这次 reset 的时间完全一致。

### main 上现在的实际状态（逐项核对）

| 11-20 报告宣称已完成的修复 | main 现状 | 证据 |
|---|---|---|
| AGENTS.md 4 处过时描述 | **仍过时**：仍写「25 项外部操作」「v1.3 §19」「五大分类主色」「这是待实施设计」 | `AGENTS.md:25 / :34 / :55 / :98` |
| Speech 规范补 indextts | **未补**：规范仍写 `'minimax' \| 'volc'` | `NODE_CONTRACT_SPEC.md` §4.4 vs `src/shared/speech.ts:13` |
| MCP 注解如实化 | **未修**：所有操作 `idempotentHint: true`，任何写操作都标 `destructiveHint` | `src/local-agent/index.ts:67-69` |
| composite.execute 计费门 + 键约定 | **未修**：`ops/composite.ts` 里没有任何 confirm/cost 逻辑 | grep 无匹配 |
| task-bind 工具白名单同口径 | **bug 已回归**：桌面准入允许 `web.search@1`，运行时 task-bind 却拒绝一切非 `node.execute@1` 工具 → 勾选联网的专家 Agent 会报 `AGENT_TOOL_UNSUPPORTED` | `desktop-host.ts:280` vs `runtime.ts:474-479` |
| 双表门禁测试 `output-source-parity.test.ts` | **文件不存在** | — |
| 节点流 e2e 17 项 `node-flow-e2e-composition.test.ts` | **文件不存在** | — |
| AGENT_ACCESS_SPEC 计数 | 仍写「当前 Registry 已实现 25 项操作」 | `AGENT_ACCESS_SPEC.md:6` |
| 合规矩阵 C1 表 | 仍写「自动执行尚未接入」 | `docs/NODE_COMPLIANCE_MATRIX.md:55` |

### 处置建议

1. **立即**：把 `backup/main-before-sync-20261120-200237` 上的 5 个提交 rebase 或 cherry-pick 回 main。之后 11-21 的提交（弹窗规范等）可能产生冲突，需要逐个解决。合回后跑 `npm run verify`、`guard:agent-parity`、`verify:logging` 三道门禁。
2. **防复发**：规范的修订必须当天推送到 origin；增加一个 `pre-sync` 脚本，在 `reset/pull --rebase` 之前检查是否有未推送的提交，有就阻断；审查报告里「已修复」的结论要附 `commit hash + 已在 origin/main` 的证明。
**✅ 已恢复（2026-11-22 13:22）**：5 个提交已合回 main（`7e36dd8` `ccd5057` `5cb530c` `32411ef` `b09dacc`），契约快照已重新生成（`39610ae`），规范草案已提交（`c293701`），并推送到 origin/main（`2e221e7..c293701`）。门禁 verify:agent-access / guard:agent-parity / verify:logging / test:contract（331 项）/ 恢复的定向测试（283 项）全部通过。上表 9 项已逐一复核生效。事前分析如下（实际只有 change-impact.json 一处冲突）：已离线完成三方冲突分析，以共同祖先 `35c43431` 为基准：
- 5 个丢失提交共改动 47 个文件，其中 8 个在 main 上也有改动；
- 真正有冲突的只有 3 处：`node-ui-decisions.test.ts` 的连线线宽断言（保留 main 一侧）、`LOGGING_COVERAGE.md` 和 `02-capability-matrix.md` 的文末追加（两边合并保留）；
- 2 个生成文件（`contracts.json`、`change-impact.json`）在合并后重新生成；
- 其余 3 个双方都改过的文件，改动段落不重叠。

3. **结论**：报告声明「已修复」和代码实际状态之间缺少一致性检查，这本身就是一个规范漏洞。**后文所有结论都以 main 的实际状态为准。**

---

## 二、架构层：你的三层模型与现有规范的对照

你描述的目标：

```
基础节点 ──串联/并联──▶ 节点流（扩展能力） ──编排──▶ Agent Flow
                                                   ├ 外部上帝 Agent：构建整个任务流程
                                                   ├ 主 Agent + 状态机：负责流转
                                                   └ 每节点：人 / AI / 人+AI，最小必要输入 → 输出
```

现状对照：

```
基础节点(37 类) ──✅──▶ composite 节点流（确定性 DAG、固定版本发布）
                              │
                              ✖ 无法作为 FlowGraph 能力，也不是 Agent 调度目标
                              ▼
Agent Flow：4 种执行模式并存
   ① 主控 LLM 自由协调（默认，靠模型决策 + maxSteps）
   ② fixed-order 固定阶段（AF-01）
   ③ graph 图模式（O4，FlowGraph IR → 编译落画布 → 声明式路由）
   ④ 专业 Agent 内部 LangGraph 循环
```

### A1 ❌ 第 2 层到第 3 层断裂：节点流无法被 Agent Flow 编排（对能力扩展影响最大）

- FlowGraph 编译器的能力白名单是**硬编码的 7 项**：`text-template@1 / text-pass@1 / image-gen@3 / image-edit@2 / video@7 / speech@4 / tts@4`（`flow-graph-compiler.ts:67-121` 的 `CAPABILITY_COMPILE`）。未知能力直接报错（`:166-168`）。
- `composite` 在 `builder.ts`、`flow-graph-compiler.ts` 和 `video-adapter.ts`（flowTargetContract）中**都不存在**。
- 这违反了项目自己的两条原则：
  - `02-architecture.md §6`：「主 Agent 控制器按契约发现能力，不能为每个新领域添加流程核心分支」；
  - `NODE_CONTRACT_SPEC §3`：禁止在公共运行器里按 `nodeType` 写分支。
  现在每新增一个可编排能力，都要改编译器源码。
- **后果**：用户发布的节点流只能手动运行，或者通过 headless `composite.execute` 调用；上帝 Agent 建图时看不到这些节点流，你的「基础节点 → 节点流 → Agent Flow」分层在第二个接口处断了。

**优化方向**：节点流发布即注册为 capability（`composite:<capabilityId>@<version>`），可编排能力目录由 registry 和已发布的 manifest **自动生成**，不再硬编码。生成规则：
- 公开输入/输出 → 能力端口；
- `executionPolicy.requiresManualGate / waitForInput` → 映射为 `collaborative` / `human`；
- 公开 schemaRef → 端口 Schema；
- 计费可能性 → 能力描述里的 cost 声明。

### A2 ⚠️ 四种执行模式并存，没有一份规范说明「什么时候用哪种、怎么嵌套」

- 05 号文档是在 LLM 主控模式下写的（「主 Agent 根据迁移后的状态协调下一任务」），图模式明确规定「不调用主控模型、不接受模型文字改路由」（`coordinator-host.ts:620-623`），两者对「主 Agent」的定义根本不同。
- 节点流内部是**无条件的数据 DAG**，Agent Flow 图模式是**带条件、循环、汇合的控制流图**。这条分层原则是正确的，但**没有写进任何规范**。

**建议写成规范条款（分层宪法）**：

| 层 | 图的性质 | 允许 | 禁止 | 谁来决策流转 |
|---|---|---|---|---|
| 基础节点 | 单一职责 | 一次转换 | 隐藏输出、多职责 | — |
| 节点流 | 确定性数据 DAG | 串联、广播并联、扇入、嵌套固定版本 | 条件分支、循环（循环用 iterate 节点）、LLM 路由 | 拓扑序 |
| Agent Flow | 控制流图 | 条件、有界循环、fork/join、人工节点 | 模型文字改路由 | 声明式路由器（图模式）；LLM 只在节点内部决策 |

LLM 自由协调模式应降级为「草案 / 探索模式」，或者只允许在单个节点内部使用。这样「主 Agent」在全局只有一个含义。

### A3 ⚠️ 「上帝 Agent」的定位，在三处文档里互相矛盾

- `05-node-coordination-standard.md §1`：上帝 Agent「是否也落为 Agent 节点尚未确定，不能自行认定为画布外工作台」；
- `02-architecture.md §6`：「MCP、CLI、外部 Agent 接入不作为首版依赖」；
- 仓外 `agent-flow-interpreter-plan-20261114.md §6`：外部上帝 Agent 通过 `flowGraph.propose` 构建 FlowGraph（这已经实现了，`flow-agents-ops.ts:621-652`）；
- `AGENTS.md`：「不建立第二份任务拓扑」。但 FlowGraph 作为 IR 存进了 `flow_definitions`，画布编辑以后这份 IR 怎么处理，**没有任何规定**。

**需要补的条款**：
1. 上帝 Agent = 外部 Agent（经 CLI/MCP），只能 propose，必须由人在 GUI 里 confirm（这一条现在只写在仓外方案里）。
2. **FlowGraph 与画布的往返规则**：画布是唯一真值。编译落地以后，用户在画布上改了被控范围内的节点或边，对应的 FlowGraph 版本标记为 `diverged`。下一次运行要么从画布反向导出新的 FlowGraph 版本，要么拒绝运行，**不允许静默按旧 IR 路由**。
3. 外部 Agent 的身份、会话和并发 propose 冲突处理（可以复用 semanticRevision CAS，但要写成规范）。

### A4 ✅（2026-11-22 已决策）「多人沟通交流」与「本地单用户」的冲突

**决策：角色化单用户（只做方案 A）。** 始终只有一个本机用户；「多人」指这个用户以多个角色（编剧、审片……）参与流程，并与各节点的 Agent 沟通。不做多身份、登录、跨设备交接或联网协作。`AGENTS.md` 的「本地单用户」约束保持不变。

规范落点（AGENT_FLOW_SPEC v0.2 §16）：
- FlowGraph 顶层新增 `roles[]`；human、collaborative 节点必须声明 `humanRole`；
- 人工决定、提交、讨论的归属**取自节点的 humanRole**，与当前视图无关；
- 收件箱按角色分组；「以某角色查看」是筛选器，不是身份；
- 新增交接说明 `handoffNote`：在下游展示，只有显式 selector 声明时才进入模型上下文；
- 「执行者 × 决策者」两维保留，其中「人产出、人复核」解释为同一用户切换角色。

### A5 ⚠️ 状态机的角色定义与图模式不兼容

- 05 号规范：状态机记录 **Flow 的业务阶段**，一个控制范围对应一个状态机。
- 图模式编译器派生的状态机：`states = 每个节点`，`transitions = 每条数据边`（`flow-graph-compiler.ts:184-197`）。这是一个**单活动状态的平面 FSM**：
  - **并行 fork** 时两个节点同时运行，平面 FSM 无法表示（当前状态只能是其中一个）；
  - **循环**自重复时没有 `b → b` 迁移；
  - **条件**没有作为迁移守卫写进去，状态机只能事后记录，起不到校验作用。

**建议**：状态机只记录「Flow 阶段」（idle / running / waiting-human / reviewing / completed / failed），节点的运行态由各节点的 task state 承担；如果确实需要节点级状态图，就改用支持并行区域的 statechart。二选一，然后写进规范。

---

### A6 ❌ 外部 Agent 可以自己确认建图，也可以代替人提交人工任务（起草规范时新发现）

- 外部操作 `flowGraph.confirm` 直接触发渲染器的 `commitFlowGraph`（`CanvasEditor.tsx:1806-1855`）。`flow-build-actions.ts` 里的 `confirm` 只是发给 main 的 IPC 动作，**中间没有任何人可见的确认步骤**。外部 Agent 可以先 propose 再 confirm，完全绕过人工审阅，与 interpreter 方案 §6 第 5 条「外部 Agent 不能自己确认落画布」相矛盾。代码注释里的「外部不能自确认」，实际含义只是「外部不能自带预览内容」。`flowAgent.build.commit` 也是同样的情况。
- 外部操作 `humanTask.submit` 可以直接完成 human-task。在「人独立完成」的节点上，AI 可以冒充人交付。
- **修复**：给操作分级（只读 / 提案 / 运行控制 / 人工决定）；人工决定类操作从外部入口进来时，只能写入草稿，状态置为 `awaiting-human`，由人在 GUI 中采用（AGENT_FLOW_SPEC AF-1.5 / AF-5.3 / AF-17.2）。**列为 P0。**

### A7 ⚠️ 两处预算和上限常量不一致（起草规范时新发现）

- 节点流的预算缺省值，发布校验和运行守卫不是同一套：发布校验为深度 5、节点 500（`composite/validate.ts`），运行守卫为深度 8、节点 200（`composite/runtime.ts:checkCompositeRunBudget`）。一个 300 个节点的节点流**能发布，但运行必然失败**（NODE_FLOW_SPEC NF-10.2）。
- 返工上限三处不同：FlowGraph `review.maxReworks` 为 0–3（缺省 1），ReviewNodeConfig 为 0–10，00 号方案为缺省 3（AGENT_FLOW_SPEC AF-13.4）。

## 三、Agent Flow 图模式：执行语义漏洞（代码级核实）

> 文件：`src/shared/agent-flow/flow-graph.ts`（schema + 校验）、`flow-graph-router.ts`（路由）、`flow-graph-compiler.ts`（编译）、`src/main/agent-flow/coordinator-host.ts`（宿主）

### G1 ❌ 条件分支没有「死路径消除」，流程会永久挂起，并被误报为「等待人工」

- 路由器对未走的分支只会标记 `blocked: INCOMING_EDGES_UNSATISFIED`（`router:102-106`），**不存在 `skipped` 状态**。
- 汇合节点的 `joinPolicy` 缺省为 `all`（`router:103`）。典型的「审核通过→发布 / 否则→返工」这类 XOR 分支汇合，如果作者没有手动写 `any`，就**永远不会就绪**。
- 如果 `exits` 里包含任一分支的末端节点，`isFlowComplete` 要求所有出口都 settled（`router:112-119`），流程就**永远不会完成**。
- 没有可分派节点时，宿主执行的是 `return this.wait(run, 'human.wait')`（`coordinator-host.ts:1052-1055`）——**死锁被报告成「等待人工」**。

**修复**：
1. 引入 `skipped` 交付态。条件边判定为假以后，向下游传播 skipped（经典的 dead-path elimination）。
2. 校验器自动推断汇合：所有入边来自互斥条件分支时，强制使用 `any`；作者显式写 `all` 就报错。
3. 增加 `flow.stalled` 终态：无就绪节点、无运行中节点、也没有人工待办时，判定为死锁，给出具体节点和原因，不再借用 `human.wait`。

### G2 ❌ 条件互斥没有校验

- `validateFlowGraph` 的注释写明「条件互斥的完整可满足性检查（D6）属 P2/P3，本层不做」（`flow-graph.ts:258`），全仓找不到任何实现。
- 方案里的决策 D6 推荐「严格互斥」，但没有落地。两条条件同时为真时会**同时激活两个分支**。

**修复**：`StageCondition` 是有限的声明式谓词（output-field / output-count / human-decision / review-passed），完全可以做静态互斥检查。检查不了的组合，强制要求 `else` 分支或显式优先级。

### G3 ❌ 多节点循环能通过校验，但无法执行

- 校验规则只要求「环里有一个声明了 `loop` 的载体节点」（`flow-graph.ts:268-281`）。
- 路由规则规定：循环载体在满足退出条件或达到上限之前**不算 settled**（`router:54-74`），而边要能触发，前提是**源节点已 settled**（`router:39-46`）。
- 推论：对环 `B(loop) → C → B`，C 必须等 B settled，B 只有在退出时才 settled。所以 C 在循环过程中**从不运行**，循环实际上只是 B 自己重复执行。如果 B 的回边按 `all` 汇合，B 在第一轮就会死锁。
- 从测试用例名称看，`flow-graph-router.test.ts` 只覆盖了「重复分派 b」这种**单节点载体**场景。

**修复**：循环改为「子图载体」：`loop: { body: nodeId[], maxIterations, exitCondition }`。路由器在 body 内部按轮次（iteration scope）计算 settled，每轮生成独立的 taskId（宿主已经用 `loop:<n>` 做 taskId 后缀，见 `coordinator-host.ts:752-754`，可以直接复用）。

### G4 ❌ `control` 边是「幽灵边」

- schema 允许 `kind: 'control'`（`flow-graph.ts:102`）；
- 校验的邻接表把 data 和 control 都计入（`flow-graph.ts:193-198`），所以只通过控制边连上的节点算「可达」；
- 路由器只认 `kind === 'data'`（`router:92-94`）；编译器丢弃所有非 data 边（`compiler:190`、`:317`）。

结果：一个只有控制入边的节点能通过校验，但**永远不会被分派，也不会出现在 blocked 列表里**。

**修复**：二选一，并写进规范：(a) 删除 FlowGraph 的 `control` 边；(b) 给它明确语义（「仅顺序依赖，不传数据」），路由器和编译器都按这个语义实现。

### G5 ❌ 「已交付」要求输出非空

`delivered = children.filter(state==='completed' && outputs.length)`（`coordinator-host.ts:1005-1009`）。节点契约允许可选输出本次不产出（如 video-clip、sound-adjust），这样的节点合法完成以后**永远不算交付**，下游就死锁了。

**修复**：交付以「完成 + 交付记录」为准；输出是否齐备，由下游的 required 输入去判定（缺失时 skip 或 fail），而不是由上游的交付判定决定。

### G6 ⚠️ 校验/编译与运行准入的口径不一致

schema 和编译器都接受 `kind: 'state-machine'`（`flow-graph.ts:24-30`，`compiler:171-179`），宿主运行准入却拒绝它（`coordinator-host.ts:331-340`，`FLOW_GRAPH_NODE_KIND_UNSUPPORTED`）。用户 propose → 预览 → **人工确认落画布**以后，第一次运行才失败。

**修复**：在「校验」这一步就使用和运行准入相同的 kind 白名单（规则：同一事实只有一个判定点）。

### G7 ❌ capability 节点不能带参数，端口还会被编译器强行改写

- `FlowNodeSchema`（strict）**没有 config/params 字段**，编译时用的是 `CAPABILITY_COMPILE` 里的固定 config（`compiler:169`）。上帝 Agent 无法为生图指定模型、比例、张数，也无法为视频指定模式或时长。
- 编译器把 capability 节点的所有入边改写成同一个 `inputPort`，所有出边改写成同一个 `outputPort`（`compiler:309-325`）。像 video（in-images + in-text + in-reference-audio）、image-edit（in-image + in-text）这样的多端口能力，**无法按语义接线**。这也违反了「端口 ID 是持久化协议」（NODE_CONTRACT_SPEC §1 第 2 条）。

**修复**：FlowNode 增加 `params`（按目标节点的 config schema 校验）和**显式端口**（`from/to.portId` 必须属于目标节点 `resolvePorts` 的结果）。不再做重映射，非法端口直接拒绝。

### G8 ⚠️ FlowGraph 数据边的端口存在性与类型没有校验

方案 §5 第 2 条要求「数据边端口类型匹配」，但 `validateFlowGraph` 只校验节点引用和拓扑（`flow-graph.ts:260-301`）。agent 节点和 human-task 节点的端口直接透传到画布 createEdge，错误要到落画布或执行时才暴露。

**修复**：复用画布的 `portPairCompatible`（已有 129 项真值表）做同口径校验。

### G9 ⚠️ 预算与错误码

- `maxSteps` 缺省 12（上限 64），而节点数最多 64、循环最多 64 轮，两者之间没有交叉校验，节点数超过 12 的图用默认预算必然耗尽。**建议**：校验时检查 `maxSteps ≥ 节点数 + Σ循环上限`，或者给出建议值。
- 未知能力用的是 `UNREACHABLE_NODE` 错误码（`compiler:168`），语义错误，应该新增 `CAPABILITY_UNKNOWN`。

### G10 ⚠️ 「最小必要输入」：分级已有，溢出策略单一（起草规范时复核后修正）

复核 `stage-contracts.ts` 和 `context-manifest.ts` 后确认：selector 已经有 `required` 字段；必需内容不静默截断，超出预算时标记 `exceeded`，宿主停止执行；可选内容超出预算时丢弃并记入 `dropped`。**之前「必要输入被截断仍照常执行」的判断不成立，予以撤回。**仍然存在的缺口是：溢出时只能失败，没有 `ask-human` / `summarize` 等可声明策略；另外，selector 指向的节点在某条分支上可能永远不会交付，校验阶段没有检查这一点（AGENT_FLOW_SPEC V11）。

---

## 四、节点规范（NODE_CONTRACT_SPEC.md）

### ✅ 保持并冻结的部分

单一职责判定流程（§1.1）、10 种 PortType、`in-/out-` 命名规则、注册期硬校验、projectOutputs 作为唯一投影入口、操作节点与资产节点分离的不变式（§11）、媒体不可变、代码节点离线可复跑。这些是你整个能力扩展的地基，设计上是对的。

### 问题清单

| # | 级别 | 问题 | 证据 | 建议 |
|---|---|---|---|---|
| N1 | ❌ 结构 | 规范开头压着 10 段带日期的变更记录（10-12 → 10-16），§1「设计原则」开头又插了 C1/C3 的历史状态（如「state-machine executor 仍未开放」），现行条款和历史台账混在一起 | 文首第 1–26 行；§1 开头第 30–38 行 | 拆成 `NODE_CONTRACT_SPEC.md`（只写现行条款）+ `CHANGELOG.md` |
| N2 | ❌ 数值 | 规范写默认尺寸 340×260（第 60、187、585 行），实现是 `NODE_UI.height.default`=300（registry、编译器注释、UI 标准 §22 都是 340×300） | `registry.tsx` STANDARD_NODE_SIZE | 规范里不写数值，只写「以 `STANDARD_NODE_SIZE` 为准」 |
| N3 | ❌ 自相矛盾 | §8.2 写视频参考视频「最多 3 段」，文首写「结构上限 30，所选模型更低上限强制校验」 | §8.2 表 vs 第 3 行 | 改成「由能力描述驱动」 |
| N4 | ❌ 语义 | `cardinality` 一个词三种含义：输入端口指扇入连线数；输出端口「固定 one」；composite 里指值的多重性（`validate.ts` 里 many→one 被拒） | §4、§4.3；`composite/validate.ts:portsCompatible` | 拆成两个字段：`fanIn: one\|many`（连线数）、`valueShape: single\|list`（值形态） |
| N5 | 🕳️ 缺口 | **skip 传播语义缺失**：executor 返回 done/skipped/failed，但规范没有规定「上游 skipped 或可选输出缺席时下游怎么办」。11-20 节点流报告里实际出现过：必填输入没给 → 内部节点被跳过 → `REQUIRED_OUTPUT_MISSING`，看起来像莫名失败 | 节点流全面测试报告-20261120 §一 | 写一节「缺席与跳过」：required 缺失时在**运行前预检**就拦截；optional 缺席时下游按「无值」执行；skipped 向下游传播 |
| N6 | 🕳️ 缺口 | **过期（stale）语义缺失**：单选运行读取已持久化的上游结果（§1 第 10 条），但上游改了以后下游没有「过期」标记；状态里有 cached，缓存键却没有规范 | §1 第 10 条；UI §7 | 定义输入指纹（上游 runId + 配置 hash），指纹不一致就显示「结果已过期」 |
| N7 | ⚠️ 安全 | iteration 列表项只要有 `kind/mediaId/mediaPath/mime` 字段，就会被还原成媒体资产（鸭子类型）。规范没有要求校验 mediaId 是否属于本项目媒体库、路径是否在项目目录内 | §2 兼容矩阵、§4.4 迭代 | 规范要求「还原前必须命中本项目媒体表，且路径规范化后位于项目目录内」（**需用例确认**当前实现是否已做） |
| N8 | ⚠️ 不确定 | W2：循环体读到外部连线时「运行时报 undefined 或整项失败」，行为不确定 | §4.4 末段 | 改为静态校验 fail-closed，卡片上的提示升级为阻断 |
| N9 | ⚠️ 计费 | W1 把 image-gen「生图任务失败」列为可重试，但它和 video 一样可能已经在远端建了任务并扣费 | §4.1（W1） | 统一规定：只有「提交前/提交失败」可以重试；提交成功后的失败用幂等键核对 |
| N10 | ⚠️ 可机检性 | `any` 只要求「业务节点禁止滥用」，没有机器可检的白名单 | §2 | 在 registry 里列出允许使用 any 的 nodeType 白名单，测试守住 |
| N11 | ⚠️ 卫生 | 两个「4.1」、两个「## 11.」；`NodeValuePacket.value: unknown`（实现是 NodeValue，并且多了 assetId/versionId）；代码入口没有列 `src/shared/engine/`；`outputSource` 只在 §8.3 出现过一次，没有定义 | 全文 | 和 N1 一起重排 |

---

## 五、节点间对接规范（连线 / 数据包 / 执行协议）

整体是项目里把守最严的部分（connection-matrix 129 项真值表）。缺的是几处**跨节点语义**：

1. **缺席值协议**（同 N5）：数据包里没有「显式无值 / skipped」的表示。下游无法区分「上游没跑」「上游跑了但没产出可选输出」「上游被跳过」。建议在 `NodeValuePacket` 的收集层引入 `absent: { reason: 'not-run'|'skipped'|'optional-not-produced' }`。
2. **多选连接的顺序**：`many` 输入按「画布连线记录顺序」排列（§4.3），但用户在 UI 上看不到这个顺序，也不能调整。video 的 `in-images` 规定「第 1 张是主图」，顺序直接影响结果。建议规范要求「顺序可见、可调整」，并且持久化成边的 `order` 字段，而不是隐式依赖创建时间。
3. **画布与节点流的连线口径必须统一**：见 F2。同一对端口在画布上能连、封装成节点流就失败（或者反过来），这会直接破坏「先在画布上调通 → 再封装」的工作流。
4. **执行协议的「验证输出」一步**：§6 列了「验证输出」，但没有说验证失败时之前的有效结果怎么处理（UI §7 说「旧结果不被失败覆盖」）。建议在契约层写明：验证失败 = failed，不投影，保留上一次成功的投影。

---

## 六、节点流（composite）规范

> 现状：规范只有 NODE_CONTRACT_SPEC §8.0 的 7 条原则；manifest、runtimeVersion、版本、升级、失败、等待输入等语义**全都只存在于代码注释里**（`src/shared/composite/*.ts`）。而这一层正是你能力扩展的主干。

| # | 级别 | 问题 | 证据 | 建议 |
|---|---|---|---|---|
| F1 | ❌ 缺规范 | 没有独立的节点流规范：`runtimeVersion` 1/2 的语义差异（外部文本是替换正文还是虚拟上游；公开输出只收首个媒体还是按映射收集）只写在注释里；版本只允许 `N.0`；`upgrade.ts` 的升级规则没有成文 | `manifest.ts:16-29`、`:187` | 新建 `NODE_FLOW_SPEC.md`：manifest 字段、版本与兼容（建议 major.minor，minor 只能加可选端口）、升级、运行语义、失败、等待输入、人工门、计费、嵌套 |
| F2 | ❌ 口径分裂 | 节点流内部连线兼容只允许「同类型或 any」（`validate.ts:portsCompatible`），画布还允许 `text↔markdown`、`iteration→json/camera/媒体`；`COMPOSITE_PORT_TYPES` 不含 `iteration`、`camera`（`manifest.ts:31-40`，strict 枚举）→ 含循环或机位端口的节点流，端口快照可能通不过 schema | `manifest.ts:31-40`、`validate.ts:portsCompatible` | 两边共用一个 `portPairCompatible`（单一真值），并补齐类型枚举。**需用一条「含 iterate 的流封装」用例确认**封装器是否裁剪了这些端口 |
| F3 | ❌ 校验缺口 | 内部边和公开输出都**不校验 JSON Schema 兼容**（画布 §5 第 4 步要求校验），只有公开 JSON 输入要求 schemaRef；同时存在自由格式的 `schema` 片段和 `schemaRef` 两套写法 | `validate.ts:96-175` | 内部边、公开输出都比较 schemaRef；去掉自由 `schema`，或者规定它只用于 UI 提示 |
| F4 | ⚠️ 判定粗糙 | 必填满足判定：节点只要有**任意**一个 mediaRefs，就满足**任意**媒体类型的必填端口（图片引用能满足音频必填） | `validate.ts:hasContractFixedInput` | 按端口类型匹配 mime/kind |
| F5 | 🕳️ 并联语义 | 并联目前只有「广播 + 扇入（隐式 all-of）」，没有规定分支失败策略（fail-fast 还是继续其他分支）、部分成功时公开输出的规则、并发上限 | §8.0 | 在规范里定义 `executionPolicy.onBranchFailure: fail-fast\|continue`、部分输出可见性，以及默认值 |
| F6 | ❌ 计费门 | `composite.execute`（headless）没有计费/网络确认门，可以直接执行流内的付费模型调用；修复提交已经丢失 | `ops/composite.ts` 无 confirm；第一章 | 恢复丢失提交；规范规定「manifest 声明了 model 依赖 → 必须确认或持有预授权」 |
| F7 | ❌ 不可编排 | 节点流不能被 Agent Flow 引用 | 见 A1 | 见 A1 |

---

## 七、Agent 对接（CLI / MCP）规范

- **骨架可信**：三入口同源派生、parity 铁律与门禁、幂等信封、impactToken、命名管道鉴权，11-20 已经核实过。
- **main 现状**（见第一章）：MCP 注解两个方向都失真：
  - `idempotentHint` 恒为 true → MCP 客户端可能自动重试 `media.delete`、`composite.execute` 等不幂等操作，重复扣费或重复删除；
  - 任何写操作都标 `destructiveHint` → 客户端对普通的创建、修改也频繁弹确认，用户会对确认提示麻木，等真正的破坏性操作出现时反而起不到提醒作用。
  - 正确做法是在 `OperationSpec` 里逐项声明 `idempotent`、`destructive`、`cost`，注解从声明派生，测试守住。
- **规范权威应该是机器生成物**：`contracts.json` 已经有 1.59MB；markdown 里手工维护的「25 项」不可能跟得上。采纳 11-20 的建议：md 只写原则和边界，操作清单由生成物和 `capability.list` 提供；规范禁止出现「当前共 N 项」这种裸计数。
- **上帝 Agent 相关条款需要补进 AGENT_ACCESS_SPEC**（目前只在仓外方案里）：
  1. `flowGraph.propose/validate/preview/confirm` 的入口归属：外部 Agent 只能调前三个，`confirm` 只能由 GUI 的可信人工发起；
  2. propose 的配额和并发冲突（同一项目同时有多个 propose）；
  3. 人工类动作（`humanTask.submit`、审核 approve）的发起者身份边界：外部 Agent 能不能代替人提交？建议：**外部 Agent 永远不能代替人提交人工决定**，只能附上草稿。
- **键约定**：outputs 用裸 id、outputPorts 用 `out-<id>` 的不一致（11-20 C-❌2），修复在丢失的提交里，需要在恢复后复核。

---

## 八、UI 规范与 UI 展示规范

### U1 ❌ 「当前权威」叠层：一份标准里有 9 处同时自称权威

- `NODE_UI_STANDARD.md` 的 §18（v1.2）、§19（v1.3）、§20（v1.5）、§22（v2.2）、§23 以及 4 个子节，**都标注了「当前权威」**；
- `AGENTS.md` 仍然要求「先读 §19 v1.3」；`NODE_CANVAS_PRESENTATION_SPEC.md` 的入口指向 §18；
- `340×260` 在 STANDARD 里出现 8 次，`340×300` 只出现 2 次，新读者按出现频率理解，会读错；
- `design/2026-11-node-visual-v2/DESIGN.md:221` 自己写了「不能长期叠加多个当前权威」，但这条没有被执行。

**建议**：把 NODE_UI_STANDARD 重写成 **v3 单一现行版**，只保留现行条款，删掉旧数值，不要只追加新数值；§13-§23 的裁决历史移到 `docs/archive/NODE_UI_DECISIONS.md`。数值写成 token，由测试读取规范文件来比对（这是 NODE_COLOR_SPEC 已经验证有效的做法，推广到几何、线宽、尺寸）。

### U2 ❌ 状态展示规范只覆盖手动节点，缺少 Agent Flow 状态

UI §7 只定义了 6 种状态（空闲 / 阻断 / 运行 / 成功缓存 / 失败 / 取消）。Agent Flow 的任务状态是 `ready / running / waiting / blocked / completed / failed / cancelled`，C4 恢复还有「unknown / 需核对」，节点流和图模式还需要 `skipped`、`stale`。**这些状态在 UI 规范里都没有对应的呈现**。尤其是：
- `waiting` 必须区分**等人 / 等工具 / 等宿主**（05 号规范 §4 有这个要求，UI 没有落地）；
- `flow.stalled`（见 G1）必须和「等待人工」在视觉上明确区分。

**建议**：写一张「统一状态全集表」：状态 → 卡片标题行 → 正文 → 操作 → 端口形态 → 颜色以外的辨识方式，手动节点、节点流、Agent Flow 共用这一张表。

### U3 🕳️ 人机协作 UI 没有规范

`human-inbox.ts`、`run-overview.ts` 已经实现，但规范里一次都没有提到。协作面板（submit / revise / discuss）、「现在轮到谁、在哪个节点做什么」、跨节点的待办聚合、讨论消息和正式交付物的区分（05 号规范 CN-07 的原则是「讨论消息不会自动成为正式成果」，UI 上要让人一眼看出来）——这些正是你「人和 AI 在节点上协作扭转」的主界面，应该成为 UI 规范里独立的一章。

### U4 ⚠️ 批次计划里的 UI 裁决没有回写到正式规范

`AGENT_FLOW_EXECUTION_SPEC_2026_11_12.md` 里的 L3（端口扇出排序、反向边外弧、控制线按 kind 着色、hover 聚焦、角色徽标）是 UI 裁决，但这份文档本身是批次执行计划。这些条款应该回写到 `NODE_CANVAS_PRESENTATION_SPEC §4`（连线语义），否则会出现第 4 份事实来源。

### U5 ⚠️ 弹窗统一规范在仓外

`modal-audit-20261121/弹窗统一规范-v1.0.md` 已经落地（commit 0c6224d3），但文档本身不在 `source/docs/` 里。应该移入仓库，并纳入 UI 规范索引。

---

## 九、规范治理：系统性问题与防复发机制

| 模式 | 本次实例 | 机制 |
|---|---|---|
| 修订没有进主干 | 第一章：P0 修订被 reset 丢掉 | 规范修订当天推送；pre-sync 钩子检查未推送提交；报告里的「已修复」附 origin hash |
| 规范放在仓外 | 11-14 graph/三形态方案、Agent-Flow 方案包 v1.0、节点卡片 v1.5、弹窗规范、本报告之前的所有审查报告，都放在 `canvas-studio/` 根目录（不受 git 管理） | 规范和方案一律放在 `source/docs/`；根目录只放运行产物 |
| 规范和台账混写 | NODE_CONTRACT_SPEC 文首、NODE_UI_STANDARD §17-§23 | 每份权威规范只写现行条款；变更进 CHANGELOG |
| 状态行腐化 | 05 号「设计规范，尚未实现」、矩阵「自动执行尚未接入」、AGENTS.md「待实施设计」 | 头部统一写 `status / last-verified / baseline-commit`；spec-lint 检查超过 14 天未验证的规范 |
| 权威叠层 | UI 标准 9 处「当前权威」 | spec-lint：每份文档「当前权威」最多出现 1 次 |
| 计数漂移 | 25/133/190 操作；28/31/32/33/37 节点 | 禁止裸计数，只写「以 registry / contracts.json 为准」 |
| 只有测试知道的规范 | 1/6 流动段、exec 八态、11-19 连线裁决 | 给 decisions 类测试加断言时，同一提交里必须在规范中追加条目（和 parity 铁律同构） |

**建议的规范分层（收敛 52+ 份文档）**：

```
L0 宪法      AGENTS.md（≤1 页：分层原则、铁律、规范索引）
L1 权威规范  NODE_CONTRACT / NODE_FLOW(新) / AGENT_FLOW(新，收敛 00/01/02/05/07/10 + 11-14 graph 方案)
             AGENT_ACCESS+PARITY / NODE_UI(v3) / NODE_COLOR / LOGGING
L2 机器真值  registry、contracts.json、node-schemas、连线矩阵（规范引用它们，不复写）
L3 档案      方案、台账、交付记录、测试与审查报告 → docs/archive/
```

---

## 十、面向你目标的目标架构（优化后的样子）

1. **统一节点描述符**：每种 nodeType 一份 descriptor，包含 数据契约（NODE_CONTRACT）+ 调度契约（CN-01~09）+ 呈现契约（UI）+ 成本声明。上帝 Agent 的能力菜单、FlowGraph 编译能力表、MCP 工具描述、UI 节点菜单，**全部从 descriptor 生成**（解决 A1、G7 的硬编码问题）。
2. **节点流即能力**：节点流发布后自动成为 `composite:<id>@<ver>` capability，可以在画布上使用，也可以被 FlowGraph 引用，还可以通过 headless 调用（解决 A1、F7）。
3. **FlowGraph v2**：
   - `FlowNode` 增加 `capabilityRef {kind: node|composite, id, version}`、`params`（按 config schema 校验）、显式端口；
   - 条件只放在控制语义的边上，删除幽灵 control 边，或者给它真实语义；
   - 引入 `skipped` 和死路径消除，校验器推断 join，增加 `flow.stalled` 终态；
   - 循环改为子图载体，按轮次计算 settled；
   - 校验 = 运行准入（同一个白名单、同一个端口兼容函数）。
4. **状态机**：只记录 Flow 阶段（或改用支持并行区域的 statechart），节点运行态归各自的 task；两者在 UI 上分区展示。
5. **人机协作**：participation 扩展成「执行者 × 决策者」两维；先做角色化单用户（A4 方案 A）；人工收件箱 / 协作面板单独写进 UI 规范。
6. **最小必要输入**：selector 增加 `necessity` + `overflow` 策略；交付记录绑定 manifest hash（已有，保留）。

---

## 十一、修订优先级

### P0（本周，先恢复再修）

| # | 事项 | 位置 | 工作量 |
|---|---|---|---|
| 0 | 把 `backup/main-before-sync-20261120-200237` 的 5 个提交合回 main，三道门禁全绿 | git | 中 |
| 1 | 修 task-bind 白名单回归（如果第 0 项合回，这一项一并解决） | `runtime.ts:474-479` | 小 |
| 2 | 图模式死锁：增加 skipped 和死路径消除 + `flow.stalled`，不再借用 `human.wait` | router / coordinator-host | 中 |
| 3 | 条件互斥校验 + 汇合推断 | `flow-graph.ts` | 中 |
| 4 | 校验与运行准入同口径（kind 白名单、数据边端口、control 边的去留） | flow-graph / compiler / coordinator-host | 小~中 |
| 5 | 交付判定不再要求 outputs 非空 | `coordinator-host.ts:1005` | 小 |
| 6 | MCP 注解从 OperationSpec 逐项派生（如果第 0 项合回，需复核） | `local-agent/index.ts` | 小 |
| 7 | 人工决定类外部操作改为「草稿 + 等待人工采用」（A6） | flow-agents ops / CanvasEditor | 中 |
| 8 | 节点流的发布期和运行期预算常量统一（A7） | composite/validate.ts、runtime.ts | 小 |

### P1（两周内）

- 新建 `NODE_FLOW_SPEC.md`（F1-F5），连线兼容统一用 `portPairCompatible`（F2）
- 节点流即能力 + 可编排能力目录自动生成（A1）
- FlowGraph v2：params、显式端口、子图循环（G3/G7）
- 收敛出一份 `AGENT_FLOW_SPEC.md`：分层宪法、四种模式的定位、上帝 Agent 入口、FlowGraph↔画布往返规则（A2/A3）
- NODE_CONTRACT_SPEC 拆成规范 + 变更记录，补 skip/stale/缺席语义（N1-N6）
- UI：统一状态全集表 + 人机协作 UI 章节（U2/U3）
- 落实 A4 角色化单用户（AGENT_FLOW_SPEC §16）

### P2（冻结阶段）

- NODE_UI_STANDARD v3 单一现行版 + 归档；推广 spec-lint
- 仓外方案和报告移入 `source/docs/archive/`
- 状态机定位二选一（A5）
- 循环体媒体还原的安全校验确认（N7）、W1 重试计费口径（N9）

---

## 附：本次未完成核实、需用例确认的项

1. F2：含 `iterate`/`camera` 端口的节点流，封装时是否被裁剪（还是直接失败）。
2. N7：iteration 媒体还原是否已校验 mediaId 归属和路径。
3. 第七章的键约定：丢失提交合回以后，headless outputs 与 outputPorts 的键是否已统一。
4. G3：多节点循环的实际行为（本报告结论来自路由纯函数推导，建议补一条 `B(loop)→C→B` 的路由测试来坐实）。

> 本报告**未修改任何规范或代码**。修订顺序建议：先 P0-0 恢复，再按 P0 清单逐项修复，每项附带测试。
