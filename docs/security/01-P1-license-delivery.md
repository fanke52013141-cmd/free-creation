# P1 单机授权交付台账：启动锁与发证

2026-11-07 · 依据 [CANVAS_STUDIO_SECURITY_PLAN.md](../CANVAS_STUDIO_SECURITY_PLAN.md) §3/§6 P1 · 状态：已交付（本机验收）

## 1. 交付范围

| 能力 | 状态 | 说明 |
| --- | --- | --- |
| 设备绑定（单机锁） | ✅ | Windows CNG `Microsoft Platform Crypto Provider` 双密钥（K_sign RSA-PSS/SHA-256 32 字节盐、K_wrap RSA-OAEP-SHA256/MGF1-SHA256），不可导出，绑定 Windows 账户持久容器 |
| 授权文件协议 | ✅ | `.csreq`/`.cschallenge`/`.csproof`/`.cslicense`/`.cspolicy`，Ed25519 根→签发人→授权链，规范字节 + 用途前缀签名，严格 Schema（zod strictObject 拒绝未知字段/重复键） |
| 期限模型 | ✅ | `days`（notBefore=issuedAt，expiresAt=issuedAt+days×86400）与 `permanent`（expiresAt=null）互斥；空/零/负/小数/越界拒绝 |
| 授权状态机 | ✅ | `unlicensed/checking/active/locked`；active 之前不打开项目数据库（含进程锁的 SQLite 表）、不迁移密钥、不注册业务 IPC/媒体协议/外部接入 |
| 签发工具 | ✅ | `tools/cs-issuer`（init-root/enroll-ek/challenge/issue/inspect/revoke/revoke-issuer/list），JSON 台账事务（消费挑战+递增序号+保存结果原子完成），不随客户包分发 |
| 启动门禁 | ✅ | `src/main/index.ts` whenReady 最先执行；无授权冒烟（--model-smoke-test）输出 LICENSE_REQUIRED 退出 1 |
| 业务守卫 | ✅ | 模型密钥读写（sqlite-model-host readSecret/saveConnection）、供应商导入导出（provider-transfer）、Agent 接入（server 启动 + service dispatch）统一 `assertLicenseActive` |
| 撤销 | ✅ | `.cspolicy` 递增序号；授权撤销由签发人签、签发人证书撤销由根签；应用导入后立即锁定 |
| 防回拨/防旧文件 | ✅ | `license-state.json` 记录历史最大序号与上次已接受 UTC；回拨 >300s 锁定 TIME_AMBIGUOUS；低序号授权拒绝 |
| 恢复行为 | ✅ | powerMonitor resume 完整复验；失效转授权窗；失败的新授权保留旧授权 |

## 2. 运行方式

```powershell
# 签发（管理机；本仓为开发根，私钥在 qa/security-dev-root/，不入库）
npm run security:issuer -- init-root --subject <名称> --store <目录>          # 首次一次性

# ── 信任直发（推荐日常交易：一来一回两个文件）──────────────────────────
# 客户发来 .csreq 直接签发；一码一机由客户端设备绑定保证（软件密钥申请默认拒绝，
# 仅隔离联调可用 --allow-soft-dev 放行）。详见 §6.0。
npm run security:issuer -- issue --request .\device.csreq --trust-request --permanent --out .\device.cslicense
npm run security:issuer -- issue --request .\device.csreq --trust-request --days 30 --out .\device.cslicense

# ── 完整模式（高保密客户：挑战+证明，两轮四个文件）────────────────────
npm run security:issuer -- enroll-ek --request .\device.csreq --note <备注>
npm run security:issuer -- challenge --request .\device.csreq --out .\device.cschallenge [--strong]
npm run security:issuer -- issue --proof .\device.csproof --days 30|--permanent --role recipient --out .\device.cslicense

# ── 通用 ────────────────────────────────────────────────────────────
npm run security:issuer -- inspect --file .\device.cslicense
npm run security:issuer -- revoke --license-id <uuid> --out .\revocations.cspolicy

# 受信根：客户端构建固定于 src/main/security/license/trusted-root.generated.ts（当前为开发根）
# 换生产根：离线生成后替换该文件 kid/publicKey 与 environment 标注；私钥绝不进仓库/构建机
```

