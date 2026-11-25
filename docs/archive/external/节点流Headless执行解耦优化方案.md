# 节点流 Headless 执行 · 与项目解耦优化方案

版本：v1.0 · 日期：2026-11-12 · 状态：待用户确认后实施
目标：外部 Agent 直接 `composite.execute(capabilityId, version, inputs) → outputs`，**不依赖项目、不依赖画布**。节点流成为可独立调用的"能力函数"。

## 一、目标与产品定位

落地你的三层产品思想：
- **节点 = 基本单元**（32 类，强制契约）。
- **节点流 = 能力二次提升**（节点串成图，封装为不可变版本，对外只暴露公开输入/输出）。
- **Agent 调用 = 快速生产**：Agent 把打磨好的节点流当**函数**调——给输入、拿输出，无需打开项目、无需画布。

本方案新增 headless 执行能力，使节点流脱离项目/画布独立运行。**现有画布内执行完全保留不变**。

## 二、架构现状与耦合点（已核实）

### 2.1 极有利的解耦基础
| 事实 | 证据 |
|---|---|
| 执行契约 `CompositeRunRequest/Outcome` **本身无 projectId/editor 字段** | shared/engine/composite-run-contract.ts:20-52 |
| `runCompositeIsolated` **已忽略宿主 editor**（`_hostEditor` 下划线），真实依赖仅 projectId+providers+request | renderer/src/composite/run-composite.ts:41-48 |
| 隔离 editor 是**纯内存 tldraw**（游离 div，不挂真实画布、不渲染）| run-composite.ts:552-562 |
| 台账写入被 `report()` 容错包裹，**失败不影响业务结果** | run-composite.ts:84-90 |
| 模型/供应商/能力仓库/媒体读取**全是全局服务，无项目耦合** | model-host、providers 表、composite_versions、media.repo readMediaBuffer |
| 媒体表**无 projectId 列**，mediaId→路径全局可解析；输入可直传 `{mediaId,mediaPath,mime}` | db-migrations.ts:21-25；createVirtualSource:537-546 |
| 已有 headless 纯逻辑先例：`output.get` 用 buildProjectionShape 纯对象投影；`runNodeTest` 在纯 shape 副本执行 | run-ops.ts:119-137；executor.ts:308-448 |

### 2.2 必须解耦的项目/画布强耦合点
| 耦合点 | 位置 | 处理 |
|---|---|---|
| `composite_runs.project_id NOT NULL` + create 必填 + list 按项目过滤 | db-migrations.ts:542；composite-run.repo.ts:123-153,237-242 | 新增 scope 列 + headless 作用域 |
| `checkFlowNodeAvailability`（Agent-Flow 占用门禁）| executor.ts:1139-1165 | headless 标志跳过 |
| GUI 补输入表单 + `listMedia(projectId)` | executor.ts:1231-1299 | headless 不注入 inputOptions |
| `emitArtifact`（画布落资产节点）| executor.ts:906-948 | headless 不注入 |
| node.execute 的 `ACTIVE_PROJECT_REQUIRED` + 真实画布握手 | service.ts:398-446 | 新增独立 headless 入口，不走此路径 |
| 媒体产物落盘 `projects/<projectId>/media/` | media.repo.ts:106-137 | headless 作用域路径 |
| createRunEditor 的 DOM 依赖（renderer-only）| run-composite.ts:560 | 路线 A 保留 renderer 宿主；路线 B 彻底去除 |

### 2.3 可零改动复用的纯逻辑
shared/composite/runtime.ts（planCompositeInputBindings/collectCompositeOutputs/checkCompositeRunBudget）、validate.ts/manifest.ts、全部节点执行器（DI 契约）、collectContractInputs/buildOutputPackets、topologicalOrder、projectNodeOutputs、deterministic-projections、composite_run_steps/waits（只按 runId）、composite.run.get（全局查询）。

## 三、总体设计

