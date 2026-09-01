# Canvas Studio 开发交接文档

> 最后更新：2026-09-01
>
> 当前分支：`main`。接手前必须执行 `git fetch origin` 与 `git status -sb`，不得依据本文旧哈希判断推送状态。
>
> 当前功能与测试基线：以 `main` 最新提交为准；交接时先执行 `git fetch origin` 与 `git status -sb`，不得依据旧哈希判断推送状态。
>
> 远程仓库：https://github.com/fanke52013141-cmd/free-creation
>
> 产品定位：单用户、本地优先的 Windows Electron 无限画布创作工具。

> **最新修复（2026-09-02 文本节点输入）**：修复文本节点双击进入编辑态后 textarea 无法输入的问题——`textRef` 改为在 `useEffect` 中同步、`enterEditing` 用 `useCallback` 稳定监听器引用、移除会覆盖 draft 的旧副作用；textarea 事件处理仅 `stopPropagation` 不做 `preventDefault`，保证输入可正常聚焦。涉及文件与验证路径见 [docs/HANDOFF_2026_09_02_TEXT_EDIT_INPUT.md](./docs/HANDOFF_2026_09_02_TEXT_EDIT_INPUT.md)。

> **最新交付（2026-09-01 Agent 生产链路）**：MCP 的真实 Electron stdio 启动烟测、持久化 revision/idempotency 写入保护、Headless Run 消费器、真实工具/节点配置契约产物以及零警告 lint 已完成。使用方式、开关和后续硬门槛见 [docs/HANDOFF_2026_09_01_AGENT_PRODUCTION.md](./docs/HANDOFF_2026_09_01_AGENT_PRODUCTION.md)。

> **最新交付（2026-09-01 Agent 对接安全基线）**：CLI/MCP 已改为读取桌面端同一份项目/媒体数据，默认只读；写入与无界面执行在画布快照事务和真实执行器完成前被主动关闭。新增 Electron ABI 构建、Zod 边界校验、稳定契约生成文件、权限/乐观版本/幂等基础设施。此前“P0–P3 已完整实现、能力表为唯一事实来源”的表述不准确，现已撤回。完整状态、验证和后续硬门槛见 [docs/HANDOFF_2026_09_01_AGENT_SAFETY_BASELINE.md](./docs/HANDOFF_2026_09_01_AGENT_SAFETY_BASELINE.md)。

> **当前交接入口（2026-08-31 P0–P3 优化）**：Sprint 0、Sprint 2、Sprint 3 和导演台安排已完成；P0–P3 协议、交互、生图比例和视频能力优化也已完成，详见 [docs/P0_P3_NODE_CAPABILITY_OPTIMIZATION_2026_08_31.md](./docs/P0_P3_NODE_CAPABILITY_OPTIMIZATION_2026_08_31.md)、[docs/NODE_PROTOCOL_AUDIT_2026_08_31.md](./docs/NODE_PROTOCOL_AUDIT_2026_08_31.md) 与 [docs/NODE_COMPLIANCE_MATRIX.md](./docs/NODE_COMPLIANCE_MATRIX.md)。左侧节点菜单保持未分类版本：单一无框鱼眼图标栏，节点列表沿用原有交互。右键画布的新建节点菜单采用一级分类悬浮二级筛选，分类项带右向箭头，二级节点可直接创建或用于真实连线。UI 整体优化六阶段已由 `f519ac3` 提交并推送。

> **最新修复（2026-08-31 右键菜单紧凑布局）**：右键“新建节点”菜单的主区域已独立为可滚动容器，工作流模板和“添加资源”操作不会再被二级菜单的 `overflow: visible` 影响而跑出边框。主菜单宽度按内容收敛为约 196px（视口自适应，最长操作文本可完整显示），右侧二级菜单保留 276px 独立宽度以容纳端口说明，并补齐浅色主题样式。源码构建、类型检查、ESLint、节点创建/注册测试和 Windows 目录打包均已通过；`dist/win-unpacked` 已更新，可直接用于桌面快捷方式验收。

> **最新修复（2026-08-31 画布视觉收口）**：工具栏图标的说明改为顶部优先展开，避免覆盖相邻图标；节点卡片不再常驻显示“可运行”readiness 标签，状态点和端口提示仍保留完整可访问说明。右键一级菜单不滚动、按最长操作文本自适应宽度，并移除工作流/资源项重复图标；二级菜单按最长节点名收敛宽度，“全部”列表保留滚动能力但隐藏滚动条。`AppSelect` 与画布内原生下拉框统一深浅主题、箭头、焦点与系统选项色彩。新建/拖拽连线采用低噪声虚线；分组显示为中性圆角容器和标题，多选才显示细虚线范围框。`npm run verify` 已通过（54 文件、620 用例）；若桌面应用正在使用，重新打包前必须先关闭 `canvas-studio.exe`，避免覆盖使用中的目录包。

> **桌面打包基线（2026-08-31）**：`electron-builder.yml` 已设为 `asar: false`，并显式复制 `@napi-rs/canvas-win32-x64-msvc` 原生 binding。此前 Windows 环境会生成错位的 asar 索引或遗漏 optional native binding，导致 `canvas-studio.exe` 在加载主入口前退出；目录打包不改变功能和本地数据，且本轮已完成启动校验。打包前仍须先执行 `electron-builder install-app-deps`，保证 `better-sqlite3` 与 Electron ABI 一致。

