# Agent Flow 优化实施规格（可执行级，2026-11-12）

配套总体方案：[AGENT_FLOW_OPTIMIZATION_PLAN_2026_11_12.md](AGENT_FLOW_OPTIMIZATION_PLAN_2026_11_12.md)。
本文把每个批次细化到**文件、函数、Schema、代码骨架、命令、断言**。执行 Agent 按批次顺序实施；
每批结束跑全量验证，汇报 diff 摘要 + commit notes，**用户确认后才提交**。

## 执行纪律（每批通用）

```powershell
# 验证流水线（批内改动完成后）
npx tsc --noEmit -p tsconfig.web.json --composite false
npx tsc --noEmit -p tsconfig.node.json --composite false
npm run typecheck:model
node scripts/run-vitest.cjs run <本批定向测试>
npx electron-vite build
npm run guard:agent-parity; npm run verify:agent-access; npm run verify:logging
npm run test   # 全量，对照基线：provider 夹具 2 项失败、verify 基线 lint 25 条
```

- 受保护源码（`src/shared/agent-access`、`src/main/agent-access`、`src/shared/engine`、`src/main/gateway`、
  `src/main/agent-flow`、`src/renderer/src/canvas/CanvasEditor.tsx`、`graph-patch.ts` 所在 scope 等，
  完整清单见 `scripts/check-agent-access.cjs:57-74`）改动后：
  ```powershell
  # 先不带 --accept-contract-change 刷新；若报 Contract changed 说明既有 Schema 变了，停下人工审查
  node scripts/check-agent-access.cjs --write --reason "<兼容结论，≥12字>"
  node scripts/audit-business-actions.cjs --write
  ```
  刷新前用诊断脚本对比 `change-impact.json` 声明哈希与当前哈希，人工核对每个变更文件 diff。
- 构建自用版：`$env:CANVAS_OWNER='1'; npx electron-vite build`；启动验收窗口前清除 `ELECTRON_RUN_AS_NODE`。
- 系统 Node 跑 SQLite 测试报 `ERR_DLOPEN_FAILED` 属既有 ABI 问题，用 `scripts/run-vitest.cjs`（Electron ABI）跑。
- 密钥/计费：R 批需要用户本机智谱密钥；任何真实模型调用前先向用户说明计费口径。

---

## 批次 L1：共享布局纯函数（无 UI/契约改动，可独立验收）

### L1.1 新目录 `src/shared/flow-layout/`

**`types.ts`**（全部类型，无外部依赖）：

```ts
export interface LayoutNode {
  id: string
  type: string                 // node-card 的 nodeType
  x: number; y: number; w: number; h: number
  title: string
  /** agent 角色（读 config.role）；非 agent 为 undefined */
  role?: 'builder' | 'coordinator' | 'specialist'
  /** 控制关系目标（agent.allowedNodeIds / ai-review.gatedNodeIds），只读派生 */
  controls?: string[]
  gatedBy?: string[]           // 被哪些 ai-review 门禁
}
export interface LayoutEdge { from: string; to: string }   // 数据边（端口无关，布局只看节点级）
export type LayoutMode = 'auto' | 'flow' | 'lanes' | 'grid'
export interface LayoutResult {
  mode: 'flow' | 'lanes' | 'grid'
  positions: Array<{ id: string; x: number; y: number }>
  /** 诊断/验收用：分层与泳道归属 */
  ranks: Record<string, number>
  lanes: Record<string, 'control' | 'execution' | 'output' | 'review' | 'none'>
}
export interface LayoutOptions {
  columnGap?: number   // 默认 120
  rowGap?: number      // 默认 80
  origin?: { x: number; y: number }  // 默认取输入节点包围盒左上角（保持画布原位附近）
}
```

**`layering.ts`** — 最长路径分层：

