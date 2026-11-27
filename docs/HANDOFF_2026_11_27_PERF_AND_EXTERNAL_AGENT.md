# HANDOFF 2026-11-27：大画布节点速率优化、外部 Agent 优先架构收口与一键对接说明

> 状态：**全部改动已合并在主分支 `main` 并推送 `origin/main`，单测、四端类型检查、铁律门禁与规范门禁全绿**
> 基线前提交：`8da7d5a0`（`test(agent-flow): drive native human confirmation in remediation acceptance`）
> 本轮核心提交：`f4ff06e1` → `9ba67c56` → `73f31f5c` → 本交接提交
> 上一交接：[HANDOFF_2026_11_26_SPEC_CONVERGENCE.md](./HANDOFF_2026_11_26_SPEC_CONVERGENCE.md)

---

## 0. 一句话结论

本轮在**100% 保持既有节点契约、UI 呈现规范与 GUI/CLI/MCP 一致性不变**的前提下，完成了两大主线升级并全部落地主分支 `main`：
1. **画布与节点全链路速率优化**：消除拖拽/连线/缩放热路径中的 $O(N^2)$ 扫描与同步 DOM 重排，引入**带滞回防抖的四档自适应性能策略**（≤60 节点零视觉削减）及主进程/渲染侧闭环的 **2x Retina 缩略图与视频首帧并发/LRU 缓存**；
2. **外部上帝 Agent 优先架构收口（拍板去内置上帝 Agent、交由外部）**：将 MCP 默认切换为轻量 `core` 档位（24 核心工具 + 3 渐进发现元工具，`tools/list` 体积压缩 >90%），退役内置 `role: 'builder'` 创建入口，落地**方案 A `graph.patch.propose / confirm / discard`**（全 34 节点 + 复合节点流幽灵预览、改/删差异框高亮、BL-01 桌面人工确认门禁），并在主页顶栏「重载」左侧新增 **「Agent 对接」一键复制完整接入说明按钮**。

---

## 1. 已拍板的核心架构裁决（后续接手请勿回退）

1. **性能优化分级原则（零体验削减优先）**：
   - 底层算法/索引/订阅/数学命中/缓存优化（Tier 0）全规模常驻生效，0 视觉削减；
   - 视觉/DOM 节流按规模带滞回区间自动切换：**Tier 1**（>60 进入 / <45 退出，离屏节点休眠 800px/LRU 40，选中/编辑/运行中永不休眠）、**Tier 2**（>150 节点或 >200 边进入 / <120 且 <160 退出，仅活跃边流光、拖拽暂停装饰动画、亮色关闭卡片 blur、跳过隐藏 `.data-edge-hit` DOM）、**Tier 3**（>300 节点或 >400 边进入 / <260 且 <340 退出，LRU 16 / 边距 500px）；
   - **媒体 2x 缩略图独立阈值**（>15 个媒体节点开启 / <10 退出），`zoom > 1.5` 自动升无损原图，大图预览弹窗与执行器始终使用原图；
   - **远景概览 LOD 默认关闭**（`enableOverviewLod: false`），不强行简化节点内容。
2. **不内置上帝 Agent，大脑交由外部强 Agent（Claude Code / Cursor / Codex / Antigravity 等）**：
   - 内置 `role: 'builder'`（`BuildPlanSchema`）已退役：GUI 职责下拉移除新建入口，`FlowBuilderControls` 移除内置模型建图触发（仅保留历史节点只读提示与既有预览收口），`flowAgent.build.*` 标为历史兼容废弃并移出 MCP `core` 档位；
   - 内部 `coordinator-host.ts` **冻结新自主编排概念扩张**（不再堆砌复杂单人多角色/循环内审核等内置大脑）；Canvas Studio 聚焦做好**全 34 节点 + 复合节点流执行宿主、幽灵预览与桌面人工确认安全阀**。
3. **外部建图主路径确立为方案 A（`graph.patch.propose` → 幽灵预览 → 人工确认）**：
   - 避免外部 Agent 被 `capability-catalog.ts` 的 7 节点白名单卡死，直接解锁全部 **34 类活跃节点 + 已发布复合节点流**；
   - `graph.patch.confirm` 强制绑定 BL-01 桌面人工确认门禁（`interactive: true`，`requestHumanDecision`），拒绝/超时/无桌面均零副作用。

