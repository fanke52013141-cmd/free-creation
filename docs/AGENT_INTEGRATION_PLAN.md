# Canvas Studio 与 Agent 对接方案

> 状态：已定方案，尚未进入实现
>
> 制定日期：2026-09-01
>
> 目标：让 Agent 在不依赖桌面页面和坐标点击的情况下，发现 Canvas Studio 的能力、理解每个节点的输入/输出与设置项、创建并运行真实工作流，并在对话中查看媒体产物。

## 1. 产品目标与边界

Canvas Studio 继续负责项目、节点契约、真实连线、执行调度、供应商调用、运行记录和媒体资产的稳定性；Agent 负责理解用户意图、选择能力、组装流程、填写参数、触发运行和判断结果。桌面画布保留为可视化检查、调试和人工干预界面，不再是唯一操作入口。

本方案明确不采用以下方式：

- 不让 Agent 通过屏幕坐标、鼠标录制或 DOM 选择器模拟用户操作。
- 不为每个节点手写一套互不关联的 MCP 参数定义。
- 不让 MCP、CLI 或桌面端分别实现业务规则。
- 不把 API Key、授权头、供应商密钥或任意本地文件访问权暴露给 Agent。
- 不创建脱离现有节点协议的“超级 Agent 节点”或隐藏数据流。

## 2. 结论：MCP 为主入口，CLI 为验证入口

| 入口 | 定位 | 典型用户 |
| --- | --- | --- |
| MCP | Agent 的正式交互入口；提供能力发现、项目编辑、运行控制和产物预览 | Codex、支持 MCP 的对话 Agent |
| CLI | 开发、调试、批处理、回归和故障排查；验证无界面核心是否可独立运行 | 开发者、自动化脚本、CI |
| 桌面端 | 工作流可视化、人工调整、对比和确认 | 最终用户 |

三个入口必须调用同一套无界面应用服务。MCP 是用户最终感知的 Agent 入口，CLI 是实现 MCP 之前的工程验收入口，不是另起一套业务系统。

## 3. 目标架构

```text
Agent / MCP Client        PowerShell / CI        Electron Desktop
         │                      │                       │
         ▼                      ▼                       ▼
    MCP Adapter             CLI Adapter           Desktop Adapter
         └──────────────────────┼───────────────────────┘
                                ▼
                       Application Command Bus
                    （事务、校验、幂等、审计、权限）
                                │
             ┌──────────────────┼──────────────────┐
             ▼                  ▼                  ▼
       Capability Registry  Workflow Service  Execution Service
       （唯一能力定义）       （节点与连线）      （运行与取消）
             │                  │                  │
             └──────────────────┼──────────────────┘
                                ▼
                  Project / Media / Provider Stores
```

### 3.1 必须先处理的现状

当前 `NodeTypeSpec` 位于 renderer，包含 React Body/Settings；执行器也主要位于 renderer。MCP 或 CLI 不能为了读取节点能力而启动 React，也不能直接导入 UI 注册表。因此需要把节点定义拆成两部分：

```ts
interface NodeCapabilitySpec {
  type: NodeTypeId
  contractVersion: number
  title: string
  description: string
  inputs: PortContract[]
  outputs: PortContract[]
  configSchema: JsonSchema
  executionMode: NodeExecutionMode
  agentExposure: AgentExposure
}

interface NodeUiSpec extends NodeCapabilitySpec {
  Body: React.ComponentType<NodeBodyProps>
  Settings?: React.ComponentType<NodeSettingsProps>
  icon: IconName
  color: string
}
```

`NodeCapabilitySpec` 放入无 React 依赖的共享核心；`NodeUiSpec` 只给桌面端使用。MCP、CLI、校验器、文档和测试只读取前者。

## 4. 能力注册表：唯一事实来源

新增 `Capability Registry`，每个可执行节点只定义一次能力：

```ts
defineCapability({
  id: 'image.crop',
  nodeType: 'image-crop',
  contractVersion: 2,
  title: '图片裁剪',
  description: '按固定比例或自由区域裁剪一张图片',
  inputs: [
    { id: 'in-image', valueType: 'image', required: true, cardinality: 'one' }
  ],
  outputs: [
    { id: 'out-image', valueType: 'image', required: true, cardinality: 'one' }
  ],
  configSchema: imageCropConfigSchema,
  executionMode: 'auto',
  agentExposure: {
    discoverable: true,
    configurable: true,
    runnable: true,
    costClass: 'local'
  }
})
```

该注册表派生出：

1. 桌面端输入输出说明与设置项；
2. 工作流连线和运行前校验；
3. CLI 的帮助、参数和返回结构；
4. MCP 的能力目录、工具参数和结果 Schema；
5. 节点契约文档与能力矩阵；
6. 契约快照和兼容性测试。