```ts
export function assignRanks(nodes: LayoutNode[], edges: LayoutEdge[]): Map<string, number> {
  // 1. 邻接表 + 入度；Kahn 拓扑排序。
  // 2. 有环：环内节点（Kahn 剩余）按 id 字典序统一赋 rank = 已分层最大值 + 1，
  //    并标记 cyclic（布局不报错；执行校验仍拒绝环，职责不变）。
  // 3. rank(v) = max(rank(u) + 1)（u 为前驱）；源节点 rank = 0。
  // 4. 孤立节点（无任何边）：rank = maxRank + 1（排最右列）。
}
```

**`ordering.ts`** — 重心法减交叉：

```ts
export function orderRanks(ranks: Map<string, number>, edges: LayoutEdge[], nodes: LayoutNode[]): string[][] {
  // layers[r] = 该层节点 id 数组，初始按 title 字典序（确定性起点）。
  // 4 轮往返扫描：正向用前驱层邻居的平均索引（barycenter）排序，反向用后继层；
  // 同分按 title 字典序 tie-break。返回每层有序 id 数组。
}
```

**`coordinates.ts`** — 真实尺寸坐标：

```ts
export function assignCoordinates(layers: string[][], nodes: LayoutNode[], opts): LayoutResult['positions'] {
  // x：列宽 = 该层 max(w)；x[r] = origin.x + Σ(列宽 + columnGap)。
  // y：层内按序堆叠，y 间距 = 前一节点 h + rowGap；整层垂直居中到全局中线
  //    （全局中线 = 最高列的总高 / 2）。
  // 输出整数坐标（Math.round），保证确定性断言稳定。
}
```

**`lanes.ts`** — agent flow 角色泳道：

```ts
export function detectAgentFlow(nodes: LayoutNode[]): boolean {
  // 存在 type ∈ {agent, state-machine, ai-review} 即 true。
}
export function layoutLanes(nodes, edges, opts): LayoutResult {
  // 带分配：
  //  control   = state-machine + role=coordinator/builder 的 agent
  //  execution = role=specialist 的 agent
  //  review    = ai-review
  //  output    = 其余节点（processor/text/素材等数据链）
  // 带内布局：
  //  output 带：对 output 节点子图跑 flow 分层（复用 layering/ordering/coordinates），左→右主链。
  //  execution 带：specialist 的 x = 其 controls 中 output 节点 x 的重心；
  //    无 controls 的 specialist 按 title 排到执行带最右；多个 specialist 同重心时按 title 顺序水平错开（w + rowGap）。
  //  control 带：state-machine 在左，coordinator 紧随其右（间距 columnGap）；builder 再右。
  //  review 带：ai-review 的 x = 其 gatedBy 目标 x 的重心（无目标则对齐 output 带末端）。
  // 带间 y：control 顶行；execution = control 底 + rowGap*1.5；output = execution 底 + rowGap*1.5；
  //    review = output 底 + rowGap*1.5。各带内节点垂直居中于带高。
  // 整体平移到 origin（包围盒左上角对齐输入包围盒左上角）。
}
```

**`index.ts`** — 唯一入口：

```ts
export function layoutGraph(nodes: LayoutNode[], edges: LayoutEdge[], mode: LayoutMode, opts?): LayoutResult {
  // auto：detectAgentFlow → lanes；edges.length > 0 → flow；否则 grid。
  // grid：复用现网格算法（从 CanvasMinimap.organizeCanvas 抽取为纯函数 gridLayout，
  //       排序/列宽/行高规则逐行保持一致，原函数改为调用它）。
  // 空图返回 { positions: [], ranks: {}, lanes: {} }；单节点原位不动。
}
```

### L1.2 测试 `test/flow-layout.test.ts`（先写，≥20 项）

| 组 | 用例 |
|---|---|
| 确定性 | 同输入两次输出逐字节相等；节点输入顺序打乱结果不变 |
| flow | 链式 A→B→C ranks=0/1/2 且 x 递增；菱形 A→(B,C)→D 无重叠、B/C 同列；边全部前向（源 rank < 目标 rank） |
| 尺寸 | 混合 h=300/360/420/600 无重叠；w=880 timeline 列宽正确 |
| 环/孤立 | A→B→A 不崩溃且同层；孤立节点排最右；空图/单节点 |
| lanes | 11 节点验证 flow（§L2.7 夹具）：状态机+主控在 control 带；4 specialist 在 execution 带且各自对齐其 target；processor 链 output 带左→右；ai-review 在 review 带对齐被门禁节点 |
| lanes 边界 | specialist 无 controls；一 specialist 控多 target（重心）；多 review；无 state-machine |
| grid | 与旧 organizeCanvas 行为一致（抽取前后同输入同输出） |
| auto | 有 agent 节点→lanes；纯 DAG→flow；无边→grid |

