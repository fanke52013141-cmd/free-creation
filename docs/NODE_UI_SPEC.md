# 节点 UI 统一规范（Node UI Spec）

> 状态：v1.2（2026-09-18），用户第二轮截图反馈已落地（见 §16）。
> v1.1（2026-09-18），已拍板实施；P-1/P0/P2 已落地（见 §15 实施记录）。
> v2 增补：§11 说明文字精简、§12 引用图片缩略图形态、§13 颜色条外置、
> §14 CSS 层叠收敛（修复 v1 遗留的磨砂覆盖 bug）。
> v1.1 集成决定（用户 v1.0 规范评审拍板）：颜色条采用方案 A（文档流内顶部 4px）；
> 引用缩略图 48×36 无名称文字，hover 全貌保留；高度档位制 260/320/380/440；
> NODE_UI Token 单一真值；端口 tooltip 只留「名称 · 类型」。
> 适用范围：画布上全部 23 个活跃节点。本规范与 `NODE_CONTRACT_SPEC.md` 平行：
> 契约规范管端口与数据，本规范管视觉结构与操作布局。

## 0. 问题陈述

当前节点没有统一的布局协议：

1. **高度参差**：`fitHeight` 在内容溢出时自动向下扩展（上限 1200px），
   文本、JSON、媒体结果会把卡片撑成任意高度，画布失去网格感；
   高度不一 → `portOffsets` 按各自高度分布端口 Y → 同列节点端口永远错位，连线斜乱。
2. **按钮散布**：41 处按钮分布在 15 个 body 文件中——空态中央、结果区上下文、
   参数行内、配置面板内各有各的摆法；运行按钮又浮在 header 右上角（仅选中时可见）。
   用户无法形成"去哪里找操作"的肌肉记忆。
3. **死代码**：`.node-hover-toolbar` CSS 无任何组件引用。
4. **（v2）说明文字泛滥**：端口 tooltip 拼接 7 段信息、空态教学句、
   拖线提示、按钮括号补语——操作教学类文案占据大量 hover/常驻空间。
5. **（v2）CSS 三套打架**：app.css / ui-foundation.css / ui-surfaces.css 各有一套
   `.node-card` / `.node-header` / `.node-color-bar`，后加载覆盖前者。实际后果：
   颜色条是内侧悬浮 + padding-bottom 让位（高度计算复杂化）；
   v1 阶段 4 写在 app.css 的深色磨砂卡片被 ui-foundation.css 覆盖，未生效。

## 1. 设计原则

| # | 原则 | 含义 |
|---|------|------|
| P1 | **显示区恒定** | 正文显示区高度只由档位决定，与内容多少、有无按钮无关。内容超出 → 显示区内部滚动，卡片高度不变 |
| P2 | **按钮归底** | 作用于整个节点的动作全部收进底部按钮区（footer），布局恒为「左次要 · 右主操作」 |
| P3 | **高度完全统一** | 同档位节点总高度一致 → 端口 Y 对齐 → 横向连线。有无按钮不改变高度：无动作时 footer 显示状态行 |
| P4 | **微按钮例外** | 作用于内容中单个对象的动作（删除一条历史、复制一个字段）保留行内，统一为 22px 图标微按钮，不占视觉重量 |
| P5 | **档位而非常量** | 保留两档标准尺寸 + 用户手动 resize 自由度；废除的是"内容驱动高度"，不是用户的选择权 |

## 2. 节点解剖：三层恒定结构

```
┌──────────────────────────────────────┐
│ header  28px   序号·图标·标题·info·状态灯 │  ← 不变（移除浮动运行按钮）
├──────────────────────────────────────┤
│                                      │
│ display  档位值   固定高度显示区          │  ← 内容超长在此内部滚动
│  · ConnectedInputPreview（已连输入）    │
│  · spec.Body 正文                     │
│                                      │
├──────────────────────────────────────┤
│ footer  44px   [次要…]      [主操作]    │  ← 新增常驻结构
├──────────────────────────────────────┤
│ color-bar 4px   类型色条                │  ← 不变
└──────────────────────────────────────┘
```

