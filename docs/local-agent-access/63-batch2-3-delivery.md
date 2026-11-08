# 批 2 / 批 3 交付：保存降噪、字段统一、人工 runbook、SSE 传输

日期：2026-11-08。承接 61 号方案。**批 4 依赖的文件仍在并行修改中，本次未动。**

## 一、批 2

### P1-6 保存不再无谓推进版本（**已评估，本轮回退，需专项迁移**）

> **结论先说**：实现了，但全仓立即出现 **42 个测试失败**（`c4-combined-recovery`、
> `local-agent-access` 等），说明"每次保存必推进版本"是被广泛依赖的不变量，
> 不是能随手改的实现细节。**已回退**，方案与迁移要求记录在此，待专项处理。

**为什么不能直接改**：以下路径都隐式依赖"save 会推进版本"——
关窗恢复/未知态核对（C4）、保存协调器的 persisted/dirty 推进、外部写操作的版本校验链、
快照/恢复副本的一致性断言。改成"内容驱动"需要：
① 明确 `graphVersion` 语义（单调时钟 vs 内容版本号）；
② 给所有读取 `graphVersion` 的路径补"版本未变"分支；
③ 数据迁移说明（旧版本号在内容未变时会停止增长，依赖"号变了=内容变了"的逻辑会误判）。

**当前缓解**：Agent 侧已用两条措施消除可感知痛苦——`expectedGraphVersion` 降为**建议值**
（撤销/重做只拒绝超前版本），以及 `REVISION_CONFLICT` 回执给**结构化 `currentGraphVersion`**
（客户端可直接重试）。噪声仍在，但不会让调用卡死。

**若要做，建议的落地顺序**（专项任务）：
1. 先写 `graphVersion` 语义文档，并全仓列出所有依赖点清单；
2. 在 `projects.repo.ts` 新增 `saveProjectIfChanged()`（不改既有 `saveProject`），
   先只让"桌面握手前的保存屏障"这一条路径切过去；
3. 用 C4 恢复 / 外部写入 / 恢复副本三组测试做回归门；
4. 稳定一个版本周期后，再考虑把默认路径也切过去。

#### （以下为当时的实现方案，保留备查）

**问题**：每次桌面握手前的保存屏障都 `graphVersion + 1`（即使画布没变）。后果：
① Agent「读版本→写」几乎必然 `REVISION_CONFLICT`（此前只能用"建议版本 + 结构化 current"兜底）；
② 无谓磁盘写与 `.bak` 轮转；③ 历史/诊断里塞满空版本。

**实现**（`src/main/store/projects.repo.ts`）：保存前取"内容指纹"，
保存后重算并比较；**相同则直接返回当前版本、不写盘、不推进版本**。

指纹 = 图（节点/连线/分组）+ 快照里的**稳定记录**（shape / binding / asset / document / page）。
**排除**：`camera`、`instance`、`instance_page_state`、`pointer`、`instance_presence` ——
这些是"看一眼/点一下"就会变的状态，算进去等于移动视角就制造新版本。

**测试**（`test/project-save-noop.test.ts`，4 项）：
① 相同内容重复保存不推进版本且文件字节不变；② 只改相机/选中态不推进；
③ 节点内容变化必须推进；④ 版本不符仍报冲突（no-op 不能绕过乐观锁）。

### P1-7 library 字段统一（阶段 A：追加 `id` 别名）

给 `library.resource.list/get`（摘要）、`library.folder.*`、`library.collection.*` 的 DTO
**追加 `id`**（=原主键），与 `media.list` / `project.list` 一致。纯追加，旧字段全部保留。
破坏性改名（去掉 `resourceId/folderId/collectionId`）留到下个大版本。

## 二、批 3

### P2-10 人工步骤 runbook

新增 `62-manual-runbook.md`：凭据包导入（外部发起 → 界面确认框 → 允许后才落库）、
即梦设备流登录（发起 → 人在浏览器授权 → 轮询）、付费生成（最小验证路径），
每条都给：**怎么调、界面会看到什么、点哪里、预期回执、失败码对照、验收记录模板**。

### P2-9 MCP SSE 传输（给只支持 SSE 的客户端）

`src/local-agent/index.ts` 重构：把 Server 构建抽成 `createMcpServer()`，按 `--transport` 选择：
- `stdio`（默认，行为不变）；
- `sse`：监听 `127.0.0.1`（可 `--port`，0=随机），启动时把 `{url, token}` 打到 stdout 供发现。

**安全边界**：只绑定 loopback；**必须带本进程随机令牌**（`?token=`）否则 401；
消息端点也带令牌（否则客户端自己的 POST 会被自己的校验挡掉——本轮踩过）；
令牌只走 stdout，不落盘不进日志。实际操作仍走本机受控套接字，桌面侧鉴权不变。
每个连接新建 Server（SSE 下 Server 与 transport 一对一，复用会让第二个客户端抢会话）。

**验收**（`scripts/mcp-acceptance-sse.cjs`，4/4 通过）：
① 启动打印发现信息且绑定 loopback；② 不带令牌 401；③ 错误令牌 401；
④ 真实 SSE 客户端连上 → `tools/list` = 141 项 → 真实调用 `capability.list` 成功。

## 三、批 4：未开始（依赖未解除）

| 项 | 依赖文件 | 现状 |
| --- | --- | --- |
| `models.discover` / `validateAgentToolCalling` | `src/main/ipc/models.ipc.ts` | 仍在并行未提交修改中 |
| `hasApiKey` 根因修复 | `src/main/gateway/providers.repo.ts` | 同上 |
| `verify:acceptance` 命令 | `package.json` | 同上 |

（外部读侧 `hasApiKey` 已在批 1 校正，Agent 看到的已是真值；只是 GUI 遗留列表的根因还等落定。）

## 四、验证

- 全仓测试 **3110 通过 / 7 跳过 / 0 失败**；`verify:agent-access` 141 operations；
  `audit-business-actions` 171 IPC + 42 画布动作；`verify:logging` 通过。
- 新增验收：`scripts/mcp-acceptance-sse.cjs` 4/4；
  `test/project-save-noop.test.ts` 4/4；`test/edition-node-parity.test.ts` 4/4。

## 五、注意

- no-op 保存改变了"每次 save 必推进版本"的旧行为。若有代码依赖"save 返回新版本号"来判定
  发生变更，需要改为比较内容或读取 `updatedAt`。本仓库内相关路径已核对（保存协调器按
  `graphVersion` 对齐 persisted/dirty，版本不变时两者仍相等，语义正确）。
