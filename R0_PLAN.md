# R0 发布基线与回归保护：开发计划与测试计划

> 制定日期：2026-08-27
> **状态：✅ 已完成（2026-08-27）。WP1-WP5 全部落地；T1-T9 共 9 个测试文件、全套 421 用例通过。剩余事项：发布前按 [docs/REGRESSION.md](./docs/REGRESSION.md) 全表人工回归留档 + 全新 Windows 用户目录安装冒烟（REGRESSION.md §6）。**
> 依据：[ROADMAP.md](./ROADMAP.md) R0 定义、[NODE_CONTRACT_SPEC.md](./NODE_CONTRACT_SPEC.md)、当前 main 分支（b3a33cc）代码实况。
> 范围：R0 五项任务全部落地，含配套测试。不含 R3/R4 的角色/场景/镜头 Schema（另行规划）。

## 1. R0 要解决什么

R1-R7 主体已完成后，当前代码有四类会在发布时暴露的问题，R0 逐一对症：

| 问题 | 代码证据 | 后果 |
| --- | --- | --- |
| 运行错误只存在内存 | `engine/store.ts:11-20` 的 `RunError` 仅进渲染进程 store；主进程虽有 `electron-log`（`main/index.ts:14`），但渲染进程没有任何错误上报通道 | 重启后错误全部丢失，用户报障时无据可查 |
| 旧项目静默降级 | `canvas/graph.ts:307-331` `deriveGraph` 遇到未知 `nodeType` 产出空端口节点并照常持久化；未知 `portId` 的边在 `createEdge`（graph.ts:135-146）静默返回 false | 升级或回滚版本后，坏数据被无提示写入 project.json，越存越坏 |
| 手动按钮与全局运行双轨 | 10 处卡片内按钮绕过执行器直调 `window.api.gateway.*`（详见 §3 WP3 排查表） | 手动路径不做契约校验、不登记输出、不写运行错误、无取消信号 |
| 回归全靠手感和记忆 | 迁移逻辑内嵌在 `CanvasEditor.tsx:530-626` 的 `handleMount` 中，无测试；无示例项目、无统一回归表 | 每次改动后无法系统性验证未破坏既有节点 |

R0 完成标准（沿用 ROADMAP 原文，验收映射见 §6）：

1. 旧项目可以打开、保存并再次打开。
2. 任意错误连线都能在创建时或运行时得到具体端口级错误。
3. 所有现有节点通过统一回归表。
4. 发布包在全新 Windows 用户目录可启动。

## 2. 总体安排

五个工作包（WP），合计约 5-8 人日：

```text
WP1 错误日志落盘 ──┐
                   ├─→ WP3 手动触发一致性 ──→ WP5 回归表与发布检查
WP2 旧快照迁移   ──┘            WP4 示例项目（随时可插入，建议在 WP5 前）
```

- WP1 与 WP2 相互独立，可并行开工。
- WP3 依赖 WP1 的错误上报通道（手动路径也要写日志）；3.1 的入口设计可与 WP1 并行。
- WP4 独立，越早建好越能为 WP5 的人工回归提供固定底稿。
- WP5 收尾，产出回归表与发布清单，并回写 ROADMAP/HANDOFF 状态。

## 3. 工作包明细

### WP1 运行错误日志落盘（对应 ROADMAP 任务 4）

**现状**：`RunError` 已含 `nodeId/phase/timestamp`（store.ts:11-20），但 UI 未消费 `nodeId`（CanvasPage.tsx:220-249 只显示 label/reason/phase/时间）；拓扑环错误只 toast 不进 store（executor.ts:256）；错误消息可能携带服务端响应体片段（`main/gateway/factory.ts:75-79` 拼接 `body.slice(0,180)`）与含 baseURL 的 URL（`gateway/video.ts:135`、`gateway/audio.ts:38`）；渲染进程无 `window.onerror`/`unhandledrejection`/ErrorBoundary 兜底。

**设计**：

- 日志走既有 `electron-log`，新增专用 IPC 通道，落盘到 `%APPDATA%/canvas-studio/logs/`，按天滚动、保留 14 天。
- 脱敏在两处设防：`addError` 入口统一过一遍 `sanitizeRunError()`；主进程写盘前再过一遍（防止未来新增调用方绕过）。
- `RunError` 扩展字段：`portId?`、`contractVersion?`、`nodeType?`、`runId?`（区分每次全局运行）。

