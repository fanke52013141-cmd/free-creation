# 时间线节点（`timeline`）接入台账

日期：2026-11-02 · 范围：画布新增时间线节点（M1–M5）· 方案：[时间线轨道节点方案 v1.1](../../时间线轨道节点方案-v1.1.md)

## 1. 本次变更

| 类别 | 内容 |
| --- | --- |
| 节点类型 | `ACTIVE_NODE_TYPE_IDS` 新增 `timeline`（可创建，`contractVersion: 1`） |
| 节点契约 | 输入 `in-video` video many / `in-audio` audio many / `in-image` image many；输出 `out-video` video（可选）；`outputSource: 'run'` |
| 尺寸机制 | `NodeTypeSpec.sizePolicy: 'standard' \| 'content' \| 'free'`；分镜板改 `content`，时间线为 `free`（默认 880×420，宽高自由） |
| 新 IPC | `media:timeline-compose`（多素材合成）、`media:probe-metadata`（素材元数据只读探测） |
| 新 preload 通道 | `composeTimeline`、`probeMediaMetadata` |
| 新主进程模块 | `media/ffmpeg-runner.ts`（公共 spawn/进度/取消登记）、`media/media-probe.ts`、`media/timeline-compose.ts` |
| 新共享模型 | `shared/timeline.ts`（时间线 JSON 模型与纯函数编辑） |
| 访问声明 | `NODE_ACCESS_DECLARATIONS` 增加 `timeline`，与 Active 清单保持一致 |

## 2. 兼容性结论（接口 Schema 变化）

`node.type.list` 的**输出** Schema 中的节点类型枚举新增 `timeline`。这是**加法变更**：

- 字段、必填性、operationId 与 transport 均未改变；
- 已有消费方读取该列表不受影响，只是多出一个合法取值；
- 未新增或修改任何 `ACCESS_OPERATIONS` 的输入 Schema；
- 节点动作仍为 `planned`：本次**没有**声称时间线可由外部 Agent 自动执行。

因此本次以 `--accept-contract-change` 显式确认，而不是静默刷新哈希。

## 3. 持久化与迁移

- 时间线内容存 `props.text`（JSON，`schemaVersion=1`），不新增 tldraw shape prop，无快照 schema 迁移。
- 片段媒体引用使用独立字符串字段 `mediaId` / `mediaPath`，进入既有项目包导入重映射链路
  （`shared/media-reference-remap.ts`、`main/store/transfer.ts`、`flow-transfer.ts`）。
- 已知边界：画布**结构导出**会按 key 正则丢弃 `media*` 字段，时间线经结构导出再导入会丢素材引用；
  这不是本次引入的新行为，时间线迁移请使用项目复制 / 项目包。

## 4. 日志影响

- 执行器 `shared/engine/executors/timeline.ts` 记录 `input` / `execution` / `result` 阶段，只含轨道数、
  片段数、总时长与画布尺寸；不记素材路径、文件名、媒体 ID 或用户正文。
- 成功/失败/取消的**唯一终态**仍由公共运行器记录，执行器不重复记终态。
- 主进程合成阶段（prepare/render/mux）目前未发独立诊断事件，已登记到
  [日志覆盖清单](../LOGGING_COVERAGE.md)「时间线合成」行的待补内容。

## 5. 验证证据

| 检查 | 结果 |
| --- | --- |
| `npm run typecheck:node` / `typecheck:web` | 通过 |
| `test/timeline-model.test.ts`（模型：解析/摆放/重叠/裁剪/分割/总长） | 24 项通过 |
| `test/media-probe.test.ts`（真实 ffprobe 探测视频/音频/图片） | 13 项通过 |
| `test/timeline-compose.test.ts`（真实 ffmpeg 合成：拼接/图片静帧/截断） | 5 项通过 |
| `test/timeline-executor.test.ts`（执行器 → 合成 → emitArtifact 全链） | 5 项通过 |
| `test/node-compliance` / `node-contract-snapshot` / `compliance-matrix-doc` / `node-color-spec` / `palette-menu-order` / `migration` | 全部通过 |
| `npm run verify:agent-access` | 本文件与快照同步后通过 |
| `npm run lint`（本次改动文件） | 通过 |

## 6. 未覆盖边界

- 卡片内**跨片段连续播放预览**未实现（本期只有播放头与单片段信息；成片预览在运行后由视频资产节点提供）。
- 时间轴缩放只提供档位按钮；`Ctrl+滚轮` 缩放需要给 `canvas-wheel-routing` 加白名单，未做。
- 磁性吸附、转场、变速、音量调节、多轨视频叠加渲染未实现。
- FFmpeg 仍由用户自备（`CANVAS_STUDIO_FFMPEG_PATH` 或 PATH）；缺失时是显式阻塞原因。
- 画布结构导出不含时间线素材引用（见第 3 节）。
