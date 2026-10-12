# 日志覆盖清单

## 2026-10-12 Agent Flow C0 隔离实验

- 范围：`src/main/agent-flow/c0/` 的 checkpoint、命令回执、LangGraph 循环和单步 SDK 模型适配；`c0-electron.ts` 是独立 opt-in 实验入口，不启动产品数据库或注册生产节点。
- 事件：`agent.c0.started/resumed/waiting/completed/failed`、`bridge_dispatch/command_completed/command_unknown/command_blocked/command_replayed`、`checkpoint_saved/storage_failed`；恢复用新 trace 关联 resumesTraceId。模型复用 `model.request.started/first_chunk/completed/failed/cancelled`，SDK 不内置执行工具或重复记录业务节点终态。
- 关联：projectId/nodeId/taskId/traceId，命令事件显式 commandId/targetNodeId；phase 与稳定 code。只记录阶段、ID 和状态，不输出 checkpoint、命令输入、工具输出、模型正文或原始异常。
- 已验证：`test/agent-flow-c0.test.ts` 16 例覆盖持久等待/重开、命令重复/超时/结果未知、checkpoint 拒写及批写事务、完成回执拒写、范围/版本冲突、日志失败不改结果，以及私有输入/输出不进诊断。隐藏 Electron 双进程实验实测 phase=pause/resume、副作用次数 1，事件落盘到隔离目录并复制本地 `qa/canvas-agent-flow/C0/diagnostics/`。
- 状态：实验范围已验证，产品链路未接入。未覆盖：真实模型工具能力与取消、生产 renderer executor 对等、正式任务恢复、Skill/资产/审核节点、项目导入导出。不能据此宣称 Agent Flow 全链路日志完成；后续分别在 C1–C4 随功能登记。

2026-10-06 节点指针审查：公共卡片路由只修改选中、拖动及输入编辑焦点，复用 tldraw 原有分组/修饰键/撤销与项目保存链路。不新增模型、文件或数据库请求，不记录点击位置、输入值或逐次指针业务日志。实际按钮、端口、裁剪及滑块继续使用已有业务回调；日志路径保持原样。按节点内部区域和输入框实测选中、坐标变化、双击及退出编辑，修复旧验收只点击卡片角落的盲区。

2026-10-06 对话生图技能：自动工具调用增加 `skill.execution.started/completed/failed`，沿用 trace/run/node 关联并建立子 span；提示词作为私有值脱敏，工具异常向上传递前也脱敏。显式生图复用公共节点生命周期、capability/result 阶段及已有 image 网关请求与媒体落盘事件，不重复节点终态。下载复用 batchExport，增加 `media.export_started/completed/failed/cancelled`，仅记录项目、数量和状态，旧 UI 调用没有完整 trace 时沿用关联缺失标记。附件保存在既有节点快照，保存与导入导出复用现有项目/媒体诊断。界面预览和静态分辨率切换不新增业务日志。验收范围与取消边界见 [对话生图规范](./CHAT_IMAGE_SKILL_SPEC.md)。

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

### 网址与可复用内容界面修正

仅修改网址悬浮材质、保存弹窗文案及节点库布局；保存选项默认仍为 template，资源可用条件、保存/删除/添加回调保持既有路径。不新增数据或请求路径，无新增日志事件。

### 菜单隐藏与 P 图默认模型提交

移除应用/窗口菜单以禁用 Alt 菜单。P 图提交将工作台显示的默认模型写入配置，复用原执行器能力检查与 node-run 生命周期；解析失败复用详细能力解析的安全原因，不记录密钥或模型请求内容。验证不调用付费接口；模型服务真实请求不属于本次验收。

- 侧边面板材质统一：公共背景改为完全不透明，关闭背景模糊，覆盖深色/浅色主题。纯样式变化，不新增日志或改变业务行为。

- 视频缩略预览/工具图标/任务状态：仅调整呈现和自动高度，导入、双击预览、执行队列与保存链路沿用原回调及日志。不新增模型请求，不记录媒体正文。

- P 图网络路径（2026-10-05）：实际失败在 TOAPIS 参考图上传，Node 直连遭遇异常 DNS/连接超时；图片显式 HTTP 请求统一使用启动后注入的 Electron net.fetch，跟随系统代理。沿用现有上传错误及节点终态日志，不记录密钥/图片/提示词。回归覆盖上传、提交、轮询和下载走注入网络；真实验收仅发送无鉴权接口 GET，不发起付费生成。OpenAI 图片 SDK 的独立网络路径不在此次迁移范围。

