# 节点全量审查与测试方案（2026-09-12）

> 范围：全部 23 个 Active 节点 + 2 个兼容保留节点（视频资产、脚本）。
> 审查维度：① UI 样式；② 排布是否符合《节点画布呈现与关系交互规范 v1.0》
> （[NODE_CANVAS_PRESENTATION_SPEC.md](./NODE_CANVAS_PRESENTATION_SPEC.md)）；
> ③ 单节点运行；④ 关联节点联合流程；⑤ 已配置真实供应商的实运营测试。
> 本方案依据 `src/capabilities/definitions.ts`、`src/renderer/src/nodes/specs/index.tsx`、
> `generated/agent-contracts.json`、`docs/NODE_DEEP_AUDIT_2026_09_11.md` 与本机应用数据库实况编写。

---

## 1. 通过标准

单节点标记为"完成"必须同时满足（沿用 2026-09-11 深度审查 §9）：

1. UI 在空态 / 已配置 / 单输入 / 多输入 / 非法输入 / running / success / failed / 保存重开
   九种状态下无遮挡、无溢出、无伪状态；
2. 呈现符合规范 §3 token（340×260 默认尺寸、42px 标题栏、底部 8px 色条、端口 18px/外移 16px、
   AppSelect 唯一下拉、底部主按钮距色条上沿 10px）；
3. 端口、Schema、必填性、基数与 capability registry 一致（`test/connection-matrix.test.ts` +
   `test/node-compliance.test.ts` 证明）；
4. 连线后卡片显示具体来源（源节点名 + 端口名 + many 顺序 + 角色）；
5. executor 只消费声明端口，写正确的 `meta.nodeRun` / `meta.nodeResult`；
6. 本地节点有真实媒体产物落盘，远程节点有真实请求 payload / 轮询 / 下载 / 入库证据；
7. 成功、失败、取消、重试、保存重开各有证据；
8. 涉及协议改动时 `npm run agent:generate` 与全量 `npm run verify` 通过。

---

## 2. 已知事实与开测前预检项

### 2.1 本机已配置的真实模型（读自 %APPDATA%/canvas-studio/data/app.db）

| 模态 | 模型 | 供应商 / 端点 | 可测节点 |
| --- | --- | --- | --- |
| 文本 | `glm-5.3-flash` | TokenDance 中转 `https://tokendance.space/gateway/v1` | 对话、AI 处理 |
| 图片 | `gpt-image-2` | codex2api 中转 `https://www.codex2api.com/v1` | 生图、P图 |
| 视频 | `minimax-h3-max` | TokenDance MiniMax `https://tokendance.space/gateway/minimax` | 图片生成视频 |
| 音频 | `minimax-speech-2.8-turbo` | TokenDance MiniMax | 配音、语音克隆（MiniMax 复刻通道） |
| 本地 | FFmpeg 7.1.1（用户 PATH）、audio-separator | — | 裁剪/拆图/取帧/截取/提音/人声分离 |

**H3-Max 能力约束（影响视频多输入用例设计）**：本机只配了 `h3-max`，其 profile 不支持
"多参模式"，支持的是 首帧（1 图）与 首尾帧（2 图）。"多图参考"模式只能在浏览器 mock 的
`specId: minimax`（H3）/ `seedance` fixture 上验证 UI，真实多参验收需要 H3（非 Max）或
Seedance 供应商。语音克隆的本地 ComfyUI + IndexTTS-2.5 通道在本机不可用，只验"能力缺失
稳定前置错误"。

### 2.2 开测前必须核实的异常（本轮新发现）

- **预检 A**：`providers` 表中同一组 3 个供应商重复出现 16 次（48 行）。需确认模型下拉是否
  出现重复项，定位写入去重缺失的根因（疑似设置保存/导入路径重复 INSERT），先记缺陷再决定是否修复。
- **预检 B**：视频真实生成在 2026-09-06 曾被 TokenDance 网关以"当前模型未配置该请求规格的价格"
  拒绝。本轮用最小参数（768P/5 秒/1 图首帧）重测；仍被拒则记录供应商原文并标记 blocked-external。
- **预检 C**：确认 FFmpeg/FFprobe 在新终端 PATH 可用（上一轮已知已运行进程看不到新 PATH）；
  audio-separator 能力探测结果记录进证据。
