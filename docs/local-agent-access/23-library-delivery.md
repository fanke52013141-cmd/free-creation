# F7 资源库外部接入交付台账（library 族）

日期：2026-11-08 · 负责人：f7-library · 共享任务：task-2
状态：**契约 + main 实现 + 服务级测试已完成**；真实 Electron 画布端到端、安装包与付费/外部依赖未在本包验收。
本文件是逐动作交付记录，不是“资源库全部接通”的声明；未完成项见 §8。

## 1. 范围与改动文件

本包把资源库的 GUI 业务动作（`src/main/ipc/library.ipc.ts` + 资源库页面实际调用）开放为外部操作，
全部复用同一 store 服务，没有外部专用执行器、没有模拟点击、没有万能 eval、没有任意 IPC 转发。

| 文件 | 改动 |
| --- | --- |
| `src/shared/agent-access/ops/library.ts` | 新增 20 项操作登记（effect/description/input）与成对输出 Schema（`z.object().strict()`）；既有 `library.search` / `library.create_resource` 未动 |
| `src/main/agent-access/library-ops.ts` | **新建**：资源库族唯一实现入口（输入装配、规则复用、物化编排、补偿、回执投影） |
| `src/main/agent-access/service.ts` | 仅最小追加：1 行 import + 一个分组 `case`（20 个操作标签委托到 `runLibraryOperation`），未重排/未删除既有分支 |
| `src/main/store/library.repo.ts` | 纯追加 + 1 处缺陷修复：导出 `validatePresetContents`（供外部前置校验复用同一规则）、新增只读 `listResourceUsages`、修复 `deleteResource` 的 blob 清理路径（见 §9） |
| `src/main/store/library-categories.repo.ts` | 纯追加：`latestCategoryVersion`（把版本漂移判为冲突而不是覆盖） |
| `src/main/store/library-materialization.repo.ts` | 纯追加：`recordMaterializedNodes`（物化成功后回填节点绑定，仅更新本项目 usage 行） |
| `test/local-agent-library-access.test.ts` | **新建**：13 项服务级测试（见 §7） |
| `docs/local-agent-access/action-coverage.json` | 19 个 `ipc.library.*` 键改为 external 并登记外部操作名；`captureProjectMedia/captureProjectNodes` 仍为 F7 并写理由；`ipc.library.import/export` 留给 task-3 |
| `docs/LOGGING_COVERAGE.md` | 追加本族日志覆盖与脱敏小节 |
| `docs/local-agent-access/23-library-delivery.md` | 本文件 |

未触碰：`src/shared/agent-access/registry.ts`（含包导入黑名单，task-3 所有）、`src/**/desktop.ts`（桌面协议由 F6 发布族扩展）、
`src/renderer/**`、`src/main/ipc/**`、`package.json`、`electron-builder.yml`、`src/main/gateway/*` 等其它进行中改动。

## 2. 业务动作分母与三入口状态

资源库族分母 = `src/main/ipc/library.ipc.ts` 的 **23 个 IPC 动作**（画布级动作里没有资源库专属项）。
CLI 与 MCP 由同一 Registry 生成，因此两列状态恒等；“GUI”列指该动作在页面上是否可达。

