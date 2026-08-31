# Agent 对接交付交接文档

> 交付日期：2026-09-01
>
> 对应方案：[docs/AGENT_INTEGRATION_PLAN.md](./AGENT_INTEGRATION_PLAN.md)
>
> 交付范围：P0 能力审计 → P1 能力注册表 + 应用服务层 → P2 CLI 适配器 → P3 MCP 适配器 → 类型检查 → 测试
>
> 验证基线：60 个测试文件、779 项用例全部通过；Node + Web 双端 TypeScript 类型检查零错误。

---

## 1. 本轮交付内容总览

本轮将 Canvas Studio 从"只能由桌面页面操作"升级为"可被 Agent 无界面调用的稳定创作引擎"。核心交付分为四个模块：

| 模块 | 目录 | 职责 | 状态 |
| --- | --- | --- | --- |
| 能力注册表 | `src/capabilities/` | 23 个节点能力的唯一定义来源，派生 MCP Schema、CLI 规格、能力矩阵和契约快照 | 已完成 |
| 应用服务层 | `src/application/` | 无 React 依赖的无界面核心：项目、节点、连线、校验、执行、资产和审计 | 已完成 |
| CLI 适配器 | `src/cli/` | 命令行入口，调用同一应用服务，支持 `--json` 结构化输出 | 已完成 |
| MCP 适配器 | `src/mcp/` | stdio JSON-RPC 2.0 服务，15 个通用工具 + 资源发现，供 Agent 调用 | 已完成 |

### 未包含在本轮的范围

- P4（Agent 友好增强）：自然语言生成工作流、自动排版、运行前成本预估、缺失参数补全、关键节点人工确认、失败后局部重试、产物对比与选择。
- P5（桌面端与 Agent 双向同步）：实时刷新、单写者锁、本地守护进程。
- 真实供应商执行：当前 `run_node` 和 `run_workflow` 返回 `queued` 状态，尚未接入真实模型网关。

---

## 2. 架构总览

```text
Agent / MCP Client          PowerShell / CI          Electron Desktop
         │                        │                        │
         ▼                        ▼                        ▼
    MCP Adapter              CLI Adapter            Desktop（未来适配）
         └────────────────────┬───────────────────────┘
                                ▼
                     createServices() 工厂
          ┌────────────┬──────────────┬──────────────┐
          ▼            ▼              ▼              ▼
    NodeService  WorkflowService  ProjectService  CapabilityService
          │            │              │              │
          └────────────┴──────────────┴──────────────┘
                                ▼
                    FileProjectStore / ProjectStore
                                ▼
                   CapabilityRegistry（唯一事实来源）
```

所有入口共用同一个 `ServiceContainer`，业务规则只存在于服务层，适配器不做业务判断。

---

## 3. 能力注册表（Capability Registry）

### 3.1 核心文件

| 文件 | 职责 |
| --- | --- |
| `src/capabilities/types.ts` | 类型定义：`Capability`、`CapabilityDefinition`、`ConfigFieldSchema`、`CapabilityPort`、`McpToolSchema`、`CliCommandSpec`、`CapabilityMatrixEntry`、`ContractSnapshot` |
| `src/capabilities/registry.ts` | 注册表实现：`defineCapability()`、`getCapability()`、`listCapabilities()`、`getCapabilityByNodeType()`、`isEmpty()`、`clearRegistry()`、快照管理 |
| `src/capabilities/definitions.ts` | 23 个节点的能力定义，通过 `defineCapability()` 注册 |
| `src/capabilities/generate.ts` | 自动生成层：MCP Schema、CLI 规格、矩阵条目、契约快照、快照差异和破坏性变更判定 |
| `src/capabilities/index.ts` | 入口：导出注册表 API 并触发 `definitions.ts` 的自动注册 |

### 3.2 已注册的 23 个能力

