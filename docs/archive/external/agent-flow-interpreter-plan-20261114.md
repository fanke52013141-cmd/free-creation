# O4 Flow 解释器详细方案（2026-11-14）

> 目标：把"外部上帝 Agent 动态构建 flow → 主 Agent 流转 → 状态机记录 → 三形态节点 → 最小必要输入"做成一个**可序列化 flow schema → 编译执行**的解释器。这是你方案里的壁垒位。
> 性质：**设计方案，未改代码**。按你的惯例，列方案 + 决策点，你拍板后再分阶段实施。
> 关键前提（读源码核实）：**这不是从零造**。AF-01/02/03/05/06 已经实现了声明式固定顺序 flow 的地基。本方案是把它**从"固定顺序"推广到"通用图"**，并补外部动态生成 + 通用编译器。

---

## 〇、核心判断（先说清楚，避免重复造轮子）

**已经有的（必须复用，不重建）：**

| 已有能力 | 源码 | 在解释器里的角色 |
|---|---|---|
| 声明式阶段契约 | `stage-contracts.ts` `FlowStageSchema`（stageKey/nodeId/goal/completion/requireHumanDecision/entry/inputs/method） | flow 节点的雏形 |
| **最小必要输入编制** | `ContextSelectorSchema` + `ContextManifestSchema`（AF-02，selector 指向已交付阶段输出 + path + budgetBytes） | **就是你"最小且必要输入"的现成实现** |
| 声明式条件解释器 | `StageConditionSchema`（output-field/output-count/human-decision/review-passed）+ `evaluateStageEntry`（纯函数，不执行任意脚本） | 条件边/进入条件的现成解释器 |
| 不可变交付记录 | `StageDeliveryRecordSchema`（AF-05，绑定定义修订/阶段/task/清单hash/方法hash/候选/人工决定/审核） | 节点产物的版本化交接 |
| 不可变版本化定义 | `flow-definition.ts` `FlowDefinitionSchema`（AF-06，contentHash + 版本） | flow schema 的版本存储 |
| 固定顺序执行 | `node-contracts.ts` `executionMode:'fixed-order'` + `coordinator-host.ts` 阶段分派 | 编译器的执行后端雏形 |
| 每任务隔离运行时 | `runtime.ts` `createAgentRuntime`（StateGraph：decide/skill/tool/search/human/finish + FlowSqliteSaver） | 每个节点的执行子图 |
| 建图预览管线 | `builder-host.ts`（propose/inspect/confirm/discard + semanticRevision CAS） | 外部生成→预览→确认的现成骨架 |
| 状态机可信投影 | O1 已做（`emitTrustedEvent` → 画布状态机） | 编译后 flow 的状态可视化 |

**真正的缺口（本方案要补的）：**
1. **拓扑表达力**：当前 flow 定义只有固定顺序阶段（线性）。缺条件分支、有界循环、并行汇合（join）。
2. **外部动态生成**：当前 FlowDefinition 是从"固定顺序主控的已保存配置"发布的（`definition-store.ts:54` 要求 `executionMode==='fixed-order'`）。外部 Agent 不能直接产出一个通用 flow JSON。
3. **通用编译器**：当前没有"flow schema → 可执行图"的通用编译；建图器（builder）只认 6 能力 / 2 拓扑的 BuildPlan。

**一句话**：解释器 = 把 AF-01 的"阶段"推广为"图节点"，把 AF-02 的最小输入/AF-05 的交付/条件解释器原样复用，新增"通用图 schema + 编译器 + 外部生成管线"。

---

## 一、目标与非目标

**目标：**
- G1：一个**可序列化的 FlowGraph schema**（JSON），外部 Agent 可产出、人可读改、可版本化存储。
- G2：节点**三形态**统一声明（autonomous / collaborative / human），每节点带**最小输入契约**（复用 ContextSelector）与**决策集**。
- G3：支持**通用拓扑**：顺序、条件分支、有界循环、并行 fork/join。
- G4：一个**编译器**：FlowGraph → 画布语义图（节点+边+配置），交给现有协调器执行（画布仍是唯一可编辑定义，遵守 approved-plan）。
- G5：**静态校验**：端口类型、环检测（循环必须有界）、参与合法性、条件/selector 引用合法性。
- G6：**外部生成管线**：propose → 静态校验 → 影响预览 → 用户确认 → 编译落画布（复用 builder-host 骨架）。

