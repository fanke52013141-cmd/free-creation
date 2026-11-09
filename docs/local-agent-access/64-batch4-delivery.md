# 批 4 交付：模型发现 / Agent 工具调用验证（解除阻塞）+ hasApiKey 根因 + 验收入口

日期：2026-11-08。此前的"卡在别人手里"其实是一次误判：相关文件（`models.ipc.ts`、
`providers.repo.ts`、`package.json`）确实有未提交改动，但**最后修改时间在 11/7–11/8 更早时段，
之后未再变动**——不是有人正在实时编辑，而是更早留下的未提交工作。
确认这一点后本轮直接处理完毕。

外部操作：141 → **143**；F9 计划项：10 → **8**（只剩 license，永不开放）。

## 一、`models.discover` / `model.validateAgentToolCalling`（2 项）

**不再复制逻辑**：把 GUI 的两段内联实现抽成共享模块，GUI 与外部接入共用同一份：

- `src/main/model-host/discovery.ts`：`discoverConnectionModels(host, connectionId)`
  —— 端点绑定校验（密钥来源必须与目标 URL 一致）、vidu-cli 固定两档、诊断事件、
  错误文案全部保留；`models.ipc.ts` 的 `discover` 处理体改为调用它。
- `src/main/model-host/agent-tool-calling.ts`：`validateAgentToolCallingOnHost(host, input)`
  —— `allowCost` 闸门、能力/协议校验、revision 防护、验证快照写入、诊断事件全部保留；
  `models.ipc.ts` 的 `validateAgentToolCalling` 处理体改为调用它。

**外部操作的两个关键边界**：
- `model.discover`：必须 `confirmNetwork=true`，否则拒绝且**零请求**；
- `model.validateAgentToolCalling`：必须 `confirmNetwork` **且** `confirmCost`（会真实请求、可能计费）。

## 二、`hasApiKey` 根因修复

`providers.repo.toSummary()` 原用 `Boolean(decryptSecret(api_key_ref))` 判断。
P2 起密钥写在设备绑定 vault，`api_key_ref` 是 `vault:provider:<id>` 指针，
解密必然失败 → **有密钥却报 false**（GUI 遗留列表受影响）。

修复：`parseVaultRef(ref) !== null || Boolean(decryptSecret(ref))` —— vault 指针格式合法即视为已保存
（是否真能读取由 `getProvider`/请求时校验）。外部读侧在批 1 已校正，现在 GUI 与外部一致。

配套：`test/providers-security.test.ts` 的 `keycrypto` mock 缺 `parseVaultRef`（真实模块有），
已补齐 mock（断言未放宽）。

## 三、`verify:acceptance` 命令

- `node scripts/verify-acceptance.cjs`：串行跑全部 8 个真实验收脚本，汇总后自动归档证据；
- `--fast` 只跑协议层 + 优化验证（约 3 分钟）；
- 可指定批次名（如 `node scripts/verify-acceptance.cjs family1 sse`）；
- `package.json` 新增 `verify:acceptance` 与 `verify:acceptance:fast`。

## 四、验证

- 全仓测试 **3110 通过 / 7 跳过 / 0 失败**
- `verify:agent-access` **143 operations**；`audit-business-actions` 171 IPC + 42 画布动作
- `mcp-acceptance-f9-remaining.cjs`：**17/17**（新增 3 项：discover 未确认拒绝、
  工具调用验证双重确认、discover 对不存在连接给稳定码）

## 五、剩余 8 项（全部 license，按用户决定不开放）

`license.getStatus / probeDevice / exportRequest / importChallenge / exportProof / importLicense /
importPolicy / getDiagnostic` —— 授权签发/挑战/证明/策略导入对外开放等于门禁失效，保持 excluded。

## 六、R1 基线测试重跑（2026-11-09）

