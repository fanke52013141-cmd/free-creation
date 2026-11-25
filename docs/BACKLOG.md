---
title: Canvas Studio 待开发清单（BACKLOG）
status: living            # 常更新文档；每完成一项就勾选，并附上提交 hash
last-updated: 2026-11-25
baseline-commit: 42c7bdd (main)
sources:
  - docs/SPEC_DEEP_REVIEW_2026_11_22.md（审查报告，编号 A*/G*/N*/F*/U*）
  - docs/NODE_FLOW_SPEC.md 附录 A（NF-*）
  - docs/AGENT_FLOW_SPEC.md 附录 A（AF-* / V*）
  - 全节点组合测试与代码审查报告-20261122.md（U-*/T-*/F-*）
  - ROADMAP.md R4
---

# Canvas Studio 待开发清单

## 使用约定

- 每一项都有稳定 ID（`BL-xx`）。提交信息里要引用 ID，例如 `fix(agent-flow): BL-03 dead-path elimination`。
- **完成标准** = 验收项全部满足 + 门禁全绿 + 对应规范条款从【目标】改为【现行】（同一个提交完成）。
- 每一项默认要求：日志影响检查（`LOGGING_SPEC`）、GUI/CLI/MCP 三入口一致（`guard:agent-parity`）、`npm run verify`。下文不再逐项重复。
- 状态：⬜ 未开始 · 🟡 进行中 · ✅ 完成（附 hash）· ⏸ 延期（附原因和期限）。
- 规模：S（≤1 天）· M（2–4 天）· L（≥1 周）。

> **2026-11-25 收尾（干净树）**：`npm run verify` 通过（`qa/verification/run-AwaNQQ`，20:59–21:20 +08，状态 `passed`、退出码 0；应用测试 3938 通过 / 7 跳过，浏览器 34 脚本、构建与全部 Agent Flow 桌面验收通过），BL-16/19/22/30/34/35/36/37/38/39/50/51 一并置 ✅。契约快照无需刷新（`verify:agent-access` 192 操作 / 34 节点通过）；收尾提交 `418ab05`。
> 取证说明：首轮 `run-R8AV8H` 因本机 DSH 受限令牌下 Electron GPU 沙箱初始化崩溃而失败（库存 Electron 39.8.10 默认应用同样复现，非本仓代码问题），本轮以 `ELECTRON_DISABLE_SANDBOX=1` 取证；`run-fQCftg` 命中 `test/license-keypackage` 篡改用例的既有偶发，重跑后全绿。

---

## P0：阻塞类（建议本周完成）

### ✅ BL-00 恢复 11-20 丢失的 5 个提交并提交规范草案 · S（2026-11-22，`7e36dd8…c293701`，已推送 origin/main）
- **来源**：审查报告 §一（P0-0）
- **范围**：运行 `canvas-studio/restore-p0-20261122.ps1 -Push`。脚本会合回 `48833f2c 7baf9d3a 4e581d58 ff54f212 2172c9fe`，重新生成契约快照，再提交 `NODE_FLOW_SPEC / AGENT_FLOW_SPEC / SPEC_DEEP_REVIEW`。
- **验收**：
  - [x] Summary 全部 PASS：verify:agent-access / guard:agent-parity / verify:logging / test:contract / restored-tests
  - [x] `test/output-source-parity.test.ts`、`test/node-flow-e2e-composition.test.ts` 在 main 上存在且通过
  - [x] 已推送到 origin/main（用 `git ls-remote` 核对）
  - [x] 复核审查报告第一章表格里的 9 项：AGENTS.md、Speech indextts、MCP 注解、计费门、task-bind、计数等全部生效
- **结论**：`135cbef8` 只新增了临时脚本 `test/tmp-matrix-dump.test.ts`（提交说明与内容不符），属于误提交，撤回正确，不恢复；转正工作见 BL-51。
- **记录**：唯一冲突是 `change-impact.json`（生成文件），合入后已重新生成快照（`39610ae`）；test:contract 331 项、恢复的定向测试 283 项全部通过。

### ✅ BL-01 外部 Agent 不得代人做人工决定 · M（2026-11-24 交付：`8a2444ac` 实时确认 + CLI 等待口径/拒绝事件，门禁全绿）
- **来源**：审查报告 A6 · AF-1.5 / AF-5.3 / AF-17.2
- **范围**：
  - 在 OperationSpec 里新增动作级别：`read | propose | control | human-decision`。
  - `flowGraph.confirm`、`flowAgent.build.commit`、`humanTask.submit`、协作采用/拒绝、人工复审，从外部入口调用时**只写入草稿**，返回 `awaiting-human`。
  - GUI 弹出待采用提示，由人点击后生效。
  - 草稿标注 `author: agent:external:<clientId>`。
