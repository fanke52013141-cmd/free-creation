# Agent Flow 端到端验证报告

日期：2026-11-12 · 验证方式：以**外部 Agent 身份**经 CLI/MCP 同源通道真实操作运行中的应用
验证项目：`AgentFlow端到端验证-公众号`（projectId `qtiiB26nOWJS`，可在 GUI 打开查看所建流程图）
应用：canvas-studio source 构建（CANVAS_OWNER=1 自用版，appVersion 1.0.0，带 `--local-agent-access` 启动）

---

## 一、结论先行

**你的构想在这套系统里不是"能不能实现"的问题，而是"已经实现了大半、外部通道实测可用、剩下几个明确缺口"的问题。**

本次验证最硬的一条证据：**我作为外部 Agent，没有碰 GUI，纯靠 CLI 命令就把一整套公众号 agent flow 图建出来并接好了线**——状态机 + 主 Agent + 4 个专家 Agent（含人机协作/纯 AI 两种模式）+ 4 个成果节点 + AI 审核，共 11 个节点、控制关系、数据边，一次性原子保存成功。这正是你构想里"外部 Agent 构建整套 flow"的那一步，**结构通道实测打通**。

但**让这套 flow 真正"跑起来"（主 Agent 编排、专家 Agent 决策）目前卡在一个前提上：应用里没有配置任何模型**。这不是代码缺陷，是运行前提缺失。补上模型后，编排层能否跑通已由仓库 2577 个测试（合成供应商夹具）证明；本次新增的证据是"外部 Agent 建图 + 外部执行非 AI 节点"这条你 previously 没验证过的路径。

---

## 二、实测逐项证据

所有命令走 `node out/main/local-agent.js <操作>`，与 MCP 工具同一注册表、同一鉴权、同一业务实现（三入口同源）。

### 2.1 外部接入连通 ✅（有一个启动前提）

| 操作 | 结果 |
|---|---|
| `app.status` | completed，返回 instanceId / appVersion |
| `model.list` | completed，**models: [] （0 个模型）** |
| `node.type.list` | completed，**32 类节点 / 256 个动作**（42 desktop-tested、181 contract-tested、30 planned、3 not-applicable）|
| `flowAgent.catalog` | completed，4 个工具 / 5 个技能 / 0 个模型 |

**新发现的前提**：应用默认启动**不开**外部接入服务。我第一次连接时返回 `APP_NOT_RUNNING`，查 `src/main/index.ts:719` 发现 agent-access 服务只在启动参数含 `--local-agent-access` 时才启动。重新以该参数启动后，`connection.json` 出现，CLI 立即连通。
→ 含义：外部 Agent 要接入，桌面端必须以 `--local-agent-access` 启动（你的启动器脚本目前没带这个参数）。

### 2.2 外部 Agent 建整套 flow ✅（核心验证，打通）

| 步骤 | 操作 | 结果 |
|---|---|---|
| 建项目 | `project.create` | completed，projectId `qtiiB26nOWJS` |
| 打开 | `project.open` | completed，opened: true |
| 建 11 节点 | `graph.patch`（批 1）| completed，**原子创建 11 节点**，graphVersion 2 |
| 接线 | `graph.patch`（批 2）| completed，**6 节点更新（控制关系+授权范围）+ 4 数据边**，graphVersion 6 |
| 预检 | `node.runPlan`（文章节点上游闭包）| completed，**nodeCount 4，missing: []**（数据 DAG 完全合法）|

所建图结构（完全对应你的公众号例子）：

```
流程状态机(state-machine)  draft→topic→research→outline→writing→reviewing→completed
        ▲ observes
主Agent(coordinator, autonomous, 绑 agent.dispatch)
        │ controls
   ┌────┼────┬────┐
选题专家  资料专家  框架专家  写作专家
(collaborative)(autonomous)(autonomous)(autonomous)
   │controls │controls │controls │controls
选题成果 → 资料成果 → 框架成果 → 文章成果 → 文章审核(ai-review, review-gate)
        （text 节点间 out-text→in-text 数据边）
```

