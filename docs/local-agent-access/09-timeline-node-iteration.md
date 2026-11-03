# 轨道线节点（`timeline`）接入台账

日期：2026-11-02 · 范围：画布新增轨道线节点（M1–M5）· 方案：[轨道线轨道节点方案 v1.1](../../轨道线轨道节点方案-v1.1.md)

## 1. 本次变更

| 类别 | 内容 |
| --- | --- |
| 节点类型 | `ACTIVE_NODE_TYPE_IDS` 新增 `timeline`（可创建，`contractVersion: 1`） |
| 节点契约 | 输入 `in-video` video many / `in-audio` audio many / `in-image` image many；输出 `out-video` video（可选）；`outputSource: 'run'` |
| 尺寸机制 | `NodeTypeSpec.sizePolicy: 'standard' \| 'content' \| 'free'`；分镜板改 `content`，轨道线为 `free`（默认 880×420，宽高自由） |
| 新 IPC | `media:timeline-compose`（多素材合成）、`media:probe-metadata`（素材元数据只读探测） |
| 新 preload 通道 | `composeTimeline`、`probeMediaMetadata` |
| 新主进程模块 | `media/ffmpeg-runner.ts`（公共 spawn/进度/取消登记）、`media/media-probe.ts`、`media/timeline-compose.ts` |
| 新共享模型 | `shared/timeline.ts`（轨道线 JSON 模型与纯函数编辑） |
| 访问声明 | `NODE_ACCESS_DECLARATIONS` 增加 `timeline`，与 Active 清单保持一致 |

## 2. 兼容性结论（接口 Schema 变化）

`node.type.list` 的**输出** Schema 中的节点类型枚举新增 `timeline`。这是**加法变更**：

- 字段、必填性、operationId 与 transport 均未改变；
- 已有消费方读取该列表不受影响，只是多出一个合法取值；
- 未新增或修改任何 `ACCESS_OPERATIONS` 的输入 Schema；
- 节点动作仍为 `planned`：本次**没有**声称轨道线可由外部 Agent 自动执行。

因此本次以 `--accept-contract-change` 显式确认，而不是静默刷新哈希。

## 3. 持久化与迁移

- 轨道线内容存 `props.text`（JSON，`schemaVersion=1`），不新增 tldraw shape prop，无快照 schema 迁移。
- 片段媒体引用使用独立字符串字段 `mediaId` / `mediaPath`，进入既有项目包导入重映射链路
  （`shared/media-reference-remap.ts`、`main/store/transfer.ts`、`flow-transfer.ts`）。
- 已知边界：画布**结构导出**会按 key 正则丢弃 `media*` 字段，轨道线经结构导出再导入会丢素材引用；
  这不是本次引入的新行为，轨道线迁移请使用项目复制 / 项目包。

## 4. 日志影响

- 执行器 `shared/engine/executors/timeline.ts` 记录 `input` / `execution` / `result` 阶段，只含轨道数、
  片段数、总时长与画布尺寸；不记素材路径、文件名、媒体 ID 或用户正文。
- 成功/失败/取消的**唯一终态**仍由公共运行器记录，执行器不重复记终态。
- 主进程合成阶段（prepare/render/mux）目前未发独立诊断事件，已登记到
  [日志覆盖清单](../LOGGING_COVERAGE.md)「轨道线合成」行的待补内容。

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

## 5.1 真机验收（2026-11-02，Electron + 真实 IPC + 真实 FFmpeg）

脚本：`scripts/test-timeline-electron.cjs`。播放真实 Electron（`CANVAS_DATA_DIR` 隔离），只在主进程把
文件选择框换成固定返回，其余全部走真实链路（media IPC、ffprobe 探测、ffmpeg 合成、tldraw 指针交互）。
运行：`node scripts/test-timeline-electron.cjs`；截图落在 `qa/timeline-electron-<时间戳>/`。

**结果：21/21 通过。** 覆盖：节点从面板创建、默认 880×420、加轨道、本地导入图片/视频/音频并分轨、
拖动片段、时间轴随内容增长、播放头分割、Delete 删除片段、撤销、空白拖动整卡、全屏编辑、运行合成、
成片落盘核验（12.07s / 1920×1080 / 含音轨）、项目持久化。

真机暴露并修复的 4 个问题（单元测试与静态门禁都发现不了）：

1. **新节点在创建面板不可见**：面板按 `workspaceProfile.visibleNodeTypeIds` 过滤，而项目预设与
   localStorage「上次创建配置」都是历史快照。修复：`GENERAL_WORKSPACE_NODE_TYPES` 加入 `timeline`；
   `normalizeWorkspaceProfile` 的 `general/all` 补入成员；`ProjectCreateDialog` 读 localStorage 前先归一化。
2. **节点内按钮点不动**：指针事件冒泡到画布后被 tldraw 接管并 preventDefault，click 永不触发。
   修复：`.tl-surface` 捕获阶段只对真正的控件（`button` / `[role="menuitem"]`）阻止冒泡，
   不拦片段条、刻度尺与空白。
3. **全屏编辑 Esc 关不掉，且内联与全屏各挂一份实例导致状态分叉**：修复 Esc 监听，并改成
   「内联与全屏只渲染一份 surface」，共享状态留在父组件。
