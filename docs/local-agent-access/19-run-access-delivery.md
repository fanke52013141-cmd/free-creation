# F3 交付：外部执行、任务与正式结果骨架

日期：2026-11-08。基线：F2（`b83beee`）。本包让外部 CLI/MCP 能提交执行、等待终态、取消并读取确定性节点的正式输出。

## 1. 实际完成的业务动作（GUI / CLI / MCP 状态）

| 业务动作 | GUI | CLI | MCP | 公共实现 |
| --- | --- | --- | --- | --- |
| 运行单节点（读取已持久化上游） | ✅ 节点运行按钮 | ✅ node.execute(single) | ✅ node_execute | renderer `runNodeManually`（GUI 同一函数） |
| 运行所选节点及上游闭包 / 整图 | ✅ 多选运行/画布运行 | ✅ node.execute(subgraph) | ✅ 同上 | renderer `runWorkflowForNodes`；付费上游重跑需 confirmPaidRerun（GUI 确认弹窗的委托等价，未确认返回 PAID_RERUN_CONFIRM_REQUIRED） |
| 取消运行 | ✅ 顶栏停止 | ✅ run.cancel | ✅ run_cancel | 取消请求（账本登记）与取消确认（宿主报告）分离；宿主停止入口与顶栏同一 |
| 查询任务状态 | ✅ 运行时间线 | ✅ run.get（node-run / flow-agent-task 双分支） | ✅ run_get | main `external_runs` 账本（M21 迁移）为唯一终态拥有者；宿主经受控报告 IPC 回填 |
| 等待终态 | —（GUI 同步等待） | ✅ run.wait | ✅ run_wait | 服务端有界轮询（≤120s），超时返回当前状态不伪造 |
| 读取正式输出 | ✅ 卡片/详情面板 | ✅ output.get | ✅ output_get | shared `DETERMINISTIC_PROJECTIONS`（text/json/processor/媒体引用等14类已登记）；未登记类型返回 UNSUPPORTED_CONTRACT，不伪造 |

未接入（如实登记）：run.list/run.events/run.reconcile（下一包）；output 导出/物化（F4 起）；结果版本选择 canvas.node.result-select 仍为 F3 计划项。

## 2. 公共契约与一致性处理

- Registry 新增 node.execute（effect=execute）、run.wait、run.cancel、output.get（共32项操作）；`validateAccessRegistry` 效果白名单增加 execute。
- run.get 输出演进为按 `source` 的 tagged union：`flow-agent-task` 分支字段逐项不变（旧客户端兼容），新增 `node-run` 分支（taskId/state/mode/nodeIds/cancelRequested/error/hostResident）。`--accept-contract-change` 已随兼容结论确认。
- 任务协议：completed 表示"本次提交已持久受理"，响应内含 taskId 与当前 state；最终成果只由 run.get/run.wait 的终态判定。宿主拒绝（引擎忙、付费重跑未确认）→ failed + 稳定码；握手失联 → 任务保持 accepted/running，重放幂等键返回原回执，不盲目重发。
- 状态机单向：accepted → running → completed/failed/cancelled；cancel-requested 由 run.cancel 登记；重复报告幂等忽略。报告 IPC 只接受状态码与 ≤500 字符稳定摘要，sender 必须是主窗口 webContents。

## 3. 验证证据（本工作区实测）

| 检查 | 结果 |
| --- | --- |
| `npm run typecheck` | 通过 |
| `test/local-agent-run-access.test.ts`（受理→终态、迟到终态等待、宿主拒绝→failed、失联→unknown+幂等重放、取消两阶段、确定性输出投影、未登记类型拒绝） | 7 项通过 |
| `test/local-agent-access.test.ts` + graph + planner + node-compliance | 合计 62 项通过 |
| `test/db-migrations.test.ts`（M21 external_runs） | 通过 |
| `npm run verify:agent-access` | 通过：32 操作 |
| `node scripts/audit-business-actions.cjs` | 通过：206 动作，29 项 external |
| ESLint（本包文件） | 通过 |

## 4. 日志覆盖

- 外部执行沿用 `agent.access.*` 生命周期（唯一终态拥有者）；宿主报告走 `agent.access.task_running/completed/failed/cancelled` 事件，携带 `upstreamTaskId`（任务账本关联），不重复写业务终态。
- 任务账本只存状态、范围（nodeIds）、≤500 字符稳定错误摘要；提示词、正文、配置值不入库不入日志（测试断言保持）。

## 5. 尚未支持 / 仅模拟验证

1. **真实 Electron 引擎执行未验收**：node.execute 的 renderer 路径由服务级 mock 宿主测试覆盖；真实桌面（引擎 + 保存协调器 + 节点 meta 落盘）在里程碑脚本验收。
2. run.list / run.events / run.reconcile 未实现（断线后的对账目前用 run.get + 幂等重放）。
3. output.get 覆盖确定性/媒体投影14类；website/code/storyboard/iterate/director 等类型明确返回 UNSUPPORTED_CONTRACT，随各节点族包接入。
4. 付费模型执行路径未做真实供应商验收（无预算授权；本地确定性流程不受影响）。

## 6. 下一工作包

里程碑验证包：真实 Electron 桌面脚本（复用 scripts/test-agent-flow-desktop.cjs 模式）执行完整场景——A/B/C 三项目画布批量建图（graph.patch）→ 确定性文本流程执行（node.execute）→ output.get 读取 → 保存重启 → GUI 打开核对；同场景覆盖非法操作不留半图、不覆盖未保存修改、幂等重放。之后进入 F4 图片素材。
