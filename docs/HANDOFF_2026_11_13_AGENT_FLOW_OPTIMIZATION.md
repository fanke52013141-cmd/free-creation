# Agent Flow 优化批次交接（2026-11-13）

承接：[2026-11-12 端到端验证交接](HANDOFF_2026_11_12_AGENT_FLOW_VERIFICATION.md)、
[优化方案](AGENT_FLOW_OPTIMIZATION_PLAN_2026_11_12.md)、[实施规格](AGENT_FLOW_EXECUTION_SPEC_2026_11_12.md)、
[R1/R2 根因结论](AGENT_FLOW_R1R2_FINDINGS_2026_11_12.md)、[L3 交付](AGENT_FLOW_L3_DELIVERY_2026_11_12.md)。

> **一句话现状**：二-1/二-2 产品改进、C1 文本可调度目标、C3 状态机外部事件、第三类可靠性
> （多专家+审核闭环/重启恢复/人工等待继续）全部实现并经真实模型验收；
> **唯一未通过项**：composite 节点流内部 ai-process 的真实模型运行（第三类-d），
> 卡在组合隔离执行的模型功能解析，诊断证据与下一步见 §3。

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

## 3. 未通过项：composite 真实模型运行（第三类-d）——下一步最高优先

**现象**：`acceptance:agent-flow-composite-model` 前 3 项通过（能力验证+绑定、发布组合、
引用实例连线），运行失败：`REQUIRED_OUTPUT_MISSING：公开输出 polished 缺少内部 n1.out-text`。
内部步骤台账：n1(ai-process) status=completed 但 **reason="功能 text.process 尚未绑定已验证文本模型"**，
全程 ~60ms（无模型请求）——实为执行器 skipped，组合按非失败放行导致输出缺失。

**已排除**：
- 绑定与验证真实存在（model.validate text.generate 成功 + model.binding.save text.process 成功，
  同一数据目录内顶层 ai-process 节点的真实模型闭环已通过）。
- 组合输入注入路径（公开输入 raw→n1.in-text）与端口解析正常（连线验收通过）。

**嫌疑方向（按优先级）**：
1. **providers 目录时机**：`resolveFeatureOption` 在 main 解析出 binding 目标后，还要在
   `ctx.providers`（渲染层 gateway store）里找到 provider/model 才返回非 null。
   gateway store 仅在项目打开时 load 一次（CanvasEditor useEffect [project.id]）；
   execute-nodes 路径用的是组件闭包 providers。需确认组合执行时 providers 是否包含
   新建 catalog 连接（listProviders 的 catalogConfigs 异步路径/验证过滤）。
2. 组合隔离编辑器（runCompositeIsolated）传入的 providers 与顶层执行是否同源；
   可在 aiProcess 跳过分支临时输出 resolveFeatureOptionDetailed 的 reason 定位
   （是 resolveModelFeature 返回 null 还是 providers 查找失败）。
3. 若确认为 store 时机问题：修复方向是执行前确保 gateway.load()（或组合执行路径
   主动刷新 providers），而不是放宽解析校验。

**复现**：`$env:CANVAS_TEST_API_KEY='<key>'; node scripts/acceptance/agent-flow-composite-model.cjs`
（脚本已含 validate 前置诊断与内部步骤 reason 输出）。

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

- 全量 `npm run test`：**293 文件、3280 过、3 失败、7 跳过**。3 失败 = 2 项 provider 夹具基线
  （local-agent-provider-network-access，与本批无关）+ 1 项 recovery-contention 全量负载波动
  （单跑 15/15 过，已知波动项，不放宽断言）。**零新增失败**。
- 门禁：`guard:agent-parity` / `verify:agent-access` / `verify:logging` 全绿
  （**162 操作** / 32 节点 / 190 IPC + 49 canvas actions）；契约加性刷新（人工核对 diff）。
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

1. **修复 composite 真实模型运行**（§3）：定位 providers 解析时机，修复后跑
   acceptance:agent-flow-composite-model 全过；随后 composite W4 剩余项（失败定位/人工补交/
   受控重试的桌面级证据）。
2. C2 联网搜索工具（需用户定搜索供应方与密钥）。
3. C4 纯人工任务节点 / headless 宿主（需架构评审）。
4. 人工鼠标点击验收（W1–L3 累积 GUI 链路）与窄屏/长名称/出错状态复核。
5. 基线债处置（provider 夹具 2 项 + verify lint 25 条）需任务发起人授权。