# 视频节点重构交接单（2026-08-30）

> 分支：`main`
> 远程仓库：https://github.com/fanke52013141-cmd/free-creation
> 前序交接：[docs/HANDOFF_2026_08_30_FEATURE_BATCH.md](./HANDOFF_2026_08_30_FEATURE_BATCH.md)

本轮在 `33d82e3 feat: add TTS node, video transforms, 3D director, UI system` 之上，将视频处理链路从单节点复合功能重构为四个职责清晰的独立节点，新增统一媒体时间轴组件和图片宫格拆分节点。全部变更尚未提交，本轮一次性提交并推送。

---

## 一、本轮交付概览

| 功能方向 | 涉及节点 | 契约变更 | 状态 |
| --- | --- | --- | --- |
| 视频节点 v2 重构 | `video-frame` / `video-clip` / `video-audio` | contractVersion 1→2，独立配置类型 | 已开发，需桌面端验收 |
| 独立人声分离节点 | 新增 `vocal-separate` | 新增 contractVersion 2 | 已开发，需桌面端验收 |
| 统一媒体时间轴 | `video-frame` / `video-clip` / `video-audio` | 无端口变更 | 已开发，需桌面端验收 |
| 图片宫格拆分节点 | 新增 `image-split` | 新增 contractVersion 1 | 已开发，需桌面端验收 |
| 快捷入口与模板 | `video` / `video-frame` / `video-clip` / `video-audio` / `vocal-separate` | 无端口变更 | 已开发，需桌面端验收 |

---

## 二、设计动机

上一批已将视频变换拆为三个节点（取帧 / 截取 / 提音），但仍存在以下问题：

1. **配置类型混用**：三个节点共享一个 `VideoRangeConfig`，字段交叉且无法独立演进。
2. **人声分离内嵌提音节点**：提音节点同时承载"提取音频"和"人声分离"两个职责，违反节点职责单一原则。
3. **时间轴碎片化**：每个节点各自实现滑块和预览，无法统一缩略图、波形和精确时间码。
4. **缺少快捷编排**：用户需要手动创建下游节点并连线，常用链路（提取人声）缺少一键入口。

本轮按 P0-P5 顺序解决以上问题。

---

## 三、v2 配置架构

### 3.1 独立配置类型

| 节点 | 配置类型 | 关键字段 |
| --- | --- | --- |
| `video-frame` | `VideoFrameConfig` | `mode`（`first`/`last`/`manual`）、`format`（`png`/`jpg`/`webp`）、`quality`、`timeMs` |
| `video-clip` | `VideoClipConfig` | `startMs`、`endMs`、`qualityMode`（`fast`/`high`）、`format`（`mp4`/`webm`） |
| `video-audio` | `VideoAudioConfig` | `format`（`m4a`/`wav`）、`sampleRate`（`original`/`44100`/`48000`） |
| `vocal-separate` | `VocalSeparationConfig` | `mode`（`fast`/`quality`）、`outputAccompaniment` |

所有配置版本号为 `version: 1`，节点 `contractVersion` 为 2（因为端口语义和配置结构相对 v1 有破坏性变化）。

### 3.2 解析 / 序列化函数

| 函数 | 用途 |
| --- | --- |
| `parseVideoFrameConfig` / `serializeVideoFrameConfig` | 取帧配置读写 |
| `parseVideoClipConfig` / `serializeVideoClipConfig` | 截取配置读写 |
| `parseVideoAudioConfig` / `serializeVideoAudioConfig` | 提音配置读写 |
| `parseVocalSeparationConfig` / `serializeVocalSeparationConfig` | 人声分离配置读写 |

所有解析函数对非法输入安全回退到默认配置，绝不抛出异常。

### 3.3 主进程 IPC

| IPC 通道 | 功能 |
| --- | --- |
| `generateVideoThumbnails` | 批量截取 10 帧缩略图（按总时长均匀分布） |
| `generateAudioWaveform` | 提取 300 个波形采样峰值 |
| `extractVideoFrame` | 精确提取指定时刻帧（首帧 / 尾帧 / 任意时刻） |
| `clipVideo` | 截取视频片段 |
| `extractVideoAudio` | 提取音频（支持 WAV / M4A / 采样率选择） |
| `separateVocals` | 人声分离（快速 FFmpeg / 高质量 AI 模型） |

---

## 四、统一媒体时间轴组件（MediaTimeline）

### 4.1 组件签名

```typescript
interface MediaTimelineProps {
  durationMs: number
  timeMs: number                  // 当前播放位置（受控）
  onTimeChange: (ms: number) => void
  startMs?: number                // 区间起点（截取模式）
  endMs?: number                  // 区间终点（截取模式）
  onStartChange?: (ms: number) => void
  onEndChange?: (ms: number) => void
  thumbnails?: string[]           // 10 帧缩略图 URL
  waveform?: number[]             // 300 个波形峰值（归一化 0-1）
  isPlaying?: boolean
  loopEnabled?: boolean
  onPlayPause?: () => void
  onToggleLoop?: () => void
  videoRef?: React.RefObject<HTMLVideoElement>
}
```

