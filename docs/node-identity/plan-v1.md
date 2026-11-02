# 节点身份色 × 图标 重设计方案 v1

- 日期：2026-11-02
- 范围：`source` 画布节点的身份色（`NODE_ACCENTS`）、节点图标（`Icon.tsx` → `IconName`/`PATHS`）、以及两者在 Stitch 中的设计看板
- 状态：**已落地**（2026-11-02）。色板、图标、规格文档、测试与浏览器双主题验收均已完成；未执行的只剩完整 `npm run verify`（工作区有并行会话改动）。
- 关联文件：`source/docs/NODE_COLOR_SPEC.md`、`source/docs/UI_ICON_SYSTEM.md`、`source/src/renderer/src/nodes/registry.tsx`、`source/src/renderer/src/components/Icon.tsx`

---

## 0. 结论摘要

**颜色**：现行 37 个身份色的问题不是"少了几种颜色"，而是三个结构缺陷叠加——同族只在浅色明度带里做 ±5% 的微调、AI 族成员仍借用 input 的粉与 data 的橙、视频族里还混着两个橙色节点。实测最差跨族 ΔE00 只有 **2.1**（状态机 `#D99647` vs 数据处理 `#D99048`），肉眼几乎同色。新方案按"**六族色相带 × 明度/色度阶梯**"重排：

| 指标（越大约好） | 旧色板 | 新色板 |
| --- | --- | --- |
| 同族最小 ΔE00 | 3.3（视频截取 vs 深度视频） | **7.8**（视频素材 vs 抽帧） |
| 菜单相邻最小 ΔE00 | 3.8（音频 vs 音色设计） | **10.4** |
| 跨族最小 ΔE00 | 2.1（状态机 vs 数据处理） | **7.8**（分镜板 vs 声音调整） |
| 身份色对卡片 `#20242A` 的最低对比度 | 3.13:1（视频截取） | **3.87:1**（组容器）/ 可创建节点 3.9:1（3D 预演台） |

**图标**：34 个节点 ID 只用了 28 个图标，其中 9 个节点在共用图标——`audio` 一个图标被音频、声音调整、人声分离、语音克隆、音色设计 **5 个节点共用**；Agent 与 AI 处理共用 `spark`；拆分与循环共用 `grid`；状态机用的是一张通用流程图 `workflow`；AI 审核用的是动作语义的裸对勾 `check`。新方案给 11 个节点各配一张**轮廓完全不同**的图标：语音族 6 张并排时 16px 仍能区分，状态机改为"两个状态圆 + 带箭头的迁移曲线"。

**Stitch**：已新建项目 `画布节点身份系统 · 颜色与图标重设计 2026-11`，产出 4 张可审阅看板（声音图标族 / AI 图标族 / 六族色板 / 卡片落地对照）。

---

## 1. 问题诊断

### 1.1 主题事实（决定了评估口径）

- `CanvasPage` / `CanvasEditor` 硬编码 `canvas-theme-dark`，当前**只有暗色主题**：画布 `#111419`、卡片 `#20242A`、面板 `#1B2027`（`.stitch/DESIGN.md` 与 `ui-surfaces.css`）。
- 节点身份色在暗色下**不做混色**（`--node-identity-strength` 默认 100%），直接用于 4px accent 条、17px 卡头图标（`NodeCardView.tsx:1159`，规范槽位名义是 15px，实现为 17px）、空态大图标、菜单/搜索/详情面板图标。因此必须按 raw hex 评估，不能用"浅色纸底上看起来还行"来验收。
- CSS 里仍有 `.canvas-theme-light` 的 55% + `#17232d` sRGB 混色规则，但组件不加这个 class，属历史残留。这条公式会把饱和度压掉约 40%，如果将来恢复浅色主题而不改公式，颜色会比现在**更趋同**（见 3.5）。

### 1.2 颜色：实测撞色清单（旧色板，CIEDE2000）

