# 节点全量审查报告 · ①文本节点（text）

> 审查日期：2026-09-12。依据 [NODE_FULL_AUDIT_TEST_PLAN_2026_09_12.md](./NODE_FULL_AUDIT_TEST_PLAN_2026_09_12.md) 执行。
> 环境：`main@7719701`，浏览器演示（`npm run dev:browser`，1708×879，Playwright 驱动）+ 代码层静态审查。
> 证据：`artifacts/text-node-audit-2026-09-12/`（修复前）与 `artifacts/text-node-audit-2026-09-12-fixed/`（修复后 20/20 全过）；
> 审查脚本 `scripts/audit-text-node.cjs`（已入库，可复跑）。
> 代码层测试：`node-compliance / connection-matrix / executors / node-readiness / contracts` 5 套件 **169 项全部通过**。
> 浏览器实测：修复前 **19 项断言 17 过 / 2 失败**（即 F-TEXT-01/02 实锤）；**同日完成全部 5 项修复，
> 修复后 20 项断言全部通过**（见文末"修复记录"），23 节点空态回归无溢出，`npm run verify` 全绿。
> 桌面端 SQLite 保存重开验证按方案留待桌面阶段统一执行。

---

## 1. UI 布局与功能

### 1.1 结构实测（空态，340×260）

| 项 | 规范值 | 实测 | 结论 |
| --- | --- | --- | --- |
| 卡片初始尺寸 | 340×260 | 340×260 | ✅ |
| 标题栏高度 | `--node-header-h` 42px | **28px** | ❌ F-TEXT-01 |
| 卡片圆角 | `--node-radius` 12px | **14px** | ❌ F-TEXT-02 |
| 底部类型色条 | 8px 且贴底 | 8px、贴底 | ✅ |
| 端口 | 直径 18px，in-text / out-text 各一 | 18px、id/类型正确 | ✅ |
| 正文溢出 | 无横/纵溢出 | 无 | ✅（空态+输入后均验证） |
| 空态提示 | 有行动提示 | "双击输入文本内容" | ✅ |
| 下拉控件 | 必须用 AppSelect | 本节点无下拉 | ✅（不适用） |

### 1.2 功能实测

| 功能 | 结果 | 证据 |
| --- | --- | --- |
| 双击进入编辑，textarea 自动聚焦到末尾 | ✅ | 02-editing.png |
| Ctrl+Enter 提交写 `props.text`，Esc 取消，失焦提交 | ✅（Ctrl+Enter 路径实测） | 03-typed-committed.png |
| 字数统计（标题栏 35 字） | ✅ | 05-run-merged-success.png |
| slash 指令 `/三视图 主题`：提交后出现指令条，"生成3图"一键创建 3 个生图节点，提示词含主题且写入生图 `props.text`（符合"正文在 props.text"规范） | ✅ | 07a-slash-bar.png、07-slash-generated-3-nodes.png |
| 空文本运行不伪装成功 | ✅（状态灯回 idle，运行记录记 skipped+"无文本输入"） | 08-empty-run.png |
| 运行合并后状态灯 success | ✅ | 05-run-merged-success.png |
| 浏览器演示环境重载后节点保留（10/10） | 如实记录；桌面 SQLite 持久化另行验收 | 09-reload.png |

### 1.3 UI 问题清单

- **F-TEXT-01（P1）标题栏高度 token 三重定义冲突**：`app.css:16` 定 `--node-header-h:42px`（规范值）→ `ui-foundation.css:23` 覆盖为 `22px` → `ui-surfaces.css:1428` 再用裸值 `height:28px` 硬覆盖。规范 §8.1 明令 ui-surfaces 不得重定义 token 几何。**优化方案**：删除 `ui-foundation.css:23` 与 `ui-surfaces.css:1428` 的 height 行，统一消费 `var(--node-header-h)`；同时决策标题栏形态（见 F-TEXT-03）后把 app.css 的值改为唯一事实。
- **F-TEXT-02（P1）圆角 token 双源冲突**：`app.css:15` 12px vs `ui-foundation.css:22` 14px，实测 14px。**优化方案**：删除 `ui-foundation.css:22`，保留规范值 12px；与 F-TEXT-01 同一个 PR 修复并跑视觉回归（23 节点空态截图门禁）。
- **F-TEXT-03（P2）悬浮标题与规范骨架不一致**：实现是悬浮于卡片上方的 28px 标题条（ui-surfaces `top:-34px`），规范 §3.2 骨架是"卡内 42px 标题栏"。二者必须二选一：改规范承认悬浮标题（需同步 §3.1 token 与 §5.2 组框上内边距 44px 的依据），或改实现回归卡内标题。**建议改规范**：悬浮标题已是全局统一形态且组框避让依赖它。
- **F-TEXT-04（P2）已连接输入的文本摘要单行省略**：`app.css:1462-1469` 对 `.connected-input-value` 用单行 ellipsis，规范 §2.2 要求"单项最大两行"。低危，建议随通用预览样式统一处理。

