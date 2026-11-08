# F7 节点库通用化与历史/恢复交付台账（node.library / history）

日期：2026-11-08。负责人：f7-nodelib。任务板 `task-4`。
范围：**节点库全类型组合保存与跨画布实例化**（N8）＋ **历史快照与恢复副本**（历史/恢复两族）。
本文是交付记录，不是"全能力完成"声明；未验收项在第五节逐条列出。

---

## 一、一句话现状

外部已从"节点库只能保存单个 AI 对话技能预设、历史/恢复完全未开放"推进到：
**13 项新操作**（节点库 6 项组合管理＋历史/恢复 7 项），全部登记在 Registry（CLI/MCP 由同一 Registry 自动生成，无外部专用执行器）；
画布写入（节点库实例化）经既有权威宿主 `graph-patch` 握手与正式保存；历史恢复只在**项目未在桌面打开**时以正式保存机制执行，打开中的画布如实返回 `RESOURCE_BUSY/desktop-ownership`；
旧 `node.library.save`（chat 技能预设子集）**一行未改**，语义与输出 Schema 完全兼容。

当前机器口径：Registry **77 项操作**；业务动作分母 **206 项**（7 个 IPC 域 + 35 画布动作）中 **external 76 / excluded 19 / 仍待接入 87**（F7 剩余 6 项为资源库采集与包传输，属其他包）。

---

## 二、业务动作三入口状态

三入口 = GUI（同一业务实现）／CLI（`npm run agent:cli -- <op> --input-file`）／MCP stdio（`<op>` 点换下划线）。
"GUI 入口"列写的是**真实存在**的界面动作；GUI 没有的动作已注明"无 GUI 入口"，不虚设界面。

### 2.1 节点库（N8：保存/实例化/跨画布复用）

| operationId | effect | GUI 入口（同一实现） | CLI/MCP | 状态 | 关键语义 |
| --- | --- | --- | --- | --- | --- |
| node.library.save（既有，未改） | write | 右键/多选工具栏「保存节点 → 流程模板」（多节点时走 compose 的等价存储） | 有 | 兼容保持 | 单 chat 节点技能预设；排除聊天历史/附件/模型选择/运行结果 |
| node.library.compose（新） | write | 「保存节点」对话框（同表同策略，GUI 面板可见） | 有 | contract-tested | `nodeIds[]`（1–40）+ 选中节点间连线拓扑 + 媒体引用记录；全类型；排除聊天历史/附件/运行结果；超 4MB 明确拒绝不静默截断 |
| node.library.update（新） | write | 无独立 GUI 入口（GUI 现有"删除后重新保存"等价） | 有 | contract-tested | 仅改条目名称；内容与画布不受影响；GUI 面板下次打开即见（同一 SQLite 表） |
| node.library.delete（新） | delete | 节点库面板删除按钮 | 有 | contract-tested | 删除条目；已插入画布的节点不受影响；删除后 list/search 不再返回，插入报 NOT_FOUND |
| node.library.get（新） | read | 无独立详情视图（卡片只显示名称） | 有 | contract-tested | 返回节点类型/标题/尺寸/相对偏移/正文与配置**存在性**/媒体引用/连线拓扑；**不返回配置与正文内容** |
| node.library.search（新） | read | 节点库面板本地过滤（名称/标题/类型） | 有 | contract-tested | 服务端同口径过滤（名称/节点标题/节点类型），分页 |
| node.library.insert（新） | write | 节点库面板点击/拖入画布（GUI 走 addNodeLibraryEntry） | 有 | contract-tested | 须先 `project.open` 目标画布；经 `graph-patch` 权威握手；节点 ID/连线/媒体引用全部重映射；媒体**复制进目标项目**后以 mediaId 注入 `mediaResolutions`（外部输入始终只有 mediaId）；幂等键重放不产生第二份 |

### 2.2 历史与恢复

