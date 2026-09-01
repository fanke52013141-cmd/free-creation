# P3「真实执行和产物」交接文档

> 交付日期：2026-09-01
>
> 对应规划：[docs/HANDOFF_2026_09_01_AGENT_SAFETY_BASELINE.md](./HANDOFF_2026_09_01_AGENT_SAFETY_BASELINE.md) §P3
>
> 交付范围：P3.1 执行器共享层 → P3.2 Run/Artifact 持久化 → P3.3 `manual-publish` 标记 `agentRunnable: false` → rendererGateway 包装雏形
>
> 验证基线：`npm run typecheck` 双端零错误；`npm test` 61 个测试文件、800 项用例全部通过。

---

## 1. 本轮交付内容总览

本轮把「只能由桌面页面运行执行器」升级为「执行器可作为服务运行、Run/Artifact 可持久化」的基础。对应安全基线 P3 的三条要求，拆成四块交付：

| 模块 | 目录 | 职责 | 状态 |
| --- | --- | --- | --- |
| 执行器共享层 | `src/shared/engine/` | 不依赖 React/tldraw/window.api 的纯函数、类型、执行器与 EXECUTOR_REGISTRY | 已完成（renderer 仍用旧执行器，shim 转换待续） |
| Run/Artifact 持久化 | `src/application/services/run-service.ts` + `src/main/store/runs.repo.ts` | 持久化 Run/Artifact 记录，覆盖 `queued/running/succeeded/failed/cancelled` | 已完成（表结构 + CRUD + 服务层） |
| DB 迁移 | `src/main/store/db-migrations.ts` | `user_version` 升到 3，新增 `runs` 与 `run_artifacts` 表 | 已完成 |
| rendererGateway | `src/renderer/src/engine/rendererGateway.ts` | 渲染进程 `GatewayClient` 实现，包装 `window.api.gateway.*` 与 `window.api.*` 的 17 个方法 | 已完成（执行器 shim 接入待续） |
| 数据迁移到共享层 | `src/shared/structured-data.ts`、`src/shared/director-data.ts`、`src/shared/graph-snapshot-sync.ts` | 把 structured/director/graph 快照同步抽到共享层，renderer 保留 re-export shim | 已完成 |
| `manual-publish` 标记 | `src/capabilities/*` | director 标记 `agentRunnable: false` | 已完成 |

---

## 2. 共享执行引擎（`src/shared/engine/`）

依赖方向为单向 DAG，无 React / tldraw / window.api 依赖：

```text
executors ← executor-types ← gateway-client ← shared/types
```

核心文件：

| 文件 | 职责 |
| --- | --- |
| `index.ts` | 共享层入口，集中 re-export 类型与执行器，导出 `EXECUTOR_REGISTRY`、`getExecutor` |
| `executor-types.ts` | `NodeExecutionContext`（P3 新增必填 `gateway`、可选 `runCode`）、`NodeExecutor`、`CancelSignal` 等共享类型 |
| `gateway-client.ts` | `GatewayClient` 接口：17 个模型网关 + 本地媒体处理方法的统一抽象 |
| `executors/` | 22 个文件 + `index.ts`，映射 24 种节点类型（含 `speech` 别名复用 `audioExecutor`、退役 `script` 保留兼容） |
| `helpers.ts` | 由 renderer 抽出的纯函数（`waitForChat` 等），`waitForChat/waitForVideo` 增加 `gateway` 入参 |
| `inputs.ts` | 输入端口数据包与提取函数（`buildOutputPackets` / `collectContractInputs` 仍留在 renderer，依赖注册表） |
| `values.ts` / `models.ts` / `node-config.ts` / `chat-data.ts` | 媒体结果、模型查询、节点配置、聊天解析的共享实现 |

---

## 3. Run/Artifact 持久化

### 3.1 DB 迁移（`user_version` 2 → 3）