| 关系 | 节点 A | 节点 B | 旧 ΔE00 | 观感 |
| --- | --- | --- | --- | --- |
| 跨族 | 状态机 `#D99647` | 数据处理 `#D99048` | **2.1** | 几乎同色 |
| 跨族 | AI 审核 `#E6B26A` | 结构数据 `#FDBA74` | 4.4 | 同族级别 |
| 同族 | 音频 `#D8B4FE` | 音色设计 `#C4A7E7` | 4.5 | 几乎同色 |
| 同族 | 声音调整 `#B18AE8` | 语音合成 `#C084FC` | 4.2 | 几乎同色 |
| 跨族 | 分镜板 `#FB923C` | 数据处理 `#D99048` | 5.2 | 同色系 |
| 跨族 | 3D 预演台 `#E8AD85` | Agent `#F7A35C` | 6.3 | 同色系 |
| 同族 | 视频截取 `#3364F0` | 深度视频 `#4F6BE0` | 3.3 | 几乎同色 |
| 跨族 | 文件 `#E284B4` | AI 对话 `#F472B6` | 4.3 | 几乎同色 |
| 同族 | 视频素材 `#9EC5FE` | 白模视频 `#A9B6E6` | 7.9 | 勉强可辨 |
| 跨族 | Agent `#F7A35C` | 状态机 `#D99647` | 7.0 | 勉强可辨 |

（完整排序见 `palette/palette-report.md` 与 `analyze.py` 输出。）

### 1.3 三个结构性缺陷

1. **AI 族没有自己的色带**：入口色早就是品牌蓝 `#42B9F5`，但成员一直停在"玫红系/橙色系"（`NODE_COLOR_SPEC` 里写明"迁移中"）。于是 AI 对话撞 input 的粉、Agent/状态机/AI 审核撞 data 的橙。
2. **视频族里混着橙色节点**：分镜板 `#FB923C`、3D 预演台 `#E8AD85` 在"视频创作"分类里，但颜色是橙系，同时和 data、AI 的橙撞成一片。
3. **同族只调明度、不调色相**：同一族 5–8 个节点挤在 5–10° 色相、0.05–0.1 明度的范围里，ΔE00 自然只有 3–7。而且色板整体偏浅（L 0.70–0.85），在深色卡片上所有颜色都"发亮"，进一步降低区分。

### 1.4 图标重合清单（旧）

| 图标 | 被哪些节点使用 | 问题 |
| --- | --- | --- |
| `audio` | 音频、声音调整、人声分离、语音克隆、音色设计（5 个） | 语音创作者全一个样 |
| `spark` | Agent、AI 处理（2 个） | 智能体与模型处理不分 |
| `grid` | 拆分、循环（2 个） | 循环节点长得像"四宫格" |
| `workflow` | 状态机（1 个，但语义是通用流程图） | 流程图图标 ≠ 状态机 |
| `check` | AI 审核（1 个，但语义是动作/成功） | 审核节点和"打勾成功"混在一起 |

33 个节点 ID → 27 个图标，9 个节点在共用；`vocal-separate` 退役后仍是 `audio`。

### 1.5 为什么用户会觉得"颜色都很像"

三个机制叠加，缺一不可：

1. **明度带太窄**：所有色都在 L 0.70–0.85，人眼对"同明度、同饱和度、色相差 5°"几乎无感，ΔE00 5 以下基本要靠并排细看。
2. **同图标放大了同色感**：颜色接近 + 形状一样 = 同一个东西。语音 5 个节点既同色又同图标，是最糟的组合。
3. **跨族色相借用**：AI 用粉、橙，分镜/预演台用橙，等于在 6 个族里塞了 4 个"暖色族"，而暖色带（35–15° 之间）根本放不下 4 组可区分的色。

---

## 2. 设计原则（可验收）