| operationId | effect | GUI 入口（同一实现） | CLI/MCP | 状态 | 关键语义 |
| --- | --- | --- | --- | --- | --- |
| history.list（新） | read | 历史坞列表 | 有 | contract-tested | 目录不返回快照正文；`restorable` 表示该版本能否被外部恢复到正式项目文件 |
| history.snapshot.create（新） | write | 历史坞「保存版本」 | 有 | contract-tested | 捕获**已持久化**画布（`expectedGraphVersion` 必须一致；未保存编辑不在其中，GUI 侧栏捕获的是内存状态）；无 tldraw 快照的项目用共享 `syncGraphSnapshot` 生成可加载快照 |
| history.snapshot.delete（新） | delete | 历史坞删除按钮 | 有 | contract-tested | 删除版本；当前画布不受影响；跨项目 id 报 NOT_FOUND |
| history.restore.precheck（新） | read | 回溯确认对话框的预检/影响摘要（GUI 内嵌） | 有 | contract-tested | 影响（当前/目标节点·连线·分组、媒体可用/缺失）＋阻塞项（ACTIVE_PROJECT/RECOVERY_COPY/TASK_OCCUPANCY/SNAPSHOT_WITHOUT_GRAPH）；无阻塞签发短期令牌 |
| history.restore（新） | write | 历史坞「回溯到此版本」 | 有 | contract-tested | 三段：令牌 → 占用复核 → 自动落「恢复前检查点」→ `projects.saveProject` 正式保存 → 重读核对；令牌绑定 实例+项目+graphVersion+snapshotId+影响摘要，过期/漂移需重新预检；生效前失败保持原图，核对失败自动回退并报 `RESTORE_ROLLED_BACK` |
| history.recovery.precheck（新） | read | 打开项目时「检测到未保存副本」对话框的事实来源 | 有 | contract-tested | 按预期裁决（use/discard）返回副本事实（是否存在/版本/节点数/更新时间）与阻塞项；无阻塞签发令牌（令牌**绑定 decision**） |
| history.recovery.resolve（新） | write | 同一对话框「使用恢复副本 / 丢弃副本」 | 有 | contract-tested | `use`=经 `projects.restoreRecoveryCopy` 正式落盘（写锁/tmp+fsync/.bak 轮转/版本推进）并移除副本；`discard`=丢弃副本、保留磁盘版本；仅未在桌面打开的项目可执行 |

为保证 `history.recovery.resolve` 在"恢复副本存在"时仍可执行（否则该操作永远无法解决副本），dispatch 的占用检查对该操作与 `run.cancel` 作同样豁免。**豁免只对一个操作生效**，已用测试证明：同一恢复副本存在时 `project.delete` / `project.export` / `project.save` / `history.snapshot.create` / `history.restore` 仍全部 `RESOURCE_BUSY`，而 `history.recovery.resolve` 的 use/discard 两条路径都能解决副本，解决后写操作恢复正常。

---

## 三、公共实现与兼容处理

**共享契约（成对登记 operation + output Schema）**
- `src/shared/agent-access/ops/node-library.ts`：6 个操作 + 输出 Schema（全部为**纯 strict 对象**，不用 `.refine()`，避免 `z.toJSONSchema` 生成风险；"二选一"等语义在执行层校验并返回明确错误码）。
- `src/shared/agent-access/ops/history.ts`：7 个操作 + 输出 Schema。
- 既有操作 **Schema 零改动**：`node.library.save` / `node.library.list` 保持原样（未动 registry.ts 的内联声明），因此**不需要 `--accept-contract-change`**；本次只是新增操作 → 契约快照由 Lead 统一 `--write` 生成。

**一份业务实现（无外部专用执行器/模拟点击/万能 eval/任意 IPC 转发）**
- `src/main/agent-access/node-library-ops.ts`（新）：compose/update/delete/get/search/insert。实例化把条目翻译成 typed graph 操作，复用既有 `resolvePatchReferences` 预检、`AccessDesktop.run({action:'graph-patch'})` 握手（renderer 校验＋单撤销步原子应用＋`ensureCanvasSaved`）、main 重读核对回执 ID 是否真实落盘——与 `graph.patch` 完全同一条协议，只是操作来源是节点库条目。
- `src/main/agent-access/history-ops.ts`（新）：list/snapshot.create/snapshot.delete/restore.precheck/restore/recovery.precheck/resolve。恢复落盘复用 `projects.saveProject`（与 `restoreRecoveryCopy`、`project.save` 同一正式保存机制），恢复副本复裁决复用 `projects.restoreRecoveryCopy` / `discardRecoveryCopy`；预检令牌复用 service 的 `impactToken` HMAC（本模块不持有密钥，只通过回调取签名并自行比对）。
- `src/main/agent-access/service.ts`：仅**追加** 2 行 import、1 个操作集合常量、1 个 `else if` 分支（带 trace/span 与占用回调）、execute 内 13 个 case 的兜底分支（沿用既有 "在 dispatch 处理" 注释模式）、以及占用豁免条件上的 1 个 `&&` 判据；未重排、未重格式化、未删除任何既有分支。
- `src/main/store/workspace-state.repo.ts`：新增 `getWorkflowTemplate` / `renameWorkflowTemplate`；`saveHistorySnapshot(input, options?)` **新增可选第二参数**（既有 IPC 调用形状不变）写入 `graph_json`；新增 `listHistorySnapshotSummaries`（列表不读大字段）、`readHistorySnapshot`（含 snapshot + graph）。
- 存储：`history_snapshots.graph_json`（迁移 **M23** 由 Lead 统一写入 `db-migrations.ts`；本包不碰迁移文件）。语义="该快照对应的已持久化图数据"（与 project.json 的 nodes/edges/groups 同构），NULL 表示没有可外部恢复的图。**没有**往 tldraw 快照 JSON 里塞业务键（会污染画布快照格式，后续 tldraw 升级有静默丢图风险）。

