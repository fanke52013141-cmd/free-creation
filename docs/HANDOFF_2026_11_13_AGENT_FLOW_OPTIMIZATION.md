# Agent Flow 优化批次交接（2026-11-13）

承接：[2026-11-12 端到端验证交接](HANDOFF_2026_11_12_AGENT_FLOW_VERIFICATION.md)、
[优化方案](AGENT_FLOW_OPTIMIZATION_PLAN_2026_11_12.md)、[实施规格](AGENT_FLOW_EXECUTION_SPEC_2026_11_12.md)、
[R1/R2 根因结论](AGENT_FLOW_R1R2_FINDINGS_2026_11_12.md)、[L3 交付](AGENT_FLOW_L3_DELIVERY_2026_11_12.md)。

> **一句话现状**：二-1/二-2 产品改进、C1 文本可调度目标、C3 状态机外部事件、第三类可靠性
> （多专家+审核闭环/重启恢复/人工等待继续）全部实现并经真实模型验收；
> P0（composite 内部 ai-process 真实模型运行）已修复闭环（§3）；
> **C2/C4/W4 批次已闭环**（§8）：C2 豆包受控联网搜索、C4 纯人工任务节点、W4 composite 失败定位，
> 均经真实端到端/桌面级验收，三门禁全绿，全量零新增失败。改动尚未提交，待授权。

## 1. 本批完成项（均有真实验证证据）

### 1.1 二-1：无输入专家可分派（已裁决产品改进）
- `CoordinationDecisionSchema` dispatch/dispatch-many 的 inputs `min(1)→min(0)`；
  新增纯函数 `dispatchInputsSatisfied`：候选有固定输入时必须至少携带一条，
  无固定输入时允许空清单。模型端口在决策解析后按真实 available 校验。
- 验证：10 项单测 + 真实闭环变体（`CANVAS_TEST_NO_INPUT=1`，无上游专家成功分派并完成）。

### 1.2 二-2：processor 新建默认透传（已裁决产品改进）
- `NodeCardShape.onBeforeCreate` 默认 `operation:'pass'`（原 'pick' 喂文本必失败，
  R1 实测根因）；pick/template 由用户显式选择。已有配置不覆盖。
- 验证：3 项单测 + 真实闭环变体（processor 不带显式配置走默认 pass 成功执行）。

### 1.3 C1：text/ai-process 可调度目标（写作垂类解锁）
- `flowTargetContract`：text v3（in-text→out-text，确定性）；
  ai-process v1 限 text 输出模式（in-text/in-json→out-text；markdown/json 模式输出端口漂移，显式拒绝）。
- `flowTargetPorts` 补 TEXT_FLOW_PORTS / AI_PROCESS_FLOW_PORTS（与注册表 portIdentity 逐字段一致，有单测）。
- desktop-host / command-ledger 准入校验同包接入；asset-store declaredPort 补 ai-process→out-text。
- **过程修复 3 个真实产品缺陷**（真实闭环暴露）：
  1. textExecutor 在 Agent 调度执行（ctx.flowCommand）时写回 props.text → 语义修订变化 →
     提交阶段 FLOW_REVISION_CONFLICT。修复：调度执行不写回正文，合并结果走 nodeResult（含 runId），
     `projectTextOutputs` 按 runId 匹配优先投影；普通执行行为不变。
  2. ai-process 执行后物化独立文档产物卡 → 新节点改变 admitted 语义图 → 同样修订冲突。
     修复：`ctx.command` 下跳过 materializeDocumentArtifact（固定资产由命令台账从投影提交）。
  3. asset-store declaredPort 映射缺 ai-process → ASSET_PORT_INVALID。修复：补映射 + 运行成功门禁。
- 验证：8 项适配器单测 + 3 项资产单测 + 目标矩阵更新；
  **text 与 ai-process 两种目标的真实模型闭环均 6 项全过**
  （`acceptance:agent-flow-closed-loop`，`CANVAS_TEST_TARGET=text|ai-process`）。

### 1.4 C3：状态机外部事件 + 输出投影
- 新操作 `flowStateMachine.submitEvent`（write，渲染器权威动作：实例修订核对 → 准入 →
  写 meta.stateMachinePending → 保存屏障 → 落盘核对）与 `flowStateMachine.get`（read，
  当前阶段/修订/合法出边事件/待处理提交）。与 GUI「提交事件」按钮同一写入语义；
  迁移合法性仍由运行时 stateMachineExecutor 校验，外部不能直接改状态。
- `output.get` 支持 state-machine：DETERMINISTIC_PROJECTIONS + DETERMINISTIC_OUTPUT_SOURCES
  登记，投影 out-state（flow.state@1，与 GUI 同源 projectStateMachineOutputs）。