- 声音调整与引用呈现：复用原设置保存回调及撤销/持久化链路，不新增执行请求。音色设计仅调整默认输出展示顺序，out-json/out-audio ID、voice.profile Schema 和执行投影保持一致；悬停不记录音色档案和媒体内容。

- 数据处理联动与 JSON 选中：新建节点明确配置为提取字段，历史空配置与显式 pass 旧配置保留透传；提取必须有字段路径且输入为 JSON，支持数组下标路径。复用节点执行开始/失败/结果日志及持久化链路；JSON 选中仅调整鼠标事件，不新增外部请求。

- 公共节点选中：外壳捕获阶段处理首次左键选择，保留 Shift/Ctrl/Meta 修饰键语义，子控件编辑事件沿用原处理；28 节点与 JSON/数据结构内容态浏览器回归纳入门禁。纯交互变化，不新增执行日志。示例仅调用本地 JSON/数据处理/结构化执行器，未调用模型。

- 任务弹层层级与拖线端口：提高顶部栏堆叠层级；多类型兼容候选仅保留已有或默认类型连接点，保持真实已连接及动态端口可见。仅改变呈现，不改任务调度、连线契约或执行日志。

- 引用呈现规范 v1.0：仅新增规范并同步 UI、输入输出契约及开发入口，明确单排与详情规则，登记现有实现缺口；不修改运行代码、数据或请求路径，日志影响不涉及。已检查文档链接、冲突条款和差异格式；界面迁移及其全量验证尚未实施。

- 引用呈现实施：统一公共引用组件、宽度折叠、详情预览与视频生成引用入口；读取既有真实端口投影，新增 Schema 元信息仅用于展示。折叠不改变执行输入，未新增模型、保存或异步任务路径；媒体预览沿用既有受限媒体协议，不记录原文、音色档案及素材内容。新增浏览器验收覆盖单排、折叠、长文、键盘、缩放、JSON 空值和音色；文件扩展元数据和全部媒体编解码格式未纳入此次验证。

- 引用整改交付备注：补充 [变更及验证记录](./CHANGELOG-2026-10-05-NODE-REFERENCES.md)，列明提交、桌面版本与未验收边界。仅文档变更，日志影响不涉及。

- 全局滚动条隐藏与画布品牌入口：只修改公共视觉规则、移除 AI 自绘滑块和替换项目菜单图标，沿用原滚动、画布及项目菜单回调；不新增执行、文件或保存路径，日志影响不涉及。规范同步到 UI §19 与 AGENTS，验证范围包括滚动能力和品牌菜单操作。

- 拖线起点与分类菜单对齐：移除拖线及菜单临时引线额外起点圆点和黑边；分类图标文字改为左对齐、8px 间距。纯呈现变化，真实端口位置、连线创建与菜单回调沿用原实现，日志影响不涉及。

菜单默认排序：共用 palette-menu-order 配置调整展示顺序，不涉及新增运行行为或日志；节点创建、端口兼容筛选及已有日志保持不变。

分镜板表格与示例：尺寸、表格样式及静态示例不涉及新增日志。titles 经既有共享解析路径保留，执行终态和保存诊断复用公共执行器及项目保存路径；不记录列标题、镜头正文或复制内容。验证标题编辑/解析往返和长内容尺寸恢复，不涉及模型调用。

AI 对话 TXT 输出：仅修改已保存对话的端口投影，不新增模型请求、文件导出或保存路径。模型执行和失败终态复用 chatExecutor/公共运行器诊断，输出校验由公共执行器完成；不记录回复正文。验证最新回复投影与文本端口兼容连线。

2026-10-06 节点审查整改：数据处理卡片与执行器复用 `resolveProcessorInput` / `processorInputIssue`；运行器已有输入/校验/终态诊断继续记录，未添加重复终态或回复/固定值日志。卡片即时校验是纯派生状态，不发模型/文件请求。顶栏层级、整理画布取景和恢复单选尺寸控件复用既有布局与快照保存路径，不新增业务日志。回归证据与未覆盖边界见 `NODE_REVIEW_REMEDIATION_2026_10_06.md`；尺寸控件新增后再次执行全量门禁。