CSS 骨架（flex column，footer/header `flex-shrink: 0`，display `flex: 1; min-height: 0;
overflow-y: auto`）。用户 resize 改变的只是 display 高度，三层结构永不重组。

## 3. 高度体系（回答 Q1：高度怎么决定）

### 3.1 两档标准尺寸

| 档位 | 尺寸 (w×h) | 分解 | 适用 |
|------|-----------|------|------|
| **标准档** | **340 × 260** | 28 header + 184 display + 44 footer + 4 bar | 逻辑/文本类：text、json、structured、code、script、processor、iterate、ai-process、chat、tts |
| **媒体档** | **340 × 420** | 28 + 344 + 44 + 4 | 预览类：image、image-gen、image-edit、image-crop、image-split、video、video-frame、video-clip、video-audio、video-transforms、audio、vocal-separate、storyboard、director、speech |

标准档 260 与现行 `STANDARD_NODE_SIZE` 完全一致——**不迁移任何已存节点尺寸**，
只是内部空间重新分配（display 从 ~228px 让出 44px 给 footer）。
媒体档 344px display 可完整容纳 16:9 视频预览 + 一行参数摘要。

### 3.2 有按钮和没按钮的节点，高度一样吗？

**一样。** 这是本规范最重要的决定：

- footer 是常驻结构，不是按需插入的补丁；
- 无节点级动作的节点，footer 显示**状态行**（就绪/缺输入/上次运行时间），空间永不浪费；
- 由此同档位节点总高度恒等 → 端口完全对齐（P3）。

（若未来需要"紧凑模式"，可整体砍 display 高度，但仍以档位为单位切换，绝不按按钮有无逐节点变化。）

### 3.3 高度规则

1. **废除 `fitHeight` 自动扩展**：NodeCardView 中 fitHeight / ResizeObserver /
   MutationObserver 整段删除；内容超出显示区即内部滚动。
2. **保留手动 resize**：tldraw resize_bounds 不受限；`needsNodeSizeMigration`
   阈值改为仅拦异常值（w > 900 或 h > 1600）。
3. **已存项目兼容**：被 fitHeight 撑高的旧节点**保持原尺寸不动**（用户视角无感知），
   新布局自动适配——display 吃掉全部可用高度，footer 恒 44px。
4. **媒体加载后不自动改高度**：16:9 预览在 display 内 `object-fit: contain`，
   网格结果（拆分 9/16 宫格）在 display 内部滚动。

## 4. 显示区（display）规范

| 场景 | 规则 |
|------|------|
| 空态 | 图标 + 名称 + ≤24 字提示（沿用既有空态文案规范）；**引导按钮移入 footer 主操作位**，不再放在空态中央 |
| 已连输入 | ConnectedInputPreview 顶部条不变，超出 3 条折叠为"还有 N 个输入" |
| 文本/代码 | textarea / 代码块自身滚动 |
| 媒体结果 | 网格 + 内部滚动（现状已支持），行高按档位预览质量为准 |
| 运行中 | 现有 execution-overlay 遮罩不变（覆盖 display，不遮 footer，运行按钮变为 spinner） |
| 滚动条 | 6px 细滚动条，hover 显现，与画布滚动条同材质 |

## 5. 按钮区（footer）规范（回答 Q2：按钮放哪里）

### 5.1 布局：左次右主

```
┌──────────────────────────────────────┐
│ [打开工作台] [清空]     [▶ 生成图片]     │
│  ← ghost，最多 2 个      ← primary，≤1 │
└──────────────────────────────────────┘
```

- **右侧主操作**（primary，最多 1 个）：该节点的"完成"动作——运行、生成、应用裁剪、
  发布。与对话框「确定在右」惯例一致。
- **左侧次要操作**（ghost，最多 2 个）：打开工作台/设置/面板、编辑配置、清空重来。
- **上限 3 个**。第 4 个动作的去处：右侧面板（CanvasSidePanel 已有完整承载）或行内微按钮（P4）。
- 按钮尺寸统一 `small`（28px 高，图标 14px），未选中时 primary 视觉降为强调 ghost，
  选中/hover 恢复 primary——画布整体不吵，单节点操作时明确。

### 5.2 无动作节点：状态行

```
┌──────────────────────────────────────┐
│ ● 就绪 · 等待上游          12:30 运行过 │
└──────────────────────────────────────┘
```

