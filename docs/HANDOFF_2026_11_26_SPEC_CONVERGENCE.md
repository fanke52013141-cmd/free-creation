# HANDOFF 2026-11-26：三大规范体系全面收敛、契约对齐与传输安全加固

> 状态：**已通过规范/契约/类型/Lint/定向单测门禁并推送 `origin/main`**
> 基线前提交：`57a7e60d`（`fix(agent-access): 补齐节点流与状态机人工门禁`）
> 上一交接：[HANDOFF_2026_11_25_BL_BATCH.md](./HANDOFF_2026_11_25_BL_BATCH.md)

---

## 0. 一句话结论

本轮完成了**节点规范、UI 规范、外部 Agent 接入与画布 Agent Flow 规范**三大领域的系统性冲突清零、代码契约补齐与自动门禁扩容，并同批合入工作区已完成的 **MCP SSE `Authorization: Bearer` 鉴权迁移、Windows `connection.json` 当前用户独占 ACL 加固与 C0 测试资产保留边界说明**。接手后如需对外发布版本，下一步是待并行 R09 soak 结束后合入其验收报告，并在干净树跑一次全量 `npm run verify`。

---

## 1. 收敛后的权威规范读取顺序

| 领域 | 现行权威文档（`status: active` / `living`） | 说明 |
| --- | --- | --- |
| 工程总纲 | [`AGENTS.md`](../AGENTS.md)、[`LOGGING_SPEC.md`](../LOGGING_SPEC.md) | 日志交付铁律、节点强制协议、GUI/CLI/MCP 一致性铁律、Agent Flow 三条核心铁律 |
| 唯一待办 | [`docs/BACKLOG.md`](./BACKLOG.md) | `status: living`；唯一待办与剩余未闭环边界清单 |
| 节点与节点流 | [`NODE_CONTRACT_SPEC.md`](../NODE_CONTRACT_SPEC.md)、[`docs/NODE_FLOW_SPEC.md`](./NODE_FLOW_SPEC.md)（v1.0）、[`docs/NODE_COMPLIANCE_MATRIX.md`](./NODE_COMPLIANCE_MATRIX.md)、[`docs/STRUCTURED_CREATIVE_DATA.md`](./STRUCTURED_CREATIVE_DATA.md) | 单节点契约 + 复合节点流正式规范（v0.1 草稿已转正为 v1.0 `active`）+ 34 个可创建节点矩阵 |
| UI 与视觉层级 | [`docs/NODE_UI_STANDARD.md`](./NODE_UI_STANDARD.md)（v3.1，§27 真值表 + §9 全量 34 节点表）、[`docs/UI_MODAL_STANDARD.md`](./UI_MODAL_STANDARD.md)、[`docs/NODE_CANVAS_PRESENTATION_SPEC.md`](./NODE_CANVAS_PRESENTATION_SPEC.md)、[`docs/NODE_OVERVIEW_PANEL_STANDARD.md`](./NODE_OVERVIEW_PANEL_STANDARD.md)（v1.1）、[`docs/NODE_COLOR_SPEC.md`](./NODE_COLOR_SPEC.md)、[`docs/NODE_REFERENCE_SPEC.md`](./NODE_REFERENCE_SPEC.md)、[`docs/STORYBOARD_TABLE_STANDARD.md`](./STORYBOARD_TABLE_STANDARD.md) | 几何/线宽/单调 `z-index` 真值由测试与 CSS 双向锁定；原 §13–§21 已归档至 [`docs/archive/NODE_UI_STANDARD-history.md`](./archive/NODE_UI_STANDARD-history.md) |
| Agent 接入与流程 | [`docs/AGENT_FLOW_SPEC.md`](./AGENT_FLOW_SPEC.md)（v0.4）、[`AGENT_PARITY_SPEC.md`](../AGENT_PARITY_SPEC.md)、[`AGENT_ACCESS_SPEC.md`](../AGENT_ACCESS_SPEC.md)、[`docs/local-agent-access/65-AGENT-PARITY-IRON-RULE.md`](./local-agent-access/65-AGENT-PARITY-IRON-RULE.md)、[`docs/local-agent-access/generated/contracts.json`](./local-agent-access/generated/contracts.json) | 图模式编排、三端同源与确认门禁；运行时操作与节点枚举一律以 `contracts.json` 与 `capability.list` 为准 |

