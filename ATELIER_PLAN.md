# Infinite Atelier 借鉴调研与接入方案

> 制定日期：2026-08-27
> 调研对象：[GuiYi-Xi/infinite-atelier](https://github.com/GuiYi-Xi/infinite-atelier)（Vite + React 19 + antd 6 + Tailwind 4 + zustand + lucide-react 的 AI 创作画布，含独立子应用 MONOFORM 导演台）
> 本文档回答三个问题：哪些可以直接借鉴、哪些可以对接嵌入、UI 上有哪些可借鉴——并给出分阶段实施计划。
> 约束：保持本项目既有技术栈（Electron + React 19 + tldraw + 自定义 CSS，LibTV 风格深色 UI）与用户 UI 偏好（紧凑、对齐、弹窗贴近触发元素、不引入大留白与多余横线），不迁移 antd/Tailwind。

## 1. 调研结论

### 1.1 导演台（MONOFORM Studio）是什么

独立的三维白模预演工作台（React Three Fiber + Three.js），以 iframe 嵌入主应用 `/director` 路由：

| 能力域 | 内容 |
| --- | --- |
| 场景搭建 | 白模人物（5 体型）+ 基础几何体 + 场景粗模（拱门/楼梯/家具等）+ GLB 导入 |
| 镜头管理 | 最多 30 个镜头，每镜头独立保存场景/骨骼/摄像机/参考图/关键帧，支持新建/复制/重命名/缩略图 |
| 摄像机与运镜 | 编辑视角与摄像机视角分离；焦距 18-120mm；俯仰/水平/翻滚；9 种画幅预设 |
| 关键帧动画 | 摄像机/角色/物体三类关键帧，平滑/线性/保持插值，1-60s 时间轴 |
| 人物动作 | 27 个动作预设（走/跑/蹲/坐/招手/点头…）+ 手动骨骼 IK + 自定义姿势 |
| 参考图 | 上传图片叠加在 3D 视口底层，透明度/大小/位置可调，可进入导出 |
| 光照 | 环境/主光/补光三色光 + 强度/角度/曝光 |
| 导出 | PNG 截图、MP4 动画、工程 JSON |

关键架构事实：**导演台与画布数据完全隔离**（localStorage 独立存储，无 postMessage 通信，画布节点与导演台互不读写）。它是「分镜预演」工具，不是节点工作流的一部分。

### 1.2 节点第二功能（悬浮工具栏）是什么

节点卡片 hover 时顶部浮现工具条（`canvas-node-hover-toolbar.tsx`），核心设计：

- 通用工具：info / delete / retry（仅失败节点）/ saveAsset / download，按节点类型增减（文本节点有字号调节、视频节点有编辑面板入口等）
- **图片节点专属快捷工具**：复制提示词、反推提示词、替换、锁定比例、蒙版编辑、裁剪、拆分、放大、超分、角度、查看大图
- **前端处理管线**（`canvas-image-data.ts`）：裁剪/拆分/放大/角度全部用 Canvas2D 前端完成，无后端依赖（超分上限长边 4096）
- **可自定义**：localStorage 存 `{ids, showLabels}`，设置弹窗勾选工具 + 文字标签开关；delete 永远保留，其余按配置过滤
- 工具定义集中（id/label/icon/active/run），执行逻辑外置到父组件回调；工具栏 `stopPropagation` 防止事件穿透画布拖拽

### 1.3 UI 体系要点

- 暖石色编辑风（stone 色系）：浅色画布 `#f4f2ed` / 深色画布 `#181715`，节点填充/边框/文字形成完整 token 层级
- 顶栏 sticky + 半透明磨砂（`backdrop-blur-xl`）
- 音频设置气泡：`createPortal` 到 body + `getBoundingClientRect` 精确定位，宽 356px、圆角 18、大阴影
- 资产选择器：4 列网格 + 搜索 + 筛选 + hover 遮罩（「插入」提示）
- pill 胶囊控件、薄滚动条（4px、hover 显现）

## 2. 三层借鉴结论总表

| 层 | 条目 | 结论 | 去向 |
| --- | --- | --- | --- |
| A 直接借鉴 | 悬浮工具栏 + 图片快捷工具 | ✅ 高价值低成本，与 tldraw 节点完美契合 | P1（本轮实施） |
| A 直接借鉴 | 前端图片处理管线（裁剪/拆分/放大） | ✅ 纯 Canvas2D，零后端依赖 | P1 |
| A 直接借鉴 | 工具栏自定义机制（localStorage + 设置弹窗） | ✅ 结构简单可平移 | P1 |
| B 对接嵌入 | 导演台·轻量版（分镜镜头控制台） | ✅ 把「镜头列表+批量控制+状态总览」概念映射到我们的 storyboard/iterate 链路 | P2 |
| B 对接嵌入 | 导演台·完整 3D 白模预演（MONOFORM） | ⏸ 子应用级嵌入，依赖重（three/R3F），数据需桥接 | P3（评估后决策） |
| C UI 借鉴 | 悬浮工具栏视觉（半透明面板/Tooltip/active/danger 态） | ✅ 随 P1 落地，用本项目 CSS 变量实现 | P1 |
| C UI 借鉴 | 弹窗精准定位模式（portal + rect 计算） | ✅ 与用户「弹窗贴近触发元素」偏好一致 | 随 P1/P2 |
| C UI 借鉴 | 暖石色画布主题 | ⚠️ 本项目保持 LibTV 深色风格一致性，仅借鉴层级化 token 思路，不改配色 | 不单独实施 |
| C UI 借鉴 | 顶栏磨砂/pill/薄滚动条 | ⚠️ 视觉风格差异大，仅在新增组件中使用轻量对应物 | 按需 |

## 3. P1 节点悬浮工具栏 + 图片快捷工具（本轮实施）

### 3.1 产品设计

节点卡片 hover 时，卡片上方浮现工具条（半透明深色面板，本项目 CSS token）。**工具栏只收纳「作用于节点/媒体」的第二功能**，不重复画布已有能力（删除/复制/层级移动已由 tldraw 快捷键与右键菜单覆盖）。

**图片类节点（image / image-gen 且已有成图）专属工具**：

| 工具 | 图标 | 行为 | 默认显示 |
| --- | --- | --- | --- |
| 查看大图 | image | 打开全屏预览浮层（复用现有 media-preview） | ✅ |
| 复制提示词 | copy | 读取节点 prompt 配置写入剪贴板（仅 image-gen） | ✅ |
| 裁剪 | crop | 裁剪对话框（拖拽选区）→ 结果入库 → 右侧生成新图片节点 | ✅ |
| 拆分 | grid | 拆分对话框（行×列）→ N 张结果入库 → 批量生成新节点 | ✅ |
| 放大 | zoom-in | 放大对话框（2x/4x 高质量重采样）→ 入库 → 新节点 | ✅ |
| 替换图片 | upload | 文件选择 → 入库 → 更新本节点媒体引用 | ❌（可在设置中开启） |
| 在资源管理器中显示 | target | 复用现有 revealMedia IPC | ❌ |

**通用工具（所有媒体节点 image/video/audio）**：查看大图（预览浮层）。

**设计差异（相对 infinite-atelier，适配本项目）**：

1. **处理结果落地为「新节点」而非原地替换**——本项目是节点画布，裁剪/拆分/放大的产物入库后在其右侧生成新图片节点，形成可视化处理链，原图不破坏、可继续连线，也符合撤销语义。
2. **不设「保存到素材库」**——本项目所有媒体本就入库（MediaStore 资产中心），该动作无意义。
3. **不做「反推提示词」**——当前 chat 网关不支持图片输入（messages 为纯文本），待支持 vision 后再列入工具集。
4. **不做蒙版编辑/角度变换/超分**——蒙版编辑依赖专用绘制器（本项目已有独立 Mask 标注流程，入口不同）；角度/超分价值密度低，后续按需追加。
5. **工具栏不提供 delete**——tldraw 原生删除（Del 键/右键菜单）已覆盖，避免双轨。

### 3.2 技术设计

新文件（均在 `src/renderer/src/canvas/`）：

```text
node-toolbar/
  imageProcessing.ts     # 前端图片处理纯函数：loadImage/crop/split/upscale/dataUrl→bytes
  nodeToolbarTools.ts    # 工具定义（id/label/icon/run）+ 配置读写（localStorage v1）
  NodeHoverToolbar.tsx   # 工具栏组件 + 设置弹窗 + 裁剪/拆分/放大/替换对话框
```

- 挂载点：`NodeCardView.tsx`，卡片 wrap hover 时显示（CSS hover + pointer 事件 stopPropagation，防画布拖拽误触）；工具条 absolute 定位在卡片上方居中（外层 wrap 无裁切，端口圆点同款前提）。
- 处理管线：`mediaUrl(mediaPath)` → `<img>` 解码 → Canvas2D 处理 → dataUrl → `Uint8Array` → 现有 `window.api.importMediaBuffer` IPC 入库 → `editor.createShape` 在源节点右侧偏移创建 image 节点 → `markUndoPoint`。
- 放大算法：逐级 2 倍 `drawImage`（smoothing high）+ `createImageBitmap` 高质量重采样，长边上限 4096（同 infinite-atelier 约束）。
- 配置存储：`localStorage['canvas-node-toolbar-tools-v1'] = {ids: string[], showLabels: boolean}`；设置弹窗（勾选 + 标签开关）经 portal 渲染到 body。
- 弹窗视觉：沿用本项目 media-preview-mask/modal 风格（居中遮罩 + 深色面板），文字标签字号与正文一致，按钮紧凑排列，无多余横线。

### 3.3 验收

- hover image-gen 节点出现工具条；裁剪/拆分/放大产物出现在画布且资产中心可见；操作后 Del/Ctrl+Z 语义正常（新节点独立成 undo 步）。
- 设置弹窗可关掉默认工具、开启文字标签；配置持久化。
- 全部门禁绿：`pnpm typecheck && pnpm lint && pnpm test`。

## 4. P2 导演台·轻量版：分镜镜头控制台（下一轮实施）

把 MONOFORM「镜头列表 + 批量控制 + 状态总览」的产品概念映射到本项目已有的 storyboard / iterate / runNodeManually 链路，**不引入 3D 依赖**：

```text
入口：画布顶栏「导演台」按钮 → 全屏遮罩面板（或右侧大抽屉）
数据：扫描画布全部 storyboard 节点 → 汇总镜头列表（序号/画面/台词/时长/来源节点）
面板左侧：镜头卡片列表（点击定位/居中画布对应分镜板节点）
面板右侧：选中镜头详情 + 动作
  - 「为此镜头生图」：读取该分镜板下游生图链路，无则自动搭建（分镜行 → 文本模板 → image-gen）
  - 「批量执行」：循环触发现有 iterate/runNodeManually 链路，逐镜头跟踪状态（复用 R8-WP2 运行记录）
  - 镜头字段快速编辑（回写分镜板节点 shots）
价值：20 镜头批量出图的可视化指挥台，替代「全局运行」的黑盒等待
```

实施前依赖：R8 WP2（运行记录持久化）提供逐镜头耗时/成败数据。预计 2-3 人日。

## 5. P3 导演台·完整 3D 白模预演（评估后决策）

把 [monoform-previs-studio](https://github.com/GuiYi-Xi/monoform-previs-studio) 作为子项目引入（独立构建产物放 `resources/`，Electron `WebContentsView`/iframe 加载，存储走项目目录而非 localStorage），并与画布桥接：

- 画布 → 导演台：image-gen 成图作为参考图输入
- 导演台 → 画布：镜头 JSON 导出回写 storyboard 节点；MP4 导出入库作为视频节点素材

成本：引入 three/R3F 构建链 + 数据桥接协议 + 与项目存储打通，预估 5+ 人日。**建议在 P2 验证「导演台」心智被用户接受后再启动**，避免为 3D 而 3D。

## 6. 实施记录

| 阶段 | 状态 | 备注 |
| --- | --- | --- |
| 调研（导演台/节点工具栏/UI 体系） | ✅ 2026-08-27 | 三路并行调研，结论见 §1 |
| P1 悬浮工具栏 + 图片快捷工具 | ✅ 2026-08-27 | 门禁全绿（typecheck / lint / 427 tests）；详见 §6.1 |
| P2 分镜镜头控制台 | ⏳ 待启动 | 依赖 R8 WP2 |
| P3 3D 白模预演嵌入 | ⏳ 评估中 | 见 §5 决策建议 |

### 6.1 P1 交付明细

```text
src/renderer/src/canvas/node-toolbar/
  imageProcessing.ts     # 前端处理管线：loadImage / crop / split / upscale（长边≤4096）/ dataUrl→bytes
  nodeToolbarTools.ts    # 工具元数据 + localStorage 配置（canvas-node-toolbar-tools-v1：{ids, showLabels}）
  NodeHoverToolbar.tsx   # 工具栏 + 设置弹窗 + 裁剪（拖拽选区）/ 拆分（行×列网格预览）/ 放大（2x/4x）对话框
test/nodeToolbarTools.test.ts  # 配置读写与工具定义完整性（7 用例）
```

- 挂载：`NodeCardView` 卡片 wrap 内，hover 显示于卡片上方；`stopEventPropagation` 防画布误触。
- 处理产物统一走「入库（importMediaBuffer）→ 右侧生成新图片节点 → markUndoPoint」，原图不破坏。
- 替换图片走隐藏 file input → 入库 → 更新本节点媒体引用（独立 undo 步）。
- 顺带修复：R8 遗留 140 处 prettier 格式警告（eslint --fix）；NodeCardView connectable effect 缺失 `shape` 依赖。