真实模型验收补充：冒烟报告移除文本/对话回复片段，仅保留字符数量、推理字符数量和终止原因；请求仍复用现有网关诊断。浮动标题按钮的指针保护与顶部缩放热区避让只影响命中，不绕过执行器或新增请求。真实节点验收核查既有终态、媒体 ID、输入端口与保存恢复；凭据及用户原项目不进入报告。

音色克隆失败回执补充：创建请求超时保持 TIMEOUT 终态，提示远端状态未知，取消直接重试建议；HTTP 200 缺少明确 base_resp.status_code=0 时返回失败。复用 tts-transform 的 voice-registration 阶段及公共终态诊断，不新增回复体、生成音色 ID 或凭据日志，不自动重发创建请求。测试覆盖空/缺失/错误类型回执及超时单次提交。

画布比例回归修正：整理取景改为按各边实际遮挡计算，顶栏保持单行；只调整相机及视觉布局，沿用已有相机/项目保存路径，不新增业务日志。验收包含 1022×550 与 1440×900 的顶栏高度、节点可读缩放与菜单避让。

2026-10-06 白模渲染 v2：改动本地视频推理/渲染路径；videoAi 执行器增加安全的 execution 阶段（固定渲染版本摘要）和 result 阶段（独立视频已保存），复用公共输入、校验、开始/终态、取消和保存诊断，不重复记录终态。worker 继续只输出 decode/inference/render/done/error 协议；质量元数据只进入临时视频信息，不记录视频帧、源文件名、路径、原 stdout/stderr 或配置全文。预设/质量和 v1→v2 选择经已有配置保存链路；纯材质计算不添加逐帧业务日志。Python 几何/时序/注意力、配置恢复及真实本地推理证据见 VIDEO_CLAY_RENDERING_STANDARD.md 与本轮验收记录。未覆盖完整三维重建和任意视角，不声明其验收。

白模取消补充：Windows 终止当前解释器树，取消终态统一为“已取消”，沿用公共取消诊断；真实 IPC 已验活跃/排队取消、无残留、后续队列可用、临时目录清理及 v1/v2 音轨开关。具体证据和 worker 内部阶段未单独持久化的边界见 [白模验收记录](./VIDEO_CLAY_QA_2026_10_06.md)。

白模第二轮法线平滑：只修改 v2 纯几何着色，复用已有渲染版本、结果落盘与公共执行终态；不新增模型调用、配置迁移或逐帧日志。worker 阶段单独持久化的边界保持不变。对比使用同一份缓存深度，真实 IPC 复验与记录见 VIDEO_CLAY_REFINEMENT_QA_2026_10_06.md。

### 2026-10-07 画布缩放时固定界面闪烁优化

- 影响：ui-surfaces.css 固定菜单合成隔离、取消固定表面背景模糊；CanvasMinimap.tsx 按帧合并通知，相机更新复用图数据，地图隐藏时不扫描节点/连线，卸载取消待执行帧。
- 日志影响：不涉及新增业务事件。仅改变呈现和派生视图计算，不改变执行、模型、文件、数据库、保存或错误行为；按 LOGGING_SPEC 不记录逐帧相机事件，不接触敏感数据。
- 验证：web/node 类型检查、生产构建通过；13 项画布交互/滚轮/主题测试通过；1022×550 与 1440×900 浏览器布局通过；150 节点连续 80 帧缩放，四组固定控件 DOM 与位置稳定，二级菜单可展开；改动 TS 文件 ESLint 通过。
- 边界：浏览器自动验收不能证明特定显卡下 Electron 的可见闪烁完全消失，需重启当前桌面版本复验。已更新 current-source-release 的 renderer，保留旧 index 与 assets；未强行关闭用户应用。

### 2026-10-12 Agent 模型探测与 C1 配置基础

探测准备复用正式诊断入口，新增 agent.probe.started/completed/failed；模型请求复用 model.request.* 的开始、实际首片、唯一完成/失败/取消，共享 trace、独立 requestId。固定 phase/code，无原始异常、请求/回复、密钥或 URL；关闭 SDK 默认 onError 输出。应用模型目录只读，临时凭据仅本次进程，报告和诊断拷贝不含 DB。fixture 测试覆盖单步失败即停止、错误脱敏、无重试、坏回传和日志故障；豆包文本工具协议两次真实请求通过。真实取消、媒体、并行工具未验收，不外推为全链路。