**结论：外部 Agent 程序化建任意 flow 图的能力是真实可用的**，不受内置 builder"6 能力/≤4 步"限制——那条限制只约束应用内的"上帝 Agent 建图"，外部 Agent 用 `graph.patch` 可建任意图。这修正了上一轮分析里"外部建图受限"的判断。

### 2.3 外部执行 ✅（非 AI 节点全链路通）

| 操作 | 结果 |
|---|---|
| `node.execute`（选题 text 节点，single）| completed，accepted，返回 taskId |
| `run.wait` | completed，**state: completed** |
| `output.get` | completed，**返回确定性文本投影**（projection: deterministic@1）|

→ 外部 Agent "触发执行 → 等待终态 → 读取正式输出" 这条闭环对非 AI 节点完全打通，输出是不可伪造的运行事实。

### 2.4 主 Agent 编排 ❌（卡在模型前提，非代码缺陷）

| 操作 | 结果 |
|---|---|
| `flowAgent.run`（主控，start）| **failed：`FLOW_COORDINATOR_CONFIG_INVALID`（admission 阶段）** |
| `flowAgent.inspect`（主控）| completed，**task: null**（准入失败，任务根本没创建）|

根因定位到 `src/main/agent-flow/coordinator-host.ts:168-175`：主控准入硬性要求
1. `role === 'coordinator'` ✅（已设）
2. **非空目标文本** `props.text.trim()` ❌（建图时未填）
3. **`modelDefinitionId`** ❌（**没有配置模型**）
4. 绑 `agent.dispatch` 工具 ✅、observes 恰好一个状态机 ✅、allowedNodeIds 非空 ✅

→ **只要没有已配置的模型，主 Agent 连准入都过不了，整个编排层无法启动。** 这是当前唯一的"运行级"拦路石。

### 2.5 状态机外部操作 ⚠️（部分）

| 操作 | 结果 |
|---|---|
| `node.execute`（状态机节点）| accepted / completed（通用执行器接受）|
| `output.get`（状态机节点）| **failed：`UNSUPPORTED_CONTRACT`** —— "state-machine: output projection lands with its node family package" |

→ 状态机节点能被通用执行路径"执行"，但**输出投影未实现**（等节点族包），且**没有对外的事件提交操作**（注册表里无 stateMachine.* / flow.state.* 事件 op）。状态机目前只认画布内人工事件推进。这坐实了上一轮的缺口②。

---

## 三、缺口清单（实测确认 + 精确位置）

| # | 缺口 | 实测证据 | 影响 | 难度 |
|---|---|---|---|---|
| 1 | **没有联网搜索工具** | `flowAgent.catalog` 只返回 4 个工具：`node.execute`/`graph.preview`/`agent.dispatch`/`review.execute`；5 个技能全是文本处理类（内容分析/内容整理/JSON整理/材料分析/结果检查）| 你的"资料搜索专家"**今天建不出来**——它搜不了网。选题/框架/写作专家可做，资料环节只能靠人喂料或预置文本 | 中（给专家 Agent 加搜索工具或外部 MCP 工具桥）|
| 2 | **模型未配置 → 编排层无法运行** | live DB：0 连接/0 定义/0 密钥/0 绑定；主控准入 `coordinator-host.ts:173` 要求 modelDefinitionId | 主 Agent/专家 Agent/审核全都跑不起来 | 配置即可，但需真实供应商端点+密钥 |
| 3 | **状态机外部事件未开放 + 输出投影未实现** | `output.get` 报 UNSUPPORTED_CONTRACT；无事件提交 op；`16-node-action-coverage.md:56` 标 F8 | 外部 Agent 不能直接推进状态机；主控相位账本与状态机节点实例仍是两条记录 | 中 |
| 4 | **无第一类"纯人工任务节点"** | 32 类节点无 human-task 类型；纯人靠 text 节点承载人上传/填写 | 能用，但缺"这是人的环节"的一等语义，外部建图时不直观 | 中 |
| 5 | **可调度节点范围有限** | node.type.list：30 个动作 planned；state-machine/ai-review 外部 execute 标 planned | 并非 32 类都能被 Agent 自动调度 | 体力活（按清单逐类适配）|
| 6 | **无 headless 宿主** | 外部执行依赖桌面已打开项目（app 必须在跑）| 外部 Agent 不能脱离桌面独立运行 flow | 大（历史上因契约缺口移除过，重启需一致性验证）|
| 7 | **外部接入需启动参数** | `index.ts:719` 仅 `--local-agent-access` 时启动服务 | 启动器脚本需补该参数，否则外部连不上 | 极小 |

