# 本地媒体运行中停止、诊断排障闭环与状态机独立执行（P1-A / P1-B / P2-A）

日期：2026-10-24。按 [本地开发交接](HANDOFF_2026_10_24_LOCAL_DEVELOPMENT.md) §4 的优先级交付：P1-A（本地媒体一致性与运行中停止）→ P1-B（失败到诊断包的排障闭环）→ P2-A（状态机节点独立执行）。基线为 L2–L4 之后的同一工作区（`71b70f3` + 未提交改动），本轮改动继续保留在工作区未提交。

## 1. P1-A：本地媒体一致性与运行中停止

**类型：已有功能的专项验收 + 针对“停止后本地任务继续跑完并落库迟到资产”这一复现问题的修复。**

### 缺口与修复

停止工作流时，已发到主进程的本地媒体调用（ffmpeg 取帧/截取/提音、audio-separator、宫格拆分循环）不会自己结束：渲染器丢弃结果，主进程继续跑完并把迟到资产落进媒体库——媒体库里出现与任何节点结果无关的孤儿文件。修复分三层：

1. **主进程作业注册表**（`src/main/media/cancellation.ts`）：`AsyncLocalStorage` 作用域按 `projectId/nodeId` 关联一次变换；`runFfmpeg/runProcess` 注册子进程终止句柄，宫格拆分在每格之间检查取消标记并回滚已写资产。新 IPC `media:cancel-transforms` 终止该节点名下仍在执行的作业并返回数量。
2. **渲染器取消订阅**（`RunControl.onCancel`）：停止/资源取消/Agent 命令取消统一触发监听器；`runCancellableMedia`（`src/shared/engine/media-cancel.ts`）把媒体 IPC 与取消竞速——取消后立即请求主进程终止，并把迟到的成功信封交给清理回调删除孤儿资产（单资产删一个、拆分逐格删、截取链按 produced/intermediate/vocals 分别清理）。signal 不支持订阅的宿主保持旧行为。
3. **执行器接入**：裁剪/拆图/取帧/截取（含截取内提人声）/提音/声音调整/人声分离全部传入 `nodeId` 并走竞速包装；裁剪与透视渲染开始前检查取消标记。取消以稳定码 `MEDIA_TRANSFORM_CANCELLED` 收尾，与普通失败区分。

### 一致性验收（真实桌面，真实素材）

`scripts/test-media-local-acceptance.cjs` 驱动隐藏真实 Electron（隔离数据目录、`out/main/media-local.js` 入口），napi-rs 生成 6000×4000 四象限 PNG、本机 ffmpeg 生成 90 秒 720p MP4：

- 单节点手动运行 / 选区依赖闭包 / 全图执行三种方式下，裁剪结果集合按 1→2→3 递增，端口输出、`out-image` 投影一致；
- 8×8 拆分 64 格全部落盘；快速截取成功；同一全图中下游 processor（pick 需要 JSON）确定性失败，**上游裁剪成果与 success 状态不因下游失败丢失**；
- 主进程核对裁剪产物 PNG 尺寸精确为 3000×2000（参数 0.5×0.5），源图 SHA-256 运行前后一致（原素材不被覆盖）；
- 运行中停止：拆分与 79 秒 balanced 重编码截取各停在第一次尝试（`exec=cancelled`、资源队列清零、结果集合无迟到新增）；主进程 `media.transform.cancelled` 日志记录终止数量，不含路径；
- 固定结果一致性（L2 桌面复验）：钉住裁剪历史结果后即使运行记录为失败，`out-image` 仍暴露钉住资产；
- 保存重开：正文/配置/连线/64 格结果/固定输出/失败代码节点状态全部一致；3 秒无人操作不自动重跑；修改参数后明确重试成功并新增一条历史结果（媒体计数精确 +1）。

诊断断言：`node.started` 逐条有唯一终态（traceId/nodeId 配对）、`workflow.started` 与终态数量相等、事件不含数据目录路径与素材文件名。证据：`qa/local-reliability/media-local-acceptance/`（results.json、执行/重开报告、diagnostics 副本）。

