# Canvas Studio UI 整体优化方案

> 基于 2026-08-31 完整代码排查编写，所有问题均有 file:line 证据。

---

## 问题诊断概览

| # | 问题 | 根因 | 影响 |
|---|------|------|------|
| 1 | 左侧图标区域底部空间浪费 | `.node-palette { bottom: 80px }` 预留过多 | 节点多时需滚动，底部却空着 |
| 2 | 节点按钮仍有边框/背景框 | `ui-foundation.css:201-212` 的 `background` 和 `box-shadow` 覆盖了 `app.css` 的 `transparent`（CSS 加载顺序导致） | 用户多次反馈"框还在" |
| 3 | 底部按钮样式不统一 | `.palette-item`（工具栏）和 `.dock-btn`（导航）是两套完全不同的样式系统 | 视觉割裂 |
| 4 | aiProcess 节点排版拥挤 | `NoModelHint` 被塞进横向 `.ai-row` 且不提前 return（对比 image-gen 正确地提前 return） | 错误提示和其他配置挤在一起 |
| 5 | 右键/双击交互重叠 | 双击空白和右键空白都弹 `NodeCreateMenu`；右键节点弹 `NodeContextMenu`，功能分裂 | 操作混乱 |
| 6 | 创建菜单太长无分类 | `NodeCreateMenu` 是扁平列表，约 20+ 节点平铺，无分组 | 可读性差 |

---

## 一、左侧图标面板延伸

### 现状
- `.node-palette` 的 `bottom: 80px`（`ui-foundation.css:679`），为左下角停靠簇预留空间
- 但停靠簇已移至 `left: 350px`，不再与面板重叠

### 方案
- 将 `bottom` 从 `80px` 改为 `14px`，与底部工具栏底部对齐
- `.palette-node-scroll` 的 `flex` 限制从 `0 1 640px` 改为 `1 1 auto`，让滚动区自适应填充剩余高度

### 改动文件
- `ui-foundation.css:679` — `bottom: 80px` → `bottom: 14px`
- `app.css:735` — `flex: 0 1 640px` → `flex: 1 1 auto`

---

## 二、彻底去除节点按钮边框/背景框

### 根因（为什么之前改了三次还有框）
CSS 加载顺序：`app.css`（第 1）→ `ui-foundation.css`（第 2）→ `ui-surfaces.css`（第 3）。
`app.css` 设的 `background: transparent` 被后加载的 `ui-foundation.css` 和 `ui-surfaces.css` 覆盖了。

### 方案：清除三处残留

| 文件 | 行 | 当前 | 改为 |
|------|-----|------|------|
| `ui-foundation.css` | 201-205 | `.palette-item { background: rgba(28,33,40,0.88); border-color: ... }` | 删除 `background`、`border-color`，只保留 `color` |
| `ui-foundation.css` | 207-212 | `.palette-item:hover { background: rgba(40,46,55,0.96); box-shadow: 0 8px 20px... }` | 删除 `background`、`box-shadow`、`border-color`，只保留 `color: var(--txt)` |
| `ui-surfaces.css` | 664-674 | `.canvas-theme-light .palette-item { background: linear-gradient(...); box-shadow: ... }` | 删除 `background`、`box-shadow`、`border-color`（浅色主题也不再有框） |

### 效果
节点按钮只剩图标 + 文字，无任何背景框、边框线、阴影。鱼眼放大效果保留。

---

## 三、按钮统一样式 + 布局重组

### 3a. 统一按钮样式

将 `.dock-btn`（导航按钮）和 `.palette-item`（工具栏按钮）统一为同一套视觉规范：

```css
/* 统一 Dock 按钮 */
.dock-btn,
.palette-item {
  display: flex;
  align-items: center;
  justify-content: center;
  border: none;
  background: transparent;
  color: var(--muted);
  cursor: pointer;
  transition: transform 0.18s cubic-bezier(0.16, 1, 0.3, 1), color 0.15s ease;
}

.dock-btn:hover,
.palette-item:hover {
  color: var(--brand);
}
```

### 3b. 布局调整

**左下角**：只保留小地图导航（`.canvas-dock`，含放大/缩小/适配/重置）
- 定位：`position: fixed; left: 14px; bottom: 14px`

**右下角**：上传/资产/流程/历史/运行/主题（`.palette-utility`）
- 定位：`position: fixed; right: 14px; bottom: 14px`
- 横向排列，鱼眼放大保留

### 改动文件
- `app.css` — `.palette-utility` 的 `left: 14px` → `right: 14px`
- `ui-surfaces.css` — `.canvas-dock` 的 `left: 350px` → `left: 14px`（回左下角）
- `app.css` — `.dock-btn` 样式统一

---

## 四、节点内部排版修复

