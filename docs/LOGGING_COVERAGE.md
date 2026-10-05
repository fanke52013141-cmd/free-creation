# 日志覆盖清单

这是开发与审查用的持续维护清单，不是运行时生成的覆盖统计。依据[日志规范](../LOGGING_SPEC.md)。

状态：`基础`=有公共阶段或零散日志；`部分`=有专门诊断但缺全链路；`待接入`=目标结构化事件尚无充分证据；`已验收`=提供运行/测试证据后才可使用。源码审阅不等于行为测试通过。

核查日期：2026-10-04（L01–L06 实施轮，基于 5085dc8 工作区）。“已验收”仅覆盖有自动化测试证据的路径；
未列出的失败场景与真机验收边界见每行“待补内容”，不得整行虚报完成。

| 业务域             | 已有入口/证据                                                                                                                                                                                                                 | 状态   | 待补内容                                                         | 实施责任与任务           |
| ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ | ---------------------------------------------------------------- | ------------------------ |
| 公共节点执行       | shared/observability schema v1+注册表；executor.ts 注入 traceId/nodeExecutionId、node.started/唯一终态事件；test/observability/executor-events.test.ts（A01/A02/A15）                                                         | 已验收 | runNodeTest 仍不产生运行记录（有意，登记为不涉及）               | 执行器维护者，L01        |
| 流程/迭代          | workflow.started/completed/failed/cancelled 事件；迭代批次 batchId/itemId 随节点事件携带；run-index.ts                                                                                                                        | 已验收 | item 级部分失败聚合事件（A10 的 100 项基线未跑）                 | 流程维护者，L04          |
| AI对话/AI处理      | main/gateway/chat.ts 发 model.request.started/first_chunk/completed/failed/cancelled；执行器传 requestId+capability 阶段；test/observability/gateway-chain.test.ts（A04/A05/A06）                                             | 已验收 | 真机流式验收未跑（pnpm model:smoke:text 待记录）                 | 文本网关维护者，L03      |
| 生图/图像编辑      | main/gateway/image.ts 入口 started/completed/failed + TOAPIS accepted/task.state_changed/poll_summary/download/persist 分阶段；gateway-chain.test.ts（A04/A07）                                                               | 已验收 | openai-images/openrouter 驱动只有入口级事件；真机未跑            | 图像网关维护者，L03/L04  |
| 长视频             | main/gateway/video.ts 提交/accepted/state_changed/poll_summary/下载/入库/恢复全链事件；429 attempt_failed+retry_scheduled（同 requestId 递增 attempt）；video-diagnostics.test.ts（A03/A09）                                  | 已验收 | MiniMax 适配真机验收未跑；恢复决策 drift 场景未专项测试          | 视频任务维护者，L04      |
| 语音克隆           | main/media/tts-transform.ts report() 改走统一事件（node.stage+phase，私有值脱敏透传）                                                                                                                                         | 已验收 | 独立失败注入测试未建（复用 gateway-events 脱敏测试）             | 音频维护者，L04          |
| 通用配音/音色设计  | AudioGenerateInput 已带 diagnostics 上下文字段；gateway 入口级事件未接入                                                                                                                                                      | 基础   | speech/voice 网关入口事件 + 执行器阶段                           | 音频维护者，L04 待办     |
| 本地媒体与导演输出 | 公共执行器终态事件已覆盖失败；media.repo 写盘失败经 node.failed 传播                                                                                                                                                          | 基础   | 外部进程退出码/信号专项事件                                      | 媒体维护者，L04 待办     |
| 代码Worker         | 执行器公共终态事件覆盖超时/异常；源码禁记由白名单序列化保证                                                                                                                                                                   | 基础   | worker 退出码专项事件                                            | Worker维护者，L04 待办   |
| 项目保存/冲突/恢复 | main/ipc/project.ipc.ts save：project.save.started/completed/conflict/failed；test/db-migrations 侧无；导入导出 transfer.started/validated/committed/failed                                                                   | 已验收 | restore 回滚专项事件（恢复副本功能并行开发中，待其落地后接事件） | 持久化维护者，L04        |
| 项目导入导出       | 同上 transfer.* 事件（导出/导入）                                                                                                                                                                                             | 已验收 | 结构导出 exportStructure 未接                                    | 持久化维护者，L04 待办   |
| 素材库             | main/ipc/library.ipc.ts：revision_published/materialization_completed/failed/mutation_failed                                                                                                                                  | 已验收 | 分类操作失败事件未接                                             | 素材库维护者，L04        |
| 模型连接/能力验证  | main/ipc/models.ipc.ts validate：configuration.validation_completed/failed（connectionId/modelId）                                                                                                                            | 已验收 | 迁移 migration_* 事件未接                                        | 模型目录维护者，L04 待办 |
| 应用生命周期       | main/index.ts：session_started/ended/previous_session_unclean/process_exited（render-process-gone）；before-quit flush≤2s                                                                                                     | 已验收 | 主进程自身崩溃（crash dump）事件未接                             | 桌面底座维护者，L02/L04  |
| 日志文件/独立事件  | src/main/diagnostics：有界队列(2048/8MiB+128关键预留)、session 分片 JSONL（按天/10MiB 轮转）、14d/200MiB/错误配额 20MiB/硬上限 256MiB 保留、健康计数+事件环；diagnostics-storage.test.ts（A12/A13/A14）                       | 已验收 | 慢盘时延专项未测（注入为拒写/满盘）                              | 诊断底座维护者，L02      |
| 查询/导出          | diagnostics:query/health/export-bundle IPC；RunsPanel 流程时间线+导出诊断包；导出 manifest/events/summary/coverage、25MiB 截断、原子写、二次脱敏（diagnostics-storage.test.ts L05 用例）                                      | 已验收 | 项目保存/恢复范围的导出入口未单列                                | 诊断UI维护者，L05        |
| 自动日志门禁       | scripts/check-logging-bypass.mjs（增量 console/electron-log 旁路 + 新文件网络调用缺诊断接入）；scripts/logging-allowlist.json；test/observability/logging-gate.test.ts（A17/A18）；npm run verify 与 CI 已接入 verify:logging | 已验收 | 变更影响声明（logging-impact 机器可读匹配）未建，靠门禁规则兜底  | 工程门禁维护者，L06      |

