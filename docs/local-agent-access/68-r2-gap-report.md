# R2 缺口补测报告（2026-11-09）

对应测试计划：[66-parity-test-plan.md](66-parity-test-plan.md) §6 的三个"此前没有真实端到端证据"的场景。
本轮用**真实隔离桌面 + 独立 CLI 进程**补测，并修掉补测中暴露的两个真实缺陷，以及两个验证脚本问题（含 R3 全链回归）。

## 摘要

| 项 | 结果 |
| --- | --- |
| A. GUI 反向腿（外部建图 → GUI 撤销/重做 → 外部可读 GUI 未保存正文） | 6/6 通过 |
| C. 画布切换与任务隔离（原"双画布并发"，语义已按产品实际修正） | 6/6 通过 |
| B. 崩溃与回执丢失（执行中硬杀 → 重启 → 结算/占用/零重放/恢复） | 6/6 通过（修复后） |
| 新发现并修复的真实缺陷 | 2 个（遗留任务永久占用、run.wait 长轮询被 15s 切断） |
| 附带修复的验证脚本问题 | 3 个脚本（`test:local-agent-access` 与 `test:diagnostics-window-close` 缺授权目录复制；`optimizations` A3 版本竞态未重试） |
| 未修复观察项 | 2 个（取消语义、计划中的"跨画布并行"假设不成立） |
| 验收脚本 | `scripts/test-agent-parity-gaps.cjs`，已纳入 `npm run verify:acceptance`（`parity-gaps` 批次） |
| R3 全链 | 前段全绿（单测 3111/跳过 7、全部桌面专项至 agent-flow-recovery）；**视频 Agent Flow 11 个脚本为既有回归红点**（HEAD 复现，非本轮引入，见 §五附） |

## 一、范围与计划修正

66 号计划 §6 的三条强制场景：

1. **A 反向腿**：外部补丁进入 GUI 历史栈；GUI 撤销/重做后外部读数一致；外部能读到 GUI 未保存正文。
2. **B 崩溃与回执丢失**：外部执行受理后硬杀桌面，重启后账本如实结算、占用解除、零重放。
3. **C 双画布并发**：计划原假设"多个画布可并行执行"。

产品实际语义（本轮校正）：桌面是**单一活动画布**，运行由当前画布的权威宿主执行；
任务在途时 `project.open` 被 `RESOURCE_BUSY/task-occupancy` 拒绝（保护在途任务，不允许静默带走）。
因此不存在"跨画布并行执行"。C 段改为验证真实语义：**在途切换保护、取消后依次在 B/C 完成、产物隔离**。

## 二、执行与结果

命令：`node scripts/test-agent-parity-gaps.cjs`（可分段 `a` / `c` / `b`）。运行产物在
`qa/local-agent-access/parity-gaps/report.json`（`qa/` 不入库），最终通过证据已归档为
[parity-gaps-2026110905174.json](evidence/parity-gaps-2026110905174.json)。

### A. GUI 反向腿

| 检查 | 结果 |
| --- | --- |
| 外部建 2 节点在权威宿主生效（latest 视图=2） | 通过 |
| GUI 撤销 → 外部 latest 视图 2→0（**整批外部补丁为一个撤销步**） | 通过 |
| GUI 重做 → 0→2 | 通过 |
| 外部补丁 → GUI 撤销/重做 → 外部读数一致（交替编辑闭环） | 通过 |
| 外部读取 GUI 正文（latest/node.get 一致） | 通过 |

备注：外部补丁后 `markUndoPoint('agent-graph-patch')` 使整批补丁为一个撤销步；
键盘必须先点击 tldraw 画布容器（`.tl-canvas`）再按 Ctrl+Z，左侧面板不承载快捷键监听。

### C. 画布切换与任务隔离

| 检查 | 结果 |
| --- | --- |
| A 运行中切画布被 RESOURCE_BUSY 拒绝，A 任务仍在账本 | 通过 |
| 取消 A → 终态（本轮实测 completed，取消请求与完成竞态见观察 O1）；占用释放后可切换 | 通过 |
| B 运行中切 C 被拒；B 完成终态=completed | 通过 |
| 取消 A 后 B/C 依次在各自画布完成（未并行、未丢失） | 通过 |
| B/C 产物各自落盘且互不串台 | 通过 |
| A 的媒体索引不含 B/C 产物 | 通过 |