## 2. 节点能力

- **契约**（capability `text.source` v2.0.0 / contractVersion 2）：输入 `in-text`（text，可选，**many**）；输出 `out-text`（text，one，必有）。端口声明与注册表、Agent 契约、连线矩阵三者一致（169 项测试含此验证）。
- **执行器语义**（`src/shared/engine/executors/text.ts`）：`mergedPrompt(自身文本, 上游合并文本)` = **上游在前、自身在后**，多上游按连线建立顺序用 `\n\n---\n\n` 连接（`inputs.ts:20`）；合并结果写回 `props.text`；完全为空 → skipped。实测与代码一致：`上游文本甲 --- 上游文本乙 --- 主角站在雨中的十字路口`。
- **输出投影**（`outputProjections.ts:67`）：trim 后非空才暴露 `out-text`，空节点不给下游提供值——防止空串污染下游。
- **扩展功能**：slash 宫格（三视图/九宫格/25宫格）批量创建生图节点，属于"创建完整声明节点"，不产生未声明业务输出，符合 AGENTS.md 约束。
- **数据边界**：正文唯一载体是 `props.text`；`meta.nodeRun/nodeResult` 记运行状态；不使用 `props.config`（`CONFIG_NODE_TYPES` 不含 text）。

## 3. 连接能力评估

### 3.1 满足项（实测通过）

| 关系 | 结果 |
| --- | --- |
| 入度：`in-text` 接收多个上游（many） | ✅ 实测 2 上游，预览显示「文本 1 · 上游文本甲」「文本 2 · 上游文本乙」，含来源节点名与端口名 |
| 出度：`out-text` 可连 13 类下游（text/image-gen/image-edit/video/speech/tts/chat/ai-process/code/json/storyboard/processor/script 的文本口） | ✅ 与 connection-matrix 121 项测试一致；实测成功连入生图与取帧 |
| markdown 并轨：chat 的 `out-markdown` 可入 `in-text` | ✅（`engine/inputs.ts:32` 按 text 消费） |
| 非法连线拒绝：text → 取帧 `in-video` | ✅ 放下前拒绝，toast 含"不兼容"，0 条边（06-illegal-text-to-video-rejected.png） |
| 拖拽中兼容性可视化：非法端口 dim、兼容端口 ok（规范 §4.2） | ✅ 实测 参考图=dim、提示词=ok |
| 环路/自连/单值占用保护 | ✅（graph.ts 校验 + connection-matrix 覆盖） |

**结论：文本节点的连接面满足规范，无缺失关系。** 作为最上游输入节点，它对全部文本类下游的可达性完整。

### 3.2 不满足项与优化方案

- **F-TEXT-06（P2）落点在非法端口上会"磁吸"改连兼容端口，无任何提示**。实测：把文本拖到生图「参考图」（image 口，dim 态）上松手，边被建到唯一兼容的「提示词」口（`graph.ts tryConnect` 在 usable 兼容端口里取离落点最近者，`CanvasEditor.tsx:1404` 起仅按节点命中）。用户意图被静默改写，虽然已连接输入预览事后可见，但当下无反馈。**优化方案**（二选一，成本低）：
  1. 落点距某 dim 端口圆心 < 8px 时拒绝并 toast「参考图 端口不接收 text，未创建连线」；
  2. 或保留改连，但 toast 明示「参考图 端口与文本不兼容，已改连 提示词」。
  建议 2，保留便捷性的同时补足可解释性，符合规范 §0"手势必须可解释"。
- **F-TEXT-05（P2）Agent 契约对 text 的 config 描述与实际载体漂移**：capability `configSchema.text`（"节点文本内容"）与生成契约 `node.text` 暴露 `text` 字段，但画布正文存在 `props.text`、Agent 通道存在 `node.content.text`（`node-service.ts:189`）；CLI `node create --param text=...` 会把值落到不生效的 `params.text`。**优化方案**：capability 删除 `configSchema.text`（正文不经 config），CLI/MCP 补 `--text` 直写 content，并同步 `npm run agent:generate`。
- **跨节点发现（移交生图节点审查定级）**：slash 创建的生图节点写 `config={modelKey:'',size:'auto'}`，而生图 capability configSchema 声明 `providerId/modelId`（**required**）/`ratio`/`seed`；执行器实际只读 `modelKey`（`image-capabilities.ts:73` normalize）。这意味着 `generated/agent-contracts.json` 的 `node.image-gen` 必填字段与执行器真实键不符——Agent 按契约创建的生图节点会因 `modelKey` 为空而不可运行。此为本轮最重要的跨节点契约漂移线索。

## 4. 修复记录（2026-09-12 同日完成）

