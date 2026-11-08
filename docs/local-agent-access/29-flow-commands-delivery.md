# F8（二）交付：Flow 命令账本协作外部接入（flowCommands 12 项）

日期：2026-11-08。范围：GUI「Agent Flow 命令」账本协作 IPC 族（`flow-commands:*`，12 项）的外部开放。
基线：77 项外部操作、116 项接入测试、真实桌面里程碑 28 项全绿。
结论（首包）：**3 项外部操作、覆盖 4 个 IPC 通信动作；其余 8 项按"不伪造内部身份"原则不开放，逐项原因见第 3 节。**
结论（F8 收官续，2026-11-08 第二轮）：**已追加 `flow.command.check`（read，只读结算预演）**；
`prepare`/`dispatch`/`abort` 的外部主体与共享端口设计、所需 DB 迁移 SQL 已提交 Lead（见第 9 节）。
结论（F8 收官第三轮，Lead 加 M24 迁移后）：**`flow.command.dispatch`（含 prepare 等价）与
`flow.command.abort` 已按第 9 节设计落地**（共享权威端口 + `principal='external'`），本族 12 项全部有了
最终判定；实现与证据见第 10 节。
首包不新增数据库迁移、不新增桌面握手动作、不新写执行器；全部落在既有 `flow_commands` 账本与授权规则上。

---

## 1. 外部主体身份设计（先于实现）

### 1.1 账本里现有的"谁"

`flow_commands` 行在当前系统中有三个身份事实：

| 字段 | 含义 | 谁写入 |
| --- | --- | --- |
| `owner_session` | 创建该命令的 `FlowCommandLedger.sessionId`（main 进程内的账本会话 UUID） | `FlowCommandLedger.prepare` |
| `lease_id` | 该命令的租约；`check`（准入）、`abort`（未开始的放弃）、`unknown`（标记结果未确认）都要求租约匹配 | `FlowCommandLedger.prepare` |
| `admitted` | 渲染器在真正调用执行器前经 `check` 写入的"已准入"位；`commit` 只有在 `admitted=1` 时才允许把成功运行结算为 committed | 渲染器经 `flow-commands:check` |

内部 Agent（`FlowCoordinatorHost` / `FlowAgentDesktopHost`）与手动运行共用**同一条**桌面命令桥：main 账本
`prepare` → 主进程向渲染器发送 `flow-commands:grant` → 渲染器 `flow-command-bridge.ts` 执行
`check`/`commit`/`abort`/`unknown` → 保存屏障后由 main `commit` 从已保存事实结算。渲染器 `cancel`
事件与 `deliver` 的取消分支也只走这条桥。

### 1.2 外部主体：只允许对既有命令做安全操作

本包**不向 `flow_commands` 写入任何新命令/新租约**，因此外部不存在"被登记进账本的身份"，
也不可能伪造内部 `owner_session` 或 `lease_id`。外部能做的是三类不依赖身份的操作：

1. **读**：按 `(projectId, commandId)` 读既有命令的回执（`lookup`）。
2. **准入检查**：按 `(projectId, nodeId)` 复用账本同一个占用/审核门禁查询（`availability`）。
3. **按已保存事实结算**：调用账本自己的 `commit`，只依据已保存项目里的运行记录结算既有命令（`reconcile`）。

这三类操作都不携带"我是内部 Agent"的声明；账本不因调用者不同而放宽任何校验。外部调用的可区分性由
**能力边界**本身保证：外部没有创建、授权、取消、放弃命令的写口，所以任何内部 Agent 身份都不可能被冒用。

### 1.3 租约归属

- 外部**不能获得或声明 `leaseId`**：租约只在 `prepare` 的 `grant` 中产生，而 `prepare`/`grant` 不外开放。
- 因此 `check`（准入）、`abort`（未开始的放弃）、`unknown`（把 pending 标记为 unknown）三项
  需要租约与 `owner_session` 的写操作**不登记**。外部即使猜到租约 UUID，也没有任何操作会读取外部传入的租约。
- `commit`（结算）在内部账本里本就不校验租约所有者，只校验"已保存运行记录里的
  `runId/commandId/commandLeaseId/inputFingerprint` 与账本行完全一致"，再由账本自己回填。
  这是它可以在不伪造身份的前提下开放的原因。

### 1.4 与内部 run、外部 run 的区分

| 主体 | 账本 | 外部可见方式 |
| --- | --- | --- |
| 内部 Agent Flow 运行 | `flow_coordination_runs` + `flow_agent_tasks` + `flow_commands` | `run.get`（source=`flow-agent-task`，本包不变）；命令回执经 `flow.command.lookup` |
| 外部节点执行 | `external_runs`（`node.execute`） | `run.get`/`run.wait`/`run.cancel`（source=`node-run`） |
| 本包外部核对 | 不新建运行，只读/结算既有 `flow_commands` | `flow.command.lookup` / `flow.command.availability` / `flow.command.reconcile` |

外部核对不会写入 `external_runs`，也不会出现在 `run.get` 的 `node-run` 分支；
内部 Agent 任务的终态仍由 `FlowCoordinatorHost`/`FlowAgentDesktopHost` 拥有，外部不能改写。

### 1.5 幂等语义

- 两个读操作（`lookup`/`availability`）不要求幂等键，重复调用只重复读取。
- `reconcile` 是写操作，沿用 dispatch 的 `local_agent_operations` 幂等账本：同键同参重放**返回原回执且
  不再执行任何结算**；同键异参返回 `IDEMPOTENCY_CONFLICT`。需要在新事实出现后再次核对时使用新的幂等键。
- `reconcile` 本身也幂等：账本的 `commit` 对终态回执行直接返回原回执；结算输出资产用确定性
  `submissionId=command:<sha256>`，重复结算不会产生第二个输出版本。

