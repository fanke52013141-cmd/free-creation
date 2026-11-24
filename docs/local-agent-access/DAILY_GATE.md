# 每日门禁（DAILY_GATE）

日期：2026-11-24。入口：`node scripts/daily-gate.cjs`（`npm run verify:daily` / `npm run verify:daily:fast`）。
证据：`qa/daily-gate/<timestamp>.json`（`qa/` 已被 `.gitignore` 忽略，不作为仓库事实来源）。

本文件只描述**当前脚本真实执行的步骤**。门禁通过仅代表本文列出的步骤通过；未列出的边界仍然是未验证。

## 1. 两种模式与开关

| 命令                                    | 行为                                                                    |
| --------------------------------------- | ----------------------------------------------------------------------- |
| `node scripts/daily-gate.cjs`（默认）   | 静态门禁 4 步 → 构建 → 真实窗口验收 1 步（`verify:acceptance` 全批次）  |
| `node scripts/daily-gate.cjs --fast`    | 只跑静态门禁 4 步，跳过构建与真实窗口验收                               |
| `node scripts/daily-gate.cjs --list`    | 只打印将执行的步骤、命令、超时与环境变量，**不执行**、不创建 `qa/` 目录 |
| `node scripts/daily-gate.cjs --dry-run` | 与 `--list` 等价语义                                                    |
| `node scripts/daily-gate.cjs --help`    | 打印用法                                                                |

- 未知参数与位置参数（例如 `full`、`--list=1`）直接拒绝，退出码 2，避免静默跑错范围。
- 门禁串行执行、**失败即停**：某步失败后，后续步骤在摘要里标为 `skipped`，不会再启动。
- 每步都有超时，超时后结束子进程树并判该步失败（Windows 用 `taskkill /T /F`，其他平台 `SIGKILL`）。
- 默认模式运行前会校验 `package.json` 里确实存在计划中的 npm 脚本；缺失则以 `DAILY_GATE_PLAN_INVALID` 退出 2。

退出码：`0` 通过；`1` 失败；`2` 参数/计划前置错误。

## 2. 静态门禁（4 步，均为 `package.json` 既有脚本）

| 步骤 id          | 命令                    | 超时 | 实际内容                                                                                                                       |
| ---------------- | ----------------------- | ---- | ------------------------------------------------------------------------------------------------------------------------------ |
| `lint`           | `npm run lint`          | 15m  | ESLint（`eslint.config.mjs`）                                                                                                  |
| `typecheck`      | `npm run typecheck`     | 30m  | `typecheck:node` + `typecheck:web` + `typecheck:license-protocol` + `typecheck:issuer`（`package.json` 里 typecheck 的真实链） |
| `unit-tests`     | `npm run test`          | 60m  | `node scripts/run-vitest.cjs run --maxWorkers=1 --minWorkers=1`（全量单元/集成测试）                                           |
| `contract-tests` | `npm run test:contract` | 20m  | **契约三关**：`test/node-compliance.test.ts`、`test/node-contract-snapshot.test.ts`、`test/connection-matrix.test.ts`          |

`--fast` 就是这 4 步，不包含任何 Electron/Playwright 窗口启动。

## 3. 真实窗口验收（默认模式才有，2 步）

| 步骤 id      | 命令                                     | 超时 | 实际内容                                                                                                                                   |
| ------------ | ---------------------------------------- | ---- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `build`      | `npm run build`（注入 `CANVAS_OWNER=1`） | 30m  | `npm run typecheck && electron-vite build`，产出 `out/`（`out/main/local-agent.js` 是验收脚本的入口前置）                                  |
| `acceptance` | `npm run verify:acceptance`              | 180m | `scripts/verify-acceptance.cjs` 串行跑 9 个批次，全部通过 **Playwright `_electron.launch`** 启动真实 Electron 窗口 + 真实本地 MCP/CLI 通道 |

9 个批次（`scripts/verify-acceptance.cjs` 的 `ALL` 列表，按实际脚本名）：

1. `protocol` → `scripts/mcp-acceptance.cjs`
2. `family1` → `scripts/mcp-acceptance-family1-project-graph.cjs`
3. `families-2-3-7-8` → `scripts/mcp-acceptance-families-2-3-7-8.cjs`
4. `families-4-5-6-9` → `scripts/mcp-acceptance-families-4-5-6-9.cjs`
5. `gap-fill` → `scripts/mcp-acceptance-gap-fill.cjs`
6. `f9-remaining` → `scripts/mcp-acceptance-f9-remaining.cjs`
7. `optimizations` → `scripts/mcp-acceptance-optimizations.cjs`
8. `sse` → `scripts/mcp-acceptance-sse.cjs`
9. `parity-gaps` → `scripts/test-agent-parity-gaps.cjs`