| 项 | 修复内容 | 涉及文件 |
| --- | --- | --- |
| F-TEXT-01 ✅ | 删除 `app.css` 的 `--node-header-h`/`--node-radius` 重复定义；token 唯一定义收敛到 `ui-foundation.css`；`ui-surfaces.css` 与 `.node-header` 基础层改用 `var()` 消费 | `ui-foundation.css`、`ui-surfaces.css`、`app.css` |
| F-TEXT-02 ✅ | `--node-radius` 统一为规范值 12px | 同上 |
| F-TEXT-03 ✅ | 修订规范 §3.1/§3.2：悬浮标题条形态定为标准，`--node-header-h=28px`（原 42px 为旧卡内骨架值），组框 44px 上内边距即其避让 | `NODE_CANVAS_PRESENTATION_SPEC.md` |
| F-TEXT-04 ✅ | `.connected-input-value` 改为最多两行省略（`-webkit-line-clamp:2`），来源标签保持单行 | `app.css` |
| F-TEXT-05 ✅ | 删除 `configSchema.text`（正文载体是 `props.text`/`content.text`，CLI 已有 `--text`）；**按破坏性变更门禁将 text 能力 contractVersion 2→3**（`isBreakingChange` 对一切 removed 生效），同步 renderer spec 与 `generated/agent-contracts.json`；CLI 用法串补 `--text` 说明 | `definitions.ts`、`specs/index.tsx`、`agent-contracts.json`、`cli/index.ts` |
| F-TEXT-06 ✅ | 从 `tryConnect` 抽出共享的 `resolveTargetInputPort`（含"落点最近端口"计算），新增 `connectionRetargetNotice`；磁吸改连时 toast 明示「已改连「提示词」：落点「参考图」端口不接收 text」 | `graph.ts`、`CanvasEditor.tsx` |

**修复后验证**：`npm test` 950/950 全绿（含两个契约门禁与 migration 版本矩阵更新）；`npm run verify`
（lint + 双 typecheck + 全量测试 + Electron 构建）全绿；`scripts/audit-text-node.cjs` 复跑 **20/20 断言
通过**（新增改连 toast 断言）；`scripts/audit-node-ui.cjs` 23 节点空态回归 **0 溢出**。
修复前证据保留于 `artifacts/text-node-audit-2026-09-12/`，修复后为 `artifacts/text-node-audit-2026-09-12-fixed/`。

## 5. 结论

文本节点的功能、数据语义与关系面**满足规范**：多输入合并顺序、来源预览、类型过滤、拒绝路径、slash 扩展全部实测通过。首轮审查发现的 2 个 P1（CSS token 双源）与 3 个 P2 已于同日全部修复并通过 20/20 复测与 `npm run verify` 全绿（见 §4 修复记录）；向生图节点移交的契约漂移线索（`providerId/modelId` vs `modelKey`）待生图节点审查定级。桌面端保存重开与真实项目链路留待桌面阶段验证。

**下一步**：按方案审查第 2 个节点「图片（image）」。

---

# 节点全量审查报告 · ②图片节点（image）

> 审查日期：2026-09-12。环境与文本节点一致（浏览器演示 + 代码层静态审查）。
> 证据：`artifacts/image-node-audit-2026-09-12/`（修复前）与 `artifacts/image-node-audit-2026-09-12-fixed/`（修复后 20/20）；
> 审查脚本 `scripts/audit-image-node.cjs`（入库可复跑）。
> 代码层测试：`media-index / registry / media-reference-remap / connected-input-preview / node-create-options` 5 套件 **37 项全部通过**。
> 浏览器实测+代码审查共发现 4 项缺陷（F-IMG-01 P1 顶栏遮挡、F-IMG-02 P1 媒体跨通道断层、
> F-IMG-03 P2 契约字段漂移、**F-IMG-04 P0 端口被连线热区遮蔽**），均已同日修复（见修复记录），
> 修复后 20/20 断言通过、文本节点回归 20/20、23 节点空态 0 溢出、`npm run verify` 全绿。

## 1. UI 布局与功能

### 1.1 结构实测

| 项 | 规范值 | 实测 | 结论 |
| --- | --- | --- | --- |
| 卡片初始尺寸 / 标题条 / 圆角 / 色条 / 端口 | 340×260 / 28px / 12px / 8px 贴底 / 18px | 全部一致（0 输入 + 1 输出端口） | ✅ |
| 空态 | 行动提示 + 导入入口 | "上传或粘贴图片后，可连接给生图、视频等节点。" + 导入图片按钮 | ✅ |
| 导入失败反馈 | 必须有 toast | `chooseAsset` 全部失败路径有 toast（QA-09-06 P2-1 修复保持） | ✅ |
| 已导入态 | 缩略图 + 替换 + 来源徽章 + 文件操作 | 齐全 | ✅ |
| 双击预览 / 单击选中 | 规范 §2.2 | 双击开 `media-preview-mask`，点遮罩关闭 | ✅ |
| 溢出 | 无 | 空态/已导入态均无 | ✅ |