1. **双轴身份**
   - 族 = 色相带（H）：一眼判断"这是声音还是视频"。
   - 层级 = 明度（L）+ 色度（C）阶梯：同族内拉开深浅与饱和，解决"功能相近也要有辨识度"。
   - 功能 = 图标轮廓：颜色不再承担"区分具体功能"的唯一职责，图标必须做到轮廓级差异。
2. **ΔE 预算（CIEDE2000，暗色 raw 色）**
   - 同族任意两节点 ≥ **7.5**（本次实际 7.8）；同一菜单里相邻两项 ≥ **9**（实际 10.4）。
   - 跨族任意两节点 ≥ **7.5**（实际 7.8）。原定 12 在 36 个节点、6 个色带内无法同时满足，已用"族内拉开 + 图标轮廓"补足；跌破 8 的对全部登记在报告里。
   - 身份色对卡片 `#20242A` 对比度 ≥ **3.3:1**（实际最低 3.87:1），对画布 `#141414` 同样达标。
3. **不做的事**
   - 不用透明度/降低饱和来"区分"同族节点（那是把颜色变灰，不是区分）。
   - 不把运行状态色（红/黄/绿）借给身份色。
   - 不改节点 ID、不改端口、不改执行逻辑；颜色只换值，旧项目按 ID 自动继承。
4. **图标语言**（沿用 `UI_ICON_SYSTEM.md`）：24×24、1.8 描边、圆端圆角、单色 `currentColor`、无渐变/阴影/发光、主轮廓 3–21、元素 ≤7、16px 必须可辨。

---

## 3. 新色板

### 3.1 六族色相带与入口色

| 族 | 入口色（不变） | 新色相带（OKLCH H） | 成员 | 设计意图 |
| --- | --- | --- | --- | --- |
| 输入与素材 | `#F472B6` | 335–15° 玫红 | 3 | 素材仍是最暖的粉，与声音的紫拉开 |
| 图片创作 | `#4ADE80` | 128–185° 绿→青绿 | 5 | 用黄绿/翠绿/蓝绿/薄荷拉出四档 |
| 视频创作 | `#60A5FA` | 236–286° 蓝→蓝紫 | 9 | 分镜板、3D 预演台迁入本族蓝带 |
| 声音创作 | `#C084FC` | 288–332° 紫罗兰→藕紫 | 5 | 淡紫/紫罗兰/深紫/藕紫/兰紫五档 |
| AI 与自动化 | `#42B9F5` | 182–214° 青→青蓝 | 5 | **整体迁入青蓝带**，不再借粉/橙 |
| 数据与代码 | `#FB923C` | 35–90° 琥珀→橙 | 5 | **橙色只属于 data** |

### 3.2 完整颜色分配（可直接替换 `NODE_ACCENTS`）

> 列说明：新 HEX / OKLCH L·C·H / 旧 HEX。对比度见 `palette-final.json`。

**输入与素材（玫红带）**

| 节点 ID | 名称 | 新 HEX | OKLCH | 旧 HEX |
| --- | --- | --- | --- | --- |
| text | 文本 | `#F9A8D4` | 0.82 / 0.110 / 346 | `#F9A8D4` |
| file | 文件 | `#EA7AAE` | 0.72 / 0.150 / 352 | `#E284B4` |
| website | 网址节点 | `#FB637E` | 0.70 / 0.186 / 13 | `#FB637E` |

**图片创作（绿→青绿带）**

| 节点 ID | 名称 | 新 HEX | OKLCH | 旧 HEX |
| --- | --- | --- | --- | --- |
| image-gen | 生图 | `#2FAE46` | 0.66 / 0.180 / 146 | `#22C55E` |
| image | 图片 | `#4ADE80` | 0.80 / 0.182 / 152 | `#4ADE80` |
| image-edit | P图 | `#1DBFA1` | 0.72 / 0.130 / 176 | `#2DBD9A` |
| image-crop | 裁剪 | `#ABE9CC` | 0.90 / 0.075 / 164 | `#6EE7B7` |
| image-split | 拆分 | `#9EEB50` | 0.86 / 0.200 / 132 | `#A3E635` |