按 [详细测试计划](66-parity-test-plan.md) §9 完成 R1：门禁、类型、lint、全仓测试（3110 通过）、
构建、`verify:acceptance` **8/8 批次（228 项检查）**、图里程碑 **49/49** 全绿。
当日分母：213 业务动作（external 175 / excluded 30 / F9 8）、143 操作、32 类节点。
本轮修复：lint 基线缺口、开发根不可迁移（本机重建并换根、永久硬件绑定激活）、
3 个验收脚本工具数硬编码、family1 与里程碑脚本的版本重试竞态；未发现新的产品行为缺陷。
完整结果、证据索引与边界见 [R1 基线测试报告](67-r1-baseline-test-report.md)。

## 七、R2 缺口补测（2026-11-09）

按 [详细测试计划](66-parity-test-plan.md) §6 完成三条强制场景的真实桌面补测：GUI 反向腿 6/6、
画布切换与任务隔离 6/6、崩溃与回执丢失 6/6（修复后）。新脚本
`scripts/test-agent-parity-gaps.cjs` 已纳入 `npm run verify:acceptance`（`parity-gaps` 批次）。

本轮发现并修复两个真实缺陷：

1. **崩溃后 external_runs 永不结算**：硬杀桌面后重启，`run.get` 仍报 running/error=null，
   `taskOccupied` 把该画布所有非读操作永久拒绝。修复：接入服务取得进程锁后把非终态行结算为
   `failed/HOST_RESTARTED`（不重放、不补产物），并发 `agent.access.runs_settled` 诊断事件。
2. **run.wait 长轮询必然 15s 被切断**：契约允许 120s，但服务端/客户端 socket 空闲超时均为 15s，
   长等待必得 `OUTCOME_UNKNOWN/connect`。修复：服务端请求期放宽到 `RUN_WAIT_MAX_TIMEOUT_MS+90s`，
   客户端按请求时长+30s 设置。

另修复验证脚本问题：`test:local-agent-access` 与 `test:diagnostics-window-close` 缺授权目录复制
（授权门禁上线后未再跑过；R3 分别以 CLI_CREATE_FAILED 和 waitForFunction 超时暴露）、
`mcp-acceptance-optimizations` A3 版本冲突未按既有模式重试。最终 `verify:acceptance`
**9/9 批次通过**（含新增 parity-gaps，证据归档 stamp `2026110905174`）。
计划中"跨画布并行执行"假设不成立：桌面为单活动画布，在途切换被 `RESOURCE_BUSY` 保护，
测试按真实语义执行；取消语义（竞态丢失/终态为 failed）记录为观察项未修复。
R3 全链同日跑完：lint/类型/单测（3111 通过/7 跳过）/日志与接入门禁/构建/本地接入、诊断关窗、
agent-flow 至 recovery 全部通过；**视频 Agent Flow 11 个脚本红**（unknown 保持/并行部分产物），
回退本轮源码到 HEAD 重建后同样失败，为 2026-10-24 之后的既有回归，另行定位。
详情、归因与修复前证据见 [R2 缺口测试报告](68-r2-gap-report.md)。

## 八、视频 Agent Flow 回归修复（2026-11-09，R3 红区优化）

R3 中 11 个视频 Agent Flow 脚本稳定失败（unknown 保持 / 返工 / 并行）。根因：视频执行器把供应商
`taskId` 写进节点 `config`（9d3f49f 续跑功能），而 `config` 参与命令语义修订与提交期输入指纹，
导致命令在下发后、提交时被误判为"画布/输入已变更"（`FLOW_REVISION_CONFLICT` /
`FLOW_SAVED_INPUT_MISMATCH`），Agent 流程失败而非停在 waiting/reconcile。

修复：任务号改存 `meta.videoTaskId`（`recoverVideoRuns` 兼容旧 `config.taskId`）；
`semanticProjectPayload` 对视频 `config`/`params.config` 忽略遗留 taskId。新增两个定向单测。
修复后 11 个脚本全部通过，`verify:acceptance` 9/9。详见
[69 视频 Flow 回归修复](69-video-flow-revision-fix.md)。
