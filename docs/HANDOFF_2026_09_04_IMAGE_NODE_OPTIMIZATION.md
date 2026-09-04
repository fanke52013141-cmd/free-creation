# 图片节点优化 + Ctrl+滚轮接管排查交接（2026-09-04）

> 已推送至 `origin/main`。本次涉及一次功能提交 `454f21b`；「Ctrl+滚轮缩放」为上一次
> 提交 `ed38a1f` 引入功能的排查与重新打包，未产生新的功能提交。

## 交付摘要

| 项 | 状态 | 说明 |
| ---- | ---- | ---- |
| 图片资产节点新增 `in-image` 输入端口 | ✅ 已开发并提交 | 用于拆分结果展开后的连线归属；`agent-contracts.json` 已同步 |
| 图片拆分节点自动展开 | ✅ 已开发并提交 | 拆分每格自动展开为独立 image 节点并连线，幂等防重复 |
| 拆分按钮移到底部 | ✅ 已开发并提交 | 与图片等其他节点位置一致 |
| 内容较多节点滚动修复 | ✅ 已开发并提交 | 移除滚动场景下误挂的 `useWheelScroll` |
| 契约同步 | ✅ 已完成 | `src/capabilities/definitions.ts` 与 `generated/agent-contracts.json` 一致 |
| Ctrl+滚轮缩放「未选中失效」 | 🔎 已定位根因并重新打包 | 代码本身正常，根因是运行了不含接管的旧 exe；已重打包 |

提交链（截至 `454f21b`，均已推送）：
- `ed38a1f`（2026-09-03）Ctrl+滚轮缩放接管与节点交互细节修复
- `5c69d4a`（2026-09-04）节点标题行按钮重排与框选实线根修
- `454f21b`（2026-09-04）图片节点优化与拆分自动展开（28 文件 +1007/-229）

## 一、本次功能改动（提交 `454f21b`）

### 1. 图片资产节点 `in-image` 输入端口

- `src/capabilities/definitions.ts`：`image.source` 从 `inputs: []` 新增可选
  `in-image`（image, one, required=false），用途为拆分结果展开后的连线归属。
- `src/renderer/src/nodes/specs/index.tsx`：图片节点匹配该端口。
- `generated/agent-contracts.json`：已通过 `agent:generate` 同步。

性质说明：该端口是**可选**输入，语义上是「拓扑归属」而非数据源——资产仍以本节点
已导入的媒体为准，不因上游连线而改变图片内容。这是刻意设计（拆分展开不是为了让
图片节点重新取图，而是建立可导航的连线关系）。

### 2. 图片拆分自动展开 `expandSplitResults`

- `src/renderer/src/nodes/specs/bodies/shared.tsx`：新增 `expandSplitResults(editor, source)`。
- 行为：读取拆分节点 `meta.nodeResult` 的媒体集合（≥2 项才展开），在拆分节点右侧
  纵向创建一排 `image` 节点，每个再建立 `image-split.out-image → image.in-image` 连线。
- 幂等：以 `mediaId@createdAt` 拼接签名写在 `meta.splitAutoExpandedFor`；媒体集合未变
  且对应节点仍在画布上则不再重复创建，重算/换图后签名变化才重建。
- 触发点：`src/renderer/src/engine/executor.ts` 在执行器动态 import 的自动展开 hook 中调用。

### 3. 拆分按钮移到底部

- `image-split.tsx`：调整拆分按钮位置到底部，与其他节点一致。

### 4. 内容较多节点滚动修复

- 移除多个节点体（image-edit / iterate / processor / structured / video-transforms /
  vocal-separate 等）中对 `useWheelScroll` 的误用，避免滚动场景下与画布手势冲突。

## 二、Ctrl+滚轮缩放「未选中失效」排查结论

### 现象

未选中任何节点时，按住 Ctrl 滑动滚轮无法放大缩小画布。

### 根因（非代码缺陷）

- 接管逻辑在 `CanvasEditor.tsx`（`.canvas-host` 捕获层，`ed38a1f` 引入）。
- 用户实际运行的 `dist/win-unpacked/canvas-studio.exe` 是 2026-09-03 14:20 构建，
  **不含接管**（早于 `ed38a1f` 约 7.5 小时）。
- 无接管时 tldraw 自带 Ctrl 滚轮在画布容器**未聚焦**（未选中时 `activeElement=BODY`）
  下会被手势管线整体吞掉，于是表现为「没选中就缩放不了」。

### 验证（Playwright `_electron` 实测）

| 运行入口 | Ctrl+滚轮 3 格结果 |
| ---- | ---- |
| 旧 exe（9-03 14:20，不含接管） | 失效（zoom 停在 100%）|
| 最新源码 / `out/` 构建 | 生效（100%→173%）|
| 重打包 exe（9-04 17:39） | 生效（100%→173%）|

