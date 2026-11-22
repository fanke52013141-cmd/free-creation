---
title: Canvas Studio 待开发清单（BACKLOG）
status: living            # 常更新文档；每完成一项就勾选，并附上提交 hash
last-updated: 2026-11-22
baseline-commit: 99a30b6e (main)
sources:
  - docs/SPEC_DEEP_REVIEW_2026_11_22.md（审查报告，编号 A*/G*/N*/F*/U*）
  - docs/NODE_FLOW_SPEC.md 附录 A（NF-*）
  - docs/AGENT_FLOW_SPEC.md 附录 A（AF-* / V*）
  - 全节点组合测试与代码审查报告-20261122.md（U-*/T-*/F-*）
  - ROADMAP.md R4
---

# Canvas Studio 待开发清单

## 使用约定

- 每一项都有稳定 ID（`BL-xx`）。提交信息里要引用 ID，例如 `fix(agent-flow): BL-03 dead-path elimination`。
- **完成标准** = 验收项全部满足 + 门禁全绿 + 对应规范条款从【目标】改为【现行】（同一个提交完成）。
- 每一项默认要求：日志影响检查（`LOGGING_SPEC`）、GUI/CLI/MCP 三入口一致（`guard:agent-parity`）、`npm run verify`。下文不再逐项重复。
- 状态：⬜ 未开始 · 🟡 进行中 · ✅ 完成（附 hash）· ⏸ 延期（附原因和期限）。
- 规模：S（≤1 天）· M（2–4 天）· L（≥1 周）。

---

## P0：阻塞类（建议本周完成）

### ⬜ BL-00 恢复 11-20 丢失的 5 个提交并提交规范草案 · S
- **来源**：审查报告 §一（P0-0）
- **范围**：运行 `canvas-studio/restore-p0-20261122.ps1 -Push`。脚本会合回 `48833f2c 7baf9d3a 4e581d58 ff54f212 2172c9fe`，重新生成契约快照，再提交 `NODE_FLOW_SPEC / AGENT_FLOW_SPEC / SPEC_DEEP_REVIEW`。
- **验收**：
  - [ ] Summary 全部 PASS：verify:agent-access / guard:agent-parity / verify:logging / test:contract / restored-tests
  - [ ] `test/output-source-parity.test.ts`、`test/node-flow-e2e-composition.test.ts` 在 main 上存在且通过
  - [ ] 已推送到 origin/main（用 `git ls-remote` 核对）
  - [ ] 复核审查报告第一章表格里的 9 项：AGENTS.md、Speech indextts、MCP 注解、计费门、task-bind、计数等全部生效
- **待确认**：`135cbef8`（P 图审计产物）在 00:05 被立即撤回，是否是有意为之。

### ⬜ BL-01 外部 Agent 不得代人做人工决定 · M
- **来源**：审查报告 A6 · AF-1.5 / AF-5.3 / AF-17.2
- **范围**：
  - 在 OperationSpec 里新增动作级别：`read | propose | control | human-decision`。
  - `flowGraph.confirm`、`flowAgent.build.commit`、`humanTask.submit`、协作采用/拒绝、人工复审，从外部入口调用时**只写入草稿**，返回 `awaiting-human`。
  - GUI 弹出待采用提示，由人点击后生效。
  - 草稿标注 `author: agent:external:<clientId>`。
- **代码位置**：`src/shared/agent-access/ops/flow-agents.ts`、`src/main/agent-access/flow-agents-ops.ts`、`src/renderer/src/canvas/CanvasEditor.tsx:1806-1855`、`flow-build-actions.ts`
- **验收**：
  - [ ] 外部调用上述操作时，画布或节点状态都不变，只多出一份待采用草稿
  - [ ] GUI 采用后才落画布或完成，且只占一个撤销步
  - [ ] parity 测试覆盖三入口的不同行为（GUI 直接生效，外部只能产生草稿）
  - [ ] 规范 AF-17.2 改为【现行】

### ⬜ BL-02 task-bind 工具白名单回归 · S
- **来源**：AF-3.2a（如果 BL-00 合入成功，这一项随之关闭，只需复核）
- **验收**：[ ] 勾选 `web.search@1` 的专家 Agent 能正常运行；`runtime.ts` 与 `desktop-host.ts:280` 使用同一份白名单常量

