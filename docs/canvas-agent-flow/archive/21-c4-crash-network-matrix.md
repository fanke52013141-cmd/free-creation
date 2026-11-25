# C4 强杀、断网与未知结果矩阵

日期：2026-10-14。范围：确定性命令的 JSON 文件/SQLite WAL 边界与断网后不重派。使用隔离进程真实强杀，生产账本、资产事务和工具适配器不增加故障开关。现有实现通过本批验证，无需修改生产执行路径。

画布路径继续沿用 C4：重开 → 核对执行事实 → 保存事实完整则恢复实际回执；否则 unknown 保持占用 → 明确继续或补呈现。不能以日志缺失或模型文字裁决远端成功。首批桌面真实按钮/IPC 路径证据仍见 [C4 首批](20-c4-recovery-transfer.md)。本包新增的是存储和网络故障证据，不重复声称验收了新桌面能力。

## 实际故障注入

`test/agent-flow-crash-recovery.test.ts` 编译隔离 worker；每个案例创建新临时目录和文件 SQLite，WAL + FULL 同步。worker 在边界通过同步标记通知父进程后阻塞，父进程强制终止；不运行 close/finally。随后在新进程重开，按公共账本保存事实核对，再用第三进程重复核对。项目正文和效果计数只在隔离目录，退出清理；无可见窗口、无个人模型目录或付费请求。

| 强杀边界 | 核对结果 | 下游/重派约束 |
| --- | --- | --- |
| grant 已持久、尚未 admission | unknown | 无效果，仍保守占用，不擅自重派 |
| admission 已记录、尚无效果 | unknown | 无效果，不能仅据计数宣称未发生 |
| 效果发生、项目事实未保存 | unknown | 已有一次效果，没有可信回执，禁止第二次 |
| 成功运行/输出已保存、回执未提交 | committed | 固定版本一次，恢复不执行业务 |
| 失败、取消、跳过事实已保存 | failed/cancelled/skipped | 对应终态，无输出版本，不重复业务 |
| 保存输入指纹被篡改 | unknown | FLOW_SAVED_INPUT_MISMATCH，不伪造成功 |
| 保存后配置语义版本改变 | unknown | FLOW_REVISION_CONFLICT，不迁移旧结果到新配置 |
| 资产插入后、回执 UPDATE 前事务中 | committed（核对后） | 重开先观察到零目标资产与 pending，证明事务回滚；核对后仅一个版本 |
| 回执及资产提交完成后 | committed | 重复核对保持同回执、同引用、同版本数量 |

事务中断由测试数据库 TEMP TRIGGER 调用同步阻塞函数实现；不修改业务实现，也不在生产增加可调用的崩溃入口。所有强杀案例在核对前检查目标资产数量和回执状态，避免用核对后的成功掩盖事务残留。

网络案例用随机端口的本地 HTTP 故障服务：收到 POST 即记录接受和一次效果，然后断开连接，不返回回执。生产 `createLedgerToolPort` 得到 unknown；相同命令再次调用只返回已有回执，deliver 和接受计数仍为 1。没有保存的 matching nodeRun 时核对拒绝、节点保持占用、资产为空。这验证接受后回包丢失的保守行为；不是供应商任务查询或远端撤回。

## 验证与日志自查

- 12 项故障测试；配合 command-ledger、command-executor、coordinator 共 61 项定向两轮通过，见 `qa/c4-fault-matrix-20261014/directed-final.log`、`verified.log`。最终文件 lint 和日志门禁通过，见 `lint.log`、`logging.log`。目录约束和清理保护在最终复验中生效。
- 测试自动纳入现有 `npm run test`，无需添加生产入口。复跑命令：`vitest run test/agent-flow-crash-recovery.test.ts`；本机使用既有匹配 native ABI 的 Electron-as-Node QA 入口。
- 日志影响：仅增加测试与文档，不改运行、请求、保存或诊断行为。生产恢复复用 command.operation、command.recovered、agent.desktop/coordination，已有桌面生命周期与脱敏证据保留；没有为 fixture 补假业务日志。
- 失败证据：只输出固定边界、状态、代码、计数与回执身份；不输出私有输入、模型正文、密钥或原始 stderr。无法观察的强杀终态不补造，业务权威仍是存储事实。测试服务和子进程均有终止/清理上限。
- logger 故障非致命与桌面真实诊断脱敏沿用首批已验收公共入口，本包不声称新增验证完整崩溃日志时间线。

## 保留边界与下一步

这是进程强杀而非物理掉电；效果计数与项目 JSON 保存是 fixture，生产账本/资产/工具适配器真实运行，未覆盖真实 renderer 在每个保存阶段崩溃。未验证供应商任务查询/撤回、人工未知副作用强制裁决、模型决策在途完整恢复、导入目录 rename/事务的真实强杀、磁盘损坏、长期多次故障及媒体/并行任务。

下一步优先补项目导入目录与数据库事务的强杀恢复、真实 renderer 保存中断；对没有可信远端查询能力的结果继续保持 unknown。不得为清除占用而新增“按用户口述成功”或自动重新执行。
