# A1.1 桌面项目操作交付台账

日期：2026-10-24。授权：用户确认继续开发A1.1。前包基线见[最小纵向包](05-a0-a1-minimal-delivery.md)。本包不代表全部A1完成。

## 1. 用户路径与支持范围

Agent新建项目 → Agent在桌面打开 → 用户编辑画布 → Agent请求保存或导出 → 等待最新编辑落盘 → 切换项目并重开核对。

| 操作             | 当前实现                                                           | 边界                                                                              |
| ---------------- | ------------------------------------------------------------------ | --------------------------------------------------------------------------------- |
| `project.open`   | 新增；保存当前画布、检查切换准入、打开目标，等待新画布和保存器就绪 | 窗口必须可用；恢复副本、任务占用或保存失败阻断；重复key返回原回执，不强制再次切换 |
| `project.update` | 新增；只开放name                                                   | 必传期望图版本；不接收画布JSON、workspaceProfile或封面修改                        |
| `project.rename` | 保留，与update共享名称提交                                         | 活动画布先保存，再由main版本化提交，renderer确认新版本；关闭项目沿原事务          |
| `project.save`   | 增加活动画布握手                                                   | 不接收外部快照；完成表示保存器确认最新编辑，返回实际图版本                        |
| `project.export` | 增加活动画布先保存                                                 | 锁定握手后版本；受控目录、完整媒体、不覆盖文件规则保留                            |

CLI/MCP共用11项操作。HTTP、导入、复制、删除、节点编辑/执行仍未开放，31类节点仍为planned。

## 2. 使用方式