数据源为现成的 `deriveNodeReadiness`（idle/ready/blocked + label）与 `meta.nodeRun`。
运行中状态行替换为进度文案（"正在生成 · 3/8"），失败显示红色摘要。
状态行让 footer 永远"有话说"，这是高度恒定的心理支撑。

### 5.3 行内微按钮（P4 例外清单）

仅限**作用于单个内容对象**的动作，统一 22px 图标微按钮：

| 位置 | 动作 |
|------|------|
| JSON 字段卡片 | 复制该字段 |
| 历史/结果条目 | 删除该条、清空历史 |
| tts 参考语音行 | 替换 / 移除参考语音 |

判断口诀：**"这个按钮删掉的话，影响的是整个节点还是其中一个东西？"**
前者 → footer；后者 → 行内微按钮。

### 5.4 header 的变化

- 移除 `node-action-float` 浮动运行按钮（与 footer 主操作重复）；
- 序号、图标、标题、info 按钮、字数徽标、状态灯全部保留不动。

## 6. 动作声明架构（符合节点强制协议）

按钮不写在 Body JSX 里，而是**由 spec 声明**，NodeCardView 统一渲染：

```ts
// registry.tsx NodeTypeSpec 新增（可选字段，向后兼容）：
footerActions?: (ctx: {
  shape: NodeCardShape
  readiness: NodeReadiness
  running: boolean
  onRun: () => void
  openPanel: (tab?: 'settings' | 'result') => void
}) => NodeFooterAction[]

type NodeFooterAction =
  | { kind: 'primary'; icon?: IconName; label: string; onPointerUp(): void; disabled?: boolean }
  | { kind: 'ghost'; icon?: IconName; label: string; onPointerUp(): void; disabled?: boolean }
```

理由（对照 AGENTS.md 节点协议精神）：

1. **契约可测试**：`node-compliance` 校验 footerActions 返回 ≤3 项、primary ≤1
   ——数量上限从"约定"升为"门禁"；
2. **渲染归一**：footer DOM/CSS 只有一份实现，禁绝各 body 自造按钮容器；
3. **Body 回归纯展示**：Body 不再持有"节点级"操作语义，上下文微按钮除外；
4. **迁移可分批**：footerActions 是可选字段，未声明的节点先落状态行，逐节点迁移。

## 7. 按钮迁移清单（41 处 → 归宿）

### 7.1 进 footer 主操作位（primary）

| 节点 | 现位置 | 动作 |
|------|--------|------|
| image-gen | body 内 gen-go | 生成图片 |
| image-edit | body 内 gen-go | 生成修改图 |
| video | body 内 gen-go | 生成视频 |
| image-crop | body 内 btn-primary | 应用裁剪 |
| image / audio 空态 | 空态中央 | 导入图片 / 导入音频 |
| chat | （新增） | 打开对话面板 |
| director | （新增） | 打开预演台 |

### 7.2 进 footer 次要位（ghost）

| 节点 | 动作 |
|------|------|
| image-edit | 打开标注工作台 |
| image-crop | 打开精细框选 |
| vocal-separate | 打开设置 |
| video | 编辑配置 / 重新生成（二选一入 footer，另一个进右面板） |
| video-transforms | 打开设置（现 6 个 ghost 收敛为 1 个；模式切换本就是 config 的事） |
| script / code / storyboard / structured / shared | 打开参数面板（现散落的设置类按钮归并） |

### 7.3 保留行内微按钮（P4）

| 节点 | 动作 |
|------|------|
| json | 复制 JSON（节点级 → 可进 footer ghost；**复制单个字段**留行内） |
| audio | 清空历史（footer ghost） / 删除单条资产（行内） |
| tts | 替换 / 移除参考语音（行内，参数上下文） |
| video:402 工作流模板按钮 | 移入右面板"推荐工作流"区（不属于单节点动作） |

### 7.4 删除

- header 浮动运行按钮（被 footer 主操作替代）；
- `.node-hover-toolbar` 死 CSS。

## 8. 端口对齐红利（本规范的隐藏收益）

`portOffsets(n, h)` 按节点高度分布端口。当前高度参差 → 同列节点端口 Y 错位。
统一档位后：