- **预检 D**：打包产物是否为当前 `main`（`7719701`）构建；`dist/win-unpacked/canvas-studio.exe`
  时间戳早于最近提交则先重新打包。

### 2.3 密钥与运行通道约束（重要）

API Key 用 Electron safeStorage（DPAPI）加密，**只有 Electron 主进程能解密**。因此：

- 真实供应商运营测试必须走 Electron（`npm run dev` 或打包 exe）+ Playwright 驱动；
- CLI（`canvas workflow run`）可做建图、校验、dry-run 和**本地变换节点**的真实执行；
  用加密 Key 的远程模型调用在纯 Node CLI 里解密为空串，不得用作远程实跑通道；
- 浏览器演示页（`npm run dev:browser`，此前审查用 127.0.0.1:3123）只用于 UI/连线/布局审查，
  供应商为 mock fixture，其通过**永远不等于**真实供应商通过。

---

## 3. 四条测试通道

| 通道 | 环境 | 用途 | 命令/入口 |
| --- | --- | --- | --- |
| A 代码/契约层 | vitest | 端口矩阵、Schema、执行器、连线计划、持久化的回归 | `npm run verify`、`npx vitest run <file>` |
| B 浏览器呈现审查 | `npm run dev:browser` + Playwright | 每节点 9 状态截图、几何断言（溢出/色条/端口/缩放） | `node scripts/audit-node-ui.cjs http://127.0.0.1:<port>/ artifacts/<目录>`（本轮扩展断言） |
| C 桌面真实运行 | 打包 exe（或 dev）+ Playwright | 真实媒体变换、真实模型调用、运行记录、入库 | 驱动 `dist/win-unpacked/canvas-studio.exe`，证据存 `artifacts/` |
| D 联合流程 E2E | 通道 C 同环境 | 第 7 节 10 条全链路场景，整图运行 + 保存重开 | 同上 |

通用证据协议（每个用例）：前后截图 +（远程）请求 payload/响应 fixture + `meta.nodeRun` /
`meta.nodeResult` 快照 + 媒体表/文件落盘核对 + 下游 `ConnectedInputPreview` 截图 + 保存重开后
复检。产物只留本地 `artifacts/`，不入库。

---

## 4. 通用呈现规范检查单（每个节点都过一遍）

**自动断言（扩展现有 audit 脚本）**：body 无横/纵溢出（`scrollWidth/clientWidth`）、底部色条
存在且高度 8px、无裸 `<select>`、初始尺寸与契约一致、状态点五态颜色正确、many 输入预览显示
来源名与序号、`one` 端口二次连线被拒并有说明、缩放 50%/100%/200% 下四角点不漂移。

**人工/截图检查**：标题栏 42px 单行省略；主按钮贴底且距色条 10px；生成型节点骨架
（输入摘要 → 模型参数行 → 弹性正文 → 底部按钮）；深浅两主题；错误文案可操作（缺哪个端口/
模型能力原因）；运行中禁止重复提交且保留旧结果；失败不清空上次成功结果。

---

## 5. 节点关联总表（类型级，连线合法性以此为准）

图例：`A.out → B.in`。`many` 表示多值端口；`req` 必填。

| 源输出 | 可连目标 |
| --- | --- |
| `text.out-text` | text/image-gen/image-edit/video/speech/tts/chat/ai-process/code 的 `in-text`(many)；json `in-text`；storyboard `in-text`；processor `in-value` |
| `chat.out-markdown` | 同上所有 `in-text`（markdown 按文本消费，`engine/inputs.ts` 已并轨） |
| `ai-process.out-text / out-markdown` | 同 text |
| `image.out-image` / `image-crop.out-image` / `image-gen.out-image` / `image-edit.out-image` / `image-split.out-image` / `video-frame.out-image` / `director.out-frame` | image-gen `in-images`(many 1–4)；video `in-images`(many)；director `in-reference-images`(1–3)；image-crop/image-split/image-edit `in-image`(req, one)；processor `in-value` |
| `image-split.out-images` (list.items) | iterate `in-list`；json/structured/code 的 JSON 端口 |
| `video.out-video` / `video-clip.out-video` / `video-asset.out-video` / `director.out-preview-video` | video-frame/video-clip/video-audio `in-video`(req)；video `in-reference-video`(many)；processor |
| `audio.out-audio` / `speech.out-audio` / `tts.out-audio` / `vocal-separate.out-audio` / `video-audio.out-audio` | tts `in-audio`；vocal-separate `in-audio`(req)；video `in-reference-audio`(many)；processor |
| `json.out-json` / `structured.out-json` / `ai-process.out-json` / `code.out-*`(json) / `iterate.out-items` | json `in-json`(many)；structured `in-context`(many)；ai-process `in-json`；code `in-json`(many)；iterate `in-list`；processor |
| `structured.out-json`(prompt.bundle@1) | image-gen `in-prompt`；video `in-prompt` |
| `structured.out-json`(storyboard.shots) / `storyboard.out-json` / `script.out-json` | storyboard `in-json`；director `in-storyboard` |
| `director.out-camera` (previs.camera) | 另一 director `in-camera-preset` |
| `iterate.out-item` (iteration) | 循环体内下游 JSON 端口（临时作用域，不入项目输出） |
| 任意输出 | processor `in-value`（万能透传） |

