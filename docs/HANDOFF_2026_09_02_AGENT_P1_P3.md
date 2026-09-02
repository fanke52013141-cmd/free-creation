# Agent P1–P3 交接与验收（2026-09-02）

## 本轮完成

### P1：Agent 端到端真实验收

- MCP 增加了不依赖外部模型或 API Key 的真实执行验收：创建两个文本节点、建立真实端口连线、执行 Headless Run、查询持久化 Run 终态，并确认下游正文已落盘。
- `text` 是独立的节点正文参数；`params` 只保存固定配置。`create_node` 与 `configure_node` 均支持 `text`。
- 测试/嵌入式 MCP 可受控注入 `executionEnabled` 与 gateway；生产仍要求 `CANVAS_AGENT_EXECUTE=enabled` 才开启真实执行。

### P2：Agent 工具补全

- MCP 与 CLI 支持 `run get/list/cancel/retry`。取消发送给真实 Headless consumer；重试只允许终态运行并重新执行。
- 新增 MCP `get_run`、`list_runs`、`cancel_run`、`retry_run`、`get_artifact`、`list_run_artifacts`。
- 新增资源模板 `canvas://runs/{runId}`、`canvas://artifacts/{artifactId}`。媒体资源只返回安全元数据和 `resourceUri`，不会暴露本机 `path`、缩略图路径或文本资产正文。

### P3：节点契约唯一来源收口

- `src/capabilities/definitions.ts` 成为 Active 节点的运行时契约来源。Capability 端口新增 `schema`，所有 JSON 端口强制使用已注册 Schema。
- 画布注册时把版本、名称、说明、分类、执行模式和静态端口投影自 Capability；UI Spec 只保留视觉、执行器、输出投影和动态端口解析。
- Agent 创建节点会复制 Schema，并统一使用 `340 × 260` 初始尺寸。
- 服务层连线验证同时检查 JSON Schema：只有相同 Schema 或显式 `json.any@1` 可连接。
- 新增 `test/agent/node-contract-source.test.ts`，防止画布、Agent、CLI、MCP 的契约漂移。

## 本轮验证

已通过：`npm.cmd run lint`、`npm.cmd run typecheck`、`npm.cmd test`、`npm.cmd run agent:generate`、`npm.cmd run agent:test-mcp-production`、`npm.cmd run build` 与 `git diff --check`。

全量 Vitest：**63 个文件，新增 P1/P2/P3 回归均通过**。提交前再运行 `npm.cmd run agent:check-contracts`；它会要求生成文件已与提交内容一致。

## 后续验收重点

1. 使用 `CANVAS_AGENT_WRITE=draft` 复验 revision 与 idempotency 写入保护。
2. 只在明确允许本地计算或供应商调用时设置 `CANVAS_AGENT_EXECUTE=enabled`；先跑文本工作流，再测实际模型。
3. 用 `get_run` 或 `canvas://runs/{runId}` 观察状态；用 `list_run_artifacts` 或 `canvas://artifacts/{artifactId}` 获取安全产物引用。
4. 新增或修改节点时，先更新 Capability，再更新 UI/执行器，并运行 `npm.cmd run verify`、`npm.cmd run agent:generate` 和 `npm.cmd run agent:check-contracts`。
