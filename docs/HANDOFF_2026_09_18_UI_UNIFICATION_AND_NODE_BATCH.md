# 交接：节点 UI 统一 + 媒体/视频缺陷修复 + 语音节点族（2026-09-18）

> 范围来源：用户 10 张截图逐条反馈（A 组 UI 统一、B 组缺陷与确认、C 组节点补全）。
> 本文记录**已落地内容、覆盖了哪条旧规范、验证方式、以及有意留下的边界**。
> 规范侧同步：`docs/NODE_UI_SPEC.md` §16（v1.2）为本轮 UI 决定的权威条款。

---

## 0. 一句话结论

用户截图里的 10 组问题全部处理完；过程中定位并修复了一个**真实的功能阻断**（旧项目里
视频节点的下游全部读不到源视频）；新增 3 个节点、改造 2 个节点；**节点名字收敛为单一来源**；
全量门禁通过（eslint 0 error、双 typecheck、864 测试、生产构建），并用真实渲染验收脚本
（Playwright 打运行中的 dev server）对 A 组与新节点做了 38 项 DOM/计算样式断言。

---

## 1. A 组 · 全局 UI 统一

### 1.1 九条决定（全部覆盖旧条款）

| # | 决定 | 落地位置 | 覆盖了 |
|---|------|----------|--------|
| 1 | **端口圆点必须是实色**：类型色即视觉，不做渐变/磨砂/内阴影；未连接只降不透明度 | `ui-foundation.css` `.port-dot::after` | v1.1「10px 磨砂玻璃珠」；`.port-dot-inner` 与 `.conn-cursor-glass` 整体删除 |
| 2 | **媒体预览一律白底 + 可见边框** | `ui-foundation.css` `.node-media`（材质唯一权威）、`ui-surfaces.css` `.media-result-tile` / `.media-preview-image .media-preview-stage`、`app.css` 结果网格/拆图/缩略图/浮层 | 原深色 `#15191f` / `#11161d` / `#090d12` |
| 3 | **运行按钮常驻**：不再 `selected &&` 才渲染；不可用时置灰 + 原因 tooltip，绝不消失 | `NodeCardView.tsx` `runBlockedReason`、`.node-run-btn:disabled` | v1.1 §5.4 只废除了按钮**位置**，本轮明确它必须常驻 |
| 4 | **无必要提示语一律删除** | `ConnectedInputPreview.tsx`（`input.value !== null` 过滤）、`audio.tsx`、`video.tsx` | 已连线但无值的输入不再渲染「等待上游输出」整条 |
| 5 | **媒体后续动作按钮只放文字** | `shared.tsx` / `video.tsx` / `video-transforms.tsx` / `app.css` | — |
| 6 | **悬浮全貌统一在上方**，且不显示来源名称 | `ConnectedInputPreview.tsx` `ReferenceThumb` | v1.2 §12.2「浮层底部一行：完整来源」 |
| 7 | **命名统一**：`修改→P图`、`图片生成视频→生视频`、`取帧/截取/提音→抽帧/截视频/截音频` | `specs/index.tsx` label、各 body、空态文案、设置面板 | — |
| 8 | **拆图节点**：行/列/面积一行；序号圆点 `line-height:1`；追溯线颜色跟随**被产出资产类型** | `image-split.tsx`、`app.css`、`DataEdgeLayer.tsx` | 追溯线原本用集合端口的 json 紫，用户误以为"拆出来的不是图片" |
| 9 | **图片资产节点不显示格式徽标** | `image.tsx` | — |

### 1.2 关键教训：CSS 层叠权威层

三条"上一轮以为改好了其实没生效"的规则，根因是**同一材质在多层重复定义**：

- `app.css` 与 `ui-foundation.css` 都定义了 `.node-media`，后者是最后加载层且带
  `radial-gradient(...) , #15191f`，**压过了写在 app.css 的白色**；
- `ui-surfaces.css` 的 `.media-result-tile { background: #11161d }` 同理；
- 全屏图片预览舞台 `#090d12` 在 `ui-surfaces.css`。

处理方式遵循呈现规范 §14：**`.node-*` 的材质只在 `ui-foundation.css` 权威**，`app.css`
只保留布局、不再声明背景。后续任何"改了没生效"的媒体面样式，先查 ui-foundation。

