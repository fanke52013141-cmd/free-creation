# MCP 验收 · 第 1 族：项目与图编辑

日期：2026-11-08。真实 MCP 协议栈（官方 SDK Client + StdioClientTransport）+ 真实桌面会话，
跑**完整业务链路**而非单点冒烟。脚本：`scripts/mcp-acceptance-family1-project-graph.cjs`。

**结果：25 步全通过；发现并修复 1 个 P1 缺陷。**

## 链路（25 步）

| 段 | 步骤 |
| --- | --- |
| 项目 | create → list（含新项目）→ get → open（真实桌面握手）→ save → rename（回读校验）→ update（活动画布） |
| 图编辑 | graph.get → graph.patch 建 2 节点 → node.get → node.update（回读校验标题）→ node.duplicate（节点数 2→3）→ layout.align（**坐标真的被改成同一 x**）→ group.create |
| 历史 | canvas.history undo → redo |
| 可见集 | nodeVisibility.get → set（visibleNodeTypeIds）→ get 回读校验 |
| 传输 | project.export（**文件真落盘、字节数与回执一致**）→ exportStructure |
| 生命周期 | clone → delete.precheck（拿 impactToken）→ delete（列表里确实没了）→ close |
| 节点库 | node.library.save（按规则拒绝普通节点） |

每一步都校验**副作用真的发生了**（节点数、坐标、标题、文件字节数、列表内容），不是只看 `status=completed`。

## 发现并修复的缺陷（P1）

**失败的 `canvas.history` 请求会推进图版本，导致重试永远追不上。**

复现（`scripts/probe-history-conflict.cjs`）：用同一个 `expectedGraphVersion` 连续请求 undo：

```
起始版本 2
第1次 failed REVISION_CONFLICT expected 2, current 3 | 之后 latest=3
第2次 failed REVISION_CONFLICT expected 2, current 4 | 之后 latest=4
...
第5次 failed REVISION_CONFLICT expected 2, current 7 | 之后 latest=7
```

**根因**：每次桌面握手前都会走保存屏障，save 推进 `graphVersion`；而 `canvas.history` 原先要求
版本**严格相等**。于是"读到的版本"必然比"真正到达时的版本"旧 1，且每次失败重试又推进 1 ——
理论上永远追不上。这不是测试脚本的问题，任何 Agent 都会卡死在这里。

**修复**：撤销/重做操作的是编辑器**自己的历史栈**，不会覆盖别人的内容，因此把
`expectedGraphVersion` 降级为**建议值**——只拒绝"超前版本"（那才是真正的状态错乱），
允许落后版本。改动在 `src/renderer/src/canvas/CanvasEditor.tsx`，
操作描述同步改为"建议值"。

**复验**：同族验收从 23/25 → **25/25 全通过**，撤销/重做均正确返回新图版本。

## 诚实边界（未覆盖 / 需注意）

1. **group.delete（解组）外部不可达**：组合后的 tldraw group 形状 ID 不经 `graph.patch` 回执暴露，
   外部拿不到它，也就无法解组。已记入报告 note；建议回执 `created` 里返回 `ref → groupId` 映射。
2. **`node.library.save` 只接受 chat/agent 节点**（`CHAT_NODE_REQUIRED`）——这是业务规则，
   不是缺陷；本轮已验证它对普通文本节点**正确拒绝**，没有误收。
3. **`project.exportStructure` 对"从未由 GUI 保存过画布快照"的项目返回
   `STRUCTURE_SNAPSHOT_MISSING`**——诚实拒绝，不是缺陷；需要结构包时先在 GUI 打开保存一次。
4. **`project.save` 会推进版本**：这是接口设计（每次保存都是新版本），但意味着外部不能把
   "保存前读到的版本"用于后续写操作。已在本族脚本里用"稳定版本 + 冲突重试"模式验证可行。
5. 本族未覆盖：`node.execute`（属执行族）、`project.import/importStructure`（属传输族）、
   `node.library` 的其余动作（需 agent 模板前置）、`node.type.*`（已在第一轮全量只读扫描覆盖）。

## 给产品的改进建议

1. `graph.patch` 回执的 `created` 增加 group 的 `ref → groupId`，让组合可逆（解组）；
2. `REVISION_CONFLICT` 回执增加**结构化** `currentGraphVersion` 字段（现在只在 `detail` 文本里），
   方便客户端可靠重试；
3. `graph.get` 的 JSON Schema 把有默认值的 `view/offset/limit` 标成了 `required`，
   与实际"可省略"行为不一致，会误导自动生成的客户端代码。

## 复现

```powershell
npm run build
node scripts/mcp-acceptance-family1-project-graph.cjs
# 报告：qa/local-agent-access/family-01-project-graph/report.json
```
