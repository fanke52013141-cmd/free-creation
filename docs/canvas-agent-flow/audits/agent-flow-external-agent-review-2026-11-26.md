# Agent Flow 与外部 Agent 接入全面审查报告

> **历史审查快照（2026-11-26，基线 `8c5c155e`）**：本文记录审查当时的缺陷、复现与建议，不代表后续工作区修复后的当前状态。当前规范与开发状态见 [AGENT_FLOW_SPEC](../../AGENT_FLOW_SPEC.md)、[BACKLOG](../../BACKLOG.md) 与[机器契约](../../local-agent-access/generated/contracts.json)；本文不手写当前能力数量。

- 审查日期：2026-11-26（Asia/Shanghai）
- 代码基线：`8c5c155e`（`main`）
- 审查方式：4 路并行只读审查 + 父代理交叉验证 + 静态复现 + 全量单测/类型检查/lint/门禁
- 机器真值：[`docs/local-agent-access/generated/contracts.json`](../../local-agent-access/generated/contracts.json) 与运行时 `capability.list`；本文不手写当前数量
- 工作区说明：审查期间 `src/renderer/src/canvas/FlowOverviewPanel.tsx` 与 `src/renderer/src/canvas/flow-overview.css` 出现并发 UI 改动；本审查未写入或还原这些文件。

## 1. 总结论

当前系统在“契约登记、纯函数图路由、命令账本、确定性恢复、三入口工具集合派生”方面有较好的工程基础，但**外部 Agent Flow 的纵向闭环仍存在多处阻断**，并且发现一项可导致供应商密钥外泄的严重安全问题。

最需要先处理的事项：

1. **Critical：修改模型/供应商端点可把原密钥发往攻击者。**
2. **High：外部 FlowGraph 编译出的 Agent/Review 节点不可运行，但 validate/propose/confirm 仍可成功。**
3. **High：条件分支输入未按路由裁剪，capability 稳定报 `FLOW_INPUT_MANIFEST_INCOMPLETE`，agent/human-task 可能失败或消费死分支数据。**
4. **High：默认并行 Fork 必被 `FLOW_PARALLEL_REJECTED`；超过并发上限也不是排队而是直接拒绝。**
5. **High：capability/human-task 图流程无法可靠停止，且父取消挡不住迟到提交。**
6. **High：命令幂等签名遗漏 `envelope/contextMaterial/scopedHumanTask`，不同业务意图会被当成同一命令。**
7. **High：`media.import` 可读取任意本地文本文件并回传正文。**
8. **High：`node.execute` 完全忽略 `expectedGraphVersion`，过期调用会执行最新画布。**
9. **High：客户端/服务端超时口径不一致，调用方收到 `OUTCOME_UNKNOWN` 后服务端仍可能继续生效。**
10. **High：main 的占用检查看不到 GUI 手动运行，外部写在 GUI 运行中仍可修改画布。**
11. **High：CI 30 分钟超时小于已实测 40.9 分钟的全量 verify；干净 CI 还缺设备授权。**
12. **High：铁律三关和真实 MCP 验收不在 CI 主门禁内；受保护源码范围漏掉核心 Agent Flow/composite/diagnostics。**
13. **High：规范权威入口分裂，headless 输出键规范写反，Agent Flow 现行规范多条状态过期。**

## 2. 审查范围与方法

### 2.1 范围

- Agent Flow 规划、蓝图、规范、交付台账、验收口径。
- `src/shared/agent-flow/**`、`src/main/agent-flow/**`、`src/shared/engine/executors/agentFlow.ts`。
- `src/shared/agent-access/**`、`src/main/agent-access/**`、`src/local-agent/**`。
- GUI/CLI/MCP 三入口、能力目录、节点动作矩阵、命令账本、资产固定版本、人工门禁、发布授权。
- 持久化、崩溃恢复、并发占用、幂等、版本冲突、日志可观测性、数据安全。
- `test/**`、`scripts/**`、`.github/workflows/ci.yml`、生成契约与门禁。

### 2.2 方法

1. 建立文档—契约—实现—测试四层证据链。
2. 并行审查文档一致性、核心运行时、外部接入、测试/门禁/日志四个方向。
3. 对关键缺陷做最小复现：
   - `nodeCommandIntentSignature` 忽略 `envelope/contextMaterial`；
   - `compileFlowGraph` 不设置 `maxParallelTasks`，默认并行准入报错；
   - 服务端 210s 超时小于人工决定 300s；
   - `media.import` 读取数据目录外文本文件；
   - 条件分支 capability 的 `FLOW_INPUT_MANIFEST_INCOMPLETE`（mock DB 复现）。
4. 运行全量单测、类型检查、lint、Agent 门禁、规范/日志门禁和构建。

## 3. 验证结果

| 检查 | 结果 |
| --- | --- |
| `npm test` | **350 passed / 2 skipped；3973 passed / 7 skipped** |
| 定向 Agent Flow/外部接入测试 | **258 passed** |
| `npm run typecheck` | 通过 |
| `npm run lint` | 通过 |
| `node scripts/guard-agent-parity.cjs` | 通过（审查时输出；当前集合以机器契约为准） |
| `node scripts/audit-business-actions.cjs` | 通过（审查时输出；当前集合以机器契约为准） |
| `npm run verify:specs` | 退出 0，但输出 11 个 `last-verified: unverified` 警告 |
| `npm run verify:logging` | 通过 |
| `npm run build` | 通过（main/preload/renderer 均成功） |
| 最新既有全量 verify 证据 | `qa/verification/run-IwbcCt` 曾因 `recovery-contention.test.ts` 的 SQLite 争用失败 1 项；本次全量单测复跑通过 |

