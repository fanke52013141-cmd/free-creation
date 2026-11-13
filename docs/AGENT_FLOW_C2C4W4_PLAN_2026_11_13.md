# Agent Flow 能力缺口与可靠性收尾实施方案（C2 / C4 / W4）

日期：2026-11-13。配套：[优化方案](AGENT_FLOW_OPTIMIZATION_PLAN_2026_11_12.md)、[实施规格](AGENT_FLOW_EXECUTION_SPEC_2026_11_12.md)、[交接](HANDOFF_2026_11_13_AGENT_FLOW_OPTIMIZATION.md)。
基线：`main` @ `8e4f81dc` + 未提交 P0 修复（execute-nodes 闭包陈旧 providers，已验收 ok=true，待授权提交）。

> **一句话范围**：C2 用豆包搜索给专家 Agent 补受控联网工具；C4 新增纯人工任务一等节点（先架构评审）；W4 只做 composite 运行失败定位。C1/C3 已完成；C2 原「需供应方决策」已由用户定为豆包搜索。

## 0. 用户决策与核实结论

| 项 | 决策 |
|---|---|
| C2 联网搜索 | 采用**豆包搜索（火山引擎联网搜索 Custom 版）**；key 由用户提供（设备密钥库/环境变量，不进仓库/日志） |
| 能力缺口 | 本批做 **C4 纯人工任务节点**（C1/C3 已完成） |
| 可靠性收尾 | 本批只做 **W4 失败定位**（人工补交/受控重试/重启恢复+付费核对留后续） |

**关键核实（纠正原假设）**：原设想「联网可经 skill 注入」**不成立**。`skill-agent.ts:18` 技能唯一允许工具是 `skill.read-resource`（读静态文本资源）；专家工具集（`runtime-model.ts:513`）= execute_node/load_skill/finish_task/wait_for_human，主控 = dispatch_agent/dispatch_parallel/finish_flow/wait_for_human，**均无联网工具**。skill 只能喂预置静态资料，不能 live 搜索。故 C2 必须新增网络工具执行器。

---

## 1. C2：豆包搜索受控工具 web.search

### 1.1 API 契约速查（火山官方文档核实，Custom 版）

