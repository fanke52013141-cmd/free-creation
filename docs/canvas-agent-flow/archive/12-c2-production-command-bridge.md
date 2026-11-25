# C2.2 生产执行命令桥

日期：2026-10-12。状态：**确定性数据处理首条路径已接入并通过最终全量验收**。持久命令账本、桌面派发、公共执行、项目保存、资产回执与跨进程核对已实现；Agent 自主模型循环和 AI 审核执行仍待 C3。承接 [生产桥审阅](09-model-probe-and-production-bridge-review.md) 与 [C2.1 资产版本](11-c2-asset-versions.md)。

## 实际桌面路径

```text
当前主窗口发起 node.execute
 → main 校验保存的 Agent 范围、语义修订、正式契约和固定输入
 → SQLite 原子保存 task 绑定、pending 与目标占用
 → main 向当前 renderer 派发一次 grant
 → 公共资源队列 → 再次校验 main lease / 实时画布 / 当前项目
 → runNodeManually → executeNodeOnce → 已注册 processor executor
 → 公共输出契约与节点运行记录
 → 等待保存协调器收敛所有在途/合并保存
 → main 从保存事实核对运行、版本、来源和重新计算的指纹
 → SQLite 同一事务提交输出资产、资产回执和命令回执
```

生产入口 dispatchFlowCommand 通过窄桌面 IPC；CanvasEditor 订阅 main grant。runFlowNodeCommand 供后续桌面工具调用。独立 prepare/执行/commit 阶段用于核对验收，重开不会重新执行 grant。不恢复 CLI/MCP/headless，不增加业务执行器。

首包只允许 processor@1，输出限文本/Markdown/JSON。端口声明抽到 shared，桌面注册与 main 复用同一声明，原名称/类型/必填/基数不变。main 不接受 caller 提供的可信端口、输出正文或成功状态。

## 固定输入、修订与占用

严格 node.execute v1 包含 command/project/task/agent/target 身份、expectedSemanticRevision、contractVersion、固定输入清单与 trace/span。每项明确 targetPortId 与完整 assetId/versionId/sourceNodeId/sourcePortId。拒绝重复端口、自执行、额外正文、非法修订及超过 128 个引用；单值端口只接一项。

main 先将当前画布项目绑定到受控主窗口，未绑定/非当前项目在占用前拒绝；再从保存的 Agent config 读取 allowedNodeIds，并校验目标正式契约。连接输入不得缺项后降级读当前上游。资产按同项目完整身份与 digest 解析；固定画布卡片保留真实连线来源及 assetId/versionId，两个入口的来源/指纹一致。卡片引用或固定内容与指定版本不匹配则拒绝。

首次授权命令建立 project/task/agent 持久绑定与 maxSteps 上限；同任务不能换 Agent 或突破原预算，缩小当前预算也生效。这是执行桥的有界绑定，不是 C3 的 LangGraph 任务生命周期。

main/renderer 使用同一 shared 语义载荷及稳定序列化。正文、配置、媒体来源、正式端口/契约、固定投影/版本、控制/审核关系、workspaceProfile 和有序数据边影响 SHA-256 指纹。标题保守纳入；位置/尺寸、相机、保存计数/时间和运行结果/记录不影响指纹。对象键归一，端口内资产与多输入边保留顺序。

renderer 在资源等待后、业务调用前检查当前 editor/project、实时画布及 main 一次性 lease。排队期间编辑配置或切项目不能继续旧命令。grant 深复制/冻结，输入经公共 collectContractInputs 校验。

pending/unknown 占用持久化并有唯一索引；普通手动/工作流入口也检查占用，不能覆盖未确认运行。普通资产提交不能发布被占用节点；命令资产提交只在 main 内以匹配 lease 获准。已声明审核 gate 在两个入口均阻断，等待 C3 接入，不绕过审核。

## 回执和未知结果

projectId/commandId 唯一；同 ID/意图返回原状态/回执，不再派发，不同意图拒绝。签名覆盖业务身份、契约/修订与固定输入，不包含重试诊断 trace/span。renderer 同时发起相同意图等待同一 Promise，不同意图拒绝。