| # | IPC 动作（GUI 入口） | 外部操作 | GUI | CLI | MCP | 边界/说明 |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | `library:search`（资源库检索/自动翻页） | `library.search`（既有）+ `library.resource.list` | 可达 | external | external | 旧契约不变；新增列表支持分类/文件夹/集合/类型/归档过滤 |
| 2 | `library:detail`（资源详情抽屉） | `library.resource.get` | 可达 | external | external | 组件摘要+修订+使用记录；正文需显式 `includeText` |
| 3 | `library:create`（新建资源表单） | `library.resource.create` | 可达 | external | external | 文本/图片/音频/视频/文件/JSON 全类型组件；可带分类/标签/集合/文件夹/变更说明 |
| 4 | `library:publish-revision`（编辑资源=新版本） | `library.resource.publish` | 可达 | external | external | 省略字段沿用基础版本；`components` 省略时复用基础版本全部组件 |
| 5 | `library:delete`（详情删除 / 批量逐项删除） | `library.resource.delete` + `library.resource.delete_many` | 可达 | external | external | 批量逐项回执；GUI 批量是逐项调用同一服务 |
| 6 | `library:archive`（页面已无入口，IPC/repo 仍在） | `library.resource.archive` | **无页面入口** | external | external | 2026-11-06 用户裁决“不归档、删除即彻底删除”；外部同源提供可逆隐藏，`includeArchived` 可查回（见 §8 决议项） |
| 7 | `library:categories:list`（分类页签/编辑器） | `library.category.list` | 可达 | external | external | 返回槽位蓝图，供创建时 `metadata.librarySlotId` 映射 |
| 8 | `library:categories:save`（新建/编辑分类） | `library.category.save` | 可达 | external | external | 版本必须=基础版本+1，漂移返回 `REVISION_CONFLICT` |
| 9 | `library:folders:list` | `library.folder.list` | 可达（夹树） | external | external | |
| 10 | `library:folders:create` | `library.folder.create` | 可达 | external | external | 同上级重名 `FOLDER_CONFLICT` |
| 11 | `library:folders:rename` | `library.folder.rename` | 可达 | external | external | 同上 |
| 12 | `library:folders:delete` | `library.folder.delete` | 可达 | external | external | 子夹与资源上移，不删资源 |
| 13 | `library:folders:set-resource`（资源归夹） | `library.resource.set_folder` | 可达 | external | external | `folderId=null` 回根目录 |
| 14 | `library:collections:list` | `library.collection.list` | 可达 | external | external | |
| 15 | `library:collections:create` | `library.collection.create` | 可达 | external | external | 重名 `COLLECTION_CONFLICT` |
| 16 | `library:collections:set` | `library.resource.set_collections` | 可达 | external | external | 整体替换，空数组清空 |
| 17 | `library:preview-files`（复用预检） | `library.resource.preview_files` | 可达（加入画布前预检） | external | external | 只报缺失组件，不复制文件 |
| 18 | `library:materialize`（资源→画布节点） | `library.resource.materialize` | 可达（拖拽/加入画布对话框） | external | external | `materializeResource` 复制受控媒体 → 现有 `graph-patch` 桌面握手 + 保存屏障 |
| 19 | `library:materialize:discard`（物化失败补偿） | `library.materialization.discard` | 可达（插入失败时自动补偿） | external | external | 按 `usageId`+项目归属核对；跨项目/已清理返回 `NOT_FOUND` |
| 20 | `library:capture-project-media`（画布→资源库） | — | 可达 | **未开放** | **未开放** | 属“资源捕获”专项（项目素材/节点快照入库 + 图形谱系校验），不在本包验收范围 |
| 21 | `library:capture-project-nodes`（画布→资源库） | — | 可达 | **未开放** | **未开放** | 同上 |
| 22 | `library:export`（资产包导出） | `library.export` | 可达 | task-3 | task-3 | 归 F7 包传输包（f7-transfer），本族不重复登记 |
| 23 | `library:import`（资产包导入） | `library.import` | 可达 | task-3 | task-3 | 同上（包导入黑名单由 task-3 按 F7 放行） |

计数：**20 项外部操作**（原计划口径写 19 项，实现时 `materialization.discard` 与 `resource.materialize` 分列为两项，最终 20 项）/
23 个 IPC 动作中 19 个已 external；4 个未接（2 捕获 + 2 包传输归 task-3）。
Registry 当前总计 “77 operations; 32 planned nodes”（含其它 F7 包并行新增），既有 37 项 Schema 逐字节未变（见 §4）。

## 3. 公共实现（一份业务实现）

| 外部操作 | 复用的既有业务实现 | 外部独有的边界职责 |
| --- | --- | --- |
| `library.resource.list` | `searchResources` | 投影字段白名单（不含正文/路径） |
| `library.resource.get` | `getResourceDetail` + `listResourceUsages` | 正文开关、引用字段安全化 |
| `library.resource.preview_files` | `getResourceDetail` + 数据目录文件存在性 | 组件归属校验 |
| `library.resource.create` | `validatePresetContents`（repo 同一函数）+ `pinCategory`/`validateCategoryContent`（共享蓝图）+ `createResource` | 本机文件读取（绝对路径/1B–128MB）、扩展名→MIME、元数据 64KB |
| `library.resource.publish` | `publishRevision`（含 `reuseComponentId` 组件复用） | 省略字段继承、归档/版本预检 |
| `library.resource.delete` / `delete_many` | `deleteResource` | 逐项回执 |
| `library.resource.archive` | `archiveResource` | 无（与 IPC 同参） |
| `library.resource.set_folder` | `setResourceFolder` | 无 |
| `library.resource.set_collections` | `setResourceCollections` | 无 |
| `library.folder.*` | `listFolders/createFolder/renameFolder/deleteFolder` | 重名预判（`FOLDER_CONFLICT`） |
| `library.collection.*` | `listCollections/createCollection` | 重名预判（`COLLECTION_CONFLICT`） |
| `library.category.*` | `listCategories/saveCategory` + `latestCategoryVersion` | 版本漂移判定 |
| `library.resource.materialize` | `planResourceNodes`（共享蓝图）+ `materializeResource`（复制受控媒体/产物配方重映射）+ 现有 `graph-patch` 桌面握手（renderer 权威 `planGraphPatch` + 保存屏障） | 版本预检、`mediaResolutions` 注入、回执节点核对、准入前补偿 |
| `library.materialization.discard` | `discardMaterialization` | 无 |