### 4.2 子组件

| 子组件 | 职责 |
| --- | --- |
| `Waveform` | Canvas 绘制波形条，devicePixelRatio 高清缩放，区间段粉色高亮 |
| `TimeInput` | mm:ss.mmm 格式手动时间码输入，Enter 提交 / Esc 取消 / blur 提交 |
| `ThumbnailStrip` | 10 帧缩略图横向铺满，CSS `--point` 百分比定位游标 |

### 4.3 交互能力

- 播放 / 暂停按钮，循环预览（↻）切换
- 逐帧导航（◀ ▶）按钮，步进 100ms
- 手动时间码输入（双击时间标签编辑）
- 双游标区间选择（仅截取模式）
- 缩略图条 + 波形叠加显示
- CSS 自定义属性 `--point` / `--start` / `--end` 控制滑块和区间高亮位置

---

## 五、节点逐一说明

### 5.1 video-frame（取帧）

```text
type: 'video-frame'
contractVersion: 2
输入：in-video (video, one)
输出：out-image (image)

配置：
  mode: 'first' | 'last' | 'manual'
  format: 'png' | 'jpg' | 'webp'
  quality: number (2-31, 仅 jpg/webp)
  timeMs: number (manual 模式下的取帧时刻)
```

- 三种取帧模式按钮（首帧 / 尾帧 / 手动），手动模式使用 MediaTimeline 单游标
- 缩略图条预览，点击切换到对应帧
- 快捷入口：修改（image-edit）、继续生图（image-gen）

### 5.2 video-clip（截取）

```text
type: 'video-clip'
contractVersion: 2
输入：in-video (video, one)
输出：out-video (video)

配置：
  startMs: number
  endMs: number
  qualityMode: 'fast' | 'high'
  format: 'mp4' | 'webm'
```

- MediaTimeline 双游标选择区间
- 循环预览：开启后播放从 startMs 开始，到达 endMs 自动跳回 startMs
- 快捷入口：取帧（video-frame）、提音（video-audio）

### 5.3 video-audio（提音）

```text
type: 'video-audio'
contractVersion: 2
输入：in-video (video, one)
输出：out-audio (audio)

配置：
  format: 'm4a' | 'wav'
  sampleRate: 'original' | '44100' | '48000'
```

- 波形预览（300 采样），区间高亮
- 格式与采样率选择
- 快捷入口：人声分离（vocal-separate）

### 5.4 vocal-separate（人声分离，新增）

```text
type: 'vocal-separate'
contractVersion: 2
label: '人声分离'
color: '#f472b6'
executionMode: 'async'

输入：in-audio (audio, one)
输出：out-vocals (audio)、out-accompaniment (audio, 可选)

配置：
  mode: 'fast' | 'quality'
  outputAccompaniment: boolean (默认 true)
```

- **快速模式（fast）**：FFmpeg 中置声道提取 + EQ + 降噪，零依赖、速度快
- **高质量模式（quality）**：本地 AI 模型（BS-RoFormer 等），需 Python 环境
- 双输出端口：人声始终输出，伴奏仅在 `outputAccompaniment=true` 时输出
- 从 `video-audio` 解耦，保持提音节点职责单一

### 5.5 image-split（图片宫格拆分，新增）

```text
type: 'image-split'
contractVersion: 1
label: '图片拆分'
executionMode: 'manual-publish'

输入：in-image (image, one)
输出：out-images (image[], 多宫格输出)

配置：
  rows: number (1-8)
  columns: number (1-8)
  scalePercent: number (10-100, 每格面积缩放百分比)
```

- 宫格预览实时显示分格效果
- `scalePercent` 以面积为基准（非边长），线性系数为 sqrt(percent)
- 最大 64 格（8x8），防止滥用

---

## 六、快捷入口与一键模板（P5）

### 6.1 视频资产节点（`video`）

新增"一键提取人声"按钮，点击后自动创建 `video-audio` → `vocal-separate` 链路并预连线：

```text
source(video) ──out-video──→ video-audio ──out-audio──→ vocal-separate
```

### 6.2 视频变换节点下游按钮

每个变换节点结果卡底部显示下游入口按钮：

| 当前节点 | 快捷按钮 | 创建的下游节点 |
| --- | --- | --- |
| video-frame | 修改 | image-edit |
| video-frame | 继续生图 | image-gen |
| video-clip | 取帧 | video-frame |
| video-clip | 提音 | video-audio |
| video-audio | 人声分离 | vocal-separate |

所有快捷入口只创建真实节点和真实端口连线，失败时回滚孤立节点。

### 6.3 编排函数

| 函数 | 位置 | 用途 |
| --- | --- | --- |
| `createAudioContinuation` | `specs/bodies/shared.tsx` | 从 `video-audio` 创建 `vocal-separate` 并连接 out-audio → in-audio |
| `createVocalExtractionTemplate` | `specs/bodies/shared.tsx` | 从视频资产创建 `video-audio` + `vocal-separate` 两节点链路 |

---

## 七、修改文件清单

### 新增文件（6）

