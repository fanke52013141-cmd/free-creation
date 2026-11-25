# 节点流（Composite）全面测试报告 · 2026-11-20

日期：2026-11-20 · 基线：35c4343（HEAD，工作区干净）
方法：既有全量回归（vitest）+ **新增 17 项封装组合端到端集成测试** + L2 流矩阵 + 真实 Electron 桌面验收（L3）+ headless 外部调用验收 + deep agents 使用核实

## 一、针对本次核心关切的结论

**1. 节点流的封装组合能力（串行/并行 → 封装为独立节点流 → 稳定输入输出）当前是可用的，且错误路径同样是规范的。**

| 用户关切 | 测试结果 |
|---|---|
| 单个节点满足标准输入输出 | ✅ 单节点流（文本透传）端到端可达，输出按公开端口投影 |
| 节点串行组合 | ✅ text→json 两段依赖链贯通，输出类型按端口变换（text→json），台账逐步记账 |
| 节点并行组合（广播 + 分支 + 扇入） | ✅ 一份输入广播两条分支，分支输出各自公开且互不串扰，扇入合并语义正确 |
| 组合后封装为独立节点流 | ✅ 引用形态（发布仓库固定版本）与内嵌形态都能作为内部"子流即节点"运行 |
| 作为输入输出稳定的执行单元 | ✅ 同流同输入重复运行 3 次输出逐字节一致；不同输入无残留；并行流同样确定性 |
| 嵌套（子流再封装） | ✅ 三层嵌套 A→B→C 输出穿透；递归成环被运行期守卫显式拒绝（RECURSIVE_COMPOSITE） |
| 错误也符合规范（可定位） | ✅ 每类错误都带 code/phase/failureNodeId/failurePortId，逐项验证（见 §五对照表） |
| 脱离项目被外部调用（扣子式封装） | ✅ headless 验收 7/7：未打开任何项目，`composite.execute → wait → run.get` 全链贯通 |

**2. "实践中经常报错"的直接原因，不是引擎跑不通，而是错误大多是契约守卫在"诚实拒绝"——每个错误都能定位到具体内部节点/端口。** 本次测试把每一类错误都跑了一遍，行为全部符合设计（详见 §五）。需要特别注意的两个高频真实踩坑点：

- **必填输入没喂** → 内部节点被跳过 → 表现为 `REQUIRED_OUTPUT_MISSING`（提示文案会写明"内部节点被跳过：无文本输入"），看起来像"莫名失败"，实际是输入契约守卫；
- **固定版本引用失效**（版本被删/摘要不符）→ `COMPOSITE_REF_NOT_RESOLVED`，需要重新发布或修正引用。

**3. deep agents 核实结论（§六）：LangChain/LangGraph 是真实使用的；skill 体系是自研的（同 deepagents/Anthropic 的 SKILL.md 设计模式），没有使用 deepagents 官方包——且项目实现计划文档明确写了"暂不引入 Deep Agents"。**

## 二、测试总览

| 层级 | 范围 | 结果 |
|---|---|---|
| P1 全量回归 | 全量 vitest 327 文件（2 skipped 为设计内） | ✅ 修复 1 处后全绿（见 §四） |
| L2 流矩阵（既有） | 83 项引擎级全链（冒烟/拓扑/循环/媒体/模型链） | ✅ 107/107（含 composite 相关） |
| **P2-E 新增** | **runCompositeIsolated 隔离编排器端到端 17 项** | ✅ 17/17 |
| L3 真机桌面验收 | 真实 Electron + CLI + MCP 22 项 | ✅ 22/22 ok=true |
| L3-headless | 无项目 headless 外部调用 7 项 | ✅ 7/7 ok=true |
| deep agents 核实 | 依赖清单 / 导入边界 / 文档决策 | ✅ 结论明确（§六） |

L4 GUI 验收（13 项）在 11-17 报告中全绿；此后 git 仅有的 6 个提交全部是画布 UI 层（循环体容器/连线命中测试），未触碰 composite 运行时，本次未重跑。

## 三、新增测试资产（本轮补上的最大缺口）

**`source/test/node-flow-e2e-composition.test.ts`（17 项，全部通过，eslint 0 error）**

此前的测试缺口恰恰是用户担心的那一层：vitest 配置明确注释"不测 tldraw Editor 和 window.api"——即**真正干活的隔离编排器 `runCompositeIsolated`（`src/renderer/src/composite/run-composite.ts`）此前零自动化覆盖**（纯函数层、执行器边界层、主画布图引擎层都有测试，唯独"封装→独立调用"的编排全链没有）。本轮用真实 tldraw 隔离编辑器 + window.api 台账桩补齐：

