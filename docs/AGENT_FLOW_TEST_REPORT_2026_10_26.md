# Agent Flow 新增节点与流程测试报告（含优化意见与修复记录）

日期：2026-10-27。被测基线：`fdea986`（origin/main，含 `194e19b` 本地功能交付）。执行环境：隔离 git worktree（并发会话占用了主工作树，见问题 F1）。测试方案见 [AGENT_FLOW_TEST_PLAN_2026_10_26.md](./AGENT_FLOW_TEST_PLAN_2026_10_26.md)。

## 1. 结论（TL;DR）

**基线代码全部通过**：静态门禁、2575 项单元/集成、日志与外部接入门禁、22 项浏览器行为、状态机独立执行画布验收、媒体停止桌面验收、Skill 桌面验收、A1.4 只读查询、诊断窗口关闭，以及 Agent Flow 主链路、顺序协调、建图、并行建图、审核、资产版本、命令账本、恢复重开、三类返工、视频与并行媒体抽样桌面专项均退出码 0。**本轮未发现任何功能缺陷**。

**本轮发现并修复 3 个工程化/环境问题**（均非功能缺陷）：并发会话工作树污染、全新检出 SQLite ABI 不匹配导致测试无法启动、三个新增验收脚本未接入任何门禁。修复内容见 §4/§5，回归结果见 §6。

## 2. 测试结果矩阵

| 层 | 测试项 | 命令 | 结果 | 证据 |
| --- | --- | --- | --- | --- |
| A | ESLint | `npm run lint` | ✅ 退出 0 | `qa/verification/agent-flow-test-20261026/A-lint.log` |
| A | Node+Web 类型检查 | `npm run typecheck` | ✅ 退出 0 | `A-typecheck.log` |
| A | 模型包类型检查 | `npm run typecheck:model` | ✅ 退出 0 | `A-typecheck-model.log` |
| B | 全量单元/集成 | `npm run test` | ✅ 207 文件 / 2575 通过 / 5 既有跳过 | `B-unit.log` |
| B | 契约合规（节点/快照/连线矩阵） | `npm run test:contract` | ✅ 退出 0 | `C-contract.log` |
| C | 日志覆盖门禁 | `npm run verify:logging` | ✅ 退出 0 | `C-logging.log` |
| C | 外部接入门禁（18 项操作） | `npm run verify:agent-access` | ✅ 退出 0 | `C-agent-access.log` |
| D | 浏览器行为门禁（22 脚本，Chrome 155 headless） | `npm run test:optimization-ui` | ✅ 退出 0 | `D-optimization-ui.log` |
| D+ | P2-A 状态机独立执行画布验收（未接线，单独执行） | `node scripts/test-browser-state-machine.cjs` | ✅ 退出 0 | `D-plus-state-machine.log` |
| E | P1-A 媒体停止桌面验收（未接线，单独执行） | `node scripts/test-media-local-acceptance.cjs` | ✅ 退出 0 | `E-media-local.log` |
| E | Skill 生产 Electron 安装/保存/重开/脱敏 | `node scripts/test-skill-agent-electron.cjs` | ✅ 退出 0 | `E-skill-electron.log` |
| E | A1.4 只读查询 CLI/MCP 18 项 | `npm run test:local-agent-access` | ✅ 退出 0 | `E-local-agent-access.log` |
| E | 诊断窗口关闭专项 | `npm run test:diagnostics-window-close` | ✅ 退出 0 | `E-diagnostics-close.log` |
| E | Agent Flow 主链路桌面（启动/双工具/人机等待重开继续/固定资产/诊断） | `npm run test:agent-flow-desktop` | ✅ 退出 0 | `E-flow-desktop.log` |
| E | 主控顺序协调 | `npm run test:agent-flow-coordination` | ✅ 退出 0 | `E-flow-coordination.log` |
| E | 文本模板建图 | `npm run test:agent-flow-builder` | ✅ 退出 0 | `E-flow-builder.log` |
| E | 并行建图 | `npm run test:agent-flow-builder-parallel` | ✅ 退出 0 | `E-flow-builder-parallel.log` |
| E | 审核 | `npm run test:agent-flow-review` | ✅ 退出 0 | `E-flow-review.log` |
| E | 资产版本 | `npm run test:agent-flow-assets` | ✅ 退出 0 | `E-flow-assets.log` |
| E | 命令账本 | `npm run test:agent-flow-commands` | ✅ 退出 0 | `E-flow-commands.log` |
| E | 恢复重开 | `npm run test:agent-flow-recovery` | ✅ 退出 0 | `E-flow-recovery.log` |
| E | 三类返工（autonomous/collaborative/manual） | `npm run test:agent-flow-rework` | ✅ 退出 0 | `E-flow-rework.log` |
| G | 视频适配器抽样 | `npm run test:agent-flow-video` | ✅ 退出 0 | `E-flow-video.log` |
| G | 并行媒体抽样 | `npm run test:agent-flow-parallel-media` | ✅ 退出 0 | `E-flow-parallel-media.log` |
| F | 生产构建 | `npm run build` | ✅ 退出 0 | `F-build.log` |

