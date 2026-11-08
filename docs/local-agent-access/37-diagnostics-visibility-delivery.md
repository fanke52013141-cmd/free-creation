# F9（三）：诊断查询 + 项目节点可见集读写（交付台账）

日期：2026-11-08。负责人：f7-nodelib（复用席位）。任务板 `task-10`。
范围：**diagnostics.query**（只读，复用 main 诊断存储）+ **project.nodeVisibility.get / set**（项目节点可见集读/写）。
本包**不触发任何模型调用**（语音克隆/音色设计/视频生成按要求只做代码层接通，不在本包；图片生成也不在本包调用）。

---

## 一、一句话现状

外部 Agent 现在可以：**按 trace/run/请求/节点/级别/时间窗分页查询已落盘的结构化诊断事件**（与 GUI 运行中心同一条 `DiagnosticsService.query` 读取路径、同一份已脱敏存储），
以及**读取/替换项目的节点可见集**（决定调色板里出现哪些节点；经 `projects.repo.saveWorkspaceProfile` 正式保存）。
新增 **3 项外部操作**，Registry 共 **95 项**（CLI/MCP 由同一 Registry 自动生成，无外部专用执行器）。

台账 34 的"外部建项目默认少 8 类节点"已由 `allWorkspaceProfile()` 修复；本包补上**解释与调整入口**：Agent 能读回"这个项目现在哪些节点可见、哪些已保存但不可创建"，也能显式收窄/恢复。

---

## 二、业务动作三入口状态

| operationId | effect | GUI 入口（同一实现） | CLI/MCP | 状态 | 关键语义 |
| --- | --- | --- | --- | --- | --- |
| diagnostics.query（新） | read | 运行中心「运行详情」时间线（`RunTimeline` 调 `diagnostics:query`） | 有 | contract-tested | 复用 `DiagnosticsService.query`；单页 ≤200、偏移 ≤5000、内部一次读 ≤2000；事件字段白名单投影 + 二次脱敏 + 截断；服务未注入或降级（`health.available=false`）→ `DIAGNOSTICS_UNAVAILABLE`，**不用空数组冒充成功** |
| project.nodeVisibility.get（新） | read | 项目「工作台节点设置」对话框读取当前配置 | 有 | contract-tested | 读 `projects.repo.openProject`（与 GUI 打开项目同一读路径，含旧配置归一化）；新项目 `presetId=all`=全部 32 类；**旧项目无配置时 `profile=null` + `source=legacy-all-visible`**（运行时按"全部可创建节点"解释），不伪造 general；另报 `savedButNotCreatable`（已保存但当前不可创建，如退役/发行版裁剪） |
| project.nodeVisibility.set（新） | write | 同一对话框「保存设置」 | 有 | contract-tested | 替换语义；只接受当前可创建类型（`allWorkspaceProfile()`：Active ∩ 非发行版裁剪）；空集合/未知/退役/重复/非法字符分别给 `EMPTY_NODE_VISIBILITY` / `UNKNOWN_NODE_TYPE` / `DUPLICATE_NODE_TYPE` / `INVALID_INPUT`；经 `saveWorkspaceProfile` 正式保存（写锁 + tmp/rename + 索引更新），**不推进 graphVersion**；落盘后重读核对，回执含 `added`/`removed`/`desktopReloadRequired` |

**未开放（可选能力，写清原因）**：`diagnostics.nodeRun.export`。
GUI 的节点诊断导出 = renderer 内存运行记录 + **原生保存对话框**；外部要等价，必须先定义"稳定运行事实来源"（`run.get` 的正式记录 vs 诊断事件）与**受控导出目录契约**，且会占用 `ipc.diagnostics.exportBundle` / `ipc.diagnostics.exportNodeRun` 两个覆盖键（本包文件范围只授权 `ipc.diagnostics.query`）。
因此本包只开放查询；导出建议作为独立包（见第七节）。

---

## 三、公共实现与兼容处理

