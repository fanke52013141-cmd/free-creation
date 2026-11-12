# Agent Flow L3 连线治理交付（2026-11-12）

依据：[优化方案](AGENT_FLOW_OPTIMIZATION_PLAN_2026_11_12.md) §1.4-1.5、[实施规格](AGENT_FLOW_EXECUTION_SPEC_2026_11_12.md) 批次 L3。
前置批次：L1/L2 布局（未提交）、R1/R2/R3 根因与闭环（未提交）。

> GUI 证据为 Playwright 驱动真实 Electron 的合成事件（非人工点击）；窗口 `[TEST]` 标识、
> 隔离数据目录、退出清理。人工点击与逐像素对齐仍单列未验证。

## 1. 完成项

### 1.1 反向边外弧路由（L3.2）
- `edge-geometry.ts`：`buildDataEdgePath` 增 `backward` 选项——反向边（源中心在目标右侧）
  改走卡片上方外弧，控制柄垂直、弧顶与跨度成比例（与前向边同一等比约定）；
  **前向路径公式逐字节不变**（单测断言）。新增 `isBackwardEdge` 共享判定。
- 调用点同步：`DataEdgeLayer`（正式数据边 + 产物追溯线）、`ConnectionLayer`（拖拽预览 + 菜单临时引线）。
- `agent-flow-relation-geometry.ts`：`preferBottom` 选项——返工线评分偏好底边→底边
  （外法线向下自然成下弧），穿卡罚分仍优先（避障让位有单测）。

### 1.2 控制线按语义着色（L3.3）
- `AgentFlowRelationLayer`：四类关系独立 marker + CSS 变量着色：
  controls=青（--brand）、observes=灰蓝（--txt-dim）、review-gate=琥珀、rework=红（--danger）。
- 实测 computed stroke 四色互异：`rgb(66,185,245) / rgb(115,127,142) / rgb(232,179,65) / rgb(231,76,60)`。

### 1.3 选中聚焦淡化（L3.4）
- `DataEdgeLayer`：`useValue` 追踪选区（实例态，不触发几何重算），两端都不在选区的边
  （含追溯线）加 `is-dimmed`（opacity 0.15）；选中/悬浮态优先级更高保持可交互。
- `AgentFlowRelationLayer`：同口径淡化无关关系与标签。
- 实测：选中 processor → 3/5 数据边淡化、相连 2 条保持；选中专家 → 9/11 关系淡化、
  自身 controls 保持；Escape 取消选中后全部恢复。

### 1.4 角色徽标（L3.5）
- `AgentFlowBody`：agent 卡片头部紧凑 chip「主控/专业/搭建」，颜色走节点身份色体系。
- 形状按项目设计系统裁决：**2px 圆角硬边微矩形 + 1px 描边**（设计系统明确禁止胶囊徽标）。
- 与被裁决移除的"专业 Agent 摘要行"无关：单行小 chip，不撑高正文。
- 实测：主控×1 + 专业×4 渲染正确。

### 1.5 L3.1 端口扇出排序——降范围说明（诚实记录）
规格原计划按对端位置排序端口锚点。实施前核对发现：本仓库端口按类型分组共享锚点，
且设计约束明确要求**锚点稳定**（"candidates use spare slots without moving anchors"）；
按对端动态排序会在拖动/连线时移动锚点，违反该约束并增加渲染抖动。agent flow 节点
每侧通常单锚点，扇出交叉收益极小。**本批不做**，留待出现真实多锚点交叉案例再评估。

## 2. 验证证据

- 定向单测：`edge-geometry`（+5 项：前向零回归/外弧几何/等比/判定）、
  `agent-flow-relation-geometry`（+2 项：preferBottom 下弧/避障让位）、
  `edge-visual-extents`、`flow-layout` 共 **49 项全过**。
- 桌面走查：`npm run acceptance:agent-flow-edges`
  （`scripts/acceptance/agent-flow-edges-walkthrough.cjs`，不依赖模型/密钥/计费）
  **8 项全过**，回执与截图 `qa/agent-flow-edges/`（gitignore 本地留档）：
  泳道全景 / processor 聚焦 / 专家聚焦三张截图。
- 全量 `npm run test`：**290 文件、3251 过、2 失败（已知 provider 基线）、7 跳过**，零新增。
- 门禁：`guard:agent-parity` / `verify:agent-access` / `verify:logging` 全绿
  （160 操作 / 32 节点 / 190 IPC + 48 canvas actions）；agentFlow.tsx 受保护源码影响声明已刷新
  （纯呈现改动，无契约变化，不带 --accept-contract-change 刷新成功）。
- 类型：web/node 检查通过；`electron-vite build` 通过。

## 3. 未完成 / 未验证边界

- **Stitch mockup 未生成**：两次调用均连接失败（Connection closed / fetch failed），
  按工具指引未再重试；设计决策改为直接遵循项目既有设计系统（已读取 designMd：
  硬边徽标/1px 描边/无阴影/紧凑密度）。视觉走查以 DOM 断言为准。
- 媒体读取网关本批不可用，截图人工复核未做；颜色/几何/淡化均由 DOM computed style 与
  路径采样客观断言覆盖。
- 人工鼠标点击手感、窄屏布局未验证。
- 反向边外弧在极端密集布局下仍可能与其他线交叉（mask 兜底防穿卡）；正交绕障路由为 V2 备选。
- 基线失败不变：provider 夹具 2 项；verify 基线 lint 25 条（本批文件零新增 lint 错误）。