> **已降级为 `status: historical` 的历史台账（仅保留追溯，不得再作为现行能力矩阵引用）**：
> [`docs/NODE_UI_SPEC.md`](./NODE_UI_SPEC.md)、[`docs/canvas-agent-flow/05-node-coordination-standard.md`](./canvas-agent-flow/05-node-coordination-standard.md)、[`docs/local-agent-access/02-capability-matrix.md`](./local-agent-access/02-capability-matrix.md)、[`03-change-enforcement.md`](./local-agent-access/03-change-enforcement.md)、[`15-gui-cli-mcp-parity-plan.md`](./local-agent-access/15-gui-cli-mcp-parity-plan.md)、[`16-node-action-coverage.md`](./local-agent-access/16-node-action-coverage.md)。

---

## 2. 本次已拍板的设计裁决与交付内容

### 2.1 四项核心裁决（已获确认并落地，后续不要回退）

1. **D1 · 节点主操作按钮圆角统一为 `10px`**：[`src/renderer/src/canvas/node-ui-tokens.ts`](../src/renderer/src/canvas/node-ui-tokens.ts) 中 `NODE_UI.primaryButton.radius` 由 `8` 改为 `10`，与 `.canvas-node-primary-btn`（`10px`）及 [`NODE_UI_STANDARD.md`](./NODE_UI_STANDARD.md) §23/§27 统一。
2. **D2 · 右侧详情栏「概览」页以精简 2×2 指标网格为准**：重写 [`NODE_OVERVIEW_PANEL_STANDARD.md`](./NODE_OVERVIEW_PANEL_STANDARD.md)（v1.1），对齐 `NodeContractPanel.tsx` 现行的 2×2 `.contract-overview-grid`（执行方式 / 输入端口 / 输出端口 / 当前状态），不再恢复旧五段式说明卡。
3. **D3 · `FlowGraph` V14 × `decider: 'human'` 角色校验闭环**：[`src/shared/agent-flow/flow-graph.ts`](../src/shared/agent-flow/flow-graph.ts) 改为基于 `resolveFlowNodeDimensions(node)` 校验——凡图声明了 `roles` 且节点含人工参与（`executor === 'human' || decider === 'human'`），必须声明合法 `humanRole`；纯 AI 节点禁止声明 `humanRole`；未声明 `roles` 的单人图继续兼容默认 `owner`。
4. **D4 · MCP `destructiveHint` 精准风险分级**：梳理全部 **191** 个外部操作（[`registry.ts`](../src/shared/agent-access/registry.ts) 与 `src/shared/agent-access/ops/*.ts`），仅保留 **27** 个真实删除/覆盖/丢弃/取消/登出/归档操作为 `destructive: true`，其余 **76** 个增补或可逆写操作改为 `destructive: false`，并在 `validateAccessRegistry()` 中新增只读无副作用、删除必破坏、导出非破坏三条强校验。

### 2.2 节点、UI 与规范门禁修复

