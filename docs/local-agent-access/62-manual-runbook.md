# 人工步骤 runbook（必须真人操作的三条路径）

日期：2026-11-08。有些能力**按设计不能由 Agent 自己完成**：导入别人的凭据、登录第三方账号、
花真钱生成内容。这三条路径必须有人在场，本文件给出可执行步骤与预期结果。

适用版本：141 项外部操作；`verify:agent-access` 通过。

---

## 一、凭据包导入（外部发起 → 人确认 → 外部继续）

**为什么必须人确认**：凭据包内含可用密钥，导入等于让这台机器获得别人账号的调用能力。
只校验一个布尔开关等于让 Agent 自己给自己盖章，无法构成人工门禁。

### 步骤

1. 把人给的 `.cskeys` 文件放进**受控导出目录**（与服务同一数据目录）：
   `<数据目录>/agent-exports/`
   - 默认路径：`C:\Users\<你>\AppData\Roaming\canvas-studio\data\agent-exports\`
2. 外部发起（Agent 侧）：
   ```json
   { "operationId": "provider.package.import",
     "input": { "fileName": "xxx.cskeys", "password": "<解封密码>", "confirmImport": true } }
   ```
3. **界面上会弹确认框**（标题「外部请求导入凭据包」），内容含：
   - 包 ID、签发设备摘要、包含几个连接、此前是否导入过
   - 只有点「允许导入」才会解密并写入；点「拒绝」返回 `HUMAN_DENIED`
4. 允许后回执：
   ```json
   { "packageId": "...", "added": 2, "updated": 0, "modelCount": 5, "humanConfirmed": true }
   ```

### 常见失败与处理

| 返回码 | 含义 | 处理 |
| --- | --- | --- |
| `IMPORT_CONFIRM_REQUIRED` | 没传 `confirmImport: true` | 补上；仍需人在界面点允许 |
| `INPUT_NOT_FOUND` | 受控目录里没有这个文件 | 确认文件名与目录 |
| `ACTIVE_PROJECT_REQUIRED` | 没有打开的画布（确认框绑定当前画布） | 先 `project.open` |
| `PACKAGE_INVALID` | 包损坏/密码错/签发设备不被信任 | 让对方重发；核对密码 |
| `HUMAN_DENIED` | 人点了拒绝 | 不要重试，先问人 |

**验收记录要求**：记录"点了允许"与回执里的 `packageId/added/updated`，以及
`provider.list` 里连接数是否 +N。

---

## 二、即梦（Dreamina）设备流登录

**为什么必须真人**：登录态是"人在浏览器里授权"的产物，Agent 只能发起与查询，
不能代替人点"授权"。

### 步骤

1. 外部发起：
   ```json
   { "operationId": "dreamina.login.start", "input": { "confirmNetwork": true } }
   ```
2. 回执三种：
   - `status: "already"` —— 本机已有有效登录，无需操作；
   - `status: "pending"` —— 带 `verificationUri` + `userCode`：**人在浏览器打开该地址、
     输入用户码并确认**；
   - `status: "failed"` —— 本机 CLI 不可用/网络失败，按 `message` 排查。
3. 轮询：
   ```json
   { "operationId": "dreamina.login.check",
     "input": { "deviceCode": "<上一步的 deviceCode>", "confirmNetwork": true } }
   ```
4. 状态流转：`pending` →（人完成）→ `success`；超时 → `expired`；异常 → `failed`。

**注意**：`success` 只代表本机 CLI 的真实登录态；不要在没有 `success` 时继续跑生成任务。

---

## 三、付费生成（生图 / P图 / 视频 / 语音 / 音色）

**为什么由你自测**：会真实计费，且涉及模型质量判断，不适合自动化刷。

### 最小验证路径（建议先用最便宜的一项）

1. 配置并验证模型（GUI 设置页，或外部 `model.connection.save` + `model.definition.save`；
   验证必须本人点，外部 `model.validate` 需 `confirmNetwork` + `confirmCost`）。
2. 建项目 → 建目标节点（如 `image-gen`）→ `graph.patch` 写配置（提示词放 `text`）。
3. `node.execute` 提交 → `run.get` / `run.wait` 读终态 → `output.get` 读产物。
4. 检查：
   - 产物是否落进项目媒体（`media.list` 能查到）；
   - 失败时 `run.get` 的错误码与 `diagnostics.query` 有对应事件；
   - 费用是否只发生一次（同一幂等键重放不应重复计费）。

### 已知边界（不要误判为缺陷）

- 未配置模型时 `node.execute` 会返回 `MODEL_BINDING_NOT_FOUND` / `MODEL_NOT_VERIFIED`——这是预期；
- 语音克隆/音色设计/视频生成按你的要求只做**代码层接通**，未做真实调用验证。

---

## 四、验收记录模板

| 路径 | 场景 | 谁点的确认 | 外部回执 | 结果 | 备注 |
| --- | --- | --- | --- | --- | --- |
| 凭据包导入 | xxx.cskeys | 人 | packageId/added | ✅/❌ | |
| 即梦登录 | 设备流 | 人 | pending→success | ✅/❌ | |
| 付费生成 | image-gen | —（计费） | runId/产物 | ✅/❌ | 费用： |

把这四列填完，就完成了"人工路径"的验收闭环。