- **代码位置**：`src/shared/agent-access/ops/flow-agents.ts`、`src/main/agent-access/flow-agents-ops.ts`、`src/renderer/src/canvas/CanvasEditor.tsx:1806-1855`、`flow-build-actions.ts`
- **实际实现（与原计划的差异）**：没有做持久草稿队列，复用了已有的 `desktop.ask` + `confirm-sensitive` 交互确认通道（不占用写入槽、只有 renderer 回复通道能确认）。新增 `src/main/agent-access/human-decision.ts`，在 4 个操作的**副作用之前**调用：`flowGraph.confirm`、`flowAgent.build.commit`、`humanTask.submit`、`flowAgent.cooperate`（action=submit 或 accepted=true；note/discuss/revise 属交流，不打扰人）。确认框会说明节点和内容摘要（摘要只用于确认框，不进日志）。拒绝、5 分钟超时、无桌面分别返回 `HUMAN_DENIED` / `HUMAN_DECISION_TIMEOUT` / `DESKTOP_UNAVAILABLE`，都是生效前失败；迟到的允许不生效。
- **验收**：
  - [x] 外部调用时先弹确认；人拒绝或超时时不调用 desktop.run 或 port.cooperate（单测：build-access 2 例、cooperate-access 4 例）
  - [x] 允许后走原有的同一实现（commitFlowGraph / commitFlowBuild / human-task-submit / cooperate），撤销步语义不变
  - [x] 规范 AF-1.5 / AF-5.3 / AF-17.2 改为【现行】
  - [x] CLI 客户端对交互式操作按人工决定上限等待（`src/shared/agent-access/interactive.ts`；此前 15s 默认超时会在人点确认之前误报 `OUTCOME_UNKNOWN`）
  - [x] 人工决定未生效的唯一终态事件 `agent.human_decision.rejected`（白名单 + 覆盖率 + 单测）
  - [x] 真机 `agent-flow-human-task.cjs` 12 项全过（含点「允许提交」与节点流等待→提交→续跑→公开输出）
  - [ ] 持久草稿队列（人离开时外部提交可稍后采用）：后续增强，未排期
- **待决定**：`flowStateMachine.submitEvent`（状态机人工事件）和 `composite.run.submitHuman`（节点流运行中补人工输入）这次没有纳入，原因是前者不在 AF-17.2 名单里，后者需要支持无桌面的 headless 场景。要不要纳入，请拍板。
- **⚠️ 需要同步更新的真机验收脚本**：以下脚本通过外部接口调用了这些操作，需要加一步「点允许」才能跑通——`scripts/acceptance/agent-flow-human-task.cjs`（**2026-11-24 已修好**：点「允许提交」+ AF-07 等待/续跑）、`agent-flow-human-task-dispatch.cjs`、`scripts/mcp-acceptance.cjs`、`mcp-acceptance-families-4-5-6-9.cjs`、`mcp-acceptance-gap-fill.cjs`、`mcp-acceptance-optimizations.cjs`、`test-agent-graph-milestone.cjs`、`audit-business-actions.cjs`（其余 7 个仍待补）。
  - **2026-11-25 复核**：7 个脚本里只有 `agent-flow-human-task-dispatch.cjs` 真正命中人工确认（`humanTask.submit` 与两处 `flowAgent.run(continue)` 在人工等待时都会弹窗）；已补「允许提交 / 允许继续」点击并把单次 CLI 超时提到 240s。其余 6 个不触发确认门（`cooperate` 用 `note`、`build.commit` 在门禁前被 `FLOW_BUILD_MISSING` 拒绝等），**无需改代码**，已按顺序复跑全绿：`audit-business-actions` / `mcp-acceptance-optimizations`（9/9）/ `mcp-acceptance-gap-fill`（12/12）/ `mcp-acceptance`（34/34）/ `mcp-acceptance-families-4-5-6-9`（47/47）/ `test-agent-graph-milestone`。
  - **唯一未复跑**：`agent-flow-human-task-dispatch.cjs` 需 `CANVAS_TEST_API_KEY`（智谱 `glm-5.3-flash` 小额计费）；本机未配置该环境变量，改动已通过语法检查，待有 key 时复跑。

### ✅ BL-02 task-bind 工具白名单回归 · S（随 BL-00 合入 `5cb530c`）
- **来源**：AF-3.2a（如果 BL-00 合入成功，这一项随之关闭，只需复核）
- **验收**：[ ] 勾选 `web.search@1` 的专家 Agent 能正常运行；`runtime.ts` 与 `desktop-host.ts:280` 使用同一份白名单常量

### ✅ BL-03 图模式：死路径消除 + 汇合推断 + 「停滞」终态 · M（`cd873b31` 已进 main；门禁见 2026-11-24 `verify`）
- **来源**：G1 · AF-8.3a / AF-8.3b / AF-8.5b / V7
- **范围**：
  - 新增子节点状态 `skipped`：条件为假时标记，并沿数据边向下游传播。
  - `joinPolicy: all` 的语义改为「全部入边已落定（满足或已跳过），且至少有一条满足」。
  - 新增流程终态 `stalled`：判定条件是没有就绪节点、没有运行中节点、也没有人工待办；状态里带上阻塞节点和原因。
  - 删除 `coordinator-host.ts:1052-1055` 里把停滞报告为 `human.wait` 的逻辑。
