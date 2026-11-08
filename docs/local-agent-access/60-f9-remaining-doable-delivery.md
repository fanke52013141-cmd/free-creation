# F9 剩余可做项交付：供应商管理 / 凭据包导入（人工确认）/ 即梦登录

日期：2026-11-08。上一轮 F9 剩 18 项，本轮把其中**可做的 7 项**做完并验证。
F9 计划项 18 → **11**（剩下 8 项 license 永不开放 + 3 项受外部阻塞）。

外部操作：133 → **140**。

## 一、本轮新增（7 项）

| 操作 | 效果 | 复用的既有实现 | 关键边界 |
| --- | --- | --- | --- |
| `provider.save` | write | `providers.repo.saveProvider` | 更新时 apiKey 留空=保留原密钥；**回执绝不回显密钥与地址** |
| `provider.delete` | delete | `providers.repo.deleteProvider` | 不存在如实 `NOT_FOUND` |
| `provider.probe` | write | `provider-check.probeProvider` | 只对**已保存**供应商探测；`allowCost` 恒 false（不发起计费调用）；需 `confirmNetwork` |
| `provider.package.import` | write | `KeyPackageService.applyKeyPackageImport` | 需 `confirmImport`，且**弹 GUI 人工确认框**，人点允许才解密落库 |
| `provider.package.importProviders` | write | `provider-transfer.importProviders` | 同上（旧格式包） |
| `dreamina.login.start` | write | `dreamina-cli.startDreaminaLogin` | 只发起设备流；已登录返回 `already`；需 `confirmNetwork`；**不伪造成功** |
| `dreamina.login.check` | write | `dreamina-cli.checkDreaminaLogin` | 只如实反映本机 CLI 状态 |

配套：桌面协议新增 `confirm-sensitive` 动作（复用 GUI 自己的确认弹窗），
外部**没有伪造这一步的通道**——人工确认必须由人在画布上点。

## 二、验收（真实 MCP + 真实桌面）

新增 `scripts/mcp-acceptance-f9-remaining.cjs`：**13 项检查全通过**。

覆盖：保存后回执不含密钥/地址、更新留空密钥不丢、探测必须确认、探测只对已保存供应商、
删除后目录消失、删不存在给 NOT_FOUND、两个导入必须确认、确认后仍校验文件存在、
假包给稳定码 `PACKAGE_INVALID`、即梦两个操作必须确认、即梦发起如实返回本机状态。

全仓测试 **3106 通过 / 7 跳过 / 0 失败**；门禁全绿（140 operations）。

## 三、过程中发现并修正的问题

1. **既有缺陷：`providers.repo.toSummary` 的 `hasApiKey` 判断在 P2 之后失效。**
   它用 `Boolean(decryptSecret(row.api_key_ref))`，但 P2 起密钥存进设备绑定 vault，
   `api_key_ref` 是 `vault:provider:<id>` 指针 → 明明有密钥却报 `hasApiKey:false`。
   本轮我的 `provider.save` 回执改以 `getProvider()` 为准（正确），并在报告中登记该缺陷；
   **没有改 `providers.repo.ts`**——它当前有并行未提交改动，避免冲突。
2. **确认开关用必填布尔会在缺省时返回 `INVALID_INPUT`**（掩盖真实原因）。
   改为可选布尔，缺省 → 返回 `NETWORK_CONFIRM_REQUIRED` / `IMPORT_CONFIRM_REQUIRED`，Agent 能直接照做。
3. **导入异常会落到 `unknown`**（写操作已准入但抛未分类错误）。已包成稳定码
   `PACKAGE_INVALID` / `PACKAGE_IMPORT_FAILED`，调用方不必猜。

## 四、剩余 11 项与原因

| 项 | 数量 | 原因 |
| --- | --- | --- |
| `ipc.license.*` | 8 | 安全红线：授权签发/挑战/证明/策略导入不得对外开放 |
| `ipc.models.discover`、`validateAgentToolCalling` | 2 | 逻辑内联在 `models.ipc.ts`，该文件**仍在并行未提交修改中**；抽取共享函数会冲突。等那批落定即可做 |
| `ipc.diagnostics.exportNodeRun` | 1 | 依赖 renderer 内存里的运行记录，需要新增桌面动作把节点运行历史取回 main，再把导出实现从 `diagnostics.ipc.ts` 抽成共享函数（该文件干净，可做，但属独立小特性） |

## 五、诚实边界

- **人工确认后的实际导入未能自动化验证**：确认框会等人点，自动化跑会挂起。
  本轮验证的是"没有人的确认绝对进不去"这一侧；真人点允许后成功导入需手测。
- **即梦登录只验证了发起与状态回显**（本机已有登录态时返回 `already`），
  完整"浏览器授权 → 轮询成功"链路需要真人操作。
- `provider.probe` 对不可达地址返回空 items（该 spec 无免费探测项），未做真实供应商连通性验证。

## 六、复现

```powershell
npm run build
node scripts/mcp-acceptance-f9-remaining.cjs
# 报告：qa/local-agent-access/f9-remaining-doable/report.json
```