---

## 6. 逐节点审查卡

每张卡固定六段：**端口 / 关联节点 / UI 审查要点 / 代码层测试 / 运行测试 / 真实运营**。
多输入用例在卡内单独列出。现有测试文件路径省略 `test/` 前缀。

### 6.1 文本 text（contract v2）
- **端口**：`in-text`(many, 可选) → `out-text`。
- **关联**：上游=chat/ai-process/code/storyboard/processor 的文本；下游=一切 `in-text` 节点。
- **UI 要点**：双击进入编辑（mousedown detail==2 捕获转发，历史修复区）、多上游合并预览的
  来源与顺序、正文 min-height 96px。
- **代码层**：`executors.test.ts`、`node-readiness.test.ts`；新增：3 条上游按边创建顺序合并、
  保存重开文本不丢。
- **运行**：节点级运行写 `props.text` 聚合结果；空文本 + 无上游 → blocked 文案。
- **真实运营**：不依赖模型（本地）；用 2 个上游文本（其一来自真实 glm-5.3-flash 对话输出）验证下游合并。

### 6.2 图片 image（contract v2）
- **端口**：无输入 → `out-image`。
- **关联**：下游=全部图片类消费者（见总表）；拆分展开会生成 image 节点并自动连线。
- **UI 要点**：导入按钮反馈（历史 P2-1 修复）、缩略图、双击预览、替换不串资产。
- **代码层**：`media-index.test.ts`、`media-reference-remap.test.ts`、`project-persistence.test.ts`。
- **运行**：导入真实 PNG/JPG → media 表落盘 → `out-image` 可连。
- **真实运营**：真实文件导入（含中文名/长文件名路径）、重启后引用完整。

### 6.3 裁剪 image-crop（v1）
- **端口**：`in-image`(req) → `out-image`。
- **关联**：上游=image/生图/取帧/预演帧等；下游=同图片消费者。
- **UI 要点**：矩形/四角透视两种模式设置面板、按原图比例解释坐标、结果网格动态高度。
- **代码层**：`image-crop.test.ts`、`image-edit-media.test.ts`（共享媒体变换路径）。
- **运行**：真实 PNG 矩形裁剪 + 透视裁剪各 1 次，核对输出资产尺寸与原图不变。
- **真实运营**：同运行（纯本地）；验收四角拖拽在 200% 缩放不下漂。

### 6.4 拆图 image-split（v1）
- **端口**：`in-image`(req) → `out-image` + `out-images`(list.items)。
- **关联**：下游=iterate（核心组合）、图片消费者；展开后自动生成 image 节点。
- **UI 要点**：行列切换 2×2→4×4 向下扩容、端口随高度重分布、连线同帧重算（规范 §6.3 验收示例）。
- **代码层**：`image-split.test.ts`、`iterate.test.ts`（消费 list.items）。
- **运行**：真实 4 宫格图拆分；展开 → 撤销 → 重做几何一致。
- **真实运营**：`out-images → 循环 in-list → 循环体生图`（见 E2E-4）。

