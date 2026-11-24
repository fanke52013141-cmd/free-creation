# 2026-11-24 BL-11 FlowGraph v2：params、真实端口与子图循环交接

状态：**已实现并提交**（本文件所在提交）；完整 `npm run verify` 退出码 0（证据 `qa/verification/run-wiPhYO/status.json`，2026-11-24T09:09–09:42Z）。
基线：`aea3987a`（2026-11-24 14:21 +08:00，`origin/main`）。

## 0. 一句话结论

FlowGraph 从「通用端口 + 单载体循环」升级为可编排真实能力：节点可带 `params`（按目标配置校验并合并）、数据边必须接真实端口且类型兼容、`loop.body[]` 支持三节点子图循环按轮次推进（每轮独立 taskId）；v1 图只读兼容。

## 1. 改动

### 1.1 params（G7）

- `FlowNode.params` 新增；`src/shared/agent-flow/node-params.ts` 登记**公开配置子集**（image-gen / video / image-edit / speech / tts / processor），未登记类型明确拒绝（`CAPABILITY_PARAMS_UNSUPPORTED`），非法值返回 `CAPABILITY_PARAMS_INVALID`。
- 编译时把 params 合并进载体固定配置（生图模型/比例/张数、视频模式/参数等生效）；复合能力暂不接受 params（用公开输入）。

### 1.2 真实端口（G8）

- `portPairCompatible` / `portCompatible` 下沉 `src/shared/port-compatibility.ts`，renderer 只重导出；`nodeSchemasCompatible` 同源。
- `validateFlowGraph` 按能力目录/节点契约校验每条边的输出/输入端口存在性与类型兼容（`PORT_NOT_FOUND` / `PORT_TYPE_MISMATCH`）；编译器**不再重映射端口**，协调器按 `edge.to.portId` 取真实端口。

### 1.3 子图循环（G3 / AF-8.4b）

- `FlowNode.loop.body[]` 新增；校验：body 必须包含载体、节点存在、唯一归属、不得嵌套、必须有出口（`LOOP_BODY_INVALID` / `LOOP_BODY_NO_EXIT`）；v1 图（无 body）的多节点环/自回边仍按 `LOOP_BODY_UNSUPPORTED` 拒绝（只读兼容）。
- 路由器：同一循环体内的边按「本轮交付」就绪（循环载体要满足退出条件才 settled）；body 出口全部交付后评估 `exitCondition`，未满足且未达上限则 `loopIterations[carrier]` 递增开下一轮。
- 协调器：子任务记录 `round`，taskId 含 `loop:<round>`，每轮独立；`graphFacts` 按轮次过滤交付事实；graph 模式下 agent 的 legacy `allowedNodeIds` 不再与图节点争用控制权。

### 1.4 顺带修复：浮层 Esc 归属

- 资源库页面的全局 Esc 快捷键在 Radix 下拉关闭（document 层先卸载浮层）后仍会关闭整个编辑器，导致「下拉里按 Esc 连弹窗一起消失」回归（`test-browser-library-forms.cjs` 复现）。
- 新增 `src/renderer/src/components/escape-owner.ts`：`ModalShell` 在捕获阶段看到内层浮层时登记归属，页面级 Esc 处理器消费该标记并跳过；标记只对本次事件有效。
- `desktop-electron.ts` 的 capability 图验收夹具把图边从通用 `in-text` 改为能力载体真实端口 `in-value`，与 BL-11 取消端口重映射后的语义一致。

### 1.5 竞争路径加固（全量负载波动）

- 全量门禁期间 `recovery-contention` 多次复现「两个恢复者双双失败」：一个 `database is locked`、一个 `GraphWriteInProgressError`。按仓库纪律不复跑掩盖，做两处有界加固：
  - `getDb()` 的 SQLite busy 超时从默认 5s 提高到 15s（`timeout: 15_000`），满载时让写者排队而不是直接失败；
  - `acquireProcessLock` 对 `SQLITE_BUSY` 有界重试 3 次（50/100ms），仍抢不到才如实抛出。
- 不影响「活进程不按超时抢占」的所有权语义；隔离复跑 3 次 15/15 通过。

## 2. 验证

| 检查 | 结果 |
| --- | --- |
| 新增单测 | `test/flow-graph-v2.test.ts`（5：params 合并/非法、复合 params、真实端口/类型、v1 拒绝+v2 编译重映射、body 载体/出口） |
| 协调器 | `test/agent-flow-coordinator.test.ts`（51：新增三节点 body 跑满两轮、round=[1,2]、taskId 全唯一；既有 v1 循环与停滞语义不变） |
| 回归 | `flow-graph-*` / capability / builder / plan / parity / access 共 **302** 项通过 |
| 铁律三关 | `guard:agent-parity` 全绿（192 操作 / 204 IPC + 50 画布动作 / 254 分母） |
| 契约 | `test:contract` 待完整门禁；快照与 `change-impact.json` 已按 `--accept-contract-change` 刷新（可选字段加性） |
| 完整门禁 | `npm run verify` 退出码 0（`qa/verification/run-wiPhYO/status.json`：3863 通过 / 7 跳过；浏览器 34 脚本、构建、全部桌面验收通过） |

## 3. 未覆盖边界（如实）

1. **`iteration/camera` 端口类型枚举**与节点流内部端口兼容（NF-6.4/6.5 剩余部分）随 BL-12。
2. **ContextManifest 最小输入编制 → 公开输入**（NF-13.4）仍为目标；参数只覆盖公开配置子集，不替代输入编制。
3. **真实供应商参数效果**（不同模型的比例/时长/张数）未发起计费请求；按能力表归一化的运行时校验仍由执行器负责。
4. **安装包与源码一致性**未核查。

## 4. 唯一下一步

按 [BACKLOG](../BACKLOG.md)：**BL-12 端口兼容判定统一 + 补全类型**（`COMPOSITE_PORT_TYPES` 补 `iteration/camera` 或封装入口明确拒绝；connection-matrix 真值表与节点流一致）→ BL-13/14（Schema 兼容、媒体 mime、必填预检、缺席三态）。

## 5. 复跑命令

```powershell
node scripts/run-vitest.cjs run test/flow-graph-v2.test.ts test/agent-flow-coordinator.test.ts
npm run guard:agent-parity
npm run verify
```
