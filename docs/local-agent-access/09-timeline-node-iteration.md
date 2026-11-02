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

## 6. 未覆盖边界



- 卡片内**跨片段连续播放预览**未实现（本期只有播放头与单片段信息；成片预览在运行后由视频资产节点提供）。
- 时间轴缩放只提供档位按钮；`Ctrl+滚轮` 缩放需要给 `canvas-wheel-routing` 加白名单，未做。
- 磁性吸附、转场、变速、音量调节、多轨视频叠加渲染未实现。
- FFmpeg 仍由用户自备（`CANVAS_STUDIO_FFMPEG_PATH` 或 PATH）；缺失时是显式阻塞原因。
- 画布结构导出不含轨道线素材引用（见第 3 节）。
