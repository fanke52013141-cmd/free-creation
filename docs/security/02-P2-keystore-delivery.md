# P2 密钥库与指定设备导出交付台账

2026-11-07 · 依据 [CANVAS_STUDIO_SECURITY_PLAN.md](../CANVAS_STUDIO_SECURITY_PLAN.md) §4/§6 P2 · 状态：已交付（本机验收）

## 1. 交付范围

| 能力 | 状态 | 说明 |
| --- | --- | --- |
| `.cskeys` v2 协议 | ✅ | 每包 32B 秘密 S 经接收者 K_wrap RSA-OAEP 封装；scrypt(N=131072,r=8,p=1,单飞) + HKDF-SHA256 内容密钥；AES-256-GCM（AAD=包头规范字节）；发放员设备 K_sign 签 包头‖密文‖tag；包内携带其授权信封，接收端验证签发链 + `credentials.export` + 设备绑定（license.signKeyId === kid(签发设备公钥)） |
| 接收设备凭证 `.csdevcred` | ✅ | 有效授权信封 + 签发人证书信封 + K_wrap 公钥 + 设备摘要；发放端全量校验（K_wrap 公钥 kid 必须等于授权 wrapKeyId，防换包重放） |
| 设备绑定密钥库 | ✅ | `secret_vault` 表（migration #20）：内容密钥 AES-GCM 加密明文（AAD 绑定 kind/id/origin/source/scope）→ 内容密钥 K_wrap 封装；明文仅在主进程发请求的短时窗口存在（5 分钟 TTL 缓存，写/删/迁移/锁定/resume 即清） |
| 端点绑定 | ✅ | 密钥释放时校验请求目标来源 === 绑定来源（`readForRequest`），改地址即拒；`fetchUpstream`/`glmCompatibleFetch` 携带凭据的请求 `redirect: manual` + 3xx 拒绝（REDIRECT_BLOCKED）；discover 自定义头不再覆盖鉴权 |
| 明文回退停用 | ✅ | `encryptSecret` 在 safeStorage 不可用/失败时抛错拒绝保存（绝不降级 plain:）；`plain:`/裸值仅保留迁移读取 |
| 旧库迁移 | ✅ | 激活后启动执行：providers + model_connections 逐行 `enc:/plain:/裸值` → vault 设备密文 → 引用替换 `vault:<kind>:<id>`；失败保留原值计入 pending 下次重试；曾为可复制明文的行输出轮换提示；幂等 |
| 密钥包导入 | ✅ | 预览（连接/端点/模型数，无明文）→ 确认 → 连接+vault 逐条原子写入 → 模型定义与 `key_imports` 单事务；重复导入识别（重导需显式确认）；覆盖现有连接需显式确认 |
| v1 传输停用 | ✅ | `exportProviders/importProviders` 恒定拒绝（PROVIDER_TRANSFER_V1_DISABLED）；UI 移除导入/导出入口，替换为密钥包三步流 |
| 发放能力门控 | ✅ | seal/列连接仅 `credentials.export`（key-issuer 角色）；UI 依 bootstrap 的 license.capabilities 显隐「发放密钥包」入口 |

## 2. 运行方式

- 接收方：模型设置 → 「导出接收凭证」→ 把 `.csdevcred` 交给发放员；
- 发放员（key-issuer 授权）：模型设置 → 「发放密钥包」→ 密码（20–256 字节，独立渠道交付）→ 选接收凭证 → 勾选连接（默认全不选）→ 导出 `.cskeys`（7 天有效，与接收者授权期限取交集）；
- 接收方：「导入密钥包」→ 选文件 + 密码 → 预览确认 → 落库；
- 撤销与续期沿用 P1：`.cspolicy` 撤销授权后，密钥读取/发放/导入全部被守卫拒绝。

## 3. 关键文件

- 协议：`packages/license-protocol/src/keypackage.ts`（+ `verify.ts` 抽取以消除循环引用）
- 密钥库：`src/main/security/keystore/`（vault.ts / keypackage-service.ts / migrate.ts）
- 迁移：`src/main/store/db-migrations.ts`（M20：secret_vault + key_imports，DB_SCHEMA_VERSION 19→20）
- 业务接入：`sqlite-model-host.ts`（readSecret/readSecretForRequest/saveConnection）、`providers.repo.ts`（getProvider/saveProvider/listProviders/bootstrap 异步化 + vault）、`keycrypto.ts`（明文回退停用 + vault 引用）
- 传输收口：`upstream-fetch.ts`（凭据请求拒绝重定向）、`glm-request.ts`（AI SDK 通道恒拒重定向）、`models.ipc.ts` discover（来源校验 + 头序修正）
- IPC/UI：`gateway.ipc.ts`（5 个 keys 通道 + keys.package.*/keys.credential.* 事件）、`KeyPackageDialogs.tsx`、`ProviderSettingsPanel.tsx`（v1 移除）、`preload/index.ts`、bootstrap 携带 license 摘要
- e2e：`scripts/test-keys-electron.cjs`（+ `test-license-electron.cjs` 角色参数化与产物固化）