路径缩写分别相对src/renderer/src、src/shared或src/main；正式修改记录应给出具体文件和函数。

## 每次变更如何更新

### 2026-10-05 节点呈现 v1.2

- 受影响路径：`canvas/NodeCardView.tsx` 自动高度、旧尺寸夹取与恢复自动；`canvas/NodeCardShape.tsx` 手动缩放。仅改变 `props.h`、`meta.nodeHeightMode`、`meta.nodeOriginalHeight`，原正文、媒体、运行结果及业务配置不变。
- 持久化复用既有项目文档保存/恢复链路与项目保存诊断阶段。未新增文件、数据库、网络或模型调用；导入、生成、配置操作复用原回调与公共执行器，不重复登记终态。
- 验证：浏览器门禁验证 900px 旧尺寸迁移到 440px、保留原值 900、手动模式及正文经文档快照恢复保持不变；全量保存协调、项目同步、快照修复、执行和日志门禁继续执行。
- 脱敏：几何变化不记录正文、回复、媒体路径或密钥。当前未新增逐次拖拽遥测事件，避免高频噪声；未逐一打开用户真实历史项目，保留既有项目恢复覆盖边界。

### 2026-10-04 T10/T11 独立来源与复用

来源保存由 media IPC 发 artifact.recipe_started/saved/failed/read_failed，只记项目/节点/运行关联，不输出私人配方内容；缺少根 trace 时标记 correlationMissing。来源 JSON 与完整提示词只进项目数据库和用户项目包，诊断导出仍只读脱敏事件。
复用文件预检发 library.reuse_preview，记录结果及缺文件数，后续复用既有物化/保存和补偿记录。纯提示词预览不记录用户输入；创建取消发生在物化之前。
验证：recipe-provenance、transfer.integration、library-insert 与浏览器路径验证通过；verify:logging 通过。真机事件落盘、资源复制后的配方传播尚未实现；主进程关闭窗口时来源保存仍待专项验证，不把此记录宣称为全业务来源覆盖。

### 2026-10-04 T09 输出新鲜度与固定