### 3.1 新增外部操作（CLI/MCP 同包，三入口 parity）
| 操作 | 作用 |
|---|---|
| `composite.execute` | 提交 headless 执行：`{capabilityId, version?, inputs:[{portId,value}], idempotencyKey}` → `{runId, status:'running'}`（异步）|
| `composite.execute.wait` | 阻塞等待终态：`{runId, timeoutMs}` → `{status, outputs, failure?}`（便捷封装，复用 run.wait 模式）|
| `composite.run.get` | **已存在且全局**：按 runId 读状态+内部步骤+输出（无需项目）|
| `composite.run.list` | 增加可选 `scope` 过滤（project/headless），默认 project 保持兼容 |

输入契约：`inputs` 按节点流**公开输入端口 id** 喂值（`{portId:'in-<id>', value:{kind:'text'|'json'|'media',...}}`）。媒体直传 `{mediaId,mediaPath,mime}` 或仅 mediaId（全局解析）。
输出契约：`outputs` 按公开输出端口 id（`out-<id>`）返回 NodeValue（text/json/media 引用）。

### 3.2 执行宿主：两条路线

**路线 A（推荐先行，最小改动、复用已验证执行路径）**
- 保留 renderer 隔离 editor 路线（今天节点流就是这么跑的，已验证）。
- 在 main window 挂一个**独立 headless 执行宿主**（不依赖 CanvasEditor/项目，应用启动即可用）。
- `composite.execute` → service.ts 新入口（**不检查 active project**）→ desktop 握手新动作 `execute-composite-headless` → headless 宿主调 `runCompositeIsolated(合成作用域, 全局providers, request)`。
- `runNodeManually` 增加 headless 标志：跳过 `checkFlowNodeAvailability` 与 GUI 补输入；不注入 emitArtifact/inputOptions。
- 合成作用域 id（如 `headless:<runId>`）贯穿资源队列/媒体落盘/台账。
- **特点**：无需打开项目、无需画布；仍需桌面应用运行（作为执行宿主，与现有 agent-access 架构一致）。

**路线 B（彻底 headless，未来增强）**
- main 进程纯数据运行器：用 `NodeShape` 纯对象 + manifest 图 + `collectContractInputs` injections 替代 tldraw/createEdge；GatewayClient 直连 main/gateway；runCode 用 vm；递归 composite 走同一运行器。
- 永久摆脱 DOM/tldraw/renderer，可纯服务端运行。
- 工作量大，须按 AGENTS.md 验证与桌面输出一致。**列为二期，不在本次范围**。

### 3.3 运行台账解耦（零表重建）
- `composite_runs` 新增 `scope TEXT NOT NULL DEFAULT 'project'`（SQLite `ALTER TABLE ADD COLUMN` 即可，无需重建）。
- headless 运行：`project_id='__headless__'` + `scope='headless'`（保持 project_id NOT NULL，避免重建）。
- `createCompositeRun` 增加可选 scope 参数；`listCompositeRuns` 增加可选 scope 过滤（默认 'project'，兼容现有 GUI）。
- `composite.run.get`/steps/waits 已全局，无需改动。

### 3.4 媒体处理
- 输入：直传 NodeValue 媒体引用（机制已存在）；外部文件先经 `media.import` 导入到 headless 作用域。
- 产物：`saveBufferAsset(headlessScope, ...)` 落 `projects/headless:<runId>/media/`——media 表无项目列，**零 schema 改动**。
- 清理策略：headless 产物按 runId 作用域，可定期清理（二期）。

### 3.5 模型
- 直接复用全局 model-host/providers/featureKey 绑定，headless 无需任何项目配置。

## 四、功能保全审查（红线清单）

