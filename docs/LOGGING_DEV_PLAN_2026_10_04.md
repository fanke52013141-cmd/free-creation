# 日志系统开发方案（L01–L06 实施细化）

日期：2026-10-04。基线：`5085dc8`（docs(logging) 提交），工作区另有他人未提交改动（见 §8）。

本方案是 [LOGGING_SPEC.md](../LOGGING_SPEC.md)（权威规范）、[LOGGING_IMPLEMENTATION_PLAN.md](LOGGING_IMPLEMENTATION_PLAN.md)（L00–L06 任务与 A01–A18 验收矩阵）、[LOGGING_AGENT_HANDOFF.md](LOGGING_AGENT_HANDOFF.md)（开发 Agent 任务说明）的**落地细化**：把任务翻译成具体文件、接口、测试与提交序列。凡与规范冲突处以规范为准。

---

## 1. 现状结论（基于本次代码核查）

已实现（可复用，不重建）：

| 能力 | 位置 | 说明 |
| --- | --- | --- |
| 节点级 trace（6 phase × info/error） | `src/renderer/src/engine/executor.ts` `recordRunTrace`（约 L477-509） | 写 `shape.meta.nodeRun`（24 条轨迹/12 条历史），双重脱敏，best-effort 镜像到 main |
| 终态记录 | `executor.ts` `finishRunRecord`（约 L424-475） | success/failed/skipped/cancelled + error.phase + durationMs |
| 运行中心 UI | `CanvasSidePanel.tsx` `RunsPanel` + `run-index.ts` | 跨节点索引、筛选、重试；来源仅画布 meta |
| 单节点诊断导出 | `src/main/ipc/diagnostics.ipc.ts` | `canvas-studio-node-diagnostics-v1`，≤13 runs |
| 脱敏 | `src/shared/diagnostics.ts` `redactDiagnosticText` | 唯一收口：凭据正则 + 私有值替换 |
| 详细阶段范例 | `shared/engine/executors/tts.ts` + `main/media/tts-transform.ts` | 带 runId/nodeId 的分阶段结构化日志 |
| 视频任务库 | `src/main/gateway/video.ts` | tasks 表、upstreamTaskId、重启恢复 `resumePendingVideoTasks`、三类受控重试 |
| electron-log | `src/main/index.ts`（L26 `log.initialize()`） | 启动环境 + 少量健康检查；默认轮转，无自定义保留策略 |

未实现（即本方案要交付的）：

- `src/shared/observability/`、`src/main/diagnostics/` **不存在**；无 schema v1、事件注册表、字段白名单、错误归一化。
- 无 sessionId/traceId/spanId/nodeExecutionId/requestId 全链路关联（model-contracts 的 requestId 仅是可选 schema 字段，legacy 网关未接）。
- 无独立 JSONL 事件文件、`<getDataDir()>/diagnostics/` 目录、轮转/保留/健康状态/退出 flush。
- 覆盖极不均：26 个执行器中仅 tts/speech 用了 `ctx.trace`（共 10 处），`setDiagnosticTarget` 仅 tts 1 处；main 网关中 chat/audio/voice/factory/upstream-fetch/video **零日志**，image.ts 仅 TOAPIS 路径且不带节点关联。
- `ChatStartInput`/`ImageGenerateInput`/`AudioGenerateInput` 无诊断上下文字段（`TtsGenerateInput` 有 runId/nodeId，`VideoSubmitInput` 有 nodeId）。
- 无 will-quit/会话结束日志；无整流程诊断包导出；无自动日志门禁（CI 只跑 lint/typecheck/test/build）。

已知偏差与注意点：

- `rendererGateway.ts` 实际在 `src/renderer/src/engine/rendererGateway.ts`（非 shared 层）。
- renderer 与 shared **各有一份 `executor-types.ts`**（shared 是权威精简版，renderer 是带注释的超集副本）——扩展类型时以 shared 为权威、renderer 同步。
- `runNodeTest`（节点测试）有意不注入诊断——保持现状，在覆盖清单登记为"不涉及（测试路径不产生运行记录）"。
- 主工程已有 `zod@^4.4.3`、`nanoid`，schema 与 ID 生成直接复用，不新增依赖。
- 诊断目录根用 `getDataDir()`（`src/main/store/db.ts`，支持 `CANVAS_DATA_DIR` 测试隔离）。

---

## 2. 目标架构

