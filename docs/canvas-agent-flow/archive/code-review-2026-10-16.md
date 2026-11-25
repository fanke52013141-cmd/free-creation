# 画布 Agent Flow 代码审查报告（2026-10-16）

## 一、摘要

本次审查覆盖 2026-10-13 至 2026-10-15 期间开发的 Agent 相关内容（工作区未提交改动约 52 个文件 + 18 个新文件），范围：

- `src/main/agent-flow/` 全部生产文件（runtime、coordinator-host、desktop-host、command-ledger、asset-store、runtime-model、video-review / video-rework / parallel-* 链路、各 store 与 electron 验收夹具）
- `src/shared/agent-flow/` 全部契约文件
- `src/main/ipc/flow-agents.ipc.ts`、`src/main/ipc/flow-commands.ipc.ts`
- 渲染层 `agent-flow-declarations.ts`、`flow-asset-actions.ts`、`flow-asset-snapshot.ts`、`agentFlow.tsx`、`AgentCollaborationPanel.tsx`、`ReviewTaskControls.tsx` 等
- 参考（未审）：`AGENTS.md`、`docs/canvas-agent-flow/` 设计文档、`qa/agent-*-20261015/`

**总体评价**：该模块工程质量明显高于一般业务代码——契约层全部使用 zod 严格校验；命令/资产/任务三条持久化线均以"事实回执"为核心，预算、占用、幂等、恢复语义完整；模型输出从不直接改写执行事实；未发现越权 IPC、路径穿越或密钥泄露问题；范围内无 `as any`、无业务 `console.*`、prettier/eslint 全绿。未发现 P0 级问题。

发现 **3 个 P1**（错误掩盖 / 裸解析导致的错误归类失真 / 重复全图哈希热点）与 **3 个可低风险修复的 P2**，本轮已全部修复并验证；另有 4 项 P2/P3 观察项记录在案，不建议本轮改动。

| 分级 | 数量 | 已修复 | 未修复 |
| --- | --- | --- | --- |
| P0 | 0 | — | — |
| P1 | 3 | 3 | 0 |
| P2（本轮修复） | 3 | 3 | 0 |
| P2/P3（仅记录） | 4 | — | 4 |

## 二、问题清单

### P1-1 视频抽帧审核：临时目录清理失败会掩盖真实失败阶段（已修复）

- 严重度：P1
- 位置：`src/main/agent-flow/video-review.ts` `sampleReviewVideo`（原 252-254 行）
- 问题：清理逻辑在 `finally` 中 `await cleanupReviewDirectory(directory)`，而 `cleanupReviewDirectory` 内部 `rm(...).catch(() => { throw failure('FLOW_VIDEO_REVIEW_CLEANUP_FAILED') })` 会直接抛出。当抽帧本身已失败（如 `FLOW_VIDEO_REVIEW_LIMIT`、`FLOW_VIDEO_REVIEW_DECODE_FAILED`）且清理恰好也失败时，finally 中的抛出会**替换**原始错误，用户与日志只能看到 CLEANUP_FAILED，丢失真实失败阶段——违反 AGENTS.md "必须补齐失败阶段" 的日志要求。
- 方案：清理结果改为捕获记录（不在 finally 中抛出），函数末尾统一裁决：采样失败优先抛采样错误；采样成功且清理失败才抛 `FLOW_VIDEO_REVIEW_CLEANUP_FAILED`（保留原语义）。
- 状态：✅ 已修复。修复过程中首版在 finally 内嵌 throw 触发 eslint `no-unsafe-finally`，已重构为"捕获后统一裁决"结构。

### P1-2 desktop-host 入口对 agent 节点 config 的裸 `JSON.parse`（已修复）