- **同类型节点**（端口数相同）在任何画布位置端口 Y 完全一致 → 横向连线成为水平线；
- **跨类型节点**若恰在档位内取同一档，同样对齐；
- 视觉验证成本骤降：连线斜率异常 = 端口数不同或用户手动改高，一眼可辨。

## 9. 实施计划

| 阶段 | 内容 | 风险 |
|------|------|------|
| **P-1 CSS 收敛** | §14：app.css 删除 node 结构类、磨砂迁移 ui-foundation、修复覆盖 bug | 中：纯视觉回归，逐条核对层叠结果 |
| **P0 结构层** | node-footer DOM/CSS + display 固定高度与滚动 + 移除 fitHeight 与浮动运行按钮 + 状态行渲染 + §13 色条外置 + §11 文案精简 + 死 CSS 清理 | 中：触摸所有节点的视觉；无 API 变化 |
| **P1 动作层** | registry 增加 footerActions 协议 + node-compliance 门禁（≤3/≤1）+ 按第 7 节清单迁移全部节点 + Body 删除对应按钮 | 低：分节点小步提交 |
| **P2 引用图片** | §12：缩略图卡片 + hover 全貌；@ 引用（text 节点）作为独立功能项 | 中：@ 是新交互，需独立测试 |
| **P3 打磨** | primary 未选中降级、媒体档 defaultSize 校验放宽（允许 340×420 集合）、CSS 源码断言门禁（test/ui-foundation.test.ts）| 低 |

每阶段独立 commit + 全量 verify；P-1 完成即修复磨砂 bug（可独立验收），
P0 完成即可感知（高度统一、状态行上线），P1 完成规范闭环，P2 交付引用新体验。

## 10. 验收标准

1. `node-compliance`：footerActions ≤3、primary ≤1、所有声明动作可点击不抛错；
2. 同档位节点在画布上高度逐像素相等（快照测试断言 defaultSize 集合）；
3. `ui-foundation.test.ts` 源码断言：存在 `.node-footer`、display `overflow-y: auto`、
   fitHeight 已删除、`.node-hover-toolbar` 已删除；
4. 全量 verify 通过；
5. 手工验收：新建 text + image-gen + video 同列摆放，端口水平对齐；
   image-gen 未选中时 footer 只见低调按钮，选中后 primary 强调。

---

## 11. 说明文字精简（v2）

### 11.1 原则：身份信息留，操作教学删

| 类别 | 定义 | 处置 | 例 |
|------|------|------|-----|
| **身份信息** | 描述数据本身的事实：是什么、来自哪、什么状态 | 留（可精简） | 图片来源名、就绪/缺输入、错误摘要 |
| **操作教学** | 教用户怎么操作：怎么拖、怎么点、会发生什么 | 删 | "按住圆点可反向拖线"、"将在此处创建节点" |

用户已会用软件；教学文案只在「首次发现性」场景保留（如空态主引导按钮本身）。

### 11.2 逐项精简清单

| 位置 | 现状 | 改为 |
|------|------|------|
| 输入端口 tooltip | `名称（类型）输入 · 必填 · 多值 · schema@v · 端口描述 · 未连接 · 按住圆点可反向拖线寻找上游`（7 段拼接） | `名称 · 类型`；必填性由缺口语义（虚线）与右侧契约面板承载 |
| 输出端口 tooltip | 同上 + `按住圆点拖出连线；多选同类节点时会批量连接` | `名称 · 类型` |
| 空态 <small> 教学句 | 12 处，如"连接图片后选择比例裁剪" | 全部删除；空态只留图标 + 名称 + （需要时）footer 主引导按钮 |
| 已连接输入标题行 | `已连接输入`（图标 + 文字） | 删除整行标题；缩略图卡片自解释（§12） |
| 已连接输入来源尾注 | `来源节点 · 端口名`（每条尾部） | 删；名称归入缩略图卡片标签（§12），hover 全貌时显示完整来源 |
| 拖入文件 drop-hint | `松开以添加资产 / 将在此处创建节点`（两行） | 只留 `松开以添加` |
| 运行按钮 tooltip | `运行此节点（使用已连接的上游结果）` | `运行` |
| slash 提示 | `（请输入主题）` | 保留（这是输入校验，不是教学） |

