# C0 测试运行时（遗留实验）

此目录是保留的 LangGraph 实验/测试夹具，用于覆盖：

- checkpoint 保存与恢复；
- 命令账本与幂等回执；
- 人工等待/继续；
- 单步 SDK 模型适配；
- 隔离 Electron 双进程恢复。

## 边界

- **不是产品入口**：`c0-electron.ts` 只启动隔离测试数据库，不注册生产节点，也不打开产品项目库。
- **不承接新功能**：新的 Agent Flow 行为应进入 `../runtime.ts`、`../coordinator-host.ts` 或正式执行器，不得在本目录扩建第二套产品运行时。
- **保留原因**`test/agent-flow-c0.test.ts` 仍有活跃回归，历史双进程恢复证据见 `docs/canvas-agent-flow/testing/`。删除前必须先迁移这些独有覆盖。
- **运行方式**：`npm run test:agent-flow-c0-unit` 与 `npm run test:agent-flow-c0`。
