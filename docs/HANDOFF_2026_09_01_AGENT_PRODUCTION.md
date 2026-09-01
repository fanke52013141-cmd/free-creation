# Agent 生产入口与执行链路交接（2026-09-01）

## 本轮完成

本轮把 Agent 对接从“可发现的草稿接口”收口为可验证的生产链路：

1. **MCP 生产启动烟测**：`scripts/canvas-mcp.cjs` 显式设置
   `ELECTRON_RUN_AS_NODE=1` 后启动 Electron 二进制。这样保留 `better-sqlite3`
   的 Electron ABI，同时以标准 stdio 服务存活，不再因没有 BrowserWindow 而立即退出。
   `pnpm agent:test-mcp-production` 会构建真实 bundle、发送 JSON-RPC `initialize`，并
   在 10 秒内断言响应。
2. **revision / idempotency 全链路**：当 `CANVAS_AGENT_WRITE=draft` 时，MCP 与 CLI 的
   节点/连线写入都必须带 `expectedGraphVersion` 和 8–128 字符的 `idempotencyKey`。
   幂等记录由 SQLite migration v4 的 `agent_idempotency` 表持久化；相同 key + 相同
   payload 重试返回首个结果，不会重复创建节点，key 被用于不同 payload 会被拒绝。
   `project.json.write-lock` 保护跨 Electron 进程的“读版本→校验→写文件”临界区，避免
   CLI/MCP 与桌面端并发覆盖。
3. **真实 Headless Run**：`CANVAS_AGENT_EXECUTE=enabled` 时 CLI/MCP 创建
   `HeadlessRunExecutor`，直接复用 shared executor 与主进程 Gateway。Run 会从
   `queued → running → succeeded/failed` 真实落盘；范围外上游的已持久化输出也可被
   单节点执行消费。未显式开启时，执行请求明确返回 `EXECUTION_DISABLED` 或
   `EXECUTION_UNAVAILABLE`，不再伪造 queued 成功。
4. **真实接口契约产物**：`generated/agent-contracts.json` 的 `mcpTools` 来自
   `defineTools()` 的实际工具列表；节点配置不再伪装为 MCP 工具或 CLI 命令，统一放到
   `nodeConfigSchemas`，供通用 `create_node/configure_node` 的 `params` 使用。
5. **Lint**：生产源码继续严格；测试夹具单独关闭 mock 所需的 `any` / 显式返回类型 /
   未使用变量规则。`pnpm lint` 当前为零 error、零 warning。

## 运行方式

```powershell
# 默认只读 MCP
pnpm agent:mcp

# 允许 Agent 写草稿；每次节点/连线写入必须传 revision/key
$env:CANVAS_AGENT_WRITE = 'draft'
pnpm agent:mcp

# 允许真实无界面执行（可能产生本地计算或供应商调用）
$env:CANVAS_AGENT_EXECUTE = 'enabled'
pnpm agent:mcp
```

CLI 与 MCP 使用相同开关。CLI 写入参数为：

```powershell
canvas node create --project <id> --type text --revision <graphVersion> --idempotency-key <stable-key>
canvas node connect --project <id> --from <nodeId:out-text> --to <nodeId:in-text> --revision <graphVersion> --idempotency-key <stable-key>
```

MCP 写入工具 `create_node`、`configure_node`、`delete_node`、`connect_nodes`、
`disconnect_nodes` 均在 `tools/list` 中公开相同字段及使用说明。

## 后续硬门槛

- 新增或修改节点：先改 `src/capabilities/definitions.ts` 的能力契约，再运行
  `pnpm agent:generate`；必须提交 `generated/agent-contracts.json`，并运行
  `pnpm agent:check-contracts`。不要在 MCP/CLI 内单独增加节点专用 schema。
- 新增 MCP 工具：改 `defineTools()` 与 `toolArgumentSchemas`，再运行生成和生产烟测。
- 新增 CLI 命令：更新 CLI help 与契约生成描述；补一条 CLI/应用服务回归。
- 修改写入语义：必须保留 revision 与 idempotency 测试；幂等重试优先于 revision
  冲突判断，首次请求仍必须进行 revision 校验。
- 修改 headless 执行器或 Gateway：至少覆盖成功、前置失败、单节点消费已持久化上游输出，
  并执行 `pnpm agent:test-mcp-production`。

## 验证门禁

```powershell
pnpm lint
pnpm typecheck
pnpm test
pnpm agent:generate
pnpm agent:check-contracts
pnpm agent:test-mcp-production
pnpm build
git diff --check
```

`agent:check-contracts` 故意要求生成文件已提交；在修改 `generated/agent-contracts.json`
但尚未提交的工作树中，它会以 diff 退出，这是预期的防漏提交行为。
