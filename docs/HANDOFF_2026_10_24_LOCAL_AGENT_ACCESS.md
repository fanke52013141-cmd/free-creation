# 交接文档：本地外部 Agent 接入（A0–A1.2 收尾与后续开发）

接续更新：A1.4首包源码与完整verify已完成（run-dRDuuy退出0），新增4项只读查询，总计18项。范围、验证和后续路线以[查询台账08](local-agent-access/08-a1-4-read-only-queries.md)为准；本文A0–A1.2证据保留为历史基线。

日期：2026-10-24。交接对象：接续开发的 Agent。范围：本地外部 Agent 接入线的当前状态、验证体系、已决边界与下一步。先读 [AGENTS.md](../AGENTS.md) 工程约束，再读本文。

## 1. 当前位置（截至本文最后一次更新）

| 包       | 状态     | 证据                                                                                                     |
| -------- | -------- | -------------------------------------------------------------------------------------------------------- |
| A0+A1 最小纵向包 | 已关闭   | [台账 05](local-agent-access/05-a0-a1-minimal-delivery.md)；run-4kUMWv 完整验证退出0；package-manifest   |
| A1.1 桌面项目操作 | 已关闭   | [台账 06](local-agent-access/06-a1-1-desktop-projects.md)；run-v3mcD2 完整验证退出0；a11 打包闭环 manifest |
| A1.2 复制与预检确认删除 | 已关闭   | [台账 07](local-agent-access/07-a1-2-clone-delete.md)；run-ZfT4VL 完整验证退出0（单元2499/5跳过）；a12 打包闭环 manifest（入口哈希一致、14项工具） |

CLI/MCP 当前共 **14 项操作**：app.status、capability.list、node.type.list、project.list/get/create/open/update/rename/save/clone/delete.precheck/delete/export。HTTP、项目导入、节点编辑/执行未开放；31 类节点仍为 planned。

## 2. 架构与代码地图

分层原则：**只有 main 服务触碰仓库；CLI/MCP 是薄传输客户端；UI 与外部共用同一业务事实**。

- `src/shared/agent-access/registry.ts`：全部 operation 声明（effect: read/write/export/delete）、严格输入/输出 Schema、目录生成与登记校验。**加操作只改这里 + service**，CLI/MCP/契约目录自动同步。
- `src/main/agent-access/service.ts`：唯一业务分发。幂等受理（`local_agent_operations` 表，HMAC 意图，30 天回执）、占用检查、活动画布握手分支、导出受控目录、A1.2 的克隆/预检/删除。
- `src/main/agent-access/desktop.ts`：main↔renderer 握手桥（requestId/sender/frame/10 秒有效期，迟到回执不授权）。
- `src/main/agent-access/server.ts`：命名管道 + token 本地服务；`src/local-agent/`：CLI（`node out/main/local-agent.js project clone --input-file x.json`）与 MCP stdio serve。
- 仓库层复用：`src/main/store/projects.repo.ts` 的 `cloneProject`（staging+事务+媒体/引用重映射）、`deleteProject`（硬删）、`withProjectVersionLock`（版本 CAS）。

A1.2 关键设计：`project.delete.precheck` 只读返回影响摘要+阻塞项，无阻塞时签发 10 分钟 HMAC `impactToken`（绑定实例/目标/权威修订/影响摘要）；删除时重算事实并比对令牌，任何漂移返回 `IMPACT_TOKEN_INVALID` 需重新预检（区分于缺失确认的 `IMPACT_CONFIRM_REQUIRED`，阶段 `delete-admission`）。删除拒绝活动画布与占用项目；同 key 回执重放，同名新项目不受旧回执影响。

## 3. 验证体系（照此复验，勿自创路径）