**非目标（本期不做，明确排除）：**
- 不做任意脚本执行（条件只用声明式解释器，沿用 AF-01 安全边界）。
- 不做云端/多用户（本地单用户 Electron 不变）。
- 不绕过画布权威（编译目标是画布图，不是另建一份运行拓扑）。
- 不替换 LangGraph harness（编译产物仍由现有协调器 + 每任务 runtime 执行）。
- 不做无界循环（所有循环必须声明 maxIterations）。

---

## 二、FlowGraph Schema 设计（可序列化 IR）

> 设计原则：**最大化复用现有 schema**。FlowStage 升级为 FlowNode；ContextSelector/StageCondition/StageDeliveryRecord 原样复用。

### 2.1 顶层

```jsonc
FlowGraph {
  schemaVersion: 1,
  graphId: id,
  name: string,
  goal: string,                      // 总目标（复述注入主 Agent，对抗 lost-in-the-middle）
  nodes: FlowNode[],                 // ≤ 64
  edges: FlowEdge[],                 // ≤ 256
  entry: nodeId,                     // 唯一入口
  exits: nodeId[],                   // 终止节点集合
  budgets: { maxSteps, maxActiveMs, maxLoopIterations }  // 全局有界
}
```

### 2.2 节点（三形态统一）

```jsonc
FlowNode {
  nodeId: id,
  title: string,
  participation: 'autonomous' | 'collaborative' | 'human',   // 三形态统一声明（O2 已验证三形态存在）
  kind: 'agent' | 'human-task' | 'capability' | 'review' | 'state-machine',
  goal: string,                      // 固定目标，分派逐字使用，不由模型补写（沿用 AF-01）
  completion: string,                // 固定完成条件说明
  // —— 最小必要输入（复用 AF-02）——
  inputs: { selectors: ContextSelector[], budgetBytes: number },
  // —— 决策集（人机协作节点；复用 O6 已验证的 submit/revise/discuss）——
  decisions?: { allowed: ('approve'|'edit'|'reject'|'respond')[], when?: StageCondition[] },
  // —— 能力节点专用（复用 builder 能力目录）——
  capability?: 'text-template@1' | 'text-pass@1' | 'image-gen@3' | ...,
  // —— 审核节点专用 ——
  review?: { criteria, rejectPolicy, maxReworks },
  // —— 循环载体专用 ——
  loop?: { maxIterations: number, exitCondition: StageCondition[] },
  carrierNodeId?: id                 // 编译后承载的真实画布节点（编译器填）
}
```

**三形态映射（编译时）：**
- `autonomous` → Agent 节点 `interactionMode:'autonomous'`。
- `collaborative` → Agent 节点 `interactionMode:'collaborative'` + decisions。
- `human` → human-task 节点（O2 已验证的纯人节点）或人工编辑的资产节点。

### 2.3 边（条件 + 拓扑）

```jsonc
FlowEdge {
  from: { nodeId, portId },
  to: { nodeId, portId },
  kind: 'data' | 'control',          // 数据边 vs 控制边（approved-plan：控制/状态关系不混入数据 DAG）
  condition?: StageCondition[]        // 条件边：全部满足才流转（复用 evaluateStageEntry）
}
```

**拓扑表达：**
- 顺序：单入单出边。
- 条件分支：一个节点多条出边，各带 condition（互斥由校验保证）。
- 并行 fork：一个节点多条无条件出边（fan-out）。
- 并行 join：一个节点多条入边 + `joinPolicy:'all'|'any'`（汇合策略）。
- 有界循环：回边 + 载体节点 `loop.maxIterations` + `exitCondition`。

### 2.4 与现有 schema 的关系

- `FlowNode.inputs` = `StageInputsSchema`（原样）。
- `FlowNode.goal/completion` = `FlowStageSchema` 同名段（原样语义）。
- `FlowEdge.condition` / `FlowNode.loop.exitCondition` = `StageConditionSchema`（原样，`evaluateStageEntry` 解释）。
- 节点产物交接 = `StageDeliveryRecordSchema`（AF-05，原样）。
- 版本存储 = `FlowDefinitionSchema` 扩展（AF-06，加 graph 字段；contentHash 机制不变）。

---

## 三、编译器设计（FlowGraph → 画布语义图）

> 编译目标选择（决策点 D1）：**编译到画布图**（推荐，遵守"画布是唯一可编辑定义"），而非直接编译到独立 StateGraph。协调器内部本就用 StateGraph 执行，所以"编译到 StateGraph"通过现有协调器间接达成，不另建权威。