### 1.6 unknown 语义

- `reconcile` 只按**已保存事实**推进：`commit` 成功时返回账本真实状态（可能是 `committed`、`failed`、
  `skipped` 或 `unknown`）；`commit` 因"运行记录尚未落盘/不匹配/租约未准入"等原因拒绝时，外部响应
  **不把命令说成成功**，而是返回当前账本回执（`pending`/`unknown`）+ 稳定原因码（`reason`）+ `commitAttempted=true`。
- `unknown` 保持为"结果未确认"，不是可重试失败的别名；外部既不能把它改成 success，也不能把它改成 failed。
- 任务已被取消时由账本如实结算：未准入 → `skipped`（`FLOW_TASK_STOPPED_BEFORE_ADMISSION`）；
  已准入 → `unknown`（`FLOW_TASK_STOPPED_OUTCOME_UNKNOWN`）。这两种都是"账本已核对的取消确认"，
  不是外部发起的取消请求。

### 1.7 判定结论

| IPC 动作 | 外部能否安全开放 | 判定 |
| --- | --- | --- |
| `lookup` | 只读既有回执，无身份要求 | ✅ 开放 |
| `availability` | 复用账本同一占用/审核门禁，只读 | ✅ 开放 |
| `commit`（结算） | 只依据已保存事实、由账本回填；不校验租约所有者 | ✅ 开放（`flow.command.reconcile`） |
| `unknown`（核对） | GUI 的"unknown 核对"= lookup+commit；外部用同一 `reconcile` | ✅ 开放（同一操作） |
| `prepare` / `dispatch` / `grant` | 需要账本会话 + 向权威渲染器下发 `grant` 的通道；外部做会创建无执行者的 pending 占用，或必须伪造内部会话 | ❌ 不开放 |
| `check` / `abort` | 需要 `leaseId` 且 `owner_session` 必须是内部账本会话；外部无租约，开放也只能永远拒绝 | ❌ 不开放 |
| `cancel` | 主进程→渲染器单向取消通知；外部等价取消是 `run.cancel`（外部 run）与内部 Agent 的 stop 能力，不转发内部 IPC | ❌ 不开放 |
| `attach` / `detach` | 渲染器命令桥与活动画布的内部绑定，不是独立用户业务动作；外部操作显式带 projectId | ❌ 不开放 |

> F8 收官续（第 9 节）已把 `check` 开放为**只读结算预演**（回滚事务复用账本 commit 规则，不落账、不冒充准入），
> 并给出 `prepare`/`dispatch`/`abort` 的迁移与端口设计。上表保留首包判定原文，最新状态以第 9 节为准。

---

## 2. 已开放操作与三入口状态

| 业务动作 | GUI 入口 | CLI | MCP | 公共实现 |
| --- | --- | --- | --- | --- |
| 查询命令回执（lookup） | 运行详情/恢复核对（`lookupFlowCommand`） | `flow.command.lookup` | `flow_command_lookup` | `FlowCommandLedger.lookup`（同一账本类） |
| 核对节点可执行性（availability） | 手动运行前占用/审核门禁（`checkFlowNodeAvailability`，`executor.ts`） | `flow.command.availability` | `flow_command_availability` | `FlowCommandLedger.assertNodeAvailable` |
| 按已保存事实结算既有命令（commit/unknown 核对） | 执行桥收尾 `commitFlowCommand`；重启核对 `reconcileFlowNodeCommand` | `flow.command.reconcile` | `flow_command_reconcile` | `FlowCommandLedger.commit` |
| 只读结算核对（check，F8 收官续） | 重启核对前的"能否结算"判断（同一 `commit` 规则） | `flow.command.check` | `flow_command_check` | `FlowCommandLedger.commit`（回滚事务内预演，不落账） |
| 外部派发（dispatch，F8 收官第三轮） | 内部 Agent 工具派发 / 手动执行同一命令桥 | `flow.command.dispatch` | `flow_command_dispatch` | 共享端口 → `FlowCommandLedger.prepare(raw,'external')` + 既有 grant 通道 |
| 外部放弃（abort，F8 收官第三轮） | 未开始命令的放弃（`abortUnstarted` 的外部主体版本） | `flow.command.abort` | `flow_command_abort` | `FlowCommandLedger.abandonExternal`（仅 external + admitted=0） |

CLI/MCP 由同一 `ACCESS_OPERATIONS` 自动生成，无第二份实现。

动作清单 `docs/local-agent-access/action-coverage.json` 中本族 12 个键的最终状态：
**external 8 个**（`lookup`/`availability`/`commit`/`unknown`/`check`/`dispatch`/`prepare`/`abort`；
其中 commit+unknown 映射同一 `flow.command.reconcile`，prepare+dispatch 映射同一 `flow.command.dispatch`）、
**excluded 4 个**（`attach`/`detach`/`grant`/`cancel`，内部桥事件，附逐项理由）。
本族不再有 F8 计划项；F8 剩余分母只含其他业务族（flowAgents/flowAssets 等，未在本包改动）。

---

## 3. 逐项原因与最终判定（含首包未开放项）

