# Canvas Studio UI 全面审查报告与优化方案

> 审查日期：2026-10-26 · 范围：`source/src/renderer` 全部界面 + 共享分类定义
> 配套设计稿：Stitch 项目「Canvas Studio UI 规范优化 2026-10」（见文末）

---

## 一、审查结论（TL;DR）

共发现 **4 个 P0 问题**（其中 3 个为你直接指出的，全部属实、已在代码中定位到根因）和 **4 个 P1/P2 一致性问题**。核心修复方向：

1. **新建项目弹窗的「高级」按钮是一个没有任何 CSS 定义的"幽灵类"**，所以它按浏览器裸按钮渲染成你截图里那条突兀的灰色横条 —— 不是设计如此，是样式丢失。
2. **`workflow` 图标被三处共用**：新建项目弹窗头图、「流程与高级」分类、「状态机」节点，必须拆开。
3. **节点详情面板 tab 栏被 CSS 写死为固定 4 列网格**，Agent 节点的第 5 个「协作」tab 必然折行；建议整体改为**左侧垂直图标 tab 栏（Rail）**，4 tab 与 5 tab 永远同一布局。
4. **「流程与高级」10 个节点混装了三种性质的东西**，建议拆为「AI 与自动化」+「数据与代码」两类，分镜板/3D 预演台并入「视频创作」。

---

## 二、P0 问题明细

### P0-1 新建项目弹窗「高级」控件无样式（你截图中的灰色横条）

**根因定位**：`src/renderer/src/components/ProjectCreateDialog.tsx:315-326`

```tsx
<button type="button" className="project-create-config-toggle" aria-expanded="false" ...>
  <Icon name="settings" size={14} />
  高级：自定义可见工具（默认沿用上次配置，当前 {selected.size} 项）
</button>
```

- `.project-create-config-toggle` 这个类名**在整个项目的所有 CSS 文件中都没有定义**（已全量 grep 确认，`project-create-dialog.css` 516 行里也没有）。
- 它实际按浏览器默认 `<button>` 渲染，再叠加全局 `ui-surfaces.css:1191` 的 `button { border: 0 !important; }`，最终呈现为一条无圆角、无内边距、占满整行的灰色裸条 —— 与弹窗其余精致的深色圆角风格完全不搭。
- 展开态的「收起工具配置」按钮（同文件 :197-207）用了同一个幽灵类，同样裸奔。

**修复**：为该类补齐规范样式（ghost 按钮形态），并顺势重构弹窗信息架构，见方案 C。

### P0-2 `workflow` 图标三处冲突

| 使用处 | 位置 | 图标 |
|---|---|---|
| 新建项目弹窗品牌头图 | `ProjectCreateDialog.tsx:159` | `workflow` |
| 「流程与高级」分类 | `palette-categories.ts:47` | `workflow` |
| 「状态机」节点 | `agentFlow.tsx:875` | `workflow` |

你说的"流程与高级和新项目是同一个图标"属实。状态机节点用流程图图标语义正确，应保留；弹窗头图与分类图标需要换。

### P0-3 节点详情面板：第 5 个 tab 必然折行（5 tab 无侧边栏布局）

**根因定位**：

- Tab 列表：`canvas/NodeContractPanel.tsx:612-634`，固定 4 项（概览 / 输入输出 / 设置 / 运行），仅 `agent` 节点动态追加第 5 项「协作」。
- 布局：`assets/app.css:4296-4309`

```css
.contract-tabs {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));  /* 写死 4 列 */
}
```

Agent 节点打开详情面板时，「协作」被挤到第二行，且只占 1/4 宽度，观感破碎。另有双层样式维护问题：`ui-surfaces.css:1719-1731` 后加载覆盖了 `app.css` 的 tab 字号（10px → 13px）、高度，两处改一处容易漂移。

**修复**：统一改为左侧垂直 Rail（图标 + 文字），见方案 B。

### P0-4 「流程与高级」分类语义模糊，需要拆分

**现状**（`src/shared/palette-menu-order.ts:13-30`）：`logic` 分类下混装 10 个节点：

| 组 | 节点 | 实际性质 |
|---|---|---|
| AI 协作 | agent（Agent）、ai-review（AI 审核）、state-machine（状态机） | Agent 编排/自动化 |
| 数据加工 | processor（数据处理）、json、structured（结构数据）、iterate（循环）、code（代码） | 纯数据/本地代码 |
| 创作预演 | storyboard（分镜板）、director（3D 预演台） | 视频叙事工具 |

