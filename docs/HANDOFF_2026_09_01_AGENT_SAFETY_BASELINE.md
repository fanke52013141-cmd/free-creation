# Agent 对接安全基线交接（P0–P5 第一阶段）

> 日期：2026-09-01
>
> 状态：已提交安全基础设施；**未开放 Agent 写入与真实无界面执行**。

## 本轮真实交付

1. `DesktopProjectStore` 已接入桌面端的 SQLite 项目索引、`project.json` 与媒体索引。CLI/MCP 不再扫描并创建一套孤立的 `projects/` 目录。
2. CLI、MCP 默认都使用只读权限：创建、配置、删除、连线及运行会返回明确的 `WRITE_DISABLED` / `EXECUTION_DISABLED`，不会制造“已排队”或“已保存”的假象。
3. 应用服务层新增 `writeEnabled`、`executionEnabled`、权限等级、操作主体、乐观版本字段和按“操作 + 项目”分域的幂等键。
4. MCP 边界以 Zod 校验项目 ID、节点 ID、端口引用和配置对象；非法路径形式的项目 ID 会在进入业务服务前被拒绝。
5. 新增 Electron ABI CLI 构建：`pnpm agent:build` 输出 `out/agent/canvas.cjs`、`canvas-mcp.cjs` 和契约生成器。`scripts/canvas-cli.cjs` 通过 Electron 启动，避免 Node/Electron 的 `better-sqlite3` ABI 不一致。
6. 新增稳定契约文件：`generated/agent-contracts.json`。生成过程会移除时间戳，`pnpm agent:check-contracts` 可检查生成结果是否已提交。
7. MCP 单测使用显式注入的隔离 `FileProjectStore`；生产入口仍固定使用 `DesktopProjectStore`。

## 已验证

```bash
pnpm typecheck
pnpm test # 60 files / 781 tests
pnpm agent:generate
pnpm agent:build
node scripts/canvas-cli.cjs capability list --json
```

上述命令在本轮通过。`pnpm lint` 仍有既有 Agent 层与测试中的 `any` / 未使用变量错误，不能作为通过门禁，见下方清单。

## 不可误判为已完成的内容

- `src/capabilities/definitions.ts` 仍是临时能力表，尚未替代 `src/renderer/src/nodes/specs/index.tsx` 的真实 `NodeTypeSpec`。两者存在端口与版本差异；不能声称“单一事实来源已经完成”。
- Agent 写入尚未同步创建/更新 tldraw `node-card` 和箭头快照。若现在开放，会造成“图数据存在、画布不可见、下次保存覆盖”的风险，因此被默认关闭。
- `WorkflowService` 没有真实 headless 执行器、运行状态仓储、取消、重试或 Artifact 关联；外部入口不能返回 `queued`。
- MCP 的 Electron stdio 启动脚本仍需补一条生产子进程冒烟测试；当前协议测试覆盖的是注入隔离存储的 server 本体。

## 接续顺序（必须按顺序）

### P1：唯一节点契约

1. 抽出不依赖 React/tldraw 的 `NodeContract`。
2. 让 `NodeTypeSpec` 从该契约派生端口、版本、默认尺寸、执行模式；保留 Body/Settings/Executor 作为 UI 扩展。
3. 删除或自动生成 `capabilities/definitions.ts`，不能再手维护第二份端口定义。
4. 新增合规测试：真实 `NodeTypeSpec`、CLI 能力、MCP resource、生成 JSON 必须逐端口完全相同。

### P2：安全写入事务

1. 在 `projects.repo.ts` 提供 `expectedGraphVersion` 原子检查与保存；不要只在服务层“先读再写”。
2. 写入时同时维护 `ProjectFile.nodes/edges/groups` 与 tldraw `node-card` / arrow snapshot。
3. 保存失败必须回滚所有图数据；提交 revision、审计记录和幂等记录。
4. 只有这些测试通过后，才可通过环境开关为受控 Agent 开放 `draft` 写入。

### P3：真实执行和产物

1. 将执行器从 renderer 拆为可在 Electron main/headless 运行的服务。
2. 建立持久化 Run/Artifact 表，支持 `queued/running/succeeded/failed/cancelled`、查询、取消和重试。
3. `manual-publish`（导演台）必须明确标记 `agentRunnable: false`。

### P4/P5：门禁、兼容与权限

1. 将 `agent:check-contracts` 加入 CI，并基于 `generated/agent-contracts.json` 比较前后版本。
2. 删除端口、改变类型、必填性变更必须提升契约版本并提供迁移。
3. 审计日志和幂等记录应落盘，幂等键包含 actor、project、operation 和 payload hash。
4. 权限至少区分 `read / edit / execute / admin`；默认 Agent 只读。

## 不要做的事

- 不要把 `FileProjectStore` 重新接回生产 CLI/MCP。
- 不要为了“能跑”而重新返回假 `queued`。
- 不要直接将 Agent 输入 `String()` 后写入项目；必须先经 Zod/契约校验。
- 不要在未同时更新画布快照前打开写入开关。
