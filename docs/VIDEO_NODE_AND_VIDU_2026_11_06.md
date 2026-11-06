# 2026-11-06 视频节点 UI 与 Vidu 能力修复

## 背景

用户反馈：
1. 图片节点生成中仍能点开正文里的模型下拉；
2. 加载态星尘看起来像一颗颗明显的圆点（低分辨率感）；
3. Vidu Q3 选择后看不到「多参」「首尾帧」，Q4 只能多参；
4. 视频节点预览有大黑边，底部有复制/复制节点按钮多余；
5. 视频截取/抽帧工作台会整体上下滚动、切换抽帧有时无效、关闭按钮偶尔关不掉。

## 一、生成中屏蔽正文交互

- `app.css` 中 `.node-execution-overlay` 由 `pointer-events: none` 改为 `auto`：遮罩覆盖正文时吃掉点击，避免生成中打开模型选择器；节点标题栏 z-index 更高，停止/查看仍可点。
- 生成中同时禁用底部操作条：`.node-card:has(> .node-execution-overlay) .node-standard-action-bar { pointer-events:none; opacity:.55 }`。

## 二、星尘更柔

- `StarDustField` 光点贴图核心从 0.98 收缩到 0.72 并前移衰减，外围光晕透明度减半；
- 星点基础尺寸与绘制半径缩小约 25%，整体透明度下调；减少“圆盘”边缘感。

## 三、Vidu 能力对齐官方 CLI（vidu-cli 0.2.36）

官方 `task submit` 文档：
- `3.2`（Q3）支持 `text2video` / `img2video`（首帧）/ `headtailimg2video`（首尾帧）/ `character2video`（1–7 张参考图），官方时长 1–16s（界面保留 4s 起档位），分辨率 1080p；
- `3.4`（Q4）只开放 `character2video`（参考生视频，可带参考音频），540p–4k，1–16s。

代码修改：
- `src/shared/video-capabilities.ts`：Q3 modes 改为 `text / first-frame / first-last-frame / reference`，Q4 保持 `reference`；时长档位 4–16（默认 4s）；Q3 支持参考图（最多 7 张）；`requiresVisualReference` 仅 Q4 为真。
- `src/shared/vidu-cli.ts`：按 mode 映射 `--type`；首帧 1 张、首尾帧 2 张、参考 1–7 张、文生 0 张；时长 1–16；首帧/首尾帧不传 `--aspect-ratio`（由图片推导），文生/参考传画幅；Q4 仅参考模式。
- `src/main/gateway/vidu-cli.ts`：图片选择按 mode 取首帧/尾帧/参考图；时长缺省时走能力默认 4s。
- `src/main/ipc/models.ipc.ts`：Q3 名称改为「文生/首帧/首尾帧/参考生视频」。
- 测试更新：`test/vidu-cli.test.ts`、`test/video-capabilities.test.ts` 覆盖新映射（25 passed）。

## 四、视频节点

- 预览区固定 16:9：`.video-thumbnail-wrap .node-media { aspect-ratio:16/9 }`，16:9 素材铺满，竖屏素材内部 contain 居中，不再被节点高度拉出大黑边。
- 底部操作仅保留「替换」「视频截取」「抽帧」，三个按钮等宽均分并补图标；删除「复制节点」按钮，保留「定位居中」图标。

## 五、视频截取 / 抽帧工作台

- 双栏布局：左视频预览 + 时间轴，右参数面板；面板内部独立滚动（滚动条隐藏），整个工作台不再上下滚动；
- 头部标签（视频截取/抽帧）点击时 `stopPropagation`，外部 `initialMode` 变化会同步 `mode`，修复切换无效；
- 关闭更可靠：遮罩改为在 `pointerdown` 命中遮罩时关闭；关闭按钮在 `pointerdownCapture` 即关闭，避免下拉层吞掉点击；
- 视觉对齐 Stitch 参考稿：青色 `#3cdde3` 仅用于主按钮与时间轴切点，主按钮改实心青色（去掉渐变与发光），边框统一发丝线。

## 日志影响

- 视频生成提交/轮询沿用既有 gateway 诊断事件（`gateway:*`、`node.run.*`），本次仅修改参数映射与 UI，不新增日志字段；
- 未改变数据库/Schema；关闭、遮罩、星尘属纯 UI。

## 未覆盖边界

- 未运行真实 Vidu 付费任务验证 Q3 参考/文生；以官方 CLI 文档与单测为准（`test/vidu-live-smoke` 仍为跳过态）。
- Stitch 参考稿为 2560×2048 桌面画布，未逐像素比对；落地按 1152×860 收紧。
- 视频工作台未在 ffmpeg 缺失场景逐项截图验证。

