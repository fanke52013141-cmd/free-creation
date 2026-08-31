# 交接单：UI 整体优化与节点分类（2026-08-31）

> 本轮基于 `fc78c97`，包含 macOS Dock 鱼眼放大、UI_PLAN 六阶段优化、节点分类二级筛选。代码已于 `f519ac3`（`UI 整体优化：Dock 鱼眼放大、边框清除、按钮统一、节点分类二级筛选`）提交并推送至 `origin/main`；自动测试通过，桌面端手工验收仍待执行。

## 一、本轮交付清单

### 1. Dock 鱼眼放大效果

| 文件                                        | 类型 | 说明                                                          |
| ------------------------------------------- | ---- | ------------------------------------------------------------- |
| `src/renderer/src/canvas/useDockMagnify.ts` | 新增 | 余弦曲线鱼眼放大 hook，`requestAnimationFrame` 批处理，零依赖 |
| `src/renderer/src/canvas/CanvasEditor.tsx`  | 修改 | 底部工具栏接入 `useDockMagnify`                               |
| CSS 三件套                                  | 修改 | `.palette-item` 过渡动画配合放大                              |

**算法**：鼠标到元素中心的距离映射为缩放系数，余弦曲线保证边缘衰减平滑。最大放大 1.4×，作用半径 80px。

### 2. UI_PLAN 六阶段优化（全部完成）

| 阶段 | 内容                                 | 改动                                                                                                                                             |
| ---- | ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| P1   | 清除三处 CSS 残留边框 + 左侧面板延伸 | `ui-foundation.css`、`ui-surfaces.css`、`app.css` 删除 `.palette-item` 的 background/border/shadow；`.palette-node-scroll` 改为 `flex: 1 1 auto` |
| P2   | 统一按钮样式 + 布局重组              | `.dock-btn` 与 `.palette-item` 统一为透明背景；导航簇移至左下角、工具栏移至右下角                                                                |
| P3   | 节点排版修复                         | `aiProcess.tsx` 无模型时提前 return `NoModelHint`；`chat.tsx` 补模型配置引导                                                                     |
| P4   | 右键菜单固定高度 + 滚动              | `.node-menu` 改为 flex 列布局 + `max-height: 400px`；`NodeContextMenu` 新增"编辑"选项                                                            |
| P5   | 节点分类字段 + 创建菜单二级筛选      | `registry.tsx` 新增 `NODE_CATEGORIES`、`NodeCategoryId`、`category` 必填字段；24 个节点全部指定分类；`NodeCreateMenu.tsx` 新增分类 Tab 筛选      |
| P6   | typecheck 验证 + 预览                | `pnpm typecheck` 零错误；dev server 正常运行                                                                                                     |

### 3. 节点分类体系

`NodeTypeSpec.category` 现为**必填字段**，注册时校验。5 个分类：

| 分类 ID | 标签     | 节点                                                                         |
| ------- | -------- | ---------------------------------------------------------------------------- |
| `input` | 素材输入 | text、image、image-gen、video、audio                                         |
| `image` | 图像处理 | image-crop、image-split、image-edit                                          |
| `video` | 视频处理 | video-frame、video-clip、video-audio、vocal-separate                         |
| `audio` | 音频语音 | speech、tts、chat                                                            |
| `logic` | 逻辑流程 | json、structured、code、storyboard、ai-process、iterate、director、processor |

### 4. 创建菜单交互升级

- 顶部分类 Tab 筛选条：全部 / 素材输入 / 图像处理 / 视频处理 / 音频语音 / 逻辑流程
- 列表区独立滚动（`overflow-y: auto`），容器固定 `max-height: 400px`
- 分类数量不足 2 个时自动隐藏 Tab 条（兼容连线场景）
- 空结果提示："没有与当前筛选匹配的节点"

## 二、提交归属（已完成）

```text
 M src/renderer/src/assets/app.css
 M src/renderer/src/assets/ui-foundation.css
 M src/renderer/src/assets/ui-surfaces.css
 M src/renderer/src/canvas/CanvasEditor.tsx
 M src/renderer/src/canvas/NodeContextMenu.tsx
 M src/renderer/src/canvas/NodeCreateMenu.tsx
 M src/renderer/src/nodes/registry.tsx
 M src/renderer/src/nodes/specs/bodies/aiProcess.tsx
 M src/renderer/src/nodes/specs/bodies/chat.tsx
 M src/renderer/src/nodes/specs/index.tsx
 M test/contracts.test.ts
 M test/registry.test.ts
?? UI_PLAN.md
?? src/renderer/src/canvas/useDockMagnify.ts
?? docs/HANDOFF_2026_08_31_UI_OVERHAUL.md
```

以上为提交前工作区清单，现已由 `f519ac3` 纳入版本控制，仅用于追溯，不代表当前工作区状态。

## 三、验证基线

- `pnpm typecheck`：✅ 零错误
- `npx vitest run`：✅ **52 个测试文件、606 项用例全部通过**（较上轮 45 文件 576 项增长：新增分类相关测试）
- 桌面端手工冒烟：**尚未执行**

## 四、人工验收路径

1. 启动应用（`pnpm dev` 或桌面快捷方式）
2. **边框验证**：左侧节点面板所有图标无背景框、无边框线、无阴影
3. **Dock 放大验证**：鼠标悬停左侧/底部图标，观察鱼眼放大效果
4. **布局验证**：左下角为导航簇（小地图开关、缩放、适配、重置），右下角为工具栏（上传、资产、流程、历史、运行、主题）
5. **节点分类验证**：右键画布空白 → 创建菜单顶部出现分类 Tab → 点击各分类筛选
6. **aiProcess 排版验证**：创建 AI 处理节点但未配置模型 → 应显示全屏 `NoModelHint` 引导
7. **chat 引导验证**：创建对话节点但未配置模型 → 应显示配置引导按钮
8. **右键节点菜单验证**：右键已有节点 → 菜单包含"编辑"选项

9. **可定制分类 Dock**：左侧只显示 6 个一级分类；点击后应只显示对应的二级节点。拖动一级分类调整顺序、重启应用后仍应保持；右键一级分类可改显示名或恢复默认。上述操作不得改变节点端口、创建结果、连线或项目导出内容。

## 五、注意事项

- `category` 字段现为**必填**，未来新增节点必须在注册时指定分类，否则注册校验失败
- 一级分类 Dock 的 `PaletteCategoryId` 是稳定 UI 键；用户只可改本机顺序和显示名。它独立保存在主进程 SQLite `settings`，不等同于、也绝不能覆盖 `NodeTypeSpec.category`。
- 测试文件 `registry.test.ts` 和 `contracts.test.ts` 已同步添加 `category: 'input'` 到测试 fixture
- `UI_PLAN.md` 保留在根目录作为本次改动的方案文档参考