执行指纹复用 node.input_validated/公共唯一终态，不输出输入内容或指纹；UI 派生新鲜度不产生逐渲染日志。
固定/解除固定接入 node.output_pinned/unpinned，带 projectId/nodeId/traceId 和端口数，不写输出正文；取消确认不产生已解除事件。
freshness.test.ts 与浏览器六项操作验证业务语义，verify:logging 通过；事件实际落盘与撤销后状态专项尚待 Electron 真机验证。

### 2026-10-04 恢复安全补强

历史版本恢复由 renderer/canvas/snapshot-restore.ts 编排，CanvasSidePanel.tsx 接入统一 producer/reporter。
注册 project.restore.cancelled，并复用 started/checkpoint_created/completed/failed/rollback_completed/rollback_failed；同一操作携带 projectId、traceId、spanId、phase，失败仅记录标准错误码，不写版本正文或原始异常。
snapshot-restore-guard.test.ts 20 例覆盖预检失败、确认取消、内容/项目变化、检查点失败、应用及回滚失败和日志失败不影响业务。该证据不等于真机日志落盘验收；恢复范围导出入口及真实桌面复验仍待补。

1. 修改已有业务域时更新该行，新增业务域新增行；不能仅更新本文件日期。
2. 记录新事件/当前阶段日志、上下文传播、失败场景、测试命令与结果。
3. 所有者用实际实现者或模块角色，不虚构人员；关闭“待补”必须附证据。
4. 一次改动可只迁移受影响路径，其他路径列明尚未覆盖；禁止整行虚报已完成。
5. 无影响变更在PR说明即可，不必为了颜色/文案给本表新增业务域。

## 变更验收记录模板

```text
日期 / 提交或工作区标识：
业务域 / 实现者或角色：
新增或复用的事件 / trace阶段：
开始与终态记录的拥有者：
project/run/node/request/task关联范围：
成功/失败/取消/重试/恢复适用用例：
脱敏、拒写和日志失败不影响业务的证据：
测试命令 / 结果 / 样例文件：
未覆盖路径 / 后续任务 / 计划完成阶段：
审查结论：
```

## 2026-10-04 T12–T16 及补缺

- 最近删除恢复：主进程拥有 project.undelete.started/completed/failed，关联 projectId；失败不会把项目移出删除列表。真实 SQLite 用例和 Electron 重启恢复已通过。
- 分镜批处理创建：canvas.batch_flow.created/failed，只记 project/node/trace 与创建数量；执行与局部续跑继续复用 workflow/node 的公共阶段和 batch/item/run 关联，不重复终态。
- 资源/项目复制来源：复用现有 library 物化、项目复制路径的日志；完整提示词仅进入私有 artifact_recipes 与资源 metadata，不进入诊断。凭据清除在主进程保存边界再次执行；复制失败继续补偿媒体。
- 结果折叠/展开、搜索上下键、最近删除页签、性能索引和文档规范为界面/派生状态，不增加逐渲染日志。镜头选用保存到项目 meta，由现有保存路径记录落盘。
- 本轮真实 Electron 注入 project.json.tmp 目录制造拒写：返回失败，原文件保持一致；来源重启读取与删除恢复通过。付费供应商取消/关闭中的全链路来源保存仍未真实调用验收。
- 事件 SDK、日志失败不影响业务和脱敏门禁沿用 observability 专项测试。不能据此宣称旧业务域全部无盲区。

- 媒体物理预检：media.files_preflight / media.files_preflight_failed，关联 projectId，记录缺失数量，不记录文件路径、媒体正文或原始异常。恢复流程复用 project.restore.* 的 trace/span。

## 2026-10-05 代码审查修复

- CanvasEditor：冲突重载、保存反馈、关窗保存/恢复副本、初始快照失败接入 project.canvas_failed，携带 projectId 与固定 phase；不携带原始异常、路径或项目正文。main 保存事务的终态仍由原 IPC 发射，该事件仅描述 renderer 阶段失败。
- 应用渲染失败改为 application.render_failed；媒体导入读取与文档抽取失败分别使用 media.read_failed / media.document_extract_failed。preload API 暴露失败通过既有诊断 IPC 直接上报 application.preload_failed，只记录固定摘要；诊断 IPC 失败不能再次抛错。
- video 轮询失败、取消和超时继续由现有节点执行器/网关阶段日志记录；资源清理和乐观锁失败继续由 library IPC 失败入口记录，不重复添加终态。
- 日志门禁匹配 fetch 空参数、空格与模板字符串；门禁以新增行检查网络调用与裸日志，修正规则注释并删除恒假判断。删除零调用的 legacy-adapter。
- 本轮精确媒体查询、类型 re-export、端口/布局缓存、打包白名单和历史文档标注不新增正文日志。性能缓存不逐渲染记录事件。

