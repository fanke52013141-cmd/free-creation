# ABC 三组优化：已实施 + 已验证

日期：2026-11-08。上一轮验收报告（58 号）列出 11 条优化建议，本轮全部实施并用真实 MCP 协议栈验证。

## 一、验证结果

新增验证脚本 `scripts/mcp-acceptance-optimizations.cjs`：**9 项检查全通过**。
既有 5 个验收脚本回归：**90 + 25 + 24 + 47 + 12 项全部通过**（合计 198 项），
全仓单元测试 **3106 通过 / 7 跳过 / 0 失败**，四道门禁全绿。

## 二、逐条落地情况

### A 组（影响正确性）

| # | 优化 | 实现 | 验证 |
| --- | --- | --- | --- |
| A1 | 版本冲突给结构化当前版本 | `AccessResponseSchema.error` 增 `currentGraphVersion`；桌面失败回执也带 `graphVersion`；service 三条冲突路径（桌面握手 / patch-admission / patch-verify）都填 | 制造冲突后断言 `error.currentGraphVersion` 是数字，**并用它直接重试成功** |
| A2 | 组合可解组 | `graph.patch` 回执新增 `groups[{ref,groupId}]`。关键发现：tldraw `groupShapes()` 返回 editor 本身而非新建 group，因此改为**显式指定 groupId**（`createShapeId()` + `{groupId}`） | `group.create` 拿 groupId → `group.delete` 解组 → 再读图 `groups` 为空 |
| A3 | cooperate 稳定错误码 | 写协作事件前先 `port.collaboration()` 查有没有持久化任务，没有则 `AGENT_TASK_MISSING`（不再落到 unknown） | 无任务节点返回 `AGENT_TASK_MISSING` 且零写入 |
| A4 | 契约 required 与实际一致 | 新增 `advertisedJsonSchema()`：广播的 inputSchema 去掉"有 defaultValue 却标 required"的字段 | `graph.get` 的 required 不再含 `view/offset/limit` |

### B 组（影响成功率）

| # | 优化 | 实现 | 验证 |
| --- | --- | --- | --- |
| B5 | 字段命名 | `media.list` 条目新增 `id` 别名（=mediaId），作为跨族统一寻址起点 | 断言 `item.id === item.mediaId` |
| B6 | 前置条件自描述 | 新增 `src/shared/agent-access/metadata.ts` 的 `OPERATION_REQUIREMENTS`；`operationDirectory()` 每项输出 `requires` | 断言 >30 项带前置，`node.library.save` 标注 `chatNode` |
| B7 | 错误码目录 | 同文件 `ACCESS_ERROR_CATALOG`（32 条：code/meaning/hint），经 `capability.list.errorCatalog` 暴露 | 断言目录非空且有 30+ 条 |
| B8 | 校验错误带原因 | service 与 MCP 服务端的 `INVALID_INPUT` 都带 `字段路径: zod message`（message 不含具体值） | 断言 detail 含字段名且长度大于字段名 |

### C 组（工作流体验）

| # | 优化 | 实现 | 验证 |
| --- | --- | --- | --- |
| C9 | 结构包不再依赖人工保存 | `exportStructurePackage` 改为异步：缺画布快照时先经权威宿主做一次**保存屏障**，再读项目 | 外部建图后直接 `exportStructure` 成功落盘 |
| C10 | 预检不再强迫先决定 | `history.recovery.precheck` 的 `decision` 改为可选；不传时只读事实并返回 `requiresDecision: true` | 不传 decision 也能预检 |
| C11 | 媒体列表带谱系标记 | `media.list` 条目新增 `hasRecipe`（一次查 `artifact_recipes`，避免逐条试探） | 断言字段存在且为布尔 |

## 三、过程中发现的额外缺陷并修复

**tldraw `groupShapes()` 返回 editor 本身而不是新建的 group。**
最初我用返回值取 groupId，单元测试（假编辑器返回数组）通过、但真实桌面回执里 `groups` 恒为空。
已改为显式指定 `groupId`。这条说明：**假编辑器测不出的 API 语义，必须靠真实桌面验收兜住**。

## 四、诚实边界

- A2 的 group 只在"本批由 group.create 创建"时可解组；历史上 GUI 手工组合的 group 若外部不知道
  其 id，仍可用 `graph.get` 的 `groups[].groupId` 取到（本轮验证走的正是这条更通用的路径）。
- B5 只给 `media.list` 加了 `id` 别名。library 各 DTO 的 `resourceId/folderId/collectionId`
  保持原样（改名是破坏性变更，需单独立项）。
- C9 的保存屏障依赖桌面宿主在运行；纯 CLI 场景仍然会得到 `STRUCTURE_SNAPSHOT_MISSING`。
- 付费生成、真实联网安装、非官方 MCP 客户端、真人点击流程仍未验（与 58 号报告一致）。

## 五、复现

```powershell
npm run build
node scripts/mcp-acceptance-optimizations.cjs        # 9 项优化验证
node scripts/mcp-acceptance.cjs                      # 90
node scripts/mcp-acceptance-family1-project-graph.cjs # 25
node scripts/mcp-acceptance-families-2-3-7-8.cjs      # 24
node scripts/mcp-acceptance-families-4-5-6-9.cjs      # 47
node scripts/mcp-acceptance-gap-fill.cjs              # 12
```