**任务**：

1. `shared/contracts` 新增 `log.write` 通道与 `RunLogEntry` 信封类型；`preload/index.ts` 暴露 `window.api.log.write`。
2. 新建 `src/main/ipc/log.ipc.ts`：接收信封 → `sanitizeRunError` → electron-log 落盘。
3. 新建纯函数 `sanitizeRunError()`（建议放 `shared/`，双进程可用）：正则剔除 `Bearer xxx`、`sk-`/`api[-_]?key` 形态 token、Authorization 头；URL 只保留协议+域名，去 path 与 query；reason 截断 500 字符。
4. `engine/store.ts`：`addError` 补齐新字段并透传 `window.api.log.write`（fire-and-forget，失败不抛）。
5. `engine/executor.ts` 错误构造点补字段：输入/输出契约校验失败附 `portId` 与 `contractVersion`；拓扑环错误同时进 store（不再只 toast）；catch 分支透传 phase。
6. 渲染进程兜底：`main.tsx` 挂 `window.onerror` + `unhandledrejection` 监听；画布外层包一层 ErrorBoundary；三处现有 `console.error`（CanvasEditor.tsx:523、CanvasSidePanel.tsx:544）改走上报。
7. UI 增强：错误面板展示端口与契约版本；条目点击可定位画布节点（读 `nodeId`，调用 editor 选中并居中）。

**验收**：

- 制造"断网跑生图"错误后，日志文件中出现完整条目（时间、runId、节点名、nodeId、portId、phase、reason），且全文检索不到 API Key。
- 应用崩溃（React 渲染异常）时日志文件同样有记录。

工作量：1-1.5 人日。

### WP2 旧项目契约迁移入口与未知端口提示（对应 ROADMAP 任务 2）

**现状**：四段迁移逻辑内嵌在 `CanvasEditor.tsx` `handleMount`（image→image-gen 迁移 530-559、compose 退役 561-570、group 退役 570-588、原生 tldraw 图片转节点 591-626），全部无测试；`deriveGraph` 对未知 nodeType/portId 静默处理；工作流模板端口恢复（CanvasSidePanel.tsx:309-374）已有"唯一可推断/含糊跳过+提示"逻辑，保持不变。

**设计原则**：不静默猜测，也不静默删数据。未知内容**保留原样 + 冻结 + 显式警告**，由用户决定删除或修复。

**任务**：

1. 抽取纯函数模块 `src/renderer/src/nodes/migrations/legacy.ts`：把 handleMount 内四段迁移改造为输入 shape 数组、输出 `{shapes, warnings}` 的纯函数（group 迁移输出分组指令而非直接调 editor）。
2. 新建 `inspectProjectFile(file): ProjectWarning[]`：检测未知 `nodeType`、边引用不存在的 `portId`、节点 `contractVersion` 高于当前注册表、`ProjectFile.version` 非 v1。打开项目时在恢复画布前调用。
3. `deriveGraph` 增加 `unknownPorts` 收集：未知端口的边保留在数据中，但标记 `meta.flagged = 'unknown-port'`；运行器遇到 flagged 边的目标节点时给出端口级错误并跳过，不静默使用旧值。
4. 未知 nodeType 节点的卡片渲染为冻结占位（显示原始类型名 + "来自更高版本或已移除的节点"提示），不参与运行，右键可删除。
5. 打开项目时的警告呈现：项目页 toast 汇总 + 画布顶部可展开警告条，逐条列出节点名、端口、原因与建议操作。
6. `CanvasEditor.handleMount` 改为编排 `legacy.ts` 与 `inspectProjectFile` 的结果，handleMount 本体回归"恢复 + 应用迁移指令"。

**验收**：

- 构造含未知 nodeType、未知 portId、高版本 contractVersion 的 fixture 项目：打开有完整警告，画布不丢数据，保存后重开警告不重复膨胀（已警告项带标记）。
- 现有真实旧项目（含 compose/group/image 历史节点）打开、保存、重开行为不变。

工作量：1.5-2 人日。

### WP3 手动触发与全局运行一致性（对应 ROADMAP 任务 3）

**现状排查结果**（10 处绕过执行器的按钮）：

