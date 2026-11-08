# F6 收尾交付：对话节点真实画布端到端、附件注入与幂等/跨项目拒绝

日期：2026-11-08。基线：`94c8bbb`（F6 第三批之后的工作区；含其他并行包未提交修改）。
本包验收期间，并行包已提交到 `80a4c36`（F6 导演台发布协议 + F7 三包），最终门禁与桌面证据
在集成后工作区重跑通过。本文是 F6 收尾桌面包的交付台账，承接
[21-media-access-delivery.md](21-media-access-delivery.md) 中「F6 第一/二/三批」的业务动作；
本包不改 Operation Registry / Schema，只补权威宿主与 main 预检的真实缺陷，并把
「chat.patch 真实画布端到端」纳入真实 Electron 桌面里程碑。

## 1. 实际完成的业务动作（GUI / CLI / MCP 状态）

| 业务动作 | GUI | CLI | MCP | 公共实现与桌面证据 |
| --- | --- | --- | --- | --- |
| 在画布创建 AI 对话节点 | ✅ 节点面板/拖入 | ✅ `graph.patch` `node.create`(chat) | ✅ `graph_patch` | 与 GUI 同一 `planGraphPatch`（同 Spec/端口/保存屏障）；F6 段真实桌面建节点并持久化 |
| 会话新建/切换/重命名/删除 | ✅ 对话面板 | ✅ `graph.patch` → `chat.patch` | ✅ 同左 | `planChatPatch` 复用 `shared/engine/chat-data` 同一函数族；桌面段新建会话并读回 |
| 追加/编辑/截断用户消息 | ✅ 对话面板 | ✅ 同左 | ✅ 同左 | 同一 chat-data 分支语义；桌面段追加 3 条并核对顺序 |
| 图片附件消息 | ✅ 附件入口 | ✅ `chat.patch` `images:[{mediaId}]` | ✅ 同左 | main 预检解析归属 → 桌面载荷 `mediaResolutions` → 宿主写 `mediaPath`/`mime`；**外部输入只有 mediaId** |
| 会话目录/消息正文读取 | ✅ 面板渲染 | ✅ `chat.read` / `chat.messages` | ✅ 同左 | 持久化节点正文（props.text）是唯一真值；桌面段逐项读回 |
| 发送/重新生成 | ✅ 发送按钮 | ✅ `node.execute` | ✅ 同左 | 同一 `chatExecutor`；无已验证模型时与 GUI 一致地如实失败（本包实测） |

Registry 中 F6 相关操作为 37 项，本包**未新增/修改契约**（无 Schema 兼容变化）；集成态下
Registry 共 77 项操作（含并行 F7 包新增操作），门禁按集成态实测通过。
付费模型执行未验收：本包只验证「无已验证文本模型连接时的如实失败」，不伪造助手回复。

## 2. 公共契约与兼容处理

- **附件注入（宿主侧）**：`planChatPatch(rawText, ops, mediaResolutions?)` 新增可选第三参数；
  外部输入仍只有 `mediaId`，main 预检把存储事实（项目相对路径/MIME/名称）经桌面请求的
  `mediaResolutions` 注入，宿主按 mediaId 取值写入消息。缺解析事实时整批失败
  `MEDIA_NOT_RESOLVED`，不写空路径附件（空路径会被 `parseChat` 的附件校验丢弃）。
  旧调用方不传第三参数时行为不变（仅当消息含附件才会命中新校验）。
- **失败语义**：预检失败 = `failed`，整批不留半图/半条消息；准入后失败 = `unknown`
  （幂等键重放原回执，不自动重发）。桌面实测同幂等键重放返回原回执且消息数不变。
- **混批限制**：`chat.patch` 与几何 op 混在一个 `graph.patch` 批次时，main 预检在准入前
  拒绝（`MIXED_PATCH_UNSUPPORTED`）。原因是权威宿主当前对含 `chat.patch` 的批次走会话
  独立分支，几何 op 会被静默丢弃；显式拒绝优于「回执成功但只应用一半」。将来若产品需要
  同批原子混合，需要宿主合并两套规划器后同步修改该预检（预检中 `mediaResolutions` 两张表
  的覆盖问题也一并处理）。
- **附件范围**：`chat-ops` 只接受图片附件（`image/*`，与 GUI 对话附件同语义）；视频/音频
  附件不开放，不在本包分母内。

## 3. 过程中发现并修复的真实缺陷（根因与证据）

### 3.1 附件路径/MIME 从未写入宿主（renderer 规划器 + 调用点）