### 1.3 运行按钮的置灰依据

`runBlockedReason` 复用契约派生的 `deriveNodeReadiness`，不引入第二套"能不能跑"的判断：

- 无项目 → `项目未就绪`
- `exec ∈ {pending,queued,running}` → `节点正在运行`
- `readiness.kind === 'blocked'` → 直接显示 `缺少输入：xxx`

### 1.4 按钮文字不居中的真实原因

图片节点后续动作行在 340px 卡片里塞了 **8 个**元素（5 个动作 + 替换 + 2 个文件操作图标）。
按钮 `flex: 1 1 0` 被压到约 37px，而「生视频」三字 + 12px 图标 + gap 约 49px **溢出**，
`overflow: hidden` 把溢出的部分左右裁掉，视觉上就成了"文字没居中"。
修法：动作按钮去图标、`gap: 0`、强制居中（与视频节点的处理一致）。

---

## 2. B 组 · 缺陷修复与确认

### 2.1 B1（真实阻断）视频抽帧/截视频/截音频/截人声"全都不能用"

**现象**：视频节点明明有画面，下游 `video-frame` 等节点的输入条却显示"等待上游输出"。

**取证**：直接读用户机器上的项目文件
`%APPDATA%\canvas-studio\data\projects\<id>\project.json`，得到：

```
shape:iD4onleLgWEAMu5rmLnEJ | video | "HappyHorse 1.1_1788616583688" |
  media=yes | mime=video/mp4 | nodeResult=EMPTY | nodeRun=null
```

即：节点是**操作节点**（`video`），`props.mediaPath` 有值，但 `meta.nodeResult` 为空、
**也没有任何运行记录**——这是早期版本"把产物直接写在 props 上"的遗留状态。

**根因**：`projectVideoOutputs` 走 `latestResultMediaOutput`，只认 `meta.nodeResult` 里的
媒体结果集合；props 上的媒体对操作节点不算输出 → 下游永远读到 `null`。

**修复**（`outputProjections.ts`）：`latestResultMediaOutput` 增加**历史兼容回退**——
无结果集合**且无运行记录**时回退到 `mediaOutput(shape, ...)`。

**为什么必须带"无运行记录"这个条件**：既有门禁
`test/projectNodeOutputs.test.ts` 有一条规定「失败运行不会继续暴露上一次的媒体输出」。
只要存在 `nodeRun` 就绝不回退，该门禁继续成立；新增用例覆盖历史回退路径。

### 2.2 B2 文本拼接分隔符 `---` → `$$$`

用户理由：三个减号在 Markdown 里是分隔线，而正文本身可能含分隔线；三段美元符号既不冲突，
也便于下游用代码 `split('$$$')` 还原。

- 新增共享常量 `TEXT_MERGE_DELIMITER = '$$$'` / `TEXT_MERGE_SEPARATOR = '\n$$$\n'`
  （`shared/engine/helpers.ts`），**拼接不插入空行**。
- `inputText`（共享层）、`mergedPrompt`、`gatherUpstreamText` 全部改用该常量。
- **顺带修掉一个隐藏分叉**：渲染层 `renderer/src/engine/contracts.ts` 里还有**第二份**
  `inputText` 实现，分隔符写死为 `\n\n---\n\n`。这会让"画布预览"与"执行器"对同一次运行
  拼出不同文本。现已改为委托共享层，消除重复实现。

### 2.3 B3 P 图产物命名

`（改）原图名` → `（改1）原图名` → `（改2）…`（序号取自本节点已有结果数，无全局状态）。

为此给媒体 `NodeValue` 增加可选 `name`（来源节点标题），由 `outputProjections` 在
`mediaOutput` / `latestResultMediaOutput` / `selectedGridMediaOutput` 三处填充，随连线传递。
`imageEditExecutor` 用它拼产物标题。无来源名时回退为「图片」。

### 2.4 B4 / B5 —— 核实结论：**原实现已经正确**

| 用户问题 | 结论 | 证据 |
|----------|------|------|
| 三种颜色的语义有没有真的写进提示词？ | **有** | `imageEditExecutor` 在 `annotations.length > 0` 时拼接"红色表示需要修改，蓝色表示替换或调整，黄色表示需要保留或重点注意" |
| 发给模型的是不是两张图（标注图 + 原图）？ | **是** | `transformImageEdit` 传 `[sourceBuffer, reference]`；`reference` 由 `renderAnnotatedReference` 用 canvas 绘制标注；TOAPIS 通道两张都作为 `reference_images` 上传 |

