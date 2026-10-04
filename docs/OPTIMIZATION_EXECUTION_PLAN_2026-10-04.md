# Canvas Studio 优化执行计划 v1.0

- 编制日期：2026-10-04。依据：《Canvas-Studio-项目审查与优化方案-2026-10-04》（下称"审查报告"）第一至四部分。
- 源码基线：`main@d39eb5d` + F19 修复（见 §0.2）。
- 性质：**可执行、可验证的施工计划**。每个任务给出：改动落点（文件/函数）、实施步骤、测试规格（文件 + 用例名）、验证命令、完成标准（DoD）、风险与回退。审查报告中的 M0–M5/T01–T16/A01–A15 编号全部沿用。
- 使用方式：按 §10 依赖图顺序执行；每任务开工前把 §1.4 任务记录建到 `docs/optimization-ledger.md`；完成一项勾一项，验收证据（测试输出、截图、命令回显）存 `qa/optimization-<任务号>/`。

---

## 0. 基线与事实核验

### 0.1 审查发现抽查核验（2026-10-04，对照 `d39eb5d` 源码）

| 编号 | 核验结论 | 证据（本轮复核） |
|---|---|---|
| F01 | **属实** | `CanvasEditor.tsx` beforeunload 处理：冲突时 `saveProjectSync({ ...input, expectedGraphVersion: undefined })` 无锁覆盖，结果不检查；关窗失败仅 console |
| F02 | **属实** | `CanvasSidePanel.tsx` 恢复路径直接 migrate + loadStoreSnapshot，无预备份/媒体预检 |
| F03 | **属实** | `ProjectCreateDialog.tsx:42-56` 首层即渲染全部节点勾选（`nodeTypes = allNodeTypes()`） |
| F05 | **属实** | `SearchPalette.tsx:137` 输入框 `onKeyDown` 对所有键 `stopPropagation()`，Esc 到不了 window 关闭监听（:44） |
| F06 | **属实** | `node-readiness.ts:64-85` 仅按必填端口连线计数判定；空提示词/上游无输出/模型未绑定时仍返回"可运行" |
| F16 | **属实** | `browserMock.ts:540` `as unknown as typeof window.api` 掩盖 models 接口缺失 |
| F19 | **属实并已修复** | `CanvasEditor.tsx` 捕获注册 `addEventListener('wheel', onWheel, {capture:true,passive:true})` 与移除 `removeEventListener('wheel', onWheel)` 不匹配 |
| F04/F07/F08/F09/F10/F11/F12/F13/F14/F15/F17/F18 | 未逐条重验，采信审查报告证据等级（A/B）；各任务开工首日先按其 file:line 复核一次再动手 | — |

### 0.2 已完成的前置修复（本计划编制时）

- **F19**：`CanvasEditor.tsx` 相机交互监听移除补 `capture: true`。验证：typecheck 通过。行为验证纳入 T15 回归（进入/离开画布 ≥5 次后 `getEventListeners(window).wheel` 不增长——DevTools 手册步骤见 §7.3）。

### 0.3 版本与环境基线

- 执行期间冻结验证环境：Windows 主机、Node/pnpm/Electron 以 `pnpm -v && node -v` 记录进 ledger；每任务验收记录提交哈希。
- **M0 起每次验收前固定命令**：`git rev-parse HEAD && pnpm run lint && pnpm run typecheck && pnpm run typecheck:model && pnpm run test && pnpm run test:model`（下称"全量门禁"）。

---

## 1. 执行框架（所有任务共用）

### 1.1 任务状态机

`待确认 → 已复现/已界定 → 方案明确 → 实现中 → 验收通过 → 已交付`

- "已复现"要求：有失败测试、截图或命令回显证明问题当前存在（F 类任务开工第一步）。
- "验收通过"与"代码已写"分开记录；模型链的"模拟通过"与"真实调用通过"分开。

### 1.2 提交粒度

