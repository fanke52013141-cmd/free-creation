# 资源库单图图片资源创建（library.create_resource）

日期：2026-11-07 · 状态：implemented（CLI/MCP 双通道验收通过）

## 1. 范围与影响

- 功能：把能力矩阵 §2.2 早已规划的 `library.create_resource`（A2）落地。用户路径：外部 Agent
  把已下载到本机的图片（如 ai-pose-gallery-zh 姿势模板图）批量建为资源库图片资源。
- 受影响文件：`src/shared/agent-access/registry.ts`（操作+输出契约）、
  `src/main/agent-access/service.ts`（execute 分支+路径校验）、
  `scripts/ingest-pose-gallery.cjs`（新增批量入库示例脚本）、契约快照与本文档。
- 接入影响：新增一个 write 操作；复用公共路径 `library.repo.ts#createResource`
  （与桌面 UI 表单/采集同一条持久化管线），未新增存储格式或私有写路径。
- 各入口状态：MCP `library_create_resource` implemented；CLI `library create_resource`
  implemented；HTTP 不存在（transports 恒为 cli/mcp-stdio）。
- 形态约定（用户明确要求）：每个资源 = 一张图片 + 名称，`formPreset: 'image'`、单
  image 组件（role 固定 `reference-image`，与 `captureProjectMedia` 现有约定一致），
  不产生多组件资源。`library.create_folder` 仍为 planned。

## 2. 公共契约

- 输入（strict）：`title`(1–180)、`imagePath`(2–500，本机绝对路径)、`description?`(≤2000)、
  `tags?`(≤20 个、单个 ≤40)。
- 输出：`resourceId / revisionId / revisionNumber / title / imageSha256`。
  不返回 blobPath 等媒体路径，与 `library.search` 的字段白名单边界一致。
- 媒体接入方式：**只收本机已存在文件路径，不收网络地址、不收二进制报文**。主进程在
  `readLibraryImage` 中校验：绝对路径、stat 为文件、1B–128MB（对齐 repo 层
  `MAX_COMPONENT_BYTES`）、扩展名白名单 png/jpg/jpeg/webp/gif → 固定 mime。
  校验失败抛 `AccessFailure('INVALID_INPUT','validate')`，不落入 STORAGE_UNAVAILABLE。
- 安全边界说明：访问服务面向同机同用户（token 在 mode 0600 的 connection.json 中），
  路径白名单不构成额外安全边界，故不设目录白名单；类型/大小校验防误用。
- Registry 同步：契约快照经 `node scripts/check-agent-access.cjs --write` 重新生成，
  门禁输出 `19 operations; 32 planned nodes`。工具注解由 effect 派生
  （readOnlyHint=false），写操作强制幂等键（`toolInputSchema` 现有行为）。

## 3. 版本、副作用与恢复

- 幂等：与其他写操作一致，idempotencyKey + intent HMAC 绑定；同键同参重放返回原回执
  不产生重复资源；同键异参 `IDEMPOTENCY_CONFLICT`。操作不携带 projectId，不触发桌面
  握手，不进活动画布占用检查；写互斥锁由 dispatch 统一施加。
- 失败语义：入库前校验失败 → `failed/INVALID_INPUT`，资源库无痕迹；入库后
  contentHash 缺失（不应发生）→ `failed/STORAGE_INCONSISTENT`，回执落库，同键重放
  不会重复建资源。blob 落盘由 `storeBlob` sha256 去重 + 原子写承担。
- 重复导入同一图片文件：blob 层去重，产生两个引用同一 blob 的独立资源（符合资源库
  现有内容寻址设计）。

## 4. 日志

- 复用 dispatch 现有 `agent.access.started/completed/failed/unknown/ rejected` 生命周期，
  `attributes.operation=library.create_resource`；未新增事件类型或字段。
- 脱敏：响应与诊断不含源文件路径、图片字节；标签与描述不入日志。测试断言
  `JSON.stringify([created, replay, events])` 不含 imagePath，events 不含 sha256。

## 5. 验证证据

- `node scripts/run-vitest.cjs run test/local-agent-access.test.ts`：35 项通过
  （新增 2 项：路径建图+幂等重放+脱敏；六类非法输入拒绝+幂等键必填）。
- `node scripts/test-local-agent-access.cjs`（真实 Electron + MCP SDK + CLI）：
  通过。工具目录断言 18→19；新增 A12 段：CLI 与 MCP 各建一图（imageSha256 一致）、
  `library_search` 可见 formPreset='image' 且 componentCount=1、同键异参
  `IDEMPOTENCY_CONFLICT`、MCP 相对路径 `INVALID_INPUT`、五份报文不泄漏源路径。
  证据：`qa/local-agent-access/vertical-slice/report.json`。
- `npm run build`（typecheck:node+web + electron-vite）通过。

## 6. 交付与例外

- 已实现：本操作 CLI/MCP 与批量示例脚本 `scripts/ingest-pose-gallery.cjs`
  （数据源适配 ai-pose-gallery-zh 的 `data/*.json`，支持 `--limit/--dry-run/--ledger`
  断点续跑，逐资源独立幂等键，unknown/failed 记入台账文件）。
- 已验证：单图创建、幂等、拒绝路径、双通道一致性（见上）。
- 未验证/未支持：远程 URL 直接拉取（明确不支持，Agent 自行下载后传本机路径）；
  全量 1439 张真实入库由用户在试点确认后自行执行（脚本一键可跑）。
- 已知边界：图片内容不做魔法数校验（扩展名+大小为准）；`.gif` 入库但封面预览按图片
  处理；资源分类（category 蓝图）与文件夹归位属 `library.create_folder` 等后续操作。
- 版权提示：姿势模板图版权归原画师（ai-pose-gallery-zh 的 img/、data/ 不在 MIT 覆盖
  范围），仅限本地个人使用，入库后导出的资源包不得对外分发。
