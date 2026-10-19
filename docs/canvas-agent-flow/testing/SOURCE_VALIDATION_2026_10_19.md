# 源码阶段功能、日志与可靠性验证

后续同步与终态核对（2026-10-19）：独立90分钟 `run-DJ65bk` 已passed，5401.137秒故障循环、3009批/24072轮，唯一任务/下载/媒体、3进程重开和清理通过；下方“进行中”为当时记录。后续45包完整验证及46/47定向验证、同步前118项复核详见 [统一交接](../HANDOFF_2026_10_19_DIAGNOSTICS_SYNC.md)，不将这些不同源码/范围证据合并为一次最终全量。

日期：2026-10-19（Asia/Shanghai）。源码起点：`bf88134`。

## 范围与判定

按用户确认，先在代码项目运行环境验证功能、日志与可靠性，稳定后才进入安装包测试。本轮不制作安装包，不关闭依赖安装/签名/干净机器条件的发布门禁。源码验证证据与安装包证据分别记录，不降低原主用例的退出条件。

1. 功能：源码浏览器交互门禁、Electron 正式 IPC/存储与 Agent 桌面夹具，覆盖节点指针/键盘、Skill 配置/固定版本、Builder、媒体、导入迁移与能力边界。
2. 日志：核对开始/唯一终态、阶段/安全原因、关联、实际写入脱敏、丢失计数，以及日志失败不改变业务结果。
3. 可靠性：关窗确认/拒绝/不可用/部分接收/超时、保存故障恢复、停止/迟到回包、诊断容量及默认 5400 秒存储压力。

真实中文 IME、人工布局可用性、设备性能阈值、受限磁盘/内存、第二人盲排障、真实供应商与物理掉电保持独立边界，自动化未覆盖的部分不签通过。

| 用户路径 | 本轮源码入口 | 仍需独立验收 |
| --- | --- | --- |
| 节点选中/拖动/编辑/键盘 | optimization-ui 的 pointer、selection、tab 脚本与 node-pointer-policy | 真实中文IME、DPI和人工连续操作 |
| Skill配置与版本 | agent-flow-desktop、collaboration及资产/runtime单测 | 勾选/取消的完整人工用法与绑定哈希逐项核对 |
| Builder预览/提交/重开 | agent-flow-builder、builder-parallel与布局单测 | 窄视口人工布局/可发现性 |
| 固定媒体预览与下游 | video/media-transfer/media-review及浏览器资产脚本 | 媒体全部原生交互组合人工检查；真实供应商质量 |
| 导入迁移 | flow-transfer、db-migrations、transfer-crash-recovery及Electron媒体包夹具 | 支持范围内真实历史项目文件包的UI导入走查 |
| 能力边界提示 | declarations/preflight/target-matrix与Agent/review/状态机控件门禁 | 普通用户对采样审核、状态机与远端停止说明的理解 |
| 保存/停止/恢复/诊断 | 故障单测、R09 renderer、RUN-06、七场景真实关窗、90分钟runner | 真正低资源/设备故障与人工盲排障，不以模拟替代 |

这里记录源码子路径的证据，不把原台账中含人工/安装环境要求的整项直接升级为通过。

## 首轮运行与环境差异

- `qa/verification/run-wMnzRP/`：沙箱运行，lint 与类型检查通过；存储 rename 出现 EPERM、组合恢复初始化失败等，随后停止该轮。不能作为产品回归结论或全量通过。
- `qa/r09-soak/run-GbQWG0/report.json`：沙箱 worker-init 失败、0 轮，cleanupCompleted=true；不是 90 分钟通过。
- 正常本地进程环境复测 `test/c4-combined-recovery.test.ts`：6/6 通过。区分沙箱文件限制与产品错误，不删除原失败证据。
- `qa/verification/run-WRUljD/`：正常环境启动的早期门禁，因随后发现日志漏洞需要修改源码而中止；最终结果只认修复后的独立运行。
- `qa/r09-soak/run-DJ65bk/`：默认 5400 秒正常环境专项，独立进程/隔离数据；结果待终态核对，不提前签通过。

## 本轮发现与修复

### 诊断 IPC 回执不代表整批成功

`diagnosticsReporter.ts` 原来只区分 Promise resolve/reject，忽略 `ok:false`、部分接收与无效回执。因此 diagnostics:event 返回 DIAGNOSTICS_UNAVAILABLE 或接收不足时可能仍报告 dropped=0，导致退出完整性失真。

改为校验成功 envelope 中的整数 accepted（0…批次大小），只将未接收数计入 renderer transport 丢弃；拒绝/无效回执按整批计数。仍不重发、不回滚业务、不阻塞业务等待落盘，不复制错误正文。

### 当前会话误报成历史异常退出

主进程先创建 ended=false 的当前会话，再检查历史未正常结束会话。原检查包含当前会话，首次启动也会发 previous_session_unclean。检查现在显式排除 service.sessionId；历史未结束与损坏记录仍保留。

### 退出时丢失会话版本信息

