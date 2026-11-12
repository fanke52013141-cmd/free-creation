# Agent Flow 优化方案（2026-11-12）

依据：[端到端验证交接](HANDOFF_2026_11_12_AGENT_FLOW_VERIFICATION.md)、[验证报告](agent-flow-verification-20261112/REPORT.md)、
[节点流执行方案](composite/WORKFLOW_IMPLEMENTATION_PLAN.md)。本方案覆盖两条主线：
**A. 画布布局与连线治理**（用户当前最痛：排布乱、看不出流程、线乱）；**B. 运行时根因修复与能力补齐**（交接 §7）。
所有批次遵循三入口 parity、节点契约、日志规范；改动不自动提交，每批全量验证通过后征求确认再提交。

---

## 0. 现状诊断（代码实测，非猜测）

### 0.1 画布为什么乱——五个根因

| # | 根因 | 证据 |
|---|---|---|
| 1 | **外部建图坐标全靠调用方手填**：`graph.patch` 的 `node.create` x/y 必填、无缺省、无布局辅助。验证 flow 的 11 个节点坐标是临时拍的 | `src/shared/agent-access/graph-ops.ts:38-39` |
| 2 | **唯一的"画布整理"是纯网格**：Shift+Alt+F 按当前位置排序塞进 `ceil(sqrt(n))` 列网格，完全不读边和拓扑——整理完还是看不出流程 | `src/renderer/src/canvas/CanvasMinimap.tsx:52-105` |
| 3 | **数据边永远右出左入的单段贝塞尔**：反向边翻折成 S 型；无交叉最小化；端口锚点按声明顺序均分，不按对端位置排序；"避障"只是 SVG mask 把穿卡部分裁掉（线在卡片下消失又冒出） | `edge-geometry.ts:23-29`、`DataEdgeLayer.tsx:164-167,561-577`、`node-port-layout.ts:70-131` |
| 4 | **内置构建器布局是固定角色模板且只支持 ≤4 步**：main 在 (0,0)、agent/target/review 分三行；节点高度还按旧的 260px 算（现在默认 300px）；外部建图根本不走它 | `src/main/agent-flow/builder-host.ts:530-611`、`src/shared/agent-flow/builder.ts:54-87` |
| 5 | **仓库没有任何拓扑布局代码**：无 dagre/elk；`topologicalOrder` 只用于执行排序不产生坐标；控制关系线有选边避卡打分但没有多线交叉最小化 | 全仓搜索确认；`agent-flow-relation-geometry.ts:255-331` |

结论：**乱不是渲染 bug，是缺一个"懂拓扑的布局层"**。现有渲染假设"左→右流动"，
只要节点按拓扑分层排好，绝大多数线自然变顺；反之任何手工坐标都救不了。

### 0.2 运行时拦路石（交接实测结论）

编排机制层已打通约 85%（外部建图/模型验证/主控准入/状态机推进/固定版本资产）。
唯一运行级失败：应用内主控决策稳定 `AGENT_MODEL_FAILED`（decisions=1，约 7s），
同款 AI SDK + 精确内容（`exact_ctx.json`）脱离应用 5/5 成功 → 根因在 Electron 主进程
消费模型流的集成（嫌疑：Node 22 下 reasoning_content + 工具调用流解析 / thinking 注入 / abort 时序）。
简单 probe 能过、主控（复杂 schema + toolChoice=required + 无 maxOutputTokens + 长思考链）稳定挂。

---

## 1. 主线 A：画布布局与连线治理

### 1.1 设计原则

1. **布局是视图操作**：只改 shape x/y，不碰 config/业务语义/契约 Schema；单撤销步可回退（沿用 `markHistoryStoppingPoint` 模式）。
2. **一份纯函数，三入口同源**：布局算法放 `src/shared/flow-layout/`（无 tldraw/Electron 依赖，输入节点矩形+边+角色，输出坐标），GUI 按钮、CLI/MCP op、内置构建器、外部建图全部复用——满足 parity 铁律，且可单测。
3. **不引新依赖**：agent flow 图规模小（验证 flow 11 节点；主画布 DAG 通常 <50），自研分层布局（Sugiyama-lite）足够，确定性输出便于验收断言。若未来图规模上千再评估 elkjs。
4. **尊重既有裁决**：不恢复已删除的关闭确认/手动边界编辑器；卡片动作层沿用第三轮裁决样式。

### 1.2 布局算法（批次 L1）

新模块 `src/shared/flow-layout/`，两种模式 + 一个兜底：

