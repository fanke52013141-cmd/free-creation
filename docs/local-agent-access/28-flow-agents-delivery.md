# F8（一）Flow 观察与固定资产外部接入（2026-11-08）

基线：`cf84a25`（接手时 main 顶部；Lead 已并发提交 `acbb07c`「F8（三）按项目锁并发 + flow 族登记位拆分」）。
目标与验收口径以 [AGENT_PARITY_SPEC.md](../../AGENT_PARITY_SPEC.md)、[15 号计划](15-gui-cli-mcp-parity-plan.md) 的 F8 段为准；
本文只记录**真实做了什么、证据是什么、还差什么**，不把"登记了操作"当成"已验收"。

## 一、一眼看懂的现状

| 指标 | 本包前 | 本包后（仅本族） |
| --- | --- | --- |
| 外部操作（CLI/MCP 同一 Registry 生成） | 77 | **+6**（flowAgents 3 + flowAssets 3） |
| flowAgents 族（10 项分母） | 0 开放 | **3 开放 / 7 未开放**（第 5 节逐项原因） |
| flowAssets 族（3 项分母） | 0 开放 | **3 开放 / 0 未开放** |
| 本族接入测试 | 0 | **15 项**（新文件 `test/local-agent-flow-agents-access.test.ts`） |
| 既有 37 项操作的 input/output Schema | — | **逐字节未变**（纯追加，未使用 `--accept-contract-change`） |
| 契约快照 / 动作清单 / 影响哈希 | — | **待 Lead 统一刷新**（按分工不运行 `--write`，见第 6 节） |

分母来源：GUI 侧 `IPC.flowAgents.*` 10 个通道 + `IPC.flowAssets.*` 3 个通道
（[action-coverage.json](action-coverage.json) 的 `ipc.flowAgents.*` / `ipc.flowAssets.*`）。
本包只负责这两族；`IPC.flowCommands.*`（12 项）由并发同事的 [29 号台账](29-flow-commands-delivery.md) 负责，
多画布按项目锁由 Lead 的 [31 号台账](31-multi-canvas-locks.md) 负责。

## 二、三入口状态表

说明：CLI 与 MCP 工具目录都由同一 `src/shared/agent-access/registry.ts` 生成，输入/输出 Schema 只有一份；
"契约已生成"指登记经 `capability.list` 与 `contracts.json` 生成链验证；"服务级通过"指
`LocalAccessService.dispatch` 真实调用路径的测试证据；**真实 CLI 进程与 MCP 客户端调用未在本包重跑**
（需要 `npm run build` 产物 + 授权激活的桌面进程，属 F10 发布验收范围，见第 8 节）。

| GUI 动作（面板） | 外部操作 | GUI | CLI | MCP | 证据 |
| --- | --- | --- | --- | --- | --- |
| Flow 查看（`inspectFlowAgent`） | `flowAgent.inspect` | 已有（`FlowAgentDesktopHost.inspect`） | 契约已生成；服务级通过 | 契约已生成；服务级通过 | 4 项测试（等待态/无任务/运行中只读/越权与非法参数） |
| Flow 能力目录（`flowAgentCatalog`） | `flowAgent.catalog` | 已有（`FlowAgentDesktopHost.catalog`） | 契约已生成；服务级通过 | 契约已生成；服务级通过 | 2 项测试（含"不泄漏技能指令/地址/配置"断言） |
| Flow 协作记录（`flowAgentCollaboration`） | `flowAgent.collaboration` | 已有（`FlowAgentDesktopHost.collaboration`） | 契约已生成；服务级通过 | 契约已生成；服务级通过 | 2 项测试（只读不改协作记录/无任务与非 Agent 节点拒绝） |
| 固定资产提交（`flow-assets:submit`） | `flowAsset.submit` | 已有（GUI 资产面板 + `ensureCanvasSaved`） | 契约已生成；服务级通过 | 契约已生成；服务级通过 | 4 项测试（正常/幂等重放与冲突/版本与目标拒绝/保存握手/占用） |
| 固定资产列表（`flow-assets:list`） | `flowAsset.list` | 已有 | 契约已生成；服务级通过 | 契约已生成；服务级通过 | 同文件列表断言（只回摘要，不回取值正文） |
| 固定资产读取（`flow-assets:read`） | `flowAsset.read` | 已有 | 契约已生成；服务级通过 | 契约已生成；服务级通过 | 同文件读取/跨项目拒绝/超限如实拒绝 |
| Flow 运行/暂停/停止/协作继续/审核/建图提交/发布 | —（**未登记**，见第 5 节） | 已有 | 未开放 | 未开放 | 测试断言这 7 个操作 ID **不在** Registry 与 `capability.list` 中 |

