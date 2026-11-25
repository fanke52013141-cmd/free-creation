# Canvas Studio Agent 对接代码审查报告

- **日期**： 2026-10-25
- **审查模型**： GLM-5.3
- **审查基线**： `source/` 工作区（已提交 `71b70f3` = A0–A1.2 外部接入 14 项操作 + 工作区未提交的 A1.4 只读查询、Skill Agent、状态机执行、媒体取消等约 3,200 行改动）
- **审查方式**： 主审查精读外部接入核心链路全部源码；三个并行子审查分别覆盖「画布 Agent Flow 运行时（main/agent-flow + shared/agent-flow，约 900KB）」「渲染进程 Agent UI 与 Skill Agent」「测试、门禁与文档一致性」。关键结论均经源码交叉验证，测试类结论经过实跑复验（local-agent-access 33/33、bridge/rename/watcher/migrations 17/17、command-ledger 抽查 91/91、接入门禁通过、change-impact 182 个哈希独立重算一致）。

---

## 一、总体结论

**整体质量高于平均水准，无 P0 阻断级缺陷。** 本次 agent 对接（外部接入 + 画布 Agent Flow + Skill Agent）在安全建模、幂等设计、状态机严谨性上体现了罕见的一致工程纪律；测试断言真实度高（真实 SQLite、真实命名管道、真实 MCP SDK 子进程，几乎不 mock 关键路径）。

主要风险集中在四个方面：

| # | 风险 | 严重度 | 一句话描述 |
|---|------|--------|-----------|
| 1 | 主进程同步 IO 热路径 | P1 | 无缓存全量读盘 + 每步全文件哈希 + 100ms 轮询，真实媒体项目下会全应用卡顿 |
| 2 | 恢复链在窗口重建后断裂 | P1 | render-process-gone 监听只挂在启动窗口上，节点可能被 FLOW_NODE_OCCUPIED 永久锁死 |
| 3 | UI 层 stale meta 覆盖写 | P1 | await 之后用渲染闭包旧 meta 整体覆盖，会吞掉主进程并发写入的资产标记 |
| 4 | 文档/门禁与实现漂移 | P1 | 能力矩阵仍写"6 种 target/状态机未开放"，未提交代码已是 9 种/已开放；机器门禁对此失明 |

统计：P1×4、P2×14、P3×30+（详见下文清单）。

---

## 二、审查范围与代码分布

```
外部 Agent 接入（本次对接主体）
├─ src/shared/agent-access/     registry.ts(447) / connection.ts / desktop.ts   — 契约与 Schema 单一来源
├─ src/main/agent-access/       service.ts(563) / server.ts(151) / desktop.ts(109) / queries.ts(39)
├─ src/local-agent/             index.ts(118) / client.ts(105)                  — CLI/MCP 薄代理
├─ 集成点                        main/index.ts、project-watcher.ts、project.ipc.ts、
│                                projects.repo.ts、transfer.ts、db-migrations.ts(M19)、preload
└─ test/                        local-agent-access(1088 行) + 3 个专项

画布原生 Agent Flow（内部运行时）
├─ src/main/agent-flow/         38 个文件（command-ledger、desktop-host、task-store、
│                                skill-store、coordination-store、runtime 等）
├─ src/shared/agent-flow/       19 个文件（commands、video-adapter、semantic-revision 等）
└─ src/main/ipc/                flow-commands.ipc.ts、flow-agents.ipc.ts

渲染层与 Skill Agent
├─ nodes/specs/agentFlow.tsx、AgentTaskControls、FlowBuilderControls、AgentCollaborationPanel
├─ 未提交：SkillAgentSettings.tsx、RunTimeline.tsx、skill-library.ipc.ts、shared/skill-agent.ts、
│          engine/media-cancel.ts、main/media/cancellation.ts 等
└─ preload/index.ts 白名单暴露
```

---

## 三、Findings 清单