- **根因链**：main 预检解析 chat 附件 mediaId 后已把事实放进桌面载荷 `mediaResolutions`
  （服务级测试只断言「已发给桌面」）；但 `CanvasEditor` 的 chat 分支没有把
  `request.mediaResolutions` 传给规划器，`planChatPatch` 也没有参数接收，`images` 一律写入
  `mediaPath: ''`、`mime: ''`。落盘后 `parseChat` 的 `messagesFrom` 只保留
  `projects/<id>/media/<file>`（或 data URI）且 `image/*` 的附件，于是**附件在持久化/重开后
  静默消失**，GUI 只剩正文气泡，服务回执却仍是 completed。
- **修复**：规划器接收并写入解析事实；宿主把载荷传入（`CanvasEditor.tsx` 一处调用）；
  缺失解析事实时整批失败。桌面证据：`report.json` 的 `chat.attachment` 为
  `projects/<projectId>/media/<mediaId>.png` / `image/png`，`node.get` 持久化正文与
  `chat.messages` 一致，GUI 对话面板图片真实加载（`imageLoaded: true` + 截图
  `milestone-f6-chat-dialog.png`）。

### 3.2 chat.patch 与几何 op 混批被静默丢弃（main 预检 / 宿主分支）

- **根因**：`CanvasEditor` 在发现任一条 `chat.patch` 时进入独立分支，只应用会话 op 并回执
  `ok`；同批 `node.create`/`edge.create` 不被执行也不报错（counts 为 0），外部会误以为
  整批已应用。
- **修复**：main 预检在任何变更前拒绝混批（`MIXED_PATCH_UNSUPPORTED`，`failed`，无副作用）。
  未把混批做成支持项，避免在本包扩大宿主原子应用范围；限制与后续要求写入第 6 节。
  桌面证据：`F6 段 (h)` 混批请求返回 `MIXED_PATCH_UNSUPPORTED`，会话消息数不变、混批
  节点未出现在 `graph.get`（预检拒绝，无半应用）。

## 4. 验证证据（命令 + 真实结果）

### 4.1 真实 Electron 桌面里程碑（构建产物 + 独立数据目录 + 授权协作激活）

命令：`node scripts/test-agent-graph-milestone.cjs`

结果：`qa/local-agent-access/milestone-a-b-c/report.json` → `status: "passed"`，
**checks = 25**（既有 20 项全部保留 + 本包新增 5 项，见清单第 18–22 项）。
F6 段（`report.chat`）真实记录：

- `messages`：3 条 `user`，顺序为「第一条 / 第二条 / 第三条（带附件）」，
  `chat.messages` 读回与 GUI 对话面板 DOM 顺序一致；
- `attachment`：`mediaId` ⊕ `mediaPath: projects/<id>/media/<mediaId>.png`、
  `mime: image/png`（宿主注入；外部输入 JSON 断言不含 `projects/` 与 `image/png`）；
- `idempotentReplay`：同幂等键重放回执 `graphVersion` 与首次一致，`totalAfterReplay = 1`
  （未重复追加）；
- `gui`：`messageBubbles = 3`、`imageLoaded = true`、截图 `milestone-f6-chat-dialog.png`
  （三条消息与附件图片真实可见）；
- `execute`：`state = "failed"`，`error = "功能 chat.generate 尚未绑定已验证文本模型"`
  （与 GUI 同一执行器/原因；消息数不变、无 assistant 回复、节点正文未变）；
- `crossProjectMedia`：使用项目 B 的 mediaId 追加 → `MEDIA_NOT_FOUND`，`totalAfter = 3`，
  项目 A 媒体数不变（无半条消息/无孤儿媒体）；
- `mixedBatch`：`chat.patch` + `node.create` 同批 → `MIXED_PATCH_UNSUPPORTED`，
  消息数仍为 3、混批节点未创建（预检拒绝，无半应用）。

里程碑脚本的健壮性调整（不改变验收语义）：权威版本读数改为「相邻相等后再等 1200ms
复核」，并对会与 GUI 防抖保存竞争的 `graph.patch` 在 `REVISION_CONFLICT`（准入前失败，
无副作用）时重读版本重试；既有 20 项断言与冲突/非法批次语义保持不变。

### 4.2 门禁（本工作区实测，含并行包状态）