### 单元与浏览器回归

- 新增 `test/media-cancel.test.ts` 13 项：竞速包装六场景（未取消/进行中取消/迟到信封清理/无 onCancel 旧行为/入口已取消/非取消失败不触发终止）、裁剪与拆分执行器取消路径（迟到资产删除、结果不写入）、取帧取消、主进程返回稳定取消码、作用域注册表（终止句柄单次触发、跨节点隔离、无作用域无操作）。
- 更新既有精确形状断言接受新 `nodeId` 字段（video-transform、sound-adjust）。
- `test-browser-local-stop.cjs`、`test-browser-local-consistency.cjs`（上一包 L1/L2）复跑通过。

## 2. P1-B：实际失败到诊断包的排障闭环

1. **summary.txt 按 trace/span 身份配对**：旧的“workflow 开始总数 vs 终态总数”会被范围截断、重跑和跨范围导出互相抵消。现在同一 `traceId/spanId` 看到开始且无唯一终态才列为未完成，逐条列出开始时间；孤立终态（有终态无开始）单独标注为可能截断；节点执行（`node.started` 对 node.completed/failed/cancelled/skipped）同样配对并列出 nodeId/runId。回归：`test/observability/diagnostics-storage.test.ts` 新增配对场景——总数 2:2 互相抵消的旧算法下，新摘要仍明确列出未闭合流程、孤立终态与未完成节点。
2. **correlationMissing 祖先关联补齐**（历史缺失不补造，只补真实可得的关联）：
   - 生成来源保存（`artifact.recipe_started/saved/failed`）：执行器把运行根 `traceId` 写入 ArtifactRecipe（schema 增加可选 `traceId`），IPC 沿用；读取失败仍显式 correlationMissing（确实无关联来源）。
   - MiniMax 语音克隆阶段事件：`TtsGenerateInput` 增加可选 `traceId`，执行器传入 `ctx.diagnostics.traceId`；有 trace 时事件携带真实祖先关联，旧输入仍显式标记缺失。回归：`test/tts-clone-gate.test.ts` 新增 sink 断言（带 trace 关联 / 旧输入缺失标记）。
3. 摘要增强与导出四文件格式、脱敏、原子写入、logger 故障隔离沿用既有 26 项服务测试，未重建导出器。

## 3. P2-A：状态机节点独立执行

**类型：确实待开发的能力。首版按协同规范 §5 落地“人工事件驱动”的独立执行，不宣称 Agent 自动调度。**

- **权威实例**：`meta.stateMachine`（JSON：taskId/stateNodeId/revision/state/lastEventId/history≤200）。只有 `stateMachineExecutor` 推进它；UI 只把人工提交事件写入 `meta.stateMachinePending`（类比聊天面板写待发送消息），不存在第二份可编辑 currentState。
- **迁移规则**：提交携带 `expectedRevision`，过期按修订冲突拒绝（实例保留、明确提示重新提交）；`lastEventId` 提供事件去重；只应用配置里声明的 `from+event→to`，未声明转换显式失败；配置漂移（当前状态不在声明列表）与实例/节点不匹配都在 input 阶段失败；损坏的 pending 提交按输入失败，不静默当作无事件。
- **无模型参与**：执行器不访问网关（测试用 Proxy 断言任何网关访问即抛错）；正式输出是 `flow.state@1` 契约的 `out-state`（`projectStateMachineOutputs` 投影），通过输出契约校验。
- **UI**：卡片显示当前阶段与修订号、待应用提交状态、当前阶段可提交的事件；「提交事件」真实按钮入 pending（markUndoPoint），「重置任务」经确认弹窗清除实例。移除 `executionDisabledReason`——状态机在创建菜单与运行按钮的既有 readiness 门禁下正常可用。
- **消费语义**：tldraw 对 meta 是浅合并，执行器消费 pending 后写空串（删键不生效），解析侧把空串视为无事件。
- **验收**：`test/state-machine-executor.test.ts` 13 项（初始化/合法迁移/修订冲突/去重/未声明转换/幂等刷新/配置漂移/节点不匹配/坏配置/重开恢复/契约一致/坏 pending/下游投影）；`test/agent-flow-node-registration.test.ts` 更新为断言开放执行且不访问网关；`scripts/test-browser-agent-flow-c1.cjs` 更新执行可用性断言；新增 `scripts/test-browser-state-machine.cjs` 真实画布闭环——首次运行初始化→卡片点击提交→运行推进 draft→working→快照重开一致→过期修订拒绝且实例不污染→正确修订完成 completed。证据 `qa/local-reliability/state-machine-standalone/`。