### 3.1 P1 —— 应尽快修复（4 项）

**[P1-A] 画布 Agent Flow 主进程同步 IO 热路径，重复执行多个数量级**
- `src/main/store/projects.repo.ts:131-154` — `readProjectSnapshot` 每次 `readFileSync + JSON.parse` 整个项目 JSON，`openProject` 无任何缓存/记忆化。
- `src/main/agent-flow/image-assets.ts:56-60` — `fixedFlowMedia` 每次调用 `statSync + readFileSync` 全文件 + sha256（上限 20MB）。
- `src/main/agent-flow/command-ledger.ts:345-360` — `resolveInputs` 对 video 目标先调一次 `assets.resolveInputs` 取 kind，随后 map 中对同一资产再调一次：**同一文件在一次 prepare 内被完整读取哈希两遍**。
- `src/main/agent-flow/runtime-model.ts:478-492` — `decide()` 每一轮模型决策都对全部固定输入重新 `resolveInputs`，媒体每次重读重哈希。
- `src/main/agent-flow/runtime.ts:111-112` — `valid()` 每步 `assertRevision` → `openProject` 全量读盘 + `canonicalFlowJson` 递归序列化整图 + sha256。
- `src/main/ipc/flow-agents.ipc.ts:204-243`、`flow-commands.ipc.ts:243-272` — coordinator `publish`/`deliver` 回调 100ms 轮询，前者每次 `openProject`，30 秒窗口最多约 300 次全量项目读盘解析。
- **影响**：一条含 20MB 参考视频的命令在 prepare/check/commit/每轮 decide 中被同步读取哈希十余次；大画布 + 多参考视频下主进程事件循环长时间阻塞，全部 IPC（含 UI）卡顿。这是最可能率先被用户撞到的问题。
- **建议**：`openProject` 按 (graphVersion, mtime) 做进程内快照缓存；`fixedFlowMedia` 按 (mediaId, size, mtime) 缓存哈希；`decide()` 的固定输入观测值随 checkpoint 传递；100ms 轮询改为 DB 变更通知或至少 500ms–1s。

**[P1-B] `render-process-gone` 恢复链在窗口重建后断裂，pending 命令占用永久锁死**
- `src/main/ipc/flow-commands.ipc.ts:98-100` — `window()?.webContents.on('render-process-gone', ... => ledger.loseRenderer())` 只在注册时挂接当前窗口；`src/main/index.ts` macOS `activate` 分支会 `createWindow()` 重建窗口，新窗口的 webContents 上没有该监听；`window()?.` 为 null 时静默跳过注册且无日志。
- **影响**：窗口重建后渲染进程崩溃时 `loseRenderer()` 不再执行，pending 命令不转 unknown，节点被 `FLOW_NODE_OCCUPIED` 永久占用，只能重启应用解除。
- **建议**：监听挂接移入 `createWindow()`（或 `browser-window-created` 统一挂接）；注册失败路径补诊断日志。

**[P1-C] AgentTaskControls 在 await 之后用渲染闭包 stale `shape.meta` 覆盖写**
- `src/renderer/src/nodes/specs/AgentTaskControls.tsx:109-124` — `await ensureCanvasSaved()` 长等待窗口之后执行 `editor.updateShape({ meta: { ...shape.meta, agentTask } })`；`shape` 是渲染时快照。等待期间主进程 `flowAgents:publication` 推送（CanvasEditor.tsx:385-387）会同节点写 `agentAssetVersionId`、`agentTaskId` 等物化标记（executor.ts:1319-1330）。
- **影响**：后写者把先写者的 meta 键整体回滚 → executor 的"已放置资产"检查（executor.ts:1308-1315）失效，同一资产被重复物化为新节点；或卡片状态与主进程权威状态不同步。
- **建议**：统一采用 executor 内部已验证的安全模式（executor.ts:881-888：每次 `getShape` 取 fresh meta 再 `mergeShapeMeta`）；`AgentCollaborationPanel.tsx:107-117` 已是正确写法，两处应统一。