## 1. 接手前必须知道的边界

- 不做多租户、账号、权限、强制教程或运营后台。
- 保持现有页面格局；视觉和交互优化必须渐进式进行，不能重做左侧工具栏、顶部栏或画布操作方式。
- 连线只表示真实的数据依赖：`source.outputs[sourcePortId] -> target.inputs[targetPortId]`。
- 分组是 tldraw 的画布状态，不是节点；视频剪辑和成片合成应交给剪映等专业工具。
- 图片资产节点与图片生成节点是两个不同能力；所有导入、粘贴或生成的媒体都必须成为可连接的节点资产。
- 节点不是复合功能容器。复杂工作流优先由节点连线或工作流模板组成。

开始修改前，按顺序阅读：

1. [README.md](./README.md)：启动、打包和本地数据位置。
2. [NODE_CONTRACT_SPEC.md](./NODE_CONTRACT_SPEC.md)：强制的节点/端口/Schema/执行规范。
3. [ROADMAP.md](./ROADMAP.md)：历史阶段记录与产品边界。
4. 本文：当前状态、交接流程、已知边界和下一步计划。

## 2. 当前完成状态（R0–R7 全部完成、P0–P4、IA-1/IA-2、UI 整体优化）

R0–R7 已全部完成并推送。UI 整体优化六阶段（Dock 鱼眼放大、边框清除、按钮统一、布局重组、节点排版修复、节点分类二级筛选）已完成，并由 `f519ac3` 提交、推送。核心交付如下：

| 阶段    | 已交付内容                                                                                     | 验证结果                                  |
| ------- | ---------------------------------------------------------------------------------------------- | ----------------------------------------- |
| R0      | 统一节点输出投影、执行模式与运行记录；输出不再由中心 `switch` 猜测                             | 注册门禁、投影测试、手动执行测试通过      |
| R1      | 节点执行器自注册；全局运行器只负责编排、校验、状态与登记                                       | `executor.ts` 无节点类型分发主逻辑        |
| R2      | 契约、Schema、连线矩阵、执行器和迁移自动化测试                                                 | 14 个测试文件、374 项测试全部通过         |
| R3      | AI 处理节点、可验证 JSON、剧本到分镜模板、右侧契约/设置/运行记录面板                           | 输出模式与 Schema 均受校验                |
| R4      | `list.items@1` 和串行迭代节点；导演台节点与手动发布输出                                        | 真实 Electron 中 PNG 帧与 WebM 均成功发布 |
| P0      | 启动超时/渲染错误边界；修复 `node-card` 快照缺少 `config` 导致的白屏；增加 tldraw 形状迁移定义 | 快照修复测试与生产构建通过                |
| P1      | 确认框焦点锁定、Esc 取消、焦点恢复；Toast 和契约分页增加可访问语义；项目卡片支持键盘打开       | lint、类型检查通过                        |
| P1 基准 | 固定演示包、100/500/1000 节点数据层基准、演示包导入与配置内媒体重映射回归                      | `benchmark:canvas` 与导入集成测试通过     |
| P2      | 顶部栏和侧面板响应式收敛；补齐 `--panel` 主题变量；窄屏下文字、按钮和弹层不溢出                | Web 类型检查、构建通过                    |
| P2 数据 | `character/scene/shot/prompt` Schema、通用结构数据节点、字段映射、提示词包端口与创作模板       | 25 个测试文件、427 项用例通过             |
| P3      | 导演台窄屏支持镜头/属性面板切换；时间轴、预演视口和操作栏保留在主工作区                        | 导演台数据测试通过                        |
| P4      | 补充快照修复、节点状态、创建菜单、运行记录、媒体映射和导入事务测试                             | 全量 23 个测试文件、405 项用例通过        |

### 本轮新增：UI 整体优化六阶段（2026-08-31 第四批）

本轮完成六阶段 UI 优化，基于 `fc78c97`，已由 `f519ac3` 提交并推送。详见 [docs/HANDOFF_2026_08_31_UI_OVERHAUL.md](./docs/HANDOFF_2026_08_31_UI_OVERHAUL.md)：

| 功能                | 状态               | 说明                                                                                                       |
| ------------------- | ------------------ | ---------------------------------------------------------------------------------------------------------- |
| Dock 鱼眼放大       | 已开发，待桌面验收 | 余弦曲线算法，`useDockMagnify` hook，零依赖，`requestAnimationFrame` 批处理                                |
| 边框清除            | 已开发，待桌面验收 | 清除三处 CSS 文件（app.css → ui-foundation.css → ui-surfaces.css）残留背景/边框/阴影                       |
| 按钮统一 + 布局重组 | 已开发，待桌面验收 | `.dock-btn` 与 `.palette-item` 统一为透明背景；导航簇移至左下角、工具栏移至右下角                          |
| 节点排版修复        | 已开发，待桌面验收 | aiProcess 无模型时提前 return `NoModelHint`；chat 补模型配置引导                                           |
| 右键菜单改进        | 已开发，待桌面验收 | 菜单固定 `max-height: 400px` + 滚动；NodeContextMenu 新增"编辑"选项                                        |
| 节点分类二级筛选    | 已开发，待桌面验收 | `NodeTypeSpec.category` 必填字段；5 分类（素材输入/图像处理/视频处理/音频语音/逻辑流程）；创建菜单分类 Tab |

验证基线：**53 个测试文件、617 项用例全部通过**；`npm run verify`（lint、Node/Web 类型检查、测试、生产构建）通过。桌面端手工冒烟尚未执行。