保存后，main 核对 nodeRun 的 commandId/lease/runId/nodeExecutionId、终态、固定清单、真实来源和重新计算的 inputFingerprint；成功必须已 admission 并声明 out-value。formal projectOutputs 读取保存结果，资产及其回执与命令回执同一 SQLite 事务；回执拒写不留半个资产。失败/取消/跳过不提交旧结果。

回执包含 command/task/target、runId/nodeExecutionId、固定输入、指纹、输出引用、保存图版本及状态。committed 表示保存事实核对后资产/回执事务已提交；done、applied 或 toast 均不能代替它。文件与 SQLite 跨介质不是原子事务，靠断点核对处理。

| 情况                                        | 处理                                               |
| ------------------------------------------- | -------------------------------------------------- |
| 重复命令、已提交回执回传丢失                | 读取原回执，不重复执行/物化/提交                   |
| 排队取消，尚未 admission                    | skipped，无新输出，以当前匹配 lease 释放未执行占用 |
| 已保存失败/取消/跳过                        | 持久真实终态，不提交旧输出，释放占用               |
| 保存失败或提交结果不明                      | unknown，保留占用，不自动执行                      |
| 等待 60 秒、renderer 失联、重开遗留 pending | 转 unknown，保留占用；恢复失败保留原记录并记录阶段 |
| unknown 有匹配保存事实                      | reconcile 只核对/提交，不调用执行器                |
| 无保存事实或语义已变                        | 继续待核对，不推断从未执行，不释放后自动重发       |

reconcileFlowNodeCommand 只有 lookup/commit，不回退到 prepare/execute。已提交版本不会被后续手动运行覆盖。C3 checkpoint 只能接受 committed 回执后推进。

## 日志自查与验收

影响为命令 IPC、SQLite 占用/回执、跨进程核对及公共入口占用校验；公共执行/投影/保存复用既有日志，不重复节点终态。command.operation.started → completed/failed 记录 prepare/dispatch/admission/manual-occupancy/saved-receipt/lookup/unknown/not-started。独立操作 span 共享可信原 trace/parent、command/task/project/node/run，回执附输出版本。

恢复有 command.recovery.started → completed/recovery_failed 和逐条 command.recovered，区分 startup/renderer-lost/timeout 并关联原 trace；renderer 未确认桥结果记录 command.bridge.failed。仅 ID/阶段/状态/静态原因/数量/耗时进诊断，不记录正文/config/canonical/Zod 原始错误、密钥或原始异常。日志失败不改变业务，诊断不是恢复真值。

新增定向：账本 13 项、公共执行 8 项、IPC 5 项，另有意图基础 7 项。覆盖来源/指纹、去重/冲突/预算/占用、pending/回执拒写、保存失败/丢回执、排队取消/编辑/切项目、unknown 核对、两入口审核阻断、foreign window/child frame、唯一终态、超时、恢复拒写和 logger 故障。

隐藏 Electron 两进程使用真实 preload/IPC/画布/公共执行器/项目保存/SQLite，验证成功/失败/排队取消对等、固定 v1、输出资产回执、位置/语义分离、重放、unknown 阻止手动覆盖/发布和无执行核对。实际诊断扫描无测试正文/假密钥；成功与核对的业务 node.started 均只有一次。只复制诊断和安全报告，不复制业务库或项目正文。

npm run verify 已包含构建后的 test:agent-flow-commands。证据 qa/canvas-agent-flow/C2/commands 与 bridge-*.log；最终全量结果见开发台账。沿用现存 Electron native ABI、pnpm 10.33.0、本机 Chromium，不重编译个人模块，不发付费模型请求。

边界：确定性首条路径不代表所有节点/媒体对等、模型取消/网络副作用恢复、Agent 自主循环、Skill/tool 执行、真实审核/三类返工已完成。Agent/状态机/AI 审核自主执行待 C3；未知人工裁决 UI、迁移/导入导出重映射和长期恢复归 C3/C4。无保存事实的 unknown 不自动解除占用。下一步接 C3 有界任务循环/checkpoint，再逐类扩执行能力。


最终验收：npm run verify 完整通过，153 个测试文件、1660 项通过、1 项既有跳过；模型模块另 2 项通过。lint、两端/模型类型检查、日志门禁、17 项浏览器脚本、生产构建及构建后的资产/命令 Electron 双进程均通过。记录 qa/canvas-agent-flow/C2/bridge-final-verify.log，双进程报告见 commands/results.json。