## 3. 重点用例核对（对应方案 §5）

- **状态机（N1）**：初始化 draft/revision=1 → 卡片按钮提交事件只入 pending → 运行推进 working/revision=2 → JSON 快照重开一致 → 过期修订提交显式拒绝且实例不被污染 → 正确修订 finish→completed/revision=3。全部通过（D+）。
- **Skill（N2）**：真实 Electron IPC 安装 SKILL.md → chat/ai-process 绑定 v1 → 公共自动保存 → 新进程重开后库与节点配置一致 → 诊断日志不含技能正文/密钥且 trace 配对唯一终态。全部通过（E）。
- **媒体停止（N4）**：6000×4000 PNG + 90s 720p MP4 真实素材；裁剪/拆图/截取单节点/选区/全图一致；拆图运行中停止真回滚、ffmpeg 真终止（主进程 1 条终止记录）；保存重开无自动再生成、明确重试可用。全部通过（E）。
- **A1.4（N5）**：18 项操作契约快照一致，model.list/library.search/run.get/diagnostics.summary 通过（E + C 门禁）。
- **Agent Flow 主链路（N6）**：桌面主链路（启动/双工具/人机等待重开继续/固定资产/诊断）、顺序协调、文本模板建图、并行建图、审核、三类返工、恢复重开、资产版本与命令账本全部通过；并行媒体（2 路）与视频适配器抽样通过（E/G）。

## 4. 问题清单与优化意见

### F1（P2·环境）并发会话污染工作树，类型检查被误判为基线失败

**现象**：测试启动时 `git status` 干净；运行期间外部会话修改了 7 个文件（`palette-preferences.ts`、`palette-categories.ts`、`registry.tsx`、`specs/index.tsx`、`specs/agentFlow.tsx`、`palette-menu-order.ts`、`test/palette-menu-order.test.ts`），把已提交并推送的五分类色板（input/image/video/audio/logic，"流程橙"）回退为旧六分类（ai/data），产生 14 个 TS2322/TS2353 错误。同时 `test-skill-agent-electron.cjs` 依赖"展开输入与 AI节点"按钮文案、`test:browser-*` 系列依赖分类文案，并发改动若提交将破坏这些已验收脚本。

**处理**：未触碰外部改动；改在 `git worktree add ... fdea986` 的隔离目录完成全部测试。基线类型检查全绿，证明错误全部来自未提交改动而非基线。

**优化意见**：同一工作目录只保留一个写者；并行 AI 会话改动提交前必须先过 `npm run typecheck` 与受影响的浏览器/桌面验收；已提交的五分类方案回退属于功能回退，需走明确决策而非直接改文件。

### F2（P2·工程化）全新检出后 `npm test` 无法启动：SQLite ABI 与 Electron 不匹配