| 能力 ID | 节点类型 | 输入端口数 | 输出端口数 | 契约版本 |
| --- | --- | --- | --- | --- |
| `text.source` | `text` | 1 | 1 | 1 |
| `image.source` | `image` | 0 | 1 | 1 |
| `image.crop` | `image-crop` | 1 | 1 | 1 |
| `image.split` | `image-split` | 1 | 2 | 1 |
| `image.generate` | `image-gen` | 3 | 1 | 1 |
| `image.edit` | `image-edit` | 2 | 1 | 1 |
| `video.source` | `video` | 0 | 1 | 1 |
| `video.frame` | `video-frame` | 1 | 1 | 1 |
| `video.clip` | `video-clip` | 1 | 1 | 1 |
| `video.audio` | `video-audio` | 1 | 1 | 1 |
| `audio.vocal-separate` | `vocal-separate` | 1 | 2 | 1 |
| `audio.source` | `audio` | 2 | 1 | 1 |
| `audio.speech` | `speech` | 2 | 1 | 1 |
| `audio.tts` | `tts` | 2 | 1 | 1 |
| `text.chat` | `chat` | 1 | 1 | 1 |
| `logic.process` | `processor` | 1 | 1 | 1 |
| `code.execute` | `code` | 3 | 1 | 1 |
| `json.edit` | `json` | 2 | 1 | 1 |
| `json.structured` | `structured` | 2 | 1 | 1 |
| `storyboard.create` | `storyboard` | 2 | 2 | 1 |
| `ai.process` | `ai-process` | 2 | 3 | 1 |
| `logic.iterate` | `iterate` | 1 | 2 | 1 |
| `director.previs` | `director` | 3 | 4 | 1 |

### 3.3 关键设计决策

1. **每个能力只定义一次**：`defineCapability()` 是唯一的注册入口，输入、输出、配置 Schema、执行模式和暴露标志均在定义中声明。
2. **三个入口派生自同一注册表**：MCP Schema、CLI 规格和能力矩阵由 `generate.ts` 从注册表自动生成，禁止手写重复定义。
3. **版本语义化**：`version` 采用 `major.minor.patch` 格式，`isBreakingChange()` 根据端口增删和类型变化自动判定。
4. **快照防漂移**：`generateSnapshot()` 记录每个能力的完整契约，`diffSnapshots()` 在变更时显示差异并标注是否为破坏性变更。

### 3.4 如何新增节点能力

```typescript
// src/capabilities/definitions.ts
defineCapability({
  id: 'image.enhance',
  nodeType: 'image-enhance',
  version: '1.0.0',
  title: '图片增强',
  description: '提升图片分辨率和画质',
  category: 'image',
  inputs: [
    { id: 'in-image', valueType: 'image', label: '原图', required: true, cardinality: 'one' }
  ],
  outputs: [
    { id: 'out-image', valueType: 'image', label: '增强图', required: true, cardinality: 'one' }
  ],
  configSchema: {
    scale: { type: 'number', label: '放大倍率', default: 2, minimum: 1, maximum: 4 },
    mode: { type: 'enum', label: '增强模式', default: 'standard', enumValues: ['standard', 'creative'] }
  },
  executionMode: 'auto',
  expose: { desktop: true, cli: true, mcp: true }
})
```

新增后无需修改 MCP 或 CLI 适配器——通用工具会自动发现新能力。

---

## 4. 应用服务层（Application Services）

### 4.1 核心文件

| 文件 | 职责 |
| --- | --- |
| `src/application/types.ts` | `Result<T>` 类型（`ok`/`fail`）、`ProjectStore` 接口、请求/响应类型 |
| `src/application/index.ts` | `createServices()` 工厂，组装所有服务并返回 `ServiceContainer` |
| `src/application/services/node-service.ts` | 节点 CRUD、连线管理、端口类型校验、幂等性缓存 |
| `src/application/services/workflow-service.ts` | 工作流校验、成本预估、单节点/全工作流运行（返回 runId） |
| `src/application/services/project-service.ts` | 项目 CRUD |
| `src/application/services/capability-service.ts` | 能力查询和节点配置校验 |
| `src/application/services/audit-log.ts` | 内存审计日志，记录操作者、动作、差异和运行结果 |
| `src/application/stores/file-store.ts` | 基于 JSON 文件的 `ProjectStore` 实现，原子写入、内存缓存 |