- **复合节点 `major.minor` 版本号三端打通**：在 [`src/shared/composite/manifest.ts`](../src/shared/composite/manifest.ts) 导出公共 `COMPOSITE_VERSION_REGEX`（`/^\d+\.\d+(?:\.0)?$/`）与 `compositeVersionSchema`，替换 [`src/shared/agent-access/ops/composite.ts`](../src/shared/agent-access/ops/composite.ts) 中 12 处旧 `/^\d+\.0(\.0)?$/` 正则，修复 CLI/MCP 拒绝 `1.1` 等次版本号的问题；新增 [`test/composite-semver-access.test.ts`](../test/composite-semver-access.test.ts)。
- **节点流规范转正与文档对齐**：[`docs/NODE_FLOW_SPEC.md`](./NODE_FLOW_SPEC.md) 升为 v1.0 `active`（修正 `runtimeVersion: 2`、34 种宿主节点不含 `composite`、`COST_CONFIRM_REQUIRED` 错误码与单画布栈式编辑模式）；[`NODE_CONTRACT_SPEC.md`](../NODE_CONTRACT_SPEC.md) 补齐 §8.0 互链并修正 §8.3 `timeline` 尺寸（`880×291`）与 3 条通用轨描述；[`NODE_COMPLIANCE_MATRIX.md`](./NODE_COMPLIANCE_MATRIX.md) 补齐元数据、`indextts` 说明与 `34 个可创建节点` 计数；[`STRUCTURED_CREATIVE_DATA.md`](./STRUCTURED_CREATIVE_DATA.md) 同步 `iterate` 并发（`1–4`，缺省 `2`）。
- **全局 5 档单调 `z-index` 与全量节点表**：统一 [`ui-foundation.css`](../src/renderer/src/assets/ui-foundation.css)、[`ui-surfaces.css`](../src/renderer/src/assets/ui-surfaces.css)、[`app.css`](../src/renderer/src/assets/app.css) 与 [`UI_MODAL_STANDARD.md`](./UI_MODAL_STANDARD.md) 为 `--z-floating: 900 < --z-modal: 3000 < --z-popover: 3500 < --z-confirm: 4000 < --z-toast: 5000`；将 [`NODE_UI_STANDARD.md`](./NODE_UI_STANDARD.md) §9 扩展至全部 **34** 个 `ActiveNodeTypeId` 并新增 [`test/node-ui-coverage.test.ts`](../test/node-ui-coverage.test.ts) 防漏；修正 [`NODE_CANVAS_PRESENTATION_SPEC.md`](./NODE_CANVAS_PRESENTATION_SPEC.md) 回边绕行公式（`lift = |end.x - start.x| * 0.25`）。
- **动作分母、节点台账与 spec-lint 扩容**：将 [`action-coverage.json`](./local-agent-access/action-coverage.json) 中 8 个 `ipc.license.*` 通道归入 `excluded`（清零遗留 `F9` 阶段）；为 [`65-AGENT-PARITY-IRON-RULE.md`](./local-agent-access/65-AGENT-PARITY-IRON-RULE.md) §7 两条未发布例外补齐 `2026-12-31` 复核期；修正 [`node-actions.ts`](../src/shared/agent-access/node-actions.ts) 中 `ai-process` 模型调用说明与 `video` BL-52 证据；升级 [`scripts/check-specs.mjs`](../scripts/check-specs.mjs) 覆盖 `AGENTS.md` + 23 份规范/治理文档，新增本地相对链接断链检测与 UI 归档章节（`§13–§21`）误引阻断。

### 2.3 同批合入的传输安全与仓库文档收敛（混合提交显式备注）

为保证 `change-impact.json` 受保护源码哈希与 `origin/main` 严格自洽，本次提交一并合入了工作区已完成并通过测试的三项加固（回溯 `git log` 时请知悉）：

1. **MCP SSE Bearer 鉴权迁移**（[`src/local-agent/index.ts`](../src/local-agent/index.ts)、[`scripts/mcp-acceptance-sse.cjs`](../scripts/mcp-acceptance-sse.cjs)、[`63-batch2-3-delivery.md`](./local-agent-access/63-batch2-3-delivery.md)）：`/sse` 与 `/messages` 改为仅接受 `Authorization: Bearer <token>` 请求头（常量时间比对），URL 与 SSE endpoint 不再携带 `?token=`；query token、缺失或错误 header 一律返回 `401`，Host/Origin 校验返回 `403`。
2. **Windows `connection.json` 发现文件最小 ACL**（[`src/main/agent-access/server.ts`](../src/main/agent-access/server.ts)、[`test/local-agent-access.test.ts`](../test/local-agent-access.test.ts)）：Windows 下临时文件发布前通过系统 `.NET` 安全 API 设为仅当前用户 `FullControl` 且关闭继承，失败返回 `WINDOWS_DESCRIPTOR_ACL_FAILED` 并清理临时文件；POSIX 保持 `0600`。（注：Windows named pipe 默认 DACL 事后收紧仍受系统句柄权限限制，**不宣称 named pipe 最小 ACL 已完成**。）
3. **C0 测试资产保留边界与未闭环台账整理**（[`test/harness/agent-flow/c0/README.md`](../test/harness/agent-flow/c0/README.md)、[`docs/canvas-agent-flow/README.md`](./canvas-agent-flow/README.md)、[`docs/BACKLOG.md`](./BACKLOG.md)）：明确 C0 保留为隔离测试专用基础设施及未来 4 条删除前置条件，整理基线 `57a7e60d` 下的真实未闭环边界。

