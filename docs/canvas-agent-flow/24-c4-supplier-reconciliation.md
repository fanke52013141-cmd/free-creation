# C4 供应商事实核对、停止边界与 unknown 裁决

日期：2026-10-14。接续 [保存强杀包](23-c4-main-save-crash-recovery.md)。本包接已有视频任务公共 IPC/执行路径，不开放媒体 Agent 调度，不把同步流式请求改成异步任务。

## 用户路径

1. 提交/在途视频遇到网络、超时或协议错误，保存为 unknown，同节点继续占用，不能新计费提交。
2. 保留原供应商、模型、提示及素材配置，再次执行返回原 taskId，只查询原任务；改输入/模型/供应商明确拒绝。
3. 官方 Ark 的持久远端 ID、提交连接与密钥指纹一致才查询；响应 ID 必须相同。查询途中连接、密钥或任务输入变化也不应用结果。
4. 可信成功结果下载入库；同进程并发核对共用 promise，已入库媒体可复用。明确 failed/cancelled 才释放占用；queued/running、404、未知结构或成功无地址都不允许重新提交。
5. 停止先持久 cancelRequested，并停止旧执行。查询/下载迟到成功不发布；重开不自动继续。原输入明确再次执行才清除停止意图并接回原任务。停止发生在入库期间时保留媒体引用、状态 unknown，不发完成事件，后续明确恢复可复用引用。

## 供应商及撤回边界

[官方 Ark 文档](https://docs.volcengine.com/docs/ark/cancel-or-delete-video-generation-tasks-api)规定 queued 可以取消，running 不支持，succeeded/failed/expired 的 DELETE 会删除记录。GET 与 DELETE 之间状态可变化，没有文档化原子条件取消参数。**本包不自动调用 DELETE**，本地停止后只核对事实；仅同任务 GET 明确 cancelled 才登记远端已取消。本地停止或 HTTP 接受不代表撤回完成。

[GLM5 网关文档](https://glm5.app/api/docs/chat-completions)有独立 request 查询/cancel，但不是当前使用的智谱官方端点。当前 Agent 走[智谱同步 chat/completions](https://docs.bigmodel.cn/api-reference/模型-api/对话补全)，没有已持久化可信异步身份，不能只凭模型名称套用别家协议。

trusted control 限 `https://ark.cn-beijing.volces.com/api/v3` Seedance 协议，严格任务 ID 校验并拒绝重定向。MiniMax、任意中转、缺少提交连接/密钥指纹的旧记录、丢失远端 ID 保持 unknown，不盲查或批量搜索。原在途轮询兼容保留，新任务新增密钥漂移阻断，历史 failed/cancelled 不倒推改写。未知占用可能需供应商控制台核对，不提供无证据强制释放。

本包交付可信查询、未知结果保护、持久停止和撤回支持边界，**没有交付自动远端撤回**，没有宣称全部供应商或全部 C4 完成。

## 验证与日志

- 最终五文件 47 项定向通过，新增恢复测试 27 项，证据 `qa/c4-supplier-20261014/directed-final.log`。包含真实本地 HTTP transport + 真实 SQLite 的查询/诊断配对；其余供应商响应为 fixture，没有真实计费/撤回请求或个人凭据。
- 覆盖身份/连接/密钥前后漂移、404/断网/无 ID/旧记录/未知状态、同输入接回/变更拒绝、查询合并/下载一次、查询/下载迟到停止、重开停止、logger 故障。正文/Key/媒体 URL 排除，控制 started/completed 同 trace 唯一配对通过。
- 新增 `task.control.started/completed`，main/video.ts 的控制操作拥有唯一生命周期，固定 operation/state + task/trace；网络子模块不记录原响应或重复终态，日志门禁 allowlist 登记职责及测试。媒体沿原公共事件，unknown 不记业务成功，供应商终态不代替画布成果事实。
- 全量首轮在日志门禁失败：子模块由调用者统一诊断但未登记；修复职责声明后续门禁结果追加下方，保留失败记录，不冒称首轮全量串行成功。
- 分段门禁全部通过：首轮 `verify.log` 中 lint、两端/模型类型、166 文件/1795 项/1 既有跳过、模型另 2 通过；职责登记后 `remaining-gates.log` 退出码 0，含日志门禁、17 浏览器、生产构建及资产/命令/专业/协作/协调/建图/审核/三类返工/恢复共 11 组隐藏桌面路径。最后增补四条边界测试及恢复诊断修正，另过最终 47 定向、两端类型及 main 增量类型，证据 `typecheck-final.log`、`typecheck-incremental.log`。不将后增测试算作首轮全量覆盖。
- 五轴复核：未知不释放计费占用，停止持久/迟到隔离；有限端点/身份、无重定向/新增依赖/业务重试；请求有界、同任务合并。未改节点端口或 UI，只有真实产物才输出。原视频文件较大，本包把协议传输隔离到 video-task-control.ts，继续沿现有任务/媒体仓库协调，未建立第二套任务事实。
- 最终增量 lint、日志门禁和生产构建退出码 0，证据 `lint-final.log`、`logging-final.log`、`build-final.log`。门禁生成的受跟踪 QA 图/报告已恢复。沿用既有 Electron-as-Node/native ABI 和本机 Chromium QA 适配，未重编译个人 native 模块，未改个人模型目录/凭据；证据在忽略的 QA 目录。源码未提交/推送。

## 后续

优先验证有专用撤回接口或原子条件取消语义的供应商，再接持久请求身份/结果恢复；无能力时保持 unknown。Ark 混合 DELETE 必须先解决终态误删除竞争。

未覆盖真实计费/撤回、同步 Agent 远端身份、媒体 Agent 自动调度、跨进程同时核对、下载/入库/任务更新间强杀的资产幂等、掉电、长期故障及任意中转。已入库但 task 更新前崩溃仍需跨存储后续验收。本包只保证存活进程合并/迟到保护。源码未提交/推送，安装包未更新。