### 1.2 功能实测

| 功能 | 结果 | 证据 |
| --- | --- | --- |
| 粘贴导入（ClipboardEvent → media 表 → 节点填充 title/mediaId/mediaPath） | ✅ 功能生效；**但落点可被顶栏遮挡（F-IMG-01）** | 02-pasted-imported.png |
| 运行（有媒体）→ success，out 端口 has-output | ✅ | 04-run-success.png |
| 运行（空资产）→ skipped 不伪装成功 | ✅ | 08-empty-run.png |
| 5 个后续动作（裁剪/宫格拆分/继续生图/修改图片/生成视频）一键创建**已连线**的声明节点（`shared.tsx:236`，createEdge 失败即删节点） | ✅ 2 个动作实测各建 1 节点 1 真实边 | 05-continuation-nodes.png |
| 手动连入生图 `in-images`(many) | ✅ 预览显示 参考图 order=1 + 缩略图 + 来源 | 06-manual-connect-image-gen.png |
| 非法连线 image → 文本 in-text | ✅ 拒绝 + toast 含"不兼容" | 07-illegal-image-to-text-rejected.png |
| 重载持久（browser demo） | 10/10 保留；桌面 SQLite 留桌面阶段 | 09-reload.png |

## 2. 节点能力

- **契约**（`image.source` 修复前 v2.0.0/cv2）：无输入 → `out-image`(image, one, 必有)。执行器为纯资产输出（`image.ts`：有 `props.mediaPath` 即 done，否则 skipped），不隐式调用模型，符合"资产节点不当中转站"设计。
- **输出投影**：`mediaOutput(shape,'image','out-image')`——只有真实媒体存在才暴露输出。
- **导入通道**：文件选择（`pickMedia`）、粘贴（`handlePaste` → `importMediaBuffer`）、拖放三路，全部落到媒体表 + `props.mediaId/mediaPath/mediaMime`。
- **Agent/headless 通道（修复前断层，F-IMG-02）**：见下节。

## 3. 连接能力评估

### 3.1 满足项

出度完整：`out-image` 可连 image-crop/image-split/image-edit（`in-image` one）、image-gen/video（`in-images` many）、director（`in-reference-images` 1–3）、processor；后续动作五连与手动连线均创建真实边；类型拒绝、拖拽 dim/ok 高亮、many 顺序、缩略图来源预览全部实测通过。

### 3.2 不满足项（本轮修复）

- **F-IMG-01（P1）自动落点避开顶栏时漏算悬浮标题**：`topbarSafeScreenY` 只保证**卡片顶边**在顶栏下 12px，但悬浮标题条从卡片顶边向上伸出 34px（`ui-surfaces.css` `top:-34px`）。实测粘贴导入的图片节点经避让网格落在顶栏正下方，标题行与"运行此节点"按钮被 `canvas-topbar` 截获命中而不可点（02 截图 + Playwright 拦截日志）。任何走避让网格向上偏移的创建路径都会复现。**修复**：安全 y 增加悬浮标题占用（34px）。
- **F-IMG-02（P1）媒体"身份"过通道、"位置"不过——四层不一致**：
  1. 画布→图模型（`deriveGraph` graph.ts:803）只写 `content={kind:'media',mediaId}`，`params` 不带 `mediaPath/mediaMime`；
  2. 图模型→画布（`graph-snapshot-sync.nodeCardProps`）`mediaPath` 恒为 `''`；
  3. headless 执行器 `toShape` 读的是 `params.mediaPath`；
  4. 工作流就绪校验（`workflow-service.ts:498`）却认 `params.mediaId`。
  后果：桌面导入的项目交给 headless 运行时图片节点必然 skipped；headless/Agent 产出的媒体节点在画布打开必是空态；就绪校验放行的节点执行必失败。**修复**：让 `params.mediaPath/mediaMime` 成为跨通道的媒体位置事实——deriveGraph 与 nodeCardProps 双向携带，就绪校验改认 mediaPath，configSchema 如实声明 `mediaPath`（移除从未可执行的 `mediaId`），按破坏性变更门禁将 image 能力 contractVersion 2→3 并同步生成契约。