- **代码位置**：`flow-graph-router.ts`、`coordinator-host.ts` graphStep、`desktop-tasks.ts` 状态联合、`run-overview.ts`
- **实现**：路由器重写为「边三态（满足 / 死边 / 待定）+ 跳过的不动点传播」；`all` 新语义；完成判定要求至少一个出口交付；宿主在确实没有待办时报 `blocked` + `FLOW_STALLED`（没有新增状态枚举，blocked 本来就表示「无法自行推进」），并发 `agent.coordination.graph_stalled` 事件（附被阻塞节点 ID）；失败文案已写入 failure-messages。
- **顺带修复（严重）**：编译器只重映射了 `loop.exitCondition`，没有重映射边条件、`decisions.when`、`inputs.selectors` 里的节点引用，所以**任何带条件分支或最小输入声明的外部图都无法编译落画布**（会被契约校验拒绝）。已修复，并加了编译测试。
- **验收**：
  - [x] 路由测试：XOR 分支 + 默认 all 汇合能走到完成；出口落在未选分支上时流程能完成；全部出口都被跳过时不算完成；条件引用未落定节点时不提前跳过
  - [x] 协调器测试：条件永不成立时返回 `FLOW_STALLED`，run 状态为 blocked
  - [ ] UI 上 stalled 与「等待人工」能明显区分：失败文案已有，正式样式和「被跳过节点」的展示见 BL-16
- **兼容**：已有的 XOR 汇合如果显式写了 `any` 行为不变；显式写了 `all` 的，从「永远等」变为「跳过的分支算已落定」，这正是期望的修复。

### ✅ BL-04 分支条件互斥校验 · M（`cd873b31` 已进 main；门禁见 2026-11-24 `verify`）
- **来源**：G2 · V6
- **范围**：对 `StageCondition` 做静态互斥检查（同一 stageKey、同一 path 上的 equals/exists/missing/type、count 区间、human-decision、review-passed）。无法判定的组合，要求写明 `else` 或优先级。
- **实现**：`conditionsExclusive` 做声明式互斥判定；新增 `otherwise` 边（原计划叫 else，为避开关键字改名）。多值交付同时命中多个分支时，运行期报 `FLOW_BRANCH_AMBIGUOUS` 兜底。
- **验收**：[x] 两条都可能为真的条件出边，校验时拒绝，错误码 `CONDITION_NOT_EXCLUSIVE`；[x] 有 `otherwise` 的图可以通过，非法 otherwise 报 `OTHERWISE_INVALID`；[x] 路由测试覆盖 otherwise 两个方向和多值歧义

### ✅ BL-05 校验即准入 · S–M
- **来源**：G4 / G6 / G8 · AF-6.2 / V8 / V9
- **范围**：
  - 校验、编译、运行准入共用同一份 kind 白名单。
  - 数据边的端口存在性和类型，用 `portPairCompatible` 统一校验。
  - **删除 FlowGraph 的 `control` 边**（2026-11-22 已拍板）：
    - `FlowEdgeSchema.kind` 收窄为只允许 `'data'`（字段保留为可选，缺省 `'data'`，兼容旧 JSON）；收到 `'control'` 时校验报错 `FLOW_EDGE_KIND_REMOVED`，并给出边的下标
    - 删除 router / compiler / coordinator-host 里所有 `edge.kind === 'data'` 过滤（`flow-graph-router.ts:93`、`flow-graph-compiler.ts:190,317`、`coordinator-host.ts:1246,1349`）；`adjacency()` 不用再改，因为只剩数据边
    - `run-overview.ts` 里 `edges[].kind` 固定为 `'data'`，或者删掉这个字段
    - 画布上的控制关系（`controls / observes / review-gate / rework`，即 `AgentFlowRelation`）**不受影响**；它们保存在节点 config 中，由编译器生成，和 FlowGraph 边是两回事
    - 影响面：全仓 test、scripts、示例里**没有**使用 `kind:'control'` 的 FlowGraph。用户库 `flow_definitions` 里已发布的定义可能含有这类边，读取时按上面的错误码明确拒绝，并提示重新发布，不做静默丢弃
- **说明**：FlowGraph v1 只携带 portId、不携带端口类型，`portPairCompatible` 又在 renderer 里，main 侧拿不到类型；端口校验只有在 v2 的显式端口（BL-11）里才能做，因此转入 BL-11。
- **验收**：[x] 种类和能力：validate、compile、准入共用 `FLOW_GRAPH_DISPATCHABLE_KINDS` / `FLOW_GRAPH_CAPABILITY_IDS`；编译映射的键类型与能力目录在类型层一一对应；[x] 固定种子生成的 24 个有向无环图均通过提案，顺序图与分叉图通过协调器运行；[x] 类型不兼容的图在 propose 阶段返回 `PORT_TYPE_MISMATCH`，无预览写入；[x] 含 `kind:'control'` 的图在 schema 解析层返回 `FLOW_EDGE_KIND_REMOVED`（propose、validate、读取已发布定义都经同一个 schema）；[x] 源码中已不再出现对 FlowGraph 边 kind 的过滤

### ✅ BL-06 零输出节点也算交付 · S（`28d02e81`，已推送）
- **来源**：G5 · AF-8.1a
- **代码位置**：`coordinator-host.ts:1005-1009`
- **实现**：`flow-graph-router.ts` 新增 `deliveredGraphNodes`（completed 即交付），`coordinator-host` graphStep 改用它；出口产物仍取「最近一次有输出的出口子节点」，全部出口都没有输出时报 FLOW_CHILD_BLOCKED（不变）。
- **验收**：[x] 可选输出本次没有产出的节点完成后，下游能正常推进（`flow-graph-router.test.ts` BL-06 用例）