```text
用户操作 / 工作流调度（executor: runWorkflow / runNodeManually / runWorkflowForNodes）
  ├─ 公共节点执行器 invokeExecutor：注入 traceId/spanId/nodeExecutionId，产出 node.* 生命周期
  ├─ 网关边界：upstream-fetch（model.request.*）、chat/image/video 适配（task.* / media.*）
  ├─ 媒体服务（media.*）、项目保存/导入导出（project.*）、素材库（library.*）、模型验证（configuration.*）
  └─ main 生命周期（app.*：session_started / session_ended / previous_session_unclean）
               ↓ 统一 DiagnosticContext + 安全事件（shared/observability）
       renderer 出站校验（executor 内 safe 序列化）
               ↓ preload / IPC（diagnostics:event，fire-and-forget，回执=已接收）
       main 入口再校验/截断/脱敏 → 有界队列（2048 条 / 8 MiB）
               ↓ 批量写（500ms / 64 条，错误快速调度）
       <getDataDir()>/diagnostics/session-*.jsonl（按天 / 10 MiB 轮转）
               ↓ 只读查询（diagnostics:query / diagnostics:health）
       现有运行中心（RunsPanel 时间线扩展）→ 本地诊断包导出（25 MiB 上限）

electron-log：继续承载应用启动/异常与安全摘要（目录与 diagnostics/ 不同，互不替代）
nodeRun/meta（12/24 上限不变）：继续承载界面近期摘要，不做独立存储
业务 tasks 表：继续是任务恢复与业务状态的唯一权威
```

新增模块（目录名沿用实施计划建议）：

```text
src/shared/observability/    # schema、事件注册表、上下文、安全序列化、错误归一化、常量
src/main/diagnostics/        # writer、队列、健康、保留清理、session 状态、查询、导出
src/renderer/src/engine/diagnosticsReporter.ts   # renderer 轻量缓冲上报适配
test/observability/          # schema/隐私/生命周期/关联测试（L01 起逐步建立）
scripts/check-logging-*.mjs  # L06 门禁脚本
```

---

## 3. 关键设计决策

| # | 决策 | 理由 |
| --- | --- | --- |
| D1 | schema 用 zod 定义于 `src/shared/observability/schema.ts`，事件注册表静态登记 | zod 已在依赖中；注册表是字段白名单的单一事实来源，main/renderer 共用 |
| D2 | renderer 侧**单一挂接点**是 `executor.ts` 的 `invokeExecutor`/`recordRunTrace`/`finishRunRecord`，不逐个改 26 个执行器的公共生命周期 | 规范要求"公共调度负责开始与唯一终态，各功能仅补自己的实际阶段"；现状已如此，扩展它风险最小 |
| D3 | IPC 沿 `IPC.diagnostics` 命名空间三件套对称扩展（contracts → preload → main），新增 `diagnostics:event`/`diagnostics:query`/`diagnostics:health`/`diagnostics:export-bundle`；旧 `node-run:event`/`node-run:export` 保留兼容，旧镜像逐步降级为摘要 | 端到端类型一致是仓库既有模式；不破坏旧调用方 |
| D4 | 新事件回执语义 = **已接收/已入队**，不代表已落盘；`diagnostics:health` 才暴露真实持久化状态 | 规范 §9 明确要求区分三态 |
| D5 | 网关边界挂接三处：`upstream-fetch.ts` 的 `fetchUpstream`（唯一网络出口，产 `model.request.attempt_*`）、`gateway.ipc.ts` 的 `wrap/wrapAsync`（入口上下文校验）、`video.ts` tasks 表周边（产 `task.*`，不改恢复语义） | 401/429/超时/重试在一个点统一获得，避免每个适配器重复实现 |
| D6 | `ChatStartInput`/`ImageGenerateInput`/`AudioGenerateInput` 增加可选嵌套字段 `diagnostics?: { runId?, nodeId?, traceId?, spanId?, nodeExecutionId?, requestId? }`（Tts/Video 的平铺 runId/nodeId 保持不动） | 嵌套结构可扩展、可选向后兼容；不破坏既有契约测试 |
| D7 | writer 全部 I/O 经可注入接口（`DiagnosticsClock`/`DiagnosticsFileStore`），测试不依赖真实磁盘慢/满 | 实施计划 L02 验证项要求确定性故障注入 |
| D8 | UI 只扩展现有 `RunsPanel`（时间线）与 `NodeContractPanel`（导出入口），不建第二面板 | 交接文档明确"扩展运行中心，不创建第二个" |
| D9 | `traceId` 生成：`runWorkflow`/`runWorkflowForNodes` 在入口生成根 traceId（映射 runId）；`runNodeManually` 单节点运行生成独立 traceId；子流程 item 用 `parentSpanId` 挂接、`itemId` 用现有 `itemRunId`；手动重试发起新 trace + `retryOfNodeExecutionId` | 规范 §4 关联规则；复用现有 runId/itemRunId 不改名 |
| D10 | 旧 `nodeRun/nodeRunHistory` meta 与新事件**并行产出**：meta 继续 12/24 摘要；新事件走独立 JSONL。旧记录读取兼容由 runRecord 既有校验保证 | 规范明确"不提高上限当作独立存储" |
| D11 | L06 门禁 = 真实脚本（`scripts/`）+ vitest 测试套件，验证可运行后才写入 `npm run verify` 与 `ci.yml` | 交接文档禁止"只改模板就宣称门禁完成" |