**兼容性结论**
- 旧客户端发 `node.library.save`（单 chat 节点）行为、输出字段完全不变；旧条目（GUI/旧外部保存的纯结构预设）可被 `node.library.insert` 直接实例化。
- GUI 保存快照：`saveHistorySnapshot` 只在"传入快照与磁盘 `tldrawSnapshot` 逐字节一致"时顺手记录 graph；不一致（画布有未保存编辑）时照旧只存快照，GUI 行为零变化。
- 恢复副本存在时的阻断语义未变（`RESOURCE_BUSY/recovery-ownership`），删除/导出的既有拒绝被本包测试再次证明未被绕过。

**媒体与跨画布隔离**
- 条目记录媒体引用（节点内容媒体 + 配置内"恰好等于源项目媒体 ID"的字符串引用）；实例化时逐份 `readMediaBuffer` → `saveBufferAsset` 复制进目标项目（新 mediaId、路径在 `projects/<目标>/media/`），再把配置里的引用经共享 `remapMediaReferences` 精确重映射。
- 任何 op 的 `media` 只带目标项目的 mediaId；路径/字节由 main 解析注入，外部输入不含路径。
- 准入前失败（宿主拒绝/超时未准入）会**补偿删除**本次已复制的媒体；准入后失败按 `unknown` 保留媒体（可能已被恢复出来的节点引用），不盲目重放。

---

## 四、真实验证证据（本机实际运行）

| 检查 | 命令 | 真实结果 |
| --- | --- | --- |
| 类型 | `npm run typecheck` | 通过（node / web / license-protocol / issuer 全绿，exit 0） |
| 业务动作分母 | `node scripts/audit-business-actions.cjs` | 通过：`171 IPC channels + 35 canvas actions; external ops 77; by phase {"external":76,"F8":25,"F9":44,"excluded":19,"F2":5,"F7":6,"F4":7,"F5":19,"F6":3,"F3":2}` |
| 定向 lint | `npx eslint <本包 8 个文件> --quiet` | 0 error（仓库 `lint` 为 `eslint . --quiet`） |
| 本包测试 | `node scripts/run-vitest.cjs run test/local-agent-node-library-access.test.ts test/local-agent-history-access.test.ts --reporter=verbose` | **11 项全通过**（5 + 6） |
| 接入契约门禁 | `npm run verify:agent-access` | **通过**：`Agent access gate passed: 77 operations; 32 planned nodes.`（exit 0；新增 13 操作由 Lead 统一 `--write` 刷新快照后转绿，本包未自行写仓库快照） |
| 既有接入回归 | `node scripts/run-vitest.cjs run test/local-agent-access.test.ts test/local-agent-graph-access.test.ts test/local-agent-run-access.test.ts test/local-agent-media-access.test.ts test/local-agent-chat-access.test.ts test/graph-patch-plan.test.ts --reporter=dot` | **84 项全通过**（8 文件；含既有 73 项与本包 11 项，含 `blocks stale generated contracts…` 门禁测试） |
| 契约生成确定性（不写仓库文件） | `node scripts/check-agent-access.cjs --write --reason "…" --snapshot-file %TEMP%… --impact-file %TEMP%…` 后 `node scripts/check-agent-access.cjs --snapshot-file … --impact-file …` | 生成 + 复核均通过：`Agent access gate passed: 77 operations; 32 planned nodes.`（证明新增 Schema 可被 `z.toJSONSchema` 稳定生成；仓库快照由 Lead 执行） |