- 过程修复：main 侧 desktop.run 必须传 commit 回调，否则渲染器 commitLocalAgentDesktop
  准入被拒 → 握手超时 OUTCOME_UNKNOWN。
- 验证：4 项单测 + **7 项桌面验收全过**（`acceptance:agent-flow-state-machine`，确定性无计费）：
  初始读取/外部提交推进/out-state 投影/过期修订拒绝/二段推进/MCP 工具一致。

### 1.5 第三类可靠性（a/b/c 通过）
`acceptance:agent-flow-reliability`（真实模型）**6 项全过**：
1. 多专家+审核真实闭环：2 专家依次分派完成 → 模型审核（review.execute）→ flow.completed，5 个固定资产；
2. 重启恢复：关闭应用重开，台账/资产持久化，restore 不重复执行（资产 5→5，决策 3→3）；
3. 人工等待/继续：协作模式专家执行后进入 waitKind=human，外部 continue 后 completed。

### 1.6 其他产品缺陷修复
- **graph-patch edge.create 漏传 compositeManifest**：引用形态 composite 实例的公开端口
  解析为空，外部连线被误拒 EDGE_PORT_INVALID。修复：livePorts 传入节点 meta 快照；
  回归测试入仓（graph-patch-plan 12 项全过）。
- aiProcess.ts 的 `@shared/*` 别名导入改相对路径（crash-recovery 测试的 esbuild 无别名）。

## 2. 验收入口（新增/扩展）

| 命令 | 内容 | 计费 |
| --- | --- | --- |
| `acceptance:agent-flow-closed-loop` | 单专家闭环；`CANVAS_TEST_TARGET=processor\|text\|ai-process`、`CANVAS_TEST_NO_INPUT=1` 变体 | 真实模型（小额） |
| `acceptance:agent-flow-state-machine` | C3 状态机外部事件 7 项 | 无 |
| `acceptance:agent-flow-reliability` | 多专家+审核/重启恢复/人工等待 6 项 | 真实模型（小额） |
| `acceptance:agent-flow-composite-model` | composite 内部 ai-process 真实模型运行 | 真实模型（小额） |

密钥经 `CANVAS_TEST_API_KEY` 环境变量注入（不进仓库/日志）；`CANVAS_TEST_MODEL` 默认 glm-5.3-flash。
回执与截图留档 `qa/`（gitignore）。

## 3. 已解决：composite 真实模型运行（第三类-d）——P0 闭环

**根因（已确证）**：execute-nodes 桌面处理器的 **闭包陈旧 providers**。
`CanvasEditor.tsx` 注册 `onLocalAgentDesktopRequest` 的 useEffect 依赖仅 `[project.id]`
（约 1979 行），回调捕获注册时的组件闭包 `providers`（gateway store 初始为 `[]`）。
gateway store 的异步 `load()` 在项目打开后才完成，store 更新触发重渲染但 effect 不重注册
→ execute-nodes 永远拿空目录。`resolveFeatureOptionDetailed` 精确报：
**"能力绑定指向的供应商 zhipu-official 未加载"**（main 侧 binding 解析成功，渲染层查找失败）。

**二分证据**：验收脚本加 `provider.list` 诊断 → main 侧目录含 zhipu-official（true），
但执行时 ctx.providers 无 → 锁定渲染层闭包，而非 main catalog/验证过滤。
顶层 ai-process 闭环之所以通过：flow command 路径用 `useGatewayStore.getState().providers`
新鲜读取（约 454 行），不受闭包影响；headless 路径（App.tsx:65-66）先 `await load()` 再新鲜读取，亦不受影响。

**修复**：
- `CanvasEditor.tsx` execute-nodes 两处（single `runNodeManually` / workflow `runWorkflowForNodes`）
  改为执行时 `useGatewayStore.getState().providers` 新鲜读取，与 flow command 路径一致。
- `aiProcess.ts` 改用 `resolveFeatureOptionDetailed`，把精确 reason 并入 skipped 文案
  （诊断改进，便于后续台账直接定位失败环节）。
- 验收脚本加 provider.list 二分诊断（保留）。

**验证证据**：`acceptance:agent-flow-composite-model` **ok=true**，4 项全过：
能力验证+绑定 / 发布组合 model-polish@1.0 / 引用实例连线 / **composite 真实模型运行 completed，
公开输出为模型生成文本（88 字）**。定向 aiProcess/composite-executor/composite-runtime 全过。
三门禁全绿（契约 contracts.json 零 diff = 纯加性；164 操作 / 32 节点 / 190 IPC + 49 canvas / 239 actions）。
全量零新增失败（见 §5）。