---

## 4. 阶段实施计划

### L01 统一事件协议与现有接口适配（3–4 工程日）

**新增**（全部在 `src/shared/observability/`）：

| 文件 | 内容 |
| --- | --- |
| `limits.ts` | 常量：单事件 ≤16 KiB、message ≤500、safeStack ≤4 KiB、attributes ≤32 键、数组 ≤50 项（保留总数）、ID 长度上限 |
| `ids.ts` | ID 生成（nanoid 包装）与校验；`newEventId/newTraceId/newSpanId/newNodeExecutionId/newRequestId` |
| `context.ts` | `DiagnosticContext` 类型（sessionId/traceId/spanId/parentSpanId/runId/nodeExecutionId/requestId/attempt/taskId/upstreamTaskId/batchId/itemId/projectId/nodeId/nodeType/process/producerId）+ 派生帮手 `childSpan()` |
| `events.ts` | 事件注册表：事件名 → `{ level 默认, 必填上下文, 允许 attributes }`；首版范围见 §6 |
| `schema.ts` | zod schema `DiagnosticsEventSchema`（schemaVersion=1、eventId、timestamp/receivedAt、sequence/producerId、level/event/phase、error 结构、attributes 白名单校验）+ `normalizeDiagnosticsEvent()`（未知键丢弃并计数，不抛业务异常） |
| `errors.ts` | `normalizeError(unknown): { code, category, retryable, httpStatus?, causeCode?, safeStack? }`；错误码初始集 = 规范 §6 的 15 个；HTTP 状态 → 码映射（401→AUTH_FAILED、429→RATE_LIMITED、5xx→UPSTREAM_FAILED…） |
| `safe.ts` | `safeString/safeAttributes/safeStack`：白名单 + 截断 + `truncatedFields`；底层复用 `redactDiagnosticText` 作最后一道脱敏 |
| `legacy-adapter.ts` | 旧 `{phase, level:'info'|'error', message}` → 新事件映射（6 phase → event.phase；info/error → level；终态补 status） |

**改动**：

- `src/shared/engine/executor-types.ts`（renderer 副本同步）：`NodeExecutionContext` 增加可选 `nodeExecutionId?/traceId?/spanId?/reportDiagnosticEvent?`；`trace` 签名不变。
- `src/renderer/src/engine/executor.ts`：
  - `runWorkflow`/`runWorkflowForNodes` 入口生成根 `traceId`（记录 runId↔traceId 映射事件）；`runNodeManually` 生成独立 traceId；`invokeExecutor` 为每次调用生成 `nodeExecutionId`/`spanId` 注入 ctx；`runSubflowForIterate` 为 item 生成子 span（parentSpanId 指向节点 span，itemId=itemRunId）。
  - `recordRunTrace`：保持旧 meta 写回不动；额外经 `legacy-adapter` 产出结构化事件 → `diagnosticsReporter` 上报（fire-and-forget，任何失败静默且计数）。
  - `finishRunRecord`：发 `node.completed/failed/cancelled/skipped` 唯一终态事件（带 durationMs、error 归一化）；手动重试带 `retryOfNodeExecutionId`。
- 新增 `src/renderer/src/engine/diagnosticsReporter.ts`：微缓冲（如 50ms/32 条合并）+ `window.api.reportDiagnosticsEvent`，无桥接时降级为 no-op（最小 mock 可测）。
- `src/shared/contracts/index.ts` + `src/preload/index.ts` + `src/main/ipc/diagnostics.ipc.ts`：新增 `diagnostics:event` 通道（本阶段 main 侧只做校验 + electron-log 安全摘要落盘，真正持久化在 L02）；旧 `node-run:event` 保留。

**测试**（`test/observability/`）：

- `schema.test.ts`：未知/敏感键拒绝或安全丢弃并计数；大小/枚举/截断；`truncatedFields`。
- `context.test.ts`：根/子 trace、执行实例唯一性、同节点重跑/迭代不冲突。
- `legacy-adapter.test.ts`：6 phase × 2 level 全映射；终态唯一、无重复。
- 更新 `test/runRecord.test.ts`、执行器相关测试：旧记录仍可读、ctx 新字段全可选不破坏现有 mock。
- `safety.test.ts`：假密钥、中文提示词、签名 URL、嵌套 cause、循环对象、控制字符不进输出。

