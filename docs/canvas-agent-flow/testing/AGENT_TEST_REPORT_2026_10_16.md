# Agent 专项测试执行进展（尚未完成验收）

更新时间：2026-10-18 14:39 UTC；当前工作树最终代码全量 npm run verify 于2026-10-18 12:58:41–13:13:24 UTC 通过（run-4JSsYX，退出码0）：lint、Node/Web/model 类型检查、190个 Vitest 文件/2,362项通过/1项跳过、model-runtime 2/2、日志门禁、优化 UI 浏览器门禁、生产构建及全部 Agent/Electron 桌面 fixture 均通过。构建有既有 Vite 提示：stores/app.ts 同时静态与动态导入。144项主用例统计仍为通过110（76.4%）、失败0、未执行21、暂缓12、阻塞1；P0为通过94、失败0、未执行4、暂缓5、阻塞1。执行台账目前678条记录，包含补充子场景、复测和历史尝试，不等于678个独立主用例。

2026-10-18 11:49 UTC REL-02 M01当前源码 Windows x64正式包正向子场景通过：公开模型目录先用本机loopback fixture完成Agent工具调用验证（probe_echo/probe_done两次请求）；随后从Agent卡片启动任务，经两次Agent模型决策只执行一个获授权的本地文本处理节点，提交固定输出“M01已整理：M01 固定输入：保留证据中的关键事实。”，任务完成。全新第二进程重开后同一task与成果仍在，且没有模型请求重放；两进程退出码0，外部请求/真实供应商/付费请求均为0。测试只证明确定性fixture下的正式包任务和恢复路径，不评价真实模型质量，也不覆盖M03/M06/M08；REL-02主用例仍未完成。1–7次尝试中的夹具/自动化修正均保留在attempt-history.json，不按产品失败计。证据见 `qa/agent-comprehensive/run-20261018-rel02-m01-current-package-v1/execution-manifest.json`。

2026-10-18 11:02 UTC 追加 CFG-03 已验证音频能力下的正式包完整音频审核正向子场景：公开审核入口、完整归一化 WAV 字节、完整音频证据和双进程持久化均通过；只证明本机确定性 fixture 的请求/回执链路，不评估真实模型音质判断。CFG-03 主用例仍未完成，144 项主用例与 P0 统计不变。

2026-10-18 11:08 UTC 再追加 CFG-03 正式包音画审核正向子场景：完整固定 MP4 的时间戳摘要、4张 JPEG 抽样帧和完整归一化音轨均与 `audioVideoEvidence` 逐项匹配，决议与固定视频版本跨进程持久化。该结果证明确定性 fixture 下的请求/回执与证据链，不评价真实模型的视听判断；CFG-03 主用例及144项/P0统计仍不变。

2026-10-18 11:11 UTC 追加 CFG-03 `sampled-video` 正向子场景：已验证 image 能力模型只接收4张带时间戳的JPEG样本，不接收音频；`four-frames-v1`摘要、固定视频哈希、决定和版本重开后保持。该补测仍不评价真实视觉质量，不改变主用例及144项/P0统计。

源码基线 b96faf49a484256bbbf8ee7f1d9ccbdd814810e6；runId run-20261016-203617。2026-10-17 HUM-07复测在本地工作树修复了固定资产回执在暂停后复用的问题，并调整隔离桌面夹具顺序；本地构建与测试通过，未生成发行包。各历史运行仍以各自manifest中的源码/产物hash为准。三轮讨论与重开事实检查重新从当前源码构建运行，其源/产物hash见collaboration-harness-manifest.json；不是既有安装目录。环境、锁文件摘要见manifest.json。

## 已执行结果

- Agent 定向单测：26 文件 / 283 通过。
- 本轮追加 Agent 恢复/诊断专项复测：3 个文件 / 29 项通过（跨存储进程强退恢复 12、诊断存储/ZIP 15、Agent 配置诊断 2）；作为新增分项证据，不与既有断言重复累计。报告见 agent-recovery-diagnostics-results.json。
- CFG-01 节点注册/打包UI验收通过：注册契约断言5/5通过；Windows解包版产品中实际创建Agent、AI审核、状态机，逐一检查默认配置及输入输出面板，保存配置并退出后重开。Agent任务目标、maxSteps=1、固定Skill；审核默认maxReworks=3；状态机初始draft、5个声明阶段及空转换均留存，out-state端口未连接。证据见cfg01-node-registration-results.json与packaged-agent-node-matrix-results.json；本轮未触发执行。
- CFG-03主用例仍未完成。工具调用能力不足子场景已由正式包复测为启动前拒绝并关闭AGT-20261018-012；模型管理界面的显式正向验证子场景也已由loopback正式包复测通过。其他已通过的能力不足前置场景包括：Agent无模型、禁用模型或缺少 `text.generate`；图像/采样视频审核缺少图像输入能力；音频审核缺少音频输入能力；以及模型声明接受image/audio但验证状态分别为pending/failed。图像审核和音画审核两个未选模型入口也通过；另有审核模型禁用、审核连接禁用、连接启用但协议不受支持三个配置入口通过，均在项目保存、工作流/节点准入及模型请求前拒绝。音画审核只配置一种已验证媒体能力的两种拒绝组合也已通过；人工审核正常执行入口、其余模态组合及真实供应商条件尚未覆盖。
- CFG-02 通过：当前源码Windows解包包中搭建/主控/专业 × 人机协作/自主六种组合均保存成功，职责控件与卡片摘要匹配，退出重开后配置保留；Electron ABI 140 下当前源码4个相关测试文件162/162通过，覆盖搭建预览/显式提交、主控派发与专业节点范围、专业Agent工具权限、协作等待/继续及自主等待拒绝、未知职责schema拒绝。Agent任务/模型/供应商/外部HTTP请求均为0。v1脚本未显式设置独立Chromium profile，单独保留且不计通过；v2使用独立 `electron-profile` 和QA项目数据目录通过。证据见 `qa/agent-comprehensive/run-20261017-cfg02-role-mode-current-package-v2/`。
- CFG-04 初测发现 project.save IPC 可接受 `maxSteps=0/65` 与 `maxParallelTasks=0/5` 并推进版本；AGT-20261017-008 已修复。当前源码中异步/同步保存和恢复副本入口均由主进程 schema 拦截。Electron ABI 测试运行时用真实 `projects.repo` 重跑8个数值边界：四个越界值均以 `INVALID_AGENT_CONFIG` 拒绝、未写节点且graphVersion保持0；合法1/64、1/4均保存并重开、graphVersion=1。另有9项 IPC 入口回归和 Windows 解包版CFG-06三配置复测共同验证配置检查和安全事件；无模型/供应商/外部HTTP请求。CFG-04现登记通过。
- CFG-06 初测在非法JSON、未知键、旧schema配置下打开Agent详情时触发“应用未能正常启动 / Cannot read properties of undefined (reading some)”；AGT-20261016-002 已修复。当前源码Windows解包版逐一打开三种损坏配置，画布、详情和设置保持可见，明确显示配置无效及执行阻止说明；“恢复默认配置”入口可达，实际恢复并保存后，project graph与tldraw snapshot中的配置均通过schema检查。三进程干净退出；模型/供应商/外部HTTP请求均为0。
- CFG-05 早期允许节点失效引用子例通过：删除授权文本节点后创建同名新节点，Agent仍保留旧nodeId且新nodeId未获授权。该记录只覆盖当时的子例；整项组合结论已由本报告末尾当前包验收升级通过。
- CFG-05 早期AI审核失效引用子例通过：审核来源、门禁与责任节点保留失效旧ID，无效关系保存被拒绝，清理后可保存。此处为先前分项结果；整项结论以本报告末尾当前包组合验收为准。
- CFG-07 浏览器指针子例通过：Agent、AI审核、状态机卡片的非控件区域均能单击选中并拖动；可编辑字段单击不进入编辑，拖动卡片有效，双击可编辑并用Esc退出。逐类结果为Agent 2区域/1字段、审核5区域/1字段、状态机4区域/0字段。整项仍未执行，未覆盖Tab遍历、按钮/下拉交互、中文输入法及桌面手工确认。
- REC-03 已修复并通过当前源码Windows解包版整项复测：双损坏快照的项目可见错误提示；首页诊断包按钮可达并实际导出 ZIP，包含安全的 `project.open.failed` 诊断且无损坏正文/绝对路径；异步/同步空图保存均被拒绝，原快照哈希不变。真实供应商/模型/命令/外部HTTP请求均为0；AGT-20261017-007已关闭。
- REC-09 早期桌面恢复子场景通过：两进程Agent recovery fixture恢复协调任务，未重放模型请求；当时尚未组合关窗冲突与工作台并发修改。组合场景现已完成，见本报告末尾最新REC-09记录。
- REC-10 中断专项通过：独立60秒目标runner在首个检查点后用真实终端Ctrl+C，记录interrupted、目标未达且finally清理完成；另一轮在检查点后强杀准确父进程，running/cleanup=false/目标未达快照如实保留，审计确认worker退出后仅手动清理归属已核验的临时目录。两轮真实模型/供应商/外部HTTP请求均为0；证据见 rec10-controlled-tty-results.json 与 rec10-parent-termination-v2-results.json。此项短时隔离测试不替代90分钟运行。
- RUN-06/HUM-07专项的8个共享断言复跑通过：模型超时/迟到回包不改终态；主控等待时暂停不暗中派发、明确继续不重放或退预算，停止后保持占用并拒绝伪造/外域派发。断言按唯一项去重。RUN-06已于2026-10-17由组合运行时/供应商故障注入与双进程Electron桌面证据升级通过；HUM-07 v4曾发现 `ASSET_SUBMISSION_CONFLICT`，修复后v7双进程Electron的暂停、明确继续、停止与新进程重开均通过。RUN-08和COO-08已由后续补测完成并升级通过。
- COO-08 范围矩阵新增3个集成断言通过：同项目重叠主控在模型调用前以 FLOW_CONTROL_OCCUPIED 拒绝且首个主控继续等待；同名节点在持久化占用表中按项目隔离；派发到已由专业节点占用的处理器或项目外节点时，在创建子任务/命令前拒绝。协调器整文件43/43通过；跨项目同名节点现已通过双项目SQLite/CoordinatorHost集成子例（两个项目分别保持waiting且scope owner独立）；仍未覆盖真实跨项目桌面主控入口，COO-08整项保持部分完成。初次夹具因首个主控配置为自主模式返回 HUMAN_WAIT_DENIED 的记录保留在 coo08-overlap-initial-fixture-failure.json。
- 补齐 3 个此前未纳入整批回归的 Agent 依赖测试文件：视频任务恢复57/57、项目保存故障16/16、项目保存IPC 9/9通过；它们覆盖原任务身份/恢复不重发、媒体固定引用、持久保存阶段故障和失败诊断。结果见 full-agent-regression-agent-scope-33-results.json。
- 另行执行 C0 确定性专项：隔离 Electron 两进程 pause/resume 均通过，checkpoint 存在且工具副作用总数仍为1；C0 单测16/16通过。C0 单测本已包含在下方整批回归，不重复增加唯一断言；Electron C0 入口是隔离试验，不启动正式产品，不能替代完整产品 UI 验收。
- REL-01 通过：commit b96faf49a484256bbbf8ee7f1d9ccbdd814810e6、构建输入 dirty-diff SHA-256 0917385D7A725698C72AA9FA1669AD86BB6438BB09E95B5EBFAFE7B3DB94E288、Windows x64 Electron 39.8.10 解包产物及真实进程路径均已绑定；npm run build 与 electron-builder --dir 退出0，exe SHA-256 2E275ED2B62EB77A6579136813AE42FC362226469D99E54D7986E447DFA8ED61。
- REL-02 主用例仍未完成：正式 Windows `win-unpacked` 包 v1.0.0 的 M01 Agent执行/恢复、M03 Builder提案/显式提交/重开、M06审核拒绝/一次有界返工/通过/重开均已有补充子场景证据；M08正式包媒体往返及项目导入媒体故障/显式重试补充子场景，另有 `write-tmp`、`rotate-bak`、`update-db`、`flush-tmp`、`promote-tmp` 故障/显式重试/第二进程UI重开子场景已通过；当前源码保存存储与IPC诊断定向测试25/25通过，另有36轮共享保存/恢复fixture通过。M08“命令已提交、Agent成果未呈现”强退/重开场景现已补齐单一已提交本地命令的事实核对与显式补呈现：新包在进程B恢复原task后保持不自动完成，核对显示“补呈现已提交成果”，用户点击后原task完成、同一回执输出写入Agent节点；模型请求数保持4、命令仍为1条，数据库完整性ok。更早的“仍 blocked”运行保留为缺陷发现记录。真实供应商异步生成已接受但无回执、由模型选择并端到端呈现多个成果的语义以及完整M08/REL-02仍未验收。多个已提交命令的歧义恢复现已由下方新增包级子场景验证为fail-closed。REL-02主用例仍记“未执行”，整体统计不变。此前打包画布检查记录tldraw静态CDN资源被应用CSP阻止；此项与供应商API请求分开统计。
- REL-02 M08 显式恢复补充子场景通过：当前源码构建的 Windows x64 Electron 39.8.10 `win-unpacked` 包（v1.0.0，exe SHA-256 `2e275ed2…dfa8ed61`；应用主bundle SHA-256 `fbde0959…09706b`）中，进程A在完成决策请求被挂起时被真实 `SIGKILL`；进程B重开原task后保留单条 committed 命令，未自动重放。公开“核对执行事实”先返回 `FLOW_ASSET_PROJECTION_MISSING / canRestore=true`，随后显式点击“补呈现已提交成果”令原task成为 `completed`，节点输出引用与处理器回执一致。重开与恢复后模型请求数均为4，命令数为1；真实供应商/付费/外部HTTP为0。两session共111条诊断行有效、无重复eventId、测试标记/固定输入/输出/本地fixture URL/隔离路径均未进入事件；重开进程的 `agent.desktop` 开始/终态配对通过，SQLite `integrity_check=ok`。命令台账定向回归69/69、Node类型检查和日志旁路门禁通过；单一命令的桌面子场景不代表真实供应商已接受异步生成且无回执，多个committed输出模糊选择由单测验证为fail-closed。完整证据与产物hash见 `qa/agent-comprehensive/run-20261018-rel02-m08-explicit-restore-v1/`。此子场景不升级REL-02主用例状态。
- REL-02 M01 Agent执行/恢复补充子场景通过：当前源码Electron夹具完成启动、Skill渐进加载、两次公共处理回执、协作等待及新进程继续；恢复未重放已观察工具，固定输入、成果发布及诊断脱敏通过。两阶段模型fixture请求共10次，分别生成两个诊断sessionId且任务身份一致；真实供应商/付费/外部HTTP均为0。该入口不是正式Windows发行包；M03/M06/M08和发行包M01未验收，REL-02主用例仍未执行。证据见 `qa/agent-comprehensive/run-20261017-rel02-m01-agent-desktop/`。
- REL-02 M03 Agent建图预览/提交补充子场景通过：公开按钮生成流程提案，类型连线和预览布局正确，预览不修改图且需要显式提交；新进程恢复预览后提交完整图，重复提交无重复节点，并运行两个专业Agent产出变换文本。fixture模型请求15次，两个诊断session独立且脱敏通过；未使用正式Windows发行包，REL-02主用例仍未执行。证据见 `qa/agent-comprehensive/run-20261017-rel02-m03-agent-builder/`。
- REL-02 M06 Agent审核/返工补充子场景通过：负面审核正确保留为节点结果并阻断下游，原资产不变；新进程恢复报告，人工明确返工产生新固定版本，第二轮通过后门禁释放，v3会使v2批准失效。fixture模型请求6次，诊断脱敏通过；未使用正式Windows发行包，REL-02主用例仍未执行。证据见 `qa/agent-comprehensive/run-20261017-rel02-m06-agent-review/`。
- BLD-03 预览冲突专项 4/4 通过：source body、Builder 配置、data edge 在预览后变更均拒绝授权且不增加节点；提案中和提交前变更也 fail closed。两进程 Electron 验收另覆盖公开提交、防重复节点、撤销/重做。BLD-03 整项通过。- Agent 共享保存、故障与跨进程恢复：7 文件 / 66 通过。
- 固定资产项目包、网关和诊断集成：3 文件 / 49 通过。
- 方案显式边界补测：最终44项通过；先前35/38项及ASCII夹具修正前的结果均保留，按最终同名断言去重。Agent视频能力矩阵另定向补跑16项、16项通过；该补充结果不重复计入下方去重总数，见agent-video-capabilities-results.json。
- Skill精确依赖、声明资源和新版本绑定新增10项通过；导入异常配置可达性特征测试1项通过（只是复现入口，不能算安全验收通过）。名称筛选跳过的旧测试不重复计入通过。
- 任务/人工确认新增14项、回执与成果新增9项、桌面宿主并发启动新增1项，24项通过。runtime-detailed与runtime-receipt-detailed报告、desktop-concurrent-start-corrected报告保留精确断言。并发夹具初次未保存宿主授予的精确输入版本而进入unknown，已修正夹具；初次失败记录和说明保留，不计为产品缺陷。
- 人工反馈越权3变体、语义修改后旧确认6变体，共9个新增集成断言通过。两个扩展桌面运行先后确认三轮讨论及新进程事实，均通过；后者补查旧任务/Skill、命令/回执哈希及重开后三条讨论记录。旧证据保留，扩展入口无真实供应商请求。
- Builder新增8个子例通过：源正文/Builder配置/数据边变化后拒绝旧预览授权，无新增业务节点；顺序1/4步和并行2/3/4路的预览节点、范围与并行上限准确。该文件合计20项通过，新增子例不代表桌面提交/撤销重做已完整验收，见builder-detailed-results.json。
- 后续Builder重复取消/取消状态恢复通过；初次测试错误要求authorize(discarded)抛错，实际协议返回discarded且renderer拒绝落图，已修正判据并保留原记录。审核门禁字段替换与0/1/10返工次数/重复回执完整证据已审计，REV-03和REV-07登记通过。
- 安全补测：命令10类、Agent9类、资产3类接口对外窗口与子frame来源均拒绝；资产提交/列举/读取的未知项目均返回安全错误且版本不变。新增23个身份与容量schema断言通过：continue/reconcile/restore缺身份拒绝，标识128/129、反馈4096/4097、选择128/129、重复选择与嵌套未知权限字段逐项核对。SEC-04另以Skill未声明资源拒绝、恶意文件请求不触发工具，以及项目媒体目录junction逃逸在资产版本/命令落库前被拒绝作边界证据。仅有对应层的证据，不泛化成全部安全用例通过。
- 媒体边界补测：33项中32通过、1失败；真实媒体守卫另增1个失败负例。原媒体正例复测通过，按唯一断言去重计数。
- 合计 726 个去重后的自动化测试项结果（Vitest test-case results），722 通过，4 失败；这是测试项数量，不是每个测试中的expect调用总数。
- 先前源码Agent定向回归（33个Agent及直接依赖测试文件）：结果在回归完成后写入下方执行摘要；新增的82项共享保存/供应商恢复断言全部通过。失败仍仅对应MED-04两层负例及SEC-02 prototype字段负例。CFG-06整页错误另由浏览器确认，不在此单测数量中。原始退出码非0代表仍有已登记缺陷，不能称门禁通过；此前回归记录均保留。该次结果见full-agent-regression-agent-scope-33-results.json。
- 桌面命令：25 条已结束，25 条退出 0；test:agent-flow-rework 内含自主、协作、人工三条子路径。完整列表和时间见 desktop-results.jsonl。
- 上述原批次以外另有三轮讨论扩展、重开事实扩展两次桌面调用，结果见desktop-three-round-discussion与desktop-discussion-reopen-facts日志；两次均隔离输出，不覆盖原协作报告。它们是参数/证据扩展，不能作为重复覆盖率相加。
- REV-08 审核取消/旧版本专项 4/4 通过：停止后晚到结果不写入、不派发；固定视频字节变化与输入身份冲突均 fail closed。两进程 Electron 验收确认重开后旧 v2 批准不会解除新 v3 gate；REV-08 整项通过。CMD-08 的四个执行入口现已分别覆盖 review-gate 和 unknown 占用，两种状态均在新进程重开后保持；固定输出集合断言也通过。CMD-08 已登记通过；AST-05 多成果输出集合主用例已于2026-10-17修复并通过当前源码双进程桌面复测，详见末尾最新记录。
- REV-05 审核超时专项通过：30 秒后返回取消/超时，晚到 pass 不写入 flow_reviews，gate 仍阻塞；两进程 Electron 审核验收覆盖负面 gate 与显式新版本返工后才放行。REV-05 整项通过。- PAR-07 并行审核恢复子场景通过：一个返工任务未知时 sibling approval 继续；第二进程恢复原任务且不重放 POST，双 gate 放行并执行下游，保留 2 个拒绝/2 个批准资产。模型 fixture 请求25次，模拟供应商POST/download各4次；该早期审核子场景未验证共享队列的强退恢复，主用例状态见末尾最新复测。- BLD-07 两进程桌面验收通过：第一进程生成预览且不改图；第二进程重开后保留预览，公开按钮提交完整图，重复提交无重复节点，撤销恢复基图、重做恢复节点与坐标，并成功执行生成的 Agent flow。FlowBuilderHost/SQLite 集成测试另验证提交状态、节点和边在再次重开后保留，且没有额外模型调用。桌面 fixture 使用合成模型，模型请求 15 次、真实外部 HTTP 请求 0；本用例验收通过。- REV-05 审核超时专项新增 1/1 通过：30秒无响应后返回 AGENT_CANCELLED_OR_TIMED_OUT，迟到的正向裁决未写入 flow_reviews，审核 gate 仍阻断目标节点。使用虚拟时钟和模型桩，不调用供应商；桌面提示/返工入口仍未验收。
- BLD-07 与 REV-05 变更后完整文件回归 41/41 通过：builder 23/23、review 18/18，未筛除其他测试，无失败或跳过。
- CMD-06 Agent 命令恢复组合验收通过：供应商事实 fixture 验证 hard kill 后 admitted receipt 恢复、断连后 unknown、无重复 POST、并发 GET 合并、仅下载一次并提交一个媒体；两进程 Electron 命令验收验证重开后占用阻止执行/发布，已保存 run 协调不重放 effect。所有 HTTP/模型均为 fixture。
- 浏览器命令：9 条已结束，6 条退出 0，3条失败；两次配置矩阵均发现CFG-06，SEC-08补测另发现结果无法拖选复制。配置矩阵每次的11个正常子例通过、3个坏配置子例复现界面错误，不把重复变体计作新覆盖；其他声明/资产、指针、30轮监听器清理、恶意HTML/反馈/长错误文本安全呈现子路径通过。边界见各原始报告。
- 请求计数按阶段提取到 request-counts.json；原始 reports 保留 task/project/asset 等事实。阶段计数可能累计，禁止直接相加；没有查询/审核独立计数的场景保留未知，不能补造为零。

## 144 项台账的判定

144 项原始定义保留，新增 408 条具备显式 caseId 的参数子例。其余既有断言按关键词形成 coverage-index.json 候选关联；只有核对了实际断言、桌面步骤和跨进程事实后才更新整项状态，不把单测通过冒充包含人工、桌面和多个参数的整项通过。

本轮已证实的范围是实际运行断言和桌面夹具报告；尚不能签署 144 项全通过或本地发布验收。

最新整项状态：{"通过":113,"失败":0,"未执行":18,"阻塞（专项条件待定义）":1,"暂缓":12}；P0状态：{"通过":97,"失败":0,"未执行":1,"阻塞（专项条件待定义）":1,"暂缓":5}。REL-02 已在同一最终包上完成 M01/M03/M06/M08 包级冒烟并升级通过（见本报告末尾 2026-10-18 REL-02 收口一节），供应商“已受理但无回执”继续单列依赖。REL-03 已按支持矩阵、旧手动路径、桌面命令/视频 fixture 与正式包 gate/拒绝证据升级通过（见末尾 REL-03 收口一节）。CFG-03 已按收口矩阵升级通过，其依据仍是既有正式包子场景，真实供应商条件继续归 AI 专项。PER-04已有稳定预热通过证据，且当前源码复测 v2 再次通过；v11未预热失败作为历史诊断记录保留。已对齐并登记通过：LOG-03、PER-03、CFG-02/CFG-03/CFG-05、REL-02、REL-03、SKL-02/03/04/05/06/08、RUN-01/02/03/04/05/06/07、HUM-01/02/03/04/05/06/08、REV-01/02/03/04/05/06/07/08、CMD-01/02/03/04/05/06/07/08、MED-01/02/03/04/05/06/08、PAR-01/02/03/04/05/06/07/08、SEC-01/02/03/04/05/06/07/08、BLD-01/02/03/04/05/06/07、COO-01/02/03/04/05/06/07、AST-01/02/03/04/05/06/07/08、REC-01/02/03/04/05/06/07/08/09、LOG-01/02/04/05。新登记项由当前run隔离目录中的两进程桌面报告、并行/审核/返工fixture及Agent回归共同支持；真实供应商请求均为0，供应商语义由确定性fixture模拟。REC-01/02覆盖Agent依赖的共享保存恢复层，不代表安装包UI验收。AST-03复核包含独立修订创建新任务与旧等待确认冲突；MED-05/06请求由确定性fixture模拟。MED-08定向执行审核模型的图像/音频能力、30/31结构边界及供应商模型不支持时的零POST断言，审核IPC拒绝顺序通过源码检查，未调用真实供应商。LOG-01按M01/M04/M06实际桌面JSONL逐条配对，强杀边界单独保留为不可观测/未正常结束事实。LOG-02覆盖异步多媒体与并行分支关联，供应商语义为合成fixture。LOG-05的6项隔离sink失败断言和15项诊断存储断言通过，覆盖Agent执行/审核返工/命令预留/项目保存结果稳定、传输丢弃计数及拒写恢复；当时同一聚焦回归的唯一失败为SEC-02，已由2026-10-17当前源码修复回归清除。COO-03状态机配置/禁用执行及协调任务重开、COO-07控制关系授权和数据边隔离通过72项聚焦回归与C1浏览器证据；状态机未被当作可独立执行引擎。SEC-06以12个决策/返工越权字段变体验证拒绝改写持久模型、凭据和工具绑定，且零工具/命令副作用；建图节点提案不选择provider model。该组使用确定性模型及隔离请求配置，不代表对真实供应商端点的调用测试。SEC-03仅证明确定性fixture下的主机协议防线，不代表真实模型抵抗性；SEC-04结论由固定Skill资源拒绝、恶意本地文件文本请求不触发执行，以及目录junction媒体逃逸拒绝组成，未宣称对任意文件系统API作全面审计。PAR-04四种整批失败没有子任务/工具执行，主控只消耗已发出的决策预算。CFG-06既有缺陷仍未修复；SEC-02/SEC-08对应AGT-20261016-003/004已修复并通过当前源码/浏览器回归；MED-04已于2026-10-17修复并通过桌面复测；LOG-04的opt-in错误栈敏感正文泄漏已修复并通过诊断ZIP成功/失败事件集成复测；正式包实际Agent成功/失败及公开诊断导出全链路已于2026-10-18通过。RUN-04活跃消耗恢复使用正式charge接口注入，另有真实短超时正例，不作长驻性能结论。HUM-08 旧确认隔离通过：模型、工具权限、scope、目标配置、连线、source body 六类变化均拒绝旧确认且不增加预算；两进程协作验收确认旧 task 不变、迟到响应被拒绝、新 revision 显式启动后成功。fixture 模型、无外部 HTTP。其他复合用例即使已有部分断言仍不升级整项通过。复核依据见reviewed-acceptance.json。

- AST-05 补充集成子例通过：混合音频/图片/文本固定引用经 Agent out-json 投影后，接入普通 JSON executor，顺序、版本 ID 与 assetKind 均保留；本测试文件 11/11 通过，模型/供应商/外部HTTP请求均为0。证据单独保存在 `qa/agent-comprehensive/run-20261017-ast05-output-consumer/`，未并入主批次 726 项统计，也不代替真实画布连线、媒体节点 UI 与桌面验收；AST-05 整项保持未完成。

- AST-01 补充集成子例通过：AgentSdkModel 按任务 directInputs 精确解析既有 v1，合成模型上下文带入 v1 固定正文且不包含新 v2；1 个定向子例通过，模型为本地合成 fixture（SDK请求=1），真实供应商与外部HTTP请求均为0。没有执行桌面版本切换/重开步骤，AST-01 整项继续未完成。证据位于 `qa/agent-comprehensive/run-20261017-ast01-fixed-input/`。

- AST-01/AST-05 补测后的相关文件回归通过：Agent runtime、资产存储、输出集合 3 个测试文件共 103/103；结果见 `qa/agent-comprehensive/run-20261017-agent-focused-regression/`。回归结果独立留存，未并入主批次 726 项去重统计。

## 2026-10-17 补充测试