4. **Delete 删掉整张节点而不是片段**：`CanvasEditor` 的 window 捕获删除优先于节点，
   焦点在 body 时还会绕过它的 controlFocus 吞键。修复：选中片段时让节点进入 tldraw 编辑态
   （`canEdit` 允许 timeline + `setEditingShape`），画布关闭自身快捷键；片段选中态改为派生值，
   节点失选即失效，画布删除语义恢复。

## 5.2 2026-11-02 第二轮回修（用户真机反馈）

用户反馈「节点根本找不到 / 不叫时间线叫轨道线 / 横向拉伸时间轴不跟着出来 / 轨道名被截断 / 图标太丑」。
对应改动：

1. **改名**：节点标签由「时间线」改为「轨道线」，类型 ID 仍为 `timeline`（稳定 ID 不随文案变）。
   UI 文案（添加成功提示、重置、全屏编辑标题）同步；合规矩阵、颜色规范、契约规范、接入台账同步。
2. **找不到节点的根因**：项目保存的 `visibleNodeTypeIds` 是历史快照，`custom` 预设还会绕过预设补丁。
   新增 `WorkspaceProfile.nodeSetRevision`（当前 2）与 `NODES_ADDED_BY_REVISION`，`normalizeWorkspaceProfile`
   对**所有预设**按版本一次性补入 `timeline`；之后用户再隐藏不会被反复加回。创建对话框读 localStorage 前也归一化。
3. **时间轴随卡片宽度增长**：内容宽度 = max(卡片可视宽, 时间线自然宽)，用 ResizeObserver 跟随卡片尺寸；
   拉宽卡片逐步显示后面的时间，只有内容超过视口才横向滚动。真机断言：刻度宽 721px = 可视宽 721px。
4. **轨道名完整显示**：轨道头宽度 96 → 132，「视频 1 / 音频 1 / 音频 2」不再截成「视…」。
5. **图标重绘**：顶部时间刻度 + 两条错位轨道片段 + 贯穿播放头，同时体现「时间」与「轨道」。

同日另修一个**跨节点**的空态居中问题：`NodeIdentity` 原来用 CSS `:has()` 判断「是否只有图标」，
结构上存在隐藏子项（`<small>`、条件隐藏的 `.node-wiring`）的 8 个节点被误判为「有内容」而退回 flex
布局，纵向偏 20~30px（JSON / P图 等）。改为运行时测量「有没有看得见的子项」并用
`data-icon-only` 驱动绝对居中；全量审计 32 个节点后偏心数 0（审计脚本
`scripts/audit-node-identity-centering.cjs`，截图 `qa/node-identity-centering-*`）。

**Agent 相关同步**：轨道线成片现在可以作为固定资产/审核输入——`DETERMINISTIC_PROJECTIONS.timeline`
投影 `out-video`，`asset-store` 把轨道线成片按本地已落盘媒体固化（与 `video-asset` 同路径）；
Agent 自动调度仍显式不支持：`flowTargetContract` 返回 null，准入处给出 `FLOW_TYPE_UNSUPPORTED` /
`AGENT_TARGET_UNSUPPORTED`，原因已写进
[节点协同规范](../canvas-agent-flow/05-node-coordination-standard.md) 与
[能力矩阵](02-capability-matrix.md) 第 3 节 `timeline@1` 行。

## 5.3 2026-11-02 第三轮（工程节点可见性 + 批量 UI 反馈）

1. **重启后仍找不到轨道线的真正根因**：`openProject` 读盘时没有归一化 `workspaceProfile`，
   只有「新建项目 / 保存工作台设置」才走 `normalizeWorkspaceProfile`。旧项目读出来仍是历史快照，
   面板永远过滤掉新节点。修复：读盘即迁移（`projects.repo.ts` `openProject`），并补
   `test/project-profile-migration.test.ts`（5 项：general/custom 旧快照补入、已是最新版本不被反复改写、
   无 profile 的旧项目保持「显示全部」、新建项目落盘带版本号）。
2. **视频节点「定位/复制」图标消失**：v1.5「文字按钮去图标」规则的 `:is(... .node-media-next-actions button) > svg`
   过宽，把纯图标按钮的图形也隐藏了。修复：补纯图标按钮的例外规则。
3. **节点详情分页**：由左侧竖排 76px Rail 改为顶部横向均分一行（`概览/输入输出/设置/运行/协作`），
   详情面板宽度 292→360px（窄屏 320→360），5 项按钮高度 50→32，四类/五类节点同一布局。
4. **数字步进器统一**：新增公共 `NumberStepper`（输入框 + 右侧自绘 +/− 大点击区，隐藏原生 spin 按钮）；
   声音调整节点三处数值改用该组件，字段材质与其他设置项统一（36px 高、8px 圆角、等宽数字）。
5. **Agent 节点空态**：删掉「专业 Agent · 人机协作」摘要行；任务目标改为 132px 高、8px 圆角输入框。
6. **语音节点文案精简**：克隆节点去掉「添加辅助提示音」（与参考语音上传重复，配置字段保留兼容旧项目）；
   本地 IndexTTS 去掉「未设置参考音频」「截断 15 秒」两条冗余提示，保留格式/时长建议。
7. **MiniMax 音色计费口径查证**：设计与克隆本身不立即收费（9.90 元/音色延迟到首次合成），
   但接口内试听按 TTS 字符计费；证据与本仓实现受影响点见
   [MiniMax 音色计费备忘](11-minimax-voice-billing-notes.md)。