**避坑**：凡 useEffect 依赖不含响应式 store 值、却在回调里用该值的，都是闭包陈旧嫌疑点；
执行路径应执行时 `getState()` 新鲜读取，不要依赖注册时闭包。

## 4. 关键机制事实（本批实测，供后续 Agent 避坑）

- **状态机完整事件词汇**含 review/rework 系列：flow.started / agent.dispatched / agent.completed /
  review.started / review.passed / review.completed / review.rejected / rework.created /
  rework.started / rework.completed / human.wait / human.continue / flow.paused / flow.completed。
  2026-11-12 交接的 7 事件列表不全；缺 review.* 迁移 → FLOW_STATE_TRANSITION_DENIED。
- **审核绑定要求**（reviewBinding）：审核节点必须有非空审核标准文本；responsibleNodeId 必须是
  专家节点；subjectSources.nodeId 必须等于 responsibleNodeId 且存在 source→review 的真实连线
  （in-text/in-json）；text-json 模式端口类型限 text/json/any。
- **reconcile/continue/restore 必须带 eventId**（FlowAgentRunSchema superRefine），
  另需 expectedTaskId + expectedWaitRevision；缺 eventId → INVALID_INPUT。
- **长模型调用 OUTCOME_UNKNOWN**：任务在宿主继续，用 flowAgent.inspect + 协调台账
  （flow_coordination_runs.body_json.state）核对，reconcile 触发结算，不盲目重试。
- **资产端口映射**（asset-store declaredPort）与 flowTargetContract.output 必须一致；
  新目标类型两处都要登记，否则 ASSET_PORT_INVALID。
- **语义修订契约**：执行结果不得改变 admitted 语义图（props.text/config/新节点）；
  调度执行的结果走 meta.nodeResult（非语义），投影按 runId 匹配。
- **better-sqlite3 按 Electron ABI 编译**：验收脚本查库用 Electron-as-Node 子进程
  （helpers/query-flow-run.cjs），系统 Node 直接 require 报 NODE_MODULE_VERSION 不匹配。
- **manifest 内部端口用 schemaRef**（不是 schema）；composite.publish 输入 strict，
  字段错误时 CLI 直接 LOCAL_AGENT_COMMAND_FAILED（无 JSON），先用 composite.validate 诊断。

## 5. 验证汇总与基线

- 全量 `npm run test`（规范 runner `scripts/run-vitest.cjs`，处理原生模块 ABI）：
  **296 文件、3351 过、2 失败、7 跳过**（P0 修复后干净重跑）。2 失败 = provider 夹具基线
  （local-agent-provider-network-access 的 provider.testConnection 2 项，与本批无关）。
  recovery-contention 为全量负载波动项（单跑 15/15 过、本次全量亦过；重负载跑可现 2 项波动），
  不放宽断言。**零新增失败**。注意：裸 `npx vitest` 绕过 runner 会触发 better-sqlite3
  Node/Electron ABI 不匹配（composite-run-wait 等），属环境而非回归，须用规范 runner。
- 门禁：`check-agent-access` / `audit-business-actions` 全绿
  （**164 操作** / 32 节点 / 190 IPC + 49 canvas actions / 239 actions）；
  P0 修复仅执行器内部逻辑，契约 contracts.json **零 diff**（纯加性，影响声明已刷新）。
- 类型：web/node 检查通过；`electron-vite build` 通过。
- `npm run verify` 仍卡基线 lint 25 条（license 两脚本，本批文件零新增错误）。

## 6. 环境与操作约定

- 构建自用版：`$env:CANVAS_OWNER='1'; npx electron-vite build`；
  启动带 `--local-agent-access` 并清除 `ELECTRON_RUN_AS_NODE`。
- **git 代理**：本机 http.proxy=127.0.0.1:7897 可能失效；推送/拉取用
  `git -c http.proxy= -c https.proxy= <cmd>` 绕过失效代理，**远端 URL 保持仓库真实 origin
  （github.com/fanke52013141-cmd/free-creation.git），严禁替换为临时代理地址**。
- 改动不自动提交；提交前征求确认并附详细 notes（根因/改动/验证/未验证边界）。
- 真实模型调用前说明计费口径；密钥只经环境变量/设备密钥库，不进仓库与日志。

## 7. 下一批建议（按优先级）