## 3. 关键文件

- 协议包（客户端与签发端共用）：`packages/license-protocol/src/`（types/canonical/sign/rsa/proof/issuer）
- 设备适配器：`src/main/security/license/device/`（adapter/windows-pcp/software/select）
- 授权服务：`src/main/security/license/`（service/store/gate/log/errors/license-window/trusted-root.generated）
- 授权窗：`src/main/ipc/license.ipc.ts`（8 通道，senderFrame 校验）、`src/preload/license.ts`（沙箱隔离、自包含）、`src/renderer/license.html` + `src/renderer/src/license/`
- 门禁与守卫接入：`src/main/index.ts`（进程锁移至门禁之后）、`src/main/model-host/sqlite-model-host.ts`、`src/main/gateway/provider-transfer.ts`、`src/main/agent-access/server.ts`+`service.ts`
- 签发工具：`tools/cs-issuer/`（Node 24 `--experimental-transform-types` 直跑，无构建产物）

## 4. 实施中修复的关键问题

1. **进程锁先于门禁打开数据库**：`acquireProcessLock` 基于 SQLite，原顺序在门禁前创建 app.db，违反"未授权实例无项目数据库写入"。已将进程锁移至门禁之后（index.ts）。
2. **零窗口退出竞态**：激活后先关授权窗会触发 `window-all-closed → app.quit`（业务窗尚未创建）。改为业务窗 `createWindow()` 之后再关授权窗；resume 路径同理先开授权窗再关业务窗。
3. **沙箱 preload 不支持相对 require**：授权 preload 引用共享 chunk 导致加载失败。改为自包含文件，通道常量内联，`test/license-preload-contracts.test.ts` 防两端漂移。
4. **签发端时限与设备端时钟**：CLI 用真实时间签发，联调测试不得使用固定假时钟（2030 样本导致证书"过期"）。

## 5. 验证记录（本机 WIN-3SO1T5P32LN，Windows 11 x64，TPM/PCP 可用，Node 24.12）

| 验证 | 结果 |
| --- | --- |
| 定向单测 `npm run test:license` | ✅ 53 通过 / 1 跳过（真机用例单独跑通过，共 54 项含真机） |
| 真机 PCP 适配器（CANVAS_LICENSE_LIVE_PCP=1） | ✅ 创建→读公钥→挑战证明→持有验证→销毁 全链路（约 2.3s） |
| electron 端到端 `npm run test:license-electron` | ✅ 4/4：A 未授权仅授权窗无 app.db；B 授权窗 UI 全流程激活（真实 TPM）进业务；C 重启免输入；D 无授权冒烟被封闭 exit 1。证据 `qa/license-electron/run-*/results.json` |
| 跨设备拒绝（双机等价模拟） | ✅ 单测：A 的授权导入 B 拒绝；复制授权存储到 B 锁定 DEVICE_MISMATCH |
| 序号/撤销/回拨/篡改/证书能力 | ✅ 单测覆盖（15 项服务测试 + 4 项 CLI e2e） |
| 全量单测 `npm test` | ✅ 2782 通过 / 7 跳过 / **1 失败为既有问题**（node-scrollbars，源于工作区先前未提交的 scrollbars.css 改动，与授权无关） |
| `npm run verify:logging` | ✅ 通过（license.* 已登记；tools/cs-issuer 以理由豁免——离线 CLI，无诊断底座，不输出密钥材料） |
| `npm run verify:agent-access` | ✅ 通过（19 操作；32 计划节点；契约已 `--write` 刷新） |
| `npm run typecheck`（node+web+license-protocol+issuer） | ✅ |
| `eslint`（全部新增源码与测试） | ✅ 无错误 |
| 构建产物 | ✅ out/renderer/license.html + out/preload/license.js（自包含）；tools/cs-issuer 不在 electron-builder 白名单，不随客户包分发 |

## 6. 边界与后续（对应方案 P0/P3）

### 6.0 信任直发模式（2026-11-07 补充，应运营方要求）