### 对上一轮分析的两处修正（实测纠正）
- **模型配置对外是开放的**：`model.connection.save` / `model.definition.save` / `model.validateAgentToolCalling` / `model.binding.save` 都在注册表里（共 154 个操作，不是 37 个）。上一轮"模型配置 GUI-only"判断有误。
- **外部协作写入是开放的**：`flowAgent.cooperate`（note/discuss/submit/revise，带 `actor=external` 标记）、`flowAgent.review`、`flowAgent.build.propose/commit` 实际都已登记（源码注释里"未登记"是过时描述）。外部 Agent 可以参与人机协作，只是需要一个正在运行的任务（即先有模型）。

---

## 四、模型这一环怎么补（需要你提供端点+密钥）

外部 bootstrap 链路在代码里是完整的：

```
model.connection.save（写连接+API Key 进设备绑定密钥库，明文不回传）
  → model.definition.save（声明模型+能力）
  → model.validateAgentToolCalling（confirmNetwork:true + confirmCost:true，真实调用验证工具调用能力，可能计费）
  → model.binding.save（只有已验证模型才能绑定功能）
  → 主控/专家节点 config.modelDefinitionId 指向它
```

安全门禁设计得很严：验证类操作默认拒绝，必须显式 `confirmNetwork`+`confirmCost` 才发请求；外部不能"自己把模型验证成已通过"。

**我没有继续这一步的原因**：当前应用数据目录是空的（live 与 11-09 备份 DB 都 0 模型），环境里虽有 `MINIMAX_API_KEY` 等密钥，但**网关需要用户配置的 baseURL，代码无硬编码默认端点**（`gateway/factory.ts:27` 无 URL 即报错）。用猜测的端点去消耗你的 API 额度不负责任。**这一步需要你给一个真实的 OpenAI 兼容端点 + 密钥 + 支持工具调用的模型 ID**，我就能把整条 flow 真正跑通并验证编排/协作/审核全链路。

---

## 五、可行性与难度总评

**想法现实，且已完成约 70-80%。** 最难的部分（LangGraph 编排器、状态持久化、命令账本、崩溃恢复、上下文隔离、固定版本产物、审核返工）都有生产级代码 + 2577 测试证据。本次又实测打通了"外部 Agent 建图 + 外部执行非 AI 节点"。

剩下的按性价比排序：
1. **配模型**（缺口 2）——配置动作，非开发。给端点+密钥即可让编排层活过来。**这是当前第一优先级。**
2. **启动器补 `--local-agent-access`**（缺口 7）——一行参数。
3. **加搜索工具**（缺口 1）——中等开发，让你的公众号例子完整成立。
4. **状态机外部事件 + 输出投影**（缺口 3）、**纯人工节点**（缺口 4）——中等开发，沿现有契约+三入口 parity 模式扩展。
5. **逐类调度适配**（缺口 5）——体力活。
6. **headless**（缺口 6）——大工程，建议最后，短期用"桌面常开"绕过。