> 门禁通过只能证明“登记/快照/大部分隔离行为”一致，不能证明真实外部 Flow 成功链路、CI 可执行性或安全边界。

## 4. 严重问题清单

### 4.1 Critical

#### SEC-01 修改模型/供应商端点可把原密钥外发

**证据**

- `src/shared/agent-access/ops/model-admin.ts:43-61` 允许 `model.connection.save` 同时修改 `baseUrl` 并省略 `apiKey`。
- `src/main/model-host/sqlite-model-host.ts:166-212` 在未提供新密钥时保留 `existing.secret_ref`。
- `packages/model-runtime/src/runtime.ts:44-66` 的 `validateModel/resolveForExecution` 使用 `readSecret()`，不是带来源校验的 `readSecretForRequest()`。
- `src/main/model-host/agent-tool-calling.ts:61-76` 同样使用 `readSecret()` 后向 `connection.baseUrl` 发请求。
- `src/main/agent-access/provider-network-ops.ts:84-107,129-155` 只要求调用方自报 `confirmNetwork/confirmCost`。
- 旧供应商路径也有同样问题：`src/main/gateway/providers.repo.ts:353-385` 保留旧 `api_key_ref`，`provider.probe` 经 `getProvider()` 读取后发往新 `baseURL`。

**攻击链**

枚举连接/模型 → 将连接改成攻击者 URL、省略密钥 → 调用 `model.validate` / `model.validateAgentToolCalling` / `provider.probe` → 原 API Key 以 `Authorization: Bearer` 发往攻击者。

**影响**

任何持有本地接入 token 的 Agent 可窃取已保存的供应商密钥。

**建议**

- 端点 origin 改变时必须重新输入密钥或人工确认。
- 所有出站请求统一使用 `readSecretForRequest()`，并禁止携带凭据的重定向。
- 增加“改 URL 后触发 validate，旧密钥不得外发”的回归测试。

### 4.2 High：Agent Flow 核心运行时

#### AF-01 外部 FlowGraph 编译产物无法通过运行准入

- `src/shared/agent-flow/flow-graph-compiler.ts:85-97` 把 agent 编译成 `tools: []`、`allowedNodeIds: []`，且不写 `modelDefinitionId`。
- `src/main/agent-flow/desktop-host.ts:273-275` 强制要求 `modelDefinitionId` 与 `node.execute@1`，否则 `AGENT_MODEL_REQUIRED` / `AGENT_TOOL_REQUIRED`。
- review 节点在 `flow-graph-compiler.ts:108-119` 写成 `subjectSources: []`、`gatedNodeIds: []`，且不写 `modelDefinitionId`；`src/main/agent-flow/coordinator-reviews.ts:76-83` 会直接拒绝。
- `FlowGraphSchema` 没有承载这些运行必需绑定的字段，外部无法在提案里补齐。
- `builder-host.ts` 与 `flow-build-actions.ts` 原样落画布并确认，不做可运行性检查。

**影响**：`flowGraph.validate/compile/propose/confirm` 可返回 ok/committed，但含 agent/review 的图不能执行。

#### AF-02 条件分支目标输入未按路由裁剪

- `dispatchCapability` 只选 `edgeState='satisfied'` 的边（`coordinator-host.ts:1469-1475`）。
- `FlowCommandLedger.authorize` 遍历全部画布入边，要求每条边都有 `command.inputs`（`command-ledger.ts:340-363`）。
- 已用 mock DB 复现：target=image-edit，两条画布入边，command 只含被选中分支，实际输出 `FLOW_INPUT_MANIFEST_INCOMPLETE input`。
- agent 在 `desktop-host.ts:351-369/533-548` 冻结全部入边：未选分支无产物→`ASSET_OUTPUT_UNAVAILABLE`，有旧产物→错误喂入。
- human-task 在 `coordinator-host.ts:1627-1647` 同样取全部入边。

**影响**：XOR/otherwise 分支进入 capability/agent/human-task 时无法正确推进，或静默消费未选分支数据。

#### AF-03 默认并行 Fork 必被拒绝

- `compileFlowGraph` 不设置 `maxParallelTasks`，实测为 `undefined`。
- `graphStep` 发现 2–4 个 ready agent 即 `dispatch-many`（`coordinator-host.ts:1194-1210`）。
- `parallel-admission.ts:15-21` 默认按 1 拒绝；大于上限也直接拒绝，不排队。

**复现**：a→b、a→c 三节点图，编译后 `maxParallelTasks === undefined`；运行到 b/c 同时 ready 时抛 `FLOW_PARALLEL_REJECTED`。

#### AF-04 无法可靠停止 capability/human-task 图流程

