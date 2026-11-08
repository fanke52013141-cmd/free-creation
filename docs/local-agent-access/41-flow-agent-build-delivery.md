# F8（收官第二批）：Flow 建图预览/提交与模型审核外部接入

日期：2026-11-08。基线：`2ab54d4`（F8 第二批：flowAgent.run / pause / stop）。本包按
"可行性优先、诚实优先"处理 F8 剩余四个方向：**建图（build）、审核（review）、协作（cooperate）、
发布（publication）**。实现沿用第二批确立的**共享宿主端口**模式（`flow-bridge.ts`）：
把 `registerFlowAgentsIpc` 里创建的那一个 `FlowBuilderHost` / `FlowReviewHost` 以窄接口发布，
外部不另建实例、不绕过模型能力预检。

## 1. 实际完成的业务动作（GUI / CLI / MCP 状态）

| 业务动作 | GUI | CLI | MCP | 公共实现 |
| --- | --- | --- | --- | --- |
| 读取建图预览 | ✅ Agent Flow 面板 | ✅ `flowAgent.build.inspect` | ✅ `flow_agent_build_inspect` | 同一 `FlowBuilderHost.handle({action:'inspect'})`；只读 `flow_builds`，不调模型、不改画布 |
| 生成建图预览 | ✅ 面板"生成建图" | ✅ `flowAgent.build.propose` | ✅ `flow_agent_build_propose` | 同一 `FlowBuilderHost.handle({action:'propose'})`；先走与 IPC 同一模型工具调用预检，再以 main 生成的 request/trace/span 调模型 |
| 提交建图到画布 | ✅ 面板"确认建图" | ✅ `flowAgent.build.commit` | ✅ `flow_agent_build_commit` | 新桌面握手动作 `flow-build` → 渲染器**同一** `commitFlowBuild`（authorize/confirm + 单撤销步 + 保存屏障）→ main 以持久化 committed 状态与已保存节点核对 |
| 提交模型审核并读取报告 | ✅ 审核节点运行 | ✅ `flowAgent.review` | ✅ `flow_agent_review` | 同一 `FlowReviewHost.run`；先走与 IPC 同一模型/证据预检；结论由模型产生，外部不能改写 |
| 协作输入（note/讨论/选择/继续） | ✅ 面板 | ❌ 不登记 | ❌ | 见 §5：协作事件无外部主体身份维度 |
| Flow 发布等待/继续 | ✅ 面板/协调器 | ❌ 不登记 | ❌ | 见 §5：需人工授权 + 渲染器运行期确认协议 |

Registry 新增 4 项操作（`flowAgent.build.inspect / propose / commit`、`flowAgent.review`），
均由同一 Registry 派生 CLI 与 MCP 工具；三入口业务实现只有一份（本模块 + 共享宿主端口）。

## 2. 架构与准入（与 IPC 入口同一套）

- **共享宿主端口**（`src/main/agent-access/flow-bridge.ts`）扩展 `build / review /
  assertReviewToolCalling` 三个窄接口。`registerFlowAgentsIpc` 在创建同一批宿主后发布一次；
  未发布时外部调用如实 `FLOW_AGENTS_UNAVAILABLE`，不降级成本地替身。
- **模型预检先行**：`propose` 与 IPC `flow agents build` 一样先执行
  `assertAgentScopeToolCalling`；`review` 与 IPC review 分支一样先执行
  `assertReviewToolCalling`（本包把 IPC 内联预检抽成共享函数，两条入口不再漂移）。
  预检失败发生在任何模型请求之前——隔离数据目录无已验证模型时实测为
  `AGENT_MODEL_UNAVAILABLE`，零模型请求、零预览/零审核记录。
- **运行身份由 main 生成**：propose/review 的 `requestId`/`traceId`/`spanId` 由 main 生成
  （`randomUUID` + 既有 trace/span 前缀）；输入 Schema 为 strict，外部带 `requestId`
  直接 `INVALID_INPUT`。
- **commit 只按 buildId**：外部不能自带节点/边/正文；main 先读持久化预览（不存在
  `FLOW_BUILD_MISSING`，非 preview 状态 `FLOW_BUILD_UNCONFIRMED`），再经桌面握手交给渲染器
  `commitFlowBuild`。提交后 main 重新读取预览必须 `committed` 且每个节点在已保存图中存在，
  否则 `STORAGE_INCONSISTENT`（failed，不把渲染器回执当成功）。桌面超时/失联按 unknown，
  不自动重发；已 committed 的重复提交按持久化事实返回，不重复建节点。