- **P1 单节点流**：文本透传流输入→输出端到端；裸端口 ID（`in-`/`out-` 前缀约定）验证
- **P2 串行**：text→json 链；空输入 `INPUT_REQUIRED`（且不进入任何内部步骤）；内部节点失败 `NODE_FAILED` 定位到 nodeId 并沿封装边界透传
- **P3 并行**：一份输入广播两分支（分支隔离）；两分支扇入合并（`$$$` 分隔符）；外部输入与节点自身正文的合并语义
- **P4 子流即节点**：引用形态经发布仓库解析贯通；内嵌形态（config 直接带 manifest）；引用无法解析 `COMPOSITE_REF_NOT_RESOLVED`；**三层嵌套 A→B→C**；**A↔B 互相引用成环 → 运行期 RECURSIVE_COMPOSITE 拒绝**
- **P5 稳定性**：同输入跑 3 次输出逐字节一致（串行流 + 并行流）；不同输入无上一轮残留；类型不符 `INPUT_TYPE_UNSUPPORTED` 先于执行拒绝

编写过程中的两个构造教训（对用户有参考价值）：

1. **自引用/环引用的 manifest 不能带 contentHash**（哈希含被引用对象，是循环定义）；发布引用（ref 不带 hash）即可，运行期预算守卫会正确拒绝成环。
2. 内嵌 manifest 快照是**值拷贝**：外层发布时内嵌的子流配置是当时的字符串快照，之后对子流对象的修改不会同步——外层运行会用旧快照。这正是"封装后不可变"语义的一部分。

## 四、发现的问题与处置

### 问题 1（唯一失败项，与节点流引擎无关）：UI 决策测试滞后于连线加粗决策

- **发现通道**：P1 全量回归（326 过 / 1 挂）。
- **现象**：`test/node-ui-decisions.test.ts > 画布连线宽度与流动段比例` 断言失败。
- **根因**：提交 `31c7a3c`（2026-11-17"thicker lines"决策）把连线宽度从 1.5/2.25 加粗到 3/4.5，但该 UI 决策断言没同步更新。1/6 流动段比例（dasharray 166.667 833.333）本身未变。
- **处置（本轮已修）**：同步断言到 3/4.5 并注明决策来源提交；重跑 118/118 通过。**这是测试滞后，不是产品缺陷。**
- **修复后全量回归**：327 文件全绿（2 skipped 为设计内，依赖真实桌面宿主）。

### 既有回归确认（11-17 已修复，守卫仍在）

11-17 报告发现的阻断级回归（引用形态媒体产物 100% 失败，e706bb2 引入）已修复并有 `test/artifact-recipe-skip.test.ts` 回归单测把守；本轮 L3 真机第 17 项（媒体资产节点流）通过，确认守卫有效。

## 五、节点流错误对照表（全部实测验证）

| 错误码 | 阶段 | 触发场景（实测） | 用户该怎么处理 |
|---|---|---|---|
| `INPUT_REQUIRED` | input | 必填公开输入没喂值 | 补输入后重跑；或把端口改成可选/给默认值 |
| `INPUT_TYPE_UNSUPPORTED` | input | 喂的类型与端口声明不符（如给 text 端口喂 JSON） | 检查连线/输入类型 |
| `INPUT_VALUE_INVALID` | input | 单值端口收到多份值 | 检查多路上游 |
| `INPUT_TARGET_MISSING` | input | 端口映射目标不存在/接入失败 | manifest 映射损坏，重新发布 |
| `COMPOSITE_REF_NOT_RESOLVED` | input | 固定版本引用解析失败（版本不存在或摘要不符） | 重新发布对应能力或修正引用 |
| `NODE_FAILED` | step | 内部节点失败（带 failureNodeId 定位） | 按定位到的节点排查（如 JSON 格式无效） |
| `REQUIRED_OUTPUT_MISSING` | output | 必需公开输出没结果（常见：内部节点因缺输入被**跳过**） | 看错误信息里的跳过原因，通常是输入没接 |
| `RECURSIVE_COMPOSITE` / `DEPTH_EXCEEDED` / `EXPANSION_BUDGET_EXCEEDED` | runtime | 递归成环 / 嵌套超 8 层 / 展开超 200 节点（manifest 可调） | 调整流结构或 executionPolicy 上限 |
| `COMPOSITE_EXCEPTION` | runtime | 编排器异常 | 记录 runId，查台账 `composite.run.get` |

所有失败都会写入运行台账（`composite.run.get` 按 runId 全局可查，含 failureNodeId/failurePortId），失败不改画布状态。

## 六、deep agents 核实结论

**直接回答：AI 对话不是用 deepagents 官方包开发的；skill 模块是自研实现。但 LangChain/LangGraph 本身是真实使用的，没有"诓骗"。**

证据链（文件:行号）：