- CMD-08 review-gate 桌面子场景通过：隔离 Electron 两进程从 Agent 标题运行、底部启动、多选运行和公开 `runNodeManually` 四入口触发准入，均记录 `FLOW_REVIEW_NOT_READY`；第二进程重开后 gate 仍有效。Agent任务、命令、审核记录、合成模型、供应商及外部HTTP请求均为0。
- CMD-08 unknown 占用及恢复子场景通过：两进程 Electron 测试覆盖64个操作；renderer丢失后的 pending→unknown 恢复后，目标节点标题、多选、手动执行与资产发布均被占用 gate 阻断。保存 run 只核对事实、不重放；缺失 run 继续 unknown；已提交回执重放不重复副作用；诊断脱敏通过。供应商、计费模型和外部HTTP请求均为0。
- CMD-08 Agent footer × unknown 占用补测通过：真实画布 Agent 卡片底部“启动任务”触发一次本地合成模型决策；工具调用以 `FLOW_NODE_OCCUPIED` 阻断，未创建新命令，原 unknown 回执保持、目标节点历史运行数仍为0。明确停止 blocked Agent 后，第二个独立进程重开仍无模型请求重放。共3次合成模型请求（2次能力探测、1次决策），真实供应商/计费模型/外部HTTP请求均为0。此前错误的事件类型断言与首次失败均保存在证据目录。结合 review-gate 和 unknown 两种状态的四入口结果，CMD-08 全项通过；证据分别见 `qa/agent-cmd08-agent-gate-20261017/desktop/`、`qa/canvas-agent-flow/C2/commands/`、`qa/agent-cmd08-unknown-agent-footer-20261017/desktop/`。
- COO-08 P0 协调范围与占用集成复测通过：定向运行协调器用例3/3通过。重叠主控在首任务执行期间和其进入人工等待后均被 `FLOW_CONTROL_OCCUPIED` 拒绝，原任务保持waiting、目标占用和唯一run记录不变；跨项目同ID占用互相隔离；对专业节点和外项目节点的越权派发均在创建子命令/执行器副作用前阻断。证据见 `qa/agent-comprehensive/run-20261017-coo08-waiting-ownership-v1/coo08-vitest.log`，扩展断言位于 `test/agent-flow-coordinator.test.ts`。
- CFG-05 早期自动化子场景通过：删除授权ID `first` 后创建同标题、不同ID的替代节点，配置仍保留旧ID且启动在创建coordination run前被拒绝，无子命令或执行器副作用。当时还未核对产品UI组合；当前 Windows 包的Agent/审核失效引用组合已在本报告末尾升级通过。定向补测日志见 `qa/agent-comprehensive/run-20261017-cfg05-coo08-id-scope-v3/focused-vitest.log`。
- RUN-08 P1 固定输入范围与上下文边界通过：真实SDK请求适配层向本地合成fixture发送1次请求，只解析并包含已授权F-TEXT固定引用；未引用的secret-branch资产ID/正文标记不在请求体。300,000字符上下文在请求前以 `AGENT_CONTEXT_TOO_LARGE` 拒绝，未声明工具被拒绝。定向3/3与Agent runtime全文件76/76通过；模型供应商、计费和外部HTTP为0。证据见 `qa/agent-comprehensive/run-20261017-run08-context-scope-v1/run08-vitest.log`、`runtime-suite-v2/vitest.log`。
- SKL-01 P1 合法Skill导入、固定绑定和内容权限边界通过：自定义F-SKILL v1进入库后，目录记录的规范化正文、enabled状态及SHA-256哈希一致；绑定任务只加载该版本instructions和明确声明的facts.md，未绑定secret Skill正文未进入任务上下文；Agent工具仍只有node.execute@1且没有执行副作用。定向用例和Agent runtime全文件77/77通过，供应商、计费和外部HTTP均为0。证据见 `qa/agent-comprehensive/run-20261017-skl01-bound-skill-v2/skl01-vitest.log`、`runtime-suite-v3/vitest.log`。
- LOG-03 恢复关联子场景通过：协作任务等待后关闭并重开SQLite，接受人工继续时产生新trace并准确记录resumesTraceId；模型桩调用数为4→5，重复响应后仍为5，重开后的工具调用为0，冲突重复响应拒绝。runtime文件77/77通过，ESLint退出0；真实供应商、付费和外部HTTP请求均为0。该场景当时没有重启OS进程，也未核对sessionId；后续独立Electron双进程证据补齐session变化，且旧祖先unknown子例已验证correlationMissing。合并判据现已通过，见 `qa/agent-comprehensive/run-20261017-agent-log03-primary-combined-v1/`。证据见 `qa/agent-comprehensive/run-20261017-log03-restored-agent-trace-v2/`。
- COO-08 桌面补充：当前源码Electron双进程夹具完成主控启动、两个专业任务、固定成果交接、人工等待后重开/明确继续，全部通过且无重放；合成模型请求16次，供应商/计费/外部HTTP为0。该正常路径补充不替代COO-08的越权集成断言；证据见 `qa/agent-comprehensive/run-20261017-coordination-desktop-v1/desktop/results.json`、`execute-report.json`、`reopen-report.json`。
- LOG-06 Agent renderer节点终态诊断传输子场景2/2通过：用正式DiagnosticsProducer构造node.completed/node.failed事件，携带nodeType=agent及task/run/trace/node身份。成功事件的drain等待IPC确认后完成，丢弃计数为0；失败事件的传输拒绝后drain仍完成，丢弃计数增加1。ESLint退出0，真实模型/供应商/外部HTTP请求均为0。没有模拟真实窗口关闭，也没有验证日志故障与Agent业务终态的组合，LOG-06主用例仍未执行；证据见 `qa/agent-comprehensive/run-20261017-log06-agent-drain-v1/`。
- PAR-07 早期并行桌面子场景通过：两个视频Agent分支的本地供应商协议fixture POST重叠；一支完成时另一支保持unknown；新进程重开未重发POST、未重跑已完成兄弟，并保留两份独立固定媒体。双unknown流显式停止后原占用仍保留。该次尚未核对共享目标的强退/FIFO队列和预算恢复，主用例结论以本报告末尾的三分支组合复测为准。证据见 `qa/agent-comprehensive/run-20261017-parallel-media-p0-v2/desktop/`。
- PER-01 同renderer两小时专项通过：2026-10-17 08:52:28–10:52:28（北京时间）在同一 renderer（webContentsId=1、PID=25268）完成120轮每分钟一次的Agent执行/等待/继续，共120个任务、240条命令；worker历史封顶12。每分钟121个资源样本、0个采样错误，15分钟间隔截图9张。运行结束后由新进程重开，最终任务仍为completed，worker历史12、固定输出123个shape、数据持久化，任务/命令计数未变化且无重放。生命周期审计为240 started/240 terminal，无未配对事件；诊断脱敏断言通过。所有模型请求均走本地合成fixture（482次fixture请求），真实供应商、计费请求及外部HTTP均为0。renderer RSS从约230 MB上升到1418 MB峰值，结束约1355 MB；page JS heap在约87–163 MB范围内回收波动，renderer句柄417–477，等待队列一直为0。DOM节点从502增至6380、CDP监听器从1538增至峰值23620（结束18956）、canvas shape从5增至125，随保留的120轮画布结果持续增长；长驻过程无崩溃或事实丢失，但本轮验证没有清空历史输出，RSS/DOM/监听器增长应作为保留结果容量风险跟踪，不能据此推断无限期长驻内存有界。证据见 `qa/agent-residency-per01-7200-20261017/desktop/execute-report.json`、`reopen-report.json`、`agent-lifecycle-audit.json`、`residency-samples.jsonl`、`results.json`及9张截图。
- PER-04 挂载卸载专项曾按旧的单次预热基线失败并登记 AGT-20261017-009。稳定预热后的最新复测结论、旧增长的复核与补丁证据见本报告末尾 `2026-10-18 PER-04 稳态预热后复测`；旧运行继续作为修复前/预热不足的历史证据保留。
- LOG-07 Agent 诊断高频轮转与保留专项通过：定向回归2个文件16/16通过。默认队列在3000条普通诊断输入下接受1920、显式丢弃1080；关键错误129条全部保留，其中一次满队列逐出有计数。默认10MiB分片阈值写入24,000条合成Agent事件后轮转为2片、20,307,390字节；全量解析24,000条且坏行/超长行均为0。QA内存FS以12MiB保留上限清理最旧1片、释放10,495,742字节，保留11,584条有效记录；项目文件未触碰。生产200/20/256MiB默认策略与QA覆写分别记录。未模拟本地物理磁盘I/O；模型、供应商、网络请求均为0。证据见 `qa/agent-comprehensive/run-20261017-log07-stress/log07-stress-results.json`、`focused-vitest-results.json`和`test/agent-flow-log07-stress.test.ts`。
- RUN-06 取消/超时运行时子场景复确认2/2通过：待决策模型尚未返回时取消，任务进入cancelled；随后释放迟到finish，终态输出仍为空。另以永久pending且忽略Abort的模型确认`maxActiveMs=10`仍有界返回TIMED_OUT。定向命令只运行这2项，runtime文件其余73项标记跳过、不计通过；当时缺少断流、非法工具JSON及桌面停止延迟证据，故未升级；该主用例已于2026-10-17由后续组合证据升级通过（见最新合并结论）。结果见 `qa/agent-comprehensive/run-20261017-run06-cancel-confirm/vitest.json`。
- PER-05 两进程桌面取消子场景通过：协作任务在新进程继续后，另起自主`cancel-fixture`任务；本地SDK夹具原定10秒后响应，运行中800ms后点击停止，任务转为cancelled，处理器运行历史仍为4；重开主任务及明确继续也成功。整次桌面验收使用合成fixture（17次模型请求），真实供应商/计费/外部HTTP为0。测试只在停止后观察1秒，未证明完整迟到响应在renderer仍存活时被消费；当时没有冻结的UI反馈阈值或p95，因此PER-05只登记子场景、不升级整项；后续20次桌面反馈采样及阈值限制见本报告末尾。证据见 `qa/agent-comprehensive/run-20261017-per05-collaboration-stop-v1/desktop/results.json`、`reopen-report.json`。
- Agent定向自动化复确认：以Electron 39.8.10内嵌Node v22.22.1（ABI 140）复跑当前Agent范围33个测试文件，共655项，652通过、3失败。失败分别为SEC-02自有`__proto__`命令被IPC接受、MED-04音频结束时间与起点/时长矛盾被schema接受、MED-04审核保存守卫接受相同矛盾；均与已登记AGT-20261016-003/AGT-20261016-001一致。系统Node v24为ABI 137，不能加载Electron ABI 140的better-sqlite3；该运行环境不匹配未计为产品测试失败。整批报告见 `qa/agent-comprehensive/run-20261017-agent-regression-electron-runtime-v2/vitest.json`，清单与哈希见同目录`execution-manifest.json`；此前33文件复核结果见 `qa/agent-comprehensive/run-20261017-agent-regression-33/vitest.json`。本次未修改正式Agent业务实现。
- Agent方案边界扩展复跑：3个新增边界测试文件100项中99通过、1失败；失败再次命中MED-04音轨结束时间与起点/时长矛盾（AGT-20261016-001），计划范围和请求边界用例通过。证据见 `qa/agent-comprehensive/run-20261017-agent-boundary-expanded-v1/vitest.log`；不与652项全量回归重复计数。
- Agent定向关联回归复跑：7个原测试文件235/235通过，另有更新后的协调器/声明两文件55/55、runtime全文件77/77通过；覆盖Skill导入/绑定、控制声明、协调器、固定输入版本/上下文预算、多成果投影、命令台账、真实子进程强杀恢复和保存故障注入。日志见对应run目录；单测/集成通过不替代尚未执行用例要求的桌面或人工步骤。
- PAR-07 强退恢复桌面子场景通过：隔离Electron在并行主控一支已完成、一支unknown的检查点写盘并刷新renderer/main诊断后，由外层真实发送SIGKILL；新Electron进程重开后恢复原协调taskId、两个子taskId及原commandId/leaseId/runId。已完成分支决策/工具计数保持2/1，未重放；unknown分支保持原任务与预算记录后显式核对并完成，计数由1/1增至2/1，均未超过12步/20工具；命令台账由committed/unknown收敛至committed/committed，commandId、taskId、lease、run保持不变；供应商fixture POST仍为4、下载1→2，合成模型请求17，外部HTTP/真实供应商/计费请求为0，诊断生命周期与脱敏审计通过。独立证据见 `qa/agent-comprehensive/run-20261017-par07-forced-exit-v3/`。
- PAR-07 FIFO/等待队列集成子场景复核通过：当前源码协调器两个定向断言2/2通过；共享目标按dispatch顺序排队，首分支未终态前第二分支不启动；waiting/queued经过协调器事实核对后顺序不变，首分支继续完成后显式继续主控，第二分支才完成，执行器计数2→4。证据见 `qa/agent-comprehensive/run-20261017-par07-queue-recheck-v2/`。该队列集成子场景没有模拟OS进程强退；跨进程队列组合已由本报告末尾的新三支桌面强退验收覆盖。PAR-07主用例以末尾最新记录为准。
- AST-05 桌面输出集合复现失败并确认：隔离Electron真实画布连接两个授权文本处理器、Agent `out-json` 和普通JSON节点。Agent runtime 已完成3次决策、执行2个处理器，固定两份不同 versionId 的输出集合已写入 `meta.nodeResult`；公共节点执行器随后在 output 阶段报 `INPUT_INVALID` 并把 Agent 节点标为 failed。因公开输出投影在失败状态被静音，下游 JSON 节点也失败且正文仍为 `{}`。确认版 v1/v2/v3 重复命中同一阶段；本地模型fixture请求5次（能力探测2、决策3），处理器执行2次，真实供应商/付费/外部HTTP均为0。未进入第二进程重开步骤；AST-05主用例从未执行改为失败，登记 AGT-20261017-010。证据见 `qa/agent-comprehensive/run-20261017-ast05-output-set-desktop-confirm-v3/`，复现场景代码仅用于隔离测试入口，没有改正式 Agent 业务逻辑。
- AST-01 桌面固定输入版本跨进程复测通过：同一来源固定资产 v1/v2 在资产版本 UI 中可读并显式选中 v2；Agent 在人工等待时先持久化 task，关闭后由新 Electron 进程恢复相同 taskId 并继续。任务 directInputs、processor target inputs、committed 命令输入引用均保持 v1；模型请求只含 v1，不含 v2；processor 与 Agent 输出都是 v1。决策3次、processor工具1次，本地 fixture HTTP/模型请求7（能力探测4、决策3），诊断双会话扫查未发现 v1/v2 正文；真实供应商/付费/外部HTTP=0。证据见 `qa/agent-comprehensive/run-20261017-ast01-fixed-input-desktop-v6/`（含源/构建hash）。AST-01 主用例升级通过。
- 144项主用例最新状态快照（截至2026-10-18 12:32 UTC；REL-02 M01补充子场景已记录但不升级主用例，PER-04当前源码稳定预热复测通过；run-FJfDIw全量verify通过后主用例状态不变）：通过110、失败0、未执行21、暂缓12、阻塞1；其中P0通过94、失败0、未执行4、暂缓5、阻塞1。PER-04按当前稳态预热验收通过。仅按144个主用例统计；本次REL-02子场景结果不改变主用例未完成状态。
- REC-09 早期当前源码定向复测：同步保存IPC/乐观冲突、崩溃恢复和存储阶段故障3个文件34/34通过；当时缺Agent运行中关窗与并发修改组合。该缺口现已由本报告末尾两进程组合复测补齐。

- REL-02 当前源码Windows解包包UI子场景通过：独立产物 `dist/agent-test-20261017-rel02-v1/win-unpacked` 从实际 canvas-studio.exe 入口启动；Agent/AI审核/状态机配置与输入输出面板、审核/状态机默认配置保存、正常退出及新进程重开均通过。真实供应商/模型/外部HTTP请求为0。v2显式隔离Electron profile；v1默认profile偏差保留说明。此轮不含Agent任务执行、M03/M06/M08，REL-02主用例仍未完成。证据见 `qa/agent-comprehensive/run-20261017-rel02-packaged-agent-ui-v2`。

- CFG-05 早期当前源码包子场景通过：当时已验证失效引用提示与保存重开及当前源码范围守卫，但尚未组合AI审核来源/门禁/责任节点。组合验收已在本报告末尾升级通过。

- LOG-03 Agent跨进程恢复trace/session子场景经v3复核通过：同一taskId在进程A等待、进程B恢复并完成；恢复事件使用新operation traceId，`resumesTraceId`等于持久化任务快照的`traceId`（二者语义不同），sessionId由`session-5ab0...`切换为`session-0c56...`。已观察工具没有重放，诊断双会话脱敏通过。本次fixture模型请求17，真实供应商/付费/外部HTTP=0。v1补充行曾将`resumesTraceId`误写成等于前序operation trace；v3新增快照trace采样后已更正，v1原始证据保留。未知祖先trace当时尚未覆盖；后续 `run-20261017-agent-log03-recovery-trace-v1` 增加该子例并验证 `correlationMissing=true`，连同上述双进程session/trace证据后，LOG-03主用例已升级通过。证据见 `qa/agent-comprehensive/run-20261017-log03-collaboration-desktop-v3`。

## 压力专项处理

- qa\r09-soak\run-bMO705\report.json：passed；3 批 / 24 轮；elapsedSeconds=2.5046326；durationTargetMet=false；cleanupCompleted=true。
- qa\r09-soak\run-lKyR1Y\report.json：externally-stopped-per-user; original report unchanged；545 批 / 4360 轮；elapsedSeconds=778.6806848；durationTargetMet=false；cleanupCompleted=false。

用户确认既有90分钟压力测试已做过，本轮没有重跑5400秒长测。另有此前启动的短时重复runner在用户指示后停止并确认退出；原始report保留停止前running快照，事实见soak-user-stop.json。复用HANDOFF_2026_10_16_R09_LOCAL_RELIABILITY_SYNC.md：选定5400秒目标已越过（5400.403秒），后续审计到6117.524秒/3584批/28672轮；离线最终恢复和三个独立新进程重开通过。历史runner实际按7200秒配置，后来被外部中断，原report不能称正常退出，cleanupCompleted=false；这些边界保留。

## 尚缺的验收证据

1. 逐项对齐完整参数/UI/人工剧本仍未完成；实际中文输入法组合、系统DPI、完整主题矩阵及独立人工体验评审未覆盖。首次隔离包交互尝试被桌面浮层拦截并停止，未进入项目；已有打包版新建Agent节点、空白卡片表面拖动、任务目标Ctrl+A与中文键入、Esc退出及新进程重开子场景。另在当前源码隔离浏览器补测CFG-07：Agent/AI审核/状态机节点的body、操作栏和设置面板Tab/Shift+Tab顺序可逆；信息按钮与设置页签可键盘打开；职责下拉框可Esc关闭并还原焦点、ArrowUp+Enter可更改草稿，复选框Space可切换并还原。未触发节点任务或保存。此结果不等同Windows打包版完整控件验收；完整应用级Tab遍历、中文IME组合、系统DPI及人工体验评审仍未完成。证据见 `qa/agent-comprehensive/run-20261017-agent-manual-ui-v3/`、`qa/agent-comprehensive/run-20261017-agent-manual-ui-v3-data/` 与 `qa/agent-comprehensive/run-20261018-cfg07-tab-navigation-v1/`。
2. PER-02 已完成通用画布数据层100/500/1000节点基准，并新增10/50/100个Agent节点的拖动、缩放、协作面板开合各30轮及10节点同机基线；交互矩阵数值、测量定义与边界见本报告末尾。该矩阵运行于隐藏隔离Electron窗口，不能代表可见帧延迟。真实低内存/磁盘配额和冻结的产品交互阈值仍未覆盖，因此PER-02主用例仍未完成。PER-01 两小时同 renderer 测试观察到保留输出增长下的 RSS、DOM 和监听器趋势。PER-04 已修复 tldraw 4.5.12 FocusManager 对绑定回调使用不同函数身份解绑的问题；稳定预热后连续6次画布重挂载与30次面板开关的监听器/interval验收通过，详见报告末尾。PER-05 已追加20次桌面可见停止反馈采样（p50 156 ms、最近秩p95 168 ms）；产品阈值仍未冻结，故不判定PER-05完成。
3. REC-11 历史证据已复用：5400秒目标及恢复/重开验证通过，但原runner实际配置7200秒、最终为外部中断且cleanupCompleted=false，不能签署“正常终止并清理”条件。按用户指示，本轮不重跑90分钟。
4. Windows解包版已按REL-01构建并启动；签名/安装器与干净机器安装未验收。REL-02主用例仍未完成：正式包M01、M03、M06双进程补充子场景均已有通过证据；M08步骤5项目包媒体/固定版本UI往返及项目导入媒体故障补充子场景，以及M08 `write-tmp`、`rotate-bak`、`update-db`、`flush-tmp`、`promote-tmp` 正式包故障子场景与源码保存阶段定向测试25/25现已通过；正式包本机模型fixture下的“已接受决策未回包”和“命令已提交未呈现”强退/重开子场景已执行；单一已提交命令现可经事实核对后显式补呈现，原task完成且同一回执成果写入Agent节点；真实供应商已接受异步生成但无回执路径及成功恢复呈现仍未验收；36轮共享恢复worker fixture不替代这些包级路径。REL-02主用例保持“未执行”。证据见 `qa/agent-rel02-m08-package-media-v1/`、`qa/agent-comprehensive/run-20261018-rel02-m01-package-v3/`、`qa/agent-comprehensive/run-20261018-rel02-m01-current-package-v1/`、`qa/agent-comprehensive/run-20261018-rel02-m03-package-v4/`、`qa/agent-comprehensive/run-20261018-rel02-m06-package-v4/`、`qa/agent-comprehensive/run-20261018-rel02-m08-package-save-write-v3/`、`qa/agent-comprehensive/run-20261018-rel02-m08-package-save-update-db-v2/`、`qa/agent-comprehensive/run-20261018-rel02-m08-package-save-rotate-bak-v2/`、`qa/agent-comprehensive/run-20261018-rel02-m08-package-save-flush-tmp-v8/`、`qa/agent-comprehensive/run-20261018-rel02-m08-package-save-promote-tmp-v2/`、`qa/agent-comprehensive/run-20261018-rel02-m08-package-media-fault-v3/`、`qa/agent-comprehensive/run-20261018-rel02-m08-unknown-accepted-no-receipt-v3/`、`qa/agent-comprehensive/run-20261018-rel02-m08-unknown-committed-unpresented-v1/`、`qa/agent-comprehensive/run-20261018-rel02-m08-unknown-committed-unpresented-reconcile-v1/`、`qa/agent-comprehensive/run-20261018-rel02-m08-source-storage-failure-ipc-v1/` 与 `qa/r09-local-20261016/soak/run-9HsafL/`。
5. REC-12 真实设备掉电条件未定义，维持阻塞；AI-01..12 按 handoff 暂缓，未发起真实付费调用。
6. LOG-04 历史探针发现 withStack=true 错误栈正文泄漏，已于2026-10-17修复safeStack并通过合成成功/失败诊断事件ZIP扫描；2026-10-18正式Windows解包包中已补齐Agent实际成功、受控模型失败、公开诊断导出及敏感值扫描，整项证据现完整，见最新追加记录。
7. 最新完整 `npm run verify` 于2026-10-18T05:26:31.857Z至05:40:35.623Z通过，runId `run-pNI52e`，退出码0：lint、应用/模型类型检查、187个单测文件（2,342通过、1跳过）、模型包测试、日志门禁、含CFG-07键盘用例的浏览器UI门禁、Electron构建、Agent资产/命令/桌面集成全套与R09本地保存恢复均通过。状态及完整日志见 `qa/verification/run-pNI52e/`。此结果不包含90分钟soak、真实低内存/磁盘配额、签名/干净机器安装或真实供应商付费验收；REL-08的发布签字条件仍未全部满足。

## 缺陷与日志

MED-04 新增异常证据检查发现 AGT-20261016-001：音轨结束时间与结尾差同时增加100ms后，schema及保存审核媒体守卫均接受内部矛盾数据。两个负例失败，正常采样正例通过；暂定S2协议完整性缺陷，不宣称已证明正常生成错误或外部可利用。保留失败证据，不修改业务代码。具体见 defects.md。

CFG-06确认AGT-20261016-002：非法JSON、未知键、旧schema三个变体打开Agent设置均触发整页错误边界，提示读取undefined.some，暂定S1。生产导入函数的隔离测试证明非法JSON可保存进入新项目；同值在共享浏览器renderer中复现失败。尚未将正式Electron导入按钮到错误界面完整串行验收。详细复现与截图见AGENT_TEST_DEFECTS_2026_10_16.md。

CFG-04 新增 AGT-20261017-008：Windows UI 数值边界正确，但实际 project.save IPC 路径没有校验 Agent 配置 schema。隔离 Electron 测试 runtime 通过真实 project.ipc handler 与真实 projects.repo 写入并重开，四个越界值 maxSteps=0/65、maxParallelTasks=0/5 全部返回成功并落盘；合法 maxSteps=1/64、并行1/4通过。不是实际执行 Agent；无模型、供应商或外部HTTP请求。证据见 cfg04-agent-config-project-save-ipc-probe-results.json 和 AGENT_TEST_DEFECTS_2026_10_16.md。

SEC-08新增AGT-20261016-004：恶意Agent输出、审核反馈及长错误文本均按纯文本呈现，详情可开关、无外链请求且错误不改变等待任务；但Agent输出的鼠标拖选结果为空，计算样式 user-select: none，无法完成用例要求的复制。暂定S2结果可用性缺陷；不代表内容执行或网络注入。证据见agent-render-security-results.json及截图。

SEC-02确认AGT-20261016-003：原本合法命令带自有__proto__字段在IPC被接受、落库并派发一次；全局原型污染和授权绕过均未证实，暂定S2严格结构校验缺口。其余五个IPC非法结构负例拒绝。初跑和确认失败均保留，不以未观察到污染替代方案的拒绝判据。三处缺陷均未修复。

LOG-04 条件性确认 AGT-20261017-006：在 Agent agent.probe.failed 事件中使用 withStack=true，异常栈带有假 prompt、response 和 media-base64 标记；消息正文提供 privateValues 后已脱敏，但 safeStack 忽略该列表，诊断ZIP中的 events.jsonl 仍包含这三类原文。Key、Bearer、签名URL与本地绝对路径标记未泄漏。文本检索未发现生产源码有 withStack=true 调用点，因此只证明该公开选项/导出组合可泄漏，不宣称默认Agent运行已触发。无模型、供应商或外部HTTP调用；复现和原始报告见 log04-sensitive-export-probe-source.txt 与 log04-sensitive-export-probe-results.json。修复前该子例使 LOG-04 整项登记失败；2026-10-17已完成safeStack修复并通过当前源码诊断ZIP复测，初始泄漏证据保留为历史记录。

REC-03 确认 AGT-20261017-007：Windows解包版损坏项目从首页点击后回到首页，没有可见错误/恢复提示；首页只有项目导入/导出等常规操作，没有诊断包导出按钮。短时DOM观察捕获3次页面变化，均未出现恢复提示；SAVE_FAILED 保存拒绝与原快照未变已通过。该缺陷仅针对Agent测试项目中的共享恢复流程，未证明项目正文被覆盖或敏感路径泄漏。证据见 packaged-rec03-corrupt-snapshots-v4-results.json 与 v4 截图；本流程没有导出ZIP。

AST-05 确认 AGT-20261017-010：多成果 Agent 的任务状态为 completed、两个 processor 命令均 committed，`meta.nodeResult` 保留按顺序排列的两个文本固定版本；但公共 Agent executor 在输出物化阶段返回 `INPUT_INVALID`，下游普通 JSON 节点也失败。现有执行器路径把合并后的 `flow.agent-output-set` JSON 当成单个固定资产值与每个 `result.refs` 比较，无法匹配聚合输出，因此结果材料化失败；这是基于执行证据与源码路径的根因判断。节点失败后 `projectNodeOutputs` 隐藏失败 run 的端口，所以引用虽留在 `nodeResult`，下游不能读取。暂定 S1，多成果公开流被阻断；版本仍保存在 Agent 结果记录中。确认版 v1/v2/v3 均复现；fixture模型请求5次、processor工具2次，真实供应商/付费/外部HTTP=0；第二进程恢复步骤未能到达。证据与源/构建hash见 `qa/agent-comprehensive/run-20261017-ast05-output-set-desktop-confirm-v3/` 及 `AGENT_TEST_DEFECTS_2026_10_16.md`。

CFG-03 新增 AGT-20261017-005：Windows解包版空模型目录场景中，点击Agent“启动任务”后有清晰缺模型提示且模型请求=0、Agent子任务=0；但工作流已经进入started/queued/admitted，node.started后失败，exec.status=failed并保存图版本。按“缺失配置须在副作用前拒绝”的严格判据失败，暂定S2本地执行准入顺序/失败状态写入边界；无真实供应商调用。若产品将“副作用”限定为外部生成/命令，该本地失败记录是否符合定义仍需产品决策。证据见packaged-cfg03-no-model-recheck-results.json及对应session JSONL。

沿用正式网关的日志生命周期、唯一终态和脱敏断言；测试程序新增日志影响为不涉及业务路径，不改变正式观测或 LOGGING_COVERAGE。既有桌面脚本检查脱敏后保存隔离诊断；原始业务证据不上传。历史 QA 输出只读，本轮使用独立输出根。不得在压力运行中清理其目录。

证据根：D:\Program Files (x86)\canvas-studio\source\qa\agent-comprehensive\run-20261016-203617










- Agent-only 源码定向总回归（run-20261017-agent-flow-unit-regression-v2）：39个相关测试文件，688项中685通过、3失败；失败为SEC-02原型键IPC接受/持久化/派发1项，以及MED-04音轨结束时间一致性2项，均复现已有缺陷AGT-20261016-003与AGT-20261016-001，未改业务代码。单独筛选通配符的初次调用未发现测试文件，已保留为运行器参数错误并排除产品结果；改用枚举的39个文件后完成本轮。证据：qa/agent-comprehensive/run-20261017-agent-flow-unit-regression-v2/execution-manifest.json、vitest.log。不重复计入既有用例汇总。

- REL-03 Agent 命令桥自动化子场景通过（run-20261017-rel03-agent-command-parity-v1）：当前源码 Electron 双进程，65项IPC命令操作；手动/命令执行结果、固定资产来源与指纹对照，图像/音频相关节点合约、停止取消、持久回执、重放、unknown恢复、占用门禁和脱敏均通过；真实供应商/付费模型请求=0。此证据仍不覆盖正式发行包和人工多模态旧工作流，REL-03主项保持未执行。

- CFG-05 主用例升级通过（2026-10-17T05:07:21Z）：当前 Windows 解包包中以同一个已删除文本节点为目标，Agent 允许范围及 AI 审核来源、门禁、责任节点都保留该旧 ID；同名替代节点未接管引用。UI 显示失效提示；无效审核设置保存被拒绝，退出重开后引用仍保留。当前源码范围守卫 2/2 通过，启动旧 ID 在创建协调 run 前拒绝，无命令/执行器副作用；模型/供应商/外部 HTTP 请求均为 0。此结果覆盖 CFG-05 定义的组合判据，并取代报告中较早的“子场景/待整项”状态。主用例当时更新为95通过、10失败、26未执行、12暂缓、1阻塞；其后REC-09、PAR-07、PER-03和LOG-03通过，最新统计为99通过、22未执行。证据见 qa/agent-comprehensive/run-20261017-cfg05-current-package-combined-v1/。
- REC-09 主用例升级通过（2026-10-17T06:13:53Z）：当前源码 Electron 双进程验收使用实际 FlowAgentDesktopHost 和确定性本地 ModelPort；进程A在Agent任务running且已预留1次决策时关闭真实BrowserWindow。外部项目保存将graphVersion从1推进到2，公开工作台IPC保存agent/text配置；beforeunload同步保存触发一次配对诊断冲突，磁盘快照/工作台配置均保留，未保存的本地最后视图写入恢复副本。进程B实际显示并点击“使用恢复副本”，原task身份与决策计数不变且安全标记AGENT_SESSION_LOST；模型未重放，工具/provider/供应商/外部HTTP均为0。画布重开后显式编辑保存成功，恢复副本消费；关闭/重开保存事件4/4、7/7按trace/span配对，私有正文诊断脱敏通过。历史90分钟压力测试按用户指示复用既有handoff证据，本轮未重跑。证据见 qa/agent-comprehensive/run-20261017-rec09-running-close-conflict-v1/。

