# HANDOFF 2026-11-22：规范体系审查 → 两份新权威规范 → P0 修复

> 接手前先读这一份，再按「读取顺序」去读其他文档。本文只写**当前状态与接下来怎么做**；具体原因和证据见所引用的文档。
> 基线：`origin/main = 28d02e81`（2026-11-22 13:40 已推送）。工作区里还有**一批未提交的改动**（见 §2.2）。

---

## 0. 一句话

今天做了四件事：一次全面的规范审查；找回了被 `reset` 丢掉的 11-20 修复；起草了两份新的权威规范（节点流、Agent Flow）；按 BACKLOG 完成了 P0 修复。**P0 已完成 7/8 项（BL-00、02、05~08 已推送；BL-01、03、04 代码已写完但还没过门禁）**。接手后的第一件事：跑门禁 → 修到全绿 → 提交推送；然后做 P1，从 **BL-10「节点流即能力」** 开始。

---

## 1. 读取顺序

| # | 文档 | 用途 |
|---|---|---|
| 1 | `AGENTS.md` | 工程铁律（日志是交付的一部分、GUI/CLI/MCP 一致、节点强制协议） |
| 2 | `docs/BACKLOG.md` | **唯一待办来源**。每项有编号、范围、代码位置、验收标准；做完要勾选并写上 commit hash |
| 3 | `docs/AGENT_FLOW_SPEC.md`（v0.2） | Agent Flow 权威规范（上帝 Agent / 主 Agent / 图模式 / 三种节点形态 / 最小输入 / 角色化单用户） |
| 4 | `docs/NODE_FLOW_SPEC.md`（v0.1） | 节点流（composite）权威规范 |
| 5 | `docs/SPEC_DEEP_REVIEW_2026_11_22.md` | 审查报告：问题编号 A*/G*/N*/F*/U* 的来源和证据 |
| 6 | `NODE_CONTRACT_SPEC.md`、`AGENT_ACCESS_SPEC.md`、`AGENT_PARITY_SPEC.md`、`LOGGING_SPEC.md` | 原有规范，继续有效 |

两份新规范的写法：每一条都带稳定编号（`AF-x.y` / `NF-x.y` / `V*`），并标明是**【现行】**（代码已强制执行）还是**【目标】**（尚未实现）。**把一条从【目标】改成【现行】，必须和实现、测试放在同一个提交里。**文末附录列出差距清单。

---

## 2. 当前状态

### 2.1 已推送（origin/main）

| 提交 | 内容 |
|---|---|
| `7e36dd8` `ccd5057` `5cb530c` `32411ef` `b09dacc` | **BL-00**：恢复 11-20 被 `reset: moving to origin/main` 丢掉的 5 个提交（P0 规范修订、MCP 注解如实化、节点流计费确认门、task-bind 白名单、两份门禁测试）。也包含 **BL-02** |
| `39610ae` | 恢复后重新生成契约快照 |
| `c293701` | 新增 NODE_FLOW_SPEC / AGENT_FLOW_SPEC / BACKLOG / 审查报告 |
| `28d02e81` | **BL-05**（删除 FlowGraph control 边；校验即准入：`FLOW_GRAPH_DISPATCHABLE_KINDS` / `FLOW_GRAPH_CAPABILITY_IDS` 是唯一来源）、**BL-06**（completed 即交付）、**BL-07**（多节点环/自回边报 `LOOP_BODY_UNSUPPORTED`）、**BL-08**（`composite/budget.ts` 是节点流预算的唯一来源） |

安全分支 `backup/main-before-restore-20261122` 和 `backup/main-before-sync-20261120-200237` 先保留，确认没问题后再删。

### 2.2 ⚠️ 未提交：BL-01 / BL-03 / BL-04（代码和测试已写完，**一次都没有编译或跑过测试**）

写代码时所在的环境没有 npm/git，所以下面这些改动没有经过类型检查、lint 和测试。**接手第一步就是跑门禁。**

改动文件（共 19 个）：

