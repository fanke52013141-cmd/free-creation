# Agent 测试缺陷记录

本轮基线：`b96faf49a484256bbbf8ee7f1d9ccbdd814810e6`。本文件保留该基线下的原始缺陷复现；2026-10-17 后续工作已修复AGT-20261016-001、AGT-20261016-003并追加对应回归，未覆盖原失败证据。其他缺陷状态仍以各自后续复测记录为准。

## AGT-20261016-001：音画审核证据未校验音轨结束时间与时长的一致性

- 状态：已修复并复测通过；原始严重度 S2（协议完整性），对应 MED-04。
- 位置：`src/shared/agent-flow/media-review.ts` 的 `AudioVideoTimelineEvidenceSchema`；`src/main/agent-flow/video-review.ts` 的 `assertAudioVideoReviewEvidence` 复用该 schema。
- 影响：内部矛盾的音画时间线证据能通过 schema 与固定媒体守卫。正常采样构造器会计算 `audioEndMs = audio.startMs + audio.durationMs`，现有正例通过；本轮没有证明正常生成会产生错误证据，也没有证明外部用户可以绕过任务权限写入此证据。

### 最小复现

1. 合法基线：视频起点 0ms、时长 1000ms；音轨起点 100ms、时长 1000ms、结束 1100ms；offset=100ms、endDelta=100ms；四帧时间为 0/250/500/750ms。
2. 只把音轨 `audioEndMs` 改为 1200ms、`audioEndDeltaMs` 改为 200ms，保留音轨起点和时长。
3. 调用 `AudioVideoTimelineEvidenceSchema.safeParse`。
4. 再使用实际合成媒体，经 `FlowReviewHost.run` 取得合法证据，然后对上述两字段各加 100ms，调用 `assertReviewEvidenceForMode(db, 'p', 'audio-video', inconsistent)`。

预期：结束时间必须等于起点加时长，两个边界均拒绝矛盾证据；实际：schema 返回 success=true，媒体守卫没有抛错。正常媒体与未修改证据仍通过。

### 复现命令与证据

```powershell
npm test -- test/agent-flow-plan-media-boundaries.test.ts
npm test -- test/agent-flow-media-review.test.ts
```

- 第一组：33 项，32 通过、1 失败；`test/agent-flow-plan-media-boundaries.test.ts` 的 MED-04 end timestamp 负例。
- 第二组：4 项，3 通过、1 失败；`test/agent-flow-media-review.test.ts` 的 MED-04 saved-review media guard 负例。
- 2026-10-17当前源码组合复跑：3个Agent边界测试文件共100项，99通过、1失败；再次命中上述 end timestamp schema 负例，音画审核保存守卫负例由第二组证据独立确认。复跑命令为 `node scripts/run-vitest.cjs run --maxWorkers=1 --minWorkers=1 test/agent-flow-plan-boundaries.test.ts test/agent-flow-plan-media-boundaries.test.ts test/agent-flow-plan-request-boundaries.test.ts`；完整结果见 `qa/agent-comprehensive/run-20261017-agent-boundary-expanded-v1/vitest.log`。
- 证据根：`qa/agent-comprehensive/run-20261016-203617/`。
- 原始报告：`plan-media-boundary-results.json`、`media-review-negative-results.json`；同名 `.log` 保留断言栈。
- 两组均使用隔离数据，无真实模型/供应商 HTTP 调用，无付费请求。第二组使用确定性模型桩、临时 SQLite 及合成音视频。
- 原修复建议：同时检查音轨起点、时长、结束、offset 与 endDelta 的关系；保留合法非零偏移正例，并回归审核保存/缓存恢复。

### 修复与复测（2026-10-17）

在 `AudioVideoTimelineEvidenceSchema` 中加入 `audioEndMs === audioStartMs + audioDurationMs` 约束。原负例（仅增加结束时间和 endDelta，起点/时长不变）现在在 schema 准入与已保存审核媒体守卫两层均拒绝；准确的非零偏移与延迟音轨正例仍通过。

- `node scripts/run-vitest.cjs run test/agent-flow-plan-media-boundaries.test.ts test/agent-flow-media-review.test.ts`：2个文件 / 37项通过。
- 与其余计划/请求边界、固定资产及诊断队列用例合并复跑：6个文件 / 121项通过。
- 当前源码Electron媒体审核桌面夹具执行/重开两阶段均通过，完整固定图片、规范化音轨及A/V时间线/四帧证据范围保留；5个合成模型请求，真实供应商/付费/外部HTTP均为0。typecheck与Electron/Vite构建通过，诊断脱敏断言通过。
- 证据见 `qa/agent-comprehensive/run-20261017-agent-med04-desktop-v1/`、`test/agent-flow-plan-media-boundaries.test.ts`、`test/agent-flow-media-review.test.ts`。原始缺陷证据和失败日志保留不变。

## AGT-20261016-002：异常 Agent 配置打开设置触发整页错误界面