**新增测试覆盖（真实数据级断言，无 mock 业务逻辑）**

`test/local-agent-node-library-access.test.ts`：
1. 组合保存（图片+裁剪+文本，一条 out-image→in-image 连线，媒体 1 份内容媒体 + 1 份配置内引用）→ 插入另一画布：节点数 3／连线数 1／位置=落点+相对偏移／正文与配置一致；插入 ID 全部与源 ID 不同；连线指向新 ID；两路媒体各自复制成目标项目新媒体（路径在目标项目目录），源项目媒体未被搬走；配置内媒体引用已重映射；接收到的宿主载荷只含 mediaId；同一幂等键重放返回原回执、`fake.calls === 1`、画布与媒体数量不变。
2. 旧 `node.library.save` 仍可用：条目只存技能预设（聊天记录/系统提示/模型选择均不入库，已直接读原始 payload 断言），旧条目可被 `insert` 实例化。
3. 删除后 list/search 不再返回、插入已删条目 `NOT_FOUND`；改名生效；按类型/名称/标题过滤。
4. 非法参数（空 nodeIds、超界坐标）、版本不符 `REVISION_CONFLICT`、未打开目标 `ACTIVE_PROJECT_REQUIRED`、损坏条目 `ENTRY_INVALID`（且画布未被改动）。
5. 媒体补偿：准入前宿主拒绝 → `failed` 且目标项目媒体数回到 0（无孤儿）；准入后失败 → `unknown` 且媒体保留。

`test/local-agent-history-access.test.ts`：
1. 快照创建 → 改动画布 → precheck（影响/媒体/阻塞/令牌）→ 恢复：版本 +1、**恢复后的图与快照图逐字段相等**、自动检查点存在且可再恢复；目录/详情不带快照正文；删除后目录不再返回、恢复已删快照 `NOT_FOUND`。
2. GUI 快照：与磁盘一致的快照 `restorable=true` 且可外部恢复；有未保存编辑的快照 `restorable=false`，precheck 报 `SNAPSHOT_WITHOUT_GRAPH`、执行报同一码（GUI 仍可在画布内恢复）。
3. 令牌：无令牌 `IMPACT_CONFIRM_REQUIRED`、伪造 `IMPACT_TOKEN_INVALID`、事实漂移后旧令牌失效且旧图未变、重新预检可重试成功。
4. 打开中的画布：precheck 报 `ACTIVE_PROJECT`、执行 `RESOURCE_BUSY`、版本未变。
5. 恢复副本：存在时 `project.delete` / `project.export` / `project.save` / `history.snapshot.create` / `history.restore` 全部 `RESOURCE_BUSY`、删除预检报 `RECOVERY_COPY`；`history.recovery.resolve` 无令牌/伪造令牌均拒绝；`discard` 后图=磁盘版本、副本移除、写操作恢复；再制造副本后 `use` 落盘（版本 +1、图=副本图、副本移除），随后快照创建正常；副本已不存在时裁决 `NOT_FOUND`。
6. 项目隔离（跨项目快照不可读/删/恢复）、未知项目 `NOT_FOUND`、版本不符 `REVISION_CONFLICT`、无副本时 precheck `exists=false`。

**边界（必须如实保留）**
- 以上是服务级测试（受控 `AccessDesktop` 替身按 `graph.patch` 协议应用并经正式保存落盘，和既有 F2/F6 接入测试同一做法）。**真实 Electron 桌面逐动作验收未做**：需要 `npm run build` 后跑里程碑脚本，由 Lead/f6-desktop 统一执行；本包不宣称 desktop-tested。
- 付费供应商路径与本包无关（未调用任何收费接口）。

---

## 五、日志覆盖与脱敏

- 外部操作生命周期完全复用既有 `agent.access.started/completed/failed/rejected/unknown`（含 operation/phase/code 与 trace/span），**不新增重复终态**。
- 历史恢复复用既有 `project.restore.started / checkpoint_created / completed / failed / cancelled`（main 侧携带 `agent.access` 的 trace/span 与 projectId；`discard` 语义=用户保留磁盘版本 → `cancelled`）。
- 节点库媒体复制复用 `media.buffer_import.started/completed/failed`（只带 byteSize/mime/mediaId/phase）。
- 未新增事件类型：新增事件需要改 `src/shared/observability/events.ts` 注册表（不在本包文件范围），因此刻意只复用已登记事件；覆盖清单见 `docs/LOGGING_COVERAGE.md` 顶部 2026-11-08 小节。
- 脱敏：事件不含条目名称、节点标题、正文、配置、提示词、聊天记录、绝对路径、快照 label；只出现操作 ID、阶段、稳定错误码、受控 mediaId/nodeId/projectId/snapshotId。日志写入失败不改变业务结果（既有 `emitGatewayEvent` 契约）。