```
src/shared/agent-flow/flow-graph.ts            BL-04 otherwise 边、conditionsExclusive、CONDITION_NOT_EXCLUSIVE / OTHERWISE_INVALID
src/shared/agent-flow/flow-graph-router.ts     BL-03 整个文件重写：边三态 + 跳过的不动点传播 + 新 all 语义 + ambiguous
src/shared/agent-flow/flow-graph-compiler.ts   BL-03 修复：重映射边条件、decisions.when、inputs.selectors 里的节点引用
src/shared/agent-flow/failure-messages.ts      FLOW_STALLED / FLOW_BRANCH_AMBIGUOUS 的用户文案
src/main/agent-flow/coordinator-host.ts        graphStep：停滞判定 → FLOW_STALLED；ambiguous → FLOW_BRANCH_AMBIGUOUS；两个新事件
src/main/agent-access/human-decision.ts        BL-01 新文件：requestHumanDecision（desktop.ask + confirm-sensitive）
src/main/agent-access/flow-agents-ops.ts       BL-01：flowGraph.confirm、flowAgent.cooperate（submit / accepted=true）接入确认
src/main/agent-access/flow-agent-build-ops.ts  BL-01：flowAgent.build.commit 接入确认
src/main/agent-access/service.ts               BL-01：humanTask.submit 接入确认（executeHumanTaskSubmit）
src/shared/agent-access/ops/flow-agents.ts     4 个操作的 description 补充确认说明（会触发契约快照更新）
test/flow-graph-router.test.ts                 +8 例（死路径、汇合、出口被跳过、待定不提前判死、otherwise、歧义）
test/flow-graph-validation.test.ts             +4 例（互斥判定、human-decision 必须用 otherwise、otherwise 非法用法）
test/flow-graph-compiler.test.ts               +1 例（条件 / selectors 重映射）
test/agent-flow-coordinator.test.ts            +1 例（条件永不成立 → FLOW_STALLED，run=blocked）
test/local-agent-flow-agent-build-access.test.ts  原有 4 例的 ask 桩改为允许；+2 例（拒绝 / 超时）
test/local-agent-flow-cooperate-access.test.ts    beforeEach 注入 desktop 桩；+4 例
docs/AGENT_FLOW_SPEC.md  docs/BACKLOG.md  docs/LOGGING_COVERAGE.md
```

**运行门禁（会自动提交并推送）：**

```powershell
powershell -ExecutionPolicy Bypass -File "D:\Program Files (x86)\canvas-studio\gate-p0-batch2-20261122.ps1" -Push
```

脚本做的事情：重新生成契约快照（`check-agent-access.cjs --write --accept-contract-change --reason ...`）→ typecheck:node/web → 对改动文件跑 eslint → 15 个相关测试文件 → test:contract → guard:agent-parity → verify:logging。**全部通过才提交**，提交信息用 `gate-p0-batch2-commit-msg.txt`。日志写到 `gate-p0-batch2-20261122.log`。如果你能直接执行命令，也可以不用脚本，按同样的顺序手动跑。

**最可能需要修的地方（写代码时已经预判到）：**
1. `flow-graph-compiler.ts` 里的 `remapCondition<T>` 是泛型展开，TS 可能报类型不可赋值。改成按 `StageCondition` 判别联合写出具体分支即可。
2. `test/local-agent-flow-agents-access.test.ts` 第 750 行以后有调用 cooperate 的用例，如果它们带 `accepted:true` 或 `action:'submit'`，又没有注入 desktop 桩，会得到 `DESKTOP_UNAVAILABLE`。修法：给 `LocalAccessService` 加上 `desktop: { run, ask: async () => ({ authorized: true }) }`。
3. 其他依赖旧路由语义的测试：以前断言 `blocked` 里有某个节点、现在它会进入 `skipped`；或者断言「全部出口被跳过也算完成」。**改测试，不要改回语义**（新语义见 AGENT_FLOW_SPEC AF-8.3a/b、AF-8.5a/b）。
4. `test/local-agent-parity.test.ts` 会检查操作描述；description 上限是 2000 字，目前没有超。
5. 门禁全绿以后，打开 BACKLOG 把 BL-01/03/04 的状态从「未过门禁、未提交」改成提交 hash。

---

## 3. 已经拍板的设计决策（不要重新讨论）