**共享契约（成对登记 operation + output Schema）**
- `src/shared/agent-access/ops/diagnostics.ts`：`diagnostics.query`（纯 strict 对象、无 refine）。
- `src/shared/agent-access/ops/project-settings.ts`：`project.nodeVisibility.get/set`。
- 既有操作 **Schema 零改动**，因此不需要 `--accept-contract-change`；契约快照由 Lead 统一 `--write`。

**一份业务实现**
- `src/main/agent-access/diagnostics-ops.ts`（新）：不新建日志读取器。宿主按鸭子类型取 `health`/`query`（装配层的 `LocalAccessOptions.diagnostics` 只声明了 `health`，本包不为此改共享选项类型与 `server.ts` 装配签名）；先校验 `available`，再调用 `query`，最后做白名单投影 + 二次脱敏（`redactDiagnosticText`）+ 截断；`safeStack`、未登记 attributes、未知字段一律不出现。
- `src/main/agent-access/project-settings-ops.ts`（新）：读走 `openProject`、写走 `saveWorkspaceProfile`（与 GUI 对话框完全同一 repo 函数）；写入前做可创建集合/重复/空校验，写入后重读核对，核对失败按 unknown 保守上报。
- `src/main/agent-access/service.ts`：只追加 2 行 import、1 个分组 `else if` 分支（diagnostics / nodeVisibility）、`execute` 里 3 个 case 的兜底 `throw`（沿用既有"在 dispatch 处理"模式）；未重排/未删除任何既有分支。

**兼容与语义说明**
- 可见集写入**显式携带当前 `nodeSetRevision`**，因此共享 `normalizeWorkspaceProfile` 不会因为"版本落后"把新节点（如 timeline）静默补回用户刚下掉的集合；GUI 对话框不传版本号，走原有的"补新节点"口径。两条路径写出的文件都合法，外部回执给出 `added/removed`，不静默改用户意图。
- 写可见集是**写操作**，沿用 dispatch 的既有占用规则：项目存在恢复副本或运行中任务时返回 `RESOURCE_BUSY`（与 `project.rename/save` 等外部写一致；比 GUI 对话框更严，属"复用既有占用规则"）。
- 画布正在打开时写入不会破坏数据（`saveWorkspaceProfile` 用同一写锁与 tmp/rename），但 GUI 持有内存副本，回执用 `desktopReloadRequired=true` 如实提示需要重开项目才能看到新可见集。
- 诊断查询是**应用级**的（诊断事件不属于某个项目）；事件里的 `projectId` 只作为事实字段返回。

---

## 四、真实验证证据（本机实际运行）

| 检查 | 命令 | 真实结果 |
| --- | --- | --- |
| 类型 | `npm run typecheck` | 通过（node / web / license-protocol / issuer，exit 0） |
| 业务动作分母 | `node scripts/audit-business-actions.cjs` | **仅因生成物陈旧失败**：`Action inventory is stale; run audit-business-actions.cjs --write`（按 Lead 指示不跑 `--write`，由其统一刷新）。语义校验已通过：编辑覆盖映射后不再有 `ORPHAN_EXTERNAL_OP`/`MISSING_COVERAGE`/`UNKNOWN_EXTERNAL_OP` |
| 定向 lint | `npx eslint <本包 5 个源文件/测试> --quiet` | 0 error |
| 本包测试 | `node scripts/run-vitest.cjs run test/local-agent-diagnostics-visibility-access.test.ts --reporter=verbose` | **9 项全通过** |
| 指定回归 | `node scripts/run-vitest.cjs run test/local-agent-diagnostics-visibility-access.test.ts test/local-agent-access.test.ts test/local-agent-parity.test.ts test/project-profile-migration.test.ts --reporter=dot` | **58/59 通过**；唯一失败为既有门禁测试 `blocks stale generated contracts…`（新增 3 个操作后契约快照必然陈旧，脚本第一步即报 `Generated contract is stale`，跑不到第二条 `Protected source changed` 断言；未改任何断言，Lead `--write` 后即应转绿） |
| 契约生成确定性（不写仓库） | `node scripts/check-agent-access.cjs --write --reason "…" --snapshot-file %TEMP%… --impact-file %TEMP%…` 后只读复核 | 生成与复核均通过：`Agent access gate passed: 95 operations; 32 planned nodes.` |

