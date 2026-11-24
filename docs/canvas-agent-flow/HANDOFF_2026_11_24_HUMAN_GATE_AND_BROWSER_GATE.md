# 2026-11-24 人工门禁、返工预览与浏览器门禁修复交接

状态：**已提交并推送**（`8a2444a`、`8cec947`）；`npm run verify` 退出码 0（证据 `qa/verification/run-VZf1qi/status.json`，2026-11-24T02:29–02:49Z）。
本文件是历史交付记录（证据链），不描述"当前能力"；当前支持矩阵仍以 [49 号 §2](49-af00-baseline-and-sample-2026-11-13.md) 为准，并按本文 §6 的口径阅读。

## 0. 一句话结论

把「人参与」从**不可信**变成**可验证**：等待语义能区分真假待办、外部不能伪造人工继续、人工采用绑定到具体等待修订；同时补上返工前的**影响预览 + 确认弹窗**；并修掉了卡住完整门禁的节点 UI 回归。

## 1. 可演示的产品路径

1. **人机协作接力**：协作 Agent 停等 → 右侧「待你处理」列出真待办（人工任务/协作 Agent/主控待采用/审核复审/缺料）→ 点回节点 → 人在 GUI 继续或提交 → 任务推进。
2. **阶段人工采用**：固定顺序主控的 `requireHumanDecision` 阶段，没有本阶段的人工采用就不收尾。
3. **返工与摒弃**：点「从此阶段返工」先看到**将作废的交付、保留的上游、影响阶段数、当前轮次/上限**，确认后才执行；取消零副作用。
4. **纯 AI 阶段**自主运行，不产生假待办；外部程序也无法凭一个 `continue` 推过人工门。

## 2. 本轮改动范围

### 2.1 `8a2444a` feat(agent-flow): 人工门禁可信化 + 返工影响预览 + 节点流编辑页体验对齐

| 范围 | 落点 |
| --- | --- |
| A3 等待语义 | `waitReason`（`human/active-child/pending-review/blocked/paused`），只有 `human` 才映射 `waitKind=human`；`coordinator-host.ts` 的 `view()` 不再把所有 waiting 报成人工 |
| A1 收件箱 | `shared/agent-flow/human-inbox.ts` 扩到五类来源；`CanvasSidePanel.tsx` 按主控节点轮询 `flowRunOverview` 合并 `needsYou` 步骤（审核复审/返工确认），缺料阻塞按稳定原因码单独标记 |
| P0-2 外部继续 | `flowAgent.run(continue)` 命中人工等待时经 `desktop.ask` 人工确认；`humanConfirmed` 只由可信入口标记（IPC sender 校验后 / 外部确认后），外部输入无法自造 |
| P0-3 采纳不伪造 | 去掉 `accepted ?? true`；缺本等待修订的人工提交或可信确认时抛 `HUMAN_DECISION_REQUIRED`（**只约束 `continue`**，见 §6.5） |
| P0-4 采绑修订 | `FlowTaskStore.humanAccepted` 只认最近一次等待修订（`flow_agent_responses.wait_revision`） |
| C 组返工预览 | 新增只读外部操作 `flowStage.reworkPreview` + `FlowStageReworkImpact`；GUI 改为"先预览、再确认"；IPC/preload/browserMock 三处同步 |
| 编辑页体验 | 初始视图固定 100%（不再 `zoomToFit` 到 92%/160%）；新节点避让已有卡片；顶栏去分隔白线；编辑页打开时主画布不接管 Delete/Ctrl+C/V/D；二级菜单恢复鱼眼特效与拖拽建节点 |
| 验收登记 | `desktopTested`：agent 0→2、state-machine 0→4、ai-review 0→2、human-task 0→4（依据 §4.2 的真窗口回执）；`02-capability-matrix.md` 口径改为以机器真值为准（33 节点） |
| 每日门禁 | `verify:daily` / `verify:daily:fast` + `scripts/daily-gate.cjs` + `docs/local-agent-access/DAILY_GATE.md` + 17 项单测 |

### 2.2 `8cec947` fix(node-ui): 恢复 AI 处理只展示输出，修复浏览器门禁与节点交互回归

| 根因 | 修复 |
| --- | --- |
| AI 处理节点重新出现「已连接输入」引用条：2026-10-05 裁决「AI 处理仅展示输出」，2026-09-10 `a69b1a8` 重写专用输入面表达式时漏掉 `ai-process` | `NodeCardView.tsx` 恢复 `ai-process` 到专用输入面，注释记明裁决与回归提交 |
| `ModalShell` 的 Esc 在 window 捕获阶段先触发，弹窗内下拉按 Esc 会把整个弹窗关掉 | 内层 `listbox/menu` 处于 open 时 Esc 交给它处理 |
| 资源库两个表单迁到 `ModalShell` 后丢了作用域类，聚焦回落到全局蓝色光环 | 补回 `library-category-dialog` / `library-resource-form-dialog`，`library-forms.css` 同时支持新壳 |
| 三个浏览器门禁断言与当前实现不符 | AI 结果滚动面改为 `div.ai-process-result-frame`；引用候选改 `.ref-card-play`；节点流条目按 2026-11-23「去运行」裁决改为"点卡片铺开到画布后再运行" |
| 上一轮 P0-3 守卫过宽，把 `reconcile/restore` 也判成伪造 | 守卫只约束 `continue`；`reconcile/restore` 保持系统恢复语义 |

## 3. 契约与三入口

