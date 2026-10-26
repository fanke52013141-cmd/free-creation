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

### F5（P2·门禁回归，源自基线之上的 c25d2fa）UI 分类重组 5→6 未同步验收脚本，且新分类默认不可见

**现象**：测试收尾期间上游合入 `c25d2fa`（UI 审查落地：分类重组 5→6、节点详情 Rail 化）。该提交把 `input` 分类文案改为"输入与素材"、新增"AI 与自动化/数据与代码"分类并移动了节点归属，但未同步 6 个硬编码旧分类文案的验收脚本：`test-browser-menu-order`、`test-browser-node-colors`（两者在 `test:optimization-ui` 门禁内）、`test-local-agent-access`（在 `verify:checks` 内）、`test-skill-agent-electron`、`test-browser-storyboard`、`test-browser-director-studio`。在合并树上实测：`test-skill-agent-electron` 因等待"展开输入与 AI节点"超时失败；`test-browser-node-standard` 因门禁残留服务的模块实例分裂抛"未注册"错误。

另发现一个产品级不一致：默认工作区 profile（`GENERAL_WORKSPACE_NODE_TYPES`）不含任何数据分类节点（processor/json/structured/iterate/code），而 `CanvasEditor` 的 Dock 只渲染"有可见节点"的分类，导致重组出的第 6 分类"数据与代码"在默认界面**不可见**；但程序化挂载的 `NodeCreateMenu` 会展示全部 6 个分类。数据分类节点在旧方案下同样不在默认可见集（历史行为），因此这是"重组意图与默认可见集不一致"的设计问题而非新回归，但其单元测试期望 6 分类，产品意图需要确认。

**处置**：6 个脚本的分类文案与断言按合并树实际行为修正（Dock 按可见分类断言 5 项、创建菜单断言 6 项；storyboard/director 的展开按钮改为"视频创作"）；"数据与代码默认不可见"作为决策项记录（见 §7），不在本轮擅自改产品默认值。

### F6（P3·基础设施）门禁服务 kill 不可靠导致僵尸 vite 接管端口

**现象**：`run-optimization-ui-gate.cjs` 结束时 `server.kill()` 与 bash `kill` 在 Windows 上多次未真正结束 vite 子进程；实测遗留 4 个僵尸 vite 占据 5173/5194/5195/5196。由于门禁只用 `fetch` 判断"服务就绪"，新一轮门禁的 vite 绑定失败后，测试实际打到了残留的旧模块图服务上，出现评估导入的注册表实例与应用实例分裂（`allNodeTypes()` 返回 0）这类诡异失败，极难排障。

**优化意见与修复**：见 §5-R4（启动前端口占用快失败 + 首屏预热）；`test-browser-node-standard` 的建形状逻辑同步加固（§5-R5）。

## 5. 修复记录

### R3 修复 F5：六处验收脚本与 c25d2fa 分类重组同步

- `test-browser-menu-order.cjs`：Dock 按默认可见分类断言 5 项并注明原因；程序化挂载的 NodeCreateMenu 单独断言全部 6 个分类。
- `test-browser-node-colors.cjs`：分类遍历改为默认可见的 5 个分类（颜色期望仍从页面 `PALETTE_CATEGORY_META` 动态读取）。
- `test-local-agent-access.cjs`、`test-skill-agent-electron.cjs`：展开按钮更新为新分类（素材 / AI 与自动化——chat 与 ai-process 已归入 AI 分类）。
- `test-browser-storyboard.cjs`、`test-browser-director-studio.cjs`：展开按钮"流程与高级"→"视频创作"（storyboard/director 已归入视频分类）。这两个脚本经 fdea986 基线复跑确认为**既有失修**（不在任何门禁内，基线上同样失败于添加按钮超时），本轮只同步文案，深层失修见 §7 决策项。

### R4 修复 F6：门禁运行器启动前快失败 + 首屏预热

`run-optimization-ui-gate.cjs`：spawn vite 前先探测目标端口，已被占用（残留服务）立即报错退出，不再对着过期模块图跑验收；服务就绪后先打开一次真实页面等待 `.tl-canvas` 稳定，触发 vite 依赖发现与可能的整页重载，避免首个验收脚本承受冷启动重载。