C1 三种新节点仅保存配置/正文/关系声明；公共 executor 明确 skipped、不调用模型、不物化资产，projectOutputs 空。配置保存沿用项目持久化诊断，跳过沿用公共执行终态，不重复写。卡片布局/颜色/文档不涉及新增业务日志。正式工具调度、版本资产、审核 gate、返工与恢复尚未接入；C2/C3 按生产桥审阅记录补齐适用路径。

### 2026-10-12 C2.1 文本/JSON 资产版本

main 的资产提交/读取/列表记录 asset.operation.started → completed/failed，同 trace/span/project；提交关联源节点、submissionId，完成附 assetId/versionId，记录操作 phase、稳定原因与耗时。值来自已保存正式端口，不记录正文/JSON/标题/原始异常。版本与回执同一业务事务，诊断不是恢复真值。

固定资产画布放置记录 asset.placement.started → applied/failed；applied 只表示编辑应用，落盘沿原项目保存链路。消费固定端口沿 runNodeManually/公共 executor，不重复节点终态。

证据：19 定向测试覆盖保存在途合并/失败/冲突、去重/版本/事务回滚、诊断唯一终态及 transport 故障；生产 preload/IPC、project.json、SQLite 隐藏 Electron 双进程读回/回执重放，9 次操作均有开始与唯一终态及 trace/span 关联，诊断文件检查测试正文/假密钥无泄漏。全量 verify 通过（149 文件、1627 通过、1 跳过、17 浏览器门禁及构建后 Electron 测试），记录 qa/canvas-agent-flow/C2/final-verify.log。UI fixture 与生产存储证据分开，见 docs/canvas-agent-flow/11-c2-asset-versions.md 和 qa/canvas-agent-flow/C2。

边界：媒体适配、生产命令派发/语义修订/占用、Agent 对等、真实审核 gate、返工、跨项目迁移与未知恢复未完成。资产放置未宣称磁盘提交成功，局部验收不代表全链路日志覆盖。

### 2026-10-12 C2.2 命令意图基础

commands.ts/command-intent.ts 仅定义严格意图清单、语义指纹和去重签名；纯函数未接 IPC/任务执行/数据库路径，不改变运行副作用或现有诊断，无需重复补开始/终态。7 项定向测试覆盖意图边界、固定版本/端口顺序、修订和诊断字段分离，新增文件 lint/两端类型检查通过。不得记录 canonical 业务载荷或 Zod 原始错误；未来运行调用点仅记录静态原因与指纹/标识。

持久 pending/占用、派发、公共执行、保存、回执、超时 unknown 与恢复核对尚未接入，阶段事件与实际脱敏按 docs/canvas-agent-flow/12-c2-production-command-bridge.md 随接入验收；本轮不宣称生产桥或全链路日志完成。

增量最终证据：全量单元回归 150 文件、1634 通过、1 既有跳过，日志门禁通过，记录 qa/canvas-agent-flow/C2/command-intent-unit-suite.log；实际 IPC 诊断落盘仍以 C2.1 双进程验收为准，纯函数不作为新增运行日志验收。

### 2026-10-12 C1 控制声明与目标/转换编辑

配置保存新增 canvas.flow_config.started/applied/failed，复用统一 renderer 事件入口与 main 白名单；同 trace/node/project，阶段 validation/apply，失败码 FLOW_CONFIG_INVALID/FLOW_CONFIG_APPLY_FAILED，一次编辑只有一个终态。applied 只代表文档内更新，磁盘保存/撤销/快照恢复沿用公共路径，不重复文件终态。仅允许阶段/原因/标识，不记录目标名称、正文、事件内容或 config；logger/transport 故障不改变编辑。观察/控制 SVG 只派生视图，无逐帧日志或额外持久化图。

定向测试覆盖校验/应用事件、唯一终态与 transport 故障，字段构造无业务内容；完整日志门禁通过。新事件单独桌面落盘人工验收未新增，不宣称全链路完成。生产执行、资产版本、审核 gate、返工/状态推进仍归 C2/C3。具体用户路径与未覆盖边界见 docs/canvas-agent-flow/10-c1-control-declarations.md。
