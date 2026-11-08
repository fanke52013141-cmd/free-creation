# F7 包传输外部接入交付台账（project.import / project.importStructure / library.import / library.export）

日期：2026-11-08。负责人：f7-transfer（task-3）。仓库：`canvas-studio/source`（main，基线提交 `94c8bbb` 之后的工作区；本包不提交、由 Lead 统一收口）。
依赖范围：`AGENT_PARITY_SPEC.md` §5/§6、`AGENTS.md`「本地数据安全」、`docs/local-agent-access/15-gui-cli-mcp-parity-plan.md` §4.4/F7、`LOGGING_SPEC.md`。

> 本文件是**交付台账，不是完成声明**。真实桌面端到端、安装包与诊断包脱敏仍按下节“未完成”边界执行。

---

## 一、结论与三入口状态

四项外部操作已登记、实现并完成服务级独立验收；业务实现全部复用 GUI 现有导入/导出服务，**没有外部专用执行器、模拟点击、万能 eval、任意 IPC 转发或直写项目快照/SQLite**。

| 业务动作 | GUI 入口（现状） | CLI | MCP | 外部操作 | 实现位置 |
| --- | --- | --- | --- | --- | --- |
| 导入项目包 | 项目页「导入项目备份」`project:import`：文件对话框 → `importProject()`（暂存/校验/重映射/事务） | `project.import`（Registry 自动生成，`--input-file` 传 `{input:{filePath},idempotencyKey}`） | 工具 `project_import`（`src/local-agent/index.ts` 从同一 Registry 生成） | `project.import` | `src/main/agent-access/transfer-ops.ts` → `store/transfer.importProject` |
| 导入结构包 | 画布传输菜单「导入画布结构」`project:import-structure`：对话框 → `importCanvasStructure()`（新项目、清洗） | `project.importStructure` | 工具 `project_importStructure` | `project.importStructure` | `transfer-ops.ts` → `store/canvas-structure-transfer.importCanvasStructure` |
| 导入资源包 | 资源库「导入资产包」`library:import`：对话框 → `importResourcePackage()`（清单/哈希校验 + 单事务） | `library.import` | 工具 `library_import` | `library.import` | `transfer-ops.ts` → `store/library.repo.importResourcePackage` |
| 导出资源包 | 资源库「导出资产包」`library:export`：对话框 → `exportResourcePackage()` | `library.export` | 工具 `library_export` | `library.export` | `transfer-ops.ts` → `store/library.repo.exportResourcePackage` |

三入口一致性说明：GUI 的“文件对话框选择”按 `AGENT_PARITY_SPEC.md` §6 以**明确受控路径**等价替代；CLI/MCP 与 GUI 进入同一个 main 服务函数，校验、幂等、失败语义、回执字段来自同一实现。CLI/MCP 命令目录由 `ACCESS_OPERATIONS` 自动生成（`src/local-agent/index.ts`），本包未手写第二个执行器。

本包同时收口的前置事实：`project.export`（完整项目包导出，sha256/字节数、缺失媒体拒绝、排他落位）是 F7 之前已验收的操作，本包以它为往返起点；`project.exportStructure`（画布结构导出）**未开放**，原因见第七节。

## 二、公共实现与外部边界

### 2.1 复用（不复制逻辑）

- 项目包：`src/main/store/transfer.ts` 的 `exportProject` / `importProject`。暂存目录 `<projects>/<newId>.importing`、版本检查、`media/*` 条目校验、媒体 ID/相对路径重映射（`remapMediaReferences` + `completeTransferMediaMap` + `prepareFlowImport`）、凭据剥离（`stripTransferCredentials`）、目录 rename + SQLite 单事务提交、失败回滚（删正式目录或暂存目录）全部沿用原实现，本包**未改**该文件。
- 结构包：`src/main/store/canvas-structure-transfer.ts` 的 `importCanvasStructure`。解析/清洗（媒体引用、运行结果、聊天正文、资产）与“新项目 + 事务 + 失败删项目/目录”沿用原实现，本包**未改**该文件。
- 资源包：`src/main/store/library.repo.ts` 的 `importResourcePackage` / `exportResourcePackage`（清单格式/版本、重复包哈希、逐文件大小+sha256、 `library_imports` 记录、DB 单事务、512MB/条目上限）沿用原实现，本包**未改**该文件。
- 幂等/准入/占用/授权：沿用 `LocalAccessService.dispatch` 的幂等账本（同键同参重放原回执、同键异参 `IDEMPOTENCY_CONFLICT`）、单写锁与授权守卫。

