# 仓库清理盘点：C0 与一次性脚本（2026-11-26）

> 范围：C0 测试运行时，以及 `scripts/*temp*.cjs`、`scripts/qa-current-audit-*.cjs`、`scripts/probe-version-mutation.cjs`。用户最初提到的 37 个 `audit-*-temp.cjs` 之外，另发现 4 个同类临时/一次性脚本和 1 个无入口版本探针，共 42 个。

## 1. 盘点方法

- 文件清单：`git ls-files`。
- 最后变格时间：`git log -1 --format=%cI|%h|%s -- <file>`；仓库没有脚本运行遥测，因此“最后实际运行时间”无法可靠还原，只能记录最后变格与引用证据。
- 引用：在全部受版本控制文件中按 basename 搜索，排除文件自身。
- 证据价值：结合引用、内容特征、正式验收入口和历史证据判断。

## 2. C0：保留，但明确为测试专用

| 文件 | 最后变格 | 引用/入口 | 证据价值 | 决策 |
| --- | --- | --- | --- | --- |
| `scripts/test-agent-flow-c0-unit.cjs` | 2026-10-12 08be32a2 | package.json: test:agent-flow-c0-unit | 高：16 项单测 + 2026-10-17 双进程恢复证据 | 保留 |
| `scripts/test-agent-flow-c0.cjs` | 2026-10-12 08be32a2 | package.json: test:agent-flow-c0 | 高：16 项单测 + 2026-10-17 双进程恢复证据 | 保留 |
| `src/main/agent-flow/c0-electron.ts` | 2026-10-12 08be32a2 | C0 运行时/契约内部引用 | 高：16 项单测 + 2026-10-17 双进程恢复证据 | 保留 |
| `src/main/agent-flow/c0/checkpoint.ts` | 2026-10-12 08be32a2 | C0 运行时/契约内部引用 | 高：16 项单测 + 2026-10-17 双进程恢复证据 | 保留 |
| `src/main/agent-flow/c0/command-ledger.ts` | 2026-10-12 08be32a2 | C0 运行时/契约内部引用 | 高：16 项单测 + 2026-10-17 双进程恢复证据 | 保留 |
| `src/main/agent-flow/c0/diagnostics.ts` | 2026-10-12 08be32a2 | C0 运行时/契约内部引用 | 高：16 项单测 + 2026-10-17 双进程恢复证据 | 保留 |
| `src/main/agent-flow/c0/model.ts` | 2026-10-12 08be32a2 | C0 运行时/契约内部引用 | 高：16 项单测 + 2026-10-17 双进程恢复证据 | 保留 |
| `src/main/agent-flow/c0/runtime.ts` | 2026-10-12 08be32a2 | C0 运行时/契约内部引用 | 高：16 项单测 + 2026-10-17 双进程恢复证据 | 保留 |
| `src/shared/agent-flow/c0-contracts.ts` | 2026-10-12 08be32a2 | C0 运行时/契约内部引用 | 高：16 项单测 + 2026-10-17 双进程恢复证据 | 保留 |
| `test/agent-flow-c0.test.ts` | 2026-10-12 08be32a2 | npm test 活跃用例 | 高：16 项单测 + 2026-10-17 双进程恢复证据 | 保留 |

C0 不是产品入口：`c0-electron.ts` 明确只启动隔离测试数据库，不注册生产节点。它仍有活跃单测和历史恢复证据，直接删除会丢失 checkpoint/命令回执/人工等待回归。决策：**保留代码，补充测试专用说明，禁止作为新功能入口**。

## 3. 一次性脚本：删除