- 外部操作：**192 个**（新增只读 `flowStage.reworkPreview`）；IPC 通道 **204**；画布动作 **50**；动作分母 **254**。
- 新增 IPC `flow-agents:stage-rework-preview`，preload 暴露 `flowAgentStageReworkPreview`，browserMock 同步返回 `null`。
- 数据面：**无数据库迁移**；新增字段均为可选（`FlowAgentView.waitReason`、`FlowAgentRun.humanConfirmed`），旧调用行为不变。
- 铁律三关：`guard:agent-parity` 全绿（契约 / 业务动作分母 / 日志门禁），`change-impact.json` 已按规则刷新（两次写入均带兼容结论）。

## 4. 验收与证据

### 4.1 完整门禁

| 检查 | 结果 |
| --- | --- |
| `npm run verify` | **退出码 0**（`qa/verification/run-VZf1qi/status.json`：`passed`，02:29–02:49Z） |
| 其间包含 | lint、双端 + model 类型检查、全量单测（约 3831 通过 / 7 既有跳过）、`test:model`、契约三关、**浏览器行为门禁 31 个脚本**、生产构建、agent-flow 桌面验收（含 R09） |
| `guard:agent-parity` | 三关全绿（192 ops / 204 IPC / 254 动作） |

### 4.2 逐个真窗口回执（`desktopTested` 登记依据）

| 节点 | 动作 | 脚本与证据 |
| --- | --- | --- |
| agent | N2/N4 | `scripts/acceptance/agent-flow-layout.cjs`、`agent-flow-edges-walkthrough.cjs` → `qa/agent-flow-layout/receipt.json`、`qa/agent-flow-edges/receipt.json` |
| state-machine | N2/N5/N6/N7 | `scripts/acceptance/agent-flow-state-machine.cjs`（7 项全过）→ `qa/agent-flow-state-machine/receipt.json` |
| ai-review | N2/N4 | 同上两个布局/连线脚本（审核节点创建、review-gate 控制线） |
| human-task | N2/N5/N6/N7 | `node scripts/test-agent-flow-human-task-graph.cjs` → `qa/agent-human-task-graph/desktop/execute-report.json`（`status=pass, model=fixture`） |

### 4.3 已知偶发

`test/license-keypackage.test.ts` 在一次完整 verify 中失败（断言"错误密码与篡改同一错误码"），单独复跑 7/7 通过；判定为既有偶发，未修改该测试。

## 5. 日志覆盖

- 本批**未新增诊断事件**：人工确认拒绝/超时沿用既有 access 失败记录与错误码（`HUMAN_DECISION_REQUIRED` / `DESKTOP_UNAVAILABLE` / `HUMAN_DENIED` / `HUMAN_DECISION_TIMEOUT`）；确认框内容不写日志或诊断（与 2026-11-22 BL-01 口径一致）。
- 返工预览是只读投影，沿用 `agent.coordination.stage_rework`（执行时）。
- 已在 [LOGGING_COVERAGE](../LOGGING_COVERAGE.md) 追加 2026-11-24 条目。
- **待补**：`agent.human_decision.rejected` 事件（需登记白名单），见 §6.6。

## 6. 未覆盖边界（如实）

1. **`scripts/acceptance/agent-flow-human-task.cjs` 仍失败**：`humanTask.submit` 返回 `OUTCOME_UNKNOWN / phase=connect`。停掉应用、重建 `out/` 后仍复现，属该验收链自身问题，本批未修；human-task 的桌面证据改用 §4.2 的确定性图路由桌面测试，**没有**拿失败回执冒充通过。
2. **外围浏览器脚本仍有 3 个失败**（`test-browser-node-ui.cjs` / `test-browser-panel-sync.cjs` / `test-browser-media-import.cjs`）：已用干净基线（`git stash`）复现同样失败，确认非本批引入；它们**不在** `test:optimization-ui` 门禁清单内，本批未修、也未放宽。
3. **真实付费模型**：未发起计费请求；真实供应商质量/费用/远端撤回未验收。
4. **安装包与源码一致性**：未核查；本轮只跑源码构建与源码验收。
5. **物理掉电 / 磁盘故障 / 长时 soak**：R09 覆盖到脚本级故障注入，不替代真实掉电。
6. **人工拒绝诊断事件未单列**（见 §5）。
7. **`49` 与 `50/51` 的口径冲突未整体重写**：49 §2 仍把 AF-01～07 标为"尚未支持"，与 51 的七包交付不一致；本批只修正了 02 能力矩阵的节点计数口径，49 的滚动更新留待文档收敛。

## 7. 唯一下一步

**修 `agent-flow-human-task.cjs` 的 `humanTask.submit` connect 失败**，恢复该验收链后再把 human-task 的 desktopTested 证据升级为 `agent-flow-human-task` 回执。
随后按优先级：② 补 `agent.human_decision.rejected` 事件与白名单；③ 把 `verify:daily` 的完整模式在本机跑通一轮并留证据；④ 处理 §6.2 的三个外围浏览器脚本（先修行为，不放宽断言）。

## 8. 复跑命令

```powershell
npm run verify                     # 完整门禁（约 20 分钟，需先关闭正在运行的桌面实例）
npm run guard:agent-parity         # 铁律三关
npm run verify:daily -- --list     # 每日门禁计划（不执行）
npm run verify:daily:fast          # 每日门禁静态档
node scripts/run-optimization-ui-gate.cjs          # 浏览器行为门禁（自起 Vite 服务）
node scripts/acceptance/agent-flow-state-machine.cjs
node scripts/test-agent-flow-human-task-graph.cjs
```

## 9. 建议阅读顺序

[完整方案](00-approved-plan.md) → [节点协同规范](05-node-coordination-standard.md) → [审核与返工](07-ai-review-node.md) → 本文件 → [49 号支持矩阵 §2](49-af00-baseline-and-sample-2026-11-13.md)（注意 §6.7 的口径冲突）。