### 2.5 B6 cowart —— **未完成，且本轮环境无法完成**

`web_search` 在本会话没有凭据、`web_fetch` 对公网域被拒（非公网 IP），仓库内也无任何
cowart 记录。**因此无法核实 cowart 的具体做法，也无法声明"已吸收其精髓"。**

作为替代，对着"图形定位 + 文字语义"这条通用精髓自查，发现并修复了一个**真实缺口**：

> 工作台里给标注写的文字**从来没有进过提示词**。一条箭头只能表达"看这里"，
> 表达不了"改成什么"，模型只能猜。

新增 `annotationInstructionLines()`（`imageEditExecutor` 内），把带文字的标注编号成清单：

```
标注 1（箭头·需要修改）：把袖口改成深蓝色
标注 2（矩形框选·需要保留或重点注意）：这块花纹保留
```

颜色角色取自工作台里「红 · 修改 / 蓝 · 替换 / 黄 · 保留」的同一套语义。

**移交项**：目前只有「文字」工具能承载标注文字；箭头 / 矩形 / 涂画还不行。
提示词侧已就绪，缺的是"画完顺手写一句"的行内输入（见 §6）。

---

## 3. C 组 · 节点补全

### 3.1 C1 视频资产节点（可上传）

`video-asset` 从"只能由运行产物生成"（`INTERNAL_NODE_TYPE_IDS`）**升级为可新建**
（`ACTIVE_NODE_TYPE_IDS`），label `视频`，contract v2，`category: input`。
`INTERNAL_NODE_TYPE_IDS` 目前为空数组（保留了类型与注释说明为什么清空）。

用户原话："我们缺一个视频节点，就像图片节点一样可以让我们传视频"。现在它与图片节点同构：
空态导入 / 已有媒体可替换 / 向下游输出 `out-video`，并保留抽帧·截视频·截音频·截人声四个后续动作。

### 3.2 C2 文件节点（新增）

新增 `file` 节点（label `文件`，contract v1，`category: input`）：

| 端口 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `out-file` | file | 是 | 已导入并落盘的原始文件资产 |
| `out-text` | text | 否 | 可解析为文本的内容（txt / md / markdown / json / csv） |

配套改动：
- `shared/mime.ts` 补 pdf / doc(x) / xls(x) / ppt(x) / csv / txt / md / json / zip 的 MIME 映射；
- `main/ipc/media.ipc.ts` 选择器新增「文档文件」过滤器，`OPENABLE_EXTS` 同步补齐；
- `app.css` 新增文件资产卡片样式（文本可滚动预览 / 二进制给"用系统程序打开"）。

**设计取舍**：Excel / Word / PDF 等二进制文档**不在画布内解析**，只把原始文件作为 file
资产暴露并给"用系统程序打开"入口；只有文本类格式写入 `props.text` 并输出 `out-text`。
这样既不假装能读 docx，又让 Markdown/CSV 立刻可用。

### 3.3 C3 配音节点改为"模型驱动"（contract v2 → v3）

用户原话："它可以输入的内容很多，所以我们选择模型的不同，也决定了它的输入和输出的结构。"

落地方式：`NodeTypeSpec.resolvePorts` 按 `config.backend` 派生三套**互斥**结构；静态 `ports`
是三套并集（仅供注册校验与契约快照）。执行器只读取当前 backend 真正需要的输入，
**不会把某家供应商的参数发给另一家**。

| backend | 输入 | 输出 |
|---------|------|------|
| `minimax`（默认） | `in-text`(many)、`in-voice`(json `voice.profile@1`) | `out-audio` |
| `doubao` | `in-text`、`in-voice`、`in-audio`(many) | `out-audio`、`out-subtitle`(json `voice.subtitle@1`) |
| `openai` | `in-text` | `out-audio` |

MiniMax 走**完整异步链路**（`main/gateway/audio.ts`）：

```
POST /v1/t2a_async_v2  →（有 file_id 直接用，否则）GET /v1/query/t2a_async_query_v2?task_id= 轮询
                       → GET /v1/files/retrieve?file_id= 取时效下载地址 → 下载落盘
```