命令：`node scripts/run-vitest.cjs run test/flow-layout.test.ts`
退出条件：全绿；`tsc --noEmit` 两配置通过；**不碰任何受保护源码**（本批无需刷契约）。

---

## 批次 L2：三入口接入 + 外部建图自动布局

### L2.1 渲染器应用函数（GUI 与外部 op 共用）

新文件 `src/renderer/src/canvas/flow-layout-apply.ts`：

```ts
import { layoutGraph, type LayoutMode } from '@shared/flow-layout'
import { deriveGraph } from './graph'
// 从 CanvasNode 派生 LayoutNode：role/controls 读 params.config（JSON.parse 容错），
// gatedBy 反向扫描 ai-review 的 gatedNodeIds。
export function applyFlowLayout(editor: Editor, mode: LayoutMode, nodeIds?: string[]): {
  mode: 'flow' | 'lanes' | 'grid'; moved: number
} {
  // 1. deriveGraph(editor) → nodes/edges；nodeIds 给定则过滤节点与两端都在 scope 内的边。
  // 2. layoutGraph(...) → positions。
  // 3. editor.run(() => editor.updateShapes(positions.map(p => ({ id, type:'node-card', x, y }))))
  //    —— 只改 x/y；不碰 config/meta。
  // 4. markUndoPoint(editor, 'flow-layout')；focusCanvas(editor)。
  // 5. 返回 { mode, moved: positions.length }。
}
```

### L2.2 GUI 入口

`src/renderer/src/canvas/CanvasMinimap.tsx`：
- `organizeCanvas`（52-105 行）改为：`applyFlowLayout(editor, 'auto')`；网格算法已抽到 shared（L1），行为兜底不变。
- 快捷键 Shift+Alt+F（237-242 行）不变；底部坞按钮 title 改「智能整理（流程分层/泳道）」，
  aria-label 同步（验收脚本按 aria-label 定位）。
- toast 提示整理模式（`已按流程分层（左→右）` / `已按角色泳道整理` / `已整理为网格`）。

### L2.3 外部 op `graph.layout`（加性契约）

**`src/shared/agent-access/graph-ops.ts`** 追加：

```ts
export const GraphLayoutInputSchema = revision.extend({
  mode: z.enum(['auto', 'flow', 'lanes', 'grid']).default('auto'),
  nodeIds: z.array(z.string().min(1).max(180)).min(1).max(GRAPH_VIEW_MAX_NODES).optional()
}).strict()
```

**`src/shared/agent-access/registry.ts`**：
- `ACCESS_OPERATIONS` 追加（graph.patch 定义旁，129 行附近）：
  ```ts
  'graph.layout': {
    effect: 'write',
    description: '对当前打开项目按拓扑分层/角色泳道/网格重排节点坐标；只改位置不改配置，单撤销步，与 GUI 智能整理同一算法',
    input: GraphLayoutInputSchema
  }
  ```
- `ACCESS_OUTPUTS` 追加：
  ```ts
  'graph.layout': z.object({
    graphVersion: z.number().int().nonnegative(),
    mode: z.enum(['flow', 'lanes', 'grid']),
    moved: z.number().int().nonnegative()
  }).strict()
  ```

**`src/shared/agent-access/desktop.ts`**：desktop action 联合追加 `graph-layout`：
`{ action: z.literal('graph-layout'), projectId, mode, nodeIds?, expectedGraphVersion, requestId, expiresAt }`（照抄 graph-patch 的握手字段）。