## 三、公共实现与兼容处理

### 3.1 一份业务实现

- **观察**：`src/main/agent-access/flow-agents-ops.ts` 直接复用 GUI 面板的同一个类
  `FlowAgentDesktopHost`（`src/main/agent-flow/desktop-host.ts`）的 `inspect` / `catalog` / `collaboration`，
  不新增执行器、不读 renderer 内存、不直写项目快照或 SQLite。
  该宿主实例按数据目录缓存一次，构造参数里的命令交付通道与模型端口被显式声明为**不可用**
  （`FLOW_DESKTOP_UNAVAILABLE` / `FLOW_MODEL_PORT_UNAVAILABLE`）：本族没有登记任何需要它们的方法，
  因此不存在"外部专用执行路径"。
- **固定资产**：`src/main/agent-access/flow-assets-ops.ts` 直接复用 `FlowAssetStore`
  （`src/main/agent-flow/asset-store.ts`）——GUI 资产面板、命令账本 precheck、审核宿主共用同一 store。
  外部只提供 `projectId / nodeId / portId / expectedGraphVersion`，**取值永远来自已保存画布**；
  提交身份 `submissionId = ext-<sha256(幂等键)[0:40]>`，崩溃重试命中同一回执。
- **活动画布**：项目正在桌面画布打开时，先走与 `graph.patch` 相同的受控桌面 `flush` 握手
  （语义等价 GUI 的 `ensureCanvasSaved`），再按落盘版本核对与提交；**没有**绕过保存屏障的路径。
- **占用与恢复副本**：`flowAsset.submit` 是写操作，沿用 dispatch 的按项目锁与
  `assertNoActiveTasks`（命令/任务/协调范围/恢复副本 → `RESOURCE_BUSY`），比 GUI 更严，不借固定资产
  提交绕过占用；`FlowAssetStore` 内部的 `ASSET_SOURCE_OCCUPIED` / 审核结论 / 端口类型校验保持原样。

### 3.2 共享文件只做最小追加

`src/main/agent-access/service.ts`（共享文件，并发同事同时在改）只追加三处，未重排/重格式化/删除任何既有分支：

1. 2 行 import（两个 ops 模块）；
2. dispatch 里 **1 个分组分支**：`FLOW_AGENT_OPERATION_IDS ∪ FLOW_ASSET_OPERATION_IDS` 时带
   trace/span/requestId/幂等键/desktop 委托到本模块，其余流程不变；
3. `execute()` 的 switch 里把 6 个新操作归到既有的 `UNSUPPORTED_OPERATION / dispatch` 分组
   ——这只是满足 TypeScript 穷尽性（否则 `unhandledOperation(operation)` 无法收窄为 `never`），
   与 F7 的处理方式相同，不改变任何既有行为。

### 3.3 Schema 与兼容结论

- 输入/输出全部是纯 `z.object(...).strict()`，**没有** `.refine() / .superRefine() / .transform()`；
  输入侧 `z.toJSONSchema` 可导出（`capability.list` 实测通过，见测试里对 `capability.list` 的断言）。
- 纯追加 6 个操作：`ACCESS_OPERATIONS` / `ACCESS_OUTPUTS` 既有条目未改一个字节，
  因此**不需要** `--accept-contract-change`，也不需要版本号迁移；CLI/MCP 帮助与工具目录由 Registry 自动扩展。
- 契约快照（`generated/contracts.json`）、业务动作清单（`generated/action-inventory.json`）、
  影响哈希（`change-impact.json`）按分工由 Lead 统一 `--write` 刷新。用临时目录重新生成的快照验证过：
  `Agent access gate passed: 86 operations; 32 planned nodes.`（86 = 77 既有 + 本包 6 + 并发 flowCommands 包 3）。

## 四、外部主体可区分性说明（为什么不伪造内部身份）

1. **只开放"读取事实"与"追加固定资产"**：本族没有任何动作能写成内部 Agent 的运行状态、决策、
   工具回执、审核结论或人工选择。`flowAgent.inspect` 只读 `flow_agent_tasks` 与协调记录；
   `flowAgent.collaboration` 只读协作事件；`flowAsset.submit` 只追加不可变版本行。
2. **运行中任务不判"会话丢失"**：GUI 的 `inspect` 在任务处于 running / 待启动且本宿主没有运行上下文时
   会把任务改成 `blocked + AGENT_SESSION_LOST`。外部进程内的第二个宿主**必然**没有该上下文，
   照搬会把自己看不到的运行判成已丢失——那是改写账本事实。因此外部 `inspect` 在这种状态下
   直接返回账本事实并标记 `ownership: "ledger-only"`，**不调用**会写账本的方法；测试断言读取前后
   `flow_agent_tasks.state/code` 完全不变。