- PAR-07 主用例升级通过（2026-10-17T06:32:52Z）：当前源码 Electron 双进程隔离验收在同一视频目标上顺序分派三支Agent。强退检查点为主控waiting、子项completed/waiting/queued；第一条命令committed，第二条unknown并记录commandId/leaseId/runId，第三支任务已建但无命令副作用；unknown占用锁为FLOW_CONTROL_OCCUPIED。进程A在同步落盘和诊断刷新后由父runner发送SIGKILL。进程B恢复原主控/子任务/命令身份，查询并完成第二支而未重发POST；第二支完成后主控仍保持原等待快照，只有明确继续主控才按FIFO启动第三支。三个分支最终完成，主控out-json汇总输出可用；第一支计数保持2决策/1工具，第二与第三支各在2/1，主控最终2决策/3工具，均在16/20上限内；队列清空后目标锁释放。供应商协议fixture POST=3（强退前2、队列第三支新增1）、下载=3，合成模型请求15、本地fixture endpoint请求12，真实供应商/计费/外部HTTP均为0。证据见 `qa/agent-comprehensive/run-20261017-par07-queue-forced-exit-v3/`，执行manifest记录源文件及全部验收产物SHA-256。
- REL-03 Agent 相关自动化补测（2026-10-17T06:36:37Z）：当前源码 Electron 构建通过；公共命令桥双进程65项操作通过，涵盖文本 processor 结果/固定资产指纹、图像生成/编辑及 Speech/TTS 命令合约、停止取消、回执重放、unknown 恢复、占用门禁和脱敏。Agent 文本主控/专业分支双进程等待、重开、明确继续且不重放通过；Agent 视频 unknown 恢复、固定产物重开及带音频参考路径通过。隔离 fixture 模型请求分别为文本10、视频9、音频参考视频9；视频供应商协议 fixture 每轮 POST/下载各1，真实供应商/付费/外部HTTP=0。REL-03 主用例仍未执行：旧非Agent项目手动文本/图片/音频/视频路径，以及 Agent 图片/音频同类目标与共享 gate/占用的组合尚未完成。manifest 和证据SHA-256见 `qa/agent-comprehensive/run-20261017-rel03-agent-focused-v1/execution-manifest.json`。
- CFG-07 Windows解包版 Agent UI 手工子场景通过（run-20261017-agent-manual-ui-v3）：以独立 `CANVAS_DATA_DIR` 启动已哈希绑定的解包包，在临时中文命名项目中实际添加1个 Agent 节点。卡片空白下方面拖动后节点向右下移动；任务目标字段通过 Ctrl+A、中文键入和 Esc 完成替换，退出编辑后辅助树Value更新。Alt+F4关闭后新Electron进程重开，同一项目、Agent节点及目标值仍在，任务状态“未运行·可运行”，运行/排队计数0。模型执行未启动；真实模型/供应商/付费请求0。此为CFG-07局部通过子场景，不覆盖实际中文IME、Tab完整遍历、所有按钮/下拉及双执行；REL-02 M01执行、M03/M06及M08完整包级验收仍未覆盖。`manual-ui-results.json`、执行manifest与重开可访问性摘要见 `qa/agent-comprehensive/run-20261017-agent-manual-ui-v3/`；为避免归档桌面通知中的个人信息，未保存截图。
- REL-02 M08 Agent项目包UI往返子场景通过（run-20261017-agent-manual-ui-v3）：在同一Windows解包包与隔离 `CANVAS_DATA_DIR` 中，经项目列表UI导出2,145字节 `.canvasbundle`，再经产品导入选择器导入并打开副本。ZIP内 `project.json` 有且仅有1个 `agent` 节点，`role=specialist`、`interactionMode=collaborative`、目标文本原样保留、序列化执行状态为 `idle`；UI副本显示“未运行·可运行”，运行/排队数均为0。退出后新Electron进程使用同一隔离数据目录再次打开，Agent节点、任务目标及未运行状态仍保留。模型/真实供应商/付费请求均为0；通用启动HTTP未埋点。该结果只证明Agent配置包级往返子场景，不覆盖媒体/凭据、损坏包矩阵或M08/REL-02整项；全量统计仍按144条主用例计算。证据及SHA-256见 `qa/agent-comprehensive/run-20261017-agent-manual-ui-v3/manual-ui-project-package-roundtrip.txt`、`Agent UI QA 2026-10-17 中文.canvasbundle`、`execution-manifest.json`。
- MED-07 Agent 多模态审核 fixture 子场景通过（run-20261017-rel03-agent-media-review-v1）：固定 PNG 全字节、完整 1.00 秒/16 kHz/单声道规范化 WAV，以及含8帧时间线、仅取4张JPEG供视觉判断的同步A/V证据均正确传入；3份 image/audio/A-V 范围独立的审核回执跨新进程重开保留且未重放模型。fixture模型及本地fixture HTTP各5次，真实供应商/付费请求为0，通用启动HTTP未全局埋点。仅为媒体证据与回执持久化子场景；未覆盖预览/播放/暂停/下游连接、同目标图片/音频gate与占用，MED-07及REL-03主用例仍未执行。证据manifest、summary、results、截图及诊断文件SHA-256均已复核一致。
- C0 Agent 最小运行与恢复子场景通过（run-20261017-agent-c0-electron-v1）：C0单测16/16通过；隔离fixture的协作任务在第一Electron进程进入waiting并持久checkpoint，第二个Electron进程恢复到completed；重放同一 commandId 后renderer effectCount仍为1。确定性模型为进程内fixture，模型供应商/付费/网络请求均为0。此结果不覆盖产品画布、生产节点适配器、真实网络断流/不响应取消/非法供应商工具JSON；144项主用例不升级。证据manifest、命令日志、Electron结果及脱敏诊断见 `qa/agent-comprehensive/run-20261017-agent-c0-electron-v1/`。
- CMD-08 Agent 审核门禁补充子场景通过（run-20261017-agent-cmd08-gate-v1）：标题、页脚、多选和直接手动执行四种入口均进入同一 FLOW_REVIEW_NOT_READY 门禁；Agent任务/命令/审核/模型请求均为0；新进程重开后门禁与配置仍保留。诊断脱敏通过，通用应用启动HTTP未全局埋点。只覆盖审核节点未接入时的准入拒绝，不覆盖审核接通后的成功业务流程，主用例状态不升级。证据manifest、results及执行/重开报告见 `qa/agent-comprehensive/run-20261017-agent-cmd08-gate-v1/`。
- RUN-06 Agent 运行故障处理单测补充子场景通过（run-20261017-agent-run06-runtime-faults-v1）：runtime 77、executor 5、command-ledger 67，共149项通过；覆盖模型不响应Abort时有界超时、取消后拒绝迟到完成且终态不变，以及unknown/回执/命令副作用恢复。均为隔离fixture，无真实供应商/付费请求。该轮未覆盖桌面断流、非法供应商工具JSON和真实迟到供应商响应；随后补测已覆盖本地故障注入和桌面迟到响应，并升级RUN-06主用例通过。证据manifest和日志见 `qa/agent-comprehensive/run-20261017-agent-run06-runtime-faults-v1/`。
- Agent-only 当前源码单元回归复现已知缺陷（run-20261017-agent-flow-unit-regression-v1）：`npm test -- test/agent-flow` 共28个测试文件、540项，537通过、3失败。SEC-02原型键命令被IPC接受并写入/派发，复现AGT-20261016-003（未观察到全局原型污染）；MED-04时间线schema与审核保存守卫都接受音轨结束时间不等于起始时间+时长的证据，复现AGT-20261016-001。两项缺陷未修复，本轮只登记测试结果；真实供应商/付费请求为0，90分钟runner未调用。证据manifest、summary和完整Vitest日志见 `qa/agent-comprehensive/run-20261017-agent-flow-unit-regression-v1/`。
- LOG-06 Agent renderer 诊断队列补充子场景通过（run-20261017-agent-log06-renderer-drain-v1）：2/2测试通过；drain等待resume诊断事件的IPC确认，传输拒绝会计入drop且不会让drain报错。此为jsdom单测，未覆盖Electron关窗完整drain/业务副作用，因此LOG-06主用例保持未执行。证据manifest及Vitest日志见 `qa/agent-comprehensive/run-20261017-agent-log06-renderer-drain-v1/`。
- UI QA 证据完整性复核：原 `run-20261017-agent-manual-ui-v3/execution-manifest.json` 中隔离 `app.db` 记录哈希为 6F259247…，当前实测为 07C90796…；项目包、手工结果、重开摘要哈希仍一致。当前库以只读 Electron ABI 连接检查，SQLite完整性为ok，Agent task/command/review、通用task、provider、model connection均为0。由于缺少旧库快照，无法判断确切字节级差异；保留历史manifest原值并新增 `evidence-integrity-addendum.json`，不再将该数据库宣称为字节级匹配。
- BLD-08 Agent 搭建器桌面子场景通过（run-20261017-agent-builder-desktop-v1、run-20261017-agent-builder-parallel-desktop-v1）：顺序与三分支并行两种提案均先预览不改业务图，经显式提交后跨进程保留，重复提交无重复节点；顺序双专员与三路独立分支均通过公共执行器完成，输出固定且分支资产保留。合成模型fixture请求15+13=28，真实供应商/付费请求0，诊断脱敏通过。未覆盖窄视口/长既有节点布局、未授权材料读取检查与真实供应商，BLD-08主用例仍未执行。
- PER-03 Agent 共享目标队列强退恢复子场景通过（run-20261017-agent-parallel-queue-forced-exit-v1）：首进程检查点为一支已完成、一支等待/unknown、一支排队；隔离Electron进程强退后，新进程恢复原任务身份且unknown不重发POST，第三支按FIFO在锁释放后执行，最终三支完成并释放共享锁，预算上限保持。synthetic model请求15、本地fixture HTTP12、合成供应商POST3、下载3；真实供应商/付费请求0。当时尚未覆盖长期等待/饥饿分布；后续v4/v2合并证据已覆盖本用例的有界等待分布与恢复判据并升级主用例。90分钟runner仍未启动。截图只含合成测试画布。
- REL-04 Agent Flow项目迁移自动化子场景通过（run-20261017-agent-rel04-flow-transfer-v1）：29/29测试通过，涵盖固定图像/视频/音频成果、旧生成视频兼容、缺失媒体身份重映射、bundle导入后新节点/version身份和内容保留、旧Agent task/run执行权威清理、关系/授权节点映射、凭据往返过滤、路径穿越与缺失/篡改固定引用拒绝。均为内存DB/临时包，模型/供应商/付费/网络请求0。随后新增的未来版本阻断单测见 run-20261017-agent-rel04-future-version-v1；仍未覆盖Windows发行版UI及历史schema迁移，REL-04主用例仍未执行。

- REL-04 未知未来项目版本阻断补测通过（run-20261017-agent-rel04-future-version-v1）：构造version=2项目包，明确收到“项目版本不兼容：文件为v2，当前支持v1”；projects、media、flow_asset_versions记录数与项目目录条目在拒绝前后不变。聚焦回归1/1通过，Flow transfer整套30/30通过；内存SQLite/临时包，无模型、供应商、付费或网络请求。只覆盖当前导入器版本守卫单测；历史schema与Windows产品UI未测，REL-04主用例保持未执行。命令日志、执行manifest及SHA-256见 `qa/agent-comprehensive/run-20261017-agent-rel04-future-version-v1/`。

- HUM-07 pause/stop协调器自动化子场景通过（run-20261017-agent-hum07-pause-stop-v1）：2项断言通过。暂停发生在当前模型决策边界，任务转waiting且无专业执行；明确继续后流程完成、执行计数符合预期且不重放/退预算。停止场景在占用事实未决时保留控制锁，取消后再次运行未派发后继任务。使用确定性本地fixture，无真实供应商、付费或外部网络请求。未覆盖桌面文案可理解性和完整人工流程，HUM-07主用例保持未执行。执行manifest、日志与SHA-256见 `qa/agent-comprehensive/run-20261017-agent-hum07-pause-stop-v1/`。

- LOG-03 Agent恢复关联子场景通过（run-20261017-agent-log03-recovery-trace-v1）：持久化人工中断跨SQLite重开恢复后，Agent resume使用新trace并通过resumesTraceId关联上次会话；重复继续不二次推进。Agent视频任务恢复保留本地taskId，对未知旧祖先明确标记correlationMissing=true，完成轮询/下载/入库且supplier POST=0。2个自动化场景通过，使用确定性模型与mock fetch，真实供应商/付费/外网=0。未覆盖正式Windows发行包完整恢复UI；LOG-03的集成验收判据已由本补测与跨进程Electron结果组合覆盖并升级通过。执行manifest、命令日志及SHA-256见 `qa/agent-comprehensive/run-20261017-agent-log03-recovery-trace-v1/`。

- LOG-08 Agent失败诊断包脱敏与定位补测通过（run-20261017-agent-log08-diagnostic-bundle-v1）：Agent `agent.runtime.failed` 事件按trace导出后保留task/project/node/阶段/code定位字段，manifest声明不含API Key；未知prompt/apiKey属性被丢弃，假密钥及私有目标标记在events/summary/coverage均未出现。专属断言1/1通过，诊断存储整套16/16通过；纯内存假数据，无模型/供应商/付费/网络请求。未覆盖第二测试人员盲诊能力，LOG-08主用例保持未执行。执行manifest、日志及SHA-256见 `qa/agent-comprehensive/run-20261017-agent-log08-diagnostic-bundle-v1/`。

- 本轮代码检查：`npm run typecheck` 通过；本轮涉及的两个测试文件单独 ESLint 通过。全仓 `npm run lint -- --no-cache` 未通过，唯一报错为既有文件 `src/main/agent-flow/parallel-media-acceptance.ts:320:21` 缺少显式函数返回类型；该生产验收脚本不在本轮改动范围。

- SKL-07 Agent Skill精确版本与运行任务固定内容补测通过（run-20261017-agent-skl07-pinned-version-v1）：禁用v1并导入v2后，重新绑定必须显式选v2；v2产生新hash且旧v1内容不变。已等待的Agent任务在库版本变化后恢复，仍使用原固定v1内容。2项store/runtime断言通过，确定性本地fixture，无真实供应商/付费/外网请求。未覆盖版本标签、勾选状态和产品UI保存重开，SKL-07主用例保持未执行。执行manifest、日志及SHA-256见 `qa/agent-comprehensive/run-20261017-agent-skl07-pinned-version-v1/`。

- PER-08 Agent checkpoint存储故障注入子场景通过（run-20261017-agent-per08-storage-fault-v1）：隔离内存SQLite触发checkpoint写拒绝，稳定返回CHECKPOINT_WRITE_FAILED而不泄露SQLite原始错误；中间写入失败事务无残留，移除故障后成功写入并读回。2项测试通过，无模型/供应商/付费/网络请求。该测试不代表真实磁盘限额或低内存设备验收，PER-08主用例保持未执行。执行manifest、日志及SHA-256见 `qa/agent-comprehensive/run-20261017-agent-per08-storage-fault-v1/`。

- PER-03 共享目标FIFO与等待恢复补测通过（run-20261017-agent-per03-fifo-wait-v1）：双分支共目标时第二支等待首支终态；人工等待/协调器reconcile后检查点仍为[waiting,queued]；显式继续子任务再继续主控后队列完成。2项协调器自动化通过，无真实模型/供应商/付费/外网请求。该记录当时尚未测等待分布与持续负载；后续v4/v2合并证据补齐有界等待分布并将主用例升级，长时间持续负载仍不在本次结论范围内。执行manifest、日志及SHA-256见 `qa/agent-comprehensive/run-20261017-agent-per03-fifo-wait-v1/`。

- PER-07 Agent runtime与诊断压力并发补测通过（run-20261017-agent-per07-runtime-log-pressure-v1）：Agent模型决策挂起期间，诊断append被阻塞并灌入2,112条合成Agent事件；队列不超上限、丢弃计数可见。释放决策后，Agent仍以2次决策/1次工具执行完成固定输出，诊断append随后模拟ENOSPC失败；重复有界flush恢复写入，队列最终清空，抽查20条JSONL均可解析、坏行0。全套LOG-07相关测试2/2通过，无真实模型/供应商/付费/网络请求。使用内存文件系统，未测真实磁盘吞吐、CPU和设备压力，因此PER-07设备专项仍未执行。证据manifest、日志及SHA-256见 `qa/agent-comprehensive/run-20261017-agent-per07-runtime-log-pressure-v1/`。

- RUN-06 Agent SDK供应商故障注入补充子场景通过（run-20261017-agent-run06-provider-faults-v1）：OpenAI-compatible SDK适配器分别注入SSE中途断流与`execute_node`工具参数非法JSON；两种情况均以`AGENT_MODEL_FAILED`失败关闭，产生`model.request.failed`而无`model.request.completed`，没有返回可执行决策，断流响应正文未进入诊断。两个定向故障用例2/2通过，runtime测试文件79/79通过，typecheck与该文件ESLint通过。每种故障只发出1个本地in-process fixture请求，真实供应商/付费/外部网络请求0。该补充当时尚未覆盖桌面UI响应延迟；随后桌面迟到响应和跨进程复开证据已与本组组合，RUN-06主用例升级通过。真实供应商传输仍未执行。证据见 `qa/agent-comprehensive/run-20261017-agent-run06-provider-faults-v1/`。


- LOG-06 Agent Electron双进程关窗前诊断drain补充子场景通过（run-20261017-agent-log06-desktop-drain-v1）：常规Agent桌面夹具完成协作等待、第二进程重开继续和运行中停止；销毁renderer前等待`drainDiagnosticsEvents()`，残留缓冲或drop会令runner失败，本次两进程均正常收尾。10次模型请求全部由本地synthetic provider处理；两个diagnostic session均`ended=true`，JSONL日志103+94行全部可解析，脱敏检查通过。没有真实供应商、付费或外部网络请求。未注入关窗时IPC拒绝/慢确认，也未做人工关窗时序验收，因此LOG-06主用例保持未执行。证据见 `qa/agent-comprehensive/run-20261017-agent-log06-desktop-drain-v1/`。

- Agent-only全量自动化回归复测（run-20261017-agent-flow-unit-regression-v2）：28个测试文件中25个通过、3个失败；543项中540通过、3失败。失败仅为已登记缺陷：SEC-02原型键命令IPC接受非法键（AGT-20261016-003）1项，MED-04音轨结束时间与结尾差同步变更后，计划schema及保存审核守卫未拒绝（AGT-20261016-001）2项；未发现新增失败。新加的RUN-06两项供应商流故障单测包含于runtime 79项并通过。隔离fixture，真实供应商/付费/外部网络0。90分钟驻留runner未启动。完整日志和manifest见 `qa/agent-comprehensive/run-20261017-agent-flow-unit-regression-v2/`。

- Agent-only 当前源码全量回归 v3（run-20261017-agent-flow-unit-regression-v3）：28个测试文件中25个通过、3个失败；544项中541通过、3失败。仅复现已知缺陷：SEC-02原型键IPC命令接受1项（AGT-20261016-003），MED-04音轨结束时间与结尾差不一致仍被计划schema和审核保存守卫接受2项（AGT-20261016-001）；没有新增失败。新增PER-03公平性断言通过。隔离fixture，真实供应商/付费/外部网络请求0；90分钟runner未启动。证据含完整测试日志、28个测试源文件及runner/package哈希，见 `qa/agent-comprehensive/run-20261017-agent-flow-unit-regression-v3/`。
- PER-03 Agent共享目标四波公平性补充通过（run-20261017-agent-per03-multiwave-fairness-v1）：四支分支连续运行四个有界波次，共32次子任务交付；FIFO保持、最大并发1、每波10秒内完成、无饥饿、共享锁清空，四个主控任务ID唯一。专属断言1/1、协调器整文件46/46通过；typecheck通过，ESLint 0错误。首次夹具模式配置不正确的运行保留并在正式复测前修正。确定性fixture，真实供应商/付费/外部网络请求0。该补充当时只覆盖有界多波次公平性；2026-10-17 v4/v2复测已将PER-03整项升级通过，设备压力和90分钟长驻仍未验收。
- REL-02/CFG-07 Agent桌面目标字段落盘补充（run-20261017-agent-ui-focus-v1）：隔离Windows解包包中创建1个项目和Agent节点，通过可访问编辑控件写入合成目标；关闭后只读检查project.json仍保留目标、exec=idle，SQLite完整性为ok，Agent task/command/review、通用task、provider和model connection均为0。模型/供应商/付费/外网请求0。协作及主页按钮点击映射到其他桌面窗口，未完成完整按钮矩阵或新进程UI重开；本次Unicode输入也不等于真实中文IME组合。仅为字段落盘子场景，不升级主用例。未保留含桌面通知的截图；数据与解包包SHA见 `qa/agent-comprehensive/run-20261017-agent-ui-focus-v1/`。
- 依用户指示，本轮跳过90分钟长稳压重跑；REC-11仅保留既有handoff及历史runner审计证据，原runner被外部中断、cleanup未完成的限制仍在。

- PER-04 监听器归因复测（2026-10-17T11:42:20Z，run-20261017-agent-per04-attribution-v2）：`npm run build` 的 typecheck 与 Electron/Vite 构建通过；随后用隔离 Electron、合成 fixture、30 次面板开关、6 次画布卸载/重挂载以及每样本强制 GC 复测。CDP 监听器仍从 598 增至 1,762（+1,164，高于 150 容差），全局活动 interval 稳定 3→3；退出/新进程重开通过。临时 EventTarget 来源追踪捕获六组 `document.body` `keydown` 与六组 `mousedown`，调用栈位于 tldraw 4.5.12 `FocusManager` 构造；依赖代码在构造与 dispose 中分别调用 `this.handleKeyDown.bind(this)` / `this.handleMouseDown.bind(this)`，产生不同函数身份，故 removeEventListener 无法移除先前回调。React 的非委托 `image error/load` 等监听也按画布实例增长，与被保留的 React/tldraw root 一致。根因定位为依赖 FocusManager 的解绑身份不匹配；未修改产品依赖或业务实现。测试期间任务/命令=0、模型/供应商/fixture HTTP=0。此复测只补充 AGT-20261017-009 的归因证据，PER-04 主用例仍失败，须修复后复测。执行manifest、调用栈与逐轮样本见 `qa/agent-panel-churn-per04-attribution-v2/desktop/`。



## PER-04 依赖补丁后复测（run-20261017-agent-per04-dependency-patch-v3）

- 对 tldraw 4.5.12 添加了精确版本 pnpm patch：`FocusManager` 持有并复用绑定后的 `keydown/mousedown` 回调；`pnpm run build` 的类型检查和 Electron/Vite 构建通过。锁文件仅保留 patch hash 与依赖引用，未保留 pnpm 重解析带来的无关 peer 快照差异。
- 按原 PER-04 序列在同一 renderer 做30次协作面板开关、6次项目/画布卸载重挂载，31个样本点强制 GC。`JSEventListeners` 仍从596增至1555（+959，高于149阈值）；活动interval 3→3；新进程重开、画布/Agent节点持久化通过。任务/命令/队列均为0，模型/供应商/fixture HTTP请求均为0。PER-04 仍失败，AGT-20261017-009 保持开放。
- EventTarget 弱引用审计显示补丁已阻止旧画布的 `body keydown/mousedown` 持续累积；但每次 canvas remount 后，旧的、已脱离文档的 `.node-standard-action-bar`、Agent字段、图片等DOM目标仍持有 React 事件监听器。最终样本中有5组 detached action bar 及配套目标，当前画布另有1组。监听器残留不再能归因于旧 FocusManager 回调；detached subtree 的保留根因还需定位，不能将该子修复记作整项通过。
- 执行manifest、31轮样本、执行/重开报告与截图见 `qa/agent-panel-churn-per04-fixed-v3/desktop/`。
- 补丁构建链补充：`pnpm install --frozen-lockfile --offline --ignore-scripts` 成功；`electron-builder --dir --config.directories.output=dist/agent-per04-patched-unpacked` 退出0。Windows x64 解包产物中的渲染器包包含 `handleKeyDownBound`/`handleMouseDownBound`，bundle SHA-256 `2788A8F8FA3059CC06F9CC55BF411CB05FC6C98452856AA8C6178A0A0C7B7BB3`；证据见 `qa/agent-panel-churn-per04-fixed-v3/desktop/packaged-build-manifest.json`。这是产物构建与依赖存在性检查，不升级 PER-04 桌面稳定性结论。
- 解包包启动烟测通过（run-20261017-agent-packaged-per04-smoke-v1）：以独立 `CANVAS_DATA_DIR` 与 Electron profile 启动新 Windows x64 包，首页完整加载、preload API 存在，页面标题为“无限画布创作平台”，窗口正常退出码0；Agent画布未启动，模型/供应商请求0。截图及SHA见 `qa/agent-packaged-per04-smoke-v1/`。此仅为REL-02启动/资源子场景，未执行M01/M03/M06/M08业务冒烟，不升级REL-02或PER-04主用例。
- 解包包新建项目与跨进程重开子场景通过（run-20261017-agent-packaged-per04-project-reopen-v1）：产品UI创建空白项目并打开tldraw画布，正常退出后第二个Electron进程自动重开同一项目，canvas/tldraw容器仍可见；两进程退出码均0，isolated data/profile使用，无模型/供应商/外部HTTP请求。证据见 `qa/agent-packaged-per04-project-reopen-v1/`。该子场景不包含Agent配置、任务执行及M01/M03/M06/M08流程，REL-02主用例保持未执行。

## PER-04 残留 DOM 弱引用诊断与补丁包 UI 复测（2026-10-17）

- 强制GC复测（run-20261017-agent-per04-dependency-patch-v4/v5）：两轮PER-04验收指标一致，`JSEventListeners`仍为596→1555（+959，高于149阈值），interval 3→3；无Agent任务、命令、队列、模型、供应商或fixture HTTP副作用；第二进程重开通过。复核发现v4/v5弱引用钩子只覆盖预热帮助函数，没有进入正式六轮卸载循环，不能据此判断正式循环中的旧Editor/DOM是否可回收。该诊断钩子范围问题已留档在v5 `diagnostic-integrity.json`；PER-04的原始监听器失败判定不受影响。
- 实际循环弱引用复测（run-20261017-agent-per04-dependency-patch-v6）：将弱引用跟踪移入正式六轮卸载循环。六个卸载周期中 `editorStore` 都已清空，但第30轮强制GC后6/6个旧Editor、旧 `.canvas-host`、tldraw容器、节点卡片、操作栏和文本框仍可达；脱离文档的Action Bar/Agent目标监听器持续增加。主判据仍为596→1555（+959，高于149阈值），interval 3→3；任务/命令/队列和模型/供应商/fixture HTTP副作用均为0，新进程重开通过。现可确认旧Editor与画布DOM子树确实被保留，但其实际强引用者仍未识别；PER-04/AGT-20261017-009继续失败/开放。证据及hash见 `qa/agent-panel-churn-per04-fixed-v6/desktop/execution-manifest.json`。
- 当前依赖补丁 Windows x64 解包包 Agent 配置 UI 子场景通过（run-20261017-agent-per04-patched-package-agent-ui-v1）：使用新解包包、独立 Electron profile及复制的合成 QA 项目；Agent、AI审核、状态机设置及输入输出面板检查通过，退出后新进程重开仍显示3类节点，两个进程均正常退出码0；外部HTTP/模型/真实供应商请求0。项目副本原本已有三个节点，此场景未执行Agent。证据截图、结果与 SHA-256 见 `qa/agent-per04-patched-package-agent-ui-v1/`。只证明当前补丁包基本配置面板/保存/重开可用，不覆盖 REL-02 的 M01/M03/M06/M08完整流程，也不改变REL-02主用例未完成状态。
- 两次首次UI脚本尝试分别碰到CDP页面可用性竞态和不属于当前验收项的历史辅助字段依赖，均保存在 `harness-*-first-attempt.json`；修正等待/移除历史字段读取后完成正式两进程UI子场景。它们登记为测试工具问题，不计产品失败。

## REL-02 / M08 项目包媒体与固定版本往返子场景（run-20261017-rel02-m08-package-media-v1）

- 以当前补丁版 Windows x64 解包应用和两组独立 `CANVAS_DATA_DIR`/Electron profile，先由源项目列表UI导出 `.canvasbundle`，再从目的实例产品“导入项目”文件选择器导入并打开。源夹具含一个合成 PNG 固定版本，并预置旧 `agentTask`、`nodeRun`、`nodeRunHistory` 事实；没有模型连接或凭据。
- 导出包 3,494 字节，SHA-256 `6FCF533067267846FED963265CAF5B6BF5D22A30D232946EA9087E4811758812`。ZIP含 `bundle.json`、`project.json`、`recipes.json`、`flow-assets.json` 和媒体字节；JSON字段扫描未发现 API key、secret、token 或 password 字段。
- 导入后目的项目ID为 `E8SgVbZIQ_la`，与源项目 `Ei03uj1FWE1L` 不同；Agent节点ID、媒体ID/路径、固定版本ID及资产ID均已重新生成。目的媒体文件 SHA-256 与源PNG相同（`6A8F6823587E92C061DBE33D73158941B8878AD3629EFBA8E4792442A38471B8`），固定版本 value digest 有效；`flowAssetRef`、`pinnedOutput` 与 `nodeResult` 指向目的媒体/版本。打开的画布包含3个节点且可渲染。
- 目的 `project.json` 中旧运行元数据已清理，所有节点 `exec.status=idle`；目的 SQLite 的通用 task、run、run artifact、Agent task、flow command task/command、审核提交、provider、model connection及model definition均为0。没有启动Agent或模型请求；一般启动HTTP未在本场景埋点，故不作零外网请求声明。
- 步骤5的媒体/固定版本/UI往返子场景通过；M08步骤1–4的保存阶段注错、强退/未知结果恢复、重试与重开仍未覆盖，M08与REL-02主用例保持未完成。完整断言见 `qa/agent-rel02-m08-package-media-v1/roundtrip-validation.json`，执行manifest与哈希见 `execution-manifest.json`，导入后画布截图见 `destination-imported-project-open.png`。

## R09 有界重复故障恢复子场景（run-20261017-r09-local-reliability-36-cycle-v1）

- `pnpm test -- test/r09-local-reliability.test.ts` 通过（1/1）。Electron-as-Node隔离worker执行14个进程阶段：初始unknown任务经历36次写临时文件/转正/更新数据库故障，分6个epoch，每个epoch重启worker并检查；六轮中任务数始终1、下载数1、未发布媒体0、项目/数据库版本不变、锁为0，底层故障后的任务状态仍为unknown/prepared。
- 恢复后模拟查询与下载一次性完成，固定媒体校验成功，显式发布后项目/数据库版本变为2；再由3个新进程重开，快照和媒体一致。模型生成/删除 mutation=0、意外网络请求=0；所有200条诊断记录均可解析，敏感标记扫描0命中，报告脱敏断言通过。
- 这是共享存储/视频物化层的有界fixture，不是打包应用UI或真实供应商验收，也不涵盖设备掉电；与已跳过的90分钟soak分开。REC-01/02主用例原状态不变，M08及REL-02仍未完成。执行manifest、逐epoch结果、诊断JSONL和Vitest摘要见 `qa/r09-local-20261016/soak/run-9HsafL/`。