- 一次提交 = 一个用户可见行为变化（或一个纯技术重构）；保存/迁移类与视觉调整分开。
- 提交信息模板：`fix(save): T04 串行保存队列（F01）——验收 A07 通过`。

### 1.3 验证层级

| 层 | 工具 | 用途 |
|---|---|---|
| L1 单元/契约 | vitest（`test/*.test.ts`） | 状态机、纯函数、契约不变 |
| L2 行为（jsdom+Editor mock） | vitest + tldraw Editor mock（`test/manual-run.test.ts` 模式） | 保存/恢复/运行计划的行为 |
| L3 浏览器脚本 | `qa/optimization-*/` 下 `.cjs` + dev:browser | 键盘、焦点、弹层、状态呈现 |
| L4 桌面 Electron | 隔离 `CANVAS_DATA_DIR` + `--remote-debugging-port` | 保存握手、重启恢复、故障注入 |

### 1.4 任务记录模板（`docs/optimization-ledger.md` 逐任务一行起）

```text
任务号/关联发现/依赖：
状态/负责人/起止：
验收用例与证据路径：
验证命令回显摘要（门禁结果 + 定向测试结果）：
未验证边界/已知限制：
```

---

## 2. M0 可信基线（2–3 工程日）

**出口标准**：演示链路不再因接口缺失假报错（T01 完成）；3 条真实创作任务脚本入库存档；P0 故障复现方案可执行；源码↔构建包↔测试产物能按提交关联。

### T01 类型化浏览器演示接口［F16］

- **改动落点**
  - `src/renderer/src/dev/browserMock.ts`：删除第 540 行 `as unknown as typeof window.api` 宽泛强转。
  - 新增 `src/renderer/src/dev/browserApiShape.ts`：`type BrowserApiShape = Pick<typeof window.api, keyof MockCapableApi>` 之类的最小形状（或直接让 browserMock 实现完整 `WindowApi` 类型，缺口处以显式 `notImplementedInDemo(name)` 桩函数补齐——抛错消息为"演示模式未实现：models.xxx"，而非 undefined 崩溃）。
  - 补齐 `models` 命名空间：至少 `resolveBinding`（`rendererGateway.ts` 调用点）、`connections`、`discover`、`testProvider` 四个被 UI 触达的方法。
  - Fixture：新增 `src/renderer/src/dev/demoFixtures.ts`，导出 `DEMO_MODEL_SCENARIOS = { ok, noBinding, timeout, cancelled }`，browserMock 按 URL/参数切换。
- **实施步骤**
  1. 去掉强转 → 跑 `pnpm run typecheck`，收集全部类型错误清单（这就是缺口清单）。
  2. 逐个补桩（`notImplementedInDemo` 或可运行的假实现）；`resolveBinding` 返回固定绑定（演示图模型）。
  3. `rendererGateway` 调用点包 try/catch，把"演示未实现"转成用户可读 toast。
- **测试规格**：`test/browser-mock-contract.test.ts`（新增）——
  - `browserMock 满足 WindowApi 类型（编译期，ts-expect-error 反向断言）`
  - `resolveBinding 在 ok 场景返回演示绑定（F16 复现用例：此前抛 resolveBinding undefined）`
  - `noBinding 场景返回可读错误码而非 undefined 崩溃`
  - `超时/取消场景状态稳定（不悬挂 Promise）`
- **验证命令**：`pnpm exec vitest run test/browser-mock-contract.test.ts`；浏览器实测：`dev:browser` 中点生图空态运行 → 应见"演示模式：模型未绑定"或出占位图，**不得出现 `Cannot read properties of undefined`**。
- **DoD**：强转删除、类型门禁通过、上述 4 用例绿、演示生图/AI处理/语音三个卡片运行各有明确反馈（截图存 `qa/optimization-T01/`）。
- **回退**：纯渲染层 mock，不影响桌面主进程；revert 单提交即可。

### T00 记录 3 条真实创作任务基线［审查报告 不足A 补法］