### 3.1 编译步骤（纯函数 + 落画布两段）

1. **纯编译（可单测）**：`compileFlowGraph(graph): CompiledGraph`
   - 为每个 FlowNode 生成画布节点配置：
     - agent → `AgentNodeConfigSchema`（role:'specialist'，interactionMode 由 participation 映射，executionMode:'fixed-order' 复用，stages 由节点 goal/inputs/method 编制）。
     - human → human-task 节点配置（`HumanTaskNodeConfigSchema`）。
     - capability → builder TARGETS 映射（复用 builder-host 的 6+1 能力映射）。
     - review → `ReviewNodeConfigSchema`。
     - state-machine → `StateMachineNodeConfigSchema`（状态/转换由图拓扑推导）。
   - 生成数据边（端口类型匹配）+ 控制边（controls/observes/review-gate/rework）。
   - 生成一个 coordinator 主控节点（role:'coordinator'，allowedNodeIds=所有专业节点，observes 状态机）。
   - 产出 `{ nodes, edges, stateMachineConfig }`（与 builder-host 的 BuildPreview.nodes/edges 同构）。
2. **静态校验**（见第五节）：编译前必须通过。
3. **落画布**：复用 builder-host 的预览→确认→提交骨架（semanticRevision CAS + 占用检查 + 单撤销步 + 保存屏障）。

### 3.2 执行（复用现有协调器，不新建执行器）

- 编译产物落画布后，由**现有协调器**执行：
  - 固定顺序部分走 AF-01 阶段分派（`coordinator-host.ts` driveStages）。
  - 条件边/循环走**新增的图路由层**（见 3.3），路由决策只认声明式条件 + 账本事实。
  - 每节点执行走 `createAgentRuntime`（隔离上下文 + 最小输入 ContextManifest）。
  - 节点完成 → O1 `emitTrustedEvent` → 状态机投影。

### 3.3 图路由层（新增，解释器的核心新代码）

- 在协调器之上加一个**声明式图路由器**：
  - 输入：当前已交付事实（`StageDeliveryFact[]`）+ 图定义。
  - 对当前节点的每条出边，用 `evaluateStageEntry` 评估 condition，决定下一节点集合。
  - 循环：维护每节点迭代计数，超 `maxIterations` 强制走 exitCondition 分支或阻塞（不静默无限循环）。
  - join：按 joinPolicy 等待所有/任一入边交付。
- **铁律**：路由只认声明式条件 + 账本回执/交付事实，**不接受模型文字直接决定流转**（沿用"模型文字不能赋成功"）。模型只能在节点内部决策，不能改图路由。

---

## 四、执行语义（节点 / 人工 / 产物 / 最小输入）

- **最小输入**：每节点执行前，按 `inputs.selectors` 从已交付阶段编制 `ContextManifest`（AF-02 现成），超 budgetBytes 截断并记 dropped。节点只拿清单内容，不拿全历史。
- **autonomous 节点**：createAgentRuntime 自主跑（decide→tool→finish），预算有界。
- **collaborative 节点**：runtime 到 human wait → 协作面板（O6 的 submit/revise/discuss + 工作稿预填）→ 人确认后续跑。
- **human 节点**：human-task 执行器停等（O2），人上传/编辑提交 → 执行器消费为正式交付。
- **产物交接**：节点完成 → 不可变资产版本 + `StageDeliveryRecord`（AF-05）→ 下游 selector 只引用固定版本。
- **状态机**：O1 投影，可见节点随交付自动推进。
- **复述**：每节点分派携带总目标 goal + 当前阶段目标（对抗 lost-in-the-middle，Manus 复述原则）。

---

## 五、静态校验（编译前必过，纯函数可单测）

`validateFlowGraph(graph): ValidationResult`，错误稳定可定位：
1. **引用合法性**：edge/condition/selector 引用的 nodeId/stageKey 必须存在（沿用 FlowStagesSchema 的 superRefine 模式）。
2. **端口类型**：数据边 from.port 输出类型 == to.port 输入类型（复用 builder 的 input/output 类型表）。
3. **环检测**：控制图强连通分量检测；**任何环必须包含一个声明了 loop.maxIterations 的载体节点**，否则拒绝（防无界循环）。
4. **参与合法性**：human 节点不能有模型决策；collaborative 节点必须有 decisions；requireHumanDecision 的阶段必须由 collaborative/human 承载（沿用 AF-01 校验）。
5. **条件互斥**：同一节点的多条条件出边，条件应互斥（声明式可满足性检查，避免歧义路由）。
6. **入口/出口**：唯一 entry；exits 可达；无孤岛节点。
7. **预算**：节点数/边数/循环上限在全局 budgets 内。