### 6.5 生图 image-gen（v3）——多输入重点
- **端口**：`in-images`(many, 1–4)、`in-prompt`(prompt.bundle@1)、`in-text`(many) → `out-image`。
- **关联**：上游=全部图片源、text/chat、structured(prompt)；下游=图片消费者。
- **UI 要点**：模型/画幅行 → 弹性提示词 → 底部"生成图片"唯一主按钮；参考图缩略卡显示
  来源名 + 顺序（参考图 1–4）；无模型时 `NoModelHint` 提前 return。
- **代码层**：`image-capabilities.test.ts`、`image-gateway-wire`（若无则补）、`executors.test.ts`
  断言 payload 用 `props.text` 而非 config 遗留 prompt；新增：4 图顺序 fixture（图片 1–4 按边序）。
- **运行**：1 图 / 2 图 / 4 图各跑一次 mock 通道验证提交结构；非法输入（text 连 in-images）放下前被拒。
- **真实运营**：gpt-image-2 真实出图：纯文生、1 参、4 参、prompt.bundle+text 双通道各 1 次；
  记录请求体与落盘资产；超 4 张第 5 条边应被基数规则拒绝。

### 6.6 P图 image-edit（v1）
- **端口**：`in-image`(req)、`in-text`(many) → `out-image`。
- **关联**：上游=图片源+文本源；下游=图片消费者。
- **UI 要点**：工作台工具（箭头/移动标注/遮罩/画笔尺寸）、标注→mask 提交、原图不变。
- **代码层**：`image-edit.test.ts`、`image-edit-media.test.ts`。
- **运行**：真实标注 + 文字说明提交（mock 通道验证 mask 结构）。
- **真实运营**：gpt-image-2 `/images/edits` 端到端（09-06 已 curl 验证后端，**UI 工作台全流程
  是已知缺口，本轮必须桌面实跑补齐**）；失败路径（无标注提交）有可操作错误。

### 6.7 图片生成视频 video（v6）——多输入重点、最高风险
- **端口**：`in-images`(many)、`in-reference-video`(many)、`in-reference-audio`(many)、
  `in-prompt`、`in-text`(many) → `out-video`。
- **关联**：上游=图片源（首帧/尾帧角色）、视频源（运动参考）、音频源（参考音频）、text、
  structured(prompt)、director（预演视频/帧）；下游=取帧/截取/提音。
- **UI 要点**：未选模型显式提示（不 fallback）；模式选项 = 模型能力 ∩ 当前输入集合
  （共享 `resolveVideoMode`）；已连图片的缩略图 + 名称 + 角色标签（首帧/尾帧/参考图 N）随模式
  切换更新；H3-Max 参数（768P 默认、5 秒、16:9）；提示词 7000 字上限 maxLength；兼容网关
  说明文案。
- **代码层**：`video-capabilities.test.ts`、`video-gateway-wire.test.ts`（H3 首尾帧/多参、
  Seedance 官方/兼容隔离）、`video-reference-validation.test.ts`、`async-executors.test.ts`；
  新增：2 图 + 参考音频提交时角色/素材顺序 fixture、超限媒体（>30MB 图）主进程拒绝 fixture。
- **运行**：浏览器 mock 全矩阵：0 图=仅文生；H3 fixture 1 图=默认多参；H3-Max fixture 1 图=仅
  首帧；2 图=首尾帧；参考视频/音频接入不支持模型时标出具体端口原因。
- **真实运营**（最小成本护栏：768P/5s/1 图）：①文生 1 次；②1 图首帧 1 次；③2 图首尾帧 1 次；
  ④参考音频提交（若网关拒则记录原文）。每次记录 task_id、轮询、下载、入库；若命中"未配置价格"
  则记 blocked-external 并停止后续视频实跑。

### 6.8 取帧 video-frame（v3）
- **端口**：`in-video`(req) → `out-image`。
- **关联**：上游=video/video-clip/video-asset/director 预演视频；下游=图片消费者。
- **UI 要点**：首帧/尾帧/指定时刻设置面板、时间输入校验。
- **代码层**：`video-transform.test.ts`、`video-transform-main.test.ts`。
- **运行/真实运营**：真实 MP4 首帧+中点+尾帧 3 次提取，PNG 落盘，FFprobe 能力探测路径。

### 6.9 截取 video-clip（v3）
- **端口**：`in-video`(req) → `out-video`。
- **关联**：上游=视频源；下游=取帧/截取/提音/视频参考（链式截取）。
- **UI 要点**：起止毫秒输入、重编码进度、取消入口。
- **代码层**：`video-transform*.test.ts`。
- **运行/真实运营**：真实 MP4 截取 2–15s 片段；起止越界错误；运行中取消留 `failed/cancelled` 记录。

