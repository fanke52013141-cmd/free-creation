# 全节点 UI 与关系审查报告（2026-09-09）

> 审查版本：`main` 工作区（2026-09-09 优化完成后复测），浏览器验收地址 `http://127.0.0.1:3123/`
> 范围：23 个可创建 Active 节点；节点空态、默认尺寸、端口、动态高度、真实连线关系、输入读取路径和已有自动化覆盖。
> 初检截图：本地 `artifacts/node-ui-audit-2026-09-09-final/`；复测截图：`artifacts/node-ui-audit-2026-09-09-postfix/`。均由 `scripts/audit-node-ui.cjs` 在隔离 browserMock 上逐节点创建和截取。该脚本不读写桌面项目。

## 优化复测状态

| 项目 | 结果 | 可复核证据 |
| --- | --- | --- |
| 节点空态截图 | 23/23 已复测 | `artifacts/node-ui-audit-2026-09-09-postfix/report.json`；所有节点均无 body 横/纵向溢出。 |
| 选区几何 | 已修复 | 选框、四个视觉角点、批量连接柄均由同一 `SelectionGeometry` 计算；tldraw 原生缩放命中区不再被 CSS 平移。 |
| 资产假连接 | 已修复 | `image.source` 升为 contract v2，`audio.source` 升为 contract v3；二者均是无输入的纯素材源。 |
| 已连接输入呈现 | 已实施 | 所有节点统一从真实 Arrow binding、端口和 `projectOutputs` 读取已连接输入；无上游结果时明确显示“等待上游输出”。 |
| 生图卡片 | 已实施 | 模型/画幅在上、提示词区弹性伸展、生成按钮锚定正文底部，参考图不再有重复的私有 chip。 |
| 异构批量连接 | 实施中 | 详见 G-05；将以“多条真实端口边的原子计划”而非联合 `any` 输出实现。 |

## 1. 方法与结论

### 方法

1. 在 1708×879 视口为每个左侧“添加节点”入口创建一个独立浏览器上下文；按新增 `data-node-id` 定位卡片，不依赖 tldraw DOM 顺序。
2. 对每个节点保存标题、外置端口、正文、底部色条的截图；记录屏幕尺寸、输入/输出端口数和 body 的横纵溢出。
3. 静态追踪“端口拖拽 → `arrow + binding` → 保存图数据 → 合同输入收集 → 执行器”的真实链路。
4. 执行 `test/node-compliance.test.ts`、`test/connection-matrix.test.ts`、`test/registry.test.ts`、`test/canvas-interaction.test.ts`：**4 文件、167 项通过**。

### 总结

| 结论 | 数量 | 含义 |
| --- | ---: | --- |
| 可创建并有标准 340×260 空态 | 18 | 视觉壳层与端口数符合基础规范。 |
| 因业务内容自动增高 | 5 | 拆分 403px、视频 340px、语音克隆 466px、代码 342px；自动增长存在但策略未统一。 |
| P0 协议 / 关系缺陷 | 2 | 图片、音频资产节点允许无业务意义的同类输入。 |
| P0 几何缺陷 | 1 | 多选自定义虚线框与 tldraw 四角句柄使用两套坐标，造成用户截图中的角点漂移。 |
| P1 统一呈现缺陷 | 23 | 所有节点缺少由真实 edge 派生的统一“已连接输入”视觉层；部分 Body 各自扫描上游。 |

## 2. 全局问题、影响与优化

