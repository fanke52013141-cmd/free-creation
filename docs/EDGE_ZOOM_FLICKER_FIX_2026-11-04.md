# 快速缩放时连线闪烁收敛（2026-11-04）

## 用户问题

「快速地放大缩小，整个画面还是会闪；主要是**连线**在放大缩小时会闪，不是节点。」

此前已做过两轮修复（详见 `WHEEL_FLICKER_FIX_2026-10-05.md`、`EDGE_ZOOM_FLICKER_FIX_2026-11-02.md`）：
背景搬到屏幕空间、连线层改为页面坐标 + 镜像相机 transform、去掉逐帧 JS 重算。用户复验后
仍有「没有原来那么频繁，但还是会闪」。

## 排查过程（真机测量）

用用户真实工程（46 节点 / 21 条数据连线，复制为一致性快照后启动，避免污染原数据）逐项测量：

1. **镜像同步**：逐帧对比 `.tl-shapes` 与 `.data-edge-frame` 的 `style.transform`，
   2 轮各 70+ 帧、0 错帧 —— 连线与节点的坐标系是同步的，不是「线脱开」问题。
2. **主线程**：rAF 间隔 p50 ≈ 16.7ms（60fps），主线程不阻塞。
3. **合成器**：Chrome tracing 的 DrawFrame 间隔在缩放期间 p50 ≈ 52–60ms、p95 ≈ 200ms，
   说明瓶颈在**绘制/光栅化**而不是 JS。
4. **成本归因**（隐藏元素对照）：隐藏节点、隐藏连线、隐藏视频、去掉卡片阴影等单项收益都在
   10–20% 量级，没有单一大头；连线层自身的两个高风险项是：
   - 每条连线两条 path 都挂 SVG `filter: drop-shadow()`（底线 5px、流光 7px）；
     滤镜在相机缩放的每个离散倍率都要重新光栅化整层，异步完成前该层可能空一帧；
   - 1.5px 的页面坐标线宽在高倍率下退化为**亚像素细线**，缩放时抗锯齿结果不稳定，
     表现为细线忽明忽暗；
   - 流光 `edge-water-flow` 是无限动画，每帧都让连线层失效重画，与缩放缓存的
     重光栅化抢同一帧预算；
   - 顶栏 `backdrop-filter: blur(14px)` 在缩放期间每帧重采样整屏背景。

## 改动

1. **连线去掉 SVG 滤镜，改用叠加描边做光晕**（`DataEdgeLayer.tsx` + `ui-surfaces.css`）：
   - 新增 `.data-edge-glow`：7px、透明度 0.16 的同色描边垫在实线下面，视觉等价于原来的
     `drop-shadow(0 0 5px)`，但完全不走滤镜管线；
   - 普通线、追溯线都加光晕；失效边保持红色虚线无光晕；
   - 去掉 `.data-edge-visible` / `.data-edge-flow` 的 `filter`，`transition` 只保留 opacity；
   - hover / selected 改为加深光晕透明度，不再依赖滤镜。
2. **线宽改为屏幕空间恒定**：所有可见连线 path 加 `vector-effect="non-scaling-stroke"`。
   缩到 20% 时线仍是 1.5 屏幕像素，不会退化成亚像素细线；放大时也不会变成粗条。
3. **相机交互期间冻结连续动画**（`ui-foundation.css`）：
   `.canvas-host.is-camera-interacting * { animation-play-state: paused }` —— 流光、节点状态
   脉冲等每帧失效重画的动画在缩放期间暂停，停止 220ms 后自动恢复（不改变静止观感与动画节奏）。
4. **相机交互期间关闭顶栏背景模糊**：`backdrop-filter: none`，停止后恢复（顶栏本身是 92%
   不透明的渐变底，视觉差异可忽略）。

## 验证

- 计算样式核对（真机）：`.data-edge-visible` = `filter:none / stroke-width:1.5px /
  vector-effect:non-scaling-stroke`；`.data-edge-glow` = 7px 同属性；`.data-edge-flow` = 2.25px。
- 视觉核对：100% 与 45% 缩放下连线均正常显示为「细实线 + 柔和光晕 + 流光段」，
  穿透节点处由 mask 正确裁剪，无断线、无重影（截图：`edge-visual-100.png` / `edge-visual-out.png`）。
- 逐帧镜像 transform 与 `.tl-shapes` 仍保持 0 错帧。
- 单测：`canvas-interaction`、`node-ui-decisions`、`edge-geometry`、`edge-visual-extents` 共 134 项通过；
  全量 `npm test` 通过（唯一失败为既有的 indextts 供应商预设用例，与本改动无关）。
- `typecheck:web`、`eslint`、`electron-vite build` 通过。

## 日志影响检查

依据 `LOGGING_SPEC.md` 与 `docs/templates/LOGGING_CHANGE_TEMPLATE.md`。

- 受影响文件：`canvas/DataEdgeLayer.tsx`、`assets/ui-surfaces.css`、`assets/ui-foundation.css`、本文档。
- 分类：不涉及业务日志。只改渲染层（SVG 材质、线宽策略、动画暂停与顶栏材质），不改变节点
  执行、模型请求、网络、文件、数据库、保存恢复或业务错误行为；不新增逐帧日志。
- 验证：见上；`npm run verify:logging` 通过。
- 盲区：浏览器/真机测量无法完全等同用户当前 GPU/驱动环境；本次消除的是「滤镜异步重光栅 +
  亚像素细线 + 动画抢帧」三类已知机制，主观顺滑度仍需用户在实际窗口复验（旧进程需退出重开）。

## 回滚

恢复 `DataEdgeLayer.tsx` 的 `vector-effect` 与 `.data-edge-glow` 路径，以及 `ui-surfaces.css`
中滤镜与 `.data-edge-glow` 规则、`ui-foundation.css` 中相机交互期间的动画/模糊覆盖即可。