8. **数字步进器全量推广（19 处）**：`NumberStepper` 已覆盖 chat(2)、iterate(3)、image-split(6)、
   aiProcess(3)、agentFlow 设置(1)、SkillAgentSettings(1)、ResourceQueuePanel(1)、DirectorStudioPanel 焦距/时长(2)；
   导播台的相机 X/Y/Z/方位/俯仰/景深/缩放共 5 处保留原生输入（9–10px 三列紧凑网格，36px 控件会撑破布局），
   已用原生箭头放大方案统一外观。空值与回退语义（`|| 35` / `|| 5` / `|| 4096`）逐处保留。
9. **重启可见性端到端验证**：新增 `scripts/test-track-palette-migration.cjs`——在隔离数据目录里
   创建项目→把 `workspaceProfile` 降级成升级前快照→重启应用→从项目列表打开→断言创建面板出现
   「轨道线」→创建→保存后 `project.json` 含 timeline 节点且带 `nodeSetRevision=2`。**6/6 通过**。

## 5.4 2026-11-02 第四轮（轨道通用化 + 图标重设计）

1. **轨道通用化（用户裁决）**：轨道不再分视频轨/音频轨。数据模型删除 `TimelineTrack.kind`
   （旧数据读入即丢弃），`addTrack()` 不再要类型；合成按**片段 kind** 分流；同轨重叠只约束画面片段
   （音频允许重叠混音）。界面：`+ 轨道` 直接加通用轨道，轨道名 `轨道 N`，轨道头统一层叠图标，
   空轨道提示改「添加素材到这条轨道」。默认两条轨道。
2. **默认高度 = 两条轨道**：`TIMELINE_UI.height` 420 → 210（minHeight 188），
   即工具栏 + 刻度尺 + 2×56 轨 + 内边距，不再留大片空白；需要更多轨道时拖高即可。
3. **图标重设计（Stitch）**：用 Stitch 生成 24×24 图标方案（工程
   `projects/14292186424646713784`），取 Variant A 并改良：时间尺 + 3 个向下刻度（朝上会被读成日历）
   + 两条错位轨道片段 + 贯穿播放头。
4. **验收脚本同步**：22 项真机检查改为通用轨道语义（音频可进任意轨道，两次导入验证），
   成片时长改为与时间线总时长比对（不再写死 12 秒）。**22/22 通过**。

## 5.5 2026-11-03 全屏编辑器（Stitch 设计）

用户要求「轨道线全屏编辑做成素材库 + 预览 + 时间轴三段式，并用 Stitch 优化整体页面」。

**Stitch 设计**：工程 `projects/2480681342899761748`，生成「Calibrated Studio Workspace」设计系统：
画布 `#0E1116` / 面板 `#191D24` / 描边 `rgb(255 255 255 / 7%)` / 强调色 `#239AD3`（播放头、选中、导出）/
文本 `#E6EDF7` 与 `#8A97A8` / 8px 间距网格 / 面板 12px、片段 4px、控件 6-8px 圆角 / 轨道 44px。
实现落在 `bodies/timeline-editor.tsx`（新增）+ `timeline.css`（编辑器段落）。

**功能**：
1. 顶栏：节点图标 + 「轨道线」+ 元信息（轨道数 · 片段数 · 总时长）+「导出成片」（走 `runNodeManually` 合成）+ 关闭。
2. 左侧素材库：已导入资产 / 画布资产（扫描画布节点持有的媒体）；全部/图片/视频/音频筛选；`+ 导入`；
   16:9 磁贴带类型角标与时长；点击追加到当前轨道，**拖拽可按落点时间插入**（`onDropAsset` → `addClip(startMs)`）。
3. 中间预览：1920×1080 角标（读 config.render）；播放/暂停按墙钟推进播放头，视频低频纠偏；
   悬浮 transport（时间码、±1s、静音标识）。
4. 底部时间轴：复用卡片内 TimelineSurface，模态内改为 44px 轨道、按片段类型着色（视频蓝 / 图片紫 / 音频绿）、
   `#239AD3` 播放头；隐藏重复的「退出」按钮（关闭交给顶栏 X / Esc）。
5. 素材库导入不直接改时间线：仍需点击或拖拽才落片段，避免「导入即铺轨」的隐式行为。

**验收**：`scripts/test-timeline-electron.cjs` 扩到 29 项并重排顺序——合成出片在「未加编辑器素材」的
17s/6 片段场景验证，编辑器 7 项在其后独立验证。**29/29 通过**。

**已知问题（下一轮处理）**：把编辑器里新增的 3 个片段（含同一媒体重复引用、两轨音频）叠加后，
时间线变 28s/9 片段时点「运行/导出成片」，主进程停在 `开始合成：1920x1080@30fps` 不再推进
（`meta.nodeRun` 一直 running；隔离目录里可复现）。当前验收已改为先合成、后编辑，避免踩到；
但产品路径上「编辑后再导出」必须修——需要给 `composeTimeline` 的 normalize/concat 阶段加超时，
并排查重复媒体引用与多轨音频混音的挂起原因。
## 5.6 2026-11-03 第二轮：剪映形态编辑器与多选顺序/吸附/长按拖动

用户新需求（原话要点）：框选多个素材要按选择顺序；引用到轨道后能长按拖动到轨道里；
提供「默认吸附」开关（关掉可随意拖动）；全屏编辑做成剪映那样的结构（素材库 + 播放器 + 时间轴，
导入本地/资产库、比例、导出、全屏播放、音量、撤销重做、分割、左右裁剪、删除、吸附、时间轴缩放）。