桌面仍需显式`--local-agent-access`，代理与应用使用相同数据目录。基础配置见[前包运行说明](05-a0-a1-minimal-delivery.md#2-运行方式)。

```powershell
node .\out\main\local-agent.js project open --input-file .\open.json
node .\out\main\local-agent.js project update --input-file .\update.json
node .\out\main\local-agent.js project save --input-file .\save.json
node .\out\main\local-agent.js project export --input-file .\export.json
```

打开输入：`{"input":{"projectId":"真实ID"},"idempotencyKey":"本次新key"}`。

修改名称输入：`{"input":{"projectId":"真实ID","expectedGraphVersion":7,"name":"新名称"},"idempotencyKey":"本次新key"}`。版本通过project.get重读，key通过key命令生成。MCP工具为project_open、project_update，信封沿前包。

活动保存/导出的expectedGraphVersion校验开始时已保存版本；握手保存本地编辑，返回/导出的实际版本可能更高。持续编辑可能在确认后产生新内容，回执只代表该次握手确认时的内容。冲突应重读并核对意图，不盲换key重发。

保存器确认已经提交到画布数据的编辑；节点中尚待“保存文本”或其他确认按钮提交的表单草稿，应先由用户完成编辑。外部保存不会替用户确认表单或执行人工门禁，不能把仍停留在控件本地草稿中的内容宣称为已持久化。

## 3. 准入、恢复与兼容

- main等待前登记pending；同key不重复执行。等待期间串行化外部副作用，读取仍可进行。pending重复返回unknown，最终提交后返回原事实。
- 握手仅接收当前窗口main frame、匹配requestId/projectId且未过期回执。10秒超时、renderer丢失或无法确认切换/提交结果保守unknown；不自动重放。迟到回执不能授权新操作，迟到元数据提交拒绝。
- 切换先保存当前画布，保存后再次检查当前项目、恢复副本和任务占用；新画布须有新editor与保存器。挂载失败时main占用对齐仍显示的项目。不绕过恢复副本人工选择。
- 活动名称修改经保存后请求绑定的main回调提交，检查名称竞争、图版本、任务及恢复占用；renderer接收新版本才确认。提交后失去确认保留unknown。
- 兼容：open/update为v1增量；原save/rename/export字段不删不收紧，新增活动画布行为。旧客户端可继续用关闭项目路径；活动路径最终版本允许高于输入。未恢复历史headless协议。
- 单次回执不承诺之后编辑已保存；物理断电原子性、自动unknown核对、跨账户ACL、第三方MCP客户端仍未验收。

## 4. 日志与接入影响检查

范围：Registry、main服务/桌面桥、preload白名单、App/CanvasPage/CanvasEditor、开发mock及测试。未修改节点契约、执行器、模型、端口或指针呈现。

复用agent.access.started及唯一completed/failed/unknown/rejected终态，main公共服务负责；握手失败阶段desktop-handshake，保存/导出/回执保留各自阶段。renderer保存沿project.save诊断，是实际子保存事务，不重复外部终态；当前子保存未新增跨层父span映射，不宣称完整trace树。就绪轮询不逐次记录。

临时消息使用requestId与10秒有效期；名称仅为业务数据，不入诊断。事件不记录名称、正文、快照、路径、key、token或原始错误。logger拒写不改变结果；账本受理拒写阻止副作用。实际JSONL检查生命周期配对及脱敏。

影响：新增操作、活动项目支持、异步Dispatcher，Schema/工具目录/快照同步。桌面桥及preload/renderer/保存协调路径纳入源码影响门禁；门禁仍是登记、生成一致性和人工影响确认，不宣称完整语义兼容自动判定。

## 5. 验证记录

定向40/40通过：接入22、原重命名IPC3、桌面桥4、监听占用3、保存协调器8。覆盖flush、名称提交及版本回读、正文导出、旧版本拒绝、占用变化、并发副作用、pending重试、超时不重放、sender/frame/项目匹配、迟到提交、renderer丢失及等待后新增恢复副本阻断切换。

初轮源码真实桌面闭环通过：CLI创建/打开、MCP活动名称更新、CLI活动保存、冻结自动保存计时后编辑并立即导出、切换与重开保留内容、重启回执及实际JSONL脱敏。隔离临时目录，无真实项目、密钥、供应商或收费模型；TEST窗口在finally关闭、清理。

补强后桌面复验暴露原防抖保存计时器在外部保存完成后继续触发，导致版本再次推进、紧随导出被正确拒绝。已在活动画布握手开始时清理该防抖计时器，保留严格版本校验；最新构建的完整桌面闭环复验通过，证据`qa/local-agent-access/vertical-slice/report.json`。类型检查、lint、日志及接入门禁通过，103个本地文档引用无断链。

首轮完整验证`qa/verification/run-k88Qrz/`退出1：单元2493通过/5既有跳过、模型另2、日志/接入及浏览器门禁、构建均通过；接入验收的Playwright clock.pauseAt将稍早构造的当前时间判为过去时间，测试设置阶段失败。改为从一分钟前安装时钟、快进至预先捕获时间再暂停，业务断言不变；单独源码闭环复验通过。

第二轮`qa/verification/run-KLDwsG/`同样完成单元、模型、日志/接入、浏览器和构建，退出1于Playwright页面截图超时（字体加载完成后未取得图像），尚未进入后续活动编辑断言。改用Electron原生webContents.capturePage，不移除业务断言；独立源码闭环连续两轮通过，截图人工检查名称和文本均正确，第二轮证据位于`qa/local-agent-access/a11-recheck/qa/local-agent-access/vertical-slice/`。

完整验证经历三轮收尾：`run-whOIIM`在agent-flow-coordination阶段随原会话进程终止而中断，无最终结论，已如实登记为interrupted，此前各段通过不延伸为整轮结论；`run-fGy8iz`退出1于`recovery-contention`跨进程恢复竞争偶发（杀锁后两个并发恢复进程同时失败，其一透出未包装的Sqlite busy错误；同源码当日三轮完整验证与隔离复跑4次15/15均通过，历史verify日志无该用例失败，判定为载荷敏感竞争窗口而非回归，复现时应修复竞争路径、不以重跑掩盖）。最终`qa/verification/run-v3mcD2/`完整通过（退出0）：单元2493通过/5既有跳过、模型2、类型/lint/日志/接入/浏览器门禁、构建、接入桌面验收、全部桌面专项及R09通过。

基于该run源码的独立目录包`dist/local-agent-access-a11-20261024/win-unpacked/`构建并通过安装版真实CLI/MCP闭环，入口哈希与源码构建一致、官方MCP SDK 1.32.1及依赖随包，证据`qa/local-agent-access/a11-package-manifest.json`与`a11-package/installed-vertical-slice/`；未做安装器发布与签名。A1.1验收范围（桌面打开、名称更新、活动保存/导出）就此关闭；复制、删除、节点编辑/执行与HTTP仍按计划推进。