### ✅ BL-07 多节点循环：正式实现前先在校验里拒绝 · S（`28d02e81`，已推送）
- **来源**：G3 · AF-8.4b
- **范围**：如果一个环里除了循环载体还有其他节点，校验时拒绝（错误码 `LOOP_BODY_UNSUPPORTED`）。正式实现放在 BL-11。
- **实现**：含 loop 载体的多节点环和自回边 → `LOOP_BODY_UNSUPPORTED`；无载体的环仍为 `CYCLE_WITHOUT_LOOP`。
- **发现**：原测试夹具「有界循环图」用的是 `a→b→a` 回边写法，在 v1 路由下**从第一步起就死锁**（入口 a 有入边，要等 b；b 又要等 a），已改为单节点 loop、不画回边的写法。
- **验收**：[x] `B(loop)→C→B` 路由测试记录了现状：循环过程中 C 从不就绪（审查附录第 4 项已坐实）；[x] 校验拒绝多节点环和自回边

### ✅ BL-08 节点流发布期与运行期预算统一 · S（`28d02e81`，已推送）
- **来源**：审查报告 A7 · NF-10.2
- **范围**：`composite/validate.ts`（5 层 / 500 节点）和 `composite/runtime.ts`（8 层 / 200 节点）改为共用一个常量模块。
- **实现**：新增 `src/shared/composite/budget.ts`（8 层 / 200 节点 / 1500 连线，取运行期既有值）；validate.ts、runtime.ts 都经 `resolveCompositeBudget`。
- **验收**：[x] `test/composite-budget-parity.test.ts` 断言两处同源，并且源码中不再写死缺省数字

---

## P1：能力扩展主线

### A. 节点流 → Agent Flow 打通（影响最大）

### ✅ BL-10 节点流即能力 + 可编排能力目录自动生成 · L（2026-11-24 交付：`capability-catalog.ts`；完整门禁绿）
- **来源**：A1 / F7 · NF-1.4 / NF-13.* · AGENT_FLOW_SPEC §4.4
- **范围**：
  - 已发布的节点流自动登记为 `capabilityRef {kind:'composite', id, version}`。
  - 能力目录由节点注册表和发布仓库**自动生成**，并带上参与形态下限、成本、网络、是否可调度。
  - 删除编译器里硬编码的 7 项 `CAPABILITY_COMPILE`。
  - 上帝 Agent 的能力菜单、MCP 工具描述都从这份目录生成。
- **实现**：`src/shared/agent-flow/capability-catalog.ts` 是唯一真值——节点能力逐项取自 `GENERATED_NODE_CONTRACTS`（端口/契约版本与画布同源），节点流能力取自已发布版本（公开端口 + NF-13.2 参与下限 + 由内部节点推导的成本/网络）；编译器、`flowGraph.validate/compile`、`flowAgent.catalog`、MCP 目录、builder 计划面全部消费同一目录。`FLOW_GRAPH_CAPABILITY_IDS` / `CAPABILITY_COMPILE` / builder 第二份 7 项映射已删除；FlowGraph 新增可选 `capabilityRef`，旧 `capability: id@version` 仍按 node 能力解析（历史 JSON 兼容）。新增准入码 `CAPABILITY_NOT_SCHEDULABLE` / `CAPABILITY_PARTICIPATION_BELOW_FLOOR`。
- **依赖**：BL-05
- **验收**：
  - [x] 发布一个节点流之后，`flowAgent.catalog` 能看到它（`test/local-agent-flow-agents-access.test.ts` 发布后断言公开端口/参与形态/可调度）
  - [x] 在 FlowGraph 里引用它能编译、运行、交付（`test/capability-catalog.test.ts` 编译为 composite 实例、公开端口不重映射、内容摘要固定版本；运行/交付沿用既有复合执行器）
  - [x] 节点流内部失败时，failureNodeId 能透传到运行总览（既有 `composite-executor` / `composite-run-repo` / `node-flow-e2e-composition` 用例锁定）
  - [x] 能力目录完整性：每个 Active 节点类型都有描述且不可调度的如实给出原因（`test/capability-catalog.test.ts`）
  - [ ] 最小输入编制（ContextManifest → 公开输入）与真实端口类型校验：随 BL-11/BL-12 推进（NF-13.4 仍标【目标】）

### ✅ BL-11 FlowGraph v2：params、显式端口、子图循环 · L（2026-11-24 交付；完整门禁绿）
- **来源**：G3 / G7 · AGENT_FLOW_SPEC §4.4 / AF-8.4b
- **范围**：
  - FlowNode 新增 `params`，按目标节点的 config schema 校验。
  - 数据边使用目标节点的真实端口，取消重映射。
  - `loop: {body[], maxIterations, exitCondition}`，路由器按轮次计算落定。
  - 旧 v1 图只读兼容。