## REL-03 旧手动执行器回归子场景（run-20261017-rel03-legacy-manual-run-v1）

- pnpm test -- test/manual-run.test.ts --reporter=verbose 通过（1个文件、15/15项）。覆盖手动节点共享执行路径、上游输入投影、运行目标及多选依赖闭包、文本扇出、失败旧输出隔离、迭代输入隔离、付费上游重跑确认，以及执行占用/重复流程保护。
- 该组为Vitest/jsdom renderer单元回归，没有启动Windows打包应用，也没有配置或调用真实供应商。它不覆盖旧图片、音频、视频工作流的桌面UI及真实人工验收，REL-03主用例仍保持未执行。
- 命令输出、运行时间、源码与证据SHA-256见 qa/agent-comprehensive/run-20261017-rel03-legacy-manual-run-v1/。

## R09 renderer 保存失败与显式重试子场景（run-20261017-rel02-renderer-save-recovery-v1）

- 当前源码Electron隐藏renderer在隔离目录注入 write-tmp、flush-tmp、promote-tmp、update-db 四种本地存储故障；均保留有效备份、失败状态未显示为已保存、workspace版本未提前推进。4次renderer重启后显式重试成功，图版本只前进1；10个保存开始事件与终结事件一一配对，诊断脱敏断言通过，模型请求为0。
- 这是REC-01/02共享保存层与重试子场景，使用当前源码Electron夹具；不等同于Windows项目包导出/导入UI故障注入，也不覆盖M08完整步骤或正式发行安装器验收。REL-02/M08完整项仍未完成。
- 各阶段报告、诊断日志、截图、运行时间及SHA-256见 qa/agent-comprehensive/run-20261017-rel02-renderer-save-recovery-v1/。

## M08 项目包传输层与强退恢复补充回归（run-20261017-rel02-transfer-regression-v1）

- 本地项目包传输相关3个Vitest文件全部通过（41/41）。覆盖固定图片/音频/视频字节和版本往返及身份重映射、损坏媒体在项目可见前拒绝、事务失败回滚、ZIP路径穿越拦截、Agent凭据剥离，以及 staging/promoted/transaction/committed 四个导入阶段强退后的恢复和幂等性。
- 这是本地文件系统与SQLite层回归，没有运行供应商、模型或付费请求；不包含Windows打包应用UI的导出/导入故障恢复，不替代M08完整验收，REL-02主用例仍未完成。
- 运行日志与输入源码/证据SHA-256见 qa/agent-comprehensive/run-20261017-rel02-transfer-regression-v1/。

## Agent runtime、协作与诊断定向回归（run-20261017-agent-runtime-diagnostics-v1）

- 5个本地测试文件共196/196项通过，关联 RUN-06、HUM-07、LOG-03、LOG-06、PER-03、PER-07。覆盖取消后的迟到响应不改终态、停止后迟到保存不产生输出回执、协作暂停后继续不重放、并行共享目标公平排空、诊断 drain 等待 IPC 确认，以及诊断队列压力/慢写失败下 Agent 仍正确完成。
- 这些是Vitest本地/合成fixture子场景，不包含完整桌面人工阈值、设备性能验收或系统日志导出评审；对应主用例状态不变。未调用真实供应商、付费服务或外部HTTP。
- 命令、源码与证据SHA-256见 qa/agent-comprehensive/run-20261017-agent-runtime-diagnostics-v1/。

## REL-02 / M08 Windows解包版损坏项目包导入负例（run-20261017-rel02-corrupt-import-ui-v1）

- 在独立 Electron profile 和 `CANVAS_DATA_DIR` 下启动当前 Windows x64 解包包，选取本地畸形 ZIP 文件 `invalid-project.canvasbundle`。两次导入均拒绝；第二次最新界面状态明确显示：`导入失败：ADM-ZIP: Invalid or unsupported zip format. No END header found`，项目列表仍为空。
- 诊断日志共记录两组 `project.transfer.started` / `project.transfer.failed`，各组 traceId/spanId 配对，失败码 `FLOW_TRANSFER_FAILED`，脱敏检查通过。应用退出后只读 SQLite 检查 projects/media/providers/model connection/model definition、通用 task 和 Agent task/command/review 均为0（内置skill版本3条）。真实供应商、付费provider和模型请求均为0；应用通用HTTP未全局埋点。
- 这是损坏 ZIP 在产品 UI 中的拒绝负例场景；不覆盖成功导入/导出或保存故障恢复，REL-02/M08主用例状态保持不变。结果、诊断摘要及SHA-256见 `qa/agent-comprehensive/run-20261017-rel02-corrupt-import-ui-v1/ui-corrupt-import-results.json`、`qa/agent-comprehensive/run-20261017-rel02-corrupt-import-ui-v1/transfer-event-summary.json`、`qa/agent-comprehensive/run-20261017-rel02-corrupt-import-ui-v1/execution-manifest.json`。
## REL-03 旧图片/视频/音频处理自动化子场景（run-20261017-rel03-legacy-media-transform-v1）

- `pnpm test -- test/image-edit-media.test.ts test/video-transform-real-media.test.ts test/video-transform.test.ts --reporter=verbose`：3个测试文件共45项，44通过、0失败、1项条件跳过。图片标注/遮罩2/2；真实本地FFmpeg/FFprobe媒体处理17/17；视频配置与执行器25/25。覆盖取帧/截取/提音/调速调声/缩略图/波形/快速人声分离、媒体输出记账与执行前错误路径。
- 媒体由本地测试夹具生成，执行真实本机FFmpeg/FFprobe；高质量人声分离器未安装，缺失提示路径通过；因FFmpeg/FFprobe已安装，缺工具守卫测试按条件跳过。未连接模型、真实供应商、付费provider或外网。
- 这是旧媒体处理器的自动化子场景，不是Windows产品UI上的旧项目端到端手工验收，未证明手动连线/执行/保存重开；REL-03主用例仍未执行。结果、完整Vitest日志及SHA-256见 `qa/agent-comprehensive/run-20261017-rel03-legacy-media-transform-v1/results.json`、`qa/agent-comprehensive/run-20261017-rel03-legacy-media-transform-v1/vitest-result.txt`、`qa/agent-comprehensive/run-20261017-rel03-legacy-media-transform-v1/execution-manifest.json`。
## REL-03 旧图片处理与真实像素变换回归（run-20261017-rel03-legacy-image-suite-v1）

- 8个测试文件共64/64通过，覆盖图片模型能力配置归一、裁剪/编辑节点输入与结果、遮罩/标注提示要求、透视映射和双线性采样、宫格拆分，以及真实PNG像素裁剪/透视/拆分、项目内资产写入与中途失败回滚。
- 使用本地合成PNG、canvas与隔离临时目录；provider能力项只断言静态配置，不发模型请求。模型/真实供应商/付费服务/外部HTTP请求均为0。
- 此组补强旧图片处理自动化证据，但不是Windows产品UI手动连线/执行/保存重开，也未覆盖Agent同目标gate/占用；REL-03主用例仍未执行。结果、完整Vitest日志及SHA-256见 `qa/agent-comprehensive/run-20261017-rel03-legacy-image-suite-v1/results.json`、`qa/agent-comprehensive/run-20261017-rel03-legacy-image-suite-v1/vitest-result.txt`、`qa/agent-comprehensive/run-20261017-rel03-legacy-image-suite-v1/execution-manifest.json`。
## REL-03 旧语音/TTS配置与协议回归（run-20261017-rel03-legacy-audio-suite-v1）

- 7个测试文件共62/62通过，覆盖语音/TTS配置归一化与序列化、音色克隆时长门禁、明确登记回执判定与超时语义、MiniMax异步合成tar产物解包、协议字段和音色来源溯源。
- 测试只使用固定响应/归档夹具及协议断言；没有发送供应商请求、模型请求、付费请求或外部HTTP。
- 这是音频路径的自动化子场景，不覆盖Windows产品UI里的旧项目手动配音、播放/保存/重开，也不覆盖Agent同目标gate/占用；REL-03主用例仍未执行。结果、完整Vitest日志及SHA-256见 `qa/agent-comprehensive/run-20261017-rel03-legacy-audio-suite-v1/results.json`、`qa/agent-comprehensive/run-20261017-rel03-legacy-audio-suite-v1/vitest-result.txt`、`qa/agent-comprehensive/run-20261017-rel03-legacy-audio-suite-v1/execution-manifest.json`。
### PER-03 最新合并结论（2026-10-17）

PER-03 主用例已升级为通过。四波、每波四个共享目标分支累计32次交付，精确FIFO首次交付顺序断言通过，最大活动交付数为1；16个等待样本 P50=77.70ms、P95=141.76ms，每波均在10秒内排空且无残留锁。单独的两进程强退复测在“已完成/等待/排队”检查点结束首进程；新进程恢复同一主控及子任务身份，unknown分支未重放供应商POST，等待分支终态后才运行排队分支，最终三支完成并释放共享锁，预算保持在上限内。

全部请求由合成模型和本地HTTP fixture提供（模型请求15、本地fixture请求12）；真实供应商、付费provider和外部网络请求为0。等待时间只描述本地合成fixture，不构成硬件负载性能结论；90分钟长驻runner未启动。证据：`qa/agent-comprehensive/run-20261017-per03-bounded-shared-target-v4/` 与 `qa/agent-comprehensive/run-20261017-per03-bounded-shared-target-v2/`。


### LOG-03 最新合并结论（2026-10-17）

LOG-03 主用例已升级为通过。独立Electron进程恢复同一 taskId，sessionId 发生变化；resume event 使用新的 operation traceId，`resumesTraceId` 指向持久化 task snapshot 的 traceId。决策计数从4增至5，重复 resume 后仍为5，已观察工具未重放。旧祖先trace未知的Agent视频恢复保留本地 taskId 并设置 `correlationMissing=true`，恢复完成且没有重复 supplier POST。该结论基于当前源码的定向集成和Electron fixture，不等同正式发行包UI验收。证据见 `qa/agent-comprehensive/run-20261017-agent-log03-primary-combined-v1/`。



### RUN-06 最新合并结论（2026-10-17）

RUN-06主用例已升级为通过。组合证据覆盖模型不响应Abort时仍有界超时、取消后释放的迟到模型完成不改终态输出、供应商SSE断流和非法工具JSON失败关闭，以及Electron画布上的可见失败和取消后迟到响应。

当前源码双进程桌面夹具注入HTTP 503后，画布显示“执行失败·运行失败”，任务保持AGENT_MODEL_FAILED并跨重开保存；第二个任务在决策请求中由画布停止，2.201秒后的本地服务端响应尝试发生在客户端连接关闭之后，任务跨重开仍为cancelled。两条桌面路径均没有处理器执行或Agent输出，故障/取消模型请求诊断各有配对终态，重开没有重放模型请求。

运行时故障组149/149、provider focused故障组2/2（runtime文件79/79）是分别留存的支撑运行，测试集合有重叠，不合并相加。桌面运行共4个本地模型/fixture请求、2个Electron进程、2个诊断session；真实供应商、付费provider和外部网络请求均为0。该桌面路径使用当前源码Electron验收夹具，未用正式发行包或真实供应商。

证据清单、结果摘要及SHA-256见 `qa/agent-comprehensive/run-20261017-agent-run06-primary-combined-v1/`；桌面原始报告和诊断见 `qa/agent-comprehensive/run-20261017-agent-run06-desktop-late-response-v4/`。最新主台账统计为通过102、未执行20、失败9、暂缓12、阻塞1；P0为通过89、失败6、未执行3、暂缓5、阻塞1。
### HUM-07 桌面补测历史失败（2026-10-17，v4；已由v7覆盖）

当前源码Electron两进程夹具确认，慢主控决策期间点击“暂停派发”后没有创建专业子任务或运行处理器；等待态“确认并继续”和“停止任务”两个入口可见且不同。点击“确认并继续”后，协调器再次运行失败，桌面诊断记录 `ASSET_SUBMISSION_CONFLICT`（协调器终态为 `FLOW_COORDINATION_FAILED`）。因此暂停边界通过，但继续路径失败，HUM-07主用例登记失败待修复；停止子场景在该失败后未执行，原有协调器单测2/2通过仍保留为补充证据。

本地合成模型/HTTP fixture请求3次；真实供应商、付费provider、外部HTTP均为0。该失败证据见 `qa/agent-comprehensive/run-20261017-agent-hum07-pause-stop-desktop-v4/`，manifest记录证据、源码、脚本与构建产物SHA-256。

### HUM-07 修复后桌面复测通过（2026-10-17，v7）

修复：协调器重新描述候选任务时，按当前项目和确定性 submission ID 查找已有固定资产提交回执；继续前仍先校验协调范围。暂停期间 renderer 保存导致 graphVersion 增长时，继续使用此前冻结的不可变输入引用，不重复提交或改换版本。`test/agent-flow-coordinator.test.ts` 的回归断言模拟了此保存边界并确认恢复前后模型收到同一固定输入版本。

当前源码 Electron 双进程夹具 v7 中，暂停发生在主控模型决策进行时；无子任务派发、无处理器执行，暂停/停止控件及等待态“确认并继续”/“停止任务”入口互相区分。明确继续后主控与两个专业任务正常完成，不重放工具或模型请求。另一个主控的停止决策在途时点击停止，任务保持 cancelled；本地fixture在客户端断开后才尝试回包，停止子任务不存在、处理器运行数为0。新进程重开后，已完成主任务和停止任务终态均保持，未出现重放。

模型/本地fixture请求各18次；真实供应商、付费服务、外部HTTP均为0。两条诊断session的生命周期配对及脱敏断言通过。定向协调器/资产回归63/63、Node/Web typecheck和Electron/Vite构建通过；v7执行与重开两阶段均通过。证据及源码/构建产物SHA-256见 `qa/agent-comprehensive/run-20261017-agent-hum07-pause-stop-desktop-v7/`。v5/v6中止点是隔离夹具前置条件及测试时序问题，过程和修正记录在该目录的 `attempt-history.json`，不作为产品缺陷计数。 最终合并构建的v8双进程复测再次通过，精确out/main构建树已随证据保存；主台账绑定v8，见 `qa/agent-comprehensive/run-20261017-agent-hum07-pause-stop-desktop-v8/`。

## 2026-10-17 MED-04 修复与边界专项复测

AGT-20261016-001 已修复：固定 A/V 审核证据除要求 `audioOffsetMs` 和 `audioEndDeltaMs` 正确外，还要求 `audioEndMs = audioStartMs + audioDurationMs`。此前“同时改结束时间和结尾差、但保留原音轨起点/时长”的矛盾证据现在在 schema 与保存审核媒体守卫两层均被拒绝；合法延迟音轨正例仍通过。MED-04 从失败更新为通过。

当前源码 Electron 媒体审核夹具的执行与第二进程重开均通过：正式审核按钮发送完整固定 PNG、完整规范化 WAV、同步 A/V 时间线及四个带时间戳的画面样本；新进程仍能读取三种固定审核回执，且模型请求没有重放。模型和本地 fixture 请求各5次，真实供应商、付费服务和外部HTTP请求为0；2个诊断session的脱敏及生命周期检查通过。证据与SHA-256见 `qa/agent-comprehensive/run-20261017-agent-med04-desktop-v1/`。

周边剩余用例继续补跑：6个边界/固定资产/诊断压力文件121/121通过，另一个媒体审核守卫文件4/4通过；共7个不同测试文件125/125。Node/Web typecheck和Electron/Vite构建通过。边界覆盖补强BLD-08的请求/范围约束、MED-04媒体证据校验、LOG-06 renderer drain和PER-07日志队列压力，但不替代未执行项所需的真实UI布局、人工诊断包查看、阈值评审或设备资源专项。完整日志、清单与SHA-256见 `qa/agent-comprehensive/run-20261017-agent-boundaries-med04-fix-v1/`。其余20项未执行主用例状态不因这些子场景自动升级；本轮统计为通过102、失败9、未执行20、暂缓12、阻塞1。

## 2026-10-17 SEC-02 自有原型键修复与主用例复测

AGT-20261016-003 已修复。`NodeExecuteCommandSchema` 在 Zod 对象解析前检查原始输入是否自有 `__proto__` 键，避免该键在对象解析时被移除后漏过 strict 校验。命令 IPC 返回 `FLOW_INPUT_INVALID` 和通用错误；`flow_commands` 无新增记录、renderer grant 未发送，返回体与诊断不包含原始键或字段值，全局原型未改变。

`node scripts/run-vitest.cjs run test/agent-flow-command-ipc.test.ts test/agent-flow-command-ledger.test.ts test/agent-flow-command-intent.test.ts test/agent-flow-command-executor.test.ts test/agent-flow-video-review.test.ts test/agent-flow-plan-request-boundaries.test.ts`：6个相关测试文件166/166通过；`pnpm run typecheck` 的 Node/Web 两部分通过。真实供应商、付费服务与外部HTTP请求为0。SEC-02主用例升级通过，主台账现在为103通过、8失败、20未执行、12暂缓、1阻塞；P0为90通过、5失败、3未执行、5暂缓、1阻塞。

随后重跑完整 `test/agent-flow` 范围，28个测试文件 / 544项全部通过；此前Agent Flow全回归中的SEC-02与MED-04三项失败均未再出现。该批是回归证据，不与前述定向断言重复累计；没有真实供应商、付费或外部HTTP请求。日志和清单见 `qa/agent-comprehensive/run-20261017-agent-flow-regression-after-sec02-med04-v4/`。

定向证据与SHA-256清单见 `qa/agent-comprehensive/run-20261017-agent-sec02-prototype-fix-v1/`。更早复现、失败回归仍按原始运行记录保留。


## 2026-10-17 SEC-08 输出复制修复与复测

AGT-20261016-004 已修复。根因包括 tldraw 全局 `.tl-container *` 禁止选文，以及节点捕获逻辑将拖选手势转为画布拖动。Agent、审核、建图只读结果文本现在覆盖为 `user-select: text` 并走专用可选文本指针策略：按下仍选中节点，后续选文交给浏览器，不启动画布拖动。日志、任务、执行及持久化路径未改变。

隔离浏览器 SEC-08 v4 全部检查通过：输出和审核反馈字面呈现、鼠标选区157字符、详情面板可打开/关闭、5000字符错误可见、无活动HTML标记、外链请求0、停止错误后任务仍等待。`test/node-pointer-policy.test.ts` 5/5通过，Node/Web typecheck通过。v1-v3的中间失败证据保留，v4结果及截图/SHA-256清单见 `qa/agent-comprehensive/run-20261017-agent-sec08-output-copy-fix-v4/`。

SEC-08主用例升级通过；该浏览器适配器不证明真实Electron IPC授权或独立人工验收。其后LOG-04与AST-05修复后，当前全表为106通过、5失败、20未执行、12暂缓、1阻塞；P0为93通过、2失败、3未执行、5暂缓、1阻塞。
## 2026-10-17 LOG-04 错误栈脱敏修复与诊断 ZIP 复测

AGT-20261017-006 已修复。`safeStack` 不再保留异常 message 原文；只保留受控错误类型、经脱敏的栈帧，并将调用方提供的 `privateValues` 传入栈帧脱敏。诊断事件、错误码、业务事件生命周期未增加字段或改变；既有错误消息字段仍按安全属性规则处理。

通过 `DiagnosticsProducer → diagnostics service → ZIP` 集成路径分别导出 `agent.runtime.completed` 与 `agent.runtime.failed` 事件，错误包含合成 prompt、response、media/base64 与假凭据标记。ZIP的 `manifest.json`、`events.jsonl`、`summary.txt`、`coverage.json` 均未出现任何标记；失败事件仍保留 task/project/node 身份、安全错误码和受控错误类型。`test/observability` 7文件54/54通过；Node/Web typecheck通过。真实Agent运行、真实供应商、付费服务及外部HTTP请求均为0。

覆盖边界：此处记录当前源码诊断生成/存储/导出集成验收，成功/失败由合成生命周期事件表示；当时实际产品运行级步骤尚未执行。该剩余步骤已由2026-10-18正式包补测完成，连同此处safeStack修复回归，现满足LOG-04整项范围。证据与SHA-256见 `qa/agent-comprehensive/run-20261017-agent-log04-stack-fix-v1/` 及后续正式包记录。

## 2026-10-17 AST-05 多成果输出集合修复与双进程复测

AGT-20261017-010 已修复。Agent executor 现在把 `flow.agent-output-set` 当作有序固定引用集合验证：对比任务结果引用与输出集合引用，按项目读取每个固定版本，核对版本身份和资产类型，再按共享投影规则重算集合；全部验证通过后分别物化固定成果节点。单成果路径仍按既有固定值比对。普通 JSON 节点可消费完整集合，不再要求聚合 JSON 等于任意单一资产值。

当前源码隔离 Electron 双进程验收通过：Agent按序执行两个授权 processor，产生两个不同 versionId 的固定文本成果；Agent `out-json` 保留顺序和引用，普通 JSON 下游成功并保存相同集合。第二 Electron 进程重开后 taskId、两引用、Agent/JSON节点各一条运行历史及正文均一致，`modelReplay=false`。模型fixture请求5次，真实供应商、付费服务和外部HTTP请求均为0；诊断双session扫描通过。输出集合定向测试12/12、`test/agent-flow` 回归28文件545/545、Node/Web typecheck、定向ESLint及 electron-vite build 均通过。证据与SHA-256见 `qa/agent-comprehensive/run-20261017-ast05-output-set-fix-v3/`。

v1尝试在物化修复成功后被测试夹具错误地要求 processor 来源端口为 `out-text`；实际节点契约为 `out-value`。修正夹具后v2/v3完整通过。原失败尝试保留在对应run目录，不计作产品失败。

## 2026-10-17 CFG-03 无模型启动前置拦截修复与打包复测

AGT-20261017-005 已修复。Renderer 在无模型配置时先读取现有 Agent 任务事实；若不是可继续的 waiting/blocked 任务，提示用户先选择决策模型，并在 `ensureCanvasSaved`、队列/工作流准入和任何执行状态更新之前返回。工作流入口也会在置为 running 或发出 workflow.started 前检查 Agent 决策模型。

`test/observability/executor-events.test.ts` 与 `test/manual-run.test.ts` 共 22 项通过；Node/Web typecheck、构建和 Windows x64 解包版构建通过。当前源码解包版隔离项目点击“启动任务”后显示缺模型提示，点击前/后完整比较 Agent exec、nodeRun、nodeResult、agentTask 均未变化；点击后应用关闭前没有新增诊断事件，模型请求/Agent任务/供应商/外部HTTP均为0。应用退出期间单独观察到 project.save.started/completed；它只出现在 app.session_ended 之前、关闭后的事件快照中，不属于点击前置拦截期间。夹具原本已有 exec.status=failed，因此通过比较全状态未变判断，不将其误当作新增失败状态。

证据与SHA-256见 `qa/agent-comprehensive/run-20261017-cfg03-no-model-preflight-v1/`；首次夹具状态比较与启动/关闭事件误归因尝试也单独留存。CFG-03整项仍未完成：禁用模型及缺少工具/模态的组合尚未执行，所以只将主台账状态从失败改为未执行，并将“Windows解包版UI / 无模型时启动Agent”子场景登记通过。更新后整表为106通过、4失败、21未执行、12暂缓、1阻塞；P0为93通过、1失败、4未执行、5暂缓、1阻塞。

## 2026-10-17 REC-03 损坏项目提示与诊断导出修复复测

AGT-20261017-007 已修复。项目记录仍存在但主快照和备份都无法读取时，主进程发出受限字段的 `project.open.failed` 事件；渲染层返回首页后保留错误提示和诊断包导出入口。诊断导出按失败发生时间筛选，并在查询前 flush 已接收的事件队列，确保刚发生的打开失败可进入 ZIP。

当前源码 Windows x64 解包版隔离复测通过：启动时/点击项目时均显示错误，首页“导出诊断包”按钮可达；经实际系统保存对话框导出诊断 ZIP，包含 `manifest.json`、`events.jsonl`、`summary.txt`、`coverage.json` 和 `project.open.failed` 事件。扫描未发现损坏快照标记或绝对路径。空图异步/同步保存都以 `SAVE_FAILED` 拒绝，主快照与备份 SHA-256 均未变化，外部请求/真实供应商/模型/命令均为0。

`test/observability/diagnostics-storage.test.ts` 与 `test/observability/schema.test.ts` 共28/28通过；Node/Web typecheck、Electron/Vite build、Windows x64解包包构建通过。报告、首页/打开截图、ZIP、session JSONL 和 SHA-256 清单见 `qa/agent-comprehensive/run-20261017-rec03-recovery-ui-v2/`。REC-03更新为通过；整表现为107通过、3失败、21未执行、12暂缓、1阻塞；P0为94通过、0失败、4未执行、5暂缓、1阻塞。

## 2026-10-17 CFG-04 保存边界与 CFG-06 异常配置恢复修复复测

AGT-20261017-008 和 AGT-20261016-002 均已修复。主进程在异步项目保存、关窗同步保存及恢复副本保存之前，对 Agent 配置调用共享 `AgentNodeConfigSchema`；非法输入不进入 repository，也不推进图版本。受限 `project.save.failed` 日志允许 `phase=validate-agent-config` 与稳定 `code=INVALID_AGENT_CONFIG`，不携带配置正文或字段值。CFG-06 对 schema 拒绝的配置使用完整类型默认值安全呈现；画布上明确阻止执行并提供配置修复入口，设置面板明确要求先显式恢复默认配置，保存按钮不能静默覆盖异常权限。

CFG-04 的 Electron ABI 集成回归使用真实临时 SQLite、正式 `IPC.project.save` handler 和 `projects.repo`：maxSteps=0/65 与 maxParallelTasks=0/5 四种输入全部以 `INVALID_AGENT_CONFIG` 被拒绝，项目图版本仍为0且没有节点写入；maxSteps=1/64 与 maxParallelTasks=1/4均成功保存、重开并推进至版本1。配套异步、同步、恢复副本、快照和图格式IPC回归与事件 schema 共37/37通过。CFG-06 Windows x64解包版三种损坏输入均保持画布可见且没有页面异常；三个项目都经显式恢复默认配置并保存，graph与tldraw snapshot的Agent配置一致且通过结构检查，进程退出码均为0。Node/Web typecheck、Electron/Vite build和Windows解包包构建通过。没有模型、供应商或外部HTTP请求。

证据和复现脚本见 `qa/agent-comprehensive/run-20261017-cfg04-cfg06-current-v1/`；初次测试报告中的失败运行仍保留作修复前基线，不计入当前回归。更新后144项主台账为109通过、1失败、21未执行、12暂缓、1阻塞；P0为94通过、0失败、4未执行、5暂缓、1阻塞。唯一仍失败项为PER-04；CFG-03、REL-02、REL-03、REL-08等未执行项和长周期/手工条件仍未完成。


## 2026-10-17 CFG-03 禁用模型正式桌面复测（修复前失败记录）

从原始无模型验收数据新建隔离副本，在本机SQLite中插入一个 `enabled=0`、声明 `text.generate` 的模型；Agent配置包含合法 `node.execute@1` 和一个授权本地处理节点。Windows x64解包应用显示“所选文本模型不可用”，主进程失败码为 `AGENT_MODEL_UNAVAILABLE`；模型请求、真实供应商请求及renderer外部HTTP请求均为0，应用退出码0。

但CFG-03的严格判据要求在任何本地副作用前拒绝。点击后已发生5次项目保存（graphVersion 40→45）、`workflow.started`、`workflow.task_queued`、`workflow.task_admitted`、`node.started`/`node.failed`，并在SQLite写入一个 `blocked` 任务，code=`AGENT_MODEL_UNAVAILABLE`。因此禁用模型参数判失败，登记AGT-20261018-011；无模型参数子场景仍通过，缺少工具能力与图像/音频/视频能力参数尚未执行。关闭应用时graphVersion再同步到46，该关闭期保存单独记录。

正式证据：`qa/agent-comprehensive/run-20261018-cfg03-disabled-model-final-v1/execution-manifest.json`、`packaged-cfg03-disabled-model-results.json`、`postrun-state.json`、启动与结束截图及隔离诊断session。此前 `run-20261018-cfg03-disabled-model-v1` 的试错运行因夹具缺合法工具、授权目标或tldraw shape字段而排除，不用于产品判定。

## 2026-10-18 CFG-03 前置模型校验修复与桌面复测

修复在保存或启动工作流前只读核对 Agent 决策模型目录：模型必须存在、已启用、声明 `text.generate`，其连接也必须启用且使用支持的协议。检查接入Agent卡片手动启动、全图运行、子图运行、节点测试入口；缺模型仍由既有任务状态守卫处理。首轮全量回归暴露普通无Agent画布因空目录异步检查而延后设置 `starting` 的既有时序断言；现仅对含Agent的画布查询目录，手动入口仍在确认前预留 `starting`。修正后 `test/manual-run.test.ts` 与 `test/observability/executor-events.test.ts` 定向复测25/25通过。`run-mWEeO7` 全量验证中，`npm run verify` 退出码0；187个Vitest文件、2,343项通过、1项跳过，模型运行时2/2、日志门禁、浏览器优化UI门禁、Electron/Vite构建及全部Agent桌面集成通过。

以最新源码重新构建 Windows x64 `win-unpacked` 包后，隔离桌面用例复测两种参数：① 模型 `enabled=0`，但声明 `text.generate`；② 模型 `enabled=1`，仅声明 `image.generate`。两个子场景均显示“所选文本模型不可用，请检查模型设置”，点击期间没有项目保存、工作流/节点事件、任务、命令、模型请求或renderer外部HTTP；`exec` 前后保持 idle。应用关闭后可见项目同步保存事件，这是关窗期间的保存，不属于点击阶段；关窗后检查SQLite任务/命令均为0，Agent仍为idle且无 `nodeRun`。

Windows包、结果、启动/结束截图、隔离诊断及逐文件哈希见 `qa/agent-comprehensive/run-20261018-cfg03-disabled-model-preflight-v1/execution-manifest.json` 和 `qa/agent-comprehensive/run-20261018-cfg03-wrong-model-capability-v1/execution-manifest.json`。此前禁用模型准入失败仍保留在上一节作为修复前基线，AGT-20261018-011已关闭。缺少工具能力、图像/音频/视频模态参数和审核启动组合尚未执行，因此CFG-03主用例仍记未执行。