| IPC | 级别 | 原因 | 后续方案 |
| --- | --- | --- | --- |
| `attach` / `detach` | excluded | 渲染器命令桥与活动画布的内部绑定通道，不是独立用户业务动作；外部操作一律显式携带 projectId，不存在"外部画布"需要附着 | 若将来需要外部长期会话，先在项目中定义显式外部宿主，再评估绑定语义 |
| `grant` | excluded | 主进程→渲染器的单向授权下发事件，不是可调用动作；外部通过 `lookup`/`reconcile` 读同一账本事实 | 无需开放；事件本身不产生业务动作 |
| `cancel` | excluded | 主进程→渲染器的单向取消通知，真实取消由渲染器执行桥完成；外部取消语义已由 `run.cancel`（外部 run）与内部 Agent stop 承担，不原样转发内部 IPC | 外部若需取消内部命令，应先有可区分的外部租约（见下） |
| `prepare` | **external（并入 dispatch）** | 单独 prepare 会创建 pending 命令/租约/占用，但外部没有权威渲染器通道执行它，会制造无法结算的占用 | 不单独开放：等价能力并入 `flow.command.dispatch` 的第一阶段（外部不允许"只准备不交付"）；见第 10 节 |
| `dispatch` | **external（F8 收官第三轮）** | 经共享权威端口复用同一账本会话；main 生成命令身份、先 flush、`principal=external`、付费族需确认 | ✅ 已开放 `flow.command.dispatch`，见第 10 节 |
| `check` | **external（F8 收官续）** | 首包判定"需要租约"针对的是**准入写**；外部开放的是只读结算预演，不冒充准入、不落账 | ✅ 已开放 `flow.command.check`，见第 9 节 |
| `abort` | **external（F8 收官第三轮）** | 放弃既有命令会改写事实，故限定 `principal=external` + `admitted=0` + pending/unknown；committed 一律拒绝 | ✅ 已开放 `flow.command.abort`，见第 10 节 |
| `unknown`（标记） | F8（未开放） | 把 pending 降级为 unknown 需要租约；外部只做 `reconcile`（只按事实推进，不主动降级） | 外部租约落地后评估 |

关键边界：**外部没有创建/授权/取消/放弃 Flow 命令的写口**。这是本包"不伪造内部身份"的实现方式，
不是遗漏；`prepare`/`dispatch` 若强行开放，要么需要伪造内部 `owner_session` 与渲染器 grant 通道，
要么产生永远无法结算的 pending 占用，两者都违反硬约束。

---

## 4. 公共实现与兼容

- Registry：`src/shared/agent-access/ops/flow-commands.ts` 新增
  `flow.command.lookup`（read）、`flow.command.availability`（read）、`flow.command.reconcile`（write）、
  `flow.command.check`（read，F8 收官续）、`flow.command.dispatch`（execute，F8 收官第三轮）、
  `flow.command.abort`（write，F8 收官第三轮），输出 Schema 同文件登记；`registry.ts` 仅做既有的
  `...FLOW_COMMANDS_OPERATIONS` 组装（F8 基线已就位）。
- 业务实现：`src/main/agent-access/flow-commands-ops.ts`。读/结算类直接构造同一 `FlowCommandLedger`
  调用其 `lookup` / `assertNodeAvailable` / `commit`；`check` 在**回滚事务**内调用同一个 `commit`
  得到"现在结算会落到什么状态"后整体回滚（命令回执/输出版本/占用事实都不落库），真正结算仍由
  `reconcile` 执行。派发/放弃经**共享权威端口** `flow-command-bridge.ts` 复用
  `registerFlowCommandsIpc` 的那一个账本会话，不另建实例、不直写 SQLite。
- 账本/桌面层追加（F8 收官第三轮）：`command-ledger.ts` 的 `Row.principal`、
  `prepare(raw, principal='internal')`（默认行为不变）与 `abandonExternal`；
  新建 `flow-command-bridge.ts` 窄端口；`flow-commands.ipc.ts` 在账本与交付通道就绪后
  `publishFlowCommandAccessPort(...)`（import + 发布共 +12 行）。
- `service.ts` 最小追加：import、dispatch 中一个 `flow.command.*` 分组分支（`await` + 传入
  activeProjectId/desktop；F8 收官第三轮只加 context 字段）、把 `flow.command.reconcile` /
  `flow.command.abort` 加进与 `run.cancel` 同类的占用检查豁免（否则结算/放弃目标本身就会被
  `TASK_OCCUPANCY` 挡住），以及 switch 里 6 个不可达的 `UNSUPPORTED_OPERATION` 守卫
  （TypeScript 穷尽检查要求，与既有 `graph.patch`/`node.execute`/`run.cancel` 写法一致）。
  未改动其他分支与并发锁实现。
- 兼容：既有操作、输出 Schema 与错误码不变；本族共新增 6 个操作键，属于增量。
  契约快照 `generated/contracts.json` 与动作清单由 Lead 统一刷新（本包不执行 `--write`）。
  数据库迁移 M24（`flow_commands.principal`，默认 `internal`）由 Lead 添加并已合入
  （`DB_SCHEMA_VERSION` 23→24）；既有行与既有内部调用行为完全不变。
- 错误码：项目/命令不存在统一 `NOT_FOUND`，节点不存在 `NODE_NOT_FOUND`，非法输入 `INVALID_INPUT`；
  占用/审核门禁透传账本稳定码（`FLOW_NODE_OCCUPIED` / `FLOW_CONTROL_OCCUPIED` / `FLOW_REVIEW_NOT_READY`）；
  结算被拒绝时以 `reason` 回传账本码，不伪造失败或成功。

---

## 5. 真实验证证据（本工作区实测）

