# 节点流深度审查与真实验收（2026-11-27）

> 基线：`main@3428a50b`。本轮只审查当前工作区源码与真实 Electron/SQLite/CLI/MCP 路径，不把历史文档或测试数量当作产品验收。所有付费模型路径均未调用真实供应商。

## 1. 结论

**审查前不能认为“节点流完全通畅”。** 本轮发现并修复了多条会直接造成丢线、丢输入、等待误报完成、重复执行、循环不推进或历史运行不可读的阻断问题。

修复后，当前自动化证据覆盖：

- 基础节点串联、广播并联、扇入、菱形、长链、子图与单节点手动运行；
- composite 编辑页保存/重开、固定版本引用、公开边界保留、发布/升级/删除保护；
- composite 串行/并行/嵌套、人工等待与续跑、原输入恢复、公开输出落账；
- Agent Flow review 图、capability/human-task 循环、coordinator 单驱动、并联 join、停止/超时/恢复；
- 真实 Electron 桌面、SQLite、CLI 与 MCP 的确定性验收。

但“自动化覆盖内通畅”不等于所有真实环境都已闭环：真实付费模型、物理掉电、真实磁盘硬件故障、Windows 安装包与干净 Runner 仍未覆盖，详见 §5。

## 2. 范围与方法

### 2.1 代码审查范围

- `src/renderer/src/canvas/graph.ts`、`engine/executor.ts`、`engine/contracts.ts`
- `src/renderer/src/composite/*`
- `src/shared/composite/*`
- `src/shared/agent-flow/flow-graph*.ts`、`context-manifest.ts`
- `src/main/agent-flow/coordinator-host.ts`、`command-ledger.ts`、`coordination-store.ts`、`builder-host.ts`
- `src/main/agent-access/composite-ops.ts`、`service.ts`
- 对应单测与 `scripts/acceptance/*` 真实验收脚本

### 2.2 验收方法

1. 静态审查图构建、端口路由、持久化、执行生命周期与失败路径。
2. Electron ABI 下运行定向 Vitest，覆盖纯函数、真实 SQLite、进程硬杀与恢复。
3. 使用真实 Electron 窗口、CLI、MCP SDK 和确定性模型夹具跑桌面验收。
4. 对失败项定位到具体源码或验收脚本竞态，修复后重跑。
5. 最终运行完整 `npm run verify`，以实际退出码和证据文件为准。

## 3. 发现与修复

### 3.1 Composite / 节点流

| 严重度 | 问题 | 修复 |
| --- | --- | --- |
| P1 | 编辑页重载 W3 引用子流时只写 `compositeNodeId`，未写 `meta.compositeManifest`，`resolvePorts` 得到空端口，`createEdge` 静默失败；保存后子流连线永久丢失 | 铺图前异步解析固定版本并校验 `contentHash`，写入 `meta.compositeManifest`；`createEdge` 失败显式阻断保存 |
| P1 | 编辑保存无条件重算公开边界，会把合法广播 `targets`、非源/汇外部端口、默认值折叠或丢弃 | 新增边界合并：保留仍有效的既有 ID/映射，只为未覆盖端口补自动推导；新发布强制 `runtimeVersion=2` |
| P1 | 整画布把 composite 内部人工等待当普通 skipped，最终仍 toast/event `completed` | `NodeExecutionResult` 增加结构化 `waiting`；整画布与子图运行遇 waiting 立即停止下游并返回 `waiting` |
| P1 | 画布起源 composite 续跑丢失公开输入，且续跑结果不回写画布/台账 | 新增 `resume-composite-canvas` 桌面动作；续跑固定使用原 `inputValues`，复用原实例与已完成步骤；画布运行也持久化 `outputValues` |
| P1 | nested capability ref 与 dependencies 不双向一致，可发布“实际引用但未声明”的流，导致被引用能力可删除 | 发布期校验实际引用与 capability dependency 双向一致；缺声明/多余声明均拒绝 |
| P1 | 新发布可仍为 `runtimeVersion=1`，编辑旧流后继续 legacy 语义 | 发布门禁强制 v2；legacy 验收改为直接 seed 历史 v1 数据，不再经新发布创建 v1 |
| P1 | 删除能力不检查历史运行，删版本后 `run.get/list` 可报 `STORAGE_INCONSISTENT` | 删除前同时检查画布实例、嵌套引用与 `composite_runs` 历史 |
| P2 | CompositeBody 用外层 `nodeRun.runId` 查子运行，步骤列表通常为空 | `CompositeRunOutcome` 回传真实子 `runId` 并写 `meta.compositeRunId`，步骤查询优先使用它 |
| P2 | `defaultValue` 只免检不注入；未知输入端口被静默忽略 | 缺省值转为真实 `NodeValue` 注入；未知端口在执行前返回 `INPUT_PORT_UNKNOWN` |
| P2 | 人工补交 JSON 输出只校验 kind，不校验公开 Schema | 补交前按 `schemaRef` 调 `validateNodeSchema`，失败返回 `OUTPUT_VALUE_INVALID` |
| P2 | 检查点持久化失败可能让内部步骤遗留 `running` | checkpoint 失败显式记 `failed`，再向上返回失败 |
| 验证 | 内部 skipped 是否跨节点传播 | 新增 processor→iterate 必填输入回归，证明下游按 `skipped` 传播而非 `not-run` |