**你的差异化（人的深度参与 + 产物版本化交接 + 最小输入强制）在开源界仍是空位**，方向无需调整，需要的是补工具面和收尾。

---

## 六、本次验证留下的状态

- 应用正在运行（带 `--local-agent-access`），外部接入可用。
- 验证项目 `qtiiB26nOWJS` 已建好完整 flow 图，**可在 GUI 打开直接查看**（状态机/主控/专家/审核/数据边都在）。
- 所有 CLI 调用日志：`C:\Users\ADMINI~1\AppData\Local\Temp\qwenwork\verify-log.jsonl`（含每步请求/响应/退出码）。
- 未改动任何源码；未消耗任何 API 费用（验证类联网操作均未触发）。

**下一步建议**：你给我一个可用的模型端点+密钥+模型 ID，我把这条公众号 flow 真正跑起来，实测主 Agent 编排、选题人机协作、审核返工全链路，补齐最后一块证据。

---

# 第二轮：配置模型后的真实运行验证（同日追加）

用户在 GUI 配置了文本模型（连接 `legacy-Y3P9-Jbxsb`，两个模型：`glm-5.3-flash`、`deepseek-v4.1-flash-1017`）。本轮把 flow 真正往"跑起来"推进，结论如下。

## 七、本轮新打通的环节（真实运行证据）

| 环节 | 操作 | 结果 |
|---|---|---|
| 模型工具调用验证 | `model.validateAgentToolCalling`（glm-5.3-flash，confirmNetwork+confirmCost）| **verified**："Agent 结构化工具调用与工具结果往返均已验证" |
| 主控完整准入 | `flowAgent.run` start | 逐一通过：模型绑定 / agent.dispatch+review.execute 工具 / allowedNodeIds 范围 / 审核责任绑定 / observes 状态机 |
| 状态机真实推进 | 主控启动 | **phase 从 draft→working**（flow.started 迁移生效，coordination-store 事务校验通过）|
| 固定版本资产提交 | 准入冻结输入 | **源素材节点成功提交 2 个不可变资产版本**（flow_asset_versions，带 versionId）——产物版本化机制真实工作 |
| 主控决策启动 | 主控运行 | 运行进入 working、decisions=1，主控确实发起了决策 |

**修正第一轮的两处判断**：
- 主控准入还要求**非空目标文本**（`coordinator-host.ts:172`）和**审核责任节点**（`responsibleNodeId`，且 subjectSources.nodeId 必须等于它，`coordinator-reviews.ts:64-75`）。
- 状态机必须用主控的**固定事件词汇**：`flow.started / agent.dispatched / agent.completed / human.wait / flow.paused / flow.completed / human.continue`（标准迁移表见 `desktop-electron.ts:1744`）。自定义事件名会被 `FLOW_STATE_TRANSITION_DENIED` 拒绝。

## 八、本轮发现的关键缺口（实锤）

### 8.1 可调度目标节点不含文本生成节点 —— 写作流程的硬伤
专家 Agent 的 `node.execute` 工具只支持 9 类目标（`video-adapter.ts:29 flowTargetContract`）：
`processor / video / image-gen / image-edit / speech / tts / image-crop / image-split / code`。
**纯 `text` / `chat` / `ai-process` 节点都不在范围内**（用 text 节点做专家目标会报 `AGENT_TARGET_UNSUPPORTED`，`failure-messages.ts:71` 明示"当前工具支持数据处理与文本生成视频"）。
→ 公众号写作这类**自由文本生成**工作流，目前没有可被 Agent 调度的文本生成目标节点。本轮被迫改用 `processor`（确定性模板透传）做目标来验证编排机制——它能证明编排闭环，但产出的不是 LLM 自由撰写的文章。**这是写作类垂类落地的第一缺口。**