---

## 2. 本轮提交与关键代码清单

### 2.1 `f4ff06e1` — 画布与节点全链路速率优化（Batch A–D 核心）

- **底层共享索引与订阅瘦身**：
  - [`src/renderer/src/canvas/node-page-index.ts`](../src/renderer/src/canvas/node-page-index.ts)、[`node-port-layout.ts`](../src/renderer/src/canvas/node-port-layout.ts)、[`node-run-duration-index.ts`](../src/renderer/src/canvas/node-run-duration-index.ts)：增量 `store.listen` 跳过位置/正文/配置变更，预排 `incomingByNode` / `orderedIncomingByNode` / `outgoingByNode` / `portConnections` / `counts`；
  - [`src/renderer/src/canvas/port-occlusion-index.ts`](../src/renderer/src/canvas/port-occlusion-index.ts)（新增）：512px 空间网格哈希 + rAF 合并的编辑器级端口遮挡索引；
  - [`src/renderer/src/canvas/use-computed-value.ts`](../src/renderer/src/canvas/use-computed-value.ts)（新增）、[`src/renderer/src/nodes/nodeValues.ts`](../src/renderer/src/nodes/nodeValues.ts)（`WeakMap` 投影缓存）、[`src/renderer/src/stores/gateway.ts`](../src/renderer/src/stores/gateway.ts)、[`src/renderer/src/canvas/model-availability.ts`](../src/renderer/src/canvas/model-availability.ts)；
  - [`src/renderer/src/canvas/NodeCardView.tsx`](../src/renderer/src/canvas/NodeCardView.tsx)：隔离运行遮罩（空闲卡 0 计时器/0 IPC）、端口跟随改写 CSS 变量、稳定 `ResizeObserver`、`MemoizedNodeBody`、仅订阅 `draft?.from ?? null`。
- **交互热路径与纯数学命中测试**：
  - [`src/renderer/src/canvas/edge-hit-math.ts`](../src/renderer/src/canvas/edge-hit-math.ts)（新增）+ [`DataEdgeLayer.tsx`](../src/renderer/src/canvas/DataEdgeLayer.tsx) + [`CanvasEditor.tsx`](../src/renderer/src/canvas/CanvasEditor.tsx)：消除 `querySelectorAll('.port-dot')`、`getBoundingClientRect`、`getBBox`、`isPointInStroke` 同步重排；`DataEdgeLayer` 过滤非几何文档变更并移除冗余 `.data-edge-glow`；自动保存接入 `requestIdleCallback`；
  - 覆盖层零负载短路：[`FlowBuildPreviewLayer.tsx`](../src/renderer/src/canvas/FlowBuildPreviewLayer.tsx)、[`AgentFlowRelationLayer.tsx`](../src/renderer/src/canvas/AgentFlowRelationLayer.tsx)、[`GroupOutlineLayer.tsx`](../src/renderer/src/canvas/GroupOutlineLayer.tsx)、[`MultiSelectToolbar.tsx`](../src/renderer/src/canvas/MultiSelectToolbar.tsx)、[`CanvasMinimap.tsx`](../src/renderer/src/canvas/CanvasMinimap.tsx)、[`canvas-wheel-routing.ts`](../src/renderer/src/canvas/canvas-wheel-routing.ts)、[`connection-drag.ts`](../src/renderer/src/canvas/connection-drag.ts)、[`ui-foundation.css`](../src/renderer/src/assets/ui-foundation.css)。
- **四档自适应档位、离屏休眠与主进程缩略图缓存**：
  - [`src/renderer/src/canvas/canvas-performance-tier.ts`](../src/renderer/src/canvas/canvas-performance-tier.ts)、[`canvas-performance-tiers.css`](../src/renderer/src/canvas/canvas-performance-tiers.css)、[`node-viewport-gate.ts`](../src/renderer/src/canvas/node-viewport-gate.ts)、[`NodeCardShape.tsx`](../src/renderer/src/canvas/NodeCardShape.tsx)；
  - [`src/main/media/thumb-cache.ts`](../src/main/media/thumb-cache.ts) + [`src/main/index.ts`](../src/main/index.ts)（`media://?w=128|680|1024` 原生 `nativeImage` 缓存）+ [`src/renderer/src/nodes/specs/bodies/media-thumbnail-core.ts`](../src/renderer/src/nodes/specs/bodies/media-thumbnail-core.ts)（视频抽帧并发限 2 + Blob URL LRU 120 自动释放）。

