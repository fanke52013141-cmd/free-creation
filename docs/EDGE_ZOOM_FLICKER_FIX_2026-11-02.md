# 快速缩放时连线闪烁修复 + 连线流光降速

## 用户问题

2026-11-02 用户反馈：

1. 快速放大/缩小时整页像"一闪一闪"，尤其是连接线会先消失、再出现，不像其他网页端无限画布那样顺滑；希望做到"极致体验"。
2. 连线对应的流动动画速度太快，改成现在的 1/3。

## 原因

`DataEdgeLayer` 采用**屏幕坐标 SVG**，相机每变化一次就要把整层连线重算一遍：

- `src/renderer/src/canvas/DataEdgeLayer.tsx`（改动前）：`editor.on('tick')` + `requestAnimationFrame` + `setRevision`，每帧触发一次 React 全量重渲染；每条连线的 `d`、`strokeWidth`（`* zoom`）、`drop-shadow` 模糊半径（`5 * zoom` / `7 * zoom`）、`strokeDasharray`（`* zoom`）与 `<mask>` 全部按新 zoom 重写。
- `.data-edge-visible` 的 CSS `transition` 包含 `filter`（`ui-surfaces.css` 旧 2378-2387 行）。滤镜半径每帧变化 → 每帧重启一次 140ms 的滤镜过渡，整层滤镜持续重算。
- 节点卡片在 tldraw 的相机变换层（`.tl-html-layer.tl-shapes`，inline `transform: scale(z) translate(x, y)`）里，由合成器整体缩放；连线却在 rAF 里用 `pageToScreen` 另算。快速缩放时两者提交时机不同，连线会滞后一帧，视觉上就是"线脱开/闪一下/消失再出现"。
- tldraw 4.5.12 把相机放在实例状态（session）里，旧实现同时监听 `session`（`DataEdgeLayer.tsx` 旧 294-320 行），于是每次相机变化还会额外触发一次全量 React 渲染。

改动前用浏览器验收脚本做 48 帧快速相机扫描（8 节点 / 7 条线，基准见 `qa/edge-zoom-flicker-2026-11-02/before-baseline.json`）：

| 指标（48 帧）                        | 改动前 |
| ------------------------------------ | ------ |
| 连线 `path` 的 `d` 重写次数          | **975** |
| `style` 中 filter / stroke-width 重写 | **1260 / 1260** |
| 整层 computed filter 取值种数        | **25**  |
| 帧间隔 p95 / max                     | 45.9ms / 64.3ms |

## 改动

1. **`src/renderer/src/canvas/DataEdgeLayer.tsx`：连线层进入相机变换空间**
   - 几何只依赖页面坐标（`getShapePageBounds`、端口 offset、`NODE_PORT_OUTSET`）；屏幕位置交给与 tldraw 完全一致的 CSS transform：`MutationObserver` 监听 `.tl-shapes` 的 inline `style`，把同一个 `scale(z) translate(x, y)` 字符串镜像到 1×1 的 `.data-edge-frame`（与 `.tl-html-layer` 同尺寸、同默认 `transform-origin`，浏览器绘制前回调，同帧对齐）。
   - 删除 `tick` / `resize` / `session` 监听：相机变化不再触发任何 React 渲染，只有文档变化（位置、端口、节点尺寸、连线）才重算。
   - 光晕、线宽、虚线间隔改为页面单位（`filter: drop-shadow(0 0 5px currentColor)`、`stroke-width: 3` 等）。由于层坐标 = 页面坐标，它们在屏幕上的观感与旧的 `* zoom` 完全等价，但**不再随缩放变化**，滤镜过渡不再每帧重启。
   - `<mask>` 使用页面坐标，范围由节点边界并集外扩得到（`src/renderer/src/canvas/edge-visual-extents.ts`），只随文档变化。
   - 命中路径改页面坐标：`isPointInStroke` 的点由 `svg.getScreenCTM()` 反变换得到；容差用 `--edge-hit-width`（`14 / zoom`，由相机同步回调写入）保持屏幕空间恒定 14px。悬浮、选中、剪刀删除与端口 27px 优先级全部保留。
   - 追溯线（`artifact:`）只可视化、不可交互：命中路径只对非 `provenance` 边渲染，`hitTest` 另加 `artifact:` 兜底（复核阶段发现的回归：追溯线误注册命中路径会吞掉点击/框选并写入伪选中 ID，已修复并有浏览器断言守护）。
   - 用 `.data-edge-clip`（`inset: 0; overflow: hidden`）负责按画布视口裁剪——1×1 的镜像层自身无法裁剪。
