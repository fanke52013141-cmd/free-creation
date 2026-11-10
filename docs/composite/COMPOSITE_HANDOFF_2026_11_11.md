# 组合能力版本编辑与端口推导 Handoff（2026-11-11）

> 2026-11-11 修订：用户明确否决“窄侧栏 + 流程条”编辑方式。现已改为
> **点击编辑直接进入全屏画布编辑模式**，节点再多也走画布平移/缩放，不再挤在侧栏流程条里。
> 版本信息/历史仍保留在独立轻量面板，不再承担内部图编辑。

## 1. 本轮结论

本次优化完成：

1. **修正组合节点公开端口推导**：默认只生成真实输入和最终输出，不再把中间节点的多路输出全部暴露；
2. **全屏画布编辑模式**：点击组合卡片「编辑」进入整屏内部图画布，可直接选中节点改配置、拖动节点、缩放/框选；
3. **按 Stitch 设计稿**重做版本信息/历史与发布入口；
4. 旧版本可通过「按内部图重新推导」修正 `0 输入 / 3 输出`。

仍未完成：内部画布的连线拖拽交互验收、版本删除与引用保护、旧实例批量升级、真实模型端到端验收。详见第 7 节。

## 2. Stitch 设计来源

- Stitch 项目：`自由画布 · 保存节点与流程运行`（`projects/2512178183919941839`）
- 屏幕：`自由画布 - 复合能力编辑 (角色设计 v2.0)`
  `projects/2512178183919941839/screens/24122006a66f489692ef5e3d9bf545a8`
- 本地设计稿：`source/.stitch/designs/composite-editor.png`
- 设计意图：全屏画布 + 右侧节点设置，不是窄侧栏流程图；实现按此方向落地。

## 3. 全屏画布编辑模式（本次新增）

入口：节点库组合卡片「编辑」「新版本」。

实现：`src/renderer/src/composite/CompositeCanvasEditor.tsx`

- 打开后覆盖整个应用窗口，独立 tldraw 编辑器，不触碰用户当前项目/画布；
- 顶部栏：返回、组合名、版本、+文本 / +AI 处理 / +生图、保存并发布；
- 内部节点按 manifest 的 `graph.nodes` 位置、标题、正文、配置、媒体引用重建；
- 内部连线按 `graph.edges` 重建；
- 选中节点后复用现有 `NodeContractPanel`（模型、系统提示词、参数、端口）；
- 保存时用 `deriveGraph` 读回节点/连线，重建 manifest：
  - 重新分配稳定内部 ID `n1...nN`；
  - 保留版本、名称、说明、依赖；
  - 公开输入/输出按内部图重新推导（媒体优先，单输出）；
- 保存动作：校验 → `composite.draft.save` → `composite.publish`；
- 关闭即销毁独立编辑器。

限制：当前独立画布复用 tldraw 默认箭头工具，端口拖线行为需要在真实应用里做一轮交互验收；如果与主画布端口手势不一致，需要复用主画布的端口拖拽层。

## 4. 端口推导规则（重要）

实现：`src/shared/composite/boundary.ts` + `src/renderer/src/composite/build-manifest.ts`

### 输入

- 没有内部上游的节点 = 边界源节点；
- 文本源节点默认生成 1 个文本输入，映射到其 `in-text`；
- 文本正文非空时作为默认值；
- 其它源节点只公开必填输入端口；
- 已有内部来源或外部连线映射的端口不重复公开。

### 输出

- 没有内部下游的节点 = 汇节点；
- 每个汇节点只公开**一个主输出**，优先级：
  `image > video > audio > file > text > markdown > json`；
- 中间节点的 `out-text / out-markdown / out-json` 默认不再公开；
- 需要更多输出时在「输入输出」页手动添加。

因此 `文本 → AI 处理 → 生图` 默认得到：

```text
1 个输入：文本（人物要求）
1 个输出：图片（最终生图）
```

## 5. 版本模型（按用户 2026-11-10 裁决）