实现（`bodies/timeline-editor.tsx` + `timeline.tsx` 工具栏）：
1. **多选按选择顺序**：素材库 Ctrl/⌘+点击多选、Shift 范围选择，磁贴左上角显示 1/2/3 顺序徽标；
   `加入轨道` 按选择顺序依次追加（`addAssetsToTrack`），先选中的排前面。双击单个素材直接追加。
2. **长按拖动**：素材 pointerdown 长按 220ms 起拖，带浮层预览（`.tl-asset-ghost`），松手时按落点
   换算时间插入到对应轨道；未到时长就移动视为滚动/点选，不会误触发。
3. **自动吸附**：工具栏磁铁开关，默认开；拖动/裁剪时把目标的「起点/终点」吸附到同轨相邻片段边缘、
   时间线起点与播放头（阈值 8px，按缩放换算），关闭后自由拖动。
4. **工具栏补齐**：撤销 / 重做 / 分割 / 向左裁剪 / 向右裁剪 / 删除 / 自动吸附 / 加轨道 / 添加素材 /
   时间码 / 时间轴缩放 / 全屏。（撤销重做走画布历史，裁剪把边缘拉到播放头。）
5. **预览增强**：比例选择（16:9/9:16/1:1/4:3，只影响预览）、音量滑杆（作用于预览视频声音）、
   全屏播放（画框 requestFullscreen）。
6. **布局切换**：素材库可在左 / 在右 / 收起三种布局间循环（`.tl-editor-main.is-bin-*`）。
7. **不再提供「画布资产」tab**：按用户要求删除；上游连线素材仍由节点首次自动铺轨覆盖。

验证：`scripts/test-timeline-electron.cjs` 扩到 **35 项，35/35 通过**，新增覆盖：
多选编号顺序、按选择顺序加入轨道（对比 mediaId 顺序）、长按浮层与落点插入、吸附精确贴齐
（吸附后 left=1806 与前段右边缘 1806 一致）、关闭吸附、布局三态切换、预览播放推进。

## 5.7 2026-11-03 真机缺陷修复：连线静默铺轨（与需求不一致）

用户截图反馈：连线素材后节点顶部出现 4 个素材缩略图（通用引用区），轨道里也被自动塞满片段，
与「先引用、再自己长按拖进轨道」的预期不符。

**根因**：轨道线复用了通用「已连接输入」引用区；同时节点首次渲染会把所有连线媒体 **自动铺到第 1 条轨道**
（`timeline-import-upstream`），顺序由边顺序决定、用户无法控制，也无法选择落点。

**修复**：
1. 节点不再自动铺轨；连线只产生「引用素材」。
2. 顶部改为轨道线专用引用素材条（`.tl-refs`）：按连线/选择顺序排列，点一下按顺序追加到当前轨道末尾，
   **长按 220ms 可拖到任意轨道任意时间点**；`NodeCardView` 的 `hasDedicatedInputSurface` 增加 `timeline`，
   避免通用引用区重复出现。
3. 追加多素材时显式给起点（`cursor` 从时间线总时长开始首尾相接），不再依赖各片段的「追加到末尾」推算。
4. 已有项目里历史上被自动铺进去的片段保持不动（数据不丢），用户可自行删除或撤销。

**验收**：`scripts/test-timeline-electron.cjs` 扩到 **39 项，39/39 通过**，新增 4 项：
连线素材出现在引用素材条、连线不再自动铺轨（clips 6 → 6）、点击引用素材追加到轨道、
长按引用素材拖到第 2 条轨道指定位置。

## 5.8 2026-11-03 第三批：分割三态、轨道排序、缩放滚轴、首帧封面、分隔条

用户对照剪映样式提出的一批交互修正，逐条落地：

1. **分割三态**：工具栏改为「分割 / 向左分割 / 向右分割」。分割=切成两段都保留；向左分割=保留切点左侧、删掉右侧；向右分割=保留右侧、删掉左侧。共用 splitClipKeep() 边界校验（test/timeline-model.test.ts 覆盖三态与贴边拒绝）。
2. **轨道拖动排序**：拖动轨道头上下移动，moveTrack() 只调整轨道顺序，片段跟着自己的轨道走（不再出现「拖到前面却显示同一轨片段」）。拖动时有目标行高亮。
3. **时间轴缩放滚轴**：缩放从两个图标改为「− 滑杆 +」（滑杆值对应 pixelsPerSecondSteps），与剪映一致。
4. **视频首帧封面**：新增 media-thumbnail.tsx，用隐藏 <video> 解码 0.1s 抽帧到 canvas → dataURL（按路径缓存），用于素材库磁贴、时间轴片段、引用素材条，不再用播放图标占位。
5. **全屏播放条精简**：播放键 + HH:MM:SS / HH:MM:SS + 比例下拉（16:9/9:16/1:1/4:3）+ 音量 + 全屏；去掉 ±1 秒按钮，比例从顶栏移入播放条。
6. **全屏时间轴高度可调**：预览与时间轴之间新增分隔条（.tl-timeline-splitter），上下拖动调整时间轴占比（22%–62%）。
7. **播放头样式统一**：全屏不再单独把播放头改成蓝色粗线，与非全屏保持同一条细线 + 三角头。
8. **改名同步**：媒体 id → 画布节点标题映射（mediaTitles），视频/图片节点改名后，轨道片段与引用素材条立即显示新名字。
9. **吸附图标**：改为「链接 / 断链」两种状态图标（link / link-off），开启时高亮。