### 本轮新增：可定制节点分类 Dock（2026-08-31）

| 能力         | 状态               | 说明                                                                                                            |
| ------------ | ------------------ | --------------------------------------------------------------------------------------------------------------- |
| 一级分类筛选 | 已开发，待桌面验收 | 左栏固定显示常用/输入/图像/视频/音频/流程 6 个分类；选中后仅在二级抽屉展示该分类的真实可创建节点。              |
| 拖动排序     | 已开发，待桌面验收 | 原生拖放调整一级分类显示顺序；只调整 `PaletteCategoryId`，不修改节点类型、端口或 `NodeTypeSpec.category`。      |
| 右键改名     | 已开发，待桌面验收 | 右键分类可修改显示名（最多 16 字）或恢复默认名；分类机器 ID 保持不变。                                          |
| 本机持久化   | 已开发，待桌面验收 | 通过 `workspace:palette-preferences:*` IPC 保存到主进程 SQLite `settings`；不写入项目快照、工作流模板或导出包。 |
| 降级保护     | 已开发             | 读取时白名单归一化：损坏、重复、未知或遗漏分类不会导致 Dock 消失，当前全部分类会被补齐。                        |

当前 UI 选择：左侧保留原有单一节点列表和鱼眼交互；分类只用于右键新建节点菜单的快速二级筛选，不改变左侧菜单。

关键文件：`src/shared/palette-preferences.ts`、`src/renderer/src/canvas/palette-categories.ts`、`src/renderer/src/canvas/CanvasEditor.tsx`、`src/main/store/workspace-state.repo.ts`。

本轮验证：Node/Web 类型检查通过；生产构建通过；全量 `vitest run` **54 个测试文件、620 项用例通过**。`eslint` 为 0 error，仍有 37 条既有格式/Hook warnings，未因本功能新增。桌面端请重点手验：分类切换、拖动排序重启后保留、右键改名/恢复默认、二级节点点击与拖入画布、深浅主题。

### 前批：视频节点 v2 重构（2026-08-30 第三批）

本轮将视频处理链路重构为四个独立节点，新增统一媒体时间轴和图片拆分节点，详见 [docs/HANDOFF_2026_08_30_VIDEO_RESTRUCTURE.md](./docs/HANDOFF_2026_08_30_VIDEO_RESTRUCTURE.md)：

| 功能             | 状态               | 说明                                                                                                             |
| ---------------- | ------------------ | ---------------------------------------------------------------------------------------------------------------- |
| 视频节点 v2 重构 | 已开发，待桌面验收 | `video-frame`/`video-clip`/`video-audio` 升级为 contractVersion 2，独立配置类型；删除旧的共享 `VideoRangeConfig` |
| 独立人声分离节点 | 已开发，待桌面验收 | 新增 `vocal-separate` 节点，从 `video-audio` 解耦；支持快速 FFmpeg 和高质量 AI 双模式；双输出（人声 + 伴奏）     |
| 统一媒体时间轴   | 已开发，待桌面验收 | `MediaTimeline` 组件：10 帧缩略图、300 点波形、播放/暂停、逐帧导航、循环预览、手动时间码                         |
| 图片宫格拆分     | 已开发，待桌面验收 | 新增 `image-split` 节点：宫格预览、面积缩放、最大 8x8                                                            |
| 快捷入口与模板   | 已开发，待桌面验收 | 视频节点下游按钮 + 一键提取人声链路（自动创建并预连线 video-audio → vocal-separate）                             |

验证基线：**45 个测试文件、576 项用例全部通过**；`npx tsc --noEmit` 零错误。

### 前批：功能批量交付（2026-08-30 第二批）

前批一次性交付四个功能方向，已提交于 `33d82e3`，详见 [docs/HANDOFF_2026_08_30_FEATURE_BATCH.md](./docs/HANDOFF_2026_08_30_FEATURE_BATCH.md)：语音克隆节点（`tts`）、视频变换增强（取帧预设 + 人声分离）、3D 预演台升级（contractVersion 1→2）、UI 图标与视觉系统。

### 本轮新增：3D 预演台（`director`）

导演台是 `manual-publish` 节点，不会在“运行工作流”时擅自打开工作区或生成媒体。

- 输入：`in-storyboard`（分镜 JSON）、`in-reference-images`（多张图片；空间建立建议前 1～3 张）、`in-camera-preset`（`previs.camera@1`）。
- 输出：`out-frame`（PNG 图片）、`out-preview-video`（白模 WebM 运动参考）、`out-camera`（机位 JSON）、`out-project`（`previs.project@2` 工程摘要 JSON）。
- 已发布的帧/视频才会成为下游的真实输入；损坏的发布记录或只有机位而没有媒体的记录会被视为未发布。
- 当前预演支持 2D Canvas 与 Three.js 白模视口。编辑视角与拍摄机位已经分离；人物可在 3D 视口中选择并直接移动/旋转，支持 G/R/空格快捷键、起终点关键帧、运镜预设、镜头序列和非阻断的穿模/时长/关键帧预警。
- “生成空间”当前落地为稳定的本地轻量白模 fallback；外部图片→白模服务必须经可插拔 Provider 适配后才能替换为自动重建，失败不得覆盖已有空间。
- 视频节点新增可选 `in-reference-video`。预演视频可一键创建真实连线进入该端口；供应商是否接受参考视频以实际响应为准。
- 媒体导入 IPC 已支持图片和视频缓冲，视频上限为 200 MB；只有 Electron preload 有本地媒体写入能力，浏览器预览页会给出明确提示。
- 空间生成现采用两层本地策略：`local-whitebox` 为默认的轻量墙体/方块白模；`image-depth` 取首张
  `in-reference-images` 图片，在 Three.js 视口中以亮度近似深度做 2.5D 视差。后者只保存真实媒体
  引用，不复制资产、不创建新节点、无额外 API 成本；未来如引入本地 Depth Anything，只替换
  `src/renderer/src/nodes/previs-space-generator.ts` 的适配器并填充可选 depth 媒体字段。