---

## 六、外部 Agent 生成管线（上帝 Agent 构建方）

> 复用 builder-host 的 propose/inspect/confirm/discard 骨架，把"BuildPlan"升级为"FlowGraph"。

1. **能力菜单**：外部 Agent 先读 `capability.list` + 节点契约目录（A2A AgentCard 式），知道能用什么节点/能力/端口。
2. **propose**：外部 Agent 产出 FlowGraph JSON → `flowGraph.propose`（新 op，复用 builder-host 的 requestId 幂等 + semanticRevision）。
3. **静态校验**：宿主跑 `validateFlowGraph`（第五节）。失败 → 结构化错误回外部 Agent（可迭代修正，AFlow 式"生成+反馈"）。
4. **影响预览**：编译为 CompiledGraph，渲染预览（节点/边/状态机），**不写画布**（沿用 builder preview）。
5. **用户确认**：人在 GUI 亲眼确认（authorize/confirm，沿用 builder 的人工门禁）。**外部 Agent 不能自己确认落画布**（与发布门禁同理）。
6. **编译落画布**：确认后编译产物落画布（单撤销步 + 保存屏障），生成 coordinator + 状态机。
7. **版本化**：FlowGraph 存 flow_definitions（AF-06，contentHash + 版本），可复用/评测/diff。

**三入口一致**：flowGraph.propose/validate/preview/confirm 须 GUI/CLI/MCP 同包（parity 铁律）。外部 Agent 走 CLI/MCP，人走 GUI 确认。

---

## 七、与现有 harness 集成（不破坏既有铁律）

| 既有铁律 | 解释器如何遵守 |
|---|---|
| 画布是唯一可编辑流程定义 | 编译目标是画布图；FlowGraph 是 IR/版本快照，不是第二份运行拓扑 |
| 模型文字不能赋成功 | 图路由只认声明式条件 + 账本回执/交付事实；模型只在节点内决策 |
| 命令账本权威 | 节点副作用仍走账本（pending/committed/unknown）；编译不改账本语义 |
| 专业 Agent 不读全图 | 每节点 createAgentRuntime 隔离 + ContextManifest 最小输入 |
| 三入口 parity | 新 op 同包 GUI/CLI/MCP + guard:agent-parity |
| 日志覆盖 | 编译/路由/循环各阶段补诊断事件（沿用 emitGatewayEvent） |
| 节点强制协议 | 编译产物每个节点过 NODE_CONTRACT_SPEC（contractVersion/ports/executor/projectOutputs） |

---

## 八、分阶段实施计划（每阶段独立可验收、可提交）

| 阶段 | 内容 | 产出 | 风险 |
|---|---|---|---|
| **P0 设计确认** | 本方案 + 决策点拍板 | 确认的 schema 草案 | 低 |
| **P1 FlowGraph schema + 静态校验** | 定义 FlowGraph/FlowNode/FlowEdge schema（复用 StageCondition/ContextSelector）；validateFlowGraph 纯函数 + 单测 | schema + 校验器（不接执行） | 低 |
| **P2 纯编译器** | compileFlowGraph → CompiledGraph（节点配置 + 边 + 状态机），纯函数 + 单测；先只支持顺序+条件（不含循环） | 编译器（顺序/条件） | 中 |
| **P3 图路由层 + 条件执行** | 协调器加声明式图路由（evaluateStageEntry 驱动）；条件分支端到端跑通 | 条件 flow 可执行 | 中高 |
| **P4 有界循环 + 并行 join** | 循环迭代计数 + exitCondition；fork/join 汇合 | 通用拓扑可执行 | 高 |
| **P5 外部生成管线** | flowGraph.propose/validate/preview/confirm op + 三入口 + 预览 UI | 上帝 Agent 动态建 flow | 中高 |
| **P6 版本化 + 复用** | FlowGraph 存 flow_definitions + diff + 从定义创建运行 | 可复用/评测 | 中 |

> 建议：**P1+P2 先做**（纯函数、低风险、可单测，立刻能验证 schema 与编译正确性），P3 起接执行（风险升高，需真实模型验收）。P5 是壁垒的"外部动态生成"卖点。