**[P1-D] 能力矩阵/README 与工作区实现方向性矛盾，且机器门禁无法拦截**
- `docs/local-agent-access/02-capability-matrix.md:160` 写"当前 Flow target 只有六种"，而未提交的 `src/shared/agent-flow/video-adapter.ts:29-54` 已支持 **9 种**（新增 image-crop@2、image-split@3、code@3，`test/agent-flow-target-matrix.test.ts:13-53` 已固化 9 项）；`:157` state-machine 标"独立执行 pending"，而未提交代码已启用（`agent-flow-node-registration.test.ts:63` 断言执行返回 done）。
- `02-capability-matrix.md:60-67` — project.open/save/update/rename/export 五行仍标 planned，与同一张表中已更新的 clone/delete 行自相矛盾（这五项在台账 06 中已验收，测试完备）。
- `scripts/check-agent-access.cjs` 哈希范围只覆盖 `src/**` 与自身，docs 完全不在保护范围内。
- **建议**：同包刷新矩阵（9 种 target、状态机已执行、项目表五行状态）；把关键计数（target 数、操作数、节点数）纳入门禁机器校验。

### 3.2 P2 —— 有实际影响（14 项）

**外部接入链路（主审查精读）**

**[P2-1] 幂等键被无副作用的前置拒绝永久占用**
- `src/main/agent-access/service.ts:142-179`（claim 先行）→ `:186-196`（occupancy/desktop 检查在后）→ `:286-293`（失败持久化为终态回执）。`RESOURCE_BUSY`、`DESKTOP_UNAVAILABLE`、`REVISION_CONFLICT` 等尚未产生任何副作用的失败也被写入终态 failed 回执。
- **影响**：按文档"同一次意图的重试必须复用同 key"（05 台账:84）行事的合规客户端，重试同一 key 将永远重放该失败回执；而 `error.retryable` 恒为 false，客户端无从判断何时该换 key。 RESOURCE_BUSY 这类瞬态失败被错误地固化为永久失败。
- **建议**：区分"admission 拒绝"与"副作用后失败"：进入副作用（desktop.run / execute）之前的失败删除 pending 行不落终态回执；或对 BUSY 类失败在回执中标记 `retryable=true` 并允许同 key 覆盖重试。

**[P2-2] 桌面握手失败一律塌缩为 OUTCOME_UNKNOWN，放大 reconcile 面积**
- `src/renderer/src/App.tsx:125-136` 所有失败（REQUEST_EXPIRED、CANVAS_NOT_READY、保存超时等）统一回 `ok:false`；`src/main/agent-access/desktop.ts:50-51` 对 `!reply.ok` 一律 `unknownOutcome=true` → 回执落 OUTCOME_UNKNOWN。
- **影响**：请求过期这类确定性、零副作用的失败也被标"结果未知"，外部 Agent 被迫核对业务事实；且回执丢失真实失败原因（`DesktopReplySchema` 无原因码字段）。
- **建议**：`DesktopReplySchema` 增加可选 `code` 字段，renderer 回传稳定失败码；主进程对确定性失败码置 `unknownOutcome=false`。

**[P2-3] 连接层认证失败完全静默，无失败可观测性**
- `src/main/agent-access/server.ts:77-84` — token/instanceId 校验失败直接 `socket.destroy()`，无诊断事件、无失败计数、无限速。本地攻击者可无限次探测管道而产品侧零痕迹（256-bit token 本身不可暴力，但可观测性缺失）。
- **建议**：认证失败计入安全计数（不含内容）并 emit 一次脱敏诊断事件；可选指数退避断开。