3. **不代填人工门禁**：不开放 `cooperate`（note/submit/revise 会与人在画布内的输入不可区分，
   submit 更是人工选择本身）；不开放导演台以外的任何"人工确认"动作；`flowAgent.collaboration`
   只读，不能写入备注、选择或继续。
4. **外部提交可追溯**：固定资产 `submissionId` 由外部幂等键派生为 `ext-<sha256>`，账本里能区分
   "外部固定的版本"与内部任务/审核固定的版本；不覆盖、不改写既有版本（`flow_asset_versions` 只追加）。
5. **失败不装成功**：取值超限 → `ASSET_VALUE_TOO_LARGE`；未保存到期望版本 → `REVISION_CONFLICT`；
   项目/节点/端口不存在 → `ASSET_PROJECT_MISSING / ASSET_NODE_MISSING / ASSET_PORT_INVALID`；
   unknown 语义仍由既有幂等回执与 `run.get` 承担，本族不引入新的"未知当作成功"分支。

## 五、未开放项与原因（这 7 项**没有**登记，属正确交付）

| 项 | 为什么不能在不伪造身份的前提下开放 | 后续方案 |
| --- | --- | --- |
| `flowAgents.run` | 内部 Agent 运行由 `flow-agents.ipc` 里创建的**桌面宿主实例**独占：模型端口（含工具调用能力预检）、命令交付通道（renderer grant）与在途运行表都在该实例内存里。外部进程内另建实例会形成第二个权威，对同一任务可能出现两个运行者并改写账本。 | 由 `src/main/index.ts` 把该宿主句柄（或一个只暴露生命周期方法的端口）注入 `LocalAccessService`，本模块再登记运行/继续；需要 Lead 排期（跨包文件）。 |
| `flowAgents.pause` | 暂停只作用于主控 Agent 协调器的进行中运行上下文（`FlowCoordinatorHost` 内存态）；外部实例拿不到协调器端口，只能假装成功。 | 同上：随协调器句柄一起注入后开放；先补"外部暂停不改变内部人工等待语义"的验收。 |
| `flowAgents.stop` | 停止要中止宿主内存里的运行控制器并清理视频任务；外部实例只能把账本状态改成 cancelled 而运行仍在继续——属于伪造成功。 | 同上；并补"停止与迟到产物清理"的桌面段（既有 F5 边界）。 |
| `flowAgents.cooperate` | 协作事件（note/discuss/submit/revise）**没有外部主体身份维度**：外部写 note 会与人在画布内的备注不可区分，submit 是人工选择本身，revise 等同人发起的返工；discuss 还需要模型端口。 | 先给协作事件增加协作者身份/权限（契约演进），再开放"外部协作者"的讨论与提议；人工选择与返工仍由人完成。 |
| `flowAgents.review` | AI 审核宿主需要桌面执行宿主的模型端口与 `assertAgentScopeToolCalling` 能力预检（`flow-agents.ipc` 内构造）；外部重建会绕过工具调用能力门禁，且付费模型路径无实测证据（无预算）。 | 与 run 一起注入共享宿主后开放；验收需预算授权，按 F10 付费分组执行。 |
| `flowAgents.build`（提交/预览） | propose 需要模型端口；真正把预览落到画布是 renderer 权威动作（`flow-build-actions.ts`：撤销步 + 公共 `createEdge` 校验 + 保存屏障 + `confirm` 回执），外部没有等价桌面动作。 | 新增受控桌面动作（`shared/agent-access/desktop.ts` 的 `flow-build`）+ renderer 权威实现，再登记；属 F8 收尾包（跨包文件）。 |
| `flowAgents.publication` | 发布是协调器运行期向权威宿主发出的**等待/继续信号**（main→renderer 事件），依赖内部运行上下文；外部只能观察任务状态，不能代替宿主确认发布。 | 随协调器句柄注入后，按"外部申请 + 宿主/人确认"的协议单独设计（与导演台 `publish-authorize` 同构）。 |

补充：`flowAgents.inspect` 的观察范围**不含**主控 Agent 的阶段/子任务（`phase/children` 来自协调器内存端口），
外部只看到 specialist 任务与账本事实；这一点已写入操作描述，不用 `run.get` 的旧子集冒充完整观察。

## 六、真实验证证据（2026-11-08 本机真实运行）

