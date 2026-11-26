# 2026-11-24 BL-10 节点流即能力：能力目录自动生成交接

状态：**已实现并提交**（本文件所在提交）；完整 `npm run verify` 退出码 0（证据 `qa/verification/run-WdMVSl/status.json`，2026-11-24T05:46–06:19Z）。
基线：`76a487b5`（2026-11-24 12:47 +08:00，`origin/main`）。
本文件是历史交付记录（证据链），不描述"当前能力"；49 号 §2 仅为 2026-11-13 历史快照。当前状态见 [AGENT_FLOW_SPEC](../../AGENT_FLOW_SPEC.md)、[BACKLOG](../../BACKLOG.md) 与[机器契约](../../local-agent-access/generated/contracts.json)。

## 0. 一句话结论

把「节点流」变成 Agent Flow 的一等能力：已发布版本自动进入能力目录，FlowGraph 用 `capabilityRef` 引用后能校验、编译、落画布并交付；编译器不再认识任何能力 ID，能力目录由节点注册表 + 发布仓库**生成**。

## 1. 改动

### 1.1 唯一能力目录（`src/shared/agent-flow/capability-catalog.ts` 新增）

- **节点能力**：逐项取自 `GENERATED_NODE_CONTRACTS`（节点注册表在 jsdom 下导出的快照），端口、契约版本与画布同源；媒体/文本 7 项声明编译载体与计划面，其余节点如实标记 `agentSchedulable:false` + 原因。
- **节点流能力**：每条已发布版本一条描述——公开端口（`in-*`/`out-*`）、NF-13.2 参与形态下限（`requiresManualGate` / `waitForInput` / 含 `human-task` → 至少 collaborative）、由内部节点推导的成本/网络、固定版本摘要。
- **计划面**：`planCapabilityCatalog()` 取代 builder 里第二份 7 项映射；`text-template`/`text-pass` 作为 processor 操作变体登记。
- **对外 DTO**：`capabilityCatalogDto` 剥离编译载体配置与 builder 钩子；CLI/MCP 只看到能力契约。

### 1.2 FlowGraph 能力引用

- `FlowNode` 新增可选 `capabilityRef: { kind: 'node' | 'composite', id, version }`；旧 `capability: id@version` 继续按 node 能力解析（历史 JSON 兼容）。
- 校验即准入：`CAPABILITY_UNKNOWN` / `CAPABILITY_NOT_SCHEDULABLE` / `CAPABILITY_PARTICIPATION_BELOW_FLOOR` 在编译前拒绝；`collaborative` 现在允许出现在 capability 节点（agent 仍要求 decisions）。
- 编译器：能力载体从目录解析（不再有 `CAPABILITY_COMPILE` / `FLOW_GRAPH_CAPABILITY_IDS`）；节点能力重映射到真实端口，节点流能力保留公开端口；`composite` 实例配置写入 `capabilityId/version/contentHash`（固定版本）。

### 1.3 三入口

- `flowAgent.catalog` 新增 `capabilities`（节点 + 已发布节点流），MCP 工具的输出 Schema 自动包含；`flowGraph.validate/compile` 用同一目录（main 侧把已发布版本注入）。
- builder 的 `TARGETS` 从目录派生，计划面校验规则也由目录的 `instruction/template/reviewable` 驱动。

## 2. 验证

| 检查 | 结果 |
| --- | --- |
| 新增单测 | `test/capability-catalog.test.ts`（10 项：目录完整性、载体、参与下限、成本/网络、旧写法兼容、未知/不可调度/低于下限拒绝、composite 编译） |
| 外部入口 | `test/local-agent-flow-agents-access.test.ts`（17 项：发布 → `flowAgent.catalog` 可见 → `flowGraph.validate/compile` 通过；未发布引用拒绝） |
| 既有回归 | `flow-graph-compiler`、`flow-graph-validation`、`agent-flow-builder`、`builder-expressiveness`、`flow-graph-build`、`flow-graph-definition`、`flow-graph-ops`、`local-agent-parity`、`agent-flow-plan-*` 共 192 项通过 |
| 铁律三关 | `guard:agent-parity` 全绿（192 操作 / 204 IPC + 50 画布动作 / 254 分母） |
| 契约 | `test:contract` 331；契约快照与 `change-impact.json` 按 `--accept-contract-change` 刷新（`capabilityRef` 为可选加性字段） |
| 完整门禁 | `npm run verify` 退出码 0（`qa/verification/run-WdMVSl/status.json`：3857 通过 / 7 跳过；浏览器 34 脚本、构建与桌面验收全过） |

## 3. 未覆盖边界（如实）

1. **最小输入编制（ContextManifest → 公开输入）与真实端口类型校验**：NF-13.4 仍为【目标】，随 BL-11（FlowGraph v2：params/真实端口/子图循环）与 BL-12 推进。
2. **节点流内部的真实模型/供应商调用**未在本批发起计费请求；运行/交付沿用既有复合执行器与固定版本账本。
3. **其余 26 个节点类型**目前不可从 FlowGraph 调度（目录里如实标注原因）；开放它们需要各自的编译载体与配置默认值，属后续增量。
4. **安装包与源码一致性**未核查。

## 4. 唯一下一步

按 [BACKLOG](../../BACKLOG.md)：**BL-11 FlowGraph v2**（`params` 按目标节点 config schema 校验、数据边使用真实端口并取消端口重映射、子图循环 `loop.body[]`）→ BL-12/13/14（节点流规范落地）。

## 5. 复跑命令

```powershell
node scripts/run-vitest.cjs run test/capability-catalog.test.ts test/local-agent-flow-agents-access.test.ts
npm run guard:agent-parity
npm run verify
```
