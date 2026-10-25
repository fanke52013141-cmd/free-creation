# 本地编辑执行、恢复与诊断接续

日期：2026-10-24。用户授权继续“编辑与执行一致性 → 异常恢复 → 诊断排障”。按[本地功能计划](LOCAL_FUNCTION_DEVELOPMENT_2026_10_24.md)验收实际缺口，不要求安装第三方客户端。

## 交付范围

1. **L2固定结果与执行一致**：`projectNodeOutputs`本已优先返回用户固定输出；单节点运行的`seedPersistedOutputs`额外检查最近一次运行状态，导致固定上游在失败/取消/未结束重试后被静音。移除重复闸门，由统一投影决定document/run/pinned可见性，仍经端口输出契约校验。解除固定后，失败运行仍不提供旧结果；不自动重跑上游、不新发供应商请求。
2. **L3恢复核对真实内容**：历史恢复原先只比较node-card的ID集合，同ID正文/配置/媒体改变、丢边/错端口仍可能报成功。恢复后现在比较已迁移文档记录的稳定序列化（shape/binding/asset），忽略session状态和对象键顺序。内容不符抛安全固定错误，进入原有恢复事务的检查点回滚；回滚同样验证内容。文件事务与远端任务账本不变。
3. **L4诊断不完整仍可排查**：运行中心时间线此前忽略`truncated`，有坏行时隐藏全部有效事件。抽取原时间线为独立组件，显示前200条截断/坏行警告的同时保留有效事件；读取失败/无覆盖仍明确提示，不称成功。React以文本显示消息，不执行日志内容。未改日志采集、保留、ZIP格式或增加新日志。

## 用户路径与证据

- 修复前：新增固定结果三状态测试均失败；恢复正文/配置/媒体/绑定/端口五场景及回滚测试均复现“未抛错/误报restored”。
- 定向：`npm test -- test/observability/diagnostics-storage.test.ts test/snapshot-restore-guard.test.ts test/run-timeline.test.ts test/freshness.test.ts test/observability/executor-events.test.ts test/agent-flow-command-executor.test.ts`，6文件90项通过。本轮新增12项（固定结果3、恢复7、时间线2），其余为现有回归。
- 真实renderer画布：`scripts/test-browser-local-consistency.cjs`通过。文本→处理→代码Worker全图执行，编辑文本后选区依赖闭包执行，固定处理中间输出并写JSON快照后实际加载重开，下游单节点读取固定结果；注入同ID正文恢复错误后实际tldraw回滚并验证原文档；实际RunTimeline显示坏行/截断与有效事件。上游重跑确认在该隔离夹具中代答，生产确认门禁保留；不冒充人工点击全流程。
- 浏览器截图和报告：`qa/local-reliability/edit-restore-diagnostics/`。截图已查看；时间线覆盖采用隔离查询回执，持久诊断ZIP由25项服务测试覆盖，不将这张截图称为实际坏盘测试。
- 类型检查与lint通过。完整`qa/verification/run-6ttY65`运行中，已过2541项单元/5项既有跳过、模型2项、日志/接入/浏览器门禁与生产构建；最终退出码待结束追加。Skill基线同步发生于该轮早期，随后补跑最终node/web类型检查；仅测试夹具随机端口变更在其桌面专项启动前补构建，后续桌面实际使用新入口，不将较早类型/构建输出冒充最终测试夹具验证。

## 日志、接入与兼容检查

- L2复用node/workflow公共开始/唯一终态及输入校验；不新增日志副本、用户内容或固定产物明细。L3复用project.restore事务的started/checkpoint_created/failed/rollback_completed或rollback_failed，不记录快照正文。L4只读现有脱敏事件；警告是固定文案和计数，日志故障不改业务结论。
- 原外部18项operation输入/输出、版本与传输集合不变；31类节点外部编辑/执行仍planned。固定引用、占用、审核、命令准入与unknown核对不绕过。受影响运行器、恢复与时间线源码加入接入影响保护范围并刷新声明。
- 不改节点端口、contractVersion、正文与config存储格式、项目文件格式、媒体ID、保存事务与任务账本，无新增依赖。只对已有固定结果和已迁移恢复快照执行更准确的既定规则；无效pin继续由公共解析/投影处理。
- 按code-review-and-quality五轴自查：删除重复运行状态判断，避免第三份投影规则；恢复稳定比较在显式恢复边界进行，不增加画布渲染热路径开销；UI复用原class和滚动规则，未新增节点私有样式。日志是数据，消息始终React转义。