| ID | 问题 | 影响 | 优化方案 | 优先级 |
| --- | --- | --- | --- | --- |
| G-01 | 多选虚线框由 `GroupOutlineLayer` 按 page→screen + 12px 外扩绘制；四角句柄仍由 tldraw 自己计算，又被 CSS translate。 | 四点与虚线框不同步，缩放、group 嵌套后更明显；用户不能可靠 resize。 | **已修复**：单一 `SelectionGeometry` 产出选框、视觉点与批量柄；原生句柄仅保留命中区。 | P0 |
| G-02 | `image.in-image`、`audio.in-audio` 可连入但执行器不消费或明确跳过。 | 用户以为已建立素材关系，实际下游值不改变；运行与视觉表达互相矛盾。 | **已修复**：两者均为纯素材源；删除无意义输入，图片升至 contract v2、音频升至 v3，并已重新生成 Agent 契约。 | P0 |
| G-03 | 正常创建边会校验契约，但 `deriveGraph` 对导入 / 外部写入的 arrow 不再完整校验。 | 损坏快照可形成“看似存在、视觉层忽略、运行时才失败”的无效边。 | 保存和载入前增加 `validateGraphEdges`，校验节点、方向、端口、类型、Schema、基数和环路；无效边明确标记。 | P1 |
| G-04 | 多个 Body 使用 `gatherUpstream*` 自扫 tldraw arrow；运行器则读 `ContractInputMap`。 | “卡片显示的输入”与“实际运行输入”存在两条路径；无法统一显示来源、名称和顺序。 | **已实施呈现层**：统一摘要从真实 edge + `projectOutputs` 派生，显示来源、端口、many 顺序与等待态；执行器输入收口仍属 P3。 | P1 |
| G-05 | 当前批量连接仅支持同名/同类型/同 Schema 输出。 | 文本 + 图片不能一次连接到生图的不同输入端口。 | **已修复**：`ConnectionPlan` 为每个成员分配声明兼容的目标端口，预检类型/Schema/基数/环路后一次创建多条普通边。 | P1 |
| G-06 | 节点色条、正文 padding、选中态等在 `app.css` 与 `ui-surfaces.css` 多次覆盖。 | 修改某个节点会意外回退公共像素规则，难以截图验收。 | 仅 `ui-foundation.css` 定 token、`ui-surfaces.css` 实现卡片壳；Body 禁止重写壳层几何。 | P1 |
| G-07 | 自动扩高只增不减，且 NodeCardView 与 script Body 各有一套策略。 | 删除内容后卡片留下大空白；不同节点高度/端口变化体验不一致。 | 增加布局测量协议（min/preferred/max、grow/scroll/paginate）；节点配置变化可在安全阈值内收缩。 | P2 |
| G-08 | 视频节点空态检测到 body `scrollWidth > clientWidth`。 | 当前截图未见明显裁切，但窄宽度或语言变长时可能横向溢出。 | 补 280/340/480px 宽度视觉用例，定位溢出子项，所有视频表单项设 `min-width: 0`。 | P2 |

## 3. 节点逐项审查

状态含义：**通过** = 当前空态/端口无异常；**需统一呈现** = 协议本身可用，但没有统一已连接输入视图；**需修复** = 已确认行为与端口语义不一致。

| 节点 | 端口关系 | 现状 / 问题 | 影响 | 优化 |
| --- | --- | --- | --- | --- |
| 文本 | `text(many) → text` | 通过；只显示正文，连接上游后无来源摘要。 | 不知道哪些文本将合并。 | 增加文本来源列表与顺序。 |
| 图片 | `image(one) → image` | **需修复**：输入可连，但 Body/Executor 不消费。 | 假连接。 | 删除 `in-image`，成为纯资产源。 |
| 裁剪 | `image → image` | 空态清楚；已连接源仅在私有读取路径中使用。 | 看不出引用的图片名/来源。 | 统一图片输入卡。 |
| 拆分 | `image → image + list(json)` | 默认即扩到 403px，九宫格可见。 | 自动高策略没有上限/回缩规范；列表输出容易被误当图片。 | 统一动态高度；显示“图片集合/list.items@1”。 |
| 生图 | `images(many) + prompt(json) + text(many) → image` | 模型/画幅/提示词/按钮较挤；参考图仅小 chip。 | 提示词区域不足，连接图片没有名称/来源卡。 | 统一输入预览；提示词弹性；生成按钮底部锚定。 |
| 修改 | `image + text(many) → image` | 工作台入口明确；连接素材不在节点上表达。 | 标注前不易确认用的是哪张原图。 | 图片与文本输入摘要。 |
| 视频 | `images + video refs + audio refs + prompt + text → video` | 默认高度 340px；body 横向溢出；配置密度高。 | 窄卡片易拥挤，参考素材缺来源卡。 | 统一输入摘要、弹性正文、修正溢出。 |
| 取帧 | `video → image` | 空态清楚，详情入口语义准确。 | 已连视频未显示。 | 视频输入卡 + 时间点摘要。 |
| 截取 | `video → video` | 同上。 | 同上。 | 视频输入卡 + 范围摘要。 |
| 提音 | `video → audio` | 同上。 | 同上。 | 视频输入卡 + 输出格式摘要。 |
| 人声分离 | `audio → audio` | 空态清楚，但“快速增强/高质量分离”输出差异容易误读。 | 用户可能认为两种模式输出完全相同。 | 输入音频卡；模式与输出说明同步。 |
| 音频 | `audio(one) → audio` | **需修复**：输入可连，Executor 运行时 skip。 | 假连接。 | 删除 `in-audio`，成为纯资产源。 |
| 配音 | `text(many) → audio` | 表单较完整，空态可读。 | 上游文本与本地文本的合并顺序不可见。 | 文本来源列表；底部运行条。 |
| 语音克隆 | `audio + text(many) → audio` | 自动高 466px；参考音频、正文和参数纵向堆叠。 | 大卡片空态缺少统一收缩策略。 | 输入卡、折叠低频设置、统一动态高度。 |
| 对话 | `text(many) → markdown` | 卡片只作为摘要，主交互在侧栏。 | 选中前看不出上游上下文。 | 紧凑文本输入来源摘要。 |
| 处理 | `any → any` | 配置/固定值混排，类型信息可见。 | 上游实际值/来源不可见。 | 通用值摘要与来源标签。 |
| JSON | `json(many) + text → json` | 空态简洁。 | 多来源 JSON / text 的优先关系不可见。 | Schema 和来源列表。 |
| 结构数据 | `json(many) + text(many) → json` | Schema 选择与编辑提示完整。 | 连接上下文仅在模板文字中提及。 | 显示每个上下文来源与 Schema。 |
| 代码 | `text + json + dynamic → dynamic` | 默认增长到 342px；参数动态改变端口。 | 动态端口/高度不在统一审计内。 | 布局测量协议；参数来源摘要。 |
| 分镜板 | `json + text → json + text` | 空态仍写“脚本节点连入”，但 script 已退役。 | 用户被引导到不可创建的旧节点。 | 改为“连接 JSON / 文本，或输入分镜 JSON”。 |
| AI 处理 | `text + json → text + markdown + json` | 结果/模型信息密集但无显式执行按钮。 | 当前输出模式与实际上游数据不易理解。 | 输入摘要、输出模式说明、统一底部执行入口。 |
| 循环 | `list(json) → iteration + list(json)` | 状态和范围清楚。 | 运行前看不到具体列表来源/Schema。 | 显示 `list.items@1` 来源和项目数。 |
| 3D 预演台 | `storyboard + images + camera → frame/video/camera/project` | 摘要清楚；当前不作为重点功能。 | 参考图、分镜、机位来源不可见。 | 复用输入摘要；导演台本体另立验收。 |