**视频创作（蓝→蓝紫带，9 节点）**

| 节点 ID | 名称 | 新 HEX | OKLCH | 旧 HEX |
| --- | --- | --- | --- | --- |
| video | 视频生成 | `#60A5FA` | 0.71 / 0.143 / 255 | `#60A5FA` |
| video-asset | 视频素材 | `#A8D6FF` | 0.86 / 0.080 / 248 | `#9EC5FE` |
| video-clip | 视频截取 | `#5583FE` | 0.64 / 0.190 / 266 | `#3364F0` |
| video-frame | 抽帧 | `#6CC9FF` | 0.80 / 0.120 / 238 | `#29C8EF` |
| video-depth | 深度视频 | `#8491E2` | 0.68 / 0.120 / 276 | `#4F6BE0` |
| video-clay | 白模视频 | `#D1DAF6` | 0.89 / 0.040 / 272 | `#A9B6E6` |
| timeline | 时间线 | `#239AD3` | 0.65 / 0.130 / 236 | （2026-11-02 新增节点） |
| storyboard | 分镜板 | `#A4B2E2` | 0.77 / 0.070 / 272 | `#FB923C` |
| director | 3D 预演台 | `#1A83DB` | 0.60 / 0.160 / 250 | `#E8AD85` |

**声音创作（紫罗兰带，5 节点）**

| 节点 ID | 名称 | 新 HEX | OKLCH | 旧 HEX |
| --- | --- | --- | --- | --- |
| speech | 语音合成 | `#C084FC` | 0.72 / 0.177 / 306 | `#C084FC` |
| audio | 音频 | `#E7CBFA` | 0.88 / 0.070 / 312 | `#D8B4FE` |
| tts | 语音克隆 | `#9269E4` | 0.62 / 0.180 / 296 | `#A366E0` |
| voice-design | 音色设计 | `#DDA7EA` | 0.80 / 0.110 / 320 | `#C4A7E7` |
| sound-adjust | 声音调整 | `#AEA0F4` | 0.75 / 0.120 / 291 | `#B18AE8` |

**AI 与自动化（青蓝带，5 节点）**

| 节点 ID | 名称 | 新 HEX | OKLCH | 旧 HEX |
| --- | --- | --- | --- | --- |
| agent | Agent | `#59D4CD` | 0.80 / 0.110 / 190 | `#F7A35C` |
| ai-process | AI 处理 | `#009D8E` | 0.62 / 0.120 / 184 | `#DB5B99` |
| chat | AI 对话 | `#A9E4E6` | 0.88 / 0.060 / 198 | `#F472B6` |
| ai-review | AI 审核 | `#00AEBD` | 0.68 / 0.130 / 204 | `#E6B26A` |
| state-machine | 状态机 | `#49D2EA` | 0.80 / 0.120 / 212 | `#D99647` |

**数据与代码（橙带，5 节点）**

| 节点 ID | 名称 | 新 HEX | OKLCH | 旧 HEX |
| --- | --- | --- | --- | --- |
| processor | 数据处理 | `#C97152` | 0.64 / 0.120 / 40 | `#D99048` |
| json | JSON | `#FF9C58` | 0.79 / 0.150 / 52 | `#F6B44C` |
| structured | 结构数据 | `#FACF9E` | 0.88 / 0.080 / 70 | `#FDBA74` |
| iterate | 循环 | `#D99C00` | 0.73 / 0.170 / 84 | `#E87932` |
| code | 代码 | `#C26E12` | 0.62 / 0.140 / 60 | `#F78C62` |

**退役 / 历史 ID（只影响旧项目展示）**