### B. 崩溃与回执丢失（修复后）

| 检查 | 结果 |
| --- | --- |
| 执行已受理（running）后即硬杀主进程（无正常退出钩子） | 通过 |
| 重启后遗留任务显式结算为 `failed/HOST_RESTARTED`（不伪造成完成） | 通过 |
| 重启后画布可再打开并可写（占用解除，不再永久锁死） | 通过 |
| 重启后零重放：无新产物、媒体数不变 | 通过 |
| 对已结算任务 `run.cancel` 幂等：仍为 failed，不复活 | 通过 |
| 重启后可重新执行同一节点并完成（账本未中毒） | 通过 |

## 三、发现与修复

### F1（严重）崩溃后 `external_runs` 永不结算 → 画布被永久占用

**复现（修复前构建）**：外部受理 9.5s 截取后立即 `taskkill /T /F` 主进程；重启同一数据目录后：

```json
// run.get 实测（证据 parity-gaps-prefix-b-2026110905182.json）
{ "state": "running", "error": null, "hostResident": true }
```

同状态下 `project.open` 被 `RESOURCE_BUSY / task-occupancy` 拒绝（service.ts 的 `taskOccupied`
把 `accepted/running/cancel-requested` 视为占用）。此前没有任何启动结算路径，行会永远停在非终态，
该画布的所有非读操作被永久拒绝。

**修复**（`src/main/agent-access/runs.ts`、`server.ts`、`index.ts`）：

- `settleOrphanedExternalRuns()`：把非终态行单事务结算为 `failed` + `error='HOST_RESTARTED'`，
  保留行、不删除、不重放、不补产物；终态行不改写。
- `startLocalAccessServer` 取得 `local-agent-access-server` **进程锁后**结算（此刻必然是唯一存活
  宿主，不会误伤其他实例）；桌面首次启动传 `settleOrphanedRuns: true`，测试内服务重启不结算。