| 文件 | 职责 |
| --- | --- |
| `src/shared/image-split.ts` | 图片拆分配置类型、解析函数、宫格计算 |
| `src/renderer/src/engine/executors/imageSplit.ts` | 图片拆分执行器 |
| `src/renderer/src/engine/executors/vocalSeparate.ts` | 人声分离执行器（含结果解析） |
| `src/renderer/src/nodes/specs/bodies/image-split.tsx` | 图片拆分 Body + Settings |
| `src/renderer/src/nodes/specs/bodies/vocal-separate.tsx` | 人声分离 Body + Settings |
| `test/image-split.test.ts` | 图片拆分单元测试 |

### 主要修改文件（14）

| 文件 | 变更摘要 |
| --- | --- |
| `src/shared/video-transform.ts` | 重写为 v2 独立配置类型（VideoFrameConfig / VideoClipConfig / VideoAudioConfig / VocalSeparationConfig），删除旧 VideoRangeConfig |
| `src/shared/contracts/index.ts` | 新增 `separateVocals`、`generateVideoThumbnails`、`generateAudioWaveform` IPC 类型 |
| `src/shared/types/index.ts` | `ActiveNodeTypeId` 新增 `vocal-separate`、`image-split` |
| `src/main/media/video-transform.ts` | 新增缩略图批量生成、波形采样、首帧/尾帧精确探测 |
| `src/main/ipc/media.ipc.ts` | 注册新 IPC 通道 |
| `src/preload/index.ts` | 暴露新 IPC 到渲染进程 |
| `src/renderer/src/nodes/specs/index.tsx` | 注册 `vocal-separate`、`image-split` 节点 Spec；三个视频节点 contractVersion 升级为 2 |
| `src/renderer/src/nodes/specs/bodies/video-transforms.tsx` | 全面重构：MediaTimeline 集成、Waveform 组件、TimeInput、循环预览、缩略图拉取、下游快捷按钮 |
| `src/renderer/src/nodes/specs/bodies/video.tsx` | 新增"一键提取人声"按钮 |
| `src/renderer/src/nodes/specs/bodies/shared.tsx` | 新增 `createAudioContinuation` 和 `createVocalExtractionTemplate` |
| `src/renderer/src/nodes/specs/outputProjections.ts` | 新增 `projectVocalSeparateOutputs`、`projectImageSplitOutputs` |
| `src/renderer/src/engine/executors/videoTransforms.ts` | 适配 v2 配置解析；三个执行器独立调用各自 IPC |
| `src/renderer/src/assets/app.css` | 新增完整 MediaTimeline CSS（时间轴轨道、缩略图、控制按钮、波形、区间高亮、时间码输入） |
| `src/renderer/src/canvas/CanvasEditor.tsx` | 节点面板新增 `vocal-separate` 和 `image-split` 标签 |

### 测试修改（5）

| 文件 | 变更摘要 |
| --- | --- |
| `test/video-transform.test.ts` | 完全重写为 v2 配置测试（独立配置解析、序列化、执行器透传） |
| `test/migration.test.ts` | `v2Types` 数组新增 `video-frame`/`video-clip`/`video-audio`/`vocal-separate`；contractVersion 断言改为动态判断 |
| `test/connection-matrix.test.ts` | 新增 vocal-separate / image-split 端口连线矩阵 |
| `test/node-contract-snapshot.test.ts` | 新增节点契约快照 |
| `test/projectNodeOutputs.test.ts` | 新增输出投影测试 |

---

## 八、验证记录

| 验证项 | 结果 |
| --- | --- |
| `npx vitest run` | **45 个测试文件、576 项用例全部通过** |
| `npx tsc --noEmit` | 通过（零错误） |
| `git diff --check` | 无空白错误 |

> 注意：本轮变更尚未执行 Electron 桌面端手工冒烟测试。

---

## 九、待验收路径

1. **取帧**：创建 `video-frame` → 连接视频 → 点击"首帧"/"尾帧"按钮 → 确认输出对应帧；手动模式下拖动时间轴确认游标联动。
2. **截取 + 循环预览**：创建 `video-clip` → 连接视频 → 拖动双游标选择区间 → 开启循环（↻）→ 播放确认在区间内自动循环。
3. **提音 + 波形**：创建 `video-audio` → 连接视频 → 确认波形渲染 → 选择 WAV/M4A → 运行确认输出音频。
4. **人声分离**：创建 `vocal-separate` → 连接音频 → 选择快速/高质量模式 → 勾选伴奏 → 运行确认人声和伴奏分别输出到两个端口。
5. **一键提取人声**：在视频资产节点点击"一键提取人声" → 确认自动创建 `video-audio` + `vocal-separate` 两节点并预连线。
6. **图片拆分**：创建 `image-split` → 连接图片 → 设置 3x3 宫格 → 确认输出 9 张子图。
7. **缩略图时间轴**：在任何视频变换节点中确认 10 帧缩略图正常加载、点击可跳转。

---

## 十、接手步骤

```powershell
git fetch origin
git status -sb
npm install
npm run typecheck
npm test
npm run build
npm run dev
```

确认本地无无关文件和远程未合并提交后开始工作。按上述待验收路径执行桌面端冒烟测试。