**验收**：A01（3 节点共同根 trace + 独立执行实例 + 唯一终态）、A02 部分（阻断阶段与原因）、A15（脱敏 fixture）。完成标准见交接文档任务A。

**回退**：`diagnosticsReporter` 可整体禁用（开关），旧 trace/meta 路径原样保留。

---

### L02 独立事件保存（3–5 工程日）

**新增**（`src/main/diagnostics/`）：

| 文件 | 内容 |
| --- | --- |
| `fs-types.ts`/`clock.ts` | 可注入 `DiagnosticsFileStore`（appendFile/readDir/rename/stat/unlink/mkdir）与 `DiagnosticsClock` |
| `queue.ts` | 有界队列：2048 条或 8 MiB 先到为准，128 条关键事件预留；溢出按规范先丢 debug/重复进度并计数，关键事件进有界内存环；500ms/64 条批量刷，error 级快速调度 |
| `writer.ts` | session 分片 `diagnostics/session-<sessionId>-<seq>.jsonl`；按天或 10 MiB 轮转；追加写；读取跳过尾部残缺 JSON 行并记录坏行数 |
| `retention.ts` | 普通事件 14 天且总量 ≤200 MiB、错误/关键终态 20 MiB 配额、含临时/索引硬上限 256 MiB；**只扫描 diagnostics 目录**（路径校验拒绝越界）；容量优先于天数 |
| `session.ts` | session 状态文件原子写（临时+rename）；启动检测上次未正常结束 → `app.previous_session_unclean` |
| `health.ts` | 健康状态：队列深度、丢弃/丢失计数、最近写失败、降级标志；降级输出受控一次性安全摘要，禁止递归调用自身 |
| `query.ts` | 按 traceId/runId/时间窗/级别的只读查询（首版内存扫描/分页读取 JSONL）；查询范围限制在日志根目录 |
| `index.ts` | `initDiagnostics(getDataDir)` 组装 + 注册 IPC（`diagnostics:event` 落队列、`diagnostics:query`、`diagnostics:health`） |

**改动**：

- `src/main/index.ts`：启动时 `session_started`（含环境/构建标识，data 目录未就绪时降级为 electron-log 安全摘要并标记日志未就绪）；`before-quit`/新增 `will-quit` 处理 `session_ended` + flush（≤2 秒超时，超时留非完整状态标记，不阻塞退出）。
- `src/main/ipc/diagnostics.ipc.ts`：`diagnostics:event` 从"仅 electron-log"接入队列；IPC 回执明确为"已接收"，附入队结果。
- 保留 electron-log 摘要（不再逐条镜像旧 node-run 事件，改为低频汇总，避免双写重复）。

**测试**：

- `writer.test.ts`：轮转（按天/按大小）、拒写恢复、尾部坏行读取有效前缀、多实例（两 session 互不覆盖）。
- `queue.test.ts`：上限溢出丢弃顺序（debug/重复进度先丢）、关键预留、批量时机（注入时钟）、flush 超时。
- `retention.test.ts`：超期/超量清理只动 diagnostics 目录（fixture 中放"假项目文件"断言未删）、错误配额。
- `session.test.ts`：非正常结束检测、原子写失败、重启读取。
- `ipc.test.ts`：回执语义（接收≠落盘）、恶意/超长字段被 main 拒绝截断。

**验收**：A12（logger 抛错/拒写/队列满不影响业务）、A13（强退/坏行/多实例）、A14（清理边界）。完成标准见交接文档任务B。

**回退**：`initDiagnostics` 可整体关闭，回落到 L01 的 electron-log 摘要；旧分片只读保留至清理，不重放。

---

### L03 对话与生图两条链路贯通（4–6 工程日）

**链路A（对话）**：

- 契约：`ChatStartInput` + `diagnostics` 上下文（D6）；`waitForChat`（helpers.ts）传递。
- `src/main/gateway/chat.ts`：以 `requestId`（nanoid）贯穿一次逻辑调用；事件 `model.request.started` → `attempt_started` → `first_chunk`（首片耗时）→ `completed/failed/cancelled`；`chat-error` 映射归一化错误码；不记 delta/reasoning 正文。
- `src/main/gateway/upstream-fetch.ts`：`fetchUpstream` 增加可选 attempt 观测回调（401/429/超时/网络错误统一产 `model.request.attempt_failed`，带 attempt 序号与 retryable 判定），供 chat/image/video 共用。
- `src/shared/engine/executors/chat.ts`：补 `node.capability_resolved`（现有 resolveModelFeature 结果摘要）与阶段 trace（沿用 tts 范式）；`ctx.setDiagnosticTarget` 记录模型身份。
- renderer→main：`gateway.ipc.ts` `wrap/wrapAsync` 校验并透传诊断上下文，main 覆盖自身 session/时间。

