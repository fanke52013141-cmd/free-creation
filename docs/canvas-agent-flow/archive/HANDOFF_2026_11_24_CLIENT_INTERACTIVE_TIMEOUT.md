# 2026-11-24 人工决定客户端等待口径、拒绝事件与节点流人工等待交接

状态：**已提交并推送**（本文件所在提交）；完整 `npm run verify` 退出码 0（证据 `qa/verification/run-kXfLHN/status.json`）。
基线：`f0e9b994`（2026-11-24 10:55 +08:00，`origin/main`）。
本文件是历史交付记录（证据链），不描述"当前能力"；49 号 §2 仅为 2026-11-13 历史快照。当前状态见 [AGENT_FLOW_SPEC](../../AGENT_FLOW_SPEC.md)、[BACKLOG](../../BACKLOG.md) 与[机器契约](../../local-agent-access/generated/contracts.json)。

## 0. 一句话结论

修掉「人还没点允许，CLI 先报 `OUTCOME_UNKNOWN`」的错位：交互式操作按人工决定上限等待；人工决定未生效有唯一终态事件；节点流内部人工等待不再被误报成输出契约失败；真机 human-task 验收链 12 项全过。

## 1. 问题与根因

- BL-01 让 4 类操作在返回前 `desktop.ask` 等人点确认（最长 5 分钟）。
- 本地 CLI 客户端 `src/local-agent/client.ts` 对非 `run.wait` 操作统一 15s 响应超时。
- 结果：15s 后人未点 → 客户端销毁 socket 并报 `OUTCOME_UNKNOWN / phase=connect`；main 仍在等待，人随后点允许会继续执行 → **客户端以为失败、服务端后来成功**。`scripts/acceptance/agent-flow-human-task.cjs` 因此卡在 `humanTask.submit`。
- 同批暴露：`composite` 执行器忽略隔离执行的 `waiting` 结果，落到输出投影报「输出契约校验失败」，把「等人」误报成失败。

## 2. 改动

### 2.1 等待口径（`src/shared/agent-access/interactive.ts` 新增）

- `HUMAN_DECISION_TIMEOUT_MS`（5 分钟）、`INTERACTIVE_RESPONSE_TIMEOUT_MS`（+30s 写入余量）、`DEFAULT_RESPONSE_TIMEOUT_MS`（15s）、`isInteractiveOperation` / `responseTimeoutMs`。
- 操作定义用 `interactive: true` 声明：`flowGraph.confirm`、`flowAgent.build.commit`、`flowAgent.run`、`flowAgent.cooperate`、`humanTask.submit`、`provider.package.import`、`provider.package.importProviders`。
- 客户端改为 `responseTimeoutMs(operationId, requestedWaitMs)`：`run.wait` 仍按请求时长 +30s，交互式操作等满人工上限，其余保持 15s。
- main 的 `HUMAN_DECISION_TIMEOUT_MS` 改为从共享模块 re-export，消除两处数字漂移。

### 2.2 人工决定拒绝事件

- 新增 `agent.human_decision.rejected`（`events.ts` 白名单；owner `main/agent-access/human-decision`；level warn）。
- `requestHumanDecision` 增加 `operation` 入参；拒绝/超时/无桌面/目标画布未打开时发唯一终态，attributes 只有 `operation` / `code` / `reason`；确认框正文、任务内容、提示词与密钥不入日志；诊断写入失败不影响拒绝结果。

### 2.3 节点流人工等待

- `compositeExecutor` 处理 `outcome.status === 'waiting'`：返回 `skipped` + 等待原因，不再落到输出投影报「输出契约校验失败」。
- 运行记录保持 `waiting-input`，外部经 `composite.run.submitHuman` + `composite.run.resume` 续跑；已完成步骤跳过（不重跑已付费任务）。

### 2.4 真机验收与浏览器门禁