| 检查 | 命令 | 真实结果 |
| --- | --- | --- |
| 类型检查 | `npm run typecheck` | 通过（node / web / license-protocol / issuer 四段 EXIT=0） |
| 本包测试 | `node scripts/run-vitest.cjs run test/local-agent-flow-commands-access.test.ts --reporter=dot` | **6/6 通过**（注册表三入口、非法参数/未知命令/跨项目、占用门禁、unknown 不报成功与账本不变、按事实结算与幂等、取消确认分离） |
| 接入回归 | `node scripts/run-vitest.cjs run test/local-agent-flow-commands-access.test.ts test/local-agent-access.test.ts test/local-agent-graph-access.test.ts test/local-agent-run-access.test.ts test/local-agent-media-access.test.ts test/local-agent-chat-access.test.ts test/graph-patch-plan.test.ts --reporter=dot` | **78/79 通过；1 项失败为聚合契约快照未刷新**：`local-agent-access.test.ts > blocks stale generated contracts…` 的第二段期望 `Protected source changed`，实际先被真实 `generated/contracts.json` 的 `Generated contract is stale` 拦住。新增操作是增量登记，Lead 统一刷新 `generated/contracts.json` + `change-impact.json` 后复验（本包不执行 `--write`） |
| 动作分母审计 | `node scripts/audit-business-actions.cjs` | 覆盖校验通过（未出现 `MISSING_COVERAGE / UNKNOWN_EXTERNAL_OP / STALE_ACTION`），随后因 `generated/action-inventory.json` 是旧聚合产物报 `Action inventory is stale; run audit-business-actions.cjs --write` 退出 1；该生成物按分工由 Lead 统一刷新 |
| 日志旁路门禁 | `node scripts/check-logging-bypass.mjs` | 通过（`logging gate passed`） |

> 如实说明：`generated/contracts.json`、`generated/action-inventory.json`、`change-impact.json` 是本批多个包共享的聚合产物，按任务分工由 Lead 在批次收口时统一 `--write` 并复验；本包不代刷，因此上表两项仍显示聚合产物陈旧，而不是业务实现失败。

### 5.1 F8 收官续（`flow.command.check`）实测

| 检查 | 命令 | 真实结果 |
| --- | --- | --- |
| 本包测试 | `node scripts/run-vitest.cjs run test/local-agent-flow-commands-access.test.ts --reporter=dot` | **7/7 通过**（新增"check 只读预演"：无事实时 `wouldSettle=false + FLOW_SAVED_RUN_MISMATCH`；有事实时预测 `committed` 但账本/输出版本不落账；reconcile 才落账；终态 `alreadySettled`；取消事实预演 `skipped` 与 reconcile 一致；NOT_FOUND/跨项目/非法参数；未登记 prepare/dispatch/abort 的边界断言） |
| 必跑三件套 | `node scripts/run-vitest.cjs run test/local-agent-flow-commands-access.test.ts test/local-agent-access.test.ts test/local-agent-parity.test.ts --reporter=dot` | **51/52 通过；1 项失败为聚合契约快照未刷新**（`local-agent-access.test.ts > blocks stale generated contracts…`，原因同首包：新增操作使 `generated/contracts.json` 陈旧，Lead 统一 `--write` 后复验） |
| 类型检查 | `npm run typecheck` | 通过（node / web / license-protocol / issuer 四段 EXIT=0） |
| 动作分母审计 | `node scripts/audit-business-actions.cjs` | 覆盖校验通过（本包键无任何 `MISSING_COVERAGE / UNKNOWN_EXTERNAL_OP / STALE_ACTION / ORPHAN_EXTERNAL_OP`），随后因 `generated/action-inventory.json` 是旧聚合产物报 `Action inventory is stale; run audit-business-actions.cjs --write` 退出 1；该生成物按分工由 Lead 统一刷新 |
| 日志旁路门禁 | `node scripts/check-logging-bypass.mjs` | 通过（`logging gate passed`） |

> 说明：以上"整仓门禁未绿"只来自共享工作区其他席位的在途改动与本包新增操作导致的聚合产物陈旧；
> 本包相关用例、覆盖键与日志门禁均为绿。批量收口时 Lead 统一刷新聚合产物后需复跑三件套。

### 5.2 F8 收官第三轮（`flow.command.dispatch` / `flow.command.abort`）实测

| 检查 | 命令 | 真实结果 |
| --- | --- | --- |
| 本包测试 | `node scripts/run-vitest.cjs run test/local-agent-flow-commands-access.test.ts --reporter=dot` | **12/12 通过**（新增：共享端口派发受理、main 生成身份、`principal=external`、非活动画布拒绝、付费未确认拒绝且不产生命令、端口未发布拒绝、幂等重放只一条命令/一次 grant、下发前确定失败自动放弃不留占用、下发不确定返回 unknown、abort 准入条件矩阵、受理/预演阶段不写输出版本；既有 7 项断言全部保留） |
| 账本/桌面回归 | `node scripts/run-vitest.cjs run test/agent-flow-command-ledger.test.ts test/agent-flow-command-ipc.test.ts test/db-migrations.test.ts --reporter=dot` | **115/115 通过**（`prepare` 默认 `internal` 行为、账本状态机、IPC 准入/结算、M1–M24 迁移均未受影响） |
| 必跑三件套 | `node scripts/run-vitest.cjs run test/local-agent-flow-commands-access.test.ts test/local-agent-access.test.ts test/local-agent-parity.test.ts --reporter=dot` | **56/57 通过；1 项失败仍为聚合契约快照未刷新**（`local-agent-access.test.ts > blocks stale generated contracts…`；新增操作使 `generated/contracts.json` 陈旧，Lead 统一 `--write` 后复验） |
| 类型检查 | `npm run typecheck` | 通过（node / web / license-protocol / issuer 四段 EXIT=0） |
| 动作分母审计 | `node scripts/audit-business-actions.cjs` | 覆盖校验通过（无 `MISSING_COVERAGE / UNKNOWN_EXTERNAL_OP / STALE_ACTION / ORPHAN_EXTERNAL_OP`），随后因 `generated/action-inventory.json` 旧聚合报 `Action inventory is stale` 退出 1（Lead 统一刷新） |
| 日志旁路门禁 / ESLint | `node scripts/check-logging-bypass.mjs`；eslint（本包 7 文件） | 均通过（EXIT=0） |