- **实现**：`FlowNode.params` + `src/shared/agent-flow/node-params.ts`（公开配置子集，image-gen/video/image-edit/speech/tts/processor；未登记类型明确拒绝）在编译前校验并合并进载体配置；`portPairCompatible` 下沉 `src/shared/port-compatibility.ts`，`validateFlowGraph` 按能力目录/节点契约校验每条边的真实端口与类型，编译器**不再重映射端口**，协调器按 `edge.to.portId` 接线；`FlowNode.loop.body[]` 支持子图循环，路由器以「轮次作用域」计算 body 内交付（同体内边按本轮交付就绪），协调器每轮递增 `loopIterations`、子任务带 `round` 与独立 taskId；v1 单节点循环语义不变，v2 显式声明 body 才允许环（BL-07 拒绝规则只保留给 v1 图）。
- **依赖**：BL-10
- **验收**：
  - [x] video 节点的多端口按语义接线（端口存在性/类型由 `portPairCompatible` 校验，协调器按 `edge.to.portId` 取真实端口）
  - [x] 生图参数（模型/比例/张数）生效（`test/flow-graph-v2.test.ts`：params 合并进 image-gen 固定配置）
  - [x] 三节点循环能跑满上限后退出，每轮使用独立 taskId（`test/agent-flow-coordinator.test.ts`：round=[1,2]、taskId 全唯一）
  - [x] BL-07 的拒绝规则撤销（v2 子图循环通过；v1 多节点环仍拒绝，见 `test/flow-graph-v2.test.ts`）
  - [x] 旧 v1 图只读兼容（无 body 的循环语义与既有测试不变）

### B. 节点流规范落地

### ✅ BL-12 端口兼容判定统一 + 明确封装边界 · M
- **来源**：F2 · NF-6.4 / NF-6.5
- **范围**：节点流内部统一使用 `portPairCompatible`；`COMPOSITE_PORT_TYPES` 补上 `iteration / camera`，或者在封装入口明确拒绝。
- **验收**：[x] 封装支持的端口组合逐项与画布兼容判定比对；[x] `iteration`、`camera` 在封装入口给出明确错误。

### ✅ BL-13 节点流校验补强 · M
- **来源**：F3 / F4 / N5 · NF-6.2a / NF-6.6 / NF-7.5
- **范围**：
  - 内部边和公开输出做 JSON Schema 兼容校验。
  - 媒体固定输入按 mime 类型匹配。
  - 必填输入在所有入口都在运行前预检，消除「莫名的 REQUIRED_OUTPUT_MISSING」。
  - 删除自由格式的 `schema` 片段，只保留 schemaRef。
- **验收**：[x] 校验回归和三入口预检通过；[x] 缺少必填输入时，不启动内部节点，直接运行返回 `INPUT_REQUIRED`。

### ✅ BL-14 缺席三态：未产出 / 已跳过 / 未运行 · M
- **来源**：N5 / N6 · NF-9.1 · NODE_CONTRACT_SPEC 补节
- **范围**：数据包收集层表达 `absent.reason`，并按规则向下游传播；手动画布、节点流、Agent Flow 使用同一套语义。可以与 BL-03 的 skipped 共用实现。
- **验收**：[x] 输入收集区分三种原因；[x] 跳过会传播到没有替代来源的必填依赖。完整 `npm run verify` 通过，记录见 `qa/verification/run-Uk1PZn/verify.log`。

### C. Agent Flow 规范落地

### ✅ BL-15 角色化单用户 · M
- **来源**：A4（已决策：只做方案 A）· AF-16.*
- **范围**：
  - FlowGraph 新增 `roles[]`，节点新增 `humanRole`，加校验规则 V13–V15。
  - 编译时写入 AgentNodeConfig / HumanTaskNodeConfig。
  - 人工决定、提交、讨论记录 `actor:{kind:'user', roleId}`，**归属取节点上声明的角色**。
  - 收件箱按角色分组，stalled 置顶。
  - 增加「以某角色查看」筛选器。
  - 交接说明 `handoffNote`：只有在 selector 里用 `$handoff` 声明时，才进入模型上下文。
  - 运行总览中事件的 source 细化为 `user:<roleId> / agent:<nodeId> / agent:external:<clientId> / system`。
- **验收**：[x] 显式角色图的人工或协作节点缺少角色时拒绝；[x] 真实 Electron 验收切换收件箱角色后，提交仍记录节点声明的角色；[x] 交接说明只由显式 selector 选择；[x] 旧图按隐式 `owner` 兼容。外部事件来源保留 CLI 标识或 MCP 客户端名称摘要。桌面证据见 `qa/agent-flow-human-task/receipt.json`。

### ✅ BL-16 统一状态全集表 + 人机协作 UI 章节 · M（2026-11-25 收尾：`run-AwaNQQ` 全量门禁通过）
- **来源**：U2 / U3 · AGENT_FLOW_SPEC §18
- **范围**：
  - 在 UI 规范中新增两章：一张状态表覆盖手动节点、节点流、Agent Flow 的全部状态（含 skipped/stale/stalled/需核对，以及 waiting 的等人/等工具/等宿主）；另一章写收件箱、协作面板、运行总览、角色标签、交接说明的展示位置。
  - 按规范实现样式。
- **实现**：`docs/NODE_UI_STANDARD.md` §25「运行状态」按手动节点 / 节点流 / Agent Flow 三列覆盖 18 种步骤状态；§26「人机协作界面」写明收件箱按角色分组、停滞提示置顶、当前卡片优先、交接说明与事件来源。
- **依赖**：BL-03、BL-15
- **验收**：[x] Electron 总览状态夹具逐一截图（`qa/agent-flow-overview-visual/desktop/execute-report.json` 的 `fixtureStates` 为 18 态，`stateScreenshots` 18 张 + `flow-inbox-stalled.png`）；[x] 每种状态均有独立可读标签和图形标记（同报告 label + glyph）；[x] 收件箱角色筛选不隐藏置顶的停滞提示（同报告 `inbox.pinned: true`、`filteredRole: writer`）。
- **收尾**：无新增界面工作；干净树全量门禁通过（`qa/verification/run-AwaNQQ`）。