**现象**：干净 worktree 中 `pnpm install` 成功（postinstall 走 `electron-builder install-app-deps`），但 `npm run test` 预检报 "SQLite does not match the Electron runtime"。实测：`better_sqlite3.node` 为 NODE_MODULE_VERSION 137（系统 Node 24），而 Electron 39（Node 22 运行时）要求 140。原因：install-app-deps 以 `buildFromSource=false` 依赖预编译产物，对 Electron 39 的预编译不可用时静默保留 Node 版二进制；重跑 install-app-deps 无效，必须 `npx electron-rebuild -f -w better-sqlite3` 从源码重编。原源码目录能跑测试只是因为历史遗留的源码编译产物。

**优化意见与修复**：见 §5-R1（预检报错补充可执行的恢复命令与原因说明）。

### F3（P3·门禁缺口）三个新增专项验收未接入任何 npm script / 门禁

**现象**：`scripts/test-browser-state-machine.cjs`（P2-A 状态机）、`scripts/test-media-local-acceptance.cjs`（P1-A 媒体停止）、`scripts/test-skill-agent-electron.cjs`（Skill 桌面）既没有 package.json 条目，也不在 `test:optimization-ui` 门禁列表或 `verify:checks` 中。P2-A/P1-A/Skill 的画布与桌面验收仅靠一次性手工执行，后续回归无门禁保护。

**优化意见与修复**：见 §5-R2（补 npm script 并接入浏览器门禁与 verify 链）。

### F4（P3·可用性）预检失败信息误导排障

**现象**：`run-vitest.cjs` 的失败提示只说 "Run electron-builder install-app-deps"，但在 F2 场景下重跑该命令无效，排障被误导。

**优化意见与修复**：见 §5-R1（与 F2 一并处理）。

## 5. 修复记录

### R1 修复 F2/F4：SQLite 预检失败信息给出真实原因与可执行恢复命令

`scripts/run-vitest.cjs`：预检 catch 现在输出底层 dlopen 错误首行（如 NODE_MODULE_VERSION 137 vs 140），并给出验证有效的恢复命令 `npx electron-rebuild -f -w better-sqlite3`；补充注释说明 install-app-deps 在缺少 Electron 预编译产物时会静默保留系统 Node ABI 二进制。不改变预检的通过/失败行为。

### R2 修复 F3：新增专项验收接入 npm script 与浏览器门禁

- `package.json` 新增：`test:browser-state-machine`、`test:media-local-acceptance`、`test:skill-agent-electron`。
- `scripts/run-optimization-ui-gate.cjs`：`test-browser-state-machine.cjs` 加入浏览器行为门禁列表（随 `npm run test:optimization-ui` 进 `verify:checks`，无外部依赖）。
- `test:media-local-acceptance` 与 `test:skill-agent-electron` 有意不进默认 `verify:checks`（前者依赖本机 ffmpeg，后者需完整 Electron 启动；两者均已验证可独立运行），按交付批次以 npm script 执行，避免门禁环境差异造成假失败。

### R3 修复记录补充：并发会话问题（F1）以流程约束处理

不修改并发会话的未提交文件；本报告与方案文档落在 docs/，测试与修复全部在隔离 worktree 完成并基于 fdea986 提交，保证推送内容不含外部改动。

## 6. 修复后回归

- 定向 vitest 经 `run-vitest.cjs` 包装器完整链路（`test/node-status.test.ts`）：退出 0（`R-vitest-targeted.log`）。
- 全量 `npm run lint`：退出 0（`R-lint.log`）。
- `npm run test:optimization-ui`（现含状态机画布验收，共 23 个浏览器脚本）：退出 0（`R-optimization-ui.log`）。
- `package.json` JSON 解析合法；`node --check` 两个脚本语法通过。
- §2 中 `test:browser-state-machine` / `test:media-local-acceptance` / `test:skill-agent-electron` 的执行即等价于新 npm script 的验证（接线前以相同脚本文件直接运行）。