## 3.5 接续批次（2026-10-25）：P1 残余、P2-B 与技能目录包

- **P1-A 残余**：桌面验收扩展提音（video-audio）与快速人声增强（vocal-separate fast）真实 ffmpeg 链路：全图执行各产出 1 项资产、保存重开一致；提音的运行中停止以 `exec=cancelled` 命中（`node.cancelled` 唯一终态）；高质量人声分离在本机无 audio-separator 时断言稳定前置失败、不落盘半成品（装有 separator 的机器自动走真实分离分支）。媒体计数 72→重开 73 精确核对。
- **P1-B 残余**：`videoTask/videoCancel` 增加可选 `traceId`，渲染器等待器与视频执行器透传运行根 trace，`task.control.*` 事件带真实祖先关联；无 trace 调用与启动恢复路径保持显式 `correlationMissing`（历史缺失不补造，登记为既有盲区）。回归：`test/observability/video-diagnostics.test.ts` 双分支断言。
- **P2-B**：`image-crop@2`、`image-split@3`、`code@3`（限单参数单输出）加入内部 Agent 可调度目标矩阵：`flowTargetContract/flowTargetPorts` 扩展（code 端口从配置精确重建，`portIdentity` 锁定），任务准入（desktop-host）校验固定图片输入与类型匹配，命令准入（command-ledger）校验配置形态与契约版本。裁剪/拆图以真实 SQLite 账本 fixture 验证命令准入与版本拒绝；执行/取消/unknown 与六类既有目标共用同一命令执行、媒体取消通道与桌面对等路径。
- **Skill 目录包**：`parseSkillBundleUpload` 受控解析——根部唯一 SKILL.md + 至多 16 个扁平 .md 资源；拒绝路径穿越/绝对路径/嵌套资源/非 Markdown/重名；总量 128 KiB 预算；版本对全部文件内容寻址（任何文件变化产生新版本）。设置面板新增“上传技能目录”（webkitdirectory），复用既有安装 IPC 与 skill.library 生命周期，不新增日志事件。
- **脚本技能边界**：任意脚本执行需要独立的工具白名单与隔离运行环境设计，本包不实现、不把内容循环包装成任意工具 Agent（沿用交接约束）。

## 4. 日志与接入检查

- 新增 `media.transform.cancelled`（electron-log，固定字段 projectId/nodeId/cancelled，无路径无正文）；节点取消沿用公共 `node.cancelled` 唯一终态，媒体执行器不重复记终态；P1-B 三处只补真实 traceId，缺失仍显式 correlationMissing。
- `docs/LOGGING_COVERAGE.md` 新增本批条目；日志门禁 `npm run verify:logging` 通过（无旁路、新增网络路径已接入）。
- Agent 接入门禁：受保护源码变化已按实际行为刷新 `docs/local-agent-access/generated/contracts.json` 与 `change-impact.json`（外部 18 项 operation 输入/输出 Schema 不变）；`npm run verify:agent-access` 通过。

## 5. 验证基线与边界