---

## 六、未完成 / 仅模拟部分（不得当成已完成）

1. **打开中的画布不能外部恢复**：GUI 在画布内做快照事务（内存 `loadStoreSnapshot` + 自动保存），外部没有等价宿主动作（新增 desktop 动作需要改 `src/shared/agent-access/desktop.ts` 与 renderer 宿主，均不在本包范围）。当前口径：返回 `RESOURCE_BUSY/desktop-ownership`；等 F9 项目生命周期（外部 `project.close`）落地后可按"关闭→恢复→重开"补齐。`canvas.snapshot.save-restore` 的 note 已如实写"仅未打开项目"。
2. **GUI 侧插入仍按纯结构预设清空媒体**（`templateNodeProps` 既有行为，未在本包改动）：外部 insert 会复制媒体并重映射，GUI 插入含媒体引用的新条目时媒体不会带过去。GUI 行为属既有产品口径，若要对齐需单列包（并同时改 renderer 与快照/媒体策略）。
3. **分组（group）不进节点库条目**：graph-patch 没有 group op，且 group 属 Legacy 清单；条目的 `groupCount` 恒为 0，组合保存/实例化只覆盖节点与连线拓扑。
4. **配置内媒体引用靠"字符串恰好等于源项目媒体 ID"识别**（含嵌套 JSON），不做节点类型私有字段枚举；不是媒体引用的同形字符串不会被误改（只精确匹配已登记 ID）。
5. **快照媒体预检只统计图数据里 `content.mediaId`**：配置内嵌媒体引用不在 precheck 的 media 计数内（GUI 的内嵌扫描基于 tldraw 快照，实现路径不同）；恢复本身不因媒体缺失阻断（与 GUI "仍要恢复"一致），回执/precheck 如实给出 missing 数。
6. **真实桌面 / 安装包 / 真实 MCP 客户端**逐动作验收未做（见第四节边界）。
7. 契约快照与 `change-impact.json` 由 Lead 统一 `--write` 刷新（本包未执行 `--write` 版本，也未执行 `--accept-contract-change`：本次只有新增操作，无既有 Schema 变更）；刷新后 `verify:agent-access` 已转绿（见第四节）。
8. 恢复失败仅在"核对不一致"时尝试回退；若回退本身失败，按 `unknown` 保守上报（`RESTORE_VERIFICATION_FAILED`），需用 `run.get`/`graph.get` 核对——该分支未被真实故障注入覆盖。
9. 错误 `phase` 标签：新增操作经既有 `DesktopAccessError → AccessFailure` 映射，除版本冲突（走 `GraphVersionConflictError` → `phase=storage`）外，其余拒绝的 `phase` 统一显示 `desktop-handshake`；稳定错误码与 `detail` 中的具体阶段（如 `restore-admission:…`、`media-copy:…`、`entry-read:…`）是精确的。要按阶段细分 `phase` 需改 service 的 catch 映射（共享文件，超出本包最小追加范围），保留为后续统一整改项。

---

## 七、下一包建议

1. **资源库采集与包传输**（F7 剩余 6 项：`project.exportStructure`、`media.batchExport`、`media.saveRecipe/getRecipe`、`library.captureProjectMedia/captureProjectNodes`）——与节点库同为"跨画布复用"，建议复用本包的媒体复制/重映射工具函数与拒绝语义。
2. **外部项目生命周期 `project.close`/`project.reopen`**（F9 前置）：补齐后即可把"打开中的画布恢复"变成"关→恢复→开"的合法路径。
3. **里程碑脚本补 2 段真实桌面验收**：①组合保存→GUI 面板可见→插入另一画布→GUI 打开后节点/连线/媒体可继续编辑；②快照创建→恢复→检查点回退（含项目未打开口径）。
4. GUI 插入的媒体策略对齐（第 6.2 条）单列包，需同时评估 `templateNodeProps` 与素材资源（captureLibraryNodes）两条路径。