验证：scripts/test-timeline-electron.cjs 扩到 **46 项，46/46 通过**，新增覆盖：向左/向右分割结果、轨道拖动排序、缩放滚轴、首帧封面存在、播放条时间码格式、全屏分隔条存在。typecheck、eslint、build、verify:logging、verify:agent-access 通过。

## 5.9 2026-11-03 第四批：引用素材池与二级导入菜单、连线宽度减半

用户澄清：左侧「全部/图片/视频/音频」不是整个项目素材库，而是**与轨道线连接的素材**；
导入分「从本地导入 / 从画布导入」两种，应做成二级菜单；删除操作提示语；节点间连线宽度减为一半。

实现：
1. **引用素材池落盘**：TimelineData.references（TimelineReference[]，只存 mediaId/mediaPath/name/kind，
   不产生片段），addReferences() 按传入顺序去重、removeReference() 移除不影响已铺片段；
   
normalizeTimeline 负责旧数据补空数组与往返序列化。
2. **左侧面板 = 引用素材池**：全屏编辑器素材库改为「已落盘引用 ∪ 当前连线素材」，
   按连线/导入顺序展示，类型筛选（全部/图片/视频/音频）作用在引用池上。
3. **导入二级菜单**：导入 展开「从本地导入 / 从画布导入」。本地导入只加入引用池（**不自动铺轨**）；
   从画布导入取当前选中的媒体节点（按选择顺序），未选中时回退导入画布上全部媒体节点并提示。
4. **删除提示语**：素材库底部「点击多选…长按拖到轨道…」文案移除，只保留「加入轨道（N）」按钮。
5. **连线宽度减半**：.data-edge-visible 3 → 1.5，.data-edge-flow 4.5 → 2.25，
   追溯线 .artifact-provenance-edge 同步 1.5（命中热区仍保持 14px 不变）。

验证：
- scripts/test-timeline-electron.cjs **50/50**：新增「引用素材提示语已删除」「导入是二级菜单（本地/画布）」
  「从画布导入把选中素材加入引用素材」「从本地导入只进引用素材、不直接生成片段」。
- test/timeline-model.test.ts 新增引用池 3 项（顺序去重、序列化往返、移除不影响片段），32 项通过。
- typecheck(node/web)、eslint、electron-vite build、verify:logging、verify:agent-access 通过。

## 5.10 2026-11-03 第五批：两处入口统一为「长按拖拽落轨」

用户裁决（对照「引用素材条」与「素材库」两张截图）：两个入口的行为要一致——**单击只选中，长按拖到哪条
轨道就加到哪**；原来的「一点就追加到当前轨道」太隐式，要求去掉。

实现：

1. **引用素材条（节点内 `.tl-refs`）**：`pointerup` 不再调用落轨；单击改走选中（Ctrl/⌘ 切换、Shift 连选），
   选中项加 `.tl-ref.is-selected`（与素材库选中态同色 `#239ad3`）。长按 220ms 后拖到 `[data-timeline-lane]`
   才落轨，落点即 `startMs`；多选时按选择顺序整组拖入。
2. **素材库（全屏编辑器 `.tl-bin`）**：删除底部「加入轨道（N）」按钮与 `.tl-bin-footer` / `.tl-bin-append`
   样式；删除磁贴双击追加；单击仍负责多选编号，落轨只走长按拖拽。落轨成功后清空选中。
3. **拖动浮层**：多选拖动时浮层显示「N 个素材」，单个仍显示名称。
4. **文案**：磁贴 `title`、引用条 `title`、空态提示改为「点击选中 … 长按拖到目标轨道」；
   素材库空态改为「先点「导入」添加，再长按拖到轨道」。
5. **顺带修复**：`bodies/timeline.css` 里 4 行 GBK 注释导致整个文件不是合法 UTF-8（工具无法读取），
   按行转成 UTF-8，只改注释字节，样式值未变。

日志影响：不涉及。纯交互呈现变更，落轨仍复用既有 `addAssetsToTrack` → `addClip` 链路，未新增执行、
文件或数据路径，执行器与主进程合成日志沿用 5.8 的覆盖结论。

验证：

- `scripts/test-timeline-electron.cjs` **53/53 通过**（真机 Electron + 真实拖拽）。替换/新增 6 项：
  「单击引用素材只选中，不直接追加到轨道」「素材库不再提供「加入轨道」按钮」「长按拖动能把多选素材一起
  放到轨道落点」「落轨顺序与选择顺序一致（先选在前）」「落轨后素材库清空选中」「素材库选中态与
  data-selected-ids 一致」；自动吸附用例改到多选落轨的第 3 条轨道上验证。
- `typecheck:web` 通过；`eslint`（改动文件）通过；`electron-vite build` 通过。
- 单测 `test/timeline-model.test.ts` / `test/node-ui-decisions.test.ts` / `test/timeline-executor.test.ts`
  共 147 项通过；模型与契约未改动。

## 5.11 2026-11-03 第六批：视频图标去掉下方箭头 + 拖拽虚影/浮层贴指针

用户真机截图反馈两点：一级菜单「视频创作」用的视频图标下面多了一个横向箭头，丑；长按素材拖动时，
浮层（写着 video）离鼠标几百像素，且源素材没有任何「被拖走」的提示。