### R5 修复 F6：node-standard 建形状单次 evaluate + 重试 + 注册诊断

`test-browser-node-standard.cjs`：就绪检查与建形状合并进同一次 `page.evaluate`（消除两次 evaluate 之间被页面重载撕裂的窗口），失败最多重试 6 次并在最终失败时输出注册数/分组/画布状态诊断与截图，把隐晦的 `undefined.label` 变成可定位证据。

### R1 修复 F2/F4：SQLite 预检失败信息给出真实原因与可执行恢复命令

`scripts/run-vitest.cjs`：预检 catch 现在输出底层 dlopen 错误首行（如 NODE_MODULE_VERSION 137 vs 140），并给出验证有效的恢复命令 `npx electron-rebuild -f -w better-sqlite3`；补充注释说明 install-app-deps 在缺少 Electron 预编译产物时会静默保留系统 Node ABI 二进制。不改变预检的通过/失败行为。

### R2 修复 F3：新增专项验收接入 npm script 与浏览器门禁

- `package.json` 新增：`test:browser-state-machine`、`test:media-local-acceptance`、`test:skill-agent-electron`。
- `scripts/run-optimization-ui-gate.cjs`：`test-browser-state-machine.cjs` 加入浏览器行为门禁列表（随 `npm run test:optimization-ui` 进 `verify:checks`，无外部依赖）。
- `test:media-local-acceptance` 与 `test:skill-agent-electron` 有意不进默认 `verify:checks`（前者依赖本机 ffmpeg，后者需完整 Electron 启动；两者均已验证可独立运行），按交付批次以 npm script 执行，避免门禁环境差异造成假失败。

### R6 处理 F1：并发会话问题以流程约束处理

不修改并发会话的未提交文件；本报告与方案文档落在 docs/，测试与修复全部在隔离 worktree 完成并基于 fdea986 提交，保证推送内容不含外部改动。

## 6. 修复后回归

**fdea986 基线 + 修复（R1/R2）**：

- 定向 vitest 经 `run-vitest.cjs` 包装器完整链路：退出 0（`R-vitest-targeted.log`）。
- 全量 `npm run lint`：退出 0；`package.json` JSON 解析合法；`node --check` 语法通过。
- `npm run test:optimization-ui`（23 个浏览器脚本）：退出 0（`R-optimization-ui.log`）。

**合并树（fdea986 + 上游 c25d2fa + 全部修复 R1–R5，变基后复验）**：

- `npm run typecheck` / `npm run lint` / `npx electron-vite build`：全部退出 0。
- `npm run test:optimization-ui`（预热 + 23 个浏览器脚本）：退出 0（`R2-gate-run9.log`）。
- `npm run test:local-agent-access`：退出 0（`R2-local-agent-access-merged.log`）。
- `node scripts/test-skill-agent-electron.cjs`：退出 0（`R2-skill-merged2.log`）。

## 7. 留给用户的决策项（本轮不擅自改动）

1. **"数据与代码"分类默认不可见**：默认工作区 profile 不含 processor/json/structured/iterate/code，Dock 按可见节点过滤后该分类在默认界面消失，与 6 分类重组的意图（单元测试期望 6 分类）不一致。可选：把数据分类节点补入 `GENERAL_WORKSPACE_NODE_TYPES`（并同步 `normalizeWorkspaceProfile` 的预设迁移），或确认"高级节点从项目设置开启"为既定设计并在重组说明中注明。
2. **两个既有失修脚本**：`test-browser-storyboard.cjs` 与 `test-browser-director-studio.cjs` 在 fdea986 基线上即失败（添加按钮交互已过期），且不在任何门禁内。建议按当前抽屉式面板交互重写或显式退役，避免长期假信号。
3. **vite 服务进程清理**：Windows 上 `server.kill()`/bash kill 对 vite 子进程不可靠，本机曾累积 4 个僵尸服务。长期可考虑门禁 runner 以进程树方式结束（taskkill /T）或使用唯一端口文件协调。
