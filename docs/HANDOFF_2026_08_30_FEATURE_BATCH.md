# 功能批量交接单（2026-08-30）

> 分支：`main`
> 远程仓库：https://github.com/fanke52013141-cmd/free-creation
> 前序交接：[docs/HANDOFF_2026_08_30_MEDIA_WORKFLOW.md](./HANDOFF_2026_08_30_MEDIA_WORKFLOW.md)

本轮在 `751c1c6 Improve media workflow and node interaction` 之上，完成了四个功能方向的增量开发。全部变更尚未提交，本轮一次性提交并推送。

---

## 一、本轮交付概览

| 功能方向 | 涉及节点 | 契约变更 | 状态 |
| --- | --- | --- | --- |
| 语音克隆节点（TTS） | 新增 `tts` | 新增 contractVersion 1 | 已开发，需桌面端验收 |
| 视频变换增强 | `video-frame` / `video-clip` / `video-audio` | 无破坏性 | 已开发，需桌面端验收 |
| 3D 预演台升级 | `director` | contractVersion 1→2，`previs.project` 1→2 | 已开发，需桌面端验收 |
| UI 图标与视觉系统 | 全局 | 无端口变更 | 已开发，需桌面端验收 |

---

## 二、功能一：语音克隆节点（TTS）

### 2.1 设计意图

新增独立节点类型 `tts`，通过本地 ComfyUI 后端的 IndexTTS-2.5 模型实现语音复刻（voice cloning）。用户上传或从上游接收一段参考音频，输入待朗读文本，节点输出合成后的新音频资产。

### 2.2 节点契约

```text
type: 'tts'
contractVersion: 1
label: '语音克隆'
color: '#fbbf24'
executionMode: 'async'（异步轮询，与视频节点一致）

输入端口：
  in-audio  (audio, cardinality: one) — 参考语音，可选上游输入或节点内上传
  in-text   (text,  cardinality: many) — 待朗读文本，与节点内文本合并

输出端口：
  out-audio (audio) — 合成并落盘后的音频资产
```

### 2.3 新增文件

| 文件 | 职责 |
| --- | --- |
| `src/shared/tts.ts` | TTS 配置类型、序列化/反序列化、默认值 |
| `src/main/comfyui/client.ts` | ComfyUI API 客户端（轮询、结果下载） |
| `src/main/comfyui/settings.ts` | ComfyUI 服务地址与端口配置读写 |
| `src/main/ipc/comfyui.ipc.ts` | ComfyUI IPC 通道（设置读写、任务提交与轮询） |
| `src/main/media/tts-transform.ts` | TTS 音频合成主进程入口 |
| `src/renderer/src/engine/executors/tts.ts` | 渲染端执行器，调用 `window.api.ttsGenerate()` |
| `src/renderer/src/nodes/specs/bodies/tts.tsx` | TTS 节点 Body（参考音频上传、文本输入、语速/情感/语言控制） |

### 2.4 注册变更

- `src/shared/types/index.ts`：`ActiveNodeTypeId` 新增 `'tts'`
- `src/renderer/src/nodes/specs/index.tsx`：注册 `tts` 节点 Spec
- `src/renderer/src/nodes/specs/bodies/index.tsx`：导出 `TtsBody`
- `src/renderer/src/nodes/specs/outputProjections.ts`：新增 `projectTtsOutputs`
- `src/renderer/src/canvas/CanvasEditor.tsx`：节点面板标签 `tts: '配音'`
- `src/main/index.ts` / `src/preload/index.ts`：注册 ComfyUI IPC 通道

### 2.5 依赖说明

- 需要用户本地运行 ComfyUI 并安装 IndexTTS-2.5 自定义节点
- ComfyUI 服务地址和端口通过设置面板配置，存储在本地配置文件中
- 与视频节点的异步轮询模式一致：提交 → 轮询状态 → 下载结果

---

## 三、功能二：视频变换增强

### 3.1 三项增强

在已有的 `video-frame` / `video-clip` / `video-audio` 三个节点上迭代：

1. **取帧预设按钮**：`video-frame` 节点新增"首帧"和"尾帧"两个快捷按钮，一键提取第一帧或最后一帧；同时保留拖动滑块预览任意时刻取帧的能力。

2. **截取视频段**：`video-clip` 功能保持不变，仅 UI 对齐优化。

3. **提取音频 + 人声分离**：`video-audio` 节点新增"人声分离"开关。开启后可选择三种模式：
   - **自动**（`auto`）：通过 ffprobe 检测立体声，立体声使用中置提取，单声道使用均衡器过滤。
   - **中置人声**（`center`）：立体声左右声道相减（`pan=mono|c0=0.5*c0+-0.5*c1`），再经过 highpass/lowpass/降噪/增益。
   - **均衡器分离**（`eq`）：仅 highpass 80Hz + lowpass 8000Hz + 降噪 + 增益，适用于单声道源。