### ⬜ BL-03 图模式：死路径消除 + 汇合推断 + 「停滞」终态 · M
- **来源**：G1 · AF-8.3a / AF-8.3b / AF-8.5b / V7
- **范围**：
  - 新增子节点状态 `skipped`：条件为假时标记，并沿数据边向下游传播。
  - `joinPolicy: all` 的语义改为「全部入边已落定（满足或已跳过），且至少有一条满足」。
  - 新增流程终态 `stalled`：判定条件是没有就绪节点、没有运行中节点、也没有人工待办；状态里带上阻塞节点和原因。
  - 删除 `coordinator-host.ts:1052-1055` 里把停滞报告为 `human.wait` 的逻辑。
- **代码位置**：`flow-graph-router.ts`、`coordinator-host.ts` graphStep、`desktop-tasks.ts` 状态联合、`run-overview.ts`
- **验收**：
  - [ ] 路由测试：XOR 分支 + 默认 all 汇合能走到完成；分支末端作为出口时，流程能完成
  - [ ] 死锁图返回 `stalled`，并给出节点 ID 和原因码
  - [ ] UI 上 stalled 与「等待人工」能明显区分（暂用状态文字，正式样式见 BL-16）

### ⬜ BL-04 分支条件互斥校验 · M
- **来源**：G2 · V6
- **范围**：对 `StageCondition` 做静态互斥检查（同一 stageKey、同一 path 上的 equals/exists/missing/type、count 区间、human-decision、review-passed）。无法判定的组合，要求写明 `else` 或优先级。
- **验收**：[ ] 两条都可能为真的条件出边，校验时拒绝，错误码 `CONDITION_NOT_EXCLUSIVE`；[ ] 有 `else` 的图可以通过

### ⬜ BL-05 校验即准入 · S–M
- **来源**：G4 / G6 / G8 · AF-6.2 / V8 / V9
- **范围**：
  - 校验、编译、运行准入共用同一份 kind 白名单（目前 `state-machine` 能通过校验，但会被准入拒绝）。
  - 数据边的端口存在性和类型，用 `portPairCompatible` 统一校验。
  - **删除 FlowGraph 的 `control` 边**（2026-11-22 已拍板）：
    - `FlowEdgeSchema.kind` 收窄为只允许 `'data'`（字段保留为可选，缺省 `'data'`，兼容旧 JSON）；收到 `'control'` 时校验报错 `FLOW_EDGE_KIND_REMOVED`，并给出边的下标
    - 删除 router / compiler / coordinator-host 里所有 `edge.kind === 'data'` 过滤（`flow-graph-router.ts:93`、`flow-graph-compiler.ts:190,317`、`coordinator-host.ts:1246,1349`）；`adjacency()` 不用再改，因为只剩数据边
    - `run-overview.ts` 里 `edges[].kind` 固定为 `'data'`，或者删掉这个字段
    - 画布上的控制关系（`controls / observes / review-gate / rework`，即 `AgentFlowRelation`）**不受影响**；它们保存在节点 config 中，由编译器生成，和 FlowGraph 边是两回事
    - 影响面：全仓 test、scripts、示例里**没有**使用 `kind:'control'` 的 FlowGraph。用户库 `flow_definitions` 里已发布的定义可能含有这类边，读取时按上面的错误码明确拒绝，并提示重新发布，不做静默丢弃
- **验收**：[ ] 属性测试：随机生成合法 FlowGraph，凡是校验通过的，运行准入一定通过；[ ] 端口不兼容的图在 propose 阶段就被拒绝；[ ] 含 `kind:'control'` 的图在 propose / validate / 读取已发布定义时都返回 `FLOW_EDGE_KIND_REMOVED`；[ ] 源码中不再出现对 FlowGraph 边 kind 的过滤

### ⬜ BL-06 零输出节点也算交付 · S
- **来源**：G5 · AF-8.1a
- **代码位置**：`coordinator-host.ts:1005-1009`
- **验收**：[ ] 可选输出本次没有产出的节点（如 video-clip 只出音频）完成后，下游能正常推进

### ⬜ BL-07 多节点循环：正式实现前先在校验里拒绝 · S
- **来源**：G3 · AF-8.4b
- **范围**：如果一个环里除了循环载体还有其他节点，校验时拒绝（错误码 `LOOP_BODY_UNSUPPORTED`）。正式实现放在 BL-11。
- **验收**：[ ] 先补一条 `B(loop)→C→B` 的路由测试，确认当前行为（审查附录中待确认的第 4 项）；[ ] 加上校验拒绝