- **F-IMG-03（P2）**：`configSchema.mediaId`（修复前）与执行器实际消费字段不符——已随 F-IMG-02 一并修正；CLI/MCP 无媒体导入工具属 Agent 能力面缺口，记入后续 Agent 审查，不在本节点展开。
- **F-IMG-04（P0）端口被连线命中热区遮蔽，扇出拖拽被静默吞掉**：`DataEdgeLayer` 在 window **捕获阶段**监听 pointerdown，落点命中连线 14px 命中描边即 `stopPropagation`。连线端点锚在端口圆心上，因此**输出端口一旦接有一条连线，从该端口再拖新连线的 pointerdown 就会被连线层吃掉**——不报错、不弹菜单、无任何反馈。实测：图片节点先"裁剪图片"后，再从其 out-image 拖线到生图，拖拽完全无效果。这直接阻断用户点名的核心场景（多图→生图、多图+音频→视频都需要从一个输出扇出多条连线）；此前逐连线拖拽能通过只是因为每次都用了"干净的"源端口，或走了批量连接柄（程序化建边，不经 pointerdown）。违反呈现规范 §8"端口在连接层之上"。**修复**：捕获监听对 `.node-card-wrap` 内的按下（节点卡片与端口）直接放行给节点侧处理器，连线选中只认暴露在画布上的线段——与"数据线在节点之下"的分层一致。

## 4. 修复记录（2026-09-12 同日完成）

| 项 | 修复内容 | 涉及文件 |
| --- | --- | --- |
| F-IMG-01 ✅ | `topbarSafeScreenY` 纳入悬浮标题向上占用 34px，所有走避让网格的创建路径（调色板/粘贴/拖放/资产面板）的标题行与运行按钮不再可能被顶栏遮挡 | `CanvasEditor.tsx` |
| F-IMG-02 ✅ | `deriveGraph` 保存 `params.mediaPath/mediaMime`；`nodeCardProps` 回读二者；`workflow-service` 就绪校验改认 `params.mediaPath`；四层媒体语义对齐 | `graph.ts`、`graph-snapshot-sync.ts`、`workflow-service.ts` |
| F-IMG-03 ✅ | `image.source` configSchema 改为 `mediaPath`（+`mediaMime`），移除不可执行的 `mediaId`；**contractVersion 2→3**（破坏性变更门禁），同步 renderer spec、migration 版本矩阵与 `generated/agent-contracts.json` | `definitions.ts`、`specs/index.tsx`、`migration.test.ts`、`agent-contracts.json` |
| F-IMG-04 ✅ | `DataEdgeLayer` 捕获监听放行 `.node-card-wrap` 内的 pointerdown/contextmenu：有连线的端口可再次拖出新连线（扇出恢复），连线选中仅作用于暴露线段 | `DataEdgeLayer.tsx` |

**修复后验证**：`npm test` 950 项全绿；`npm run verify`（lint + 双 typecheck + 全量测试 + Electron 构建）全绿；
`scripts/audit-image-node.cjs` 复跑 **20/20 断言通过**（含"有连线的端口再次扇出"路径）；
`scripts/audit-text-node.cjs` 回归 **20/20**（其 5b→7 的连续拖拽同样受益于 F-IMG-04）；
23 节点空态回归 0 溢出。

## 5. 结论

图片节点 UI、运行语义与连线面满足规范；本轮共修复 4 项——P0 一项（F-IMG-04 端口被连线热区遮蔽，直接阻断"一输出扇出多输入"的核心工作流）、P1 两项（F-IMG-01 顶栏遮挡、F-IMG-02 媒体跨通道断层）、P2 一项（F-IMG-03 契约字段），全部通过 20/20 复测与 `npm run verify` 全绿。F-IMG-04 属画布全局交互缺陷（影响所有节点间的连线操作，不止图片节点），本次顺带修复并经文本节点回归验证。向后续节点移交：① 生图节点契约漂移（`providerId/modelId` vs `modelKey`）；② CLI/MCP 缺媒体导入工具。桌面端真实文件导入/替换/重启恢复留待桌面阶段。

**下一步**：按方案审查第 3 个节点「裁剪（image-crop）」。

---

# 节点全量审查报告 · ③裁剪节点（image-crop）

> 审查日期：2026-09-12。环境同前（浏览器演示 + 代码层静态审查）。
> 证据：`artifacts/crop-node-audit-2026-09-12/`（修复后 20/20）；审查脚本 `scripts/audit-image-crop-node.cjs`（入库可复跑）。
> 代码层测试：`image-crop / image-perspective / contracts` 等 **27 项全部通过**；修复后门禁 293 项全绿。
> 浏览器实测 20 项断言最终全部通过；1 项代码缺陷（F-CROP-01）已修复。

## 1. UI 布局与功能

### 1.1 结构实测

| 项 | 规范值 | 实测 | 结论 |
| --- | --- | --- | --- |
| 尺寸/标题/圆角/色条/端口 | 340×260 / 28px / 12px / 8px 贴底 / 18px | 全部一致；端口 `in-原图`(必填) + `out-裁剪图` | ✅ |
| 空态 | 行动提示 + 入口 | "连接一张图片后…精细框选也可随时打开" + 配置裁剪按钮 | ✅ |
| 溢出 | 无 | 空态/工作台/运行后均无 | ✅ |
| 专用输入面 | crop/split/video 不渲染通用预览 | 内联工作台直接显示待裁剪原图 | ✅ |