禁止在 MCP 适配器内再次手写节点输入、输出、默认值或业务校验。

## 5. 让 Agent 知道软件能做什么

采用“稳定的通用工具 + 动态能力目录”，避免每新增一个节点就新增一个 MCP Tool。

### 5.1 MCP Resources

| Resource URI | 内容 |
| --- | --- |
| `canvas://capabilities` | 所有 Agent 可用能力的摘要、版本和分类 |
| `canvas://capabilities/{capabilityId}` | 单项能力的输入、输出、设置 Schema、限制和示例 |
| `canvas://projects/{projectId}` | 项目摘要、版本和当前画布状态 |
| `canvas://projects/{projectId}/workflow` | 节点、端口、真实连线和校验状态 |
| `canvas://runs/{runId}` | 运行状态、步骤、错误、费用摘要和产物索引 |
| `canvas://artifacts/{artifactId}` | 图片、视频、音频或结构化结果的元数据与可读取内容 |

Agent 第一次连接时，通过 MCP 的工具列表知道可以查询能力；需要选择节点时读取 `canvas://capabilities`；需要精确配置时再读取单项能力，不把全量节点说明塞入系统提示词。

### 5.2 稳定 MCP Tools

#### 发现与查询

- `canvas_list_capabilities`
- `canvas_get_capability`
- `canvas_list_projects`
- `canvas_get_project`
- `canvas_get_workflow`
- `canvas_get_node`
- `canvas_list_assets`
- `canvas_get_run`

#### 编辑与编排

- `canvas_create_node`
- `canvas_update_node`
- `canvas_delete_node`
- `canvas_connect_nodes`
- `canvas_disconnect_nodes`
- `canvas_apply_workflow`
- `canvas_auto_layout`

#### 校验与执行

- `canvas_validate_workflow`
- `canvas_estimate_run`
- `canvas_run_node`
- `canvas_run_selection`
- `canvas_run_workflow`
- `canvas_cancel_run`
- `canvas_retry_run`

#### 结果处理

- `canvas_get_artifact`
- `canvas_compare_artifacts`
- `canvas_select_artifact`
- `canvas_send_artifact_to_node`
- `canvas_save_workflow_template`

工具保持通用，具体节点差异由 `capabilityId`、节点契约和 JSON Schema 表达。只有项目备份、供应商授权等真正不同的系统级动作才新增工具。

## 6. Agent 可理解的输入与输出

### 6.1 统一值类型

所有端口值都包装为统一数据包，不直接传递不明字符串：

```ts
type AgentNodeValue =
  | { type: 'text'; value: string }
  | { type: 'markdown'; value: string }
  | { type: 'json'; schemaId?: string; value: unknown }
  | { type: 'image'; artifactId: string; mimeType: string; width?: number; height?: number }
  | { type: 'video'; artifactId: string; mimeType: string; durationMs?: number }
  | { type: 'audio'; artifactId: string; mimeType: string; durationMs?: number }
```

媒体通过 `artifactId` 引用，不把任意绝对路径作为节点参数。只有受控的“导入本地文件”工具可以将用户明确选择的文件转换为媒体资产。

### 6.2 标准工具结果

```json
{
  "ok": true,
  "requestId": "req_01",
  "projectRevision": 42,
  "data": {},
  "warnings": [],
  "nextActions": []
}
```

失败结果必须包含稳定错误码：

```json
{
  "ok": false,
  "requestId": "req_01",
  "error": {
    "code": "NODE_INPUT_MISSING",
    "message": "图片裁剪节点缺少必填输入 in-image",
    "retryable": false,
    "details": {
      "nodeId": "node_12",
      "portId": "in-image"
    }
  }
}
```

### 6.3 媒体在 Agent 页面中的呈现

运行结束后返回产物摘要和 MCP Resource：

```json
{
  "runId": "run_123",
  "status": "succeeded",
  "artifacts": [
    {
      "artifactId": "asset_456",
      "type": "image",
      "mimeType": "image/png",
      "resourceUri": "canvas://artifacts/asset_456",
      "thumbnailUri": "canvas://artifacts/asset_456/thumbnail",
      "sourceNodeId": "node_12"
    }
  ]
}
```

支持媒体内容展示的 Agent 可以直接预览；不支持的客户端仍能读取元数据、导出或在桌面端定位该资产。

## 7. 命令模型与运行模型

### 7.1 不操作坐标，操作语义

Agent 只负责“创建生图节点”“连接文本输出到提示词输入”。节点位置是可选展示参数，缺省使用 `auto_layout`。严禁把“点击 120,80”或 DOM 选择器作为正式接口。

### 7.2 修改使用事务

多步编排先生成变更计划，再原子提交：