**[P2-4] 崩溃残留的 `flow_coordination_scope` 行会持续阻塞该项目全部外部写操作**
- `src/main/agent-access/service.ts:329` — `SELECT 1 FROM flow_coordination_scope WHERE project_id=?` 不带状态过滤。正常路径有清理（coordination-store.ts:134），但崩溃残留行没有自动核对/回收机制（台账 06 已登记 recovery-contention 偶发窗口）。
- **影响**：曾运行协调流程后崩溃的项目，`project.update/save/clone/delete/export` 全部 RESOURCE_BUSY，直到桌面端完成一次正常协调生命周期；当前无 `run.reconcile` 类外部核对入口。
- **建议**：协调 scope 行增加状态/时间戳字段，或提供与内部协调宿主一致的核对入口，允许"确认无活跃会话后"释放残留占用。

**画布 Agent Flow 运行时**

**[P2-5] video 模式检查的裸 `JSON.parse` 在防护之前执行，错误分类失真**
- `src/main/agent-flow/command-ledger.ts:279-283` — 取 `JSON.parse(target.props.config).mode` 无 try/catch，先于下一行的安全 parse 执行。目标节点 config 为非法 JSON 时抛 SyntaxError，IPC 层归类为 `FLOW_STORAGE_FAILED`（flow-commands.ipc.ts:169-172），用户与遥测看到"存储失败"而非"输入契约无效"。同类：`desktop-host.ts:368-375, 157-159`、`coordinator-host.ts:482-486`。
- **建议**：统一"先安全 parse 再取字段"辅助函数，所有 config 读取走单一入口。

**[P2-6] `semanticProjectPayload` 过滤规则与 `find(...)!` 非空断言冲突**
- `src/main/agent-flow/coordinator-reviews.ts:275-280` — `semanticProjectPayload` 会过滤"未连线且 pinned 的 text/json 卡"；若返工负责人节点恰为此类，`find` 返回 undefined，`.text` 抛 TypeError，被包装为 `FLOW_COORDINATION_FAILED`，根因丢失。
- **建议**：显式 null 检查，返回 `FLOW_REWORK_TARGET_UNSUPPORTED`。

**[P2-7] `FlowTaskStore.setState/wait` 破坏本模块"事务内状态转移"约定**
- `src/main/agent-flow/task-store.ts:126-138`（read-then-update 无 `db.transaction`）、`:176-183`（`wait()` 不校验当前状态直接置 waiting）。同文件其他方法均在事务内。
- **影响**：当前单进程同步执行下暂无交错，但终态检查可被绕过、对未来引入异步的改动是 TOCTOU 陷阱。
- **建议**：`setState/wait` 改为事务 + 条件 UPDATE（`WHERE state IN (...)`）的 CAS 式转移。

**[P2-8] `CoordinationStore.save()` last-writer-wins 全量覆盖，无 revision CAS**
- `src/main/agent-flow/coordination-store.ts:94-106` — 仅检查 cancelled 与 preservePause 即整行覆盖 `body_json`；`event()` 有 CAS 而 `save()` 没有。消费方 `coordinator-host.ts` 在多个 await 点之后用内存副本反复 save。
- **影响**：stop()/pause() 与 wave 完成回调交错时可能丢失 children 更新（cancelled 有兜底，其他字段没有）。
- **建议**：save 携带 expectedRevision 做条件更新，或收敛为单一写入队列。

**[P2-9] `run()` 的 reconcile/restore 分支不加 admission 锁**
- `src/main/agent-flow/desktop-host.ts:910-911` — 检查 `active/admission` 后未 `admission.add`，与正常 start/continue 可并发进入同一任务；`await controlVideoTask`（:930）拉大窗口，状态/code 可能抖动。
- **建议**：reconcile/restore 复用 admission 互斥。