144项当前状态：110通过、0失败、21未执行、12暂缓、1阻塞；P0：94通过、0失败、4未执行、5暂缓、1阻塞。PER-04已通过稳定预热复测。长周期、人工、资源配额、签名/干净安装和真实供应商条件仍未完成。

## 2026-10-17 PER-04 堆快照诊断范围更正

新增同一renderer强制GC后30轮复测与约63MB堆快照。CDP仍为596→1555（+959，阈值149），活动interval为3→3，第二进程重开通过。旧Editor对象均在堆快照中；可见的保留路径包含Window监听器审计表中的 `onKey`、`onPointerUp` 与 `onTaskUpdate` 闭包。对应产品effect源码中存在匹配的removeEventListener清理，当前尚未解释为何卸载后仍保留，不能把调用点视为已定位根因。

对旧DOM对象的最短路径经过测试探针 `activeByTarget` WeakMap。当前离线快照分析器将V8 WeakMap ephemeron内部边当作强边遍历，因此这些DOM路径不是有效的强引用证明；此结论不影响PER-04监听器增长失败判定。原始快照、对象ID、分析脚本及retainer输出见 `qa/agent-comprehensive/run-20261018-per04-heap-v4/desktop/`。PER-04根因仍未定位。

## 2026-10-17 REL-04 SQLite 数据库迁移补充子场景

定向运行 `pnpm test -- test/db-migrations.test.ts --reporter=verbose`，7/7通过。覆盖空库逐级迁移、v1只补缺失迁移、拒绝高于当前应用支持版本的SQLite数据库，以及真实SQLite事务失败回滚、版本号不推进和修正后安全重跑。模型、供应商和外部HTTP请求均为0。证据见 `qa/agent-comprehensive/run-20261018-rel04-db-migration-v1/`。

范围限制：这只验证应用内SQLite数据库schema迁移，不覆盖旧 `.canvasbundle` 或旧项目快照格式导入、迁移后的业务路径或打包产品UI。因此REL-04主用例仍未执行；144项主用例当前汇总为110通过、0失败、21未执行、12暂缓、1阻塞；P0统计不变。
## 2026-10-17 BLD-08 Builder 预览布局补充子场景

定向运行 `pnpm test -- test/agent-flow-builder.test.ts --reporter=verbose`，23/23通过。布局断言验证有既有节点占位时，预览坐标保持有限且提案节点避开该节点；同文件Builder host相关回归也通过。纯本地 fixture，无模型、供应商或外部HTTP请求。证据见 `qa/agent-comprehensive/run-20261018-bld08-builder-layout-v1/`。

范围限制：这是布局算法/host级测试，不覆盖窄窗口的打包UI可见性、人工布局检查或模型/供应商设置控件，BLD-08主用例仍未执行。主用例统计不变；本轮只新增补充证据。
## 2026-10-17 BLD-08 Builder 预览双进程桌面补充子场景

`pnpm run test:agent-flow-builder` 当前源码 Electron fixture 两阶段通过。预览时公共按钮生成有界提案，幽灵节点位置和typed edges与host一致，未修改画布且必须显式提交；新进程恢复后提交完整图，重复提交不产生重复节点，随后两个专业Agent通过公共执行器成功处理文本。诊断双session脱敏通过。本次仅向本机确定性模型fixture发出15次请求；真实供应商与付费服务请求为0；一般renderer外部HTTP未全局埋点。证据和hash见 `qa/agent-comprehensive/run-20261018-bld08-builder-desktop-v1/`。

范围限制：该harness使用源码renderer和当前编译的Electron入口，不是Windows解包发行包；未覆盖窄视口、设置控件或人工视觉验收。BLD-08主用例仍未执行，主用例汇总保持不变。
## 2026-10-17 SKL-07 Skill 选择与打包UI持久化补充子场景

Windows x64解包包隔离数据三进程验收通过：`material-analysis@1` 初始为勾选；取消后保存，重开仍未勾选；重新勾选并保存后，第三个独立Electron进程重开仍显示勾选，SQLite中的配置绑定保持`material-analysis@1`。3次退出码均为0；只读数据库检查 `integrity_check=ok`，Agent任务、命令、普通任务、运行、模型连接和供应商记录均为0。没有启动Agent，因此未观察执行时绑定的Skill内容hash，SKL-07主用例仍未完成。

网络边界：renderer尝试加载1,122个tldraw CDN资源请求，全部以CSP失败；测试同时用Chromium非loopback DNS阻断和Playwright HTTP(S)路由拦截，未联系外部端点。无模型、供应商或付费请求。证据及hash见 `qa/agent-comprehensive/run-20261018-skl07-ui-toggle-v5/`。本补充不改变主用例统计。

## 2026-10-18 CFG-07 节点指针与画布交互定向单测补充

定向运行 pnpm test -- test/node-pointer-policy.test.ts test/canvas-interaction.test.ts test/canvas-ui-interactions.test.ts --reporter=verbose，3个文件28/28通过。覆盖节点标签/空白区surface归属、编辑字段与真实控件的指针策略、画布创建/拖动/连线/标题交互，以及小地图和连接点交互契约。全程使用本地单测，未启动应用；模型、供应商、付费及HTTP请求均为0。

范围限制：这些是源码策略/契约断言，不等于打包产品实际的拖拽、双击编辑、IME、完整Tab/Esc、按钮及下拉验收。CFG-07主用例仍未执行；144项主用例当前汇总为110通过、0失败、21未执行、12暂缓、1阻塞；P0统计不变。证据见 qa/agent-comprehensive/run-20261018-cfg07-pointer-policy-v1/。

## 2026-10-18 SKL-07 运行时固定Skill快照补充

精确筛选运行 agent-flow-runtime 的任务内容固定用例，1项通过、其余78项由筛选跳过。协作任务进入等待后，禁用已绑定v1并导入内容不同的v2；原任务恢复并完成，结果中的Skill快照与更新前完全一致。全程本地runtime fixture，真实模型、供应商、付费和HTTP请求均为0。

范围限制：这验证运行时快照不会随Skill库后续变化而漂移，不是打包产品UI的任务绑定哈希端到端比对。SKL-07主用例仍未执行，主用例统计不变。证据见 qa/agent-comprehensive/run-20261018-skl07-runtime-pin-v1/。

## 2026-10-18 PER-05 取消后的晚到模型回包定向单测补充

精确筛选 runtime 取消用例，1项通过、其余78项由筛选跳过。请求取消后，迟到的模型完成被拒绝，任务终态事实保持不变，也不发布迟到结果。仅使用本地runtime fixture，真实模型、供应商、付费和HTTP请求均为0。

## 2026-10-18 PER-05 可见停止反馈与延迟响应断连补充

在桌面协调Agent夹具中，对公开“停止任务”按钮进行20次独立进程采样，测量点击到卡片可见“已停止”状态：最小151 ms，中位数156 ms，最近秩p95 168 ms，最大196 ms；独立轮询的持久任务取消事实p50 158.5 ms、最近秩p95 187 ms、最大205 ms。20/20运行通过，任务均保持cancelled、没有创建子任务/processor执行。每轮在取消后保持窗口运行2.4秒，延迟供应商fixture再尝试响应；客户端连接已关闭，任务没有复活。模型fixture每轮请求18次，真实模型/供应商/付费/外部HTTP请求均为0。样本逐轮证据及汇总见 `qa/agent-comprehensive/run-20261018-per05-stop-latency-samples-20/`；计时夹具位于 `src/main/agent-flow/desktop-electron.ts`。

范围限制：性能阈值尚未冻结，因此这些延迟及20样本最近秩p95仅作描述，不判定达到产品性能阈值。取消关闭了客户端连接，供应商延迟响应只证实在窗口仍开着时无法送达，不等于测试了取消后完整模型响应仍能到达应用并被消费。PER-05主用例仍未执行，主用例统计不变；晚到模型完成拒绝的本地runtime单测证据仍见 `qa/agent-comprehensive/run-20261018-per05-late-reply-v1/`。

## 2026-10-18 REL-02 Windows解包包 M03 建图提案补充子场景

正式 Windows `win-unpacked` 包通过隔离双进程验收。使用仅监听 `127.0.0.1` 的确定性模型 fixture，应用依次完成 `probe_echo`、`probe_done` 和 `propose_flow` 三次请求。Builder 生成7节点/5边的提案时，项目图保持不变；点击公共“提交图变更”后，画布成为11节点/5边，构建状态为 `committed`。第二个独立进程重开后，项目图及已提交状态一致；两个进程退出码均为0。只读 SQLite `integrity_check=ok`，flow_agent_tasks、flow_commands、tasks、runs、providers计数均为0；renderer外部请求、真实供应商调用及付费请求均为0。

边界：此结果只覆盖打包产品的M03 Builder预览、显式提交和重开子场景；没有执行生成的流程，也未覆盖M01、M06、M08。REL-02完整主用例仍为未执行，汇总统计不变。执行清单、结果、只读审计、截图、日志及SHA-256见 `qa/agent-comprehensive/run-20261018-rel02-m03-package-v4/`。

## 2026-10-18 REL-02 Windows解包包 M01 Agent执行补充子场景

正式 Windows `win-unpacked` 包通过公共 Agent 卡片入口完成 M01 文本执行。隔离项目绑定一个仅授权的本地 processor 和确定性 loopback 模型 fixture；模型先完成2次能力探测，再发出2次决策请求。Agent任务以 `completed` 结束，执行2次决策和1个工具调用；唯一 `node.execute` 命令已提交，processor 的 `out-value` 固定版本及画布资产正文均为“M01已整理：M01 固定输入：保留证据中的关键事实。”。第二个独立 Electron 进程重开后，同一 taskId、完成状态和固定输出仍存在，模型请求没有重放；两个进程退出码均为0。只读 SQLite `integrity_check=ok`，Agent任务1条、命令1条、固定资产版本2个、供应商记录0；外部请求、真实供应商和付费请求均为0。运行包版本1.0.0，SHA-256为 `2e275ed2b62eb77a6579136813ae42fc362226469d99e54d7986e447dfa8ed61`。

边界：这是打包产品中单个 Agent、一个本地文本处理器的 M01 执行与重开子场景，模型语义由本地确定性 fixture 提供。它不覆盖真实供应商模型质量、M06审核/返工或M08项目包导入导出。REL-02完整主用例仍未执行，主汇总统计不变。v1/v2夹具尝试因缺少画布绑定记录和错误的输出落点断言而排除；详情见该目录的 `attempt-history.json`。最终证据、只读审计、截图与SHA-256见 `qa/agent-comprehensive/run-20261018-rel02-m01-package-v3/`。

## 2026-10-18 REL-02 Windows解包包 M06 审核与有界返工补充子场景

正式 Windows `win-unpacked` 包 v1.0.0 通过隔离双进程验收（包 SHA-256：`2e275ed2b62eb77a6579136813ae42fc3622264699d99e54d7986e447dfa8ed61`）。从公共协调 Agent 入口运行已提交的 M03 生成图：首轮固定版本审核拒绝（revision 0），负责人 Agent 完成一次有界返工后第二轮通过（revision 1）；审核通过前，下游专业 Agent 未执行。协调任务及三个 Agent task 均为 `completed`，三条 `node.execute` 命令均为 `committed`。第二个 Electron 进程恢复相同 task、审核事实和命令，模型请求没有重放；两个进程退出码均为0。

只读 SQLite `integrity_check=ok`；`flow_agent_tasks=3`、`flow_commands=3`、`flow_command_tasks=3`、`flow_asset_versions=8`、`flow_reviews=2`、`flow_coordination_runs=1`、`flow_coordination_events=11`，普通 `tasks`/`runs`/`providers` 均为0。本机 loopback fixture 共13次请求，外部请求尝试、真实供应商调用及付费请求均为0。

范围边界：首轮拒绝及第二轮批准由确定性本机审核 fixture 预设，只验证控制流与固定版本持久化，不代表真实审核语义或质量。为聚焦审核/返工路径，第二个生成的 Agent 在隔离项目克隆中设置为 `autonomous`，未覆盖人工等待/确认路径。REL-02 的 M01、M03、M06 正式包补充子场景已有证据；M08 仍缺正式包保存故障、强退与恢复组合验收，故 REL-02 主用例保持“未执行”，144项主用例汇总及 P0 统计不变。证据、SHA-256 清单、只读审计、尝试记录和两张运行截图见 `qa/agent-comprehensive/run-20261018-rel02-m06-package-v4/`。

## 2026-10-18 REL-02 Windows解包包 M08 write-tmp 故障与显式重试补充子场景

正式 Windows `win-unpacked` 包 v1.0.0（SHA-256：`2e275ed2b62eb77a6579136813ae42fc3622264699d99e54d7986e447dfa8ed61`）在隔离导入项目副本中通过一个 M08 保存检查点。第一进程停留在首页；经 renderer 暴露的公共 `saveProject` IPC 尝试保存时，在 `project.json.tmp` 写入阶段注入目录冲突。调用返回 `SAVE_FAILED`，诊断记录 `phase=write-tmp`、`STORAGE_WRITE_FAILED`；主 `project.json`、`.bak` 与 SQLite graphVersion=1均未改变。清除故障后显式重试成功，graphVersion升至2；`.bak` 保留原有效主快照，新标题同时写入项目图和tldraw快照。第二个Electron进程从产品UI打开项目并读回新标题；固定媒体哈希及1条固定资产版本保持不变。两个进程退出码均为0，诊断 session 均 `ended=true`。

只读 SQLite `integrity_check=ok`；任务、运行、命令、Agent task、审核、模型连接及供应商记录均为0。模型请求、renderer外部HTTP尝试、真实供应商及付费请求均为0。审计与13个文件的SHA-256清单、两张截图见 `qa/agent-comprehensive/run-20261018-rel02-m08-package-save-write-v3/` 与 `qa/agent-comprehensive/run-20261018-rel02-m08-package-save-update-db-v2/`。

范围边界：本次只覆盖 `write-tmp` 一个保存故障点、显式重试、旧快照备份和第二进程UI重开。未覆盖 `flush-tmp`、`rotate-bak`、`promote-tmp`、`update-db`、媒体落盘故障，也未覆盖“供应商已接受但无回执”或“命令已提交但未呈现”的强退/unknown核对。v1/v2夹具问题及排除理由保存在 `attempt-history.json`。M08和REL-02主用例仍未完成；144项主用例统计及P0统计不变。

## 2026-10-18 REL-02 Windows解包包 M08 update-db 故障与回滚补充子场景

正式 Windows `win-unpacked` 包 v1.0.0（SHA-256：`2e275ed2b62eb77a6579136813ae42fc3622264699d99e54d7986e447dfa8ed61`）在隔离项目副本中通过 M08 `update-db` 保存检查点。通过仅存在于测试数据库副本中的SQLite触发器，在项目快照已完成文件写入、flush、备份轮转和promote后拒绝graph_version更新。公共 `saveProject` IPC 返回 `SAVE_FAILED`，诊断记录 `phase=update-db`、`STORAGE_WRITE_FAILED`、`rollbackFailed=false`。主 `project.json` 恢复为基线哈希，graphVersion保持1，临时文件被清理。回滚将原有效 `.bak` 恢复到主文件，因此失败后 `.bak` 路径暂时不存在；解除触发器并显式重试后，graphVersion升至2，`.bak` 重新生成且哈希等于原有效快照。第二个Electron进程从产品UI打开项目并读回更新标题；媒体哈希及固定版本数量不变。两个进程退出码为0，诊断session均 `ended=true`。

只读 SQLite `integrity_check=ok`；任务、运行、命令、Agent task、审核、模型连接及供应商记录均为0。模型请求、renderer外部HTTP尝试、真实供应商和付费请求均为0。执行清单、只读审计、尝试记录和两张截图见 `qa/agent-comprehensive/run-20261018-rel02-m08-package-save-update-db-v2/`。

范围边界：只覆盖 `update-db` 单一故障点、回滚、显式重试、备份重建和第二进程UI重开。触发器仅作用于隔离测试数据库，不改正式代码。v1夹具因错误假设回滚后 `.bak` 路径仍存在而在重开前中断；v2已修正判据并完成完整复测，过程见 `attempt-history.json`。其余M08保存/媒体故障及“已接受未回执/已提交未呈现”强退与unknown核对未覆盖，故M08和REL-02主用例仍未完成，144项主用例及P0统计不变。

## 2026-10-18 REL-02 Windows解包包 M08 rotate-bak 故障与显式重试补充子场景

正式 Windows `win-unpacked` 包 v1.0.0（SHA-256：`2e275ed2b62eb77a6579136813ae42fc3622264699d99e54d7986e447dfa8ed61`）在隔离项目副本中通过 M08 `rotate-bak` 保存检查点。测试夹具将原 `.bak` 暂存后以同名空目录占位，使产品公共 `saveProject` IPC 在备份轮转阶段返回 `SAVE_FAILED`；诊断事件为 `phase=rotate-bak`、`STORAGE_WRITE_FAILED`、`rollbackFailed=false`。失败后主 `project.json` 哈希不变，graphVersion保持3，`.tmp`已清理。移除目录并恢复原备份后，显式重试成功，graphVersion升至4，旧主快照进入 `.bak`。第二个正式包进程自动恢复画布，节点标题与tldraw快照均读回新值；固定媒体哈希及1条固定资产版本不变。两个进程退出码均为0，诊断session均 `ended=true`；只读SQLite `integrity_check=ok`，模型请求、外部HTTP尝试、供应商及付费请求均为0，普通任务/运行/命令/Agent任务/审核/provider记录为0。

范围边界：只覆盖 `rotate-bak` 一个保存故障点、回滚、显式重试和第二进程UI重开；不升级M08或REL-02主用例。v1夹具复现了产品失败和成功重试，但因第二进程自动打开画布，测试器误等项目列表而未核验重开；已保留输出及停止本轮隔离进程。v2修正UI判据后完整通过，尝试历史与哈希清单见 `qa/agent-comprehensive/run-20261018-rel02-m08-package-save-rotate-bak-v2/`。后续 `flush-tmp` 与 `promote-tmp` 正式包补充子场景均已通过；M08媒体故障补充子场景已通过；仍缺“已接受未回执/已提交未呈现”强退与unknown核对。REL-02主用例仍未执行，144项与P0统计不变。
## 2026-10-18 REL-02/M08 源码保存故障与公共IPC诊断定向复测

`pnpm test -- test/project-save-storage-failure.test.ts test/project-save-storage-ipc.test.ts --reporter=verbose` 通过：2个测试文件、25/25项。确定性fs mock覆盖 `write-tmp`、`flush-tmp`、`rotate-bak`、`promote-tmp`、`update-db` 失败和回滚；公共IPC测试覆盖异步/同步图保存及工作台保存的安全诊断映射、失败不误报成功、诊断sink异常隔离。fixture不启动正式包、模型、供应商或外部服务。

边界：这是当前源码下的存储层与IPC定向测试，不能替代正式Windows包的对应故障注入或REL-02主用例。证据与源码SHA-256见 `qa/agent-comprehensive/run-20261018-rel02-m08-source-storage-failure-ipc-v1/`；REL-02主用例仍未执行，144项与P0统计不变。

## M08 正式包 `flush-tmp` / `promote-tmp` 注错尝试（排除，不计结果）

外部Windows文件属性/句柄无法稳定卡在产品同步保存的 `flush-tmp` 或 `promote-tmp` 调用前。`flush-tmp` v1在保存前等待夹具导致测试器超时、产品请求未发起；v2监听与保存并发后未能及时捕获临时文件，产品在隔离副本中成功提交（graphVersion 3→4）；v3的只读属性跟随临时文件转正，保存仍成功；`promote-tmp` v1的无删除共享句柄也未及时捕获，保存正常成功。上述目录保留了脚本、结果及过程记录，分别见 `qa/agent-comprehensive/run-20261018-rel02-m08-package-save-flush-tmp-v1/`、`qa/agent-comprehensive/run-20261018-rel02-m08-package-save-flush-tmp-v2/`、`qa/agent-comprehensive/run-20261018-rel02-m08-package-save-flush-tmp-v3/` 与 `qa/agent-comprehensive/run-20261018-rel02-m08-package-save-promote-tmp-v1/`。它们均为隔离数据副本；这些早期尝试不构成产品失败，也不算故障注入通过。随后 `flush-tmp-v8` 与 `promote-tmp-v2` 均通过本机 loopback Node inspector 在正式包进程内精确注入一次故障，分别验证回滚、显式重试和第二进程重开；早期失败尝试不计入通过数。

## REL-03 自动化复跑调用错误（排除，不计结果）

19文件定向复跑因PowerShell参数转发多带一个字面量 `--`，Vitest脚本筛选器未生效并启动默认测试集合。发现后停止了该次 `run-vitest` 进程树；部分日志没有最终摘要，全部保留但不接受为REL-03证据，也不计入通过数。记录见 `qa/agent-comprehensive/run-20261018-rel03-legacy-automated-rerun-v1/`。该次未修改生产源码或正式包数据。
## 2026-10-18 REL-03 旧手动执行与多模态本地自动化定向复跑

直接筛选命令运行19个Vitest文件：`manual-run`共享执行器、图片工作流/像素变换、视频变换以及Speech/TTS协议和来源fixture。结果185项通过、1项跳过、0失败；使用本地确定性数据与媒体，不调用真实供应商、付费服务或外部网络。命令输出、源文件哈希和manifest见 `qa/agent-comprehensive/run-20261018-rel03-legacy-automated-filtered-v1/`。

范围边界：该复跑属于renderer/helper/protocol自动化，不启动正式Windows产品UI；不覆盖旧非Agent文本/图片/音频/视频的桌面手工连线、运行、保存重开，也不覆盖Agent控制同类目标时的共享gate/占用组合。REL-03主用例仍未执行，统计不升级。
## 2026-10-18 REL-03 图片网关与视频本地变换定向复测

`pnpm test -- test/image-gateway-drivers.test.ts test/video-capabilities.test.ts test/video-transform-main.test.ts --reporter=verbose` 通过：3个文件、27/27项，0跳过、0失败。图片网关测试 mock 了网络、AI SDK、媒体仓库和供应商仓库；视频变换测试 mock 了子进程及媒体落盘；视频能力测试为纯配置断言。没有真实供应商、付费或外部HTTP请求。完整命令输出、测试文件SHA-256和结果摘要见 `qa/agent-comprehensive/run-20261018-rel03-legacy-automated-media-extra-v1/`。

范围边界：这是 REL-03 自动化补充证据，不是 Windows 产品UI中的旧项目手工执行、保存重开或 Agent 同目标 gate/占用组合验收；REL-03主用例仍未执行，144项主用例统计不因本次复测变化。
## 2026-10-18 REL-03 正式包旧文本节点手动运行与双进程重开补充子场景

正式 Windows `win-unpacked` 包 v1.0.0（SHA-256：`2e275ed2b62eb77a6579136813ae42fc3622264699d99e54d7986e447dfa8ed61`）使用隔离 `CANVAS_DATA_DIR` 与独立 Electron profile，打开只含旧文本输入和模板 processor 的非Agent QA项目。通过产品卡片的“运行节点”按钮手动执行后，UI显示固定结果 `REL03手动处理：REL03旧手动流程固定输入：保存这条证据。`；第一进程正常退出，第二进程重开后节点仍为success且结果一致。两进程退出码均为0，SQLite `integrity_check=ok`；Agent task、command、model connection、provider和供应商/付费请求均为0，外部HTTP尝试为0。

观察到的graphVersion为：夹具32、手动保存后33、第二进程重开读取34、第二进程干净关闭后数据库35；结果正文保持不变。该子场景只核对手动文本处理及保存重开，不评价版本号递增语义。截图、执行清单、隔离数据库审计和脚本见 `qa/agent-comprehensive/run-20261018-rel03-legacy-manual-package-v4/`。早期v1项目定位超时和v2无效合成快照均发生在产品操作前，按夹具/测试器错误排除；原因及输出保留在同目录名的 `...-v1/`、`...-v2/`。v3通过结果也保留；v4是只含非Agent节点的最终复测。

范围边界：仅覆盖正式包中的旧文本输入/模板处理手动路径及新进程重开；没有覆盖图片、音频、视频产品UI路径，也没有覆盖Agent控制同目标的gate/占用组合或真实客户旧项目。REL-03主用例仍未执行；144项主用例和P0统计不变。

## 2026-10-18 REL-03 正式包图片裁剪与双进程像素核验补充子场景

正式 Windows `win-unpacked` 包 v1.0.0（SHA-256：`2e275ed2b62eb77a6579136813ae42fc3622264699d99e54d7986e447dfa8ed61`）在隔离 `CANVAS_DATA_DIR`、独立 Electron profile 和无模型配置下打开非Agent图片项目。产品UI点击图片裁剪节点“运行节点”后生成 PNG；使用 8×6 彩色像素夹具及矩形区域 `(x=0.25, y=0.25, width=0.5, height=0.5)`，验证输出为 4×3 且12个像素的RGBA均与源图对应区域逐值相同。第一进程退出后，第二进程重开同一项目，节点仍为success、mediaId未变，输出文件哈希一致且像素再次逐值匹配。两个进程退出码均为0，SQLite `integrity_check=ok`；Agent task/command、model connection、provider、真实供应商/模型/付费及外部HTTP尝试均为0。

v1初始烟测用1×1图和全图裁剪，仅证明产品入口能生成并持久化媒体，未验证裁剪几何；该记录保留为有限烟测，不计作几何验证。v2改用8×6图及实际子区域并完成上述逐像素断言。两次结果、截图、manifest和脚本分别保留于 `qa/agent-comprehensive/run-20261018-rel03-legacy-image-crop-package-v1/` 与 `qa/agent-comprehensive/run-20261018-rel03-legacy-image-crop-package-v2/`。

范围边界：仅覆盖正式包中旧图片裁剪节点的手工执行、实际矩形裁剪和新进程重开；尚未覆盖图片编辑/拆分等其他图片节点、旧音频/视频UI流程、Agent控制同目标的gate/占用组合或真实客户项目。REL-03主用例仍未执行；144项主用例和P0统计不变。

## 2026-10-18 REL-03 正式包视频抽帧及双进程复核补充子场景

正式 Windows `win-unpacked` 包 v1.0.0（SHA-256：`2e275ed2b62eb77a6579136813ae42fc3622264699d99e54d7986e447dfa8ed61`）在隔离 `CANVAS_DATA_DIR`、独立 Electron profile 和无模型配置下打开非Agent视频项目。通过产品UI点击“运行节点”，在配置的1000ms抽取视频帧；输入是本机 FFmpeg 生成的2秒、96×64固定红色视频并带正弦音轨。输出PNG经独立像素解码确认尺寸96×64、中心RGBA=(253,0,0,255)。第一进程退出后，第二进程重开同一项目，节点仍为success、mediaId及文件SHA-256一致，输出像素复核仍通过。两进程退出码均为0，SQLite `integrity_check=ok`；Agent task/command、model connection、provider、真实供应商/模型/付费和外部HTTP尝试均为0。FFmpeg/FFprobe由本机PATH定位，SHA摘要见manifest；未打包或下载媒体处理器。

首次脚本尝试在正式包启动前因运行环境没有 `where.exe` 报Harness错误，未创建隔离数据且未触发产品操作；原脚本保留为 `attempt1-where-resolution-failure.cjs`，`attempt-history.json`记载后，改为从PATH定位ffmpeg.exe并验证相邻ffprobe.exe后通过。执行manifest、测试脚本、截图和视频夹具见 `qa/agent-comprehensive/run-20261018-rel03-legacy-video-frame-package-v1/`。

范围边界：仅覆盖正式包旧视频抽帧节点的指定时刻执行、PNG内容与新进程重开；未覆盖视频截取/音轨双输出、独立旧音频手工流程、Agent控制同目标的gate/占用组合或真实客户项目。REL-03主用例仍未执行；144项主用例和P0统计不变。

## 2026-10-18 REL-03 正式包视频截取画面与音轨双输出补充子场景

正式 Windows `win-unpacked` 包 v1.0.0（SHA-256：`2e275ed2b62eb77a6579136813ae42fc3622264699d99e54d7986e447dfa8ed61`）在隔离 `CANVAS_DATA_DIR`、独立 Electron profile 和无模型配置下打开非Agent视频项目。产品UI点击视频截取节点“运行节点”，对本机2秒、96×64红色视频及正弦音轨按250–1250ms截取，配置为balanced画面编码、保留原音，并同时独立输出44.1kHz WAV音轨。FFprobe独立确认视频和音频各1.000秒；视频为96×64 H.264并含AAC轨，独立音频为44.1kHz PCM S16LE。第一进程退出后第二进程重开，两个mediaId/path均一致；媒体哈希、流参数和时长再次核验一致。两进程退出码为0，SQLite `integrity_check=ok`；Agent task/command、model connection、provider、真实供应商/模型/付费和外部HTTP尝试均为0。

本机FFmpeg/FFprobe只用于生成本地确定性夹具和独立读取结果，工具SHA摘要及输出媒体SHA见 `qa/agent-comprehensive/run-20261018-rel03-legacy-video-clip-package-v1/execution-manifest.json` 与 `results.json`。完整脚本、产品UI截图和隔离数据库均在同目录。

范围边界：仅覆盖正式包“视频截取”节点同次生成视频片段和独立音频片段，不能代替完整旧音频编辑、视频项目手工搭建或Agent控制同目标的gate/占用组合；REL-03主用例仍未执行，144项主用例和P0统计不变。

## 2026-10-18 REL-03 正式包声音调整节点补充子场景

正式 Windows `win-unpacked` 包 v1.0.0（SHA-256：`2e275ed2b62eb77a6579136813ae42fc3622264699d99e54d7986e447dfa8ed61`）在隔离 `CANVAS_DATA_DIR`、独立 Electron profile 和无模型配置下打开非Agent音频项目。产品UI点击“声音调整”节点运行，对本机2秒、44.1kHz、单声道440Hz WAV按1.5倍速及150%音量处理，输出AAC/m4a。FFprobe确认采样率44100Hz、单声道、时长1.339秒；独立解码计算源/输出PCM RMS，比例为1.494，符合1.5倍增益的预设容差。第一进程退出后第二进程重开，节点保持success、同一mediaId及输出哈希不变，时长和RMS再次核验通过。两进程退出码均为0，SQLite `integrity_check=ok`；Agent task/command、model connection、provider、真实供应商/模型/付费和外部HTTP尝试均为0。

本地FFmpeg/FFprobe仅用于生成固定音频夹具和独立检查产物；输出哈希、工具哈希、两进程结果及截图见 `qa/agent-comprehensive/run-20261018-rel03-legacy-sound-adjust-package-v1/`。

范围边界：仅覆盖正式包旧音频“声音调整”节点的速率/音量处理及新进程重开；不覆盖TTS/供应商语音生成、人声分离、完整旧音频手工项目或Agent同目标gate/占用组合。REL-03主用例仍未执行，144项主用例和P0统计不变。