**`src/main/agent-access/service.ts`**：
- dispatch（469 行附近）加分支：`operationId === 'graph.layout'` → 与 graph.patch 相同的
  `this.options.desktop.run({ action:'graph-layout', ... })` 权威握手；预检只校验项目打开 + nodeIds 存在。
- 2063 行 switch 注释同步（graph.layout 同样经握手，不落本地）。

**`src/renderer/src/canvas/CanvasEditor.tsx`**（1267 行 graph-patch 处理器旁）：
新增 `request.action === 'graph-layout'` 分支，**逐行复用 graph-patch 的握手骨架**：
版本核对（REVISION_CONFLICT 带当前版本）→ `commitLocalAgentDesktop` 准入 → 过期/画布切换检查 →
`editor.run(() => applyFlowLayout(editor, request.mode, request.nodeIds))` →
保存屏障（与 graph-patch 同一 ensureCanvasSaved 路径）→ 回执 `{ graphVersion, mode, moved }`。
失败码沿用 graph-patch 口径（CANVAS_CHANGED / PATCH_NOT_ADMITTED / REVISION_CONFLICT）。

### L2.4 `graph.patch` 加 `autoLayout` 可选标志

- `registry.ts:133`：`input: revision.extend({ ops: GraphPatchOpsSchema, autoLayout: z.boolean().default(false) }).strict()`
- `service.ts:1373-1382`：desktop.run 载荷透传 `...(input.autoLayout ? { autoLayout: true } : {})`。
- `desktop.ts` graph-patch action schema 加 `autoLayout: z.boolean().optional()`。
- `CanvasEditor.tsx:1326-1329`：apply 之后、**同一 editor.run 内**（同一撤销步）：
  ```ts
  editor.run(() => {
    replanned.plan.apply(editor)
    if (request.autoLayout) applyFlowLayout(editor, 'auto')  // 全图（含新建节点）
  })
  ```
- 回执 data 追加可选 `layout?: { mode, moved }`（ACCESS_OUTPUTS graph.patch 加性扩展）。
- 语义写清：autoLayout=true 时 node.create 的 x/y 仍必填（兼容），布局覆盖坐标；
  只移动节点不改 config；旧调用（不传标志）行为逐字节不变。

### L2.5 内置构建器复用 + 高度修正

`src/main/agent-flow/builder-host.ts:530-611` `assignPreviewPositions`：
- 保留"候选原点 + 重叠探测"落位逻辑（580-606 行，与现有画布避碰）；
- **相对坐标生成**（544-565 行）改调 `layoutGraph(previewNodes, previewEdges, 'lanes')`：
  preview.nodes 映射为 LayoutNode（id 后缀 -main/-state/-agent-i/-target-i/-review-i → role/type），
  preview 的数据边从 plan.steps 派生（target 链 + agent→target）。
- `width/height` 常量（531-532 行）改 `NODE_UI.width / NODE_UI.height.default`（340×300）；
  `FlowBuildPreviewLayer.tsx:130-131` 与 `graph-patch.ts:114,205,303` 的模拟端口 h=260 同步改 300
  （这三处是既有偏差修正，跑 node-ui/freshness/graph-patch-plan 测试确认）。
- 注意：builder-host 在 main 进程，`@shared/flow-layout` 无 tldraw 依赖可直接 import（L1 保证）。

### L2.6 台账与门禁（精确步骤）

1. `docs/local-agent-access/action-coverage.json` 追加：
   ```json
   "canvas.flow_layout": {
     "label": "智能整理（流程分层/角色泳道/网格）",
     "gui": "底部坞整理按钮 / Shift+Alt+F",
     "phase": "external",
     "note": "经 graph.layout op 与 graph.patch autoLayout；与 GUI 同一 layoutGraph 纯函数，只改坐标单撤销步",
     "external": ["graph.layout", "graph.patch"]
   }
   ```
   （canvas action 清单 `CANVAS_ACTIONS` 在 audit 脚本内，需同步登记 `canvas.flow_layout`。）