### 3.2 Agent Flow / FlowGraph

| 严重度 | 问题 | 修复 |
| --- | --- | --- |
| P0 | 编译出的 review 图 coordinator tools 只有 `agent.dispatch`，启动即 `FLOW_COORDINATOR_SCOPE_INVALID` | 编译期按图内容补入 `review.execute` |
| P0 | capability/human-task 的 v1 loop 复用 task/command，v2 carrier 停在第一轮，`maxIterations` 不可靠 | 统一 v1/v2 轮次初始化与递增，每轮独立 `taskId/round`，修复上限前提前落定 |
| P0 | renderer 整画布先 topoSort，loop 回边被拒；非 loop 图又重复执行 coordinator 已控制的子节点 | 整画布过滤 coordinator 受控子节点/状态机，只由 coordinator 驱动；手动/局部运行受控节点明确拒绝 |
| P0 | `routedInputEdgeIds: []` 可绕过必需入边与输入绑定 | 空/子集路由在 prepare 阶段拒绝；图模式输入必须绑定真实画布边，非图命令保留原资产引用语义 |
| P0 | 整个 run JSON 限 256 KiB，大 ContextManifest 在副作用前保存失败 | M36 新表独立存储 >16 KiB manifest，读取无损合并；run 主体 8 MiB、单 manifest 4 MiB 显式上限 |
| P1 | graph 完成判定可在子节点仍 ready/running/waiting 时提前 completed | 完成前调用 `assertChildrenComplete`，拒绝未落定子任务 |
| P1 | 声明式 inputs selector 未真正裁剪 path/port，human-task 同端口 many 生成重复端口项 | capability/agent/human-task 按 selector 真值来源裁剪；human-task 同端口多资产合并 |
| P1 | ContextManifest 只按 contentHash 去重，会吞掉不同 source 的 required 贡献 | 去重键改为 source+contentHash，required 升级仍保留 |
| P1 | loop body 内多值 ambiguous 未检查 delivered；skipped exit 不落定导致无法进下一轮 | ambiguous 来源集合纳入 delivered；skipped exit 视为轮次落定 |
| P1 | 首次 confirm/崩溃恢复可“洗白”额外受控入边 | preview/confirm/authorize/restore 发现额外受控入边立即 `FLOW_CANVAS_DIVERGED` |
| P1 | deadline abort 可能被误报完成或会话丢失 | abort 明确 failed + `AGENT_BUDGET_EXHAUSTED` 并释放占用 |
| P1 | stop 任一步骤抛错会跳过 release/终态 | stop 全步骤异常安全，finally 释放占用并写 cancelled 终态 |
| P1 | 图模式人工采纳/协作返工仍要求 renderer 直接运行受控子节点，单驱动改造后卡住 | 协调器用显式协作提交事实续跑等待 Agent；协作返工保留显式启动，但续跑/发布由审核宿主单驱动 |
| P1 | LangGraph resume 先写 pending writes、后写 checkpoint，旧外键把合法顺序判为 `CHECKPOINT_WRITE_FAILED` | M37 移除 pending writes 对 checkpoint 行的超前外键；读取仍只按已存在 checkpoint 关联 |

## 4. 验证证据

### 4.1 定向自动化

- Electron ABI 下节点流/Agent Flow 定向回归：**74 个文件、1050 项全部通过**（广泛运行 73 文件通过，剩余 review-join 修复后 5/5 重跑通过）。
- 覆盖 composite runtime/editor/repo/upgrade/reference、FlowGraph compiler/router/build、coordinator、command ledger、coordination store、db migrations、基础画布矩阵与 node-flow E2E。
- `typecheck:node`、`typecheck:web`、`npm run lint`、`git diff --check` 通过。
- `verify:agent-access`：**191 operations / 34 active nodes**，契约与受保护源码 hash 通过。

### 4.2 真实桌面验收

