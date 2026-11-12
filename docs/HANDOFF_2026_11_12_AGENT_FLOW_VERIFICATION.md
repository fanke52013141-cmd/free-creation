# Canvas Studio Agent Flow 端到端验证交接

更新日期：2026-11-12，Asia/Shanghai。用途：在另一台电脑接续"外部 Agent 构建并驱动 agent flow"的验证与修复。本文以实测证据为准；配套完整报告与复现脚本见 [`agent-flow-verification-20261112/`](agent-flow-verification-20261112/README.md)。

> **一句话现状**：构想的编排机制层已实测打通约 85%（外部建图、模型配置验证、主控准入、状态机推进、固定版本资产、决策发起全部真实跑通）。**唯一运行级拦路石**：应用主控的真实模型决策稳定失败（`AGENT_MODEL_FAILED`），但用同款 AI SDK + 精确内容独立复现却 100% 成功——**根因锁定在应用运行时集成，不是端点/接口格式/模型能力问题**。下一步是捕获应用内那条失败流的确切错误并修复。

## 1. 用户目标与范围

- 用户在做**人机深度协作的 agent-flow 产品**：外部 Agent 构建整套 flow；主 Agent（coordinator）+ 状态机驱动；每节点最小必要输入（上下文隔离，防爆炸）；产物版本化交接；人深度参与而非弹窗审批。
- 本轮任务：**端到端实操验证**这套系统能否支撑该构想，并定位跑不通的根因。用户已授权全权验证（"你来处理全权"）。
- 验证用公众号写作 flow 做载体：选题（人机协作）→ 资料 → 框架 → 写作 → 审核。
- **本轮未改任何源码**，纯验证。提交内容仅本文档 + 验证材料。

## 2. 接手前必须知道

| 项目 | 当前事实 |
|---|---|
| 主源码目录 | `D:\Program Files (x86)\canvas-studio\source`（上级是安装/构建目录，非 Git 仓库）。另一台电脑路径可能不同，以实际为准。 |
| 分支 / 基线 | `main`，HEAD `f853b7d`（节点流第三轮裁决），**与 origin/main 完全一致，无未推送源码改动**。 |
| 远端 | `origin` = `https://github.com/fanke52013141-cmd/free-creation`。 |
| 技术栈 | Electron 39 + React 19 + tldraw 4.5；Agent 运行时 LangGraph 1.4 + Vercel AI SDK（ai 7.0.73 / @ai-sdk/openai-compatible 3.0.34）；better-sqlite3（按 Electron 编译）。 |
| 数据目录 | `%APPDATA%\canvas-studio\data`（app.db、projects、diagnostics、agent-access/connection.json）。 |
| 验证项目 | projectId `qtiiB26nOWJS`，名"AgentFlow端到端验证-公众号"。已建为 processor 目标链（素材源→选题→资料→框架→文章）+ 主控 + 状态机。**此项目在本机数据库，另一台电脑没有，需按 §5 重建。** |
| 模型配置 | 本机已配 `zhipu-official` 连接（官方智谱 `https://open.bigmodel.cn/api/paas/v4`）+ 定义 `zhipu-official-glm-5_3`（glm-5.3，工具调用已验证）。**密钥在本机设备密钥库，不进仓库、不可跨机迁移；另一台电脑须用自己的密钥重新配置。** |
| 工程铁律 | GUI/CLI/MCP 三入口 parity（`guard:agent-parity` 门禁）；节点强制契约；日志规范。改受保护源码须刷新影响声明并过门禁。 |

## 3. 已完成什么（三轮验证实测结论）

### 第一轮：外部通道 + 建图 + 非 AI 执行 ✅
- 外部接入需启动带 `--local-agent-access`（`src/main/index.ts:719`），否则 `APP_NOT_RUNNING`。
- CLI/MCP 注册表共 **154 个操作**（`shared/agent-access/registry.ts` + `ops/*` spread）。源码注释里"未开放"可能过时，以实际 dispatcher 为准。
- **外部 Agent 用 `graph.patch` 一次性原子建出完整 flow 图**（状态机+主控+4专家+成果+审核，11 节点+控制关系+数据边），`node.runPlan` 预检 `missing:[]`。→ "外部建整套 flow"结构通道打通，不受内置 builder 6 能力/4 步限制。
- 非 AI 节点外部执行全链路通：`node.execute → run.wait → output.get`（确定性投影，不可伪造）。