- 状态：三种输入在隔离浏览器中各两轮、Windows解包版初测均复现；AGT-20261016-002 已修复并在当前源码Windows x64解包版三种输入下复测通过，对应 CFG-06。未验证签名安装版或干净机器。
- 位置：`src/renderer/src/nodes/specs/agentFlow.tsx` 的 `configOf` 校验失败返回空对象，`AgentFlowSettings` 取得 catalog 后直接读取 `draft.tools.some` 等数组属性。
- 输入：非法 JSON `{`；合法配置增加 `unknownPermission: true`；合法配置的 `schemaVersion` 改为 0。
- 操作：在隔离画布载入其中一种配置，打开该 Agent 详情/设置，等待 catalog 返回。实际解包版在打开节点详情时即进入错误边界，无法到达“设置”标签。
- 预期：明确显示配置无效并阻断保存/运行，保留可操作的画布和修复入口。
- 实际：整页显示“应用未能正常启动”，具体原因为 `Cannot read properties of undefined (reading 'some')`；`.tl-canvas` 与设置均不可见。
- 入口可达性：通过正式 `exportProject/importProject` 与临时 SQLite 完成导入后，`{` 配置仍保存于新项目的 Agent 快照。该测试证明导入不会在此之前拒绝这一配置；共享 renderer 使用同值复现整页失败。未宣称已把整套流程在正式 Electron 导入按钮中连跑完成。
- 对照：六种职责/参与方式组合保存和重新打开设置、maxSteps=0/1/64/65 的UI校验、关闭未保存草稿共 11 个子例通过。
- 初次记录：`agent-config-matrix-initial-results.json` 与 `agent-config-matrix-initial.log`。
- 再次确认：`agent-config-matrix-confirmed-results.json`，含错误边界的实际文字；`config-invalid-json.png`、`config-unknown-key.png`、`config-old-schema.png`。
- 导入可达性：`config-import-reachability-results.json`，1 个特征测试通过，26 个既有测试由名称筛选跳过，不计为本次重跑通过。
- Windows 解包版复核：`packaged-cfg06-invalid-config-v3-results.json`；非法JSON、未知键、旧schema均显示相同 `undefined.some` 全页错误，画布/设置消失，进程正常退出；截图 `packaged-cfg06-v3-invalid-json.png`、`packaged-cfg06-v3-unknown-key.png`、`packaged-cfg06-v3-old-schema.png`。无模型/供应商/外部HTTP请求。
- 边界：此前浏览器 UI 使用隔离适配器；项目导入测试使用生产导入/导出函数、临时目录与SQLite；新复核为实际 Windows 解包版而非安装包；没有真实模型/供应商调用。
- 修复：无效配置使用完整类型默认值安全绘制，不再返回空对象；节点卡片显示无效状态、阻止执行并提供修复入口。设置页明确要求显式“恢复默认配置”后才可保存修复，避免静默覆盖失效权限。
- 修复后复测：当前源码Windows解包版对非法JSON、未知键、旧schema三种项目均可打开详情和设置，画布可见、无页面异常；每种配置均通过显式恢复默认值并保存，project graph与tldraw snapshot配置一致且通过schema检查；三进程均正常退出，模型/供应商/外部HTTP请求为0。证据：`qa/agent-comprehensive/run-20261017-cfg04-cfg06-current-v1/packaged-cfg06-recovery-results.json`、三个 `packaged-cfg06-*.png`、`packaged-cfg06-recovery-smoke.cjs`。

## 验证缺口

AGT-20261016-003（SEC-02，原暂定S2）历史复现：命令IPC未拒绝自有 `__proto__` 字段。使用 `JSON.parse` 在原本合法命令上加入 `"__proto__":{"polluted":true}`，断言确认其为自有字段；调用正式命令IPC测试入口，实际ok=true、flow_commands新增1条、renderer派发1次。全局 `({}).polluted` 仍为undefined，未观察到原型污染或授权绕过；原缺口是方案要求的严格保留键拒绝。相同测试的长ID、普通未知键、重复端口、129引用和自执行5个负例均被拒绝。初跑及确认分别见 `security-ipc-boundary-results.json`、`security-ipc-prototype-confirmed-results.json`，后者11项中10通过1失败；无真实供应商调用。

### AGT-20261016-003 修复与复测（2026-10-17）

`NodeExecuteCommandSchema` 现在在 Zod 对象解析前检查原始输入的自有 `__proto__` 键，并将其作为 `FLOW_INPUT_INVALID` 拒绝。IPC 回归确认 `flow_commands` 数量为0、grant 未发送、返回体与诊断不包含原始保留键或字段值；全局原型保持未改变。长ID、普通/嵌套未知键、重复端口、129引用、自执行等负例也保持拒绝。

- `node scripts/run-vitest.cjs run test/agent-flow-command-ipc.test.ts test/agent-flow-command-ledger.test.ts test/agent-flow-command-intent.test.ts test/agent-flow-command-executor.test.ts test/agent-flow-video-review.test.ts test/agent-flow-plan-request-boundaries.test.ts`：6个文件 / 166项通过。
- 随后完整复跑 `test/agent-flow`：28个文件 / 544项通过，原Agent Flow v3回归中的SEC-02一项与MED-04两项失败均未再出现。
- `pnpm run typecheck`：Node/Web 类型检查通过。
- 隔离测试无真实供应商、付费或外部HTTP请求。定向证据日志、退出码及源文件SHA-256见 `qa/agent-comprehensive/run-20261017-agent-sec02-prototype-fix-v1/`；全目录回归及SHA-256见 `qa/agent-comprehensive/run-20261017-agent-flow-regression-after-sec02-med04-v4/`。

