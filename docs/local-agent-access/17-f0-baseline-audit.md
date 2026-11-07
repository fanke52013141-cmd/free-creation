# F0 基线审计：动作分母、32类节点与现状证据

日期：2026-11-08。基线提交：`3b1f2ab`（main），工作区含进行中的授权/密钥库/发行版未提交修改（保留，不并入本任务）。
本台账落实[完整计划](15-gui-cli-mcp-parity-plan.md) F0：把"全部"列成机器可审计清单，并记录可复现基线证据。

## 1. 可复现基线证据（2026-11-08 本工作区实测）

| 检查 | 命令 | 结果 |
| --- | --- | --- |
| 类型检查（node+web+license-protocol+issuer） | `npm run typecheck` | 通过（exit 0） |
| 外部接入定向测试（含真实 CLI 子进程与 MCP stdio） | `node scripts/run-vitest.cjs run test/local-agent-access.test.ts --reporter=dot` | 38 项全部通过 |
| 业务动作分母审计 | `node scripts/audit-business-actions.cjs` | 通过：171 IPC 通道 + 34 画布动作 = 205 项，25 项外部操作全部有映射 |
| 接入门禁 | `npm run verify:agent-access` | 仍阻断：`change-impact.json` 源码哈希与工作区不一致（存在其他进行中修改）。按工作区要求不批量刷新他人修改的哈希；本任务修改的受保护文件随各工作包刷新并写明影响范围 |

注意：以上是**当前开发工作区**的证据。干净克隆构建与安装包复现在 F10 执行；本工作区存在并行未提交修改（`packages/license-protocol/`、`src/main/security/`、`src/main/ipc/license.ipc.ts` 等），已确认 `typecheck` 与定向测试在其存在下通过，即当前实现不依赖缺失模块。

## 2. 业务动作分母（机器清单）

- 登记文件：[action-coverage.json](action-coverage.json)（人工维护、逐项登记阶段与理由）
- 审计脚本：`scripts/audit-business-actions.cjs`（从 `src/shared/contracts/index.ts` 解析 IPC 通道全集 + 画布级动作声明，校验无漏项、无陈旧项、external 映射真实存在）
- 生成产物：[generated/action-inventory.json](generated/action-inventory.json)

分母口径：**205 项业务动作**（171 个 IPC 通道 + 34 个画布级 GUI 动作）。按现状：

| 现状 | 数量 | 说明 |
| --- | --- | --- |
| external（当前 25 项操作已覆盖或部分覆盖） | 15 | 部分覆盖已在 note 标明子集边界 |
| excluded（无外部业务语义） | 18 | 逐项写明理由：呈现辅助、内部通知/遥测通道、历史退役、安全边界（密钥导出）、应用生命周期 |
| planned F2 | 14 | 画布读写编辑、关闭项目 |
| planned F3 | 6 | 执行/运行/取消/结果选择 |
| planned F4 | 11 | 文件/图片素材与执行 |
| planned F5 | 21 | 视频/音频/时间线 |
| planned F6 | 10 | 对话/Skill/网址/导演台 |
| planned F7 | 41 | 库/历史/恢复/传输/导出 |
| planned F8 | 25 | 内部 Agent Flow/命令/资产 |
| planned F9 | 44 | 模型/连接/凭据/环境/设置/诊断/授权 |

excluded 清单（审计强制逐项理由）：`project.external-change`、`media.video-audio`、`media.vocal-separate`、`media.pick`、`media.reveal`、`media.copy-path`、`media.open`、`media.tts-generate`（历史通道，节点执行取代）、`workspace.*timing*`×4（性能遥测）、`gateway.event`（流式通道经 run 协议）、`keys.export-credential`（安全边界）、`diagnostics.node-run:event`、`diagnostics.event`、`license.exit-app`、`canvas.view.viewport`。

与旧口径的关系：旧文档的 25 项操作、31 类节点计数、最小包排除条款保留为历史基线；本表是当前权威分母，后续每包更新 action-coverage.json 并保持审计通过。

## 3. 32 类节点矩阵

逐节点动作清单、当前外部状态与验收重点见 [32类节点动作表](16-node-action-coverage.md)（F0 复核：`ACTIVE_NODE_TYPE_IDS` 32 类与 `NODE_ACCESS_DECLARATIONS` 32 项一致，`node.type.list` 仍全部返回 planned，与代码事实一致）。每类节点 N1–N8 公共动作 + 专有动作的关闭记录格式以该表第 5 节为准。

## 4. 缺口登记（F0 结论）

1. **画布读写未接入**：外部无法读取图内容、创建/修改/删除节点与连线；桌面握手当前仅支持 open/flush/rename/bind-skills 四动作（`src/shared/agent-access/desktop.ts`）。
2. **执行未接入**：`node.execute`、run 族（wait/events/cancel/reconcile）、output 族均未开放；`run.get` 仅内部 Flow 任务。
3. **多画布宿主**：外部操作活动画布外的项目需先 `project.open`（桌面切换）；无后台宿主。串行多画布按 F2 口径实现，并发在 F8。
4. **门禁现状**：`verify:agent-access` 检查登记/快照/哈希；F0 新增动作分母审计为静态门禁。三入口目录一致性、持久化对照、故障恢复门禁按 F1/F9 计划补齐。
5. **未验收项**：真实 Electron 画布的绑定验收、安装包验收、干净克隆构建（F10）；真实付费模型验收需预算授权（F4/F5/F6 分组执行）。

## 5. F0 验收对照

| 计划要求 | 状态 |
| --- | --- |
| 每个现有 GUI 业务动作都有唯一 ID、现状、计划阶段 | ✅ action-coverage.json 205 项，审计脚本强制无漏项 |
| 32 类 Active 清点 | ✅ 代码与 16 号文档一致（32=32） |
| 基线可复现（类型检查、定向测试） | ✅ 本台账第 1 节；干净克隆构建登记为 F10 待办 |
| 缺陷/缺口列表 | ✅ 第 4 节 |
| 新增测试仅针对基线缺口 | ✅ 本包仅新增静态审计脚本（无运行时行为变更） |