**[P2-10] 超长函数与双份节点契约校验逻辑**
- `desktop-host.ts:258-507` `bind()` 约 250 行（7 种节点类型校验块重复）；`cooperate()` 176 行；`coordinator-host.ts:679-942` `recover()` 263 行；`review-host.ts:72-315` `run()` 243 行。
- `command-ledger.ts` 的 `authorize/resolveInputs` 与 `desktop-host.bind` 对同一组 `*FlowConfigValid/*FlowInputsValid` 存在两份并行实现（一份基于 command.inputs，一份基于图 edges），需人肉同步，漏改即产生准入与执行不一致。
- **建议**：抽取"目标节点输入契约校验"单一入口共享；拆分超长函数。

**[P2-11] DB/快照读回数据广泛使用 `as`/`!` 绕过 zod 防线**
- 例：`desktop-host.ts:123-124, 752, 1094`、`coordinator-host.ts:324, 331`、`coordinator-reviews.ts:279`、`flow-commands.ipc.ts:221`、`builder-host.ts:137`。shared 层为外部输入建立了严格 schema（做得好），但 main 层从 DB 读回的数据不走 schema，损坏数据以 TypeError 炸出并丢失错误码（最终都成 `*_FAILED` 兜底）。
- **建议**：DB 读回的 receipt/run/snapshot 一律过对应 schema `.parse`（run-status.ts:3 已有正确示范）。

**[P2-12] `skill-store.list()` 不校验 `content_hash`，与 `bind()` 行为分裂**
- `src/main/agent-flow/skill-store.ts:24-39`（只 parse）对照 `:113-115`（bind 校验 sha256）。body 被改动时 list 正常、bind 失败。**建议**：list 同样校验（skill ≤128KB，成本可控）。

**渲染层与 Skill Agent**

**[P2-13] Agent/Builder 卡片 750ms 常驻 IPC 轮询，方向与本次状态机改造背道而驰**
- `src/renderer/src/nodes/specs/AgentTaskControls.tsx:22-49`、`FlowBuilderControls.tsx:27-47` — 无条件永久轮询 `flow-agents:inspect/build`；FlowBuilderControls 在 projectId 为空时仍每 750ms 空转；而事件通道（`canvas-agent-task-updated`、`AgentPublication`）已存在。本次未提交改动已把状态机卡片改为 meta 驱动（正确方向），这两处未跟进。
- **建议**：轮询降级为兜底（5s 或仅 running 态高频），主路径靠事件推送；projectId 为空不启动。

**[P2-14] SkillAgentSettings 对无效显式配置静默渲染为空态，UI 与执行契约不一致**
- `src/renderer/src/nodes/specs/bodies/SkillAgentSettings.tsx:67-69` — `agent.success === false` 时传 `undefined`，组件按"未配置"渲染全空勾选；执行侧同一配置直接失败（executors/chat.ts:37-45）。用户 UI 看到没绑技能、运行却报配置无效，且一旦在 UI 勾选保存会无提示整体替换原配置。
- **建议**：无效配置显式渲染告警（"已保存的技能配置无效，运行将被阻止"）。

**测试/门禁（P2 级）**

- **[P2-15]** `scripts/check-agent-access.cjs:21-36` 哈希 scope 含 `gateway/chat.ts` 却不含 `gateway/video.ts`、`ipc/gateway.ipc.ts`、`ipc/media.ipc.ts`、`media/*`——本次未提交修改恰含这些文件，且 change-impact 的 reason 明文承认其属于接入影响面，机器哈希却不覆盖。
- **[P2-16]** `test/agent-flow-command-ledger.test.ts:545-556` 用例名声称"未声明配置在准入处拒绝"，测试体只有 happy path，零负断言；删掉 ledger:299-301 的接线测试仍全绿。
- **[P2-17]** 迁移并发声明（db-migrations.ts:448-454 "BEGIN IMMEDIATE 后重读版本"）无任何双连接/双进程并发测试；`db.ts` 未显式设 `busy_timeout`。台账 06 已记录过真实 SQLITE_BUSY（run-fGy8iz）。

### 3.3 P3 —— 改进项（择要，共 30+）

