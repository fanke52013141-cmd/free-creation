# Agent Flow R1/R2 根因结论与闭环验收（2026-11-12）

配套：[端到端验证交接](HANDOFF_2026_11_12_AGENT_FLOW_VERIFICATION.md)、[优化方案](AGENT_FLOW_OPTIMIZATION_PLAN_2026_11_12.md)、[实施规格](AGENT_FLOW_EXECUTION_SPEC_2026_11_12.md)。
本文记录本机（Windows，当前 main `8f5c85e0` + L1/L2 布局批次）实测结论，**修正交接文档的核心假设**。

## 1. 一句话结论

交接文档的"应用内主控真实模型决策稳定失败（AGENT_MODEL_FAILED），根因锁定应用运行时 GLM 集成"
**在当前代码上未复现**。glm-5.3 与 glm-5.3-flash 的应用内主控决策均成功；真实闭环
（主控→专家→固定资产→finish→completed）已用 glm-5.3-flash 跑通并入仓验收。
此前观察到的失败由**夹具配置缺陷与 schema 缺口**导致，不是模型流集成缺陷。

## 2. 实测证据（真实模型，小额计费）

正式验收：`npm run acceptance:agent-flow-closed-loop`
（`scripts/acceptance/agent-flow-closed-loop.cjs`，密钥经 `CANVAS_TEST_API_KEY` 环境变量注入，
模型经 `CANVAS_TEST_MODEL` 参数化，默认 glm-5.3-flash；隔离数据目录、`[TEST]` 标题、退出清理）。
最近回执 `qa/agent-flow-closed-loop/receipt.json`（gitignore 本地留档），6 项全过：

1. 模型工具调用验证通过（应用内两阶段真实探针，status=verified）；
2. CLI 建 flow（状态机/主控/专家/processor/素材源 + observes 控制关系 + 数据边）；
3. 素材源 node.execute → run.wait completed（固定输入资产就绪）；
4. 专家 completed（decisions=2, tools=1：一次 execute_node + 一次 finish_task）；
5. 主控协调台账 completed（decisions=2：一次 dispatch + 一次 finish_flow）；
6. 固定资产提交 2 个（素材源 out-text + processor out-value，flow_asset_versions 真实落库）。

## 3. 定位过程中捕获的真实失败模式（临时插桩，已移除）

R1 插桩（`CANVAS_FLOW_DEBUG=1` 门控写隔离目录本地文件，不进日志/数据库）捕获到三类失败，
逐一复现并归因后**插桩已全部移除**（runtime-model.ts / runtime.ts / glm-request.ts 恢复原状，grep 零残留）：

| 现象 | 真实根因 | 性质 |
| --- | --- | --- |
| 主控 `AGENT_MODEL_FAILED`，zod `too_small` path=inputs | dispatch schema `inputs.min(1)`：专家**没有固定上游输入**时，模型只能返回空 inputs，被 schema 拒绝 | **产品 schema 缺口**（无输入专家不可分派）；夹具补素材源→专家 in-text 边后消失 |
| 专家循环 execute_node 至 `AGENT_BUDGET_EXHAUSTED`（12 步） | processor 默认 config `operation:'pick'`（提取字段）喂文本输入必然失败：执行 trace 明示"提取字段需要 JSON 输入，请改用字符串模板"；回执 `FLOW_EXECUTION_FAILED`，专家正确重试 | **夹具配置缺陷**（改 `operation:'pass'` 后一次执行即 committed）；暴露默认 processor 配置对文本链不友好 |
| glm-5.3 偶发 `AGENT_MODEL_ACTION_INVALID`（decisions=8） | 模型返回非单一工具调用（toolCalls≠1），推理模型非确定性 | 模型行为波动，非代码缺陷；flash 未复现 |

关键机制事实（供后续开发参考）：
- 专家的 `directInputs` 来自**连到专家节点本身** in-text/in-json 的上游边（desktop-host.ts:476），
  不是目标节点的上游；素材源必须先运行产出固定资产。
- 专家执行目标节点的回执必须 `committed` 才能 finish_task（"文字声称完成无效"）；
  执行失败时专家会重试——**循环不一定是模型问题，先查回执状态**。
- 状态机必须用标准迁移表全量事件（draft→working 后还需 agent.dispatched/agent.completed/
  flow.completed 等迁移），缺迁移报 `FLOW_STATE_TRANSITION_DENIED`。
- `flowAgent.run` 长模型调用可能返回 `OUTCOME_UNKNOWN`（connect 超时），任务在宿主继续；
  以协调台账（flow_coordination_runs.body_json.state）为终态真值，不要盲目重试。
- better-sqlite3 按 Electron ABI 编译：验收脚本查库须用 Electron-as-Node 子进程
  （`scripts/acceptance/helpers/query-flow-run.cjs`），系统 Node 直接 require 报 NODE_MODULE_VERSION 不匹配。

## 4. 对交接文档 §7  next steps 的修订

| 原计划 | 修订 |
| --- | --- |
| 1. 捕获应用内主控失败的确切 SDK 错误 | **已完成**：捕获到的不是流错误，而是 inputs schema 拒绝与执行回执失败（见 §3） |
| 2. 修复应用 GLM 集成（thinking 注入/Node 22 流解析） | **无需修复**：当前代码应用内主控决策成功；未做任何 GLM 集成改动 |
| 3. 跑通完整闭环 | **已完成**：acceptance:agent-flow-closed-loop 6 项全过（glm-5.3-flash） |
| 4. 扩展文本生成可调度目标 | 仍待做（C1）；本轮 processor 目标已验证可用 |
| 5. 搜索工具/状态机外部事件/人工节点 | 仍待做（C2/C3/C4） |

## 5. 建议的后续产品改进（需裁决，未擅自实施）

1. **无输入专家的可分派性**：dispatch schema `inputs.min(1)` 使没有固定上游的专家永远不可分派。
   建议：available 候选无 inputs 时允许空 inputs（schema 条件化），或在准入/建图期给出明确提示。
   属契约变更，须走加性审查与门禁。
2. **processor 默认配置**：GUI/外部新建 processor 默认 `operation:'pick'`，文本链场景必失败。
   建议默认 `pass`（透传），pick/template 由用户显式选择。属行为变更，需用户裁决。
3. **glm-5.3 推理模型波动**：ACTION_INVALID 偶发；可在决策层加"非单一工具调用"的受控重试
   （当前 maxRetries=0），或文档建议写作垂类优先 flash。需计费口径裁决。

## 6. 未验证边界

- 本轮闭环为**单专家单 processor** 最小链；多专家并行、审核门禁/返工、视频/媒体目标未在本轮跑通
  （仓库既有桌面验收脚本覆盖部分路径，但依赖特定环境/模型）。
- glm-5.3（完整推理模型）只验证到主控分派成功 + 专家偶发 ACTION_INVALID；未跑通其完整闭环。
- 人工 GUI 点击驱动的主控运行未验收（本轮全部 CLI 驱动）。
- 计费：本轮多次小额探针 + 决策调用（flash 为主），无大额生成；密钥仅经环境变量/设备密钥库，未进仓库与日志。