## 并行工作区与剩余边界

原工作区另有Skill开发。为防改动/测试相互影响，本轮在独立Git checkout中复制当前源码快照实施，依赖通过本机junction复用，不提交/推送。最终只带回本轮修改；最新Skill基线不算本包交付。测试数据隔离、不操作真实用户项目；浏览器门禁新增可选`CANVAS_QA_GATE_PORT`；Agent桌面夹具监听OS分配的loopback端口并向验收入口传`CANVAS_AGENT_FIXTURE_BASE_URL`，避免固定5200在并行验证时互串。该入口仅测试构建使用，真实模型分支与生产连接配置不变；旧独立入口默认5200保持兼容。无付费调用、物理掉电或供应商取消验收。

本包关闭三条已复现缺口；不是宣称31类节点所有模式、所有设备故障或所有诊断链路全部验收。文本→处理→代码为本次本地用户路径，其他节点继续按计划逐类检查。代码Worker执行发生在真实浏览器，生产Electron与新进程任务恢复由完整既有桌面专项补充；本次JSON快照重开不冒充物理掉电。


## 验证接续

首次隔离完整`run-6ttY65`退出1：首尾帧专项setup-canvas阶段AGENT_CANVAS_TIMEOUT，节点执行尚未开始。此前2541单元/5既有跳过、模型2项、浏览器/构建/前段桌面均通过。因复用node_modules junction导致两个checkout共用Vite优化缓存，已将浏览器cacheDir移到各checkout的忽略qa目录，并关闭本轮独立dev server；这是隔离风险修正，不仅凭复跑断言原超时根因。随后独立`qa/local-reliability/isolated-first-last/`首尾帧两进程通过；最终完整`run-pfbHPM`运行中，以最终退出码为准。


`run-pfbHPM`退出1：新增浏览器夹具省略pin字段时，tldraw按metadata补丁合并保留了原pin，导致UNPINNED_FAILED_RESULT_EXPOSED。修正仅在测试夹具中显式将pinnedOutput设null；单项完整浏览器路径随后通过，并以真实node.failed事件验证时间线（不再使用备用模拟失败事件）。业务修复未因此变更。最终完整改用`run-KjZcLF`，等待实际退出码。


## 最终验收与合入

最终完整`qa/verification/run-KjZcLF/status.json`为passed、exitCode=0（北京时间2026-10-24 21:06:12–21:21:30）。2541项单元通过/5项既有跳过，model-runtime另2项，lint、node/web/model类型、日志/接入门禁、全部浏览器路径（含本轮新增画布验收）、生产构建、真实CLI/MCP、七场景关窗诊断、全部Agent Flow桌面专项及R09本地可靠性通过。首次环境超时和测试夹具失败记录保留，不以单项重跑替代最终完整结果。

已将本包14个选定文件带回原`source`，逐文件核对实现一致，保留其他聊天改动。原目录再次运行6文件90项定向、接入门禁和`npm run build`均退出0。源码与验证输入比对结果保存于`qa/local-reliability/l2-baseline/integration-parity.json`；最终完整QA和先前失败证据已复制回原目录对应`qa/verification/`。未提交/推送，也未覆盖正在运行的安装版程序。

本次日志证据：取消/失败唯一终态、固定结果与未固定失败输出隔离、恢复失败→回滚的明确阶段、诊断截断/坏行提示及有效事件保留通过；现有25项诊断服务回归覆盖ZIP四文件、脱敏、原子写入和logger故障。未验收真实磁盘/物理掉电、供应商远端取消和全类型全部配置组合。