1. **定向单元**：`npm test -- test/local-agent-access.test.ts`（28 项）。注意：vitest 必须经 `scripts/run-vitest.cjs`（Electron ABI），直接 `npx vitest` 会全挂。
2. **真实桌面闭环**：`node scripts/test-local-agent-access.cjs`（源码模式，先 `npx electron-vite build`）。覆盖 CLI/MCP/桌面打开/活动保存导出/克隆/删除/回执/JSONL 脱敏。安装版：设 `CANVAS_LOCAL_AGENT_INSTALL_ROOT=<win-unpacked 目录>`。
3. **接入门禁**：`npm run verify:agent-access`。改 registry/受保护源码后必须 `node scripts/check-agent-access.cjs --write --reason "≥12字说明"` 刷新快照与影响声明；既有操作 Schema 变化还需 `--accept-contract-change` 并给兼容结论。
4. **文档引用**：`node qa/local-agent-access/check-doc-links.cjs`（当前 105 项零断链）。
5. **完整验证**：`npm run verify`（约 25–30 分钟，产物在 `qa/verification/run-*/`）。**用后台任务跑并等它结束**：父会话终止会连带杀掉验证链，留下永远 "running" 的僵尸 run（先例：run-whOIIM，已手工标 interrupted）。收到 interrupted 僵尸时如实标注，不得当失败或通过。
6. **打包闭环**：`node qa/local-agent-access/final-a11-package.cjs` / `final-a12-package.cjs`——等待指定 run 过 `test:local-agent-access` 检查点后 electron-builder 目录包 + 安装版验收 + manifest（入口哈希/依赖在包内）。换 run 时改脚本头部 `verification` 常量。

## 4. 已知边界与坑

- **recovery-contention 偶发窗口**：run-fGy8iz 曾因跨进程恢复竞争偶发失败（两个并发恢复进程双双失败，其一透出未包装 Sqlite busy）。同源码多轮全过、隔离复跑稳定；台账 06 已登记。复现时修竞争路径，勿以重跑掩盖。
- 删除不级联清理 media/library_usages 孤儿行（FK pragma 未开启，与桌面现有硬删除共享现状）；这是登记过的共享边界，未在 A1.2 扩大。若要修，须在仓库层修并同步桌面行为。
- 验收脚本断言 MCP 工具数当前为 **14**；再加操作记得同步改 `scripts/test-local-agent-access.cjs`。
- 验收脚本截图用 `webContents.capturePage`（Electron 原生），不要换回 Playwright `page.screenshot`（字体加载等待会超时）；冻结时钟用"一分钟前安装、快进、暂停"模式。
- 测试可见窗口必须标 `[TEST]` 标题并在 finally 关闭清理；数据一律 `CANVAS_DATA_DIR` 隔离临时目录。
- 日志：接入操作复用 `agent.access.started` + 唯一终态（main 公共入口负责），新失败用新 phase/code，不重复记终态，不记名称/路径/令牌/正文。变更走 [日志模板](templates/LOGGING_CHANGE_TEMPLATE.md) 并更新 [覆盖清单](LOGGING_COVERAGE.md)。
- 提交纪律：完整验证未出结果前不宣称通过；台账/覆盖清单引用真实 run ID 与退出码。

## 5. 下一包建议（按[实施计划](local-agent-access/04-implementation-plan.md)顺序）

1. **A1.4 查询与诊断**：能力/模型去敏目录、run.get 基础、资源库只读、诊断摘要/包。注意诊断包边界见 LOGGING_SPEC §12，资源包与项目包分开验收。
2. **A1.5 安装包与真实客户端**：已有 a11/a12 目录包与脚本内真实 MCP SDK 客户端闭环（run-ZfT4VL/a12 manifest）；剩余是安装器、版本匹配声明与至少一个第三方 MCP 客户端实测。
3. **A2 节点结构化访问**：31 类 NodeAccessSpec、图命令、公共执行准入；先读计划 §4 的五类回归要求与 05 节点协同规范（内部 Agent Flow 目录）。
4. 用户路径先行：每包先定义并验收一条画布用户路径；未支持项显式标注，不以测试数量替代验收。

## 6. 本次提交内容备注

单次提交包含 A0+A1 最小包、A1.1、A1.2 三段及全部台账/门禁产物（此前后续均未提交，基线为 vidu 提交 6f3819d）。详细变更与证据见各台账；验证状态见 §1。工作树内 `dist/`、`qa/` 为本地产物不入库；`docs/local-agent-access/generated/` 与 `change-impact.json` 是门禁比对产物，必须随源码一起提交。