## 2026-10-18 LOG-04 正式包 Agent 成功/失败运行与诊断导出补充复测

正式 Windows `win-unpacked` 包 v1.0.0（SHA-256：`2e275ed2b62eb77a6579136813ae42fc3622264699d99e54d7986e447dfa8ed61`）在隔离数据目录中通过公开 Agent UI 完成一次本地模型/processor 成功运行，并执行第二次 Agent 运行；本机 OpenAI-compatible fixture 对决策请求返回受控 HTTP 500，第二个 Agent 任务按预期持久化为 `blocked / AGENT_MODEL_FAILED`。五次模型 fixture 请求均观察到测试专用 Authorization 假密钥，未连接真实供应商、付费服务或外部 HTTP。

随后通过产品公开 `window.api.exportDiagnosticsBundle` 导出诊断 ZIP，含111条事件、`badLines=0`、未截断；ZIP仅含 `manifest.json`、`events.jsonl`、`summary.txt`、`coverage.json`。事件中记录成功的 `model.request.completed`/Agent runtime 结束，以及失败的 `model.request.failed`、`agent.runtime.blocked`、`node.failed`、`workflow.failed`；诊断错误码为安全分类。ZIP扫描提示词、假密钥、错误响应、签名URL、绝对路径和媒体Base64六类哨兵，全部未发现；SQLite只读完整性检查为 `ok`，产品进程退出码0。

本轮与已通过的 safeStack 修复复测合并后，覆盖了历史 `withStack=true` 条件探针、修复后合成ZIP测试以及正式包真实Agent成功/失败运行级导出扫描；六类敏感值均未进入诊断ZIP，业务输出和命令未打入诊断包。AGT-20261017-006维持已关闭，LOG-04整项维持通过；144项总数及通过/失败汇总不变。夹具清理、失败终态及 ESM inspector 适配尝试保留于 `attempt-history.json`。

结果、脚本、manifest、只读数据库审计、诊断ZIP和两张产品截图见 `qa/agent-comprehensive/run-20261018-log04-package-runtime-v1/`。


## 2026-10-18 REL-03 当前源码桌面 Agent/旧手动执行共享 gate 补充子场景

在隔离的当前源码 Electron 桌面夹具中，针对同一个旧 processor 建立 unknown 命令回执占用，然后从真实画布卡片点击“运行节点”。手动入口显示“该节点由主 Agent 协调，请先停止对应流程”；执行前后 exec=idle、运行历史均为0、输出未改变，未创建第二条命令。随后启动 Agent footer 流程，Agent 在命令创建前因 FLOW_NODE_OCCUPIED 被阻止；显式停止后任务为 cancelled，原命令仍为唯一一条且回执仍为 unknown。第二个 Electron 进程重开确认占用记录仍在，且未重放被阻止的 Agent 操作。两个进程验收通过，诊断脱敏检查通过；只使用本地合成模型fixture的3次请求，真实模型、供应商、付费与外部HTTP均为0。

首次验收已正确阻止手动执行并产生 FLOW_NODE_OCCUPIED，但renderer未将该错误码映射为清晰占用提示，界面回退到了通用未确认命令提示。已修复共享手动执行器的消息映射，并以 test/manual-run.test.ts 覆盖 FLOW_CONTROL_OCCUPIED 与 FLOW_NODE_OCCUPIED 两种情况，17/17通过；重新构建后桌面双进程复测通过。尝试原因及修复过程见 attempt-history.json。

边界：此证据来自当前源码桌面夹具，不是正式 Windows 发布包验收；只覆盖通用旧processor上的unknown/pending命令占用组合，不代表所有多媒体节点或其他占用状态。它补充验证 REL-03共享gate行为，但 REL-03完整主用例仍未完成，144项主用例与P0汇总统计不变。命令、执行/重开报告、构建与源文件SHA-256、诊断记录见 qa/agent-comprehensive/run-20261018-rel03-agent-legacy-gate-v2/。

## 2026-10-18 REL-03 正式包旧图片宫格拆分与双进程像素复核补充子场景

正式 Windows win-unpacked 包 v1.0.0（SHA-256：2e275ed2b62eb77a6579136813ae42fc3622264699d99e54d7986e447dfa8ed61）在隔离 CANVAS_DATA_DIR、独立 Electron profile 和无模型配置下打开旧图片项目。产品UI点击“拆分”节点的“运行节点”，将本机8×6彩色夹具按2行×2列、100%面积生成4个PNG。独立解码验证每个输出为4×3，按从左到右、从上到下排列，所有RGBA像素均与原图对应象限逐值一致。首进程关闭后，第二进程重开同一项目，节点仍为success，4个mediaId/path保持一致，哈希和每格像素再次核验通过。两进程退出码均为0，SQLite integrity_check=ok；Agent任务/命令、模型连接、provider、真实模型/供应商/付费及外部HTTP尝试均为0。

本地8×6 PNG只用于确定性输入，独立像素解码由测试脚本完成。四份输出哈希、项目及数据库审计、执行manifest和两张产品UI截图见 qa/agent-comprehensive/run-20261018-rel03-legacy-image-split-package-v1/。

范围边界：仅覆盖正式包旧图片“拆分”节点2×2、100%面积宫格生成及新进程资产重开；未覆盖其他行列/面积参数、图片编辑/生成、完整旧图片工作流或Agent同目标gate。REL-03主用例仍未执行；144项主用例和P0统计不变。

## 2026-10-18 REL-03 正式包历史“截音频”节点兼容与双进程复核补充子场景

正式 Windows win-unpacked 包 v1.0.0（SHA-256：2e275ed2b62eb77a6579136813ae42fc3622264699d99e54d7986e447dfa8ed61）在隔离 CANVAS_DATA_DIR、独立 Electron profile 和无模型配置下打开历史画布。虽然“截音频”已退役且不能新建，历史画布中的节点仍从产品UI点击“运行节点”成功执行：从本机2秒、96×64 MP4提取250–1250ms音轨，生成1秒WAV。FFprobe确认PCM S16LE、44.1kHz、单声道；独立解码计算RMS为2879.49，正向过零估算频率439Hz，符合合成440Hz音轨。第二个Electron进程重开后同一mediaId/path及哈希、时长、采样规格和音频内容均再次核验一致。两进程退出码均为0，SQLite integrity_check=ok；Agent任务/命令、模型连接、provider、真实模型/供应商/付费与外部HTTP尝试均为0。

本机FFmpeg/FFprobe仅用于生成固定视频夹具和独立检查WAV；视频/音频SHA、工具哈希、结果、隔离数据库审计、产品UI截图和manifest见 qa/agent-comprehensive/run-20261018-rel03-legacy-video-audio-package-v1/。

范围边界：仅覆盖正式包历史“截音频”节点250–1250ms WAV提取及双进程资产/内容复核；不覆盖人声分离、语音生成、其他格式/时段或完整旧视频工作流。REL-03主用例仍未执行；144项主用例和P0统计不变。

## 2026-10-18 REL-03 正式包旧图片编辑节点与本机模型夹具补充子场景

正式 Windows win-unpacked 包 v1.0.0（SHA-256：2e275ed2b62eb77a6579136813ae42fc3622264699d99e54d7986e447dfa8ed61）在隔离 CANVAS_DATA_DIR、独立 Electron profile 中打开旧图片项目，从产品UI手动运行历史图片编辑节点。唯一的 OpenAI-compatible provider 指向本机 127.0.0.1 确定性夹具；请求为 POST /v1/images/edits，共1次，模型ID和中文修改说明匹配。multipart 含两份 image[] 参考图；独立解码确认两张均为8×6，RGBA逐像素与本机源图一致。夹具返回固定8×6图片，输出像素与预设逐值相等。第一进程退出码0；第二进程重开后节点仍为success，mediaId及文件SHA-256保持一致，图片像素再次核验通过。两进程退出码均为0，SQLite integrity_check=ok；无Agent task/command，唯一provider、model connection和model definition均指向本机夹具；真实模型/供应商调用、付费请求、外部HTTP均为0。

脚本v1–v3的失败记录是夹具断言问题（UTF-8提示词解码、image[] multipart字段识别、本地旧provider目录同步计数），不是产品运行失败；v4修正后全流程通过。结果、请求摘要、逐像素证明、数据库审计、manifest、脚本和产品UI截图见 qa/agent-comprehensive/run-20261018-rel03-legacy-image-edit-package-v4/；早期尝试记录保留在同名v1–v3目录。

范围边界：仅覆盖正式包旧图片编辑节点的单次人工运行、无标注/无遮罩输入和双进程产物复核；模型输出由确定性本机夹具提供，不评价真实模型质量，也不覆盖标注/遮罩、其他图片操作或Agent对同目标的占用组合。REL-03主用例仍未完成；144项主用例与P0统计不变。
## 2026-10-18 REL-02 Windows解包包 M08 flush-tmp 故障与显式重试补充子场景

正式 Windows win-unpacked 包 v1.0.0（SHA-256：2e275ed2b62eb77a6579136813ae42fc3622264699d99e54d7986e447dfa8ed61）在隔离 CANVAS_DATA_DIR、独立 Electron profile 中通过公共 project.save IPC 保存 M08 项目。只在本机绑定的 Electron Node inspector 中安装一次性故障桩：命中指定 project.json.tmp 文件描述符时让 fs.fsyncSync 精确失败一次（EIO）。产品返回 SAVE_FAILED，诊断事件 phase=flush-tmp、STORAGE_WRITE_FAILED；project.json 和 .bak 哈希均保持基线，graphVersion保持3，临时文件被清理。解除故障臂后显式更新标题并重试，保存提交为graphVersion 4，媒体哈希和固定资产版本数不变。第二个正式包进程重开后标题和快照一致、媒体哈希不变。两进程退出码均为0；SQLite integrity_check=ok；模型请求、真实供应商/付费/外部HTTP为0，任务/命令/模型/供应商数据无副作用。

故障注入仅作用于本次打包进程的内存fsyncSync函数和隔离用户数据，正式包文件未修改。失败尝试、诊断事件、显式重试、第二进程截图、只读数据库审计和SHA-256见 qa/agent-comprehensive/run-20261018-rel02-m08-package-save-flush-tmp-v8/。

范围边界：只覆盖 M08 正式包 `flush-tmp` 一个故障阶段、回滚/临时文件清理、显式重试与第二进程重开；不覆盖媒体故障、“已接受未回执/已提交未呈现”的强退及unknown核对。`promote-tmp` 已由紧随其后的独立补充子场景覆盖。REL-02主用例仍为未执行，144项主用例与P0统计不变。
## 2026-10-18 REL-02 Windows解包包 M08 promote-tmp 故障与显式重试补充子场景

正式 Windows `win-unpacked` 包 v1.0.0 在隔离项目副本中通过本机 loopback Electron Node inspector，仅对 `project.json.tmp` 转正到 `project.json` 的 `renameSync` 注入一次 EIO。公共 `project.save` IPC 返回 `SAVE_FAILED`；诊断为 `phase=promote-tmp` / `STORAGE_WRITE_FAILED`，`rollbackFailed=false`。失败后主文件哈希与graphVersion=3保持原值，备份与临时候选均由回滚清理。移除注入后显式重试成功，graphVersion升至4；旧快照成为备份，固定媒体哈希和资产版本数不变。第二个正式包进程重开读到相同标题、快照版本和媒体哈希。两个进程退出码均为0，SQLite `integrity_check=ok`；模型、真实供应商、付费及外部HTTP请求均为0。

证据及尝试哈希见 `qa/agent-comprehensive/run-20261018-rel02-m08-package-save-promote-tmp-v2/`。早期 v1 外部句柄尝试仍保留在历史排除段，不计通过。

范围边界：仅覆盖 M08 正式包 `promote-tmp` 一个故障点、回滚、显式重试与第二进程重开，不升级 M08 或 REL-02 主用例。正式包媒体故障补充子场景已另行通过；后续已补充本机模型决策未回包与命令已提交未呈现的强退/重开子场景；“核对执行事实”点击后仍为blocked/AGENT_SESSION_LOST，未成功恢复呈现，真实供应商异步接受但无回执仍未覆盖；REL-02主用例仍未执行，144项主用例与P0统计不变。
## 2026-10-18 REL-02 Windows解包包 M08 项目导入媒体落盘故障与显式重试补充子场景

正式 Windows `win-unpacked` 包 v1.0.0 的首页 UI 点击“导入项目”，进入产品导入 IPC；本机 loopback Electron Node inspector 在隔离进程内对 `.importing/media/<id>.png` 的 `writeFileSync` 精确注入一次 EIO。为确定文件选择，本场景通过内存中的 Electron `showOpenDialog` 适配器返回固定本机 `.canvasbundle` 路径；产品导入按钮、renderer handler 和公共 IPC 均实际执行。产品界面显示“导入失败”，诊断记录 `project.transfer.failed`、`operation=project-import`、`phase=storage`、`code=EIO`。失败回滚后项目、媒体、固定版本表均为0，隔离目录下无 `.importing` 或媒体残留。

解除故障后再次从首页点击导入，成功导入恰好一个项目/媒体/固定版本；媒体ID、路径、资产与版本ID均为新标识，固定版本digest有效，PNG字节SHA-256与源包一致（`6a8f6823587e92c061dbe33d73158941b8878ad3629efba8e4792442a38471b8`）。产品画布打开后，第二个正式包进程自动重开同一项目并读回相同媒体内容。两个进程退出码均为0，SQLite及转账事件核对通过；命令、Agent任务、模型连接/定义、供应商记录、模型请求、真实供应商、付费和外部HTTP请求均为0。证据及哈希见 `qa/agent-comprehensive/run-20261018-rel02-m08-package-media-fault-v3/`；v1诊断读取时序与v2重开等待判据失败为夹具尝试，保留但不计结果。

范围边界：仅覆盖 M08 正式包项目导入时一个媒体临时写入故障、回滚、显式重试和第二进程重开；文件选择由本机对话框API适配器供给，不覆盖真实文件选择器操作。此补充不升级 M08 或 REL-02 主用例。后续已补充本机模型决策未回包与命令已提交未呈现的强退/重开子场景；“核对执行事实”操作后仍为blocked/AGENT_SESSION_LOST且未呈现，真实供应商异步接受但无回执及成功恢复呈现仍未验收；REL-02主用例仍未执行，144项主用例及P0统计不变。

## 2026-10-18 REL-02 正式包本机模型决策请求无回包强退/重开补充子场景

正式 Windows `win-unpacked` 包 v1.0.0（SHA-256：`2e275ed2b62eb77a6579136813ae42fc3622264699d99e54d7986e447dfa8ed61`）在隔离 CANVAS_DATA_DIR、独立 Electron profile 中从产品 UI 启动专业 Agent。仅连接本机 127.0.0.1 确定性 OpenAI-compatible fixture：两个能力探测请求成功，随后模型接口接受 `execute_node` 决策请求，但测试桩返回响应头后一直不发送工具回执。首进程以真实 `SIGKILL` 强制结束；第二个正式包进程重开后保留同一 taskId，任务变为 `blocked / AGENT_SESSION_LOST`，`outputRefs=[]`，没有处理命令，也未自动重发已接受的模型请求。首进程实际 signal 为 SIGKILL；重开进程退出码0；只读SQLite `integrity_check=ok`。本机模型fixture共3个POST；真实供应商、付费及外部HTTP请求均为0。

范围边界：这验证的是本机模型决策HTTP请求被接受但没有返回，不是供应商已接受异步生成任务但无回执；不升级M08或REL-02主用例。证据见 `qa/agent-comprehensive/run-20261018-rel02-m08-unknown-accepted-no-receipt-v3/`（execution-manifest.json、results.json、appdb-readonly-audit.json、脚本及双进程截图）。

## 2026-10-18 REL-02 正式包命令已提交、成果未呈现强退/重开补充子场景

正式 Windows `win-unpacked` 包 v1.0.0 在隔离 CANVAS_DATA_DIR、独立 Electron profile 与本机确定性模型fixture中运行 M01 专业 Agent。模型返回 `execute_node` 决策；本地处理器成功执行并提交唯一命令与固定输出。随后fixture接受包含1份工具回执的 `finish_task` 决策请求，但不返回完成回执。首进程以 `SIGKILL` 强制结束；第二进程重开后同一taskId仍为 `blocked / AGENT_SESSION_LOST`，唯一命令保持committed，处理器固定输出仍在，Agent `outputRefs=[]` 且没有Agent成果呈现；决策请求没有自动重放。卡片可见“核对执行事实”入口。两进程退出（首进程signal SIGKILL，第二进程退出码0），SQLite `integrity_check=ok`；本机fixture共4个POST，真实供应商、付费及外部HTTP为0。

范围边界：此轮只验证已提交命令的持久化、未呈现状态、强退/重开及恢复入口可见；没有在此轮点击恢复入口，也没有完成M08。证据见 `qa/agent-comprehensive/run-20261018-rel02-m08-unknown-committed-unpresented-v1/`（execution-manifest.json、results.json、appdb-readonly-audit.json、脚本及双进程截图）。

## 2026-10-18 REL-02 正式包“核对执行事实”恢复动作复测（仍未恢复）

在与上一子场景相同的正式包、隔离M01项目和本机模型fixture下，强退并重开后实际点击Agent卡片“核对执行事实”。操作后同一taskId仍为 `blocked / AGENT_SESSION_LOST`，唯一已提交命令仍为committed，`outputRefs=[]`，Agent卡片继续显示“核对执行事实”，2.5秒观察窗口内没有成功呈现成果。fixture请求数保持4（操作前4、操作后4），未重放模型请求；SQLite `integrity_check=ok`。这记录为未恢复结果，尚未登记缺陷编号，不能作为恢复通过。源码路径检查与现象吻合：desktop-host 的 reconcile 分支仅在 task 为 waiting 且 waitKind=reconcile 时写入 FLOW_COMMAND_FACTS_VERIFIED；本场景重开后为 blocked/AGENT_SESSION_LOST、waitKind=null，因此该分支没有推进任务。

范围边界：只覆盖已提交本地处理命令后的正式包恢复入口；当前观察到的按钮操作没有推进任务或呈现成果。真实供应商异步接受/无回执路径仍未覆盖；M08及REL-02主用例保持未完成。证据见 `qa/agent-comprehensive/run-20261018-rel02-m08-unknown-committed-unpresented-reconcile-v1/`。

## 2026-10-18 全量自动门禁复测

当前工作树执行 `npm run verify` 通过，runId `run-dE63lA`，退出码0；开始时间2026-10-18T03:57:36.266Z，结束时间2026-10-18T04:11:36.710Z。187个Vitest文件全部通过，2,342项通过、1项跳过；其后模型运行时包2/2、日志旁路检查、浏览器优化UI门禁、Electron主/渲染构建、Agent资产与命令IPC、各桌面执行/协作/协调/建图/审核/返工/恢复/视频/并行集成及R09本地保存恢复均通过。验证日志和状态见 `qa/verification/run-dE63lA/`。该自动门禁没有启动长时soak，也不替代报告中列出的人工、真实资源限制、发布签名/安装和真实供应商条件。

## 2026-10-18 PER-02 通用画布数据层基准（补充子场景）

在本机运行既有通用画布基准，生成并保留100/500/1000节点画布包。单次序列化数据测量：100节点 JSON 构造/序列化/解析/打包分别0.94/0.59/0.50/10.03 ms；500节点为2.55/2.52/2.49/7.69 ms；1000节点为2.80/5.21/6.17/14.46 ms。图拓扑基准100/500/1000节点拓扑耗时0.190/0.774/0.835 ms。机器为Windows x64、Intel Core i7-14700KF、28逻辑核、约32 GiB RAM。原始输出、生成包及SHA-256见 `qa/agent-comprehensive/run-20261018-per02-data-layer-v1/`。

边界：该通用脚本测量对象构造、JSON与打包，不创建Agent节点，不测拖动/缩放/面板交互，不计算p50/p95或同机交互基线，也未施加低内存/磁盘配额。PER-02主用例状态不变。

## 2026-10-18 PER-03 并行队列强退恢复复测

独立Evidence目录内的Electron双进程夹具通过：首进程检查点包含已完成、unknown等待及排队第三分支，随后对真实Electron子进程强制SIGKILL；新进程恢复同一主任务及子任务身份，已完成分支没有重放，unknown分支经事实核对后无重复供应商POST，第三分支在锁释放后按FIFO提交。最终三支完成、共享目标锁释放，决策/工具预算未超限。合成模型fixture请求15次、fixture HTTP 12次，供应商POST从2增至3、下载从1增至3；真实供应商/付费/外部HTTP=0。2个诊断session共337条JSONL均可解析、eventId唯一；测试密钥/内容标记无泄漏，6个 `parallel-queue-` 值仅位于预期的 `upstreamTaskId` 相关字段。执行清单及SHA-256见 `qa/agent-comprehensive/run-20261018-per03-queue-recovery-v2/`。此子场景不变更PER-03主用例统计。

## 2026-10-18 PER-02 Agent画布交互性能矩阵（补充子场景）

当前源码Electron桌面夹具分别构建10、50、100个Agent节点画布；每个规模执行30轮拖动、缩放、协作面板打开和关闭，并以10节点组作为同机基线。每轮拖动前将目标节点聚焦到100%缩放；拖动由Electron `sendInputEvent`鼠标事件驱动，缩放调用可见缩放控件的renderer回调，面板通过nodePanelStore开关。记录操作到目标几何/缩放/挂载状态变化并稳定32ms的耗时，P50/P95使用最近秩法。隐藏隔离BrowserWindow中的帧呈现延迟不在测量范围内。

| Agent节点数 | 拖动 P50/P95 (ms) | 缩放 P50/P95 (ms) | 面板打开 P50/P95 (ms) | 面板关闭 P50/P95 (ms) |
| ---: | ---: | ---: | ---: | ---: |
| 10（基线） | 241.19 / 248.72 | 343.80 / 379.60 | 47.04 / 50.46 | 47.20 / 58.97 |
| 50 | 296.15 / 382.70 | 258.40 / 327.30 | 47.95 / 58.46 | 47.53 / 56.70 |
| 100 | 641.28 / 753.68 | 630.10 / 888.30 | 52.50 / 62.24 | 52.68 / 384.43 |

相对10节点基线，50节点组四项P50/P95比分别为拖动1.23/1.54、缩放0.75/0.86、面板打开1.02/1.16、面板关闭1.01/0.96；100节点组分别为2.66/3.03、1.83/2.34、1.12/1.23、1.12/6.52。100节点面板关闭P95为384.43ms，是样本尾部观测，不对其作产品阈值判定；当前没有冻结的PER-02延迟阈值。机器为Windows x64、Intel Core i7-14700KF、28逻辑处理器、34,200,453,120字节内存；Electron 39.8.10、Chrome 142.0.7444.265、Node 22.22.1。

本次模型/fixture请求均为0，没有Agent任务派发、命令执行或供应商调用。隔离诊断session共380条JSONL事件，全部可解析且eventId唯一；成功运行后进度文件已清理。截图、原始30轮数据、环境与交互协议、执行报告及源/构建/证据SHA-256见 `qa/agent-comprehensive/run-20261018-per02-interaction-matrix-v1/`。此数据补齐Agent节点交互采样与同机基线，但不覆盖可见帧延迟、低内存/磁盘配额或冻结产品阈值，PER-02主用例保持未完成。

## 2026-10-18 全量自动门禁复测（二）

本轮改动后再次执行 `npm run verify`，runId `run-afenYi`，退出码0；开始时间2026-10-18T04:59:52.519Z，结束时间2026-10-18T05:13:53.567Z。187个Vitest文件全部通过，2,342项通过、1项跳过；模型运行时包2/2、日志旁路检查、浏览器优化UI门禁、Electron主/渲染构建、Agent资产与命令IPC、桌面执行/协作/协调/建图/审核/返工/恢复/视频/并行集成及R09本地保存恢复全部通过。完整日志及状态见 `qa/verification/run-afenYi/`。自动门禁不启动长时soak，也不替代本报告列出的人工、真实资源限制、签名/安装和真实供应商条件。

## 2026-10-18 CFG-07 当前源码浏览器键盘与控件交互补充子场景

浏览器门禁在隔离当前源码renderer中创建有效默认配置的Agent、AI审核及状态机节点，分别检查节点正文、固定操作栏和设置tab的焦点顺序。Tab正向遍历与Shift+Tab反向遍历均按DOM顺序可逆：Agent为1/2/9个tab stop，AI审核为1/2/8个，状态机为0/1/4个。实际键盘Enter可从节点信息按钮打开说明面板，并激活“设置”tab；职责Radix下拉Esc关闭后焦点回到触发器，ArrowUp+Enter将草稿从“专业 Agent”改为“主控 Agent”；Space切换复选框后可还原草稿值。没有触发Agent/节点任务，也没有保存配置。

该测试作为 `scripts/run-optimization-ui-gate.cjs` 的门禁步骤接入；独立 `npm run test:optimization-ui` 退出码0，随后完整 `npm run verify` 的同一门禁也通过。结果、四张截图、失败尝试历史、源文件和full-verification SHA-256见 `qa/agent-comprehensive/run-20261018-cfg07-tab-navigation-v1/`（execution-manifest.json）。此子场景不覆盖打包Windows应用的全控件手工验收、中文IME真实组合输入、系统DPI/全主题矩阵或独立人工体验评审，CFG-07主用例仍未完成。

## 2026-10-18 全量自动门禁复测（三）

加入CFG-07键盘浏览器子场景后执行 `npm run verify`，runId `run-pNI52e`，退出码0；开始时间2026-10-18T05:26:31.857Z，结束时间2026-10-18T05:40:35.623Z。187个Vitest文件全部通过，2,342项通过、1项跳过；模型运行时包、日志门禁、含本轮键盘用例的浏览器优化UI门禁、Electron构建、Agent资产/命令IPC、所有桌面执行/协作/协调/审核/返工/恢复/多媒体/并行集成及R09本地保存恢复均通过。状态、日志及集成证据见 `qa/verification/run-pNI52e/`。该门禁仍不启动90分钟soak，也不替代真实资源配额、签名/干净安装、供应商实网或本报告列出的人工验收条件。

## 2026-10-18 PER-04 稳态预热后复测

早期单次预热复测出现监听器从596增至783（+187）的跃升；额外2秒静置后从590增至783（+193）。逐轮样本显示跃升发生在监测期第一次画布重挂载，之后五次重挂载直到第30轮保持783不变。为让基线覆盖一次性初始化，本轮在监测前执行2次未计入正式轮次的画布卸载/重挂载与3次面板开关，再静置2秒并强制GC；随后仍按原量执行30次协作面板开关、6次正式画布卸载/重挂载和31个强制GC样本。

稳定基线下 `JSEventListeners` 为783→783，净增0（阈值196）；静置末尾仍为783。CDP `Nodes` 为1096→1100（+4），DOM查询数309→309，活动 `setInterval` 为3→3，净增0；任务、命令、模型及fixture请求均为0。新Electron进程重开同一项目后Agent shape仍在、项目持久化、没有任务重放。`npm run build`（Node/Web typecheck及Electron/Vite build）通过，`npm run test:agent-flow-panel-churn`退出码0。PER-04按当前监听器/interval验收通过；先前+187/+193结果作为首次挂载初始化的诊断记录保留，未被删除或改写。

执行报告、重开报告、31轮逐样本、截图、诊断session及源/构建SHA-256见 `qa/agent-panel-churn-per04-stable-warmup-v1/desktop/`，汇总清单为 `execution-manifest.json`。诊断样本末尾仍记录有 `Failed to fetch` 和图像解码错误文本；本次探针未记录资源目标/调用栈，尚未归因，且未与稳定的PER-04监听器/interval判据相关联。

## 2026-10-18 CFG-03 图像审核能力前置检查补充复测

Windows x64 `win-unpacked` 隔离项目将 AI 审核配置为 `reviewMode=image`，模型已启用且声明 `text.generate`，但没有图像输入能力声明或已验证结果。实际点击“审核当前版本”后，界面显示“所选审核模型未通过图像输入能力验证，请检查模型设置”；点击期间没有项目保存、工作流/节点准入、Agent任务、命令或模型请求，审核状态保持 `idle`。退出后SQLite仍无任务/命令且审核节点没有 `nodeRun`，进程退出码0。真实供应商、付费及renderer外部HTTP请求均为0。

该图像审核入口补充子场景通过；当时尚未覆盖视频/音频审核、所有输入关系或全部CFG-03条件。采样视频和音频审核后续复测见本报告末尾对应补充结果。该场景结果、隔离SQLite核查、截图、诊断session及逐文件SHA-256见 `qa/agent-comprehensive/run-20261018-cfg03-review-image-capability-v1/execution-manifest.json`。

## 2026-10-18 CFG-03 Agent 工具调用能力不足复测（修复前失败基线）

Windows x64 `win-unpacked` 包中配置合法 `node.execute@1`、授权processor以及 `enabled=1` 且声明 `text.generate` 的Agent模型。模型连接启用并指向只绑定 `127.0.0.1` 的确定性OpenAI-compatible fixture；收到强制 `probe_echo` 工具调用请求时仅返回文本，不返回 `tool_calls`。没有真实供应商、付费或renderer外部HTTP请求。

v2点击Agent“启动任务”期间，项目先从graphVersion 40保存到42，随后发生 `workflow.started`、`workflow.task_queued`、`workflow.task_admitted`、`node.started`；主进程向本机fixture发出1次能力探测请求，记录 `model.request.started/first_chunk/failed`，再以 `AGENT_MODEL_TOOL_UNVERIFIED` 拒绝。应用界面给出明确能力错误；退出后SQLite保留1条 `blocked / AGENT_MODEL_TOOL_UNVERIFIED` Agent任务、0条命令，Agent节点执行态为failed。应用正常退出，退出码0。此记录是不满足“能力不足在保存、工作流准入、任务持久化和模型请求前拒绝”的修复前基线；缺陷由后续v3包复测关闭。

证据、点击阶段与退出阶段分开的诊断、SQLite状态、截图、fixture及源/包SHA-256见 `qa/agent-comprehensive/run-20261018-cfg03-no-tool-calling-v2/execution-manifest.json`。该次失败不被删除或改写；当前缺陷状态及修复后结论见本报告末尾v3复测记录。CFG-03主用例仍记未执行，不能用单个修复后子场景代表全项完成。

## 2026-10-18 全量自动门禁复测（四）

当前源码执行 `npm run verify`，runId `run-46CPd3`，2026-10-18T06:45:29.440Z开始、06:59:35.339Z结束，退出码0。187个Vitest文件通过，2,344项通过、1项跳过；模型运行时2/2，ESLint/Node与Web及模型类型检查、日志旁路检查、浏览器优化UI门禁、Electron/Vite构建、Agent资产/命令IPC、桌面执行/协作/协调/建图/审核/返工/恢复/视频/多媒体/并行集成及R09本地保存恢复均通过。状态和完整日志见 `qa/verification/run-46CPd3/`。

