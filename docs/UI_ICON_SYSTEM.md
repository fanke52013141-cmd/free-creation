# 无限画布 UI 图标系统规范（v2）

> 状态：已定稿的设计与接入规范。新节点、新工具和重做既有图标时必须遵循本文件。
>
> 视觉母版：[ui-icon-master-v1.png](assets/ui-icon-master-v1.png)。母版由生图生成，用于确定轮廓、留白和色彩节奏；**不得直接切图或作为 UI 图标发布**。
>
> v2（2026-11-02）：节点身份图标按 Stitch 方案重绘并落地——声音创作 6 个、AI 与自动化 5 个、循环 1 个，见 §4 语义字典与 §7 I4。图标设计源：`design/2026-11-node-identity/icons/icon-drafts.tsx`。

## 1. 目标与边界

图标的职责是让用户一眼分辨“对象类别”和“可执行动作”，而不是承担装饰。它必须在 16px 仍可识别，在深色、浅色与禁用状态下都保持清楚。

- 产品图标统一由 `src/renderer/src/components/Icon.tsx` 输出 SVG；不使用 Emoji、PNG 或字体图标。
- 生图只产出视觉方向稿与特殊插画，不能替代可缩放、可继承颜色、可访问的 SVG 源文件。
- 节点类型色属于“类别提示”，不能与运行成功、失败、警告等状态色混用。
- 同一概念在节点标题、左侧节点栏、右键菜单和右侧面板必须复用同一个 `IconName`。

## 2. 几何规范

| 项目 | 规范 |
| --- | --- |
| 画板 | `viewBox="0 0 24 24"` |
| 默认描边 | `strokeWidth="1.8"`；复杂图标可降至 `1.65`，不能低于 `1.5` |
| 端点/转角 | `strokeLinecap="round"`、`strokeLinejoin="round"` |
| 安全区 | 主轮廓位于 `3–21`，不得贴边；光标、箭头等可延展至 `2–22` |
| 最小负空间 | 相邻路径至少保留 `1.5` 单位；小圆点最小半径为 `1.25` |
| 填充 | 默认 `fill="none"`。只有播放三角、状态点等“实心语义”可填充 |
| 阴影/渐变 | SVG 内禁止 filter、阴影、渐变和发光；这些只由 CSS 容器状态提供 |
| 变换 | 不在 path 内做模糊缩放；几何需在 24px 网格内可直接审阅 |

尺寸槽位：左侧栏 `20px`，节点标题 `15px`，节点操作/菜单 `16px`，顶部操作 `16px`，主要空状态 `24px`，媒体占位 `32–36px`。传入 `Icon` 的 `size` 是唯一缩放入口。

## 3. 色彩与状态

图标默认使用 `currentColor`，由父级决定颜色；`PATHS` 内不写固定的产品色。

| 状态 | 色彩策略 | 使用条件 |
| --- | --- | --- |
| 静止 | `--muted` | 次要工具、未选中菜单 |
| 可操作/悬浮 | `--txt` | 鼠标悬浮或键盘焦点 |
| 已选中 | 当前节点类别色或 `--brand` | 左栏激活、选中节点、当前工具 |
| 禁用 | 静止色 + 35% opacity | 不可执行的操作 |
| 成功/失败/运行 | 仅状态灯或状态标签使用 | 绝不改变类别图标的含义 |

节点类别色沿用 `nodes/specs/index.tsx` 中的 `color`：文本蓝、图片绿、视频粉、音频琥珀、对话/结构数据紫、处理青、代码灰、导演台金。颜色最多作为图标的“父级色”或 1 个小强调点；不能把一个图标拆成多种无语义的彩色路径。

## 4. 语义字典

### 节点类别（核心 17 个）