- 产出 `qa/optimization-baseline/REAL-TASKS.md`：3 条任务脚本（如"文字想法→生图→裁剪"、"已有图片→P图→拆分选用"、"文档→AI处理→分镜"），每条含：步骤、预期停顿点（对照 F01–F18 哪一条）、观察记录。
- 验证：由用户实际走一遍（工具已具备），我方仅记录；不采集提示词内容，只记节点序列与停顿。

---

## 3. M1 保存与恢复（7–11 工程日）——主线，资源冲突时优先保此期

**出口标准**：A07/A08/A09 全部通过；无静默丢失/静默覆盖；旧项目正常打开。

### T04 保存协调器与状态常驻［F01］

- **设计（状态机）**
  ```text
  SavePhase: 'saved' | 'dirty' | 'saving' | 'failed' | 'paused'
  coordinator 字段: dirtyVersion(自增) / persistedVersion / inFlight:boolean / lastSavedAt / lastError
  不变量: ①同项目同时最多 1 个在途保存事务 ②保存期间编辑→标记 dirty，响应返回后若 dirtyVersion>出发时版本→立即再发
  ③旧响应（persistedVersion ≥ 自身序号）不得覆盖较新状态标记 ④failed 状态持续显示直到一次成功
  ```
- **改动落点**
  - 新建 `src/renderer/src/stores/save-coordinator.ts`（zustand）：实现上述状态机，纯逻辑（接收 `save(input): Promise<Result>` 注入），**不 import Electron API**——保证可单测。
  - `CanvasEditor.tsx`：现 `flushSave`/防抖/`graphVersionRef` 逻辑迁移为 coordinator 订阅者；顶栏项目名旁新增保存状态徽标（复用 `.node-status` 视觉族：已保存/未保存/保存中/失败/已暂停 + tooltip 显示 lastSavedAt 与"重试/导出恢复副本"动作）。
  - `CanvasSidePanel` 或 `CanvasPage` 顶栏区：状态徽标组件（新文件 `components/SaveStatusBadge.tsx`）。
  - **beforeunload 重设计**（F01 核心）：删除现"冲突→无锁覆盖"分支。改为：`beforeunload` 时若有 dirty → 同步保存（带乐观锁）；若返回 `REVISION_CONFLICT` → **写恢复副本**（`saveProjectSync` 增加 `recoveryCopy: true` 参数，主进程落 `project.json.local-recovery`，不动 project.json）→ 不覆盖。启动/打开项目时检测恢复副本：存在则弹选择（用磁盘版/用恢复副本），选择后删除另一份。
  - `src/main/ipc/project.ipc.ts` + `src/main/store/projects.repo.ts`：`saveProjectSync` 支持 `recoveryCopy` 分支（复用现有临时文件+回滚机制，写独立文件名）；`openProject` 返回 `pendingRecovery` 标记。
- **实施步骤**
  1. 先写失败测试固化现状缺陷（A07 场景：保存中编辑→旧响应返回→状态误标）。
  2. coordinator 纯状态机 + 单测全绿。
  3. CanvasEditor 接线，beforeunload 改造。
  4. 主进程 recoveryCopy + 启动检测。
  5. L4 故障注入（见验证）。
- **测试规格**
  - `test/save-coordinator.test.ts`（新增，纯逻辑）：`保存期间继续编辑会合并为下一次待保存`；`旧响应不把最新状态误标已保存`；`失败后状态保持直到成功`；`暂停（restoreFailed）时不发保存`。
  - `test/project-save-sync.test.ts`（扩展）：`冲突时写恢复副本而非无锁覆盖`；`恢复副本不覆盖 project.json`；`openProject 报告 pendingRecovery`。
  - L4 故障注入脚本 `qa/optimization-T04/fault-inject.cjs`：①隔离目录设只读（拒写）→ 持续编辑 → 状态徽标必须保持"保存失败"，导出恢复副本可用；②外部推进 graphVersion（直接 node:sqlite 写或第二实例保存）→ 本地保存 → 必须出现恢复副本选择，**不允许静默覆盖**。