| 类别 | 按钮 | 位置 | 问题 |
| --- | --- | --- | --- |
| 生成类 | 生图-生成图片 | bodies/image-gen.tsx:69-99 | 直调 `imageGenerate` 写 props，无契约校验、无输出登记、无取消 |
| 生成类 | 视频-生成/取消/重新生成 | bodies/video.tsx:135-164、186-202 | 任务生命周期自管，绕过 `videoExecutor` |
| 生成类 | 音频-生成语音 | bodies/audio.tsx:137-166 | 绕过 `audioExecutor` |
| 生成类 | 分镜-单镜头/全部生图 | bodies/storyboard.tsx:155-211 | 直调 `imageGenerate` 写镜头字段 |
| 导入类 | 图片-导入、音频-上传 | bodies/image.tsx:16-33、audio.tsx:90-107 | 资产编辑，直写 props |
| 辅助类 | 脚本-AI 拆解、代码-AI 生成、文本-生成N图 | bodies/script.tsx:284-325、code.tsx:253-287、text.tsx:30-67 | 配置编辑辅助，非运行路径 |

**分类处置**（需确认的决策点见 §5）：

- **生成类收敛**：新增统一入口 `runNodeManually(editor, nodeId)`，复用 `executeNodeOnce` 的完整链路（拓扑内收集该节点输入 → 契约校验 → 调执行器 → `projectNodeOutputs` 投影 → 登记 → 写运行错误）。Body 中重复的直调逻辑删除，按钮改为调用该入口。执行器已具备所需能力（imageGen 执行器含 seed/复用/来源记录，video 执行器含任务等待与取消，audio 执行器含异常分类）。
- **导入类保持**：资产导入写 props 后，`projectNodeOutputs` 投影天然一致，全局运行会重新投影，不存在双轨风险。仅在一致性矩阵中文档化。
- **辅助类不收敛**：AI 拆解/AI 生成代码改写的是节点配置（prompt、代码源码），语义上是"编辑"，不是"运行"。文档化为非运行入口，避免把编辑动作塞进执行器。

**任务**：

1. `engine/executor.ts` 导出 `runNodeManually(editor, projectId, nodeId)`：内部复用 `executeNodeOnce`，手动与全局共用同一条投影与错误路径。
2. 改造 image-gen Body：生成按钮 → `runNodeManually`；"重新生成"保留清空逻辑（与 R5 既有交互一致），清空后仍由用户手动或全局运行触发。
3. 改造 video Body：生成走执行器；"取消任务"对接 `CancelSignal`；轮询与事件监听逻辑随执行器收敛。
4. 改造 audio Body：生成走执行器。
5. 分镜生图核实后处置：若镜头级生图属于卡片内部编辑（写镜头字段而非端口输出），归类为导入类文档化；若与生图节点输出重叠，收敛到执行器。实现前先验证（见 §5 决策点 4）。
6. 产出 `docs/CONSISTENCY_MATRIX.md`：13 个节点 ×（手动入口 | 是否复用执行器 | 输出投影 | 取消 | 错误路径）矩阵，作为后续新增按钮的对照基线。

**验收**：

- 同一张图，手动单独运行某节点与全局运行该节点，产出的端口输出与持久化 props 完全一致（自动化断言，见测试计划 T5）。
- 手动触发失败时，错误进入诊断面板与日志文件（与全局运行同一条 `addError` 路径）。

工作量：2-3 人日（最大的工作包，生成类逐节点改造 + 回归）。

### WP4 可回归示例项目（对应 ROADMAP 任务 5）

**任务**：

1. 在应用内手工搭建示例项目，覆盖四条链路：文本→生图、文本→对话→JSON、JSON→分镜、处理→代码；另加一条 迭代→生图 批处理链路作为 R4 能力的回归样本。媒体使用小体积占位文件。
2. 通过既有导出能力生成 `resources/demo/canvas-studio-demo.canvasbundle`（R7 已实现自包含 zip 导出）。
3. 项目列表新增"打开示例项目"入口：每次导入为带新 id 的副本，不污染 fixture。
4. 自动化校验：测试解析 bundle，断言包含必需节点类型、四条链路连通、媒体文件存在（见测试计划 T9）。