### ⬜ BL-08 节点流发布期与运行期预算统一 · S
- **来源**：审查报告 A7 · NF-10.2
- **范围**：`composite/validate.ts`（5 层 / 500 节点）和 `composite/runtime.ts`（8 层 / 200 节点）改为共用一个常量模块。
- **验收**：[ ] 测试断言两处读取的是同一常量；[ ] 300 个节点的流在发布时就被拒绝，或者能正常运行，二者结果一致

---

## P1：能力扩展主线

### A. 节点流 → Agent Flow 打通（影响最大）

### ⬜ BL-10 节点流即能力 + 可编排能力目录自动生成 · L
- **来源**：A1 / F7 · NF-1.4 / NF-13.* · AGENT_FLOW_SPEC §4.4
- **范围**：
  - 已发布的节点流自动登记为 `capabilityRef {kind:'composite', id, version}`。
  - 能力目录由节点注册表和发布仓库**自动生成**，并带上参与形态下限、成本、网络、是否可调度。
  - 删除编译器里硬编码的 7 项 `CAPABILITY_COMPILE`。
  - 上帝 Agent 的能力菜单、MCP 工具描述都从这份目录生成。
- **依赖**：BL-05
- **验收**：[ ] 发布一个节点流之后，`flowAgent.catalog` 能看到它；[ ] 在 FlowGraph 里引用它能编译、运行、交付；[ ] 节点流内部失败时，failureNodeId 能透传到运行总览

### ⬜ BL-11 FlowGraph v2：params、显式端口、子图循环 · L
- **来源**：G3 / G7 · AGENT_FLOW_SPEC §4.4 / AF-8.4b
- **范围**：
  - FlowNode 新增 `params`，按目标节点的 config schema 校验。
  - 数据边使用目标节点的真实端口，取消重映射。
  - `loop: {body[], maxIterations, exitCondition}`，路由器按轮次计算落定。
  - 旧 v1 图只读兼容。
- **依赖**：BL-10
- **验收**：[ ] video 节点的多端口按语义接线；[ ] 生图参数（模型/比例/张数）生效；[ ] 三节点循环能跑满上限后退出，每轮使用独立 taskId；[ ] BL-07 的拒绝规则撤销

### B. 节点流规范落地

### ⬜ BL-12 端口兼容判定统一 + 补全类型 · M
- **来源**：F2 · NF-6.4 / NF-6.5
- **范围**：节点流内部统一使用 `portPairCompatible`；`COMPOSITE_PORT_TYPES` 补上 `iteration / camera`，或者在封装入口明确拒绝。
- **验收**：[ ] 遍历 connection-matrix 真值表，节点流判定结果与画布完全一致；[ ] 包含 iterate 的流封装有确定、可解释的结果（审查附录中待确认的第 1 项）

### ⬜ BL-13 节点流校验补强 · M
- **来源**：F3 / F4 / N5 · NF-6.2a / NF-6.6 / NF-7.5
- **范围**：
  - 内部边和公开输出做 JSON Schema 兼容校验。
  - 媒体固定输入按 mime 类型匹配。
  - 必填输入在所有入口都在运行前预检，消除「莫名的 REQUIRED_OUTPUT_MISSING」。
  - 删除自由格式的 `schema` 片段，只保留 schemaRef。
- **验收**：[ ] 每条规则各有一个正例和一个反例；[ ] 缺少必填输入时，任何内部节点都不会执行，并返回 `INPUT_REQUIRED`

### ⬜ BL-14 缺席三态：未产出 / 已跳过 / 未运行 · M
- **来源**：N5 / N6 · NF-9.1 · NODE_CONTRACT_SPEC 补节
- **范围**：数据包收集层表达 `absent.reason`，并按规则向下游传播；手动画布、节点流、Agent Flow 使用同一套语义。可以与 BL-03 的 skipped 共用实现。
- **验收**：[ ] 下游能区分三种原因；[ ] 依赖必填输入的下游会随之 skipped

### C. Agent Flow 规范落地

### ⬜ BL-15 角色化单用户 · M
- **来源**：A4（已决策：只做方案 A）· AF-16.*
- **范围**：
  - FlowGraph 新增 `roles[]`，节点新增 `humanRole`，加校验规则 V13–V15。
  - 编译时写入 AgentNodeConfig / HumanTaskNodeConfig。
  - 人工决定、提交、讨论记录 `actor:{kind:'user', roleId}`，**归属取节点上声明的角色**。
  - 收件箱按角色分组，stalled 置顶。
  - 增加「以某角色查看」筛选器。
  - 交接说明 `handoffNote`：只有在 selector 里用 `$handoff` 声明时，才进入模型上下文。
  - 运行总览中事件的 source 细化为 `user:<roleId> / agent:<nodeId> / agent:external:<clientId> / system`。