### 2.2 外部入口新增的边界职责（`src/main/agent-access/transfer-ops.ts`）

1. **受控目录**：导入只接受服务启动时 realpath 固定的受控导出目录 `<dataDir>/agent-exports` 内的普通包文件。先词法包含判断、再 realpath 包含判断（防符号链接逃逸）；越界/穿越返回 `PATH_NOT_ALLOWED`，不存在返回 `NOT_FOUND`，扩展名不符/空输入返回 `INVALID_INPUT`。相对路径与绝对路径都可用，但 realpath 后必须仍在受控目录内。
2. **不覆盖**：资源包导出先写目录内隐藏临时文件 → `fsync` → `linkSync` 排他落位；目标已存在返回 `OUTPUT_EXISTS`，成功回执 `overwritten:false` + `sha256` + `byteSize` + `resourceCount`。
3. **提交后核对**：项目导入返回前重新读取项目（`getProject/openProject`），逐个核对媒体索引对应文件存在、大小一致；不一致时删除刚导入的项目与暂存残留并返回 `STORAGE_INCONSISTENT`（该失败不伪装成已提交）。资源包导入核对导入前后资源数差与回执一致。
4. **错误分类**：把底层入参/内容错误映射为稳定外部码（`PACKAGE_INVALID / PACKAGE_VERSION_UNSUPPORTED / PACKAGE_CONTENT_INVALID / PACKAGE_PATH_INVALID / PACKAGE_TOO_LARGE / PACKAGE_HASH_MISMATCH / PACKAGE_DUPLICATE / IMPORT_FAILED / LIBRARY_IMPORT_FAILED`），`detail` 只放固定阶段/代码，不含路径、包内容或凭据。
5. **边界回执**：导入回执含新项目元信息、节点/连线/分组/媒体数量、缺失媒体数、包 `sha256`/`byteSize`、`committed:true`；结构包回执含数量与哈希；资源包导出/导入回执见上。

### 2.3 关于“是否接受任意本机路径”

`project.import` **不接受任意本机路径**：输入只有一个 `filePath`，它必须落在受控导出目录内（见 2.2 第 1 条），这是对 GUI 文件对话框的等价替代，不是新的任意文件读取入口。`media.import` 的“任意绝对路径”是 F4 已验收的素材登记语义（只读入文件并登记为项目媒体），与本包无关。GUI 通道本身（项目页/资源库对话框）保持原样，外部入口在 main 层收紧到受控目录。

### 2.4 输入/输出契约

- 登记：`src/shared/agent-access/ops/transfer.ts` 的 `TRANSFER_OPERATIONS` + `TRANSFER_OUTPUTS` 成对，输入 `z.object().strict()`；输出为 `z.object().strict()`，由 `registry.ts` 的 `satisfies Record<AccessOperationId, z.ZodType>` 强制成对。
- `project.import` / `project.importStructure` / `library.import` effect=`write`（需幂等键）；`library.export` effect=`export`（需幂等键）。四个操作均无新增输入路径字段。
- 命名说明：`project.importStructure` 为既有黑名单/GUI 通道同名操作 ID（camelCase）。`scripts/audit-business-actions.cjs` 原操作 ID 解析正则只接受小写（`[a-z_.]+`），会导致该 ID 无法被审计识别；本包把它改为 `[a-zA-Z_.]+`（一行、无其他行为变化），否则审计脚本会误报 `UNKNOWN_EXTERNAL_OP`。此脚本改动请 Lead 在发布说明中复核。

## 三、导入安全独立验收证据

测试文件：`test/local-agent-transfer-access.test.ts`（9 项，全部通过；harness 与 `local-agent-chat-access.test.ts` 同层，`CANVAS_DATA_DIR` 隔离临时目录，真实 SQLite + 真实文件系统）。

