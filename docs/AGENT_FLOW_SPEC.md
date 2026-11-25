---
title: Agent Flow 规范
status: draft            # draft → review → frozen
version: 0.2
last-verified: 2026-11-24
baseline-commit: aea3987a (main)
owner: Canvas Studio 规范组
supersedes: |
  本文收敛以下文档的「现行条款」，原文降级为档案（见 §20）：
  docs/canvas-agent-flow/00-approved-plan.md · 01-product.md · 02-architecture.md ·
  05-node-coordination-standard.md · 07-ai-review-node.md · 10-c1-control-declarations.md ·
  仓外 agent-flow-interpreter-plan-20261114.md · agent-flow-three-form-plan-20261114.md
machine-truth: src/shared/agent-flow/*.ts · src/main/agent-flow/coordinator-host.ts · contracts.json
---

# Agent Flow 规范 v0.2（草案）

> v0.2（2026-11-22）：§16 参与者模型已决策，确定为「角色化单用户」（只做方案 A）；FlowGraph 删除 `control` 边（AF-4.3a）。

## 阅读约定

与 `NODE_FLOW_SPEC.md` 相同：**【现行】** 表示已实现并强制执行；**【目标】** 表示规范要求但尚未实现，附差距编号（见 `规范体系深度审查报告-20261122.md`）；条款编号 `AF-x.y` 是稳定引用 ID；本文不写计数。

---

## 1. 目标与铁律

**目标**：上帝 Agent 构建任务流程；人和 AI 在流程中的每个节点上协作推进。每个节点可以由人独立完成、由 AI 独立完成，或者由人和 AI 协作完成。每个节点拿到**最小且必要的输入**，产出**不可变的交付**；节点之间按声明式规则逐个推进，直到任务完成。

**铁律（优先级高于本文其他条款）**

**AF-1.1【现行】画布是唯一可编辑的流程定义。** FlowGraph 是编译输入（IR）和版本快照，不是第二份运行拓扑；数据库、checkpoint 和日志都不是用户可编辑的流程。

**AF-1.2【现行】模型文字不能赋予成功，也不能改变路由。** 流转只认交付事实（不可变资产 + 交付记录 + 命令回执）和声明式条件；模型只能在节点内部做决策。

**AF-1.3【现行】副作用以命令台账为准。** 每个业务调用都有 `commandId`，台账状态为 `pending / committed / unknown`；`unknown` 必须先核对，不能自动重放；checkpoint 不能代替命令回执。

**AF-1.4【现行】专业节点不读全图。** 每个节点只能拿到其输入清单（ContextManifest）中的内容；节点正文和文件里的指令都视为数据，不会改变权限。

**AF-1.5【现行 · BL-01】人工决定只能由人做出。** 外部 Agent（CLI/MCP）不得代替人完成「人工决定类」动作，包括：确认建图落画布、提交 human-task 结果、协作节点的采用/拒绝、审核人工复审。外部 Agent 只能附上**草稿**，等人在 GUI 中采用（见 §17）。

---

## 2. 分层与执行模式

### 2.1 分层（与 NODE_FLOW_SPEC §1 一致）

| 层 | 图性质 | 谁决定流转 |
|---|---|---|
| 基础节点 | 单一职责 | — |
| 节点流 | 确定性数据 DAG | 拓扑序 |
| **Agent Flow** | 控制流图：条件、有界循环、汇合、人工节点 | **声明式路由器** |

### 2.2 执行模式

主 Agent 节点的 `executionMode` 有三种取值（`AgentNodeConfigSchema`），规范定位如下：

| 模式 | 现状 | 规范定位 |
|---|---|---|
| `graph` | 【现行】FlowGraph + 声明式路由，不调用主控模型 | **标准模式**。需要可复现、可审计、需人参与的流程必须使用它 |
| `fixed-order` | 【现行 · BL-35】声明阶段编译为线性路由图 | 与 `graph` 共用就绪、完成判定和单节点 Agent 分派。阶段契约（stages）保留进入条件、人工采用、输入编制和固定方法。 |
| `model`（缺省，旧语义） | 【现行】主控模型每轮输出 dispatch/finish/wait | **探索模式**：只用于草案和原型；不得作为交付流程模板发布；UI 上必须标注「模型调度、不可复现」 |

**AF-2.1【目标·A2】** 「主 Agent」在全局只有一个含义：**流程的控制宿主**（持有控制范围、预算、状态和运行总览）。在 `graph` 模式下，主 Agent 不调用模型；在 `model` 模式下，主 Agent 的模型决策同样只能输出受约束的控制命令（`CoordinationDecision`），不能执行业务能力。

---

## 3. 角色

| 角色 | 承载方式 | 职责 | 边界 |
|---|---|---|---|
| **上帝 Agent**（构建者） | ① 外部 Agent 经 `flowGraph.*`（FlowGraph）；② 画布内 `role: builder` 的 Agent 节点（BuildPlan） | 理解目标，构建或修改整张流程图：节点、参与形态、最小输入、条件、审核 | 只能 propose；落画布必须由人在 GUI 确认（AF-1.5）；构建完成不等于已执行 |
| **主 Agent**（协调者） | `role: coordinator` 的 Agent 节点，每个控制范围一个 | 持有控制范围（`allowedNodeIds`）、预算、状态机绑定；按路由推进；汇总交付 | 不改拓扑；发现能力不足时只能提出可见的图变更建议 |
| **专业 Agent**（执行者） | `role: specialist` 的 Agent 节点 | 完成本节点的复杂任务：在有限步内规划、调用工具、自检、请求补充输入 | 自身的任务范围、预算和工具白名单；返回交付或明确的 blocked/failed |
| **能力节点** | 基础节点，或【目标】已发布的节点流 | 一次确定性转换 | 不感知流程 |
| **人** | human-task 节点，或 collaborative 节点里的决策者 | 提交、采用、拒绝、讨论 | 见 §9、§16 |

**AF-3.1【现行】** 同一控制范围只有一个运行中的主 Agent，可以有多个独立的专业 Agent；多个主 Agent 竞争同一范围会被拒绝（`FLOW_CONTROL_OCCUPIED`）。

**AF-3.2【现行】** 角色权限由宿主校验，不靠提示词区分；专业 Agent 的工具只能是 `node.execute@1`，以及显式勾选的 `web.search@1`。
- **AF-3.2a【目标·回归】** 运行时 task-bind 的工具白名单必须与桌面准入完全相同。现行 `runtime.ts:474-479` 拒绝 `web.search@1`，导致勾选联网的专家必定失败。修复提交已丢失，需恢复。

---

## 4. 流程定义：FlowGraph IR

### 4.1 顶层【现行】

| 字段 | 约束 | 说明 |
|---|---|---|
| `schemaVersion` | 1 | |
| `graphId / name` | | |
| `goal` | ≤32 KiB | 总目标；每次分派都会复述给节点，防止上下文过长时目标被淹没 |
| `nodes[]` | 1–64 | 见 4.2 |
| `edges[]` | ≤256 | 见 4.3 |
| `entry` | 唯一 | 不能同时是出口 |
| `exits[]` | ≥1 | 见 §8.5 的完成判定 |
| `budgets` | `maxSteps`（缺省 12）、`maxActiveMs`、`maxLoopIterations`（缺省 8） | 全局上限 |

### 4.2 节点【现行】

| 字段 | 说明 |
|---|---|
| `nodeId / title` | 稳定身份；编译时映射为画布 shape id（`shape:` 前缀） |
| `kind` | `agent \| human-task \| capability \| review \| state-machine` |
| `participation` | `autonomous \| collaborative \| human` |
| `goal / completion` | 固定目标和完成条件说明；分派时逐字使用，不由模型补写 |
| `inputs` | 最小必要输入（`StageInputs`，见 §10） |
| `decisions` | 人机协作的决策集合（`approve / edit / reject / respond`，可带条件） |
| `capability` | capability 节点的能力 ID |
| `review` | `criteria`、`rejectPolicy: rework \| stop`、`maxReworks` |
| `loop` | `maxIterations`、`exitCondition[]`（见 §8.4） |
| `joinPolicy` | `all \| any`（见 §8.3） |

**participation 与 kind 的约束【现行】**：

| participation | 允许的 kind | 必须 | 禁止 |
|---|---|---|---|
| `human` | 仅 `human-task` | — | — |
| `collaborative` | 仅 `agent` | `decisions` | — |
| `autonomous` | `agent`、`capability`、`review` | — | `decisions` |

### 4.3 边【现行】

`{ from: {nodeId, portId}, to: {nodeId, portId}, condition?: StageCondition[], otherwise?: true }`

**AF-4.3b【现行 · BL-04】** `otherwise: true` 是否则分支：同源所有条件出边都已可判定且均不成立时流转，任一成立时不流转（并沿数据边跳过下游）。互斥判定按单值交付；多值交付同时命中多个分支时，路由器报 `ambiguous`，宿主以 `FLOW_BRANCH_AMBIGUOUS` 拒绝推进，不猜走哪条。：**FlowGraph 只有数据边。**

**AF-4.3a【现行 · BL-05，2026-11-22】删除 `control` 边。** 此前 schema 接受 `kind: 'control'`：校验时把它计入可达性，路由和编译时却把它丢掉。现规定：
- `kind` 字段只允许 `'data'`（可选，缺省 `'data'`，兼容旧 JSON）；
- 收到 `'control'` 时报 `FLOW_EDGE_KIND_REMOVED`；读取已发布的定义时同样拒绝，并提示重新发布，**不静默丢弃**；
- 「仅表示先后、不传数据」的依赖，必须用一条真实的数据边来表达（例如把上游的交付作为下游的可选输入）。

流程中的**控制关系**（`controls / observes / review-gate / rework`）不是 FlowGraph 边。它们由编译器生成，保存在节点 config 的 `relations` 中（§6），不受本条影响。

### 4.4 FlowGraph v2【部分现行】

> BL-10/BL-11 已完成前四行：`capabilityRef` + 能力目录生成（`capability-catalog.ts`）、`params`（`node-params.ts`，编译前校验并合并）、真实端口（`port-compatibility.ts` 下沉 shared，编译器不再重映射）、子图循环 `loop.body[]`（路由器轮次作用域 + 每轮独立 taskId）。`control` 边在 BL-05 已删除。剩余「执行者×决策者」「角色」两行仍为目标（BL-21/BL-15）。

| 变化 | 原因 | 差距 |
|---|---|---|
| ~~`capability` 改为 `capabilityRef`；能力目录生成~~ ✅ BL-10 | 编译器现在硬编码了能力白名单，节点流无法编排 | A1 |
| ~~新增 `params`，按目标节点 config 校验~~ ✅ BL-11 | 上帝 Agent 无法指定模型、比例、时长等参数 | G7 |
| ~~数据边端口必须是真实端口；禁止编译器重映射~~ ✅ BL-11 | 多端口能力被强行合并到一个端口 | G7 / G8 |
| 删除 `control` 边（已决策，见 AF-4.3a） | 现在校验时计入、执行和编译时丢弃 | G4 |
| `loop` 改为子图载体 `loop: { body: nodeId[], maxIterations, exitCondition }` | 现在多节点循环无法执行 | G3 |
| 参与形态拆成两维：`executor: human \| ai \| mixed` × `decider: none \| human \| ai-review` | 现在「人微调 capability 结果再确认」必须多包一层 Agent | A4 |
| 顶层新增 `roles[]`，节点可声明 `humanRole`（引用 `roles[].roleId`） | 角色化单用户：区分「谁的活」、收件箱按角色汇总、决定和讨论都带角色（§16） | A4（已决策） |

---

## 5. 构建流程（上帝 Agent → 画布）

```
上帝 Agent（外部）                宿主                              人（GUI）
  capability 目录 ◀── 读取 ──── flowAgent.catalog / capability.list
  生成 FlowGraph ── propose ──▶ 校验(§7) → 编译 → 持久化预览（不写画布）
                  ◀── errors ── 校验失败：结构化错误，可迭代修正
                                  预览：节点/边/状态机/预算/成本 ───────▶ 审阅
                                                                       确认 ─┐
                                 编译产物落画布 ◀─────────────────────────────┘
                                 （授权 / CAS / 单个撤销步 / 保存屏障）
                                 FlowGraph 版本化保存（contentHash）
```

**AF-5.1【现行】** propose 不调用模型、不写画布；同一张图、同一 `requestId` 幂等返回同一个 `buildId`。

**AF-5.2【现行】** 落画布经过渲染器的权威动作 `commitFlowGraph`：授权 → semanticRevision CAS → 单个撤销步 → 保存屏障 → 回执核对。

**AF-5.3【现行 · BL-01，实现方式为 (a) 的实时确认版】确认只能由人在 GUI 发起。** 现在外部调用会经 `desktop.ask` 弹出确认框（复用 confirm-sensitive），人点允许才执行原有的同一 commitFlowGraph / commitFlowBuild；拒绝、超时（5 分钟）、无桌面时分别返回 `HUMAN_DENIED` / `HUMAN_DECISION_TIMEOUT` / `DESKTOP_UNAVAILABLE`，均为生效前失败，迟到的允许不生效。持久草稿队列（离线后再采用）留作后续增强。原条款： 现行的外部操作 `flowGraph.confirm` 会直接触发 `commitFlowGraph`，**没有任何人可见的确认步骤**（`CanvasEditor.tsx:1806-1855`，代码中的 `confirm` 只是 IPC 动作，不是确认对话框）。这意味着外部 Agent 可以先 propose 再自己 confirm，与 interpreter 方案 §6 第 5 条「外部 Agent 不能自己确认落画布」相矛盾。要求以下二选一：
- (a) `flowGraph.confirm` 改为「请求确认」：GUI 弹出预览确认框，由人点击后才落画布；外部调用只能拿到 `awaiting-human` 状态；
- (b) 外部入口不提供 `confirm`，只有 GUI 预览面板可以确认。

`flowAgent.build.commit`（builder 角色）同样适用。

**AF-5.4【目标·A3】FlowGraph 与画布的往返规则**：
- 落画布后，画布成为真值；FlowGraph 版本记录为 `sourceGraph = {definitionId, version, contentHash}`；
- 用户在画布上修改被控范围内的节点、边或配置后，运行总览把这次运行标记为 `diverged`；
- 下一次运行前要求二选一：**从画布反向导出**新的 FlowGraph 版本，或者**放弃画布修改**。不允许按旧 IR 静默路由。

**AF-5.5【现行】** FlowGraph 定义可以独立发布为不可变版本（`flowGraphDefinition.*`），并支持 diff；从定义创建运行时仍走 propose → 确认管线，不修改模板。

---

## 6. 编译【现行 + 目标】

**AF-6.1【现行】** 编译产物（`compileFlowGraph`）包括：每个 FlowNode 对应的画布节点；一个 coordinator 主控节点（`executionMode: graph`，`allowedNodeIds` 为全部子节点，携带 `graph`）；一个派生状态机；数据边；`controls / observes` 控制关系；以及布局坐标（与 GUI 智能整理使用同一算法）。

**AF-6.3【现行 · BL-03 修复】编译重映射**：编译器把边条件、`decisions.when`、`inputs.selectors.sourceStageKey` 中的节点引用，与 `loop.exitCondition` 一起映射为画布 id。修复前，带条件分支或最小输入声明的外部图一进契约校验就失败，根本无法编译落画布。

**AF-6.2【种类与能力部分已现行 · BL-05；端口部分为目标·G8，待 BL-11】校验即准入**：种类白名单 `FLOW_GRAPH_DISPATCHABLE_KINDS` 与能力目录 `FLOW_GRAPH_CAPABILITY_IDS` 已成为 validate、compile、运行准入三处的唯一来源。原条款：编译和预览阶段使用的 kind 白名单、端口兼容函数、能力目录，**必须与运行准入完全相同**。现行情况是：schema 和编译器都接受 `state-machine` 节点，运行准入却拒绝它（`FLOW_GRAPH_NODE_KIND_UNSUPPORTED`），用户在人工确认落画布后、第一次运行时才会失败。

---

## 7. 静态校验

| # | 规则 | 状态 |
|---|---|---|
| V1 | 引用合法：edge、condition、selector 引用的 nodeId 都存在 | 【现行】 |
| V2 | participation 与 kind 的约束（§4.2 表） | 【现行】 |
| V3 | 不含 loop 载体的环 → `CYCLE_WITHOUT_LOOP`；**含载体的多节点环或自回边 → `LOOP_BODY_UNSUPPORTED`**，循环只能用单节点 `node.loop` 声明、不画回边 | 【现行 · BL-07】（v2 改为子图载体） |
| V4 | 从入口可达全部节点；出口可达；入口不是出口 | 【现行】 |
| V5 | `loop.maxIterations ≤ budgets.maxLoopIterations` | 【现行】 |
| V6 | **同一源节点的多条条件出边必须两两互斥**（`CONDITION_NOT_EXCLUSIVE`，见 `conditionsExclusive`：exists/equals/type 与 missing、equals 不同值、type 不同类型、count 区间不相交），或者改用 `otherwise` 边（每源至多一条、须有条件兄弟边、不能带条件：`OTHERWISE_INVALID`）。human-decision / review-passed 没有否定形式，二选一只能用 otherwise | 【现行 · BL-04】 |
| V7 | ~~汇合推断~~：已由 AF-8.3b 的新 `all` 语义取代——XOR 汇合用缺省 `all` 即可，无需报错 | 【现行 · BL-03，作废原条款】 |
| V8 | 数据边端口存在，且按 `portPairCompatible` 类型兼容、Schema 兼容 | 【目标·G8】 |
| V9 | kind 和能力在运行准入白名单内（与 AF-6.2 同源）：`NODE_KIND_UNSUPPORTED` / `CAPABILITY_UNKNOWN` | 【现行 · BL-05】 |
| V10 | 预算交叉检查：`maxSteps ≥ 可执行节点数 + Σ(loop.maxIterations × body 大小)`。单节点循环按大小 1 计算。预算不足时返回 `STEP_BUDGET_INSUFFICIENT` 及所需步数。 | 【现行 · BL-35】 |
| V11 | `required` 输入 selector 的源节点必须先于使用节点出现在从入口到达该节点的所有拓扑路径上。可绕过源节点或引用自身时返回 `REQUIRED_SELECTOR_UNREACHABLE`。 | 【现行 · BL-35】 |
| V12 | 错误码语义准确：未知能力用 `CAPABILITY_UNKNOWN`，不复用 `UNREACHABLE_NODE` | 【现行 · BL-05】 |
| V13–V15 | 角色声明与归属规则（见 §16.1） | 【目标·A4】 |

---

## 8. 路由与流转语义

### 8.1 基本概念【现行】

- **交付（delivered）**：节点完成，并有正式交付。
- **落定（settled）**：非循环节点交付即落定；循环节点交付后，满足 `exitCondition` 或达到 `maxIterations` 才落定。
- **就绪（ready）**：入口节点在未交付时就绪；其他节点按 `joinPolicy` 检查数据入边，入边源节点已落定且边条件满足即就绪。
- 路由器是纯函数（`flow-graph-router.ts`），输入只有交付事实和声明式条件。

**AF-8.1a【现行 · BL-06】** 交付判定不再要求 `outputs.length > 0`（`deliveredGraphNodes`）。节点契约允许可选输出本次不产出；「完成且有交付记录」即算交付，输出是否满足要求由下游 required 输入判定。

### 8.2 条件【现行】

条件是有限的声明式谓词（`StageCondition`），不执行脚本：
- `output-field`：某节点交付值的某个点路径 `exists / missing / equals / type`；
- `output-count`：交付数量 `gte / lte`；
- `human-decision`：该节点存在显式的人工采用；
- `review-passed`：指定审核节点通过。

### 8.3 分支、跳过与汇合

**AF-8.3a【现行 · BL-03】死路径消除**：条件边判定为假时，目标节点标记为 `skipped`（理由：`CONDITION_FALSE`）；`skipped` 沿数据边向下游传播，下游节点的全部入边都来自 skipped 或未满足时，同样 skipped。`skipped` 视为落定。

**AF-8.3b【现行 · BL-03】** `joinPolicy: all`（缺省）=「全部入边已落定（满足或已跳过），且至少一条满足」；`any` = 任一入边满足。XOR 分支汇合无需手写 `any`。条件引用的节点尚未落定时，边处于待定状态，不会提前判为死边。

### 8.4 有界循环

**AF-8.4a【现行】** 循环必须有界：`loop.maxIterations` 加上全局 `maxLoopIterations`；每一轮使用独立 taskId（后缀 `loop:<n>`）；达到上限时强制落定，不允许静默无限循环。

**AF-8.4b【现行 · BL-11】子图循环**：循环体是一组节点（`loop.body[]`）。路由器以「轮次作用域」计算 body 内的就绪和落定状态——同体内边按**本轮交付**就绪（循环载体本身要满足退出条件才 settled）；一轮结束（body 内出口节点交付）后评估 `exitCondition`，不满足且未达上限则开下一轮（`run.loopIterations[carrier]` 递增，子任务带 `round` 与独立 taskId）。v1 单节点循环语义不变；**v1 图**（无 body）的多节点环/自回边仍报 `LOOP_BODY_UNSUPPORTED`（只读兼容），v2 图用 body 显式声明后才允许环。

### 8.5 完成、停滞与失败

**AF-8.5a【现行 · BL-03 修订】** 全部 `exits` 落定（交付或跳过）且至少一个出口交付即完成；完成产物取通过审核的出口审核节点的被审对象，否则取最后一个完成的出口子节点的输出。

**AF-8.5b【现行 · BL-03，以 `blocked` + `code: FLOW_STALLED` 表达】停滞是独立终态**：判定条件还要求没有在途或等待中的子任务、没有未通过的审核；同时发出 `agent.coordination.graph_stalled` 事件，附带被阻塞节点 ID。全部出口都被跳过时也判为停滞（`isFlowComplete` 要求至少一个出口交付）。原条款：没有就绪节点、没有运行中节点、没有人工待办（human-task 待提交、collaborative 待决策、审核待复审）时，判定为 `stalled`，并给出阻塞节点和原因（`INCOMING_EDGES_UNSATISFIED`、`REQUIRED_INPUT_UNREACHABLE` 等）。**禁止**把停滞报告为 `human.wait`（现行 `coordinator-host.ts:1052-1055`）。

**AF-8.5c【现行】** 预算耗尽返回 `AGENT_BUDGET_EXHAUSTED`，属于失败，不是等待。

### 8.6 分派

**AF-8.6【现行】** 每一步分派一个就绪节点；多个就绪的 agent 节点（没有循环、没有 capability/human-task 混入）可以一次性 `dispatch-many` 并发，并发数受 `maxParallelTasks`（1–4）约束。审核节点由审核控制环驱动，不经过图分派。

---

## 9. 节点三形态（人 / AI / 人+AI）

| 形态 | 承载 | 现行流程 | 交付 |
|---|---|---|---|
| **AI 独立** `autonomous` | specialist Agent 或 capability | 自主执行，预算有界；缺少输入或无法交付时进入明确的 blocked/failed，不自动转为人工 | 不可变资产版本 |
| **人+AI** `collaborative` | collaborative Agent | 运行到需要人工时进入 `waiting(waitKind=human)`，在本节点讨论、修订、选择；人明确采用后继续 | 被采用的版本；交付记录 `humanDecided=true` |
| **人独立** `human` | human-task | 执行器停等，人提交结果，执行器校验 revision 并去重后交付 | 人提交的不可变版本 |

**AF-9.1【现行】** 讨论消息**不会**自动成为正式交付；人工修改会产生新版本，旧任务的输入保持不变。

**AF-9.2【现行·限制】** human-task 的结果类型只有 `text | json`。
- **AF-9.2a【目标】** 人独立完成的媒体工作（上传或修改图片、音频、视频）怎么接入目前没有定义。规范要求二选一：(a) human-task 增加媒体结果类型，提交时引用项目媒体库中的资产；(b) 明确规定「人工媒体交付 = 资产节点 + human-task 引用该资产」，并给出编译模板。

**AF-9.3【现行·BL-21，2026-11-26 冻结：执行者 × 决策者两维】**（替代一维 participation；旧图缺省自动映射，行为不变）：

| executor ＼ decider | none | human | ai-review |
|---|---|---|---|
| ai | 纯 AI | AI 产出，人采用（最常见的人+AI） | AI 产出，AI 审核 |
| human | 纯人工 | 以角色 X 产出，再切换到角色 Y 复核（同一个本机用户，见 §16） | 人产出，AI 审核 |
| mixed | — | 节点内对话协作，人最终决定 | — |

旧图映射（缺省）：`autonomous → ai × none`、`collaborative → mixed × human`、`human-task → human × none`、`review → ai × ai-review`；显式声明必须与该节点合法组合一致。**capability 节点缺省 `ai × none`，可显式声明 `decider: 'human'`（AI 产出、人采用）**：能力执行产出交付后先挂起为「待采用」，人工在流程总览点「继续」即采用并放行下游；未采用不会伪造完成，外部 Agent 不能代替该人工采用。

---

## 10. 最小必要输入

**AF-10.1【现行】** 每个节点通过 `inputs.selectors[]` 声明它要读取的内容：`sourceStageKey`（已交付的节点）+ `path`（点路径，空表示整个值）+ `required` + `purpose`；同时声明 `budgetBytes`（缺省 128 KiB）。

**AF-10.2【现行】** 宿主据此编制 `ContextManifest`：
- 必需内容**不静默截断**：超出预算时标记 `exceeded`，宿主停止执行并显示原因；
- 可选内容超出预算时丢弃，记入 `dropped`；
- 缺失的内容记入 `missing`（`DELIVERY_MISSING / FIELD_MISSING`）；
- 存在必需缺失或预算超出时，节点不允许执行；
- 清单带 `manifestHash`，交付记录绑定这个 hash，事后可以追溯「它当时看到了什么」。

**AF-10.3【现行】** 专业 Agent 需要更多内容时，返回**补充请求**，不能自己读取全图。

**AF-10.4【现行·BL-40，2026-11-26】** 溢出策略可声明：`overflow: 'fail' | 'ask-human' | 'summarize'`（缺省 `fail`，与现行行为一致）。`summarize` 必须由一个显式的能力节点完成并留下交付，不能在宿主里隐式调用模型。`ask-human` 在等待人工补料后继续：Agent 阶段把精简材料作为阶段上下文；能力节点把材料作为文本输入注入（优先第一个 `text`/`markdown` 输入端口，否则取唯一的单值 `any` 端口），命令以可选 `contextMaterial {targetPortId,text}` 承载，渲染层替代该端口的固定资产引用；补料缺失或端口不可承载时显式失败，不静默忽略。

---

## 11. 交付与资产

**AF-11.1【现行】** 交付记录（`StageDeliveryRecord`）绑定以下内容：定义修订、节点、taskId、输出资产引用（`assetId / versionId / sourceNodeId / sourcePortId`）、ContextManifest hash、执行信封 hash、人工决定、审核结论、提交时间。

**AF-11.2【现行】** 下游 selector 只引用固定版本；上游返工后，旧交付标记为 `stale=true`，不能再当作新版本交付。

**AF-11.3【现行】** 成果先登记、再物化到画布；物化失败时可以按 outputKey 补齐，不重复创建，也不丢失成果。

---

## 12. 状态模型

### 12.1 流程运行状态【现行】

`ready / running / waiting / blocked / completed / failed / cancelled`；`waiting` 必须带 `waitKind: human | reconcile`。
- **【目标】** 增加 `stalled`（AF-8.5b）；`waitKind` 增加 `tool`（等待远端异步任务）。

### 12.2 子节点和审核状态【现行】

- 子任务状态与流程运行状态同集；
- 审核状态：`ready / pending / passed / rejected / human-wait / manual-wait`；
- 子节点状态**【目标】** 增加 `skipped`（AF-8.3a）。

### 12.3 状态机节点

**AF-12.3【现行】** 每个控制范围绑定一个状态机节点（`observes` 关系）；状态只通过可信事件迁移（`emitTrustedEvent`），并做事件去重和 revision 校验；用户可以提交人工事件（`flowStateMachine.submitEvent`），合法性由执行器校验；不允许直接 setState。

**AF-12.3a【现行·BL-18，2026-11-26 冻结：阶段 FSM】** 状态机只记录「流程阶段」：`idle → running ⇄ waiting-human / reviewing → completed | failed | stopped`（另含 `paused`）。节点级进度只由各子任务状态承载，不进入阶段机的 states/transitions。编译期由 `deriveFlowPhaseStateMachine()` 生成唯一阶段配置；并行 fork、循环迭代与条件分支下，阶段取自协调器真实 `run.phase`，不按节点或数据边派生（不再采用 per-node 平面 FSM，也不引入并行 region statechart）。

---

## 13. 审核与返工

**AF-13.1【现行】** 审核只针对**固定版本**；`passed` 只放行被审核的那组版本；新内容或新标准必须重新审核。审核运行成功但结论为不通过，与审核运行失败是两回事；技术失败没有结论，**不默认放行**。

**AF-13.2【现行】** 返工走显式的 `rework` 控制关系回到 `responsibleNodeId`，不建立反向数据边。返工生成新的任务实例：保留原输入，反馈通过执行信封的 `reworkFeedback` 注入，不改写能力节点的配置。

**AF-13.3【现行】** 按责任方分别处理：人工责任方等待人修改后提交新版本；纯 AI 责任方保留原任务和输入，带反馈新建一次尝试；人机协作责任方在原节点等待人讨论和调整，人明确继续后修订。

**AF-13.4【目标·新发现】返工上限统一**：现行三处取值不一致：FlowGraph `review.maxReworks` 为 0–3（缺省 1），ReviewNodeConfig 为 0–10，00 号方案为缺省 3。规范冻结为：**上限 0–3，缺省 3**；三处共用同一常量。

---

## 14. 命令、幂等与恢复

**AF-14.1【现行】** 写命令共有字段：`commandId`、`projectId`、可信发起者身份、目标引用、预期版本。同一命令重放返回原回执，不会重复执行。

**AF-14.2【现行】** 应用重启后，未知执行显示为「需核对」；有完成回执的操作不重放；只有被证明可以安全恢复的能力，才开放自动继续。

**AF-14.3【现行】** 暂停只停止新的派发；正在执行的节点按自身能力取消或收尾；迟到的结果保留来源，但不推进已停止的流程。

**AF-14.4【现行】** 图修改使用预期 revision 校验；用户已修改时返回冲突，主 Agent 重新读取，不覆盖用户修改；正在执行的节点继续使用原快照；布局移动使用独立的视图修订，不会触发业务重试。

---

## 15. 预算

| 预算 | 层级 | 缺省值 | 状态 |
|---|---|---|---|
| `budgets.maxSteps` | 流程 | 12（≤64） | 【现行】；V10 交叉检查见 §7 |
| `budgets.maxActiveMs` | 流程 | 10 分钟 | 【现行】 |
| `budgets.maxLoopIterations` | 流程 | 8 | 【现行】 |
| 每任务决策轮数、工具次数、时长 | 专业 Agent | 12 轮 / 20 次 / 10 分钟（视频另设） | 【现行】 |
| ContextManifest `budgetBytes` | 节点 | 128 KiB | 【现行】 |
| `maxParallelTasks` | 主 Agent | 1（≤4） | 【现行】 |

---

## 16. 参与者模型：角色化单用户

**AF-16.0【已决策 · 2026-11-22】** 产品始终只有**一个本机用户**。「多人协作」指的是这个用户**以多个角色**参与流程（如编剧、美术指导、审片），并与各节点的 Agent 沟通。系统**不做**多个身份、登录、账号、权限、跨设备交接或联网协作；这些需求出现时，必须先修订 `AGENTS.md` 的第一条约束，然后才能修订本章。本决策不改变 `AGENTS.md` 现有约束。

### 16.1 角色声明

**AF-16.1【目标】** FlowGraph 顶层声明角色表，节点按角色归属：

```jsonc
FlowGraph {
  ...,
  roles: [                                   // 可选；≤16
    { "roleId": "writer",   "name": "编剧",  "description": "负责剧本与对白" },
    { "roleId": "reviewer", "name": "审片",  "description": "终审画面与节奏" }
  ]
}
FlowNode {
  ...,
  humanRole?: "writer"                       // 引用 roles[].roleId
}
```

校验规则（并入 §7）：
- **V13** `humanRole` 必须引用已声明的 `roleId`；`roleId` 唯一；
- **V14** `participation` 为 `human` 或 `collaborative`（以及 v2 中 `decider: human`）的节点**必须**声明 `humanRole`；纯 `autonomous` 节点**不得**声明；
- **V15** 未声明 `roles` 的图，视为只有一个隐式角色 `owner`（名称「我」）。旧图无需迁移。

角色是**流程定义的一部分**：随 FlowGraph 版本化，编译时写入承载节点配置（`AgentNodeConfig`、`HumanTaskNodeConfig` 新增可选字段 `humanRole`），落画布后由画布作为真值（遵守 AF-5.4 的往返规则）。

### 16.2 归属与记录

**AF-16.2【目标】角色由节点决定，不由当前视图决定。** 人工决定、人工提交、讨论消息的角色归属，**一律取所在节点的 `humanRole`**；不读取 UI 里「我现在正以哪个角色查看」的状态。这样即使用户忘了切换视图，归属依然确定、可复现，也无需任何身份校验。

需要记录角色的事实：

| 事实 | 新增字段 | 位置 |
|---|---|---|
| 人工采用 / 拒绝 / 编辑（collaborative） | `actor: { kind: 'user', roleId }` | 交付记录（`StageDeliveryRecord`）、协作事件 |
| human-task 提交 | `actor: { kind: 'user', roleId }` | `HumanTaskInstance` |
| 审核人工复审 | `actor: { kind: 'user', roleId }` | 审核记录 |
| 讨论消息 | `author: { kind: 'user', roleId } \| { kind: 'agent', nodeId }` | 节点会话 |
| 运行总览事件 | `source: 'user:<roleId>' \| 'agent:<nodeId>' \| 'agent:external:<clientId>' \| 'system'` | `FlowRunOverview.events`（替代现行的 `user \| agent`） |

`actor` 结构只保留 `kind` 和 `roleId` 两个字段，**不预留** userId / participantId，避免给人「已支持多人」的错觉。

### 16.3 收件箱与角色视图

**AF-16.3【目标】** 人工收件箱（`human-inbox`）按角色分组汇总以下待办：
- human-task 待提交；
- collaborative 待决策（采用、拒绝、回复）；
- 审核待人工复审；
- 流程 `stalled` 告警（不属于任何角色，置顶显示在「流程」分组下）。

**AF-16.4【目标】角色视图是筛选器，不是身份。** UI 可以切换「以某角色查看」：只高亮该角色的节点、过滤收件箱、在节点上显示角色标签。切换视图不会改变任何权限，也不会改变 AF-16.2 的归属规则。

### 16.4 角色间沟通

用户说的「多人沟通与交流」，在本模型中落实为以下两件事：

**AF-16.5【现行】节点内沟通**：用户以节点的角色，在该节点的会话里与该节点的 Agent 讨论、补充、纠偏；会话按节点和任务隔离，不同 Agent 不共享会话。讨论消息**不会**自动成为正式交付。

**AF-16.6【目标】交接说明**：节点交付时可以附一段 `handoffNote`（≤4 KiB，纯文本），作为交付记录的一部分：
- 在下游节点的卡片和协作面板中展示，标注来源角色和节点；
- **不会自动进入任何模型的上下文**。下游节点只有在 `inputs.selectors` 中显式声明 `{ sourceStageKey, path: '$handoff' }` 时，交接说明才会进入它的 ContextManifest（受预算和 required 规则约束）；
- 交接说明不是资产，不参与条件判定和路由。

### 16.5 与外部 Agent 的边界

**AF-16.7【目标】** 外部 Agent 永远不能以任何角色的名义做出人工决定（AF-1.5、AF-17.2）。它提交的草稿会标注为 `author: agent:external:<clientId>`，需要用户在对应角色的节点上采用后才生效。

### 16.6 不在范围内

以下能力明确不做：多个身份或登录、身份校验或 PIN、按人分配权限、跨设备任务包交接、实时多人在线、通知推送。

## 17. 外部接入（CLI / MCP）

**AF-17.1【现行】** Agent Flow 相关操作分属 `flowAgent.*`、`flowGraph.*`、`flowGraphDefinition.*`、`humanTask.*`、`flowStateMachine.*` 操作族；三入口共用同一宿主。清单以 `contracts.json` 为准。

**AF-17.2【目标·A6】动作分级**（由 OperationSpec 声明，宿主强制）：

| 级别 | 示例 | 外部 Agent |
|---|---|---|
| 只读 | catalog / inspect / preview / list / get | 允许 |
| 提案 | `flowGraph.propose`、`flowAgent.build.propose`、草稿提交 | 允许 |
| 运行控制 | `flowAgent.run / pause / stop` | 允许（受计费确认门约束） |
| **人工决定** | `flowGraph.confirm`、`flowAgent.build.commit`、`humanTask.submit`、协作采用/拒绝、人工复审 | **禁止直接生效**：只能写入 `draft`，状态变为 `awaiting-human`，由人在 GUI 中采用 |

**【现行 · BL-01】** 人工决定类操作从外部调用时，先在桌面弹出确认，人点允许后才执行（实时确认）。覆盖 `flowGraph.confirm`、`flowAgent.build.commit`、`humanTask.submit`、`flowAgent.cooperate`（action=submit 或 accepted=true）。`flowStateMachine.submitEvent` 与 `composite.run.submitHuman` 暂未纳入，待定（见 BACKLOG BL-01 备注）。

**AF-17.3【目标】** 外部 Agent 身份进入审计：每个外部调用都记录 `clientId`，运行总览事件归属为 `agent:external:<clientId>`。

---

## 18. UI 呈现要求（由 UI 规范实现，本文只列约束）

1. 画布上的数据边、控制关系（controls / observes / review-gate / rework）、溯源虚线必须视觉可分；控制关系不能画成数据边。
2. 统一状态全集表：手动节点、节点流、Agent Flow 共用一张表，覆盖 §12 的全部状态以及 `skipped / stale / stalled / 需核对`；**等人 / 等工具 / 等宿主**必须可区分；`stalled` 必须与「等待人工」视觉上明确不同。
3. 人工收件箱、协作面板（submit / revise / discuss）、运行总览是 UI 规范中的独立章节；角色标签、按角色分组的收件箱、「以某角色查看」筛选器、交接说明的展示位置，也在 UI 规范中统一定义（§16）。
4. 建图预览必须展示：节点、参与形态、最小输入、条件、预算、成本（NODE_FLOW_SPEC NF-12.2）、需要人工的节点。

---

## 19. 日志与验收

**AF-19.1【现行】** 日志沿用现有观测入口，登记 Agent / task / command / review / asset 的关联关系；不记录正文、反馈、提示词、回复、Key 或原始请求；执行信封只记录 hash 和计数。

**AF-19.2 验收门禁**（新增或修改 Agent Flow 能力时同包提供）：
1. 路由纯函数测试覆盖：顺序、XOR 分支 + 汇合、AND fork/join、单节点循环、**多节点循环**、死路径消除、停滞判定、零输出节点交付。
2. 「校验即准入」一致性测试：随机生成合法 FlowGraph → 校验通过 ⇒ 运行准入必然通过。
3. 「模型文字不能改路由」定向测试（现行已有，保留）。
4. AF-17.2 动作分级测试：外部入口调用人工决定类操作，必须得到 `awaiting-human`。
5. 角色测试：human 或 collaborative 节点缺少 humanRole 时校验拒绝；切换角色视图不改变决定的归属；交接说明在没有显式 selector 时不会进入模型上下文。
6. 一条真实画布路径：上帝 Agent propose → 人确认 → 纯 AI 节点 → 人机协作节点 → 审核拒绝 → 返工 → 通过 → 完成；中途重启应用能恢复，且不重放已完成的步骤。
7. `npm run verify` + `guard:agent-parity` + `verify:logging` 全绿。

---

## 20. 与旧文档的关系

| 旧文档 | 处理 |
|---|---|
| 00-approved-plan / 01-product / 02-architecture | 现行条款已并入 §1–§3、§14；原文移入 `archive/` 并保留链接 |
| 05-node-coordination-standard | CN-01~09 并入 §4、§10、§11、§12、§14；原文头部「尚未实现」作废 |
| 07-ai-review-node | 并入 §13 |
| 10-c1-control-declarations | 控制关系并入 §4、§6；原文移入 archive |
| 06 实施计划、08 台账、09–51 交付记录、HANDOFF_* | 档案，不再承载规范 |
| 仓外 interpreter / three-form / 方案包 v1.0 | 移入 `source/docs/archive/`；其中已实现部分并入 §4–§9 |
| AGENT_FLOW_EXECUTION_SPEC_2026_11_12 | 批次执行计划，不是规范；L3 UI 条款回写到 UI 规范 |
| AGENTS.md「画布原生 Agent Flow」一节 | 缩减为三条铁律，并链接到本文 |

---

## 附录 A：现行与目标差距（冻结前清零或明确延期）

| 差距 | 条款 | 优先级 |
|---|---|---|
| ~~外部 Agent 可自确认落画布、可代人提交人工任务~~ ✅ BL-01（实时确认版） | AF-1.5 / AF-5.3 / AF-17.2 | — |
| task-bind 工具白名单回归 | AF-3.2a | **P0** |
| ~~死路径消除、汇合推断、停滞终态~~ ✅ BL-03 | AF-8.3a / V7 / AF-8.5b | — |
| ~~条件互斥校验~~ ✅ BL-04 | V6 | — |
| 校验即准入（kind、端口、能力）+ 删除 control 边 | AF-6.2 / AF-4.3a / V8 / V9 | **P0** |
| ~~零输出节点交付~~ ✅ BL-06 | AF-8.1a | **P0** |
| 多节点循环（拒绝 ✅ BL-07；实现待 BL-11） | AF-8.4b | P1（实现） |
| 节点流作为能力、能力目录生成 | §4.4 / NODE_FLOW_SPEC §13 | P1 |
| params 与显式端口 | §4.4 | P1 |
| FlowGraph 与画布往返（diverged） | AF-5.4 | P1 |
| ~~状态机改为阶段状态机~~ ✅ BL-18（阶段 FSM 冻结，编译期唯一配置） | AF-12.3a | — |
| 返工上限统一 | AF-13.4 | P1 |
| 人工媒体交付 | AF-9.2a | P1 |
| 角色化单用户：roles / humanRole / actor 记录 / 收件箱按角色分组 / 交接说明 | §16 | P1（已决策：只做方案 A） |
| ~~执行者 × 决策者两维~~ ✅ BL-21（executor/decider 冻结；capability 可 decider human） | AF-9.3 | — |
| 预算交叉检查、错误码语义 | V10 / V12 | P2 |
| fixed-order 统一编译为 graph | §2.2 | P2 |
