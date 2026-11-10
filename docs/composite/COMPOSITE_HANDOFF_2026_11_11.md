# 组合能力版本编辑与端口推导 Handoff（2026-11-11）

## 1. 本轮结论

本次优化完成两件事：

1. **修正组合节点公开端口推导**：默认只生成真实输入和最终输出，不再把中间节点的多路输出全部暴露；
2. **按 Stitch 设计稿重做组合版本编辑器**：右侧全高抽屉，节点图 / 输入输出 / 版本历史三页，支持改内部节点配置、改公开边界、查看历史版本、发布/覆盖版本。

仍未完成：内部节点图的拖拽增删连线编辑、版本删除与引用保护、旧实例批量迁移、真实模型端到端验收。详见第 7 节。

## 2. Stitch 设计来源

- Stitch 项目：`自由画布 · 保存节点与流程运行`（`projects/2512178183919941839`）
- 屏幕：`自由画布 - 复合能力编辑 (角色设计 v2.0)`
  `projects/2512178183919941839/screens/24122006a66f489692ef5e3d9bf545a8`
- 本地设计稿：`source/.stitch/designs/composite-editor.png`
- 实现文件：
  - `src/renderer/src/composite/CompositeVersionDialog.tsx`
  - `src/renderer/src/composite/composite-editor.css`

## 3. 端口推导规则（重要）

实现：`src/shared/composite/boundary.ts` + `src/renderer/src/composite/build-manifest.ts`

### 3.1 输入

- 没有内部上游的节点 = 边界源节点；
- 文本源节点默认生成 1 个文本输入，映射到其 `in-text`；
- 文本节点正文非空时作为默认值；
- 其它源节点只公开必填输入端口；
- 已有内部来源或外部连线映射的端口不重复公开。

### 3.2 输出

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

## 4. 版本模型（按用户 2026-11-10 裁决）

- 版本使用**主版本整数**：`1.0 / 2.0 / 3.0`；旧的 `1.0.0` 兼容读取并显示为 `1.0`。
- 允许**直接修改旧版本并覆盖**同一主版本（不再强制“版本不可变”）。
- 发布前仍执行完整 `validateCompositeManifest`。
- 版本历史接口：`composite.version.list`（IPC + Agent 只读操作）。
- 编辑器「版本历史」页可以载入任意旧版本进行查看/修改；载入旧版本后发布默认仍保存当前版本号，需要保留旧版时先把版本号改成新的主版本。

## 5. 使用路径

1. 打开右侧「节点库」；
2. 找到「角色设计」组合卡片；
3. 点「编辑」；
4. 「输入输出」页点 **“按内部图重新推导”**：旧数据会从 `0 输入 / 3 输出` 修正为 `1 输入 / 1 输出`；
5. 「节点图」页选中内部节点，可编辑该节点的配置 JSON（模型、系统提示词等）；
6. 修改名称/说明/版本号；
7. 点「发布新版本」：同版本覆盖或按主版本生成新版本。

> 旧数据修复：已有组合的 manifest 不会自动重算；必须进入编辑器点一次“按内部图重新推导”并发布，才会写入正确端口。

## 6. 验证证据

- `test/composite-boundary.test.ts`：文本→AI→生图只得到 1 输入/1 图片输出；中间 markdown/json 不公开（2 项通过）；
- `test/composite-build-manifest.test.ts` + manifest/repo/agent-access 相关 16 项通过；
- `npm run typecheck:web`、`eslint`、`npm run build` 通过；
- `npm run guard:agent-parity` 三关全绿（新增 `composite.version.list` 已同步契约、动作分母、日志门禁）；
- 应用已用隔离测试库重启（`qa/composite-app-data`），窗口 `无限画布创作平台` 可打开；
- Stitch 设计稿已下载到 `.stitch/designs/composite-editor.png`。

未验证：

- 旧「角色设计」实例在真实画布上的修复发布路径（UI 代码已接，尚未逐步点击验收）；
- 内部节点配置修改后的真实模型运行；
- 版本删除/引用保护（未实现）。

## 7. 已知限制与下一批任务

### 必须补

1. **内部节点图可视化编辑**：当前「节点图」页只能改节点配置 JSON，不能在编辑器里增删节点或拖拽连线；需要复用画布节点编辑器/NodeRunHost 做子图编辑。
2. **版本删除与引用保护**：用户要求可删除旧版本；当前只支持查看/载入，未实现删除；删除前必须检查画布实例与嵌套组合引用。
3. **旧实例迁移**：已有 composite 实例仍绑定旧 manifest。后续可加“实例升级到新版本”入口，用 `planCompositeUpgrade` 做端口兼容预检。
4. **真实模型人物设计验收**：ToAPIS 已配置并验证 `gpt-image-2`（image.generate）与 `deepseek-v4.1-flash`（text.process），但尚未在画布跑通 `文本 → AI → 生图 → 公开图片 → 下游消费` 全链路。
5. **P3 持久等待/恢复**：`composite_run_waits` 表和 repo 已有，运行器尚未在缺输入时打开等待并暂停/恢复；GUI/CLI 补交入口未接。
6. **P5 画布 Agent 适配**：未开始。

### 已完成的中间件

- 组合契约/不可变校验/M25 定义版本草稿；
- composite 节点独立 store 隔离执行（不切页、并发不串）；
- 运行账本 M26 + 重启结算；
- 依赖锁定、嵌套环/深度/预算、版本升级影响预检；
- 节点库组合卡片与真实 CLI 发布/查询。

## 8. 关键代码位置

| 功能 | 文件 |
|---|---|
| 公开边界推导 | `src/shared/composite/boundary.ts` |
| 从画布选区建 manifest | `src/renderer/src/composite/build-manifest.ts` |
| 版本编辑器（Stitch 设计） | `src/renderer/src/composite/CompositeVersionDialog.tsx` |
| 编辑器样式 | `src/renderer/src/composite/composite-editor.css` |
| 默认边界编辑器 | `src/renderer/src/composite/CompositeBoundaryEditor.tsx` |
| 版本/发布仓储 | `src/main/store/composite.repo.ts` |
| 组合实例执行 | `src/renderer/src/composite/run-composite.ts` |
| 组合节点 spec | `src/renderer/src/nodes/specs/index.tsx` |

## 9. 提交记录（本轮）

- `b29cbd4` 按 Stitch 设计重做版本编辑器 + 修正默认公开端口
- `fb0fd68` 修复组合 JSON 公开端口缺 schema 导致保存失败
- `33c96e9` 主版本整数管理 + 节点库编辑/新版本
- `d9f449f` 修复 AI 处理无文本模型时隐藏系统提示词
- 本次 handoff 与“按内部图重新推导端口”随最后一次提交入库