| 项 | 值 |
|---|---|
| 端点 | `POST https://open.feedcoopapi.com/search_api/web_search` |
| 认证 | `Authorization: Bearer <API_KEY>`（独立搜索 key，**非方舟 Ark key**） |
| Content-Type | application/json |
| 请求 | `Query`(1~100 字符，必填，超长截断、不支持多词)、`SearchType`("web"/"image"，必填)、`Count`(≤50，默认 10)、`Filter{NeedContent,NeedUrl,Sites,BlockHosts,AuthInfoLevel,IcpHostOnly}`、`TimeRange`(OneDay/OneWeek/OneMonth/OneYear/YYYY-MM-DD..YYYY-MM-DD)、`QueryControl{QueryRewrite}`、`ContentFormats`(text/markdown)、`Industry`(finance/game/health/gov) |
| 响应 | `ResponseMetadata{RequestId,Error?}` + `Result{ResultCount,WebResults[],SearchContext,TimeCost,LogId}`；**失败时 Result=null，错误在 ResponseMetadata.Error，HTTP 可能仍 200** |
| WebItem | Id/SortId/Title/SiteName/Url/**Snippet**(~200 字，仅列表展示)/​**Summary**(500~1000 字，**推荐喂模型**)/Content(全文)/PublishTime(ISO)/RankScore/AuthInfoDes/AuthInfoLevel(1~4) |
| 计费 | 每火山账号 **500 次/月免费**（与 Global 版共用），超出按量后付费；**独立于模型 token**；10 QPS/账号 |
| 错误码 | 700429 QPS 限流→429；10406/10412 额度耗尽；700901 key 无效；10500/10501 可重试；10413 robots 合规拒绝（不可重试） |

**未核实项**：官方文档已核请求/响应字段；错误码表来自社区整理（10router issue #84），实施时以真实冒烟返回为准。本批只做 web 文搜文，不做 image/visual/fetch。

### 1.2 架构接入点（探查实测，file:line）

工具登记链：catalog 输出 schema 通用（`ops/flow-agents.ts:312`），**新增内部工具不改外部契约**；真正硬编码点：
- `desktop-host.ts:246-251` catalog 工具数组（追加 web.search@1）
- `desktop-host.ts:268-271` **准入白名单**（现仅允许 node.execute@1，需放宽）
- `runtime.ts:230-234` 执行期 tool-scope 复核
- `agentFlow.tsx:562-594` UI 勾选（specialist 增 web.search）

运行时：`runtime-model.ts:513-556` tool() 定义、`:588-600` toolName→kind 映射；决策契约 `runtime-contracts.ts:118-144`（增 search 变体）；LangGraph `runtime.ts:220-339`（增 search 节点+边）。**MVP 不改 coordinator**（搜索属 specialist 内部循环）。

网络：复用 `gateway/upstream-fetch.ts:47` `fetchUpstream`（redirect:'manual' 拒 3xx、AbortSignal.timeout、凭据脱敏）+ `CONTROL_TIMEOUT_MS`(60s)；密钥经 `providers.repo.ts:77` readConnectionSecret/vault，外部只给 connectionId。新建 `gateway/doubao-search.ts`。

日志：`observability/events.ts` def 登记 web.search.started/completed/failed（attributes 仅 id/int/flag/short≤80）；红线**不记 query 正文/结果正文/密钥/原始异常**（failed 只传稳定码 `new Error(code)`）。

### 1.3 核心设计决策：搜索结果如何成为「候选资产」（非静默采用）

**约束**：现有资产管线（`asset-store.ts:68` submit）**只能投影自已保存画布节点输出**（DETERMINISTIC_PROJECTIONS + declaredPort）。web.search 结果无对应画布节点，必须扩展资产来源。

| 方案 | 做法 | 评估 |
|---|---|---|
| **A（推荐）** | 新增 `web.search` 命令种类（`commands.ts:20` 现仅 node.execute）；search 在 main 执行后由 ledger 直接 prepare+commit（无需 renderer deliver），asset-store 增 search 来源 submit 变体写 flow_asset_versions（json kind/out-json），产出 outputRefs→自动进 candidates | 贴合现有「回执→候选→finish_task 只能引用 committed refs」机制，天然非静默采用；改动集中 main |
| B | 经渲染器把结果写入专用 json 节点再走 node.execute 结算 | 引入画布副作用，改动大，不推荐 MVP |

**非静默采用保证**：结果持久化为 committed 回执资产→仅作 observedOutputs 回灌模型+列入 candidates；finish_task/人工选择只能引用固定 refs；search 节点 prompt 标记结果为「外部不可信观察」，不得自动 finish。

### 1.4 受控网络与计费门

- 内部工具路径：确认门 = 用户在节点配置**显式勾选 web.search@1**（准入白名单）+ 运行期 tool-scope 复核，与 confirmNetwork「默认不执行、显式授权才联网」同构。
- 豆包 500 次/月免费、独立计费；首次运行建议人工确认（复用 collaborative wait_for_human 或准入提示）。**真实冒烟前向用户说明计费口径**（免费额度内）。
- 可选后置：外部 CLI/MCP op `flowAgent.search`（含 confirmNetwork/confirmCost，首行 refuse NETWORK_CONFIRM_REQUIRED，复用 safeMessage）——本批不做，避免 contracts.json 变更。

### 1.5 文件改动清单（按依赖排序，MVP=内部工具+方案 A）

1. `observability/events.ts` 登记 3 事件
2. `gateway/doubao-search.ts`（新建）fetchUpstream+vault+GatewayError 稳定码+emitGatewayEvent
3. `runtime-contracts.ts:118` AgentDecisionSchema 增 search 变体
4. `commands.ts:20` 增 web.search 命令/回执类型
5. `asset-store.ts` 增 search 来源 submit 变体（main 生成值、幂等 submissionId、json/text kind）
6. `command-ledger.ts` 增 search prepare+commit（main 直接结算）
7. `runtime-model.ts:513-600` 增 web_search tool（按 config.tools 条件挂载）+映射
8. `runtime.ts:220-339` 增 search 节点+边+port 调用+tool-scope 校验
9. `desktop-host.ts` catalog 数组+准入白名单+接线 search port
10. `agentFlow.tsx:562` specialist 增 web.search 勾选（+browserMock 可选）
11. 门禁 `check-agent-access.cjs --write --reason`（仅刷新 change-impact，contracts.json 不变）
12. 测试：observability schema 自动覆盖；补 search 节点/资产候选/准入白名单单测；真实冒烟脚本

### 1.6 验收标准

- 定向：search 决策解析、准入白名单（未勾选拒绝）、资产候选注入、finish_task 只能引用 committed search refs、错误码归一、事件脱敏。
- 真实冒烟：配豆包连接→specialist 勾选 web.search→分派「资料搜索专家」→真实搜索→结果成候选资产→人工/finish 引用→flow.completed；台账+截图留档 qa/。
- 门禁三关全绿（contracts.json 零 diff，仅 change-impact 刷新）；全量对照基线零新增。

### 1.7 风险

- 资产来源扩展（5/6）是区别于 execute_node 的关键，需保证幂等与 commandPermit 占用语义不被破坏。
- Query≤100 字符、无 country/language；长 query 截断行为需提示。
- 错误在 body（HTTP 200）必须先查 ResponseMetadata.Error 再读 Result，否则空结果误判成功。

---

## 2. C4：纯人工任务节点 human-task（先架构评审）

> 方案标注「需架构评审、单列不预先承诺」。本节为评审稿，**批准后才实施**。

### 2.1 一等节点登记点（NODE_CONTRACT_SPEC.md:173）

新节点须自带 Spec/Body/Executor/投影，禁止运行器按 nodeType 加 switch：
1. `shared/types/index.ts:11` ACTIVE_NODE_TYPE_IDS 加 human-task
2. 新 Spec 注册（`registry.tsx:436`）：contractVersion=1、端口（in-* 可选上下文、out-text/out-json）、executor、projectOutputs、Body、SettingsPanel、340×260
3. `node-schemas.ts:9` 注册 Schema（或复用 json.any@1）+ 补 NODE_CONTRACT_SPEC.md
4. 投影函数（参照 agent-outputs.ts projectStateMachineOutputs）
5. 可调度则 `video-adapter.ts:30` flowTargetContract 增条目+输入校验
6. 外部提交 op（参照 flowStateMachine.submitEvent：ops+service 分派+渲染器权威动作）
7. 日志复用公共执行生命周期+失败阶段+LOGGING_COVERAGE.md

### 2.2 等待语义（核心评审决策）

可复用范式：**state-machine 的「pending meta + expectedRevision + 执行器唯一权威」**（`agentFlow.tsx:110-208` UI 只写 pending；`executors/agentFlow.ts:225-346` 校验修订/去重/迁移）+ **agentFlow 执行器的「skipped+reason 表达等待」**（`executors/agentFlow.ts:92-105`，不伪造成功）。

**不宜整套搬 Agent 等待机**：waitRevision/semanticRevision/模型预检与 flow_agent_tasks 强耦合；纯人工节点无模型参与，用 state-machine pending 范式更轻。

**待评审决策**：
- (a) 工作流全局运行遇 human-task 是**停**还是**绕行**？（现无先例；skipped 会被下游必需输入校验视为无输出）
- (b) 人工产物如何资产化？主控 finish_task 只接受 committed 回执引用，人工提交文本/JSON 需经 assets.submit 物化才可被调度消费。
- (c) **composite 内人工节点**：台账有 waiting-input 状态（`composite-run.repo.ts:6`）但 run-composite.ts 无人工等待处理，隔离 editor 中 human-task 会被当 skipped 走完——需 **fail-closed 或显式拒绝**。
- (d) tldraw meta 浅合并：消费 pending 必须写空串（`agentFlow.ts:329`）。

### 2.3 Body UI

参照 state-machine Body：任务说明（props.text）+输入预览+结果填写（按 out 端口）+「提交结果/标记完成」写 pending meta+等待/已完成状态+修订冲突重提提示。

### 2.4 验收标准（实施后）

节点可创建/配置/保存/重开一致；人工提交经执行器权威推进+修订防过期；调度目标准入；产物资产化可被下游消费；composite 内 fail-closed；定向+门禁+桌面证据。

---

## 3. W4：composite 运行失败定位（本批可靠性收尾）

### 3.1 现状缺口（探查实测）

- 台账 `composite-run.repo.ts:13-34`：composite_runs 有 errorCode/errorMessage/**failurePhase**(input|step|output|runtime)，步骤表 composite_run_steps 有 stepKey/nodeType/status/reason。
- **缺口①**：`CompositeRunFailure{code,phase,nodeId?,portId?}`（run-composite.ts:50）只在内存返回值；`finish()`（:97）落库**不传 nodeId/portId**→失败节点未结构化持久化。
- **缺口②**：执行器边界 `executors/composite.ts:77-88` 失败只回传 reason+diagnosticPhase，**丢弃 failure.nodeId/portId**。
- **缺口③**：skipped 步骤被记为 completed（run-composite.ts:353 `failed?'failed':'completed'`），跳过原因只在输出阶段 reason 拼接。
- **缺口④**：桌面无内部步骤列表 UI（CompositeBody.tsx 只显示名称/版本/端口；RunTimeline 不读步骤台账）；nested parentRunId 无下钻。
- **缺口⑤**：`composite.execute.wait` 的 failure 只回 {code,phase}（service.ts:537），schema 允许 nodeId/portId 但服务端从不填充。

### 3.2 改动清单

1. `composite_runs` 持久化失败 nodeId/portId（迁移 + finish() 透传，failure 对象已含）
2. `executors/composite.ts:84` 失败结果携带 nodeId/portId 进 meta.nodeRun/诊断
3. `run-composite.ts:353` skipped 步骤如实记 skipped+reason
4. 桌面 composite 实例详情读 composite.run.get 渲染内部步骤状态/reason，支持 parentRunId 下钻；RunTimeline 关联步骤台账
5. `service.ts:537` composite.execute.wait failure 填充 nodeId/portId
6. 测试：run 级失败节点断言、skipped 台账、output 阶段 nodeId/portId 定位、嵌套失败链

### 3.3 验收标准

制造内部节点失败/必需输出缺失/skipped→composite.run.get 与 execute.wait 返回结构化 failureNodeId/failurePortId+phase；桌面实例详情可见失败内部节点与原因；嵌套失败可下钻；定向+门禁+桌面证据（截图/回执 qa/）。**不依赖真实模型**（用确定性 processor 失败即可定位）。

---

## 4. 分批顺序与门禁纪律

推荐顺序（理由：W4 最 contained 且无计费先交付；C2 已调研充分随后；C4 需评审批准最后）：
1. **W4 失败定位**（无计费，含 DB 迁移）→ 定向+桌面证据
2. **C2 豆包 web.search**（免费额度冒烟）→ 定向+真实冒烟+门禁
3. **C4 human-task**（评审批准后）→ 定向+桌面证据

每批纪律：批内完成重跑定向+全量（规范 runner `scripts/run-vitest.cjs`）对照基线（provider 夹具 2 项 + recovery-contention 波动 + verify lint 25 条），零新增才汇报；受保护源码同包刷新 change-impact（先不带 --accept-contract-change 验纯加性）；**不自动提交**，附 diff+notes 征求授权；密钥经设备密钥库/环境变量不进仓库/日志；真实调用前说明计费口径。

## 5. 待用户决策项

1. **C2 MVP 范围**：内部 specialist 工具+方案 A 资产来源（推荐，不改外部契约）；是否同时做外部 CLI/MCP op（后置）？
2. **C2 计费门**：首次运行人工确认方式（节点准入提示 vs collaborative wait_for_human）；真实冒烟在 500 免费额度内，是否授权现在冒烟？
3. **C4 等待语义**：§2.2 (a) 全局运行停/绕行、(c) composite 内 fail-closed——评审批准后才实施。
4. **分批顺序**：是否同意 W4→C2→C4？