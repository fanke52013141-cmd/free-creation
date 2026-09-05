# 节点与画布 QA 审查报告（2026-09-05）

## 结论摘要

- **代码级功能与契约回归：通过。** `npm run verify` 通过，67 个测试文件、847 个测试全部通过；类型检查和 Electron/Vite 构建通过。
- **节点契约覆盖：通过。** 当前生成的能力矩阵包含 23 个可暴露能力；MCP、CLI、Headless 标志和输入/输出快照由契约测试校验。
- **连线与并行路径：代码级通过。** 连线兼容矩阵 84 项通过，手动运行、输出投影、拓扑和 Headless Runner 测试通过。
- **浏览器像素级验收：未完成。** 当前 Codex In-app Browser 拦截 `http://127.0.0.1:5173/`（`net::ERR_BLOCKED_BY_CLIENT`），且当前会话没有可控制的桌面窗口或 Chrome 实例。因此按钮遮挡、节点底部色条重叠、悬浮提示和真实供应商媒体执行不能被宣称为已完成浏览器实测。

## 验证证据

### 自动化回归

| 检查 | 结果 |
|---|---|
| `npm run lint` | 0 个错误，131 个 Prettier 格式警告 |
| `npm run typecheck` | Node/Web 均通过 |
| `npm run test` | 67 files / 847 tests 全部通过 |
| `electron-vite build` | 主进程、preload、renderer 均构建通过 |
| `test/connection-matrix.test.ts` | 84 项连线兼容性测试通过 |
| `test/node-contract-snapshot.test.ts` | 139 项节点契约快照测试通过 |
| `test/agent/contract-consistency.test.ts` | MCP/CLI/矩阵一致性与幂等性通过 |
| `test/manual-run.test.ts` | 单节点手动运行路径通过 |
| `test/projectNodeOutputs.test.ts` | 37 项输出投影测试通过 |
| `test/agent/headless-runner.test.ts` | Headless 图运行路径通过 |

### UI 代码审查证据

- `NodeCardView` 将节点级运行按钮独立放到卡片右上方，说明按钮仍留在标题行。
- `.node-color-bar` 的最终级联样式位于 `ui-surfaces.css`，颜色条在卡片底部，仅保留下方圆角；卡片通过 `padding-bottom: 8px` 为色条留出空间。
- 选中节点使用圆角卡片的虚线边框，tldraw selection outline 使用虚线描边。
- `DataEdgeLayer` 在 tldraw `tick`/`resize` 时重新换算端点，解决缩放、平移时连线滞后一帧的问题。
- 预览窗口通过 portal 挂到 `body`，关闭按钮有 `pointerdown`/`click` 事件隔离，连线层也跳过 `.media-preview-mask`。
- 所有标准节点默认尺寸统一为 `340 × 260`；节点颜色、标题、序号和状态信息均由统一卡片结构渲染。

## 节点功能、输入输出与自动化覆盖

端口类型中的 `text` 与 `markdown` 可互连；`json` 端口还会进行 Schema 校验；`any` 端口允许通用传递。下表来自当前生成的 `generated/agent-contracts.json` 快照。

| 节点 | 输入 | 输出 | 主要用途/设置项 | 当前结论 |
|---|---|---|---|---|
| 文本 | `in-text:text` | `out-text:text` | 可编辑文本；`text` | 契约、手动运行通过 |
| 图片 | `in-image:image` | `out-image:image` | 图片资产源；`mediaId` | 契约、持久化通过 |
| 裁剪 | `in-image:image` | `out-image:image` | 固定比例/自由裁剪；`mode`、`ratio`、`cropRect` | 配置与执行器通过 |
| 拆分 | `in-image:image` | `out-image:image`、`out-images:json` | 网格拆分；`rows`、`cols`，运行时生成图块列表 | 配置与执行器通过 |
| 生图 | 图片、参考图、提示词 JSON、文本 | `out-image:image` | 供应商、模型、画幅、参考图 | 契约与引用映射通过；真实供应商未在浏览器验证 |
| 修改 | 原图、文本说明 | `out-image:image` | 供应商、模型、mask/标注 | 配置与媒体执行测试通过 |
| 视频 | 首帧、尾帧、参考图/视频/音频、提示词、文本 | `out-video:video` | 供应商、模型、时长等 | 契约通过；真实供应商未在浏览器验证 |
| 取帧 | `in-video:video` | `out-image:image` | 首帧、尾帧或时间点、数量 | 视频转换测试通过 |
| 截取 | `in-video:video` | `out-video:video` | `startTime`、`endTime` | 视频转换测试通过 |
| 提取音频 | `in-video:video` | `out-audio:audio` | 视频时间范围内提取音轨 | 视频转换测试通过 |
| 人声分离 | `in-audio:audio` | 人声、伴奏两个音频口 | 快速/高质量分离 | 主进程相关测试通过；真实模型未浏览器验证 |
| 音频 | `in-audio:audio` | `out-audio:audio` | 音频资产源与预览；`mediaId` | 契约通过 |
| 配音 | `in-text:text` | `out-audio:audio` | 文本转语音 | 契约通过；真实供应商未浏览器验证 |
| 语音克隆 | 参考音频、文本 | `out-audio:audio` | voice、speed；ComfyUI/IndexTTS | 契约通过；真实本地模型未浏览器验证 |
| 对话 | `in-text:text` | `out-markdown:markdown` | provider、model、system prompt、temperature | MCP/CLI/手动路径通过 |
| JSON | JSON、文本 | `out-json:json` | JSON 输入、格式校验 | 契约/Schema 测试通过 |
| 结构数据 | JSON、文本上下文 | `out-json:json` | `schemaId` 与结构化字段 | 契约测试通过 |
| 代码 | 文本、JSON | `out-output:any` | 代码及动态变量端口 | 代码契约与离线运行通过 |
| 处理 | `in-value:any` | `out-value:any` | 通用透传或固定值 | 执行器测试通过 |
| 循环 | `in-list:json` | 当前项、结果列表 | `variableName`，逐项运行 | 迭代测试通过 |
| 分镜板 | JSON、文本 | 分镜 JSON、文本摘要 | 分镜卡片编辑与导出 | 编辑器/契约测试通过 |
| AI 处理 | 文本、JSON | 文本、Markdown、JSON | provider、model | 执行器与输出投影通过 |
| 3D 预演台 | 分镜、参考图、相机预设 | 帧、预览视频、相机、工程 | 预演空间与发布 | 数据/输出投影通过 |