---

## 3. 门禁、日志覆盖与验证证据

| 检查项 | 结果与范围 |
| --- | --- |
| `npm run verify:specs` | ✅ 通过（扫描 `AGENTS.md` + 23 份规范与治理文档，零断链、零归档 UI 章节误引、零重复权威词） |
| `npm run guard:agent-parity` | ✅ 三关全绿：`191 operations; 34 active nodes`；`205 IPC channels + 50 canvas actions`（`{"external":209,"excluded":46}`）；`logging gate passed` |
| `npm run typecheck` | ✅ `node` / `web` / `license-protocol` / `issuer` 四套工程零错误 |
| `npm run lint` & `git diff --check` | ✅ 全仓 `eslint . --quiet` 零错误/警告；空白与缩进检查零告警 |
| 契约与定向 Vitest | ✅ 17 个测试文件共 **621** 项测试全部通过（含 `local-agent-access` 40 项、`composite-semver-access`、`composite-agent-access`、`flow-graph-v2`、`flow-graph-validation`、`flow-graph-dimensions`、`node-ui-coverage`、`node-ui-standard-spec`、`node-ui-decisions`、`ui-foundation`、`compliance-matrix-doc`、`node-color-spec`、`node-compliance`、`node-contract-snapshot`、`connection-matrix`、`output-source-parity`、`node-flow-e2e-composition`） |

- **日志覆盖核查**：已登记于 [`docs/LOGGING_COVERAGE.md`](./LOGGING_COVERAGE.md)。`composite.*` 版本校验与 `FlowGraph` V14 角色校验分别复用既有 `agent.access.*` 与 `flowGraph.*` 调度诊断；Windows `connection.json` ACL 失败沿用 `agent.access.server_failed` 唯一启动终态；全批不记录密钥、SID、路径、URL、提示词或业务正文。
- **本轮未跑范围（如实记录，不外推）**：本轮未执行约 40 分钟的全量 `npm run verify` 桌面与浏览器重型套件，未发起新的真实付费模型请求，未构建 Windows 安装包或实跑干净 GitHub Runner。

---

## 4. 工作区保留项与下一步接手指南

1. **⚠️ 工作区未入库文件提醒**：
   - `docs/canvas-agent-flow/audits/r09-r11-acceptance-2026-11-26.md` 当前包含另一并行验收任务的 R09 5400 秒隔离 soak 占位（多处标记为 `待最终运行结束` 且引用本地 gitignore 的 `qa/` 目录）。本次推送**故意未将其暂存提交**；待该 soak 运行结束、回填真实指标并移除失效本地链接后，再单独提交入库。
2. **建议下一步顺序**：
   - **跑一次干净树全量 `npm run verify`**：验证本轮 CSS 5 档 `z-index` Token 与 `10px` 主按钮圆角在全部 34 个 Playwright/Electron 桌面验收脚本下零视觉/交互回归。
   - **收口 `NF-13.4`（[`BACKLOG.md`](./BACKLOG.md) BL-10 遗留）**：明确 `ContextManifest → 节点流公开输入` 的最小输入编制范围，完成后将 [`NODE_FLOW_SPEC.md`](./NODE_FLOW_SPEC.md) 中唯一剩余的 `【目标】` 条款升为 `【现行】`。
   - **推进安全与发布尾项**：Windows named pipe 创建期最小 DACL、`code` 节点 sandbox 专项隔离审计、视频审核时长上限（60s vs 生成 120s）对齐、`human-task` 音频结果类型，以及 R09/R11/R12 与 Windows 安装包最终验收。