> 未做真实 Electron 桌面端到端（另需真实活动画布 + 真实 grant 通道，属里程碑脚本范围）；
> 付费族目标只用假渲染器验证阶段闸门，**未触达任何供应商**。

---

## 6. 日志覆盖与脱敏

- 外部操作生命周期沿用 dispatch 的 `agent.access.started/completed/failed/unknown/rejected`
  （唯一外部终态拥有者）；本包新增的账本操作另外复用既有 `command.operation.started/completed/failed`
  事件记录账本阶段（与 `flow-commands.ipc` 同一事件族与 `phase` 值：`lookup` / `manual-occupancy` /
  `saved-receipt` / `reconcile-preview` / `dispatch` / `abandon`），携带 `commandId`、`state`、`versionId`
  与 trace/span，不新增事件类型。只读预演无法结算时事件 `status=unknown`，不记 success；
  dispatch 的 completed 事件里 `state=pending`（受理，不代表执行完成），abort 的 completed 里
  `state=skipped`。**不记录**命令输入清单、资产值、Agent 目标正文、提示词或模型回复。
- 脱敏：不记录命令输入清单、资产值、提示词、正文、路径、模型回复或凭据；`commandId`/节点 ID/项目 ID
  是受控标识。日志写入失败不改变外部应答（`emitGatewayEvent` 内部 catch）。
- 详细登记见 `docs/LOGGING_COVERAGE.md` 本包条目。

---

## 7. 未覆盖边界

- 未做真实 Electron 桌面端到端：本包的外部操作不经过渲染器执行（只读账本/按已保存事实结算），
  服务级测试使用真实 SQLite + 真实账本类；桌面桥本身的行为仍由既有桌面验收覆盖，本包未重跑。
- `availability` 的审核门禁分支（`FLOW_REVIEW_NOT_READY`）未在本包新增测试中构造完整审核夹具，
  该分支由既有账本单测与桌面验收覆盖；本包测试覆盖占用/控制范围两类门禁。
- 外部核对不能替代内部 Agent 的终态拥有权：内部任务状态仍由 `flow_agent_tasks`/协调运行决定。

---

## 8. 下一包

1. **真实桌面里程碑段**（独立包）：在真实 Electron + CLI 下跑"外部 dispatch → 渲染器执行 →
   外部 check/reconcile 读回"，覆盖 grant 交付、活动画布切换、flush/版本与未保存编辑；
   本包只有服务级"假渲染器"证据，**不写 desktop-tested**。
2. **renderer `flush` 语义修正评估**：本包发现 `flush` 请求在 `CanvasEditor` 中没有强制保存分支，
   只回当前已保存版本（详见第 10.5 节）；外部 dispatch 已按"命令语义版本以已保存图计算"实现并
   对未保存编辑如实 skipped，但若要让 dispatch 在"用户正在编辑"时也稳定受理，需要一次独立的
   renderer flush 修正（与 F8 固定资产提交共用同一问题），属跨入口保存协议变更，未在本包擅自修改。
3. **多宿主并发**（F8 三，Lead）：按项目锁 + 多画布宿主，使两张画布可同时运行。
4. 契约快照/动作清单统一刷新与真实桌面重跑由 Lead 在批次收口时执行。

---

## 9. F8 收官续（第二轮）：check 开放 + 外部命令（dispatch/abort）设计

本轮目标是把 `dispatch` / `prepare` / `check` / `abort` 继续推进。结论分两部分：
**`check` 已作为只读操作开放并验收；`dispatch`/`prepare`/`abort` 需要"外部主体列 + 共享命令端口"，
设计、迁移 SQL 与账本/端口改动已提交 Lead，迁移落地前不登记**（不先埋一个永远拒绝的幽灵接口）。

### 9.1 已交付：`flow.command.check`（read，只读结算预演）

- **语义**：只读既有命令的账本回执，并在**回滚事务**内调用账本自己的 `commit` 一次，得到"若现在
  调用 reconcile 会落到什么状态"，然后整体回滚。它不落账、不改写命令回执/租约/占用、不生成输出版本；
  真正的结算仍必须经 `flow.command.reconcile`（write + 幂等键）。
- **为什么不直接开放账本 `check`（准入）**：账本 `check` 是渲染器执行前的**准入写**，要求 `leaseId`
  且 `owner_session` 匹配；外部没有租约，直接开放只能永远拒绝，或必须伪造内部会话。因此外部
  `check` 只做"核对/预演"，准入仍由内部渲染器在执行前写入。
- **输出**：`{ projectId, commandId, state, alreadySettled, wouldSettle, wouldResultState?, reason?, receipt }`。
  - `wouldSettle=false` 时 `reason` 为账本稳定码（如 `FLOW_SAVED_RUN_MISMATCH`、`FLOW_LEASE_REJECTED`）；
  - 预演中生成的输出版本随事务回滚，**不会**出现在 `wouldResultState`/`receipt` 里；外部要拿到正式
    输出引用必须调用 `reconcile`；
  - 终态命令返回 `alreadySettled=true`，不预演；
  - unknown 预演仍是 unknown（不会被报成成功）。
- **只读证明（测试断言）**：预演前后 `flow_commands` 行（state/receipt_json/lease_id/run_id/owner_session/
  admitted）完全相等；`flow_asset_versions`/`flow_asset_submissions` 计数不变；取消事实的预演结论
  （`wouldResultState=skipped`）与随后 reconcile 的真实落账状态一致。
- **三入口**：GUI 等价动作是重启核对前的"能否结算"判断（同一 `commit` 规则）；CLI `flow.command.check`；
  MCP `flow_command_check`。`action-coverage.json` 中 `ipc.flowCommands.check` 转为 external。
- **日志**：复用 `agent.access.*`（外部生命周期）+ `command.operation.started/completed/failed`
  事件族，`phase=reconcile-preview`；预演无法结算时事件 `status=unknown`，不记 success；不记录命令输入清单/正文。