- `coordinator-host.ts:283-297` 对所有非终态 child 调用 `specialists.inspect/stop`。
- `desktop-host.ts:119-135` 的 `saved()` 只接受 agent，capability/human-task 必抛 `AGENT_NODE_MISSING`。
- capability command 的 `taskId` 是子哈希，`command-ledger.ts:148-159` 的 `taskStopped` 只按精确 taskId 查父任务，查不到父协调器。

**影响**：停止在设置 `run.state='cancelled'` 前中断；即使补上 stop，迟到 capability 结果仍可能 commit。

#### AF-05 命令幂等签名遗漏业务执行字段

- `src/main/agent-flow/command-intent.ts:45-60` 只纳入核心字段、`videoRework`、`inputs`。
- `envelope`、`contextMaterial`、`scopedHumanTask` 会影响真实执行，却未进入签名。
- 实测：同 commandId 分别改 `envelope.stageGoal`、`contextMaterial.text`，签名比较均返回相同。

**影响**：重试/恢复会把不同提示词、不同人工补料当作同一意图，静默复用旧命令/旧产物。

#### AF-06 图级超时预算未执行

- `FlowGraph.budgets.maxActiveMs` 除 Schema/默认值外没有任何运行时读取。
- 协调器没有总 deadline，也没有把 graph budget 传给子快照。

**影响**：图级超时/成本预算形同虚设。

#### AF-07 human-task 失败被伪装成人工等待

- `coordinator-host.ts:1712-1723` 只要不是 committed，就进入 `waiting/human.wait`，包括 failed、cancelled、pending、unknown。

**影响**：真实失败被隐藏，用户/外部 Agent 被误导去处理人工任务，并可能重复副作用。

#### AF-08 固定资产流程拒绝 >20MiB 视频

- `src/main/agent-flow/image-assets.ts:56-80` 对所有 image/audio/video 一律限制 20MiB。
- `src/main/agent-flow/video-review.ts:93-100` 同样硬编码 20MiB。
- 注释却称生成视频保留原有大小支持。

**影响**：常见长视频/高码率成果无法进入 Agent Flow。

### 4.3 High：外部 Agent 接入与安全边界

#### EXT-01 `media.import` 可任意读取本机文本文件并回传

- `src/shared/agent-access/registry.ts:236-249` 的 `filePath` 只做长度校验。
- `src/main/store/media.repo.ts:50-95` 接受任意绝对路径，并把 `.txt/.md/.csv/.json` 内容内联。
- `src/main/agent-access/service.ts:2255-2277` 直接把 `textContent` 放入响应。
- 完整回执还会写入幂等账本。

**复现**：在数据目录外创建 `outside-secret.txt`，调用 `media.import`，响应 `textContent` 原样返回。

**影响**：外部 MCP/CLI Agent 可读取任意本地文本文件，并可经项目包导出读取其他二进制，违反允许根目录/禁止任意文件浏览边界。

#### EXT-02 `node.execute` 忽略 `expectedGraphVersion`

- `src/shared/agent-access/registry.ts:189-203` 强制要求 `expectedGraphVersion`。
- `src/main/agent-access/service.ts:434-487` 只检查项目/节点存在，未比较版本。
- `src/renderer/src/canvas/CanvasEditor.tsx:1896-2028` 也未核对请求版本。

**影响**：过期调用会在配置、正文、连线或输入已变化后继续执行，可能产生错误结果或重复付费。

#### EXT-03 超时口径不一致，客户端报 unknown 后服务端仍可能生效

- 服务端所有受理请求固定 210s 断连：`RUN_WAIT_MAX_TIMEOUT_MS(120s)+90s`。
- 人工决定允许 300s，客户端等待 330s。
- 普通客户端只等 15s，但 `provider.testConnection` 首个 fetch 无超时、`model.validate` 90s、`model.discover` 20s、Flow 建图/审核、导演台发布都可能超过 15s。

**影响**：调用方收到 `OUTCOME_UNKNOWN` 后，main 后续仍可能写库、发布或执行模型任务，诱发危险重发。

#### EXT-04 main 看不到 GUI 手动本地运行的占用

- main 只查 `flow_commands/flow_agent_tasks/tasks/external_runs` 等 DB 表。
- GUI 手动运行占用在 renderer 的 `resource-queue` 内存中。
- `graph.patch` 分支没有 engine idle 检查，而 `execute-nodes` 分支有。

**影响**：GUI 正在跑 processor/code/本地媒体时，外部仍可修改或导出画布，造成运行中图与结果不一致。

#### EXT-05 `single` 模式可传多个节点但只执行第一个

- Schema 允许 1–50 个 `nodeIds`。
- renderer 只使用 `executeNodeIds[0]`。
- 响应却回传全部 `nodeIds`。

**影响**：静默部分执行，Agent 误以为多个节点已执行。

#### EXT-06 `project.export` 回执可能返回错误的 `sourceGraphVersion`

- export 前会 flush 活动画布并可能推进版本。
- 回执仍返回调用方输入的 `expectedGraphVersion`。
- 包内 `bundle.json` 使用实际版本。
- 现有测试已出现输入版本 3、包内版本 4 的实例。

#### EXT-07 CLI/MCP 本地校验错误语义漂移，CLI 不支持 stdin