2. **CSS**：新增 `.data-edge-clip` / `.data-edge-frame` 层结构；`.data-edge-visible` 基色光晕改 `currentColor`；失效边虚线仍由组件 inline 给出（保持"单一来源"）；相机交互期间 `.data-edge-frame` 与节点层一起提升合成层（`will-change: transform`）。
3. **`CanvasEditor.tsx`**：`DataEdgeLayer` 不再需要 `hostRef`。
4. **动画降速（用户裁决）**：`.data-edge-flow` 由 `1.35s` → `4.05s`（1/3）；拖拽预览 `.conn-water-path` 由 `1.6s` → `4.8s`（同一视觉语言同步降速）。`pathLength="1000"` 的脉冲仍占整条路径，降速前后屏幕速度关系一致，只是整体慢 3 倍。

改动后同一脚本同一条件：

| 指标（48 帧）                        | 改动前 | 改动后 |
| ------------------------------------ | ------ | ------ |
| 连线 `path` 的 `d` 重写次数          | 975    | **30**（全部来自 4 次节点自动高度校正） |
| `style` 中 filter / stroke-width 重写 | 1260 / 1260 | **0 / 0** |
| 整层 computed filter 取值种数        | 25     | **1** |
| 镜像 transform 与 `.tl-shapes` 一致  | —      | **是（且元素坐标完全重合）** |
| 流光动画时长                         | 1.35s  | **4.05s** |

## 日志影响检查

依据 `LOGGING_SPEC.md` 与 `docs/templates/LOGGING_CHANGE_TEMPLATE.md`。

- **影响判断**：不涉及业务日志。本次只改渲染层（SVG 坐标空间、CSS 材质、命中几何）与动画时长，不改变节点执行、模型请求、网络、文件、数据库、保存恢复与业务错误行为；不新增任何逐帧/逐连线日志（高频事件，规范明确禁止），日志写入失败与业务结果无关。
- **事件与职责**：开始/成功/失败/重试/恢复路径均不适用。
- **字段与失败语义**：不适用，未新增关联 ID、错误码或诊断事件。
- **验证**：见下节；`npm run verify:logging` 通过。
- **盲区**：无新增日志覆盖需求。

## 验证

```powershell
# 浏览器验收服务（独立终端）
pnpm dev:browser

# 连线缩放回归：镜像 transform、端点贴合端口、缩放期间零几何/滤镜重写、流光 4.05s、悬浮/选中/删除
node scripts/test-browser-edge-zoom-stability.cjs

# 原有滚轮材质稳定性
node scripts/test-browser-wheel-stability.cjs

# 单测与静态检查
node scripts/run-vitest.cjs run test/edge-geometry.test.ts test/edge-visual-extents.test.ts test/canvas-interaction.test.ts test/canvas-wheel-routing.test.ts test/canvas-dark-theme.test.ts --maxWorkers=1 --minWorkers=1
npm run lint
npm run typecheck
npm run verify:logging
```

结果：回归脚本 PASS。覆盖范围（不是只看"有没有报错"）：
- 4 个缩放档位（0.5 / 1 / 2 / 2.8）× 每一档的每一条连线都单独聚焦量测：端点与对应端口偏差 < 0.01px；镜像 transform 与 `.tl-shapes` 微任务级一致；命中宽度恒为 14/zoom；可见连线数量恒为 3。
- 页面坐标 mask：每个节点都有一条 black 挖空矩形且与 `getShapePageBounds` 完全一致，mask 覆盖范围包含全部节点。
- 只动相机的 36 帧扫描：`d` / filter / stroke-width 重写均为 0，文档变更 0，镜像 transform 每帧一致，流光 computed filter 只有一种取值，可见连线数不跳变（并断言精确条数，避免"数量为 0 也算稳定"）。
- 追溯线：正常绘制、没有命中路径、悬浮无剪刀、点击不产生伪选中。
- 交互：0.7 / 1 / 2.8 三个倍率都验证"悬浮出剪刀 → 按下选中正确连线 → 移开剪刀消失"，中倍率再验证真实点击剪刀删除。

定向 33 项单测通过；lint、node/web 类型检查、日志门禁、生产构建通过。证据目录 `qa/edge-zoom-flicker-2026-11-02/`（`evidence.json`、各档位截图、改动前后指标）。

## 边界（未覆盖 / 需人工复验）

- 浏览器验收运行在 headless Chromium 的软件光栅下，帧耗时不能代表 Electron 的真机 GPU 合成；本修复消除的是"每帧 JS 重算 + 滤镜/遮罩重光栅 + 连线与节点不同帧提交"，桌面版的主观顺滑度仍需用户在实际窗口复验（旧安装包需退出重开）。
- `AgentFlowRelationLayer`（控制关系虚线）仍是屏幕坐标逐帧重算，仅当画布存在 agent / 状态机 / AI 审核节点时出现；本包未改动，列为后续同类优化候选。
- 未替换正在使用的 `current-source-release` 安装包；`current/` 目录未动。

## 回滚

恢复 `DataEdgeLayer.tsx`、`CanvasEditor.tsx` 的调用参数，以及 `ui-surfaces.css` / `ui-foundation.css` 中 `.data-edge-*` 与 `edge-water-flow` 时长即可；`edge-visual-extents.ts` 与两个验收文件可一并删除。