| ID | 名称 | 新 HEX | 归属族 |
| --- | --- | --- | --- |
| video-audio | 截音频 | `#7788C9` | video |
| vocal-separate | 人声分离 | `#B17DB5` | audio |
| script | 脚本 | `#CC6526` | data |
| group | 组容器 | `#9E765F` | data（保持低对比） |
| compose | 合成 | `#CD8E5E` | data |

### 3.3 结构性迁移（本次重点）

1. **AI 族整体迁入青蓝带**：Agent/AI 处理/AI 对话/AI 审核/状态机从"粉 + 橙"改为 182–214° 的青蓝阶梯。由此清掉 6 组跨族撞色（AI 对话 vs 文件/网址、Agent/状态机/AI 审核 vs data 的橙）；状态机 vs 数据处理从 ΔE 2.1 变为 **48.6**，AI 审核 vs 结构数据从 4.4 变为 **40.0**。
2. **分镜板 / 3D 预演台迁入视频蓝带**：完成 `NODE_COLOR_SPEC` 里"迁移中"的承诺。分镜板 vs 数据处理从 5.2 变为 **37.3**。
3. **橙色专属 data**：橙带里不再混入 AI 与视频节点，"暖色族"由 4 个减为 2 个（input 玫红 + data 橙），色相预算重新够用。

### 3.4 验收数字

- 同族最小 ΔE00 **7.8**（视频素材 `#A8D6FF` vs 抽帧 `#6CC9FF`）；菜单相邻最小 **10.4**。
- 跨族最小 ΔE00 **7.8**（分镜板 `#A4B2E2` vs 声音调整 `#AEA0F4`）。8 以下的跨族对已登记（见 `palette-report.md` §3），靠图标轮廓与分类菜单位置兜底。
- 身份色对比度：对卡片 `#20242A` 最低 **3.87:1**（退役 `group`），可创建节点最低 **3.94:1**（3D 预演台）；对画布 `#141414` 全部 ≥ **4.57:1**。
- 浅色历史主题兜底：按 `.canvas-theme-light` 的 55% 混色复算，图标前景对纸底与 12% 底板均 ≥3:1（最低 3.13:1 / 3.38:1），`scripts/test-browser-node-colors.cjs` 双主题门禁通过。
- 复算命令：`cd design/2026-11-node-identity/palette && python design.py`（输出"问题数: 0"）。

### 3.5 主题规则

- 暗色是唯一现行主题，身份色 100% 使用，**不要再引入混色系数**。
- 浅色主题若恢复：不要复用 `.canvas-theme-light` 的"55% 混色"，应为每个节点显式提供浅色 token（或改为 `color-mix(in oklch, …)` 保饱和的深色化），并重跑对比度与并排验收。4px accent 条在浅纸底上需要加深 15–20% 才看得见（当前浅色 class 未启用，本轮不处理）。
- 图标底板 12%、悬停 18% 透明度规则不变；身份色不进入状态语义。

### 3.6 迁移影响面

- 代码层只需要改 `NODE_ACCENTS` 的 36 个值 + `PALETTE_CATEGORY_META` 入口色（不变）。`spec.color`、卡头图标、菜单、搜索、详情面板、端口继承全部走同一真值，不需要逐个组件改。
- `test/node-color-spec.test.ts` 会逐行核对 `NODE_COLOR_SPEC.md` 的登记表，**文档必须与新值同包更新**。
- 旧项目按节点 ID 取色，重开后自动呈现新色，无需迁移数据。
- 浏览器颜色验收脚本会重新生成 `qa/node-colors-*` 截图证据。

---

## 4. 新图标方案

### 4.1 设计语言（沿用并收紧）

`viewBox 0 0 24 24`、`stroke 1.8`（密集图标可 1.65）、圆端圆角、`fill=none`（仅 Agent 眼点、状态语义点可实心）、无渐变/阴影/发光、主轮廓 3–21、相邻路径净空 ≥1.5、每个图标 2–4 条主路径、元素 ≤7、单色 `currentColor`。16px 为验收尺寸，72px 只用于空态放大展示。