| 文件 | 最后变格 | 引用数 | 证据价值 | 决策 |
| --- | --- | ---: | --- | --- |
| `scripts/audit-agent-continue-temp.cjs` | 2026-11-01 85556956 | 0 | 低：历史节点矩阵副本；正式 test-node-combos / audit-node-operation-matrix 已替代 | 删除 |
| `scripts/audit-agent-real-app-temp.cjs` | 2026-11-01 85556956 | 0 | 低：一次性探针，含本机密钥读取/硬编码路径风险 | 删除 |
| `scripts/audit-agent-real-launch-temp.cjs` | 2026-11-01 85556956 | 0 | 低：一次性探针，含本机密钥读取/硬编码路径风险 | 删除 |
| `scripts/audit-agent-validation-after-fix-temp.cjs` | 2026-11-01 85556956 | 0 | 低：一次性 UI/版本/浏览器探针，无引用 | 删除 |
| `scripts/audit-agent-validation-restart-temp.cjs` | 2026-11-01 85556956 | 0 | 低：一次性 UI/版本/浏览器探针，无引用 | 删除 |
| `scripts/audit-agent-validation-temp.cjs` | 2026-11-01 85556956 | 0 | 低：一次性 UI/版本/浏览器探针，无引用 | 删除 |
| `scripts/audit-agent-verified-temp.cjs` | 2026-11-01 85556956 | 0 | 低：历史节点矩阵副本；正式 test-node-combos / audit-node-operation-matrix 已替代 | 删除 |
| `scripts/audit-ai-json-chain-temp.cjs` | 2026-11-01 85556956 | 0 | 低：历史节点矩阵副本；正式 test-node-combos / audit-node-operation-matrix 已替代 | 删除 |
| `scripts/audit-ai-json-real-temp.cjs` | 2026-11-01 85556956 | 0 | 低：历史节点矩阵副本；正式 test-node-combos / audit-node-operation-matrix 已替代 | 删除 |
| `scripts/audit-ai-live-temp.cjs` | 2026-11-01 85556956 | 0 | 低：历史节点矩阵副本；正式 test-node-combos / audit-node-operation-matrix 已替代 | 删除 |
| `scripts/audit-ai-markdown-real-temp.cjs` | 2026-11-01 85556956 | 0 | 低：历史节点矩阵副本；正式 test-node-combos / audit-node-operation-matrix 已替代 | 删除 |
| `scripts/audit-chat-dialog-real-image-temp.cjs` | 2026-11-01 85556956 | 0 | 中：真实/付费路径探针；无入口，已被正式验收入口替代 | 删除 |
| `scripts/audit-chat-dreamina-after-fix-temp.cjs` | 2026-11-01 85556956 | 0 | 中：真实/付费路径探针；无入口，已被正式验收入口替代 | 删除 |
| `scripts/audit-chat-dreamina-temp.cjs` | 2026-11-01 85556956 | 0 | 中：真实/付费路径探针；无入口，已被正式验收入口替代 | 删除 |
| `scripts/audit-chat-real-context-retry-temp.cjs` | 2026-11-01 85556956 | 0 | 中：真实/付费路径探针；无入口，已被正式验收入口替代 | 删除 |
| `scripts/audit-chat-real-context-temp.cjs` | 2026-11-01 85556956 | 0 | 中：真实/付费路径探针；无入口，已被正式验收入口替代 | 删除 |
| `scripts/audit-chat-switch-temp.cjs` | 2026-11-01 85556956 | 0 | 低：一次性 UI/版本/浏览器探针，无引用 | 删除 |
| `scripts/audit-design-resume-temp.cjs` | 2026-11-01 85556956 | 0 | 低：历史节点矩阵副本；正式 test-node-combos / audit-node-operation-matrix 已替代 | 删除 |
| `scripts/audit-director-current-temp.cjs` | 2026-11-01 85556956 | 0 | 低：一次性 UI/版本/浏览器探针，无引用 | 删除 |
| `scripts/audit-dreamina-live-temp.cjs` | 2026-11-01 85556956 | 0 | 低：历史节点矩阵副本；正式 test-node-combos / audit-node-operation-matrix 已替代 | 删除 |
| `scripts/audit-dreamina-short-after-fix-temp.cjs` | 2026-11-01 85556956 | 0 | 低：历史节点矩阵副本；正式 test-node-combos / audit-node-operation-matrix 已替代 | 删除 |
| `scripts/audit-edit-annotation-real-temp.cjs` | 2026-11-01 85556956 | 0 | 低：历史节点矩阵副本；正式 test-node-combos / audit-node-operation-matrix 已替代 | 删除 |
| `scripts/audit-edit-toapis-real-temp.cjs` | 2026-11-01 85556956 | 0 | 低：历史节点矩阵副本；正式 test-node-combos / audit-node-operation-matrix 已替代 | 删除 |
| `scripts/audit-edit-workbench-real-temp.cjs` | 2026-11-01 85556956 | 0 | 低：历史节点矩阵副本；正式 test-node-combos / audit-node-operation-matrix 已替代 | 删除 |
| `scripts/audit-fast-video-temp.cjs` | 2026-11-01 85556956 | 0 | 低：历史节点矩阵副本；正式 test-node-combos / audit-node-operation-matrix 已替代 | 删除 |
| `scripts/audit-frame-variants-temp.cjs` | 2026-11-01 85556956 | 0 | 低：历史节点矩阵副本；正式 test-node-combos / audit-node-operation-matrix 已替代 | 删除 |
| `scripts/audit-frame-workbench-temp.cjs` | 2026-11-01 85556956 | 0 | 低：历史节点矩阵副本；正式 test-node-combos / audit-node-operation-matrix 已替代 | 删除 |
| `scripts/audit-image-live-temp.cjs` | 2026-11-01 85556956 | 0 | 低：历史节点矩阵副本；正式 test-node-combos / audit-node-operation-matrix 已替代 | 删除 |
| `scripts/audit-p-tools-temp.cjs` | 2026-11-01 85556956 | 0 | 低：历史节点矩阵副本；正式 test-node-combos / audit-node-operation-matrix 已替代 | 删除 |
| `scripts/audit-p-workbench-temp.cjs` | 2026-11-01 85556956 | 0 | 低：历史节点矩阵副本；正式 test-node-combos / audit-node-operation-matrix 已替代 | 删除 |
| `scripts/audit-processor-pass-temp.cjs` | 2026-11-01 85556956 | 0 | 低：历史节点矩阵副本；正式 test-node-combos / audit-node-operation-matrix 已替代 | 删除 |
| `scripts/audit-review-real-temp.cjs` | 2026-11-01 85556956 | 0 | 低：历史节点矩阵副本；正式 test-node-combos / audit-node-operation-matrix 已替代 | 删除 |
| `scripts/audit-split-custom-temp.cjs` | 2026-11-01 85556956 | 0 | 低：历史节点矩阵副本；正式 test-node-combos / audit-node-operation-matrix 已替代 | 删除 |
| `scripts/audit-state-after-fix-temp.cjs` | 2026-11-01 85556956 | 0 | 低：历史节点矩阵副本；正式 test-node-combos / audit-node-operation-matrix 已替代 | 删除 |
| `scripts/audit-state-branches-temp.cjs` | 2026-11-01 85556956 | 0 | 低：历史节点矩阵副本；正式 test-node-combos / audit-node-operation-matrix 已替代 | 删除 |
| `scripts/audit-website-open-temp.cjs` | 2026-11-01 85556956 | 0 | 低：历史节点矩阵副本；正式 test-node-combos / audit-node-operation-matrix 已替代 | 删除 |
| `scripts/audit-workbench-temp.cjs` | 2026-11-01 85556956 | 0 | 低：历史节点矩阵副本；正式 test-node-combos / audit-node-operation-matrix 已替代 | 删除 |
| `scripts/inspect-palette-temp.cjs` | 2026-11-01 85556956 | 0 | 低：一次性 UI/版本/浏览器探针，无引用 | 删除 |
| `scripts/probe-version-mutation.cjs` | 2026-11-09 525641bd | 0 | 低：一次性 UI/版本/浏览器探针，无引用 | 删除 |
| `scripts/qa-current-audit-image-edit-node.cjs` | 2026-11-21 f60cb1f8 | 0 | 低：一次性 UI/版本/浏览器探针，无引用 | 删除 |
| `scripts/qa-current-audit-video-node.cjs` | 2026-11-01 85556956 | 0 | 低：一次性 UI/版本/浏览器探针，无引用 | 删除 |
| `scripts/verify-edit-ui-temp.cjs` | 2026-11-01 85556956 | 0 | 低：一次性 UI/版本/浏览器探针，无引用 | 删除 |