关于环境与副作用（均为既有行为，不是本门禁新增）：

- `CANVAS_OWNER=1` 只影响 `electron-vite build` 的构建期 define（自用版构建跳过授权门禁、保留全部节点），与 `scripts/run-verification.cjs` 的既有约定一致。
- `npm run build` 里已经包含一次 `typecheck`，所以默认模式的 `typecheck` 会被执行两次：一次在静态门禁，一次在 `build` 脚本内部。这是按 package.json 既有脚本编排的结果，门禁没有另造命令。
- 每个批次会把 `report.json` 写到 `qa/local-agent-access/<批次>/`；`verify-acceptance.cjs` 结束时还会调用 `scripts/archive-acceptance-evidence.cjs`，把报告**追加**到 `docs/local-agent-access/evidence/` 与 `INDEX.md`。每日调度会让这个受版本管理的目录持续出现新文件，需要按团队策略提交或清理。
- 真实窗口验收前置：本机授权已激活、有可用的交互桌面会话、磁盘空间足够保存 `qa/` 证据。门禁不负责激活授权，也不会修改授权状态。
- 门禁串行执行，运行期间不要手工操作被测应用窗口，否则可能出现非代码原因的真实窗口失败。

## 4. 证据与结果

控制台最后两行固定为：

```text
DAILY_GATE_SUMMARY=qa/daily-gate/2026-11-24T07-32-41-123Z.json
DAILY_GATE_RESULT=failed
```

`DAILY_GATE_RESULT` 取值只有 `passed` / `failed`（`--list` / `--dry-run` 只打印计划，不输出该行）。
参数或计划错误时退出码 2，可能只输出 `DAILY_GATE_RESULT=failed` 而没有摘要文件。

摘要 JSON 关键字段：

- `tool` / `version` / `mode`（`full` 或 `fast`）；
- `startedAt` / `finishedAt` / `status`（`passed` / `failed`）/ `failedStep`；
- `summaryPath`（相对路径）；
- `steps[]`：`id`、`phase`、`title`、`script`、`command`、`timeoutMs`、`env`、`status`（`passed` / `failed` / `skipped`）、`exitCode`、`signal`、`durationMs`、`timedOut`、`errorCode`（`STEP_TIMEOUT` / `SPAWN_ERROR` 等）。

摘要写入失败时，门禁把结果判为 `failed` 并在 stderr 打印 `DAILY_GATE_SUMMARY_WRITE_FAILED`。

## 5. 明确未覆盖的边界

以下内容**不在**每日门禁的通过结论内：

1. **真实付费模型调用**：门禁不设置任何模型密钥、不传 `--real-model`、不启用 `test:agent-flow-desktop --real-model`。`verify:acceptance` 的批次脚本是否跳过依赖凭据的分支，由脚本自身现状决定；门禁不为它补凭据，也不改变其跳过行为。因此“模型真实调用链、计费与真实产物质量”不等于已验证。
2. **安装包与源码一致性**：门禁只验收 `electron-vite build` 的 `out/` 产物，不构建、不安装、不启动 `electron-builder` 生成的安装包（`build:win`、`build:unpack`、`build:desktop-latest` 等均未纳入）。已安装版本与当前源码是否一致、打包后行为是否一致，均未验证。
3. **物理掉电**：没有任何模拟或真实断电、硬件级强杀、文件系统损坏测试；`test:r09-soak`、崩溃恢复专项与 `test:renderer-save-recovery` 也不在本门禁计划内。因此不能把本门禁当作掉电/崩溃恢复的保证。
4. **相邻但未纳入的静态门禁**：`guard:agent-parity`（提交前铁律三关：契约快照 / 动作分母 / 日志）、`verify:agent-access`、`verify:logging`、`test:model`、`test:license`、`test:optimization-ui`、`test:local-agent-access`、`test:diagnostics-window-close`、agent-flow 系列桌面专项等均**不**在本每日入口内；完整 `npm run verify`（`verify:checks`）覆盖面仍然大于每日门禁。
5. **人工与真实鼠标走查**：需要人判断的视觉验收、真实鼠标共创、真实用户操作路径不自动覆盖。
6. **环境矩阵**：本门禁假定当前 Windows 交互桌面会话、本机已激活。CI（尤其是无桌面会话的容器）上的真实窗口验收未在本仓库验证；跨平台（macOS/Linux）同样未验证。
7. **并发与清洁环境**：门禁串行运行，不清理历史 `qa/` 证据，也不验证干净克隆/干净用户目录下的首次运行；连续两次运行之间的状态污染未被隔离。
8. **`acceptance:*` 系列桌面/GUI 专项**：`acceptance:composite-desktop`、`acceptance:composite-gui`、`acceptance:agent-flow-layout` 等 14 个脚本同样会启动真实窗口，但它们不在 `verify:acceptance` 的 9 批列表内，也没有纳入每日门禁；需要时单独执行。

