# ①P5 收尾详细实施方案：外部生成 → 人工确认 → 落画布闭环（2026-11-14）

> 路线已拍板：①P5 收尾 → ②三形态节点 → ⑤真实模型样片 → ④版本化 → ③并行。
> 本文是 ① 的详细方案 + 决策点。**设计方案，未改代码**；按惯例你拍板 D1–D6 后分阶段实施。
> 全部结论已读源码核实（builder-host / flow-build-actions / flow-agents-ops / flow-graph-compiler / 渲染器预览管线）。

---

## 〇、现状与缺口（读源码核实）

**已有（必须复用，不重建）：**

| 已有能力 | 源码 | 复用角色 |
|---|---|---|
| 只读校验/编译 | `flow-agents-ops.ts:539/556` `validateFlowGraphOp`/`compileFlowGraphOp`（外部 CLI/MCP，**GUI 未暴露**） | propose 的校验+编译内核 |
| 提案持久化骨架 | `builder-host.ts` `FlowBuilderHost.handle`（propose/inspect/authorize/confirm/discard）+ `flow_builds` 表 + `committed()` | 预览持久化 + 提交核对 |
| **渲染器权威落画布** | `flow-build-actions.ts` `commitFlowBuild(editor, preview)`（GUI 与 CLI/MCP **共用唯一_apply 路径**） | 落画布唯一权威 |
| 幽灵预览层 | `FlowBuildPreviewLayer.tsx` + `flow-build-preview-store.ts`（项目级 ghost overlay，非真实 shape） | 预览渲染 |
| 外部 parity 骨架 | `flow-agent-build-ops.ts` `flowAgent.build.inspect/propose/commit` → `flow-bridge.ts` → desktop-request `{action:'flow-build'}` → CanvasEditor `onLocalAgentDesktopRequest` → 同一 `commitFlowBuild` | CLI/MCP 经渲染器落画布 |
| CAS/占用/幂等守卫 | semanticRevision 三道检查 + `FLOW_CONTROL_OCCUPIED`/`FLOW_BUILD_CONFLICT`/`FLOW_BUILD_UNCONFIRMED` + graphVersion 乐观锁 + `buildId`/`meta.flowBuildId` 幂等 | 安全边界原样复用 |

**真正的缺口（本方案要补）：**
1. **propose 入口**：builder 的 propose 依赖 builder 角色节点 + `model.build` 生成 plan + 源 text 节点；`flowGraph.propose` 接收**外部已生成的 FlowGraph**，无 builder 节点、**不调模型**，纯校验+编译+持久化。
2. **预览 UI 入口**：builder 预览挂在 builder 节点卡片（`FlowBuilderControls`）；flowGraph 无 builder 节点，需项目级"外部建图预览"确认入口。
3. **confirm 落画布闭环**：`flowGraph.validate/compile` 目前只读、不落画布；缺 propose→preview→confirm→落画布。
4. **编译器两处补全（关键 bug 级缺口）**：
   - `flow-graph-compiler.ts:189` coordinatorConfig **未设 `executionMode:'graph'` + `graph`** → 落画布后会退回模型驱动分派，而非声明式图路由（graphStep）。**必须补**，否则落画布后执行不走 P3/P4。
   - 编译产物节点**无 x/y 布局** → 落画布需 `layoutGraph`（builder-host 已 import）排版。

---

## 一、目标与非目标

**目标：**
- G1：外部 Agent 产 FlowGraph → `flowGraph.propose`（校验+编译+持久化预览，**不写画布、不调模型**）。
- G2：人在 GUI 看幽灵预览 → 明确"确认落画布" → `commitFlowBuild` 渲染器权威 apply（单撤销步 + 保存屏障）。
- G3：`flowGraph.confirm` 核对**已保存图**含预览节点（`committed()`）才置 committed；**外部 Agent 不能自确认**（必须经渲染器）。
- G4：落画布后 coordinator 走 `executionMode:'graph'` 声明式图路由（衔接 P3/P4）。
- G5：三入口一致（GUI/CLI/MCP 同包 propose/preview/confirm/discard，parity 铁律）。

**非目标：**
- 不调模型生成图（外部 Agent 已是生成方；与 builder 的本质区别）。
- 不绕渲染器权威（main 不直写画布）。
- 不做 P6 版本化（④单独做；本期预览持久化即可）。
- 不扩非 agent 节点执行（②单独做；本期 propose 仍按 graph 首期范围校验）。

---

## 二、操作设计（新增 4 个外部 op + GUI 入口）