### 6.10 提音 video-audio（v3）
- **端口**：`in-video`(req) → `out-audio`。
- **关联**：下游=tts 参考、人声分离、视频参考音频。
- **代码层**：`video-transform*.test.ts`。
- **运行/真实运营**：真实 MP4 提音 → WAV/M4A 落盘 → 接入人声分离（E2E-6）。

### 6.11 人声分离 vocal-separate（v4）
- **端口**：`in-audio`(req) → `out-audio`(人声)；伴奏生成关联独立音频节点。
- **关联**：上游=audio/speech/tts/video-audio；下游=配音参考、视频参考音频。
- **UI 要点**：能力探测前置（audio-separator 缺失时稳定前置错误）、高质量模式伴奏节点出现。
- **代码层**：`executors.test.ts`（能力探测分支）。
- **运行/真实运营**：真实歌曲 MP3 分离；人声与伴奏两资产；伴奏节点自动出现在画布。

### 6.12 音频 audio（v3）
- **端口**：无输入 → `out-audio`。
- **UI 要点**：导入反馈、波形/播放控件、双击预览不自动播放（规范 §2.2）。
- **代码层**：`media-index.test.ts`。
- **运行/真实运营**：真实 WAV/MP3 导入、重启后时长与名称完整。

### 6.13 配音 speech（v2）
- **端口**：`in-text`(many) → `out-audio`。
- **关联**：上游=text/chat/ai-process；下游=视频参考音频、tts 参考、人声分离。
- **UI 要点**：模型/音色/格式设置行、多文本合并朗读预览。
- **代码层**：`tts-config.test.ts`、`audio` 网关相关执行器测试。
- **运行**：多上游文本合并提交结构断言。
- **真实运营**：minimax-speech-2.8-turbo 真实合成 1 次（T2A v2 适配器），hex 音频解码落盘。

### 6.14 语音克隆 tts（v2）
- **端口**：`in-audio`(可选)、`in-text`(many) → `out-audio`。
- **UI 要点**：ComfyUI/MiniMax 双后端选择与可用性提示、参考语音上传。
- **代码层**：`tts-config.test.ts`。
- **运行**：本机无 ComfyUI+IndexTTS-2.5 → **必须**得到稳定前置错误（不 crash、不静默）。
- **真实运营**：MiniMax 快速复刻通道若网关支持 `minimax:voice_clone` 则 1 次真跑；否则记录 blocked。

### 6.15 对话 chat（v1）
- **端口**：`in-text`(many) → `out-markdown`。
- **关联**：上游=text；下游=所有文本输入（markdown 并轨）。
- **UI 要点**：选中节点自动开右侧对话面板（历史 P3 修复）、多轮记忆、未配置模型引导。
- **代码层**：`chat-memory.test.ts`、`chat-data` 相关。
- **运行**：多轮对话记忆正确、`out-markdown` 输出最后一条助手回复。
- **真实运营**：glm-5.3-flash 真实 2 轮对话（第 2 轮引用第 1 轮内容验证记忆）；输出接 AI 处理。

### 6.16 处理 processor（v1）
- **端口**：`in-value`(any) → `out-value`(any)。
- **关联**：万能适配器，验证 text/image/audio/video/json 四类值透传。
- **代码层**：`executors-shared.test.ts`。
- **运行**：四类值各透传 1 次，输出端口类型随配置变化。

### 6.17 JSON json（v1）
- **端口**：`in-json`(many)、`in-text` → `out-json`。
- **UI 要点**：字段卡片、非法 JSON 错误态、编辑器与卡片编辑态统一（历史修复区）。
- **代码层**：`node-schemas.test.ts`、`structured-data.test.ts`。
- **运行/真实运营**：粘贴真实模型返回的 JSON 文本解析；节点级运行与整图运行都有执行记录（历史 P3-7）。