三种性质互相都不挨着，"流程与高级"这个名字无法预示里面有什么。

---

## 三、P1/P2 一致性问题（同轮清查发现）

**P1-1 「输入与 AI」分类同样语义混合。**
`input` 分类（`palette-menu-order.ts:14`）= 文本/文件/网址（输入素材）+ ai-process（AI 处理）/ chat（AI 对话）（AI 能力）。拆出 AI 分类后应更名「输入与素材」。

**P1-2 弹窗色系与全局 token 脱节。**
`project-create-dialog.css` 硬编码独立深色系（底 `#141721`、卡片 `#1a1e2b`、主色 `#06b6d4` 青色），而全局生效 token 是 `ui-foundation.css:8-25`（`--bg #111419`、`--card #20242a`、`--brand #42b9f5`）。同一应用里两种"深色蓝"，色温和主色都对不上。

**P1-3 AI 审核节点没有「协作」tab。**
`NodeContractPanel.tsx:619` 仅对 `agent` 追加协作 tab，但 `ai-review` 同样参与 Agent 流程的协作回路（接受/拒绝/返工，`AgentCollaborationPanel.tsx`），其审核标准却只能去「设置」里找。建议协作 tab 覆盖 agent / ai-review / state-machine 三类 Agent 系节点（state-machine 可只读展示状态推进记录）。

**P2-1 Agent 系节点视觉语言不统一。**
agent=`spark`、ai-review=`check`、state-machine=`workflow`，颜色各自独立（`NODE_ACCENTS`），画布上没有"这一组属于 Agent 编排体系"的家族感。画布控制关系虚线层（`AgentFlowRelationLayer.tsx`）与节点卡的 accent 也没有共享色板。

**P2-2 tab 无图标、纯文字，密度低识别慢。**
面板宽度 `clamp(350px, 25vw, 390px)`（ui-surfaces.css:1687），5 个中文 tab 横排本来就挤；改垂直 Rail 后建议每项配 20px 图标，形成可复用的 tab 规范。

---

## 四、优化方案

### 方案 A：分类重组 —— 5 类 → 6 类

| 新分类 | 包含节点 | 图标 | 主色（沿用现体系饱和度） |
|---|---|---|---|
| 输入与素材 | text、file、website | `upload` | 粉 #F472B6 |
| 图片创作 | image-gen、image、image-edit、image-crop、image-split | `image` | 绿 #4ADE80 |
| 视频创作 | video、video-asset、video-clip、video-frame、video-depth、video-clay、**storyboard、director** | `video` | 蓝 #60A5FA |
| 声音创作 | speech、audio、tts、voice-design、sound-adjust | `audio` | 紫 #C084FC |
| **AI 与自动化**（新） | **agent、ai-process、chat、ai-review、state-machine** | `spark` | 品牌蓝 #42B9F5 |
| **数据与代码**（新） | **processor、json、structured、iterate、code** | `code` | 橙 #FB923C |

- 分镜板、3D 预演台本质服务视频叙事（分镜表/白模 previs），并入「视频创作」后该类 8 个节点仍可接受；若想保持 6 个以内，也可将两者留在「数据与代码」，**推荐前者**（用户视角它们是创作工具）。
- 落地点：`palette-menu-order.ts`（分组）、`palette-preferences.ts`（`NODE_CATEGORY_IDS` 增至 6）、`palette-categories.ts`（meta + 图标 + 色）、新建项目弹窗自动跟随（它遍历 `NODE_CATEGORY_IDS`）。

### 图标重新分配（消除冲突）

| 对象 | 现状 | 改为 |
|---|---|---|
| 新建项目弹窗头图 | `workflow` ❌ | `layers`（项目 = 画布集合） |
| 「AI 与自动化」分类 | — | `spark` |
| 「数据与代码」分类 | — | `code` |
| 「输入与素材」分类 | `text` | `upload` |
| 状态机节点 | `workflow` | 保留 ✅ |

### 方案 B：节点详情面板统一 Tab 规范（核心交付）

**横排 4 列 grid → 左侧垂直 Rail**，全部节点类型同一布局，4 tab 与 5 tab 永不折行：

```
┌──────────────────────────────┐
│ 🔷 Agent                  ✕  │  ← 节点名 + 节点色图标
├──────┬───────────────────────┤
│ ◇ 概览 │                      │
│ ⇄ 输入输出 │   内容区（滚动）   │
│ ⚙ 设置 │                      │
│ ▶ 运行 │                      │
│ ◈ 协作 │                      │  ← 仅 Agent 系节点出现
├──────┴───────────────────────┤
```