- **验证命令**：全量门禁 + `pnpm exec vitest run test/save-coordinator.test.ts test/project-save-sync.test.ts` + fault-inject 脚本回显。
- **DoD**：A07/A08 通过；`grep expectedGraphVersion: undefined src/renderer/src/canvas/CanvasEditor.tsx` 零命中（无锁覆盖分支已删）；徽标五态截图。
- **风险与回退**：beforeunload 同步链路改动风险最高——recoveryCopy 走独立文件、不动原 project.json，单提交 revert 即回旧行为。

### T05 恢复前检查点与预检［F02］

- **改动落点**
  - `CanvasSidePanel.tsx` 恢复入口（:330 一带）：改为五步——`预览差异(节点数/最后运行/媒体清单) → 媒体存在性预检 → 保存"恢复前检查点"快照(自动类,与用户命名版本分开) → migrate+load → 验证(节点数>0 且引用可解析) → 失败自动回滚到检查点`。
  - `src/main/store/history-snapshots`（或 workspace-state.repo，按实际命名）：快照增加 `kind: 'user' | 'auto-recovery'` 字段；列表 UI 分组显示；自动类不挤占用户版本（各自上限）。
  - 媒体预检：恢复前对快照引用的 mediaId 批量 `media.stat`（新 IPC `media:batch-stat` 或复用现有列表接口），缺失时列出名称/数量，允许取消。
- **测试规格**：`test/snapshot-restore-guard.test.ts`（新增）——`恢复前自动创建检查点`；`检查点创建失败则不执行恢复`；`缺媒体时列出并可取消（不产生假媒体）`；`恢复后可一键回到检查点`；`自动检查点与用户版本分开计数`。
- **验证**：全量门禁 + 定向测试 + L4 手册：保存版本 A→编辑为 B→恢复 A→改回 B（走"回到恢复前"），重开项目内容为 B。
- **DoD**：A09 通过；恢复路径上每一步失败都有明确停止与提示（截图三张：预览/缺媒体/检查点回滚）。
- **回退**：恢复流程包在单一入口函数，revert 后回到"直接恢复"旧行为（旧风险回来但不损坏数据）。

---

## 4. M2 开始与运行（6–9 工程日）

**出口标准**：A01–A05 通过；三种运行范围（当前节点/选区依赖/全图）行为可预测且有说明。

### T02 统一创建搜索与键盘退出［F04/F05］

- **改动落点**
  - `SearchPalette.tsx` 重构结果分组：`创建工具`(来自 `allNodeTypes()`，搜索 label+description+别名表) / `当前画布`(现有逻辑) / `我的流程`(现有模板逻辑)。每条结果前置动作标签（创建/定位/插入）。别名表放 `src/renderer/src/canvas/node-aliases.ts`（人工维护，起步 10 条：裁一下→image-crop、配音→speech 等）。
  - **Esc 修复（F05，先行独立提交）**：输入框 `onKeyDown` 改为仅对非 Esc `stopPropagation`；Esc 先 `close()` 再阻止画布快捷键；关闭后焦点返回触发按钮（记录 `opener` ref）。
  - 键盘：↑↓ 选择、Enter 执行、结果>30 显示计数与"继续筛选"提示。
  - 对工作台隐藏但命中的工具：显示"已隐藏，可本次添加"，走现有 `node-create-options` 兼容判断，不永久改 profile。
- **测试规格**
  - `test/search-palette.test.ts`（新增）：`空画布搜索"生图"出现创建动作`；`别名"裁一下"命中裁剪节点`；`动作标签区分创建/定位/插入`；`超30条显示计数提示`。
  - L3 脚本 `qa/optimization-T02/esc-focus.cjs`（复用 `qa/verify-runtime-2026-09-29/r47-keyboard-verify.cjs` 骨架）：输入框内 Esc 关闭且焦点回触发钮；关闭后按 Delete 不误删节点（联动 R-47 守卫）。