| 检查 | 结果 |
| --- | --- |
| `npm run typecheck` | 通过（node / web / license-protocol / issuer 均 0 错误；集成态实测） |
| `npm run build` | 通过（typecheck + electron-vite build；本次里程碑即运行该产物） |
| 定向接入测试 `node scripts/run-vitest.cjs run test/local-agent-access.test.ts test/local-agent-graph-access.test.ts test/local-agent-run-access.test.ts test/local-agent-media-access.test.ts test/local-agent-chat-access.test.ts test/graph-patch-plan.test.ts --reporter=dot` | `Test Files 6 passed (6)`；`Tests 73 passed (73)`，进程退出码 0（stderr 仅并行包 `package.json` 重复键的 esbuild 警告，与测试结果无关） |
| `node scripts/audit-business-actions.cjs` | 通过：`171 IPC channels + 35 canvas actions; external ops 77`（含并行 F7 包新增操作；F6 本包未改 IPC/画布动作分母） |
| `npm run verify:agent-access` | 通过：`Agent access gate passed: 77 operations; 32 planned nodes`（集成态已刷新契约快照与影响声明；F6 本包未新增/修改契约） |
| 真实桌面里程碑（官方构建产物） | **通过，25/25 checks**（`report.json` status=`passed`） |

> 共享工作区说明：本包与 F7 三个包在同一工作区并行开发，上述 77 项操作包含其他包新增
> 的操作。F6 未新增操作或 Schema，也没有删除/重命名任何已发布契约；契约快照、
> `change-impact.json` 与 `action-coverage.json` 由集成方在全部包完成后统一刷新（刷新会把
> 本包 `service.ts` / `CanvasEditor.tsx` 的哈希一并纳入），本包未代签其他包的哈希。

## 5. 日志覆盖与脱敏

- 复用既有 `agent.access.started/completed/failed/unknown` 生命周期（operation =
  `graph.patch` / `node.execute` / `chat.messages` 等），**无新增事件、字段或旁路 logger**；
  宿主 `planChatPatch` 不记录任何正文。
- 会话标题、消息正文、附件名、`mediaPath` 不进入诊断：里程碑末尾扫描 `diagnostics/**.jsonl`
  断言 `F6 外部追加`、`外部会话 F6`、`不应写入的跨项目附件消息`、`不应写入的混批消息`
  均未出现（新增 4 条断言，与既有正文/用户内容脱敏断言同段）；失败只记录稳定 code/index
  （如 `op[N]` / mediaId）。
- 日志写入失败不改变业务结果（沿既有 dispatch 断言）；`chat.patch` 的桌面应用与保存沿用
  `project.save` 生命周期，不重复记录终态。
- 边界：桌面宿主内没有 chat.patch 独立 trace 事件（复用外部接入生命周期 + 保存事件），
  未做跨进程 trace 树对齐；该边界与既有图编辑一致，见
  [LOGGING_COVERAGE.md](../LOGGING_COVERAGE.md) 本包小节。

## 6. 未完成或仅本地/模拟验证

1. **模型回复执行未验收**：仓库无预算/无已验证文本模型连接，本包只验证「如实失败」：
   `node.execute` → `run.wait` `failed`，原因「功能 chat.generate 尚未绑定已验证文本模型」，
   没有伪造助手回复。真实供应商/付费对话执行未实测。
2. **「执行→助手回复→chat.messages 读回」未跑通**：仓库只有测试级模型 mock（vitest/浏览器
   替身），没有可在真实 Electron 生产路径注入的本地模型通道；不接受为验收在生产代码加旁路。
   需预算授权或后续受控本地模型接入后补测。
3. **混批不可用**：`chat.patch` 必须单独成批（`MIXED_PATCH_UNSUPPORTED`）。同批建会话节点 +
   追加消息、或会话编辑 + 建边，需要宿主合并规划器，未实现。
4. **附件仅图片**：视频/音频附件、附件删除/替换、附件与生图意图组合未验收。
5. **会话级幂等/unknown 边界**：只实测正常回执幂等重放；准入后 unknown（保存后失联）时按
   图版本与 `chat.messages` 核对的专项场景未复现，复用 F2 图补丁的 unknown 机制。
6. **MCP 客户端未逐动作实测**：CLI 与 MCP 由同一 Registry 生成；桌面证据走 CLI。
7. **安装包/干净克隆**（F10）未做；历史证据不等于安装包通过。
8. **导演台发布授权协议**（manual-publish 的等待/继续）由并行包推进，不在本台账范围。

## 7. 下一包目标

- 按 [15-gui-cli-mcp-parity-plan.md](15-gui-cli-mcp-parity-plan.md)：F6 余项（模型连接后的
  真实对话执行、导演台发布协议、代码/循环节点桌面执行证据）与 F7（资源库/节点库/历史/包传输）
  由各自包推进；本包只关闭「对话节点真实画布端到端 + 附件注入 + 幂等/跨项目拒绝」。
- 后续如果需要同批 `chat.patch` + 几何 op 原子应用：先升级宿主规划器为「图+会话」联合计划，
  再放宽 `MIXED_PATCH_UNSUPPORTED` 并补桌面证据；届时同步处理 main 预检中两张
  `mediaResolutions` 表的合并（当前混批被拒后该覆盖点不可达）。