### 4.2 11 个图标（新 / 重绘）

| IconName | 节点 | 隐喻与轮廓 | 与最近邻的差异 | 16px 判断 |
| --- | --- | --- | --- | --- |
| `sound-adjust` | 声音调整 | 三根竖向推子 + 三个不同高度的横向旋钮 | 与 `audio`（纯竖柱）差在"旋钮横杠" | 成立 |
| `speech` | 语音合成 | 麦克风（胶囊 + U 支架 + 底座）+ 右上两条发射弧 | 与旧 `mic` 差在发射弧，与 `audio` 差在整机轮廓 | 成立（弧略细） |
| `voice-clone` | 语音克隆 | 上下两条错位声波曲线（原声 + 回声） | 与 `audio` 的竖柱、`speech` 的整机完全不同 | 成立 |
| `voice-design` | 音色设计 | 左下三弧声纹扇形 + 右上四角星 | 与 `image-gen` 共用"星"语言，但底座是声纹不是相框 | 勉强（16px 扇形会并成块） |
| `vocal-separate` | 人声分离（退役） | 左侧三根短柱 → 右侧分叉两支箭头 | 与 `sound-adjust` 差在分叉 | 弱（仅历史展示，接受） |
| `audio` | 音频 | 五根节奏不同的声波柱（族锚点，零改动） | — | 成立 |
| `agent` | Agent | 圆角方头 + 天线 + 两个实心眼点 | 与 `spark`（只有星芒）、`chat`（气泡）完全不同 | 成立 |
| `ai-process` | AI 处理 | 斜向魔杖 + 杖尖大四角星 + 小星点 | 与 `agent` 差在"无人形"，与 `spark` 差在魔杖 | 成立 |
| `ai-review` | AI 审核 | 盾牌轮廓 + 内部对勾 | 与 `check`（裸勾）差在盾牌 | 成立（最稳） |
| `state-machine` | 状态机 | 两个状态圆（大/小）+ 带箭头的迁移曲线 | 与 `workflow`（两矩形 + 折线）轮廓级不同；与 `link` 类图标差在箭头 | 成立（去掉初始点后显著变清晰） |
| `iterate` | 循环 | 三条递减横线 + 右侧回绕 U 箭头 | 与 `grid`（四宫格）、`text`（三条等宽）不同 | 成立 |

预览：`icons/icons-review-final.png`（新色板 + 新图标整页）、`icons/icons-review-voice-final.png`、`icons/icons-review-ai-final.png`、`icons/icons-review-nodecard-final.png`。可交互版：`icons/icons-preview-final.html`。

### 4.3 节点 → 图标替换映射

| 节点 | 旧 icon | 新 icon |
| --- | --- | --- |
| audio | `audio` | `audio`（不变） |
| sound-adjust | `audio` | `sound-adjust` |
| vocal-separate | `audio` | `vocal-separate` |
| speech | `mic` | `speech` |
| tts | `audio` | `voice-clone` |
| voice-design | `audio` | `voice-design` |
| agent | `spark` | `agent` |
| ai-process | `spark` | `ai-process` |
| ai-review | `check` | `ai-review` |
| state-machine | `workflow` | `state-machine` |
| iterate | `grid` | `iterate` |

`mic`、`spark`、`check`、`workflow`、`grid` 保留在 `IconName` 中继续服务工具/动作语义（录音、品牌星、通过、流程入口、网格），但不再被节点标题引用。

### 4.4 已裁决事项

- **speech vs mic**：`mic` 归录音控件与工具动作，`speech` 独占"麦克风 + 发射弧"作为节点身份；语义字典里明确写开。
- **state-machine 初始点**：原设计在 r3.6 环内放 r1.25 实心点，16px 净空只有 1.45 会糊；已改为去掉内点、状态圆放大到 r3.9，箭头末端留 1.6 净空（`icon-drafts.tsx` 与 `build-icons.cjs` 已同步）。
- **vocal-separate**：退役节点，16px 偏弱，接受；不复用为可创建节点。
- **voice-design**：唯一使用 1.65 描边的图标（三弧密集），符合规范下限。