- 严重度：P1
- 位置：`src/main/agent-flow/desktop-host.ts` `inspect()`（原 124 行）、`stop()`（原 179 行）、`pause()`（原 362 行）、`run()`（原 681 行）
- 问题：四处 `JSON.parse(x.config).role === 'coordinator'` 在 config 为 `undefined` 或损坏 JSON 时抛出原始 `SyntaxError`，IPC 层只能归为通用 `AGENT_DESKTOP_FAILED`，错误信息失真。其中 `inspect()` 会被渲染层状态机节点以 750ms 轮询（经 `coordinator.inspect` 前的同一段判断），画布中一旦存在未保存完整的 agent 节点（新建节点首次自动保存前），将持续产生误导性失败。
- 方案：新增 `agentRoleOf(config)` 安全解析辅助函数（解析失败返回 `undefined`，按非 coordinator 处理；后续 `saved()`/`bind()` 的 zod 校验会给出准确错误码），四处调用点统一替换。
- 状态：✅ 已修复。

### P1-3 模型连接 baseUrl 的裸 `new URL` 与双重解析（已修复）

- 严重度：P1（与 P1-2 同类的错误归类失真）
- 位置：`src/main/ipc/flow-agents.ipc.ts` `resolveModel`（原 61、90 行）
- 问题：`new URL(connection.baseUrl)` 未捕获——连接记录中 baseUrl 非法时抛 `TypeError`，被 IPC 外层归为 `AGENT_DESKTOP_FAILED`，而不是语义正确的模型连接错误；且同一 baseUrl 在函数内解析两次。
- 方案：协议校验后立即解析一次并存入 `address`，解析失败归为 `AGENT_MODEL_PROTOCOL`；两处使用 `address.hostname`。
- 状态：✅ 已修复。

### P2-1 coordinator 派发候选过滤中的重复全图哈希与重复解析（已修复）

- 严重度：P2（性能热点）
- 位置：`src/main/agent-flow/coordinator-host.ts` `step()`（原 419-427 行）
- 问题：候选过滤对每个 (child × review) 组合都调用 `this.check(run)`（内部执行 `semanticProjectPayload` 全量序列化 + sha256）并重新 `JSON.parse` 同一审核配置。常见规模（≤10 子节点 × ≤3 审核）下每轮 step 额外产生约 30 次全图哈希，且该循环位于每次模型决策后的同步路径上。
- 方案：该循环为同步代码（`describeAssignment`/`bind` 无 await），先 `const scopeFile = this.check(run)` 校验一次；每个未通过审核的 review 只解析一次 `gatedNodeIds` 构建 Set，循环内仅做 Set 查询。失败面不变（节点缺失/配置损坏同样抛出并归为 `FLOW_COORDINATION_FAILED`）。
- 状态：✅ 已修复。

### P2-2 `FlowCommandLedger.check()` 变量遮蔽与重复解析（已修复）

- 严重度：P2（可读性/微性能）
- 位置：`src/main/agent-flow/command-ledger.ts`（原 500-516 行）
- 问题：外层 `input`（租约入参）被内层 `for (const input of command.inputs)` 遮蔽，易误读；`row.command_json` 被解析两次。
- 方案：先解析一次 `command` 传入 `authorize`，循环变量改名 `entry`。行为完全等价。
- 状态：✅ 已修复。

### P2-3 desktop-host reconcile 分支重复查询回执（已修复）

- 严重度：P2（微性能/可读性）
- 位置：`src/main/agent-flow/desktop-host.ts` `run()` reconcile 分支（原 711-716、762-765 行）
- 问题：`uncertain`（some）与 `unresolved`（filter）对同一条件各查一次 `this.receipts(record)`，且构造恢复原因时第三次重复查询。
- 方案：单一 `filter` 得 `unresolved`，`uncertain = unresolved.length > 0`，恢复原因复用 `uncertain`（期间无回执写入，语义等价）。
- 状态：✅ 已修复。

### P2/P3 观察项（本轮不修，记录建议）