### 9.2 为什么 dispatch/prepare 不能沿用"另建一个 ledger 实例"

`FlowCommandLedger` 只在 `registerFlowCommandsIpc` 中创建一次，它是渲染器 `flow-commands:check/commit`
IPC 的唯一验收会话：`owner_session` 必须等于该实例的 `sessionId`；grant 下发通道
（`webContents.send(IPC.flowCommands.grant)`）与 `activeProjectId` 也只在该闭包里。外部另建实例会出现：

1. 两个权威：外部 prepare 的命令行 `owner_session` 不同，渲染器 `check` 必然 `FLOW_LEASE_REJECTED`；
2. 无受控交付：外部没有把 grant 交给渲染器的既有通道，另建一条等于新增外部专用执行器；
3. 无主体区分：外部借用同一会话 prepare 出的命令与内部 Agent 工具派发不可区分，属于冒充内部身份。

因此正确做法与 F8 第二批（`flow-bridge.ts`）一致：**把同一个权威实例以窄接口发布**，并给命令行增加
显式 `principal` 标记。

### 9.3 建议设计（已在第三轮落地，实现见第 10 节）

> 本节保留第三轮提交给 Lead 的设计原文；实现时有三处按实际收敛，**以第 10 节为准**：
> ① 付费族还包含 `voice-design`；② dispatch 响应不含 `receipt`（受理只回 commandId/taskId/runId/
> graphVersion/state，避免把"已受理"误读为"已结算"）；③ `flow-commands.ipc.ts` 的发布块约 15 行
> （含 send 的 active/window 判空与 arm），不是 2 行。

**A. 数据库迁移（Lead 统一加，建议 M24）**

```sql
ALTER TABLE flow_commands ADD COLUMN principal TEXT NOT NULL DEFAULT 'internal'
  CHECK (principal IN ('internal','external'));
```

- 既有行默认 `internal`（历史命令全部是内部 Agent/手动运行产生），语义正确；
- `DB_SCHEMA_VERSION` 23 → 24（由 Lead 排号）；
- 不需要新索引：`principal` 只用于身份判定与审计，不参与热查询。

**B. 账本（`src/main/agent-flow/command-ledger.ts`，需授权/Lead 加）**

1. `Row` 增加 `principal: string`；
2. `prepare(raw: NodeExecuteCommand, principal: 'internal' | 'external' = 'internal')`：INSERT 时写入
   `principal`（默认 `internal`，既有调用方零改动；仅共享端口用 `external`）；
3. 新增受控放弃方法（只对未开始的外部命令）：

```ts
/**
 * 外部主体放弃一条**尚未开始**的命令：principal=external、admitted=0、
 * state 为 pending 或 unknown（unknown 且 admitted=0 表示渲染器从未准入，必然未执行）。
 * 已准入（admitted=1）一律拒绝：可能已执行，必须用 reconcile 按已保存事实核对。
 */
abandonExternal(raw: CommandLookup): FlowCommandReceipt {
  const input = CommandLookupSchema.parse(raw)
  return this.db.transaction(() => {
    const row = this.row(input)
    const receipt = JSON.parse(row.receipt_json) as FlowCommandReceipt
    if (row.principal !== 'external') fail('FLOW_COMMAND_NOT_EXTERNAL', 'abandon')
    if (receipt.code === 'FLOW_EXTERNAL_ABANDONED' && row.state === 'skipped') return receipt
    if (row.admitted !== 0) fail('FLOW_COMMAND_ALREADY_ADMITTED', 'abandon')
    if (row.state !== 'pending' && row.state !== 'unknown')
      fail('FLOW_COMMAND_NOT_PENDING', 'abandon')
    return this.update(row, {
      ...receipt,
      state: 'skipped',
      code: 'FLOW_EXTERNAL_ABANDONED',
      outputRefs: []
    })
  })()
}
```

- `unknown` 只在 `admitted=0` 时可放弃（说明从未准入、必然未执行）；`admitted=1` 的 unknown
  **不可放弃**：可能已执行，必须核对。
- 已 `committed`/`failed`/`cancelled` 一律拒绝，绝不改状态。

**C. 共享命令端口（新文件 `src/main/agent-access/flow-command-bridge.ts`，仿 `flow-bridge.ts`）**

```ts
export interface FlowCommandAccessPort {
  isActive(projectId: string): boolean
  prepareExternal(raw: NodeExecuteCommand): FlowCommandPrepareResult
  /** 仅下发既有 grant（arm 超时 + webContents.send），等待/结算仍走既有账本。 */
  send(grant: FlowCommandGrant): void
  abandonExternal(input: CommandLookup): FlowCommandReceipt
}
```

由 `registerFlowCommandsIpc` 在 `connect?.(...)` 之后调用一次 `publishFlowCommandAccessPort({...})` 发布
（`flow-commands.ipc.ts` 仅 +2 行：import + publish）；未发布时外部操作如实
`FLOW_COMMANDS_UNAVAILABLE`，不降级成本地替身。端口不暴露任意 prepare、不暴露 ledger 本体。

**D. 外部操作（待迁移/端口落地后登记）**