- **失败语义**：准入前失败 = failed（无副作用）；准入后失联 = unknown；未开放操作不登记，
  CLI 本地即拒绝。

## 3. 验证证据

### 3.1 单元/服务级（本工作区实测）

新增 `test/local-agent-flow-agent-build-access.test.ts`（16 项，全部通过）：

1. 端口未发布 → 四个操作均 `FLOW_AGENTS_UNAVAILABLE`（不降级替身）；
2. 非活动画布 → 四个操作在宿主调用前 `ACTIVE_PROJECT_REQUIRED`，builder/review 零调用；
3. inspect 只读预览，响应/序列化不含建图正文与配置；无预览返回 `build:null`；
4. propose 先预检再调用同一宿主，requestId 为 UUID、trace/span 为 main 关联 ID，并读回
   持久化预览（不是只信返回值）；
5. 模型预检失败 → propose/review 的宿主调用均为 0（付费路径不被触发）；
6. commit：桌面不可用 `DESKTOP_UNAVAILABLE`；无预览 `FLOW_BUILD_MISSING` 且不触发桌面；
   缺 buildId `INVALID_INPUT`；
7. commit 成功路径（假桌面模拟渲染器落盘）：桌面载荷只有 buildId/目标、没有建图内容；
   main 以持久化 committed + 节点存在核对成功；
8. commit "回执成功但节点未落盘" → `STORAGE_INCONSISTENT`（不报成功）；
9. 桌面失联（unknownOutcome）→ status `unknown` / `OUTCOME_UNKNOWN`，不自动重发；
10. 桌面明确拒绝 → failed 保留稳定错误码；
11. 已 committed 预览重复提交 → 不再次触发桌面动作，按持久化事实返回节点 ID；
12. review：模型预检失败零宿主调用；成功路径映射报告字段；输入带 `passed` 被 strict
    Schema 拒绝（外部不能改结论）；propose 预检失败时同幂等键重放不重复调用模型。

批次门禁（本工作区实测，见 §6）：`npm run typecheck` 通过；`npm run build` 通过；定向 5 个
接入测试文件 **85/85**；`audit` / `verify:agent-access` 通过（集成方已刷新契约快照与动作
清单，见下）；真实桌面里程碑 **49/49**。

### 3.2 真实 Electron 桌面段（里程碑新增 4 项，45 → 49 全绿）

`scripts/test-agent-graph-milestone.cjs` 新增 6.14 段（在既有 45 项之后、重启段之前），
在隔离数据目录（无任何模型连接）里用真实画布验证；本次运行
`qa/local-agent-access/milestone-a-b-c/report.json`：`status=passed`，**checks=49**
（既有 45 项全部保留 + 本包 4 项），`report.flowAgent` 记录：

| 场景 | 真实结果 |
| --- | --- |
| 建 builder 角色 Agent 节点 + ai-review 节点（graph.patch 落盘） | completed |
| `flowAgent.build.inspect` | completed，`build:null`（propose 前没有预览） |
| `flowAgent.build.propose` | **failed / AGENT_MODEL_UNAVAILABLE**（模型预检处，零模型请求） |
| propose 后再次 inspect | completed，`build:null`（零预览） |
| propose 输入自带 `requestId` | **failed / INVALID_INPUT**（不能自造运行身份） |
| `flowAgent.build.commit`（无持久化预览） | **failed / FLOW_BUILD_MISSING**（不触发桌面写入） |
| 非活动画布上的 build.inspect | **failed / ACTIVE_PROJECT_REQUIRED** |
| `flowAgent.review`（真实 ai-review 节点，无已验证模型） | **failed / AGENT_MODEL_UNAVAILABLE**（零模型请求） |
| `flowAgent.review`（非审核节点） | **failed / FLOW_REVIEW_CONFIG_INVALID** |
| review 输入自带 `passed:true` | **failed / INVALID_INPUT**（不能改结论） |
| CLI `flowAgent.cooperate` / `flowAgent.publication` | 本地拒绝（CLI_INVALID_RESULT:2，未登记） |

## 4. 日志覆盖与脱敏

- 复用既有 `agent.access.started/completed/failed/unknown` 生命周期（operation =
  `flowAgent.build.inspect/propose/commit`、`flowAgent.review`），无新增事件类型；
  commit 的桌面握手沿既有 `project.save` 生命周期，不重复记终态；