- **验证**：全量门禁 + 定向 + L3 脚本 + 手册 A02。
- **DoD**：A02 通过；`grep -n "stopPropagation" src/renderer/src/canvas/SearchPalette.tsx` 显示 Esc 分支先行处理。

### T03 新建项目分层［F03］

- **改动落点**：`ProjectCreateDialog.tsx` 首层收敛为：名称 + 起点（空白画布/从我的流程/导入素材，后两项复用现有模板与导入入口）+ 折叠的"自定义可见工具"（默认收起，展开后维持现 28 项勾选与"沿用最近配置"）。回车即创建。
- **测试**：`test/project-create-dialog.test.ts` 扩展：`只填名称可创建（节点配置不可见不阻断）`；`折叠展开后勾选状态持久化到最近偏好`；`起点选择只影响初始内容`。
- **DoD**：A01 前半通过；现有 `test:browser-*` 回归不破。

### T06 统一预检［F06］

- **设计**：扩展 `node-readiness.ts` 返回结构化阻断原因，三层共享同一判定函数：
  ```ts
  type Readiness =
    | { kind:'ready' }
    | { kind:'blocked', reason: 'not-connected'|'await-upstream'|'config-missing'|'model-unbound'|'media-missing', ports?, detail, fix }
  ```
  - `not-connected`：现有连线计数（保留）。
  - `await-upstream`：必填口已连线但上游无有效输出 **且上游不在本次运行计划内**（计划判断注入，避免误阻断合法流程——报告 F06 边界）。
  - `config-missing`：节点级最小配置校验（生图无提示词、截取无范围等，每节点一个 `minConfigCheck` 纯函数，放 shared 与执行器同源）。
  - `model-unbound`：`resolveFeatureOption` 结果缓存注入（复用 `specs/bodies` 已有调用，不新增模型请求）。
- **改动落点**：`node-readiness.ts`、各执行器旁新增 `min-config.ts`（或并入 shared helpers）、卡片状态灯与详情共用 `describeReadiness()` 中文映射。
- **测试**：`test/node-readiness.test.ts` 扩展 5 用例（对应 5 种 reason 各一）；A03 手册确认"上游在计划内不误阻断"。
- **DoD**：生图空态不再显示"可运行"（显示"缺提示词，补齐后运行"）；三种消费方（卡片/详情/运行计划 T07）输出一致。

### T07 运行计划与范围说明［F07］

- **改动落点**：`engine/executor.ts` 三个入口已有闭包逻辑，新增 `planOnly` 纯函数变体（不执行，返回 `{nodes, willRun[], willReuse[], generateRequests, blockers[]}`——复用 `seedPersistedOutputs` 与拓扑闭包代码路径，不复制规则）；顶栏运行按钮悬停/点击展示摘要卡（"本次处理 N 节点；重新生成 M 张；K 项未就绪"）；既有局部重跑确认弹窗改为**带名字的清单**（节点标题列表，不只计数）。
- **测试**：`test/run-plan.test.ts`（新增）：`单节点运行计划只含自身`；`选区闭包含上游且不触无关分支`；`取消计划零生成请求`（gateway mock 计数）。
- **DoD**：A03/A04 通过；三种入口的摘要文案与实际执行集合一致（脚本断言摘要 nodes 数 == 实际执行数）。

### T08 面向创作者的错误与恢复［F10］

- **改动落点**：`shared/engine/error-mapping.ts`（新增）：`mapRunError(raw, phase) → { 中文阶段, 原因一句话, 动作按钮[], 是否可能新计费 }`；`CanvasSidePanel` RunsPanel 第一层渲染映射结果，原始 error/runId/phase 折叠进"诊断详情"。动作按钮复用现有"回到节点/重试节点"及视频任务的续查/重下（M2 只做文案与入口，不改任务系统）。
- **测试**：`test/error-mapping.test.ts`：7 类失败样本（对齐 A05）各自映射正确；`普通信息层不出现裸英文状态词`（断言 RunsPanel 渲染文本不含 'failed'/'execution'）。
- **DoD**：A05 前两类（缺模型/参数错）通过，其余 5 类映射正确（真实注入到 M5/L4 补）。

