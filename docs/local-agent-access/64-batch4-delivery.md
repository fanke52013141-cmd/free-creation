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
