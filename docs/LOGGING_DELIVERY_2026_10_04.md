# 日志系统交付记录（L01–L06）

日期：2026-10-04。基线：`5085dc8` 工作区。本记录按 [LOGGING_AGENT_HANDOFF.md](LOGGING_AGENT_HANDOFF.md) §7 的交付格式编写，如实区分「已验收（有自动化测试证据）」与「未覆盖/待办」。

## 1. 完成阶段与新增/复用入口

| 阶段 | 交付内容 | 关键入口 |
| --- | --- | --- |
| L01 统一事件协议 | schema v1（zod）、事件注册表（60+ 事件）、字段白名单、错误归一化（16 码 + HTTP 映射）、安全序列化、旧 trace 适配 | `src/shared/observability/`（limits/ids/context/events/errors/safe/schema/producer/legacy-adapter） |
| L01 执行器集成 | 根 traceId（工作流入口生成）、nodeExecutionId/spanId 注入、node.* 生命周期与唯一终态、迭代 batchId/itemId、renderer 微批上报 | `renderer/engine/executor.ts`、`renderer/engine/diagnosticsReporter.ts`、`shared/engine/executor-diagnostics.ts` |
| L02 独立事件保存 | 有界队列（2048 条/8 MiB，128 条关键预留）、session 分片 JSONL（按天/10 MiB 轮转）、保留（14 天/200 MiB/错误配额 20 MiB/硬上限 256 MiB，仅限诊断目录）、session 状态文件、健康状态+事件环、只读查询、退出 flush≤2s | `src/main/diagnostics/`（queue/writer/retention/session/health/clock/fs-types/service）、`main/ipc/diagnostics.ipc.ts`（diagnostics:event/query/health） |
| L03 对话链路 | ChatStartInput.diagnostics 上下文（requestId 一次逻辑调用不变）；model.request.started/first_chunk/completed/failed/cancelled（取消=远端结果未知） | `main/gateway/chat.ts`、`shared/engine/executors/chat.ts` |
| L03 生图链路 | ImageGenerateInput.diagnostics；入口 started/completed/failed + TOAPIS accepted/task.state_changed/poll_summary(30s)/download/persist 分阶段；多张图 batchId+逐张 requestId/itemId | `main/gateway/image.ts`、`shared/engine/executors/imageGen.ts` |
| L04 覆盖域 | 视频全链（含 429 退避 attempt 递增、重启恢复新 trace+correlationMissing、绝不重复提交）、语音克隆统一事件化、项目保存/导入导出 transfer 事件、素材库 revision/materialization 事件、模型验证 configuration 事件、应用生命周期（session_started/ended/previous_session_unclean/process_exited） | `main/gateway/video.ts`、`main/media/tts-transform.ts`、`main/ipc/{project,library,models}.ipc.ts`、`main/index.ts` |
| L05 查询/导出/UI | diagnostics:query/health/export-bundle IPC；诊断包 zip（manifest.json/events.jsonl/summary.txt/coverage.json，25 MiB 截断、原子写、二次脱敏）；RunsPanel 流程时间线 + 导出入口 | `main/diagnostics/service.ts` exportBundle、`canvas/CanvasSidePanel.tsx` RunTimeline |
| L06 自动门禁 | 增量旁路检查（新增行内裸 console / 直接 electron-log）+ A18 规则（新文件网络调用缺诊断接入即失败）+ 允许清单（带理由）；接入 `npm run verify`（verify:logging）与 CI | `scripts/check-logging-bypass.mjs`、`scripts/logging-allowlist.json`、`.github/workflows/ci.yml` |

## 2. 可追踪的 ID 与阶段

- 全链：`sessionId`（main 生成）→ `traceId`（runWorkflow/runNodeManually 入口生成；main 侧恢复开新 trace）→ `spanId`（节点 span=nodeExecutionId，父 span=workflow span）→ `nodeExecutionId`（每次节点调用唯一，持久化进 nodeRun meta）→ `requestId`（一次逻辑网关调用，429 退避重试不变）→ `attempt`（重试序号）→ `upstreamTaskId`（远端任务，确实获得才记录）。
- 阶段：workflow.* / node.started→input_validated→capability_resolved→stage→output_validated→唯一终态 / model.request.*（attempt 级）/ task.*（state_changed+30s poll_summary）/ media.download→persist / project.save|transfer / library.* / configuration.* / app.* / diagnostics.*。
- 未覆盖 ID 路径：TtsGenerateInput 仍只有 runId/nodeId（事件标 correlationMissing）；旧视频任务恢复时旧 traceId 不可知（显式标记，不补造）。

