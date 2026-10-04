# 日志覆盖清单

这是开发与审查用的持续维护清单，不是运行时生成的覆盖统计。依据[日志规范](../LOGGING_SPEC.md)。

状态：`基础`=有公共阶段或零散日志；`部分`=有专门诊断但缺全链路；`待接入`=目标结构化事件尚无充分证据；`已验收`=提供运行/测试证据后才可使用。源码审阅不等于行为测试通过。

核查日期：2026-10-04（L01–L06 实施轮，基于 5085dc8 工作区）。“已验收”仅覆盖有自动化测试证据的路径；
未列出的失败场景与真机验收边界见每行“待补内容”，不得整行虚报完成。

| 业务域 | 已有入口/证据 | 状态 | 待补内容 | 实施责任与任务 |
| --- | --- | --- | --- | --- |
| 公共节点执行 | shared/observability schema v1+注册表；executor.ts 注入 traceId/nodeExecutionId、node.started/唯一终态事件；test/observability/executor-events.test.ts（A01/A02/A15） | 已验收 | runNodeTest 仍不产生运行记录（有意，登记为不涉及） | 执行器维护者，L01 |
| 流程/迭代 | workflow.started/completed/failed/cancelled 事件；迭代批次 batchId/itemId 随节点事件携带；run-index.ts | 已验收 | item 级部分失败聚合事件（A10 的 100 项基线未跑） | 流程维护者，L04 |
| AI对话/AI处理 | main/gateway/chat.ts 发 model.request.started/first_chunk/completed/failed/cancelled；执行器传 requestId+capability 阶段；test/observability/gateway-chain.test.ts（A04/A05/A06） | 已验收 | 真机流式验收未跑（pnpm model:smoke:text 待记录） | 文本网关维护者，L03 |
| 生图/图像编辑 | main/gateway/image.ts 入口 started/completed/failed + TOAPIS accepted/task.state_changed/poll_summary/download/persist 分阶段；gateway-chain.test.ts（A04/A07） | 已验收 | openai-images/openrouter 驱动只有入口级事件；真机未跑 | 图像网关维护者，L03/L04 |
| 长视频 | main/gateway/video.ts 提交/accepted/state_changed/poll_summary/下载/入库/恢复全链事件；429 attempt_failed+retry_scheduled（同 requestId 递增 attempt）；video-diagnostics.test.ts（A03/A09） | 已验收 | MiniMax 适配真机验收未跑；恢复决策 drift 场景未专项测试 | 视频任务维护者，L04 |
| 语音克隆 | main/media/tts-transform.ts report() 改走统一事件（node.stage+phase，私有值脱敏透传） | 已验收 | 独立失败注入测试未建（复用 gateway-events 脱敏测试） | 音频维护者，L04 |
| 通用配音/音色设计 | AudioGenerateInput 已带 diagnostics 上下文字段；gateway 入口级事件未接入 | 基础 | speech/voice 网关入口事件 + 执行器阶段 | 音频维护者，L04 待办 |
| 本地媒体与导演输出 | 公共执行器终态事件已覆盖失败；media.repo 写盘失败经 node.failed 传播 | 基础 | 外部进程退出码/信号专项事件 | 媒体维护者，L04 待办 |
| 代码Worker | 执行器公共终态事件覆盖超时/异常；源码禁记由白名单序列化保证 | 基础 | worker 退出码专项事件 | Worker维护者，L04 待办 |
| 项目保存/冲突/恢复 | main/ipc/project.ipc.ts save：project.save.started/completed/conflict/failed；test/db-migrations 侧无；导入导出 transfer.started/validated/committed/failed | 已验收 | restore 回滚专项事件（恢复副本功能并行开发中，待其落地后接事件） | 持久化维护者，L04 |
| 项目导入导出 | 同上 transfer.* 事件（导出/导入） | 已验收 | 结构导出 exportStructure 未接 | 持久化维护者，L04 待办 |
| 素材库 | main/ipc/library.ipc.ts：revision_published/materialization_completed/failed/mutation_failed | 已验收 | 分类操作失败事件未接 | 素材库维护者，L04 |
| 模型连接/能力验证 | main/ipc/models.ipc.ts validate：configuration.validation_completed/failed（connectionId/modelId） | 已验收 | 迁移 migration_* 事件未接 | 模型目录维护者，L04 待办 |
| 应用生命周期 | main/index.ts：session_started/ended/previous_session_unclean/process_exited（render-process-gone）；before-quit flush≤2s | 已验收 | 主进程自身崩溃（crash dump）事件未接 | 桌面底座维护者，L02/L04 |
| 日志文件/独立事件 | src/main/diagnostics：有界队列(2048/8MiB+128关键预留)、session 分片 JSONL（按天/10MiB 轮转）、14d/200MiB/错误配额 20MiB/硬上限 256MiB 保留、健康计数+事件环；diagnostics-storage.test.ts（A12/A13/A14） | 已验收 | 慢盘时延专项未测（注入为拒写/满盘） | 诊断底座维护者，L02 |
| 查询/导出 | diagnostics:query/health/export-bundle IPC；RunsPanel 流程时间线+导出诊断包；导出 manifest/events/summary/coverage、25MiB 截断、原子写、二次脱敏（diagnostics-storage.test.ts L05 用例） | 已验收 | 项目保存/恢复范围的导出入口未单列 | 诊断UI维护者，L05 |
| 自动日志门禁 | scripts/check-logging-bypass.mjs（增量 console/electron-log 旁路 + 新文件网络调用缺诊断接入）；scripts/logging-allowlist.json；test/observability/logging-gate.test.ts（A17/A18）；npm run verify 与 CI 已接入 verify:logging | 已验收 | 变更影响声明（logging-impact 机器可读匹配）未建，靠门禁规则兜底 | 工程门禁维护者，L06 |

路径缩写分别相对src/renderer/src、src/shared或src/main；正式修改记录应给出具体文件和函数。

## 每次变更如何更新

### 2026-10-04 恢复安全补强

历史版本恢复由 renderer/canvas/snapshot-restore.ts 编排，CanvasSidePanel.tsx 接入统一 producer/reporter。
注册 project.restore.cancelled，并复用 started/checkpoint_created/completed/failed/rollback_completed/rollback_failed；同一操作携带 projectId、traceId、spanId、phase，失败仅记录标准错误码，不写版本正文或原始异常。
snapshot-restore-guard.test.ts 20 例覆盖预检失败、确认取消、内容/项目变化、检查点失败、应用及回滚失败和日志失败不影响业务。该证据不等于真机日志落盘验收；恢复范围导出入口及真实桌面复验仍待补。

1. 修改已有业务域时更新该行，新增业务域新增行；不能仅更新本文件日期。
2. 记录新事件/当前阶段日志、上下文传播、失败场景、测试命令与结果。
3. 所有者用实际实现者或模块角色，不虚构人员；关闭“待补”必须附证据。
4. 一次改动可只迁移受影响路径，其他路径列明尚未覆盖；禁止整行虚报已完成。
5. 无影响变更在PR说明即可，不必为了颜色/文案给本表新增业务域。

## 变更验收记录模板

```text
日期 / 提交或工作区标识：
业务域 / 实现者或角色：
新增或复用的事件 / trace阶段：
开始与终态记录的拥有者：
project/run/node/request/task关联范围：
成功/失败/取消/重试/恢复适用用例：
脱敏、拒写和日志失败不影响业务的证据：
测试命令 / 结果 / 样例文件：
未覆盖路径 / 后续任务 / 计划完成阶段：
审查结论：
```