## 4. 关系审查结果

### 已验证成立

- UI 端口拖拽创建 `arrow`、start/end binding 与 `meta.fromPort/toPort`；`DataEdgeLayer` 从这些真实绑定绘制线。
- 执行器按 `fromPort → toPort` 收集、验证类型/Schema/required/cardinality，不按节点标题或类型猜测。
- `test/connection-matrix.test.ts` 覆盖 120 项连接兼容矩阵；类型/Schema/基数/环路的核心门禁通过。
- DataEdgeLayer 使用 `getShapePageBounds()`，分组后的边仍按页面绝对坐标计算。

### 仍需补足

1. 保存后重开，逐边比较 nodeId/portId 的 round-trip 端到端测试；
2. 外部损坏 arrow 的保存前/载入前 `validateGraphEdges`；
3. 同构多选、异构选择计划、单值冲突与环路的原子性测试；
4. 所有节点“连接输入态”的截图门禁；
5. 失败运行时不得把过期 `nodeResult` 当作可用输入的测试。

## 6. 本轮验收记录

| 验收项 | 结果 |
| --- | --- |
| 23 个 Active 节点空态截图 | 23/23 完成，复测报告记录为零 body 溢出。 |
| 节点协议、执行器、连线矩阵、画布交互与新增关系测试 | 8 个目标文件、300 项通过。 |
| 浏览器端到端画布验收 | 通过：导入图片、裁剪/拆分、模型生成、端口拖拽、分组后连线、缩放、浅色检查器、持久化刷新等。 |
| 工程全量门禁 | `npm run verify` 通过：75 个测试文件、939 项测试，TypeScript 与 Electron 构建通过。 |
| Agent 契约 | 已运行 `npm run agent:generate`，`generated/agent-contracts.json` 已同步图片/音频的破坏性契约升级。 |

> ESLint 仍输出 12 条既有 Prettier 警告（无 error）；本轮新增审查脚本已单独通过 ESLint，且 `git diff --check` 通过。

## 5. 本轮实施顺序

1. **P0（已完成）**：修复选框几何；删除图片/音频无意义输入并 bump 契约版本。
2. **P1（本轮完成）**：统一 `ConnectedInputPresentation`，覆盖 image/text/json/audio/video；重排生图卡片；实现异构 `ConnectionPlan`。
3. **P2**：统一自动高度 / 溢出策略；修正分镜板 legacy 文案、视频窄宽溢出、生成型节点操作栏。
4. **P3**：每节点空态、连接态、运行中、成功、失败、动态内容状态截图；桌面真实媒体和保存重开验收。