2. 刷新契约（先不带 --accept-contract-change；graph.patch 输出加了可选字段属加性，
   若脚本报 Contract changed 则人工核对 diff 确认仅新增后带标志重跑）：
   ```powershell
   node scripts/check-agent-access.cjs --write --reason "加性：新增 graph.layout 操作与 graph.patch autoLayout 可选标志，布局为视图操作只改坐标；既有操作输入输出兼容"
   node scripts/audit-business-actions.cjs --write
   npm run guard:agent-parity
   ```
3. `docs/local-agent-access/02-capability-matrix.md` 补 graph.layout 行（compliance-matrix-doc 测试会核对）。
4. 定向测试：`test/flow-layout.test.ts` + `test/graph-patch-plan.test.ts` + `test/contracts.test.ts` +
   `test/compliance-matrix-doc.test.ts` + builder 相关（`test/agent-flow-builder*.test.ts`，先 glob 确认文件名）。

### L2.7 桌面验收脚本 `scripts/acceptance/agent-flow-layout.cjs`

入仓 + package.json `"acceptance:agent-flow-layout"`。复用 composite-desktop-acceptance 的
隔离骨架（临时数据目录 + 复制本机 security + `[TEST]` 标题 + 退出清理）。**不依赖模型/密钥/计费。**

步骤与断言：
1. CLI 建项目打开；`graph.patch` + `autoLayout:true` 建 11 节点验证 flow：
   state-machine×1、coordinator×1、specialist×4（allowedNodeIds 各指 1 个 processor）、
   processor×5（素材源→选题→资料→框架→文章 数据边链）、ai-review×1（gatedNodeIds=[文章]）。
   坐标故意乱填（模拟外部 Agent 手拍）。
2. `graph.get` 读回坐标 → 断言：
   - 任意两卡片矩形零重叠（含 32px 间距）；
   - processor 链 x 严格递增（流程可读）；
   - 每个 specialist 的 x 中心 ≈ 其 target x 中心（±40px）；
   - state-machine/coordinator y < specialist y < processor y < ai-review y（带序）；
   - 回执 `layout.mode === 'lanes'`。
3. CLI `graph.layout`（mode:'flow'）重排 → 断言数据边全部前向；再 `mode:'grid'` → 网格断言。
4. GUI：Playwright 打开同项目，手工打乱（node.update 随机坐标）→ 点击底部坞整理按钮
   （aria-label 定位）→ 截图 `layout-before.png` / `layout-after.png` → 断言画布坐标与 CLI lanes 结果一致（parity）→
   Ctrl+Z 一步 → 断言恢复打乱坐标（单撤销步）。
5. MCP：`graph_layout` 工具存在且调用结果与 CLI 一致。
6. 回执写 `qa/agent-flow-layout/receipt.json` + 截图。

退出条件：脚本全过；全量测试对照基线无新增失败；门禁三关绿；汇报 diff + notes 待确认提交。

---

## 批次 R1：捕获主控真实错误（需用户密钥 + 小额计费，先说明再执行）

### R1.1 插桩（临时，CANVAS_FLOW_DEBUG 门控）

**`src/main/agent-flow/runtime-model.ts:435-436`**（确切失败点，error part 当前被丢弃）：

```ts
for await (const part of result.fullStream)
  if (part.type === 'error') {
    if (process.env.CANVAS_FLOW_DEBUG === '1') {
      // 仅开发诊断：写本地 qa 文件，不进事件日志/数据库（脱敏红线）。
      const e = part.error as { message?: string; responseBody?: string; cause?: unknown; statusCode?: number }
      const safe = {
        at: new Date().toISOString(), phase: 'coordination',
        message: String(e?.message ?? '').slice(0, 500),
        statusCode: e?.statusCode,
        responseBody: String(e?.responseBody ?? '').slice(0, 4000),
        cause: String((e?.cause as Error)?.message ?? e?.cause ?? '').slice(0, 500)
      }
      // 过滤授权头残留（responseBody 理论上不含请求头，仍做兜底替换）
      const text = JSON.stringify(safe).replace(/Bearer\s+[A-Za-z0-9._-]+/gi, 'Bearer <redacted>')
      require('node:fs').appendFileSync(
        require('node:path').join(process.env.CANVAS_DATA_DIR || '.', 'flow-debug.jsonl'), text + '\n')
    }
    throw new AgentRuntimeError('AGENT_MODEL_FAILED', 'coordination')
  }
```