**链路B（生图）**：

- 契约：`ImageGenerateInput` + `diagnostics` 上下文。
- `src/main/gateway/image.ts`：三个驱动（openai-images/toapis-task/openrouter-chat）统一事件：提交 `model.request.started`、任务接受 `task.state_changed(accepted)` + `upstreamTaskId`、轮询只记状态变化（TOAPIS 2.5s 轮询不逐条记）+ 30 秒 `task.poll_summary`、下载 `media.download_started/completed/failed`（5 分钟超时）、入库 `media.persist_completed/failed`。区分四层事实：远端成功 / 下载成功 / 媒体入库成功 / 画布保存成功。
- 请求重试（`submitWithBackoff` 仅 429 场景）保持逻辑 requestId 不变、attempt+1。
- `src/shared/engine/executors/imageGen.ts`：补 capability/submit/result 阶段 trace 与 setDiagnosticTarget；多张生成用 batchId/itemId 关联。
- 项目保存关联：自动保存合并多节点修改时记 `project.save.*` 事件带 `linkedTraceIds`（不强行归给最后一个节点）——保存 IPC 处挂接。

**fixture**（`test/fixtures/diagnostics/`，确定性假 fetch/假网关，不发真实请求）：

401、429+重试成功、超时、流中断（首片后断开）、用户取消与迟到回包竞争、远端成功但下载失败、下载成功但写盘失败、空/坏响应。

**验收**：A03、A04、A05、A06、A07、A08；真机代表性验收（`pnpm model:smoke` 系列）与模拟验收分开记录。完成标准见交接文档任务C：一次失败按 ID 可定位真实阶段；"远端成功但本地下载失败"不会被误读为需重新提交。

**里程碑 M1 = L01+L02+L03 全部验收后标记完成**；中断则留下明确阶段与失败测试。

---

### L04 覆盖清单逐项迁移（5–8 工程日）

按 `LOGGING_COVERAGE.md` 逐域推进，每域一个提交（事件 + 错误映射 + 成功/主要失败测试 + 清单更新）：

| 域 | 复用入口 | 增量要点 |
| --- | --- | --- |
| 长视频恢复 | `video.ts` tasks 表 + `resumePendingVideoTasks` | `task.resume_started`（新 trace + `resumesTraceId` + 稳定 taskId）、`task.poll_summary`、恢复决策；**日志绝不触发重复提交**（恢复语义不变，仅观测）；下载/落盘分阶段 |
| 语音克隆/配音/音色设计 | tts 范式推广 | tts-transform 的 `report()` 改走统一事件（保留 phase 语义）；speech/voice-design 执行器补 capability/request/result |
| 图片编辑 | `image.ts` `generateImageEditToAsset` | 同生图链路事件；参考图只记数量/来源 ID |
| 本地媒体/导演输出 | `main/media`、`media.repo.ts` | 外部进程记退出码/信号/耗时与受控错误类型，stderr 不原样写；媒体 ID 关联 |
| 迭代 | `runSubflowForIterate` | item 稳定身份（itemRunId）、部分失败聚合、`node.skipped` 带依赖原因 |
| 代码 Worker | `renderer/engine/codeRuntime.ts` | 超时/退出/桥接失败事件；**禁止记录用户源码**；观测接口不给用户代码新能力 |
| 保存/恢复 | 项目 IPC/仓库事务 | `project.save.*/project.restore.*`（操作 ID、版本、检查点、回滚、冲突 SAVE_CONFLICT）；linkedTraceIds |
| 导入导出 | 项目 IPC 事务 | `project.transfer.*`（validated/committed/rolled_back）；路径去标识 `[APP]/…` |
| 素材库 | `library.ipc.ts` | `library.revision_published/materialization_*/mutation_failed` |
| 模型验证/迁移 | `model-host`、`models.ipc.ts`、model-contracts requestId 字段 | `configuration.validation_*/migration_*`；连接 ID 摘要，不记配置全文；legacy 网关与新模型模块两条入口都接 |
| 应用生命周期 | `main/index.ts` | renderer gone / 子进程退出 / `app.process_exited`；异常后仍执行原退出策略 |

**验收**：A09（视频重启恢复无重复提交）、A10（100 项迭代部分失败可关联）、A11（导入/恢复事务回滚清楚）+ 各域清单更新。