| IconName | 含义 | 轮廓约束 | 不得混淆 |
| --- | --- | --- | --- |
| `text` | 普通文本 | 三条不等长横线 | `script` |
| `image` | 图片资产 | 相框、山形、一个太阳点 | `image-gen` |
| `image-gen` | 生成图片 | 横向图片框 + 右上四角星 | `image`、`edit` |
| `crop` | 图片裁剪 | 两条裁切角线 | `frame` |
| `image-split` | 图片拆分 | 四块小图，其中一块错位分离 + 切分虚线 | `grid`、`crop` |
| `image-edit` | P图 | 相框 + 斜向画笔（节点身份） | `image-gen`、`edit` |
| `edit` | 通用编辑动作 | 铅笔/单笔触（只作动作） | `image-edit` |
| `website` | 网址节点 | 浏览器窗 + 地址栏 + 地球 | `external`（动作）、`link` |
| `video` | 视频生成 | 视频框 + 播放 + 横向箭头 | `director`、`video-asset` |
| `video-asset` | 视频素材 | 胶片条 + 齿孔 + 播放三角 | `video`、`frame` |
| `frame` | 视频取帧 | 加高胶片条 + 一条竖线 | `crop`、`clip` |
| `clip` | 视频截取 | 加高胶片条 + 两条竖线（入点/出点） | `frame`、`split` |
| `depth` | 深度视频 | 高重叠前后两框 + 斜向 Z 轴箭头 | `director`、`layers` |
| `clay` | 白模视频 | 立体方块 + 右面播放三角 | `assets`、`depth` |
| `audio` | 音频 | 五根节奏不同的声波线 | `video` |
| `video-audio` | 截音频 | 完整音频波形被竖线切成两段 | `audio`、`speech` |
| `sound-adjust` | 声音调整 | 三根竖向推子 + 三个错高旋钮 | `audio`、`voice-clone` |
| `speech` | 语音合成 | 音频波形 + AI 四角星 | `mic`、`voice-clone` |
| `voice-clone` | 语音克隆 | 两个并排人形轮廓（双胞胎）+ 右侧三条声波柱 | `audio`、`sound-adjust` |
| `voice-design` | 音色设计 | 音频波形 + 画笔 | `image-edit`、`audio` |
| `vocal-separate` | 人声分离（退役） | 单条波形中间切开 + 右侧独立声柱 | `sound-adjust`、`audio` |
| `mic` | 录音/麦克风控件 | 胶囊麦克风 + U 支架 + 底座 | `speech`（节点身份） |
| `chat` | 对话 | 单气泡 + 两条内容线 | `script` |
| `agent` | Agent | 机器人头 + 天线 + 两个实心眼点 | `spark`、`ai-process` |
| `ai-process` | AI 处理 | 斜向魔杖 + 大小两颗四角星 | `agent`、`spark` |
| `ai-review` | AI 审核 | 盾牌 + 内部对勾 | `check`（动作） |
| `state-machine` | 状态机 | 镜像待办：左侧勾选、右侧待办文字 | `workflow`（流程图）、`reset` |
| `iterate` | 循环 | 三个完整箭头组成圆形循环 | `grid`、`text` |
| `script` | 脚本 | 文档 + 内容线 | `text`、`code` |
| `processor` | 处理 | 二进制数字 01 | `code`、`data` |
| `structured` | 结构数据 | 文件目录树：文件夹 + 两条缩进文件 | `json`、`workflow` |
| `json` | 结构化数据 | 花括号 + 三条平铺字段线 | `code`、`structured` |
| `code` | 代码 | 尖括号 + 斜杠 | `json` |
| `storyboard` | 分镜 | 胶片分格 | `video` |
| `director` | 3D 预演台 | 单个摄影机（无地面底座） | `video`、`depth` |
| `grid` | 布局/表格动作 | 四个独立方块 | `storyboard`、`image-split` |

**节点图标与工具/动作图标互斥**：`mic` 只用于录音控件，`speech` 独占“文本行 + 喇叭 + 声波”作为语音合成节点身份；`check` 只表示“通过”动作，`ai-review` 用盾牌对勾表示审核节点；`workflow` 只表示流程入口，`state-machine` 用“三个状态圆 + 闭环迁移箭头”；`website` 用浏览器窗 + 地球，不再复用 `external` 动作箭头；`image-edit` 用相框 + 画笔，铅笔 `edit` 只作动作；`spark` 是品牌/AI 装饰点，`agent`、`ai-process` 各有独立轮廓。节点标题图标只描述“对象”，不得借用动作或状态语义。

### 工具与导航（核心 13 个）

`upload`（向上箭头落入托盘）、`assets`（立方体/资产盒）、`workflow`（一进二出的关系图）、`history`（时钟回箭头）、`search`（放大镜）、`settings`（齿轮）、`home`（房屋）、`minimap`（小画布）、`fit`（四角收束）、`zoom-in` / `zoom-out`、`undo` / `redo`、`play` / `pause` / `send` / `close` 等应优先使用国际通用形状。

操作图标永远描述动作，节点图标永远描述对象。例如“打开右侧输入输出说明”使用 `info`，不复用 `processor`；“运行”使用 `play`，不使用 `video`。

## 5. 接入与命名规则

1. 先判断是“对象图标”还是“动作图标”，再从语义字典选择；没有合适名称时才新增 `IconName`。
2. 新增项使用全小写 kebab-case，例如 `video-reference`；禁止 `VideoReference`、`referenceVideo` 或中文 key。
3. 在 `IconName` 联合类型和 `PATHS` 中同时增加条目；两者必须一一对应。
4. 新节点规格只写 `icon: '...'`，不内联 `<svg>`。`CanvasPage`、菜单、面板也同样复用 `Icon`。
5. 有悬浮提示的纯图标按钮必须提供 `title` 与 `aria-label`；只读图标不应获得 tab 焦点。
6. 图标不会单独表达关键状态。必须同时给出文字、状态灯、标签或 tooltip。

## 6. 视觉验收清单