启动时 session 文件包含 appVersion/platform/arch/Electron 等 env，原 flushOnQuit 重写文件时未保留它们。本轮保留初始化时的环境快照，正常和不完整退出均不丢失，不新增用户配置/正文等字段。诊断 bundle manifest 当前没有直接附上环境快照，仍是后续覆盖缺口；不宣称任意导出包已具备完整版本证据。

## 日志检查模板自查

- 影响：renderer→preload→diagnostics:event 接收回执、真实窗口退出完整性及 app.previous_session_unclean 判定。
- 事件职责：沿用已有 node/workflow/model/project/app 生命周期；不新增重复终态，不改事件 schema。renderer 只统计传输未接收事件，main 保持写盘/队列健康统计。
- 关联：保留原 trace/span/project/node/request/task；本轮不补造丢失事件或旧恢复 trace。
- 失败语义：已接收不等于已写盘；IPC 未确认、拒绝、不可用、部分接收及超时不能把会话标为完整；日志失败不撤销保存成功。
- 隐私：回执仅检查 ok/accepted，不记录返回原文。真实关窗夹具保存含假正文的项目，再扫描 diagnostics 确认正文不泄漏。
- 高频/重试：无逐渲染、逐 token、鼠标轨迹日志；不增加自动重试或重复上报。
- 验证：首组 4 文件 47 项通过，覆盖 service、renderer、executor 与关窗 bridge；新增当前会话排除回归待最终验证。
- 新入口：`npm run test:diagnostics-window-close`，使用源码生产 main/preload + Vite renderer、真实隐藏 BrowserWindow.close；只在独立 bootstrap 注入传输故障，不修改生产主进程关闭逻辑。

最终七场景已纳入 `verify:checks`，证据 `qa/verification/run-8BBmbb/qa/diagnostics-window-close/run-iqbyW3/results.json`：慢确认846ms、拒绝802ms、不可用804ms、部分接收819ms、超时2219ms、诊断写盘EIO 875ms、历史未结束会话831ms。拒绝/不可用的transportDropped=2，部分接收=1；写盘EIO transportDropped=0但main正确保持ended=false。所有场景环境快照保留、项目版本1/正文保持、保存唯一终态和实际诊断脱敏通过。版本保留修复前的六场景结果和EIO夹具首轮失败保留；后者发生在基线保存日志仍在队列时就注入故障，修正为先查询确认保存日志已实际落盘，再注入故障。

## 真实窗口首轮证据

`qa/diagnostics-window-close/run-q2l2EH/results.json` 五场景通过：慢确认 815ms / ended=true；IPC 拒绝 840ms、不可用 782ms、部分接收 761ms 均 ended=false；超时 2177ms / ended=false。五场景保存版本均为1、项目正文保持、保存开始/唯一完成配对、无模型请求，实际诊断正文排除通过。

边界：注入的 node.completed 是明确标注的合成传输探针，不是 Agent 执行事实；业务结果隔离检查使用真实项目保存。不能把该证据升级为“Agent业务终态+诊断写盘失败”的完整 LOG-06 主用例。首次启动时序、bootstrap 模块加载的夹具失败保留在独立 run 目录；修正后等待页面完整加载再计量关闭。

## 最终验证

最终完整 `npm run verify`：`qa/verification/run-8BBmbb/`，北京时间09:15:51–09:40:16，exitCode=0。lint、Node/Web/model类型、192个测试文件2389通过/1既有跳过、model-runtime 2项、日志旁路门禁、19项浏览器脚本、源码生产构建、七场景真实关窗及所有Agent/媒体/R09桌面夹具通过。31份results无显式失败，其中24份桌面结果报告diagnosticRedaction=true；真实关窗7场景与R09保存路径另外各自断言实际诊断脱敏。不能把结果文件数量或单个脱敏字段当作全业务覆盖率。

源码/构建/结果清单：`qa/verification/run-8BBmbb/source-validation-manifest.json`，773个源文件、31个构建文件及31份结果的SHA-256；记录baseline=bf88134及uncommitted=true。该清单是本机源码证据，不是安装包签名。

默认90分钟独立专项仍在运行；最终记录待终态、三进程重开及清理完成后填写，不以当前检查点签通过。

`qa/verification/run-LxajOo/` 在第三项版本信息修复前：192文件2387通过/1跳过、模型2项、日志旁路门禁、19项浏览器脚本与源码构建均已通过，运行至桌面命令阶段后停止。因随后补充会话env保留，不作为最终源码全量门禁通过。

## 停止与迟到回包专项

命令：`node scripts/test-agent-flow-desktop.cjs --agent-run06-fault`，独立 `CANVAS_QA_OUTPUT_ROOT=qa/source-validation-20261019-stop`。

`qa/source-validation-20261019-stop/qa/agent-comprehensive/run-20261017-agent-run06-desktop-fault-v1/results.json`：执行/新进程重开均通过。两次本地合成请求分别覆盖供应商 HTTP 失败和延迟回复；失败任务/节点明确失败，停止任务保持 cancelled，处理器执行与 Agent 成果均为0；重开请求数不增加。延迟回复尝试发生在取消之后，客户端已断开，不宣称客户端消费了完整迟到响应或供应商远端已撤回。两 session 实际诊断脱敏通过。本轮未冻结/测量停止反馈p95，因此不关闭 PER-05 整项。