---

### L05 运行中心增强与诊断包（3–5 工程日）

- `RunsPanel`：新增"本次流程"时间线视图（`diagnostics:query` 按 traceId 拉取），展示 node→request→task→download→save 阶段父子关系；按状态/错误码筛选；缺失/过期/截断显示"诊断记录不完整"，不显示为成功。重试按钮仍走原执行路径。
- 导出：`NodeContractPanel`/`RunsPanel` 增加"导出诊断包"入口 → `diagnostics:export-bundle`：
  - 内容 `manifest.json`（格式/环境/范围/丢失/截断/覆盖状态）+ `events.jsonl` + `summary.txt`（失败阶段/根因链/未完成步骤）+ `coverage.json`；
  - 单包 ≤25 MiB，超限先缩范围或明确截断；临时文件写成功后原子 rename，重名不静默覆盖；导出前**二次脱敏**；
  - 不默认打包数据库/项目/媒体/main.log 全文；取消导出不创建假包。
- 旧单节点 JSON 导出（`canvas-studio-node-diagnostics-v1`）保留并标不同 format 版本；旧版本记录在独立日志已清理时仍可导出节点摘要并注明"仅摘要"。

**验收**：A16；包不含正文/Key/签名 URL/用户绝对路径（用 §6 fixture 复检）。

---

### L06 自动门禁（2–3 工程日，与 L01 起逐步建、最后收口）

- vitest 套件（`test/observability/`）：schema/字段白名单、隐私（敏感 fixture 全链路：写入/降级控制台/导出三处检查）、公共生命周期契约（开始/唯一终态）、IPC 关联保持（契约↔preload↔main 对称）。
- `scripts/check-logging-bypass.mjs`：对变更文件做增量检查——新业务文件出现裸 `console.*`/直接 `electron-log` 引用即失败；底座/启动/降级等显式允许清单（带理由）登记在 `scripts/logging-allowlist.json`；历史旁路不阻断但有迁移计划。
- `scripts/check-logging-impact.mjs`：变更文件 ↔ 日志影响声明（变更检查模板的机器可读版）匹配；纯样式/文档可凭依据标 no-impact（A17）。
- A18 演示：构造一个"新增网络调用但不加日志"的示例 diff，门禁必须失败——以此证明门禁有效。
- 上述脚本真实通过后，才加入 `npm run verify`（新增 `verify:logging` 步骤）与 `.github/workflows/ci.yml`。

---

## 5. 核心接口草案

```ts
// src/shared/observability/context.ts
export interface DiagnosticContext {
  sessionId: string;            // main 启动生成，重启必不同
  traceId: string;              // 一次用户操作/工作流根 ID（调度入口生成）
  spanId: string;               // 当前逻辑步骤
  parentSpanId?: string;
  runId?: string;               // 现有工作流/子流程运行 ID（不改名）
  nodeExecutionId?: string;     // 每次节点调用独立生成
  requestId?: string;           // 一次逻辑网关调用（重试不变）
  attempt?: number;             // 从 1 起
  taskId?: string;              // 本地异步任务
  upstreamTaskId?: string;      // 供应商任务（确实获得才填）
  upstreamRequestId?: string;
  batchId?: string; itemId?: string;
  projectId?: string; nodeId?: string; nodeType?: string;
  process: 'main' | 'renderer' | 'worker';
  producerId: string;           // 来源实例，配 sequence 发现丢失/乱序
}

// src/shared/observability/schema.ts（zod，节选）
export const DiagnosticsEventSchema = z.object({
  schemaVersion: z.literal(1),
  eventId: z.string().min(1),
  timestamp: z.string().datetime(),       // 发生时间（UTC ISO）
  receivedAt: z.string().datetime().optional(),  // main 接收时补
  sessionId: z.string(),
  producerId: z.string(),
  sequence: z.number().int().nonnegative(),
  process: z.enum(['main', 'renderer', 'worker']),
  level: z.enum(['debug', 'info', 'warn', 'error', 'fatal']),
  event: z.string(),                       // 必须在注册表内
  phase: z.string().optional(),
  traceId: z.string().optional(),
  spanId: z.string().optional(),
  parentSpanId: z.string().optional(),
  projectId: z.string().optional(),
  nodeId: z.string().optional(), nodeType: z.string().optional(),
  runId: z.string().optional(),
  nodeExecutionId: z.string().optional(),
  requestId: z.string().optional(), attempt: z.number().int().positive().optional(),
  taskId: z.string().optional(), upstreamTaskId: z.string().optional(),
  batchId: z.string().optional(), itemId: z.string().optional(),
  durationMs: z.number().nonnegative().optional(),
  status: z.enum(['success','failed','cancelled','skipped','interrupted','unknown']).optional(),
  message: z.string().max(500),
  error: z.object({
    code: z.string(), category: z.string(), retryable: z.boolean(),
    httpStatus: z.number().optional(), causeCode: z.string().optional(),
    safeStack: z.string().max(4096).optional(),
  }).optional(),
  attributes: z.record(z.string(), z.unknown()).optional(),  // 注册表白名单过滤后
  truncatedFields: z.array(z.string()).optional(),
  correlationMissing: z.boolean().optional(),
  linkedTraceIds: z.array(z.string()).optional(),
  resumesTraceId: z.string().optional(),
  retryOfTraceId: z.string().optional(), retryOfNodeExecutionId: z.string().optional(),
});

// IPC（src/shared/contracts/index.ts 扩展）
IPC.diagnostics.event        = 'diagnostics:event'         // 上报（回执=已接收/已入队）
IPC.diagnostics.query        = 'diagnostics:query'         // 只读查询
IPC.diagnostics.health       = 'diagnostics:health'        // 日志健康
IPC.diagnostics.exportBundle = 'diagnostics:export-bundle' // L05 诊断包
// 保留：diagnostics:node-run:event / diagnostics:node-run:export（旧兼容）
```