### 4.2 Result<T> 模式

所有服务方法返回 `Result<T>`，不抛异常：

```typescript
type Result<T> =
  | { ok: true; data: T }
  | { ok: false; error: ServiceError }
```

调用方使用 `unwrap()` 提取值或处理错误：

```typescript
const result = await services.nodes.createNode({ ... })
if (result.ok) {
  console.log(result.data.node.id)
} else {
  console.error(result.error.message)
}
```

### 4.3 ServiceContainer 接口

```typescript
interface ServiceContainer {
  projects: ProjectService
  nodes: NodeService
  workflows: WorkflowService
  capabilities: CapabilityService
  auditLog: AuditLog
  store: ProjectStore
}
```

通过 `createServices()` 创建，所有服务共享同一个 `ProjectStore` 实例。

### 4.4 幂等性

每个写操作支持 `idempotencyKey`，重复提交相同 key 时返回缓存结果，不会重复创建节点或重复扣费：

```typescript
await services.nodes.createNode({
  projectId: 'proj_1',
  nodeType: 'text',
  idempotencyKey: 'agent-turn-001-create-text'
})
// 即使重试，也只会创建一个节点
```

### 4.5 连线类型校验

`isPortTypeCompatible()` 检查源端口和目标端口的值类型是否兼容：

| 源类型 | 兼容目标类型 |
| --- | --- |
| `text` | `text`, `markdown`, `json`, `any` |
| `markdown` | `markdown`, `text`, `any` |
| `image` | `image`, `any` |
| `video` | `video`, `any` |
| `audio` | `audio`, `any` |
| `json` | `json`, `any` |
| `any` | `any` |

---

## 5. CLI 适配器

### 5.1 入口

`src/cli/index.ts` 导出 `runCli(args: string[])` 函数，可在 Node.js 环境中直接调用。

### 5.2 支持的命令

```powershell
# 项目管理
canvas project list
canvas project get <id>
canvas project create <name>
canvas project delete <id>

# 能力查询
canvas capability list
canvas capability show <id>
canvas capability node-type <nodeType>

# 节点操作
canvas node create --project <id> --type <nodeType> [--config '{"key":"value"}']
canvas node get --project <id> --node <nodeId>
canvas node list --project <id>
canvas node update --project <id> --node <nodeId> --config '{"key":"value"}'
canvas node delete --project <id> --node <nodeId>

# 连线操作
canvas node connect --project <id> --from <nodeId:portId> --to <nodeId:portId>
canvas node disconnect --project <id> --from <nodeId:portId> --to <nodeId:portId>

# 工作流
canvas workflow validate --project <id>
canvas workflow estimate --project <id>
canvas workflow run --project <id> [--node <nodeId>] [--dry-run]

# 资产
canvas artifact list --project <id>
canvas artifact get --project <id> --artifact <artifactId>

# MCP 服务
canvas mcp serve
```

所有命令支持 `--json` 标志，输出与 MCP 完全相同的结构化结果。

### 5.3 使用示例

```typescript
import { runCli } from './src/cli'

// 列出所有能力
await runCli(['capability', 'list'])

// 创建项目并添加节点（JSON 输出）
await runCli(['project', 'create', 'my-project', '--json'])
await runCli(['node', 'create', '--project', 'proj_1', '--type', 'text', '--json'])
```

---

## 6. MCP 适配器

### 6.1 入口

`src/mcp/server.ts` 导出 `startMcpServer(stdin, stdout)` 函数，启动基于 stdio 的 JSON-RPC 2.0 服务。

### 6.2 协议

- 传输：stdio（NDJSON 帧化）
- 协议版本：`2024-11-05`
- 服务名称：`canvas-studio-agent`
- 支持的版本：`0.1.0`

### 6.3 暴露的 15 个工具

#### 查询类