---

## 5. M3 成果选用与复用（8–12 工程日）

**出口标准**：A10/A11 通过；超过 12 次尝试后选定成果及来源仍可追溯。

### T09 结果新鲜度与固定选用［F08］

- **设计**：输入指纹（轻量版）——`shared/engine/input-fingerprint.ts`：`hash = 契约版本 + config + 正文/内容 + 按序上游产物 mediaId/resultRef`；存入 `NodeRunRecord.inputFingerprint`；投影层对比当前指纹≠上次成功指纹 → 状态灯/结果卡加"输入已修改"角标（**不删旧结果、不自动重跑**）。"固定"= 结果卡操作`固定此结果`：下游消费固定 assetId（记录于 `meta.pinnedOutput`，投影优先读它），解除固定有提示。
- **测试**：`test/freshness.test.ts`：改提示词→角标出现、旧结果仍在；固定后其他候选生成不影响下游；解除固定提示来源将变化。
- **DoD**：A10 前半通过。

### T10 长期生成来源记录［F09］

- **改动落点**：新表 `artifact_recipes`（id, mediaId, runId, fullPrompt, paramsJson, modelKey, providerId, contractVersion, inputsJson(引用 mediaId 列表), createdAt）——`db-migrations.ts` M10（沿用 T04 的事务迁移模式）；写入口在 `emitArtifact`/物化路径；资产详情页"查看生成来源"渲染完整记录；旧数据无记录时显示"历史记录不完整"。诊断导出复用脱敏管道（不导 fullPrompt）。
- **测试**：`test/db-migrations.test.ts` 增 M10 用例；`test/recipe-provenance.test.ts`：第 13 次后可查选定素材来源；删除生产节点后记录仍在；导出导入重映射 recipe 引用。
- **DoD**：A10 全部通过；A11 引用完整性含 recipes。

### T11 复用预览与语言统一［F11］

- **改动落点**：保存入口统一文案"保存为可复用内容"→ 二选一（素材资源/流程模板）；`LibraryResourcePicker` 插入前预览清单（将建节点/复制文件数/资源版本/未填变量）；变量未填齐时定位变量并阻断提交；配方按钮改名"生成提示词文本"并说明模型参数仅说明性。
- **测试**：L3 脚本 `qa/optimization-T11/preview.cjs` 三场景（正常/缺文件/变量未填）；`test/library-insert.test.ts` 扩展不产生半套节点断言。
- **DoD**：A11 通过。

### T12 按次生成结果分组［F12］

- **改动落点**：`artifact-materializer.ts` 产物节点加 `meta.runGroupId = runId`；画布层对该组渲染可折叠外框（仅视觉，`display` 切换不改图数据）；资产面板动作"定位选用结果/显示本轮/显示全部"。
- **测试**：`test/artifact-grouping.test.ts`：折叠不改变执行拓扑（deriveGraph 前后一致）；整理仅选区、可撤销。
- **DoD**：多轮生成截图（折叠/展开/定位）；A14 样本下无布局破坏。

---

## 6. M4 分镜专项（8–14 工程日，按 M0 真实任务频次决定是否立项）

### T13 分镜映射与局部续跑［F13］