### 4a. AI 处理节点（aiProcess）— 最优先

**问题**：`NoModelHint` 被塞进横向 `.ai-row`（`aiProcess.tsx:98-109`），与"模型"标签挤在一起，下方配置照常渲染。

**方案**：参照 image-gen 的正确做法，在 Body 函数开头提前 return：

```tsx
// aiProcess.tsx — 在渲染配置表单之前
if (options.length === 0) {
  return <NoModelHint onOpen={() => openSettings()} />
}
// 有可用模型才渲染完整配置
```

### 4b. 对话节点（chat）— 补引导

**问题**：未配置模型时只显示灰色"未选择模型"文字，无跳转按钮。

**方案**：在 `ChatBody` 中，当 `!selectedModel` 时，添加一个可点击的"配置模型"提示（复用 `NoModelHint` 或简化版本）。

### 改动文件
- `aiProcess.tsx:95-224` — 提前 return `NoModelHint`
- `chat.tsx:24-35` — 未配置模型时添加引导按钮

---

## 五、右键菜单 + 双击交互统一

### 5a. 统一触发机制

| 操作 | 当前行为 | 统一后 |
|------|----------|--------|
| 右键空白 | 弹 `NodeCreateMenu` | **保持：弹创建菜单** |
| 右键节点 | 弹 `NodeContextMenu`（复制/置顶/置底/删除） | **保持：弹节点操作菜单** |
| 双击空白 | 弹 `NodeCreateMenu` | **保持：弹创建菜单**（阻止 tldraw 默认行为） |
| 双击节点 | 由节点 Body 自行处理 | **保持：触发编辑**（文本节点编辑文本、代码节点编辑代码等） |

**核心改动**：当前双击空白和右键空白功能相同（都弹创建菜单），这不冲突，保持即可。双击节点和右键节点功能不同（编辑 vs 操作菜单），这也合理，保持即可。

**要做的统一**：确保右键节点菜单也包含"编辑"选项，让用户可以通过右键进入编辑，而不只是双击。

### 5b. 固定菜单高度 + 滚动

**现状**：`NodeCreateMenu` 和 `NodeContextMenu` 高度自适应内容，节点多时菜单很长。

**方案**：
- 创建菜单设固定最大高度 `max-height: 400px`，超出滚动
- 菜单列表区 `overflow-y: auto`，平滑滚动
- 菜单容器保持不变（标题 + 搜索 + 列表）

### 5c. 节点分类 + 二级筛选

**现状**：`NodeCreateMenu` 扁平列出约 20 个节点，按注册顺序排列，无分组。

**方案**：给节点添加 `category` 字段，分为 5 类：

| 分类 | 包含节点 | 图标 |
|------|----------|------|
| 内容输入 | text、image、image-gen、video、audio | 文字/图片 |
| 图像处理 | image-crop、image-split、image-edit | 裁剪 |
| 视频处理 | video-frame、video-clip、video-audio、vocal-separate | 视频 |
| 音频语音 | speech、tts、chat | 音频 |
| 逻辑流程 | json、structured、code、storyboard、ai-process、iterate、director、processor | 流程 |

**实现步骤**：
1. `registry.tsx` 的 `NodeTypeSpec` 接口添加 `category?: NodeCategory` 字段
2. `specs/index.tsx` 注册时为每个节点指定 category
3. `NodeCreateMenu.tsx` 按 category 分组渲染，顶部添加分类 Tab/筛选条
4. 默认显示全部，点击分类 Tab 筛选

### 改动文件
- `registry.tsx` — 添加 `NodeCategory` 类型 + `category` 字段
- `specs/index.tsx` — 每个节点补充 category
- `NodeCreateMenu.tsx` — 分组渲染 + 分类筛选 + 固定高度滚动
- `NodeContextMenu.tsx` — 添加"编辑"选项
- `app.css` — 菜单样式（固定高度、分类 Tab、滚动）

---

## 执行顺序

| 阶段 | 内容 | 预估 |
|------|------|------|
| **P1** | 去边框（清三处 CSS 残留）+ 左侧延伸 | 10 分钟 |
| **P2** | 按钮统一样式 + 布局重组（左下角导航、右下角工具） | 20 分钟 |
| **P3** | 节点排版修复（aiProcess 提前 return、chat 引导） | 15 分钟 |
| **P4** | 右键菜单固定高度 + 滚动 | 10 分钟 |
| **P5** | 节点分类字段 + 创建菜单二级筛选 | 30 分钟 |
| **P6** | 验证：typecheck + 手动预览 | 10 分钟 |

---

## 不做的事

- 不改鱼眼放大效果（上次已完成，保留）
- 不改节点 Body 的功能逻辑（只改排版/提示方式）
- 不改 tldraw 画布的核心交互
