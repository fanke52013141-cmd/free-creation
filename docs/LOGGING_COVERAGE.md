# 日志覆盖清单

这是开发与审查用的持续维护清单，不是运行时生成的覆盖统计。依据[日志规范](../LOGGING_SPEC.md)。

状态：`基础`=有公共阶段或零散日志；`部分`=有专门诊断但缺全链路；`待接入`=目标结构化事件尚无充分证据；`已验收`=提供运行/测试证据后才可使用。源码审阅不等于行为测试通过。

核查日期：2026-10-04，基线2e58e09。本轮未跑业务日志故障测试，以下不标“已验收”。

| 业务域 | 已有入口/证据 | 状态 | 待补内容 | 实施责任与任务 |
| --- | --- | --- | --- | --- |
| 公共节点执行 | renderer/engine/executor.ts、runRecord.ts；test/runRecord.test.ts存在 | 部分 | 独立记录、执行实例ID、稳定事件和唯一终态契约 | 执行器维护者，L01/L02 |
| 流程/迭代 | executor.ts内runId、itemRunId；run-index.ts | 基础 | 根/子trace、item对应、取消/重跑关联 | 流程维护者，L03/L04 |
| AI对话/AI处理 | shared/engine/executors/chat.ts、aiProcess.ts及公共执行器 | 基础 | 请求ID、首片/流中断、模型请求与节点关联 | 文本网关维护者，L03 |
| 生图/图像编辑 | main/gateway/image.ts有部分提交/task日志；公共执行器 | 部分 | 所有适配器统一、下载/写盘分阶段、请求ID | 图像网关维护者，L03/L04 |
| 长视频 | main/gateway/video.ts已有任务库/恢复/重试 | 部分 | 恢复父子关联、轮询摘要、远端成功与落盘分开 | 视频任务维护者，L04 |
| 语音克隆 | shared/engine/executors/tts.ts、main/media/tts-transform.ts、media.ipc.ts | 部分 | 接统一schema、错误脱敏/重复归并、独立存储 | 音频维护者，L04 |
| 通用配音/音色设计 | 公共执行器；相关gateway/media入口 | 基础 | 实际请求与产物落盘完整链 | 音频维护者，L04 |
| 本地媒体与导演输出 | 公共执行器；main/media、media.repo.ts | 基础 | 外部进程/文件写入错误规范、媒体ID关联 | 媒体维护者，L04 |
| 代码Worker | renderer/engine/codeRuntime.ts及公共执行器 | 基础 | 超时/退出/诊断桥接，禁止记录源码 | Worker维护者，L04 |
| 项目保存/冲突/恢复 | CanvasEditor.tsx有console错误；项目仓库/IPC已有业务错误返回 | 待接入 | 独立操作ID、版本、检查点/回滚、linkedTraceIds | 持久化维护者，L04 |
| 项目导入导出 | 项目IPC与仓库事务；启动workspace健康摘要 | 基础 | 导入阶段/事务/回滚完整事件，路径去标识 | 持久化维护者，L04 |
| 素材库 | library.ipc.ts及library仓库有业务接口 | 待接入 | 修订、材料化、分类操作失败/回滚 | 素材库维护者，L04 |
| 模型连接/能力验证 | model-contracts可选requestId；main/model-host、models.ipc.ts | 基础 | 配置变化安全摘要、验证关联与归一化错误 | 模型目录维护者，L04 |
| 应用生命周期 | main/index.ts的electron-log启动/健康检查 | 部分 | 非正常退出标记、可用崩溃事件、flush/健康状态 | 桌面底座维护者，L02/L04 |
| 日志文件/独立事件 | main.log存在，electron-log默认轮转 | 部分 | 项目级保留限额、JSONL、队列/故障、自诊断 | 诊断底座维护者，L02 |
| 查询/导出 | run-index.ts、CanvasSidePanel.tsx、diagnostics.ipc.ts | 部分 | 全流程时间线、范围导出、manifest/不完整说明 | 诊断UI维护者，L05 |
| 自动日志门禁 | CI已有通用测试，尚无新规范专门拦截器 | 待接入 | 字段/schema/旁路/变更影响检查 | 工程门禁维护者，L06 |

路径缩写分别相对src/renderer/src、src/shared或src/main；正式修改记录应给出具体文件和函数。

## 每次变更如何更新

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