- `scripts/acceptance/agent-flow-human-task.cjs`：两处人工提交各点一次「允许提交」；节点流段改为 AF-07「等待 → 提交 → 续跑 → 公开输出」；12 项全过。
- 3 个外围浏览器脚本修复并纳入 `test:optimization-ui` 门禁（`scripts/run-optimization-ui-gate.cjs`，优先读 `CANVAS_QA_URL`）：
  - `test-browser-node-ui.cjs`：缺输入时运行按钮可点、24px 端口命中区（v2.2 §22）、遮罩挂在分组 `<g>`、标题行右端运行按钮、说明侧栏实色底。
  - `test-browser-panel-sync.cjs`：两级调色板入口、经工作台设置启用「拆分」、定位画布内容、无原图不渲染预览网格。
  - `test-browser-media-import.cjs`：两级调色板入口、定位画布内容。

## 3. 验证

| 检查 | 结果 |
| --- | --- |
| 单测（新增/修改） | `test/local-agent-interactive-timeout.test.ts`(4)、`test/human-decision-diagnostics.test.ts`(7)、`test/composite-executor.test.ts`(9) 全过 |
| 真机 human-task | `node scripts/acceptance/agent-flow-human-task.cjs` 退出码 0，12 项检查（`qa/agent-flow-human-task/receipt.json`） |
| 浏览器 | node-ui / panel-sync / media-import 全 PASS（已纳入门禁） |
| 铁律三关 | `guard:agent-parity` 全绿（192 操作 / 204 IPC + 50 画布动作 / 254 分母；日志门禁绿） |
| 契约 | `test:contract` 331 项通过；`change-impact.json` 已按规则刷新 |
| 完整门禁 | `npm run verify` 退出码 0（`qa/verification/run-kXfLHN/status.json`） |

## 4. 未覆盖边界（如实）

1. **其余 7 个真机验收脚本仍停在确认框**（BACKLOG BL-01 已登记）：`agent-flow-human-task-dispatch.cjs`、`mcp-acceptance.cjs`、`mcp-acceptance-families-4-5-6-9.cjs`、`mcp-acceptance-gap-fill.cjs`、`mcp-acceptance-optimizations.cjs`、`test-agent-graph-milestone.cjs`、`audit-business-actions.cjs`。
2. **外部 node-run 状态枚举没有 waiting**：节点流等人时 `run.wait` 仍如实报 `failed` + 等待原因，真相以 `composite.run.get` 的 `waiting-input` 为准；若要一等状态需版本化扩展外部枚举。
3. **真实供应商/长任务下的人工拒绝**未做端到端复验；确认框内容不入日志的口径由单测锁定。
4. **安装包与源码一致性**未核查；本轮只跑源码构建与源码验收。
5. `recovery-contention` 是既有全量负载波动项：本轮首跑复现 1 次（`database is locked`），隔离复跑 15/15 通过，最终完整门禁通过；未放宽断言。

## 5. 唯一下一步

按 [BACKLOG](../../BACKLOG.md) P1 主线：**BL-10 节点流即能力**（发布即登记 `capabilityRef`、能力目录自动生成、删除硬编码 `CAPABILITY_COMPILE` / `FLOW_GRAPH_CAPABILITY_IDS`）→ BL-11 FlowGraph v2（params、真实端口、端口类型校验、子图循环）→ BL-12/13/14。

待拍板项见 [11-22 交接 §4](../../HANDOFF_2026_11_22_SPEC_P0.md)：`flowStateMachine.submitEvent` / `composite.run.submitHuman` 是否纳入人工确认、BL-18 阶段 FSM、BL-20 人工媒体交付方式、NF-5.3 输出键前缀。

## 6. 复跑命令

```powershell
node scripts/acceptance/agent-flow-human-task.cjs   # 真机（需 CANVAS_OWNER=1 构建）
npm run guard:agent-parity                          # 铁律三关
npm run verify                                      # 完整门禁（约 30+ 分钟，先关闭桌面实例）
node scripts/run-optimization-ui-gate.cjs           # 浏览器行为门禁（含本次纳入的 3 个脚本）
```
