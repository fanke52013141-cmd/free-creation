# Agent Flow 开发与交付台账

日期：2026-10-12。确认方案：[完整版](00-approved-plan.md)。

| 包       | 状态                         | 范围                                                          | 验证与边界                                                                                               |
| -------- | ---------------------------- | ------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| 完整方案 | 已发布，57db152              | 画布协作、Agent/状态机/审核、Skill/工具、资产、返工、实施顺序 | 文档格式/链接/差异检查；远端 main 哈希已核对                                                             |
| C0       | 实验底座已交付，生产接入待补 | 框架版本、有限循环、模型单步、checkpoint、执行桥实验          | 16 定向测试、全量 verify、最新构建的隐藏 Electron 双进程通过；豆包最小工具协议已验证；生产执行桥尚未接入 |
| C1       | 配置基础已开始               | 三种配置节点、Schema、公共 UI、端口、保存                     | 契约与注册测试通过；关系呈现及实际执行仍待后续                                                           |
| C2–C4    | 未开始                       | 见确认方案                                                    | 无生产执行验收证据                                                                                       |

## 发布备注

完整方案不恢复已撤回的旧 Agent Flow，实现必须从当前源码演进。C0 使用隔离数据，先证明框架/宿主/回执/恢复；不得把实验实现宣传为已完成画布 Agent 或 AI 审核功能。后续每包记录真实测试、提交及未覆盖范围。

## C0 实施记录

依赖显式锁定 core 1.2.9、LangGraph 1.4.14、checkpoint 1.1.5，沿用原锁定版本，无框架大版本升级。使用已有 better-sqlite3 和 checkpoint SerializerProtocol 适配；实验创建自己的表，未迁移生产库。

LangGraph 运行受范围/版本校验的有限循环。命令先持久 pending 再发送，完成后保存回执；相同命令返回原结果，输入冲突拒绝，pending/未知不自动重发。人工继续携带 task/revision，过期或重复响应拒绝。SDK 单步只返回工具提案，由实验运行器校验执行，不嵌套另一套工具循环。

Electron 构建增加独立 `out/main/agent-flow-c0.js` 实验入口，使用隐藏沙箱窗口与窄 IPC、隔离临时 DB；退出前关闭窗口/连接，测试脚本检查绝对清理路径。pause 与 resume 分别启动不同 Electron 进程，回执和 checkpoint 跨进程恢复，业务效果次数保持 1。renderer 是确定性 fixture，尚未绑定正式 tldraw/renderer executor，不作为手动/Agent 对等验收。

复跑：`npm run build` 后 `npm run test:agent-flow-c0`；定向测试 `npm run test:agent-flow-c0-unit`。本机原 native SQLite 为 Electron ABI 140，普通 Node 24 ABI 137 不兼容；定向测试使用 Electron-as-Node 22.22.1（ABI 140），未覆盖或重编译个人环境的 native 模块。全量检查在同样匹配的 Node 入口下执行。

模型单步适配已用 OpenAI-compatible SSE fixture 验证结构化 tool-call、单次请求、未知工具拒绝与正文不进诊断；C0 首次交付未发真实请求；本轮已补豆包最小工具协议探测，见下方记录，不外推为完整 Agent 能力。checkpoint 含业务上下文，仅存实验库，不导入诊断包；诊断走现有底座，验证范围见 LOGGING_COVERAGE。

本轮已补最小真实模型探测与生产桥审阅，并进入 C1 配置基础开发。下一步补控制关系呈现、目标选择与转换编辑；正式命令对等验收归 C2，C0 入口不能直接成为生产调度入口。

### 基线与测试环境备注

- 本机默认 pnpm 为 11，仓库声明 10.33.0；使用声明版本执行安装与检查，保留原锁文件中全部既有依赖版本，仅增补三项显式依赖。
- 全量检查使用隔离 QA 目录内的 Node/pnpm 启动适配：Node 入口匹配现存 Electron SQLite ABI，不修改全局配置、不删除/rebuild 原有 native 模块。
- 既有浏览器脚本硬编码 Chrome，本机未安装；QA 启动适配将该 launch 转到已安装的 Playwright Chromium，仅对本次检查进程生效，不改正式应用或已有浏览器脚本。最终结果登记时注明这一环境差异。
- 同步到的线上折叠堆叠行为（85980d3）已隐藏成员端口，两项源码静态断言仍要求旧表达式。只更新 node-ui-decisions/canvas-ui-interactions 中对应断言，未修改 NodeCardView；定向 126 项通过，不通过放宽业务校验掩盖失败。

### 日志检查自查

