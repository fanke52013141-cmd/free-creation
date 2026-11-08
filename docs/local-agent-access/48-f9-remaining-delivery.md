# F9 剩余项收敛：调色板偏好、诊断导出、模型定义批量删除

日期：2026-11-08。基线：`818852c`（113 项操作）。本轮把 F9 剩余 30 项里**能安全开放的 4 项**
做完并验收，其余 26 项逐项写明为何暂不开放。操作数 113 → **117**。

## 1. 本轮开放（4 项）

| 操作 | 效果 | GUI 同一动作 | 关键边界 |
| --- | --- | --- | --- |
| `workspace.palettePreferences.get` | read | 调色板设置读取 | 纯界面偏好，不含项目数据/密钥 |
| `workspace.palettePreferences.save` | write | 调色板设置保存 | 与 GUI 同一归一化（去重、补默认顺序）；未知分类由严格 Schema 拒绝；重复保存 `changed=false` 且不落第二次写 |
| `diagnostics.exportBundle` | export | 诊断面板"导出诊断包" | **输出位置由 main 决定**（受控导出目录 + 时间戳 + 不覆盖）；范围必须给 traceId/runId/时间窗之一；回执给文件名/sha256/字节数/事件数，不返回绝对路径 |
| `model.definition.deleteMany` | write | 模型设置多选删除 | 与 GUI 同一 `deleteModels`；不存在的 ID 计入 `notFound`，不让过期 ID 把整批成功项变成失败；重复 ID 去重 |

## 2. 真实验证（`test/local-agent-f9-remaining-access.test.ts`，13 项全通过）

调色板偏好（5 项）：
1. 默认值是完整分类顺序，读取不修改状态；
2. 保存后读回一致、重复项去重、缺失分类补齐（集合大小 == 全部分类）；
3. **未知分类被严格 Schema 拒绝**（不是"悄悄忽略后照常保存"）；
4. 重复保存相同内容 `changed=false` 且存储值不变；
5. 同幂等键重放返回原回执。

诊断导出（5 项）：
1. 无范围 → `INVALID_INPUT`（不允许导"全部事件"）；
2. 服务不可用 → `DIAGNOSTICS_UNAVAILABLE`（不返回空包冒充成功）；
3. 成功路径：文件真实落在受控导出目录、`sha256` 与文件字节一致、字节数/事件数正确、
   **回执不含绝对路径与目录名**；
4. 范围透传给同一 `exportBundle`（traceId/runId/时间窗）；
5. 带 `filePath` 等多余字段 → `INVALID_INPUT`（不接受任意输出路径）。

模型定义批量删除（3 项）：
1. 已存在被删、不存在计入 `notFound`，删除后单删返回 `NOT_FOUND`；
2. 空列表被 Schema 拒绝；重复 ID 只删一次；
3. 幂等重放不重复删除。

## 3. 仍未开放的 26 项及原因

| 组 | 数量 | 不开放原因 |
| --- | --- | --- |
| `ipc.keys.*`（供应商/密钥/凭据包/provider 测试与探测） | 12 | 供应商密钥与凭据包属于**更高阶密钥迁移协议**（封包/预览/导入涉及安全边界与用户确认），且 `testProvider/probeProvider` 会向供应商发真实请求。需要独立的"凭据包契约 + 去敏回执 + 供商探测预算授权"。 |
| `ipc.keys.dreaminaLoginStart/Check` | 2 | 第三方登录必须真人完成。真要做，需要"外部 prepare → 人在 GUI 完成 → 外部 status/continue"的协作者身份协议（与导演台发布同量级），且不得伪造登录成功。 |
| `ipc.models.discover` | 1 | 会向供应商 `/models` 发请求（消耗密钥配额、可能被限流）。需用户明确授权"网络请求边界"后再开放。 |
| `ipc.models.validate` / `validateAgentToolCalling` | 2 | 会真实调用模型（可能计费）。用户当前明确要求生成类不做真实调用；验证是付费路径，需预算授权。 |
| `ipc.license.*` | 8 | **安全红线**：授权状态读取、设备探测、申请/挑战/证明/授权/策略导入都属授权体系，外部 Agent 不得绕过或代签（`AGENT_PARITY_SPEC §6`）。已在我的开发机激活脚本中用合法路径处理，不进入产品外部接口。 |
| `ipc.diagnostics.exportNodeRun` | 1 | 该导出依赖 **renderer 内存中的运行记录**（runs 数组由界面提供），main 没有等价稳定事实源。要开放需先把"节点运行历史"持久化成可查询契约（属独立包）。 |

## 4. 顺带的修复与说明

- **补提交遗漏**：上一轮 F9（四）提交漏掉了 `registry.ts` 里 `MODEL_ADMIN_*` 的挂载
  （工作区生效但未入库），本次一并提交——否则干净检出会编译失败。
- `diagnostics.exportBundle` 的 F9 分组分支此前只匹配 `diagnostics.query`，新增操作必须同时
  加入 dispatch 分组条件，否则会落到 `UNSUPPORTED_OPERATION`（测试已覆盖该路径）。

## 5. 数字

- 外部操作：113 → **117**
- external 业务动作：116 → **120**
- F9 未开放：30 → **26**（全部有上述理由）
- 新测试：13 项通过