### 1.2 功能实测

| 功能 | 结果 | 证据 |
| --- | --- | --- |
| 空跑（缺必填原图）→ 不伪装成功 + toast 指明缺失端口 | ✅ | 02-empty-run.png |
| 连接原图 → 内联工作台显示待裁剪图片 | ✅ | 03-workbench-with-source.png |
| 比例切换（自由/1:1/16:9/…）写入 config 并激活 | ✅ 16:9 | 04-aspect-and-drag.png |
| 角点拖拽实时改写归一化选区 | ✅ selection style 变化 | 同上 |
| 矩形运行 → success + 产物资产节点（artifact-materializer）+ out 可用 | ✅ | 05-run-success.png |
| 裁剪产物可链式消费（crop → crop2 工作台显示裁剪结果） | ✅ | 06-chain-consumes-crop-output.png |
| 非法连线 text → in-原图 | ✅ 拒绝 + toast，且原连接不被破坏 | 07-illegal-text-to-crop.png |
| 四角透视：设置面板切换写入 config；浏览器演示媒体引擎诚实拒绝（failed + 运行中心给出"桌面端支持透视裁剪"原因） | ✅（真实透视 napi-rs + 单应变换留桌面阶段） | 08a/08b |
| 重载：比例/连线/上次成功产物输出全部保留；**失败不清空上次成功结果**（实测 failed 后 out 仍 has-output） | ✅ | 09-reload.png |

## 2. 节点能力

- **契约**（修复前 `image.crop` v1）：`in-image`(image, 必填, one) → `out-image`(image, one)。执行器为纯本地变换（`gateway.cropImage` → 主进程 napi-rs canvas：rect 直接裁剪，quad 走 `solveHomography` 透视变换），不调用任何远程模型。
- **配置**（真实事实，`shared/image-crop.ts`）：`{version:1, mode:'rect'|'quad', aspectRatio:12 值枚举, rect:{x,y,width,height} 归一化, points:[四角]}`；parse 对任意输入收敛到合法值（宽度下限 1/10000、不越界）；quad 有非交叉/非退化校验后才进 FFmpeg/变换。
- **产物语义**：投影用 `latestResultMediaOutput`——只有本节点成功运行的产物才暴露为输出；每次运行追加 `meta.nodeResult` 集合，原图保持不变。
- **坐标设计**：全部归一化（0~1），换分辨率素材后构图可复现。

## 3. 连接能力评估

满足项：上游单源 `in-image` 可接全部图片源（实测图片节点、链式裁剪产物）；下游 `out-image` 可接全部图片消费者（链式实测）；非法类型拒绝、单值端口占用保护、拖拽兼容高亮全部正常。**无缺失关系**。

### 不满足项（已修复）

- **F-CROP-01（P1）能力 configSchema 与真实配置完全脱节**：schema 声明 `mode: fixed-ratio/free`、`ratio`、`cropRect`——三个键没有一个是执行器读取的（真实为 `mode: rect/quad`、`aspectRatio`、`rect`、`points`），且真实存在的四角透视模式在 Agent 契约里根本不可表达。Agent 按旧契约传 `ratio=16:9` 会被静默忽略。**修复**：configSchema 按 `ImageCropConfig` 逐字段重写（mode/aspectRatio/rect/points），删除全部幽灵字段；删除属破坏性变更，**contractVersion 1→2**，同步 renderer spec、migration 版本矩阵与 `generated/agent-contracts.json`。

## 4. 修复记录（2026-09-12 同日完成）

| 项 | 修复内容 | 涉及文件 |
| --- | --- | --- |
| F-CROP-01 ✅ | configSchema 重写为真实配置形状（mode: rect/quad、aspectRatio 12 值、rect、points 数组），**contractVersion 1→2**，同步生成契约与版本矩阵 | `definitions.ts`、`specs/index.tsx`、`migration.test.ts`、`agent-contracts.json` |

**修复后验证**：`npm test` 950/950；`npm run verify` 全绿；门禁 293 项全绿；浏览器审查 20/20。

## 5. 结论

裁剪节点的 UI、运行语义、产物链路与连接面全部满足规范；实测覆盖了从空态到链式消费的完整路径。唯一缺陷（Agent 契约描述了从未存在的配置键）已按契约同步机制修复。浏览器演示不支持透视裁剪是**如实声明的环境边界**（错误信息指引桌面端），真实透视变换留待桌面阶段验收。

**下一步**：按方案审查第 5 个节点「P图（image-edit）」。

---

# 节点全量审查报告 · ⑤P图节点（image-edit）