Rail 规范（写入 token）：
- Rail 宽 72px；每项：图标 20px + 文字 11px，纵向 12px 间距；圆角 8px；active 用**节点 accent 色**（10% 底 + 全亮文字），hover 用 `--card-hover`。
- 内容区宽度补偿：面板宽 `clamp(380px, 26vw, 420px)`。
- tab 顺序与语义固定：**概览 → 输入输出 → 设置 → 运行 →（协作）**；所有节点的概览 tab 统一为「描述 + 连线规则 + 2×2 状态格」结构（现状已有，固化为规范）。
- 状态徽标（就绪/运行中/错误/完成）固定出现在 Rail「运行」项右上角，替代现在散落在内容里的状态展示。

### 方案 C：新建项目弹窗重构

1. **修复幽灵类**：`.project-create-config-toggle` 定义为标准 ghost 按钮（透明底、1px `--line` 边框、14px 圆角、`--muted` 文字、hover 提升），不再裸奔。
2. **信息架构**：名称输入 → 一条「高级：自定义可见工具（当前 N 项）」ghost 折叠条（左侧 `settings` 图标 + 右侧 chevron）→ 展开后为搜索框 + 6 分类分区（分类头沿用彩色图标 + N/M 计数 + 全选）。
3. **色彩接入全局 token**：`#06b6d4` → `var(--brand)`，底/卡/线改用 `--bg/--card/--line`，与主界面同一深色系。
4. 头图换 `layers` 图标（P0-2）。

### 方案 D：Agent 体系 UI 规范

- 「协作」tab 覆盖 agent / ai-review / state-machine 三类（state-machine 只读展示阶段推进记录）。
- Agent 系节点共享一组"编排色"家族（节点卡 accent 条 + 控制关系虚线同源），画布上一眼识别"这是 Agent 编排体系"。
- 协作面板信息层级固定为：任务状态 → 目标 → 输入引用 → 资产版本 → 操作（接受/拒绝/修订）。

---

## 五、Stitch 设计稿

Stitch 项目：**Canvas Studio UI 规范优化 2026-10**（`projects/1822171761107212658` · DESKTOP · 深色主题 · 设计系统「Obsidian Slate Canvas」`assets/0d3ecb57ad1c4cbab96003246ac62e96`）

| # | 屏幕 | Screen ID | 对应方案 |
|---|---|---|---|
| 1 | 节点检查器 · Agent（5-tab 垂直 Rail · 协作激活态） | `9cc695ecbc554633a598c71c531005c9` | 方案 B |
| 2 | 节点检查器 · 生图（4-tab 同一 Rail 规范 · 输入输出激活态） | `c8cf287ea4e3402e91dba2e39a7c1cb9` | 方案 B |
| 3 | 新建项目弹窗 · 重构终态（修复幽灵类 + 文案校正版） | `9b8f7c16df5a43779176ed963bc63283`（初版 `5e5d4afb4e05440eb46c456cf6a82d4a`） | 方案 C |
| 4 | 节点创建菜单 · 6 分类新体系（AI 与自动化展开态） | `28946383a5e04a8a8a22279c38668556` | 方案 A |

本地截图归档：`.stitch/designs/01-agent-inspector-5tab.png`、`02-image-inspector-4tab.png`、`03-new-project-dialog-fixed.png`、`04-node-menu-6-categories.png`。

## 六、落地改动清单（代码侧待办）

1. `project-create-dialog.css`：新增 `.project-create-config-toggle` 规范样式（ghost 按钮），色系改接 `ui-foundation.css` token；`ProjectCreateDialog.tsx:159` 品牌图标 `workflow` → `layers`。
2. `palette-menu-order.ts` + `palette-preferences.ts` + `palette-categories.ts`：分类 5 → 6（新增 `ai`、`data`，移除 `logic`；storyboard/director 并入 `video`；ai-process/chat 移入 `ai`），图标与颜色按方案 A 分配。注意 `NODE_CATEGORY_IDS` 变更会影响 localStorage 中的分类排序偏好，需做迁移兜底。
3. `NodeContractPanel.tsx` + `app.css`/`ui-surfaces.css`：`.contract-tabs` 改垂直 Rail；tab 定义抽成常量并统一 4/5 tab 两种形态；协作 tab 覆盖 `agent/ai-review/state-machine`。
4. `agentFlow.tsx:875`：状态机图标保留 `workflow`；Agent 系三节点 accent 色板与 `AgentFlowRelationLayer` 虚线同源。