影响为新增隔离实验执行/模型协议/SQLite/文件路径；公共模型事件复用现有入口，实验生命周期、回执/未知结果和 checkpoint 阶段由 C0 模块记录，恢复关联旧 trace。允许字段仅阶段、稳定原因和 ID，业务正文和原始异常不进入诊断。命令成功只表示有效结果回执已持久化，不表示正式画布项目已保存。已测正常、去重、范围/版本、超时未知、数据库拒写/事务、重开、日志故障和私有样例；真实模型取消、生产执行器和正式资产/审核链路仍未覆盖。覆盖清单已同步，证据仅复制诊断与无正文的报告，不打包实验数据库。

### 最终验证证据

- `npm run verify` 通过（匹配的 Electron-as-Node、pnpm 10.33.0 和本机 Chromium QA 适配环境）。142 个测试文件、1572 项通过、1 项既有跳过；模型运行模块另 2 项通过。lint、两端/模型类型检查、日志门禁、14 项浏览器脚本和 main/preload/renderer 生产构建均通过，记录 `qa/canvas-agent-flow/C0/verify.log`。
- `npm run test:agent-flow-c0-unit`：16 项通过；两条线上基线静态断言修正后，与 C0 一起定向 126 项通过。
- 最新构建后 `npm run test:agent-flow-c0` 再次通过：pause/resume 为不同 Electron 进程，checkpoint 存在、窗口隐藏、工具效果计数始终 1。证据 `qa/canvas-agent-flow/C0/electron-results.json`，无正文或 Key。
- 文档格式、链接和 `git diff --check` 通过。生成的既有 QA 文件不纳入源码交付；验证证据保留在隔离 C0 目录。
- 交付边界仍为实验底座，不是 C1 画布节点产品验收，不是 C2 生产执行器对等，也不证明任何真实模型自主执行或 AI 审核质量。

## 2026-10-12 模型探测、生产桥审阅与 C1 首批配置节点

模型探测和生产桥审阅见 [审阅记录](09-model-probe-and-production-bridge-review.md)。保存的凭据暂不可读时未发请求；随后使用用户明确提供的临时豆包凭据，两个有界文本请求实测工具参数与改变后的工具结果均通过。凭据没有保存到代码/配置/报告。取消/并行/媒体仍 unverified。

C1 已开始：agent/state-machine/ai-review 三种可创建配置节点，contractVersion=1，复用公共壳/设置/指针规则/菜单/色板，config/text 分开保存。执行明确 blocked/skipped，输出投影空，不假装功能已运行。Schema 与固定版本审批匹配、确定性状态转换有测试；控制声明不进入数据 DAG。剩余 C1 的控制关系呈现、节点目标选择、转换编辑器，以及 C2/C3 的真实执行与资产事务仍需继续，不标为全包完成。

日志影响与验证边界见 LOGGING_COVERAGE 及审阅记录的日志自查。公共配置保存/跳过沿用既有日志，探测准备和模型失败有明确阶段；实际证据仅报告与诊断，无原始业务库。

### 本轮最终验证

- 最终 `npm run verify` 完整通过，记录 qa/canvas-agent-flow/C0/c1-verify-final.log；145 个测试文件、1601 项通过、1 项既有跳过，model-runtime 另 2 项通过；lint、两端/模型类型检查、日志门禁、15 项浏览器脚本及 main/preload/renderer 生产构建通过。
- 使用既有 Electron-as-Node/native ABI、pnpm 10.33.0 与本机 Chromium QA 适配；未改个人 native 安装。测试图库视口与节点计数随新增节点调整，最大缩放仍完整验收所有卡片；冷启动首个选择器有界等待 60 秒。
- 31 种节点两主题/三档缩放、颜色与指针通过；新增三节点设置保存、文档快照恢复、图 config 一致和空输出通过。证据 qa/canvas-agent-flow/C1/settings-results.json、review-settings.png；C1 定向指针记录 c1-pointer.log。
- 最新构建复验 C0 两个 Electron 进程 pause/resume，工具效果仍为 1；探测缺少 allow-cost 在 cost-guard 阶段终止，无模型请求。真实豆包探测仍仅两次，未为重新构建重复付费调用；取消/并行/媒体尚未验证。
- 实际真实探测报告/诊断扫描：凭据前缀、认证字段、端点、合成请求/回传正文匹配数为 0。诊断准备失败的当前构建也已实测；日志与证据不含业务 DB。日志验收局限在本轮受影响路径，不宣称生产桥/资产/审核/返工完成。
- 剩余工作：完成 C1 控制关系呈现、目标选择和转换编辑；再执行 C2 生产桥/资产事务对等门槛与 C3 真实任务/返工。可创建配置节点不等于可执行 Agent 产品。