> 审查日期：2026-09-12。环境同前。证据：`artifacts/edit-node-audit-2026-09-12/`（修复后 20/20）；
> 审查脚本 `scripts/audit-image-edit-node.cjs`（入库可复跑）。
> 修复后验证：`npm test` 950/950、`npm run verify` 全绿、门禁 293 项全绿。
> **边界声明**：浏览器演示的 `imageEdit` 网关明确拒绝执行（mock 如实报"浏览器演示不支持图片修改"），
> 因此本轮验的是 UI 全流程 + 诚实失败路径；真实 gpt-image-2 `/images/edits` 供应商调用（含 mask
> multipart）留桌面阶段验收——这正是 09-06 交付记录的已知缺口。

## 1. UI 布局与功能

| 功能 | 结果 | 证据 |
| --- | --- | --- |
| 空态几何（340×260 / 28 / 12 / 8 / 三端口 18px：in-原图 + in-修改说明(many) + out-修改图） | ✅ | 01-fresh-empty.png |
| 空跑缺原图 → 阻断 + toast | ✅ | 02-empty-run.png |
| 全屏工作台：打开/关闭/单例收口（开运行中心自动收起） | ✅ | 04a/05b |
| 画笔标注绘制（工具切换 + 颜色 蓝·替换 生效） | ✅ svg 标记 +1 且 class 含 blue | 04b |
| 撤销/重做标注（0 ↔ 1） | ✅ | 同上 |
| 修改说明写入 config 并在重开工作台后恢复 | ✅ | 06-reopen-persisted.png |
| 浏览器演示运行 → failed 不伪装成功 + 运行中心记录原因 | ✅ | 05/05b |
| 非法连线 audio → P图（与 image/text 输入均不兼容）拒绝 | ✅ | 07-illegal-audio-to-edit.png |
| 重载：连线 + 标注 + 修改说明全部保留 | ✅ | 08-reload.png |

无溢出。文本连到 P图 是**合法**连线（接入 in-修改说明）——第一版脚本误把它当非法用例，已修正为音频源。

## 2. 节点能力

- **契约**（修复前 `image.edit` v1）：`in-image`(必填) + `in-text`(many 可选) → `out-image`。
- **执行器语义**（设计良好）：prompt = 修改说明 ∪ 上游文本 ∪ 标注语义说明（红=修改/蓝=替换/黄=保留，且明确"不要保留标注本身"）∪ 遮罩指引；无模型/无原图/无内容分别给出可操作的 skip 理由；`validateImageEditConfig` 对标注类型/颜色/点数、遮罩笔画与点数上限、4000 字说明等全部有结构化校验。
- **配置**（真实事实 `shared/image-edit.ts`）：`{modelKey, size(4 档), instruction, annotations[](arrow/rect/brush/text × red/yellow/blue), mask{enabled,strokes,brushSize,invert}}`，parse 对任意输入收敛并去重标注 id、迁移旧橙色。

## 3. 连接能力评估

三端口各自可达：原图接全部图片源（实测）；修改说明接文本源（实测——文本连线合法接入）；输出接图片消费者。非法拒绝（audio 实测）。**无缺失关系**。

### 不满足项（已修复）

- **F-EDIT-01（P1）能力 configSchema 漂移**：声明 `providerId/modelId`（幽灵必填，执行器读 `modelKey`）+ `mask`（string"base64 或区域描述"，与真实结构化遮罩不符）；`instruction/annotations/size` 完全未声明。**修复**：按 `ImageEditConfig` 重写（modelKey 必填、size 枚举、instruction、annotations 数组含子 Schema、mask 对象含四字段）；删除幽灵键属破坏性变更，**contractVersion 1→2**，同步 renderer spec、migration 版本矩阵与 `generated/agent-contracts.json`。
- **观察项（P2，不修）**：节点已连接原图后空态文案仍是"连接图片后…"，未区分"已连接，可打开工作台"；文案在后续 UX 批次统一处理即可。

## 4. 修复记录（2026-09-12 同日完成）

| 项 | 修复内容 | 涉及文件 |
| --- | --- | --- |
| F-EDIT-01 ✅ | configSchema 重写为 `ImageEditConfig` 真实结构（modelKey 必填、size/instruction/annotations/mask 全量声明，删除幽灵 providerId/modelId），**contractVersion 1→2**，同步生成契约与版本矩阵 | `definitions.ts`、`specs/index.tsx`、`migration.test.ts`、`agent-contracts.json` |

## 5. 结论

P图节点的工作台交互（标注/撤销重做/颜色语义/修改说明）、前置校验、诚实失败路径全部实测通过；契约漂移已修复。**遗留桌面验收项**（按方案在桌面阶段执行）：① gpt-image-2 `/images/edits` 真实调用（含标注第二参考图 + mask multipart）；② 工作台全流程真跑；③ 失败/重试的真实供应商路径。

**下一步**：按方案审查第 6 个节点「视频（image-gen 已并入图片链路，下一独立节点为 取帧 video-frame）」——按卡序为「取帧（video-frame）」。

---

# 节点全量审查报告 · ④拆图节点（image-split）