| 验收点 | 用例 | 断言事实 |
| --- | --- | --- |
| 导出→导入往返 | `remaps nodes/edges/groups/snapshot/recipe media…` | 节点/连线/分组 ID 全部换新且连线端点一致；图片节点 `content.mediaId`、`params.mediaPath` 指向新项目；`tldrawSnapshot` 中 node-card 的 `props.mediaId/mediaPath` 与 `meta.nodeResult` 的 `frame.mediaId/mediaPath/referenceMediaIds` 全部重映射；导演台 `config.shots[0].referenceMediaIds` 重映射；产物配方 `mediaId/paramsJson/inputMediaIds` 重映射而 `fullPrompt` 原样保留；导入项目以导入版本为乐观锁保存成功（可编辑）；引用计数/缺失媒体 0 |
| 媒体可读且不混用 | 同上 + `creates one project per package…` | 新项目媒体文件按 `projects/<新项目>/media/<新ID>.png` 落盘且字节与源一致；源项目媒体路径不变仍可读；同一包导入两次得到两个项目，媒体 ID/路径互不相同、各自可读 |
| 密钥剥离（导出侧） | `strips provider credentials…` | 源项目 `params.config`、`tldrawSnapshot` props/meta.nodeResult 写入 `apiKey`/`api_token`；导出包每个 zip 条目（含 project.json/recipes.json）均不含明文密钥 |
| 密钥剥离（导入侧） | 同上 | 手工构造含 `providers:[{apiKey}]`、config/nodeResult 内嵌密钥的“恶意包”放入受控目录后导入，新项目 `project.json` 不含明文密钥/`Bearer`；事件日志序列化串不含密钥 |
| 损坏包拒绝 | `rejects damaged or incompatible project packages…` | 缺 `project.json` → `PACKAGE_INVALID`；版本 v99 → `PACKAGE_VERSION_UNSUPPORTED`；flow 资产 digest 与 value_json 不符 → `PACKAGE_CONTENT_INVALID`；媒体子目录路径 → `PACKAGE_PATH_INVALID`；重复媒体 ID → `PACKAGE_CONTENT_INVALID`（detail `FLOW_TRANSFER_MEDIA_DUPLICATE`） |
| 失败清理 | 同上 | 五次失败后 `projects` 表计数 0、`projects.list.total=0`、`projects/` 下无 `*.importing` 暂存目录（失败发生在暂存阶段也被清理）；每次失败都有 `agent.access.failed` 终态且 `attributes.operation=project.import` |
| 幂等重放 | `replays the same idempotency key…` | 同一 key 连续两次 `project.import`：第二次 `completed` 且 data 与第一次完全相等，项目总数只 +1，无暂存残留 |
| 受控路径边界 | `rejects package paths outside…` | 受控目录外绝对路径、`../`、`nested/../../` 均返回 `PATH_NOT_ALLOWED`（即使目标不存在也不暴露目录外存在性）；目录内不存在 → `NOT_FOUND`；错误扩展名/空输入 → `INVALID_INPUT`；结构包/资源包同样拒绝目录外路径 |
| 结构包导入 | `imports a cleaned structure package…` | 导入为新项目（名称带「（导入）」），节点/连线/分组计数正确、`graphVersion=1`；结构包内 `apiKey`、`mediaPath`、图片 shape/asset、用户正文全部清除，node-card 媒体字段为空串、`meta={}`；错误扩展名/版本不兼容/非 JSON/图数据无效分别拒绝且不新增项目 |
| 资源包导出回执 | `exports a resource package with hash receipt…` | 回执 `overwritten:false`、`resourceCount=1`、路径在受控目录内、磁盘字节数一致、sha256 与回执一致；重复文件名 → `OUTPUT_EXISTS`；`../` 文件名 → `INVALID_INPUT`；未知资源 ID → `NOT_FOUND` |
| 资源包导入/重复/损坏 | 同上 + `rejects corrupted resource packages…` | 受控目录内绝对路径导入成功、`packageSha256` 与导出回执一致、资源数 +1 且 `library.search` 可见两份同名资源、新 ID 不同；同内容包再导入 → `PACKAGE_DUPLICATE` 且资源数不变；清单版本 99 → `PACKAGE_VERSION_UNSUPPORTED`；缺清单 → `PACKAGE_INVALID`；blob 同长度篡改 → `PACKAGE_HASH_MISMATCH`；失败后资源数、`library_imports` 记录均为 0 增量 |

说明：`library_imports` 是资源包导入的“已提交”账本，失败用例断言其无新增记录，证明 DB 事务回滚生效。