## AGT-20261016-004：Agent 输出无法通过文本选择复制

- 状态：已修复并通过隔离浏览器复测；暂定S2（结果可用性），对应 SEC-08 的复制验收步骤。
- 原因：tldraw `.tl-container *` 对画布后代统一设置 `user-select: none`；节点捕获的指针路由还会把拖选手势交给画布移动节点。
- 操作：在隔离画布显示恶意 HTML 文本输出，鼠标拖选整段文字并读取选区；另以 DOM Range 检查文本节点。
- 预期：内容保持为惰性文本，同时可以复制。
- 实际：`innerText` 与 Range 内容完整，但鼠标选区和 `window.getSelection()` 均为空，不能完成复制。
- 同次正向检查：Agent 输出、审核反馈及 5000 字错误仍按纯文本显示；没有活动 `script/img/a`，拦截到的恶意主机请求为0；提交停止错误后任务仍为 waiting。详情面板状态路由可打开/关闭；该合成布局未验证真实 Electron 中信息按钮的鼠标命中。
- 原始失败证据：`qa/agent-comprehensive/run-20261016-203617/agent-render-security-results.json`、`agent-render-security.png`。复现入口：`node qa/agent-comprehensive/run-browser-agent.cjs sec08`。
- 修复：Agent/审核/建图的只读结果文本标记为可选文本；节点指针策略选中对应节点后将指针留给浏览器原生选文，不触发画布拖动。此改动不改变执行或诊断路径。
- 修复后复测：隔离浏览器 v4 的 SEC-08 全部检查通过：Agent输出和审核反馈字面文本、实际鼠标拖选157字符、详情面板开关、5000字符错误显示、无活动 HTML 标记/外链请求、停止错误不改变等待状态。测试报告 `failedChecks=[]`、外部请求0。`test/node-pointer-policy.test.ts` 5/5通过，Node/Web typecheck通过。
- 证据与哈希：`qa/agent-comprehensive/run-20261017-agent-sec08-output-copy-fix-v4/`。v1-v3 修复过程中的失败运行保留，v4为通过结果。
- 边界：这是内容可用性缺陷，不是脚本执行或网络注入；运行使用浏览器隔离适配器，不代表真实 IPC 权限验收。

完整参数组合、独立人工业务体验、系统 DPI/输入法、同一 renderer 长驻、实际分发包及真实设备专项仍需对应证据；它们不能依据局部自动化通过而签字。真实供应商测试按 handoff 暂缓。

用户已确认本轮不重复历史 90 分钟存储压力。冗余运行已停止，原始停止前快照与 `soak-user-stop.json` 分别保留，不改写成通过；引用最新 R09 handoff 的时长与手动恢复结论，并保留历史强制中断、未清理等限制。


## AGT-20261017-005：无模型 Agent 启动先进入本地工作流

- 状态：已修复并通过当前源码 Windows 解包版复测；保留修复前失败日志作为历史证据。对应 CFG-03 的无模型子场景，缺少工具/模态组合仍未测；暂定 S2。
- 前置：模型目录为空，Agent 已有测试任务目标；供应商凭据已从进程环境移除。
- 操作：在 Agent 卡片点击“启动任务”。
- 预期：缺少决策模型时在工作流准入前拒绝，不产生任务/工作流副作用、命令或模型请求，并给出可定位原因。
- 修复：共享节点契约新增模型绑定状态检查；手动Agent节点运行和全工作流入口均在建立工作流状态/日志前拒绝缺模型配置。Agent卡片路径在 `ensureCanvasSaved` 前检查当前持久任务事实，允许已有 waiting/blocked 任务继续，其余情况给出缺模型提示并返回。
- 修复后实际：提示“请在节点设置中选择决策模型”；点击后无 workflow/node/task/model 事件，未保存、入队或改变 exec/nodeRun/nodeResult/agentTask；应用退出阶段单独发生的项目保存未归因到点击动作。模型请求、Agent子任务、真实供应商和外部HTTP均为0。测试夹具初始 exec.status 已是 failed，比较前后完整状态确认未变。
- 证据：修复前 `qa/agent-comprehensive/run-20261016-203617/packaged-cfg03-no-model-recheck-results.json` 与 session JSONL；修复后 `qa/agent-comprehensive/run-20261017-cfg03-no-model-preflight-v1/packaged-cfg03-no-model-results-v2.json`、隔离数据目录、截图、smoke harness 与 execution-manifest.json。
- 回归：`test/observability/executor-events.test.ts` + `test/manual-run.test.ts` 22项通过；Node/Web typecheck、构建和Windows x64解包版构建通过。CFG-03整项暂记未执行（未完成），无模型打包UI子场景通过。
- 限制：仅验证“无模型”参数；禁用模型及缺少工具/模态能力的组合未执行。模型选择器没有配置真实或付费供应商。