- MCP 返回结构化 `INVALID_INPUT/UNSUPPORTED_OPERATION`。
- CLI 对未知命令、JSON/Schema 错误只输出固定 `LOCAL_AGENT_COMMAND_FAILED`。
- CLI 只支持 `--input-file` 或空 input，没有规范要求的 stdin。

#### EXT-08 所有 MCP 工具均标注 `openWorldHint:false`

`src/local-agent/index.ts:67-72` 对网络搜索、供应商测试、模型验证、即梦登录、环境安装及模型型执行全部标为本地操作，会误导依赖 MCP annotations 的审批系统。

#### EXT-09 公共 `OperationSpec` 不完整且版本硬编码

- `src/shared/agent-access/ops/common.ts:56-63` 缺少规范要求的 `executionMode/resultPolicy/diagnostics/evidence/status/owner` 等字段。
- `registry.ts:522-536` 将 `operationVersion` 固定为 1。
- `check-agent-access.cjs` 允许 `--accept-contract-change`，但不要求升级版本。

#### EXT-10 错误码目录不完整且重试提示错误

- `metadata.ts` 缺 `IDEMPOTENCY_REQUIRED`、`APP_NOT_RUNNING`、`INSTANCE_MISMATCH`、`HUMAN_DENIED`、`HUMAN_DECISION_TIMEOUT` 等实际码。
- `REVISION_CONFLICT` 提示用当前版本重试、`RESOURCE_BUSY` 提示相同幂等键重试，但 service 会直接重放旧失败回执。

#### EXT-11 超大响应被断连并误报 `OUTCOME_UNKNOWN`

- `server.ts:113-118` 在响应超过 1MiB 时直接销毁 socket。
- `client.ts` 将其映射为 `OUTCOME_UNKNOWN`。
- 无副作用的读取也会被误报为未知。

#### EXT-12 授权失效分支没有错误对象

`service.ts:273-285` 只返回 `status:'failed'`，没有 `code/phase/retryable`，CLI/MCP 无法机器识别授权失败。

#### EXT-13 `provider.package.export` 是已注册但不可达的幽灵契约

- `src/shared/agent-access/ops/key-package.ts:17-31` 已注册。
- `src/main/agent-access/key-package-ops.ts:15-18` 的 `KEY_PACKAGE_OPERATION_IDS` 漏掉它。
- 实际 dispatch 落入 `service.ts:2953-2965` 的 `UNSUPPORTED_OPERATION`。
- 静态路由核对机器契约列出的全部操作后，只发现这一条幽灵操作。

**影响**：CLI/MCP 暴露一个必然失败的操作；门禁仍全绿。

### 4.4 High：CI、门禁与可执行性

#### CI-01 CI 30 分钟超时小于已实测成功 verify 的 40.9 分钟

- `.github/workflows/ci.yml:25` 设置 `timeout-minutes: 30`。
- `qa/verification/run-jnYYL6/status.json` 显示成功 verify 耗时约 40.9 分钟。
- CI 第 46 行执行同一个 `pnpm verify`。

**影响**：即使代码全绿，CI 也会在完成前超时。

#### CI-02 干净 CI 缺少设备授权

- `scripts/test-local-agent-access.cjs:14-27,56-58` 在源码模式无条件要求本机 `license-current.json`。
- CI 未注入 license/security secret。
- `CANVAS_OWNER=1` 只是构建期 define，脚本不读取，也不能跳过复制。

**影响**：全新 Windows runner 无法通过 `verify:checks`。

#### CI-03 铁律三关与真实 MCP 验收不在 CI 主门禁内

- CI 只跑 `pnpm verify`。
- `verify:checks` 不含 `guard:agent-parity`、`audit-business-actions.cjs`，也不含 `verify:acceptance`。

**影响**：业务动作分母、真实 CLI/MCP stdio 回归不会阻断合并。

#### CI-04 `change-impact` 受保护源码范围漏掉核心文件

- `scripts/check-agent-access.cjs:57-74` 未包含 `src/shared/agent-flow/**`、`src/shared/composite/**`、`src/renderer/src/composite/**`、`flow-assets.ipc.ts`、`flow-commands.ipc.ts`、`composite.ipc.ts`、`composite*.repo.ts`、`src/main/diagnostics/**`（除 service.ts）。
- 最近 BL-21 修改了 `src/shared/agent-flow/flow-graph.ts`，但 `change-impact.json.sourceHashes` 没有该文件，门禁仍通过。

#### CI-05 日志门禁在 GitHub 默认浅克隆上会空跑通过

- CI checkout 未设置 `fetch-depth: 0`。
- `check-logging-bypass.mjs` 在 merge-base 为 HEAD 或 `HEAD~1` 不存在时把 diff 当空，仍打印 passed。
- 现有测试只接受“通过或失败但输出一致”，没有验证真实增量确实被扫到。

### 4.5 High：规范、蓝图与文档权威

#### DOC-01 规范权威入口互相冲突

- `docs/canvas-agent-flow/README.md:3` 说归档只用于追溯，但 `:159-165` 仍把 `archive/00/01/02/06/10` 列为活规范，并称 49 号是“当前唯一有效”的能力矩阵。
- `docs/canvas-agent-flow/archive/README.md:6` 明确归档不作为现行规范。
- `docs/AGENT_FLOW_SPEC.md:487-499` 又明确 supersede 这些旧文档。
- `AGENTS.md:96-98` 仍指向 README 与 49 作为当前入口/能力现状。