## 四、PACKAGE_IMPORT_BLOCKLIST 解黑

`src/shared/agent-access/registry.ts`（本包 scope 内唯一允许的集合增删）已从黑名单移除并开放：

- `project.import`（依据：第三节项目包用例 + 暂存/重映射/密钥剥离/失败清理）；
- `project.importStructure`（依据：结构包用例与清洗断言）；
- `library.import`（依据：资源包导入/重复/损坏回滚用例）。

仍阻断并保留在 `PACKAGE_IMPORT_BLOCKLIST`（附理由写在源码注释）：

- `keys.importProviders`：供应商凭据包导入会越过密钥库/设备授权边界（涉及解密、设备绑定与明文凭据生命周期），必须按 F9「受控凭据配置」独立设计与验收，不能借项目/资源包通道旁路。
- `workspace.import`：工作区导入涉及跨项目合并、冲突裁决与运行/审核事实边界，当前没有与 GUI 同源的合并服务，须在 F8/F9 单独验收。

同时 `capability.list.limitations` 移除了已失真的 `NO_PROJECT_IMPORT`（Lead 授权，仅删该项）。

## 五、日志覆盖与脱敏

详见 `docs/LOGGING_COVERAGE.md` 的 2026-11-08 包传输小节。要点：

- 开始/终态复用 dispatch 的 `agent.access.started/completed/failed/unknown`，`attributes.operation` 为操作 ID、`phase` 为 `package-path/project-import/project-import-verify/structure-import/structure-import-verify/library-import/library-import-verify/library-export`、`code` 为稳定回执码；**不新增事件、不重复终态**。
- GUI 既有 `project.transfer.*`、`library.transfer.*` 事件保持原样，外部路径不双写。
- 不记录包路径/文件名、包条目内容、标题、提示词、媒体字节或凭据；测试断言事件串不含明文密钥、包文件名与提示词。
- 日志写入失败不改变导入/导出结果（底层 `emitGatewayEvent` 内部 catch）。

## 六、验证命令与真实输出（2026-11-08 本工作区）

1. `node scripts/run-vitest.cjs run test/local-agent-transfer-access.test.ts --reporter=dot`
   → `Test Files 1 passed (1)` / `Tests 9 passed (9)`。
2. `npm run typecheck`（node/web/license-protocol/issuer 四段）→ `EXIT=0`，无错误。
3. `node scripts/audit-business-actions.cjs`
   → 外部操作分母 63；业务动作映射**无** `UNKNOWN_EXTERNAL_OP`（修复 camelCase 解析后）。当前只剩 `Action inventory is stale; run audit-business-actions.cjs --write`：聚合产物由 Lead 统一 `--write`（本包按约定不写聚合快照）。
4. `node scripts/run-vitest.cjs run test/local-agent-transfer-access.test.ts test/local-agent-access.test.ts test/local-agent-graph-access.test.ts test/local-agent-run-access.test.ts test/local-agent-media-access.test.ts test/local-agent-chat-access.test.ts test/graph-patch-plan.test.ts --reporter=dot`
   → `Test Files 1 failed | 6 passed (7)` / `Tests 1 failed | 81 passed (82)`。唯一失败是 `local-agent-access.test.ts` 的“blocks stale generated contracts…”：它先断言 `Generated contract is stale`，当前 `docs/local-agent-access/generated/contracts.json` 尚未由 Lead 统一刷新，脚本先于“Protected source changed”断言退出；**待 Lead `check-agent-access.cjs --write` 刷新快照后该用例应恢复**（不涉及本包业务断言）。
5. `npm run verify:agent-access`
   → 当前失败 `Error: Generated contract is stale; update registry, compatibility and evidence together`（同上，聚合快照/影响哈希由 Lead 统一生成；本包注册表与 dispatch 已定稿）。
6. `node scripts/check-logging-bypass.mjs` 未单独运行；本包新增代码无 `console.*`、无 `electron-log` 直连、无网络调用（只有文件/DB 路径），`npm run verify:logging` 由发布包统一执行。

## 七、未完成 / 仅模拟 / 明确边界