### 4.5 未改动图标

`chat`、`spark`、`check`、`image-gen`、`video`、`frame`、`clip`、`depth`、`clay`、`crop`、`edit`、`json`、`structured`、`code`、`processor`、`storyboard`、`director`、`text`、`image`、`file` 等保持现状；视频系 6 张图标已在 2026-11-02 的上一轮 Stitch 方案中区分完毕。

---

## 5. Stitch 落地

- 项目：`画布节点身份系统 · 颜色与图标重设计 2026-11`
- 项目 ID：`projects/2626451197125481241`
- 链接：https://stitch.withgoogle.com/projects/2626451197125481241

| # | 看板 | Screen ID | 内容 |
| --- | --- | --- | --- |
| 1 | 声音创作 · 图标语言规范表 | `4fe3a3b1ff6044d4a52d6a10cf78e307` | 6 枚语音图标 72px 大图 + 16/20/24/48 尺寸梯 + 340px 卡头 |
| 2 | AI 与自动化 · 图标语言规范表 | `5a33d1ecf5f845d1bfb9976f3db8009a` | Agent / AI 处理 / AI 审核 / 状态机 / 对话 五枚图标与卡头 |
| 3 | 节点身份色板 v2 · 六族色带 | `553e34db1a9048f59018af3627816526` | 六族 30 个可创建节点完整色表 + 结构修正 + Before/After 审计 |
| 4 | 节点身份系统 · 卡片落地对照表 | `f12f454955834c99b82a039da88a0098` | 声音 5 卡、AI 5 卡、跨族 4 卡并排验证 |

说明：Stitch 用于**方向审阅与看板交付**；可发布资产以本地 SVG（`icons/icon-drafts.tsx`）为准，符合 `UI_ICON_SYSTEM.md` "生图只产出方向稿，不得直接切图"的约束。

---

## 6. 实施清单（2026-11-02 已执行）

1. [x] **图标**：11 个条目已并入 `source/src/renderer/src/components/Icon.tsx` 的 `IconName` 与 `PATHS`（新增 `sound-adjust`、`speech`、`voice-clone`、`voice-design`、`vocal-separate`、`agent`、`ai-process`、`ai-review`、`state-machine`、`iterate`；`audio` 保留为族锚点）。`Icon` 组件对 `voice-design` 默认降描边到 1.65。
2. [x] **颜色**：`source/src/renderer/src/nodes/registry.tsx` 的 `NODE_ACCENTS` 已替换为第 3.2 节 37 个值（含新增 `timeline`）；入口色 `PALETTE_CATEGORY_META` 未动。
3. [x] **图标映射**：`specs/index.tsx` 与 `specs/agentFlow.tsx` 已按 4.3 修改（vocal-separate / sound-adjust / speech / voice-clone / voice-design / agent / ai-process / ai-review / state-machine / iterate）。
4. [x] **文档**：`NODE_COLOR_SPEC.md` 升 v1.4（六族色相带、37 节点分配表、ΔE/对比度验收、浅色 55% 混色标为历史残留）；`UI_ICON_SYSTEM.md` 升 v2（语义字典补 10 个新图标，写清 `speech` vs `mic`、`state-machine` vs `workflow`、`ai-review` vs `check`）。
5. [x] **测试**：`test/node-color-spec.test.ts` 已随文档通过；`test/icon-system.test.ts` 新增图标契约检查（11 个映射、声音 6 个 / AI 5 个图标互不重复、所有可创建节点图标都在 `ICON_NAMES` 中）。
6. [x] **验收**：
   - `npx tsc --noEmit`（node + web）通过；
   - `npx vitest run` 颜色/图标/注册表/契约快照 239 项通过；
   - `node scripts/test-browser-node-colors.cjs`（独立 dev server `:5197`）通过：32 个可创建节点 × 暗/浅两主题 + 6 组菜单 + 搜索 + 详情 + 项目弹窗 + 创建菜单，**最低对比度 3.16:1**；截图在 `source/qa/node-colors-<时间戳>/`。