**外部接入**
- 回执清理仅在启动时执行（service.ts:88-90），长会话回执越 TTL 仍累积。
- 导出 `existsSync`→`linkSync` 存在微小 TOCTOU（service.ts:528,544），竞争失败方收到 OUTCOME_UNKNOWN 而非 OUTPUT_EXISTS。
- intent HMAC 对 JSON 键序敏感（service.ts:150-152），语义相同、字段顺序不同的输入被误判 IDEMPOTENCY_CONFLICT。
- 每连接只处理单请求、无复用（server.ts:56-67）；`project.list` 全量载入后内存分页（service.ts:459-471）；`client.ts:18` 死代码（`CANVAS_DATA_DIR ??` 永不触达）。
- 断电时 `agent-exports/` 残留 `.uuid.canvasbundle` 临时文件，无启动清理。
- `capability.list` 全仓库零成功路径测试；`app.status` 仅失败路径覆盖；回执剪枝无数据级测试。

**画布 Agent Flow**
- `command-intent.ts:17-20` 裸 parse；8 处无列名 INSERT 依赖列序（command-ledger.ts:561 等）；`json_extract` 查询在 commit 高频路径潜在全表扫描（无表达式索引）；错误包装不带 `cause` 丢根因（3 处）。
- 协作历史 40 条硬上限，超限后 note/revise 硬失败而非截断归档（collaboration-store.ts:30）。
- `resolveInputs` 按 index 对齐 edges/assets，顺序不同即误拒 `FLOW_INPUT_SOURCE_MISMATCH`（多参考视频 30 输入时易触发）。
- `desktop-electron.ts`（224KB 验收 harness）与生产代码同目录靠 argv 区分，建议移入独立目录从生产构建剔除。
- `inspect()` 查询带写副作用（失联 running→blocked），GET 语义与写库耦合。
- `timed()` abort 监听器在已中止路径残留；coordinate 30s 超时后未 abort 模型流，网络请求空转（runtime.ts:117-126、coordinator-host.ts:506-530）。

**渲染层**
- 状态机卡片一次只能提交第一个合法事件（agentFlow.tsx:147-168），与正文提示"可提交事件：a、b、c"不符。
- agentFlow.tsx 死代码与不一致：`:214` 恒真条件、`:902-909` 不可达分支、`:119` `nextRevision` 命名歧义、重置写 `null` 而 executor 消费 `''`。
- 每渲染双重 `JSON.parse + zod safeParse`（agentFlow.tsx:74-77 等）叠加全图 `deriveGraph`，大画布拖动每帧多次全图遍历；语义指纹每条命令至少计算 3 次（flow-command-bridge.ts:140-146, 250-267）。
- 绑定技能的 chat 节点丢失流式反馈与 reasoning（skill-agent.ts:38-47 未桥接 progress）。
- chat 节点双配置通道混用（模型配置在 `props.text`，agent 配置在 `props.config`）。
- `diagnostics.ipc.ts:158-171` query 无 sender/frame 校验（与本次建立的安全基线不一致，只读低危）；`skill-library.ipc.ts` 每次拒绝都发诊断事件，可被刷。
- Skill 上传边角：单文件分支绕过"目录必须含 SKILL.md"校验；schema 失败提示固定为"最多 8 个/256KiB"但实际可能是 id 重复；32 位 FNV 指纹理论碰撞（有 SKILL_VERSION_IMMUTABLE 兜底）。

**门禁**
- `change-impact.json` 自身不在哈希 scope，可手改 `sourceHashes` 绕过；scope 内被 gitignore 或非 .ts/.cjs 文件不被哈希；reason 只查长度不查内容（03 文档已如实声明为"承认制"子集）。
- M19 建表缺 `IF NOT EXISTS`，偏离 M7–M9 自己确立的双保险模式（曾运行中间构建的开发库会迁移失败且无自愈）。
- 裁剪/拆图"无效配置被 parse 归一化后准入"——inputFingerprint 冻结的是归一化结果，语义敏感，需在文档写明。