1. **真实 Electron 桌面端到端未做**：本包为 main 服务级测试（与 F4/F6 接入测试同层），未在真实桌面验证“外部 `project.import` → 项目页可见 → 打开 → 编辑→ 执行”全链路；`out/` 构建产物由 Lead/f6-desktop 管理，本包未运行 `npm run build`。里程碑 20 项未重跑。
2. **契约快照/action-inventory 未刷新**：按 Lead 约定，`docs/local-agent-access/generated/contracts.json`、`generated/action-inventory.json`、`change-impact.json` 由 Lead 统一 `--write`；本包未写（避免多包并发互相覆盖）。本文件第 6 节的审计/验证快照状态以刷新后复跑为准。
3. **`project.exportStructure`（结构包导出）未开放，但“GUI 导出结构包 → 外部导入结构包”路径可用**：GUI 该动作读取渲染器当前（可能未保存）画布快照；外部没有等价的“取未保存画布结构”协议，按“不伪造等价输入”原则本包只开放结构包导入。实际可用路径：用户在 GUI 画布传输菜单导出 `.canvasflow` → 放入受控导出目录 `<dataDir>/agent-exports` → CLI/MCP `project.importStructure` 导入为新项目（本包已验收，见第三节）。即结构包链路不是整条缺失，缺的只是“外部触发导出”这一侧；action-coverage 中导出动作保留 F7。
4. **资源包导入的 blob 孤儿边界**：`importResourcePackage` 在 DB 事务提交前通过 `storeBlob` 写 blob 文件；极端失败下 DB 记录回滚而 blob 文件可能残留（用户不可见、不计入资源库）。这是既有 GUI 路径，属 `src/main/store/library.repo.ts`（f7-library 域），本包未修改；如需彻底清理应单独补补偿任务。
5. **包体积/流式解包**：沿用既有上限（项目包 50000 条目/2GB，结构包 50MB，资源包 512MB 与条目上限），未做流式解包重构；超大包仍整包载入内存。
6. **`keys.importProviders` / `workspace.import`** 未实现，仍阻断（见第四节）。
7. **旧的“导入排除”表述**：`docs/local-agent-access/02-capability-matrix.md`、`21-media-access-delivery.md` 仍有 F7 前“包导入不开放”的历史表述，属发布包统一修订范围，本包未改。
8. **付费供应商执行**与本包无关（不触发任何模型/网络调用），本包不宣称任何付费路径已验收。

## 八、下一包 / 交接注意

- 下一包（F8：内部 Agent 与多画布并发；F9：凭据/环境/设置/诊断）如需开放 `workspace.import`，必须先有 GUI 同源的合并服务与冲突裁决协议；`keys.importProviders` 需先明确设备绑定/解密/零明文回执边界。
- 后续新增包导入类操作：登记 `ops/transfer.ts` 的成对表 → `transfer-ops.ts` 边界实现 → 统一 `--write` 契约快照 → 补本台账与 `action-coverage.json`；注意 `scripts/audit-business-actions.cjs` 的操作 ID 解析已支持 camelCase。
- 复核顺序建议：先跑第 6 节 1/2，再刷新聚合产物后跑 4/5；桌面端到端建议加入 F10 或 F7 收尾里程碑脚本。

## 九、本包改动文件清单

- `src/shared/agent-access/ops/transfer.ts`（四项操作 + 输出 Schema）
- `src/main/agent-access/transfer-ops.ts`（新增：受控路径、回执、提交后核对、错误分类）
- `src/main/agent-access/service.ts`（仅追加 import 行 + 四个 switch case；并删 `NO_PROJECT_IMPORT` 一项 limitation）
- `src/shared/agent-access/registry.ts`（仅收缩 `PACKAGE_IMPORT_BLOCKLIST` 并写保留理由）
- `test/local-agent-transfer-access.test.ts`（新增，9 项）
- `test/local-agent-access.test.ts`（Lead 授权的两处解黑连带断言：L737 区域、L980 区域）
- `docs/local-agent-access/action-coverage.json`（仅四个业务动作改 external + 操作名）
- `docs/LOGGING_COVERAGE.md`（仅追加本包小节）
- `docs/local-agent-access/24-transfer-delivery.md`（本文件）
- `scripts/audit-business-actions.cjs`（一行：操作 ID 解析支持 camelCase，否则 `project.importStructure` 被误报）
- 未改：`src/main/store/transfer.ts`、`src/main/store/canvas-structure-transfer.ts`、`library.repo.ts`（全部复用现有实现）；未运行 `git add/commit/push`。