- 诊断文件落在隔离数据目录（`CANVAS_DATA_DIR`），不落在仓库；验收后随临时目录清理。
- 同批在 `glm-request.ts` fetchNoRedirect（29-38 行）加**可选**响应状态记录（仅 CANVAS_FLOW_DEBUG=1，
  记 status/url pathname，不记 body/headers）——用于区分 4xx/5xx/流中断。
- 生产路径（CANVAS_FLOW_DEBUG 未设）逐字节不变；`verify:logging` 必须过（无新事件、无旁路）。

### R1.2 门禁与构建

```powershell
node scripts/check-agent-access.cjs --write --reason "临时诊断插桩：CANVAS_FLOW_DEBUG 门控写本地文件，生产路径与日志口径不变，R2 修复后移除"
npm run guard:agent-parity; npm run verify:agent-access; npm run verify:logging
$env:CANVAS_OWNER='1'; npx electron-vite build
```

### R1.3 本机模型配置（CLI，密钥由用户提供，走设备密钥库）

```text
model.connection.save  { protocol:'openai-compatible', baseUrl:'https://open.bigmodel.cn/api/paas/v4', apiKey:<用户密钥> }
model.definition.save  { connectionId, modelId:'glm-5.3', capabilities:['text.generate'] }
model.validateAgentToolCalling { definitionId, confirmNetwork:true, confirmCost:true }
```
（字段名以 `ops/model.ts` 实际 Schema 为准，执行前先读；validate 真实计费，小额探针。）

### R1.4 复现与取证

1. 启动：清 `ELECTRON_RUN_AS_NODE`，`electron.exe . --local-agent-access`，`CANVAS_FLOW_DEBUG=1`、`CANVAS_DATA_DIR=<隔离目录>`。
2. 按验证报告 §七建 flow（或复用 L2 验收脚本的 11 节点夹具 + 主控目标文本）。
3. `flowAgent.run { nodeId:<主控>, action:'start' }` → 等待失败 → 读 `<隔离目录>/flow-debug.jsonl`。
4. 记录：真实错误结构（statusCode/responseBody/cause）→ 写入 `docs/agent-flow-verification-20261112/`
   新增诊断记录 md（脱敏后）。
5. 若 OUTCOME_UNKNOWN：查 `flow_coordination_runs` 表核对，不盲目重试；改图前 `flowAgent.stop` 释放。

退出条件：拿到应用内真实错误（或确证流被 abort 的时序证据）；插桩仍在（R2 移除）；门禁绿。

---

## 批次 R2：对照实验 + 修复 + 移除插桩

### R2.1 实验矩阵（每次只变一个变量，应用内重跑主控，记录结果）

| # | 操作点 | 变量 | 判定 |
|---|---|---|---|
| E1 | `glm-request.ts:20-25` 临时 return body（跳过 thinking 注入） | thinking 开关 | 若 E1 成功 → 推理流解析问题 |
| E2 | model.definition 换非推理模型（同端点，如 glm-4-plus，以用户账号可用为准） | 模型族 | 若 E2 成功 → reasoning_content 特有 |
| E3 | `runtime-model.ts:382` streamText 加 `maxOutputTokens: 4096` | 输出上限 | 若 E3 成功 → 长思考链/无上限流异常 |
| E4 | 用 `repro_sdk.mjs` 在 Electron 内嵌 Node（`ELECTRON_RUN_AS_NODE=1 electron.exe repro_sdk.mjs`）跑 | 运行时 | 若 E4 失败而系统 Node 成功 → Node 22 流差异 |
| E5 | 检查 coordinate 的 signal 来源（coordinator-host 调用处）与 30s timeout | abort 时序 | 失败发生在 ~7s，非 30s 超时；核对是否提前 abort |

### R2.2 修复与回归