---

## 四、分维度评价

### 4.1 架构与契约一致性 —— 强

"一份业务契约，多个薄入口"已真实落地：Registry（shared/agent-access/registry.ts）是 CLI 命令目录、MCP 工具描述、JSON Schema、生成契约快照（generated/contracts.json）的唯一来源，独立重算 182 个哈希一致。main 是唯一业务调用者，CLI/MCP 只做传输；语义修订 CAS 在 authorize（prepare/resumeVideo/check 三入口）与 commit（saved-revision 二次校验）双侧执行，协作修订、协调 scopeRevision、状态机事件各有 CAS；`commit` 只接受已保存执行事实、`assets.submit` 只认保存画布的确定性投影——**未发现任何可绕过 CAS/账本伪造成功的路径**。节点契约（31 类）强制登记且缺失即门禁阻断。

### 4.2 安全性 —— 强（未发现可利用漏洞）

- 传输：命名管道 + 每次启动轮换的 256-bit token + `timingSafeEqual` + instanceId 双因子；连接 1MiB 上限、16 连接上限、15s 超时；POSIX 下 0o600 socket/文件权限。
- 桌面桥：requestId/sender/mainFrame 三重绑定 + 10s 有效期 + 单 pending 串行化，迟到回执不能授权新操作。
- 路径：导出 fileName 白名单正则（无遍历面）、媒体 realpath+relative 双重包含检查、符号链接逃逸有专项测试（SEC-04）、skill 上传对绝对路径/../盘符/null 字节全部显式拒绝。
- IPC：flow-agents/skill-library 均做 sender+mainFrame 校验；preload 暴露面克制（agent-access 仅 3 个窄 API）；无 innerHTML/eval/原始 ipcRenderer 透传。
- 脱敏：事件只记固定 operation/phase/code/trace；密钥/token/正文/路径不落日志，有逐事件断言验证。
- 弱点仅 P2-3（认证失败静默）与 P3 级（diagnostics query 无 sender 校验、harness 同目录）。

### 4.3 可靠性与恢复 —— 设计突出，工程收尾有缺口

unknown ≠ failed、pending 崩溃转 unknown 不重放、恢复副本/占用/版本三重准入、`recoverAbandoned`/`loseRenderer`/60s 超时/`AGENT_SESSION_LOST` blocked 的恢复闭环完整，且与 05 号协同规范 CN-01~CN-09 高度吻合。缺口集中在：P1-B（恢复链断裂）、P2-9（reconcile 无锁）、P2-4（协调占用残留无核对入口）、断电原子性未验收（台账已如实声明）。

### 4.4 性能 —— 最弱维度

见 P1-A：这是全审查中唯一"正常使用即可撞到"的级别问题；叠加渲染层 750ms 轮询（P2-13）与每帧全图遍历（P3），多 Agent 大画布场景下主进程与渲染进程双侧都有系统性浪费。

### 4.5 测试与门禁 —— 断言真实度罕见地高，盲区在长尾与并发

强项：故障注入用 DB 触发器强制回执写失败；脱敏断言对整个响应+事件流逐一否定 secret；started↔唯一终态 1:1 配对在单测与 e2e JSONL 两级验证；e2e 是真实闭环（双实例占用拒绝、跨 CLI/MCP 幂等复用、活动画布 dirty edit 先 flush 再导出、重启回执持久）；command-ledger 91 用例覆盖指纹伪造/伪造回执/符号链接逃逸。
盲区：文档行级状态（P1-D）、门禁哈希范围（P2-15）、并发迁移/并发 UI+外部写/物理断电（P2-17 及长尾清单）、capability.list/app.status 零覆盖、e2e 依赖真实显示器无法无头 CI。

### 4.6 代码质量 —— 分层清晰，局部债集中在 main 执行层