| op | effect | 输入 | 输出 | 说明 |
|---|---|---|---|---|
| `flowGraph.propose` | write | `{projectId, graph: FlowGraph, requestId}` | `{buildId, state:'preview', semanticRevision, nodes, edges}` | 校验→编译→布局→持久化预览；幂等（buildId=hash[projectId,anchor,requestId]）；占用/CAS 守卫 |
| `flowGraph.preview` | read | `{projectId, buildId?}` | `BuildPreview \| null` | 读预览；若已保存图含预览节点自动 promote committed（同 builder inspect） |
| `flowGraph.confirm` | write | `{projectId, buildId}` | `{state:'committed', graphVersion, nodeIds}` | **经渲染器 commitFlowBuild 落画布**后核对 committed；外部不能绕渲染器 |
| `flowGraph.discard` | write | `{projectId, buildId}` | `{state:'discarded'}` | 取消预览 |

> `flowGraph.validate/compile` 保留为只读纯函数（外部迭代修正用，AFlow 式生成+反馈）。propose 内部复用它们。

**propose 与 builder 的关键差异：**
- 无 builder 节点依赖、无 `model.build`、无源 text 节点校验。
- 锚点 nodeId（决策点 D2）：builder 用 builder 节点 id；flowGraph 用编译产物 coordinator id（`coordinator:<graphId>`）作持久化/预览/占用锚点。
- 校验失败 → 结构化错误码回外部（可迭代修正），不持久化。

---

## 三、渲染器权威落画布（复用 commitFlowBuild，不新建第二权威）

`commitFlowBuild(editor, preview)` 现有 10 步序列原样复用：
1. currentProject 守卫 → 2. ensureCanvasSaved 前屏障 → 3. main authorize CAS → 4. openProject + 渲染器 CAS（canvasSemanticRevision）→ 5. 逐节点 preflight（registry/contractVersion/shape 不存在）→ 6. markUndoPoint 单撤销步 → 7. editor.run(createShape 节点 + createEdge 边，失败仅删本步新建) → 8. ensureCanvasSaved 后屏障 → 9. main confirm 核对 committed → 10. select。

**flowGraph 接入点：**
- 预览节点需带 x/y（编译器补 layoutGraph）+ `meta.flowBuildId`（commitFlowBuild 已写）。
- confirm 走与 `flowAgent.build.commit` 相同的 desktop-request 机制（flow-bridge → CanvasEditor → commitFlowBuild），**CLI/MCP 也经渲染器**，外部不能自确认。
- 预览层复用 `FlowBuildPreviewLayer` + `flow-build-preview-store`（项目级，已支持多预览）。

---

## 四、预览 UI（决策点 D4）

- 复用 `FlowBuildPreviewLayer` 幽灵预览（项目级 ghost overlay）。
- 新增**项目级"外部建图预览"面板**：列出本项目 pending flowGraph 预览（graph 名/目标/节点数/边数/状态），每条带"确认落画布"/"取消"按钮 → 调 commitFlowBuild / discard。
- 不挂 builder 节点卡片（flowGraph 无 builder 节点）。

---

## 五、编译器补全（关键，落画布后执行的前提）

1. `compileFlowGraph` coordinatorConfig 补 `executionMode:'graph'` + `graph`（FlowGraph 原样），使落画布后 coordinator 走 `graphStep`（P3/P4）。
2. 编译产物节点补 x/y（`layoutGraph` 排版，与 builder 预览同构）。
3. 单测：编译产物 coordinator 含 executionMode:'graph'+graph；布局坐标有限且无重叠。

> 注意：补 executionMode:'graph' 后，`flowGraph.compile` 只读预览的输出 schema 需同步（coordinator config 字段），并刷新契约快照。

---

## 六、三入口 parity + 日志 + 节点协议（铁律）

- **parity**：4 个新 op 同包 GUI/CLI/MCP；`npm run guard:agent-parity` 绿；只读 preview 入 `EXTERNAL_ONLY_OPERATIONS` 评估；propose/confirm/discard 为 write，需公共契约+Schema+兼容说明+测试。刷新 `check-agent-access.cjs --write --reason "<English>"` + `audit-business-actions.cjs --write`。
- **日志**（LOGGING_SPEC）：propose（开始/校验失败/持久化终态）、confirm（落画布开始/committed/失败阶段）、discard、graph 路由分派已有 `agent.coordination.graph_dispatched`；补 propose/confirm 诊断事件 + 脱敏（不记 graph 正文/密钥）；更新 LOGGING_COVERAGE.md。
- **节点协议**：编译产物每个节点过 NODE_CONTRACT_SPEC（contractVersion/ports/executor/projectOutputs）；coordinator/specialist/state-machine 复用现有契约。