## 并行与组合链路

已由代码测试覆盖的组合包括：

1. 文本 → 对话 / AI 处理 / 生图 / 视频 / 配音。
2. 图片 → 裁剪 / 拆分 / 修改 / 生图；拆分列表 → 循环。
3. 视频 → 取帧 / 截取 / 提取音频；提取音频 → TTS 参考语音；取帧结果 → 图片处理。
4. 音频 / TTS → TTS 参考语音；音频 → 人声分离。
5. JSON / 结构数据 → 生图、视频、代码、循环、分镜板。
6. 分镜板 → 3D 预演台；预演视频 → 视频运动参考。
7. 多输入端口的 cardinality、必填输入、Schema 不匹配和非法媒体类型均有拒绝测试。

这些是执行器、契约和 Headless 层面的并行验证，不等同于鼠标在浏览器中拖拽并运行多个节点；后者仍需桌面验收。

## 当前问题与风险

### P0：浏览器实时审查被环境阻塞

本地 Vite 服务仍在运行，但 Codex In-app Browser 对 `localhost/127.0.0.1` 返回 `net::ERR_BLOCKED_BY_CLIENT`，当前会话也没有可控桌面窗口。没有合法的浏览器画面，就不能证明像素级遮挡、悬浮提示、浅色主题可读性和滚动交互已经通过。

### P1：浏览器演示模式不执行真实媒体能力

`browserMock.ts` 明确将媒体导入、裁剪、视频取帧/截取/提音、图片生成/修改设为 MOCK 失败，并将 ffmpeg/ffprobe/人声分离能力报告为不可用。这是演示限制，不代表 Electron 主进程实现失败，但必须在桌面应用中验收。

### P2：待清理的工程质量项

- 131 个 Prettier 警告集中在既有文件，当前不影响构建或测试，但建议单独格式化提交。
- 构建有 `bodies/shared.tsx` 动态导入与静态导入并存的 Vite 提示，不影响产物，但可整理模块边界。
- `.conn-*` 与 `.data-edge-*` 两套连线样式仍同时存在；当前业务线由 `DataEdgeLayer` 使用 `.data-edge-*` 绘制，旧样式可在视觉验收后清理，避免未来误改。
- 运行按钮浮动在 `top: -34px`，状态徽章最大宽度 116px；长标题或极窄节点是否与标题行重叠必须通过真实窗口确认。

## 本机验收清单

1. 打开桌面开发版，依次创建 23 类节点，确认标题、序号、说明按钮、运行按钮和底部色条不互相遮挡。
2. 将节点缩放到最小、最大并切换深色/浅色主题，检查标题、提示、下拉框和底部操作区。
3. 测试文本双击输入、输入输出面板回写、图片预览关闭、视频预览关闭。
4. 实际拖拽并运行：文本→对话、图片→裁剪→拆分、视频→取帧/截取/提音、音频→人声分离、JSON→结构数据→代码。
5. 对两条或以上分支同时运行，检查运行状态、输出投影、错误提示和连线是否仍绑定节点。
6. 放大、缩小、平移画布后再次检查连线端点是否贴合端口；选中连线、右键空白处和预览弹窗关闭分别验证事件隔离。

## 建议的下一步

提供一个可控的桌面窗口或允许访问本地开发页的浏览器会话后，按上面的验收清单做一次截图/录屏回归；同时增加一组固定 viewport 的视觉回归截图，才能把“未确认的 UI 风险”收敛为可自动阻断的测试。