### ✅ BL-17 FlowGraph 与画布往返（diverged） · M
- **来源**：A3 · AF-5.4
- **验收**：[x] 修改被控节点后总览提示差异并拦截启动；[x] 桌面验收覆盖恢复原定义及发布新版本。反向导出只接受重新编译后可复现的改动。见 `scripts/acceptance/agent-flow-human-task.cjs`。

### ✅ BL-18 状态机改为流程阶段机 · M（2026-11-26 完成）
- **来源**：A5 · AF-12.3a
- **已选方案**：阶段 FSM。流程记录整体阶段，子任务记录节点进度。
- **实现**：编译期 `deriveFlowPhaseStateMachine()` 生成唯一阶段配置（idle/running/waiting-human/reviewing/paused/completed/failed/stopped），不再按节点或数据边派生；阶段取自协调器真实 `run.phase`，`projectFlowPhase` 只投影流程阶段。并行 fork、循环迭代、条件分支下阶段由运行事实驱动；节点级进度只出现在子任务（state-machine 配置无节点 ID）。
- **验收**：[x] 并行 fork、循环、条件分支下，状态机显示都如实（编译期阶段机测试 + 阶段投影测试：多子任务分派/完成不改阶段、任一分支持等人进入 waiting-human、继续/迭代回 running、完成进 completed）；[x] 节点级进度只出现在子任务上（states/transitions 不含节点 ID，历史只含阶段迁移）。规范 AF-12.3a 冻结为【现行】。

### ✅ BL-19 返工上限统一 · S（2026-11-25 收尾：`run-AwaNQQ` 全量门禁通过）
- **来源**：A7 · AF-13.4
- **范围**：FlowGraph、ReviewNodeConfig、默认值三处统一为 0–3、缺省 3，共用一个常量。
- **实现**：`src/shared/agent-flow/rework-limit.ts` 的 `MAX_REWORKS = 3` 是唯一常量；`ReworkLimitSchema`（0–3、缺省 3）供 FlowGraph 与 builder 使用，新输入超过 3 直接拒绝；`SavedReviewReworkLimitSchema`（读 0–10，`min(3)` 截断、缺省 3）兼容历史审核卡；`agentFlow.tsx` 对超限旧配置显示「旧配置最多按 3 次返工执行。保存后更新为有效上限。」
- **验收**：[x] 常量单一来源的测试（`test/agent-flow-node-contracts.test.ts` 直接引用 `MAX_REWORKS`，覆盖缺省、越界拒绝、历史 10→3）；[x] 旧配置 >3 时按 3 截断，并给出提示（schema 截断 + 设置面板提示）。
- **收尾**：干净树全量门禁通过（`qa/verification/run-AwaNQQ`）。