物化链路（与 GUI 同源，不直写项目文件）：
`组件选择 → planResourceNodes（分类槽位/配方变量/JSON 校验） → materializeResource（读资源 blob→写 projects/<id>/media、写 library_usages、artifactRecipe 重映射） → desktop.run({action:'graph-patch', ops:[node.create…], mediaResolutions}) → renderer 整批校验+准入+单撤销步应用+ensureCanvasSaved → main 重读 project.json 核对节点ID与 mediaId → 回填 usage 节点绑定 → 回执`。
GUI 侧同一链路的差异只有呈现层：`meta.librarySource` 标签、tldraw 分组、确认对话框。**外部物化只保证“节点业务字段 + 受控媒体引用”与资源一致，不编排库来源标记与分组**（见 §8）。

## 4. 契约与兼容

- 纯追加：既有 37 项操作的 input/output Schema 与 `docs/local-agent-access/generated/contracts.json` **逐字节一致**（校验脚本输出 `changed existing: 0`），因此本包**不需要** `--accept-contract-change`；新增操作不需要版本升级。
- 既有 `library.search` / `library.create_resource` 语义与字段完全保留（旧客户端兼容）；增强检索与全类型创建用新 ID（`library.resource.list` / `library.resource.create`）。
- 批量删除不改变单项删除语义：`library.resource.delete_many` 内部逐项调用同一 `deleteResource`，回执含每项 `deleted/code`。
- 版本/冲突：修订 `REVISION_CONFLICT`、分类 `REVISION_CONFLICT`、归档资源发布 `RESOURCE_ARCHIVED`、文件夹/集合重名 `FOLDER_CONFLICT`/`COLLECTION_CONFLICT`、非法输入 `INVALID_INPUT`。
- 物化的 `expectedGraphVersion` 与 `graph.patch` 同义：活动画布有未保存编辑时宿主先保存再核对，版本前进即 `REVISION_CONFLICT`（客户端重读后重试，不静默覆盖）。

## 5. 幂等、失败与补偿

- 写操作全部沿用 dispatch 幂等账本：同键同参重放返回原回执、不重复副作用；同键异参 `IDEMPOTENCY_CONFLICT`；过期 `IDEMPOTENCY_EXPIRED`。
- 物化：**准入前**失败（宿主校验拒绝/资源忙/版本冲突）→ 立即 `discardMaterialization` 删除本次复制的项目媒体，回执 `failed`，画布与媒体都无残留；**准入后**失联（超时/宿主异常/核对不一致）→ `unknown`（`OUTCOME_UNKNOWN`），**不删除**可能已被节点引用的媒体，交由 `project.open`+`graph.get` 核对；已回填到 usage 的媒体可用 `library.materialization.discard` 按 `usageId` 清理。
- 批量删除：单项异常只影响该项回执（`DELETE_FAILED`），不静默删/改成功项。
- 资源包导入导出、项目包导入不在本族（task-3）。

## 6. 日志覆盖与脱敏

- 复用 dispatch 的 `agent.access.started/completed/failed/unknown/rejected`（`attributes.operation`/`phase`/`code`），未新增事件类型；
  GUI 既有 `library.*` 域事件保持不变。
- 新增关键路径（物化）复用既有事件族：`library.materialization_completed`（operation/phase/nodes/assets）与
  `library.materialization_failed`（operation/phase/cleanup），不记录资源标题、正文、文件名或路径。
