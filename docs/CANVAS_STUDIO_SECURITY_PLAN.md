# Canvas Studio Windows 离线授权与保密实施方案

2026-11-06 · 实施设计 v1 · 适用于受管理的 Windows 11 x64 实体电脑

## 1. 发布目标和约束

Canvas Studio 继续以本地单用户方式运行。指定电脑经过发证后可断网启动。模型请求是否需要联网仍取决于供应商。签发人用独立工具审核设备并生成授权文件。使用者首次启动时提交设备申请、导入授权文件，后续正常启动无需输入授权码。模型设置仍位于项目列表首页。

首版高保密发行包限定 Windows 11 x64、TPM 2.0、受支持的 Windows 版本。设备绑定到实体 TPM 和创建密钥的 Windows 账户。受管理的发放场景要求使用普通 Windows 账户，管理员由管理方保管。机器换网、换 IP、改电脑名与离线启动应正常。换主板、清 TPM、重装系统或更换 Windows 账户造成密钥不可用时重新发证。远程代发授权也需要设备证明，强模式无 TPM 时拒绝签发。

| 要防的情况 | 实施机制 | 交付边界 |
| --- | --- | --- |
| 复制安装包、授权文件或数据目录 | 签发人数字签名和 TPM 私钥持有证明 | 在另一台机器上，官方包无法激活或打开工作区 |
| 知道导出密码后将密钥包复制到另一台机器 | 指定接收设备的 TPM 解封装，加上导出密码 | 两者缺一均无法解开包 |
| 直接替换 JavaScript、原生组件或启动入口 | 签名发行、ASAR 完整性、外置文件签名清单和系统应用控制 | 受管设备上的操作系统负责阻断未获准程序。自管电脑的管理员仍可运行自行修改的客户端 |
| 电脑关机后被盗或硬盘被拆 | 系统卷、项目卷和离线备份加密 | Windows 会话已解锁时，由系统账户隔离和应用权限继续保护 |
| 已授权用户或本机恶意程序窃取正在使用的供应商 Key | 减少密钥暴露，使用供应商可撤销且限权的独立 Key | 通用 Bearer Key 被提取后可以在其他工具使用。只有供应商侧授权或代理能阻止这种重用 |

项目源码如已对外公开，历史副本仍可被构建。签名可以区分官方包及非官方包。真正需要保密且尚未分发的源码、资源和构建映射应存于权限受控的仓库和构建存储。项目包继续排除 API Key。云模型接收到的输入和输出受供应商数据政策约束，含涉密材料的工作流使用经批准的本地模型或供应商。

## 2. 当前仓库的改造起点