> 审查日期：2026-09-12。环境同前。证据：`artifacts/split-node-audit-2026-09-12/`（修复前）与
> `-fixed/`（修复后 18/18）；审查脚本 `scripts/audit-image-split-node.cjs`（入库可复跑）。
> 修复后验证：`npm test` 950/950、`npm run verify` 全绿、门禁 258 项全绿。

## 1. UI 布局与功能

| 功能 | 结果 | 证据 |
| --- | --- | --- |
| 空态几何（340×260 / 28 / 12 / 8 / 1入2出端口 18px） | ✅（修复后；修复前挂载即自压缩到 220，见 F-SPLIT-01） | 01-fresh-empty.png |
| 空跑缺原图 → 阻断 + toast | ✅ | 02-empty-run.png |
| 连接原图 → 预览 + 行列网格叠加层 + 汇总文案 | ✅ | 03-configured-2x2.png |
| 行列/面积输入写 `props.config`（2×2 持久化） | ✅ | 同上 |
| 运行 → success + 每格一张产物资产节点（2×2=4 个）+ 双输出可用 | ✅ | 04-run-success-artifacts.png |
| `out-图片集合`(list.items) → 循环节点 `in-列表` 连接并显示来源 | ✅ | 05-out-images-to-iterate.png |
| `out-当前图片` → 下游裁剪工作台显示该格 | ✅ | 06-current-image-consumable.png |
| 非法连线 text → in-原图 拒绝 | ✅ | 07-illegal-text-to-split.png |
| 重载：配置/连线/双输出全部保留 | ✅ | 08-reload.png |

无溢出；专用输入面按规范跳过通用预览；"当前图片"固定为最新一次运行的第一格（快速拆分设计下无独立选格 UI，多格消费走 `out-图片集合`→循环，描述与行为一致）。

## 2. 节点能力

- **契约**（修复前 `image.split` v1）：`in-image`(必填) → `out-image` + `out-images`(list.items)。
- **执行器**：`gateway.splitImageGrid` → 主进程逐格 napi-rs 裁剪落盘；**失败时主进程回滚本次已落盘资产**，节点结果按"一次运行=一次完整派生"整体替换，不与上次格子混合。每次运行逐格 emit artifact → 画布物化为独立图片资产节点（带溯源 meta）。
- **配置**（真实事实 `shared/image-split.ts`）：`{rows, columns, scalePercent}`，默认 **3×3/100%**，总量上限 64 格（超限保持行数下调列数），scalePercent 为**面积**百分比（边长开平方），每格以自身中心为锚。

## 3. 连接能力评估

双输出各自可达：`out-当前图片` 接全部图片消费者（链式实测裁剪）；`out-图片集合` 接循环 `in-列表`（list.items Schema 通道实测）与 JSON 类端口。非法拒绝、拖拽兼容高亮正常。**无缺失关系**。

### 不满足项（已修复）

- **F-SPLIT-01（P2）挂载即自压缩违反统一初始尺寸**：Body 内遗留"旧卡一次性压缩到 5/6 高"的 effect，导致新节点出生 260 立即被压到 220，违反呈现规范 §3.1 统一初始尺寸。CSS 本就 flex+overflow 钳制，260 高度无溢出。**修复**：删除该 effect（项目明确无历史用户数据），恢复 340×260。
- **F-SPLIT-02（P1）能力 configSchema 漂移**：声明 `rows/columns(required, default 2, max 10)` + `cols`——真实键是 `columns`、真实默认 3×3、上限按 64 格总量钳制，且 `scalePercent` 完全缺失（Agent 无法表达面积缩放）。**修复**：configSchema 重写为 rows/columns/scalePercent（default 3/3/100、上限 64/64/100）；`cols` 删除属破坏性变更，**contractVersion 1→2**，同步 renderer spec、migration 版本矩阵与 `generated/agent-contracts.json`。

## 4. 修复记录（2026-09-12 同日完成）

| 项 | 修复内容 | 涉及文件 |
| --- | --- | --- |
| F-SPLIT-01 ✅ | 删除挂载自压缩 effect，恢复契约统一初始尺寸 340×260（CSS 已保证内容钳制） | `bodies/image-split.tsx` |
| F-SPLIT-02 ✅ | configSchema 重写（rows/columns/scalePercent，真实默认与上限；删除幽灵键 `cols`），**contractVersion 1→2**，同步生成契约与版本矩阵 | `definitions.ts`、`specs/index.tsx`、`migration.test.ts`、`agent-contracts.json` |

## 5. 结论

拆图节点的快速拆分交互、双输出语义（单格直连 + 集合批处理）、失败回滚与产物物化全部实测通过；两项缺陷（自压缩违规、契约漂移）已修复并全量验证。按方案下一个节点为「修改（image-edit）」——其 `/images/edits` UI 工作台是 09-06 交付中记录的已知缺口，届时需要桌面端真实供应商配合验收。