### 8.2 真实供应商在主控复杂决策上失败 —— 编排跑不完的当前拦路石
- `glm-5.3-flash`：简单工具调用验证**通过**，但主控决策请求（dispatch_agent + finish_flow + wait_for_human 多工具 + 枚举收窄 inputs + 较大上下文）**两次都在约 18 秒后失败**（18.1s / 17.7s，`AGENT_MODEL_FAILED`，供应商错误码 UNKNOWN，日志按规范脱敏了原始报文）。非 30s 超时（`runtime-model.ts:385`），是供应商侧处理约 18s 后返回错误。
- `deepseek-v4.1-flash-1017`：工具调用验证**直接失败**（"模型未通过工具结果往返验证"），不能用于 Agent。
→ 编排代码已证明可用（准入/状态机/资产/决策发起全通），但**当前两个模型都无法完成主控的真实决策推理**，因此本轮没有跑完一次完整的"主控→专家→执行→产物→审核"闭环。这正是台账里 R11"真实供应商端到端未验收"缺口的具体显现——**合成夹具测试发现不了真实供应商对复杂工具调用的兼容性问题**。

## 九、修订后的总体结论

**编排机制层：已验证可用（约 85%）。** 外部建图、模型配置与验证、主控准入、状态机推进、固定版本资产、决策发起——全部真实跑通。

**真实运行层：卡在模型供应商兼容性。** 需要一个能对"多工具 + 枚举收窄 + 较大上下文"的 Agent 决策请求稳定返回合法工具调用的模型/端点。当前 glm-5.3-flash 端点在这类请求上稳定失败，deepseek 验证不过。

**垂类适配层：写作流程缺文本生成目标节点。** 即使模型问题解决，公众号写作还需要把 text/chat/ai-process 纳入可调度目标（或新增文本生成能力节点）。

## 十、给你的下一步（按优先级）

1. **换一个能稳定处理复杂工具调用的模型/端点**（最关键）。glm-5.3-flash 在简单验证通过但复杂决策失败，建议：① 确认该端点是否对工具 schema/上下文有限制；② 试 GLM 系列更高规格模型或其他供应商的强工具调用模型。给我一个候选，我立刻重跑验证完整闭环。
2. **把文本生成节点纳入 Agent 可调度目标**（写作垂类必需）——扩展 `flowTargetContract` 支持 text/ai-process，或新增专门的文本生成能力节点。这是中等开发量，沿现有契约+三入口 parity 模式。
3. 补搜索工具（资料环节）、状态机外部事件、纯人工节点（见第一轮缺口清单）。

## 十一、本轮留下的状态

- 验证项目 `qtiiB26nOWJS` 已重建为 processor 目标链（素材源→选题→资料→框架→文章），主控/专家已绑 glm-5.3-flash，状态机用标准迁移表。可在 GUI 打开查看。
- 已停止所有运行中的协调任务（最后状态 cancelled），项目处于干净可编辑状态。
- 本轮触发了真实模型调用：2 次工具调用验证（glm 通过/deepseek 失败）+ 2 次主控决策（均失败）+ 若干能力探测。均为小额文本请求。
- 调用日志：`C:\Users\ADMINI~1\AppData\Local\Temp\qwenwork\verify-log.jsonl`；诊断事件：%APPDATA%\canvas-studio\data\diagnostics\events\。
- 未改动任何源码。

---

# 第三轮：官方智谱端点 glm-5.3 测试 + 根因隔离（同日追加）

用户提供官方智谱端点 `https://open.bigmodel.cn/api/paas/v4` + 模型 `glm-5.3`（密钥已入设备密钥库，指纹 0fd7324d5ace，本报告不回显）。本轮把"是不是接口/端点的问题"彻底查清。

## 十二、官方端点能力：完全正常（多重证据）