## AGT-20261017-006：Agent 诊断 ZIP 的 opt-in 错误栈保留敏感正文

- 状态：已修复并通过当前源码诊断 ZIP 集成复测；原始内存存储探针保留为修复前历史证据。对应 LOG-04，源码检索未发现生产调用点设置 `withStack: true`，因此原缺陷属于 opt-in API/导出组合。
- 操作：构造 `agent.probe.failed` 事件，错误对象消息包含假 prompt、response、媒体 base64、API key、Bearer、签名 URL 和绝对路径标记；调用 `DiagnosticsProducer.build(..., { error, withStack: true, privateValues })`，写入内存诊断存储后导出 ZIP。
- 预期：诊断包仅保留错误码/安全字段，错误栈不含 prompt、response、媒体原文或凭据。
- 实际：导出的 `events.jsonl` 仍含 `AGENT_PROMPT_PRIVATE_20261017`、`AGENT_RESPONSE_RAW_20261017`、`AGENT_MEDIA_BASE64_PRIVATE_20261017`。API key、Bearer、签名 URL 和 `C:\Users\private\agent-output.png` 标记已清除。`privateValues` 被用于错误 message，但 `safeStack` 未使用该值列表。
- 边界：只证明 opt-in `withStack` API 与 ZIP 导出组合可泄漏；未发现当前生产源码调用 `withStack: true`，没有真实模型、供应商或外部 HTTP 请求。该探针不是实际 Windows 安装包 UI 流程。
- 证据：`qa/agent-comprehensive/run-20261016-203617/log04-sensitive-export-probe-source.txt`、`log04-sensitive-export-probe-results.json`；1 项失败，报告错误明确列出 3 个泄漏标记。
- 修复与复测（2026-10-17）：`safeStack` 忽略异常 message 首行，仅保留白名单错误类型和经脱敏栈帧；`DiagnosticsProducer` 将 `privateValues` 传递给错误栈脱敏。合成 completed/failed 事件经实际 producer、诊断服务及 ZIP 导出；扫描 manifest.json、events.jsonl、summary.txt、coverage.json 未发现 prompt、response、media/base64 或假凭据标记。7个 observability 文件54/54通过，Node/Web typecheck通过。证据见 `qa/agent-comprehensive/run-20261017-agent-log04-stack-fix-v1/`。未覆盖真实Agent运行级UI全链路；未发现生产 `withStack:true` 调用点。

## AGT-20261017-007：双损坏快照后缺少用户提示与诊断导出入口

- 状态：已修复并通过当前源码 Windows 解包版整项复测；修复前 v4 失败证据保留。对应 REC-03，暂定 S2。
- 操作：对 Agent QA 项目主快照和备份同时注入不可读内容，启动实际解包版，短时观察首页 DOM 变化并点击该项目；检查首页可见操作与诊断导出按钮。
- 预期：打开失败时向用户显示明确恢复/损坏提示，并能导出隔离诊断包；保存必须拒绝空图覆盖。
- 实际：首页仍列出项目；点击打开后显示“无法打开”提示和“导出诊断包”入口。`project.open.failed` 只记录安全阶段/原因码和项目标识；诊断 ZIP 实际导出并包含打开失败事件，四个预期 ZIP 文件齐全，扫描未发现损坏正文或绝对路径。异步/同步空图保存均以 `SAVE_FAILED` 拒绝，原损坏快照哈希不变。
- 边界：实际产物为 Windows 解包版，隔离 `CANVAS_DATA_DIR`；仅对 Agent QA 项目验证共享保存恢复流程。无模型、供应商、命令或外部HTTP请求。没有声称数据被覆盖或已有ZIP泄漏。
- 证据：修复前 `qa/agent-comprehensive/run-20261016-203617/packaged-rec03-corrupt-snapshots-v4-results.json`；修复后 `qa/agent-comprehensive/run-20261017-rec03-recovery-ui-v2/rec03-recovery-ui-results.json`、首页/打开截图、实际诊断 ZIP、诊断 JSONL 与 SHA-256 manifest。
- 修复：主进程对项目记录仍存在但快照/备份不可读的打开失败写入安全 `project.open.failed` 事件；渲染层回到首页后保留可访问的错误说明和诊断 ZIP 导出操作，按失败时间限定导出范围。诊断 ZIP 导出先 flush 已接收但尚未落盘的诊断事件。
- 回归：`test/observability/diagnostics-storage.test.ts` 与 `test/observability/schema.test.ts` 共28/28通过；Node/Web typecheck、构建和Windows x64解包版构建通过。实际打包UI打开失败提示、导出按钮、ZIP文件、快照保全、保存拒绝和脱敏检查均通过。

## AGT-20261017-008：Agent 配置边界可经项目保存 IPC 绕过

