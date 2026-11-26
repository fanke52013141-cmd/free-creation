# H01、H02、H04–H10 审查修复交付台账

日期：2026-11-26（Asia/Shanghai）。基线：`main@8c5c155`。范围：仅处理审查报告指定的 H01、H02、H04、H05–H10，不顺带扩大其他 backlog。

## 1. 业务动作与兼容结论

- **H01 / H09**：不改变 operation、IPC 或 manifest Schema。`continue` 的失败节点进入认领终态；未提交人工任务每批最多认领一个，已满足提交和普通节点仍可并发。旧运行继续遵守一个未满足人工等待的协议，避免多 wait 相互遮蔽。
- **H10**：在完整逐层暂停/恢复协议之前，嵌套人工门明确返回 `NESTED_MANUAL_GATE_UNSUPPORTED`。发布与运行共用递归检查，旧内嵌和固定版本历史快照不会被误报为成功。最外层人工任务保持支持；这是把原先错误失败/提前完成改为明确的暂不支持边界。
- **H02**：公开 params 只保留执行链能够兑现的字段。processor `field+operation=field → pick/path`、speech/tts 唯一 `provider::model → providerId/modelId`、speech `voice → voiceId` 做无损映射；`text-template` 的模板覆盖保留。无执行语义的字段/枚举在 validate/compile 返回 `CAPABILITY_PARAMS_UNSUPPORTED`，格式/范围/组合错误返回 `CAPABILITY_PARAMS_INVALID`。image/video 的 `featureKey` 修复公共 parser 透传；video seed 按模型能力处理，未扩大生产能力或付费请求。
- **H04**：协调运行 child 增加可选 `humanDecided`，旧 JSON 可继续读取。可信采用后，图事实、条件路由、StageDeliveryRecord 和数据库重开读取同一事实。
- **H05–H08**：`flowAgent.run@1` 新增**可选** `contextMaterial`，旧调用不变。仅 `FLOW_CONTEXT_OVER_BUDGET` 的 continue 可携带，main 负责材料预览、人工确认、来源与内部 Schema 复验；伪造来源、非预期等待、拒绝和修订冲突不执行。有效输入清单、预算、固定资产引用、渲染注入、composite 预检和指纹使用同一集合；歧义和仍超限在执行前失败。
- 未新增 operation、GUI 业务按钮或 IPC 通道；`action-coverage.json` 无需新增行。已刷新 `generated/contracts.json` 与 `change-impact.json`，兼容结论为可选字段加性，错误参数和嵌套人工门改为 fail-closed。

## 2. 实现位置

- `src/renderer/src/composite/run-composite.ts`、`src/shared/composite/manual-gate.ts`、`src/shared/composite/validate.ts`：失败终态、人工认领、递归人工门准入和 checkpoint 缺字段回放。
- `src/shared/agent-flow/node-params.ts`、`flow-graph.ts`、`flow-graph-compiler.ts`、`src/shared/image-capabilities.ts`、`src/shared/engine/helpers.ts`、`src/shared/engine/executors/video.ts`：参数转换、错误码、featureKey 与 seed 的真实执行语义。
- `src/main/agent-flow/coordination-store.ts`、`coordinator-host.ts`、`command-ledger.ts`、`src/shared/agent-flow/context-manifest.ts`：人工采用事实、有效输入、预算、composite 预检和指纹。
- `src/shared/agent-access/ops/flow-agents.ts`、`src/main/agent-access/flow-agent-run-ops.ts`：CLI/MCP 补料契约、桌面预览确认与同一宿主转发。

## 3. 日志影响

不新增诊断事件或网络旁路，不重复记录公共终态。失败/认领/续跑沿用 `composite.run.*`；图准入沿用稳定错误码与 phase；人工采用沿用 `human.wait` / `agent.completed`；外部补料沿用 access 与人工决定诊断。材料正文只进入桌面确认预览，不进入日志；配置全文、提示词、提交值和原始异常不新增记录。日志拒写不改变业务结果，账本拒写仍阻断提交。

详见 `docs/LOGGING_COVERAGE.md` 的“2026-11-26 H01/H02/H04–H10 审查修复”。

## 4. 回归证据

已完成的分项验证：

- H01/H09/H10：22 个 composite/Node Flow 测试文件，158 项通过；覆盖失败节点一次认领、两个人工节点两种提交顺序、三层固定版本与旧内嵌人工门拒绝。
- H02：图与执行器矩阵 206 项通过；新增 `test/capability-params.test.ts` 11 项效果测试。另独立复跑参数/图/能力 5 文件 80 项通过。
- H04–H08：171 项通过；包括有效输入 10 项、账本 73 项、CLI/MCP 16 项、固定顺序 14 项、协调器 54 项和命令材料 4 项。另经独立复审确认 retained optional 与 text/Markdown 边界无剩余 blocker。
- 全部修改完成后：`npm run typecheck` 与 `npm run lint` 通过；`npm run guard:agent-parity` 三关通过（192 operations / 34 planned nodes）。

集成验证已完成的额外项目：

- 完整 Vitest：352 个测试文件通过、2 个跳过；4003 项通过、7 项跳过。
- `npm run test:contract`：338 项通过；`npm run verify:specs` 通过；`npm run build` 通过。
- `test:agent-flow-capability-graph` 桌面验收通过；首次因本机 GPU 沙箱崩溃未生成报告，按仓库既有取证方式以 `ELECTRON_DISABLE_SANDBOX=1` 重跑通过。
- `acceptance:agent-flow-human-task` 桌面验收通过（等待、提交、续跑、正式输出均为确定性夹具，无真实计费）。夹具同步了既有 `requiresManualGate` 声明与 NF-5.3 的 `out-` 输出键，不改变产品行为。
- 完整 `npm run verify` 的首轮曾因集成复审发现补料边界而停止，未作为通过证据；最终修正经独立复审确认无剩余 blocker 后重新执行，**全部通过**。证据：`qa/verification/run-O67zbm/status.json`（status=passed，exitCode=0），覆盖 4003 项应用测试、34 个浏览器脚本、构建和全部 Agent Flow 桌面回归。
- `npm run verify:acceptance:fast`：protocol 34/34、optimizations 9/9 通过；真实 MCP 工具数 192。证据已归档到 `docs/local-agent-access/evidence/`（本批索引批次 `2026112616565`）。

## 5. 未覆盖边界

- 不实现嵌套人工门的逐层暂停/恢复；本包选择明确拒绝，未来若支持必须新增独立 waiting outcome 与祖先恢复协议。
- 不处理审查报告中的其他编号（包括 M02 intent signature、H16 capability 恢复等）。
- 参数测试使用 parser/executor/gateway spy，不代表真实付费供应商验收；不扩大生产能力。
