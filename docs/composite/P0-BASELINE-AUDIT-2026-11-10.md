# P0 基线核查与执行可行性结论

日期：2026-11-10
核查基线：HEAD `544ac25`（工作区新增了本计划与交接文档，未改动业务代码）
依据：[《组合节点能力化实施计划》](../COMPOSITE_CAPABILITY_PLAN_2026_11_10.md)

本轮只做 P0 静态核查与最小结论，不把后续 P1–P5 的设计当成已实现能力。下一阶段从 P1 开始。

## 1. 规范与基线

- `AGENTS.md`、`NODE_CONTRACT_SPEC.md`、`LOGGING_SPEC.md`、`AGENT_PARITY_SPEC.md`、`AGENT_ACCESS_SPEC.md`、`NODE_UI_STANDARD.md` 已阅读。
- **规范冲突**：`NODE_CONTRACT_SPEC.md` 设计原则第 6 条明确“复杂业务优先做工作流模板，不新增把多个步骤藏起来的巨型节点”。本计划的 composite 节点必须同时满足：
  - 不是隐藏内部步骤的巨型 Config；
  - 有公开端口、显式输入输出映射、固定版本、可查看内部图；
  - 内部节点仍用同一种子节点协议。
  因此 P1 必须同步修订 `NODE_CONTRACT_SPEC.md`，把“显式契约的组合节点”列为工作流模板之外的第二条合法路径，否则实现会被现有规范判为违规。
- 当前工作区仅有计划/交接文档和 `docs/local-agent-access/evidence/INDEX.md` 的未提交修改；实施时保留其它人的未提交内容，不覆盖。

## 2. renderer 运行器与 editor 的耦合（P0 核心结论）

`src/renderer/src/engine/executor.ts` 中，单节点执行上下文 `NodeExecutionContext` 的写操作全部落在当前 tldraw editor：

- `updateProps` → `ctx.editor.updateShape(...)`（executor.ts:874-879）
- `updateResult` / `updateMeta` → `ctx.editor.updateShape(... meta ...)`（:880-895）
- `emitArtifact` → `materializeArtifact(ctx.editor, current, ...)`，会在画布上创建结果节点（:896-938）
- `setDiagnosticTarget` / `trace` → `writeRunRecord(ctx.editor, ...)`（:863-867）
- 工作流级入口 `runWorkflow` 还有 `useEngineStore` 阶段、确认弹窗、toast、`deriveGraph(editor)` 等 UI 依赖（:1903-1967）。

但以下关键点可直接复用：

- `NodeTypeSpec.resolvePorts(shape)` 已经存在（registry.tsx:146-151、:456-460），composite 可以由 `props.config` 中的固定 manifest 同步派生实例端口，不需要为每个组合新增静态 TypeScript 类型。
- 节点执行器本身（文本、AI 处理、生图）只通过 `ctx.gateway`、`ctx.inputs`、`ctx.update*`、`ctx.emitArtifact` 工作，不直接依赖 React。
- 媒体落盘、模型调用、诊断都走既有公共入口，composite 宿主只需提供执行上下文与产物捕获。

**结论**：隔离执行可行，但不能直接复用当前 `runWorkflow(editor, ...)`。需要一个 `CompositeRunHost`：

1. 内部图用固定版本 manifest 建立独立 tldraw store/editor（或等价的 graph host），不复用用户当前画布；
2. 复用 `deriveGraph`/`topoSort`/`executeNodeOnce` 的纯图逻辑；
3. 把 `updateProps/updateResult/updateMeta/emitArtifact` 改写到运行快照与产物表，而不是用户画布；
4. 公开输出从 manifest 的 output source 映射读取本次运行的端口产物。

P0 的原型验证目标（下一实现包）是：`text → ai-process → image-gen` 三节点在独立 host 中跑通，输入只注入 text，输出只取 image，不修改用户当前页面。

## 3. 首批可嵌入节点与风险

| 节点 | 是否首批 | 说明 |
| --- | --- | --- |
| `text` | 是 | `outputSource: document`，正文即输出；需要把公开输入映射到 `props.text` 或 `in-text` 端口 |
| `ai-process` | 是 | 纯 gateway 执行器；需要确认其输出是文本/JSON，且不依赖画布结果卡片 |
| `image-gen` | 是 | 通过 gateway 生成后 `emitArtifact` 创建结果节点；组合宿主必须捕获 artifact 而不建用户画布节点 |
| `image` / 媒体资产 | 后续 | 固定媒体依赖与跨项目导入需要额外引用重映射 |
| `video` / `timeline` / `storyboard` / `director` | 暂不 | 有工作台、人工发布或特殊 UI 语义，需单独适配 |
| `agent` / `ai-review` / `state-machine` | 暂不 | 人工门禁与画布 Agent 协同，P5 单独验收 |
| `iterate` / 循环 | 后续 | 有子流程与预算语义，P4 单独验收 |

`image-gen` 的 `emitArtifact` 是最大风险点：现实现会调用 `materializeArtifact` 在 editor 里创建结果节点；组合执行必须把该行为改为“捕获 artifact → 写入运行产物表”，不能把内部结果铺到用户画布。

## 4. 状态与兼容策略

- 现有运行事实已有 `runs` / `run_artifacts` / `meta.nodeRun` 等结构，可承载内部节点执行记录与产物。
- 现有外部 run 状态没有 `waiting-input`；先按计划使用**版本化可选等待详情**，不直接改变旧枚举语义，避免严格旧客户端解析失败。
- 组合运行新增：
  - `rootRunId` / `parentRunId` / `compositeVersion` / `internalNodeRunId` 关联；
  - 公开输出引用与内部运行快照的绑定；
  - 取消向内部子调用传播，未知远端任务不自动重发。
- P0 只确认策略；P1/P2 再落表，避免另建一套权威执行系统。

## 5. 已确认可复用机制

- 节点库模板：`workflow_templates` 保存节点/连线 payload；可复用其“选中节点生成结构”的逻辑，但组合需要稳定内部 ID、端口映射、版本与依赖，不能直接把旧模板当组合。
- 运行补输入：`workflow-inputs.ts` 已有缺项/端口预检与临时文本/JSON/媒体输入；P2 扩展为持久等待请求。
- 外部任务：`runs`、`run_artifacts`、video taskId/`TASK_IN_FLIGHT`/`resumePendingVideoTasks` 可复用于组合运行的任务核对与恢复。
- Agent 接入：`node.library.*` 的注册/分发/契约生成机制可直接扩展到 `capability.*`。

## 6. P1 实施清单（下一包）

1. `src/shared/composite/manifest.ts`：manifest/port/mapping/graph/dependency/executionPolicy 类型与 zod 校验；
2. DB 迁移：`composite_capabilities`、`composite_versions`、`composite_drafts`；
3. `src/main/store/composite.repo.ts`：草稿、发布（不可变版本）、查询、归档、内容摘要；
4. 发布校验：端口存在、映射存在、类型/基数兼容、DAG、递归、依赖、展开预算；
5. GUI“保存为组合节点/转换为组合节点”弹窗（Stitch 参考 + 公共组件）；
6. `capability.*` Agent 操作与 CLI/MCP 接入（与 GUI 同包）；
7. 更新 `NODE_CONTRACT_SPEC.md`、日志覆盖、能力矩阵、change-impact。

P2 起再注册 composite 节点/执行器与运行入口。

## 7. 本轮未验证边界

- 未实现 composite 执行器，未做真实模型链路；
- 未新增数据库表/接口；
- 未重新执行历史测试；P1 开工时按 `npm run verify` 基线重新核实。