- 状态：初测通过实际 `project.ipc` handler 和真实 `projects.repo` 复现；AGT-20261017-008 已修复并经Electron ABI运行时真实 repository回归通过；对应 CFG-04。
- 方法：创建临时项目目录和内存 SQLite，通过 `IPC.project.save` 直接提交 Agent 配置，随后用正式 `openProject` 重新读取，并用 `AgentNodeConfigSchema` 判定保存内容是否合法。
- 预期：`maxSteps=0/65` 与 `maxParallelTasks=0/5` 应在保存 IPC 被拒绝且不写入；合法边界 `maxSteps=1/64`、`maxParallelTasks=1/4` 应正常保存并重开。
- 初测实际：四个合法边界均保存且通过 schema；四个越界值也全部收到 `{ok:true,data:{graphVersion:1}}`，非法配置经重开仍留在 `project.json`，schema 判定全部拒绝。UI边界子例通过但未覆盖主进程保存路径。
- 边界：本探针只覆盖项目保存 IPC 与 Agent 数值边界，不声称越界配置已执行 Agent；真实模型、供应商与外部 HTTP 请求均为 0。影响范围限于能调用此 renderer IPC 保存项目图的路径。
- 修复：异步项目保存、关窗同步保存和恢复副本保存IPC在调用repository前使用 `AgentNodeConfigSchema` 校验图数据或tldraw snapshot中的Agent节点。错误以 `INVALID_AGENT_CONFIG` 返回，诊断事件记录受限phase和稳定code，不带配置正文。
- 修复后复测：真实临时SQLite和真实repository的8个边界结果全部符合要求：0/65与0/5被拒绝、未写节点、版本仍为0；1/64与1/4成功保存重开、版本为1。配套IPC事件/schema回归通过。证据：`qa/agent-comprehensive/run-20261017-cfg04-cfg06-current-v1/cfg04-focused-tests-electron-runtime.log`、`test/project-save-agent-config-persistence-ipc.test.ts`、`test/project-save-agent-config-ipc.test.ts`、`test/observability/schema.test.ts`、打包构建与CFG-06三配置结果。

## AGT-20261017-009：项目/画布重复挂载后监听器与节点计数累积

