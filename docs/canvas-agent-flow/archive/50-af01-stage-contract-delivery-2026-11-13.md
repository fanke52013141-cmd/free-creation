# AF-01 阶段与输出契约 — 交付备注

日期：2026-11-13（Asia/Shanghai）。状态：**已实施并验收（确定性宿主测试 + 真实桌面三入口定义一致性）**。方案入口：[48-优化方案](48-task-specific-flow-optimization-plan-2026-11-13.md) §10 AF-01。

## 1. 交付范围（对照 AF-01 退出条件）

| 退出条件 | 实现 | 证据 |
| --- | --- | --- |
| 两阶段按声明顺序交接 | coordinator 固定顺序模式：按 `stages` 声明顺序取第一个未分派阶段，确定性推进 | `test/flow-fixed-order.test.ts` 真实宿主（FlowCoordinatorHost + FlowAgentDesktopHost + FlowCommandLedger + FlowAssetStore + SQLite） |
| 字段缺失/人工决定缺失不能越过 | 声明式进入条件解释器 `evaluateStageEntry`；缺字段→`FLOW_STAGE_ENTRY_UNMET` 阻断；缺人工决定→停等；`requireHumanDecision` 阶段无显式人工采用不收尾 | 同上（缺字段阻断、人工采用后继续、零越过分派） |
| 不靠模型任意补写目标 | 固定顺序模式主控**零模型调用**；阶段目标/完成条件逐字来自声明配置 | 同上（coordinatorModelCalls=0，模型工厂被调用即失败） |
| 旧模式保持 | `executionMode` 缺省=旧模型协调语义；存量配置不迁移；`AgentNodeConfigSchema` 新增字段均可选 | 既有 coordinator/runtime/ledger 等 16 文件 345 项回归通过 |
| 正式交付绑定具体产物 | 完成时 `run.outputs`=最后阶段子任务的固定 outputRefs，经 `assets.resolveInputs` 校验 | 同上（outputs=最后阶段产物，重跑幂等不重复执行） |

## 2. 主要改动

- **共享协议**：新增 `src/shared/agent-flow/stage-contracts.ts`（`FlowStageSchema`/`FlowStagesSchema`/`StageConditionSchema` + 纯函数 `evaluateStageEntry`）。首版条件限于方案 §4.3：字段存在/缺失/等于/类型、输出数量、人工已采用、审核已通过；不执行任意脚本。`AgentNodeConfigSchema` 加可选 `executionMode`/`stages`（strict + superRefine：fixed-order 必须带 stages、承载节点须在授权范围、顺序模式禁并行）。`declarations.ts` 增阶段承载节点图校验。
- **固定协调**：`coordinator-host.ts` 新增 `fixedOrderStep`/`stageFacts`/`dispatchDecision`（模型决策与固定顺序共用分派尾段）；`task-store.ts` 增 `humanAccepted`（只读已持久化 human 续接事实）；`desktop-host.ts` 增 `humanDecision`。沿用既有命令账本/占用/幂等/恢复，不另建执行器。
- **输出适配（同源派生）**：`video-adapter.ts` 新增 `flowDeclaredOutputPort`/`aiProcessFlowOutputPort`/`humanTaskFlowOutputPort`；ai-process 调度输出端口由保存配置 `mode` 派生（text/markdown/json），human-task 由 `outputType` 派生（text/json）。`asset-store.ts` 资产登记、`command-ledger.ts`/`desktop-host.ts` 准入与适配器共用同一派生入口；投影沿用既有 `projectAiProcessOutputsShared`/`projectHumanTaskOutputs`。
- **GUI**：`agentFlow.tsx` 主控设置新增「执行模式」选择与阶段编辑器（阶段标识/承载节点/目标/完成条件/人工采用/进入条件），固定顺序模式隐藏决策模型与并行调度；`agentFlow.css` 增阶段编辑器样式。外部经既有 `graph.patch` 写同一配置、`bind` 同一 Schema 校验，**无新增/修改外部操作**。
- **诊断**：新增 `agent.coordination.stage_dispatched`/`stage_entry_blocked`/`stage_human_decision_missing`（已登记 `observability/events.ts` 白名单，只记阶段身份/承载节点/计数/稳定原因码）。开始/唯一终态复用既有 `agent.coordination.started/completed/failed`，不重复终态。

## 3. 验证证据（分级）

- **确定性宿主测试（无计费）**：`test/flow-stage-contracts.test.ts`（11）+ `test/flow-fixed-order.test.ts`（7，含零主控模型调用、缺字段/缺人工决定不越过、发布中断 reconcile 不重放、诊断脱敏）。真实宿主 + SQLite，仅模型端口替身。
- **回归**：coordinator/runtime/command-ledger/assets/node-contracts/declarations/target-matrix/video-adapter/output-set/flow-target-text/human-task/config-diagnostics/flow-agents-access/agent-run-access 共 16 文件 345 项；node-compliance/composite-executor/composite-runtime/asset-canvas 共 4 文件 29 项，全部通过。
- **真实桌面三入口定义一致性（无计费）**：`scripts/acceptance/af01-stage-parity.cjs` 5 项全过——CLI graph.patch 写入固定顺序阶段 → CLI node.get 回读一致 → MCP node_get 回读完全一致 → GUI 设置面板渲染执行模式+2 阶段+1 进入条件（目标逐字一致）→ GUI 保存后 CLI 回读一致。截图 `qa/af01-stage-parity/gui-stage-editor.png`。
- **门禁**：`guard:agent-parity` 三关全绿（169 操作 / 190 IPC + 50 画布动作 / 日志门禁）；契约快照零 Schema 变化（纯加性）；`npm run lint` 0 错误；typecheck 0 错误；`CANVAS_OWNER=1` 构建成功。

## 4. 未覆盖边界（如实）

- 未做真实 GUI 鼠标共创长任务与真实模型固定顺序运行（需另行确定模型与费用预算；本包以确定性宿主测试证明协调语义，以真实桌面证明三入口定义一致）。
- AF-02～AF-07 未实施：ContextManifest 输入编制、ExecutionEnvelope 真实内容指令、连续共创 UI、阶段验收/局部返工、复用评测、嵌套人机 Flow 均不在本包。
- 固定顺序模式当前承载节点限专业 Agent 子节点；纯人工阶段经 specialist 协作包裹（与现状一致），直接 human-task 承载留待后续包按方案 §4.3 扩展。
- 诊断包导出后的字段抽查未做。

## 5. 兼容结论

`AgentNodeConfigSchema` 新增字段均可选，旧 `schemaVersion:1` 配置解析与语义不变；外部操作 Schema 零变化（契约快照比对通过）；ai-process/human-task 输出端口派生对旧 text 配置结果不变（仍 out-text），仅放开 markdown/json。无数据迁移。