**新增测试覆盖（真实数据级断言）**

`test/local-agent-diagnostics-visibility-access.test.ts`（9 项）：
1. **诊断分页/过滤**：用真实 `initDiagnosticsService`（内存文件系统 + 受控时钟）落盘 3 条事件；按 trace 分页（limit=1 → `truncated`/`nextOffset=1`；第二页 `nextOffset=null`）、按 level=error、按 nodeId、按 since/until 时间窗过滤；未命中 trace 返回 completed+空结果（与"不可用"区分）；断言 `source=diagnostics-store` / `redaction=event-whitelist@1`。
2. **敏感标记不出现**：生产者路径传入的私有提示词正文（`privateValues`）在诊断里被替换为占位符；历史行里带 `apiKey=sk-…`、未登记 attributes（`promptText`/`rawBody`）、`safeStack` 私有路径时，查询输出**不含**原始密钥、未登记属性、原始请求体、safeStack 与私有路径，`attributes` 只剩注册表允许的键。
3. **不可用如实报错**：未注入诊断服务 → `DIAGNOSTICS_UNAVAILABLE`；降级服务（`mkdir` 抛错 → `health.available=false`，其 query 返回空数组）→ 同样 `DIAGNOSTICS_UNAVAILABLE`，且**不返回 data**。
4. **非法参数拒绝**：非法 level、limit=0/201、offset=5001、负 since、含空格 traceId、额外字段 → `INVALID_INPUT`。
5. **可见集默认值**：外部 `project.create` 后 `get` → `presetId=all`、可见=可创建=32 类，且台账 34 的 8 类高级节点（裁剪/拆分/截取/深度/白模/音色设计/导演台/AI 处理）都在；旧项目（文件删除 `workspaceProfile`）→ `profile=null`、`source=legacy-all-visible`、生效集=全部可创建。
6. **写入并读回**：重复项先被拒（`DUPLICATE_NODE_TYPE`）；写成 3 类后 `openProject` 读回一致、`graphVersion` 未变、`added/removed` 正确；画布打开时 `desktopReloadRequired=true`；写全集时 `presetId=all`。
7. **显式拒绝**：空集合 `EMPTY_NODE_VISIBILITY`、`group`（Legacy）与未登记类型 `UNKNOWN_NODE_TYPE`、字符串/非法字符/额外字段 `INVALID_INPUT`、缺幂等键 `IDEMPOTENCY_REQUIRED`、项目不存在 `NOT_FOUND`；被拒写入后项目配置仍是 all（无半配置）。
8. **跨项目隔离**：写 B 后 A 的 `project.json` 逐字节未变、A 的可见集仍是 all；B 读回为写入集合。
9. **幂等重放**：同幂等键重放返回原回执、项目文件逐字节一致、`updatedAt` 不再变化（无第二次写）；同键不同意图 → `IDEMPOTENCY_CONFLICT`。

**边界（如实保留）**
- 服务级测试：诊断读写用真实 `DiagnosticsService` + 内存文件系统，可见集用真实 `projects.repo` 与项目文件；**真实 Electron 桌面逐动作验收未做**（需 `npm run build` 后跑里程碑，由 Lead 统一执行）。
- 本包零模型调用、零供应商请求、零凭据读取。

---

## 五、日志覆盖与脱敏