7. **日志影响**：不涉及（纯视觉常量与 SVG，不触达执行/网络/文件/保存恢复路径）。
8. **风险与遗留**：37 处颜色与 11 个图标全入口生效（菜单、搜索、详情、卡头、空态、端口继承），已由浏览器脚本整体截图复核；浏览器脚本原先对“无底板身份图标”按透明背景算成黑色导致误报，已同步修正为按卡片底色测量。完整 `npm run verify` 未在本轮执行（工作区同时有另一会话在改时间线节点，lint 被其未跟踪的 `scripts/_debug-*.cjs` 阻塞），建议合并窗口重跑。

### 6.1 验证证据

- 浏览器截图：`source/qa/node-colors-1793625843412/`（`all-nodes-dark.png`、`all-nodes-light.png`、`menu-1..6.png`、`search`/`panel` 等）。
- 色板复算：`python design/2026-11-node-identity/palette/design.py` → `问题数: 0`；同族最小 ΔE 7.8、相邻 10.4、跨族 7.8。
- 浅色兜底：`check_light_plate.py` → 图标前景对纸底最低 3.13:1，对 12% 底板最低 3.38:1。
- 设计文档与代码一致性：`verify_doc.py` → 37 个节点 HEX 全部一致。

---

## 7. 交付物索引

```
design/2026-11-node-identity/
  方案-节点身份色与图标重设计-v1.md      ← 本文件
  analyze.py / current-palette.json       ← 旧色板量化
  census.py                               ← 图标重合与对比度盘点
  palette/
    design.py                             ← 新色板定义 + 约束复算（0 问题）
    finalize.py                           ← 生成 palette-final.json / report / swatches
    palette-final.json                    ← 37 节点 × OKLCH × ΔE 矩阵
    palette-report.md                     ← 六族表、最差对、取舍说明
    swatches.html / swatches.png          ← 暗色色板审阅页
  icons/
    icon-drafts.tsx                       ← 11 个图标的 JSX（可直接并入 Icon.tsx）
    icons-preview-final.html              ← 新色板 + 新图标预览
    icons-review-final.png                ← 整页预览截图（dsf2）
    icons-review-voice-final.png          ← 语音 6 图标
    icons-review-ai-final.png             ← AI 5 图标
    icons-review-nodecard-final.png       ← 340px 卡头模拟
    icons-report.md                       ← 逐图标说明与 16px 实测
```

## 附录 A：计算方法

- 颜色空间：OKLCH（OKLab 极坐标），用于"族色相带 + 明度/色度阶梯"设计。
- 差异度量：CIEDE2000（ΔE00），阈值取同族 7.5 / 相邻 9 / 跨族 7.5。
- 对比度：WCAG 2.x 相对亮度比，背景取卡片 `#20242A` 与画布 `#141414`。
- 旧色板的对照数据由 `analyze.py` 生成；新色板由 `palette/design.py` 复算（0 问题即通过）。

## 附录 B：与旧规范的差异

| 项 | 旧规范 v1.3 | 本方案 v1.4（建议） |
| --- | --- | --- |
| AI 族成员色 | 玫红/橙（"迁移中"） | 青蓝带 182–214° |
| 分镜板/预演台 | 橙（"迁移中"） | 视频蓝带 250–272° |
| 同族色数 | 5–8 个近似浅色 | 色相 + 明度 + 色度三轴阶梯 |
| 浅色主题 | 55% + `#17232d` 混色 | 显式 token（若启用），不再全局混色 |
| 图标 | 5 个语音节点共用 `audio` | 每个节点专属轮廓图标 |