- 脱敏：回执与事件只含受控 ID、sha256、MIME、尺寸、修订号、节点 ID；不含导入源路径、blob/媒体相对路径、正文。
  测试断言事件序列化串不含临时数据目录、资源标题/描述、源文件名。
- 日志写入失败不改变业务结果（`emitGatewayEvent`/`emitDomainEvent` 内部 catch）。
- 明细见 [LOGGING_COVERAGE.md](../LOGGING_COVERAGE.md) 的「2026-11-08 资源库外部接入」小节。

## 7. 真实验证证据

本机 Windows PowerShell 5.1，数据目录隔离（`CANVAS_DATA_DIR` 临时目录），测试经 `node scripts/run-vitest.cjs`（Electron 运行时）。

| 检查 | 命令 | 真实结果 |
| --- | --- | --- |
| 新增资源库测试 | `node scripts/run-vitest.cjs run test/local-agent-library-access.test.ts --reporter=dot` | **13 passed / 13**（exit 0） |
| 既有接入回归 | `node scripts/run-vitest.cjs run test/local-agent-library-access.test.ts test/local-agent-access.test.ts test/local-agent-graph-access.test.ts test/local-agent-run-access.test.ts test/local-agent-media-access.test.ts test/local-agent-chat-access.test.ts test/graph-patch-plan.test.ts --reporter=dot` | **85 passed / 1 failed**；唯一失败在 `test/local-agent-access.test.ts`（`blocks stale generated contracts…`），原因是勾库 `generated/contracts.json` 未刷新，刷新生效后恢复（见下） |
| 契约门禁（临时快照，不动共享产物） | `node scripts/check-agent-access.cjs --write --reason "…" --snapshot-file <TEMP>/…` 后只读复跑同一对临时文件 | `Agent access gate passed: 77 operations; 32 planned nodes.`（两次均 exit 0） |
| 既有契约兼容 | 对比勾库快照 37 项 vs 当前 Registry | `changed existing: 0`；`added: 40`（其中本族 20 项） |
| 业务动作分母 | `node scripts/audit-business-actions.cjs` | 覆盖登记合法（无 `MISSING_COVERAGE`/`UNKNOWN_EXTERNAL_OP`/`EXTERNAL_WITHOUT_MAPPING`/`STALE_ACTION`）；仅提示 `Action inventory is stale`（生成物由 Lead 统一 `--write`） |
| 类型检查 | `npm run typecheck`（node+web+model+license+issuer） | **exit 0**（并行包中途曾出现其文件的临时错误，其页面已收口；复跑全绿） |
| 日志旁路门禁 | `npm run verify:logging` | `logging gate passed: 本批变更无日志旁路，新增网络路径均已接入诊断`（exit 0） |
| 已注册共享快照刷新（Lead 统一执行） | `npm run verify:agent-access` | 当前如实失败于 `Generated contract is stale`：`generated/contracts.json` 与 `generated/action-inventory.json` 尚未由 Lead `--write`；本族**不**越权写共享产物，临时快照复跑已证明刷新后可通过 |

测试覆盖口径（`test/local-agent-library-access.test.ts`，13 项）：
1. 六类组件创建 + 默认不回正文 + `includeText` 读正文 + 修订/使用记录字段 + 不存在资源 `NOT_FOUND`；
2. 修订发布继承元数据/复用组件 + 旧基础版本 `REVISION_CONFLICT`；
3. 归档/取消归档 + 检索过滤 + 归档资源拒绝发布；
4. 删除后无残留（资源/修订/组件/标签/集合/文件夹/使用记录/索引行全清、磁盘 blob 删除、重复删除 `NOT_FOUND`）；
5. 分类蓝图归属 + 槽位引用 + 文件夹/集合归属 + 必填槽位缺失拒绝 + 归夹/清空 + 重名/重命名/删夹（资源上移）；
6. 分类蓝图版本保存 + 版本漂移冲突 + 版本号非法；
7. 批量删除逐项回执（2 成功 1 `NOT_FOUND`，保留资源不受影响）；
8. 幂等重放只创建一次 + 同键异参冲突；
9. 非法参数矩阵（相对路径/缺正文/正文带路径/坏 JSON/预设不匹配/扩展名与类型不符/文件不存在/空批量）且不留资源；
10. 跨项目越权：非活动项目物化 `ACTIVE_PROJECT_REQUIRED` 且不留媒体、版本不符 `REVISION_CONFLICT` 且不留媒体、错误项目补偿清理 `NOT_FOUND`；
11. 物化全链路：媒体重映射到 `projects/<id>/media/`、桌面载荷只有 mediaId、节点引用=资源字节、`graphVersion+1`、usage 回填节点数、幂等重放不重复复制/建节点；
12. 准入前宿主拒绝 → `failed` + 媒体补偿清零；准入后失联 → `unknown` + 媒体保留 + `discard` 可清理；
13. 接入诊断脱敏（事件串不含数据目录/标题/描述/文件名，completed 事件带 operation/phase）。