- 状态：已解决。tldraw 4.5.12 exact-version patch 修复了 FocusManager body handler identity bug；加入稳定预热后，PER-04正式监测通过，未再观察到监听器、DOM或活动interval随监测轮次增长。旧失败运行与一次性初始化跃升继续保留为历史诊断证据。严重度S2（资源清理/长时间交互稳定性）。
- 方法：早期版本先执行一次预热画布重挂载后建立基线；同一renderer进行30次实际协作面板打开/关闭，并每5轮关闭项目、卸载画布再重新打开，共6轮；每个采样点用CDP `Performance.getMetrics` 采样 `JSEventListeners`、`Nodes`、JS heap、Renderer工作集和DOM，并通过页面级 `setInterval/clearInterval` 包装统计活动interval。最终复测为覆盖一次性初始化，基线前增加2次未计入正式轮次的画布重挂载、3次面板开关和2秒静置；31个采样点前均调用CDP `HeapProfiler.collectGarbage`。结束后启动新Electron进程重开项目。
- 预期：无随轮次增长的重复监听或轮询；项目关闭后不遗留 Agent 业务任务。
- 历史实际失败：强制GC的早期同renderer复测（webContentsId=1、PID=32712）中，`JSEventListeners`从598增至1762（+1,164，+194.6%），超过当时容差线150；CDP `Nodes`从802增至2765。浏览器DOM查询数保持309。cycle 0/5/10/15/20/25/30监听器计数依次为598/787/982/1177/1372/1567/1762；活动 `setInterval` 数3→3，任务/命令/资源队列均为0，新进程重开无重放。随后每轮强制GC与来源审计确认旧 FocusManager body handler 解绑身份不匹配并已用依赖patch修复；剩余监听器跃升在单次预热基线下只出现在第一个监测期重挂载，后续监测重挂载保持平台值。
- 判定边界：`JSEventListeners` 和 CDP `Nodes` 是聚合指标，尚未识别具体监听器类型、注册目标或生产代码调用点；增长可在强制GC后重现，说明不是单纯等待GC即可消失，但仍需源码/对象归属分析后才能定位修复点。`setInterval` hook只统计安装后通过页面 `window.setInterval` 注册的interval，不覆盖`setTimeout`递归轮询或安装前捕获的函数引用。DOM `getElementsByTagName('*')`计数稳定不能解释CDP节点计数增长。
- 验收阈值：30轮后监听器净增长超过基线25%且至少100个时失败；强制GC轮的容差线150，实际增长1,164。容差用于吸收CDP计数抖动，原方案仍要求无随轮次增长。
- 复现命令（强制GC版）：`$env:CANVAS_AGENT_PANEL_CHURN_FORCE_GC='1'; $env:CANVAS_AGENT_EVIDENCE_DIR='qa/agent-comprehensive/run-20261017-per04-panel-churn-gc-v11/desktop'; npm run test:agent-flow-panel-churn`。命令按监听器验收失败返回非零，但两进程检查均完成；原始无GC版继续保留在v10目录。
- 证据：强制GC结果位于 `qa/agent-comprehensive/run-20261017-per04-panel-churn-gc-v11/desktop/execute-report.json`、`reopen-report.json`、`panel-churn-samples.jsonl`、`results.json`、`panel-churn-start.png`、`panel-churn-end.png`。基线归一后无GC结果见 `run-20261017-per04-panel-churn-v10/desktop/`；更早探索运行 v6/v7 只作为重复趋势参考。
- 修复后复测（2026-10-18，`run-20261018-per04-stable-warmup-v1`）：先前一次预热后，首个监测期重挂载产生一次性+187/+193跳升；其后5次重挂载及30轮结束均保持平台值。为将该一次性初始化纳入基线，本轮增加2次未计入正式轮次的预热画布重挂载、3次面板开关及2秒静置，然后执行原有30次面板开关、6次正式画布重挂载和31个强制GC样本。`JSEventListeners` 783→783（+0，阈值196），CDP `Nodes` 1096→1100（+4），DOM查询数309→309，活动interval 3→3；任务、命令、模型与fixture请求均为0。`npm run build`通过，定向桌面测试退出码0；第二进程重开、Agent shape持久化且无重放。执行/重开报告、逐轮样本、截图和hash见 `qa/agent-panel-churn-per04-stable-warmup-v1/desktop/`。
- 根因归因（2026-10-17）：每样本强制 GC 的隔离复测将 `document.body` 上每个画布实例的 `keydown` / `mousedown` 监听器分别追到 `tldraw` 4.5.12 `FocusManager` 构造函数。构造时使用 `this.handleKeyDown.bind(this)` / `this.handleMouseDown.bind(this)` 注册；`dispose()` 又重新 `.bind(this)` 后移除，函数身份不同，故无法解除。6 次项目/画布重挂载后，审计仍有6个body keydown和6个body mousedown回调；React非委托image/error/load等根容器监听也随实例增加。之后加入exact-version依赖patch，保留并复用绑定回调；旧归因复测记录保留在对应运行目录。
- 新归因证据：`qa/agent-panel-churn-per04-attribution-v2/desktop/execution-manifest.json`、`execute-report.json`、`panel-churn-samples.jsonl`。旧v11/v10样本仍作为原始增长证据保留。
- 堆快照复核（2026-10-17T16:46:32Z，run-20261018-per04-heap-v4）：30个弱引用目标均出现在快照中；旧Editor的示例路径经过Window监听器审计表中的`onKey`、`onPointerUp`、`onTaskUpdate`闭包。相关产品effect源码有成对的removeEventListener调用，因此真实卸载时为何仍保留尚未解释，不能据调用点直接断言根因。旧DOM分析路径经过测试探针`activeByTarget` WeakMap；离线分析器将V8 WeakMap ephemeron内部边当作强边遍历，此类DOM路径不作为强引用证明。主判据仍失败（596→1555，+959，阈值149），interval 3→3、第二进程重开通过。堆快照约63MB及retainer结果见`qa/agent-comprehensive/run-20261018-per04-heap-v4/desktop/`。
- 稳态预热复测最终判定：前述heap快照诊断仅代表旧的单次预热失败运行；当前正式监测基线为783，六次画布卸载/重挂载及30次面板循环后计数仍为783。最近两个旧Editor在样本时点仍被弱引用观察到，但前四个已回收且计数没有逐轮增长；本轮没有证明这些近期对象在更长时间后仍然保留。Renderer诊断同时记录 `Failed to fetch` 与图像解码错误文本，但探针未保存来源目标/调用栈，不能据此认定与PER-04相关。现按通过的PER-04验收关闭此缺陷，原堆快照作为边界诊断证据保留。

## AGT-20261017-010：Agent 多成果输出集合在画布输出物化阶段失败