---

## 九、风险与决策点（需你拍板）

### 9.1 主要风险
1. **通用图执行复杂度**：条件/循环/join 的路由正确性是难点（尤其循环+返工交织）。缓解：路由纯函数化 + 大量单测 + 声明式条件（不执行脚本）。
2. **与固定顺序协调器的兼容**：现有 driveStages 是线性；加图路由不能破坏存量 fixed-order flow。缓解：图路由作为可选层，fixed-order 走原路径。
3. **AI 生成 flow 质量**：外部生成的图可能非法/低质。缓解：静态校验硬门禁 + 生成-反馈迭代（AFlow 式）+ 人工确认。
4. **画布权威边界**：编译落画布必须走渲染器权威动作（不能 main 直写）。缓解：复用 builder-host 的提交骨架。
5. **工作量**：这是壁垒级大改，P1–P6 全做是数周量级。缓解：分阶段，P1+P2 先落地验证。

### 9.2 决策点
| # | 决策 | 选项 | 建议 |
|---|---|---|---|
| D1 | 编译目标 | A 编译到画布图（协调器执行）/ B 直接编译独立 StateGraph | **A**：遵守画布唯一权威，复用协调器 |
| D2 | schema 复用度 | A 最大化复用 FlowStage/ContextSelector/StageCondition / B 全新设计 | **A**：少造轮子，语义一致 |
| D3 | 循环支持时机 | A P4 做有界循环 / B 首期只做顺序+条件，循环后置 | **B**：先降风险，循环单独攻坚 |
| D4 | 外部生成范围 | A 外部产完整 FlowGraph / B 外部只产阶段建议，人补图 | **A**：这才是壁垒；但静态校验+人工确认兜底 |
| D5 | 启动范围 | A 先做 P1+P2（schema+纯编译）/ B 直接全做 | **A**：低风险先验证 |
| D6 | 条件互斥校验强度 | A 严格互斥（拒绝歧义）/ B 允许优先级排序 | **A**：避免歧义路由，声明式可满足性检查 |

---

## 十、验收标准（每阶段）

- **P1**：validateFlowGraph 对非法图（悬空引用/类型不匹配/无界环/参与非法）全部稳定拒绝；合法图通过。单测覆盖各类错误。
- **P2**：compileFlowGraph 对顺序/条件图产出正确节点配置+边+状态机；与 builder-host 产物同构；纯函数单测。
- **P3**：一条含条件分支的真实 flow（如"审核通过→发布，否则→返工"）端到端跑通；路由只认交付事实；模型文字不能改路由（定向测试）。
- **P4**：有界循环跑通且超 maxIterations 强制退出；fork/join 汇合正确；崩溃恢复不重放。
- **P5**：外部 Agent 产 FlowGraph → 校验 → 预览 → 人确认 → 落画布 → 执行；非法图被拒；外部不能自确认；三入口一致。
- **P6**：FlowGraph 版本化存储 + diff + 从定义创建独立运行（不改模板）。
- **全程**：每阶段 typecheck + 定向单测 + guard:agent-parity + 日志覆盖；接执行阶段需关 app 跑 npm run verify + 真实模型样片。

---

## 十一、诚实结论

- **可行，且地基比你想象的厚**：AF-01/02/03/05/06 已实现声明式固定顺序解释器 + 最小输入 + 不可变交付。本方案是"固定顺序→通用图"的推广 + 外部动态生成，不是从零造。
- **真正的壁垒在 P3–P5**：通用图路由的正确性 + 外部 Agent 动态生成 + 人工确认门禁。这三块全网开源没有现成品（调研结论：LangGraph 拓扑须代码编译，AFlow 仅学术）。
- **不能先验保证的**：AI 生成 flow 的质量、通用图在真实垂类任务的好用程度——必须真实任务实测。能保证的是：schema/校验/编译的正确性（单测）、路由只认事实（定向测试）、三入口一致（parity）。
- **建议起步**：先拍板 D1–D6，然后做 P1+P2（纯函数、低风险、立刻可验证），再决定是否攻坚 P3–P5。

> 下一步：请你就第九节 D1–D6 拍板（尤其 D1 编译目标、D3 循环时机、D5 启动范围）。确认后我从 P1（FlowGraph schema + 静态校验）开始，分阶段提交，每阶段遵守三入口铁律 + 日志覆盖 + 节点协议。