| 决策 | 内容 | 规范位置 |
|---|---|---|
| 多人协作模型 | **角色化单用户**：始终只有一个本机用户，「多人」= 同一个人扮演多个角色；不做登录、多身份、跨设备、联网 | AGENT_FLOW_SPEC §16 |
| control 边 | **删除**。FlowGraph 只保留数据边；控制关系（controls/observes/review-gate/rework）由编译器写进节点 config.relations | AF-4.3a |
| 分层 | 基础节点（单一职责）→ 节点流（确定性数据 DAG，没有条件也没有 LLM 路由）→ Agent Flow（控制流图，由声明式路由器推进，模型只在节点内部做决策） | NF-1.2 / AF §2 |
| 执行模式 | `graph` 是标准模式；`fixed-order` 是它的线性特例；`model`（主控 LLM 自由调度）只作为探索模式 | AF §2.2 |
| 人工决定 | 外部 Agent 永远不能代替人做决定。当前实现是**实时弹窗确认**；持久草稿队列以后再做 | AF-1.5 / AF-17.2 |
| 循环 | v1 只支持单节点 `node.loop`，不画回边；多节点循环体等 FlowGraph v2（BL-11） | AF-8.4b |
| 节点流预算 | 8 层 / 200 节点 / 1500 连线，唯一来源是 `src/shared/composite/budget.ts` | NF-10.2 |
| 返工上限 | 统一为 0–3，缺省 3（**尚未实现**，见 BL-19） | AF-13.4 |
| `135cbef8` | 误提交（只有一个临时脚本 `test/tmp-matrix-dump.test.ts`），已撤回，**不要恢复** | — |

## 4. 还没拍板（先问用户，不要自己决定）

1. `flowStateMachine.submitEvent` 和 `composite.run.submitHuman` 要不要也走人工确认（BL-01 备注）。后者还被没有桌面的 headless 场景使用。
2. BL-18：状态机用「阶段 FSM」还是「带并行区域的 statechart」（建议阶段 FSM）。
3. BL-20：人工媒体交付用哪种方式，(a) human-task 扩展结果类型，还是 (b) 资产节点模板（建议 a）。
4. NF-5.3：节点流 headless 输出的键要不要统一带 `out-` 前缀（建议带）。

---

## 5. 接下来做什么（按顺序）

> 每一项的完整范围和验收标准都在 BACKLOG 里，这里只写入口和要注意的地方。

### 5.1 收尾 P0
- **跑 §2.2 的门禁**，修到全绿，推送。
- **8 个真机验收脚本**现在会停在确认框上（它们从外部调用了 4 个人工决定操作）。需要加一步「在确认框点允许」。可以参考 `scripts/acceptance/*` 里已有的 Playwright 点击写法，或者参考 `publish-authorize` 相关脚本是怎么处理确认框的。清单在 BACKLOG BL-01。

### 5.2 P1 主线：打通节点流和 Agent Flow（影响最大）
1. **BL-10 节点流即能力**：节点流发布后自动登记为 `capabilityRef {kind:'composite', id, version}`；可编排能力目录从注册表和发布仓库**自动生成**，替换掉写死的 `FLOW_GRAPH_CAPABILITY_IDS` 和 `CAPABILITY_COMPILE`（`src/shared/agent-flow/flow-graph.ts`、`flow-graph-compiler.ts`）。规范见 NF-13.*、AF §4.4。
2. **BL-11 FlowGraph v2**：节点增加 `params`（按目标节点 config schema 校验）；数据边使用真实端口，**取消** `flow-graph-compiler.ts` 里的端口重映射（目前所有入边都被映射到同一个 `inputPort`）；端口类型校验（BL-05 剩下的部分）；子图循环 `loop.body[]`，做完后撤销 BL-07 的拒绝规则。
   - 难点：`portPairCompatible` 现在在 `src/renderer/src/canvas/graph.ts`，main 侧拿不到。要先把纯判定函数下沉到 `src/shared/`，renderer 再重新导出（`connection-matrix.test.ts` 的 129 项真值表必须保持全绿）。
3. **BL-12/13/14 节点流规范落地**：内部连线统一使用 `portPairCompatible`，并补上 `iteration/camera` 类型；JSON Schema 兼容校验；媒体固定输入按 mime 类型匹配；必填输入在运行前预检；区分缺席的三种状态。

### 5.3 P1 其余
BL-15 角色化单用户 → BL-16 统一状态全集表与人机协作 UI（依赖 BL-03、BL-15）→ BL-17 FlowGraph 与画布不一致时标记 `diverged` → BL-18/19/20/21 → BL-22 修订 NODE_CONTRACT_SPEC → BL-23/24 组合测试遗留。

### 5.4 建议节奏
第 1 周收尾 P0；第 2–3 周做 BL-10/12/13/14；第 4 周做 BL-11/15/16。

---

## 6. 关键代码地图