### 11.3 禁回潮门禁

`ui-foundation.test.ts` 源码断言：NodeCardView 中不再出现「按住圆点」「拖出连线」
「批量连接」等教学字符串。

## 12. 引用图片：缩略图卡片 + hover 全貌 + @ 引用（v2）

### 12.1 缩略图卡片（替代现行 30×28 内联小图）

ConnectedInputPreview 中 kind=image 的输入渲染为独立卡片：

- 尺寸 64×48（图片 64×30 + 标签 18px），`object-fit: cover`，圆角 6px；
- 多值输入横向排列自动换行；
- 名称 = 来源节点标题（用户命名的语义），不再是 `节点 · 端口` 双段拼接；
- 视频/音频/文件仍用图标 chip（现行样式），只有图片升级为缩略图卡片。

### 12.2 hover 全貌

鼠标悬浮缩略图卡片 ≥300ms → fixed 定位全貌浮层：

- 大图 `object-fit: contain`，最长边 ≤ min(40vw, 420px)，带轻微投影与 150ms 淡入；
- 浮层底部一行：完整来源（节点 · 端口）；
- 离开即消失；点击缩略图仍走现有 `openMediaPreview` 全屏预览
  （两个层次：hover 看一眼，点击细看）。

### 12.3 @ 引用图片（新功能，范围先定 text 节点）

在 text 节点正文输入 `@` → 弹出项目图片选择浮层（复用 slash 命令的解析模式）：

- 候选 = 当前画布所有图片输出（媒体节点、image-gen 结果）；
- 选中后正文插入 `@节点名` 标记，渲染时替换为小 chip 样式；
- **语义边界（节点协议红线）**：`@标记` 只是正文的可见标记，
  **不隐式产生业务输出、不改变端口数据流**——图片要成为节点输入仍必须走端口连线。
  @ 的价值是提示词写作时快速指代画布上的素材（人和模型都能看懂）。
- 后续若要「@ 即连线」，必须作为独立节点能力提案（显式端口 + 契约测试），不在本期。

## 13. 颜色条外置（v2）

### 13.1 现状与问题

最终层叠结果：颜色条是 absolute 悬浮在卡片**内侧**底部（8px，opacity 0.7），
卡片为它让位 `padding-bottom: 8px`。加上 header 又是 `top: -29px` 浮在卡片外——
卡片内部结构成了「上无 header、下有悬浮条 + padding 补偿」的混合体，
fitHeight 的溢出计算需要理解这些非文档流元素，极易出错。

### 13.2 新设计：对称外浮

- 色条移到 `.node-card-wrap` 上 absolute `bottom: -6px`，居中 60% 宽、4px 高、
  全圆角胶囊、opacity 0.55（更低调）；
- 卡片删除 `padding-bottom: 8px`——footer 直接贴到卡片底缘，文档流完整；
- 高度计算从此只看 header(-29px 已知) + 卡片体（display + footer），无补偿值；
- 类型色信息保留（胶囊条 + header 图标色 + 选中光晕），无信息损失。

## 14. CSS 层叠收敛（v2，先于一切实施）

**现状**：`.node-card` / `.node-header` / `.node-color-bar` / `.node-body` 在
app.css 与 ui-foundation.css 双重定义，后者覆盖前者；v1 阶段 4 写在 app.css 的
深色磨砂卡片（半透明底 + 内高光）被 ui-foundation.css 覆盖**实际未生效**（bug）。

**收敛规则**：

1. `.node-*` 结构类（card/header/body/footer/color-bar/port）的**唯一权威定义在
   ui-foundation.css**（最后加载的结构层文件）；浅色主题变体仍在 ui-surfaces.css；
2. app.css 删除全部 `.node-card` / `.node-header` / `.node-color-bar` / `.node-body`
   结构定义（保留 :root 变量与其它非 node 结构类）；
3. 阶段 4 磨砂定义迁移到 ui-foundation.css 并与 §13.2 外置色条合并；
4. `ui-foundation.test.ts` 增加门禁：app.css 不得再包含 `.node-card {`、
   `.node-color-bar` 定义（防止层叠债务回潮）；