- 外部操作生命周期复用既有 `agent.access.started/completed/failed/rejected/unknown`（operation/phase/code + trace/span），**不新增重复终态**；`diagnostics.query` 本身不写业务日志（读操作），也不把查询结果写入诊断存储（避免"看日志产生日志"的环）。
- 可见集写入通过 `saveWorkspaceProfile` 落盘；该路径**没有**专属注册事件（新增事件需改 `src/shared/observability/events.ts`，不在本包文件范围）。当前可见证据 = `agent.access.completed` + 回执 + 项目文件事实；已把"可见集写入缺少专属事件"登记为后续项（见第六节第 6 条），未用业务 `console.log` 冒充。
- 脱敏：`diagnostics.query` 输出二次脱敏（`redactDiagnosticText`：`apiKey=/Bearer/sk-…` 等）+ 白名单投影（只保留事件注册表允许的 attributes 键、无 safeStack、无原始异常、message 截断 500 字符、attributes 值截断 256）；`nodeVisibility.*` 只处理节点类型 ID 与预设名，不含用户正文/路径/密钥。诊断事件正文由各生产者按固定模板生成（本包不放宽该约束）。
- 覆盖清单见 `docs/LOGGING_COVERAGE.md` 顶部 2026-11-08 小节。

---

## 六、未完成 / 仅模拟部分（不得当成已完成）

1. **诊断导出未开放**：`diagnostics.nodeRun.export`（及 GUI 的 `diagnostics:export-bundle`）需要"稳定运行事实来源 + 受控导出目录契约 + 覆盖键授权"，本包未做（原因见第二节），GUI 仍可在原生对话框导出。
2. **分页是偏移分页，不是稳定游标**：诊断存储按分片顺序读取（新分片优先），并发写入时同一 offset 可能重叠/漏行；需要严格快照一致性时应按 traceId/runId 精确查询。已在输出里给出 `nextOffset` 与 `truncated`，不承诺游标隔离。
3. **真实桌面未验收**：见第四节边界；GUI 侧"重开项目后可见集生效"未做真实窗口验收（只有数据级 + IPC 路径证据）。
4. **打开中的画布**：写入后 GUI 需要重开项目（`desktopReloadRequired=true`）；自动刷新面板需要 renderer 订阅项目文件变更（现有 watch 只用于外部修改提示），未在本包实现。
5. **错误 phase 标签**：新增操作经既有 `DesktopAccessError → AccessFailure` 映射，除版本冲突外 `phase` 统一显示 `desktop-handshake`；稳定错误码与 detail 精确。要按阶段细分需改 service 的 catch 映射（共享文件，超出本包最小追加范围），登记为统一整改项。
6. **日志缺口**：工作区配置写入没有专属注册事件；诊断查询是只读无事件。若后续要求"配置变更事件"，需在事件注册表登记 `project.workspace_profile.changed`（单一所有权），本包不越权改注册表。
7. **契约快照 / 动作清单**：按 Lead 指示未跑 `--write`，由其统一刷新；刷新前 `verify:agent-access` 与 `audit-business-actions` 的"陈旧"检查会红，语义检查已通过（见第四节）。
8. **`project.create` 显式可见集入参**：仍未提供（台账 34 第 4 条），本包只补"创建后读写"；新增可选字段属改既有操作 Schema，需单独契约变更。

---

## 七、下一包建议

1. **诊断导出外部化**（独立包）：定义受控导出目录 + 稳定范围（trace/run/时间窗）、容量上限、二次脱敏断言，并一次性补齐 `ipc.diagnostics.exportBundle` / `ipc.diagnostics.exportNodeRun` 覆盖键与 sha256/字节回执。
2. **可见集变更事件**：在事件注册表登记 `project.workspace_profile.changed`（含 presetId、可见数量、added/removed 计数，不含节点标题），并让 GUI 侧 workspace 设置保存与外部写入共用。
3. **画布打开时的可见集热更新**：renderer 订阅外部修改并刷新调色板（否则只能"重开项目"）。
4. **`project.create` 可选 `visibleNodeTypeIds`/`presetId` 入参**：与 GUI 新建对话框完全对齐，需契约变更 + 兼容结论。
5. 里程碑补 2 段真实桌面验收：①外部 set 可见集 → GUI 重开项目 → 调色板只剩所选节点；②GUI 运行中心时间线与外部 `diagnostics.query` 对同一 trace 返回一致事件集。