### 2.2 `9ba67c56` — 外部 Agent 优先架构收口、方案 A 幽灵预览与 2x 缩略图全接线

- **MCP 渐进式发现（`core` 档位）**：
  - [`src/local-agent/mcp-profile.ts`](../src/local-agent/mcp-profile.ts)（新增）+ [`src/local-agent/index.ts`](../src/local-agent/index.ts)：默认 `core` 档位暴露 24 个高频工具 + `canvas_ops_search` / `canvas_ops_schema` / `canvas_ops_call` 3 个元工具，附带 `MCP_SERVER_INSTRUCTIONS`；保留 `--profile full` / `CANVAS_MCP_PROFILE=full`（`scripts/mcp-acceptance*.cjs` 与 `test/local-agent-access.test.ts` 已显式传 `--profile full`）。
- **退役内置 `builder`**：
  - [`src/renderer/src/nodes/specs/agentFlow.tsx`](../src/renderer/src/nodes/specs/agentFlow.tsx)、[`FlowBuilderControls.tsx`](../src/renderer/src/nodes/specs/FlowBuilderControls.tsx)、[`src/shared/agent-access/ops/flow-agents.ts`](../src/shared/agent-access/ops/flow-agents.ts)。
- **方案 A 全 34 节点幽灵预览 + 改/删高亮**：
  - [`src/main/agent-access/graph-patch-preview.ts`](../src/main/agent-access/graph-patch-preview.ts)（新增，复用 `flow_builds(source='patch')`，输出 `nodes`/`edges`/`updatedNodeIds`/`deletedNodeIds`）；
  - [`src/shared/agent-access/registry.ts`](../src/shared/agent-access/registry.ts)、[`metadata.ts`](../src/shared/agent-access/metadata.ts)、[`src/main/agent-access/service.ts`](../src/main/agent-access/service.ts)：新增 `graph.patch.propose`、`graph.patch.confirm`（`interactive: true` + `requestHumanDecision`）、`graph.patch.discard`；
  - [`src/main/ipc/flow-agents.ipc.ts`](../src/main/ipc/flow-agents.ipc.ts)、[`src/preload/index.ts`](../src/preload/index.ts)、[`FlowGraphPreviewPanel.tsx`](../src/renderer/src/canvas/FlowGraphPreviewPanel.tsx)、[`FlowBuildPreviewLayer.tsx`](../src/renderer/src/canvas/FlowBuildPreviewLayer.tsx)、[`flow-build-preview.css`](../src/renderer/src/canvas/flow-build-preview.css)：支持画布叠加「拟修改」蓝虚线框与「拟删除」红虚线框，点击「确认落画布」走同一 `planGraphPatch` 单撤销步 + 保存屏障。
- **渲染侧 2x 图片缩略图全节点接线**：
  - [`src/renderer/src/canvas/use-media-display-url.ts`](../src/renderer/src/canvas/use-media-display-url.ts)（新增），已接入 `image.tsx`、`image-edit.tsx`、`shared.tsx`（`MediaResultGrid`）与 `ConnectedInputPreview.tsx`（引用条视频改用 `VideoThumb`）。
- **文档与契约同步**：
  - 新增 [`docs/local-agent-access/EXTERNAL_AGENT_SKILL.md`](./local-agent-access/EXTERNAL_AGENT_SKILL.md)，同步更新 [`docs/BACKLOG.md`](./BACKLOG.md)、[`docs/LOGGING_COVERAGE.md`](./LOGGING_COVERAGE.md)、[`action-coverage.json`](./local-agent-access/action-coverage.json)、[`generated/contracts.json`](./local-agent-access/generated/contracts.json)（当前 **194 operations / 34 active nodes**）与 [`change-impact.json`](./local-agent-access/change-impact.json)。

### 2.3 `73f31f5c` — 主页顶栏「Agent 对接」一键复制详细对接说明