参数覆盖：`voice_setting{voice_id,speed,vol,pitch,emotion,english_normalization}`、
`audio_setting{audio_sample_rate,bitrate,format,channel}`、`pronunciation_dict.tone`、
`language_boost`、`voice_modify{pitch,intensity,timbre,sound_effects}`、`aigc_watermark`。
请求体由纯函数 `buildMiniMaxAsyncTtsBody()` 构造，便于 wire 断言。

范围收敛（主进程与 UI 同源）：format 仅 mp3/pcm/flac（wav→mp3）、speed[0.5,2]、vol(0,10]、
pitch[-12,12]；**空音色不伪造 voice_id**；`pronunciation_dict`/`voice_modify`/`language_boost`
只在偏离默认时才出现在请求体里。

### 3.4 C4 语音克隆参数补全（contract v2 → v3）

`main/gateway/voice.ts` 新增 `uploadMiniMaxFile()` / `cloneMiniMaxVoice()` /
`buildVoiceCloneBody()`，`tts-transform.ts` 负责分派。补齐：

- `text_validation` + `accuracy`（ASR 相似度校验）
- `clone_prompt{prompt_audio, prompt_text}`：第二条音频以 `purpose=prompt_audio` 单独上传，
  **填了音频却没填原文直接报错**（不静默丢弃）
- `need_noise_reduction` / `need_volume_normalization` / `aigc_watermark` / `language_boost`
- `voice_id` 规则落成共享函数 `isValidMiniMaxVoiceId`（[8,256]、字母开头、`[A-Za-z0-9_-]`、
  末位非 `-`/`_`），UI 即时红字提示 + 主进程拒绝非法自定义 ID
- 新增 `out-json` 输出 `voice.profile@1`（`{voice_id, ...}`），供下游配音节点直接引用
- UI 增加 **7 天未调用会被删除**的警示（官方文档明确约束）

**已知缺口**：官方要求参考音频时长 10 秒–5 分钟，主进程**没有做时长探测**（无 ffprobe 解码），
只在 UI 给文字提示。

### 3.5 C5 音色设计节点（新增）

新增 `voice-design`（contract v1）：`in-text`(many，= 音色描述) → `out-audio`（试听音频，必填）
+ `out-json`（`voice.profile@1`，必填）。

`main/gateway/voice.ts` `designMiniMaxVoice()` 只发送官方文档化的 4 个字段
（`prompt` / `preview_text` / `voice_id?` / `aigc_watermark`），**不臆造 `model` 字段**。
返回的 `trial_audio` 是 **hex 编码**，已 `Buffer.from(hex,'hex')` 解码后落盘为真实音频资产——
不是把字符串当资产存下来。节点内展示并支持一键复制 voice_id。

### 3.6 C6 豆包 seed-audio（新增供应商协议）

新增 provider spec `doubao-speech`（`https://openspeech.bytedance.com`，modality audio，
suggestions `['seed-audio-1.0']`），`factory.ts` 新增 `'native-speech'` 驱动分支。

**已实现**：`POST /api/v3/tts/create` + `X-Api-Key` 鉴权；请求体 `model`、`text_prompt`、
`speaker`、`audio_config{format,sample_rate,speech_rate,loudness_rate,pitch_rate,enable_subtitle}`、
`watermark{aigc_watermark}`、`aigc_metadata{enable:false}`；响应解码
`code/message/audio(Base64)/subtitle{text,sentences[]}`，字幕结构化为 `voice.subtitle@1`
并投影到 `out-subtitle`；`enable_subtitle` 关闭时不产生空字幕。

**有意未实现（不写半成品）**：`references[]` 参考音频（官方文档只写了"object list"，
**没有给出条目字段结构**）、`audio_data` / `audio_url`、参考图片。
对应地，豆包模式下若检测到上游 `in-audio` 有连线会**明确 failed 并提示"该通道尚未接入"**，
而不是静默丢弃上游输入后假装合成成功。

---

## 4. 节点名字收敛为单一来源

用户规则："如果这个节点叫『P图』，那么左侧就不要叫『修改』，要叫『P图』。"

排查发现 `CanvasEditor.tsx` 里的 `paletteLabels` 覆盖表让**同一个节点有两个名字**：