5. 本节作为 P0 实施的第一步（后续所有视觉改动都建立在单一权威层上）。

## 15. 实施记录（v1.1，2026-09-18）

用户对 v2 规范评审后拍板的关键决定（覆盖/细化上文相应章节）：

| 决定 | 采纳内容 |
|------|----------|
| 颜色条（§8/§13） | **方案 A**：文档流内、卡片顶部 4px；删除 absolute 悬浮与 `padding-bottom: 8px` 让位补偿 |
| 引用缩略图（§12） | **48×36 无名称文字**；hover 全貌浮层保留（300ms 延时、portal 到 body、不拦截指针）；点击进入媒体预览 |
| 高度体系（§3） | 档位制 260/320/380/440；超 440 由 node-body 内部滚动承载；1200 仅作旧项目迁移保护值 |
| 尺寸真值（§24A） | 新增 `canvas/node-ui-tokens.ts`（NODE_UI + resolveNodeHeight），NodeCardShape 与 Registry 同源 |
| 文案（§11） | 端口 tooltip 只留「名称 · 类型」；运行 tooltip→「运行节点」；教学句（按住圆点/批量连接/双击预览）删除 |
| 折叠（§17） | 引用超过约两行（12 项）折叠为 +N，展开后由 body 滚动承载 |

三个已落地提交：

1. **P-1 `1c7e7b6` CSS 层叠收敛**：ui-foundation.css 成为 `.node-*` 外壳唯一
   权威层；修复阶段 4 磨砂被不透明背景覆盖、从未生效的 bug；色条改文档流顶部；
   `.node-hover-toolbar` 死代码三处全删；NodeCardView DOM 调整（标题移到
   .node-card-wrap、色条为卡片首子元素）；门禁防回潮。
2. **P0 `894b63c` 高度档位制 + 单一真值**：NODE_UI Token 与 resolveNodeHeight
   档位函数；NodeCardShape 默认 340×200 → 260（消除与 Registry 双真值）；
   fitHeight 改为只升不降的档位跳档；node-body overflow-y:auto；
   教学文案删除；`MAX_AUTO_NODE_HEIGHT` 降级为 legacyGuard 派生。
3. **P2 `0c4086d` 图片引用缩略图**：ConnectedInputPreview 重写——图片引用
   48×36 缩略图卡（无名称、序号角标、tooltip 含来源）、hover 全貌浮层、
   点击预览、+N 折叠；删「已连接输入」标题行；非图片引用保持单行 chip。

后续（未实施，另立阶段）：

- **P1 footerActions 协议**：spec 声明 `(ctx) => NodeFooterAction[]`，
  41 处按钮迁移与 More Menu（§5–§7）；
- **@ 引用**（§12.3）：正文中 `@` 弹出候选、引用仅作可见标记，
  不隐式产生端口数据流；
- **P3**：Result Collection 统一（§19）、媒体行为对齐（§18）、manual max 720 评估。

---

## 16. v1.2 决定（2026-09-18 用户第二轮截图反馈）

用户逐张截图评审后拍板，**覆盖**前文与之冲突的条款。本节优先于 §11/§13/§15。