## 2026-10-05 节点资源队列

- 调度入口增加 workflow.task_queued / workflow.task_admitted / workflow.task_cancelled，关联 projectId/runId/traceId/spanId；不记录提示词、模型响应、文件路径或密钥。
- 已执行节点的开始、阶段、终态复用公共 executeNodeUnscheduled；排队取消不会调用执行器或产生付费请求。手动任务复用独立 workflow.started 和终态，不覆盖前台工作流汇总。
- resource-queue 与 manual-run 用例覆盖排队取消、运行取消后保留额度、释放唤醒、防重和并行状态隔离；日志传输失败继续由 diagnosticsReporter 吞掉，不改变业务结果。
- 边界：当前额度为当前 renderer 会话中的总模型/GPU/媒体/本地额度；不代表供应商账户实际余量，也不跨桌面窗口共享。额度不持久化、任务不跨重启续跑。真实付费供应商取消尚未验收。

## 2026-10-05 节点四图呈现修复

- 字数顺序、图标/按钮对齐、模型徽标移除、消息动作位置和端口布局均是呈现/手势变化，不增加执行、数据或付费调用，不新增生命周期日志。
- 网址双击复用现有设置面板和浏览器跳转；保留 HTTP/HTTPS 校验，不记录目标 URL。消息复制、用户编辑和重新生成继续走既有处理入口；删除助手编辑入口，不新建消息修改/请求路径。
- 浏览器 mock 验证两态网址各自路由、AI 操作仅复制/重新生成、单端口居中与溯源线稳定；没有发起付费请求。公共执行与诊断传输边界不变。

## 2026-10-05 文档结果产物与图片表单

- AI 处理成功结果通过 buildOutputPackets 校验后创建文档节点，node.document_materialized 复用 recordRunTrace 的 project/run/node/trace 关联；不记录回复、提示词或 JSON 数据。开始、失败、取消与终态沿用公共执行器，失败和测试不创建结果节点。
- 单元与浏览器 mock 覆盖文本/Markdown/JSON 产物、保存恢复、失败无产物；真实付费模型未调用。诊断失败边界保持既有 reporter 行为。
- 裁剪完整预览、生图自然高度、P 图参数布局及查看已有结果复用既有 UI/执行入口，不涉及新请求或额外终态日志。


### 2026-10-05 节点呈现 v1.3 修正

仅调整说明可见性、底部操作呈现及内容几何；保留导入、裁剪、生成、创建后续节点的原回调与执行器，不改变数据/网络/落盘路径，无新增日志事件。复用现有导入、节点运行、项目保存诊断。验收不触发付费模型请求；运行器业务链路不在本次新增验证范围。


### AI 处理结果呈现修正（2026-10-05）

成功结果直接在节点正文框显示完整文本、Markdown 原文或格式化 JSON，取消配置/查看结果切换按钮。短结果最低 260px，长结果自动增长到 440px，超出由公共正文滚动区承载；不截断内容。配置保留右侧面板入口。仅修改读取已有输出投影和呈现，不改变执行器、结果持久化及日志路径，无新增日志事件。浏览器门禁验证自动显示、完整末尾、440px 上限与可滚动。


### AI 结果阅读与格式（2026-10-05）

AI 处理卡片只显示输出，取消通用输入预览。点击正文选中节点并允许选文，滚动条拖动不启动节点拖动；选中后的滚轮使用公共正文外壳，边界不传递到画布。Markdown 输出用已有 ReactMarkdown/GFM 渲染，禁用原始 HTML；纯文本保持换行和字面符号。仅改呈现与滚轮路由，不变更执行、持久化和请求路径，无新增日志事件。