实现：

1. **`video` 图标重绘**（`components/Icon.tsx`）：删除下方横向箭头路径，视频框由 18×11 改为 18×17 撑满
   24 格高度，播放三角居中。一级菜单「视频创作」与「视频生成」节点共用同一图标，所有引用处同步生效。
   `docs/UI_ICON_SYSTEM.md` 的 `video` 行与 I6 几何段同步更新。
2. **浮层定位修正**：`.tl-asset-ghost` 原来渲染在画布节点 DOM 内，画布祖先带 `transform`，`position: fixed`
   被当作相对该祖先定位，导致浮层偏到别处。改为 `createPortal` 挂到 `document.body`（引用素材条与素材库
   两处都改），坐标即视口坐标。
3. **浮层外观**：由「图标 + 文字」改为「媒体缩略图 + 名称 + 多选数量徽标」，单/多选都跟随鼠标。
   （位置口径在 5.12 修正：浮层中心与指针重合，不再悬在指针上方。）
4. **源素材虚影**：拖动中给源磁贴/引用条加 `.is-dragging`，`opacity: .35`，松手或取消即恢复；
   与浮层一起形成「原地虚影 + 指针处预览」的拖拽反馈。

日志影响：不涉及。纯图标与拖拽呈现变更，未触碰执行、数据、文件路径。

验证：

- `scripts/test-timeline-electron.cjs` **57/57 通过**（真机 Electron + 真实鼠标拖拽）。新增 4 项：
  「长按引用素材时源素材淡出成虚影」「拖动浮层跟随鼠标（不再偏到别处）」（实测浮层中心 x 与鼠标一致、
  位于指针上方约 33px）「长按素材时源磁贴淡出成虚影（多选两个）」「素材库拖动浮层跟随鼠标」。
- 图标几何另用 Playwright 渲染 96px/16px 对比图人工确认（`video-icon-compare.png`，临时文件，未入库）。
- `typecheck:web`、`eslint`（改动文件）、`electron-vite build`、`verify:agent-access` 通过。

## 5.12 2026-11-03 第七批：拖拽浮层贴合指针、落轨自动避让、默认高度与全屏分隔条

用户真机反馈四个问题：① 长按素材时浮层「突然蹦到鼠标上方」；② 拖到轨道一空白处却报
「该位置已有片段」；③ 默认高度只显示约 1.6 条轨道；④ 全屏拖动时间轴分隔条「拖不动」。

排查结论（用用户真实项目数据核对）：

- 用户时间线 `轨道 1` 上是首尾相接的多段 10042ms 片段（0–10.04s、40.17s 起连续 10 段），
  视觉上「看起来空了」的位置其实紧贴片段边界，落入位置只要差几十毫秒就会命中已有片段。
- 拖拽浮层当时用 `translate(-50%, -135%)` 悬在指针上方约 55px：用户按看到的浮层去瞄落点，
  真实指针落在下方约 55px，于是要么命中下方的已有片段（报重叠）、要么落到轨道外（静默不落轨）。
- 节点默认 210 高只按「工具栏+刻度尺+2 轨」估算，未计入 2026-11-03 新增的引用素材条（31px），
  实测滚动区 117px < 内容 136px，第二条轨道被裁掉约 40%。

实现：

1. **浮层贴合指针**：`.tl-asset-ghost` 改为 `translate(-50%, -50%)`（中心与指针重合），
   并降到 `opacity: .92`，既贴手又不完全挡住落点。
2. **落轨自动避让**：`shared/timeline.ts` 新增 `resolveClipDurationMs()`（与 `addClip` 同一时长算法）
   与 `freeStartMsFor()`（画面片段从期望起点向右找第一个放得下的空档；音频仍允许叠放）。
   `addAssetsToTrack` 先用它算出实际起点再 `addClip`，发生顺延时提示「已顺延到后方空档」，
   不再直接抛「该位置已有片段」。
3. **落点兜底与反馈**：引用素材条与全屏素材库的落点解析都加了「取纵向最近轨道 + 横向夹紧」兜底；
   松手仍没有目标轨道时给出明确 toast，而不是静默无反应。
4. **默认高度 210 → 230**：`TIMELINE_UI.height`，两条轨道带引用素材条后完整可见
   （实测滚动区 137px = 内容 137px，两行都 visible）；`minHeight` 仍 188。
5. **全屏分隔条**：命中区 10px → 18px，抓手由 20% 宽的 3px 细线改为居中 104×4px 圆角条，
   悬停/按下变品牌色，加 `touch-action: none`。
6. **旧节点升档迁移**：`needsTimelineHeightMigration()`（registry）+ `migrateLegacyNodeSizes()`；
   打开项目时只把「高度正好等于旧默认 210」的轨道线节点升到当前默认 230，用户手动调过的高度不动。
   用户当前项目 `迪斯尼动画` 实测：打开后被迁移为 880×230 并落盘。

日志影响：不涉及。落轨仍走既有 `addClip` 编辑链路，只改了起点计算方式，未新增执行/数据/文件路径。

验证：