---

## 七、分阶段实施（每阶段独立可验收、可提交）

| 阶段 | 内容 | 产出 | 风险 |
|---|---|---|---|
| **P5.1 编译器补全 + propose 持久化** | 编译器补 executionMode:'graph'+graph+布局；flowGraph.propose/preview/discard op（校验+编译+持久化，无模型）+ 单测 | 外部可产预览（不落画布） | 中 |
| **P5.2 预览 UI** | 项目级外部建图预览面板 + 复用幽灵预览层 | GUI 可见预览 | 中 |
| **P5.3 confirm 落画布 + 三入口** | flowGraph.confirm 经 commitFlowBuild + desktop-request；GUI/CLI/MCP 同包；parity 绿 | 闭环落画布 | 中高 |
| **P5.4 执行衔接验收** | 落画布后 coordinator 走 graphStep 端到端（fixture）；真实模型样片（⑤） | 落画布即可执行 | 中 |

> 建议 P5.1 先做（编译器补全是 bug 级前提 + propose 纯持久化低风险），P5.3 接渲染器权威（风险升高，需关 app 跑 verify）。

---

## 八、决策点（需你拍板）

| # | 决策 | 选项 | 建议 |
|---|---|---|---|
| D1 | 复用策略 | A 复用 FlowBuilderHost+commitFlowBuild+flow_builds+flowAgent.build 骨架 / B 新建独立 host+表+commit | **A**：少造轮子，渲染器权威/预览/parity 全复用；解耦 builder 节点依赖 |
| D2 | propose 锚点 nodeId | A 编译 coordinator id / B 外部指定现有 agent 节点 / C 合成 graphId 锚点 | **A**：coordinator 是编译产物天然主控锚点 |
| D3 | propose 是否调模型 | A 不调（外部已生成）/ B 调模型补全 | **A**：外部 Agent 是生成方，propose 纯校验+编译 |
| D4 | 预览 UI 入口 | A 复用幽灵层+项目级确认面板 / B 独立预览面板 | **A**：复用 FlowBuildPreviewLayer+store |
| D5 | confirm 权威 | A 经渲染器 commitFlowBuild（GUI 点确认/CLI-MCP 经 desktop-request）/ B main 直写 | **A**：渲染器唯一权威，外部不能自确认 |
| D6 | 持久化表 | A 复用 flow_builds（加 source 区分 builder/graph）/ B 新建 flow_graph_builds | **A**：复用 committed()/CAS 骨架；加 source 字段区分 |

---

## 九、验收标准

- **P5.1**：非法图 propose 稳定拒绝（结构化错误码）；合法图持久化预览（state=preview，含 executionMode:'graph' coordinator + 布局）；幂等重放返回同 buildId；不调模型（定向测试 modelCalls=0）。
- **P5.2**：GUI 项目级面板列出 pending 预览 + 幽灵层渲染节点/边/状态机。
- **P5.3**：外部 propose → GUI 确认 → 落画布（单撤销步 + graphVersion+1）→ confirm committed；**外部不能自确认**（定向测试）；CLI/MCP 经渲染器落画布；CAS 冲突拒绝；三入口 parity 绿。
- **P5.4**：落画布后 coordinator 走 graphStep 端到端完成（fixture，0 主控决策模型调用）；真实模型样片（⑤，需你配模型+key）。
- **全程**：每阶段 typecheck + 定向单测 + guard:agent-parity + 日志覆盖；接执行阶段关 app 跑 npm run verify。

---

## 十、诚实结论

- **地基厚**：渲染器权威 commitFlowBuild + 幽灵预览 + 外部 parity 骨架 + CAS/占用/幂等守卫全部现成，① 主要是"接外部 FlowGraph 入口 + 项目级预览 UI + 编译器补全"，不是从零造。
- **关键前提**：编译器 coordinator 缺 executionMode:'graph'+graph 是 bug 级缺口，必须先补，否则落画布后不走图路由。
- **不能先验保证**：外部生成图的质量、真实垂类任务好用程度——需 ⑤ 真实模型实测。能保证：校验/编译/落画布正确性（单测）、外部不能自确认（定向测试）、三入口一致（parity）。

> 下一步：请你就 D1–D6 拍板（尤其 D1 复用策略、D2 锚点、D6 持久化表）。确认后我从 P5.1（编译器补全 + propose 持久化）开始，分阶段提交，每阶段遵守三入口铁律 + 日志覆盖 + 节点协议。