shared 契约层质量高；main 执行层的 `as`/`!` 断言（P2-11）、双份校验（P2-10）、四个 200 行级函数是主要技术债；注释普遍解释"为什么"，错误码体系可用性好。

---

## 五、优化建议（按优先级）

### 第一优先（P1，建议本迭代内完成）

1. **修性能热路径**（P1-A）：`openProject` 快照缓存（键 graphVersion+mtime）→ `fixedFlowMedia` 哈希缓存 → `decide()` 固定输入走 checkpoint → 轮询降频到 ≥500ms。四项相互独立，可分别提交，收益立竿见影。
2. **修恢复链挂接**（P1-B）：监听移入 `createWindow()`；同批检查 `registerGatewayIpc` 等同类旧窗口引用。
3. **修 stale meta 覆盖**（P1-C）：AgentTaskControls 改 fresh `getShape` + 定向写键，与 AgentCollaborationPanel 统一。
4. **刷新能力矩阵并纳入门禁**（P1-D + P2-15/16）：矩阵改 9 target/状态机已执行/项目表五行；`check-agent-access.cjs` scope 补 `gateway/`、`ipc/gateway.ipc.ts`、`ipc/media.ipc.ts`、`media/`、`process-lock.ts`、`db.ts`；关键计数机器校验。

### 第二优先（P2，建议下个迭代）

5. **幂等语义分层**（P2-1）：admission 拒绝不落终态回执，或 BUSY 类标 retryable 允许覆盖重试；同步更新文档中"复用同 key"的指引。
6. **握手失败码**（P2-2）：DesktopReplySchema 加 `code`，确定性失败不再标 unknown。
7. **轮询降级**（P2-13）：借状态机 meta 驱动模式把 Agent/Builder 卡片一并迁移。
8. **统一 config 安全 parse 辅助函数**（P2-5）并顺手修 coordinator-reviews 的 `find!`（P2-6）。
9. **任务/协调层并发机制化**（P2-7/8/9）：setState/wait 事务化 CAS、CoordinationStore.save 带 revision、reconcile 分支进 admission。
10. **skill-store.list 补 hash 校验**（P2-12）；SkillAgentSettings 无效配置告警（P2-14）。
11. **补齐三个测试缺口**（P2-16/17 + capability.list）：裁剪准入负断言、双连接并发迁移 + `busy_timeout`、capability.list/app.status 成功路径。

### 第三优先（中期架构性）

12. **节点输入契约校验收敛为单一入口**（P2-10），消灭 ledger 与 bind 的双份实现——这是防止未来"准入与执行不一致"类缺陷的结构性投资。
13. **DB 读回数据一律过 schema**（P2-11），把 `as`/`!` 从 main 执行层清出去。
14. **验收 harness 迁出生产目录**（desktop-electron.ts 等），生产构建剔除。
15. **协调占用核对入口**（P2-4）：为残留 scope 行提供与内部一致的 reconcile 路径，避免"只能重启"。
16. **认证失败可观测**（P2-3）+ 导出临时文件启动清理 + M19 补 `IF NOT EXISTS`。
17. **渲染层性能**：config parse 结果按字符串缓存、语义指纹版本号缓存、chat 双配置通道收敛到 props.config。

---

## 六、结语

本次 agent 对接的**安全与正确性建模是这套代码最强的部分**——三层防伪造结构（authorize 四重校验 / commit 只认保存事实 / assets.submit 只认确定性投影）、幂等账本、unknown 语义与恢复设计都达到了可审计的水准，且台账文档的"如实登记未验收边界"习惯值得保持。**当前的真实短板不在设计而在工程耐久性**：性能热路径、窗口生命周期、任务层并发约束"靠约定不靠机制"、以及文档与门禁的覆盖缺口。按上述第一、第二优先级修复后，这套架构具备承载 A2（画布/节点外部操作）与 A3（外部执行）继续扩展的条件。

— 审查结束 —