#### DOC-02 headless 输出键规范写反

- `AGENT_ACCESS_SPEC.md:14` 和 `docs/local-agent-access/02-capability-matrix.md:256` 说 outputs 使用裸公开输出 id。
- 当前代码 `src/shared/agent-access/ops/composite.ts:172-174,190,238`、机器契约和 `docs/BACKLOG.md:297` 都要求 `out-<id>`，旧裸键仅读取兼容。

#### DOC-03 `AGENT_FLOW_SPEC` 多条状态与代码/BACKLOG 相反

典型例子：

- `AGENT_FLOW_SPEC.md:81` 称 `web.search@1` 必定失败；实际已修复并有测试。
- `:191,206` 仍把端口校验列为目标；BL-11 已实现。
- `:270-271` 称 human-task 只支持 text/json；实际已支持 image/video。
- `:341` 仍称返工上限未统一；`rework-limit.ts` 已统一。
- `:376-438` 仍把 roles/humanRole 列为目标；BL-15 已完成。
- `:38,287` 称每个节点必须通过 ContextManifest；实际 `inputs` 可选，无清单时回退全部固定输入。
- `:296` 称专业 Agent 可返回“补充请求”；当前 decision schema 没有 request-more 动作，`ask-human` 只覆盖预算超限。

#### DOC-04 “当前唯一能力矩阵”49 号已失真

- `docs/canvas-agent-flow/archive/49-af00-baseline-and-sample-2026-11-13.md:59-67` 仍把 AF-01/02/03/05/07 标为尚未支持。
- `51-af01-07-delivery-2026-11-13.md` 已记录七包实现，代码和测试也存在。
- 49 号的数量只代表 2026-11-13 时点；当前集合已变化，必须以机器契约为准，不能继续用 49 号描述现状。
- `HANDOFF_2026_11_24_HUMAN_GATE_AND_BROWSER_GATE.md:88` 已承认 49 与 50/51 冲突未重写，但 README 仍称其为当前唯一矩阵。

#### DOC-05 手写计数和当前状态严重过期

- `AGENTS.md:56`：190 项；实际 192。
- `AGENT_PARITY_SPEC.md:145,149`：33 类、190 项；实际 34/192。
- `AGENT_ACCESS_SPEC.md:13,37,52`：33/31 类。
- `docs/local-agent-access/README.md:4,52-53`：25 项、32 类。
- `docs/local-agent-access/02-capability-matrix.md:42`：33 类。

#### DOC-06 外部接入规范仍把已落地能力写成“未开放/待实现”

- `AGENT_ACCESS_SPEC.md:42` 和 local-agent-access README 说项目/资源包导入未开放；实际已实现并测试。
- `AGENT_ACCESS_SPEC.md:81` 说 Registry、Dispatcher、传输层待实现；实际已存在。
- README 仍说通用外部节点动作、状态机外部执行未接通。

#### DOC-07 R 系列完成状态被过度声明

- `AGENTS.md:98` 与 `docs/canvas-agent-flow/03-delivery.md:3` 称 R 系列均已交付/验收。
- `archive/38-agent-completion-plan.md:27-30` 明确 R09、R11、R12 尚未闭环。

#### DOC-08 README 是追加式年表，多个“当前/最新”互相冲突

- 同时存在“已交付”和“未提交/推送”的当前描述。
- 一处说 C4 尚未实现，另一处又把 C4 列为当前交付。
- 仍把归档台账当进度入口。

#### DOC-09 AF-01～07 的“验收”口径超过交付记录自身

- `51-af01-07-delivery-2026-11-13.md:35-38` 明确未做真实模型固定顺序长任务、真实 GUI 鼠标共创，也未跑完整 `npm run verify`。
- README 却概括为七包均已验收。

### 4.6 Medium：其他运行时与契约问题

