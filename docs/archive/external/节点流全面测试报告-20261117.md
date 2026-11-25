# 节点流（Composite）全面测试报告 · 2026-11-17

日期：2026-11-17 · 基线：5c94f1c（并行循环项隔离 + 泳道预铺 + R-22 修复）
方法：全量既有回归（vitest）+ 新增 83 项流矩阵（引擎级 mock-editor 全链）+ 真实 Electron 桌面验收（CLI+MCP）+ 真实 FFmpeg 媒体链 + GUI 验收
结论：**发现并修复 1 个阻断级真机回归（11-16 引入）；修复后 L2 83/83 + L3 桌面 22/22 全过。**

---

## 一、总览

| 层级 | 范围 | 结果 |
|---|---|---|
| P1 既有回归 | 全量 vitest（约 100 文件） | ✅ 修复前后均全绿 |
| P2-A 单节点冒烟 | 29 例（33 类活跃节点含桩/真机） | ✅ 全过 |
| P2-B 基础拓扑 | 8 例（线性/扇出/扇入/菱形/长链/子图/手动复用） | ✅ 全过 |
| P2-C 失败/跳过语义 | 7 例 | ✅ 全过 |
| P2-D 循环 iterate | 15 例（并发 1/2/4、skip/fail 策略、resume、typed 注入、20 项批量） | ✅ 全过 |
| P2-F 模型组合链 | 7 例（桩网关事件序） | ✅ 全过 |
| P2-G 本地媒体 | 5 例（**真实 FFmpeg** 全链 + ffprobe 复核） | ✅ 全过 |
| P2-H 特殊宿主 | human-task 停等/状态机迁移与去重 | ✅ 全过 |
| P2-J 持久化 | 终态字段/历史追加/循环体指纹 | ✅ 全过 |
| P2-E composite | L3 桌面验收 22 项（真实 Electron+CLI+MCP） | ✅ 修复后 22/22 |
| P3 失败诊断 | L3 真机失败定位到根因 | ✅ 已修复 |
| P4 L4 GUI 验收 | composite GUI 13 项 | ✅ 全过（见 §五） |

**新增测试资产**（共 83 项，全部通过）：
- `test/helpers/flowHarness.ts` — 共享 mock-editor/桩网关/桩模型目录/媒体信封 harness
- `test/flow-matrix-basic.test.ts`（A/B/C 47）· `test/flow-matrix-iterate.test.ts`（D 15）· `test/flow-matrix-media.test.ts`（G 5）· `test/flow-matrix-model-host.test.ts`（F/H/J 13）
- `test/artifact-recipe-skip.test.ts`（回归修复单测 3）

## 二、发现的问题与修复

### 问题 1（阻断级，真机）：媒体资产节点流全挂 ——「生成来源保存失败；素材已保留，请勿重复生成」

- **发现通道**：真实 Electron 桌面验收（`composite-desktop-acceptance.cjs`）第 17 项；16 项过后失败，`run.wait state=failed`。
- **现象**：composite 内含图片资产节点（mediaRef 引用形态）运行必失败；错误文案误导（「素材已保留，请勿重复生成」实际是来源落库失败，不是生成失败）。
- **根因链**（文件:行号）：
  1. `e706bb2`（11-16「节点流保存只登记到库 + 公开媒体产物落画布为资产节点」）给 composite 执行器新增公开媒体产物 `ctx.emitArtifact`（`src/shared/engine/executors/composite.ts:167-174`）——引用形态产物也会被送入；
  2. `emitArtifact` 绑定链把 `saveArtifactRecipe` 失败映射为 `false` 并**硬失败整个节点**（`src/renderer/src/engine/executor.ts:1054-1056` `.then(saved => saved.ok, () => false)` + `:1129-1130` throw）；
  3. `saveArtifactRecipe` 要求 media 表有该资产行（`src/main/store/artifact-recipes.repo.ts:10-13`）——发布快照 mediaRef / headless 直写素材**本来就不在 media 表**（本次运行并未生成它），必 throw；
  4. → 引用形态媒体产物 composite 运行 100% 失败。11-12 全绿报告之后由 e706bb2 引入，属**回归**。
- **修复**（本次提交）：
  - `src/main/store/artifact-recipes.repo.ts`：media 表无此资产 → 返回 `skipped` 跳过落库（无生成来源可记，不拒跑）；media 存在但路径不属于本项目 → 保留 throw（完整性守卫不放宽）；
  - `src/main/ipc/media.ipc.ts`：`skipped` 发新诊断事件 `artifact.recipe_skipped`（如实记录，不误报 saved/failed）；
  - `docs/LOGGING_COVERAGE.md`：登记新事件与验证证据；
  - `test/artifact-recipe-skip.test.ts`：3 项回归单测（无行 skipped / 本项目 saved / 跨项目拒绝）。
- **修复验证**：单测 3/3 ✅；L3 桌面验收重跑 **22/22 ok=true** ✅（原失败项「CLI 媒体资产节点流运行」恢复通过）。

### 问题 2（既有已知，非本次回归，维持现状记录）

- chat 有待发消息仍弹补输入（可选可跳过，不阻断）——`运行补输入-全节点测试计划.md` 已裁决保留；
- video/voice-design/tts/audio/file/video-asset 不弹素材/模型补输入窗（设计如此）；
- video-depth / video-clay 依赖本地 Python+Torch 推理引擎：本机未安装（环境受限），本次以桩验证「引擎未安装时诚实 failed 且原因可读、不挂死」；真实转换链路留待装机后专项验收；
- SQLite 依赖的测试必须经 `scripts/run-vitest.cjs`（Electron-as-Node）运行——环境限制，非缺陷。