### 3.2 修改文件

| 文件 | 变更摘要 |
| --- | --- |
| `src/shared/video-transform.ts` | 新增 `VocalIsolationMode` 类型；`VideoRangeConfig` 新增 `removeBackground` 和 `isolationMode` 可选字段；`parseVideoRangeConfig` 解析新字段 |
| `src/main/media/video-transform.ts` | `transformVideoAudio` 新增人声隔离分支；`buildCenterExtractionFilter()` / `buildEqOnlyFilter()` 构建 FFmpeg 滤镜链；`probeStereo()` 通过 ffprobe 检测声道数；`getFfprobePath()` 解析 ffprobe 路径 |
| `src/renderer/src/nodes/specs/bodies/video-transforms.tsx` | 新增首帧/尾帧预设按钮；`toggleVocalIsolation()` / `changeIsolationMode()` 处理器；人声分离复选框 + 模式下拉选择 UI；`saveRange()` 保留隔离字段 |
| `src/renderer/src/engine/executors/videoTransforms.ts` | prompt 日志标记"人声分离" |
| `src/renderer/src/assets/app.css` | 新增 `.frame-preset-row` / `.frame-preset-btn` / `.audio-isolation-control` / `.audio-isolation-toggle` / `.audio-isolation-mode` 样式 |
| `test/video-transform.test.ts` | 新增人声隔离配置解析测试（合法模式、removeBackground=false 丢弃 isolationMode、非法模式回退 auto）；新增执行器透传测试 |

### 3.3 当前限制

当前人声分离基于 FFmpeg 滤镜链（中置提取 + EQ），属于零依赖快速方案。相比 AI 模型方案（BS-RoFormer / MelBand RoFormer），分离质量有限。已完成开源项目调研，推荐后续集成 `python-audio-separator`（子进程模式），详见本轮交接末尾"待开发"部分。

---

## 四、功能三：3D 预演台升级

### 4.1 变更范围

导演台从 2D 白模预演升级为 3D 白模预演。节点标签从"导演台"改为"3D 预演台"。

### 4.2 契约变更

| 项目 | 旧版本 | 新版本 | 说明 |
| --- | --- | --- | --- |
| `director` 节点 contractVersion | 1 | 2 | 端口 ID 不变，描述更新 |
| `previs.project` Schema | 1 | 2 | 新增 3D 空间生成相关字段 |
| `video` 节点 contractVersion | 1 | 2 | 新增 `in-reference-video` 端口 |

### 4.3 主要修改

| 文件 | 变更摘要 |
| --- | --- |
| `src/renderer/src/canvas/Director3DViewport.tsx` | 大幅扩展 Three.js 3D 视口（+401 行）：角色占位、机位变换、焦距/画幅、起终点关键帧、运镜预设、穿模/时长预警 |
| `src/renderer/src/canvas/DirectorStudioPanel.tsx` | 预演台面板重构（+476 行）：3D 操作栏、镜头序列、参考图分区、空间生成控制 |
| `src/renderer/src/nodes/director-data.ts` | 导演台数据模型扩展（+426 行）：3D 空间状态、镜头关键帧序列、空间生成策略 |
| `src/renderer/src/nodes/previs-space-generator.ts`（新增） | 本地轻量白模空间生成器：`local-whitebox`（默认墙体/方块白模）和 `image-depth`（首张参考图亮度近似深度做 2.5D 视差）两种策略 |
| `test/previs-space-generator.test.ts`（新增） | 空间生成器单元测试 |
| `test/director-data.test.ts` | 导演台数据模型回归测试 |

### 4.4 视频节点新增端口

`video` 节点新增 `in-reference-video`（运动参考）输入端口，类型为 `video`，用于接收预演台白模视频作为运动参考。供应商是否接受参考视频由实际响应决定。

---

## 五、功能四：UI 图标与视觉系统

### 5.1 设计意图

建立统一的图标系统和视觉基础层，替换散落的内联 SVG。

### 5.2 新增文件

| 文件 | 职责 |
| --- | --- |
| `docs/UI_ICON_SYSTEM.md` | 图标系统设计文档（命名规范、尺寸、用法） |
| `docs/assets/ui-icon-master-v1.png` | 图标精灵图主文件 |
| `src/renderer/src/assets/ui-foundation.css` | UI 基础层样式（色彩、间距、字体、阴影 token） |
| `src/renderer/src/assets/ui-surfaces.css` | UI 表面层样式（卡片、面板、按钮、弹层组件样式） |
| `test/icon-system.test.ts` | 图标系统测试 |

### 5.3 修改文件