| 现状 | 改造落点 |
| --- | --- |
| 主进程启动会打开数据库、迁移历史密钥、清理临时文件、注册媒体和业务 IPC，再启动外部接入 | 准入移动到这些动作之前。授权界面使用单独窗口和 preload。封闭正式业务路径也要覆盖无界面模型冒烟、Agent、窗口重建和深链入口。[启动主进程](../src/main/index.ts#L354) |
| Windows 包为 `asar: false`，注释记录启用后遇到原生依赖和索引问题。构建包含多个验收入口 | 单独制作生产发行配置，修复 ASAR，保留生产需要的原生模块及媒体工具，从发行白名单排除测试入口和 source map。[打包配置](../electron-builder.yml#L1) · [构建入口](../electron.vite.config.ts#L26) |
| `canvas-studio-agent.cmd` 设置 `ELECTRON_RUN_AS_NODE=1`，直接引用 `resources/app` 下的 JS | 先把生产 CLI/MCP 迁为独立签名客户端，再关闭正式包的 Node 模式。保留现有 CLI 参数、stdio MCP 及返回格式，所有业务仍由同一个已授权的桌面宿主处理。[现有启动脚本](../build/canvas-studio-agent.cmd) · [接入契约](../AGENT_ACCESS_SPEC.md) |
| 现有桌面开发快捷方式会拉取 Git 源码并启动本地构建 | 正式快捷方式改由签名安装器创建，直指已安装的 EXE。发布流程走签名安装包，开发快捷方式只用于隔离开发数据。[现有快捷方式流程](desktop-latest-launch.md) |
| 模型配置有两条密钥存储路径。`safeStorage` 失败时可以写 `plain:`，旧数据可能含裸值。配置导出当前是仅密码的 v1 | 收口 `providers.api_key_ref`、`model_connections.secret_ref` 及自定义鉴权头。停用明文回退，增加 TPM 库及指定接收设备的 v2 导出。[密钥存储](../src/main/gateway/keycrypto.ts) · [模型宿主](../src/main/model-host/sqlite-model-host.ts) · [供应商配置导出](../src/main/gateway/provider-transfer.ts) |
| 锁文件中的 Electron `39.8.10` 所属的 39 系列于 2026-05-05 结束支持 | 第一批升级到构建时仍受支持、通过本项目原生依赖回归的稳定主版本并锁定版本。发行门禁检查支持状态。[官方发布周期](https://releases.electronjs.org/schedule) |

## 3. 管理员怎样发证

### 3.1 三种密钥分别保管

| 密钥 | 推荐配置 | 谁持有 |
| --- | --- | --- |
| 授权根签名与签发密钥 | Ed25519。离线根签发短链的签发人证书，限定用途和有效期。发行包只固定根公钥。根签署签发人撤销与发行策略，日常签发使用签发人密钥 | 根放离线硬件或加密介质，离线备份两份并演练恢复。签发人密钥由专门的管理电脑或支持对应算法的硬件保管。Git、CI 和安装包均无授权私钥 |
| Windows 代码签名密钥 | 可信发布者证书，使用硬件托管或受控签名服务。签安装器、应用 EXE、独立 Agent 客户端和自有原生组件 | 发布负责人。构建机只提交待签产物，签发授权的工具无代码签名权限 |
| 每台设备的签名和解封装密钥 | Windows CNG 的 `Microsoft Platform Crypto Provider`。每个绑定账户分别生成不可导出的 `K_sign` 和 `K_wrap` | 目标设备 TPM。应用和签发人只交换公钥和必要的证明。测试根与生产根完全隔离 |

设备签名优先验证 RSA-PSS/SHA-256、32 字节盐，解封装验证 RSA-OAEP/SHA-256、MGF1-SHA-256、空标签，RSA 至少 2048 位。研发先用目标机型验证 CNG 和 Node 双向互通、重复打开密钥以及锁屏后恢复。遇到不兼容型号时标记为未支持，修改算法需单独评审并升级协议版本。签名与解封装用途分开，默认采用当前 Windows 账户的持久密钥容器。[Windows TPM 密钥证明](https://learn.microsoft.com/en-us/windows-server/identity/ad-ds/manage/component-updates/tpm-key-attestation) · [Windows NCryptDecrypt](https://learn.microsoft.com/en-us/windows/win32/api/ncrypt/nf-ncrypt-ncryptdecrypt) · [RSA 规范](https://www.rfc-editor.org/rfc/rfc8017)

### 3.2 首次安装、证明和续期

1. **登记目标机**。管理员在接收电脑安装已签名版本，先当面或通过受控交付渠道确认设备身份，将该 TPM 的 EK 公钥摘要加入签发台账。首次登记保留必要的校验证据和批准记录，台账不进入客户端诊断。
2. **申请**。用户在启动页点「导出设备申请」，得到 `.csreq`。文件带两个公钥、证明所需的 EK/AK 材料和随机申请编号。界面显示设备摘要用于人工核对，完整文件用于验证。IP、MAC、电脑名和磁盘序列号不作为身份凭据。
3. **离线挑战**。发证工具验证 EK 证书链与预登记摘要，核验 TPM 型号和证明策略。签发 `.cschallenge`，绑定申请文件摘要、挑战 ID 和随机 nonce，并用 `MakeCredential` 将一次性随机秘密绑定到 EK 与 AK Name。建议挑战 48 小时内有效，签发台账拒绝重用。
4. **提交证明**。目标机导入挑战，核验签发人签名，执行 `ActivateCredential`。导出 `.csproof`，内含一次性秘密对挑战与申请摘要的 HMAC、AK 对两把设备密钥的 `Certify` 证明和 `K_sign` 对本次挑战的签名。证明绑定挑战 nonce。签发端检查 EK 信任、AK 属性和绑定、证明签名、完整 `TPMT_PUBLIC` 计算的对象 Name、不可迁移与 TPM 内生成属性、算法和用途、公钥是否与申请及后续授权一致。普通软件公钥通过持有证明也无法通过这一关。
5. **发证**。你核对编号和设备摘要，选择「使用者」或「模型密钥发放员」。两者都有 `app.run`，后者才有 `credentials.export`。发证前必须选择「按天授权」或「永久授权」，表单默认未选。按天授权填写正整数天数，签发前显示预计到期的日期和时间。永久授权显示「永久有效」，签发前显示绑定的设备摘要并确认。发证工具产出 `.cslicense`，台账记录授权编号、设备摘要、角色、期限类型、天数和到期时间（适用时）、签发时间和操作人。初次签发、续期及变更期限均需新挑战。同一设备重新签发时增加授权序号。
6. **激活**。用户导入授权。应用验证签发链、产品、期限、权限、撤销策略和两个公钥摘要，做一次本机私钥持有验证，通过后原子替换旧授权，再进入项目列表。失败的新授权文件保留原有效授权。每次冷启动以及系统恢复后重新验证。按天授权在到期前 14 天、7 天和 1 天提示续期，短期授权只显示当前适用的提醒。永久授权显示「永久有效」，免续期提醒，仍执行设备绑定和撤销检查。

`MakeCredential`、`ActivateCredential` 和 `Certify` 依据 TCG 协议，使用经过审查且固定版本的 TPM 组件。Windows CNG 管理日常密钥和签名，TPM 证明适配器先验证能否证明同一组 CNG 密钥。Microsoft PCPTool 的证明 API 可作为互通原型参考。首批若无法完整验证证明和 EK 信任链，只能做隔离联调，不能发行高保密包。用两台实体设备和软件密钥伪造样例验收后再接入正式签发工具。[TCG TPM 2.0 规范](https://trustedcomputinggroup.org/resource/tpm-library-specification/) · [TCG EK 证书规范](https://www.trustedcomputinggroup.org/resources/documents/http-trustedcomputinggroup-org-wp-content-uploads-tcg-ek-credential-profile) · [Microsoft PCPTool 证明接口](https://github.com/microsoft/TSS.MSR/blob/main/PCPTool.v11/inc/TpmAtt.h)

### 3.3 文件契约和状态

- `.csreq` 含 `v`、`product`、`requestId`、两个规范 SPKI 公钥、两个 TPM 公共区、AK 公共区及 EK 证书链。`.cschallenge` 的签名负载含 `challengeId`、`requestSha256`、`nonce`、`credentialBlob`、`encryptedSeed`、`issuedAt` 和 `expiresAt`。`.csproof` 含申请与挑战摘要、激活 HMAC、两份带 AK 签名的证明和设备签名。`requestId`、`challengeId` 与挑战 `nonce` 均由密码学随机数生成，挑战 `nonce` 为 32 字节。签发台账在同一事务中消费挑战、递增序号和保存签发结果。同一请求重试读取同一结果，不能重复签发。
- `.cslicense` 使用严格 UTF-8 JSON。信封含 `kid`、`payload`、`sig`，后两项使用无填充 base64url。负载字段为 `v`、`product`、`licenseId`、`sequence`、`signKeyId`、`wrapKeyId`、`capabilities`、`issuedAt`、`notBefore`、`term`、`expiresAt`。固定 `product` 为 `com.canvas-studio.app`，公钥 ID 为规范 SPKI DER 的完整 SHA-256，时间为 UTC 秒。签发人证书独立置于信封，先验证根签名和用途，再用证书公钥验授权。固定算法由版本决定。
- `term=days` 时，`notBefore` 等于签发时间，`expiresAt = issuedAt + days × 86400`，到达该秒即过期。签发端拒绝空值、零、负数、小数及导致时间越界的天数，签发工具和客户端均验证时间可安全表示。`term=permanent` 时，`expiresAt` 必须为 `null`。缺少期限字段、非法组合和未知类型均拒绝。签发人证书须覆盖授权的签发时间，证书自然到期后不能继续签发，已合法签出的授权按自身期限和签名撤销策略处理。
- 签名输入使用用途前缀和 JCS 规范字节，授权使用 `ASCII("CS/license/v1\0") || ASCII(kid) || 0x00 || payloadBytes`。固定并限制 `kid` 格式。其他对象使用各自用途前缀。使用严格 Schema 和规范字节复核，拒绝重复键、未知字段、非法编码、超限或未知版本。授权文件上限 64 KiB，设备证明文件上限 1 MiB。根公钥来自发行包，文件中的任意自带根证书均不能取得信任。[Ed25519](https://www.rfc-editor.org/rfc/rfc8032) · [JCS](https://www.rfc-editor.org/rfc/rfc8785)
- 状态只允许 `unlicensed`、`checking`、`active`、`locked`。`active` 之前不注册业务 IPC、媒体协议处理器、外部接入，也不打开项目数据库、迁移数据或启动模型任务。授权窗口只可探测 TPM、导出申请和证明、导入签名文件、查看简短诊断。隔离 preload，限制 IPC 发送方、文件选择及大小，支持安全退出。
- `active` 之后在模型调用、密钥读写与导入导出、Agent 接入和其他业务入口校验主进程授权状态。系统恢复后在下一次敏感操作前复验。授权存储与项目分离，授权文件使用同卷临时文件、原子替换、单写者。历史最大授权序号和上次已接受的系统 UTC 用于识别普通回拨和旧文件覆盖。离线且由本机控制的时间无法对抗全盘快照回滚。签发人可签其签发范围内的设备撤销名单，离线根签署签发人撤销及最低发行版策略。策略带递增序号，管理方导入后生效。永久授权没有自然到期日，设备完全隔离且未收到撤销文件时，签发端单独停用台账不会改变设备端授权。

### 3.4 研发接口和发证命令

Windows 原生适配器只暴露 `probe`、`createDeviceKeys`、`readPublicKeys`、`attestChallenge`、`sign` 和 `unwrap`。在主进程用异步受控调用。`sign` 与 `unwrap` 只在授权服务及密钥库内部调用，preload 无通用私钥操作。固定容器身份，密钥丢失时进入重新登记流程，禁止在后台自动重建并继续运行。对不可用、容器不存在、证明校验失败分别返回可诊断错误。

签发 CLI 的目标接口如下。`enroll-ek` 需要管理员核验实体设备，`issue` 只处理已经完成挑战的申请，必须指定 `--days` 或 `--permanent` 中的一项，两项互斥。两条签发示例使用不同挑战的证明文件。`revoke` 只写签名撤销文件与台账。命令行参数、Shell 历史和环境变量无私钥口令。

```powershell
cs-issuer enroll-ek --request .\device.csreq --asset CS-017
cs-issuer challenge --request .\device.csreq --out .\device.cschallenge
cs-issuer issue --proof .\device.csproof --role recipient --days 30 --out .\device.cslicense
cs-issuer issue --proof .\device-permanent.csproof --role recipient --permanent --out .\device-permanent.cslicense
cs-issuer inspect --file .\device.cslicense
cs-issuer revoke --license-id 83887d51-f21a-40fb-85b2-47a5764a00de --out .\revocations.cspolicy
```

## 4. 模型 API Key 从导出到使用

### 4.1 首页交互

1. 接收电脑从「模型设置」导出签发人认证的接收设备凭证。凭证含有效 `.cslicense` 及 `K_wrap` 公钥，公钥摘要必须和签名授权匹配。发放员导入凭证，界面展示已登记设备摘要及到期时间或「永久有效」，人工确认目标电脑。
2. 发放员在全局模型设置点「导出」。弹窗顺序是设置密码、再次输入密码、接收设备和 API 密钥多选。列表按供应商连接或共用 Key 分组，显示对应模型，默认全不勾选。至少选一项才可导出。显示供应商名称和模型名称，列表、预览、复制和详情无明文 Key。密码用独立渠道交给接收者，建议随机生成至少 20 个字符。
3. 接收者点「导入」，选择 `.cskeys` 并输入密码。主进程先验签发人权限、接收方及文件完整性，再尝试解封装和口令验证。完成后预览供应商和模型，确认才保存。覆盖现有连接需要明确确认。同一个 Key 供多个模型使用时，文件包含所选 Key 及该连接对应模型。供应商级模型限制要在供应商侧配置。

### 4.2 `.cskeys` v2 的加密和验证顺序

1. 主进程仅读取用户选择且允许发放的自有密钥。为每个包生成 32 字节设备秘密 `S`，用接收者 `K_wrap` 公钥做 RSA-OAEP 封装。生成 16 字节随机 salt，异步 `scrypt` 从密码 UTF-8 字节导出 32 字节 `P`。固定 `N=131072, r=8, p=1, maxmem=256 MiB`，单进程一次只执行一个口令派生。密码按用户输入的字节处理，不截断、不自动规范化，主进程限制密码长度为 20–256 个 UTF-8 字节并检查包体。低配机器先基准测试，生产参数变更以新协议版本发布。[Node.js Crypto](https://nodejs.org/api/crypto.html) · [OWASP scrypt 参数](https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html)
2. `HKDF-SHA256(ikm=S || P, salt=salt, info="CS/keys/v2/aes", len=32)` 得到包的内容密钥。用 AES-256-GCM 加密选中的供应商和模型负载，每包独立随机 12 字节 nonce、16 字节标签。JCS 规范化公开头部作为 AAD，包含格式版本、包 ID、接收者完整公钥摘要、签名者公钥摘要、签发和失效时间、salt、nonce 及封装后的 `S`。供应商配置、端点和明文 Key 全部在加密负载内。[HKDF](https://www.rfc-editor.org/rfc/rfc5869) · [OWASP 加密存储](https://cheatsheetseries.owasp.org/cheatsheets/Cryptographic_Storage_Cheat_Sheet.html)
3. 发放员 `K_sign` 为头部、密文、认证标签和发放员授权签名，使用 `CS/keys/v2/sign` 用途前缀。接收者先做文件尺寸、Schema、版本、签发链、发放员 `credentials.export`、接收者公钥摘要、签名和失效检查，再调用 TPM 及 scrypt。密钥包有独立的导入窗口，默认从导出起 7 天。接收者或发放员持有按天授权时，取密钥包和双方适用到期时间中最早的时间。永久授权没有到期时间参与比较。文件上限 4 MiB，最多 64 个连接及每连接 128 个模型，超限时分批。错误密码和认证失败用同一个对外提示。错误路径均不得产生部分导入。
4. 先解密、验证负载与加密新存储，再在一个 SQLite 事务中提交配置、模型和已导入包 ID。相同包重复导入提示已导入，缺少文件或操作取消不落库。私钥材料留在 TPM，解封装中间值和 Buffer 及时清理。对 JS 运行时无法证明完全清零的字符串，限制生命周期和跨进程传播，禁止生产进程自动上传内存转储。

### 4.3 本机密钥库及旧配置迁移

- 高保密包用独立的版本化本机密钥库。每条密钥生成随机内容密钥做 AES-GCM，再由本机 `K_wrap` 公钥封装内容密钥。AAD 至少绑定连接 ID、规范 HTTPS 来源、凭据来源和凭据权限。只允许主进程在有效授权下取明文，并在发请求时短时使用。列表从安全元数据判断是否有密钥。对手动录入允许输入，保存后主进程不向 renderer、Agent 或诊断接口返还。加密失败拒绝保存，保留旧密文和原配置。
- 已发放的 Key 绑定已签名的供应商来源。改地址、代理配置或身份头需要重新授权该连接。主进程只向匹配的允许来源发送鉴权头，强制 TLS 验证，禁用自动携带凭据的重定向并校验适配器实际请求地址。对鉴权自定义头使用相同保护或拒绝该配置。普通项目内容、用户脚本、模型返回和 Agent 参数无法指定凭据发送地址。生产日志、日志包、导出包预览和异常均扫验假密钥与假认证头。
- 既有 `enc:` 数据由原 Windows 账户在激活后的迁移事务中读取。两张表逐项验证后改为设备密文，迁移失败保留原值并报告待修复数量。发现 `plain:`、裸值或历史密码包时，视为曾经存在可复制副本，先在供应商侧轮换旧 Key，再用新 Key 发放。历史 v1 密钥包在正式使用者包中禁用导入和生成，确有需要时由发放员在原账户、隔离环境中做一次迁移后重新导出 v2。历史快照、SQLite WAL、备份和旧机器上的 Key 按轮换与受控保留处理。
- 使用者许可证可调用导入的 Key，不能查看或再导出。若要求限制真实调用次数、模型、金额和作废时间，给每台授权机器分配单独的供应商子 Key，设置模型和额度并可撤销。供应商不支持对应限制时，只有部署受控代理并把真实 Key 留在代理，才可以执行这些约束。代理属于额外在线依赖，首版离线授权不依赖它。[Windows `safeStorage` 的隔离边界](https://www.electronjs.org/docs/latest/api/safe-storage)

## 5. 安装包和发现篡改后的动作

### 5.1 构建和发行

1. 升级受支持的 Electron。隔离复现 ASAR 目录索引故障，验证原生 SQLite、Canvas、FFmpeg、Python runner、IPC、素材入库、导出及项目恢复。JS 主进程、preload、renderer 进 `app.asar`，只解包必须原生加载或外部执行的文件。测试入口和开发标志从发布入口剔除。建立安装目录白名单，打包后扫描 source map、调试代码、测试根和凭据。
2. 独立的签名 Agent 客户端承接 CLI/MCP，客户端只连接主进程提供的本地受控通道。激活成功后才开启外部接入。保留既有认证、操作目录和能力范围。安装验证覆盖 `--local-agent-access`、默认路径、冷启动、退出、未授权的调用错误和过期令牌。开发运行参数与测试产物不提供生产绕行。
3. 在最终签名前启用 `EnableEmbeddedAsarIntegrityValidation`、`OnlyLoadAppFromAsar`。完成 Agent 迁移后关闭 `RunAsNode`，同时关闭 `EnableNodeOptionsEnvironmentVariable` 和 `EnableNodeCliInspectArguments`。CI 读取最终 EXE 的 fuse 配置和 ASAR 完整性资源。主窗口和授权窗启用 `contextIsolation: true`、`nodeIntegration: false`、`sandbox: true`，逐项迁移现有非沙箱 preload，校验发送者及顶层 frame，收紧导航、权限和 CSP。生产入口拒绝未经批准的调试开关、替代数据根和测试入口。用生产包验证现有项目媒体和本地资源可正常使用。[Electron ASAR 完整性](https://www.electronjs.org/docs/latest/tutorial/asar-integrity) · [Electron Fuses](https://www.electronjs.org/docs/latest/tutorial/fuses) · [Electron 安全指南](https://www.electronjs.org/docs/latest/tutorial/security)
4. 将包外自有二进制签名。对实际装载的 `.node`、脚本、动态库、媒体工具和其他 `app.asar.unpacked` 资源生成发行签名清单，使用固定发行公钥验签并逐项核对 SHA-256。用 ASAR 内最小引导入口先核验，后加载依赖包外组件的主进程模块，避免顶层静态导入提前加载。安装目录位于 `Program Files`，普通账户无修改权限。包外文件的校验和目录 ACL 同时启用，运行中不能从项目或临时目录加载替代代码。[electron-builder v26 打包内容](https://www.electron.build/v26/docs/contents/) · [Windows SignTool 验签](https://learn.microsoft.com/en-us/windows/win32/seccrypto/using-signtool-to-verify-a-file-signature)
5. CI 先验证 App 内资产和签名清单，再签最终 EXE 和 NSIS 安装器并加 RFC 3161 时间戳，验证预期发布者、证书链和哈希，生成含 Git 提交、唯一递增发布号、签名者、依赖锁文件和 SHA-256 的发布记录。首版由管理员分发签名安装器。桌面快捷方式直接启动已安装 EXE，关于页显示版本、提交号及授权状态。任何改动安装产物的步骤都必须在最终签名之前。[Authenticode 时间戳](https://learn.microsoft.com/en-us/windows/win32/seccrypto/time-stamping-authenticode-signatures)
6. 管理员先在测试机用 Windows App Control for Business 的审计模式验证所有正式依赖，再切强制模式。按发布者、文件身份和最低允许版本放行正式包，覆盖辅助组件并按企业基线控制可执行脚本和通用运行时。组织保管策略更新和恢复凭据。同步开启 Secure Boot、BitLocker 和独立 Windows 普通账户，确认项目盘与备份均受保护。无法控制管理员和系统执行策略的电脑，只能按客户端加固等级验收。[Windows App Control](https://learn.microsoft.com/en-us/windows/security/application-security/application-control/app-control-for-business/) · [BitLocker](https://learn.microsoft.com/en-us/windows/security/operating-system-security/data-protection/bitlocker/)

安装前核对 TPM 和磁盘状态，用 Windows SDK 的 SignTool 验证交付物。签名验过后还要核对发布记录里的预期发布者及 SHA-256。首次试点先演练备份恢复，再切换系统应用控制的强制策略。

```powershell
Get-Tpm | Select-Object TpmPresent,TpmReady
Confirm-SecureBootUEFI
Get-BitLockerVolume | Select-Object MountPoint,VolumeStatus,ProtectionStatus
signtool verify /pa /all /v .\canvas-studio-setup.exe
Get-FileHash .\canvas-studio-setup.exe -Algorithm SHA256
```

### 5.2 锁定、诊断和恢复

| 触发 | 立即处理 | 恢复路径 |
| --- | --- | --- |
| 授权缺失、过期、撤销或设备不匹配 | 停在授权页，只提供设备申请、导入授权和退出。已运行时停收新任务，关闭 Agent 和凭据通道，清理会话中的临时秘密。仅在包完整性仍可信的情况下允许既有工作区做有界的本地保存 | 导入新授权或正确授权。若当前授权仍有效，导入失败时继续保留它 |
| TPM 暂时不可用或被清除 | 拒绝解锁并保留密文，显示可重试或换机的区分提示 | 恢复同一设备密钥或重新登记。旧设备已失去私钥时在供应商侧重发 Key，项目由独立备份恢复 |
| ASAR、清单、外置模块或代码签名校验失败 | 停止启动。已运行时断开接入、停止请求并安全退出。完整性无法确认时停止业务写入 | 使用事前保存的官方签名包修复安装。系统提前拦截时，以 OS/安装器日志定位 |
| 确认某台设备或已发放 Key 被盗用 | 管理员在台账停用设备，为可联系机器分发签名撤销文件，并撤销供应商 Key | 新设备重新走发证、发放新 Key 和项目恢复。离线旧机收到撤销文件前，按天授权可在原期限内使用，永久授权继续有效 |

软件采用锁定和修复流程。怀疑篡改时不会自删、破坏数据库、清空媒体、清 TPM 或永久销毁密钥。升级、重装、退出和卸载均独立于数据销毁。保留用户原始项目和独立备份。故障页面给出稳定的原因码和操作指引。

授权检查建议记录 `license.check.started` 和唯一 `license.check.completed` 或 `license.check.failed`。迁移与导出分别记录开始、完成、拒绝、取消或失败，复用现有 trace 和 `provider.export.*`。启动早于业务数据库的阶段使用与项目无关的现有诊断落点或最小适配。仅记录版本、操作类型、阶段、原因码、耗时、可重试和计数，不记录公钥、EK/AK、原始证明、设备码、签名文件、密码、供应商头或 API Key。日志拒写时保持相同的授权判定。ASAR 在 JavaScript 启动前拒绝时，验收证据以系统或安装器日志为准。[日志规范](../LOGGING_SPEC.md) · [日志检查模板](templates/LOGGING_CHANGE_TEMPLATE.md)

## 6. 实施顺序和出包条件

| 阶段 | 责任与提交 | 阶段通过条件 |
| --- | --- | --- |
| P0 预研和基线 | Windows 原生、发布和测试。固定现有数据样本与 Git 提交，准备两台不同实体 TPM 电脑及一台用于反例的虚拟机。验证 CNG 两种密钥、持有证明、EK 信任和互通。另行验证 Electron 升级、ASAR、原生模块和 CLI 迁移路径 | 真实 A 可签名和解封装，真实 B 不能使用 A 私钥。软件密钥和替换公钥被拒绝。安装包完整性实验可以重复，列明通过机型和有阻塞的设备 |
| P1 启动锁和签发工具 | 主进程、桌面 UI、原生层。新建发行专用安全模块和最小授权窗，接到 `app.whenReady`。实现离线 `challenge`、`issue`、`revoke`、`inspect` CLI 与签发台账。发证工具不随客户包分发 | 按天和永久两种授权均可在 A 离线激活、重启并正常使用。B 复制全套文件仍进不了工作区。未授权实例没有项目数据库写入和外部接入。错误续期保留旧授权，正常换机恢复通过 |
| P2 密钥库和指定设备导出 | 模型设置、主进程网关、SQLite。保留首页入口和多选交互，接入 v2、TPM 库、端点绑定、旧格式迁移和诊断 | A 发放所选 Key 到 B，正确密码在 B 导入。同一包和密码在 A 或另一台非接收设备上导入失败。B 无查看、重导或借改地址外发密钥的路径，旧库迁移失败可回滚 |
| P3 签名发布和客户端封闭 | 发布、Windows 运维、Agent 接入。签名、Fuses、ASAR、包外校验、Agent 客户端、App Control，完成版本和快捷方式交接 | Windows 真实安装和卸载演练通过，正常签名包可用，改包被拒绝，旧版绕行被管理策略拦截，项目和密钥密文保留 |

P0 应先排 3–5 个工程工作日，按两台实体机和证书链实测结果拆 P1–P3 工期。首批安全发行需要 P0–P3 全部通过。签发、Windows 发布和安全复核由不同职责把关，个人维护时至少分开使用签发环境和发布环境。

### 6.1 必须执行的验收

| 场景 | 通过标准 |
| --- | --- |
| 未授权、错误签名、错产品、过期、已撤销、重复和超限文件 | 只有授权窗可用。无新项目数据库或迁移写入，无媒体处理器、业务 IPC 和 Agent 调用通道 |
| 同一电脑换网、断网、重启、休眠恢复及更新 | 官方授权正常。无启动联网依赖。更新前后项目和媒体验证通过，离线更新后快捷方式仍指向正式版本 |
| 复制安装目录、用户配置和授权到另一台实体机，替换两个公钥或用软件 TPM | 目标机无法取得有效硬件证明或持有原私钥，业务入口全部拒绝 |
| 期限选项、到期、回拨、续期、签发人换钥、主板更换或重装 | 未选择期限、同时传入两种期限和非法天数均拒绝签发。按天授权在签发时间加指定天数时过期。永久授权在签发证书自然到期后仍通过校验，导入有效撤销后停止使用。两种授权均不可跨设备使用。整个离线系统快照回滚的边界登记为已知限制 |
| v2 导出选择两项，错设备、错密码、改头、改签名、重导或导入中断 | 仅两项入包。正确目标和密码同时具备才可导入。无部分落库，重导可识别，未选择项、假密钥和认证头在输出中均无泄漏 |
| 修改模型端点、重定向、鉴权头、请求来源及调用 IPC | 导入凭据只发送到已批准的来源。使用者无明文或重导路径。授权页 preload、外部 Agent 与未信任 frame 不能调用敏感接口 |
| 替换 ASAR、外置脚本、DLL、独立 Agent 客户端，启用 Node 运行或旧版启动脚本 | 生产包或系统策略阻断，记录预期原因，原项目、素材和密文内容校验一致 |
| 拔盘和恢复 | BitLocker 恢复手册可用。清 TPM 后原 Key 无法复用。新设备可用新授权、无密钥项目包和轮换后的 Key 恢复工作 |

每包执行新增定向测试、`npm run verify:logging`、`npm run verify:agent-access` 和 `npm run verify`，发布包另做 Windows 安装和双机实测。按两份变更模板登记错误码、Agent 能力和 schema 影响。既有外部接入操作不增加授权或密钥管理接口，现有能力的准入条件和错误路径更新到矩阵、影响登记和端到端测试。验收记录写明系统版本、硬件型号、应用版本、提交、签名及各项结果。测试只用隔离数据、测试根、假供应商密钥和本地模拟服务。[Agent 变更模板](templates/AGENT_ACCESS_CHANGE_TEMPLATE.md) · [能力清单](local-agent-access/02-capability-matrix.md) · [日志覆盖清单](LOGGING_COVERAGE.md)

本文件是设计交付。TPM 互通、签名安装包、ASAR 恢复和双机测试属于实施验收，当前尚无实测结论。
