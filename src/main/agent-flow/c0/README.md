# C0 测试运行时（保留决策）

## 决策

**保留 `src/main/agent-flow/c0/`、`src/main/agent-flow/c0-electron.ts`、`src/shared/agent-flow/c0-contracts.ts`、`scripts/test-agent-flow-c0*.cjs` 与 `test/agent-flow-c0.test.ts`，定位为测试专用资产；不得删除，不得扩建为第二套产品运行时。**

保留依据：

- [`test/agent-flow-c0.test.ts`](../../../../test/agent-flow-c0.test.ts) 当前有 **16 项活跃测试**，覆盖命令账本去重/冲突/未知结果、checkpoint 原子写入与拒写、人工等待/跨库重开恢复、模型单步协议、诊断失败隔离与私有正文不泄漏。
- [`scripts/test-agent-flow-c0.cjs`](../../../../scripts/test-agent-flow-c0.cjs) 仍由 `npm run test:agent-flow-c0` 调用，使用两个独立 Electron 进程完成 pause/resume；2026-11-26 本次文档收敛复跑通过，`effectCount = 1`、checkpoint 存在、窗口隐藏，本次本地回执位于 `qa/canvas-agent-flow/C0/electron-results.json`（忽略目录，不作为跨 checkout 链接）。
- 历史证据见 [C0 实施记录](../../../../docs/canvas-agent-flow/archive/08-development-ledger.md)、[Agent 测试报告](../../../../docs/canvas-agent-flow/testing/AGENT_TEST_REPORT_2026_10_16.md) 与 [仓库清理盘点](../../../../docs/canvas-agent-flow/audits/repo-cleanup-2026-11-26.md)。直接删除会丢失目前仍由这些断言独立覆盖的恢复与回执边界。

## 边界

- **不是产品入口**：`c0-electron.ts` 只启动隔离测试数据库和隐藏 fixture 窗口，不注册生产节点，不打开产品项目库，也不接入正式 renderer executor。
- **不是生产真值**：C0 的 checkpoint/命令表只服务于实验，不作为正式项目事务或生产副作用恰好一次的证据。
- **不证明真实模型**：单测与双进程 fixture 使用确定性模型；供应商、付费、网络请求均为 0，不能替代真实 GUI、真实供应商或安装包验收。
- **不承接新功能**：新的 Agent Flow 行为应进入 `../runtime.ts`、`../coordinator-host.ts` 或正式执行器；不得在本目录扩建第二套产品运行时。
- **保留独立构建入口**：`electron.vite.config.ts` 中的 `agent-flow-c0` input 与 `package.json` 的两个 `test:agent-flow-c0*` 脚本仍属测试基础设施，不得误删。

## 未来删除条件

只有同时满足以下条件，才可在一个独立变更中删除 C0：

1. 16 项测试中的独有覆盖已迁移到正式运行时测试或 `test/fixtures/`，并有等价或更强断言；无法迁移的覆盖必须明确记录退役理由与替代证据。
2. 双进程 pause/resume 恢复用例已迁移到正式测试入口并持续通过，或已有正式恢复链路覆盖 checkpoint、人工等待与命令回执且旧 fixture 被明确退役。
3. `src/main/agent-flow/c0/`、`c0-electron.ts`、`c0-contracts.ts`、两个 C0 脚本、测试文件、`electron.vite.config.ts` 的 `agent-flow-c0` input、`package.json` 脚本及文档引用均无残留。
4. 删除后 `npm run verify`、`npm run verify:specs` 与 `git diff --check` 通过，且正式 Agent Flow 恢复/回执回归未减少。

## 关于迁移到 `test/fixtures`

现在**不建议实际移动**。这不是单纯改目录：需要同步调整测试导入、`src/shared/agent-flow/c0-contracts.ts` 的归属、Electron 独立构建 input、`out/main/agent-flow-c0.js` 产物名、`package.json` 脚本、Electron-as-Node/native ABI 运行方式及历史证据链接。当前代码已有明确测试专用边界，移动收益低于回归风险；确需整理时，应先完成上述影响清单，再单独提交迁移与验证。

## 运行方式

```bash
npm run test:agent-flow-c0-unit
npm run build
npm run test:agent-flow-c0
```