- 以 `16px`、`20px`、`24px` 三档检查：轮廓不粘连、无多余细节、视觉重心居中。
- 深色和浅色主题下检查对比度；禁用图标仍可辨认但不抢视觉焦点。
- 将同类图标并排检查：`image/image-gen/edit`、`video/frame/clip`、`text/script/json/code` 必须一眼区分。
- 同一图标出现在左栏、节点标题、右键菜单、右侧面板时，其形状与方向完全一致。
- 新 icon 需补一个渲染测试或更新现有图标快照，确保 `IconName` 与 `PATHS` 不脱节。

## 7. 分阶段改造计划

### I0 — 审计与冻结（本次完成）

- 输出视觉母版与本规范。
- 保持现有 `Icon.tsx` 的 public API，不改节点契约、不改任何布局和执行逻辑。
- 识别需要优先重绘的高频图标：`image-gen`、`edit`、`frame`、`clip`、`processor`、`json`、`storyboard`、`director`、`assets`、`workflow`。

### I1 — 基础图标重绘

- 用本规范重绘上列 10 个高频图标，控制到 2–4 条主路径；`image`、`video`、`text` 作为锚点保留可识别性。
- 将 `CanvasPage.tsx` 中内联的设置、主页 SVG 迁入 `Icon`，避免同义图标出现两套风格。
- 对每一个 `IconName` 做 16/20/24px 截图对比，修正基线和视觉重量。

### I2 — 组件状态落地

- 完成左栏、顶部、节点头部、右键菜单、底部工具栏的统一状态色，图标本身只继承 `currentColor`。
- 为主操作保持一个蓝色焦点；其他工具默认中性，避免“每个按钮都在发光”。
- 为禁用、运行、报错状态补文字和 tooltip，不用颜色猜测状态。

### I3 — 回归与治理

- 加入图标渲染覆盖测试：`IconName`、`PATHS` 和各节点规格引用三者一致。
- 在新节点检查项中加入本规范链接；节点契约审查和 UI 审查必须同时通过。
- 后续图标变更以视觉母版为方向、以 SVG 源码为唯一交付物；位图母版仅作为审阅参考。

### I4 — 节点身份图标落地（2026-11-02）

- 新增/重绘 11 个 `IconName`：`sound-adjust`、`speech`、`voice-clone`、`voice-design`、`vocal-separate`、`agent`、`ai-process`、`ai-review`、`state-machine`、`iterate`、`audio`（族锚点保留）。
- 节点映射：声音调整/语音合成/语音克隆/音色设计/人声分离不再共用 `audio`；Agent、AI 处理不再共用 `spark`；AI 审核不再用裸 `check`；状态机不再用 `workflow`；循环不再用 `grid`。
- 状态机在 16px 下放弃“初始点”语义（r1.25 内点会糊），改为大/小两个状态圆 + 带箭头迁移曲线；这是 2026-11-02 用户验收后的裁决。
- `voice-design` 在 I4 时曾单独按 1.65 描边；I6 重绘后结构已简化，恢复统一 1.8。
- 设计源、预览与 16px 实测见 `design/2026-11-node-identity/icons/`；新增图标契约测试 `test/icon-contract.test.ts`。

## 8. 本次生成素材

- 工具：内置 Image Generation。
- 路径：`docs/assets/ui-icon-master-v1.png`。
- 用途：深色画布 UI 的轮廓、留白、类型色参考。
- 生成约束：5×4 图标方向稿、无文字/Logo/水印、单线条、圆端角、可简化为 24×24 SVG。

### I5 — 语音克隆图标重绘（2026-11-03）

- 用户裁决：`voice-clone` 用「双胞胎 + 音频」表达，不再用两条错位声波——后者与 `audio`、`sound-adjust` 的声波语言过于接近。
- 轮廓：两个相同的人形（头 + 肩）并排，右侧三条声波柱表示复刻后的声音；保持 1.8 描边、24×24 网格、圆角端点。
- 同步更新桌面图标导出（`Canvas Studio 节点图标`）与 `Icon.tsx` 语义注释。

### I6 — 节点图标按点名重绘（2026-11-03）

- 用户裁决：按每个节点“一句话功能”直接指定轮廓；生图、Agent 最后按点名修正。
- 当前几何：
  - image-gen：横向图片框（16×13）+ 山形/太阳 + 右上四角星。
  - video：视频框 + 播放三角 + 横向箭头。
  - frame：加高胶片条（18×11）+ 一条贯穿竖线。
  - clip：加高胶片条（18×11）+ 两条竖线。
  - depth：高重叠前后两框 + 斜向 Z 轴箭头。
  - video-audio：完整音频波形被竖线切成两段。
  - speech：音频波形 + 右上 AI 四角星。
  - voice-design：音频波形 + 画笔。
  - processor：二进制数字 01。
  - structured：文件目录树（文件夹 + 两条缩进文件 + 目录线），无外框。
  - iterate：三个完整箭头组成圆环。
  - director：只保留摄影机，去掉地面底座。
  - state-machine：待办镜像版——勾选在左，待办文字在右，前两条勾选。
- 规范：24×24、1.8 描边、圆端角、无渐变/外框。
- 设计源：用户逐条文字裁决；本仓库以 `Icon.tsx` 的 SVG 为唯一交付物。