| 测试 | 结果 |
|---|---|
| `model.validateAgentToolCalling`（glm-5.3 官方）| **verified**，两阶段全过 |
| 裸 API 复现：简单/复杂 schema、toolChoice required/auto/强制、单/多工具、流式 | **全部产出合法工具调用** |
| 裸 API + 应用注入的 `thinking:{type:enabled}` + `reasoning_effort:low` | **仍成功** |
| **用应用同款 AI SDK**（ai 7.0.73 / openai-compatible 3.0.34）+ glmCompatibleFetch 复现 streamText | **成功** |
| **用应用的精确内容**（真实主控目标+4专家完整目标+真实资产引用+精确 dispatch schema+精确系统提示）经同款 SDK 复现，连跑 5 次 | **5/5 全部成功** |

→ **官方 glm-5.3 端点完全可用，工具调用稳定可靠。** 之前 relay 的 glm-5.3-flash 与 deepseek-v4.1-flash-1017 的问题不适用于官方端点。

## 十三、但应用主控仍稳定失败 → 根因在应用侧集成，不在端点

- 应用主控用官方 glm-5.3 启动，**两次都在 decisions=1 处 `AGENT_MODEL_FAILED`**（约 7s）。
- 而**完全相同的请求**（同 SDK、同内容、同参数）在独立 Node 脚本里 5/5 成功。
- 内容仅约 1.4KB，**不是大上下文问题**；`glmRequestBody` 注入的 thinking 参数也排除了。

**结论：这不是接口不对应（不是 chat vs responses），不是端点问题，不是 GLM 能力问题。是应用运行时（Electron 主进程）里主控消费模型流的集成缺陷。** 简单探测（probe，maxOutputTokens=128、简单 schema）在应用里能过；主控（无 maxOutputTokens、复杂 schema、toolChoice=required、推理模型长思考链）在应用里稳定失败，但同样的请求脱离应用就成功。

**已排除**：端点能力、chat/responses 格式、请求内容、工具 schema、thinking 参数、SDK 版本（独立复现用同版本成功）。
**剩余嫌疑**：Electron 内嵌 Node 22 与独立 Node 24 的流处理差异；或主控运行时某个并发/abort/模型实例细节。需进一步在应用内捕获确切错误才能定位。

## 十四、关键概念澄清（回应用户疑问）

- 应用走 **Chat Completions**（`/chat/completions`，`factory.ts:54-60`），这是所有 OpenAI 兼容厂商的通用标准，**不是"该淘汰的老接口"**。Responses API 是 OpenAI 自家专有接口，第三方基本不支持。选 Chat Completions 是兼容性正确的。
- deepseek-v4.1-flash-1017（relay 代理变体）失败在"工具结果往返"阶段（能发起调用，收到工具结果续接时上游报错），两次稳定复现；与官方端点无关。

## 十五、下一步（精确定位修复）

要把应用主控真正跑通，需要捕获应用内那条失败流的确切 SDK 错误（当前被日志规范脱敏）。两条路：
1. **在应用内加临时诊断**：在 `glm-request.ts` 的 fetch 或 `runtime-model.ts` 的 coordinate 端口捕获 error part 的原始 responseBody/cause，重构建后重跑，即可拿到 GLM 返回的真实错误并对症修复。（需改受保护源码+过 parity 门禁，经你确认后我来做。）
2. **对照实验**：临时关闭 `glmRequestBody` 的 thinking 注入（或换非推理模型）重跑主控，验证是否推理流式所致。

## 十六、本轮留下的状态

- 官方连接 `zhipu-official` + 模型定义 `zhipu-official-glm-5_3` 已配置并验证通过；flow 节点已重绑到官方 glm-5.3。
- 已停止所有协调任务，项目干净可编辑。
- 本轮真实模型调用：1 次官方验证 + 约 20 次裸 API/SDK 复现探测（均小额文本）+ 2 次应用主控决策（失败）。
- 复现脚本与精确内容：temp 目录 `repro_*.py / repro_*.mjs / exact_ctx.json`。
- 未改动任何源码。