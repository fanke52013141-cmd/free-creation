# F1/F2 交付：画布读取与批量图编辑外部接入

日期：2026-11-08。基线：F0（`daf0f7e`）。本包把外部 CLI/MCP 从"只能管理项目"推进到"能读写画布"。

## 1. 实际完成的业务动作（GUI / CLI / MCP 状态）

| 业务动作 | GUI | CLI | MCP | 公共实现 |
| --- | --- | --- | --- | --- |
| 读取画布节点/连线/分组视图（分页） | ✅（画布本身就是该数据的权威呈现） | ✅ graph.get | ✅ graph_get | persisted 视图读 projects.repo；latest 视图经桌面握手 read-graph 取权威宿主当前状态 |
| 读取单节点配置/正文/端口/连线 | ✅ | ✅ node.get | ✅ node_get | 同上（persisted） |
| 批量创建节点（含正文/配置/位置/尺寸/标题） | ✅ | ✅ graph.patch | ✅ graph_patch | 桌面握手 graph-patch：renderer 用与 GUI 同源的 Spec/createEdge 校验并原子应用 |
| 修改节点标题/正文/配置/位置/尺寸/层次 | ✅ | ✅ 同上 | ✅ 同上 | node.update op；动态端口变化预检，不静默删除用户连线 |
| 删除节点（级联清理连线） | ✅ | ✅ 同上 | ✅ 同上 | node.delete op |
| 创建连线（类型/Schema/基数/占用/重复/成环校验） | ✅ | ✅ 同上 | ✅ 同上 | edge.create op + connectOrder |
| 删除连线 | ✅ | ✅ 同上 | ✅ 同上 | edge.delete op |

未接入（如实登记）：组合/解组、批量对齐命令、复制粘贴的专用映射（可由组合表达，未单列验收）、跨 ref 的边改接专用语义。均保留在 [action-coverage.json](action-coverage.json) F2 计划项。

## 2. 公共契约与一致性处理

- `src/shared/agent-access/graph-ops.ts`：graph.patch 的 5 种 typed op（node.create/update/delete、edge.create/delete）的 zod Schema、上限常量（≤200 op、正文 ≤200k 字符、config ≤64KiB）、`toGraphView` 读取投影（两种视图同构、不泄漏 config/正文）、main 侧结构预检 `resolvePatchReferences`。
- 寻址约定：`shape:` 前缀为持久化节点 ID；无前缀为同批 node.create 声明的 `ref`，回执返回 `created:[{ref,nodeId}]` 映射。
- Registry 新增 graph.get/node.get/graph.patch（28 项操作），CLI/MCP 工具目录由同一 Registry 自动生成，两入口无实现分叉。
- 错误信封新增可选 `detail`（≤300 字符，仅含稳定码/序号/端口 ID，不含用户内容）；桌面回执新增 `validated/errorCode/errorDetail/result` 可选字段。均为加字段，无删除或改名，旧客户端不受影响（`--accept-contract-change` 已随影响说明显式确认）。

## 3. 提交协议（严格按计划 §4.2）

预检（main：Schema、上限、引用可解析、占用、恢复副本）→ 权威宿主整批校验（renderer：真实节点 Spec、端口解析、类型/Schema 兼容、基数占用、重复、成环、动态端口变化影响）→ 保存用户未保存内容（flush，先于一切变更协调）→ 版本核对（expectedGraphVersion 不符返回 REVISION_CONFLICT，不覆盖）→ main 准入（占用+版本+任务占用核对）→ 准入后整批重校验 → 单撤销步原子应用 → 保存屏障 → main 读取磁盘核对每个回执 ID → 回执（graphVersion/saved/created/applied）。

失败语义：准入前校验失败 → `failed` + 稳定码（整批不留半图）；准入后任何失败 → `unknown`（OUTCOME_UNKNOWN，按确定 ID 与 graph.get 核对，不自动重放）。

## 4. 验证证据（本工作区实测）

| 检查 | 结果 |
| --- | --- |
| `npm run typecheck`（node+web+license-protocol+issuer） | 通过 |
| `test/local-agent-access.test.ts`（含真实 CLI 子进程与 MCP stdio） | 38 项通过 |
| `test/local-agent-graph-access.test.ts`（新增：读取分页/不泄漏、非打开项目拒绝、预检、幂等回执、unknown 保守语义、validated 失败映射、上限拒绝） | 9 项通过 |
| `test/graph-patch-plan.test.ts`（新增：规划器拒绝矩阵——占用/重复/成环/悬空动态端口/未知引用/超大配置/无效操作；created 映射与级联删除） | 8 项通过 |
| `npm run verify:agent-access` | 通过：28 操作 + 32 planned 节点 |
| `node scripts/audit-business-actions.cjs` | 通过：206 动作分母（25 项 external） |
| `test/node-compliance.test.ts` | 通过（节点注册面未受影响） |

## 5. 日志覆盖

复用 `agent.access.started/completed/failed/rejected/unknown` 统一生命周期（唯一终态拥有者不变），新增操作自动纳入；错误 detail 仅含稳定码与结构标识（op 序号/端口 ID/节点 ID 前缀），不记录提示词、正文、配置值或路径。脱敏断言在测试中验证 config/text 不进入目录读取与日志（`private-config-value`/`private-text-*` 断言）。日志写入失败不改变业务结果的既有测试继续有效。

## 6. 尚未支持 / 仅模拟验证（不得宣称为完成）

1. **真实 Electron 画布的 graph-patch 握手验收未做**：renderer 侧应用路径目前由规划器单测 + mock 宿主服务测试覆盖；真实桌面（Tldraw editor + 保存协调器）的端到端验收属于首个里程碑验证包（进行中），未完成前不宣称桌面已验收。
2. **多画布串行宿主流程**：graph.patch 目前仅对"当前打开项目"开放（未打开返回 ACTIVE_PROJECT_REQUIRED + project.open 指引）；A/B/C 三画布串行建立→执行→保存→重启→GUI 核对的完整场景在里程碑包验收。
3. **latest 视图**经桌面握手读取（含未保存编辑 + unsaved 标志），其与 flush 时序的实测未做。
4. 付费模型无关（本包不含模型调用）。

## 7. 下一工作包

F3：node.execute + run.get/list/wait/cancel + output.list/get/select 骨架；文本/JSON/processor 确定性节点闭环；随后执行里程碑场景（A/B/C 三画布批量建图→执行→保存→重启→GUI 核对，含非法操作不留半图与不覆盖未保存修改的桌面实测）。