- 不记录建图目标/计划/节点正文/配置、审核 criteria/feedback/资产正文、模型提示词或回复；
  失败只记录稳定 code/phase；`flowAgent.review` 的 report 只回给调用方，不入日志；
- 端口/宿主调用失败不改变业务结果；未知结果保持 unknown，不记成功。
- 边界：桌面 flow-build 动作没有独立诊断事件（与 graph-patch 桌面动作一致，复用外部接入
  生命周期 + 保存事件），未做跨进程 trace 树对齐；见 `docs/LOGGING_COVERAGE.md` 本包小节。

## 5. 未开放项与"为什么不能开"

1. **`flowAgent.cooperate`（协作输入/继续）**：内部 `FlowAgentCollaborationSchema` 与
   `FlowCollaborationStore` 没有外部主体维度（没有 actor/source 字段），外部写 note 会与
   人在画布内的输入不可区分；submit/revise/accepted/selected 更是直接等同人工决定与继续。
   要开放必须先给协作事件加协作者身份契约、让 GUI 可区分呈现并单独验收（涉及
   `shared/agent-flow/desktop-tasks.ts`、`collaboration-store` 与面板，不在本包范围）。
   另外 note 还要求存在一条"等待中"的协作任务，无模型运行无法产生可测任务。
2. **`flowAgent.publication`（发布等待/继续）**：发布是协调器运行期 main→renderer 的
   授权/等待信号；`FlowCoordinatorHost` 的确认条件依赖渲染器保存后的内部运行事实
   （nodeRun.runId、审核记录签名等）。外部替宿主回执等于伪造内部运行身份；要开放需按
   导演台发布协议另建 `prepare/authorize/status/continue` 契约（`src/main/agent-access/publish.ts`
   是导演台版本），并与人工授权绑定，本包未做。
3. **`flowAgent.build.propose` / `flowAgent.review` 的成功路径未实测**：需要"已通过工具调用
   验证"的模型连接（会真实调用供应商），按用户要求不做真实付费调用；本包只验证到
   "模型预检失败、零请求、零预览/零决定"。
4. **`flowAgent.build.commit` 的成功路径未真实桌面实测**：预览只能由 propose 模型生成；
   无模型环境无法产生预览。协议与 main 侧核对已用假桌面单测覆盖（见 3.1），真实渲染器
   `commitFlowBuild` 调用路径复用 GUI 已存在的同一函数，但"外部→桌面→真实落盘"整链
   留待有模型环境验收；因此本包**不宣称 commit 已 desktop-tested**。
5. 建图/审核的流式进度、取消（模型调用中的 abort）未暴露外部 operation；沿用宿主 30s
   内部超时。
6. `flowAgent.build.discard`（取消预览）未单独开放：预览是惰性 DB 状态，不影响画布；
   为避免扩大外部写面，本包只开放 inspect/propose/commit。
7. 逐节点矩阵未在本包更新（N1–N8 的状态口径由 Lead 的矩阵门禁维护）；本包只登记
   操作/覆盖/证据。

## 6. 验证记录（真实命令与结果）

| 检查 | 结果 |
| --- | --- |
| `npm run typecheck` | 通过（node/web/license-protocol/issuer 0 错误） |
| `npm run build` | 通过（typecheck + electron-vite build；本次里程碑即运行该产物） |
| 新增测试 + 既有 Flow/parity 测试（5 文件） | `Test Files 5 passed (5)`；`Tests 85 passed (85)`（含新增文件 16/16） |
| `node scripts/audit-business-actions.cjs` | 通过：`171 IPC channels + 41 canvas actions; external ops 106`（4 个新操作均已映射到 `ipc.flowAgents.build/review`；聚合产物由集成方刷新，本包未跑 `--write`） |
| `npm run verify:agent-access` | 通过：`Agent access gate passed: 106 operations; 32 planned nodes`（契约快照/影响声明由集成方刷新，本包未代签） |
| 真实桌面里程碑（官方构建产物） | **通过，checks=49**（45 基线 + 4 新增；`report.json` status=`passed`） |

> 共享工作区说明：本包与 F8 命令账本包在同一工作区并行开发；契约快照、影响声明与动作
> 清单的 `--write` 聚合由 Lead 在集成提交中统一执行（本包未跑），因此上述审计/契约门禁
> 在集成刷新后通过。并行包改动（如语音执行器）曾短暂阻塞构建，已由对应负责人修复后重跑通过。