- 按 R1 真实错误 + 矩阵结论对症修（候选：SDK reasoning 流解析适配、fetch 流兼容、thinking 参数策略）。
- 修复点若在 `glm-request.ts`/`factory.ts`/`runtime-model.ts`：附**流夹具回归测试**
  `test/agent-flow-glm-stream.test.ts`——录制 reasoning_content + tool_calls 的 SSE 帧序列为夹具，
  mock fetch 喂给 SDK/适配层，断言决策解析成功；不依赖网络。
- **移除 R1 全部插桩**（runtime-model/glm-request 恢复 + 诊断分支删除），grep 确认 `CANVAS_FLOW_DEBUG` 零残留。
- 门禁三关 + 全量测试；契约刷新（修复若改受保护源码）。

退出条件：应用内主控决策成功（真实模型，decisions=1 产出 dispatch_agent）；回归测试绿；插桩零残留。

---

## 批次 L3：连线治理 + 可读性（Stitch mockup 先行）

### L3.0 Stitch（项目 18414626961577825789，设计系统 assets/60a542ef636f47c3be36db7c97c45990）

生成 1 屏 mockup：lanes 布局后的 agent flow 画布（四带 + 角色徽标 + 控制线三色 + 反向边外弧），
只调整既有元素风格；下载留档 qa/，作为走查基准。

### L3.1 端口扇出排序

`src/renderer/src/canvas/node-port-layout.ts:70-131` `createNodePortLayout`：
- 现状：锚点顺序 = groupTypes 声明顺序。
- 改：同类型组内多锚点时，按对端节点中心 y（deriveGraph 可得）排序分配 offset；
  无对端信息的端口保持声明序。**端口 id/类型分组不变**，只改视觉 Y 落点。
- 测试：`test/node-port-layout.test.ts`（先 glob 确认现有测试名）加扇出排序用例 + 既有用例不回归。

### L3.2 反向边外弧

`src/renderer/src/canvas/edge-geometry.ts`：

```ts
export function buildDataEdgePath(start, end, opts?: { backward?: boolean }): string {
  // backward（源 x >= 目标 x，调用方 DataEdgeLayer 按节点中心判定）：
  //   控制柄沿垂直方向：弧顶 = min(start.y, end.y) - arcLift（arcLift = 60 + |dx|*0.1，上限 160），
  //   M start C (start.x, start.y - arcLift) (end.x, end.y - arcLift) end —— 从上方绕过中间卡片。
  // 前向：保持现公式逐字节不变（回归零风险）。
}
```
`DataEdgeLayer.tsx:164-167` 与 `ConnectionLayer.tsx` 调用处传 backward；
`agent-flow-relation-geometry.ts` rework 关系：chooseAnchors 评分对 rework 强制下弧（source bottom → target bottom）。

### L3.3 控制线按 kind 着色

`AgentFlowRelationLayer.tsx:120,143` 统一色 → 按 kind 取 CSS 变量：
`--flow-relation-controls`（现青）/ `--flow-relation-observes`（灰蓝）/ `--flow-relation-review`（琥珀）/ `--flow-relation-rework`（玫红）；
变量定义在 `agent-flow-relations.css`，值走应用主题变量体系（Stitch mockup 定色）。图例：关系标签已含中文文案，不新增控件。

### L3.4 hover 聚焦

`DataEdgeLayer.tsx` + `AgentFlowRelationLayer.tsx`：读现有选中态（editor.getSelectedShapes）；
选中节点时无关边 opacity 0.15、相关边保持——纯渲染派生，不落盘、不改 meta。
（若现有 spotlight 机制已覆盖节点，边层复用同一选中信号，避免两套状态。）

### L3.5 角色徽标

`src/renderer/src/nodes/specs/agentFlow.tsx` `AgentFlowBody`（74-261 行）：
header 区加小 chip：coordinator→「主控」、specialist→「专业」、builder→「搭建」；
样式复用现有 badge class（CSS 变量），state-machine/ai-review 不加（已有身份色+Body 状态）。

### L3.6 验收

- 定向：node-port-layout / edge-geometry（新增 backward 用例）/ node-ui 相关；
- 桌面走查：复用 L2 脚本建 flow → 截图对照 Stitch mockup → 断言反向边不穿卡（几何采样）；
- 全量 + 门禁；汇报待确认提交。