## 3. 验证结果（真实测试命令与结果）

命令：`npm run verify`（lint + typecheck + typecheck:model + test + test:model + verify:logging + electron-vite build）。

新增测试 6 个文件、42 个用例（`test/observability/`）：

| 文件 | 覆盖 |
| --- | --- |
| schema.test.ts | 注册表/白名单丢弃计数/密钥与提示词 fixture 脱敏/16KiB 上限/HTTP 错误映射/cause 链/safeStack 去路径（A15） |
| diagnostics-storage.test.ts | 队列有界+关键预留+逐出、JSONL 轮转+坏行、拒写降级、查询过滤、session 非正常结束、保留清理不触碰业务文件、服务端到端、多实例隔离、退出 flush、data 目录不可用降级、L05 诊断包四文件+原子写（A12/A13/A14） |
| executor-events.test.ts | 3 节点共同根 trace/独立执行实例/唯一终态/父子 span、契约失败 INPUT_INVALID 无伪造请求事件、敏感 fixture 不进事件（A01/A02/A15） |
| gateway-chain.test.ts | 对话 started/first_chunk/completed 正文不落日志、401→AUTH_FAILED、流中断保留首片统计、取消竞争远端未知、correlationMissing；生图 TOAPIS 全阶段同一 requestId、远端成功但下载失败可区分且不重复提交、429 attempt_failed RATE_LIMITED（A03/A04/A05/A06/A07） |
| video-diagnostics.test.ts | 重启恢复 resume_started/无重复 POST/稳定 taskId/correlationMissing、恢复阻断原因、429 退避 attempt 递增+waitMs（A03/A09） |
| logging-gate.test.ts | A18 缺诊断网络路径门禁失败、接入后通过、A17 纯样式通过、当前工作区门禁真实运行（A17/A18）；子进程 stdio 显式 pipe 避免故意失败用例污染 CI 日志 |

全量回归：最终 `npm run verify` 退出码 0——lint 通过、双侧 typecheck 通过、测试 115 个文件 / 1383 通过 / 1 跳过、模型子包测试通过、verify:logging 门禁通过、electron-vite 生产构建成功（构建产物 out/）。

## 4. 如何在应用中查看/导出

- 运行中心（右侧面板「运行」页签）：点击运行卡片的「流程时间线」按根 trace 拉取独立事件；「导出诊断包」导出 zip 到下载目录（假样例：`canvas-studio-diagnostics-2026-10-04T08-00-00.zip`，内含 manifest.json / events.jsonl / summary.txt / coverage.json）。
- 旧单节点 JSON 导出入口保留（NodeContractPanel），format 版本不同，不与新诊断包混淆。
- 开发 Agent 排查：summary.txt 失败/未完成摘要 → events.jsonl 按 eventId/causeCode 找根因 → traceId/spanId 还原父子时间线。

## 5. 门禁与未验证边界

- `npm run verify:logging` 已接入 verify 链与 CI；A18 演示用例（新增网络路径缺日志→门禁失败）为自动化测试。
- 未验证边界（诚实登记）：真机模型验收（`pnpm model:smoke:*`）本轮未运行，涉及真实付费请求；桌面整包故障验收（强退/断电/A09 真机重启）在隔离数据目录的自动化覆盖为模拟级；A10（100 项迭代基线）性能测量未执行；A11 恢复回滚专项事件待恢复副本功能并行任务落地后接入。

## 6. 覆盖清单与提交状态

- [LOGGING_COVERAGE.md](LOGGING_COVERAGE.md) 已逐行更新：12 个业务域标记已验收（附测试证据），5 个域保留「基础/待办」并写明具体待补路径，无整行虚报。
- 提交状态：本任务改动保留在工作区未提交。原因：工作区存在另一任务（T04 关窗恢复副本）未提交改动，且与本任务共享 `contracts/index.ts`、`preload/index.ts`、`project.ipc.ts` 等文件；为满足交接文档「不将别人的未提交代码混入本任务提交」，提交需在并行任务落地后按文件拆分执行，或由用户确认后统一提交。