| 文件 | 变更摘要 |
| --- | --- |
| `src/renderer/src/components/Icon.tsx` | 图标组件扩展（+91 行）：支持精灵图模式、新增图标类型 |
| `src/renderer/src/canvas/MultiSelectToolbar.tsx` | 多选工具栏重设计（+110/-）：使用新图标系统、布局优化 |
| `src/renderer/src/assets/app.css` | 大量样式补充（+238 行）：视频变换、人声分离、导演台、图标相关样式 |

---

## 六、其他修改

以下文件在本轮有适配性修改，不构成独立功能：

- `src/renderer/src/canvas/ConnectionLayer.tsx`（+30）：连线层渲染优化
- `src/renderer/src/canvas/NodeCardView.tsx`（+9）：节点卡片视图适配
- `src/renderer/src/canvas/graph.ts`（+2）：连线校验微调
- `src/renderer/src/canvas/CanvasMinimap.tsx`（-8）：小地图简化
- `src/renderer/src/canvas/side-panel/AssetsPanel.tsx`（+13）：资产面板适配
- `src/renderer/src/pages/CanvasPage.tsx`（+36）：画布页面适配
- `src/renderer/src/main.tsx`（+2）：入口适配
- `src/renderer/src/nodes/specs/bodies/shared.tsx`（+33）：共享 Body 组件扩展
- `src/renderer/src/nodes/specs/bodies/video.tsx`（+14）：视频节点 Body 适配新端口
- `src/renderer/src/nodes/specs/bodies/director.tsx`（+15）：导演台 Body 适配
- `src/shared/contracts/index.ts`（+41）：契约类型扩展
- `src/shared/node-schemas.ts`（+20）：Schema 注册扩展
- `src/main/gateway/video.ts`（+21）：视频网关适配参考视频
- `src/main/ipc/media.ipc.ts`（+64）：媒体 IPC 扩展
- `src/preload/index.ts`（+17）：preload 通道扩展
- `src/renderer/src/engine/executor-types.ts`（+6）：执行器类型扩展
- `src/renderer/src/engine/executor.ts`（+17）：执行器编排适配
- `src/renderer/src/engine/executors/iterate.ts`（+27）：迭代执行器适配
- `src/renderer/src/engine/executors/video.ts`（+4）：视频执行器适配
- 多个测试文件：新增 TTS、视频变换、导演台、迭代、异步执行等回归用例

---

## 七、本轮验证记录

| 验证项 | 结果 |
| --- | --- |
| `npx vitest run` | 44 个测试文件、557 项用例全部通过 |
| `npm run typecheck` | Node + Web 双端类型检查通过 |
| `git diff --check` | 无空白错误 |

> 注意：本轮变更尚未执行 Electron 桌面端手工冒烟测试。以下路径需要人工验收后才能确认功能完整可用。

### 待验收路径

1. **语音克隆**：创建 `tts` 节点 → 上传参考音频 → 输入文本 → 运行 → 确认输出音频资产可播放、可连线到下游。
2. **视频取帧**：创建 `video-frame` 节点 → 连接视频 → 点击"首帧"/"尾帧"按钮 → 确认输出对应帧。
3. **视频提音 + 人声分离**：创建 `video-audio` 节点 → 连接视频 → 开启"人声分离" → 选择模式 → 运行 → 确认输出为人声增强后的音频。
4. **3D 预演台**：创建 `director` 节点 → 连接分镜和参考图 → 打开预演工作区 → 在 3D 视口中移动角色、设置机位 → 发布帧和视频。
5. **UI 图标**：确认节点面板、工具栏、右侧面板图标正常显示。

---

## 八、待开发内容

### 8.1 人声分离 AI 模型集成（高优先级）

已完成开源项目调研，推荐方案：

| 方案 | 模型 | 集成方式 | 质量(SDR) | 评估 |
| --- | --- | --- | --- | --- |
| **python-audio-separator 子进程** | BS-RoFormer 2026.07 | spawn Python 进程调用 CLI | 12.39 | 推荐：质量最高、集成简单、和现有 IndexTTS 模式一致 |
| ONNX Runtime Node | HTDemucs / MDX-Net | 主进程原生推理 | ~8-10 | 备选：无 Python 依赖但模型质量稍低 |
| onnxruntime-web + WebGPU | HTDemucs (ONNX) | 渲染进程 Web Worker | ~8 | 备选：零依赖但实现复杂 |

实施路径：FFmpeg 先截取音频片段 → Python 子进程调用 `audio-separator` 分离人声 → 返回干净人声文件。需要像 IndexTTS 一样做环境检测和引导安装。

### 8.2 其他待办

- TTS 节点的 ComfyUI 连接配置 UI（当前通过设置面板手动填写地址端口）
- 视频节点 `in-reference-video` 端口的供应商实际验收
- 3D 预演台的外部图片→白模重建 Provider 适配（当前为本地 fallback）
- UI 图标系统的完整覆盖（部分节点仍使用旧图标）

---

## 九、接手步骤

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