### 6.18 结构数据 structured（v1）——prompt.bundle 生产者
- **端口**：`in-context`(many json)、`in-text`(many) → `out-json`（schema 随配置解析）。
- **关联**：下游=image-gen/video 的 `in-prompt`、iterate `in-list`、storyboard/director。
- **UI 要点**：Schema 选择、`{{input[0].field}}` / `{{text}}` 模板、resolvePorts 动态 schema。
- **代码层**：`structured-data.test.ts`。
- **运行**：模板替换 + Schema 校验失败路径。
- **真实运营**：prompt.bundle → 生图 in-prompt 真实生效（E2E-8）。

### 6.19 代码 code（v2）
- **端口**：`in-text`(many)、`in-json`(many)、动态参数端口 → 动态 `out-output`。
- **UI 要点**：参数配置冲突时不显示半真假动态端口、离线沙箱。
- **代码层**：`code-contract.test.ts`、`code-runtime-offline.test.ts`、`headless-run-code.test.ts`。
- **运行/真实运营**：确定性转换 2 例（文本拼接、JSON 过滤）；错误代码 → failed 可重试。

### 6.20 分镜板 storyboard（v1）
- **端口**：`in-json`(storyboard.shots)、`in-text` → `out-json` + `out-text`。
- **关联**：上游=ai-process/structured/script；下游=director、（经 prompt 链）生图/视频。
- **UI 要点**：镜头卡片编辑、合成文本摘要、Schema 校验。
- **代码层**：`storyboard-editor.test.ts`、`director-data.test.ts`。
- **运行**：真实 glm-5.3-flash 拆解 JSON → 分镜板渲染 → 编辑 1 个镜头 → out-json 更新。

### 6.21 AI 处理 ai-process（v1）
- **端口**：`in-text`(many)、`in-json` → `out-text` / `out-markdown` / `out-json`（按输出模式）。
- **UI 要点**：一次性无记忆语义的文案、Schema 选择、NoModelHint 提前 return（UI_PLAN §4a）。
- **代码层**：`aiProcess.test.ts`。
- **运行**：三种输出模式 mock 各 1 次；Schema 违例 → 结构化错误。
- **真实运营**：glm-5.3-flash：文本摘要 1 次 + 按 shot schema 出 JSON 1 次（喂给分镜板）。

### 6.22 循环 iterate（v2）——多输入批处理核心
- **端口**：`in-list`(list.items) → `out-item`(iteration) + `out-items`(list.items)。
- **关联**：上游=image-split/structured/code；循环体=生图/视频/文本/JSON 等子流程节点。
- **UI 要点**：顺序执行、限数、失败策略、重试、取消；`out-item` 不入项目输出。
- **代码层**：`iterate.test.ts`、`batch-connection.test.ts`。
- **运行/真实运营**：mock 通道全矩阵（成功/失败继续/失败中止/取消/限数 2）；真实通道只允许
  **限数 2** 的小列表驱动生图（成本护栏），`out-items` 结构核对（来源、状态、产物）。

### 6.23 3D 预演台 director（v3，手动发布）
- **端口**：`in-storyboard`、`in-reference-images`(1–3)、`in-camera-preset` →
  `out-frame` / `out-preview-video` / `out-camera` / `out-project`（均发布后才可用）。
- **关联**：上游=storyboard、图片源、另一 director；下游=video（首帧/运动参考）、director 链。
- **UI 要点**：`executionMode: manual-publish`（不自动发布）、窄屏镜头/属性面板切换、
  发布前输出端口无值。
- **代码层**：`director-data.test.ts`、`previs-space-generator.test.ts`。
- **运行/真实运营**：导入真实分镜 + 2 参考图 → 建白模 → 调机位 → 发布静帧 + WebM →
  接视频节点作首帧/运动参考（E2E-1）；`out-camera →` 第二个 director 的机位预设。
- **约束**：按既有安排，导演台排在其它节点稳定之后，不作为视频节点前置。

### 6.24 兼容保留节点（不参与打分）
- **video-asset**（不可创建）：由资产导入/产物生成，验收预览、选择、向下游输出。
- **script**（不可创建，旧版复合）：仅验证已有项目打开不报错；新流程一律"文本→处理→JSON"。

---

## 7. 关联流程联合测试（E2E 场景）

每条场景都要：整图运行（依赖顺序正确）→ 节点级重跑 → 保存/关闭/重开 → 边、输入顺序、
结果来源、状态完全一致。