## 3. 架构地图

```text
节点 Spec（职责/端口/投影/执行模式）
        │
        ├─ Body：卡片上的最小编辑界面
        ├─ Executor：把已验证输入变成持久化运行结果
        └─ projectOutputs：持久化状态映射为正式输出端口
                │
          executor.ts：拓扑、收集、验证、运行、登记
                │
      NodeValuePacket（nodeId + portId + value + runId）
                │
          下游端口的真实输入
```

| 位置                                                | 职责                                                   |
| --------------------------------------------------- | ------------------------------------------------------ |
| `src/shared/types/index.ts`                         | `NodeTypeId`、端口类型、执行模式等跨层类型             |
| `src/shared/node-schemas.ts`                        | 版本化 JSON Schema 的注册与校验                        |
| `src/renderer/src/nodes/registry.tsx`               | `NodeTypeSpec` 和注册时硬门禁                          |
| `src/renderer/src/nodes/specs/index.tsx`            | 所有节点 Spec、端口、执行器与投影的注册入口            |
| `src/renderer/src/nodes/specs/outputProjections.ts` | 每一种节点的持久化状态 → 输出端口映射                  |
| `src/renderer/src/nodes/nodeValues.ts`              | 统一投影入口与持久化结果解析器                         |
| `src/renderer/src/engine/executor.ts`               | 拓扑排序、输入收集、契约检查、执行状态、下游数据包登记 |
| `src/renderer/src/engine/executors/`                | 节点独立执行器；不向全局运行器加特例                   |
| `src/renderer/src/canvas/graph.ts`                  | 连线创建、类型/Schema/数量/环校验、按端口读取上游值    |
| `src/renderer/src/canvas/NodeContractPanel.tsx`     | 右侧“概览 / I/O / 设置 / 运行”详情面板                 |
| `src/renderer/src/canvas/DirectorStudioPanel.tsx`   | 导演台独立全屏预演工作区                               |
| `src/main/ipc/media.ipc.ts`                         | 本地媒体导入、落盘与安全限制                           |

## 4. 节点清单与可用范围

| 节点     | 主要输入                | 主要输出                           | 当前说明                                            |
| -------- | ----------------------- | ---------------------------------- | --------------------------------------------------- |
| 文本     | 多文本（可选）          | `out-text`                         | 可用                                                |
| 图片资产 | 无                      | `out-image`                        | 导入、粘贴、拖入均应走此节点                        |
| 生图     | 文本、参考图            | `out-image`                        | 可用；支持尺寸、种子和重新生成                      |
| 视频资产 | 无                      | `out-video`                        | 可用；依赖已配置视频供应商；支持一键提取人声链路    |
| 视频取帧 | `in-video`              | `out-image`                        | 可用；首帧/尾帧/手动三种模式；统一时间轴            |
| 视频截取 | `in-video`              | `out-video`                        | 可用；双游标区间；循环预览；质量模式                |
| 视频提音 | `in-video`              | `out-audio`                        | 可用；WAV/M4A + 采样率；波形预览                    |
| 人声分离 | `in-audio`              | `out-vocals` / `out-accompaniment` | 可用；快速 FFmpeg / 高质量 AI 双模式；双输出        |
| 图片拆分 | `in-image`              | `out-images`                       | 可用；宫格拆分（最大 8x8）；面积缩放                |
| 音频     | 音频、文本              | `out-audio`                        | 可用；依赖供应商                                    |
| 语音克隆 | 参考语音、文本          | `out-audio`                        | 可用；依赖本地 ComfyUI + IndexTTS-2.5               |
| 对话     | 文本                    | `out-markdown`                     | 多轮交互；保留 Markdown 语义                        |
| AI 处理  | 文本、JSON              | text / markdown / JSON 之一        | 一次性、可复跑的工作流转换                          |
| 处理     | 动态值                  | `out-value`                        | 通用透传/兜底，不承载业务规则                       |
| JSON     | 文本、JSON              | `out-json`                         | 结构化编辑与校验                                    |
| 结构数据 | JSON 上下文、文本上下文 | 所选 Schema 的 `out-json`          | 通用结构编辑/字段映射；不做角色等特例 UI            |
| 代码     | 文本、JSON、命名参数    | 命名输出端口                       | 本地受限转换；变量名决定端口 ID                     |
| 分镜板   | 分镜 JSON、兼容文本     | 分镜 JSON、摘要                    | 可用                                                |
| 迭代     | `list.items@1`          | `out-item`、`out-items`            | P3.1 明确循环体边界；仍为串行、无暂停恢复           |
| 导演台   | 分镜、参考图、机位      | 帧、预演视频、机位、工程摘要       | 手动发布；已升级为 3D 白模预演（contractVersion 2） |
| 脚本     | 历史文本                | 分镜 JSON、文本                    | 仅旧项目兼容，禁止新建                              |