- **验收**：[ ] 人工或协作节点缺少角色时，校验拒绝；[ ] 切换视图不改变人工决定的归属；[ ] handoffNote 没有 selector 时不进入模型上下文；[ ] 旧图按隐式的 `owner` 角色兼容

### ⬜ BL-16 统一状态全集表 + 人机协作 UI 章节 · M
- **来源**：U2 / U3 · AGENT_FLOW_SPEC §18
- **范围**：
  - 在 UI 规范中新增两章：一张状态表覆盖手动节点、节点流、Agent Flow 的全部状态（含 skipped/stale/stalled/需核对，以及 waiting 的等人/等工具/等宿主）；另一章写收件箱、协作面板、运行总览、角色标签、交接说明的展示位置。
  - 按规范实现样式。
- **依赖**：BL-03、BL-15
- **验收**：[ ] 浏览器门禁截图覆盖每一种状态；[ ] 「颜色不能单独承载状态」检查通过

### ⬜ BL-17 FlowGraph 与画布往返（diverged） · M
- **来源**：A3 · AF-5.4
- **验收**：[ ] 落画布之后修改被控节点，运行总览显示 `diverged`；[ ] 下次运行时要求在「反向导出新版本」和「放弃修改」之间二选一，不能静默按旧 IR 运行

### ⬜ BL-18 状态机改为流程阶段机 · M
- **来源**：A5 · AF-12.3a
- **需拍板**：用阶段 FSM，还是带并行区域的 statechart（建议用阶段 FSM）。
- **验收**：[ ] 并行 fork、循环、条件分支下，状态机显示都如实；[ ] 节点级进度只出现在子任务上

### ⬜ BL-19 返工上限统一 · S
- **来源**：A7 · AF-13.4
- **范围**：FlowGraph、ReviewNodeConfig、默认值三处统一为 0–3、缺省 3，共用一个常量。
- **验收**：[ ] 常量单一来源的测试；[ ] 旧配置 >3 时按 3 截断，并给出提示

### ⬜ BL-20 人工提交媒体结果 · M
- **来源**：AF-9.2a
- **需拍板**：(a) human-task 增加媒体结果类型；(b) 用「资产节点 + human-task 引用」的模板实现。
- **验收**：[ ] 人在图上上传图片作为交付，下游可以按固定版本引用

### ⬜ BL-21 执行者 × 决策者两维 · M
- **来源**：AF-9.3
- **范围**：participation 拆分为 `executor × decider`，原有三种取值映射到新模型。重点是让「AI 产出、人采用」不再需要额外包一层 Agent。
- **依赖**：BL-11
- **验收**：[ ] capability 节点可以配置 `decider: human`；[ ] 旧图自动映射，行为不变

### D. 规范与组合测试遗留

### ⬜ BL-22 NODE_CONTRACT_SPEC 修订 · M
- **来源**：N1–N11
- **范围**：
  - 文档拆为正文 + `CHANGELOG`；尺寸数值改为引用 `STANDARD_NODE_SIZE`。
  - 视频参考上限改为由能力描述驱动。
  - `cardinality` 拆为 `fanIn / valueShape`（先只改文档，代码改造另立项）。
  - 补充 skip / stale / 缺席语义；修正编号重复，以及 NodeValuePacket 签名、代码入口清单。
- **验收**：[ ] 正文里没有带日期的变更段落；[ ] spec-lint（BL-30）通过

### ⬜ BL-23 操作节点卡内「死结果区」 · S–M
- **来源**：组合测试 U-1 / U-2（推荐方案 b）
- **范围**：speech / voice-design / image-edit 的 Body 改为从 `meta.nodeResult` 集合读取当前选中项，与 `MediaResultGrid` 同源。
- **验收**：[ ] 运行后卡片内可以试听或回看本次结果；[ ] 不再依赖 `props.mediaPath`

### ⬜ BL-24 MiniMax 克隆参考音频约束放到主进程 · S
- **来源**：组合测试 T-4
- **范围**：在 `cloneMiniMaxVoice` 入口校验：时长 10 秒–5 分钟、大小 ≤20MB、MIME 在白名单内；连线输入和上传输入两种来源都要覆盖。
- **验收**：[ ] 不合规的音频在请求供应商之前就被拒绝，并返回可操作的提示文案

---

## P2：收敛与体验