| # | 必须保持不变 | 依据 |
|---|---|---|
| 1 | 画布内节点流执行（node.execute/compositeExecutor）完全不变 | 路线 A 仅新增独立入口，不改现有路径 |
| 2 | GUI 补输入弹窗交互不变 | headless 不注入 inputOptions，GUI 路径不受影响 |
| 3 | Agent-Flow 占用门禁对画布/Agent 命令仍生效 | headless 标志仅作用于 headless 路径 |
| 4 | 现有 composite.run.list（按项目）语义不变 | scope 默认 'project' |
| 5 | 节点流版本不可变/引用保护/升级预检不变 | 复用同一能力仓库与校验 |
| 6 | 递归/深度/展开预算守卫不变 | 复用 checkCompositeRunBudget |
| 7 | 媒体读取/产物落盘沙箱不变 | 复用 media.repo，仅作用域路径不同 |
| 8 | 三入口 parity（CLI/MCP/GUI 一致）| composite.execute 同包接入 CLI/MCP |
| 9 | 执行器输出契约/投影不变 | 复用 shared 执行器与投影 |
| 10 | 台账失败不影响业务结果 | 复用 report() 容错 |

## 五、实施分期

- **P0 契约与台账**：composite.execute/execute.wait op 契约（ops/composite.ts）+ composite_runs scope 列迁移 + repo scope 参数。
- **P1 headless 执行宿主**：renderer 独立 headless 宿主 + desktop 握手新动作 + service.ts 新入口（免 active project）+ runNodeManually headless 标志。
- **P2 执行接线**：composite.execute 实现（解析 manifest→组装 inputs→runCompositeIsolated 合成作用域）+ 媒体直传/导入 + 输出收集。
- **P3 CLI/MCP 接入**：local-agent 映射 + parity 门禁 + 影响声明。
- **P4 验证**：单元（headless 执行/台账 scope/媒体）+ 真实 E2E（外部 CLI 调用节点流无需项目）+ 回归（画布执行不变）。
- **二期（不在本次）**：路线 B 纯数据 main 运行器；headless 产物清理。

## 六、验证计划

- 单元：headless 执行 text→processor 流（无项目）输出正确；scope 台账隔离；媒体直传；预算守卫；版本固定。
- E2E（真实 Electron + CLI）：
  1. 不打开任何项目，`composite.execute` 调用已发布节点流 → runId → composite.run.get 取输出。
  2. 含媒体输入的节点流 headless 执行。
  3. 嵌套节点流 headless 执行（递归）。
  4. 回归：画布内 node.execute 节点流仍正常（功能保全）。
- 门禁：typecheck/lint/guard:agent-parity/build。

## 七、文件改动清单（路线 A）

| 文件 | 改动 |
|---|---|
| shared/agent-access/ops/composite.ts | 新增 composite.execute/execute.wait 契约 + run.list scope |
| main/store/db-migrations.ts | composite_runs 增 scope 列（M30）|
| main/store/composite-run.repo.ts | create/list 增 scope |
| main/ipc/composite.ipc.ts | runStart 透传 scope |
| main/agent-access/composite-ops.ts | composite.execute/execute.wait 实现 |
| main/agent-access/service.ts | headless 入口（免 active project）+ 握手新动作 |
| main/agent-access/desktop.ts | execute-composite-headless 握手 |
| renderer（新 headless 宿主模块）| 独立执行宿主，调 runCompositeIsolated |
| renderer/src/engine/executor.ts | runNodeManually headless 标志（跳过门禁/GUI 补输入）|
| renderer/src/composite/run-composite.ts | 合成作用域透传（如需）|
| shared/engine/composite-run-contract.ts | headless 标志（如需）|
| test/* | headless 执行/台账/媒体测试 |

## 八、风险与权衡

- **路线 A 仍需桌面应用运行**：与现有 agent-access 架构一致（外部 Agent 本就通过桌面应用的 agent-access server 调用）。若需纯服务端无 GUI 运行，走二期路线 B。
- **headless 标志侵入 runNodeManually**：需精确条件隔离，确保不影响画布/Agent 路径（红线 1/2/3）。用独立参数而非全局状态。
- **媒体作用域清理**：headless 产物累积需清理策略（二期），本次先约定作用域路径。
- **输出一致性**：路线 A 复用同一执行器，输出与画布一致（天然保证）；路线 B 需额外验证。