| 工具名 | 参数 | 说明 |
| --- | --- | --- |
| `list_projects` | 无 | 列出所有项目 |
| `get_project` | `projectId` | 获取项目详情 |
| `list_node_types` | 无 | 列出所有可用节点类型 |
| `get_capability` | `capabilityId` | 获取能力的输入、输出和配置 Schema |
| `get_capability_by_node_type` | `nodeType` | 按节点类型查询能力 |
| `validate_node_config` | `nodeType`, `config` | 校验节点配置是否符合能力契约 |

#### 编辑类

| 工具名 | 参数 | 说明 |
| --- | --- | --- |
| `create_node` | `projectId`, `nodeType`, `config?`, `idempotencyKey?` | 创建节点并自动生成端口 |
| `configure_node` | `projectId`, `nodeId`, `config` | 更新节点配置（合并模式） |
| `delete_node` | `projectId`, `nodeId` | 删除节点及其关联连线 |
| `connect_nodes` | `projectId`, `fromNode`, `fromPort`, `toNode`, `toPort` | 创建数据连线（带类型校验） |
| `disconnect_nodes` | `projectId`, `fromNode`, `fromPort`, `toNode`, `toPort` | 断开连线 |

#### 执行类

| 工具名 | 参数 | 说明 |
| --- | --- | --- |
| `validate_workflow` | `projectId` | 校验整个工作流的完整性和连线合法性 |
| `estimate_run` | `projectId` | 预估运行成本、供应商需求和缺失配置 |
| `run_node` | `projectId`, `nodeId`, `dryRun?` | 运行单个节点，返回 `runId` |
| `run_workflow` | `projectId`, `dryRun?` | 运行整个工作流，返回 `runId` |

### 6.4 资源

MCP 服务同时暴露以下资源供 Agent 读取：

| 资源 URI | 说明 |
| --- | --- |
| `canvas://capabilities` | 所有能力的摘要列表 |
| `canvas://capabilities/{capabilityId}` | 单项能力的详细契约 |
| `canvas://projects` | 项目列表 |
| `canvas://projects/{projectId}` | 项目详情和节点图 |

### 6.5 启动方式

```typescript
import { startMcpServer } from './src/mcp/server'
import { createReadStream, createWriteStream } from 'fs'

// 标准 stdio 模式
startMcpServer(process.stdin, process.stdout)
```

或通过 CLI 入口：

```powershell
node dist/cli/index.js mcp serve
```

### 6.6 Agent 交互示例

Agent 连接后执行以下交互流程：

```
1. tools/call list_node_types → 发现 23 种节点
2. tools/call get_capability(nodeType: "image-gen") → 了解生图节点需要 3 个输入端口
3. tools/call create_node(projectId, nodeType: "text") → 创建文本节点
4. tools/call create_node(projectId, nodeType: "image-gen") → 创建生图节点
5. tools/call connect_nodes(projectId, fromNode: text, fromPort: out-text, toNode: image-gen, toPort: in-prompt)
6. tools/call validate_workflow(projectId) → 校验工作流
7. tools/call run_node(projectId, nodeId: image-gen) → 运行生图节点，获得 runId
8. 后续查询运行状态和产物
```

---

## 7. 自动生成与防漂移机制

### 7.1 生成 API

`src/capabilities/generate.ts` 提供以下生成函数：

| 函数 | 输入 | 输出 |
| --- | --- | --- |
| `generateMcpToolSchema(cap)` | 单个能力 | MCP 工具的 JSON Schema（名称、描述、属性、required） |
| `generateCliSpec(cap)` | 单个能力 | CLI 命令规格（命令名、选项、默认值） |
| `generateMatrixEntry(cap)` | 单个能力 | 能力矩阵条目（节点、命令、CLI、MCP、测试标志、版本） |
| `generateSnapshot(cap)` | 单个能力 | 契约快照（端口、配置、版本和时间戳） |
| `generateAll(capabilities)` | 全部能力 | 包含上述所有的完整生成结果 |
| `diffSnapshots(old, new)` | 两个快照 | 差异报告（新增/删除/修改的端口和配置） |
| `isBreakingChange(diff)` | 差异报告 | 布尔值，判定是否为破坏性变更 |

### 7.2 CI 防漏检查

`test/agent/contract-consistency.test.ts` 实现了以下自动化门禁：