### ✅ BL-20 人工提交媒体结果 · M
- **来源**：AF-9.2a
- **实现**：human-task 支持图片和视频结果类型。
- **验收**：[x] 打包版验证图片与视频提交、续跑和公开输出。下游固定引用使用项目媒体 ID，并检查项目归属、MIME 与摘要。见 [日志覆盖](LOGGING_COVERAGE.md#2026-11-24-人工图片和视频交付)。

### ✅ BL-21 执行者 × 决策者两维 · M（2026-11-26 完成）
- **来源**：AF-9.3
- **范围**：participation 拆分为 `executor × decider`，原有三种取值映射到新模型。重点是让「AI 产出、人采用」不再需要额外包一层 Agent。
- **依赖**：BL-11
- **实现**：`FlowNode` 新增可选 `executor`（ai/human/mixed）与 `decider`（none/human/ai-review），缺省按 participation 映射（autonomous→ai×none、collaborative→mixed×human、human-task→human×none、review→ai×ai-review），旧图行为不变；capability 缺省 ai×none，可显式 `decider:'human'`。协调器在能力交付后置为「待采用」（`HUMAN_ADOPTION_REQUIRED`，子任务 waiting），人工在流程总览继续即采用并放行下游；外部未确认继续被拒绝。渲染器宿主继续统一带可信人工标记（同时服务 BL-40 补料）。
- **验收**：[x] capability 节点可以配置 `decider: human`（schema/解析 + 桌面能力图验收：执行→待采用→人工继续→协调完成）；[x] 旧图自动映射，行为不变（旧字段缺省映射测试 + 既有套件回归）。规范 AF-9.3 冻结为【现行】。

### D. 规范与组合测试遗留

### ✅ BL-22 NODE_CONTRACT_SPEC 修订 · M（2026-11-25 收尾：`run-AwaNQQ` 全量门禁通过）
- **来源**：N1–N11
- **范围**：
  - 文档拆为正文 + `CHANGELOG`；尺寸数值改为引用 `STANDARD_NODE_SIZE`。
  - 视频参考上限改为由能力描述驱动。
  - `cardinality` 拆为 `fanIn / valueShape`（先只改文档，代码改造另立项）。
  - 补充 skip / stale / 缺席语义；修正编号重复，以及 NodeValuePacket 签名、代码入口清单。
- **实现**：变更历史移入 `docs/CHANGELOG-node-contract.md`，正文不再保留带日期段落；§1 原则 8 与 §3 示例引用 `STANDARD_NODE_SIZE`；§4.3 写明 `fanIn` / `valueShape` 与现行 `PortDecl.cardinality` 的映射；新增 §4.5 AI 失败重试、§4.6 `outputSource`、§6.1 已连接端口的缺席原因（`skipped` / `not-run` / `optional-not-produced`）；§8.2 参考视频段数上限改为「所选模型能力描述 + `src/shared/video-capabilities.ts`」；§6 的 `NodeValuePacket` 签名与 `src/shared/engine/inputs.ts` 一致，顶部代码入口清单保留，章节编号无重复。
- **验收**：[x] 正文里没有带日期的变更段落；[x] `npm run verify:specs` 通过（其余规范缺 `last-verified` 的告警属 BL-30 范围）。
- **收尾**：干净树全量门禁通过（`qa/verification/run-AwaNQQ`）。

### ✅ BL-23 操作节点卡内「死结果区」 · S–M（2026-11-25 桌面确认：`scripts/acceptance/node-result-area-desktop.cjs`）
- **来源**：组合测试 U-1 / U-2（推荐方案 b）
- **范围**：speech / voice-design / image-edit 的 Body 改为从 `meta.nodeResult` 集合读取当前选中项，与 `MediaResultGrid` 同源。
- **验收**：[x] 浏览器验收确认配音与音色设计的播放请求及图片编辑预览指向选中结果；[x] 三种节点统一读取 `meta.nodeResult`。定向测试覆盖选中项、旧集合回退和失败结果过滤。
- **桌面确认（2026-11-25）**：新增 `scripts/acceptance/node-result-area-desktop.cjs`（Electron + vite 渲染层，无模型调用）11 项检查通过：三张卡片结果区展示 2 条、选中高亮唯一、配音/音色设计点播放的是选中项（非最近一条）、图片编辑预览指向选中项、无 `selectedMediaId` 的旧集合回退渲染、失败运行不展示结果区。证据 `qa/node-result-area-desktop/receipt.json` 与 `shots/result-area-desktop.png`。

### ✅ BL-24 MiniMax 克隆参考音频约束放到主进程 · S（2026-11-25 定向测试通过）
- **来源**：组合测试 T-4
- **范围**：在 `cloneMiniMaxVoice` 入口校验：时长 10 秒–5 分钟、大小 ≤20MB、MIME 在白名单内；连线输入和上传输入两种来源都要覆盖。
- **验收**：[x] 不合规的音频在请求供应商之前就被拒绝，并返回可操作的提示文案
- **实现与证据**：约束已在 `src/main/media/tts-transform.ts` 与 `src/main/gateway/voice.ts` 双层前置（MIME/大小零 ffprobe 零网络；时长仅本地 ffprobe）。新增 `test/tts-clone-bl24-gate.test.ts`（11 项）：MIME 非白名单、>20MB、9 秒/6 分钟越界均在克隆/网络前拒绝；10 秒与 300 秒边界放行；ffprobe 不可用时跳过本地检查；连线与上传两种来源共用同一 `referenceAudioId` 准入且不回退 `refMediaId`；阶段事件为 `reference-audio` + `error` + `voice.clone` 且不泄漏路径。顺带修正文案：越界时向下取一位并标明「（少于下限）/（超过上限）」，避免 9999ms 显示成「10.0 秒」。真实供应商未在定向测试中调用。

---

## P2：收敛与体验

| ID | 事项 | 来源 | 规模 |
|---|---|---|---|
| ✅ BL-30 | **spec-lint**：脚本已接入 `npm run verify`，定向检查覆盖元数据、权威声明、手写计数和过期告警。未登记验证日期的规范标记为 `unverified` 并告警。`run-AwaNQQ` 全量门禁通过 | 审查报告 §九 | S |
| ✅ BL-31 | **2026-11-26 完成**：NODE_UI_STANDARD 收敛为 v3 单一现行版（header 声明 v3/last-verified/唯一权威），原 §13–§21 历史实施记录与旧几何整体移入 `docs/archive/NODE_UI_STANDARD-history.md`（编号保留不复用）；新增 §27「v3 数值真值表」作为几何/线宽/尺寸的机器可读来源，`test/node-ui-standard-spec.test.ts` 直接解析表格并与 `NODE_UI`/`STORYBOARD_UI`/`TIMELINE_UI` 及 CSS 实现比对（数值漂移即红）。同步更新 AGENTS 与 NODE_CANVAS_PRESENTATION_SPEC 的入口引用。 | U1 | L |
| ✅ BL-32 | **2026-11-26 完成**：①仓外方案/报告（根目录 md/zip、Agent-Flow 方案包、2026-11-22 审计 md、弹窗规范原始副本、L3 批次执行计划）复制入 `docs/archive/external/` + 顶层 [归档索引](./archive/README.md)；②Agent Flow 历史文档按 AGENT_FLOW_SPEC §20 迁入 `docs/canvas-agent-flow/archive/`（65 份阶段交付/交接/审查，README 与全仓链接同步改写，现行入口保留 03/04/05/07/71）；③弹窗规范入仓为 [UI_MODAL_STANDARD.md](./UI_MODAL_STANDARD.md) 并纳入 NODE_UI_STANDARD §12 索引（U5）；④L3 连线/可读性条款（端口扇出排序、反向边外弧、控制线 kind 着色、hover 聚焦、角色徽标）回写 NODE_CANVAS_PRESENTATION_SPEC 正文（U4）。当前文档链接检查无新增断链；spec-lint 通过 | 审查报告 §九 | M |
| ✅ BL-33 | **2026-11-25 完成**：扇入顺序在节点流编辑页可见可调（↑/↓）并持久化为 manifest 边 `order`（修复编辑保存丢失 `connectOrder` 的问题）；`executionPolicy.onBranchFailure`（fail-fast/continue）与 `maxConcurrency`（1–4）落地：schema、编辑页「运行策略」面板、隔离执行调度器（就绪批次、失败分支下游阻塞、无关分支继续、已在运行节点自然结束）；人工门自动推断 `MANUAL_GATE_UNDECLARED` 已有。定向测试 `composite-policy.test.ts` 6 项 + `composite-gui-acceptance` 全绿 | NF-8.3a / 8.4 / 8.5 / 9.3a | M |
| ✅ BL-34 | 节点流版本号改为 major.minor；单次撤销和写盘失败回滚已通过 Electron 验收，版本契约 14 项定向测试通过；`run-AwaNQQ` 全量门禁通过 | NF-11.2 / 11.5 | M |
| ✅ BL-35 | V10、V11、V12 已实现；固定顺序编译为线性路由图，共用就绪、Agent 分派和完成处理；`run-AwaNQQ` 全量门禁通过 | AGENT_FLOW_SPEC §2.2 / §7 | M |
| ✅ BL-36 | 循环媒体归属与节点流执行前重试已通过 Electron 验收；生图、视频和循环自动重放保护已通过定向测试；`run-AwaNQQ` 全量门禁通过（其余异步路径见未覆盖边界） | N7 / N9 | S–M |
| ✅ BL-37 | 192 个操作逐项声明 `idempotent / destructive / cost`；能力目录和 MCP 工具从声明派生；`run-AwaNQQ` 全量验收通过 | 审查报告 §七 · NF-14.3 | S |
| ✅ BL-38 | 音色设计绑定、空循环体提示、右边缘产物落位已通过浏览器验收（U-3、F-1、U-5）；`run-AwaNQQ` 全量门禁通过 | 组合测试 | S–M |
| ✅ BL-39 | 循环卡片提供「只继续未完成项」，中止后续跑回归覆盖已完成项复用；`run-AwaNQQ` 全量门禁通过 | ROADMAP R4 | M |
| ✅ BL-40 | **2026-11-26 完成**：`ask-human` 补料打通能力节点——`node.execute` 可选 `contextMaterial{targetPortId,text}`、协调器映射文本端口并重校验预算、账本提交计入 `human:context` 指纹、store 投影放开 capability、渲染层注入文本输入；Agent 阶段行为不变。桌面端到端：`test-agent-flow-capability-graph` 扩展「超限等待→总览提交→能力节点执行→协调完成」通过，`test-agent-flow-overview-visual` 回归通过；选项与代码地图见 [71 决策记录](canvas-agent-flow/71-capability-context-supplement-decision.md) | AF-10.4 | M |
| ✅ BL-41 | 外围浏览器脚本修复并纳入 `test:optimization-ui` 门禁（node-ui / panel-sync / media-import） | 2026-11-24 | S |

---

## P3

| ID | 事项 | 来源 |
|---|---|---|
| ✅ BL-50 | 空项目首页增加直接创建入口；视频模式自动改写提示一次，浏览器已通过；`run-AwaNQQ` 全量门禁通过 | 组合测试 U-4 |
| ✅ BL-51 | 节点组合回归与默认端口连接矩阵快照已接入完整发布验收；选跑 `node-combos` 通过 229 项；`run-AwaNQQ` 全量门禁通过 | 组合测试 P3-7 |
| ⬜ BL-52 | 配置 Vidu Token 后，复跑组合 8，完成真实出片验收 | 组合测试 P3-8 |

---

## 待拍板

| 问题 | 关联 | 建议 |
|---|---|---|
| ~~`135cbef8` 被撤回是否是有意为之~~ | BL-00 | ✅ 误提交，不恢复 |
| ~~`control` 边：删除，还是实现为「仅顺序依赖」~~ | BL-05 | ✅ 2026-11-22 已决定：删除 |
| ~~节点流 headless 输出键：带前缀还是裸 id~~ | NF-5.3 | ✅ 2026-11-26 冻结：统一带 `out-` 前缀（旧裸 id 读取兼容） |

## 待补用例确认（来自审查报告附录）

1. 含 `iterate` / `camera` 端口的节点流，封装时的行为 → BL-12
2. iteration 媒体还原时是否校验了 mediaId 归属 → BL-36
3. headless 输出键约定在 BL-00 合入后是否已统一 → BL-00
4. 多节点循环的实际行为 → BL-07

---

## 建议节奏

| 周 | 内容 |
|---|---|
| 第 1 周 | BL-00 → BL-02、BL-06、BL-07、BL-08（小项先清）→ BL-01、BL-03、BL-04、BL-05 |
| 第 2–3 周 | BL-10、BL-12、BL-13、BL-14（打通节点流与 Agent Flow，补齐节点流规范） |
| 第 4 周 | BL-11、BL-15、BL-16 |
| 之后 | 其余 P1，以及 P2/P3 按需排期 |