## 4. 验证记录（本机 WIN-3SO1T5P32LN，真实 TPM，Node 24.12）

| 验证 | 结果 |
| --- | --- |
| 协议单测（双软件适配器模拟 A/B 两台设备） | ✅ 往返/错密码/错设备/过期/篡改/无能力/超限/密码策略/来源规范化 |
| vault 单测（真实 SQLite + M20） | ✅ 往返/来源绑定拒绝（含端口差异）/跨设备 VAULT_DECRYPT_FAILED/缓存恰好一次 TPM/重启可解 |
| keycrypto 单测 | ✅ 明文回退停用（不可用即抛）/vault 引用解析/兼容读取 |
| electron e2e `test-keys-electron.cjs`（真机 TPM） | ✅ A 发放员授权生效；B 种子连接；C 凭证导出；D 密钥包发放（1 连接，7 天期限）；E 导入落库；F 重导识别 + 错密码拒绝 |
| 使用者负例（无 key-issuer 授权运行） | ✅ seal 在能力检查处拒绝 |
| 既有回归（keycrypto/vault/transfer/models/local-agent-access/vision/command-ipc） | ✅ 106 通过 |
| 全量 `npm test`（含异步化适配的 9 个测试文件：video-task-recovery 57、c4+r09 16、providers 系列、迁移 7 等） | ✅ 2801 通过 / 1 既有失败（node-scrollbars，源于工作区先前未提交的 CSS 改动，与授权无关） |
| typecheck（node+web+license-protocol+issuer）/ build / eslint | ✅ 0 错误 |
| verify:logging（keys.* + gateway.upstream.redirect_blocked + model.discovery.* 已登记） | ✅ |
| verify:agent-access（契约已刷新：19 操作/32 节点） | ✅ |
| 迁移真实库 | ✅ 本机日常库（10MB）启动时自动迁移，vault 引用生效（`vault:connection:*`） |

## 5. 实施中修复的关键问题

1. **循环引用**：keypackage 引 index.ts 的 Schema 在模块初始化期拿到未初始化值 → Schema 改为直接从具体模块导入；`verifyEnvelope` 抽到 `verify.ts`。
2. **同步热路径 vs TPM 异步**：getProvider/readSecret 每请求调用而 PCP 解封装只能异步 → 将密钥消费链整体异步化（约 25 处调用点 + IPC handler），以 5 分钟 TTL 缓存吸收重复解封装；拒绝"常驻明文缓存"的捷径（违背方案"短时使用"）。
3. **bootstrap 同步链**：saveProvider → bootstrap → saveConnection 均需 vault 异步写 → 一并异步化；v1 传输停用消除了事务内同步写密钥的冲突。
4. **better-sqlite3 事务语义**：`db.transaction(fn)` 返回事务函数需再调用，e2e 抓出 key_imports 未落库 → 修复为 `transaction(fn)()`。
5. **裸 esbuild 子进程构建**：recovery-contention/c4/r09 的 worker 以裸 esbuild 打包 src，`@free-creation/license-protocol` 别名不可达 → security 层改相对导入；v16 迁移竞速 fixture 需同步拆除 M20 表。

## 6. 边界（对应方案验收的差距）

- **双实体机互测**属 P0/管理方验收：本机以双软件适配器单测承载"非接收设备导入失败"矩阵；真机 e2e 为同机发放/导入（同一 K_wrap）。
- **裸 fetch 全量收口**分期：本期覆盖两大传输 + 释放时来源校验；image.ts 等直连 fetch 的凭据来自已校验的连接配置，重定向面收窄但未逐一改造（台账登记）。
- **供应商侧限制**（调用次数/额度/作废）仍按方案 §4.3 由子 Key 或代理承担，非本包范围。
- `modelsJson` 的模型形状由主进程目录层定义（协议只承载完整性），跨大版本目录迁移不属本包承诺。

## 7. 日志影响检查（按模板）

- 新增事件族：`keys.credential.completed`、`keys.package.completed`（发放/导入分事件发射，成功/失败/取消唯一终态）。
- 禁入内容核查：事件只含包 ID、连接数、模型数、阶段、原因码、设备摘要（16 hex）；**无明文 Key、无连接密文、无密码、无完整端点路径**。
- 无 console.*、无 electron-log 直引；verify:logging 通过。

## 8. 接入变更影响检查（按模板）

- 未新增外部接入操作；既有操作的密钥读取路径行为增强（来源校验）但契约不变。
- 触及保护范围文件 → `check-agent-access.cjs --write --reason` 刷新 contracts/change-impact。
- 新增 IPC 通道（gateway:keys:*）仅注册于业务窗口主进程 handler，renderer 无明文通道；外部 Agent 无密钥管理入口（方案要求）。
