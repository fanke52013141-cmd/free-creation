# 真实 MCP 客户端验收报告（第一轮）

日期：2026-11-08。目标：证明"Agent 真能通过 MCP 用这些能力"，而不是只在单元测试里逻辑正确。

**工具**：`qa/mcp-acceptance.cjs`——用官方 `@modelcontextprotocol/sdk` 的
`Client` + `StdioClientTransport` 起**真实 MCP 协议栈**（stdio JSON-RPC），
连接 `electron out/main/local-agent.js mcp serve --stdio`，在一次真实 Electron 应用会话里调。

**前提**：应用必须已激活（否则停在授权窗，本地接入服务不启动）。脚本把本机已激活的
`security/` 目录复制进隔离数据目录——授权是设备绑定的，同机有效，**不伪造任何签名**。

## 结论：91 项检查全通过，发现并修复 1 个真实缺陷

```
工具数=133  检查=91  通过=91  失败=0
```

### A. 协议层（真实 MCP）

| 检查 | 结果 |
| --- | --- |
| MCP initialize 握手 | 通过 |
| `tools/list` 返回工具数 = 133 | 通过 |
| 所有工具 `inputSchema` 都是 object 型 | 通过 |
| 经 MCP `project.create` 建项目并拿到 ID | 通过 |
| 经 MCP `project.open` 在真实桌面打开画布 | 通过 |

### B. 只读操作全量扫描（56 项，全部真实调用）

按各自 `inputSchema` 生成最小合法入参，逐个经 MCP 调用：

- **35 项返回 `completed`**：读能力真实可用；
- **21 项返回 `failed` + 业务码**（`NOT_FOUND`×9、`NODE_NOT_FOUND`×5、`AGENT_NODE_MISSING`×2、
  `STORAGE_UNAVAILABLE`、`ASSET_VERSION_MISSING`、`MODEL_BINDING_NOT_FOUND`、`MEDIA_NOT_FOUND`、
  `INPUT_NOT_FOUND`）：**接线正确**，缺的只是前置数据（占位 id 不存在）；
- **0 项异常/超时/纯文本错误**。

### C. 权限与安全闸门（10 项，必须是"被拦住"）

| 操作 | 实际返回 |
| --- | --- |
| `environment.videoEngine.install`（未确认） | `INSTALL_CONFIRM_REQUIRED` |
| `provider.testConnection`（未确认联网） | `NETWORK_CONFIRM_REQUIRED` |
| `model.validate`（未确认费用） | `NETWORK_CONFIRM_REQUIRED` |
| `project.import`（路径越界） | `PATH_NOT_ALLOWED` |
| `canvas.history`（版本冲突） | `REVISION_CONFLICT` |
| `provider.package.preview`（文件不存在） | `INPUT_NOT_FOUND` |
| `run.cancel`（任务不存在） | `NOT_FOUND` |
| `graph.patch`（空 ops） | `INVALID_INPUT`（结构化） |
| `flowAgent.cooperate`（缺字段） | `INVALID_INPUT`（结构化） |
| `license.getStatus`（不在注册表） | `UNSUPPORTED_OPERATION`（结构化） |

**零副作用**：所有被拦路径都没有产生请求、写入或费用。

## 发现的真实缺陷（已修复）

**MCP 协议层错误只回纯文本，没有结构化错误码。**

修复前：参数校验失败时返回 `{isError:true, content:[{text:'INVALID_INPUT'}]}`。
真实 Agent 客户端只能看到一串文本，**无法区分"缺少幂等键"和"字段类型不对"**，
也无法稳定分支（文本随时可能改）。

修复（`src/local-agent/index.ts`）：协议层失败也返回符合 `operationResponseSchema` 的结构化回执
`{apiVersion, requestId, operationId, traceId, status:'failed', error:{code, phase, retryable, detail}}`，
其中 `detail` 只放**字段路径**，不放请求正文、本机路径或密钥。

验证：修复后同一批调用从"3 项纯文本错误 + 2 项客户端抛错"变为
**0 纯文本错误、0 抛错**，10 项拦截全部返回可分支的 `error.code`。

## 未覆盖（如实列出，不假装通过）

1. **写 / 删除 / 导出 / 执行类 104 项**（effect = write 56 / delete 8 / export 7 / execute 5，
   另有部分读需特定业务前置）：这些需要一个**完整业务场景**才能安全调用（建节点→连线→执行→读产物），
   否则就是"用假数据打真实业务"。计划在下一轮按业务族分场景验收：项目与图编辑、
   媒体与传输、资源库、Agent Flow、模型与环境。
2. **付费生成真实调用**：按用户要求由本人自测，本报告不声称供应商已验收。
3. **非 Claude/MCP 客户端**：本轮只用官方 SDK 客户端；若用户要用其它客户端（如某些
   只支持 SSE 传输的），需要另做传输层适配验收。
4. 既有 `scripts/test-local-agent-access.cjs`（旧验收脚本）里硬编码了
   `tools.length===34`，已随操作数增长而过期；本报告的脚本按 133 校验，
   旧脚本建议改为读 `verify:agent-access` 的操作数而不是写死。

## 复现方式

```powershell
# 前提：本机已激活，且已 npm run build
node qa/mcp-acceptance.cjs
# 报告：qa/local-agent-access/mcp-acceptance/report.json
```