当前注册 Schema：

- `json.any@1`
- `storyboard.shots@1`
- `list.items@1`
- `previs.camera@1`
- `previs.project@2`
- `character.profile@1`
- `scene.definition@1`
- `shot.definition@1`
- `prompt.bundle@1`

## 5. 新节点接入：强制交接协议

任何新增节点都必须完整通过以下顺序，缺任一步不合并：

1. 先写清职责、输入、输出、错误语义和是否需要手动发布；不要先画 UI。
2. 在 `NodeTypeId` 中加入稳定类型；端口 ID 一经发布不可随意重命名。
3. 在 `node-schemas.ts` 注册所有专用 JSON Schema；业务 JSON 不得只声明裸 `json`。
4. 在 `specs/index.tsx` 注册 `NodeTypeSpec`：端口、`executionMode`、`projectOutputs`、`executor` 和 Body 缺一不可。
5. 将执行逻辑放入 `engine/executors/<node>.ts`；不要修改 `executor.ts` 增加 `nodeType` 分支。
6. 将“持久化配置/运行结果 → 端口输出”的逻辑放入 `outputProjections.ts`；运行器和 UI 不得各写一份投影。
7. Body 只做编辑与展示，不得扫描上游节点类型；读取上游值只能按目标 `portId`。
8. 确认右侧契约面板能解释端口、连接来源、值预览和运行结果。
9. 增加注册、Schema、投影、执行器、连线/迁移测试，并更新规范与本文。

若端口或 Schema 有破坏性变化：提高 `contractVersion`，提供迁移或明确拒绝旧项目；绝不能静默猜端口。

## 6. 接手与发布流程

### 开始工作

```powershell
git fetch origin
git status -sb
git log --oneline -5
pnpm install
pnpm typecheck
pnpm test
pnpm build
pnpm dev
```

先确认本地没有无关文件和远程未合并提交，再开始修改。测试素材、API Key、SQLite、媒体和打包输出均不得提交。

### 合并前门禁

```powershell
pnpm typecheck
pnpm lint
pnpm test
pnpm build
git diff --check
git status -sb
```

还必须进行一次与改动相符的真实桌面端冒烟测试。涉及媒体时至少验证：资产落盘、节点输出、连线可用、失败状态不产生旧输出。

### 当前已验证基线

- `pnpm typecheck`：通过（Node + Web 双端类型检查）。
- `npx vitest run`：**53 个测试文件、617 项用例全部通过**（含 P0–P3 的 Active 清单、动态端口、就绪状态、图片/视频能力回归）。
- `git diff --check`：通过。
- Electron 手工测试：导演台发布链路已验证（PNG 帧与 WebM）；白屏问题已定位为旧 `node-card` 快照缺少 `config`，已修复。
- 本轮 UI 优化六阶段尚未执行桌面端手工冒烟，验收路径详见 [docs/HANDOFF_2026_08_31_UI_OVERHAUL.md](./docs/HANDOFF_2026_08_31_UI_OVERHAUL.md)。
- 构建仍会提示 `db.ts` 同时被动态与静态导入；它不阻断构建，列入后续技术债。
- 桌面快捷方式 `Canvas Studio.lnk` 指向 `dist/win-unpacked/canvas-studio.exe`；本轮已验证该目标能保持运行。重新打包后必须确认 `resources/app/out/main/index.js` 存在，再通知用户点击快捷方式。

### 本次功能提交

`39a32f2 feat: harden node workflows and director studio`

该提交包含节点契约治理、导入媒体重映射与事务保护、导演台 2D/3D 预演和发布、节点状态/运行记录、P0–P4 UI 修复及对应测试。提交不包含 API Key、SQLite、本地项目目录、生成媒体或打包产物。

`76e943c feat: add run center and precise media provenance`（本地提交，尚未推送）

该提交新增跨节点运行中心和只读运行索引；失败运行可从统一 executor 路径重试，资产可定位到精确产生它的 `runId`。每个生成结果只增加可选的持久化 `runId`，既有端口、节点类型、连线语义和旧结果的安全回退保持不变。

### 当前未提交：视频节点 v2 重构（2026-08-30 第三批）

详见 [docs/HANDOFF_2026_08_30_VIDEO_RESTRUCTURE.md](./docs/HANDOFF_2026_08_30_VIDEO_RESTRUCTURE.md)。本轮包含：

1. **视频节点 v2 重构**：三个视频变换节点（`video-frame`/`video-clip`/`video-audio`）升级为 contractVersion 2，各自拥有独立配置类型（删除旧的共享 `VideoRangeConfig`）。修改 `src/shared/video-transform.ts`、`video-transforms.tsx`、`videoTransforms.ts` 等。
2. **独立人声分离节点（`vocal-separate`）**：从 `video-audio` 解耦为独立节点；双输出端口（`out-vocals` + `out-accompaniment`）；快速 FFmpeg 和高质量 AI 双模式。新增 `vocalSeparate.ts` 执行器和 `vocal-separate.tsx` Body/Settings。
3. **统一媒体时间轴（`MediaTimeline`）**：10 帧缩略图、300 点波形预览、播放/暂停/逐帧导航、循环预览、手动时间码输入。新增 `generateVideoThumbnails` 和 `generateAudioWaveform` IPC。
4. **图片宫格拆分节点（`image-split`）**：新增节点，宫格预览、面积缩放、最大 8x8。新增 `src/shared/image-split.ts`、执行器和 Body。
5. **快捷入口与一键模板**：视频资产节点新增"一键提取人声"按钮（自动创建 `video-audio` → `vocal-separate` 并预连线）；三个变换节点结果卡新增下游快捷按钮。