**模式一：flow（通用 DAG 分层，左→右）**
1. **分层**：对数据边 DAG 做最长路径分层（源节点 rank=0；`rank(v)=max(rank(u)+1)`）。环/孤立节点：环内节点按 DFS 序降级为同层并标记（布局不报错，执行校验仍拒绝环）；孤立节点排最右列。
2. **层内排序**：重心法（barycenter）4 轮往返扫描，按相邻层邻居的平均位置排序，最小化交叉；同分按标题字典序保证确定性。
3. **坐标分配**：x = 累计列宽（每列取该层真实最大 w + 列间距 120）；y = 层内按真实 h 堆叠 + 行间距 80，整层垂直居中对齐到全局中线。全部用 `NODE_UI` 真实尺寸（340×300 起步，读 shape 实际 w/h）。
4. **输出**：`{ positions: Map<nodeId,{x,y}>, ranks, lanes? }`，纯数据，调用方决定如何应用。

**模式二：lanes（agent flow 角色泳道，检测到 agent/state-machine/ai-review 节点时默认）**

以验证 flow（状态机+主控+4 专家+4 processor+审核，11 节点）为例：

```
┌─ 控制带 ─────────────────────────────────────────────┐
│  [状态机]  ←observes→  [主控 Agent]                   │
├─ 执行带 ─────────────────────────────────────────────┤
│  [选题专家]   [资料专家]   [框架专家]   [写作专家]      │
│      │controls    │            │            │        │
├─ 成果带 ─────────────────────────────────────────────┤
│  [素材源] → [选题processor] → [资料] → [框架] → [文章] │
├─ 审核带 ─────────────────────────────────────────────┤
│                              [AI 审核] ←review-gate─┘ │
└──────────────────────────────────────────────────────┘
```

- **控制带**（顶行）：state-machine 与 coordinator 并排，observes 线短横线。
- **执行带**：specialist 按数据流顺序左→右（排序依据：其 allowedNodeIds 对应 target 在成果带的位置；无依据时重心法）。
- **成果带**：target 节点（processor 等）按数据边分层排成左→右主链——**这就是"看得出的流程"**；每个 specialist 垂直对齐到它控制的 target 上方，controls 虚线变成短竖线。
- **审核带**（底行）：ai-review 对齐到被门禁节点下方；rework 返工线走带外下弧（见 1.4）。
- 多 target/扇出：一个 specialist 控制多个 target 时居中对齐到其 target 组的重心。
- 角色识别只读 config（role 字段）与节点类型，不改 config。

**模式三：grid（兜底）**：现有网格整理保留，用于无连线的素材堆 canvas；入口文案区分"整理网格"与"整理流程"。

**测试（纯函数，先写）**：确定性（同输入同输出）、无卡片重叠、DAG 边全部前向（源 rank < 目标 rank）、泳道角色分配正确、环/孤立节点不崩溃、真实尺寸（300/360/420 高）不重叠、空图/单节点。

### 1.3 三入口接入（批次 L2）

| 入口 | 改动 | 契约影响 |
|---|---|---|
| **GUI** | 底部坞"整理"升级为智能整理：检测到 agent flow 节点 → lanes；有数据边 → flow；否则 grid。Shift+Alt+F 同行为；单撤销步 + `focusCanvas` | 无（视图操作） |
| **CLI/MCP** | 新 op `graph.layout`：`{ projectId, mode?: 'auto'|'flow'|'lanes'|'grid', nodeIds?: string[] }`，复用同一纯函数，走 graph.patch 同一权威宿主写口（批量 node.update x/y，原子、单撤销步） | 加性新操作；登记 registry + action-coverage + parity 门禁 |
| **外部建图** | `graph.patch` 输入加可选 `autoLayout?: boolean`：为 true 时本批创建完成后对**新建节点**（可选含全图）跑一次布局。外部 Agent 一次调用即得整齐 flow，不再手填坐标 | 加性可选字段；x/y 仍必填（兼容），autoLayout 时坐标被布局覆盖并在回执注明 |
| **内置构建器** | `assignPreviewPositions` 改调共享布局（替换固定模板），高度 260→真实 NODE_UI；预览层同步 | 无 Schema 变化 |

`graph.layout` 与 `autoLayout` 的 GUI 等价入口就是整理按钮——审计映射写清，不留 EXTERNAL_ONLY 例外。

### 1.4 连线治理（批次 L3）

布局解决 80% 的线乱；剩余 20% 按优先级：