### 第二轮：模型验证 + 主控准入 + 状态机 + 资产 ✅（编排机制层）
- 主控准入硬要求（`coordinator-host.ts:168-222`）：role=coordinator、**非空目标文本**、**modelDefinitionId**、绑 agent.dispatch、allowedNodeIds 只含专家+审核、observes 恰好一个状态机；审核责任绑定（`coordinator-reviews.ts:64-75`：responsibleNodeId 必填，subjectSources.nodeId 必须等于它）。
- 状态机必须用主控**固定事件词汇**：`flow.started / agent.dispatched / agent.completed / human.wait / flow.paused / flow.completed / human.continue`（标准迁移表 `desktop-electron.ts:1744`）。自定义事件名被 `FLOW_STATE_TRANSITION_DENIED` 拒绝。
- 实测：主控启动后状态机 **draft→working** 推进成功；源节点**成功提交固定版本资产**（flow_asset_versions）。→ 状态机与产物版本化机制真实工作。

### 第三轮：官方端点根因隔离 ✅（关键结论）
- 官方 glm-5.3 工具调用验证**两阶段全过**。
- 裸 API 复现主控请求（复杂 schema/多工具/流式/required/应用注入的 thinking+reasoning_effort 参数）**全部成功**。
- **用应用同款 AI SDK + 精确内容（`exact_ctx.json`）独立复现，5/5 成功**。
- **但应用主控用同一端点两次都在 `decisions=1` 处 `AGENT_MODEL_FAILED`**（约 7s）。
- 内容仅约 1.4KB，排除大上下文；排除 chat/responses 格式（应用走 Chat Completions，是兼容厂商通用标准，方向正确）；排除端点能力。
- **根因锁定：应用运行时（Electron 主进程）消费模型流的集成缺陷。** 简单 probe（maxOutputTokens=128、简单 schema）在应用里能过；主控（无 maxOutputTokens、复杂 schema、toolChoice=required、推理模型长思考链）在应用里稳定挂，脱离应用就成功。剩余嫌疑：Electron 内嵌 Node 22 vs 独立 Node 24 的流处理差异，或主控运行时并发/abort/模型实例细节。

## 4. CLI 调用要点（踩过的坑）

- 入口：`node out/main/local-agent.js <操作> --input-file x.json`（与 MCP 同源）。
- **写操作强制 `idempotencyKey`**，格式 `<13位ms时间戳>:<UUID>`（`registry.ts:896`）。读操作可选。
- **`graph.patch` 用 `expectedGraphVersion` 乐观锁**；冲突返回 `REVISION_CONFLICT`，需重读当前版本重试（项目打开/自动保存会推高版本）。
- **Windows PowerShell 重定向与 Write 工具会输出 UTF-8 BOM（EF BB BF），导致 CLI `JSON.parse` 失败**。用 Python 驱动 CLI（写无 BOM UTF-8 payload，程序化解析响应）。
- 输入包裹形状：`{"input":{...}, "idempotencyKey":"..."}`。
- 长时模型调用 CLI 可能返回 `OUTCOME_UNKNOWN`（exit 3，connect 超时），但任务在宿主继续；用 `flowAgent.inspect` / 查 `flow_coordination_runs` 表看真实状态，**不要盲目重试**。
- 失败的启动会留下占用节点的协调运行；改图前需 `flowAgent.stop` 释放（`RESOURCE_BUSY`）。

## 5. 如何在另一台电脑重建验证

1. 拉仓库，`pnpm install`（better-sqlite3 须按 Electron 编译；系统 Node 跑 SQLite 相关测试会 `ERR_DLOPEN_FAILED`，属既有环境问题，纯逻辑测试正常）。
2. 自用版构建：`$env:CANVAS_OWNER='1'; npx electron-vite build`（漏掉会跑成带授权门禁版本）。
3. 启动：先移除 `ELECTRON_RUN_AS_NODE`，再 `node_modules\electron\dist\electron.exe . --local-agent-access`。
4. 用自己的智谱密钥配模型：`model.connection.save`（protocol=openai-compatible, baseUrl=官方端点, apiKey）→ `model.definition.save`（modelId=glm-5.3, capabilities=[text.generate]）→ `model.validateAgentToolCalling`（confirmNetwork+confirmCost）。
5. 建 flow：`project.create` → `project.open` → `graph.patch` 建状态机/主控/专家/processor 目标链（参考 REPORT.md 第七节与 `exact_ctx.json` 的结构）。专家目标**必须用受支持类型**（见 §6 缺口）。
6. 复现根因：运行 `agent-flow-verification-20261112/repro_glm.py` 与 `repro_sdk.mjs`（设 `CANVAS_TEST_API_KEY`），对比应用内 `flowAgent.run` 的失败。