- **实施顺序**（报告 8.1"先一个镜头"）：①单镜头全链手工跑通并记录断点 → ②显式转换：用 processor/code 节点组成 `shots→list.items` 模板（缺契约则按节点协议新增 `shot-list-adapter` 转换节点，走全量契约测试）→ ③稳定 shotId（分镜行 uid，重排不换）→ ④`meta` 记录 per-shot 的 inputRevision/taskId/selectedAssetId → ⑤失败只重跑该项（复用 iterate 的 failed 模式）。
- **测试**：`test/storyboard-adapter.test.ts`（契约+连线+失败）；L4 手册 A12（20 镜改 3 失败 2 → 只处理 5 项）。
- **DoD**：A12 通过；shotId 与资源/任务/选用成果在重排、重开、导入导出后不串。

---

## 7. M5 规模与日常（5–8 工程日）＋贯穿任务

### T14 最近删除与版本启动［F14/F15］

- 项目列表加"最近删除"页签（`projects.deleted=1` 列表 + 恢复动作 + 名称冲突处理）；`launch-latest-desktop.ps1` 旁新增 `launch-verified-desktop.ps1`（只启动已装包，显示 build-source.json 提交/时间）；新包旁路构建目录成功后再切换。
- **测试**：`test/projects-recent-delete.test.ts`；L4：删除→恢复→导出重开引用完整（A15）。
- **DoD**：A15 通过；更新失败保留可工作包（脚本级验证）。

### T15 规范与行为门禁收敛［F17/F18，贯穿］

- **F17 裁定**（M2 前完成）：按节点族定主操作位置——建议生成类正文按钮为主（现状高频）、标题运行降为次级图标；`NODE_UI_STANDARD.md` 升 v1.1 删除冲突条款，旧条款标"已失效"。
- **F18**：每期选 1–2 个源码字符串断言测试改行为测试（优先：overlay-dismissal→真实 Esc 分层测试、canvas-interaction 相关）；`app.css` 死规则按权威层逐步删（每删一批跑 ui-foundation/canvas-interaction 回归 + 截图基线对比）。
- **F19 行为验证**（本计划 §0.2 的收尾）：L4 步骤——进/出画布 5 次 → DevTools `getEventListeners(window)` 中 wheel 捕获监听数为 0。
- **DoD**：代表节点（生图/AI处理/视频截取）空态/运行/失败/成功四态截图一致；Esc/Delete/焦点/连线/撤销组合回归脚本绿。

### T16 性能证据与定向优化［F12/F18，M5］

- 样本 A/B/C 生成脚本（复用 `scripts/benchmark-canvas.mjs`/`benchmark-graph.mjs` 扩展）；指标：输入响应 P50/P95、拖动帧时间、首帧可操作、保存耗时、内存峰值。
- **规则**：一次只优化一个实测热点；前后同场景数据入 `qa/optimization-T16/baseline.json` 与 `after.json`；禁止无测量断言"性能提升"。
- **DoD**：A14 报告含硬件/窗口/缩放与三样本数据；同机无回归。

---

## 8. 验收用例执行规格（A01–A15）

每条：`前置 → 步骤 → 通过判据 → 证据产物`。逐条卡片见下表（执行时复制到 ledger 勾选）：