```json
{
  "projectId": "project_1",
  "baseRevision": 41,
  "idempotencyKey": "agent-turn-20260901-001",
  "operations": [
    { "op": "createNode", "tempId": "text_1", "nodeType": "text" },
    { "op": "createNode", "tempId": "image_1", "nodeType": "image-gen" },
    { "op": "connect", "from": "text_1:out-text", "to": "image_1:in-prompt" }
  ],
  "mode": "apply"
}
```

- `baseRevision` 防止 Agent 覆盖用户刚在桌面端完成的修改。
- `idempotencyKey` 防止网络或 Agent 重试导致重复创建与重复扣费。
- 任一操作失败时整个批次回滚。
- `mode: dry-run` 只返回计划、错误、供应商和成本预估，不写入项目。

### 7.3 执行必须异步

运行工具立即返回 `runId`；Agent 通过状态查询或进度通知继续：

```text
queued → validating → running → waiting-provider → succeeded
                                         └──────→ failed / cancelled
```

失败不得污染旧结果；重试生成新的 `runId`，保留完整来源和审计记录。

## 8. 权限、安全与本地运行方式

### 8.1 默认使用本地 stdio MCP

第一版只提供本机 `stdio` MCP Server，例如：

```powershell
canvas-studio-agent mcp serve
```

不默认监听局域网端口，不开放远程 HTTP。若将来提供本地 HTTP/Streamable HTTP，必须增加随机会话令牌、来源限制、端口绑定和单实例控制。

### 8.2 权限范围

| Scope | 能力 |
| --- | --- |
| `project:read` | 查询项目、节点、连线、运行和资产摘要 |
| `project:write` | 创建/修改/删除节点与连线 |
| `run:execute` | 调用本地处理器或供应商，可能产生费用 |
| `asset:import` | 导入用户明确指定的文件 |
| `asset:export` | 导出指定产物到用户明确授权的位置 |
| `admin:provider` | 管理供应商；默认不授予 Agent |

危险动作必须显式确认：删除项目、批量删除资产、覆盖导出文件、修改供应商、预计费用超过用户阈值。

### 8.3 密钥边界

Agent 只能看到 `ProviderSummary`、可用能力和模型名称，不能读取 API Key。供应商调用仍由主进程/无界面核心完成，MCP 日志不得记录授权头、完整本地路径和提示词以外的隐私数据。

## 9. CLI 设计与验收用途

CLI 与 MCP 共用 Command Bus，建议首批命令：

```powershell
canvas-studio-agent capability list
canvas-studio-agent capability show image.crop
canvas-studio-agent project list
canvas-studio-agent workflow get --project project_1
canvas-studio-agent workflow validate --project project_1
canvas-studio-agent workflow apply --project project_1 --file workflow.json --dry-run
canvas-studio-agent run workflow --project project_1 --wait
canvas-studio-agent run status run_123
canvas-studio-agent artifact show asset_456
canvas-studio-agent mcp serve
```

CLI 输出默认是适合人的表格，增加 `--json` 后输出与 MCP 完全相同的结构，便于自动化验证。

## 10. 防止节点变化后忘记同步 MCP

不依赖人工记忆，采用以下强制门禁：

1. `NodeCapabilitySpec` 是输入、输出、设置和执行语义的唯一来源。
2. MCP/CLI Schema、能力矩阵和文档由注册表生成，不允许手写重复定义。
3. 每个公共契约保存 JSON 快照；变化时测试必须显示差异。
4. 兼容新增提高 minor 版本，破坏性变化提高 major/`contractVersion` 并提供迁移。
5. `agentExposure.mcp = true` 的能力必须存在 Handler、Schema、成功/失败测试和持久化测试。
6. CI 执行生成命令后检查工作区；出现未提交生成差异则失败。
7. 同一用例分别经 Application、CLI、MCP 调用，比较默认值、错误码和输出结构。

计划生成：

```text
docs/generated/capability-matrix.md
generated/agent/capabilities.json
generated/agent/mcp-tools.json
test/contracts/__snapshots__/*.json
```

## 11. 分阶段实施计划

### AG-0：现状审计与冻结公共词汇（0.5～1 人日）

- 列出所有 Active 节点、端口、Schema、默认值、执行模式、投影和媒体输出。
- 建立 `CapabilityId`、错误码、运行状态、媒体引用的统一词汇。
- 标记哪些能力允许 Agent 发现、配置、运行，哪些只允许桌面人工发布。
- 不改变节点功能，不接入 MCP。

验收：能力矩阵覆盖所有 Active 节点；没有裸 `json`、未声明端口或无法解释的输出。

### AG-1：共享能力注册表（2～3 人日）

