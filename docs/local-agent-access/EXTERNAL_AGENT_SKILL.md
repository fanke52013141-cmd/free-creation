# Canvas Studio 外部 Agent（MCP / CLI）接入指南

> **架构定位（2026-11-27 确立）**：Canvas Studio 不再内置“上帝 Agent”（`role: 'builder'` 已退役），规划与编排大脑交由外部强 Agent（Claude Code / Cursor / Codex / Antigravity 等）；Canvas Studio 专注提供 **全 34 节点与复合节点流的确定性执行、幽灵预览与桌面人工确认门禁**。

---

## 1. MCP 启动方式（默认轻量 `core` 档位）

```bash
# 推荐：默认 core 档位（25 个高频核心工具 + 3 个渐进发现元工具，<45 KB，兼容所有 MCP 客户端）
node out/main/local-agent.js mcp serve

# 兼容全量档位（全量直出所有已注册工具，仅用于全量契约测试或无需工具数限制的客户端）
node out/main/local-agent.js mcp serve --profile full
```

也可通过环境变量切换：`CANVAS_MCP_PROFILE=core|full`。

> **幂等键规则**：所有非只读操作都必须在顶层传入 `idempotencyKey`，格式为 `<13位毫秒时间戳>:<小写UUIDv4>`（例如 `1764244200000:550e8400-e29b-41d4-a716-446655440000`）。

---

## 2. 推荐 4 步外部创作闭环（覆盖全部活跃节点与已发布节点流）

1. **探索与打开项目**
   - `project_list` → `project_open`
   - `graph_get`（项目已打开时优先传 `view: "latest"` 获取最新画布节点、连线与 `graphVersion`）
   - `node_type_list` / `node_type_get` 查看任意节点类型的输入输出端口与 **`configGuide` 配置示例**
   - `composite_search` / `composite_get` 查看已封装发布的可复用节点流（黑盒能力）
   - `media_import` 仅允许从 `<dataDirectory>/agent-exports` 受控目录导入本地文件

2. **以幽灵预览提议建图（方案 A，推荐）**
   - 调用 `graph_patch_propose`，提交带 `ops`（`node.create` / `edge.create` / `node.update` / `node.delete` 等）与 `autoLayout: true` 的画布变更提案。
   - **提案期深度预检 + 零画布写入**：服务端会立即校验节点类型、端口存在性（缺端口会返回合法端口清单）、类型兼容、`code` 配置与无环性；通过后桌面画布会立刻出现半透明幽灵节点与连线预览，右上角弹出「外部建图预览」卡片。
   - 落盘方式二选一：
     - 用户直接在桌面预览面板点击 **「确认落画布」**；
     - 或外部 Agent 调用 `graph_patch_confirm({ projectId, previewId })`（弹窗前自动校验版本，无冲突才弹出桌面确认弹窗），经人工点击允许后单撤销步原子落盘（拒绝/超时均零副作用）。
   - 如需取消预览：调用 `graph_patch_discard`。

3. **执行并核对真实产物**
   - 调用 `node_execute`（单节点或子图）或 `composite_execute` + `composite_execute_wait`（已发布节点流）。
   - 调用 `run_wait` 等待终态，再调用 `output_get` 读取真实产出（文本、JSON 或受控 `mediaId`）。
   - 纯本地确定性节点（`code` / `processor` / `image-crop` / `image-split` / `video-frame` / `video-clip` / `sound-adjust` / `silence-trim`）子图执行无需付费重跑确认；含付费模型上游需经用户同意后传 `confirmPaidRerun: true`。
   - **铁律**：绝不凭模型文本推断成功；一切以 `run_wait` / `composite_execute_wait` 终态与 `output_get` 事实为准。

4. **按需发现其余扩展操作**
   - `canvas_ops_search({ query, group, effect })`：按关键词或命名空间（`library` / `history` / `provider` / `model` / `diagnostics` / `director` / `node.runPlan` 等）检索操作。
   - `canvas_ops_schema({ operationId })`：按需拉取单个操作的精确 JSON Schema。
   - `canvas_ops_call({ operationId, input, idempotencyKey })`：经同一鉴权与人工确认门禁执行该操作。

---

## 3. 架构演进与废弃说明

- **已退役**：内置上帝 Agent（`role: 'builder'`、`BuildPlanSchema`、`flowAgent.build.*`）已停止演进，不再作为新建节点选项；历史项目仅保留只读兼容与既有预览收口。
- **已冻结**：内部 `coordinator-host` 不再扩张新的自主多角色/内置评审编排概念；复杂决策、返工判断与跨步调度交由外部强 Agent 完成。