新增表：
- `runs`：`id / project_id / scope_type / scope_node_ids / status / actor / started_at / finished_at / duration_ms / error_code / error_message / created_at`，带 `(project_id, status)` 与 `(status)` 索引。
- `run_artifacts`：`id / run_id / project_id / node_id / port_id / media_id / artifact_type / mime_type / label / input_summary / model_key / created_at`，带 `(run_id)` 与 `(project_id)` 索引。

### 3.2 服务层

- `src/application/types.ts`：新增 `RunStatus`、`RunScopeType`、`RunRecord`、`RunUpdatePatch`、`RunArtifactRecord`；`ProjectStore` 接口新增 `createRun/updateRun/getRun/listRuns/createRunArtifact/listRunArtifacts`。
- `src/application/services/run-service.ts`：运行与产物查询服务。
- `src/application/services/workflow-service.ts`：`runNode` / `runWorkflow` 不再返回假 `queued`，而是创建持久化 Run 记录（dry-run 仍返回 `runId: 'dry-run'`、`status: 'succeeded'`）；新增 `manual-publish`（`AGENT_NOT_RUNNABLE`）阻断、`estimateRun` 等。
- `src/main/store/runs.repo.ts`：SQLite CRUD，经 `DesktopProjectStore` 异步方法间接访问。

---

## 4. `manual-publish` 标记

- `src/capabilities/`：导演台（`director`）能力标记为 `agentRunnable: false`（manual-publish）。
- `WorkflowService.runNode/runWorkflow`：校验范围内任一 `manual-publish` 节点，Agent 自动执行返回 `AGENT_NOT_RUNNABLE`，需桌面端手动操作。

---

## 5. 验证

```bash
npm run typecheck   # node + web 双端零错误
npm test            # 61 files / 800 tests 全部通过
git diff --check    # 无空白错误
```

测试相关更新：
- `test/db-migrations.test.ts`：迁移断言更新到 `user_version 3`，并校验 `runs`/`run_artifacts` 表创建。
- `test/agent/application-services.test.ts`：`MockStore` 补齐 Run/Artifact 方法；`runNode/runWorkflow` dry-run 断言改为 `succeeded`；正常模式断言持久化 Run 记录返回 `queued`。
- 新增 `test/agent/graph-write-transaction.test.ts`：图写入事务安全性回归。

---

## 六、已知边界与下一步（唯一推荐项）

> 关键：renderer 执行器尚未切换为 shared 层 re-export shim，`executor.ts` 尚未注入 `gateway` / `runCode`。当前 renderer 仍走旧执行器，构建与测试均为绿。

下一步（按序）：
1. **p3-renderer-adapter**：把 `src/renderer/src/engine/executors/*.ts`（21 个）转为 `export * from '@shared/engine/executors/<name>'` 的 re-export shim；同步转换 `executors/shared.ts → @shared/engine/helpers`；更新 `executor.ts` 的 `invokeExecutor` / `runNodeTest` 注入 `gateway: rendererGateway` 与 `runCode`。注意 `contracts.ts`（`buildOutputPackets`/`collectContractInputs`）与 `executor-types.ts`（`NodeCardShape`）不可整体 shim，需保留 renderer 版本或做类型兼容。
2. **p3-headless-wire**：创建 main 进程 `GatewayClient` 实现 + 把 `WorkflowService` 接入 headless 真实执行。
3. **p3-verify**：`npm run verify` 全量门禁。

### 已知边界

- `buildOutputPackets` / `collectContractInputs` 依赖 renderer 注册表（`getNodeType`），**故意留在 renderer 层**，未接入共享 `inputs.ts`；headless 执行路径需要等效的端口解析。
- `src/capabilities/definitions.ts` 仍是临时能力表，尚未取代 `specs/index.tsx` 的真实 `NodeTypeSpec`（见安全基线 P1）。

---

## 不可提交内容

- API Key、Authorization header、真实供应商 Base URL/配置。
- `.pnpm-store/`（已加入 `.gitignore`）、`node_modules/`、`out/`、`dist/`、日志与截图。
- 本地 SQLite 项目目录与生成媒体。