- `scripts/test-timeline-electron.cjs` **58/58 通过**（真机 Electron + 真实鼠标拖拽）。新增/改写 5 项：
  「默认尺寸按两条轨道完整可见（880×230）」「拖动浮层中心与鼠标重合」（实测 (896,275)=(896,275)）、
  「素材库浮层中心与鼠标重合」（594,576 = 594,576）、「拖到已占用位置自动顺延落轨（不报『已有片段』）」
  （片段 9 → 10）、「全屏分隔条拖动可放大时间轴（命中区≥18px）」（时间轴 314 → 422px）。
  同时把两处「节点被画布裁剪导致漏数」的断言改成先框选视野再统计（成片节点、新建素材节点）。
- `test/timeline-model.test.ts` 新增「落轨避让」4 项（顺延、连续顺延、音频不避让、时长算法一致），
  36 项通过；`test/registry.test.ts` 新增旧高度迁移 4 项，29 项通过；
  `typecheck:web`、`eslint`、`electron-vite build`、`verify:agent-access` 通过。
- 全量 `npm test`：2698 项通过，唯一失败仍是与本次无关的既有项
  `test/provider-preset-modality.test.ts`（indextts 语音模型枚举）。
- 真机几何实测：节点 880×230、两行轨道 `visible=true`、浮层中心与指针 dx=0.00/dy=-0.01。

## 5.13 2026-11-03 第八批：图标按钮、吸附贴合、免长按拖拽、播放器重排、默认三轨

用户对照截图提出一批修正，逐条落地：

1. **分割/删除改纯图标**（`timeline.tsx` 工具栏，全屏共用同一组件）：删除「分割」「删除」的文字，只留图标；
   图标几何按用户点名重绘——分割=左右方括号实心 + 中间虚线切点；向左分割=左实心/右虚线（删右侧）；
   向右分割=左虚线/右实心（删左侧）；删除=垃圾桶。`docs/UI_ICON_SYSTEM.md` 增补三条图标说明。
2. **自动吸附真的贴得上**：新增 `resolveMoveStartMs()`（`shared/timeline.ts`）——拖动整段时起点/末端
   都参与吸附（原来只吸起点），落点与同轨画面片段重叠时直接贴到最近的重叠片段前/后边缘（首尾相连），
   不再出现「开着吸附也贴不上、松手报重叠」；阈值 8px → 12px。
3. **免长按拖拽**：引用素材条与全屏素材库改为「按下即拖」——位移超过 4px 立刻起拖并显示浮层/虚影，
   位移 ≤4px 视为单击选中；两处的「长按」文案同步改掉。
4. **去掉媒体悬停解释**：时间轴片段、引用素材条、全屏素材磁贴的 `title` 全部移除，悬停不再弹名称/时长说明。
5. **全屏播放器重排**（`timeline-editor.tsx` + `timeline.css`）：播放条从画面内浮层改为视频下方的独立一行
   （`.tl-preview` 改纵向 flex，`.tl-transport` 静态 44px），不再遮挡视频；左侧播放键 + HH:MM:SS / HH:MM:SS，
   右侧预览比例、音量、全屏，与用户给的参考图一致。视频区占上方全部剩余高度。
6. **导出成片按钮**：改用与顶栏「运行」按钮同一套主按钮材质（渐变蓝 + 同样的描边/阴影/圆角）。
7. **默认三条轨道**：`createEmptyTimeline()` 默认 3 轨；`TIMELINE_UI.height` 230 → 286、新增
   `trackCount: 3`；打开旧项目时一次性迁移——旧默认高度（210/230）升到 286、旧的默认两轨用
   `padTimelineTracks()` 补齐到三轨（只补空轨，不删轨道/片段），自定义高度不动。
   定位针高度 = 刻度尺 + 轨道数 × 56，三轨后正好覆盖三条轨道。

日志影响：不涉及。仍是纯交互/呈现变更，落轨、拖动都复用既有 `addClip` / `moveClip` 编辑链路。

验证：

- `scripts/test-timeline-electron.cjs` **58/58 通过**（真机 Electron + 真实鼠标）。断言同步为新默认
  「880×286 / 默认三条轨道」，引用素材拖动改「按下移动 8px 即出现虚影（无需长按）」。
- `test/timeline-model.test.ts` 41 项通过（新增拖动吸附 4 项：起点贴合、末端贴合、拖到片段内部自动贴边、
  关闭吸附保留原位；新增三轨默认与补轨迁移 2 项）；`test/registry.test.ts` 29 项通过（旧高度 210/230 迁移）；
  `test/migration.test.ts` 63 项通过。
- `typecheck:web`、`eslint`、`electron-vite build`、`verify:agent-access` 通过。
- 真机几何实测：节点 880×286；全屏播放条位于视频下方（视频底 416、播放条 424–468，不再重叠）；
  时间轴默认三行轨道。视觉截图：`qa/timeline-*`（本轮临时图未入库）。

## 5.14 2026-11-03 第九批：磁吸落轨、连续缩放 + Ctrl 滚轮、间距压缩

用户真机反馈：

1. **吸附开着却连不上**：把素材拖到已有片段的轨道上，落点没和前面的片段接上。
2. **吸附按钮的提示语多余**：「关闭后片段可自由拖动」这类解释不需要。
3. **缩放颗粒度太粗、图标又丑又小**；希望全屏编辑里按住 Ctrl 滚动就能细调缩放。
4. **全屏间距太高**：想要默认按三条轨道预留高度，调整间距的拖动条压缩成一条线。

实现：

