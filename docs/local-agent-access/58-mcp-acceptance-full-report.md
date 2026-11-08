# MCP 全量验收汇总（9 族 · 133 项操作 · 199 项检查）

日期：2026-11-08。真实 MCP 协议栈（官方 SDK `Client` + `StdioClientTransport`）+ 真实 Electron
桌面会话，按**业务族**跑完整链路，每步校验**副作用真的发生了**（不只看 `status=completed`）。

## 一、总结果

| 族 | 内容 | 检查 | 结果 |
| --- | --- | --- | --- |
| 全局 | 协议层 + 只读全扫 + 安全闸门 | 91 | 全通过 |
| 1 | 项目与图编辑 | 25 | 全通过 |
| 2 | 媒体（导入/列表/谱系/批量导出/删除/项目包导出） | 6 | 全通过 |
| 3 | 传输（结构包/项目包导入/越界拒绝） | 4 | 全通过 |
| 7 | 历史快照（创建/列表/恢复预检/恢复/删除） | 5 | 全通过 |
| 8 | 诊断与工作区（状态/能力/节点目录/偏好/诊断查询/诊断包） | 9 | 全通过 |
| 4 | 资源库（文件夹/收藏集/分类/资源/修订/采集/导入导出/物化/批量删除/节点库） | 21 | 全通过 |
| 5 | Agent Flow（inspect/catalog/协作/运行/建图/审核/命令/资产/导演发布） | 11 | 全通过 |
| 6 | 模型与环境（连接/凭据指纹/定义/绑定/目录/环境/安装闸门/凭据包） | 12 | 全通过 |
| 9 | 执行与对话（node.execute/run/output、chat、skill） | 3 | 全通过 |
| 补齐 | 前几族未触及的 10 项 | 12 | 全通过 |

**合计 199 项检查全部通过；133 项操作 100% 被真实调用过。**
全仓单元测试 **3105 通过 / 7 跳过 / 0 失败**；四道门禁全绿（133 operations）。

脚本：`scripts/mcp-acceptance.cjs`、`-family1-project-graph`、`-families-2-3-7-8`、
`-families-4-5-6-9`、`-gap-fill`；缺陷复现：`scripts/probe-history-conflict.cjs`。

## 二、验收中发现并已修复的缺陷

### P1：撤销/重做永远追不上版本（已修）

失败的历史请求会推进版本，导致任何"读版本→写"的重试持续错位（复现：2→3→4→5→6→7）。
根因是保存屏障在每次握手前推进 `graphVersion`，而 `canvas.history` 原先要求版本**严格相等**。
修复：撤销/重做只作用于编辑器自己的历史栈、不覆盖他人内容，因此版本降级为**建议值**
（只拒绝超前版本）。修复后第 1 族 23/25 → 25/25。

### MCP 协议层错误只有纯文本（已修）

参数校验失败只回 `INVALID_INPUT` 文本，真实 Agent 无法按错误码分支。现返回符合
`operationResponseSchema` 的结构化回执（含 `traceId`，`detail` 只放字段路径）。

## 三、需要优化的地方（按优先级）

### A. 会影响 Agent 正确性的（建议尽快）

1. **`REVISION_CONFLICT` 的当前版本只在文本里**
   `detail: "expected 16, current 17"` —— 客户端只能正则解析文本才能可靠重试。
   **建议**：回执增加结构化 `currentGraphVersion` 字段；或服务端在内部完成一次重试。
   （影响 `graph.patch` / `project.save` / `project.rename` / `history.snapshot.create` 等所有带版本校验的写操作。）

2. **组合（group）不可逆**
   `graph.patch` 的 `group.create` 不回传 group 形状 ID，外部拿不到就无法 `group.delete` 解组。
   **建议**：`created` 里返回 `ref → groupId`（与节点一致）。

3. **`flowAgent.cooperate` 缺任务时返回 `unknown` 而不是稳定码**
   调用方无法区分"没发生"与"不确定"，只能放弃。**建议**：返回 `AGENT_TASK_MISSING`。