1. **依赖事实**：`source/package.json` 只有 `langchain@^1.5.10`、`@langchain/core@1.2.9`、`@langchain/langgraph@1.4.14`、`@langchain/langgraph-checkpoint@1.1.5`。**没有 `deepagents` 包**——lockfile、node_modules、全代码库 `createDeepAgent` 零命中。
2. **LangGraph 真实使用**：`src/main/agent-flow/runtime.ts:159-405`（Agent 决策循环 StateGraph + interrupt/Command + SQLite checkpointer）、`src/main/agent-flow/c0/runtime.ts:30`（C0 运行时）、`coordinator-host.ts`、`checkpoint.ts`（自研 LangGraph Saver）。这些是真实的 LangGraph 状态机，不是空壳。
3. **skill 体系是自研的**：
   - 契约层：`src/shared/agent-flow/runtime-contracts`（`FixedSkill`/`SkillPackageSchema`，SKILL.md + resources 渐进披露模式）；
   - Agent 流侧：`runtime.ts:201-229` 的 `skill` 图节点（load-skill → 上下文 128KiB 上限）+ `src/main/agent-flow/skill-store.ts`；
   - 对话节点侧：`src/shared/engine/skill-agent.ts`（`runSkillAgent` 有界循环：`read_resource`/`complete` JSON 协议，最多 12 步）+ `src/shared/skill-agent.ts`（内置技能：内容分析/内容整理等 5 个）。
4. **项目自己的决策文档**：`source/docs/canvas-agent-flow/archive/06-implementation-plan.md:64` 明确写了——"先实现自定义 StateGraph 的一个有限循环……**暂不引入 Deep Agents 默认文件系统/子 Agent 执行环境**，避免与现有节点和主 Agent 调度重复。"

事实澄清（供用户校准预期）：

- deepagents 确实是 LangChain 公司（langchain-ai）的开源包，且新版带 skills 模块（SKILL.md 渐进披露，见 [LangChain deepagents 文档](https://docs.langchain.com/oss/python/deepagents/overview)、[Skills 模块文档](https://docs.langchain.com/oss/python/deepagents/skills)、[GitHub 仓库](https://github.com/langchain-ai/deepagents)）——你的记忆是对的；
- LangChain 核心库本身没有 skill 模块——也对；
- 本项目的 skill 系统**复刻的是同一设计模式**（SKILL.md/资源渐进披露 + 固定版本绑定 + 工具白名单），跑在 LangGraph 原语之上。如果此前有会话告诉你"用了 deepagents 的 skill 模块"，那句话不准确——准确说法是"用 LangGraph 自研了一套 deepagents 风格的 skill 体系"；
- 另需注意边界：**对话节点的模型传输走的不是 LangChain**，而是项目自建网关（renderer GatewayClient → main model-host → `packages/model-runtime`，基于 Vercel AI SDK）。LangChain 仅用于 Agent-Flow 子系统的决策循环与 checkpoint。skill 系统有 6 个测试文件把守（`skill-agent.test.ts`、`agent-flow-runtime.test.ts` 等），本轮回归全部通过。

## 七、一个重要的语义说明（期望管理）

**节点流内部没有真正的并行执行。** `run-composite.ts:355` 按拓扑序**串行**执行内部节点——"并行分支"是拓扑上的并行（扇出/分支互不依赖、结果互不串扰），调度上是逐个跑（不会同时调用两个模型）。真正支持并发的是循环节点（iterate，并发 1/2/4 可配）。如果期望"两个生图分支同时出图"，目前节点流实例内做不到；两个**独立**的节点流实例并发运行是支持的（各自隔离 editor，`run-composite.ts:33-35` 注释明确）。

## 八、证据文件

- 新增测试：`source/test/node-flow-e2e-composition.test.ts`（17 项）
- 全量回归：`source/temp-p1-full-test-v3.log`（修复后全绿）
- L2 流矩阵基线：`source/temp-nodeflow-l2-baseline.log`（107/107）
- L3 真机验收：`source/temp-l3-composite-desktop-v3.log`（ok=true，22 checks）
- headless 验收：`source/temp-headless-execute-acceptance.log`（ok=true，7 checks）
- 上轮报告（含 11-16 回归修复记录）：`节点流全面测试报告-20261117.md`

## 九、建议

1. **把本轮新增的 17 项集成测试纳入常规提交门禁**（连同 `composite-desktop-acceptance.cjs`），防止"单点提交破坏封装链路"再次静默合入——vitest 配置注释里"不测 tldraw Editor"的边界已被本轮打破且收益明显。
2. UI 决策类断言（`node-ui-decisions.test.ts`）在改动视觉决策时应同步更新——本次就是一处滞后漏网。
3. 若确实需要 deepagents 的官方能力（文件系统工具、子 Agent 编排），按 06-implementation-plan 的口径评估后再引入，避免与现有节点/调度重复；当前自研 skill 体系已覆盖"固定版本技能 + 渐进披露"的核心价值。