1. **磁吸落轨**（`shared/timeline.ts` 新增 `snapDropStartMs()`）：吸附开启时，拖入的素材自动吸到
   轨道上最近的**合法片段边缘**——片段末尾（往后接）或片段开头减自身时长（往前插），无论落点多远
   都会首尾相连；空轨保持落点原样；音频允许叠放、不参与磁吸；关闭吸附时只做「避开重叠」。
2. **去掉吸附解释文案**：吸附按钮只保留 `自动吸附：开/关` 的无障碍名称，不再挂解释性 tooltip。
3. **连续缩放 + Ctrl/⌘ 滚轮**：缩放从 5 档离散值改为连续值（8–240 px/s）；滑杆直接映射像素/秒，
   −/+ 按钮按 1.3 倍，Ctrl/⌘ + 滚轮按 1.12 倍细调（全屏弹窗内任意位置有效，时间轴区域内优先接管）；
   缩放图标由放大镜改为 16px 的 − / +，按钮 24px。
4. **全屏间距压缩**：时间轴区默认高度改为固定 240px（正好三条轨道：工具栏 36 + 刻度尺 24 + 3×56 + 内边距），
   分隔条从 18px 方块压缩为「1px 视觉线 + 8px 命中区」，悬停变品牌色，上下拖动仍可调高度。

日志影响：不涉及。仍是纯交互/呈现变更，落轨复用 `addClip`、拖动复用 `moveClip`。

验证：

- `scripts/test-timeline-electron.cjs` **62/62 通过**（真机 Electron + 真实鼠标）。新增 4 项：
  「默认时间轴区高度按三条轨道预留」（240px）、「全屏分隔条压缩成一条线（命中区 ≤12px）」（8px）、
  「分隔条拖动可调整时间轴高度」（240 → 347px）、「Ctrl+滚轮可细粒度缩放时间轴」（片段宽 32 → 40px）、
  「吸附开启时拖入片段自动首尾相连（贴已有边缘）」（新片段左缘 805 = 已有片段右边缘）。
- `test/timeline-model.test.ts` **45 项通过**（新增落轨磁吸 4 项：任意位置吸到片段边缘、落在两段之间吸最近合法边缘、
  空轨保持落点、音频不磁吸）。
- `typecheck:web`、`eslint`、`electron-vite build`、`verify:agent-access` 通过。

## 5.15 2026-11-03 缺陷修复：合成成片整条静音（无声音）

用户真机反馈：「合成了一个视频之后没有声音」。

**排查与根因**（用用户工程 rnE1u2WwBL8C 的真实数据复现）：

- 4 段源视频都是 h264 + aac 2ch 48kHz，volumedetect 实测平均约 -16 dB，本身有声音；
  成片 PIpQUSbIob.mp4 也有 aac 音轨，但实测 mean/max 均 **-91 dB**（数字静音）。
- 用应用真实模块 `composeTimeline()` 复现：同样 -91 dB。逐阶段复跑后确认问题不在 ffmpeg 参数。
- 根因：`src/main/media/ffmpeg-runner.ts` 的 `runProcess()` 原设计只有显式 `captureStdout: true`
  才累积 stdout，而 `timeline-compose` 的 `probeHasAudio()` / `probeDurationMs()` 都没传这个开关。
  于是**「素材有没有音轨」永远探测成 false**：每段归一化时都走 `anullsrc` 补静音，独立音频轨
  （`resolved.hasAudio === false` 直接 `continue`）也被整条跳过，成片必然静音。
  该缺陷自时间线 M4（2026-11-02）引入；旧测试只断言「有 audio 流」（`hasAudio: true`），
  静音轨同样满足，所以一直没被拦住。

**修复**：

1. `probeHasAudio()` / `probeDurationMs()` 显式传 `{ captureStdout: true }`。
2. `runProcess()` 改为「未提供 `onStdout` 时默认累积 stdout」——探测类调用天然要返回值，
   进度流调用方仍显式不保留，从机制上避免同类漏传。
3. 回归门禁升级：`test/timeline-compose.test.ts` 用 `volumedetect` 断言成片平均电平 > -50 dB，
   并新增「视频片段自带的原音会进入成片」用例；`test-timeline-electron.cjs` 的成片断言从
   「有音轨」改为「有音轨且 meanDb > -50」。

**验证**：

- 修复后同一组用户素材重合成：mean **-16.3 dB**、max -0.4 dB（有声音）。
- `test/timeline-compose.test.ts` **6/6 通过**（含新增 2 条电平断言）。
- 真机 `test-timeline-electron.cjs` **62/62 通过**：成片 `meanDb` = -26.5 dB、1920×1080、时长一致。
- `typecheck:node`、`eslint`、`electron-vite build` 通过。
- 影响面：修复前已合成的旧成片仍是静音文件，需要用户对轨道线节点重新「运行/导出成片」一次；
  旧文件不会自动重写。

## 6. 未覆盖边界





- 卡片内**跨片段连续播放预览**未实现（本期只有播放头与单片段信息；成片预览在运行后由视频资产节点提供）。
- 时间轴缩放只提供档位按钮；`Ctrl+滚轮` 缩放需要给 `canvas-wheel-routing` 加白名单，未做。
- 磁性吸附、转场、变速、音量调节、多轨视频叠加渲染未实现。
- FFmpeg 仍由用户自备（`CANVAS_STUDIO_FFMPEG_PATH` 或 PATH）；缺失时是显式阻塞原因。
- 画布结构导出不含轨道线素材引用（见第 3 节）。
