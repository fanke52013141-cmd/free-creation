# canvas-studio 交接文档

> 无限画布创作平台 · 单用户本地 Windows 桌面应用
> UI/功能对标 [LibTV](https://liblib.tv)，目标是做一个更强大、完全本地的无限画布创作工具。
> 本文档面向接手开发的工程师，覆盖架构、关键决策、已知风险与后续计划。

---

## 1. 项目概览

| 项 | 值 |
|---|---|
| 定位 | 单用户、本地优先（无云端、无账号），Windows 优先 |
| 技术栈 | Electron 39 + electron-vite 5 + React 19 + TypeScript 5.9 + tldraw 4.5.12 + better-sqlite3 + zustand + AI SDK 7（ai + @ai-sdk/openai-compatible）+ pnpm |
| 画布引擎 | tldraw v4（自定义形状承载节点卡片） |
| 数据 | SQLite（索引/设置）+ 每项目一个 `project.json`（图数据 + tldraw 快照）+ 媒体文件目录 |
| 参考竞品 | LibTV（功能/交互参照），参考文档：`libtv_guide.md`（工作区根目录） |
| 总体规划 | 《无限画布创作平台-技术框架与规范.md》（桌面 `无限画布` 文件夹） |

## 2. 快速上手

```bash
pnpm install          # postinstall 自动重建 better-sqlite3
pnpm dev              # 启动 Electron 开发实例（HMR）
pnpm typecheck        # node + web 两套 tsconfig 全量检查
pnpm lint             # eslint（含 prettier 规则）
pnpm build:win        # 打 Windows 安装包
```

浏览器验证 UI（不需要 Electron）：`pnpm dev` 后直接开 `http://localhost:5173/`，
`dev/browserMock.ts` 会模拟 `window.api`（仅 DEV 生效，Electron 内自动跳过）。媒体导入等主进程功能在浏览器 mock 下为空实现。

## 3. 架构与目录

```
src/
├─ main/                      # Electron 主进程
│  ├─ index.ts                # 窗口创建、media:// 协议注册（stream: true）、启动时 resumePendingVideoTasks
│  ├─ ipc/project.ipc.ts      # 项目 CRUD/保存（含 beforeunload 用的同步保存）
│  ├─ ipc/media.ipc.ts        # 拖拽导入 + 系统对话框导入（async，逐文件错误透传）
│  ├─ ipc/gateway.ipc.ts      # 模型网关：供应商 CRUD/连通测试/chat 流式/生图/视频任务
│  ├─ gateway/                # ★ 模型网关（M4）
│  │  ├─ factory.ts           # 驱动映射：openai-compatible（AI SDK）vs video（自研适配器）
│  │  ├─ providers.repo.ts    # providers 表 CRUD（含连通测试拉取模型列表）
│  │  ├─ chat.ts              # 流式对话：streamText + 事件转发（chunk/done/error）
│  │  ├─ image.ts             # 生图：generateImage → 落地项目 media → 返回 asset
│  │  └─ video.ts             # 视频任务式适配器（MiniMax H3 + Seedance）：提交/轮询/下载/断点恢复
│  └─ store/
│     ├─ db.ts                # SQLite 初始化 + 迁移 + settings/providers/tasks 等表
│     ├─ projects.repo.ts     # project.json 读写（原子写：tmp → rename，旧版留 .bak）
│     └─ media.repo.ts        # 异步复制进项目目录 + 索引；2GB 上限；文本内容内联(≤1MB)
├─ preload/index.ts           # contextBridge 暴露 window.api（类型即契约）
├─ shared/
│  ├─ contracts/index.ts      # IPC 通道名常量 + IpcEnvelope 信封类型 + SaveProviderInput
│  └─ types/index.ts          # 领域模型（CanvasNode/ProviderConfig/VideoTaskInfo/PROVIDER_SPECS/...）
└─ renderer/src/
   ├─ App.tsx                 # 启动恢复上次项目 + 路由（home/canvas）+ 全局 Toast + 挂载 ProviderSettingsPanel
   ├─ pages/                  # ProjectListPage（主页）/ CanvasPage（画布页 + 顶栏重命名）
   ├─ gateway/
   │  └─ ProviderSettingsPanel.tsx  # 供应商管理面板（模板选择/BaseURL+Key/模型增删/连通测试）
   ├─ canvas/
   │  ├─ CanvasEditor.tsx     # tldraw 宿主：建节点/拖放导入/自动保存/连线收尾/连线显隐
   │  ├─ NodeCardShape.tsx    # node-card 形状定义 + TLGlobalShapePropsMap 声明合并
   │  ├─ NodeCardView.tsx     # 卡片视图（标题可编辑 + 状态灯 + 端口圆点 + 预览 portal 到 body）
   │  ├─ graph.ts             # ★ 连线核心：tryConnect 校验建边 / createEdge 建 arrow+binding / deriveGraph 派生图数据
   │  ├─ connection-drag.ts   # 连线拖拽控制（非组件模块，Fast Refresh 友好）：window 监听同步挂载
   │  ├─ ConnectionLayer.tsx  # 拖线虚线引线浮层（portal 到 body）
   │  ├─ NodeCreateMenu.tsx   # 双击画布/拉线到空白弹出的创建菜单
   │  └─ ProjectMenu.tsx      # 左上角 Logo 项目菜单（LibTV 1.4.1）
   ├─ nodes/
   │  ├─ registry.tsx         # ★ NodeType 注册表 + 端口声明/兼容校验/端口纵坐标布局
   │  └─ specs/               # 六类节点：bodies.tsx（内容组件）+ index.tsx（注册，含端口声明）
   ├─ components/Toast.tsx    # 全局 toast（挂 App 根）
   ├─ stores/                 # zustand：app / toast / connection（连线拖拽草稿）/ gateway（供应商+任务状态）
   └─ dev/browserMock.ts      # 浏览器直连时的 window.api 模拟（DEV only，gateway 走 MOCK 拒绝）
```

数据落盘位置：`%APPDATA%/canvas-studio/data/`（app.db + `projects/<id>/project.json` + `projects/<id>/media/`）。

## 4. IPC 契约速查

统一信封：`{ ok: true, data } | { ok: false, error: { code, message } }`

| window.api | 说明 |
|---|---|
| `bootstrap()` | 启动恢复：返回 lastProjectId |
| `listProjects / createProject / renameProject / deleteProject` | 项目 CRUD（删除=软删） |
| `openProject(id)` | 返回 ProjectFile（含 tldrawSnapshot），并记录 lastProjectId |
| `saveProject(input)` | 异步保存快照/图数据 |
| `saveProjectSync(input)` | beforeunload 用 sendSync 保证落盘 |
| `importMedia({ projectId, paths })` | 拖拽导入 → `{ assets, errors }` 逐文件结果 |
| `pickMedia(projectId)` | 系统对话框多选导入 |
| `getDroppedFilePath(file)` | Electron 32+ 拿拖拽文件真实路径（webUtils） |
| `gateway.providers()` | 列出已配置供应商（含模型清单） |
| `gateway.saveProvider(input)` | 新增/更新供应商（upsert，API Key 明文存 providers 表） |
| `gateway.deleteProvider(id)` | 删除供应商 |
| `gateway.testProvider(input)` | 连通测试：OpenAI 兼容驱动拉 GET /models 并返回模型列表；视频驱动仅校验必填 |
| `gateway.chatStart({ providerId, modelId, system, messages })` | 发起流式对话 → `{ taskId }`，后续走事件推送 |
| `gateway.chatCancel({ taskId })` | 中止对话（AbortController） |
| `gateway.imageGenerate({ projectId, providerId, modelId, prompt, size })` | 生图 → 落地项目 media → `{ asset }`（暂无参考图入参） |
| `gateway.videoSubmit({ projectId, nodeId, providerId, modelId, prompt, params, firstFrameMediaId? })` | 提交视频任务 → `{ taskId }`，轮询走事件推送（契约支持首帧 mediaId，主进程已实现转 data URL；**渲染端 UI 尚未接线**） |
| `gateway.videoCancel({ taskId })` | 取消视频任务 |
| `gateway.videoTask({ taskId })` | 查询单个任务状态（兜底，正常以事件为准） |

**网关事件**：单一通道 `gateway:event`（`window.api.gateway.onEvent(listener)`），载荷为判别联合 `GatewayEvent`（`shared/contracts`）：
`chat-delta`（流式分片 text）/ `chat-done` / `chat-error`；
`video-status`（含进度 message）/ `video-done`（返回 mediaId+mediaPath+name+mime，视频落地项目 media 目录）/ `video-error`。
渲染端 `stores/gateway.ts` 持 taskId → 节点映射，节点 body 按事件刷新。

## 5. 关键技术决策（务必理解再改）

1. **tldraw 自定义形状的类型接入**：`NodeCardShape.tsx` 通过 `declare module '@tldraw/tlschema'` 合并 `TLGlobalShapePropsMap`，把 `node-card` 注入 `TLShape` 联合类型。`@tldraw/tlschema` 是 devDependency，**版本必须与 tldraw 完全一致**（当前都锁 4.5.12），升级 tldraw 时同步升级它。

2. **tldraw 交互铁律**：自定义形状内部，只有"真正可交互元素"（输入框、按钮、可编辑标题、端口圆点）才允许 `stopEventPropagation`；卡片根元素必须放行 pointer 事件给 tldraw，否则选中和拖拽全部失效（曾因此全量节点拖不动）。点击类交互（如图片预览）需用位移阈值（>4px 视为拖拽）区分点击与拖动。

3. **连线系统架构**（M3）：
   - 端口拖拽是"两段式"：端口 `onPointerDown`（React 合成事件）→ `beginConnectionDrag` **同步**挂载 window 原生 `pointermove/pointerup` 监听（监听必须在后续 pointer 事件前就绪）→ 松手回调由 `CanvasEditor` 注册的 `setConnectionFinishHandler` 处理命中检测。拖拽逻辑放在**非组件模块** `connection-drag.ts`（组件内定义 window 监听会触发 React Fast Refresh 报错）。
   - 连线本体 = tldraw `arrow` 形状 + 两条 `arrow` binding（start/end 锚定两节点），随节点移动自动跟随、可选中删除、支持撤销；端口信息存 `arrow.meta.fromPort/toPort`。绑定锚点 `normalizedAnchor.y` 按端口纵坐标算，`isPrecise: true`。
   - 校验规则在 `graph.ts#tryConnect`：类型兼容（`portCompatible`，`any` 万能口）、禁自环、禁重复边、禁环（DFS）。多输入口时按落点距离选最近兼容口。
   - 连线显隐是**纯 CSS**（`.canvas-host.edges-hidden [data-shape-type='arrow']{visibility:hidden}`），不写 store、不污染撤销历史。
   - 脚本节点分镜数据存 `shape.props.text`（JSON 字符串），不改形状 schema、旧快照零迁移；解析失败时原文当剧本文本（兼容粘贴场景）。

4. **快照与图数据双轨**：当前画布状态以 tldraw store snapshot 直接存进 `project.json`（简单可靠）；`nodes/edges/groups` 由 `deriveGraph` 从 shapes 派生（node-card→CanvasNode，arrow+binding→CanvasEdge），保存时随快照一并写入，是 M4 执行引擎的消费源。**恢复失败保护**：`loadStoreSnapshot` 抛错时置 `restoreFailedRef`，跳过一切自动保存（含 beforeunload），避免空画布覆盖旧数据。

5. **保存策略**：监听 store `document` scope → 800ms 防抖异步保存；关窗走 `sendSync` 同步保存。每次保存全量重写 JSON + graphVersion+1（M5+ 节点量大时再做增量）。

6. **媒体管线**：文件复制进项目目录（不引用原路径）→ `media:///<relPath>` 协议加载（`stream: true` 供 video）→ `getMediaAbsPath` 做前缀穿越校验。txt/md/json（≤1MB）导入时内联 `textContent`，直接生成可编辑文本节点。

7. **CSP**：`connect-src` 已放开 https/http/ws（为 M4 模型网关预留），媒体只允许 `self blob: media:`。若 M4 前 want 更严可先收紧。

8. **样式约定**：全部在 `app.css`，CSS 变量（--bg/--card/--line/--brand…）定义配色；LibTV 式深色。浮层必须 portal 到 `document.body`（画布容器带 transform，fixed 会错位）。

9. **模型网关双层驱动**（M4，务必理解再扩）：
   - **选型结论**：文本/图片统一走 Vercel AI SDK 的 `@ai-sdk/openai-compatible`——调研确认国内主流厂商（DeepSeek/通义/Kimi/GLM/豆包）官方端点全部 OpenAI 兼容，中转站天然对口，OpenAI 官方也直接可用，故**不需要** per-vendor 官方包。视频（MiniMax H3 / Seedance）是任务式异步 API（提交→轮询→下载），AI SDK 无对应抽象，自研轻量适配器（`video.ts`，每家约 100 行）。
   - **驱动路由**：`factory.ts#driverForSpec` 按 `specId` 分流——`minimax`/`seedance` → video 适配器，其余 → openai-compatible。**新增文本/图片供应商零代码**：只需在 `shared/types` 的 `PROVIDER_SPECS` 加模板（预填 baseURL/建议模型）；新增视频供应商才要写适配器。
   - **供应商持久化**：`providers` 表（SQLite），**API Key 明文存储**（单用户本地应用，无多租户风险，已知取舍）；模型清单 JSON 存 `models` 列，手动增删 + 连通测试时从 `GET /models` 一键拉取。**实测坑**（微信 chatapi 端点）：部分中转站不实现 `/models`（返回 400）、且**仅支持流式**（非流式请求挂起到超时）——`testProvider` 已做回退：`/models` 失败时用已配置的首个模型发最小 `stream:true` 对话探测；对话链路本身用 `streamText` 恒为流式，不受影响。
   - **视频任务持久化**：复用 `tasks` 表（`kind='video'`），upstreamTaskId 存 input 列 JSON；**重启恢复**：主进程启动时 `resumePendingVideoTasks` 扫描 submitted/running 任务继续轮询，产物落地项目 media 目录（复用媒体管线，`media://` 协议直接可播）。
   - **流式事件推送**：主进程只经单一 `gateway:event` 通道推判别联合 `GatewayEvent`；渲染端 `stores/gateway.ts` 以 taskId 为键分发。**不要**为每类事件开新通道（信封规范 §10）。
   - **图片生成产物**：`image.ts` 生成后直接写入项目 media 目录并登记 asset，节点拿到即插即用，不经用户手动导入。

## 6. 已完成里程碑

- **M0** 骨架：Electron + tldraw 集成、启动恢复上次项目。
- **M1** 项目管理：列表/新建/重命名/删除（软删）/打开；自动保存（防抖 + 关窗同步落盘）；原子写 + .bak 回退。
- **M2** 节点系统：NodeType 注册表（扩展点）；五类节点（文本/图片/视频/音频/对话）；双击画布建节点；左侧栏「＋」按住拖到画布释放（拖动式添加）；拖文件/对话框导入媒体；媒体预览（portal）；LibTV 风格 UI（Logo 项目菜单、五键左侧栏、顶栏双击重命名、小地图为 tldraw 默认）。
- **审查修复轮（P0/P1）**：预览浮层 portal 修复错位；快照恢复失败禁写保护；媒体导入异步化 + 2GB 上限；导入失败 toast 透传；文本文件内容内联；节点拖不动根因修复（pointerdown 拦截）；media 路径穿越校验补分隔符。
- **M3 连线系统与脚本节点**：
  - 六类节点端口声明（in/out，类型 text/image/video/audio/json/any），卡片左右渲染端口圆点（输入空心/输出实心），拖线时按类型兼容高亮（绿=可接，暗=不可）。
  - 从输出端口拖出连线：虚线引线跟手（portal 浮层）→ 松手命中检测 → 校验（类型兼容/自环/重复/环）→ 创建 arrow + 双 binding（连线随节点移动、可删可撤销）。
  - 拉线到空白处弹创建菜单，新节点建好后自动连回拖线来源（LibTV 交互）。
  - 连线显隐开关（左下角按钮，纯 CSS 切换不污染撤销历史）。
  - 脚本节点（LibTV 1.2.6 基础版）：剧本文本输入 + 分镜表格（增删/上下移/画面描述/台词/时长），内容撑高卡片（上限 640 后内滚），数据存 text prop（JSON）。
  - 保存时 `deriveGraph` 从 shapes 派生 nodes/edges 写入 project.json graph 字段（M4 执行引擎数据源）。
  - 深色画布（tldraw `colorScheme: 'dark'` 对齐整体 UI）。
- **M3 交互审查修复轮（浏览器全量回归通过）**：
  - **撤销粒度**：tldraw 变更默认累积进 `pendingDiff`，无分段点时一次 Ctrl+Z 回退多步。修复：每个逻辑操作结束同步调 `markHistoryStoppingPoint`（封装在 `canvas/history.ts#markUndoPoint`；**必须同步调用**，rAF 在页面不可见时不触发会丢分段点）。已覆盖：建节点、建连线、媒体导入、文本提交、标题编辑、脚本字段（blur 打点，连续敲键自然合并为一步）、镜头增删/移动。「拉线到空白建节点」流程不打节点单独点，节点+连线合并为一步（createEdge 统一收尾打点）。脚本节点自动撑高的 h 变更用 `pendingMarkRef` 延迟到布局副作用之后打点，与内容变更并入同一撤销步。
  - **删节点级联清线**：tldraw 删 shape 只级联删 binding 不删 arrow，会留悬空线。修复：`CanvasEditor.handleMount` 里 `sideEffects.registerAfterDeleteHandler('shape')` 同步处理——binding 已在删 shape 时移除，此刻遍历 arrow 找绑定数 <2 的悬空线随同一次事务 `deleteShapes`（一次 Ctrl+Z 整体还原）。异步方案（rAF/microtask + store listener）在后台标签页会丢清理时机，已弃用。
  - **双击边界**：双击弹菜单的监听限定 `target.closest('.tl-canvas')` 内且不在 shape/overlays/UI 上——双击侧栏按钮、连线开关不再误弹节点菜单。
  - **待连线残留**：拉线到空白后取消上传（对话框取消/失败/空 assets）会清 `pendingConnectRef`，避免残留到下一次建节点时误连。
  - 环检测/重复连线拦截/类型兼容经复测**本来就正常**（此前会话报失败是测试脚本时序问题）；拖拽中途引线浮层 + 端口高亮 + Esc 取消正常（此前误报是 React 渲染与同帧查询的时序假阴性，需分步 evaluate 验证）。
- **M4 模型网关**（对话/图片/视频三类节点已全部实装）：
  - **依赖**：Vercel AI SDK 7（`ai` + `@ai-sdk/openai-compatible`），文本/图片全走 OpenAI 兼容协议；视频自研任务式适配器（MiniMax H3 `POST /v2/video_generation` + 轮询 `/v2/query/video_generation`；Seedance 即梦开放平台提交 + 轮询），架构详见 §5.9。
  - **供应商体系**：`PROVIDER_SPECS` 九个模板（openai/deepseek/qwen/kimi/glm/doubao/relay/minimax/seedance，预填官方 baseURL 与建议模型）；`ProviderSettingsPanel`（左上角项目菜单「模型供应商设置」入口，portal 挂 App 根）做模板选择 → BaseURL/APIKey → 模型清单（手动增删 + 连通测试一键拉取 `GET /models`）；providers 表 upsert。
  - **对话节点**：模型下拉（按已配置供应商聚合）+ system 输入 + 多轮消息；`chatStart` 返回 taskId，`chat-delta/done/error` 事件流式渲染（markdown 纯文本呈现，气泡式布局），中止按钮走 `chatCancel`。props.text 存 `{system, modelKey, messages}` JSON（旧纯文本视为 system，零迁移）。
  - **图片节点**：提示词 + 模型 + 尺寸（auto/1024x1024/1536x1024/1024x1536）；`imageGenerate` 生成后落地项目 media 并直接绑定节点 asset（media:// 协议渲染，无需手动导入）。props.text 存 `{prompt, modelKey, size}`（旧纯文本视为提示词）。
  - **视频节点**：提示词 + 模型 + 参数（时长/分辨率按 spec 支持度）；`videoSubmit` 任务式提交，`video-status/done/error` 事件驱动进度与产物绑定；**任务持久化 + 重启恢复**（tasks 表 kind='video' + `resumePendingVideoTasks`，节点挂载时按 taskId 查询补媒体/清理终态）。props.text 存 `{prompt, modelKey, params, taskId}`。首帧图链路：契约与主进程已实现（`firstFrameMediaId` → 读本地文件转 base64 data URL 上传，MiniMax/Seedance 适配器均消费），**渲染端尚未接线**。
  - **校验**：typecheck / lint（0 error，余为 CRLF 警告）/ `build:win` 全部通过。

## 7. 已知问题 / 待办（按优先级）

**P1（待实测/待修）**
- [ ] `media://` 未处理 HTTP Range 请求，`<video>` 拖进度条可能失效 —— 实测，失效则在协议 handler 解析 Range 头
- [x] 卡片内可滚动区域（长文本）滚轮是否会缩放画布 —— 已修复并验证：`useWheelScroll`（bodies.tsx）在内容可滚时原生截断 wheel 冒泡（React 合成事件到不了 tldraw 的容器监听），顶部/底部放行给画布
- [ ] tldraw 字体/图标走 `cdn.tldraw.com`，**离线时缺失**（单机应用硬伤）→ 用 tldraw `assetUrls` 本地化打包
- [x] 网关真实 API 冒烟（2026-08-22，文本链路）——微信 chatapi（chatapi.weixin.qq.com/openai/v1）+ GLM-5.2 全链路通过：`createOpenAICompatible` + `streamText` 流式输出正常，供应商「微信 AI（GLM-5.2）」已写入 providers 表（id: wechat-glm），应用内对话节点开箱可用
- [x] 网关真实 API 冒烟（2026-08-22，图片链路）——codex2api（www.codex2api.com/v1）+ gpt-image-2 全链路通过：`/models` 正常返回（该中转仅此一个模型），`generateImage` 66~81s 出图，b64_json 解码为有效 PNG，`image.ts` 消费的 `uint8Array`/`mediaType` 字段均正常；供应商「Codex2API（生图）」已写入 providers 表（id: codex2api-image）。**注意**：gpt-image-2 不严格遵循 size 参数（请求 1024x1024 实际返回 1254x1254），属上游特性，应用内尺寸选项仅作建议值
- [ ] 视频链路仍未接真实 API——MiniMax/Seedance 待各自密钥实测（含重启恢复）

**P2（已记录，排期处理）**
- [ ] API Key 明文存 SQLite（单用户本地应用，暂可接受；后续可接 Windows 凭据管理器 DPAPI）
- [ ] 对话上下文仅手动输入，**连线输入尚未自动注入**（上游文本/图片节点的产物拼进 messages）——M5 连线编排的核心
- [ ] 项目软删后 project.json + 媒体文件残留磁盘（M7 回收站规划内）
- [ ] 保存全量重写（节点多后写放大），M5+ 做增量
- [ ] `window.confirm` 与深色 UI 不符，换自绘确认弹窗
- [ ] `detectKind` 认 `.avi` 但导入过滤器不含（不一致）；db 未显式 close；`exec` 状态字段当前恒为 idle（M4 执行引擎才用）
- [ ] git 换行符警告（LF→CRLF），可加 `.gitattributes` 统一

**M4 剩余 / 下一步**
- 连线上下文注入（核心缺口）：三类生成节点的连线输入自动拼装进生成请求——上游文本节点内容进对话 messages；上游图片节点作图片参考（`ImageGenerateInput` 需加参考图字段）/ 视频首帧（契约与主进程已就绪，渲染端 UI 未接线，见 §6 M4 条目）。
- 脚本节点 AI 拆解分镜（剧本 → 分镜表格一键生成，走网关 chat）。
- 执行引擎：拓扑排序 + 节点 exec 状态流转（连线编排一键串行执行，`exec` 字段启用）。
- 参考规划：《技术框架与规范》§6/§7 与 libtv_guide.md 对应章节。

## 8. 浏览器冒烟测试说明（M3 验证结论）

- 连线创建、空白拉线弹菜单、新节点自动连线、连线显隐、脚本节点增删改均已通过浏览器验证（`http://localhost:5173/` + browserMock）。
- **重要**：自动化测试工具的 mouse 操作不产生 pointer 事件（应用监听 pointerdown/move/up），拖线类交互必须用 JS 合成 `PointerEvent` dispatchEvent 验证；真实用户操作不受影响。
- 浏览器验证遇到 `Failed to reload ... does not provide an export named` 类 Vite HMR 错误时，删除 `node_modules/.vite` 并重启 dev server（HMR 模块图缓存损坏，源码本身无误）。
- **缓存损坏的另一种表现**（审查轮实测）：HMR 无报错但浏览器拿到旧模块（改了代码行为不变）。验证模块新鲜度要 `fetch('/src/xxx.tsx')` 检查**标识符**（如函数名）——不能检查带引号的字符串字面量（Vite 转译会单引号变双引号，必然误报）。发现仍旧时同样删 `node_modules/.vite` 重启。
- 拖拽中途状态（引线浮层/端口高亮）检查必须**分步 evaluate**：dispatch 事件与查询 DOM 不能在同一个脚本里（React 渲染是异步的，同帧查询必为 false，属测试假阴性）。
- 撤销相关断言：undo 后若脚本要继续后续步骤，必须先 redo 恢复现场，否则端口元素已随节点消失导致后续拖拽脚本静默失败。

## 9. 工作流约定

- 提交前必过：`pnpm typecheck && pnpm lint`
- 修改 `shared/` 或 `preload/` 后必须**重启 dev**（主进程不热更，渲染端 HMR 会造成两端契约不一致）
- 新增节点类型：在 `nodes/specs/bodies.tsx` 写内容组件 + `index.tsx` 注册，不改核心
- UI 改动对照 LibTV 指南（libtv_guide.md §1.4 画布四大模块）
- 本地无测试框架；浏览器 mock + `http://localhost:5173/` 做交互冒烟