**验收**：任何机器上"打开示例项目"后，四条链路在配置好供应商的情况下可一键运行；未配置供应商时链路给出明确的缺模型提示。

工作量：0.5-1 人日。

### WP5 节点回归表与发布检查（对应 ROADMAP 任务 1 + 完成标准 3/4）

**任务**：

1. 新建 `docs/REGRESSION.md`：13 个节点 × 9 项操作（创建、编辑、拖动、复制、删除、连接、运行、保存、恢复）矩阵，每格写明预期行为；以 WP4 示例项目为固定底稿。
2. 把 HANDOFF §13 发布检查清单与回归表合并引用：发布流程改为"清单 + REGRESSION.md 全量过一遍"。
3. 全新环境冒烟：`pnpm build:win` 后在全新 Windows 用户目录（干净虚拟机或新建本地用户）安装启动，验证 `%APPDATA%/canvas-studio/data/` 自动创建、示例项目可打开。
4. 回写状态：更新 ROADMAP.md R0 各任务勾选、HANDOFF.md"当前已知问题"与"推荐的下一项工作"。

**验收**：REGRESSION.md 全表通过并留档（版本号 + 日期 + 执行人），发布包冒烟记录附入。

工作量：0.5-1 人日。

## 4. 实施顺序建议

按周排（单人节奏，可压缩）：

| 阶段 | 内容 | 产出 |
| --- | --- | --- |
| 第 1 段 | WP1 全部 + WP2 任务 1-2（迁移纯函数化 + inspect） | 日志链路可用；旧逻辑获得测试保护 |
| 第 2 段 | WP2 任务 3-6 + WP3 任务 1（runNodeManually 设计与实现） | 未知内容显式化；手动运行入口就绪 |
| 第 3 段 | WP3 任务 2-6（逐节点改造 + 一致性矩阵）+ 同步补 T5 测试 | 双轨消除 |
| 第 4 段 | WP4 + WP5，最后统一跑 §5 测试计划全量 | 回归表、示例项目、发布冒烟、文档回写 |

每段收尾跑一次 `pnpm typecheck && pnpm lint && pnpm test && pnpm build`，保持 CI 绿色，不攒到最后。

## 5. 测试计划

四层：单元（进 CI）、跨进程（进 CI）、人工回归（发布前）、错误注入（发布前）。

### 5.1 单元测试（vitest，node 环境，新增文件）

| 编号 | 文件 | 覆盖内容 | 对应 WP |
| --- | --- | --- | --- |
| T1 | `test/sanitize.test.ts` | `sanitizeRunError` 真值表：Bearer/sk-/api_key token 剔除、URL 只留协议+域名、超长截断、中文与多行错误保留 | WP1 |
| T2 | `test/run-error.test.ts` | 错误构造纯函数：各阶段（input/execution/output/topo）产出字段齐全（nodeId/portId/contractVersion/runId）；拓扑环错误进 store 不再只 toast | WP1 |
| T3 | `test/legacy-migrations.test.ts` | 四段迁移输入输出真值表：image→image-gen（有无 prompt 两分支）、compose 删除、group 输出分组指令、原生 tldraw 图片转节点；迁移幂等（二次运行不再变更） | WP2 |
| T4 | `test/project-inspect.test.ts` | `inspectProjectFile`：未知 nodeType / 未知 portId / 高 contractVersion / 非 v1 文件 / 正常文件 五类输入的警告断言；不修改原数据 | WP2 |
| T5 | `test/manual-run.test.ts` | 同图同节点：`runNodeManually` 与 `runWorkflow` 的输出投影、持久化 props 逐字段一致（沿用 executors.test.ts 的 fake editor 模式）；手动失败走同一错误路径 | WP3 |
| T6 | `test/graph-unknown-ports.test.ts` | `deriveGraph` 对未知端口边产出 flagged 标记与警告；flagged 边不参与运行、运行时报端口级错误 | WP2 |

### 5.2 跨进程与主进程测试（vitest，node 环境，新增文件）