| ID | 问题 | 主要证据 |
| --- | --- | --- |
| AF-09 | 编译器丢弃 text-template/image-edit 的 `FlowNode.goal` | `flow-graph-compiler.ts:84,121-144`；默认 template/instruction 不读 goal |
| AF-10 | 返工移除 waiting/blocked 子任务但不取消/取代旧任务，续跑撞 `AGENT_TASK_OCCUPIED` | `coordinator-host.ts:2012-2029,2067-2075`；`task-store.ts:96-103` |
| AF-11 | 终态协调运行在崩溃窗口不释放 scope，之后永久 `FLOW_CONTROL_OCCUPIED` | `coordinator-host.ts:2215-2216` 对 terminal 直接 return；正常完成才 release |
| AF-12 | 图流程崩溃恢复错误要求 `children.length === childIds.length`，skipped/loop 合法图无法恢复 | `coordinator-host.ts:2399-2405` |
| AF-13 | 外部 `flowAgent.inspect` 丢失 `waitReason/children`，并把所有 waiting 报成 human | `flow-agents-ops.ts:194-220,151-177` |
| AF-14 | 外部命令回执 `outputRefs` 最大 8，与内部/composite 最大 32 不一致 | `ops/flow-commands.ts:56` |
| AF-15 | FlowGraph 定义发布不做语义校验，未知能力/无界环也能发布 | `definition-store.ts:138-175` 只 `FlowGraphSchema.parse` |
| AF-16 | 定义 diff 遗漏 `executor/decider/humanOutputType/capabilityRef/params/joinPolicy/carrierNodeId` | `flow-definition.ts:133-144` |
| AF-17 | `ContextManifest.hash` 不包含 `kind`，text/markdown 同内容哈希碰撞 | `context-manifest.ts:156-169` |
| AF-18 | `maxSteps` 预留算法每个循环多算一整轮，边界合法图被拒 | `flow-graph.ts:793-804` |
| AF-19 | review 状态未按 loop round 作用域化，循环审核可能使用旧轮次 | `coordinator-reviews.ts:208`；`coordinator-host.ts:1824-1832` |
| AF-20 | 已 committed 的外部 confirm 不检查 `committedScopeHash`，可把已漂移画布报为 committed | `flow-agents-ops.ts:832-841`；`builder-host.ts:154-183` |
| LOG-01 | `flowAgent.run` 的 access 与 coordination/model/node 日志 trace 断裂 | `service.ts:1049-1056` 未传 diagnostics；`flow-agent-run-ops.ts:82-84` 重新生成 ID |
| LOG-02 | 协调器停止会记 `completed(success)` 或 `failed`，永远不会记 cancelled | `coordinator-host.ts:277-306,548-568`；事件注册表无 cancelled |
| LOG-03 | 人工决定拒绝事件没有 trace/span，无法与 access 请求关联 | `human-decision.ts:71-86` 未传 context |
| OPS-01 | `verify:checks` 重复 `test:agent-flow-parallel-review`，漏 `parallel-queue/cmd08/panel-churn` | `package.json:107` |
| OPS-02 | 验收入口把“脚本不存在”当 SKIP，仍可退出 0 | `scripts/verify-acceptance.cjs:46-52,66-82` |
| TEST-01 | 外部 `flowAgent.run` 成功链路只有 FakePort，没有真实 CLI/MCP→宿主→协调器→账本→产物 E2E | `test/local-agent-flow-agent-run-access.test.ts`；交付台账明确未实测 |
| TEST-02 | 全量 verify 存在真实 SQLite 并发抖动 | `qa/verification/run-IwbcCt/verify.log:610-631`；本次全量单测复跑通过 |
| DOC-10 | active 规范 `last-verified: unverified` 仍让 `verify:specs` 通过 | `scripts/check-specs.mjs:25-36` 只警告不失败 |
| DOC-11 | 归档迁移造成批量断链 | `AGENT_ACCESS_SPEC.md:60`、BL10/BL11 handoff、archive/00/02/06 等 |
| DOC-12 | 日志覆盖清单与代码不符且内部矛盾 | `docs/LOGGING_COVERAGE.md:194,1083,1089`；不存在的 `agent.access.task_running` |
| DOC-13 | `node.type.list` 描述仍写“本包不开放节点操作” | `registry.ts:373-379` |
| DOC-14 | 节点动作矩阵把已开放的 chat N7、ai-review N5 等仍标 `planned` | `node-actions.ts:106-124,309-318` |
| DOC-15 | `project.rename` 与 `project.update` 行为相同但未声明 alias | `service.ts:2747-2749` |
| CODE-01 | 旧 C0 实验仍作为独立构建入口和事件族保留，产品链路未接入 | `electron.vite.config.ts:41-50`；`src/main/agent-flow/c0/**` |
| CODE-02 | 大量 temp/probe 脚本无 package/源码/文档入口 | 审查扫描发现 52 个无引用脚本，多数为 `*-temp.cjs`/probe |
| CODE-03 | 源码注释和测试名仍描述旧阶段 | `flow-graph.ts:28`、`flow-graph-compiler.ts:26-27`、`local-agent-parity.test.ts:108` |

### 4.7 风险项（未据此判定为已复现缺陷）

1. **凭据批量导出**：`provider.package.export` 默认导出全部连接，密码由调用方选择且无人工门禁；当前因路由缺失不可达，若直接补路由会变成高风险能力。
2. **code 节点沙箱**：外部可执行 code 节点，但实现主要依赖 Web Worker + 正则/全局封锁；规范自身也承认尚未完成隔离审计，不能视为安全沙箱。
3. **传输层硬化**：Windows named pipe 未显式设置 ACL；MCP SSE 将 token 放在 URL query，且未校验 Origin/Host。
4. **运行错误回传**：`external_runs.error` 会原样保存 renderer 错误，可能包含路径、提示词片段或供应商原文。
5. **`flow.command.dispatch` 无客户端幂等键**：响应丢失后重试会创建第二次命令，可能重复付费/副作用。
6. **`FlowNode.decisions/carrierNodeId` 是死契约**：schema 声明但运行时不消费，外部可能误以为人工动作/条件受控。
7. **视频审核 60s 与生成配置 120s 不一致**：长视频可能在生成后被审核 schema 拒绝。

## 5. 系统性根因分析

### 5.1 “校验即准入”没有覆盖运行准入

`validateFlowGraph` 校验的是图结构、能力目录和端口，但编译产物缺少运行必需的模型、工具、审核绑定。于是出现：