### 删除理由

- 全部 42 个文件在 `package.json`、CI、正式验收入口、测试和产品源码中均为 0 引用。
- 37 个 `audit-*-temp.cjs` 来自 2026-11-01 的批量本地同步提交 `85556956`，其中大量文件是 2200+ 行的历史节点矩阵副本；正式 `test-node-combos`、`audit-node-operation-matrix`、`mcp-acceptance-*` 与 `test-browser-*` 已承接当前验收。
- 至少 `audit-agent-real-app-temp.cjs` 与 `audit-agent-real-launch-temp.cjs` 会读取并解密本机 provider 密钥，再通过环境变量传给子进程；多个脚本写死 `D:\tmp`、`C:\Users\Administrator` 或旧项目 ID。保留它们只会扩大敏感面与误运行风险。
- 付费/真实供应商探针没有正式入口和预算门禁，不应继续散落在 `scripts/` 根目录。
- 历史证据应保留报告、日志和验收回执，而不是保留可执行的一次性脚本。本文件即作为清理清单与决策档案。

## 4. 执行与验证

- 提交：`fix(agent-flow): 完成外部审查修复与仓库清理`（本次提交）。

- C0：新增 `src/main/agent-flow/c0/README.md`，说明测试专用边界；代码与 16 项单测保留。
- 一次性脚本：删除上述 42 个文件，共移除 58,182 行。
- 日志门禁：删除 2200+ 行脚本产生超过默认 `execFileSync` 缓冲区的 diff，`scripts/check-logging-bypass.mjs` 的 Git 读取缓冲区提升到 64MiB，避免大清理被误判为“无法读取基线”。
- 引用检查：清理前 42 个文件在 `package.json`、CI、正式验收入口、测试和产品源码中均为 0 引用；清理后仅本决策档案保留文件名。
- 验证通过：`npm run lint`、`npm run typecheck`、`npm run test:agent-flow-c0-unit`（16/16）、`node scripts/guard-agent-parity.cjs`、`npm run verify:specs`、`npm run verify:logging`、`git diff --check`。
- 清理后全量单测：**359 文件通过 / 2 跳过；4043 项通过 / 7 跳过**。
- 补充回归：`test/observability/logging-gate.test.ts`、`test/daily-gate-plan.test.ts`、`test/verification-infrastructure.test.ts`、`test/compliance-matrix-doc.test.ts` 共 86 项通过。
