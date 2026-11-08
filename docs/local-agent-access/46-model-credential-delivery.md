# F9（四）：模型连接与受控凭据写入

日期：2026-11-08。对应 `ipc.models.saveConnection / deleteConnection / saveDefinition /
deleteDefinition / saveBinding` 与"模型设置里显示的密钥状态"。

## 1. 为什么要做、边界在哪

用户目标"人能做的 Agent 也能做"里，**配模型**是关键一环：Agent 不能配模型，就等于
所有生成能力都用不上。但凭据是敏感面，`AGENT_PARITY_SPEC §6` 明确要求：
可通过受控写入或秘密引用配置，**不得在参数示例、shell 历史、stdout、能力目录、诊断或项目包中
返回明文**，且不得绕过既有设备密钥/授权规则。

因此本包只做"受控写入 + 不可逆指纹核对"，**不开放**任何能拿到明文或绕过安全机制的动作：

| 动作 | 是否开放 | 原因 |
| --- | --- | --- |
| 连接创建/更新（含 API Key 写入） | ✅ `model.connection.save` | 复用 GUI 的 `saveConnection`（设备绑定密钥库 + 授权守卫） |
| 密钥是否存在 / 指纹 | ✅ `model.credential.status` | 只回 `present + sha256:12` 指纹 |
| 连接删除（连带模型定义） | ✅ `model.connection.delete` | 与 GUI 删除同一宿主方法，回执给被删模型数 |
| 模型定义创建/更新/删除 | ✅ `model.definition.save / delete` | 不涉及凭据 |
| 功能默认绑定 | ✅ `model.binding.save` | **只在"该模型该操作已验证"时成立**（宿主强制） |
| 模型发现 / 模型验证 | ❌ 不开放 | 会向供应商发请求（可能计费/被限流）。因此**外部无法自行把模型验证成已通过**——验证仍是 GUI/人的步骤，绑定随之受限，绝不伪造"可用" |
| 读明文密钥 / 导出凭据包 / 密钥库绕行 | ❌ 永不开放 | 违反 §6 与设备密钥规则 |

## 2. 实现要点

- 唯一实现：`src/main/agent-access/model-admin-ops.ts` 全部委托 `SqliteModelHost`
  （GUI 模型设置同一类），没有新的存储、加密或校验路径。
- 明文生命周期只在本进程内：写入走宿主的设备绑定密钥库；读取仅用于计算
  `sha256(secret).slice(0,12)` 指纹；**既不回传也不进日志/诊断**。
- 回执只给 `baseUrlHost`（主机名），不回显 `baseUrl` 全串与 `headers`（后者可能含 Authorization）。
- `invalidatedBindings`：连接的事实（协议/地址/请求头/密钥）变化会让宿主清除该连接的
  验证与功能绑定——回执如实标记，避免"改了地址却以为还能用"。
- 删除是显式破坏性动作：删连接连带删其模型定义，回执给出 `deletedModels`。
- 幂等：走 dispatch 既有幂等账本，同键重放返回原回执、不产生第二条连接。

## 3. 真实验证（test/local-agent-model-admin-access.test.ts，8 项全通过）

1. 写入密钥后：回执 `present=true`、指纹 12 位十六进制、`baseUrlHost=127.0.0.1`；
   **回执 JSON 与诊断事件 JSON 都不含明文标记**；密钥库里只有密文列（断言密文不含明文）。
2. 指纹稳定：同一密钥重复写指纹不变；**省略 apiKey 时保留原密钥**；换密钥指纹改变。
3. 连接事实变化 → `invalidatedBindings=true`。
4. `credential.status`：连接不存在 NOT_FOUND；存在时只回 present+fingerprint，无明文。
5. 删除连接：先建 2 个模型定义 → 回执 `deletedModels=2`；之后 credential.status 与
   模型定义删除均 NOT_FOUND。
6. 模型定义：连接不存在 NOT_FOUND；能力为空被 Schema 拒绝（INVALID_INPUT）。
7. 功能绑定：未验证模型 → `MODEL_NOT_VERIFIED`；写入一条验证记录（夹具模拟"人已在 GUI 验证"）后
   绑定成功——**验证操作本身没有对外的网络入口**。
8. 幂等重放：同一幂等键两次 → 回执相同、库里只有一条连接。

## 4. 尚未完成 / 边界

1. **模型发现与验证仍未开放**：需要向供应商发请求。要开放必须先定"网络/计费授权"语义
   （与 node.execute 的 confirmPaid 同类），并由用户确认是否允许 Agent 直接触发验证请求。
2. **清除单个连接的密钥**（保留连接、只删 key）GUI 目前也没有独立入口，本包未造这个动作；
   如需可后续补 `model.credential.clear`（要同时清验证与绑定，属于新行为）。
3. 凭据包导出/导入（`keys.exportProviders/importProviders`）仍按既有范围阻断，
   涉及等级更高的密钥迁移协议。
4. 绑定成功后"功能是否真的可用"还取决于验证状态与模型能力，本包不宣称端到端可用。