- validate/compile/propose/confirm 全绿；
- 第一次运行才报 `AGENT_MODEL_REQUIRED` / `AGENT_TOOL_REQUIRED` / `FLOW_REWORK_SCOPE_INVALID`。

这与规范 AF-6.2“校验即准入”直接矛盾。

### 5.2 图路由与命令账本使用了两套“输入真相”

路由器知道哪些边是 satisfied/dead，但命令账本仍按画布全部入边校验。条件分支因此必然在 capability 上断裂。需要把“本次活跃边集合”作为执行契约显式传递，而不是让账本重新猜。

### 5.3 外部接入的“同步响应”与真实任务生命周期不匹配

大量操作实际是长任务或人工等待，但协议只有 15s/210s  socket 超时和同步 envelope。结果是客户端报 unknown、服务端继续执行。应把 `executionMode/deadline/resultPolicy` 纳入 OperationSpec，长任务统一 accepted + taskId。

### 5.4 门禁证明的是“声明一致”，不是“行为可用”

- 幽灵操作 `provider.package.export` 不影响契约快照一致性。
- FakePort 测试无法证明真实宿主成功链路。
- 稳定错误码也被验收脚本当作“接通”。
- CI 不跑铁律和真实 MCP 验收，且 30 分钟必然超时。

## 6. 建议修复顺序

### 第一优先级：安全

1. 修复端点变更导致密钥外发；统一 origin-bound secret read。
2. 限制 `media.import` 路径范围，正文读取改为独立显式能力。
3. 在 code 沙箱完成专项审计前，不把外部 code 执行标为可发布。

### 第二优先级：Agent Flow 纵向闭环

1. 让 FlowGraph 编译产物通过运行准入，或明确返回“需人工配置/不可运行”。
2. 修复条件分支输入裁剪。
3. 修复并行 fork 排队/预算。
4. 修复 capability/human-task 停止与迟到提交。
5. 修复命令签名遗漏字段。
6. 执行图级 `maxActiveMs`。
7. 修复 human-task 回执状态映射。

### 第三优先级：外部契约与运行时

1. `node.execute` 校验 `expectedGraphVersion`。
2. 统一客户端/服务端超时和长任务协议。
3. GUI 手动运行与 main 共享忙状态。
4. 修复 `single` 多节点、export 版本回执、CLI stdin/错误 envelope、MCP annotations、OperationSpec、错误目录、超大响应、授权失败错误对象。
5. 修复幽灵操作和节点动作矩阵漂移。

### 第四优先级：CI/门禁

1. 拆分 CI job 或提高 timeout。
2. 干净 CI 跳过设备授权复制或提供合法测试授权。
3. CI 显式运行 `guard:agent-parity` 和真实 MCP 验收。
4. 补全 `change-impact` 保护范围。
5. CI 设置 `fetch-depth: 0`，日志门禁基线不可用时失败。
6. 验收脚本缺失直接失败。

### 第五优先级：文档收敛

1. 统一权威入口为 `docs/AGENT_FLOW_SPEC.md` + `docs/BACKLOG.md` + 机器契约。
2. 重写或撤销 49 号“当前唯一矩阵”。
3. 修正 headless 输出键、计数、已实现状态、R 系列验收口径。
4. 修复归档断链，增加 Markdown 链接检查。
5. 清理旧 C0、无入口脚本和过期注释。

## 7. 必补验收用例

- 改模型/供应商 URL 后触发 validate/probe，断言旧密钥不会发往新 origin。
- `media.import` 对数据目录外文件返回 `PATH_NOT_ALLOWED`。
- 外部 FlowGraph：compile → confirm → 直接 run，Agent/Review 无需手工补配置即可运行。
- XOR/otherwise 分别进入 capability/agent/human-task，断言只消费选中分支。
- 2/3/4 路并行 fork 按 `maxParallelTasks` 排队而非拒绝。
- capability/human-task 运行中 stop，迟到结果不得 commit。
- 同 commandId 改 `envelope/contextMaterial/scopedHumanTask` 必须冲突或生成新意图。
- 人工决定等待 210–300s，客户端不应提前 unknown。
- GUI 手动本地运行中，外部 graph.patch/export/open 返回 `RESOURCE_BUSY`。
- 干净 Windows CI runner 完整跑通 verify。
- 真实 CLI 与 MCP stdio 调用 `flowAgent.run(start/continue/stop)`，核对任务、命令账本、产物与 trace。

## 8. 正向结论

- CLI/MCP 工具集合确实从同一 Registry 派生。
- 未发现外部接入使用 shell 拼接执行命令；主要进程调用使用 `spawn` 参数数组。
- 项目/结构/资源包导入具备 realpath、扩展名、条目/大小和路径穿越检查。
- 命令账本、资产固定版本、崩溃恢复、人工门禁已有较多确定性测试。
- 当前全量单测 3973 项通过，类型检查、lint、Agent 三门禁通过。

## 9. 边界与未覆盖

- 本审查未执行真实付费模型请求。
- 未完成真实 GUI 鼠标/键盘的完整 Agent Flow 共创验收。
- 未完成 Windows 打包版与源码版逐动作一致性复核。
- 未完成 code 节点沙箱越权专项测试。
- 审查期间工作区存在并发 UI 改动，报告基线以 `8c5c155e` 为准。