---

## 6. 首版事件族与错误码范围

事件族（登记表首批，逐步扩充；负责人见 LOGGING_COVERAGE 各行）：

| 事件族 | 首批事件 | 阶段 |
| --- | --- | --- |
| `app.*` | session_started / session_ended / previous_session_unclean / process_exited | L02/L04 |
| `workflow.*` | started / completed / failed / cancelled | L01 |
| `node.*` | started / input_validated / capability_resolved / output_validated / completed / failed / cancelled / skipped | L01/L03 |
| `model.request.*` | started / attempt_started / accepted / first_chunk / attempt_failed / retry_scheduled / completed / failed / cancelled | L03 |
| `task.*` | state_changed / poll_summary / resume_started / resume_blocked / completed / failed | L03/L04 |
| `media.*` | download_started / completed / failed；persist_started / completed / failed | L03/L04 |
| `project.save.*` / `project.restore.*` / `project.transfer.*` | 按 §4 L04 | L03(保存关联)/L04 |
| `library.*` / `configuration.*` | 按 §4 L04 | L04 |
| `diagnostics.*` | queue_dropped / write_failed / recovered / export_completed / export_failed | L02/L05 |

错误码初始集（15 个，规范 §6）：INPUT_INVALID、CAPABILITY_UNAVAILABLE、AUTH_FAILED、RATE_LIMITED、REQUEST_TIMEOUT、NETWORK_FAILED、UPSTREAM_FAILED、RESPONSE_INVALID、MEDIA_DOWNLOAD_FAILED、MEDIA_WRITE_FAILED、SAVE_CONFLICT、STORAGE_WRITE_FAILED、RESTORE_FAILED、PROCESS_EXITED、UNKNOWN。已有业务错误码提供稳定映射，保留安全 sourceCode，不得全部归 UNKNOWN。

---

## 7. 验收矩阵映射（A01–A18）

| 编号 | 场景 | 验证方式 | 阶段 |
| --- | --- | --- | --- |
| A01 | 3 节点运行成功 | `test/observability/context.test.ts` + executor 契约测试 | L01 |
| A02 | 输入不合法/未绑定 | 执行器阻断路径测试（无伪造请求事件） | L01/L03 |
| A03 | 超时→重试成功 | upstream-fetch fixture（同 requestId、attempt 递增） | L03 |
| A04 | 401/429/5xx/坏响应 | 同上，错误码/retryable 断言 | L03 |
| A05 | 流式首片后断开 | chat fixture，首片统计有、正文无 | L03 |
| A06 | 取消与迟到回包 | cancel 竞争 fixture | L03 |
| A07 | 远端成功下载失败 | image TOAPIS fixture，task 与 download 阶段区分 | L03 |
| A08 | 媒体成功保存冲突 | project.save conflict 事件 | L03/L04 |
| A09 | 视频重启恢复 | 隔离数据目录重启测试，无重复提交 | L04 |
| A10 | 100 项迭代部分失败 | item 身份稳定/聚合 | L04 |
| A11 | 导入/恢复事务失败 | 检查点/回滚事件 | L04 |
| A12 | logger 抛错/拒写/队列满 | 注入式 FS/clock 故障测试 | L02 |
| A13 | 强退/坏行/多实例 | writer/session 测试 | L02 |
| A14 | 轮转与限额 | retention 测试 + 越界保护断言 | L02 |
| A15 | 敏感 fixture | safety 测试（写入/控制台/导出三处） | L01/L05 |
| A16 | 运行中心与导出 | UI/导出测试，包可解析 | L05 |
| A17 | 纯样式 no-impact | 门禁允许清单 | L06 |
| A18 | 新网络功能缺日志 | 门禁演示用例（必须失败） | L06 |