验证：`npx vitest run` **45 文件 576 项全部通过**；`npx tsc --noEmit` 零错误。本轮尚未执行 Electron 桌面端手工冒烟，验收路径见交接单。

### CR-0 / CR-1 / CR-2（2026-08-29）

以 [CODE_REVIEW_2026_08_29.md](./docs/CODE_REVIEW_2026_08_29.md) 为依据，已完成以下切片；导演台不在本轮改动范围内。

1. **CR-0 节点规范收口**：分镜、代码和聊天 React UI 不再直接调用模型网关。分镜与代码的快捷生成改为明确工作流指引；聊天面板只写入待发送消息，再通过 `runNodeManually → chatExecutor` 执行。文档/摘要/温度等上下文合并也已移入 `chatExecutor`。结构数据节点把插值运行产物写入 `meta.nodeResult`，不再覆写用户模板 `props.text`；输出投影只接受成功运行的结果。运行器投影本轮产物时使用内存中的 success 记录，避免结构化节点在循环子流程中遗漏输出。
2. **CR-1 API Key 边界**：新增 `ProviderSummary`。渲染进程、preload、设置面板和所有 renderer executor 只接收公开摘要（模型、URL、`hasApiKey`），API Key 仅由主进程仓库解密并供网关使用。编辑现有供应商时 API Key 输入框留空会保留已存密钥；新建供应商仍强制填写。
3. **CR-2 本地持久化**：工作流模板与历史版本移出 `localStorage`，通过 `workspace:*` IPC 保存至本机 SQLite。模板为本机全局数据；历史快照按项目隔离、最多 30 条、单条限制 8 MB；渲染端会对保存/读取/删除失败给出提示。因当前没有历史项目，不做旧 localStorage 迁移。
4. **新增防回归测试**：`react-model-boundary` 禁止 UI 绕过 executor；`providers-security` 验证供应商公开列表不包含密钥；`workspace-persistence-boundary` 禁止模板/历史 store 回退到 localStorage。既有循环工作流测试同时覆盖 CR-0 结构化结果在迭代体内的输出回归。

验证：`npm run verify`、`git diff --check` 均通过；全量为 33 个测试文件、460 项用例。提交前仍应做一次桌面端手工冒烟：保存/编辑供应商（留空 Key）、保存/重启后读取模板、保存/回溯/删除历史版本、对话节点发送并检查 nodeRun 和 out-markdown。

**CR-3 / CR-4 / CR-5 完成状态：**

1. **✅ CR-3 数据层卫生**：MIME 已收敛到共享单一来源；SQLite 改为按版本逐项、可模拟测试的 `user_version` 迁移；启动时将残留 `.importing` 移入 `.recovery`，幽灵项目与 `.tmp` 仅报告而不删除。
2. **✅ CR-4 契约与执行测试**：新增 chat/video/audio mocked gateway、聊天完成、视频轮询/取消回归；迭代暂停恢复、导入重映射和代码动态端口契约已有覆盖。代码节点维持 `contractVersion: 2`，端口由同一 `resolvePorts` 解析；破坏性端口变更不得猜测旧连线。
3. **✅ CR-5 体验与维护性**：资产面板已拆为独立模块，并继续通过画布文档监听即时刷新来源索引；其余子面板保持独立职责组件；新增 `docs/DESKTOP_ACCEPTANCE_CHECKLIST.md` 作为发布前桌面验收门禁。导演台继续冻结，直至清单通过。

## 7. 当前交接结论与历史计划（2026-08-31 审计修订）

> 以下 Sprint 0–4 是保留的历史计划，不再代表当前待开发范围。本节顶部的“当前验证计划”优先级最高。

### 当前验证计划（唯一后续范围）

Sprint 0（交接与发布基线校准）、Sprint 2（全节点协议与能力审计）、Sprint 3（参考项目能力对齐审计）、导演台安排及 P0–P3 协议/能力优化已完成。本轮不新增节点类型、不调整导演台能力；后续只允许执行下列验证或由验证结果引出的缺陷修复。

1. 自动门禁：`npm run verify`、`git diff --check`，并记录准确测试数量。
2. 桌面人工回归：按 [docs/DESKTOP_ACCEPTANCE_CHECKLIST.md](./docs/DESKTOP_ACCEPTANCE_CHECKLIST.md) 验收画布、持久化、供应商、媒体、导入导出与 UI。
3. 性能与本地稳定性：运行 `benchmark:canvas` 的 100/500/1000 节点基线，并进行保存重开、异常恢复和离线运行检查。
4. 真实供应商回归：以用户本地已配置模型验证图片与视频；视频至少覆盖 Seedance/MiniMax H3 的 16:9、9:16、秒数、失败提示和取消。API Key 不进入日志、项目或仓库。
5. 导演台验收：只验证既有 v2 的重开、手动发布、下游视频参考连线、未发布无输出与导入导出重映射；图片直接建模不在本轮范围。

候选能力（图片模型精确 16:9/9:16 支持、反推提示词、放大、角度控制）已记录在 [docs/NODE_PROTOCOL_AUDIT_2026_08_31.md](./docs/NODE_PROTOCOL_AUDIT_2026_08_31.md)，不自动进入开发队列。