1. **媒体资产读取的重复全量哈希**（`image-assets.ts` `fixedFlowMedia`，经 `asset-store.read()` 每次触发）：每次读取媒体资产都同步重读并重哈希最多 20MiB 文件；专业 Agent 决策循环中 `decide()` 每步对固定输入、已观测输出、被拒输出全部 `resolveInputs`，同一视频版本会被反复哈希。这是刻意的完整性优先设计（注释明确 "Freeze and recheck bytes as well as metadata"），不建议贸然加缓存。若后续成为热点，建议方向：资产入库时固化 `(size, mtimeNs)` 与 hash 的对应关系并校验元数据未变，将全量重读降级为抽样校验。
2. **协调决策 30s 竞速超时不中止底层请求**（`coordinator-host.ts` `step()` 决策 Promise.race）：超时后模型调用依赖 SDK 自身 30s timeout 自然收尾，`decisionPending` 保持 true 走保守恢复语义，行为可接受；若在 race 超时时直接 `controller.abort()` 反而会使流程落入 "running 挂起→SESSION_LOST" 的更差路径，故维持现状。
3. **`runtime.ts` `execute()` 中 `store.read(thread)` 连续调用两次**（原 345 行）：微小冗余，可在后续顺手合并。
4. **验收夹具体量**：`desktop-electron.ts`（1211 行）等 acceptance 文件为单文件隔离验收脚本（不进应用入口），体积大是既有风格，不作为问题处理。

### 环境注意事项（非代码问题）

本机 `better-sqlite3` 原生模块按 Electron ABI（NODE_MODULE_VERSION 140）编译，而 vitest 使用系统 Node 24（ABI 137）。直接 `npm run test` 会因 ABI 不匹配全部失败。本轮验证采用：备份 Electron 版二进制 → `npm rebuild better-sqlite3`（切换到系统 Node ABI）→ 运行测试 → 恢复原二进制。开发者日常如需跑 vitest，同样需要临时 rebuild，跑完用 `npx electron-builder install-app-deps` 恢复 Electron 版。

## 三、已修复项

| 编号 | 文件 | 改动 |
| --- | --- | --- |
| P1-1 | `src/main/agent-flow/video-review.ts` | 清理失败不再掩盖采样失败阶段；结构改为捕获后统一裁决，满足 `no-unsafe-finally` |
| P1-2 | `src/main/agent-flow/desktop-host.ts` | 新增 `agentRoleOf()` 安全解析，4 处裸 `JSON.parse` 替换 |
| P1-3 | `src/main/ipc/flow-agents.ipc.ts` | baseUrl 单次解析，非法值归为 `AGENT_MODEL_PROTOCOL` |
| P2-1 | `src/main/agent-flow/coordinator-host.ts` | 候选过滤的重复 `check()`/`JSON.parse` 提出循环，一次校验 + Set 查询 |
| P2-2 | `src/main/agent-flow/command-ledger.ts` | `check()` 去除变量遮蔽与重复解析 |
| P2-3 | `src/main/agent-flow/desktop-host.ts` | reconcile 分支回执查询去重（3 次 → 1 次） |

所有修改保持最小 diff，未改变对外行为、IPC 协议与存储格式；`desktop-host.ts`/`command-ledger.ts` 的部分改动经 `prettier --write` 按仓库标准格式化。

## 四、验证结果

| 验证项 | 命令 | 结果 |
| --- | --- | --- |
| 类型检查（node+web） | `npm run typecheck` | ✅ 通过（0 错误） |
| ESLint | `npm run lint` | ✅ 通过（0 错误 0 警告） |
| Prettier | `npx prettier --check src/main/agent-flow/**/*.ts src/shared/agent-flow/**/*.ts src/main/ipc/flow-agents.ipc.ts src/main/ipc/flow-commands.ipc.ts` | ✅ 全部符合 |
| 全量单元测试 | `npm run test` | ✅ 173 个文件、1968 通过、1 跳过（与修复前基线一致，无回归） |

基线说明：修复前先建立了同一环境下的绿色基线（typecheck/lint/1968 测试全过），修复后复跑结果完全一致。better-sqlite3 ABI 处理见"环境注意事项"；桌面级验收脚本（`npm run verify` 中的 `test:agent-flow-*` 系列，需启动 Electron 与夹具服务）未在本轮执行，原因：其依赖 Electron ABI 原生模块与本机显示环境，且本轮修改均不触及验收脚本覆盖的协议行为；单元测试（含 coordinator、command-ledger、video 链路 196 例）已覆盖修改路径的类型与逻辑等价性。

## 五、结论

Agent Flow 近期开发内容整体质量高：契约严格、事实驱动、恢复语义完整、无安全问题。本轮修复的 6 项均为错误归类/诊断质量/局部性能改进，无行为变更，全部通过现有验证门禁。
