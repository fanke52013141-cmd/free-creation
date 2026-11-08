# F8（第二批）：Agent 运行与内置度外部接入（flowAgent.run / pause / stop）

日期：2026-11-08。基线：`2661e83`。本包解决 F8 第一批留下的最大阻塞：
"run/pause/stop 的权威宿主是 flow-agents IPC 里创建的那一个桌面实例，外部另建实例
= 第二个权威"。做法不是绕过它，而是**把同一个实例以窄接口发布**给本地外部接入。

## 1. 架构：共享宿主端口，而不是第二个宿主

- 新增 `src/main/agent-access/flow-bridge.ts`：只承载一个"端口"对象
  （`run / pause / stop / assertAgentScopeToolCalling`），由 `registerFlowAgentsIpc`
  在创建宿主后调用一次 `publishFlowAgentAccessPort(...)` 发布；
- 外部 `flowAgent.run/pause/stop` 一律经该端口执行，**不 new 第二个宿主**；
- 端口只在 flowAgents IPC 注册完成后存在；未发布（例如非桌面启动阶段）时外部调用
  如实返回 `FLOW_AGENTS_UNAVAILABLE`，不降级成本地替身。

为什么这是唯一正确做法：`FlowAgentDesktopHost` 持有模型端口、命令交付通道与在途运行表。
两个实例会让"谁拥有这个任务"变得不确定，从而出现账本与运行事实互相覆盖。

## 2. 准入与安全（与 GUI 入口同一套）

| 关卡 | 实现 |
| --- | --- |
| 运行身份 | `requestId` / `traceId` / `spanId` 由 main 生成（UTC 随机的 UUID），外部不能自造 |
| 请求形状 | 直接复用内部 `FlowAgentRunSchema` / `FlowAgentQuerySchema`；continue/reconcile/restore 必须携带观测到的 `expectedTaskId` 与 `expectedWaitRevision`（乐观并发） |
| 付费闸门 | start/continue 先执行与 IPC 入口相同的 `assertAgentScopeToolCalling`（技能范围内模型必须已通过工具调用验证）；**预检失败时宿主 run 一次都不会被调用**，账本里也不会留下任务 |
| 活动画布 | `run` 要求目标项目就是当前活动画布（宿主需要渲染器交付命令），否则 `ACTIVE_PROJECT_REQUIRED` |
| 控制操作 | `pause` / `stop` 可作用于非活动画布上的既有任务（停止工作不应被切画布挡住）；任务不存在如实 `NOT_FOUND`，不编造空视图 |
| 占用豁免 | 三个操作对"存在活动 Agent 任务"豁免占用检查——否则刚创建的任务永远无法继续/停止；**豁免只对这三个操作生效**，同一项目上的其他写入仍 `RESOURCE_BUSY`（有对照断言） |

## 3. 真实验证证据

`test/local-agent-flow-agent-run-access.test.ts`（9 项，全部通过）：

1. 端口未发布 → `FLOW_AGENTS_UNAVAILABLE`；
2. `run` 在项目非活动时 `ACTIVE_PROJECT_REQUIRED`，且宿主 run 与预检都未被调用；
3. start 成功路径：先预检、再调用同一宿主；`requestId/traceId/spanId` 由 main 生成（UUID 断言）；
4. **预检失败 → 宿主 run 零调用、账本零任务**（付费路径不被偷偷触发）；
5. continue 缺 `expectedTaskId/expectedWaitRevision` → `INVALID_INPUT` 且不调用宿主；带齐则透传；
6. 存在活动任务时 run/pause/stop 均可执行，而对照的 `media.import` 仍 `RESOURCE_BUSY`；
7. pause/stop 对不存在任务 `NOT_FOUND`；
8. pause/stop 可作用于非活动画布上的既有任务；
9. 同幂等键重放返回原回执，宿主只被调用一次。

批次门禁：`npm run typecheck` 通过；`node scripts/audit-business-actions.cjs`
→ 171 IPC + 40 画布动作；external ops **98**（本包 +3）；18+1 个接入测试文件待统一复跑；
`verify:agent-access` 由 Lead 统一刷新。

## 4. 矩阵与覆盖更新

- `ipc.flowAgents.run/pause/stop` 转为 external 并映射到三个新操作；
- 逐节点矩阵中 `agent` 节点的 N5/N7 从 `planned` 升为 `contract-tested`，证据写明
  "预检失败时零模型请求"与"真实长任务未实测"——**不写 desktop-tested**。
- 发现并记录一个既有命名不一致：`ipc.flowAgents.pause` 的通道值是 `flowAgents:pause`
  （其他都是 `flow-agents:*`）。本包按现状登记（改通道属于 IPC 契约变更），
  建议后续单独修正，避免外部按前缀猜通道。

## 5. 未完成 / 边界

1. **真实 Agent 运行未实测**：需要"已验证工具调用能力"的模型连接（会消耗预算），
   用户当前要求语音/音色/视频类不做真实调用；Agent 运行同样属付费路径，
   因此只验证到"预检失败如实拒绝、零模型请求"。
2. `flowAgent.cooperate`（协作输入）仍未开放：协作事件没有外部主体身份维度，
   外部写 note/submit 会与人工输入不可区分，需要先定协作者身份契约。
3. `flowAgent.review` / `flowAgent.build`（建图提交）/ `publication` 仍未开放：
   前者需同一宿主模型端口与工具调用预检的完整路径，后者需要新的渲染器权威桌面动作。
4. `flow.command.dispatch/prepare/check/abort`：**已在 F8 收官批次开放**（`check/dispatch/abort`
   登记，prepare 并入 dispatch），见 [29 号台账第 10 节](29-flow-commands-delivery.md)；
   外部主体以 `principal='external'` 标记进账本，abort 只对未准入命令生效。
5. 真实桌面段未跑（本包是服务级 + 端口注入证据）；桌面段需要先在 GUI 配好已验证模型，
   属于用户自测范围。