- 版本使用**主版本整数**：`1.0 / 2.0 / 3.0`；旧的 `1.0.0` 兼容读取并显示为 `1.0`。
- 允许**直接修改旧版本并覆盖**同一主版本（不再强制“版本不可变”）。
- 发布前仍执行完整 `validateCompositeManifest`。
- 版本历史接口：`composite.version.list`（IPC + Agent 只读操作）。
- 节点库「版本」按钮打开轻量版本面板：可查看历史、载入旧版本、改名称/说明/版本、发布；内部图编辑走全屏画布。
- 「新版本」入口会先把主版本 +1，再进入全屏画布，保存即发布该新版本。

## 6. 使用路径

1. 打开右侧「节点库」；
2. 角色设计卡片：
   - 「编辑」→ 全屏画布，改节点/配置/连线，保存并发布；
   - 「新版本」→ 版本 +1 后进入全屏画布；
   - 「版本」→ 查看历史、载入旧版本、改名称/版本、发布；
3. 旧数据修复：进入编辑后保存会自动按内部图重推导端口；也可在版本面板「输入输出」页点“按内部图重新推导”。

## 7. 验证证据

- `test/composite-boundary.test.ts`：文本→AI→生图只得到 1 输入/1 图片输出；中间 markdown/json 不公开（2 项通过）；
- `test/composite-build-manifest.test.ts` + manifest/repo/agent-access 相关 16 项通过；
- `npm run typecheck:web`、`eslint`、`npm run build` 通过；
- `npm run guard:agent-parity` 三关全绿（新增 `composite.version.list` 已同步契约、动作分母、日志门禁）；
- 应用已用隔离测试库重启（`qa/composite-app-data`）。

未验证：

- 全屏编辑画布里的端口拖线/连线手势（需要真实窗口交互验收）；
- 旧「角色设计」实例的修复发布路径逐步点击；
- 内部节点配置修改后的真实模型运行；
- 版本删除/引用保护（未实现）。

## 8. 已知限制与下一批任务

### 必须补

1. **全屏画布端口拖线验收**：与主画布一致地从输出端口拖到输入端口建立数据边；当前复用 tldraw 默认箭头工具，需实测并必要时接入主画布端口拖拽层。
2. **版本删除与引用保护**：当前只支持查看/载入；删除前必须检查画布实例与嵌套组合引用。
3. **旧实例迁移**：已有 composite 实例仍绑定旧 manifest；后续加“实例升级到新版本”入口，用 `planCompositeUpgrade` 做兼容预检。
4. **真实模型人物设计验收**：ToAPIS 已配置并验证 `gpt-image-2`（image.generate）与 `deepseek-v4.1-flash`（text.process），但尚未跑通 `文本 → AI → 生图 → 公开图片 → 下游消费`。
5. **P3 持久等待/恢复**：`composite_run_waits` 表与 repo 已有，运行器尚未接入等待暂停/恢复；GUI/CLI 补交入口未接。
6. **P5 画布 Agent 适配**：未开始。

## 9. 关键代码位置

| 功能 | 文件 |
|---|---|
| 全屏组合画布编辑 | `src/renderer/src/composite/CompositeCanvasEditor.tsx` |
| 全屏编辑样式 | `src/renderer/src/composite/composite-editor.css` |
| 公开边界推导 | `src/shared/composite/boundary.ts` |
| 从画布选区建 manifest | `src/renderer/src/composite/build-manifest.ts` |
| 版本/历史轻量面板 | `src/renderer/src/composite/CompositeVersionDialog.tsx` |
| 默认边界编辑器 | `src/renderer/src/composite/CompositeBoundaryEditor.tsx` |
| 版本/发布仓储 | `src/main/store/composite.repo.ts` |
| 组合实例执行 | `src/renderer/src/composite/run-composite.ts` |

## 10. 提交记录

- `b29cbd4` 按 Stitch 设计重做版本编辑器 + 修正默认公开端口
- `fb0fd68` 修复组合 JSON 公开端口缺 schema 导致保存失败
- `33c96e9` 主版本整数管理 + 节点库编辑/新版本
- `d9f449f` 修复 AI 处理无文本模型时隐藏系统提示词
- `a8d259e` 旧版本按内部图重新推导 + Handoff
- 本次全屏画布编辑随最新提交入库