1. **composite W4 剩余项**：人工补交 / 受控重试的桌面级证据（失败定位已闭环，见 §8.3）。
2. C2 后续：外部 CLI/MCP `flowAgent.search` op（本批为内部 specialist 工具）；搜索供应方扩展。
3. C4 后续：人工节点作为 Agent 调度目标（flowTargetContract + skipped 回执账本语义，需评审）；headless 宿主。
4. 人工鼠标点击验收（W1–L3 累积 GUI 链路）与窄屏/长名称/出错状态复核。
5. 基线债处置（provider 夹具 2 项 + verify lint 25 条）需任务发起人授权。

## 8. C2/C4/W4 批次闭环（2026-11-13，均有真实验证证据）

方案：[C2/C4/W4 实施方案](AGENT_FLOW_C2C4W4_PLAN_2026_11_13.md)。用户裁决：顺序 W4→C2→C4；
C2 用豆包搜索（内部工具+方案 A 资产来源，授权免费额度冒烟）；C4 停等+composite fail-closed。

### 8.1 C2 豆包受控联网搜索（web.search@1）
- **核实纠正**：原假设「skill 可注入联网」不成立——skill 仅注入提示词+静态资源（`skill-agent.ts:18` 唯一工具 skill.read-resource），无网络工具。故新增受控搜索工具。
- **API**：火山官方文档（volcengine.com/docs/87772/2272953）核实，`POST https://open.feedcoopapi.com/search_api/web_search`，Bearer 独立搜索 key，500 次/月免费、独立于模型 token；错误在 ResponseMetadata.Error（HTTP 可能 200）。
- **实现**：`gateway/doubao-search.ts`（fetchUpstream+错误归一+脱敏事件）；specialist 决策增 search 变体（`runtime-contracts.ts`）+ LangGraph search 节点（`runtime.ts`）+ `search-tool.ts` 端口；`asset-store.submitSearchResult` 把结果结算为 agent out-json 固定候选资产（非静默采用，finish_task 只能引用 committed refs）；准入白名单加性放宽（node.execute 必选+web.search 可选）；UI 勾选；web.search.* 脱敏事件。搜索连接 id=doubao-search（legacy provider，无需模型验证）。
- **验证**：单测 16 项（doubao-search 7 + web-search-asset 9）+ 回归 59 项 + catalog 断言维护；真实端到端冒烟 `acceptance:agent-flow-web-search` **10 项全过**（主控分派搜索专家→真实豆包搜索 5 条结果→固定候选资产→completed）。

### 8.2 C4 纯人工任务节点（human-task）
- **实现**：一等节点（契约/Spec/Body/设置面板/执行器/投影）；停等语义（未提交 skipped 不伪造成功）；执行器权威推进（expectedRevision 防过期+submissionId 去重+类型校验）；外部 op `humanTask.submit/get`（与 GUI 同一 meta.humanTaskPending 写入，渲染器权威动作+保存屏障）；composite 内部人工节点 **fail-closed**（HUMAN_TASK_UNSUPPORTED_IN_COMPOSITE，定位内部节点）；output.get 投影同源（DETERMINISTIC_PROJECTIONS/OUTPUT_SOURCES）。
- **验证**：单测 12 项 + 注册表/parity 47 项 + 规格门禁（合规矩阵/颜色/调色板）维护；桌面级验收 `acceptance:agent-flow-human-task` **10 项全过**（停等/外部提交/修订冲突/out-text 投影/composite fail-closed 定位）。

### 8.3 W4 composite 失败定位
- **实现**：M31 迁移持久化 failure_node_id/failure_port_id；执行器边界+meta.nodeRun.error 透传；skipped 步骤如实记账（不再误记 completed）；execute.wait 填充 nodeId/portId；CompositeBody 失败定位+内部步骤台账 UI（parentRunId 下钻）。
- **验证**：repo/executor 单测 + 迁移测试维护；桌面级验收 `acceptance:agent-flow-composite-failure` **9 项全过**（failurePhase=output/failureNodeId=n1/failurePortId=out-text/skipped 台账）。

### 8.4 门禁与全量
- 三门禁全绿：**166 操作 / 33 节点 / 190 IPC + 50 canvas / 240 动作**。契约为加性（新增 humanTask.submit/get + human-task 节点；graph.patch/node.type.list/node.type.get 仅增 human-task 枚举值，向后兼容，已用 --accept-contract-change 并人工核对 diff 确证纯加性）。
- 全量 `npm run test`：**3390 过 / 2 失败 / 7 跳过**，唯一失败 = provider 夹具基线 2 项，**零新增失败**。
- 类型 web/node 通过；electron-vite build 通过。

### 8.5 未验证边界（如实）
- 人工鼠标点击 GUI 链路未做（验收为 CLI 驱动桌面宿主）；C2 外部 CLI/MCP op、C4 调度目标、W4 人工补交/受控重试留后续。
- 改动尚未提交（含 P0），待任务发起人授权。