- 状态：已修复并通过当前源码 Electron 双进程桌面复测；修复前的隔离桌面复现保留为历史证据。暂定严重度 S1，对应 AST-05。
- 位置：`src/renderer/src/engine/executor.ts` 的 Agent `artifactOutputPorts` 物化分支，以及 `src/renderer/src/nodes/nodeValues.ts` 对失败 run 的输出静音规则。
- 前置：隔离画布中有一个 Agent、两个授权 processor 和一个普通 JSON 节点；源文本连到 Agent/processor 输入；Agent `out-json` 连到 JSON 节点 `in-json`。本地确定性模型要求依次执行两个 processor，并把两个 committed 回执作为最终输出。
- 实际执行事实：Agent runtime 为 `completed`，决策数3、工具数2；`meta.nodeResult` 保留 `flow.agent-output-set`，内有两个 `assetKind=text` 固定引用，顺序分别来自 `shape:ast05-first`、`shape:ast05-second`，versionId 不同。两个 processor 都有成功的 committed 回执。
- 失败表现：公共 Agent executor 在 `output` 阶段将 Agent 节点 `exec` 与 `nodeRun` 标记为 `failed`，诊断错误码为 `INPUT_INVALID`，并返回 `AST05_AGENT_OUTPUT_MATERIALIZATION_FAILED`。同一运行随后尝试普通 JSON 节点，结果也是 failed，正文仍为初始 `{}`；第二进程重开尚未执行。
- 根因判断：现有 Agent artifact materializer 对每个 `artifactOutputPorts` packet 遍历 `result.refs`，把单个固定引用对应的值与完整 packet.value 比较。多成果投影的 packet.value 是包含所有 refs 的 versioned JSON aggregate，不等于任何单项固定资产值，因此匹配不到并进入输出失败路径。任务记录仍保留完整固定引用，但 `projectNodeOutputs` 会静音非 success run，所以下游不能消费。该根因根据复现数据和当前源码路径推断；尚未修复验证。
- 复现：`node scripts/test-agent-flow-desktop.cjs --agent-output-set`。确认版 `run-20261017-ast05-output-set-desktop-confirm-v1/v2/v3` 均在执行阶段失败；v2/v3 另尝试普通 JSON 下游，仍失败。最终确认使用本地fixture模型请求5次（能力探测2、决策3）、processor执行2次；真实供应商/付费/外部HTTP均为0。
- 证据：`qa/agent-comprehensive/run-20261017-ast05-output-set-desktop-confirm-v3/execution-manifest.json`、`ast05-failure-summary.json`、`ast05-agent-execution-failure.json`、`execute-report.json`、`failure-reasons.json`、`diagnostics/`。源码及build hash记录在 manifest 中。
- 修复与复测（2026-10-17）：executor 将输出集合与任务固定引用逐项核对，按项目读取所有不可变版本并重算共享投影，校验引用身份和资产类型后再分别物化。双进程桌面验收中两个授权processor的固定成果按序到达Agent out-json，普通JSON下游读取完整集合；新进程恢复后两节点运行事实与正文不变且模型不重放。输出集合测试12/12、`test/agent-flow` 28文件545/545、Node/Web typecheck、ESLint与构建通过。证据见 `qa/agent-comprehensive/run-20261017-ast05-output-set-fix-v3/`。真实供应商/付费/外部HTTP请求为0。

## 当前源码 Agent 总回归复核（2026-10-17）

39个Agent相关测试文件 / 688项中685通过、3失败；未改业务代码。SEC-02 的原型键命令再次被IPC接受、持久化并派发，缺陷 AGT-20261016-003 仍在；MED-04 的 schema 不一致结束时间和保存审核守卫负例均未拒绝，缺陷 AGT-20261016-001 仍在。完整输出：qa/agent-comprehensive/run-20261017-agent-flow-unit-regression-v2/vitest.log，执行清单：qa/agent-comprehensive/run-20261017-agent-flow-unit-regression-v2/execution-manifest.json。

- 复测更新（2026-10-17T12:03:36Z）：依赖 patch `@tldraw/editor@4.5.12` 后，原 `FocusManager` 不匹配的 bound handler 已修复，旧画布 `body keydown/mousedown` 不再逐轮累积。PER-04 仍失败（596→1555，+959，阈值149）；每次画布重挂载后，5组 detached `.node-standard-action-bar` 及配套 Agent DOM 目标仍被保留并带有 React 事件监听器。活动interval 3→3、重开通过、业务/网络副作用为0。当前依赖 patch 只修复了一个已确认根因；detached subtree 的保留来源仍未查明，缺陷保持开放。新证据及hash见 `qa/agent-panel-churn-per04-fixed-v3/desktop/execution-manifest.json`。

- 诊断范围更正（2026-10-17）：v4/v5 的旧Editor与DOM弱引用探针实际只覆盖预热卸载，不覆盖PER-04正式六轮卸载循环；因此不能用其数据排除正式循环中的Editor/画布根保留。v4/v5原始PER-04监听器指标仍有效，弱引用结论不计入根因判断。修正后的v6将探针移入实际循环，见下一条记录。
- 复测更新（2026-10-17T12:20:05Z，run-20261017-agent-per04-dependency-patch-v6）：正式循环6/6次卸载均观察到 `editorStore` 清空，但第30轮强制GC后6/6旧Editor、`.canvas-host`、tldraw容器、节点卡片、action bar及文本框仍被弱引用观察到存活。监听器指标仍596→1555（+959，阈值149），interval 3→3；第二进程重开通过，业务及网络副作用为0。已确认旧Editor与画布DOM子树跨卸载保留，具体强引用者仍未定位；PER-04继续失败，缺陷保持开放。执行manifest、逐轮样本及hash见 `qa/agent-panel-churn-per04-fixed-v6/desktop/`。




## AGT-20261018-011：禁用决策模型在工作流准入之后才拒绝