## 10. 修复 Resolution 附录（2026-11-26 工作区）

> 本附录记录审查后的修复状态，不修改上文历史发现。审查基线为 `8c5c155e`，修复工作基于并发提交 `e9b263f2`；代码与文档修复已提交，提交说明为 `fix(agent-flow): 完成外部审查修复与仓库清理`，最终快速验收结果见本节末尾。

| 审查项 | 状态 | 主要落点 |
| --- | --- | --- |
| SEC-01 密钥端点外泄 | 已修复 | `SecretPort.readSecretForRequest`、模型/供应商 origin 绑定、端点变更无新密钥拒绝、Agent Flow/probe 出站路径统一绑定读取 |
| EXT-01 任意文本文件读取 | 已修复 | 外部 `media.import` 仅允许 `agent-exports`，realpath/relative 防逃逸，正文不进入外部响应/幂等账本 |
| AF-01 编译产物不可运行 | 已修复 | FlowNode 模型/工具/范围/审核绑定、安全推导、`runnable/runtimeErrors`、propose/confirm/发布准入 |
| AF-02 条件分支输入 | 已修复 | satisfied 边按目标传入 bind/ledger，capability/agent/human-task 不消费死分支 |
| AF-03 并行 fork | 已修复 | 超容量按容量与写冲突排队分波 |
| AF-04 停止与迟到提交 | 已修复 | 父取消先持久化，按节点 kind 停止，parent task/deadline 阻止迟到 commit |
| AF-05 命令签名 | 已修复 | 除 trace/span 外全部业务执行字段纳入签名 |
| AF-06 图级预算 | 已修复 | 总 deadline、子任务剩余预算传播、统一 1h schema |
| AF-07 human-task 状态 | 已修复 | 仅预期 skipped 进入人工等待，failed/cancelled/pending/unknown 正确映射 |
| AF-08 视频上限 | 已修复 | 输入参考 20MiB，生成视频固化/审核 500MiB |
| AF-09～AF-20 | 已修复或明确收敛 | goal 映射、活跃子任务返工阻断、scope 释放、skipped/loop 恢复、outputRefs 上限、定义发布/diff、manifest hash、循环预算、confirm scope hash；loop 内 review 明确拒绝 |
| EXT-02～EXT-06、EXT-12～13 | 已修复 | 节点执行版本/single、超时元数据、GUI 占用、export 源版本、AUTH_FAILED、幽灵凭据导出契约移除 |
| EXT-07～11 | 已修复 | CLI stdin/结构化错误、MCP openWorldHint、operationVersion/openWorld/transport 元数据、错误目录、大响应结构化语义 |
| LOG-01～03 | 已修复 | access/coordination trace 贯通、cancelled 唯一终态、人工拒绝事件关联 |
| CI-01～05 | 已修复 | 60 分钟超时、完整历史、干净 CI 授权、铁律/快速验收入门禁、保护范围与 fail-closed |
| DOC-01～15 | 已修复 | 权威入口、49 号降级、headless 键、计数、现行状态、R 系列口径、断链与元数据收敛 |
| CODE-01～03 | 部分收敛 | 过期注释/测试名随文档与代码修复清理；C0 保留为测试专用，42 个无入口临时脚本已删除 |

后续补充修复：`composite.run.submitHuman`、`composite.run.resubmit`、`flowStateMachine.submitEvent` 已纳入统一人工决定门禁；拒绝/超时/无桌面均在副作用前失败，回归见 `test/local-agent-human-gates.test.ts`。

### 验证证据

- `npm test`：**360 passed / 2 skipped；4048 passed / 7 skipped**。
- 最终运行时定向：**5 文件 / 223 项通过**；新增外部 committed scope 回归 **1 项通过**；人工门禁回归 **27 项通过**。
- `npm run typecheck`、`npm run lint`、`npm run build`：通过。
- `guard:agent-parity`、`verify:specs`、`verify:logging`、`git diff --check`：通过。
- `CANVAS_OWNER=1 npm run verify:acceptance:fast`：**2/2 批次通过**（protocol 34/34、optimizations 9/9）。
- 额外验收：族 2/3/7/8 **24/24**、族 4/5/6/9 **47/47** 通过；覆盖收紧后的受控 `media.import` 与机器契约节点数。
- 人工门禁验收：`agent-flow-state-machine.cjs` **7/7** 通过，包含真实 GUI 点击「允许提交」后状态机推进。
- 首轮全量测试发现的 esbuild 别名与旧图夹具问题已修复，9 个失败文件复跑 **105 项全通过**后再次全量通过。

### 仍未覆盖的边界

- 未发起真实付费模型/供应商调用，未完成真实 GUI 鼠标端到端、Windows 打包版与干净 GitHub runner 实跑。
- code 节点 sandbox 仍待专项隔离审计；节点动作矩阵已明确标注 `sandbox boundary pending`。
- Windows named pipe 最小 ACL、SSE token 移出 URL query 尚未实施；已补 SSE Host/Origin 校验。
- `loop.body` 内 review 当前明确拒绝，未实现按轮次作用域执行。
- R09/R11/R12 仍未闭环；C0 已保留为测试专用，42 个无入口一次性脚本已删除，见 [仓库清理记录](<repo-cleanup-2026-11-26.md>)。