- [`src/renderer/src/lib/external-agent-brief.ts`](../src/renderer/src/lib/external-agent-brief.ts)（新增）：从 `GENERATED_NODE_CONTRACTS` 与 `ACCESS_OPERATIONS` 动态生成完整对接说明书（含 MCP `core` 配置、CLI 命令、当前工作区项目 ID 列表、4 步工作流、`graph.patch.propose` 示例、全部 34 类节点与输入/输出端口速查表、安全铁律与错误码处理）。
- [`src/renderer/src/pages/ProjectListPage.tsx`](../src/renderer/src/pages/ProjectListPage.tsx)：在顶栏 **「重载」按钮左侧**新增 **「Agent 对接」** 按钮（点击一键复制到剪贴板并弹出 Toast）。

---

## 3. 验证证据、门禁结果与日志边界

| 检查项 | 结果与范围 |
| --- | --- |
| 新增与定向单元测试（Electron ABI） | ✅ 全绿：`test/canvas-performance-tier.test.ts`、`test/edge-hit-math.test.ts`、`test/local-agent-mcp-core-profile.test.ts`、`test/graph-patch-preview-access.test.ts`、`test/external-agent-brief.test.ts`、`test/home-dev-reload.test.ts`、`test/local-agent-interactive-timeout.test.ts`、`test/local-agent-parity.test.ts`、`test/local-agent-human-gates.test.ts`、`test/node-compliance.test.ts`、`test/node-ui-decisions.test.ts`、`test/canvas-interaction.test.ts`、`test/ui-foundation.test.ts` |
| `npm run typecheck` | ✅ 四端 0 报错（`node` / `web` / `license-protocol` / `issuer`） |
| `npm run guard:agent-parity` | ✅ 三关全绿（契约 194 ops / 34 active nodes；业务动作分母 205 IPC + 50 canvas actions；日志门禁通过） |
| `npm run verify:agent-access` | ✅ 通过（194 operations; 34 active nodes） |
| `npm run verify:specs` | ✅ 通过（含本文档新增后的规范与断链检查） |
| 日志覆盖与脱敏 | ✅ `graph.patch.propose/confirm/discard` 复用公共 `agent.access.*`、`agent.human_decision.rejected` 与 `agent.desktop.*`；缩略图缓存、渲染热路径与主页复制按钮不新增业务日志，不记录提示词、正文或密钥（已登记 [`docs/LOGGING_COVERAGE.md`](./LOGGING_COVERAGE.md)） |

### 诚实的未覆盖边界

- 本轮未在真机用外部 MCP 客户端（如 Claude Code / Cursor / Antigravity）跑真实付费模型端到端创作链；
- 本轮未重跑完整 `npm run verify` 与 Windows 安装包构建；
- 大画布（200+/500+ 节点）实际桌面 FPS 与显存占用尚未做自动化真机 benchmark 录数；
- 既有发版边界（`code` 节点沙箱审计、Windows named pipe 最小 ACL、R09 物理掉电、多供应商付费回归）维持 [`docs/BACKLOG.md`](./BACKLOG.md) 登记状态不变。

---

## 4. 接手后的建议下一步（按优先级）

1. **P1 · 真实外部 Agent 联调实测（最值得立刻做）**：用真实 Claude Code / Cursor / Antigravity 粘贴主页「Agent 对接」生成的说明并连上 `node out/main/local-agent.js mcp serve`，实跑 2～3 条真创作链（文案→生图→视频→人工确认落画布→执行读结果），根据真实卡壳点微调 `node.type.get` 示例配置与错误提示。
2. **P2 · 生产目录测试代码剥离与巨无霸拆分**：将 `src/main/agent-flow/` 下的 19 个纯测试/验收文件（6,527 行，含 3,506 行的 `desktop-electron.ts`）迁出 `src/main/`；逐步按域拆分 `src/main/agent-access/service.ts`（3,360 行）。
3. **P2 · 超大画布主进程异步保存 + 性能基准脚本**：评估将 `projects.repo.ts` 的 `saveProject` 升级为异步落盘（保留进程锁与原子替换），补齐 50 / 200 / 500 节点帧率基准脚本。
4. **发版前 · 全量 `npm run verify` 与剩余安全边界**：补齐 `code` 节点沙箱边界审计、Windows 安装包实测与多供应商真实模型验证。
