# F8（二）交付：Flow 命令账本协作外部接入（flowCommands 12 项）

日期：2026-11-08。范围：GUI「Agent Flow 命令」账本协作 IPC 族（`flow-commands:*`，12 项）的外部开放。
基线：77 项外部操作、116 项接入测试、真实桌面里程碑 28 项全绿。
结论：**3 项外部操作、覆盖 4 个 IPC 通信动作；其余 8 项按"不伪造内部身份"原则不开放，逐项原因见第 3 节。**
本包不新增数据库迁移、不新增桌面握手动作、不新写执行器；全部落在既有 `flow_commands` 账本与授权规则上。

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

---

## 2. 已开放操作与三入口状态

| 业务动作 | GUI 入口 | CLI | MCP | 公共实现 |
| --- | --- | --- | --- | --- |
| 查询命令回执（lookup） | 运行详情/恢复核对（`lookupFlowCommand`） | `flow.command.lookup` | `flow_command_lookup` | `FlowCommandLedger.lookup`（同一账本类） |
| 核对节点可执行性（availability） | 手动运行前占用/审核门禁（`checkFlowNodeAvailability`，`executor.ts`） | `flow.command.availability` | `flow_command_availability` | `FlowCommandLedger.assertNodeAvailable` |
| 按已保存事实结算既有命令（commit/unknown 核对） | 执行桥收尾 `commitFlowCommand`；重启核对 `reconcileFlowNodeCommand` | `flow.command.reconcile` | `flow_command_reconcile` | `FlowCommandLedger.commit` |

CLI/MCP 由同一 `ACCESS_OPERATIONS` 自动生成，无第二份实现。

动作清单 `docs/local-agent-access/action-coverage.json` 中本族 12 个键的更新结果：
**external 4 个**（`lookup`/`availability`/`commit`/`unknown`，其中后两者映射到同一 `flow.command.reconcile`）、
**excluded 4 个**（`attach`/`detach`/`grant`/`cancel`，内部桥事件，附逐项理由）、
**仍为 F8 4 个**（`prepare`/`dispatch`/`check`/`abort`，待外部租约协议）。因此 F8 剩余分母从 25 减为 17
（本族 4 + 另一同事的 flowAgents 10 + flowAssets 3；后者未在本包改动）。

---

## 3. 未开放项与原因（8 项）

| IPC | 级别 | 原因 | 后续方案 |
| --- | --- | --- | --- |
| `attach` / `detach` | excluded | 渲染器命令桥与活动画布的内部绑定通道，不是独立用户业务动作；外部操作一律显式携带 projectId，不存在"外部画布"需要附着 | 若将来需要外部长期会话，先在项目中定义显式外部宿主，再评估绑定语义 |
| `grant` | excluded | 主进程→渲染器的单向授权下发事件，不是可调用动作；外部通过 `lookup`/`reconcile` 读同一账本事实 | 无需开放；事件本身不产生业务动作 |
| `cancel` | excluded | 主进程→渲染器的单向取消通知，真实取消由渲染器执行桥完成；外部取消语义已由 `run.cancel`（外部 run）与内部 Agent stop 承担，不原样转发内部 IPC | 外部若需取消内部命令，应先有可区分的外部租约（见下） |
| `prepare` | F8（未开放） | 会在账本创建 pending 命令/租约/占用，但外部没有权威渲染器通道执行它，会制造无法结算的占用 | 需要"外部主体 + 外部租约 + 外部授权下发"独立协议 |
| `dispatch` | F8（未开放） | 同上；且 dispatch 必须由权威宿主执行，外部另建通道等于新增外部专用执行器 | 与 F9/F10 的多宿主/外部委托协议一起设计 |
| `check` | F8（未开放） | 需要内部 `leaseId`，且要求 `owner_session` 匹配；外部无租约 | 外部租约落地后可开放为外部准入 |
| `abort` | F8（未开放） | 需要内部 `leaseId` 且 `admitted=0`；允许外部放弃会改写内部命令事实 | 仅随外部租约开放 |
| `unknown`（标记） | F8（未开放） | 把 pending 降级为 unknown 需要租约；外部只做 `reconcile`（只按事实推进，不主动降级） | 外部租约落地后评估 |

关键边界：**外部没有创建/授权/取消/放弃 Flow 命令的写口**。这是本包"不伪造内部身份"的实现方式，
不是遗漏；`prepare`/`dispatch` 若强行开放，要么需要伪造内部 `owner_session` 与渲染器 grant 通道，
要么产生永远无法结算的 pending 占用，两者都违反硬约束。

---

## 4. 公共实现与兼容

- Registry：`src/shared/agent-access/ops/flow-commands.ts` 新增
  `flow.command.lookup`（read）、`flow.command.availability`（read）、`flow.command.reconcile`（write），
  输出 Schema 同文件登记；`registry.ts` 仅做既有的 `...FLOW_COMMANDS_OPERATIONS` 组装（F8 基线已就位）。
- 业务实现：`src/main/agent-access/flow-commands-ops.ts`（新建），直接构造同一 `FlowCommandLedger`
  类调用其 `lookup` / `assertNodeAvailable` / `commit`；不直写 SQLite、不复制账本规则、不新增桌面通道。
- `service.ts` 最小追加：import、dispatch 中一个 `flow.command.*` 分组分支、把 `flow.command.reconcile`
  加进与 `run.cancel` 同类的占用检查豁免（否则结算目标本身就会被 `TASK_OCCUPANCY` 挡住）、
  以及 switch 里 3 个不可达的 `UNSUPPORTED_OPERATION` 守卫（TypeScript 穷尽检查要求，与既有
  `graph.patch`/`node.execute`/`run.cancel` 写法一致）。未改动其他分支与并发锁实现。
- 兼容：既有 77 项操作、输出 Schema 与错误码不变；本包只新增 3 个操作键，属于增量。
  契约快照 `generated/contracts.json` 与动作清单由 Lead 统一刷新（本包不执行 `--write`）。
  无数据库迁移（`DB_SCHEMA_VERSION` 不变），无新表/新列。
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

---

## 6. 日志覆盖与脱敏

- 外部操作生命周期沿用 dispatch 的 `agent.access.started/completed/failed/unknown/rejected`
  （唯一外部终态拥有者）；本包新增的账本操作另外复用既有 `command.operation.started/completed/failed`
  事件记录账本阶段（与 `flow-commands.ipc` 同一事件族与 `phase` 值：`lookup` / `manual-occupancy` /
  `saved-receipt`），携带 `commandId`、`state`、`versionId` 与 trace/span，不新增事件类型。
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

1. **外部主体与租约协议**（F9/F10）：在 `flow_commands` 增加显式 principal/外部会话标记（需 DB 迁移与
   Lead 排号），并为外部租约提供受控 grant 下发/check/abort/unknown 通道；通过后才能开放
   `prepare`/`dispatch`/`check`/`abort`/`unknown(标记)`/`cancel`。
2. **多宿主并发**（F8 三，Lead）：按项目锁 + 多画布宿主，使两张画布可同时运行。
3. 契约快照/动作清单统一刷新与真实桌面重跑由 Lead 在批次收口时执行。