- 新建 `src/shared/capabilities/`。
- 将无 UI 的端口、描述、Schema 和执行模式从 renderer 注册表拆出。
- renderer 的 `NodeTypeSpec` 组合共享能力与 React UI，不重复声明契约。
- 增加能力快照、生成器和防漂移测试。

验收：桌面行为不变；节点契约测试全部通过；生成能力目录覆盖全部 Active 节点。

### AG-2：无界面 Application Service（3～5 人日）

- 建立项目、节点、连线、校验、执行、运行、资产命令。
- 把 renderer 中的编排逻辑逐步移到无 React 依赖的服务层。
- 加入项目 revision、事务、幂等键和统一错误码。
- 桌面端改为调用同一服务，但不改变 UI。

验收：测试中不创建 React 页面即可完成“打开项目→创建节点→连接→校验→运行→读取产物”。

### AG-3：CLI 垂直切片（2～3 人日）

- 实现能力查询、项目查询、工作流校验、工作流 dry-run、运行和产物查询。
- 支持人类输出与 `--json`。
- 用 CLI 建立第一条端到端链路：文本→生图→读取图片产物。

验收：桌面应用不打开时也能运行测试项目；CLI 和 Application 返回结构一致。

### AG-4：MCP 只读与能力发现（2 人日）

- 提供 stdio MCP Server。
- 实现能力、项目、工作流、运行和资产 Resources。
- 实现只读查询 Tools。
- 验证 Agent 能回答“有哪些图片处理能力”“图片裁剪输入输出是什么”。

验收：Agent 不需要预置节点知识即可读取并准确解释能力。

### AG-5：MCP 编排与执行（3～5 人日）

- 实现节点、连线、事务工作流、校验和运行工具。
- 实现 dry-run、费用预估、取消、重试和危险动作确认。
- 返回图片、视频、音频 Resource 与缩略图。

验收：在 Agent 对话中完成“创建流程→运行→查看图片→修改参数→局部重试”，不操作桌面页面。

### AG-6：双向同步和发布门禁（2～3 人日）

- Agent 修改后桌面端实时刷新；桌面修改后 revision 更新。
- 增加单写者锁或本地守护进程，防止 Electron、CLI、MCP 同时写项目。
- 完成 Application/CLI/MCP 一致性测试、安全测试、恢复测试和文档生成。

验收：并发修改有明确冲突而不是静默覆盖；故障重启后项目和运行记录一致。

## 12. 推荐目录结构

```text
src/
├── shared/
│   ├── capabilities/          # 无 UI 能力契约与 Schema
│   └── agent-protocol/        # 值类型、错误码、命令和结果 Envelope
├── application/
│   ├── commands/              # 创建、连接、校验、运行、资产命令
│   ├── services/              # Workflow/Execution/Artifact 服务
│   └── command-bus.ts
├── main/
│   └── adapters/desktop/      # Electron IPC 适配
├── cli/                       # CLI 适配
├── mcp/                       # stdio MCP 适配，不包含业务规则
└── renderer/                  # 画布和可视化 UI
```

## 13. 首个验收场景

第一条实现链路固定为“文本→生图”，因为它同时覆盖能力发现、文本输入、真实连线、供应商前置校验、异步运行、费用提示、图片资产和 Agent 预览：

1. Agent 调用 `canvas_list_capabilities`，发现文本与生图能力。
2. Agent 调用 `canvas_get_capability`，读取双方端口和生图设置 Schema。
3. Agent dry-run 创建两个节点并建立 `out-text → in-prompt` 真实连线。
4. 系统返回缺失供应商或预计调用信息，用户确认后 apply。
5. Agent 调用 `canvas_run_workflow`，获得 `runId`。
6. 运行完成后返回图片 Artifact Resource，并在对话中展示。
7. 用户要求修改时，Agent只更新生图配置并重跑受影响子图。
8. 打开桌面端后可以看到同一项目、同一节点、同一连线和同一运行记录。

完成该垂直切片后，再扩展图片裁剪、图片修改、视频、音频和结构化数据；不能一开始同时适配全部执行能力。

## 14. 完成定义

Agent 对接达到可发布状态必须同时满足：

- Agent 可以动态发现全部允许暴露的节点能力。
- 每项能力都有机器可读的输入、输出、设置 Schema 和示例。
- Agent 不依赖页面、坐标或节点标题推测数据关系。
- CLI、MCP 和桌面端使用同一应用服务与默认值。
- 工作流修改具备事务、revision、幂等和审计记录。
- 媒体结果可在 Agent 页面读取或预览，并可追溯到节点和运行。
- API Key 不离开可信主进程/核心服务。
- 契约变化会由 CI 自动检测，不可能静默遗漏 MCP。
- 无界面端到端、桌面回归、并发冲突和故障恢复测试全部通过。