| 关注点 | 位置 |
|---|---|
| FlowGraph IR + 静态校验 | `src/shared/agent-flow/flow-graph.ts`（`FlowGraphSchema`、`validateFlowGraph`、`conditionsExclusive`、两份白名单常量） |
| 图路由（纯函数） | `src/shared/agent-flow/flow-graph-router.ts`（`flowRouteState`、`nextReadyNodes`、`isFlowComplete`、`deliveredGraphNodes`） |
| 编译 FlowGraph → 画布 | `src/shared/agent-flow/flow-graph-compiler.ts`（`CAPABILITY_COMPILE`、`toCanvasGraph`、`deriveStateMachine`） |
| 图模式执行宿主 | `src/main/agent-flow/coordinator-host.ts` 中的 `graphStep` / `dispatchCapability` / `dispatchHumanTask` / `graphFacts`；运行准入在 `bind()` 的 `if (graphMode)` 分支 |
| 条件、最小输入、交付记录 | `src/shared/agent-flow/stage-contracts.ts`、`context-manifest.ts` |
| 节点配置契约 | `src/shared/agent-flow/node-contracts.ts`（Agent/Review/StateMachine/HumanTask） |
| 外部操作定义 | `src/shared/agent-access/ops/*.ts`（flow-agents、composite 等）；机器真值：`docs/local-agent-access/generated/contracts.json` |
| 外部操作实现 | `src/main/agent-access/service.ts`（总调度）、`flow-agents-ops.ts`、`flow-agent-build-ops.ts`、`human-decision.ts` |
| 桌面交互通道 | `src/main/agent-access/desktop.ts`（`run` 占写入槽；`ask` 用于交互确认，不占写入槽）；renderer 侧在 `src/renderer/src/canvas/CanvasEditor.tsx` 的 `onLocalAgentDesktopRequest`（`confirm-sensitive`、`flow-graph`、`flow-build`） |
| 节点流 | `src/shared/composite/`（manifest、validate、runtime、boundary、upgrade、outputs、budget） |
| 端口兼容真值 | `src/renderer/src/canvas/graph.ts` 的 `portPairCompatible`；`test/connection-matrix.test.ts` |
| 用户可见失败文案 | `src/shared/agent-flow/failure-messages.ts` |

---

## 7. 门禁与流程纪律

- 每次提交前：`npm run typecheck`、eslint、相关测试、`npm run test:contract`、`npm run guard:agent-parity`、`npm run verify:logging`。大改动再加一次全量 `npm run verify`（**今天一次都还没跑过全量，建议本周跑一次**）。
- **契约快照**：改了 `src/shared/agent-access/ops/*` 的输入 Schema 或描述，`verify:agent-access` 就会失败。用 `node scripts/check-agent-access.cjs --write --accept-contract-change --reason '<≥12 字的说明>'` 重新生成，并把 `contracts.json` 和 `change-impact.json` 一起提交。**不要只刷新 hash 就放行**，要先确认行为真的变了。
- **parity 铁律**：用户能做的业务动作，必须在同一个提交里把 CLI/MCP 一起改完（AGENTS.md）。
- **日志**：涉及执行路径的改动，要更新 `docs/LOGGING_COVERAGE.md`；不能记录正文、提示词或密钥。
- **规范同步**：实现某条【目标】条款时，同一个提交里把规范改成【现行】，并勾选 BACKLOG。
- **防丢提交（今天的教训）**：当天必须推送。`reset` 或 `pull --rebase` 之前，先用 `git rev-list --count origin/main..HEAD` 确认没有未推送的提交。任何「已修复」的说法都要附上已在 origin/main 上的 hash。
- 根目录 `canvas-studio/` 不归 git 管理（里面有 exe、日志、仓外方案）。规范和方案一律放进 `source/docs/`。仓外的旧方案归档是 BL-32。
- 工作区里有几个与本批无关的未跟踪临时文件（`scripts/tmp-combo-*.cjs/mjs`、`scripts/tmp-probe-launch.cjs`、`scripts/audit-video-processor-temp.cjs`），**不要一起提交**。

---

## 8. 已知风险与没验证过的点

1. **BL-01/03/04 一次都没有编译或运行过**（§2.2）。
2. **兼容性**：本地库里已发布或已落画布的 FlowGraph，如果含 control 边、回边循环或不互斥的条件分支，现在会被拒绝，需要修改后重新发布。
3. 审查报告附录里还没核实的两项：含 `iterate/camera` 端口的节点流封装时怎么表现（并入 BL-12）；iteration 媒体还原时是否校验了 mediaId 的归属（并入 BL-36）。
4. 停滞判定很保守：只要还有未通过的审核或在途子任务，就仍然报 `human.wait`。审核拒绝且返工额度用完的情况，由审核控制环负责终止，这块没有单独补测试。
5. BL-37：MCP 的 `idempotentHint` 现在等于「只读」，这只是过渡做法，还没有逐个操作声明。