- 新增诊断事件 `agent.access.runs_settled`（count/states，无 ID/内容），见
  [日志覆盖清单](../LOGGING_COVERAGE.md#2026-11-09r2-缺口验收宿主重启结算遗留外部任务附带-runwait-长轮询连接超时修复)。
- 单测：`test/local-agent-run-access.test.ts` 新增结算用例（running/cancel-requested → failed；
  cancelled 不改写；重复结算为空）。

**修复后实测**：`failed/HOST_RESTARTED`、写操作恢复、零重放、可重新执行。

### F2（严重）`run.wait` 长轮询必然在 15s 被切断

**复现（修复前构建）**：`run.wait` 契约允许 `timeoutMs ≤ 120000`，但：

- 服务端每个接入 socket `setTimeout(15000)` 空闲即销毁（`server.ts`）；
- CLI/MCP 客户端同样固定 15s（`client.ts`）。

等待中的任务一旦超过 15s 没有终态，客户端收到 `OUTCOME_UNKNOWN / phase=connect`
（证据 parity-gaps-prefix-c-2026110905182.json），与"任务仍在跑"的合法状态无法区分。

**修复**：服务端收到请求后把等待上限放宽到 `RUN_WAIT_MAX_TIMEOUT_MS + 90s`；客户端按请求的
`timeoutMs + 30s` 设置 socket 超时。纯连接行为，契约 Schema 与业务终态不变。

**修复后实测**：C 段使用 `run.wait` 90s 正常返回 completed；120s 上限以内的长轮询不再被切断。

### F3（验证链回归）两个旧桌面测试缺少授权目录复制

R3 全链先后在两个步骤失败，均可复现：

- `test:local-agent-access` → `CLI_CREATE_FAILED`（两次独立运行）；
- `test:diagnostics-window-close` → `page.waitForFunction` 30s 超时（业务窗未出现）。

根因相同：脚本用空临时数据目录启动真实桌面，授权门禁只开授权窗，业务 API/接入服务都不存在。
这两个脚本在授权门禁上线后一直没有跑过（全链此前在其他步骤就失败）。修复：与全部 MCP 验收
脚本一致，启动前把本机已激活的 `security` 目录复制进每个隔离数据目录（不伪造签名）。
修复后两者单独运行均通过。发行版（`CANVAS_LOCAL_AGENT_INSTALL_ROOT`）无授权门禁，不复制。

### F4（验收脚本竞态）`optimizations` A3 未按既有模式重试版本冲突

`verify:acceptance` 第一次全量重跑时 A3 失败：`graph.patch` 读到稳定版本 10 后、请求到达前
保存屏障把版本推进到 11，返回 `REVISION_CONFLICT(currentGraphVersion=11)`，脚本未重试。
这是与 R1 修过的 family1/里程碑同类的**测试脚本竞态**（服务端行为正确，结构化版本已回传）。
修复：A3 与同脚本 A1/A2 一致，用服务端回传的 `currentGraphVersion` 重试一次。
连续两次 parity-gaps 与最终 9/9 全量验收通过。

B 段另有一处测试侧健壮性调整：重启后应用自动恢复画布与 `project.open` 握手可能重叠，
宿主回执 `CANVAS_NOT_READY` 时表现为 unknown；脚本对"宿主未就绪"类失败有界重试，
对 `RESOURCE_BUSY/task-occupancy`（真实占用）立即失败，不掩盖本轮修复的缺陷。

## 四、观察与未修复项

### O1 取消语义（未修复，记录证据）

- 受理后约 2s 内取消一个约 3.4s 的截取任务：`running → cancel-requested → completed`。
  **取消请求丢失在完成竞态中**（宿主先完成、回执后到），契约允许"最终状态以宿主回执为准"，但
  调用方无法从终态区分"取消生效"与"跑完了"。
- 75s 级三段子图在 5s 时取消：`running → cancel-requested → failed`，约 31s 后才终态。
  取消能中断执行，但终态是 `failed` 而非 `cancelled`，且 FFmpeg 终止耗时较长。

建议单独评估：把"取消请求"作为宿主启动执行前必须核对的状态，并为被取消的运行回执 `cancelled`
（或至少在 DTO 保留 `cancelRequested`）。本轮不改，避免在未确认 GUI 停止按钮同一语义前改变行为。

### O2 计划假设修正（已写入本报告 §一）

"跨画布并行执行"不是产品能力；在途切换被拒绝是**保护**而非缺陷。66 号计划 §6 的 C 场景按实际语义执行。

## 五、验证证据

| 项 | 结果 |
| --- | --- |
| `npm run typecheck:node` | 通过 |
| `node scripts/run-vitest.cjs run test/local-agent-run-access.test.ts` | 8/8 通过（含新增结算用例） |
| `npm run test:license` | 通过 |
| `npm run build` | 通过 |
| `node scripts/test-local-agent-access.cjs` | 通过（修复 F3 后） |
| `node scripts/test-diagnostics-window-close.cjs` | 通过（修复 F3 后） |
| `node scripts/test-agent-parity-gaps.cjs` | A 6/6、C 6/6、B 6/6 通过 |
| `npm run guard:agent-parity` | 通过（契约 Schema 未变，已按 `--reason` 刷新 change-impact 声明） |
| `npm run verify:acceptance` | **9/9 批次通过**（含新增 `parity-gaps` 批次；证据归档 stamp `2026110905174`） |
| `npm run verify`（R3 全链） | 前段全绿；视频 Agent Flow 11 个脚本为既有回归（HEAD 复现，见 §五附） |

修复前证据（已归档）：

- [parity-gaps-prefix-b-2026110905182.json](evidence/parity-gaps-prefix-b-2026110905182.json) — F1（失败记录在 `failures`）
- [parity-gaps-prefix-c-2026110905182.json](evidence/parity-gaps-prefix-c-2026110905182.json) — F2（异常在 `error` 字段：
  `RUN_WAIT_REJECTED: OUTCOME_UNKNOWN/connect`；归档 INDEX 的"通过"只统计 `check()` 条目）

### 五附. R3 全链结果与归因（2026-11-09）

链路 `qa/verification/run-HRxUrv/`（在修复 F3 前启动，随后用单跑补齐）：前段**全绿**——
lint、typecheck ×4、typecheck:model、单测 **3111 通过 / 7 跳过**、model 2、verify:logging、
verify:agent-access、test:optimization-ui、build、test:local-agent-access、test:diagnostics-window-close、
test:agent-flow-assets / commands / desktop / collaboration / coordination / builder / builder-parallel /
review / rework / recovery。

**红点（既有回归，与本轮无关）**：以下 11 个脚本稳定失败——

| 脚本 | 错误 |
| --- | --- |
| video / video-first-frame / video-first-last-frame / video-reference / video-motion-reference / media-transfer / video-audio-reference / video-multi-reference | `AGENT_EXECUTE_VIDEO_UNKNOWN_NOT_HELD` |
| video-rework | `AGENT_EXECUTE_VIDEO_REWORK_UNKNOWN_NOT_HELD` |
| parallel-review | `AGENT_EXECUTE_PARALLEL_REVIEW_UNKNOWN_NOT_HELD` |
| parallel-media | `AGENT_EXECUTE_PARALLEL_PARTIAL_RESULT_LOST` |

失败现场（`qa/verification/run-HRxUrv/qa/agent-video-20261015/desktop/execute-report.json`）：
`acceptanceStage={"mode":"text","rootCode":"FLOW_REVISION_CONFLICT","childCode":"FLOW_REVISION_CONFLICT"}`，
即供应商 unknown 应把流程停在 `waiting/reconcile`，实际在命令 `saved-revision` 阶段发生版本冲突。
通过的同类：`video-review`、`media-review`、`r09-local-reliability`。

**归因证据**：把本轮修改的 4 个源文件（runs.ts、server.ts、index.ts、client.ts）回退到 HEAD
（`6196625`）重建，`test:agent-flow-video` 以**完全相同错误**失败 → 与 R2 无关。
最后一次全链绿为 2026-10-24（`run-v3mcD2`）；此后候选提交包括 `194e19b`（本地交付/审查 P1 修复）、
`2a0b38b`（timeline）、`820e07b`（Flow 命令账本外部接入）。

**结论**：R2 相关路径（接入服务、CLI/MCP、GUI 反向腿、崩溃恢复）全部绿；视频 Agent Flow 的
unknown 保持 / 并行部分产物是**历史回归**。截至本报告归档时未修复；后续已在独立优化轮次
完成根因修复（taskId 从 config 移入 meta + 语义修订归一化），见
[69 视频 Flow 回归修复](69-video-flow-revision-fix.md)。

## 六、日志与铁律影响

- 新增事件仅 `agent.access.runs_settled`（启动结算事实，不含业务内容），见 LOGGING_COVERAGE。
- F2 为连接层修复，不新增日志、不改变错误码与终态语义。
- 外部契约（143 操作/32 节点）Schema 未变；CLI/MCP/GUI 三入口共用同一实现，未新增执行器或旁路；
  `guard:agent-parity` 绿。
- 节点与外部操作矩阵无需变更（本轮未新增业务动作）。

## 七、未覆盖边界

- 未做真实断电/内核崩溃；B 段是应用级硬杀（`taskkill /T /F`），不覆盖磁盘损坏或 SQLite WAL 损坏。
- 未验证"重启时另一个桌面实例仍存活"的竞态（进程锁会阻止该场景，本轮未构造）。
- 未做付费模型真实调用；A/C 段的执行均为本地确定性节点（视频截取），不产生模型费用。
- O1 的取消语义未修复，GUI 停止按钮与外部 `run.cancel` 的终态一致性仍需单独评估。
- F10 打包未开始（项目未完成，按用户指示不做发行版验证）。

## 附：本轮变更文件

- `src/main/agent-access/runs.ts` — `settleOrphanedExternalRuns`
- `src/main/agent-access/server.ts` — 启动结算 + `runs_settled` 事件 + 服务端长轮询等待上限
- `src/main/index.ts` — 桌面启动传 `settleOrphanedRuns: true`
- `src/local-agent/client.ts` — CLI/MCP 客户端按 `run.wait` 请求时长设置 socket 超时
- `test/local-agent-run-access.test.ts` — 结算单测
- `scripts/test-agent-parity-gaps.cjs` — R2 三段验收脚本（新增，已纳入 verify:acceptance）
- `scripts/verify-acceptance.cjs` — 注册 `parity-gaps` 批次
- `scripts/test-local-agent-access.cjs`、`scripts/test-diagnostics-window-close.cjs` — 修复授权目录复制（F3）
- `scripts/mcp-acceptance-optimizations.cjs` — A3 版本冲突重试（F4）
- `docs/LOGGING_COVERAGE.md` — 新增事件与连接修复的日志影响说明
- `docs/local-agent-access/change-impact.json` — 受保护源码变更声明（Schema 兼容结论）