| 节点 | 左侧面板 | 卡片默认标题 |
|------|----------|--------------|
| tts | 克隆 | 语音克隆 |
| json | 数据 | JSON |
| storyboard | 分镜 | 分镜板 |
| director | 预演 | 3D 预演台 |

**处理：整张表删除**。面板可见文字、tooltip、`aria-label`、新建卡片的默认标题现在全部取
`spec.label`，分叉在结构上不再可能发生。同时 `image-split` 的 label 由「拆图」统一为「拆分」
（与图片节点按钮、用户用语一致），contract 升到 v3。

当前面板 26 个节点：
文本 / 图片 / 裁剪 / 拆分 / 生图 / P图 / 生视频 / 视频 / 抽帧 / 截视频 / 截音频 / 人声分离 /
音频 / 文件 / 配音 / 语音克隆 / 音色设计 / 对话 / 处理 / JSON / 结构数据 / 代码 / 分镜板 /
AI 处理 / 循环 / 3D 预演台

---

## 5. 验证

### 5.1 门禁

| 门禁 | 结果 |
|------|------|
| `eslint --no-cache .` | **0 error**（126 prettier warning 为仓库既有存量） |
| `tsc -p tsconfig.node.json` / `tsconfig.web.json` | 均通过 |
| `vitest run` | **72 文件 / 864 用例全部通过** |
| `electron-vite build` | 通过 |
| `node-compliance` / `node-contract-snapshot` / `migration` | 通过（新增节点与版本升级已同步） |

> 注意：`npm run verify` 里的 `eslint --cache` **会跳过未改动文件里的历史错误**。
> 本轮就因此暴露出 `video.tsx` 的条件 Hook 调用与 `CanvasEditor.tsx` 的 `prefer-const`
> 两个旧 error（已一并修复）。建议把 `--cache` 去掉，或用 `--no-cache` 复验。

### 5.2 真实渲染验收（临时脚本，未入库）

用 Playwright 打**运行中的** dev server（`http://localhost:5173/`），对计算样式与 DOM 断言：

- A 组 25 项：白底媒体面、可见边框、实色端口圆点（`getComputedStyle(el,'::after')` 读
  `backgroundColor` / `backdropFilter` / `boxShadow`）、运行按钮未选中时存在、缺输入时 `disabled`
  且颜色非高亮、拆图三控件 `getBoundingClientRect().top` 相同、序号圆点 `line-height: 1`、
  无「等待上游输出」文案、图片动作按钮无 `svg` 且 `justify-content: center`。
- 新节点 13 项：5 个新节点可创建并渲染、视频/文件空态有导入入口、配音按 backend 派生端口
  （默认 minimax = 2 进 1 出）、语音克隆 2 进 2 出（含 out-json）、**26 个节点的可见文字与
  aria-label 完全一致**。

截图：`artifacts/verify-2026-09-18/ui-check.png`、`artifacts/verify-2026-09-18/new-nodes.png`。

### 5.3 回归门禁

新增 `test/node-ui-decisions.test.ts`（16 项）。本轮决定大多是"**删掉某个覆盖**"型——
实色圆点不许回退成磨砂、媒体面不许回退成深色、运行按钮不许再被 `selected` 门控、
`$$$` 不许变回 `---`、面板不许再出现第二份名字表。这类规则最容易在后续改动里被悄悄改回去，
所以固化成源码断言（断言"某文案不再出现"时先剥注释，避免注释里的历史说明误判）。

---

## 6. 已知边界与移交项