`test/local-agent-access.test.ts` 的唯一失败项（**非本族引入**）：
- `blocks stale generated contracts and unacknowledged protected-source changes`：勾库 `generated/contracts.json` 尚未刷新（Lead 统一 `--write`），脚本先报 `Generated contract is stale`，第二条断言（`Protected source changed`）因此不可达；刷新后恢复。该文件此前的另外两项（`project.import` 不在操作表 / 期望 `UNSUPPORTED_OPERATION`）已由 task-3 按 F7 放行口径更新，复跑已通过。

## 8. 未完成 / 仅模拟 / 未实测（不得当作已验收）

1. **真实 Electron 画布端到端未跑**：本包物化用服务级受控宿主替身验证（替身只承担 renderer「按 ops 建 shape + 保存」这一侧，媒体复制/载荷/核对/回执均由真实 main 代码完成）。
   真实桌面需 `npm run build` + 里程碑脚本，由 Lead 在集成阶段执行（本包未 build，避免共享 `out/` 冲突）。
2. **物化的呈现层差异**：外部物化不写 `meta.librarySource`、不建 tldraw 分组、不弹确认框；节点业务字段、受控媒体引用、保存版本与 GUI 一致。
   若产品要求库来源可追溯，需要新增渲染侧握手动作（`materialize-resource` 直接复用 `insertResource`），属下一包，不在本包发明。
3. **资源捕获（画布→资源库）未开放**：`captureProjectMedia` / `captureProjectNodes` 仍为 F7，理由见 §2；需要与图形谱系校验、节点快照归档策略同包验收。
4. **归档语义待产品决议**：GUI 页面自 2026-11-06 已无归档入口（“删除即彻底删除”），本包按“IPC/repo 仍在→同源开放可逆归档”处理并在覆盖台账写明；若产品决定彻底移除归档，应同时下线 IPC、repo 与外部操作（本包不做单方面删除）。
5. **批量的导出**归 task-3（`library.export`）；本包只做批量删除。
6. **失败细分**：`create/publish` 的写入失败码沿用 GUI 语义（`CREATE_FAILED`/`REVISION_FAILED`），规则错误统一 `INVALID_INPUT`（阶段 `library-validate` 可区分）；未按字段做更细的机器错误子码。
7. **并发/多画布**：物化沿用当前串行口径（单 mutating 标志 + 活动画布唯一宿主），未验证两画布同时物化；属 F8。
8. **付费/外部依赖**：资源库族不触发模型请求，无付费路径；未做真实供应商验证（也不适用）。

## 9. 发现的既有缺陷与修复

- `library.repo.deleteResource` 在清理无引用 blob 时执行 `rmSync(blob.path)`，而 `blob.path` 是**相对数据目录**的受控路径
  （`library/blobs/xx/<sha>.ext`），相对进程 cwd 删除导致删除资源后磁盘残留孤儿文件。已改为
  `rmSync(isAbsolute(blob.path) ? blob.path : join(getDataDir(), blob.path), { force: true })`，兼容历史绝对路径行；
  清理失败仍不影响数据库删除结果。三入口（GUI 删除 / 外部单删 / 外部批删）同源受益。
- `library.repo.validatePresetContents` 由文件内函数改为导出，供外部创建/修订在写库前用**同一份规则**给出 `INVALID_INPUT`，
  避免在接入层复制校验规则造成漂移；函数体未改。

## 10. 下一包

1. 渲染侧 `materialize-resource` 握手动作（复用 `insertResource`，补齐 `meta.librarySource` 与分组、确认语义），并跑真实桌面里程碑。
2. 资源捕获族（项目素材/节点快照入库）与图形谱系校验。
3. `create/publish` 字段级错误子码（配合 CLI 自纠错），以及物化在多画布并发下的按项目锁。
4. 归档语义的最终产品决议与三入口一致下线/保留。