- 定向：媒体取消 13 项、诊断存储 26 项（含新配对）、tts/gateway 关联 38 项、状态机 13 项 + 注册 5 项 + agent-flow 系列 88 项；L1/L2 浏览器与状态机/C1 浏览器脚本复跑通过。
- 全量：`npm run typecheck` 0 error、`npm run lint` 0 error、`npm test` 2569 通过 / 5 既有跳过（208 文件）。
- 桌面：`qa/local-reliability/media-local-acceptance/` 两阶段真实 Electron 通过（本机 ffmpeg，无任何供应商调用）。
- 完整验证：接续批次 `qa/verification/run-Y5fFsd/` 退出 0（北京时间 2026-10-25 08:44:53–08:59:48）：lint、node/web 类型、2575 单元通过/5 既有跳过、模型另 2、日志/接入门禁、全部浏览器门禁、生产构建、CLI/MCP 真实接入、全部 Agent Flow 桌面专项（含 video-rework 的 task.control 探针语义更新）及 R09 通过；其前 `run-w6jHk9` 因 rework 夹具把 task.control 探针计入媒体生命周期归属检查而失败，夹具修正后业务代码未变。主批次 `run-9mZFGP/` 退出 0（北京时间 2026-10-25 00:04:39–00:19:44）：lint、node/web 类型、2569 单元通过/5 既有跳过、模型另 2、日志/接入门禁、全部浏览器门禁（含 C1/declarations 的状态机新行为）、生产构建、CLI/MCP 真实接入、全部 Agent Flow 桌面专项及 R09 通过。此前 run-TBRACI（接入门禁哈希过期）与 run-AgWavk（declarations 卡片文案断言未同步 P2-A）两次失败记录保留，均修复后未改变业务代码。
- 边界：本机停止已能终止本地子进程，**不等于远端供应商任务已取消**；拆分回滚覆盖格子间取消，单格同步渲染无法中断（迟到整包由渲染器清理兜底）；物理掉电、真实磁盘满、audio-separator 高质量模式的真机验收不在本轮；状态机首版仅人工事件，Agent 自动调度（P2-B）未开放。

## 6. 长期技术债审计（2026-10-25，纯文档收口）

对旧 HANDOFF「长期技术债」四项逐一核实现状，全部关闭或转为明确边界，**无代码改动**：

1. **`db.ts` 动/静态导入告警**：完整构建输出 0 告警，renderer 源码无任何 db 导入——main/renderer 存储边界在此前重构中已分离，该告警与其风险（非预期 chunk）已不存在。
2. **`NodeCardProps.text` 字段复用**：逐执行器审计——speech/tts/image-gen/video/aiProcess/processor 等均按「用户正文在 `props.text`、固定参数在 `props.config`、运行结果在 `meta.nodeResult`」三分离执行；chat 的 text 存对话会话数据、storyboard 存分镜数据、structured 存用户模板，均为节点的内容载体而非配置复用。唯一「配置混入 text」的是 legacy `script` 节点（text 存 `{source, shots, outputFields, modelKey}`），该节点已冻结禁止新建、仅为旧项目兼容保留——迁移它反而破坏兼容。结论：无待迁移项。
3. **迭代节点并发**：执行器侧并行池已完整落地（W2）：并发 1–4 有界认领、`onFailure:'fail'` 停止认领新项且在途项自然完成、`out-items` 按原始下标有序聚合、中途取消在途项作废为 skipped、resume 按条目指纹复用，`test/iterate.test.ts` 含真并发回归。renderer 宿主未声明 `parallelItems` 是记录在案的设计决策：循环体节点在画布上是单张卡片，未做每项独立视图（UI 虚拟化）前并行执行会互相覆写卡片运行状态——这不是未完成的清理，而是等待 UI 层投入的能力边界。
4. **节点 Schema 细化**：`character.profile@1`、`scene.definition@1`、`shot.definition@1`、`prompt.bundle@1` 已全部注册（`node-schemas.ts`）并有专属校验分支，P2 数据批次已交付。

本节为纯文档变更，按交接约束不重跑整套验证；审计涉及的构建输出与测试文件（`test/iterate.test.ts` 5 项并行回归）为现有已验证资产，未修改。