1. **三入口一致性**：MCP 工具名、CLI 命令名和能力定义都基于同一 `nodeType`，`configSchema` 字段集一致。
2. **MCP Schema 完整性**：每个暴露给 MCP 的能力都生成有效 Schema，required 列表与 configSchema 一致，enum 字段包含约束。
3. **CLI 规格完整性**：每个暴露给 CLI 的能力都生成有效规格，选项有 name、type 和 required。
4. **生成幂等性**：两次调用 `generateAll()` 产生相同结构化结果（忽略时间戳）。
5. **能力矩阵完整性**：矩阵条目数与能力数一致，每个能力的 id 和 nodeType 出现在矩阵中。
6. **快照工作流**：新增可选字段判定为非破坏性，删除输出端口判定为破坏性，修改端口类型判定为破坏性。

### 7.3 变更处理规则

| 变化类型 | 是否破坏性 | 处理方式 |
| --- | --- | --- |
| 优化内部实现 | 否 | 契约不变 |
| 修复 Bug | 否 | 契约不变 |
| 新增可选配置字段 | 否 | 提升版本 minor |
| 新增输入端口 | 是 | 提升版本 major，判断兼容性 |
| 删除输出端口 | 是 | 提升版本 major，提供迁移 |
| 修改端口值类型 | 是 | 提升版本 major |

---

## 8. 测试覆盖

### 8.1 测试文件

| 文件 | 测试数 | 覆盖范围 |
| --- | --- | --- |
| `test/agent/capability-registry.test.ts` | 32+ | 注册表注册、查询、校验、快照、23 个生产能力定义集成 |
| `test/agent/capability-generate.test.ts` | 30+ | MCP Schema 生成、CLI 规格生成、矩阵条目、快照差异、破坏性变更判定 |
| `test/agent/application-services.test.ts` | 50+ | NodeService CRUD、连线校验、幂等性；WorkflowService 校验/预估/运行；ProjectService；CapabilityService；AuditLog |
| `test/agent/mcp-server.test.ts` | 20+ | JSON-RPC 协议、initialize、tools/list、tools/call、resources/list、resources/read、完整 Agent 交互流程 |
| `test/agent/contract-consistency.test.ts` | 19 | 三入口一致性、MCP Schema 完整性、CLI 规格完整性、生成幂等性、能力矩阵、快照工作流 |

### 8.2 测试基线

```text
Test Files:  60 passed (60)
Tests:       779 passed (779)
Duration:    ~17s
```

### 8.3 关键测试模式

**MockStore 模式**（用于服务层测试，无需文件系统）：

```typescript
class MockStore implements ProjectStore {
  private projects = new Map<string, ProjectFile>()
  // ... in-memory 实现
}
```

**PassThrough 流模式**（用于 MCP 服务测试）：

```typescript
const stdin = new PassThrough()
const stdout = new PassThrough()
startMcpServer(stdin as any, stdout as any)
// 写入 JSON-RPC 请求，读取响应
```

**vi.resetModules() 模式**（用于集成测试中重新加载模块）：

```typescript
async function freshImport() {
  vi.resetModules()
  return await import('@capabilities')
}
```

---

## 9. 关键类型别名配置

### 9.1 tsconfig.node.json

```json
{
  "compilerOptions": {
    "paths": {
      "@capabilities": ["./src/capabilities/index.ts"],
      "@application": ["./src/application/index.ts"]
    }
  }
}
```

### 9.2 vitest.config.ts

```typescript
resolve: {
  alias: {
    '@capabilities': path.resolve(__dirname, 'src/capabilities/index.ts'),
    '@application': path.resolve(__dirname, 'src/application/index.ts'),
  }
}
```

注意：别名不带前导斜杠，与 TypeScript paths 配置一致。

---

## 10. 环境变量

| 变量名 | 默认值 | 说明 |
| --- | --- | --- |
| `CANVAS_DATA_DIR` | `~/.canvas-studio/data` | 项目数据的文件存储根目录 |

---

## 11. 下一步建议

### 短期（P4 Agent 友好增强）