`cs-issuer issue --request <csreq> --trust-request` 跳过挑战/证明，凭申请文件直接签发，
交易为一来一回两个文件。保证与边界：
- 一码一机：授权绑定设备 TPM 密钥指纹；客户端在导入与每次冷启动核验绑定并做本机持有
  签名验证；授权文件复制到其他设备一律 `LICENSE_DEVICE_MISMATCH` 锁定（已实测）。
- 直发拒绝 `software-dev` 申请（软件密钥可复制，是绕过单机锁的唯一途径；自报字段可被
  改写过的客户端伪造——该威胁由 P3 代码签名/App Control 收口，属已知边界）。
- 同一申请重复签发 = 续期（授权序号递增），仍只对同一设备有效。
- 台账以 `mode: trust-request | challenge` 区分两种签发。

- **P0 待办**：完整 TCG 证明链（EK 证书链核验 + MakeCredential/ActivateCredential/Certify，需 PCPTool 互通原型）；两台不同实体 TPM 机器互测；软件密钥伪造样例的签发端强模式实测（`--strong` 已实现单机拒绝，待双机）。当前 EK 校验为登记摘要比对，非管理员会话取不到 EK 时签发端需显式 `--allow-unenrolled`/非强模式。
- **P3 待办**：签名安装包、ASAR 完整性 + Fuses、包外清单验签、App Control、独立签名 Agent 客户端、Electron 39 升级。
- **密钥保管**：开发根为明文 0600 文件（qa/ 已 gitignore）；生产必须离线硬件（方案 §3.1），私钥口令不经 CLI/环境变量。
- **已知限制**：离线且本机可控时间的全盘快照回滚无法对抗（方案 §3.3 已登记）；软件适配器仅开发未打包构建 + 显式 `CANVAS_LICENSE_ALLOW_SOFTWARE_DEVICE=1`，打包构建无条件拒绝。

## 7. 日志影响检查（按模板）

- 新增事件族：`license.check.*`、`license.activation.completed`、`license.policy.completed`、`license.request.completed`、`license.guard.skipped`；开始/唯一终态配对，无重复终态。
- 禁入内容核查：无公钥/EK/AK/设备码/签名文件/密码/API Key/原始异常；原因码为稳定枚举。
- 无 console.*、无 electron-log 直引（log.ts 走 emitGatewayEvent）；verify:logging 门禁通过。
- 日志拒写不改变授权判定（log.ts 全部 catch 吞掉发射异常）。

## 8. 接入变更影响检查（按模板）

- 未新增外部接入操作或能力；既有操作矩阵不变。
- 触及保护范围文件（provider-transfer.ts、sqlite-model-host.ts、agent-access/server.ts、service.ts、gateway/）→ 已运行 `check-agent-access.cjs --write --reason` 刷新 contracts.json 与 change-impact.json。
- 新增 IPC 通道（license:*）仅注册于授权窗（锁定态），业务窗口与外部 Agent 不可达；preload 沙箱隔离。


## 9. 发行版构建（免授权功能裁剪版，2026-11-07）

`npm run build:distribution`（CANVAS_DISTRIBUTION=1，开关见 `src/shared/edition.ts`）：
- **跳过授权门禁与设备密钥库**：无授权窗、无 license.check 事件、无 vault——API Key 走
  系统安全存储（DPAPI），客户在模型设置导入密钥即用；
- **功能裁剪**（节点保留注册但不可创建，外部接口与既有工程零破坏）：
  视频创作去掉 深度视频/白膜视频/3D预演台；声音创作去掉 语音克隆/音色设计；
  AI 与自动化去掉 Agent/AI审核/状态机；数据与代码整组移除。资源库保留。
- **即梦 CLI 随包**（extraResources → `resources/bin/dreamina.exe`），探测顺序
  env → 打包内 → PATH → 默认落点，用户无需自行下载；
- 产物：`dist/canvas-studio-1.0.0-setup.exe`（NSIS，用户级安装）+ win-unpacked。
  asar 维持 false（历史 Windows 索引问题属 P3 待办），代码为打包后 JS，非源码形态。
- 已验证：免授权 7 秒进业务；Dock 分类仅剩 图片/输入/视频/声音/AI(处理+对话)；
  裁剪节点全部不可见；密钥导入且明文不回显；主线（不带开关）构建与授权 e2e 无回归。