---

## 批次 R3：真实闭环验收（计费，先说明）

新脚本 `scripts/acceptance/agent-flow-closed-loop.cjs`（入仓 + npm script）：
1. 隔离环境 + 本机模型配置（R1.3）；建 11 节点 flow（L2 夹具 + autoLayout）。
2. `flowAgent.run` start → 轮询 `flowAgent.inspect`：
   断言状态机 draft→working；decisions≥1 产出 dispatch；specialist 执行 processor；
   `flow_asset_versions` 出现固定版本资产；审核通过 → flow.completed。
3. 失败路径：构造审核拒绝（rejectPolicy=rework）→ 断言 rework 关系触发返工、maxReworks 上限生效。
4. 全程台账断言（flow_coordination_runs 状态/阶段），截图 + 回执 qa/agent-flow-closed-loop/。
5. 此批同时覆盖节点流 W4「真实模型端到端」；W4 其余项（重启恢复/付费核对/人工补交）单列后续批次，不混入。

---

## 批次 C1-C3：能力补齐（闭环跑通后，逐个独立批）

### C1 文本生成可调度（写作垂类）
- `src/shared/agent-flow/video-adapter.ts:29` `flowTargetContract` 支持类型追加 `text` / `ai-process`
  （先读该文件确认联合类型与派生逻辑）；`runtime-model.ts:370-430` dispatch schema 的 inputs 类型随之扩展。
- 专家工具执行路径（`runtime-model.ts:508-551`）确认 text/ai-process 的 node.execute 语义（确定性文本合并/模型处理）。
- 契约加性刷新 + 定向测试（agent-flow 目标契约用例）+ 桌面验收：写作专家调度 text 节点产出文章。

### C2 联网搜索工具
- 先定供应方（用户决策：搜索 API 供应方与密钥）；`flowAgent.catalog` 工具集增 `web.search`，
  受控网络（confirmNetwork）、日志事件先注册（events.ts）、结果作为候选资产注入（不静默采用）。
- 独立方案评审后再实施（涉及新网络路径与计费）。

### C3 状态机外部事件 + 输出投影
- 新 op `flowStateMachine.submitEvent`：`{ projectId, nodeId, event, expectedRevision }`，
  事件词汇校验复用 `desktop-electron.ts:1744` 标准迁移表；GUI 等价入口 = 状态机 Body 现有「提交事件」按钮。
- `output.get` 支持 state-machine 投影（currentState/revision/legalEvents），消除 UNSUPPORTED_CONTRACT。
- 审计映射 + 契约刷新 + 定向测试 + CLI/MCP/GUI parity 验收。

---

## 附录 A：批次依赖与顺序

```
L1 ──► L2 ──────────────► L3（Stitch 先行）
        │                    │
        └──► R1 ──► R2 ──► R3 ──► C1 ──► C3 ──► C2（需供应方决策）
             （需用户密钥 + 计费说明）
```
L1/L2 可立即开工（无密钥无计费）；R1 开工前向用户要本机智谱密钥并说明计费口径。

## 附录 B：commit notes 模板（每批提交前给用户确认）

```text
feat(agent-flow)/fix(agent-flow): <批次标题>

根因：<为什么改>
改动：<文件级清单 + 契约变化（加性/无）>
验证：<定向 N 项 / 全量 3218± 对照基线 / 门禁 159± 操作 / 桌面验收 N 项>
未验证边界：<人工点击 / 真实模型 / 像素对齐等如实列出>
台账：<docs 更新链接>
```

## 附录 C：已知基线（不得伪造绿）

- `test/local-agent-provider-network-access.test.ts` 2 项失败（provider 夹具，与本方案无关）。
- `npm run verify` 卡基线 lint 25 条（activate-dev-license.cjs / license-tool.cjs）。
- `recovery-contention` 全量负载波动项：再现先复现真实竞争，不放宽断言。
- 系统 Node 的 SQLite ABI 限制：用 scripts/run-vitest.cjs。