该次自动门禁只记录run-46CPd3时的源码常规回归结果；当时CFG-03工具调用能力不足正式包场景仍在准入及保存后才拒绝。其后已由run-5FkoS5和v3正式包复测补充更新，缺陷现已关闭。全量门禁不包含长时soak、真实供应商付费调用、资源配额、签名/干净安装及人工验收。

## 2026-10-18 CFG-03 采样视频审核能力前置检查补充复测

Windows x64 `win-unpacked` 包在隔离项目和独立数据目录中配置 `reviewMode=sampled-video`；启用的模型仅声明 `text.generate`，没有经验证的图像输入能力。实际点击“审核当前版本”后，界面显示“所选审核模型未通过图像输入能力验证，请检查模型设置”。点击阶段没有项目保存、审核/工作流/节点事件、Agent任务、命令、模型请求或renderer外部HTTP；审核保持idle。关窗时单独记录一次同步项目保存；重开后SQLite中Agent任务/命令均为0、无review nodeRun，`integrity_check=ok`。应用退出码0。

## 2026-10-18 CFG-03 音频审核能力前置检查补充复测

同一正式包的独立隔离副本配置 `reviewMode=audio`，模型仍只声明 `text.generate`。点击“审核当前版本”后，界面显示“所选审核模型未通过音频输入能力验证，请检查模型设置”。点击阶段没有项目保存、审核/工作流/节点事件、Agent任务、命令、模型请求或renderer外部HTTP；审核保持idle。关窗时的同步项目保存与点击阶段分离；退出后SQLite中Agent任务/命令均为0、无review nodeRun，`integrity_check=ok`。应用退出码0。

两项均为“能力不足时在副作用前拒绝”的通过子场景，不升级CFG-03主用例，也不覆盖真实视频/音频内容质量或图像、采样视频、音频的模态交叉组合。独立结果、截图、关闭前后诊断、SQLite、预置配置和逐文件SHA-256见 `qa/agent-comprehensive/run-20261018-cfg03-review-modes-v1/execution-manifest.json`。

## 2026-10-18 CFG-03 已声明但未验证媒体输入能力的边界复测

继续使用正式Windows解包包和独立隔离数据副本，补了两个“目录声明了输入类型、验证状态尚不足”的场景：采样视频审核模型声明 `acceptedAssetKinds=[image]`、`text.generate` 验证为 `pending`；音频审核模型声明 `acceptedAssetKinds=[audio]`、验证为 `failed`。两次实际点击审核按钮都显示对应的图像/音频输入能力验证失败提示；点击阶段没有项目保存、工作流/节点/命令/任务事件、模型请求或renderer外部HTTP，审核状态保持idle。退出后两个项目均无Agent任务、命令及review nodeRun，SQLite `integrity_check=ok`；进程退出码均为0。

该结果确认模型的输入类型声明本身不会替代 `text.generate` 的成功验证。第一次脚本尝试因夹具未创建诊断目录、且发生在应用启动前而排除；修正后两项正式包运行均通过，尝试和修正记录保留。此次仍是能力准入测试，不运行真实审核模型或供应商，不升级CFG-03主用例。配置、运行结果、截图、诊断、只读SQLite状态及逐文件SHA-256见 `qa/agent-comprehensive/run-20261018-cfg03-review-declared-capability-v1/execution-manifest.json`。

## 2026-10-18 CFG-03 图像与音画审核未选择模型入口复测

正式Windows解包包的两个隔离项目分别将审核模式设为 `image` 与 `audio-video`，配置中省略 `modelDefinitionId`，同时保留可用模型目录。产品UI的“审核当前版本”按钮可用；点击后均显示“请在审核节点设置中选择审核模型”。点击阶段没有项目保存、工作流/节点/命令事件、Agent任务、模型请求或renderer外部HTTP；退出后审核保持idle、无review nodeRun，任务/命令均为0，SQLite `integrity_check=ok`，退出码均为0。关窗同步保存事件单独记录，不计入点击阶段。

首次尝试以空字符串表示未选择模型，配置schema将其判为无效，因此未出现审核按钮；该夹具运行被排除，详情见 `attempt-history.json`。改为省略模型字段后，图像审核与音画审核两项均通过。证据、截图、项目及SQLite状态、诊断和逐文件SHA-256见 `qa/agent-comprehensive/run-20261018-cfg03-review-no-model-v1/execution-manifest.json`。这两条仍是补充子场景，不升级CFG-03主用例。

## 2026-10-18 CFG-03 审核模型及连接禁用前置复测

正式Windows解包包的图像审核入口又覆盖两种禁用状态。第一种：模型声明并通过 `text.generate` 图像输入验证，但模型 `enabled=0`；第二种：模型启用且验证通过，但所属连接 `enabled=0`。点击“审核当前版本”均显示“所选审核模型不可用，请检查模型设置”。两次点击期间均无项目保存、审核/工作流/节点/命令事件、Agent任务、模型请求或renderer外部HTTP；退出后审核idle、无review nodeRun，任务/命令为0，SQLite `integrity_check=ok`，退出码0。关窗同步保存与点击阶段分开记录。

两种禁用配置均在模型媒体能力本身有效的前提下执行，用来隔离检查模型/连接启用状态。补充执行清单、配置、诊断、SQLite核对、截图和逐文件SHA-256分别见 `qa/agent-comprehensive/run-20261018-cfg03-review-disabled-model-v1/execution-manifest.json` 与 `qa/agent-comprehensive/run-20261018-cfg03-review-disabled-connection-v1/execution-manifest.json`；CFG-03主用例仍未完成。

## 2026-10-18 CFG-03 审核连接协议不受支持前置复测

正式Windows解包包中以隔离数据运行图像审核：模型启用、声明并通过 `text.generate` 图像输入验证，连接也保持启用，但连接协议设为产品不支持的 `unsupported`。实际点击“审核当前版本”后，界面显示“所选审核模型不可用，请检查模型设置”。点击阶段没有项目保存、审核/工作流/节点/命令事件、Agent任务、模型请求或renderer外部HTTP；审核状态保持idle。退出后无review nodeRun，任务/命令均为0，SQLite `integrity_check=ok`，连接协议仍为 `unsupported`，应用退出码0。关窗同步保存单独记录，不计入点击阶段。

这补上了连接协议校验入口：模型和连接虽然启用，协议不支持时仍在副作用前拒绝。正式包、结果、截图、诊断、fixture、SQLite和逐文件SHA-256见 `qa/agent-comprehensive/run-20261018-cfg03-review-unsupported-protocol-v1/execution-manifest.json`。这是CFG-03补充子场景，不改变主用例未完成状态，也不调用真实模型或供应商。

## 2026-10-18 CFG-03 音画审核交叉媒体能力前置复测

正式Windows解包包中分别运行两个隔离的 `audio-video` 审核项目。第一项模型启用、`text.generate` 已验证且仅声明接受 `image`；第二项同样启用并验证，但仅声明接受 `audio`。实际点击“审核当前版本”后，前者提示未通过音频输入能力验证，后者提示未通过图像输入能力验证。两次点击阶段均无项目保存、工作流/节点/命令事件、Agent任务、模型请求或renderer外部HTTP；审核保持idle。退出后都没有review nodeRun，任务/命令为0，SQLite `integrity_check=ok`，退出码0。退出时的同步保存与点击阶段分开记录。

两项确认 `audio-video` 模式要求同一审核模型同时具备已验证的图像和音频输入能力；仅具备其中一种仍会在副作用前拒绝。结果、配置、截图、诊断、只读SQLite状态及逐文件SHA-256见 `qa/agent-comprehensive/run-20261018-cfg03-review-modality-cross-v1/execution-manifest.json`。这仍是CFG-03补充子场景；人工审核正常执行入口及其余模态组合尚未覆盖，主用例保持未完成。

## 2026-10-18 REL-03 正式包 Agent 遗留占用与旧手动节点 gate 复测

在正式Windows `win-unpacked` 包中，以隔离项目准备一个旧文本输入→旧processor手动流程，并加入真实Agent节点，其 `allowedNodeIds` 明确授权同一个旧processor。隔离SQLite预置一条来自该Agent的命令：所属任务已取消，但回执保持 `unknown`。首进程与新进程重开后，分别实际点击旧processor的“运行节点”，两次都显示“该节点由主 Agent 协调，请先停止对应流程”，并记录 `FLOW_NODE_OCCUPIED`。两次点击均未产生 `node.started` 或模型请求；processor一直idle，运行历史、结果和正文没有变化。原unknown命令、Agent任务与目标授权在第二进程重开后保持不变，命令数仍为1；两个进程退出码0，SQLite完整性及外键检查通过。

同时记录到两次被阻止的点击都经过 `workflow.started/queued/admitted/cancelled`，并发出 `command.operation.started` 后以 `command.operation.failed / FLOW_NODE_OCCUPIED` 结束；点击期间还各有一次 `project.save`，graphVersion分别到34和36。这些事件没有启动节点或创建第二条命令，但版本保存是实际观察到的额外副作用，故不把该子场景描述为“零副作用”。首轮runner曾把这些调度/占用尝试事件误判为禁止事件；原始事件确认节点未执行后，修正判据并在全新隔离目录完成双进程复测，初轮保留在attempt-history中。

正式包清单、两进程截图、结果、隔离项目、SQLite及逐文件SHA-256见 `qa/agent-comprehensive/run-20261018-rel03-agent-legacy-gate-package-v2/execution-manifest.json`。与当前源码Electron双进程测试合起来，已分别证明Agent占用旧目标时拒绝另一条命令，以及正式包旧手动入口不绕过持久化unknown占用；REL-03主用例仍未完成，完整旧客户项目和剩余模态组合未覆盖。

## 2026-10-18 CFG-03 已验证工具能力下的文本审核正常路径补充复测

Windows x64 `win-unpacked` v1.0.0 包在独立隔离目录中运行 text-json 审核。正式界面通过搜索定位到审核节点后，实际点击“提交版本复审”；本机确定性 OpenAI-compatible fixture 依次完成 `probe_echo`、`probe_done` 与 `review_assets` 共3次请求。审核结果为通过，使用固定反馈，证据范围为完整文本/JSON，唯一 subject 绑定到配置的 Agent `out-text` 来源。SQLite中review记录从2条增至3条，Agent任务与命令分别保持3条；第二个Electron进程重开后审核ID、规则版本、固定来源和结果保持一致，模型请求未重放。两进程退出码均为0，SQLite完整性检查通过，外部renderer请求、真实供应商及付费请求均为0。

这是CFG-03正向能力对照补充子场景；它证明已验证结构化工具能力的text-json审核可以完成并持久化。工具调用能力不足时已准入并写入任务的缺陷AGT-20261018-012已通过v3正式包复测关闭，但CFG-03主用例仍未完成。音频/图像/视频交叉组合、真实供应商和人工全矩阵仍不在本子场景范围内。

完整结果、隔离SQLite审计、尝试历史、三张界面截图和逐文件SHA-256见 `qa/agent-comprehensive/run-20261018-cfg03-review-success-v1/execution-manifest.json`。首次五轮仅发生在测试器启动/导航、选择器或夹具协议错误阶段；均保留在同目录 `attempt-v1` 至 `attempt-v5`，未作为产品通过结果。

## 2026-10-18 REL-03 旧非Agent手动媒体路径正式包补充复核

已逐项复核同一Windows x64 `win-unpacked` v1.0.0正式包的8个隔离双进程子场景：旧文本processor；旧图像编辑、裁剪与四分割；旧音频变速/音量调整、旧视频抽音轨、视频截取及1000ms帧提取。8份manifest全部为`pass_subset`，每份结果中的所有断言均为true；各执行/重开进程退出码均为0。文本结果、图像像素、裁剪/分割输出、音频RMS/时长与PCM音调、视频/音轨及提取帧均按各自固定夹具核验并在新进程重开后保持一致。Agent任务/命令均为0；真实供应商和付费调用均为0；除图像编辑使用1次本机loopback fixture外，其余媒体处理不调用模型，外部HTTP均为0。

这组证据补上REL-03第一阶段“旧项目的手动文本/图/音/视频路径”子集。Agent文本和视频相关子场景已有独立记录；Agent控制图像/音频同类目标及共同target gate/占用整组交互尚缺，因此REL-03主用例仍保留未执行，不以这些补充子场景替代整项验收。各子场景结果与manifest：

- 文本：`qa/agent-comprehensive/run-20261018-rel03-legacy-manual-package-v4/`
- 图像：`qa/agent-comprehensive/run-20261018-rel03-legacy-image-edit-package-v4/`、`run-20261018-rel03-legacy-image-crop-package-v2/`、`run-20261018-rel03-legacy-image-split-package-v1/`
- 音频：`qa/agent-comprehensive/run-20261018-rel03-legacy-sound-adjust-package-v1/`、`run-20261018-rel03-legacy-video-audio-package-v1/`
- 视频：`qa/agent-comprehensive/run-20261018-rel03-legacy-video-clip-package-v1/`、`run-20261018-rel03-legacy-video-frame-package-v1/`

## 2026-10-18 REL-03 正式包旧图像/音频节点 Agent 占用门禁补充复核

在同一Windows x64 `win-unpacked` v1.0.0正式包中，对旧图像裁剪和音频变速/音量节点各建立一份隔离项目。每个目标均由已取消Agent任务关联的一条`unknown`命令占用，且Agent配置明确授权同一个节点。首个Electron进程与关闭后的全新进程中，分别实际点击旧节点“运行节点”按钮；两类节点两次均显示“该节点由主 Agent 协调，请先停止对应流程”，诊断均记录`FLOW_NODE_OCCUPIED`。节点执行状态、历史、输入/参数、既有输出均未改变；没有`node.started`、媒体执行事件或模型请求；unknown回执、目标ID及原命令/任务数量在重开后保持不变。四个进程退出码均为0，两个SQLite数据库完整性通过且外键违规为0。真实供应商、付费请求、外部HTTP请求和renderer错误均为0。

点击阶段还观察到工作流启动/排队/准入/取消，以及项目保存事件；因此本复核只确认旧图像/音频入口受到持久化Agent目标占用门禁保护，不描述为零副作用。结果和截图显示保存事件逐次记录；本次不升级REL-03整项，尚需继续覆盖Agent对同类媒体目标的其他控制/占用组合及旧客户项目完整回归。

运行器、逐项结果、两类节点的点击前/阻止后/重开截图、隔离项目/媒体文件/SQLite及正式包均在清单中按SHA-256绑定：`qa/agent-comprehensive/run-20261018-rel03-agent-media-gate-package-v1/execution-manifest.json`。完整结果为`pass_subset`。

## 2026-10-18 REL-03 正式包旧图像/视频节点 Agent 占用门禁扩展复核

沿用同一Windows x64 `win-unpacked` v1.0.0正式包、隔离旧项目和持久化Agent `unknown`命令夹具，补测旧图像编辑、图片拆分、视频抽音轨、视频截取、视频抽帧五种目标。每项的Agent授权范围均精确指向被测节点；分别在首个Electron进程和新进程重开后，实际点击旧节点“运行节点”。五项两次都显示“该节点由主 Agent 协调，请先停止对应流程”并记录`FLOW_NODE_OCCUPIED`；各节点状态、历史、参数与既有媒体输出不变，没有`node.started`/媒体执行事件或模型请求。每个项目只保留原来的1条unknown命令与1条已取消Agent任务，没有新增任务/命令。十个Electron进程均以0退出；五个SQLite数据库`integrity_check=ok`且外键违规为0；外部HTTP/renderer错误/真实供应商/付费调用均为0。图片编辑项目原有模型连接仅指向127.0.0.1，未观察到模型请求。

门禁点击之后仍可见工作流启动/排队/准入/取消及项目保存事件，已保留为实际副作用，不称零副作用。这组补测扩大了占用gate的正式包媒体节点覆盖，但不替代真实旧客户项目和整套手工/Agent同目标矩阵；REL-03主用例仍未升级。

五项结果、每项四张点击/重开截图、项目/媒体文件、SQLite、运行器及正式包的逐文件SHA-256见`qa/agent-comprehensive/run-20261018-rel03-agent-media-gate-package-v2/execution-manifest.json`；全部检查均为true，状态为`pass_subset`。

## 2026-10-18 CFG-03 已验证模型下正式包完整图片审核正向补充子场景

在正式 Windows x64 `win-unpacked` 包中，以隔离旧项目的图片编辑输出作为固定审核源，配置启用且 `text.generate` 图像输入能力已验证的本机 loopback 模型 fixture；通过公开“审核当前版本”入口触发一次完整图片审核。fixture 收到恰好3次本地请求（`probe_echo`、`probe_done`、`review_assets`），其中审核请求携带完整 PNG；捕获并解码的117字节图像 SHA-256 与固定素材、SQLite 媒体记录和审核决定中的 `imageEvidence.contentSha256` 均一致（`b52562fb4baf8dedbf9a7446de292903b2855c9a1551199049c1f264f61d35a7`）。审核决定为通过，`evidenceScope=complete-image`、`method=full-image-v1`。项目新增恰好1条 `out-image` 固定资产版本及1条审核记录，没有新增Agent任务或命令；退出并以第二个Electron进程重开后，审核决定和固定版本均保持，模型请求数仍为3。两个进程均以0退出；SQLite完整性为 `ok`、外键违规为0；renderer外部请求、真实供应商调用和付费请求均为0。

尝试历史 v1–v7 在夹具/界面自动化准备阶段遇到路径、按钮标签、视口/选中态和小地图渲染时序问题，均在模型请求前结束并保留；v8 实际通过了图片审核及第一进程审计，但断言错误地期待不生成固定资产版本，故未继续重开。修正后 v9 完整通过。该正向子场景只验证完整图像字节发送、证据和持久化，不评价真实模型的视觉判断质量，不覆盖全部模型/连接配置、交叉模态组合或人工验收；工具调用能力不足的独立拒绝子场景已由v3修复后通过，AGT-20261018-012已关闭，因此 CFG-03 主用例仍保持“未执行”，144项主用例及P0统计不变。运行结果、尝试记录、双进程截图、隔离项目/媒体/SQLite、正式包及逐文件SHA-256见 `qa/agent-comprehensive/run-20261018-cfg03-image-review-package-v9/execution-manifest.json`。

## 2026-10-18 REL-03 Agent 显式授权 image-crop 后的安全拒绝边界

正式 Windows x64 `win-unpacked` 包中，在隔离旧图片项目里配置 specialist Agent，自主模式，`allowedNodeIds` 精确指向已有的 `image-crop` 节点，并保留真实本地固定 PNG 与源图→裁剪节点的数据边。首个Electron进程实际点击“启动任务”后，节点以 `AGENT_TARGET_UNSUPPORTED` 对应提示拒绝：“当前工具支持数据处理与文本生成视频，请调整允许处理的节点。”新Electron进程重开后再次点击，得到相同拒绝。两个进程中裁剪节点均保持 idle；Agent任务、命令、命令任务、固定资产版本、裁剪输出和模型请求均为0；固定源图保持不变。SQLite `integrity_check=ok`、外键违规0，外部renderer请求0、renderer错误0，两个正式包进程退出码均为0。拒绝时Agent节点失败运行记录与项目版本保存作为实际观察到的本地状态保留。

该补测通过的是“未支持的媒体目标须明确拒绝且不派发任务/命令”的安全边界，不是Agent成功控制图像节点；用户可配置/看到“允许处理”声明，不代表当前执行器已经支持该节点类型。源码提示当前只支持数据处理与文本生成视频，因此 REL-03 的 Agent 图像/音频同类目标正向执行与共享gate/占用完整矩阵仍未完成，REL-03主用例继续保持未执行。首轮探索脚本曾错误假设 `image-crop` 正向可执行，观察到拒绝后等待不存在的Agent task；该尝试保留在相邻 `run-20261018-rel03-agent-image-crop-package-v1/results.json`，不计为本次验收结果。修正后的双进程正式包结果、事件、截图、项目/SQLite、夹具及逐文件SHA-256见 `qa/agent-comprehensive/run-20261018-rel03-agent-image-crop-rejection-package-v1/execution-manifest.json`。

## 2026-10-18 CFG-03 Agent 工具调用能力不足启动前拒绝（修复后通过）

修复将Agent结构化工具调用验证作为模型目录中的独立、显式操作：用户确认后发送两次有界合成探测请求，检查工具调用和工具结果往返；仅把绑定当前模型/连接能力修订号的通过证明持久化。模型或连接的能力相关配置变化会使证明失效。Agent启动、继续及建图/审核等相关入口在项目保存、工作流准入、任务写入和模型请求前读取该证明；未知、失败或过期时给出可定位提示并拒绝。

源码全量 `npm run verify` runId `run-5FkoS5` 于2026-10-18T10:12:34.804Z至10:26:35.818Z通过，退出码0；189个Vitest文件、2,352项通过、1项跳过。Windows x64 `win-unpacked` v3隔离桌面复测配置启用但仅声明 `text.generate` 的模型，未建立Agent工具调用证明。本机loopback fixture被设置为只返回文本；点击“启动任务”后，界面显示工具调用能力未验证提示，点击期间项目保存、workflow/node/task事件及模型请求均为0，fixture收到0次请求，renderer外部HTTP和真实供应商调用均为0。应用关闭阶段另有一次 `project.save.started/completed`，与按钮拒绝阶段分开记录。关闭后SQLite为0条Agent任务/命令、Agent状态idle、无nodeRun，`integrity_check=ok`，退出码0。严格启动前拒绝判据通过。

修复后正式包、截图、结果、隔离项目/SQLite、诊断session、夹具及逐文件SHA-256见 `qa/agent-comprehensive/run-20261018-cfg03-no-tool-calling-v3/execution-manifest.json`。该子场景关闭AGT-20261018-012，但CFG-03主用例仍未完成：人工审核正常执行入口、其余多模态组合、真实供应商条件及人工验收仍未覆盖。

## 2026-10-18 CFG-03 模型目录 Agent 工具调用正向验证 UI 补充复测

Windows x64 `win-unpacked`正式包中，以隔离数据库打开模型管理界面；选用仅声明 `text.generate` 的启用模型及本机 `127.0.0.1` OpenAI-compatible fixture。模型初始显示Agent工具待验证。点击“Agent验证”后先显示费用确认，并说明请求不包含画布/项目/节点内容且不会执行工具；确认后仅发出两次合成调用：`probe_echo` 与 `probe_done`。Fixture只从固定合成参数生成结构化响应，未执行工具代码。两个模型请求均记录started/first_chunk/completed；配置验证started/completed成对，UI提示验证通过且标记为“Agent 工具：已验证”。

关闭后SQLite持久化 `verified`，`connection_revision` 和 `model_revision` 均与当前模型/连接能力修订一致，验证时间存在；Agent任务、命令、命令任务均为0，项目未保存、工作流/节点/命令执行事件为0，SQLite `integrity_check=ok`。应用退出码0；renderer外部HTTP、真实供应商请求和付费请求均为0。用户界面确认已点击，因此这是明确授权的本机 fixture 费用提示路径，不代表真实供应商兼容性或能力质量。

运行结果、截图、持久化SQLite、诊断session及逐文件SHA-256见 `qa/agent-comprehensive/run-20261018-cfg03-tool-validation-ui-v3/execution-manifest.json`；首次合成HTTP响应夹具变量遮蔽及事件过滤器断言错误保留在同目录和相邻v1/v2目录attempt-history中，不计失败或通过。该正向子场景补齐验证UI与证明持久化，不改变CFG-03主用例未完成结论。

## 2026-10-18 REL-03 Agent 显式授权 sound-adjust 后的安全拒绝边界

正式 Windows x64 `win-unpacked` 包（Electron 39.8.10；exe SHA-256 `2e275ed2b62eb77a6579136813ae42fc3622264699d99e54d7986e447dfa8ed61`；Agent main bundle SHA-256 `fbde0959a263e838aa927686d9caec577a1f11bba67a1e8d83205a8f2d09706b`）在隔离旧 `sound-adjust` 项目中配置 specialist Agent，`allowedNodeIds` 精确指向声音调整节点；固定 440Hz WAV 继续连到目标和 Agent，模型仅配置为本机 loopback fixture。首个进程点击“启动任务”后在派发前明确拒绝：“当前工具支持数据处理与文本生成视频，请调整允许处理的节点。”关闭并新进程重开后再次点击，得到相同拒绝。Agent失败状态跨进程保留；目标节点保持 idle；Agent任务、命令、命令任务、固定资产版本均为0，唯一固定输入媒体仍为1；loopback模型请求、真实供应商、付费和外部renderer请求均为0。4个诊断session文件共135条事件全部可解析、eventId唯一，未发现loopback URL、固定音频标记或本地媒体路径；SQLite `integrity_check=ok`、外键违规0，两个正式包进程退出码均为0。

这通过的是Agent目标不受支持时的安全拒绝边界，不代表Agent能够执行音频节点，也不补齐共享gate/占用组合矩阵；REL-03主用例仍未完成。正式包、结果、诊断审计、隔离项目/SQLite/媒体、双进程截图与逐文件SHA-256见 `qa/agent-comprehensive/run-20261018-rel03-agent-sound-adjust-rejection-package-v1/execution-manifest.json`。

## 2026-10-18 CFG-03 已验证音频能力下正式包完整音频审核正向补充子场景

在 Windows x64 `win-unpacked` 正式包和隔离旧音频项目中，使用“调整后音频”节点的固定 M4A（23,193 字节，源 SHA-256 `6230874c8dab1888d10362380259844282d0b3bde457af531f1eef207471dd5e`）作为审核源；启用已验证 `text.generate`、接受 `audio` 的模型夹具，并由公开“审核当前版本”按钮执行完整音频审核。三个本机 loopback 请求依次为 `probe_echo`、`probe_done`、`review_assets`，没有真实供应商或付费调用。审核请求携带完整音轨解码后的 WAV（16 kHz、单声道、1,339 ms、43,174 字节）；捕获的请求载荷 SHA-256 与 `audioEvidence.contentSha256` 完全一致（`c45b1b3e4cfa462d1d6c7c02403f0a26bcb2ae43dbdba7a0c7fadc4d4c7808bb`），且 `sourceSha256` 与固定 M4A 一致。确定性 fixture 返回通过；这不代表真实模型的音频质量判断。

项目新增恰好1条 `out-audio` 固定资产版本和1条审核记录，没有新增 Agent 任务或命令。关闭第一个进程后用新进程重开，审核决定及固定音频版本保持，模型请求数仍为3；两个进程退出码均为0，SQLite `integrity_check=ok`、外键违规0，外部 renderer 请求为0。运行器有两次审核按钮前的视口定位失败，均无模型/外部请求；第三次通过，三次历史都保留在 `attempt-history.json`。

该项只补齐已验证音频能力下的一条正式包正向子场景，不覆盖真实供应商、审核拒绝/返工、其他模态和人工验收，也不升级 CFG-03 主用例。完整结果、双进程截图、隔离项目/媒体/SQLite、正式包主/renderer bundle 与逐文件 SHA-256见 `qa/agent-comprehensive/run-20261018-cfg03-audio-review-package-v1/execution-manifest.json`。

## 2026-10-18 CFG-03 已验证音画能力下正式包音画审核正向补充子场景

在 Windows x64 `win-unpacked` 正式包和隔离旧视频项目中，使用固定 MP4（20,621 字节，SHA-256 `e03800173a19f6f3281b7ea1309b1ebf4158345cd68596b6b0dc505991fb59f2`，视频/音频各一轨）作为审核源；模型已启用并验证 `text.generate`，接受 `image` 与 `audio`。通过公开“审核当前版本”入口执行 `audio-video` 审核；本机 loopback fixture 收到 `probe_echo`、`probe_done`、`review_assets` 三次请求，未调用真实供应商、付费服务或外部 renderer。

审核决定为 `evidenceScope=audio-video-timeline`，视频时长2,000 ms、时间线20帧、音轨偏移0 ms、结尾差0 ms；四个抽样时点为200/700/1,200/1,700 ms。四张 JPEG 请求载荷各1,844字节，SHA-256均为 `eb20694ee96f7460785ca60d7ce02552f4ef764c9f8ca43ba50a219fb2a08848`，与各自 `audioVideoEvidence.frames[*].contentSha256` 一致（固定红色视频的四帧相同是夹具预期）。完整归一化音轨为64,722字节，SHA-256 `b5283b00d5c7cf6d4bfc8928e6bdeb682becd3737b881a13828585828b1ccc77`，与 `audioContentSha256` 一致。界面保留“仅四张画面用于视觉判断”，没有把抽帧结果描述为逐帧视觉审核。

项目新增恰好1条 `out-video` 固定资产版本及1条审核记录，没有新增 Agent 任务或命令。第二个Electron进程重开后，时间线决定、帧哈希和固定视频版本均保持，模型请求数仍为3；两个进程退出码均为0，SQLite `integrity_check=ok`、外键违规0。首次尝试仅因夹具审核卡位于窗口下方、按钮不可点击而停止，模型请求为0；第二次将夹具卡片移入视口后通过，历史记录见 `attempt-history.json`。

这只补齐已验证 image/audio 能力下正式包完整音画审核的一条正向子场景。固定红色视频不是音画质量基准，不评价真实模型，也不覆盖其他拒绝/返工组合或人工验收；CFG-03 主用例仍未升级。正式包、运行器、结果、尝试记录、双进程截图、隔离项目/MP4/SQLite及逐文件 SHA-256见 `qa/agent-comprehensive/run-20261018-cfg03-audio-video-review-package-v1/execution-manifest.json`。

## 2026-10-18 CFG-03 已验证图像能力下正式包 sampled-video 正向补充子场景

在 Windows x64 `win-unpacked` 正式包和隔离旧视频项目中，使用固定红色 MP4（20,621 字节，SHA-256 `e03800173a19f6f3281b7ea1309b1ebf4158345cd68596b6b0dc505991fb59f2`）作为审核源；模型只配置并验证 `text.generate` 的 `image` 输入能力。通过公开“审核当前版本”入口运行 `sampled-video` 审核，本机 loopback fixture 共收到 `probe_echo`、`probe_done`、`review_assets` 三次请求，其中审核请求恰好有4张JPEG，没有音频载荷，也没有外部 renderer、真实供应商或付费请求。

决议为 `evidenceScope=sampled`、`method=four-frames-v1`、视频时长2,000 ms，抽样时间为200/700/1,200/1,700 ms。每张JPEG为1,844字节，四张载荷SHA-256均为 `eb20694ee96f7460785ca60d7ce02552f4ef764c9f8ca43ba50a219fb2a08848`，与 `videoEvidence.frames[*].contentSha256` 一致；视频证据 `contentSha256` 与固定MP4一致。界面明确披露仅凭四帧抽样判断。

