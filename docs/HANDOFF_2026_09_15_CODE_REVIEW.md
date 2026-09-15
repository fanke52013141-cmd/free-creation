# 交接：代码同步与全库代码审查（2026-09-15）

> 基线提交：`555a77ec0d738f5d35c7b1a4d922391f61b93231`（本轮已推送到 `origin/main`）
>
> 性质：**只读审查**。本轮未修复任何业务代码，未改动任何受版本控制的源文件；所有发现均为待修复项。
>
> 完整报告：`outputs/code-review-2026-09-15/`（本地未跟踪目录：`代码审查报告.html/.md`、`验证摘要.json`、完整测试/lint/构建日志与打包材料）。

## 1. 本轮完成了什么

1. **代码同步**：确认本地 main 领先远端 104 个提交后，经确认将本地已提交内容推送到线上。服务器 `refs/heads/main` 与本地 HEAD 均为 `555a77e`，`git diff --quiet HEAD --` 与 `git diff --cached --quiet` 均通过。未强推、未回退、未额外提交业务代码。
   - 注意：本机 `refs/remotes/origin/main` 跟踪引用多次 fetch 后仍可能读取旧值 `363f2d1`，`git status -sb` 可能显示 `ahead 104`。**判断推送状态一律以 `git ls-remote origin refs/heads/main` 为准**，不要依据本机跟踪缓存。
2. **全库代码审查**：覆盖主进程、preload、IPC、shared engine、renderer/headless 双执行入口、SQLite/文件持久化、导入导出、供应商配置与工程门禁。共确认 **11 项问题：P1×8、P2×3**，每项含文件行号、触发路径、隔离验证证据、修复与回归测试建议（详见完整报告 §5）。
3. **自动化验证**（托管 Node 22.22.2，未重装/重编译原生依赖）：
   - `typecheck:node` / `typecheck:web`：通过。
   - `eslint --no-cache .`：0 error / 129 warning（全部为 prettier 格式告警，集中在 `scripts/audit-*.cjs`）。
   - 生产构建（electron-vite build）：初次因内存分配失败中断，**单独重跑通过**；renderer 主 JS 8,833.63 kB（未压缩）、CSS 353.24 kB。
   - 全量测试（低并发 `--maxWorkers=2 --no-file-parallelism`）：**950 项，932 通过 / 18 失败**，涉及 6 个文件。**18 项失败的直接原因是 `better-sqlite3@12.11.1` 二进制按 NODE_MODULE_VERSION 140 编译、Node 22.22.2 需要 127，属测试运行时 ABI 不匹配，不代表这 18 项业务逻辑有缺陷**；须在匹配环境重跑后才能下结论。

## 2. 问题清单（摘要，完整证据见报告）

| 编号 | 级别 | 一句话描述 | 关键位置 |
| --- | --- | --- | --- |
| F01 | P1 | 保存早期失败（写 .tmp 失败）后回滚会删除当前有效 project.json 或回退到旧版 | `src/main/store/projects.repo.ts:222-240` |
| F02 | P1 | 关窗保存显式不带乐观锁，可覆盖 CLI/MCP 已提交的外部修改 | `CanvasEditor.tsx:536-545`、`project.ipc.ts:124-133` |
| F03 | P1 | 同步保存失败的 FLUSH_FAILED 信封被 preload 丢弃，保存失败仍关窗丢数据 | `src/preload/index.ts:65-67` |
| F04 | P1 | headless 代码节点注入宿主 args 对象，可经构造器链越过 node:vm 隔离（需显式 `CANVAS_AGENT_EXECUTE=enabled`） | `src/main/headless/run-code.ts:119-128` |
| F05 | P1 | headless 把整个 `node.params` 当 props.config，桌面 `params.config` 协议失效，节点静默 skipped | `run-executor.ts:186-208` |
| F06 | P1 | headless 用通用投影替代节点 projectOutputs，structured/media 结果丢失或传出模板 | `run-executor.ts:237-282` |
| F07 | P1 | headless 保存 JSON content 后，快照同步把桌面 props.text 清空 | `run-executor.ts:274-278`、`graph-snapshot-sync.ts:146-164` |
| F08 | P1 | 循环体取消后部分输出被记为 done，resume 时错误复用、剩余项不再执行 | `executor.ts:701-735`、`shared/engine/executors/iterate.ts:228-263` |
| F09 | P2 | headless 持久化上游多路输入被覆盖，many 端口只剩最后一路 | `run-executor.ts:211-234` |
| F10 | P2 | 拆图单图输出固定取 results.at(-1)，忽略 selectedMediaId | `outputProjections.ts:54,86-108` |
| F11 | P2 | 密钥服务暂不可用时仅改供应商名称即把 api_key_ref 清成 NULL | `providers.repo.ts:94-112` |

**修复优先级**：F01–F03（数据保存安全）→ F04（不可信代码隔离）→ F05–F07（双入口语义统一）→ F08–F10 → F11。报告 §7 给出了分 7 个提交的落地拆分与验收门槛。

## 3. 工程观察（非缺陷）

- 源码约 59,169 行 / 237 文件，测试约 13,680 行 / 78 文件（含空行注释，git tracked）。
- 大文件候选拆分：`app.css`(9,684)、`CanvasEditor.tsx`(1,845)、`capabilities/definitions.ts`(1,439)、`DirectorStudioPanel.tsx`(1,323)、`executor.ts`(940)。
- `vitest.config.ts` coverage.include 仅 8 个文件且无阈值，主进程存储/headless/IPC 基本不在覆盖统计内。
- Node 单测与 Electron 原生依赖（postinstall install-app-deps）共用一个 node_modules，是本轮 ABI 失败的结构性根源；建议 CI 分环境或按 ABI 冒烟门禁。
- 已核实良好的部分：普通保存有乐观锁+写锁+bak 轮转；导入有 zip 炸弹/路径/版本防护与重映射；供应商列表不回传密钥；950 项用例与契约门禁真实存在。这些不需重做，只需按报告补边界。

## 4. 移交项

1. **P1 修复**：按报告 §7 顺序处理 F01–F08，每组先写复现测试再修复；触及端口/Schema/契约的改动照常走 `agent:generate` 门禁。
2. **测试环境**：修复 Node/Electron ABI 隔离后在干净环境复跑 950 项，替换本报告的 932/950 基线。
3. **端到端验收**：真实桌面关窗/外部并发编辑/保存重开、安装包、真实供应商调用仍未验证。
4. **lint**：129 条 prettier 告警可一次性 `--fix` 清理（本轮为保持审查零改动未执行）。
5. **跟踪引用**：接手者如见 `ahead 104` 幻象，先 `git ls-remote` 核对再操作，勿据此重复推送。
6. 本机 git 代理 `127.0.0.1:7897` 未运行时，推送需 `-c http.proxy= -c https.proxy=` 直连（沿用 2026-09-12 交接项）。

## 5. 验证材料位置

`outputs/code-review-2026-09-15/`：`tests-serial-final.json/.log`（950 项全量结果）、`tests.log`（默认并发 OOM 现场）、`lint.log`、`build.log`（失败现场）、`build-retry.log`（成功）、`验证摘要.json`（机器可读汇总）、`代码审查报告及验证材料.zip`。