| # | 决定 | 落地位置 | 覆盖了 |
|---|------|----------|--------|
| 1 | **端口圆点必须是实色**：类型色就是类型色，不做渐变、不做磨砂、不带内阴影；未连接只降不透明度（0.45，hover 0.8） | `ui-foundation.css` `.port-dot::after`（唯一权威层）；`.port-dot-inner` 与 `.conn-cursor-glass` 已整体删除 | §15「10px 磨砂玻璃珠」、原 `ui-foundation.test.ts` 的玻璃材质断言 |
| 2 | **媒体预览一律白底 + 可见边框**：非图片区域与图片区域必须一眼可分；覆盖节点内预览、结果网格、拆图预览、引用缩略图、hover 全貌、全屏预览 | `ui-foundation.css` `.node-media`（材质唯一权威）、`ui-surfaces.css` `.media-result-tile` / `.media-preview-image .media-preview-stage` | 原深色 `#15191f` / `#11161d` / `#090d12` |
| 3 | **运行按钮常驻**：不再 `selected &&` 才渲染；不可用时置灰并给出原因 tooltip（项目未就绪 / 正在运行 / 缺少输入），绝不消失 | `NodeCardView.tsx` `runBlockedReason` + `.node-run-btn:disabled` | §5.4「移除浮动运行按钮」只废除了位置，不废除常驻 |
| 4 | **无必要提示语一律删除**：已连线但无值的输入不再显示「等待上游输出」（整条不渲染）；音频资产节点的说明段、视频节点的「AI 生成」小字删除 | `ConnectedInputPreview.tsx`（`input.value !== null` 过滤）、`audio.tsx`、`video.tsx` | §11.2 只删了教学句，未删状态占位 |
| 5 | **媒体后续动作按钮只放文字**：图标会挤掉文字居中，`.node-media-next-actions button` 去图标、`gap: 0`、强制居中 | `shared.tsx` / `video.tsx` / `video-transforms.tsx` / `app.css` | — |
| 6 | **悬浮全貌统一显示在上方**：下方会遮挡节点内容；仅上方空间不足时翻下。来源名称文字与原生 tooltip 一并删除 | `ConnectedInputPreview.tsx` `ReferenceThumb` | §12.2「浮层底部一行：完整来源」 |
| 7 | **命名统一**：`修改` → `P图`（调色板、图片节点按钮、派生标题）；`图片生成视频` → `生视频`；`取帧/截取/提音` → `抽帧/截视频/截音频`（spec label、调色板、空态文案、底部按钮同步） | `CanvasEditor.tsx` `paletteLabels`、`specs/index.tsx` label、各 body | — |
| 8 | **拆图节点**：行/列/面积收成一行；序号圆点 `line-height: 1` 修复不居中；追溯连线颜色跟随**被产出资产类型**（图片→绿），不再用集合端口的紫色 | `image-split.tsx`、`app.css`、`DataEdgeLayer.tsx` | — |
| 9 | **图片资产节点不显示格式徽标** | `image.tsx` | — |

### 16.1 门禁更新

`ui-foundation.test.ts` 的端口材质断言按 #1 改写（实色 + 无 `backdrop-filter` + `box-shadow: none`）。
新增 `test/node-ui-decisions.test.ts`（16 项）把本节决定固化为源码断言，防止"删掉某个覆盖"类
改动被悄悄改回去。另有两支临时真实渲染验收脚本（不入库）覆盖 #2–#9 与全部新节点，均通过。

### 16.1.1 名字只有一个来源（v1.2 追加）

`CanvasEditor.tsx` 里的 `paletteLabels` 覆盖表**已删除**。它曾让同一个节点出现两个名字：

| 节点 | 左侧面板 | 卡片默认标题 |
|------|----------|--------------|
| tts | 克隆 | 语音克隆 |
| json | 数据 | JSON |
| storyboard | 分镜 | 分镜板 |
| director | 预演 | 3D 预演台 |

现在面板可见文字、tooltip、`aria-label` 与新建卡片的默认标题**全部取 `spec.label`**，
分叉在结构上不再可能发生。`image-split` 的 label 也由「拆图」统一为「拆分」（与图片节点
按钮、用户用语一致），契约版本随之升到 3。

### 16.2 待办（用户已确认方向，尚未实施）

- **标注文字承载**：目前只有「文字」工具能带文字，箭头 / 矩形 / 涂画还不行。
  提示词侧的编号清单（`annotationInstructionLines`）已就绪，缺的是「画完顺手写一句」的行内输入。
- **豆包参考素材通道**：`references[]` 条目的字段结构官方文档未给出，`audio_data` /
  `audio_url` / 参考图片亦未实现。豆包模式下若检测到上游 `in-audio` 有连线会明确失败并
  提示"该通道尚未接入"，不会静默丢弃输入后假装成功。
- **tldraw CDN 噪声**：tldraw 会去 `cdn.tldraw.com` 拉图标雪碧图与 `translations/en.json`，
  被应用自己的 CSP 拦下，在浏览器验收里产生 300+ 条控制台错误与 2 次未处理 `Failed to fetch`。
  不影响功能（自绘 UI 不用它的工具栏图标），但会淹没真实错误，值得单独评估。