| # | 场景 | 覆盖的多输入/关系 | 通道 |
| --- | --- | --- | --- |
| E2E-1 | 文本→AI处理(shot JSON)→分镜板→预演台(发布帧+WebM)→视频(首帧/运动参考)→取帧→裁剪 | director 3 入；发布链；视频多输入 | C+D（视频实跑视预检 B） |
| E2E-2 | 4×image→生图（断言图片 1–4 顺序与 payload 一致） | **多图→图** | C 真实 gpt-image-2 |
| E2E-3 | 2×image + audio→视频（首帧+尾帧+参考音频角色标注） | **多图+音频→视频** | C（h3-max 首尾帧；音频支持性按网关实测） |
| E2E-4 | image→拆图(3×3)→out-images→循环→循环体生图(限数2)→out-items→JSON | many→循环→扇出 | C（生图真实，限数 2） |
| E2E-5 | text×3→text(合并)→speech→video(参考音频) | 多文本合并 + 音频入视频 | C |
| E2E-6 | video→提音→人声分离→(人声)→P图链外: 人声→配音参考；伴奏资产核对 | 音频衍生链 | C |
| E2E-7 | chat(真实 2 轮)→out-markdown→AI处理(JSON schema)→structured→code 过滤→JSON 卡片 | markdown 并轨、json 链 | C |
| E2E-8 | structured(prompt.bundle)+text→生图 `in-prompt`+`in-text` 双通道 | prompt 包与正文并存 | C |
| E2E-9 | director1 `out-camera`→director2 `in-camera-preset`；机位复用 | camera 专用通道 | C |
| E2E-10 | 框选 text+image→组合连接柄→生图（一次释放 2 条边）；任一非法则 0 条边 | 异构原子连接 | B+D |

非法路径（所有场景通用）：text 连 `in-images`、`one` 端口双源、Schema 不匹配（普通 json →
`in-storyboard`）、环路（processor 自连）均须放下前被拒并给出原因。

---

## 8. 真实供应商运营矩阵与成本护栏

| 节点 | 供应商/模型 | 用例数 | 护栏 |
| --- | --- | --- | --- |
| 对话 / AI 处理 | glm-5.3-flash | 各 ≤4 | 短 prompt |
| 生图 | gpt-image-2 | ≤6 | 默认尺寸；4 参 1 次 |
| P图 | gpt-image-2 /edits | ≤2 | 单标注 |
| 视频 | minimax-h3-max | ≤3（文生/首帧/首尾帧） | 768P/5s；命中"未配置价格"即停 |
| 配音 | minimax-speech-2.8-turbo | ≤2 | ≤100 字 |
| 循环×生图 | — | 限数 2 | 禁止对真实供应商跑全量列表 |
| 取消/重试 | 上述任一 | 各 1 | 运行中取消，记录终态 |

所有请求/响应保存为 wire fixture 存 `artifacts/wire-<日期>/`，用于把"网关已验证能力"升级为
"供应商级已验收"。

---

## 9. 执行顺序

1. **Phase 0 基线**：预检 A–D；`npm run verify`；必要时重打包 exe；启动 dev:browser 与桌面端。
2. **Phase 1 代码层**：跑契约三件套 + 补缺的代码级测试（多输入顺序 fixture、超限媒体拒绝）。
3. **Phase 2 呈现审查**：扩展 `audit-node-ui.cjs` 断言 → 23 节点 × 9 状态截图与几何断言
   （`1708×879`、深浅主题、50%/100%/200% 缩放抽样）。
4. **Phase 3 单节点运行**：本地变换节点 → 远程生成节点（第 8 节矩阵），逐节点按第 6 节卡执行。
5. **Phase 4 联合流程**：E2E-1…10，每条留证据链。
6. **Phase 5 保存重开与导出**：全场景重开复检 + `transfer.integration` 实项目导出/导入
   （媒体 ID 重映射、无 API Key、tldrawSnapshot/meta.nodeResult 引用完整）。
7. **Phase 6 报告**：产出 `docs/NODE_FULL_AUDIT_2026_09_12.md`：逐节点九状态矩阵、
   问题清单（P0 阻断 / P1 应修 / P2 记录）、wire fixture、通过标准核对表。

问题分级：P0=数据错误/连线语义错/真实链路必失败；P1=协议不一致/状态伪呈现；P2=视觉与体验。
发现 P0 即停该节点后续实跑，先修复再回归。