| # | 项目 | 状态 |
|---|------|------|
| 1 | **cowart 调研** | 本会话无网络，**未完成**。需要用户给链接/截图，或提供可用的检索通道 |
| 2 | **箭头/矩形/涂画承载标注文字** | 提示词侧编号清单已就绪，缺"画完顺手写一句"的行内输入。**需用户确认是否要做** |
| 3 | **豆包 `references[]` / `audio_data` / `audio_url` / 参考图片** | **未实现**。`references[]` 条目字段结构官方文档未给出；连线时明确报错而非静默忽略。需要用户补文档 |
| 4 | MiniMax 复刻参考音频**时长** 10 秒–5 分钟 | 未强制（主进程无 ffprobe 时长探测），仅 UI 文字提示 |
| 5 | tldraw CDN 噪声 | tldraw 会拉 `cdn.tldraw.com` 的图标雪碧图与 `translations/en.json`，被应用自身 CSP 拦下，在浏览器验收里产生 300+ 条控制台错误与 2 次未处理 `Failed to fetch`。**不影响功能**（自绘 UI 不用它的工具栏图标），但会淹没真实错误，值得单独评估 |
| 6 | 真实供应商端到端 | 本轮**全部为本地/浏览器验证**，未做真实 MiniMax / 豆包 / TOAPIS 出片验收 |
| 7 | 旧项目视频节点数据 | 已用兼容回退修好"读不到"，但**没有做数据迁移**（把旧 props 媒体升级成结果集合）。若将来要做，注意别破坏"失败运行不暴露旧产物"的门禁 |

---

## 7. 环境注意事项（本机实测）

| 现象 | 说明与绕法 |
|------|------------|
| `npm run dev` 直接崩 `Cannot read properties of undefined (reading 'isPackaged')` | 本机 DSH 的 `node` 是 shim（`%APPDATA%\dsh-desktop\harness\.desktop-bin\node.cmd`），会给**每次 node 调用**注入 `ELECTRON_RUN_AS_NODE=1`，派生的 `electron.exe` 继承后退化成纯 node。绕法：`Remove-Item Env:ELECTRON_RUN_AS_NODE` 后用真实 node 直接跑 `node_modules/electron-vite/bin/electron-vite.js dev` |
| 浏览器验收脚本连不上 `127.0.0.1:5173` | Electron dev server 只绑 `::1`（IPv6）。用 `http://localhost:5173/` 或 `http://[::1]:5173/` |
| 推送需要直连 | 本机 git 代理 `127.0.0.1:7897` 未运行，推送用 `git -c http.proxy= -c https.proxy= push` |

---

## 8. 本轮文件清单

**新增源码**
- `src/main/gateway/voice.ts`（MiniMax 文件上传 / 快速复刻 / 音色设计）
- `src/shared/speech.ts`（模型驱动配音配置 + 选项表 + 发音词典解析）
- `src/shared/voice-design.ts`（`VoiceDesignConfig` + `VoiceProfile` + `parseVoiceProfile`）
- `src/shared/engine/executors/speech.ts`、`.../voiceDesign.ts`
- `src/renderer/src/engine/executors/speech.ts`、`.../voiceDesign.ts`（2 行 re-export shim）
- `src/renderer/src/nodes/specs/bodies/file.tsx`、`speech.tsx`、`voice-design.tsx`

**新增测试**
- `test/node-ui-decisions.test.ts`（16）、`test/speech-config.test.ts`（13）、
  `test/voice-protocol-wire.test.ts`（12）

**主要修改**
- `src/renderer/src/canvas/`：`NodeCardView`（运行按钮常驻 + 置灰 + 实色端口 DOM 收敛）、
  `ConnectedInputPreview`（过滤空值 + 浮层在上方 + 去来源名）、`DataEdgeLayer`（追溯线配色）、
  `ConnectionLayer`（去玻璃珠渐变）、`CanvasEditor`（删除 paletteLabels）、`CanvasSidePanel`（模板改名）
- `src/renderer/src/nodes/specs/`：`index.tsx`（新节点注册 + label/版本）、`outputProjections.ts`
  （历史回退 + `name` 传递 + `projectFileOutputs`）、`bodies/*`（命名、去图标、空态文案）
- `src/shared/`：`types/index.ts`（`video-asset`/`file`/`voice-design` 进 ACTIVE）、`mime.ts`、
  `engine/{helpers,inputs,values}.ts`、`tts.ts`、`node-schemas.ts`
- `src/main/`：`gateway/{audio,factory}.ts`、`media/tts-transform.ts`、`ipc/{gateway,media}.ipc.ts`
- `src/renderer/src/engine/contracts.ts`（`inputText` 收敛到共享层）
- CSS：`ui-foundation.css`、`ui-surfaces.css`、`app.css`
- 文档：`docs/NODE_UI_SPEC.md` §16（v1.2）、本文件、`HANDOFF.md` 顶部条目

规模：`61 files changed, 2423 insertions(+), 884 deletions(-)` + 13 个新文件。