4. **契约把有默认值的字段标成 required**
   `graph.get` 的 `view/offset/limit` 有默认值却在 JSON Schema 里是必填，会误导自动生成的客户端
   和 LLM 工具调用。**建议**：`required` 只列真正必填项。

### B. 影响 Agent 成功率与成本的（建议排期）

5. **字段命名不统一**
   `media.list` 条目是 `mediaId`，`library` 条目是 `resourceId` / `folderId` / `collectionId`，
   而 `project.list` 是 `id`。跨族写 Agent 逻辑时极易写错（本次验收脚本因此改了三处）。
   **建议**：统一为 `id`，或**全族统一带前缀**，并在契约里写明。

6. **缺少"前置条件"自描述**
   `node.library.*` 需要 chat/agent 节点、`chat.*` 需要 chat 节点、`flow.*` 需要已配置模型与任务、
   `library.resource.materialize` 需要目标画布已打开。现在只能靠试错获得 `CHAT_NODE_REQUIRED` 这类码。
   **建议**：在 `capability.list` / 工具描述里补 `requires: ['chatNode', 'openProject', ...]`。

7. **错误码没有机器可读清单**
   133 项操作实际返回了几十种业务码（本轮观测到 20+ 种）。Agent 无法枚举"可能收到什么"。
   **建议**：契约里给每个操作附 `errorCodes[]`。

8. **`INVALID_INPUT` 只说字段路径，不说原因**
   例如 `detail: "input.folderId"`，没说是缺字段、类型不对还是格式不符。
   **建议**：补简短原因（不包含具体值，避免泄漏）。

### C. 数据与工作流体验（建议评估）

9. **结构包导出依赖"GUI 保存过的画布快照"**
   完全由外部建图的项目会拿到 `STRUCTURE_SNAPSHOT_MISSING`，必须先让人在界面开一次。
   **建议**：提供 `project.snapshot.create`（外部可请求生成快照），或在 `graph.patch` 提交后自动生成。

10. **`history.recovery.precheck` 需要 `decision` 参数**
    语义是"预检"，却要求先给决策（`discard`）。**建议**：拆成无参 `precheck` + `resolve(decision)`。

11. **`media.list` 不含生成谱系摘要**
    要看"这个产物怎么来的"必须逐个调 `media.getRecipe`。**建议**：列表条目带 `hasRecipe` 标记，
    或提供批量查询。

### D. 本轮未覆盖（如实说明）

- **真实付费生成**（生图/P图/视频/语音/音色）：按用户要求由本人自测，本轮只验证了"未配置/未授权时
  正确拒绝且零网络请求"。
- **真实联网安装**（`environment.videoEngine.install`）：需要 CUDA 环境与数 GB 下载，只验证了确认闸门。
- **非官方 SDK 的其它 MCP 客户端**（如某些只支持 SSE 的）：传输层未适配验收。
- **桌面交互类**（人工确认弹窗、发布授权点击）：本轮验证了"未确认必被拒"，没有做真人点击流程。

## 四、复现方式

```powershell
npm run build
node scripts/mcp-acceptance.cjs                      # 协议层 + 只读全扫 + 闸门（91）
node scripts/mcp-acceptance-family1-project-graph.cjs # 族 1（25）
node scripts/mcp-acceptance-families-2-3-7-8.cjs      # 族 2/3/7/8（24）
node scripts/mcp-acceptance-families-4-5-6-9.cjs      # 族 4/5/6/9（47）
node scripts/mcp-acceptance-gap-fill.cjs              # 补齐 10 项（12）
# 报告：qa/local-agent-access/*/report.json（qa/ 被 gitignore，仅本地留证）
```

前提：本机已激活；脚本会自动探测授权目录（`canvas-studio/data/security` 或 `Electron/data/security`）
并复制进隔离数据目录（设备绑定、同机有效、不伪造签名）。