```text
npm run typecheck            → node / web / license-protocol / issuer 全部通过（exit 0）
node scripts/audit-business-actions.cjs
  → 校验部分通过；输出：“Action inventory is stale; run audit-business-actions.cjs --write”
    （按分工未运行 --write：业务动作清单与契约快照由 Lead 统一生成；本包 6 项映射无
     UNKNOWN_EXTERNAL_OP / ORPHAN_EXTERNAL_OP / BAD_PHASE）
node scripts/run-vitest.cjs run test/local-agent-flow-agents-access.test.ts \
  test/local-agent-access.test.ts test/local-agent-graph-access.test.ts \
  test/local-agent-run-access.test.ts test/local-agent-media-access.test.ts \
  test/local-agent-chat-access.test.ts test/graph-patch-plan.test.ts --reporter=dot
  → Test Files 1 failed | 6 passed；Tests 1 failed | 87 passed
    唯一失败是既有用例 local-agent-access.test.ts >“blocks stale generated contracts…”：
    新登记操作使 docs/local-agent-access/generated/contracts.json 过期，脚本在快照检查处
    先抛出 “Generated contract is stale”。用临时目录重新生成快照后同一脚本输出
    “Agent access gate passed: 86 operations; 32 planned nodes.”，说明只差 Lead 统一刷新
    聚合产物（本包按分工不运行 --write）。
单跑新文件：node scripts/run-vitest.cjs run test/local-agent-flow-agents-access.test.ts --reporter=dot
  → Tests 15 passed (15)
```

15 项测试覆盖：正常路径（catalog/inspect/collaboration/资产提交→列表→读取）、非法参数
（`INVALID_INPUT`）、跨项目越权（`AGENT_NODE_MISSING` / `ASSET_VERSION_MISSING` /
`FLOW_PROJECT_INACTIVE`）、写操作幂等重放与同键异意图冲突（`IDEMPOTENCY_CONFLICT`）、
不存在目标拒绝（`NOT_FOUND` / `ASSET_NODE_MISSING` / `AGENT_TASK_MISSING`）、
活动画布保存握手（捕获到 `action: "flush"`）、占用期写入拒绝（`RESOURCE_BUSY`）、
读取超限如实拒绝（`ASSET_VALUE_TOO_LARGE`），以及"外部没有改写内部事实"
（运行中任务状态不变、协作记录条数不变、画布 `graphVersion`/节点字节不变、
未开放的 7 个操作不在 Registry 与 `capability.list` 中）。

**未做的验证（不得宣称）**：真实 Electron 桌面段未跑（本包只有服务级 dispatch 证据）；
CLI 进程与真实 MCP 客户端调用未跑（需 `npm run build` + 授权激活，属 F10）；
付费模型路径、真实供应商请求均为 0 次。

## 七、日志覆盖与脱敏

已追加到 [LOGGING_COVERAGE.md](../LOGGING_COVERAGE.md) 的「2026-11-08 F8（一）」小节，要点：

- 复用 dispatch 现有 `agent.access.started / completed / failed / unknown / rejected` 生命周期，
  `attributes.operation` 为操作 ID、`phase` 沿用既有稳定值、`code` 为稳定回执码；**未新增事件类型**。
- 读取型操作只有 started → completed 两条终态；`FlowSkillStore` 自己的 `skill.library.*` 事件保持原样，
  不重复记同一终态。
- 不记录：任务目标正文、协作消息正文、模型回复、固定资产取值、项目文件路径、绝对媒体路径、配置正文。
- 测试断言：事件序列恰为 `agent.access.started` → `agent.access.completed`，且事件序列化串不含
  交付正文、私有配置与临时数据目录。

## 八、未覆盖边界与下一包

1. **共享宿主注入**（本包最大缺口）：`run / pause / stop / review / cooperate / publication` 需要
   `flow-agents.ipc` 创建的宿主/协调器句柄。建议下一包在 `src/main/index.ts` 注入一个**只读 + 生命周期**
   受限端口给 `LocalAccessService`（`LocalAccessOptions` 增加可选 `flow` 字段），再由本模块登记；
   同时给协作事件增加协作者身份维度，避免外部输入与人工输入不可区分。
2. **建图提交**：新增桌面动作 `flow-build`（承认 `flow-build-actions.ts` 的撤销步与保存屏障），
   才能开放 `build` 的 preview/commit；propose 仍需先补预算验收。
3. **真实桌面段**：本包 6 项操作要补进里程碑脚本（真实 Electron + 独立数据目录 + 授权协作激活），
   并与 CLI/MCP 真实客户端调用一起做三入口一致性证据。
4. **付费与 GPU 路径**：审核/运行一旦开放，需预算授权的付费分组验收；`video-depth/clay` 仍需本机
   Python/GPU，不改现状。
5. 契约快照、动作清单、影响哈希与 `verify:agent-access` 的刷新由 Lead 统一 `--write`；
   本包未改 `package.json`、未运行 `npm run build`、未做任何 git 提交。
