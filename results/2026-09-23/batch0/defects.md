# Canvas Studio 基线缺陷报告（batch0 · 自动门禁）

候选版本：53c738e · 2026-09-23 · 状态：OPEN（仅记录，未修改业务代码）

> 说明：以下为基线自动门禁直接发现的失败。`npm run test`、`npm run lint`、`npm run test:node-matrix`
> 均在 53c738e 上不通过。是否属于「测试断言过时」还是「真实回归」需要逐条核对源码定界。

## A. lint 错误（7 处，`npm run lint` 退出码 1）

| 文件 | 位置 | 规则 | 内容 |
|---|---|---|---|
| packages/model-runtime/src/memory.ts | 23:90 | explicit-function-return-type | 函数缺返回类型 |
| src/renderer/src/canvas/ConnectionLayer.tsx | 75:23 | explicit-function-return-type | 函数缺返回类型 |
| src/renderer/src/canvas/DataEdgeLayer.tsx | 270:3 | react-hooks | 渲染期间访问 ref（useRef.current） |
| src/renderer/src/gateway/…（ProvidersPanel 相关） | 61:36 | react-hooks/set-state-in-effect | effect 内同步 setState |
| src/renderer/src/gateway/ProviderSettingsPanel.tsx | 117:20 | react-hooks/set-state-in-effect | effect 内同步 setState |
| src/renderer/src/nodes/specs/bodies/voice-design.tsx | 621:18 | no-constant-binary-expression | && 左侧恒真 |

## B. 单测失败（13 处，5 个文件；`npm run test` 退出码 1）

### B1. node-ui-decisions.test.ts（5 失败）
多为「读取源文件并断言包含某代码结构」的结构断言，与最近的节点调色板 / bodies 拆分改动疑似不同步：
1. §16.7 命名统一 > 左侧面板与节点同名（期望源含 `palette-label`）
2. §16.10 > 兼容端口浮出名称标签（期望源含 `port-label`）
3. §16.10 > tooltip 走 portHint 单一入口（期望源含 `function portHint`）
4. §16.13 > in-text/in-json 连线数直接呈现（期望源含 `countIncomingConnections`）
5. §16.13 > 对话节点说明来源顺序（同上）

### B2. ui-foundation.test.ts（3 失败，CSS 结构断言）
1. 连线和端口只保留低噪声的基础样式来源（缺 `.node-color-bar` 4px / flex-shrink）
2. 节点卡片保持磨砂玻璃，端口点是类型色实心圆
3. 节点外壳结构类只有一个权威来源：ui-foundation.css

### B3. canvas-interaction.test.ts（2 失败）
画布交互断言（具体用例名见 test-full.log）。

### B4. selection-geometry.test.ts（2 失败）
多选框几何断言。

### B5. media-import-real.test.ts（1 失败）
「Word/Excel/PPT/PDF 导入即抽出正文」：期望输出 5 字段，实际 4 字段（文档正文抽取链路可能少一个字段/来源）。

> 其余 1123 通过、1 跳过。完整失败明细见 `test-full.log`。

## C. 节点操作审计失败（`npm run test:node-matrix`）

浏览器驱动 UI 审计，多个节点在「配方执行」创建节点步骤超时（getByRole button name=『添加X节点』 30s 超时）：
- 文本、JSON、处理、分镜板、结构数据
- **根因已定界（batch1）：审计脚本过期，非产品回归。** 创建入口已改为两级调色板：一级分类
  （`CanvasEditor.tsx:1728` 区域）展开后才渲染二级抽屉 `.palette-node-flyout`（`aria-label=添加X节点`，
  `:1779`）。审计脚本 `audit-node-operation-matrix.cjs:296` 直接点击 `添加X节点` 而未先展开分类，
  抽屉未渲染导致 DOM 不存在而超时；脚本无任何 `palette-category-item`/`palette-node-flyout` 引用。
- 受控桌面验证（隔离数据目录 + CDP）：分类展开与「添加文本节点」均成功，`type-text` 卡片 0→1，
  新卡提示「双击输入文本」。产品真实入口可用。
- 该脚本使用浏览器模式（vite dev:browser）+ Playwright，产物为「浏览器 UI」证据，不能直接作为桌面 Electron 通过依据。

## D. 影响与优先级

- 全量自动门禁未通过 → 发布候选门槛当前不满足（TEST_PLAN §10）。
- 上述失败若为真实回归，多数落在 P1（常用能力故障/菜单卡严重不可用判据）与 P2。
- 均为「告诉用户存在，不要改业务代码」的基线记录项。