> R0–R7、IA-1、IA-2 已全部完成。以下计划按优先级排列，标注完成度与剩余工作量。

### Sprint 0：UI 优化收尾（立即）

目标：把本轮 UI 优化六阶段提交、验收、推送。

- [ ] 提交 12 个修改文件 + 3 个新增文件，commit message 参照 [docs/HANDOFF_2026_08_31_UI_OVERHAUL.md](./docs/HANDOFF_2026_08_31_UI_OVERHAUL.md)。
- [ ] 执行桌面端手工冒烟（验收路径见交接单第四节）：边框清除、Dock 放大、布局重组、节点分类 Tab、aiProcess 排版、右键编辑入口。
- [ ] 推送至远程，更新本节状态标记。

工作量：0.5 人日（含手工验收）。

### Sprint 1：桌面端回归基线（高优先）

目标：补齐自动化测试无法覆盖的桌面端 E2E 回归，为后续发布提供可重复的验收底稿。

| 任务                      | 状态      | 说明                                                                      |
| ------------------------- | --------- | ------------------------------------------------------------------------- |
| tldraw 端到端回归         | ⏳ 待执行 | 节点创建、双击编辑、拖动、连线、分组、撤销、保存重开、右键菜单与右侧详情  |
| 100/500/1000 节点性能基线 | ⏳ 待执行 | `pnpm benchmark:canvas` 生成基线，记录首屏/拖动/保存耗时                  |
| 批量媒体生成回归          | ⏳ 待执行 | P3.4：以已配置图片模型完成 20-100 项桌面端媒体生成回归（分镜→批量生图）   |
| 示例项目全链路验收        | ⏳ 待执行 | 四条链路：文本→生图、文本→AI处理→分镜→导演台、分镜→批量生图、视频节点链路 |
| `db.ts` 导入告警清理      | ⏳ 待评估 | 动/静态导入告警不阻断构建，但应在发布前确认无非预期 chunk 问题            |

验收：所有回归项可重复执行并留档；性能基线有量化数据；批量生成可暂停恢复且失败项可单独重试。

工作量：2-3 人日。

### Sprint 2：媒体资产与供应商体验（中优先）

目标：让真实生成链路更稳定、可追溯、可重试。

- 视频节点补"重新生成"和完整来源摘要（图片已有，视频/音频待补）。
- 资产库补筛选、按来源跳转、批量导出。
- 将供应商能力（文本/首帧/尺寸/时长/种子）结构化为驱动描述，UI 根据能力启用或禁用配置。
- 为异步视频任务补更精确的恢复、取消和错误分类。
- 严格保持 API Key 只在主进程本地使用，不写入日志、项目导出或模板。

验收：任意媒体能回溯到输入与模型配置；失败任务有明确可操作的恢复路径。

工作量：3-5 人日。

### Sprint 3：导演台体验完善（中优先）

目标：在既有 2D/3D 白模预演基础上提升预演指导价值，不破坏既有 I/O。

> 注：Three.js 白模视口已在前批功能中落地（场景、角色占位、机位变换、焦距和画幅）。本阶段聚焦体验完善而非新引擎。

- 支持从分镜同步镜头，并明确"同步覆盖"与"本地编辑保护"的冲突策略。
- 增加镜头顺序、参考图分区、相机预设和预演导出设置。
- 保持 `previs.camera@1`、`previs.project@2` 和现有帧/视频端口稳定。
- 评估"生成空间"从本地轻量白模升级为真实 Depth Anything 的可行性（仅替换 `previs-space-generator.ts` 适配器）。

验收：同一导演工程可重开、可编辑、可重新发布；旧的 PNG/WebM 下游连线完全兼容。

工作量：3-5 人日。

### Sprint 4：正式发布收尾（发布前必做）

目标：让单用户本地版本可安全升级和迁移。

- 生成 Windows 安装包回归矩阵：新装、升级、旧项目、导入导出和离线使用。
- 完善备份/修复 UI，而不是只保留 `.bak` 文件。
- 发布前执行依赖审计并复查 Electron 依赖链风险；`extract-zip@2.0.1` 公告需在 Electron 升级时重点复核。
- 为每次发布写节点契约变更记录与迁移说明。
- 发布前执行 [docs/DESKTOP_ACCEPTANCE_CHECKLIST.md](./docs/DESKTOP_ACCEPTANCE_CHECKLIST.md) 全量桌面验收门禁。

工作量：2-3 人日。

### 长期技术债（非阻塞，择机清理）

| 项目                          | 说明                                                                      |
| ----------------------------- | ------------------------------------------------------------------------- |
| `NodeCardProps.text` 字段复用 | 运行结果已统一写到 `meta.nodeResult`，但配置字段的彻底细分应在统一批次做  |
| 迭代节点并发                  | 当前严格串行；可控并发需先实现每项独立运行态隔离                          |
| 节点 Schema 细化              | 角色/场景/镜头独立版本化 Schema 可与列表协议结合，提供更细粒度元素 Schema |
| `db.ts` 动/静态导入           | Vite 告警不阻断构建，发布前确认无非预期 chunk 问题                        |

## 8. 已知边界与风险