| ID | 事项 | 来源 | 规模 |
|---|---|---|---|
| ⬜ BL-30 | **spec-lint**：每份规范的头部必须有 status / last-verified；「当前权威」最多出现一次；禁止裸计数；超过 14 天未验证就告警 | 审查报告 §九 | S |
| ⬜ BL-31 | NODE_UI_STANDARD v3 单一现行版 + 裁决历史归档；几何、线宽、尺寸的数值由测试读取规范文件比对 | U1 | L |
| ⬜ BL-32 | 文档归档：仓外方案和报告移入 `source/docs/archive/`；Agent Flow 52 份文档按 AGENT_FLOW_SPEC §20 归档；弹窗规范移入仓库（U5）；L3 UI 条款回写到 PRESENTATION_SPEC（U4） | 审查报告 §九 | M |
| ⬜ BL-33 | 节点流：分支失败策略 `onBranchFailure`、内部并发 `maxConcurrency`、人工门自动推断、扇入顺序可见可调 | NF-8.3a / 8.4 / 8.5 / 9.3a | M |
| ⬜ BL-34 | 节点流版本号改为 major.minor；升级应用只占一个撤销步，失败时回滚 | NF-11.2 / 11.5 | M |
| ⬜ BL-35 | 固定顺序模式统一编译成图模式；预算交叉检查 V10；错误码 `CAPABILITY_UNKNOWN`（V12）；selector 可达性检查 V11 | AGENT_FLOW_SPEC §2.2 / §7 | M |
| ⬜ BL-36 | 安全与计费：循环项还原媒体时，校验媒体归属和路径（N7）；所有远端异步生成节点只在「提交前或提交失败」时重试（N9 / NF-12.3a） | N7 / N9 | S–M |
| ⬜ BL-37 | MCP 注解从 OperationSpec 里的 `idempotent / destructive / cost` 声明派生（BL-00 合入后再复核是否已完成） | 审查报告 §七 · NF-14.3 | S |
| ⬜ BL-38 | 体验修复：音色设计按钮的可用状态与功能绑定一致（U-3）；循环体为空时提前提示（F-1）；产物节点放在视口内（U-5） | 组合测试 | S–M |
| ⬜ BL-39 | ROADMAP R4：批处理中止后，提供「只继续未完成项」入口 | ROADMAP R4 | M |
| ⬜ BL-40 | ContextManifest 溢出策略 `overflow: fail \| ask-human \| summarize` | AF-10.4 | M |

---

## P3

| ID | 事项 | 来源 |
|---|---|---|
| ⬜ BL-50 | 首页入口更醒目；视频模式被自动改写时给一次轻提示 | 组合测试 U-4 |
| ⬜ BL-51 | 组合测试脚本转为正式的 `scripts/test-node-combos.cjs`，纳入大版本发布门禁；连接矩阵导出改为快照测试 | 组合测试 P3-7 |
| ⬜ BL-52 | 配置 Vidu Token 后，复跑组合 8，完成真实出片验收 | 组合测试 P3-8 |

---

## 待拍板

| 问题 | 关联 | 建议 |
|---|---|---|
| `135cbef8` 被撤回是否是有意为之 | BL-00 | — |
| ~~`control` 边：删除，还是实现为「仅顺序依赖」~~ | BL-05 | ✅ 2026-11-22 已决定：删除 |
| 状态机：阶段 FSM 还是 statechart | BL-18 | 阶段 FSM |
| 人工媒体交付：human-task 扩展类型，还是资产节点模板 | BL-20 | (a) 扩展类型 |
| 节点流 headless 输出键：带前缀还是裸 id | NF-5.3 | 统一带前缀 |

## 待补用例确认（来自审查报告附录）

1. 含 `iterate` / `camera` 端口的节点流，封装时的行为 → BL-12
2. iteration 媒体还原时是否校验了 mediaId 归属 → BL-36
3. headless 输出键约定在 BL-00 合入后是否已统一 → BL-00
4. 多节点循环的实际行为 → BL-07

---

## 建议节奏

| 周 | 内容 |
|---|---|
| 第 1 周 | BL-00 → BL-02、BL-06、BL-07、BL-08（小项先清）→ BL-01、BL-03、BL-04、BL-05 |
| 第 2–3 周 | BL-10、BL-12、BL-13、BL-14（打通节点流与 Agent Flow，补齐节点流规范） |
| 第 4 周 | BL-11、BL-15、BL-16 |
| 之后 | 其余 P1，以及 P2/P3 按需排期 |