事件探针确认：接管在 `.canvas-host` 捕获阶段正确 `preventDefault` + `stopPropagation`，
事件不再进入 `.tl-container` 或节点层；因此节点选中与否、光标是否在节点上、是否滚动
容器均不影响接管。

## 三、测试覆盖情况

### 已自动化测试（全绿）

- 全量 `npm test`：**67 文件、847 用例全部通过**（2026-09-04 17:56 复测）。
- `npm run typecheck`（node + web）：通过（`build:unpack` 已内联执行）。
- 契约门禁：`image.source` 新增 `in-image` 端口后 `agent-contracts.json` 与源码一致，
  契约快照/一致性测试通过。
- `image-split` 执行器：`test/image-split.test.ts` 覆盖宫格配置、面积缩放、参数收敛、
  执行器消费真实原图并记录每格结果。
- 连线矩阵基础：`test/connection-matrix.test.ts` 覆盖 image-split → video / iterate 等；
  本次未新增但既有用例通过。

### 已自动化测试但与本次改动相关

- `test/node-contract-snapshot.test.ts`：校验各节点端口契约，会捕获 image.source 的
  `in-image` 端口，但断言未显式列举图片资产节点的新增端口。

### 尚未编写自动化测试（重要缺口）

- **`expandSplitResults` 自动展开**：无任何单测。幂等签名（`splitAutoExpandedFor`）、
  展开节点创建、`image-split.out-image → image.in-image` 连线、换媒体后重建、幂等跳过
  均未用测试固化。
- **`image-split → image` 连线矩阵**：`connection-matrix` 未显式断言
  `image-split(out-image) → image(in-image)` 可连。
- **按钮位置、滚动修复等 UI 改动**：属渲染层，无自动化测试。

## 四、已验证 / 待验证问题清单

### 已修复（本次 / 上轮提交内）

| 问题 | 修复 | 验证状态 |
| ---- | ---- | ---- |
| 图片资产节点无 `in-image` 端口 | 新增可选端口 | ✅ 契约同步，自动化通过 |
| 图片拆分需手动手动逐个建图连线 | 自动展开 + 自动连线 | ✅ 代码完成；自动化覆盖缺失 ⚠️ |
| 拆分按钮在顶部位置不一致 | 移至底部 | ✅ 代码完成；需桌面冒烟 ⚠️ |
| 内容多节点滚轮误触发画布手势 | 移除误用 `useWheelScroll` | ✅ 代码完成；需桌面冒烟 ⚠️ |
| Ctrl+滚轮未选中缩放失效 | 确认非代码缺陷，重打包 exe | ✅ Playwright 实测重打包 exe 生效 |

### 尚未修复 / 待测试

| 问题 | 状态 | 说明 |
| ---- | ---- | ---- |
| 右键菜单「编辑」对文本节点无法打开编辑器 | ⏳ 已知遗留 | `NodeContextMenu.tsx` 只调 `setEditingShape`，不分发 `canvas:edit-text-node`；独立于本次，待后续 |
| 图片拆分自动展开的**桌面手工验收** | ⏳ 待执行 | 见下方验收路径，未在打包版实际点击验证 |
| connection-matrix 缺 `image-split→image` 断言 | ⏳ 待补 | 建议补单测防回归 |
| `expandSplitResults` 幂等/重建单测 | ⏳ 待补 | 建议补单测防回归 |
| 用户端重打包 exe 后实际缩放 | ⏳ 待用户确认 | 已提供新 exe，需用户双击验证 |

## 五、桌面手工验收路径（建议顺序）

1. 导入/使用一张大图到「图片拆分」，设置 2×2，运行；
2. 确认拆分结果自动展开为 4 个图片节点 + 4 条 `out-image→in-image` 连线；
3. 再点运行一次，确认不重复展开（幂等）；
4. 更换原图后重跑，确认旧展开节点重建为新的；
5. 确认「调整拆分」按钮在节点底部；
6. 打开内容较多的文本/JSON 节点，滚轮在节点内部应滚动正文、不在画布上平移；
7. 未选中任何节点时，按住 Ctrl 滚轮应缩放画布（需用重打包的 exe）。

## 六、下一步唯一推荐项

补上 `expandSplitResults` 的自动化单测（幂等 + 连线 + 重建），并补
`image-split→image` 连线矩阵断言；随后按第五节在打包版完成桌面冒烟，特别是拆分自动
展开的幂等与换图重建。之后再评估已知遗留（右键编辑文本节点）。

## 备注

- 本次未新增 API Key、媒体、SQLite 或打包产物到仓库；`out/`、`dist/` 仍在 gitignore。
- `npm run build:unpack` 已在 2026-09-04 17:39 完成，`dist/win-unpacked/canvas-studio.exe`
  为最新（含接管逻辑），可直接用于桌面验收；打包前请先关闭运行中的旧 exe。
- 完整交接流程、契约门禁与不可提交内容见根 [HANDOFF.md](../HANDOFF.md) 与
  [NODE_CONTRACT_SPEC.md](../NODE_CONTRACT_SPEC.md)。