1. 导演台已升级为 2D Canvas + Three.js 白模双视口预演（contractVersion 2），但非完整三维导演工具；其价值在于稳定镜头数据与可发布媒体输出。"生成空间"当前为本地轻量白模 fallback，外部图片→白模服务需经可插拔 Provider 适配。
2. 迭代节点已具备明确的 `out-item` 循环体边界、项级检查点、协作式暂停恢复和"分镜→批量生图"模板，但仍严格串行，不支持可控并发。
3. `NodeCardProps.text` 仍承担部分节点配置；运行结果已统一写到 `meta.nodeResult`，但配置字段的彻底细分应在 P2 统一做，避免零散迁移。
4. `pnpm build` 对 `db.ts` 的动态/静态导入会给出 Vite 告警，目前没有功能影响。
5. API Key 使用 Electron `safeStorage` 加密并兼容旧配置；仍禁止将 Key、授权头、真实模型配置或媒体数据提交到 Git。

## 9. Infinite Atelier 借鉴进度与 IA-2 计划

### IA-1 第三批：媒体结果体验（已完成）

- 图片资产和生图结果卡提供“继续生图”“生成视频”快捷入口；只创建真实节点和真实 `out-image -> in-image` 端口连线，失败时回滚孤立节点。
- 图片、生图、视频、音频结果卡统一展示来源摘要，并提供定位文件、复制路径和系统打开等本地操作。
- 四类媒体支持结果集合；重复生成追加最近 12 项候选，`selectedMediaId` 标记当前结果，切换后仍投影到原有 `out-image` / `out-video` / `out-audio` 端口。
- 支持清空历史候选并保留当前输出；音频结果采用播放器加轻量结果网格。
- 未新增节点类型、未新增隐藏端口、未改变既有节点契约；媒体仍以独立 `MediaAsset` 保存。

验收：`npm run lint`、`npm run typecheck`、`npm test`、`electron-vite build`、`git diff --check` 全部通过；合并线上更新后当前为 27 个测试文件、450 个用例，并已补充生图执行器的首次写入、重复追加、取消和失败回归。

### IA-2：资产与运行中心（IA-2.0–2.3 已完成）

1. **✅ IA-2.0 数据索引**：已从 `MediaAsset`、`meta.nodeRun` 和 `meta.nodeResult.results` 建立只读索引；包含来源节点、模型摘要、结果集合当前项、最近运行 ID/状态和资产时间，不复制 API Key、路径全文或完整提示词。
2. **✅ IA-2.1 资产筛选**：资产中心已支持类型、稳定来源 `nodeId`、最近运行状态、时间范围和安全关键词组合筛选；默认按最新资产排序，显示筛选后的数量。
3. **✅ IA-2.2 来源定位（节点部分）**：资产卡显示来源节点和“当前/历史”结果标记，可通过稳定 shape ID 选中并聚焦来源节点；节点已删除时明确提示且不修改项目数据。本地文件操作继续沿用既有安全 IPC。
4. **✅ IA-2.3 运行中心**：跨节点读取持久化的 `meta.nodeRun` / `meta.nodeRunHistory`，支持运行状态、节点/运行 ID/端口的安全搜索、定位来源节点和错误摘要；失败记录的重试仍通过统一 `runNodeManually → executor` 路径。资产卡可直接打开准确对应的运行记录。
   - 每个新媒体结果会写入产生它的 `runId`；索引优先从当前记录或历史记录精确匹配该运行，即使后续一次执行失败，也不会把既有资产误标为失败运行。旧结果没有 `runId` 时安全回退到节点最近记录。
   - 未新增端口、节点类型或隐式数据流；运行中心只读取既有持久化状态，不保存提示词全文、路径全文或密钥。
5. **✅ IA-2.4 自动化验收**：图片执行器已覆盖精确 `runId`、重复追加、取消和失败不写入；项目仓库已覆盖保存重开后媒体结果 `runId`、当前运行记录和历史记录不变。下一项只剩 Electron 人工路径：“生成图片 → 重复生成 → 切换结果 → 定位节点 → 查看运行记录 → 失败重试”；完成后再决定是否在音频结果网格中提供同样的运行入口。

本切片新增 `test/media-index.test.ts`、`test/run-index.test.ts`、`test/project-persistence.test.ts`，并补强 `test/media-result-executor.test.ts`；覆盖生成结果集合来源、当前/历史结果、稳定 `nodeId` 筛选、无运行记录资产、安全关键词、跨节点运行记录的去重排序和过滤、连续执行时每个媒体结果保留自身 `runId`，以及保存重开后该溯源记录不丢失。完整门禁通过，当前为 30 个测试文件、456 个用例。IA-2 仍保持本地单用户架构，不引入登录、团队、云端项目或权限系统；导演台真实 3D、图片转模型和供应商级批量候选不作为 IA-2 前置工作。P3.4 的真实桌面端批量媒体回归属于并行验收债务，不阻塞 IA-2 的索引与资产中心开发，但必须在发布前完成。详细借鉴差异与验收表见 [INFINITE_ATELIER_ADOPTION_PLAN.md](./docs/INFINITE_ATELIER_ADOPTION_PLAN.md)。

## 10. 不可提交内容

- `.docx` 原文、临时解析缓存、`node_modules/`、`out/`、安装包、日志。
- 本地 SQLite、项目目录、生成媒体、截图和性能产物。
- API Key、Authorization header、真实供应商 Base URL/配置。

每次交接至少应包含：提交哈希、变更摘要、通过的命令、人工验证路径、已知限制和下一步的唯一推荐项。