## 6. 每日调度建议

调度只是“按天触发本脚本”，不改变上面的覆盖口径。

### 6.1 Windows 计划任务

必须在已登录用户的交互桌面会话中运行（Playwright 启动 Electron 需要桌面，**不要**选择 “Run whether user is logged on or not” 这类无桌面会话的运行方式）：

```powershell
$root = 'D:\Program Files (x86)\canvas-studio\source'
$argument = "-NoProfile -ExecutionPolicy Bypass -Command `"Set-Location '$root'; New-Item -ItemType Directory -Force 'qa\daily-gate' | Out-Null; node scripts/daily-gate.cjs *>> 'qa\daily-gate\scheduler.log'`""
$action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument $argument
$trigger = New-ScheduledTaskTrigger -Daily -At 03:30
Register-ScheduledTask -TaskName 'CanvasStudio-DailyGate' -Action $action -Trigger $trigger -Force

# 手工演练一次，然后看 qa/daily-gate/scheduler.log 与摘要 JSON
Get-ScheduledTask -TaskName 'CanvasStudio-DailyGate' | Format-List TaskName, State
Start-ScheduledTask -TaskName 'CanvasStudio-DailyGate'
```

注意：

- 上面是示例路径，按本机实际安装位置调整；`Register-ScheduledTask` 用当前用户身份注册，若要改成其它账号，需要显式提供 `-User` / `-Password`（并保持“仅在用户登录时运行”）。
- 如果计划任务环境的 `PATH` 里没有 `node`，把命令中的 `node` 换成绝对路径，例如 `& 'C:\Program Files\nodejs\node.exe'`。
- 等价的 `schtasks /Create` 也能用，但引号嵌套容易出错，不建议照抄混合引号写法。
- 只想每天跑静态门禁（更轻、不依赖桌面）时，把命令里的 `node scripts/daily-gate.cjs` 换成 `node scripts/daily-gate.cjs --fast`。

### 6.2 CI cron

CI 里最稳妥的是先上 `--fast`（不启动真实窗口）；完整模式需要桌面/图形环境与已激活授权，本仓库尚未验证 CI 能稳定跑完真实窗口验收，不要假设它能跑。

```yaml
# 示例：每天 19:30 UTC（= 次日 03:30 Asia/Shanghai）跑静态门禁
on:
  schedule:
    - cron: '30 19 * * *'
  workflow_dispatch:

jobs:
  daily-fast-gate:
    runs-on: windows-latest
    timeout-minutes: 180
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: pnpm
      - run: pnpm install --frozen-lockfile
      - run: node scripts/daily-gate.cjs --fast
```

若要在 CI 里跑完整模式，需要额外解决：图形显示环境（Linux 用 xvfb、Windows 需要可用桌面会话）、授权激活材料、以及真实窗口用例的运行时长；这些前置目前在 CI 中均未验证，不建议直接把默认模式排进每日 cron。上面的 workflow 只是排程模板，本仓库尚未在 CI 中实跑验证。

## 7. 本地手工使用建议

```powershell
node scripts/daily-gate.cjs --list      # 先确认今天要跑什么
node scripts/daily-gate.cjs --fast      # 日常快速回归（静态门禁）
node scripts/daily-gate.cjs             # 完整：静态 + 构建 + 真实窗口验收（耗时最长）
```

## 8. 变更影响

本入口只新增/修改：`package.json` 的 scripts（新增 `verify:daily`、`verify:daily:fast`）、
`scripts/daily-gate.cjs`、本文件、`test/daily-gate-plan.test.ts`。

- 不涉及 `src/**` 受保护源码、IPC/契约、CLI/MCP 能力、节点执行或数据路径，因此不需要刷新
  `docs/local-agent-access/change-impact.json` 与契约快照。
- 不涉及业务日志：脚本只做调度、超时与证据落盘，不新增/修改任何业务诊断事件，也不替代正式诊断。
  真实窗口验收的日志证据仍由既有脚本与 `docs/LOGGING_COVERAGE.md` 的口径负责。
- 门禁通过不代表第 5 节列出的边界已验证。