- `flow.command.dispatch`（effect=`execute`，需要幂等键）：输入
  `{ projectId, agentNodeId, targetNodeId, contractVersion, inputs:[{targetPortId, assets:[ref]}], confirmPaidTarget? }`。
  执行顺序：
  1. 要求目标项目 = 当前活动画布且端口已发布（否则 `ACTIVE_PROJECT_REQUIRED` / `FLOW_COMMANDS_UNAVAILABLE`）；
  2. 目标类型属于付费能力（video/image-gen/image-edit/speech/tts）时必须 `confirmPaidTarget=true`，
     否则在 prepare 前 `PAID_TARGET_CONFIRM_REQUIRED`（与 node.execute 的付费重跑确认同一原则）；
  3. 经桌面握手 flush 未保存画布（同 `project.save` 的 flush 语义），从**已保存**项目计算
     `expectedSemanticRevision`；外部不能自造 revision；
  4. `commandId/taskId/traceId/spanId` 全部由 main 生成（外部不能伪造运行身份）；
  5. `port.prepareExternal(command)`（账本照常校验 Agent 范围、端口契约、审核门禁、输入资产）；
  6. `port.send(grant)` 交给既有渲染器通道；渲染器照常 `check`（准入）→ 执行 → 保存 → `commit`；
  7. 返回 `{ projectId, commandId, taskId, runId, targetNodeId, state:'pending', receipt }`；
     后续状态由 `flow.command.lookup` / `flow.command.check` 读取、由 `flow.command.reconcile` 结算。
  8. 下发瞬间失联 → 返回 unknown（不重发；账本 arm 定时器会把 pending 标成 unknown，外部用核对确认）。
- `flow.command.abort`（write，需要幂等键）：输入 `{projectId, commandId}`；调用 `port.abandonExternal`。
  只允许**外部命令、未准入（admitted=0）、pending 或 unknown**；重复放弃幂等返回原回执；
  已准入 / 非外部 / 已终态分别返回 `FLOW_COMMAND_ALREADY_ADMITTED` / `FLOW_COMMAND_NOT_EXTERNAL` /
  `FLOW_COMMAND_NOT_PENDING`。放弃后释放该节点的账本占用，外部可用 `availability` 复核。
- `flow.command.prepare` **不单独登记**：外部"只准备不交付"会留下无法执行的占用；其等价能力是
  dispatch 的第一步（`prepareExternal`）。动作清单把 `ipc.flowCommands.prepare` 与
  `ipc.flowCommands.dispatch` 都映射到 `flow.command.dispatch`，并在 note 里写明。

**E. 需要 Lead 的动作（按序）**

1. 加 9.3-A 迁移并 bump `DB_SCHEMA_VERSION`；
2. 授权我在 `command-ledger.ts` 增加 `principal`/`prepare(raw, principal)`/`abandonExternal`
   （3 处小改），并允许新建 `flow-command-bridge.ts` + `flow-commands.ipc.ts` 发布端口（+2 行）；
3. 之后我实现 dispatch/abort 的 ops、测试（服务级 + 假渲染器：publish 端口后由测试模拟
   check→保存→commit）、action-coverage 与日志条目，并把真实桌面段留给里程碑脚本。

**F. 边界与风险（如实登记）**

- 外部 dispatch 依赖活动画布 + flush 握手；用户可能随时编辑，flush 后到 grant 之间的编辑会让
  渲染器 revision 校验失败 → 命令 skipped/unknown，如实报告，不重发；
- 付费目标仅做确认闸门，**未做真实供应商验收**（无预算）；
- 外部不能取消已派发命令（cancel 通道仍 excluded）；只能在准入前 abort，准入后等待/核对；
- 真实 Electron 桌面端到端（外部 dispatch → GUI 执行 → 外部 check/reconcile 读回）需在迁移与端口
  落地后补里程碑段，本设计不宣称已验收。

---

## 10. F8 收官第三轮实现（dispatch / abort 落地）

Lead 已合入 M24 迁移并授权账本/端口/IPC 改动，本轮按第 9 节设计完成实现。

### 10.1 迁移与账本

- `db-migrations.ts` M24（Lead 提交）：
  `ALTER TABLE flow_commands ADD COLUMN principal TEXT NOT NULL DEFAULT 'internal' CHECK (principal IN ('internal','external'));`
  `DB_SCHEMA_VERSION` 23 → 24；既有行与既有内部调用全部默认 `internal`。
- `command-ledger.ts`（3 处小改，其余 828 行逻辑未动）：
  1. `Row` 增加 `principal: 'internal' | 'external'`；
  2. `prepare(raw, principal = 'internal')`：INSERT 写入 `principal`；既有调用方不传参，行为完全不变；
     已有命令重放时若 `principal` 不一致按 `FLOW_COMMAND_CONFLICT` 拒绝（防止复用内部 commandId）；
  3. 新增 `abandonExternal(raw)`：仅 `principal='external'`、`admitted=0`、`state ∈ {pending, unknown}`
     可放弃；已终态 → `FLOW_COMMAND_NOT_PENDING`；`admitted=1` → `FLOW_COMMAND_ALREADY_ADMITTED`
     （可能已执行，只能 reconcile 核对）；重复放弃幂等返回原回执。**不提供放弃内部命令的能力。**

### 10.2 共享权威端口

- 新建 `src/main/agent-access/flow-command-bridge.ts`：`FlowCommandAccessPort`
  `{ isActive, prepareExternal, send, abandonExternal }` + `publish/get/reset`。
- `flow-commands.ipc.ts` 在账本与 `connect?.()` 都就绪后发布端口：
  - `prepareExternal` = `ledger.prepare(raw, 'external')`（**同一个** `FlowCommandLedger` 实例）；
  - `send` = 先判 active/window → `arm(grant)`（60s 超时转 unknown）→ `webContents.send(grant)`，
    与既有 IPC dispatch 完全同一条交付通道；
  - `abandonExternal` = `ledger.abandonExternal`。
- 未发布（非桌面启动阶段）时 dispatch/abort 如实 `FLOW_COMMANDS_UNAVAILABLE`，不降级成本地替身。

### 10.3 外部操作

`flow.command.dispatch`（effect=`execute`，幂等键）：