性能基线（实施计划 §6）：100/500 节点、100 项串行迭代、5 分钟流式、长视频轮询、同时保存——分别记录关/开日志的耗时、事件数、队列峰值、丢失数、文件体积；目标：典型流程总耗时回退 ≤5%，renderer 单事件 p95 < 1ms。

---

## 8. 提交拆分与工作区保护

- **保护他人改动**：当前工作区有 `M src/renderer/src/canvas/SearchPalette.tsx` 与未跟踪 `artifacts/*`（browserMock/测试产物）——不属于本任务，所有日志提交用显式文件列表 `git add <paths>`，绝不 `git add -A`。
- 提交序列（每阶段一条或数条，均含测试与 `LOGGING_COVERAGE.md` 更新）：
  1. `feat(diagnostics): L01 统一事件协议与执行器上下文`
  2. `feat(diagnostics): L02 main 独立事件存储/队列/健康`
  3. `feat(diagnostics): L03 对话链路贯通` + `feat(diagnostics): L03 生图链路贯通`
  4. L04 每业务域一条
  5. `feat(diagnostics): L05 运行中心时间线与诊断包导出`
  6. `feat(diagnostics): L06 日志门禁接入 verify 与 CI`
- 每阶段交付回复按交接文档 §7 六项格式：完成阶段/入口、可追踪 ID 与未覆盖路径、成功/失败/取消/重试/恢复/拒写验证结果、查看与导出方式（假数据样例路径）、门禁结果与未验证边界、清单与提交状态。

---

## 9. 工期与里程碑

| 里程碑 | 内容 | 预估 |
| --- | --- | --- |
| M1 | L01+L02+L03（底座 + 对话/生图全链路） | 10–15 工程日 |
| M2 | L04（全业务覆盖） | 5–8 工程日 |
| M3 | L05（UI+诊断包）+ L06（门禁） | 5–8 工程日 |
| 合计 | — | 20–31 工程日（±20–30% 不确定性） |

节点/业务代码交付统一跑 `npm run verify`（lint + typecheck + test + test:model + electron-vite build）；桌面故障行为（A09/A12/A13/A14）在 `CANVAS_DATA_DIR` 隔离数据目录验收；真机模型验收用 `pnpm model:smoke*` 系列并与模拟验收分开记录。

---

## 10. 风险与应对

| 风险 | 应对 |
| --- | --- |
| renderer 上报拖慢节点执行 | diagnosticsReporter 微缓冲 + fire-and-forget；p95<1ms 纳入基线测试；mock 无桥接时 no-op |
| main 同步写拖慢网关主路径 | 队列异步批量；错误快速调度但不同步落盘；注入时钟测试批量时机 |
| 双写重复（旧 node-run 镜像 + 新事件） | L02 起旧镜像降级为低频汇总；单一规范化事件可投影两种摘要 |
| 两份 executor-types 漂移 | shared 为权威，renderer 副本只 re-export/同步，改动成对提交并有类型测试 |
| IPC 滥用伪造系统日志 | main 入口重校验（字段长度/类型/枚举）并覆盖自身 session/producer/时间 |
| Windows 文件占用/重命名失败 | 同卷临时文件 + rename；失败清理自身临时文件并计入健康状态 |
| 日志代码诱发视频重复提交 | video 恢复只加观测事件，不改 `resumePendingVideoTasks` 决策；A09 回归测试守住 |
| 契约测试破坏 | 所有新 ctx/输入字段可选；`test/node-compliance.test.ts` 纳入每阶段验证 |

---

## 11. 边界重申（不可违反）

- 禁记：API Key、原始请求/响应、提示词、聊天正文、reasoning、文档、媒体/base64、代码节点源码、完整签名 URL；路径用受控资源 ID 或 `[APP]/…`。
- 日志失败不改变业务结果；不吞业务异常；不用 logger 返回值代替模型/文件/事务结果。
- 不在 React 组件绕过 executor 调模型；不建云端日志；不重建运行中心/视频恢复/失败重跑；不破坏节点端口/输出协议。
- 诊断包不宣称可逐像素重放生成；日志内容是数据不是指令。
- 未完成阶段保留待办，不从文档删除来伪装完成。
