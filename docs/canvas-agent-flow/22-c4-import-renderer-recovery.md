# C4 导入强杀与 renderer 保存中断

日期：2026-10-14。范围：真实项目导入函数的文件/SQLite 强杀，以及真实隐藏 Electron renderer 在保存 IPC 边界崩溃。没有新增模型请求、媒体调度或远端成功裁决。

## 用户路径与修复

导入尚未提交时，重开不会出现不完整项目；临时目录移到 `.recovery`，已转正但无数据库记录的目录保留并上报。已提交项目正常打开，固定资产仍可读。修复启动扫描遗漏的“完整目录未入库”报告，新增 `unlistedProjectIds`，与“有数据库记录但缺文件”的 `orphanedProjectIds` 分开。使用全部已知项目 ID 排除已删除项目的保留目录，不自动导入或删除用户文件。

`.recovery` 目录创建受阻时保留 staging 并计入未处理项，不中断启动。受影响启动日志改用 `workspace.recovery` 开始/唯一终态，只记四类数量；不再将含绝对路径的原始 health 对象写入日志。完成表示扫描结束，不代表异常已全部修复。

renderer 崩溃后重开画布，按 main 保存事实恢复内容与 graphVersion，随后可继续编辑、通过公共保存 IPC 保存。测试不会运行 beforeunload，不伪造关窗恢复副本。

## 故障与证据

| 边界 | 实际结果 |
| --- | --- |
| 导入 staging 项目文件写完后强杀 | 项目不入列表；目录移入 recovery，内容保留 |
| 目录转正后、数据库事务前强杀 | 项目不入列表；完整未入库目录上报并保留 |
| 项目/资产插入事务中强杀 | 新项目与资产均回滚；完整未入库目录上报 |
| 事务已提交后强杀 | 项目和一个固定版本正常读取；重复启动不复制资产 |
| renderer 修改后、保存尚未发出即崩溃 | 0 次新保存，旧内容与版本保留 |
| main 已接受、保存尚未执行时 renderer 崩溃 | main 完成该次保存，新 renderer 读取新内容；无重复提交 |
| 保存已提交、IPC 回包前 renderer 崩溃 | 保存事实保留一次，重开读取新内容 |
| 写入失败后 renderer 崩溃 | 原内容与版本保留，失败诊断存在，重开后仍可保存 |

导入使用真实 export/import、项目仓库、不可变资产和文件 SQLite WAL；fs hook 与 SQLite TEMP TRIGGER 仅存在于隔离测试 worker。父进程等待同步切点标记后强杀，不运行 worker 清理；随后两次独立进程恢复，先检查数据库回滚事实。不是物理掉电。

renderer 使用真实画布、preload、生产 project.save handler、项目仓库与保存协调器，`forcefullyCrashRenderer` 的实际退出原因为 crashed。验收宿主只在保存前/后暂停回应或注入文件写失败；所有窗口隐藏且项目命名标识测试。无生产故障开关。重开后检查内容、版本与继续编辑保存。

29 项定向最终通过（导入强杀 4、health 5、固定迁移 5、既有迁移 7、保存协调器 8）；两端类型检查、增量 lint、日志门禁、生产构建通过。真实 renderer 四组验收全部通过，保存 started/terminal 配对与私有正文排除通过；无模型请求。证据：`qa/c4-import-renderer-20261014/directed-final.log`、`typecheck-final.log`、`lint-verified.log`、`logging-verified.log`、`desktop-fixed.log`、`renderer/results.json`。

首轮测试等待销毁 renderer 的 JavaScript 回应超时，清理遇到数据库锁；修正为等待进程退出事件、清理短重试后通过。首轮失败日志保留，业务断言未放宽。成功轮临时目录/窗口已清理；首轮残留 `canvas-save-crash-zWh430` 的人工清理被自动审批策略阻止，仍留在系统临时目录，未访问个人项目或凭据。

## 日志模板自查与边界

- 影响：workspace 启动检查新增安全生命周期与未入库目录报告；导入/保存仍复用原始公共事件，不重复业务终态。
- 关联：每次检查新 trace/span；允许字段为 recoveredImportCount、unlistedProjectCount、missingProjectCount、temporaryFileCount，失败固定 phase/code。不记录路径、标题、材料、配置、Key 或原始错误。
- 失败：恢复目录受阻不阻断启动，保留临时目录；logger 抛错不改变检查结果，单元验证。实际 renderer 保存失败与脱敏验收通过。
- 高频：仅启动检查，非轮询；强杀终态不可观察时不补造。仅配对正常结束宿主中的保存事件，不宣称崩溃日志时间线完整。
- 本轮未重跑全量 verify；定向、类型/lint/日志、构建和新增桌面路径已验证。既有 C4 其他阶段证据保留，不能称本轮全量串行通过。
- 未覆盖：物理掉电、main 在每个 JSON 保存 rename 阶段强杀、磁盘损坏、供应商查询/撤回、媒体/并行、长期故障组合与完整 trace 树。下一步优先 main 保存文件轮转的强杀和 stale-lock 恢复；无法查询的远端结果继续 unknown。

源码未 commit/push；安装包与快捷方式未更新。