| 编号 | 文件 | 覆盖内容 | 对应 WP |
| --- | --- | --- | --- |
| T7 | `test/projects-repo.test.ts` | 临时目录中 `saveProject` 原子写（.tmp→.bak→rename）、`graphVersion` 递增、损坏时 .bak 回退、open→save→open roundtrip。此项同时补上 ROADMAP R2 遗留的"主进程项目读写与 graphVersion 测试" | 基线保护 |
| T8 | `test/log-ipc.test.ts` | log handler 收到含假 Key 的错误 → electron-log mock 捕获的写入内容不含 Key；信封字段完整 | WP1 |
| T9 | `test/demo-bundle.test.ts` | 示例 bundle 可解析；含四条链路的节点与边；媒体文件存在且引用一致 | WP4 |

### 5.3 人工回归（发布前，按 docs/REGRESSION.md 执行）

固定底稿为 WP4 示例项目，矩阵：13 节点 × 9 操作。重点行为断言（均已在 HANDOFF §7/§13 列出，此处为执行口径）：

- 单值端口拒绝第二个上游；Schema 不兼容连线在创建时被拒并给出端口级原因。
- 节点删除时关联连线同步消失；分组移动、撤销、重做正常。
- 文本节点双击编辑、图片粘贴/拖入成节点、对话 Markdown 渲染。
- 旧项目（含 compose/group/image 历史节点）打开→保存→重开，内容与警告符合预期。
- 迭代节点 20 项批处理：并发、限数、单项失败不影响已完成项、中止后重跑复用已完成项。

### 5.4 错误注入场景（发布前，人工）

| 场景 | 操作 | 预期 |
| --- | --- | --- |
| 断网生成 | 断网后手动与全局各跑一次生图 | 面板与日志文件均有记录，reason 含 HTTP 状态，不含 Key |
| 坏 Schema | AI 处理选 storyboard.shots 输出，喂非法 JSON | 执行器报 Schema 不符，错误带 portId 与 Schema 名 |
| 循环连线 | 构建 A→B→A | 运行前报循环错误，进面板与日志（不再只 toast） |
| 旧版本数据 | 打开含高版本 contractVersion 节点的 fixture | 冻结占位 + 警告，不崩、不静默改写 |
| 渲染崩溃 | 开发模式注入渲染异常 | ErrorBoundary 拦截，日志有记录，应用不白屏 |

### 5.5 CI

新增测试文件自动纳入现有 `ci.yml` 的 `pnpm test` 步骤，无需改工作流。人工回归与错误注入不进 CI，由发布流程引用 REGRESSION.md 执行留档。

## 6. 验收标准映射

| ROADMAP R0 完成标准 | 由谁达成 | 证据 |
| --- | --- | --- |
| 旧项目可以打开、保存并再次打开 | WP2 | T3/T4/T7 通过 + §5.3 旧项目人工回归记录 |
| 任意错误连线都能得到具体端口级错误 | WP1 + WP2 | T2/T6 通过 + §5.4 坏 Schema/循环连线场景 |
| 所有现有节点通过统一回归表 | WP5 | REGRESSION.md 全表留档（版本+日期+执行人） |
| 发布包在全新 Windows 用户目录可启动 | WP5 | 干净环境冒烟记录 |

## 7. 风险与决策点

实现前需要确认的四个决策：

1. **日志内容边界**：reason 截断 500 字符、URL 只留域名是否够用？若排障需要 path，可改为保留 path 去除 query（Key 常在 query）。
2. **未知端口边的处置**：本计划选择"保留 + 冻结 + 警告"而非自动删除，符合"不静默猜测"；若倾向自动清理需改验收口径。
3. **辅助类按钮不收敛**：脚本 AI 拆解、代码 AI 生成、文本生成N图按"编辑辅助"保留直调。若希望全部收敛，WP3 工作量约 +1 人日。
4. **分镜镜头级生图归类**：实现 WP3 前需核实镜头生图写入的是卡片内部字段还是端口输出（R5 曾将分镜生图改为独立资产节点引用），再决定收敛或文档化。

其他风险：

- WP3 改造 video Body 涉及异步任务生命周期迁移，是回归风险最高的一处；先写 T5 一致性测试再动 Body。
- `legacy.ts` 抽取必须保持行为等价（纯移动 + 注入 editor 指令），与 R6 bodies 拆分同一纪律，完成后以 T3 + 旧项目人工回归双保险。
- 日志 IPC 为 fire-and-forget，需确认 electron-log 在渲染进程崩溃前的写入时机（兜底：主进程兜底捕获 + beforeunload 前补写错误队列暂不做，留观察）。