| 验收 | 结果 | 关键覆盖 |
| --- | --- | --- |
| `acceptance:composite-desktop` | 通过 | 发布/升级/引用/嵌套/递归/预算/媒体/删除保护/MCP |
| `acceptance:composite-gui` | 通过 | GUI 发布、草稿恢复、版本切换、升级、撤销、缺输入阻止 |
| `acceptance:agent-composite-remediation` | 通过（8 scenarios，连续 2 轮） | H01/H09/H10，CLI+MCP，重启恢复、双人工等待顺序；真实原生人工确认驱动 |
| `acceptance:agent-composite-legacy-runtime` | 通过（2 scenarios） | 历史 v1 headless/inline 兼容 |
| `acceptance:agent-capability-params` | 通过 | processor field/path、video featureKey/seed、真实 Host/Store |
| `acceptance:agent-flow-composite-failure` | 通过 | 失败阶段/节点/端口定位、skipped 如实记账 |
| `acceptance:agent-flow-composite-retry` | 通过 | 原输入重试、链式上限、人工补交、终态守卫 |
| `acceptance:agent-flow-edges` | 通过 | 12 节点、四类控制关系、反向数据边、焦点淡化 |
| `acceptance:agent-flow-state-machine` | 通过 | 状态推进、修订冲突、输出投影、MCP 一致 |
| `acceptance:agent-flow-human-task` | 通过 | 人工等待、提交/冲突、续跑消费、公开输出落账 |
| Agent Flow graph 桌面组 | 通过 | capability/parallel/end-to-end/review/collab/media/queue/recovery；含协作等待、返工、重启与停止 |

**H09 人工确认复核补充**：pure headless `composite.run.submitHuman` 使用主进程原生确认框。验收脚本现在通过 Windows UI Automation 按 Electron 主进程 PID 与精确按钮名调用真实「允许提交」控件，不 mock `desktop.ask`、不伪造授权回执；非 Windows 会明确打印人工点击步骤并继续等待生产门禁。修复后 CLI 与 MCP 的 H09 均完成两次确认，整组连续两轮 8/8 通过，每轮报告记录 4 次 `windows-uia-invoke`。此前一次 `HUMAN_DECISION_TIMEOUT` 的根因是脚本没有驱动原生确认框，不作为产品执行逻辑回归。

### 4.3 完整验证

- `ELECTRON_DISABLE_SANDBOX=1 npm run verify` **通过**（退出码 0，证据 `qa/verification/run-Qd20tV/status.json`）。
- 主测试 **372 文件通过 / 2 跳过，4157 项通过 / 7 跳过**；model-runtime 6/6 通过。
- `verify:specs`、`guard:agent-parity`（191 operations / 34 active nodes、205 IPC + 50 canvas actions、日志门禁）、`test:optimization-ui`、生产构建、`verify:acceptance:fast`（protocol 34/34、optimizations 9/9）均通过。
- 完整桌面验收链通过：local-agent-access、diagnostics-window-close、Agent Flow assets/commands/desktop/collaboration/coordination、capability/human-task/parallel/review/collab/media/end-to-end graph、builder/review/rework/recovery、视频/首尾帧/多参考/审核/并行队列、CMD-08、panel churn 与 R09 renderer 恢复。

### 4.4 日志影响

- 节点流与整画布运行复用公共 `node.*` / `workflow.*`；人工等待使用已注册的 `workflow.waiting`，不再误报 `completed`。
- Agent Flow 续跑/返工复用 `agent.coordination.*`、`agent.resume*` 与 checkpoint 现有事件，只记录稳定 ID、阶段与错误码。
- 不记录正文、提示词、回复、协作文本、输入值、checkpoint 内容或原始异常；临时调试输出已移除。
- M37 是表约束迁移，沿用迁移测试与 `user_version` 事务保证；`migration_*` 事件缺口维持既有边界。详见 [日志覆盖清单](<../LOGGING_COVERAGE.md>)。

## 5. 仍未闭环的边界

- **真实付费模型**：本轮未调用真实供应商；确定性夹具不等于模型质量、供应商受理或计费验收。
- **物理掉电/真实磁盘硬件故障**：R09 已验证可注入故障与进程硬杀，但不等于真实设备掉电、磁盘写满或目录元数据耐久。
- **Windows 安装包/干净 Runner**：当前为开发构建与真实 Electron 桌面验收，未覆盖安装包、跨平台干净 CI。
- **Windows named pipe 最小 ACL**：既有随机 token + `connection.json` 当前用户 ACL 补偿控制已启用；named pipe 默认 DACL 仍未最小化。
- **Agent Flow P2 展示/归因问题**：外部 continue 归因、waitReason 分类、waiting 事件语义、零输出 exit、并行出口选择、reviewPassed 历史刷新等仍需后续专项处理。
- **composite 编辑页异步加载竞态**：已修复 ref 缓存与丢线，但快速切换版本与异步加载之间的 UI 竞态仍建议后续补专项验收。

## 6. 证据索引

- 本报告：`docs/canvas-agent-flow/audits/node-flow-deep-review-2026-11-27.md`
- 定向测试与完整 verify：`qa/verification/`
- composite GUI：`qa/composite-gui-acceptance/`
- composite remediation：`qa/local-agent-access/composite-remediation-e2e/report.json`；归档证据 `docs/local-agent-access/evidence/composite-remediation-e2e-2026112707154.json`
- composite legacy：`qa/local-agent-access/composite-legacy-runtime-e2e/report.json`
- capability params：`qa/local-agent-access/capability-params-e2e/`
- composite failure/retry：`qa/agent-flow-composite-failure/`、`qa/agent-flow-composite-retry/`
- Agent Flow graph 桌面验收：`qa/agent-*-graph/`、`qa/agent-flow-context-adoption-e2e/`