1. **端口扇出排序**：`createNodePortLayout` 的锚点 Y 顺序改为按对端节点 rank/y 排序（端口身份与类型分组不变，只改视觉落点顺序），同源多边不再天然交叉。
2. **反向边路由**：数据边若源 rank ≥ 目标 rank（反馈/回环），改走卡片上方/下方的外弧贝塞尔（控制柄沿垂直方向），不再翻折 S 型穿过中间节点；rework 控制线同规则走下弧。
3. **控制线按 kind 着色**：controls 保持青色虚线；review-gate 琥珀、rework 玫红、observes 灰蓝——语义一眼可辨（颜色走 CSS 变量，Stitch 出 mockup 确认）。
4. **hover 聚焦**：选中/悬浮节点时，无关边降到 15% 透明度，相关边高亮——交互式解乱（只读视图态，不落盘）。
5. **mask 保留为兜底**：分层后穿卡应极少；mask 裁剪保留防极端布局，但验收断言"flow 布局后数据边零穿卡"。
6. （V2 备选）正交绕障路由与主控→多专家线束 bundling：仅当 1-5 后仍有明显交叉再评估，不预先做。

### 1.5 可读性辅助（批次 L3 内，小改）

- **角色徽标**：agent 卡片头部加小 chip「主控/专业/搭建」（现在角色只在设置面板可见）；state-machine/ai-review 已有身份色与 Body 状态显示，不动。
- **流程方向提示**：智能整理后 toast 提示"已按流程分层（左→右）"；不新增持久化形状、不自动建背景板（避免侵入用户画布）。
- 涉及视觉改动先用 **Stitch**（项目 `18414626961577825789`，设计系统 `assets/60a542ef636f47c3be36db7c97c45990`）出泳道/徽标/线色 mockup，只调整既有元素风格，不新增控件类型。

### 1.6 布局验收（真实桌面）

新脚本 `scripts/acceptance/agent-flow-layout.cjs`（入仓，`npm run acceptance:agent-flow-layout`）：
1. CLI `graph.patch` + `autoLayout:true` 建 11 节点验证 flow（不依赖模型/密钥/计费）；
2. 断言：卡片零重叠、成果带数据边全部前向、specialist 与其 target 垂直对齐、控制带/审核带角色正确；
3. GUI 点击智能整理（先手工打乱坐标）→ 截图前后对比 → 撤销一步恢复原坐标；
4. `graph.layout` CLI/MCP 调用与 GUI 结果坐标一致（parity 断言）；
5. 截图留档 qa/，窗口 `[TEST]` 标识、退出清理。

---

## 2. 主线 B：运行时根因修复（交接 §7 展开）

### 2.1 批次 R1：捕获应用内真实错误（最关键，解锁一切）

现状：`model.request.failed` 按日志规范脱敏只有 UNKNOWN，拿不到 GLM 真实报错。

**插桩方案（临时、受控、合规）**：
- 位置：`src/main/agent-flow/runtime-model.ts` coordinate 端口（约 435-468 行）的 stream error part + `src/main/gateway/glm-request.ts` 自定义 fetch（41-53 行）。
- 方式：仅当环境变量 `CANVAS_FLOW_DEBUG=1`（开发诊断开关，默认关）时，把 error part 的 `responseBody`/`cause`/`statusCode` 写入 **qa/ 下本地诊断文件**（gitignore）。**不进事件日志、不进数据库**——脱敏红线不破；生产路径零变化。
- 受保护源码改动 → 同包刷新影响声明 + 过 `guard:agent-parity` / `verify:agent-access` / `verify:logging`；插桩代码在 R2 修复后**移除**，不留后门。
- 复现：自用版构建（`CANVAS_OWNER=1`）+ `--local-agent-access` 启动；本机需先配智谱连接与模型定义（密钥设备绑定，**需要用户提供本机密钥**）；`flowAgent.run` start → 读诊断文件拿真实错误。
- 计费控制：主控单次决策约 1.4KB 上下文，小额；验证前 confirmNetwork+confirmCost 口径不变。

### 2.2 批次 R2：对照实验 + 修复

按嫌疑度排序的对照矩阵（每次只变一个变量，应用内重跑主控）：

| 实验 | 变量 | 验证假设 |
|---|---|---|
| E1 | 关闭 `glmRequestBody` thinking 注入（glm-request.ts:20-25） | 推理流式解析问题 |
| E2 | 换非推理模型（同端点） |  reasoning_content 特有 |
| E3 | 主控请求加 maxOutputTokens（如 4096） | 无上限长思考链触发流异常 |
| E4 | 独立 Node 24 跑应用同款流消费代码 vs Electron Node 22 | 运行时流处理差异 |
| E5 | 检查 abort controller / 并发 dispatch 时序 | 提前中断 |

拿到 R1 真实错误后对症修复（大概率是 SDK 对 reasoning 流 + tool_calls 的解析或 fetch 流适配）；
修复附**回归测试**：用录制的流夹具（mock stream fixture）覆盖 reasoning+tool_calls 组合，不依赖真实网络。
移除全部插桩，门禁全绿。

