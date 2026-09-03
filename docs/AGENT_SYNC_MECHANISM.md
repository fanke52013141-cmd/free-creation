# Agent 契约同步机制

> 版本：1.0（2026-09-03）
> 状态：已落地——门禁测试与 CI 步骤均在 `main` 生效。
> 目的：**任何改动节点能力/端口/Schema/MCP 工具的提交，要么自动把 Agent 契约同步到一致状态，要么被门禁拦截。** 不依赖开发者记忆和纪律。

## 1. 一图看懂

```
开发者改动 src/capabilities/definitions.ts / renderer specs / MCP 工具定义
                    │
                    ▼
        本地 npm run test（新增 2 个门禁测试文件）
                    │
        ┌───────────┴────────────────────┐
        ▼ 契约漂移                    ▼ 破坏性变更未 bump 版本
 [contract-snapshot-fresh]      [contract-version-bump]
        │                              │
        ▼                              ▼
 npm run agent:generate         bump contractVersion
 重新生成 + 同一提交提交   （definitions.ts + renderer spec 两侧同步）
        │                              │
        └──────────────┬───────────────┘
                       ▼
        CI 双保险：pnpm agent:check-contracts（PR 独立红色标记）
                       ▼
        merge → Agent 三入口（Application / CLI / MCP）契约始终新鲜
```

## 2. 核心事实：契约的唯一来源

P3 之后，`src/capabilities/definitions.ts` 是全部 23 个节点能力的**唯一运行时事实来源**（端口、JSON Schema、configSchema、contractVersion、执行语义）。renderer spec 只能投影，不能自带另一份可生效的端口表（`test/agent/node-contract-source.test.ts` 强制）。

`generated/agent-contracts.json` 是从这份定义**确定性生成**的消费侧契约快照（22 个 MCP 工具、5 个 CLI 命令、23 个节点配置 Schema、能力矩阵、契约快照），由 `npm run agent:generate` 产出，**禁止手工编辑**。

因此契约同步只有一个动作：**改定义 → 重新生成 → 同一提交带上产物**。

## 3. 触发矩阵（改了什么 → 必须做什么）

| 你改了什么 | 必须做什么 | 谁来强制 |
|---|---|---|
| 能力定义的端口 / Schema / configSchema（`definitions.ts`） | `npm run agent:generate` 重新生成，`generated/agent-contracts.json` 与代码改动放**同一提交** | `contract-snapshot-fresh.test` + CI |
| 删除端口 / 修改端口类型 / required 从可选收紧为必填 | 上面全部，**另须 bump `contractVersion`**：`definitions.ts` 与 renderer spec 两侧同步提升 | `contract-version-bump.test` + `node-contract-source.test` |
| 新增节点类型 | `NODE_CONTRACT_SPEC.md` 全流程（能力注册 + renderer spec + executor + 测试），再 `npm run agent:generate` | `node-compliance.test` + `node-contract-source.test` |
| MCP 工具定义（`src/mcp/server.ts` 的 `defineTools()`） | 契约重新生成 + 更新 `test/agent/mcp-server.test.ts` | `contract-snapshot-fresh.test` + 一致性测试 |
| 错误码 / 运行状态 / 媒体引用词汇 | 三入口（Application / CLI / MCP）同步实现，更新 `test/agent/contract-consistency.test.ts` 相关断言 | 一致性测试 |
| 仅 UI / 样式 / 执行器内部实现（不触及契约面） | 无需任何 Agent 侧动作 | — |

**判定破坏性变更的规则**（与 `isBreakingChange()` 一致）：

- 端口被删除 → 破坏性
- 端口 `type` 变更 → 破坏性
- 端口 `required` 从 `false` 收紧为 `true` → 破坏性
- 纯新增端口 / 新增可选配置 → 向后兼容，允许版本号不变

## 4. 门禁对照表