1. 校验端口/桌面/活动画布（`FLOW_COMMANDS_UNAVAILABLE` / `DESKTOP_UNAVAILABLE` / `ACTIVE_PROJECT_REQUIRED`）；
2. 经既有 `flush` 握手取渲染器当前已保存版本，并与 `openProject` 版本核对（不一致 `REVISION_CONFLICT`）；
3. 目标节点/Agent 节点存在性检查；付费族（video/image-gen/image-edit/speech/tts/**voice-design**）
   未 `confirmPaidTarget=true` 时在 prepare 前 `PAID_TARGET_CONFIRM_REQUIRED`；
4. `commandId`/`taskId`/`traceId`/`spanId` 由 main 生成；`expectedSemanticRevision` 从**已保存项目**计算；
   输入经 `NodeExecuteCommandSchema` 全量校验（非法 `INVALID_INPUT`）；
5. `port.prepareExternal` 由账本照常校验 Agent 范围/端口契约/审核门禁/固定资产；`principal='external'`；
6. `port.send` 经既有 grant 通道交给渲染器；渲染器照常 `check`（准入）→ 执行 → 保存 → `commit`；
7. 受理响应 `{ projectId, commandId, taskId, runId, targetNodeId, graphVersion, accepted:true, state:'pending' }`
   ——**只表示已持久受理并交给渲染器，不表示执行完成、也不含 outputRefs**；最终状态由
   `lookup`/`check` 读取、由 `reconcile` 结算；
8. 下发前确定失败（活动画布切换/窗口不可用）→ 放弃这条未准入的外部命令释放占用 + `failed`；
   下发结果不确定 → 抛 unknown（保留 pending，由 arm 定时器/外部核对转 unknown，绝不宣告成功）。

`flow.command.abort`（effect=`write`，幂等键）：`port.abandonExternal`；成功返回 `state=skipped`、
`code=FLOW_EXTERNAL_ABANDONED` 的账本回执；未知命令/跨项目 → `NOT_FOUND`；其余判定见 10.1。

三入口：GUI 内部命令桥（同一 grant/准入/结算链路）↔ CLI `flow.command.dispatch` / `flow.command.abort`
↔ MCP `flow_command_dispatch` / `flow_command_abort`。`ipc.flowCommands.prepare` 与
`ipc.flowCommands.dispatch` 都映射到 `flow.command.dispatch`（外部不允许"只准备不交付"）。

### 10.4 测试覆盖（服务级，假渲染器，不触达供应商）

`test/local-agent-flow-commands-access.test.ts` 共 12 项（既有 7 项断言未删改，新增 5 项）：

1. 共享端口派发受理：受理回执字段、main 生成 UUID 身份、账本 `principal='external'` 且
   `owner_session` 等于发布账本会话、`admitted=0`、`sent=1`；受理阶段不产生输出版本；
   `check` 在渲染器提交前 `wouldSettle=false`；假渲染器 `check→保存→commit` 后才出现正式输出。
2. 拒绝面：非活动画布、付费未确认（prepare 前拒绝、零命令零下发）、确认后账本契约拒绝、
   端口未发布（dispatch 与 abort 均 `FLOW_COMMANDS_UNAVAILABLE`）。
3. 幂等：同键重放返回原回执、只一条命令/一次 grant；同键异参 `IDEMPOTENCY_CONFLICT`；
   新键在在途命令存在时按项目占用 `RESOURCE_BUSY`（不并发出第二条）。
4. abort 矩阵：pending+admitted=0 可放弃并释放占用、重复放弃幂等、放弃后 reconcile 不再结算、
   迟到 check 不能复活；admitted=1 拒绝；committed 拒绝且账本行完全不变；
   unknown+admitted=0 可放弃；unknown+admitted=1 拒绝；内部命令 `FLOW_COMMAND_NOT_EXTERNAL`；
   未知命令/跨项目 `NOT_FOUND`。
5. 下发失败语义：确定未下发（活动画布/窗口判空失败）→ 放弃命令、无 pending 占用、按 failed 报告；
   下发结果不确定 → `unknown` 且保留 pending（不宣告成功、不重发）。
6. 另有账本/桌面回归：`agent-flow-command-ledger` / `agent-flow-command-ipc` / `db-migrations`
   共 115 项全过（默认 `internal` 行为与既有状态机不受影响）。

### 10.5 真实边界（如实登记）

- **renderer `flush` 语义**：`CanvasEditor` 的桌面请求处理没有 `flush` 强制保存分支，未匹配的
  action 只回当前已保存 `graphVersion`。因此外部 dispatch 在"画布有未保存编辑"时：main 用已保存图
  计算 revision，渲染器 grant 的 revision 校验会失败并如实 `skipped`（`FLOW_NOT_STARTED`）或
  unknown，**不会执行错误版本**。要让在编辑中的画布也稳定受理，需要一次独立的 renderer
  flush 修正（固定资产 `flowAsset.submit` 共用同一问题，属跨入口保存协议），未在本包擅自修改。
- **未做真实 Electron 桌面端到端**：需要真实活动画布 + 真实 grant 通道；本包是服务级 + 假渲染器证据，
  不写 desktop-tested。
- **付费族只验证闸门**：未确认时零命令零下发；确认后的真实生成未实测（用户明确要求不做真实调用）。
- **外部不能取消已派发命令**：`cancel` 通道仍 excluded；只能在准入前 abort，准入后只能等待/核对。
- **unknown+admitted=1 不可放弃**：可能已执行，必须 reconcile；若长期没有已保存事实，占用会保留
  （与内部账本同一语义，需真实运行/人工核对收尾）。
- **项目级串行**：dispatch 是写操作，同一项目存在在途命令时新派发按既有占用策略 `RESOURCE_BUSY`
  （不并发下发）；不需要并发的调用方应先 settle 或 abort。