1. **自然语言生成工作流**：Agent 接收用户自然语言描述，自动选择能力并组装完整工作流。
2. **运行前成本预估**：`estimate_run` 接入真实供应商价格表，返回预估费用。
3. **缺失参数补全**：运行前检测缺失的必填配置，提示 Agent 补全。
4. **关键节点人工确认**：Agent 在高成本节点前暂停，等待用户确认后继续。
5. **失败后局部重试**：只重跑失败的节点，不影响已成功的上游节点。
6. **产物对比与选择**：返回多个候选结果，Agent 展示给用户选择。

### 中期（P5 双向同步）

1. **桌面端实时刷新**：Agent 创建节点或运行流程后，桌面画布实时更新。
2. **桌面修改同步**：用户在画布中修改后，Agent 重新读取时获得最新状态。
3. **单写者锁**：防止 Electron、CLI、MCP 同时写同一个项目。
4. **本地守护进程**：常驻后台服务，统一管理项目访问和供应商调用。

### 长期（真实执行集成）

1. **供应商网关接入**：将 `run_node` 和 `run_workflow` 从 `queued` 状态接入真实模型执行。
2. **异步运行管理**：完整的 `queued → validating → running → succeeded/failed/cancelled` 状态机。
3. **媒体产物存储**：运行结果保存为可通过 `artifactId` 引用的资产。
4. **缩略图和预览**：为图片、视频和音频生成缩略图，支持 Agent 在对话中展示。

---

## 12. 接手注意事项

1. **不要在适配器中写业务规则**。所有节点逻辑、校验和默认值必须在 `src/capabilities/definitions.ts` 或 `src/application/services/` 中定义。
2. **新增节点时只修改注册表**。在 `definitions.ts` 中调用 `defineCapability()`，MCP 和 CLI 会自动发现新能力。
3. **修改现有能力时运行契约测试**。`test/agent/contract-consistency.test.ts` 会自动检测破坏性变更。
4. **保持 Result<T> 模式**。服务方法不抛异常，返回 `ok` 或 `fail`，调用方负责处理。
5. **幂等键必须唯一**。Agent 重试时使用相同的 `idempotencyKey` 避免重复操作。
6. **端口类型变更属于破坏性变更**。必须提升版本号并通过快照差异测试。
7. **不要手写 MCP 工具 Schema**。使用 `generateMcpToolSchema()` 从注册表自动生成。
8. **不要手写 CLI 命令规格**。使用 `generateCliSpec()` 从注册表自动生成。

---

## 13. 文件清单

### 新增文件

```text
src/capabilities/
├── definitions.ts          # 23 个能力定义
├── generate.ts             # 自动生成层
├── index.ts                # 入口 + 自动注册
├── registry.ts             # 注册表实现
└── types.ts                # 类型定义

src/application/
├── index.ts                # createServices() 工厂
├── types.ts                # Result<T>、ProjectStore、请求/响应类型
├── services/
│   ├── audit-log.ts        # 内存审计日志
│   ├── capability-service.ts  # 能力查询和配置校验
│   ├── node-service.ts     # 节点 CRUD 和连线管理
│   ├── project-service.ts  # 项目 CRUD
│   └── workflow-service.ts # 校验、预估和运行
└── stores/
    └── file-store.ts       # JSON 文件持久化

src/cli/
└── index.ts                # CLI 适配器

src/mcp/
└── server.ts               # MCP stdio 服务

test/agent/
├── application-services.test.ts
├── capability-generate.test.ts
├── capability-registry.test.ts
├── contract-consistency.test.ts
└── mcp-server.test.ts

docs/
├── AGENT_INTEGRATION_PLAN.md       # 方案文档
└── HANDOFF_2026_09_01_AGENT_INTEGRATION.md  # 本文档
```

### 修改的文件

```text
tsconfig.node.json          # 新增 @capabilities 和 @application 路径别名
tsconfig.web.json           # 同步路径别名
tsconfig.test.json          # 同步路径别名
vitest.config.ts            # 新增测试路径别名
HANDOFF.md                  # 更新交接摘要
```