| 漂移类型 | 拦截点 | 失败提示 |
|---|---|---|
| 改了定义但没重新生成快照 | `test/agent/contract-snapshot-fresh.test.ts`（3 用例） | 首个差异行号 + `npm run agent:generate` 修复指令 |
| 破坏性变更没 bump 版本 | `test/agent/contract-version-bump.test.ts`（2 用例） | 能力 ID + 具体 diff 路径（如 `outputs.x.required: false → true`）+ bump 指令 |
| renderer spec 与 Capability 定义不一致 | `test/agent/node-contract-source.test.ts` | 版本/标签/端口投影不等断言 |
| 三入口描述互相矛盾 | `test/agent/contract-consistency.test.ts` | 一致性断言 |
| 快照被手工编辑或含时间戳 | `contract-snapshot-fresh.test.ts` 第 3 用例 | 时间戳残留断言 |
| CI 层面统一复核 | `.github/workflows/ci.yml` 的 `Agent 契约快照一致性` 步骤 | PR 页面独立红色标记 |

注意：快照新鲜度门禁**在 `npm run test` / `npm run verify` / CI 的 `pnpm test` 中天然生效**，开发者不需要记得任何额外命令就能发现漂移；`agent:check-contracts` 只是 CI 的显式双保险。

## 5. 开发者工作流

日常功能迭代触及节点能力时：

1. 改动 `definitions.ts`（必要时同步 renderer spec、executor、`NODE_CONTRACT_SPEC.md`）。
2. 若属破坏性变更（见第 3 节规则），bump `contractVersion` 并同步 renderer spec 同字段。
3. `npm run agent:generate` 重新生成契约快照。
4. `npm run test`——快照新鲜度与版本 bump 门禁通过即证明契约已同步。
5. 把 `generated/agent-contracts.json` 与代码改动放进**同一提交**，写明契约变更内容。
6. 全量门禁 `npm run verify`（提交前或 CI 中）保持绿色。

提交自查一句话：**改了定义，就要看到 `generated/agent-contracts.json` 出现在同一次提交里。**

## 6. 交接文档要求（Agent 影响评估）

从本机制落地起，凡触及节点能力面的交接文档（`docs/HANDOFF_*.md`）须包含以下小节：

```markdown
## Agent 影响评估

- 触及能力定义 / 端口 / Schema / MCP 工具：是 / 否
- 若是：已重新生成并提交 generated/agent-contracts.json：是 / 否
- 破坏性变更（删端口 / 改类型 / 收紧必填）：无 / 有（列出，并附 contractVersion 提升前后值）
- 三入口一致性测试结果：npm run test 全绿
```

## 7. 实现索引

| 组件 | 位置 |
|---|---|
| 归一化（「契约的契约」，写盘与测试共用） | `src/capabilities/generate.ts` 的 `normalizeArtifacts()` |
| 写盘入口 | `src/capabilities/generate-entry.ts` → `scripts/generate-agent-contracts.mjs` |
| 快照新鲜度门禁 | `test/agent/contract-snapshot-fresh.test.ts` |
| 破坏性变更版本门禁 | `test/agent/contract-version-bump.test.ts` |
| 差异检测 / 破坏性判定 | `src/capabilities/generate.ts` 的 `diffSnapshots()` / `isBreakingChange()` |
| CI 双保险 | `.github/workflows/ci.yml` 的 `Agent 契约快照一致性` 步骤 |
| 工程约束 | 根目录 `AGENTS.md` 的「Agent 契约同步」节 |

## 8. 风险与取舍说明

- **门禁只拦不改**：`contractVersion` 的提升不自动化——版本变更需要人工确认三入口语义是否都要跟进，自动 bump 反而掩盖破坏面。
- **快照格式演进**：若 `GeneratedArtifacts` 未来增加非确定性字段，快照新鲜度门禁会变红——这是预期行为，提醒更新 `normalizeArtifacts()`，两处消费方（写盘 + 测试）因共用实现而自动保持一致。
- **新增能力的豁免边界**：首次注册的 capability 无旧快照可对比，属正常豁免；若注册后立刻删除端口，下一轮提交的快照对比即可捕获。
- **configSchema 字段内部变更**：`diffConfigSchema` 只比较键的增删（新增/删除字段计入破坏性判定），字段内部 `required`/`type` 的收紧不进入版本 bump 对比——但快照新鲜度门禁的字符串级全等仍会拦截漂移本身；此类收紧是否 bump 由人工判断（建议按破坏性处理）。