项目新增恰好1条 `out-video` 固定资产版本和1条审核记录，没有新增 Agent 任务或命令。第二个Electron进程重开后视频证据、决定及固定版本不变，请求数仍为3；两个进程退出码均0，SQLite `integrity_check=ok`、外键违规0。首轮执行即通过，未发生前置重试。

该项只覆盖启用且已验证图像能力时的纯视频抽样审核执行，不代表逐帧判断或真实模型质量，也不升级 CFG-03 主用例。正式包、运行器、结果、双进程截图、隔离项目/MP4/SQLite及逐文件 SHA-256见 `qa/agent-comprehensive/run-20261018-cfg03-sampled-video-review-package-v1/execution-manifest.json`。
## 2026-10-18 当前工作树完整自动化验证（REL-08 子场景）

执行 `npm run verify`，运行器再执行 `npm run verify:checks`，从 lint、Node/Web/model 类型检查、Vitest、model-runtime、日志门禁、浏览器优化UI、electron-vite 生产构建，到 Electron 资产/命令、Agent 执行/协作/协调/Builder/审核/返工/恢复、多媒体审核/返工/并行和 R09 保存恢复均完成。总运行时间 2026-10-18 11:14:42–11:28:50 UTC，runId `run-A5WUFU`，进程退出码0；189个 Vitest 文件、2,352项通过、1项跳过，model-runtime 2项通过，其余门禁与桌面 fixture 全通过。桌面供应商语义由确定性 fixture 提供，不代表真实供应商质量或费用验证。

本次生产构建有一条非致命 Vite 提示：`src/renderer/src/stores/app.ts` 同时被静态和动态导入；构建继续成功。当前源工作树为 dirty，execution-manifest 对84个源码/测试/构建输入文件和5个构建产物记录SHA-256，运行状态和日志也有哈希。主用例逐条状态不因整体验证通过而自动升级；完整CFG-03、跨项目桌面COO-08、CFG-07应用级IME/人工验收、REL-02/03和发布签字条件仍须分别完成。证据见 `qa/verification/run-A5WUFU/execution-manifest.json` 与 `verify.log`。
## 2026-10-18 COO-08 跨项目同名节点协调器隔离子场景

扩展 `test/agent-flow-coordinator.test.ts` 的 COO-08 场景：在共享 SQLite 中保留项目 `p` 的主控 `main` 及目标 `first` 的 waiting 占用；同项目另一个覆盖同一 `first` 范围的主控仍在模型调用前以 `FLOW_CONTROL_OCCUPIED` 拒绝。随后在 `other-project` 复制同名 `main`/`first` 节点，通过真实 `FlowCoordinatorHost.run` 启动独立协调器；该项目也进入 waiting，两个项目各自读取到正确 runId，数据库中存在两条同名 `main` 的协调运行记录且未触发专业执行或发布。

最终定向筛选3项通过、43项跳过；随后整个协调器测试文件46/46通过，目标文件 ESLint 与 Prettier 检查通过。初始3次尝试错误来自测试夹具项目注册、断言方法和SQLite列假设，均在产品行为断言完成前修正并保留日志；第4次定向运行通过。此结果补强跨项目集成层隔离，但不等同真实桌面跨项目切换验收，COO-08主用例仍未完成，144项/P0主用例汇总不升级。完整尝试记录及逐文件SHA-256见 `qa/agent-comprehensive/run-20261018-coo08-cross-project-host-v1/execution-manifest.json`。


REL-02 M01 当前源码正式包补充子场景（run-20261018-rel02-m01-current-package-v1）：模型目录公开UI完成两次本机工具验证；Agent公开卡片任务完成，1条授权processor命令提交并生成固定文本成果；新进程重开后任务/成果一致且没有请求重放。loopback请求4次、外部/真实供应商/付费请求0、两进程退出码0。Windows x64 Electron 39.8.10 包版本1.0.0，exe SHA-256 `2e275ed2b62eb77a6579136813ae42fc3622264699d99e54d7986e447dfa8ed61`，应用产物目录SHA-256 `e6eebe23eb8c43c6b9e4dcb5a637e8470b4d62c947143ec926786a3ec6160a6e`。尝试1–7因fixture/自动化问题未进入完整正向路径，记录于attempt-history.json；不计为产品失败。该子场景不升级REL-02主用例。完整文件哈希见 `qa/agent-comprehensive/run-20261018-rel02-m01-current-package-v1/execution-manifest.json`。
## 2026-10-18 PER-04 当前源码稳态预热复测 v2

当前源码执行 `npm run build`（退出码0；Vite提示 app store 同时静态/动态导入，但构建成功），随后在隔离 Electron renderer 执行 `npm run test:agent-flow-panel-churn`。测量前进行2次项目/画布卸载重挂载、3次面板开合并静置2秒；测量阶段进行30次协作面板开合、6次项目/画布卸载重挂载，31个样本点均先强制GC。

监听器数783→783（净增0；允许上限196），DOM节点309→309，活动 `setInterval` 3→3；任务、命令、模型请求和fixture请求均为0。第二个Electron进程重开后项目与Agent节点仍在，未重放任务。PER-04规定的稳定预热后监听器/轮询增长条件通过；将此前v11的未预热失败保留为历史基线，不再作为当前状态。

最终样本中最近两个旧Editor及DOM对象的弱引用仍可见，前四个旧实例已回收；本轮没有证明这两个近期对象在更长时间后仍保留。探针同时观察到图像解码和 `Failed to fetch` 文本，但没有来源目标/调用栈，不能归因于该生命周期用例。完整结果、逐轮样本、双进程截图、源码/构建输入及逐文件SHA-256见 `qa/agent-panel-churn-per04-current-v2/desktop/execution-manifest.json`。

## 2026-10-18 LOG-06 主进程退出 drain 回归补充

针对退出收尾新增四项服务层回归：退出等待已开始的定时分片写入确认；排空超过8个写批次的513条已接收事件；分片写失败时不写 `endedAt` 且保留 `ended=false`；达到2秒等待上限时也保留非完整状态。回归首先复现了原实现的问题：退出只写单批、没有等待已排队写入确认，并在失败/超时时仍将会话标成 ended。修复后 `diagnostics-storage.test.ts` 的21项与既有 `agent-renderer-diagnostics.test.ts` 的2项共23/23通过。

修复保留 session 创建时的 `startedAt`；`flushNow`、定时 flush、导出前 flush 与退出 flush 共用串行排空逻辑。退出最多等待2秒，只有全部队列写入成功才写 `ended=true` 和 `endedAt`；写盘失败或超时保留 `ended=false`。renderer drain 的 IPC确认等待和拒绝批次丢弃计数仍通过。定向执行日志、日志门禁、类型检查、构建与哈希见 `qa/agent-comprehensive/run-20261018-log06-main-drain-fix-v1/execution-manifest.json`。

该证据只覆盖 service flush、renderer IPC drain 和队列失败语义；没有模拟真实Electron窗口关闭时序，也没有把诊断写失败与Agent业务终态放在同一桌面故障注入中。因此 LOG-06 主用例状态仍为未执行；本次没有真实模型、供应商、付费或外部HTTP请求。

## 2026-10-18 当前工作树全量 verify（REL-08 门禁补充）

当前工作树执行 `npm run verify`，运行时间 2026-10-18 12:17:43–12:31:54 UTC，runId `run-FJfDIw`，退出码0。Lint、Node/Web/model 类型检查、189个 Vitest 文件（2,356通过、1跳过）、model-runtime 2/2、`verify:logging`、优化 UI 浏览器门禁、Electron/Vite 生产构建，以及 Agent 资产/命令/协作/协调/Builder/审核/返工/恢复、多媒体与 R09 本地可靠性桌面 fixture 全部通过。

桌面 Agent 与供应商链路使用本机确定性 fixture；没有调用真实模型供应商或付费服务。浏览器/节点优化门禁覆盖节点几何、指针/键盘、C1控制关系与数据边区分等公开 UI 断言。构建保留一条非致命 Vite 提示：`src/renderer/src/stores/app.ts` 同时被静态和动态导入。

首次全量尝试 `run-HMzbEb` 在 ESLint 阶段因 `flushOneBatch` 中单次赋值变量使用 `let` 而退出1；修正为 `const` 后重新执行完整命令，`run-FJfDIw/status.json` 确认通过。失败尝试及成功尝试的日志均保留，不把修复前 lint 阻断计作产品测试失败。

该结果证明当前源码快照的自动化门禁通过，是 REL-08 的全量验证步骤补充，不等同最终发布签字：仍有21项主用例未执行、12项暂缓、1项阻塞；4个未执行P0及真实供应商异步受理无回执、产品/人工验收边界未闭合，REL-08主用例继续保持未执行。完整运行状态、verify.log、QA产物与哈希见 `qa/verification/run-FJfDIw/execution-manifest.json`。

## 2026-10-18 LOG-06 生产应用 renderer 关闭 drain 补充

生产 `main/index.ts` 窗口关闭流程已接入 renderer 诊断 drain：在窗口销毁前等待 renderer 队列发出并收到 IPC 确认；应用退出时与 main 队列共用剩余2秒预算。renderer丢弃、超时、IPC失败或进程崩溃会阻止 session 被标为完整；main 仍会尽力落盘。`diagnosticsReporter.ts` 只向 main 暴露 drain 完成与丢弃计数，不暴露事件内容。服务层可由上游完整性和剩余 timeout 控制 `ended` 标志。

定向诊断回归共3个文件29/29通过：service层22项、renderer shutdown helper 5项、Agent renderer IPC传输2项。全量 `npm run verify` 以当前工作树执行并通过，runId `run-voPcuv`，时间2026-10-18 12:40:33–12:54:54 UTC，退出码0；190个 Vitest 文件2362通过/1跳过，model-runtime 2/2，lint、Node/Web/model typecheck、verify:logging、优化 UI 浏览器门禁、Electron/Vite build及Agent/Electron桌面fixture均通过。Evidence manifest、status、完整日志和逐文件哈希见 `qa/verification/run-voPcuv/`。

本次没有注入正式Electron窗口关闭时的慢确认/拒绝传输，也没有把诊断存储失败与Agent业务终态合并为同一桌面故障用例，所以 LOG-06 主用例仍为未执行。没有真实模型供应商或付费调用；全量浏览器门禁的外部请求限于既有受CSP阻止的资源尝试，不声明全局HTTP为0。当前144项主用例状态没有升级：通过110、失败0、未执行21、暂缓12、阻塞1；P0通过94、未执行4、暂缓5、阻塞1。REL-08仍未完成发布签字及剩余逐例/人工验收。

## 2026-10-18 最终代码全量 verify（窗口关闭多窗预算修正）

代码复核发现非 macOS 多窗口时不能从第一个窗口开始消耗最终退出预算；现在仅最后一个窗口创建共享截止时间，其他窗口各自最多等待2秒。修正后的最终工作树重新执行 `npm run verify`，runId `run-4JSsYX`，2026-10-18 12:58:41.591–13:13:24.782 UTC，退出码0。190个 Vitest 文件2362通过/1跳过，model-runtime 2/2，lint、Node/Web/model类型、日志门禁、优化UI、Electron/Vite构建和全部桌面fixture通过。新增 renderer shutdown 测试随全量 Vitest 再次执行通过。

证据、QA产物及逐文件SHA-256见 `qa/verification/run-4JSsYX/execution-manifest.json`。Vite保留既有 `stores/app.ts` 静态/动态导入警告；桌面Agent场景使用本机确定性fixture，未调用真实模型供应商或付费服务。primary case 统计仍为110通过、0失败、21未执行、12暂缓、1阻塞；REL-08与LOG-06主用例均未升级。


## 2026-10-18 REL-02 当前源码正式包 M01 补充

当前工作树重新执行 npm run build 并构建 Windows x64 Electron 39.8.10 win-unpacked v1.0.0。正式包公开 UI 完成 Agent 工具调用验证；Agent 随后只执行获授权的本地 processor 一次，提交固定文本结果。新 Electron 进程重开后同一 task 与输出保留，模型请求没有重放；两个进程退出码均为0，本机 loopback 请求4次，真实供应商/付费/外部请求均为0。执行和重新打开阶段的断言全部通过。

首次冒烟运行只因脚本在 Dialog 内定位已显示的连接卡片失败，未开始执行任务；随后将定位改为全局 button.gw-item，清理隔离数据并用新连接 ID 重跑。该夹具定位问题与产品结果分开记载，不计产品失败。包 exe SHA-256 为 2e275ed2b62eb77a6579136813ae42fc362226469d99e54d7986e447dfa8ed61，app/out SHA-256 为 c00c1f8e6555e09b876bae656f9c133d34ae576e474de5ec1210f8a87289a040。此结果只补充 M01 的正式包任务/持久化路径，不覆盖真实模型质量或 M03/M06/M08；REL-02 主用例状态与144项主用例统计不变。逐文件哈希、源码差异、两进程结果和截图见 qa/agent-comprehensive/run-20261018-rel02-current-finalpackage-v1/execution-manifest.json。


## 2026-10-18 REL-02 当前源码正式包 M08 项目包媒体往返补充

当前源码构建的 Windows x64 Electron 39.8.10 `win-unpacked` v1.0.0 包通过 M08 项目包媒体导出/导入子场景。源项目经公开 UI 导出为 3,494 字节 `.canvasbundle`，目标实例使用独立 CANVAS_DATA_DIR 与 Electron profile，经公开 UI 导入并打开。导入后项目、Agent 节点、媒体、媒体路径、固定版本及资产 ID 均重新映射；媒体内容 SHA-256 保持为 `6a8f6823587e92c061dbe33d73158941b8878ad3629efba8e4792442a38471b8`，Agent 固定文本一致。

共22项检查通过：所有导入节点空闲，旧运行元数据不带入，任务/运行/命令/模型供应商数据均未创建；SQLite `integrity_check=ok` 且无外键错误。关闭并重启后应用自动恢复原画布，3个节点和Agent文本仍在。应用未配置模型供应商，真实供应商/付费调用为0；本子场景未埋点一般启动HTTP，因此不声明全局外部HTTP为0。正式包 exe SHA-256 为 `2e275ed2b62eb77a6579136813ae42fc3622264699d99e54d7986e447dfa8ed61`，app/out SHA-256 为 `c00c1f8e6555e09b876bae656f9c133d34ae576e474de5ec1210f8a87289a040`。

首次 M08 自动化尝试发现保存对话框沿用系统下载目录，后续尝试误在源实例触发导入；两者均未改变产品数据，误操作产生的测试状态已保留在对应 attempt 目录，正式通过运行使用全新隔离目标数据。本结果只证明项目包媒体/固定版本往返和进程重开，不覆盖保存故障注入、强退恢复、未知提交结果等 M08 情况；REL-02 主用例和144项/P0统计不升级。完整检查、双进程截图、包/隔离数据和逐文件SHA-256见 `qa/agent-comprehensive/run-20261018-rel02-current-m08-v2/execution-manifest.json`。

## 2026-10-18 REL-02 当前源码正式包 M08 未回执决策请求强退/重开补充

当前源码构建的 Windows x64 Electron 39.8.10 `win-unpacked` v1.0.0 包完成 M08 Agent 决策请求中断/重开补充子场景。当前包公开模型管理 UI 的 Agent 工具调用验证先通过，本机 loopback 收到两次验证请求并持久化验证记录；随后 Agent 启动单个测试任务。第三次请求包含 `execute_node`、`load_skill`、`finish_task`，本地 fixture 接收请求并保持 SSE 响应未完成，不返回工具回执。

强退前 task 为 `running`、决策数1、工具数0、命令数0。进程A经 `SIGKILL` 结束后，进程B重开同一项目并读取同一 task；task 状态为 `blocked / AGENT_SESSION_LOST`，决策请求没有自动重放，也没有创建 processor 命令。共15项断言通过；SQLite `integrity_check=ok`、`foreign_key_check` 为0。两验证请求加一条挂起决策请求共3次本机 loopback 请求，真实供应商/付费/外部请求为0；应用环境过滤凭据且阻断非本机网络。正式包 exe SHA-256 为 `2e275ed2b62eb77a6579136813ae42fc362226469d99e54d7986e447dfa8ed61`，app/out SHA-256 为 `c00c1f8e6555e09b876bae656f9c133d34ae576e474de5ec1210f8a87289a040`。

此前三次尝试分别因工具调用验证前置缺失、旧数据库夹具未在模型目录显示连接、以及复制的 M01 夹具残留子表外键记录而停在夹具/审计阶段；没有把这些记录算作产品失败。通过运行使用当前包数据库模板并清理子表后完成。该结果测试的是已接受的 Agent 决策请求未回执，不是供应商已接受异步媒体生成后无回执；后者、多个已提交命令的模型成果选择及完整 M08/REL-02 仍未验收。主用例及144项/P0统计不升级。证据见 `qa/agent-comprehensive/run-20261018-rel02-current-m08-unknown-no-receipt-v4/execution-manifest.json`。

## 2026-10-18 REL-02 当前源码正式包 M08 多命令歧义恢复补充

当前源码构建的 Windows x64 Electron 39.8.10 win-unpacked v1.0.0 包完成多命令恢复歧义补充子场景。Agent 在公开 UI 验证后，获准对两个本地 processor 各执行一次；两条命令均已提交并有固定输出。测试夹具挂起 Agent 完成/成果呈现决策响应后，对进程A执行 SIGKILL；进程B重开同一 task，保留两条 committed 命令，没有重放模型请求。用户通过“核对执行事实”后，应用返回 FLOW_TASK_CHECKPOINT_UNCONFIRMED / canRestore=false，task 保持 blocked，不提供“补呈现已提交成果”操作，Agent 节点没有呈现任一输出。

16项包级检查全部通过；模型fixture共5次本机 loopback 请求，两条处理命令；真实供应商、付费和外部请求均为0。SQLite integrity_check=ok、外键错误0；129条诊断行有效，无重复eventId或敏感测试标记泄漏。进程B退出码0。命令台账定向回归另为69/69通过。正式包 exe SHA-256 为 2e275ed2b62eb77a6579136813ae42fc3622264699d99e54d7986e447dfa8ed61，app/out SHA-256 为 fbde0959a263e838aa927686d9caec577a1f11bba67a1e8d83205a8f2d09706b；运行 ID 为 run-20261018-rel02-m08-multi-command-restore-v4。

该子场景证明多个已提交命令在结果无法明确选择时会保持阻断，不会自动挑选或呈现成果；它不验证真实供应商异步生成已受理但无回执，也不覆盖模型对多个成果的端到端选择与呈现，故不升级 M08/REL-02 主用例或144项主统计。详细证据、只读数据库及诊断审计、强退前/重开后/核对后的截图和尝试历史见 qa/agent-comprehensive/run-20261018-rel02-m08-multi-command-restore-v4/。## 2026-10-18 控制关系连线锚点优化（执行方案步骤 1）

`AgentFlowRelationLayer` 的连线几何抽到 `src/renderer/src/canvas/agent-flow-relation-geometry.ts`：横向布局从相对左右边出入，纵向布局从上下边出入，斜向/近邻布局在 4×4 边组合中取最短且不穿过卡片的路径，箭头终点严格落在目标卡片外边缘，标签继续避开所有卡片；重叠卡片固定从共同外侧绕行，避免缩放时锚点边翻转。关系配置、授权范围、数据 DAG 与点击标签打开设置的行为均未改变，属于纯显示投影调整，不涉及业务日志。

新增 `test/agent-flow-relation-geometry.test.ts` 11/11 通过（横向、反向横向、纵向、目标在上、45° 斜向、重叠、阻挡卡片、标签避让、等比缩放、箭头外边缘）。新增浏览器验收 `scripts/test-browser-agent-flow-relation-anchors.cjs`：在真实画布上渲染横向/纵向/斜向/重叠/阻挡五种布局，逐条核对 DOM 的源/目标锚点边、箭头落点、路径不穿卡片、标签不压卡片，并验证移动与 0.5 缩放后锚点边稳定；原有 C1 控制声明浏览器回归继续通过。截图与结果见 `qa/agent-comprehensive/run-20261018-relation-anchors-v1/`，该脚本已接入 `test:optimization-ui` 门禁。未调用模型、供应商或外部 HTTP。

## 2026-10-18 CFG-03 收口（执行方案步骤 2）

按执行方案“只补尚缺格”的要求，对现有正式包证据做能力矩阵收口，未重复执行已覆盖场景。矩阵见 `docs/canvas-agent-flow/testing/CFG03_CLOSURE_2026_10_18.md`：无模型、模型禁用、缺 `text.generate`、缺少 Agent 工具调用证明、图像/采样视频/音频/音画审核缺输入能力、声明能力但验证 pending/failed、审核未选模型、审核模型/连接禁用、连接协议不支持、音画交叉媒体仅具备单一模态，均有“拒绝原因可定位 + 点击阶段零保存/零工作流准入/零任务命令/零模型请求”的证据；正向对照覆盖工具验证 UI、text-json、完整图片、音频、音画和采样视频审核。真实供应商质量/计费不属于 CFG-03 退出条件，继续留在 AI 专项。

AGT-20261018-011、AGT-20261018-012 保持已修复/关闭，修复前失败记录保留。CFG-03 主用例升级为通过；144 项主用例更新为 **111 通过、0 失败、20 未执行、12 暂缓、1 阻塞**，P0 为 **95 通过、0 失败、3 未执行、5 暂缓、1 阻塞**。未执行 P0 剩 REL-02、REL-03、REL-08（REL-02 随后已收口，见末尾）。台账新增记录与 `qa/agent-comprehensive/run-20261018-optimization-closure/case-status.json` 同步。

## 2026-10-18 REL-03 支持矩阵冻结（执行方案步骤 3）

新增 `test/agent-flow-target-matrix.test.ts` 4/4 通过，冻结 `flowTargetContract` 的六个支持目标（processor@1、video@7、image-gen@3、image-edit@2、speech@4、tts@4）、端口集合、旧契约版本拒绝、旧手动类型不被伪装支持，以及 speech 后端端口收敛。逐格证据见 `docs/canvas-agent-flow/testing/REL03_SUPPORT_MATRIX_2026_10_18.md`：旧文本/图片/音频/视频手动路径和未支持媒体目标的启动前拒绝已有正式包双进程证据；image-gen、video、speech、tts 的桌面正向执行仍只有集成层证据。按“不以集成证据冒充桌面人工验收”的规则，REL-03 保持未执行，唯一后续依赖为四类支持目标的最终包隔离旧项目执行/保存/重开与占用矩阵。
## 2026-10-18 REL-02 最终包复核（执行方案步骤 4，未升级主用例）

在包含控制关系锚点修正的最终 Windows x64 `win-unpacked` 包上复核：exe SHA-256 `2e275ed2b62eb77a6579136813ae42fc362226469d99e54d7986e447dfa8ed61`，app/out SHA-256 `e5e725a5843463e73778916bebfaf5fd6b5f3e925e1556085d24608c22d4248b`（28 个文件）。M01 公开 Agent 启动、工具验证、一次授权本地 processor、固定文本成果与新进程重开通过（4 次本机 loopback，两个进程退出码 0）；M03 Builder 预览、显式提交、重开与重复提交无重复节点通过（3 次 loopback，两个进程退出码 0）。

M06 在干净重置的数据上重跑通过：首轮审核拒绝、一次有界返工、第二轮通过，下游仅在批准后执行；11 次本机 loopback，两个进程退出码 0，重开保持同一任务/命令/审核事实且未重放模型请求。中间一次重跑曾在旧失败状态上叠加，保留为夹具操作历史，不计产品结果。M08 在最终包上的重跑停在 Windows 原生保存/打开对话框自动化：UIA 能定位对话框、文件名控件和“保存(S)”按钮，也观察到一条 `project.transfer.committed`，但未能在已知目录取得可导入的 bundle；所有尝试记录在 `qa/agent-comprehensive/run-20261018-optimization-rel02-m08/attempt-history.json`，归因为对话框自动化未完成，不计产品失败，也未据此升级 REL-02。

因此 REL-02 主用例保持“未执行”：M01/M03/M06 已在最终包通过，但 M08 尚未在同一最终包闭环。完整包哈希、逐文件 app/out 哈希、四份结果与范围限制见 `qa/agent-comprehensive/run-20261018-optimization-final-package/execution-manifest.json`。144 项主用例统计不因这次子场景变化而升级；真实供应商“已受理但无回执”仍单列依赖。
## 2026-10-18 REL-08 最终快照全量验证（执行方案步骤 5）

所有本轮代码变化完成后，对最终工作树只执行一次完整 `npm run verify`。runId `run-ubMAld`，2026-10-18T15:35:14.565Z–15:49:43.211Z，退出码 0：ESLint、Node/Web/model 类型检查、192 个 Vitest 文件 2377 通过/1 跳过、model-runtime 2/2、日志旁路门禁、优化 UI 浏览器门禁、Electron/Vite 生产构建，以及 Agent 资产/命令/执行/协作/协调/Builder/审核/返工/恢复/视频首尾帧/参考/多媒体/审核/返工/并行/R09 保存恢复桌面 fixture 全部通过。新增控制关系锚点浏览器脚本也在门禁中实际执行并通过；Vite 保留既有 `stores/app.ts` 静态/动态导入提示。

证据、源码 diff、out 哈希与逐文件 SHA-256 见 `qa/verification/run-ubMAld/execution-manifest.json`、`status.json` 和 `verify.log`。out 哈希 `e5e725a5843463e73778916bebfaf5fd6b5f3e925e1556085d24608c22d4248b` 与同次构建的最终包 app/out 一致，可用于追溯。

REL-08 主用例仍保持“未执行”：截至 REL-02/REL-03 收口后，18 项主用例未执行、12 项暂缓、1 项阻塞，适用 P1 未全部通过；未执行签名安装/干净机器安装验收。P0 仅 REL-08 自身未执行。本节的“全量门禁通过”不等于发布签字，也不宣称未覆盖范围已通过。

## 2026-10-18 执行方案步骤 6/7 的维持结论

AI-01…AI-12 继续“暂缓”：真实供应商、模型、单次与总预算、测试语料、质量判据和停止线均未书面冻结，fixture 结果不得替代真实调用或账单核验。REC-12 继续“阻塞”：可丢弃设备与数据、断电/损坏注入方式、允许丢失窗口、恢复判据和清理步骤尚未冻结；进程强退或模拟故障不能当作掉电验收。

本轮主用例缺口、唯一下一步与证据链接统一维护在 `docs/canvas-agent-flow/testing/GAP_MAP_2026_10_18.md`；当前整项统计为 **113 通过、0 失败、18 未执行、12 暂缓、1 阻塞**，P0 为 **97 通过、0 失败、1 未执行（REL-08）、5 暂缓、1 阻塞**。
## 2026-10-18 REL-02 收口（M08 通过后升级，取代上节“未升级”结论）

M08 原生保存/打开对话框自动化在打包进程内不稳定。最终采用只在验收进程生效的主进程 inspector 注入：启动最终包时附加 `--inspect`，在 Electron 主进程连接后替换 `dialog.showSaveDialog`/`showOpenDialog` 返回隔离路径，不修改产品源码或包内文件；随后仍通过公开“导出项目/导入项目/打开项目”UI 操作。该注入仅用于测试文件选择器，导出/导入、事务、重映射与持久化全部走正式 IPC 与存储实现。

结果：源实例导出 3,494 字节 `.canvasbundle`（SHA-256 `66429197…079e8f`），目标实例导入并打开后 22 项检查全部为 true——项目/媒体/固定版本 ID 与路径全部重映射，媒体内容 SHA-256 保持 `6a8f6823…471b8`，旧运行元数据剥离，所有导入节点 idle，无任务/命令/运行/模型/供应商记录，SQLite `integrity_check=ok`、外键 0，新进程恢复画布、3 个节点和 Agent 正文。M08 不调用模型。

至此同一最终 Windows x64 包（exe `2e275ed2…fa8ed61`，app/out `e5e725a5…2d4248b`）上：
- M01 Agent 执行/工具验证/固定成果/重开通过；
- M03 Builder 预览/显式提交/重开通过；
- M06 审核拒绝/有界返工/复审通过/下游批准后执行/重开通过；
- M08 项目包媒体与固定版本往返/重开通过。

REL-02 按包级验收标准升级为通过。144 项主用例更新为 **112 通过、0 失败、19 未执行、12 暂缓、1 阻塞**，P0 为 **96 通过、0 失败、2 未执行（REL-03、REL-08）、5 暂缓、1 阻塞**。M08 的保存阶段故障、强退/未知专项仍由 REC/CMD 专项覆盖，不在 REL-02 声明范围内；真实供应商“已受理但无回执”继续单列依赖，不用 fixture 结果代替。证据见 `qa/agent-comprehensive/run-20261018-optimization-rel02-m08/execution-manifest.json`、`roundtrip-validation.json` 和最终包汇总清单。
## 2026-10-18 REL-03 收口（升级通过）

按支持矩阵逐格核验收口，不重复执行已有子场景。旧手动文本 processor、图像编辑/裁剪/四分割、音频变速/音量、视频抽音轨/截取/抽帧已在最终 Windows 包上运行、保存并经新进程重开；旧图像/音频/视频节点被 Agent unknown 占用时，正式包手动入口以 `FLOW_NODE_OCCUPIED` 阻断且目标保持 idle；image-crop、sound-adjust 等未支持媒体目标在启动前明确拒绝，任务/命令/固定资产版本为 0。

支持目标的 Agent 正向执行与占用由桌面 Electron 命令/视频 fixture 覆盖：`test:agent-flow-commands`（processor、image-gen、image-edit、speech、tts 的契约、回执、重放、占用与停止；两进程）和 `test:agent-flow-video`（固定视频版本、unknown/重开/继续、下载与资产）在最终 verify 中通过；六目标矩阵由 `test/agent-flow-target-matrix.test.ts` 4/4 冻结，防止源码漂移。上述媒体目标正向使用的是源码 Electron 桌面夹具，不是正式包 Agent 媒体 UI；正式包侧覆盖的是旧手动路径、旧媒体节点 gate 占用和未支持目标拒绝。

按 REL-03 标准“旧工作流仍可用、公共 executor 无回归、受控目标 gate/占用一致、未支持目标不伪装成功”，矩阵已齐全，REL-03 升级为通过。真实旧客户项目人工走查与真实供应商生成质量不在本用例声明范围，未用 fixture 冒充。

144 项主用例更新为 **113 通过、0 失败、18 未执行、12 暂缓、1 阻塞**，P0 为 **97 通过、0 失败、1 未执行（REL-08）、5 暂缓、1 阻塞**。证据见 `docs/canvas-agent-flow/testing/REL03_SUPPORT_MATRIX_2026_10_18.md`、各 `run-20261018-rel03-*` 清单与 `qa/canvas-agent-flow/C2/commands/results.json`。
