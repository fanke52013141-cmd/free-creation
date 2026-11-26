# 真实 Host/Store 与 CLI/MCP 端到端回归台账

日期：2026-11-26（Asia/Shanghai）。范围：为 H01、H02、H04–H10 修复补充可重复执行的真实桌面、真实存储和双外部入口回归，不用 fake port 或手写成功回执替代业务执行。

## 1. 可重复入口

```powershell
npm run acceptance:agent-composite-remediation
npm run acceptance:agent-capability-params
npm run acceptance:agent-flow-context-adoption

# 统一运行器（本批）
node scripts/verify-acceptance.cjs composite-remediation capability-params agent-flow-context-adoption
```

共享传输位于 `scripts/acceptance/lib/e2e-transport.cjs`：生产 CLI socket、官方 MCP SDK stdio、真实 Electron 窗口与实例/PID 校验。三个场景也已加入 `scripts/verify-acceptance.cjs` 的全量验收清单。

## 2. 覆盖矩阵

| 范围 | 真实业务路径 | 核心断言 |
| --- | --- | --- |
| H01 | CLI/MCP `composite.execute` → run.get / diagnostics | 失败节点仅认领一次、独立分支 completed、整体 NODE_FAILED；`step_failed` 仅一次 |
| H09 | `maxConcurrency=4` 双 human-task，CLI=h1→h2、MCP=h2→h1 | 同一时刻最多一个未满足 wait；rev1/rev2、两步 completed、out-h1/out-h2、两种顺序均完成；CLI 关闭重开恢复同一 runId |
| H10 | 直接两层与间接三层旧嵌套，validate + 运行准入 | 均返回 `NESTED_MANUAL_GATE_UNSUPPORTED`，内部 steps=0；历史版本 fixture 不伪装成当前可发布 |
| H02 processor | CLI/MCP validate → propose → GUI commit → 真实执行 | 持久化 `operation=pick/path=profile.title`，真实输出“雨巷”，nodeRun=success，协调器/子任务 completed |
| H02 video | 真实 connection/definition/binding/save/resolve → seed 预检 | `acceptance.video.custom` 被消费；nodeRun=skipped/当前模型不支持种子参数；本地 HTTP videoSubmit=0；无 out-video |
| H04–H08 | start → 超限 → 材料预览确认 → 采用等待 → 采用确认 → 完成 | `humanDecided=true`；effective manifest 同时含 `human:context` 与 retained JSON；原始大文本被排除；三条命令 committed+真实指纹；下游仅一次；固定资产正确 |
| 重开恢复 | MCP adoption wait 时关闭并重启 | 同一 taskId/waitRevision/adoptionPending/双输出保留；显式 `activateFlowCanvas` 后继续并完成 |

## 3. 真实性与安全边界

- 不复制本机 license/security 或私钥。仅未打包开发构建使用 `CANVAS_LICENSE_DEV_BYPASS=1`，不构成授权验收。
- 参数用例使用 Vite 源码 renderer + 真实构建 main/preload，不冒充打包 renderer 验收。
- `model_validations` 中明确标记为 **TEST SETUP ONLY** 的记录只用于建立测试 fixture，不是供应商验证或业务成功回执。实际模型绑定、解析、执行和提交均由生产路径完成。
- H10 的旧嵌套版本以真实 SQLite fixture 行表示历史数据，当前 validate/execute/run.get/diagnostics 仍全部经生产入口，未把 fixture 当作当前可发布版本。
- 所有外部操作均经过生产 AccessService；报告区分 AccessResponse 的传输 completed 与 task/run 的真实业务终态。
- 输入文件使用 0600 并在退出后删除；MCP/Electron/Vite/HTTP server 和临时目录均有清理路径。报告不包含真实授权材料。
- 未调用真实付费供应商，不证明供应商受理、费用或媒体质量。video seed 的支持能力 gateway 路径由 `capability-params` 单元效果测试覆盖；本 E2E 未单独执行 image-gen featureKey。
- 参数报告保留了一条未归因的 `Failed to fetch` 页面诊断，未宣称“零页面错误”；已断言的 processor/featureKey/seed 事实不依赖该诊断。

## 4. 证据

统一运行器结果：**3/3 批次通过**（证据批次 `2026112616565` 之后的 `2026112618453`）。

- `qa/local-agent-access/composite-remediation-e2e/report.json`：status=passed，CLI/MCP 共 8 场景，restartVerified=true。
- `qa/local-agent-access/capability-params-e2e/report.json`：ok=true；processor 全链与 video featureKey/seed 全链通过。
- `qa/local-agent-access/agent-flow-context-adoption-e2e/report.json`：ok=true，51 项真实检查；CLI/MCP 均完成，MCP 重开后完成。
- 持久化证据已归档至 `docs/local-agent-access/evidence/`，索引同步更新。

补充静态验证：新增脚本 `node --check` 通过；`npm run guard:agent-parity` 三关通过。

## 5. 最终验证

- 完整 Vitest：352 个测试文件通过、2 个跳过；4003 项通过、7 项跳过。
- `npm run typecheck`、`npm run lint`、`npm run verify:specs`、`npm run verify:logging`、`npm run build`、`git diff --check` 全部通过。
- 独立真实性复审确认无剩余高置信 blocker：没有复制真实授权材料，没有用 fake port 或手写回执替代业务执行，重开和 attach 均经过真实实例与命令桥校验。