## 三、逐族要点（关键断言摘录）

- **A 冒烟**：33 类活跃节点逐一最小运行——纯逻辑类 done/skipped/failed 均按契约诚实落终态；模型类走桩网关事件序（chatStart→delta→done）验证管线；ai-process 空输入诚实 skipped「没有输入文本或 JSON」；image-gen 无提示词 skipped；tts 缺参考语音 skipped；必填端口未连 → 契约层显式 failed(phase=input)。
- **B 拓扑**：10 节点长链全成功；单源扇出三分支独立；connectOrder 决定多入度取值顺序；框选子图自动带上游闭包且不误跑旁观节点；手动单跑复用上游已持久化输出（不重跑）。
- **C 语义**：上游 failed/skipped → 下游显式 failed(phase=input)、不静默复用旧输出（outputs.delete）；一坏一好分支互不拖累；R-17 数字改型（1e3）与 R-15 占位符缺失均显式失败。
- **D 循环**：3/5/20 项 × 并发 1/2 全部完成且分项输出按项隔离（影子编辑器）；onFailure skip 中间项失败不拖死整体、fail 首败即停；resume 只补失败项；空列表 0 项成功；未配置循环体诚实 skipped；typed 列表项注入 image 端口驱动 image-crop 成功；循环体模板卡不重复执行（runId 含 `:item:`）。
- **F 模型链**：text→ai-process→text、image-gen→image-edit、video→video-frame、voice-design→speech（音色档案注入验证 voiceId 透传）、json 模式产出、网关 429 结构化透传、R-22 推理模型思考回退——全部贯通。
- **G 真实 FFmpeg**：image→crop→split（产物≥3 文件）、抽帧 PNG、截取 1s（ffprobe 复核时长 ±200ms）、声音调整、时间线 2 视频+1 音频合成（总时长 ±500ms）——主进程真实处理器全链验证。
- **H 宿主**：human-task 停等→人工提交（pending+expectedRevision）→续跑 done；状态机 draft→published、revision 单调、重复事件提交被拒。
- **J 持久化**：终态字段完整（nodeRun/finishedAt/durationMs/nodeRunHistory/nodeResult）；重跑追加历史；iterate 结果带循环体指纹（resume 校验基准）。
- **E composite（L3 真机）**：发布不可变版本/冲突后服务可用、插入运行真实输出、失败定位 output 阶段、升级兼容/阻断、引用形态、递归/深度/预算三守卫、引用保护、归档恢复、MCP 四操作——22/22。

## 四、与 2026-11-12 报告的差异（回归判定）

| 项 | 11-12 | 本次 |
|---|---|---|
| 桌面 composite 验收 22 项 | ✅ | ❌→✅（发现 e706bb2 回归并修复后恢复） |
| 运行补输入矩阵 | ✅ 108 | ✅（既有用例随全量回归通过） |
| 循环并发/影子隔离 | 未覆盖（当时未实现） | ✅ 新增 15 项专项覆盖 |
| 真实 FFmpeg 全链 | 部分既有 | ✅ 新增 5 项引擎级全链 |
| R-22 推理回退 | 未覆盖 | ✅ F7 验证通过 |

## 五、L4 GUI 验收（修复后重跑）

`composite-gui-acceptance.cjs`（Playwright 驱动真实 Electron）：**13 项全过，ok=true**——画布就绪、palette 添加/双击编辑、右键封装发布 1.0、运行实例、编辑草稿保存/恢复、发布 2.0 预览与确认、旧实例版本隔离、拖线封装外层、不兼容升级阻断、右键升级引用形态、保存/取消语义。

## 六、二次验证汇总（修复后）

| 门 | 结果 |
|---|---|
| typecheck（tsc -p） | ✅ EXIT=0 |
| eslint（改动文件） | ✅ 0 errors（prettier 已 --fix） |
| 全量 vitest | ✅ 326 文件 / 3668 测试全过（含新增 83 项），EXIT=0 |
| L3 composite 桌面验收 | ✅ 22/22 ok=true |
| L4 composite GUI 验收 | ✅ ok=true（13 项） |

## 七、证据文件

- 首轮 L3 失败日志：`temp-l3-composite-desktop.log`（ok=false，第 17 项 MEDIA_RUN_FAILED）
- 修复后 L3：`temp-l3-composite-desktop-v2.log`（ok=true，22 checks）
- 修复后 L4：`temp-l4-composite-gui.log`（ok=true）
- 全量回归：`temp-p1-full-test.log` / `temp-p1-full-test-v2.log`
- 测试源码：`source/test/flow-matrix-*.test.ts`、`source/test/artifact-recipe-skip.test.ts`、`source/test/helpers/flowHarness.ts`

## 八、结论与建议

1. **节点流当前可正常跑通**：33 类节点冒烟、10 族组合流、循环并发、composite 生命周期（真机 22 项）全部验证通过。
2. 本次唯一阻断问题（引用形态媒体产物）已修复并有回归测试把守；建议后续把 `composite-desktop-acceptance.cjs` 纳入常规提交门禁，避免 11-16 这类「单点提交破坏既有链路」再次静默合入。
3. 待办（非阻断）：video-depth/clay 装机后专项验收；`chat` 补输入过度弹窗按既有裁决维持观察。
