# ②三形态节点详细方案：graph 执行扩到 capability + human-task（2026-11-14）

> 路线已拍板：①P5 收尾（已完成）→ **②三形态节点** → ⑤真实模型 → ④版本化 → ③并行。
> ② 首期范围（用户已定）：**capability + human-task 先行，review 门禁返工随后**。
> 本文是 ② 的方案 + 决策点。**设计方案，未改代码**；拍板后分阶段实施。

---

## 〇、现状与缺口（读源码核实）

**当前执行架构（agent 链）：**
- 协调器（coordinator）→ 分派给**专业 agent 节点**（specialist）→ agent 经 `node.execute@1` 工具执行底层 capability/human-task 节点。
- `desktop-host.bind`（describeAssignment）**严格要求** `config.role==='specialist'` + `node.execute@1` 工具；`nodeType!=='agent'` 直接拒绝。
- `graphStep`（O4-P3/P4）只走 agent 分派（dispatchDecision → specialists.runAssignment），交付事实 graphFacts 读 child.outputs + humanDecided。
- graph 模式准入（coordinator-host:315）**拒绝非 agent 节点**：`graph.nodes.some(kind!=='agent') → FLOW_GRAPH_NODE_KIND_UNSUPPORTED`。

**缺口：**
1. FlowGraph 的 capability/human-task 是**直接图节点**（编译为 processor/human-task 画布节点），不经 agent 包装；当前 graph 模式无法执行它们。
2. graphStep 没有非 agent 节点的执行路径（capability 直接执行 / human-task 停等续跑）。
3. graph 模式准入需放开 capability/human-task kind。

---

## 一、核心架构决策（D1，需拍板）

**capability/human-task 图节点如何执行？**

| 选项 | 做法 | 优点 | 缺点 |
|---|---|---|---|
| **A 直接执行（推荐）** | graphStep 按节点 kind 分流：capability 直接调节点执行器（复用 agent node.execute 工具同一执行器）；human-task 创建人工等待任务，停等→续跑消费为交付。协调器 allowedNodeIds 含这些非 agent 节点，准入放开 kind。 | 贴合 FlowGraph"直接图节点"语义；不增加冗余 agent 包装节点；图路由统一 | 需在 graphStep 加非 agent 执行分支 + 人工等待/续跑接入 |
| B agent 包装 | 编译器把每个 capability/human-task 图节点包成一个 specialist agent（agent 经 node.execute 执行底层节点）；graph 路由仍纯 agent | 完全复用现有 agent 分派管线，改动小 | 每个能力/人工节点多一层 agent 包装（冗余节点+模型开销）；违背"最小必要"；human-task 停等语义被 agent 层复杂化 |

**建议 A**：FlowGraph 的卖点就是"直接图节点 + 最小必要"，B 的 agent 包装会引入冗余节点与模型开销，且 human-task 纯人工语义不应套 agent。A 复用节点执行器与人工等待机制，不另建执行器。

---

## 二、A 方案执行设计

**准入（coordinator-host graphMode）：**
- 放开 kind：允许 `agent | capability | human-task`（review 仍拒绝，随后阶段）。
- graph.nodes 与 childIds 一一对应校验保留（含非 agent 节点）。

**graphStep 分流（按 next.kind）：**
- `agent`：现有 dispatchDecision 路径（不变）。
- `capability`：构造该 processor 节点的执行输入（按图数据边从已交付事实编制），调**节点执行器**（与 agent node.execute 工具同一执行器，复用 runComposite/节点 executor），产出正式输出 → 记 child completed + outputs → emitTrustedEvent → 图路由推进。预算/失败走现有 child blocked 语义。
- `human-task`：创建人工等待任务（复用 C4 human-task 停等机制），child state='waiting' → graphStep 返回 human.wait；人工经 GUI/外部 humanTask.submit 提交 → 续跑消费为正式交付 → 图路由推进。

**交付事实（graphFacts）：** 已读 child.outputs + humanDecided，capability/human-task child 产生 outputs 后自然纳入路由（无需改 graphFacts）。

**循环/条件：** 复用 P3/P4 路由（nextReadyNodes/isFlowComplete/loopIterations），非 agent 节点同样参与条件边与有界循环。

---

## 三、人工等待/续跑接入（human-task）

- 复用 C4 既有 human-task 停等/提交/续跑（humanTask.submit + 续跑消费），不另建人工通道。
- graph 模式 human.wait 后，人工提交触发续跑（recover/continue），graphStep 从已交付事实继续路由。
- 三入口：GUI 人工任务面板提交 / 外部 humanTask.submit（已有）同一宿主。

---

## 四、三入口 parity + 日志 + 节点协议

- 不新增外部 op（执行经现有 flowAgent.run/continue + humanTask.submit）；准入放开 kind 属内部执行语义，三入口共用同一协调器。
- 日志：capability 执行复用节点执行器既有诊断；human-task 复用 C4 停等/提交诊断；graphStep 分流补 `agent.coordination.graph_dispatched` 的 kind 属性。更新 LOGGING_COVERAGE。
- 节点协议：capability/human-task 编译产物已过 NODE_CONTRACT_SPEC（P2 编译器）；执行复用既有 executor。

---

## 五、分阶段实施

| 阶段 | 内容 | 产出 | 风险 |
|---|---|---|---|
| **②.1 capability 执行** | 准入放开 capability；graphStep capability 分支调节点执行器；fixture 端到端（含条件/循环里的 capability） | capability 图节点可执行 | 中 |
| **②.2 human-task 执行** | 准入放开 human-task；graphStep human-task 停等 + 续跑接入；fixture 人工提交→续跑→路由推进 | human-task 图节点可执行 | 中高 |
| **②.3 验收** | 完整 verify + 真实模型样片（⑤） | 三形态（agent/capability/human）图执行 | 中 |

> review 门禁返工（②.4）随后单独阶段。

---

## 六、决策点（需拍板）

| # | 决策 | 选项 | 建议 |
|---|---|---|---|
| D1 | 执行架构 | A 直接执行 / B agent 包装 | **A**：贴合 FlowGraph 直接图节点语义，无冗余包装 |
| D2 | capability 执行器复用 | A 复用 agent node.execute 同一节点执行器 / B 新写执行器 | **A**：不另建执行器（铁律） |
| D3 | human-task 停等复用 | A 复用 C4 humanTask 停等/提交/续跑 / B 新建人工通道 | **A**：复用既有人工机制 |
| D4 | 首期范围 | capability + human-task（已定）/ 含 review | **capability + human-task**（用户已定） |

---

## 七、诚实结论

- **可行**：节点执行器与 C4 人工等待机制现成，② 主要是 graphStep 加非 agent 分流 + 准入放开 kind，不另建执行器/人工通道。
- **难点**：human-task 停等/续跑与图路由的衔接（等待态恢复后从已交付事实继续）；capability 执行输入按图数据边编制。
- **不能先验保证**：真实垂类任务好用程度需 ⑤ 实测。能保证：路由只认交付事实（定向测试）、三入口一致、节点协议。

> 下一步：请你就 D1–D3 拍板（尤其 D1 执行架构）。确认后从 ②.1（capability 执行）开始，分阶段提交。