- 状态：已修复并通过当前源码 Windows x64 解包版复测；严重度暂定S2，对应CFG-03。CFG-03主用例仍未完成。
- 复现：当前源码Windows x64解包包、隔离SQLite、本地无密钥模型连接（127.0.0.1:1），引用一个 `enabled=0` 且声明 `text.generate` 的模型；Agent拥有合法 `node.execute@1` 和授权processor目标。
- 修复前失败事实：UI明确显示“所选文本模型不可用”，但点击后产生5次 `project.save`（graphVersion 40→45）、`workflow.started`、`workflow.task_queued`、`workflow.task_admitted`、`node.started` 和 `node.failed`；`flow_agent_tasks` 写入 `blocked/AGENT_MODEL_UNAVAILABLE` 记录。模型生成、真实供应商及renderer外部HTTP均为0。应用关闭时另同步保存至graphVersion 46。该运行保留为历史证据。
- 修复：新增只读 `preflightAgentDecisionModels`，在保存画布或启动工作流前验证模型存在、启用、声明 `text.generate`，并验证连接启用且协议受支持；接入Agent卡片手动启动、全图/子图运行和节点测试入口。缺模型仍先由既有任务状态检查处理，允许符合条件的 waiting/blocked 任务继续。
- 修复后复测：当前源码 Windows x64 解包包中，`enabled=0` 且有 `text.generate` 的模型，以及 `enabled=1` 但只有 `image.generate` 的模型，均在点击阶段显示明确不可用提示；点击期间没有项目保存、工作流/节点事件、Agent任务、命令、模型请求或renderer外部HTTP，`exec`保持idle。关窗阶段出现的项目同步保存与点击事件分离；关窗后SQLite任务、命令数均为0，Agent仍idle且没有 `nodeRun`。全量 `npm run verify`（run-mWEeO7）通过，手动运行及executor事件定向25/25通过。
- 验收边界：图像、采样视频和音频审核缺少相应输入能力的正式包子场景均已通过；模型声明接受image/audio但能力验证为pending/failed、图像和音画审核未选模型，以及审核模型禁用、连接禁用或连接协议不受支持的正式包子场景也通过。Agent结构化工具调用能力不足场景已由AGT-20261018-012记录并经v3正式包修复后通过。音画审核只具备image或只具备audio的两种交叉拒绝子场景已通过；人工审核正常执行入口及其余多模态组合尚未覆盖，CFG-03整项仍未完成。该缺陷修复及复测没有使用真实模型、供应商或付费调用。
- 证据：修复前 `qa/agent-comprehensive/run-20261018-cfg03-disabled-model-final-v1/`；修复后 `qa/agent-comprehensive/run-20261018-cfg03-disabled-model-preflight-v1/execution-manifest.json` 与 `qa/agent-comprehensive/run-20261018-cfg03-wrong-model-capability-v1/execution-manifest.json`。

## AGT-20261018-012：Agent 工具调用能力失败时已准入并写入任务

- 状态：已修复并关闭；严重度 S2，对应 CFG-03。v2失败基线保留，v3正式包复测通过。
- 复现：Windows x64 `win-unpacked` 包；隔离项目中配置 `enabled=1` 且声明 `text.generate` 的模型、启用的 `openai-compatible` 连接、合法 `node.execute@1` 和授权本地 processor。模型服务只绑定 `127.0.0.1`，被要求强制调用 `probe_echo` 时返回文本、不返回 `tool_calls`。
- v2修复前结果：Agent卡片按钮可用。点击期间先将项目从graphVersion 40保存到42，之后产生 `workflow.started`、`workflow.task_queued`、`workflow.task_admitted`、`node.started`；主进程发出1次本地 `agent.capability.probe` 请求并记录 `model.request.started/first_chunk/failed`。随后以 `AGENT_MODEL_TOOL_UNVERIFIED` 拒绝。退出后SQLite有1条 `blocked / AGENT_MODEL_TOOL_UNVERIFIED` Agent任务、0条命令，Agent节点显示failed；界面给出可定位提示。点击期间的严格副作用前拒绝判据失败。
- 网络边界：仅本机 `127.0.0.1` fixture 收到1次 POST；真实供应商/付费请求=0，renderer外部HTTP=0。
- 修复：模型目录提供单独的Agent工具调用验证；用户确认潜在供应商请求后执行有界合成工具调用及结果往返探测，并将证明与模型/连接能力修订号绑定持久化。配置变化会使旧证明失效。启动、继续、建图/审核相关入口在保存和工作流准入前拒绝未验证或过期证明；不在启动时探测。
- 修复后复测：v3 Windows x64 `win-unpacked`包中点击“启动任务”后提示所选文本模型未验证Agent工具调用能力。点击期间project.save、workflow/node/task、model.request均为0，本机fixture请求0；关闭后Agent任务/命令均0，节点idle且无nodeRun，SQLite `integrity_check=ok`，应用退出码0。退出阶段的一次graphVersion 40→41保存单独记录。真实供应商、付费调用、renderer外部HTTP均为0。
- 证据：修复前基线为 `qa/agent-comprehensive/run-20261018-cfg03-no-tool-calling-v2/execution-manifest.json`；修复后正式包、结果、截图、隔离SQLite、诊断及逐文件哈希见 `qa/agent-comprehensive/run-20261018-cfg03-no-tool-calling-v3/execution-manifest.json`。全量自动门禁run-5FkoS5退出码0，189个Vitest文件、2,352项通过、1项跳过。
- 剩余范围：此缺陷关闭不等于CFG-03主用例完成；人工审核正常执行入口、其余多模态组合、真实供应商条件及人工验收仍待覆盖。