| 用例 | 执行环境 | 关键步骤 | 通过判据（可判真假） | 证据 |
|---|---|---|---|---|
| A01 从零开始 | L3+L4 | 新建只填名→空态写想法→Ctrl+K 搜"生图"创建 | 全程无需展开节点配置；未配模型时给出配置入口文案，无裸异常 | 录屏+截图 |
| A02 搜索与焦点 | L3 | Ctrl+K→输入→Esc→再开→Tab 循环→Enter→关后按 Delete | Esc 只关当前层且焦点回触发钮；Delete 不删节点 | 脚本 `esc-focus.cjs` 回显 |
| A03 合法依赖流程 | L2/L3 | 文本→处理→生成，上游无结果，运行终点 | 计划含上游、不误阻断；制造 Schema 不匹配时错误定位到具体边 | run-plan 测试+截图 |
| A04 避免误运行 | L2 | 两独立分支，选区运行其一 | 只跑目标闭包；全图摘要列出两分支；取消零请求（gateway 计数=0） | `run-plan.test.ts` 断言 |
| A05 失败分类 | L2(mock)/L4(真实) | 7 类失败注入 | 每类中文原因+对应动作；能重下不重生成；未知受理不自动重交 | error-mapping 测试+脚本 |
| A06 视频恢复不退化 | L4 | 带 upstreamTaskId 在途任务→重启隔离实例 | 续查原任务；不建第二任务；无任务ID不假装恢复 | 隔离实例日志 |
| A07 快速编辑退出 | L4 | 防抖窗口内切项目/关窗；保存中继续编辑 | 内容落盘或恢复副本存在；旧响应不覆盖新状态 | fault-inject.cjs |
| A08 保存失败冲突 | L4 | 拒写目录+外部推进版本+关窗冲突 | "保存失败"持续显示；两份可恢复版本；无未提示覆盖 | 同上+截图 |
| A09 历史恢复 | L4 | 版本A→编辑B→恢复A；A缺媒体；检查点写失败 | 预览可见；可回B；缺媒体可取消；备份失败不覆盖B | snapshot-guard 测试 |
| A10 成果选用追溯 | L4 | 15 轮生成选第 2 轮→改词→继续→删生产节点 | 选用素材可用；旧输入标记准确；来源可查 | recipe 测试+截图 |
| A11 资源模板往返 | L2/L4 | 资源含图/文/声/变量→插他项目→升级版本→导出导回 | 引用重映射正确；原项目不被改写；无 Key 泄漏 | transfer 测试扩展 |
| A12 分镜局部修改 | L4 | 20 镜改 3 失败 2 重排续跑 | 只处理 5 项；shotId 不串；暂停重开可续 | T13 测试+录屏 |
| A13 本地独立 | L4 | 断网开已验证包→编辑保存重开 | 本地编辑不依赖在线；生成单独提示 | 手册+日志 |
| A14 窗口与规模 | L4 | 1280×720/125%/150%；50/200/1000 节点 | 动作可达无新遮挡；实测数据入报告 | T16 数据文件 |
| A15 误删恢复 | L4 | 删项目→最近删除恢复→导出重开 | 名称/媒体/引用/来源恢复；未清理不谎称释放空间 | recent-delete 测试 |

---

## 9. 度量与记录

- 六目标沿用报告 §5；每目标在 M0 基线一次、各期出口各测一次，结果追加 `qa/optimization-metrics.md`（表格：目标/日期/样本/数值/提交）。
- 修改前后各 3 次同任务对照（真实任务脚本），只记观察不做统计宣称。
- ledger 每任务完成时必须含：全量门禁回显摘要、定向测试结果、验收用例状态。

## 10. 依赖与排期总览

```text
M0(2-3d): T01 ──┬→ T00 基线
                └→ T15-F17裁定(先行)
M1(7-11d): T04 → T05        （T04 先行，T05 依赖其检查点写入）
M2(6-9d):  T02(Esc先) ∥ T03 ∥ T06 → T07 → T08   （T07 依赖 T06 的结构化预检）
M3(8-12d): T09 → T10 → T11 ∥ T12               （T10 迁移依赖 T04 模式）
M4(8-14d): T13（独立，按 M0 频次决策）
M5(5-8d):  T14 ∥ T16；T15 贯穿每期
```

- 主线 28–43 工程日（不含 M4）；缓冲 20%；数据迁移超预期时砍体验功能保 M1。
- 每期出口未达标不进入下一期；唯一允许并行的是 T15 收敛与文档。

---

## 附：与审查报告的差异说明

1. 报告 F19 属实，已在本计划编制时先行修复（§0.2），T15 仅保留其行为验证。
2. 报告建议均保留原意；本计划补充了具体数据结构（SavePhase/Readiness/inputFingerprint/runGroupId/artifact_recipes 表）、测试文件与用例名、故障注入脚本路径，使每项可执行可验证。
3. 未采纳/未扩展项与报告 §7"明确不纳入"一致，不再复述。