### 2.3 批次 R3：完整闭环验收

新脚本 `scripts/acceptance/agent-flow-closed-loop.cjs`：
主控启动 → 状态机 draft→working → 分派专家 → processor 执行 → 固定版本资产提交 → 审核放行 → flow.completed；
断言各阶段真实台账（flow_coordination_runs / flow_asset_versions），失败可定位到节点/阶段。
需要真实模型（计费），跑通后截图+回执留档。此批同时覆盖节点流 W4 的"真实模型端到端"诉求。

### 2.4 能力缺口（批次 C1-C4，P2，闭环跑通后）

| 批次 | 缺口 | 方案要点 |
|---|---|---|
| C1 | **文本生成不可调度**（写作垂类硬伤） | `flowTargetContract`（video-adapter.ts:29）扩展 text/ai-process；dispatch schema 与专家工具同步；契约加性变更过门禁 |
| C2 | 无联网搜索工具 | flowAgent.catalog 增搜索工具（受控网络、confirmNetwork、日志接入）；需先定搜索供应方 |
| C3 | 状态机外部事件 + 输出投影 | 新 op `flowStateMachine.submitEvent`（固定事件词汇校验）+ `output.get` 支持状态机投影；GUI 已有事件提交按钮，补外部等价入口 |
| C4 | 纯人工任务节点 / headless 宿主 | human-task 一等节点（契约+Body+调度语义）；headless 需架构评审，单列方案不预先承诺 |

---

## 3. 执行顺序与批次纪律

推荐顺序（理由：布局批不依赖密钥/计费，立即解决用户当前痛点；运行时需要用户密钥与真实计费，并行准备）：

1. **L1+L2**（布局纯函数 + 三入口）→ 布局验收脚本全过
2. **R1+R2**（错误捕获 + 修复）→ 需要用户本机智谱密钥；插桩移除、回归测试绿
3. **L3**（连线治理 + 可读性，Stitch mockup 先行）→ 视觉走查
4. **R3**（闭环验收）→ 真实模型证据
5. **C1→C2→C3**（能力补齐，C4 单列评审）

每批纪律（按用户工作偏好）：
- 改动按批实施，批内完成后重跑**全量测试**（定向 + `npm run test`）与门禁三关，全绿才汇报；
- 基线失败如实区分（provider 夹具 2 项、verify 基线 lint 25 条、SQLite ABI 环境限制），不伪造绿；
- **不自动提交**：每批汇报附 git diff 摘要 + 详细 commit notes（根因/改动/验证），征求确认后才 commit/push；
- 受保护源码改动同包刷新契约快照与影响声明，人工核对 diff，纯加性优先（不带 --accept-contract-change 刷新验证）。

## 4. 风险与兼容

- **布局不动业务**：只写 x/y，config/契约/运行语义零变化；`graph.layout`/`autoLayout` 为加性契约，旧调用不受影响。
- **节点高度不一致**（builder/预览/graph-patch 模拟端口按 260，实际 300）：L2 统一改读 NODE_UI，属修正既有偏差，需跑 node-ui/freshness 相关测试确认无回归。
- **确定性**：布局排序含字典序 tie-break，同图同输出——验收可断言坐标，CLI/MCP/GUI parity 可机器比对。
- **密钥安全**：R 批全程密钥走设备密钥库/环境变量，不进仓库、不进日志、不进诊断文件（诊断文件只记错误结构，记前过滤授权头）。
- **不恢复已裁决删除的行为**：关闭确认、手动边界编辑器不复活；布局入口沿用现有底部坞/右键体系。

## 5. 交付物清单

| 批次 | 代码 | 文档/证据 |
|---|---|---|
| L1+L2 | `src/shared/flow-layout/*`、graph.layout op、graph.patch autoLayout、GUI 整理升级、builder 修正 | 布局单测、`acceptance:agent-flow-layout` 回执+截图、台账 |
| R1+R2 | 临时插桩（后移除）、GLM 集成修复、流夹具回归测试 | 诊断文件（本地）、对照实验记录、台账 |
| L3 | 端口扇出排序、反向边路由、控制线着色、hover 聚焦、角色徽标 | Stitch mockup、视觉走查截图、台账 |
| R3 | 闭环验收脚本 | 真实模型运行台账+截图 |
| C1-C3 | 目标契约扩展、搜索工具、状态机外部 op | 契约快照 diff、门禁、定向测试 |

每批更新对应 HANDOFF/交付台账；本方案本身作为后续执行 Agent 的接手依据。