## 6. 已确认的能力缺口（实测）

| 缺口 | 证据 | 影响 |
|---|---|---|
| **无联网搜索工具** | `flowAgent.catalog` 仅 4 工具：node.execute / graph.preview / agent.dispatch / review.execute | "资料搜索专家"建不出来 |
| **文本生成节点不可被 Agent 调度** | `video-adapter.ts:29 flowTargetContract` 仅支持 processor/video/image-gen/image-edit/speech/tts/image-crop/image-split/code；text/chat/ai-process 不在内（`AGENT_TARGET_UNSUPPORTED`）| 写作垂类硬伤，需扩展可调度目标 |
| **状态机外部事件未开放 + 输出投影未实现** | `output.get` 报 `UNSUPPORTED_CONTRACT`；无事件提交 op；`16-node-action-coverage.md:56` 标 F8 | 外部不能推进状态机 |
| **无第一类纯人工任务节点** | 32 类无 human-task；纯人靠 text 节点承载 | 缺"人的环节"一等语义 |
| **无 headless 宿主** | 外部执行依赖桌面打开项目 | 不能脱离桌面运行 |

## 7. 下一步（按优先级）

1. **捕获应用内主控失败的确切 SDK 错误**（最关键，解锁修复）。当前错误被日志规范脱敏（`model.request.failed` 只有 UNKNOWN）。在 `src/main/gateway/glm-request.ts` 的 fetch 或 `src/main/agent-flow/runtime-model.ts` 的 coordinate 端口（约 435-468 行）临时捕获 error part 的 `responseBody`/`cause`，重构建重跑，拿到 GLM 真实报错。改受保护源码须过 parity 门禁。
2. **修复应用 GLM 集成**。对照实验：临时关闭 `glmRequestBody` 的 thinking 注入（`glm-request.ts:20-25`）或换非推理模型重跑主控，验证是否推理流式所致；再对症修（可能是 Electron Node 22 下 SDK 对 reasoning_content + 工具调用流的解析）。
3. **跑通完整闭环**：主控修好后，实测主控→专家执行 processor→产物→审核全链路（本轮因主控失败未到达）。
4. **扩展文本生成可调度目标**（写作垂类必需）：`flowTargetContract` 支持 text/ai-process，或新增文本生成能力节点。
5. 补搜索工具、状态机外部事件、纯人工节点（§6）。

## 8. 关键文件索引

| 用途 | 位置 |
|---|---|
| 主控编排 / 准入 / coordinate 调用 | `src/main/agent-flow/coordinator-host.ts`（准入 168-222，coordinate 505-530）|
| 模型端口 / dispatch schema / 决策流 | `src/main/agent-flow/runtime-model.ts`（coordinate 340-469，dispatch schema 370-430，专家工具 508-551）|
| GLM thinking 注入 + 自定义 fetch | `src/main/gateway/glm-request.ts`（glmRequestBody 3-26，glmCompatibleFetch 41-53）|
| 模型工厂（Chat Completions）| `src/main/gateway/factory.ts`（createCatalogChatModel 47-61）|
| 工具调用验证探针 | `src/main/agent-flow/model-probe.ts`（两阶段 38-146）|
| 审核责任绑定 | `src/main/agent-flow/coordinator-reviews.ts`（bindCoordinatorReviews 50-107）|
| 可调度目标契约 | `src/shared/agent-flow/video-adapter.ts:29`（flowTargetContract）|
| 节点配置契约 | `src/shared/agent-flow/node-contracts.ts`（Agent/Review/StateMachine config）|
| 外部操作注册表 | `src/shared/agent-access/registry.ts` + `ops/*` |
| 外部接入启动开关 | `src/main/index.ts:719`（--local-agent-access）|
| 标准状态机迁移表 | `src/main/agent-flow/desktop-electron.ts:1744` |

## 9. 注意事项

- **绝不把 API Key 写进代码或提交仓库**。复现脚本一律从环境变量 `CANVAS_TEST_API_KEY` 读。本机密钥在设备密钥库，跨机须重配。
- 改受保护源码（gateway/agent-flow/agent-access）须同包过 CLI/MCP parity + 契约快照 + 日志门禁（`npm run guard:agent-parity`、`npm run verify:agent-access`）。
- 不要 reset/clean 覆盖他人工作区；先 `git status` 与各台账。
- 验证类联网操作（model.validate / probe）会真实计费，须 confirmNetwork+confirmCost；复现脚本仅发小额文本请求。
- 本轮所有运行已停止，验证项目处于干净可编辑状态。