# canvas-studio 交接文档

> 无限画布创作平台 · 单用户本地 Windows 桌面应用
> UI/功能对标 [LibTV](https://liblib.tv)，目标是做一个更强大、完全本地的无限画布创作工具。
> 本文档面向接手开发的工程师，覆盖架构、关键决策、已知风险与后续计划。

---

## 1. 项目概览

| 项 | 值 |
|---|---|
| 定位 | 单用户、本地优先（无云端、无账号），Windows 优先 |
| 技术栈 | Electron 39 + electron-vite 5 + React 19 + TypeScript 5.9 + tldraw 4.5.12 + better-sqlite3 + zustand + pnpm |
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
│  ├─ index.ts                # 窗口创建、media:// 协议注册（stream: true）
│  ├─ ipc/project.ipc.ts      # 项目 CRUD/保存（含 beforeunload 用的同步保存）
│  ├─ ipc/media.ipc.ts        # 拖拽导入 + 系统对话框导入（async，逐文件错误透传）
│  └─ store/
│     ├─ db.ts                # SQLite 初始化 + 迁移 + settings 表
│     ├─ projects.repo.ts     # project.json 读写（原子写：tmp → rename，旧版留 .bak）
│     └─ media.repo.ts        # 异步复制进项目目录 + 索引；2GB 上限；文本内容内联(≤1MB)
├─ preload/index.ts           # contextBridge 暴露 window.api（类型即契约）
├─ shared/
│  ├─ contracts/index.ts      # IPC 通道名常量 + IpcEnvelope 信封类型
│  └─ types/index.ts          # 领域模型（CanvasNode/ProjectFile/MediaAsset/...）
└─ renderer/src/
   ├─ App.tsx                 # 启动恢复上次项目 + 路由（home/canvas）+ 全局 Toast
   ├─ pages/                  # ProjectListPage（主页）/ CanvasPage（画布页 + 顶栏重命名）
   ├─ canvas/
   │  ├─ CanvasEditor.tsx     # tldraw 宿主：建节点/拖放导入/自动保存/拖动式添加
   │  ├─ NodeCardShape.tsx    # node-card 形状定义 + TLGlobalShapePropsMap 声明合并
   │  ├─ NodeCardView.tsx     # 卡片视图（标题可编辑 + 状态灯 + 预览 portal 到 body）
   │  ├─ NodeCreateMenu.tsx   # 双击画布弹出的创建菜单
   │  └─ ProjectMenu.tsx      # 左上角 Logo 项目菜单（LibTV 1.4.1）
   ├─ nodes/
   │  ├─ registry.tsx         # ★ NodeType 注册表（新增节点类型 = 写 Spec 注册，核心零改动）
   │  └─ specs/               # 五类节点：bodies.tsx（内容组件）+ index.tsx（注册）
   ├─ components/Toast.tsx    # 全局 toast（挂 App 根）
   ├─ stores/                 # zustand：app（视图状态）/ toast
   └─ dev/browserMock.ts      # 浏览器直连时的 window.api 模拟（DEV only）
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

## 5. 关键技术决策（务必理解再改）

1. **tldraw 自定义形状的类型接入**：`NodeCardShape.tsx` 通过 `declare module '@tldraw/tlschema'` 合并 `TLGlobalShapePropsMap`，把 `node-card` 注入 `TLShape` 联合类型。`@tldraw/tlschema` 是 devDependency，**版本必须与 tldraw 完全一致**（当前都锁 4.5.12），升级 tldraw 时同步升级它。

2. **tldraw 交互铁律**：自定义形状内部，只有"真正可交互元素"（输入框、按钮、可编辑标题）才允许 `stopEventPropagation`；卡片根元素必须放行 pointer 事件给 tldraw，否则选中和拖拽全部失效（曾因此全量节点拖不动）。点击类交互（如图片预览）需用位移阈值（>4px 视为拖拽）区分点击与拖动。

3. **快照与图数据双轨**：当前画布状态以 tldraw store snapshot 直接存进 `project.json`（简单可靠）；`nodes/edges/groups` 字段 M2 起预留，M3 连线系统开始填充。**恢复失败保护**：`loadStoreSnapshot` 抛错时置 `restoreFailedRef`，跳过一切自动保存（含 beforeunload），避免空画布覆盖旧数据。

4. **保存策略**：监听 store `document` scope → 800ms 防抖异步保存；关窗走 `sendSync` 同步保存。每次保存全量重写 JSON + graphVersion+1（M5+ 节点量大时再做增量）。

5. **媒体管线**：文件复制进项目目录（不引用原路径）→ `media:///<relPath>` 协议加载（`stream: true` 供 video）→ `getMediaAbsPath` 做前缀穿越校验。txt/md/json（≤1MB）导入时内联 `textContent`，直接生成可编辑文本节点。

6. **CSP**：`connect-src` 已放开 https/http/ws（为 M4 模型网关预留），媒体只允许 `self blob: media:`。若 M4 前 want 更严可先收紧。

7. **样式约定**：全部在 `app.css`，CSS 变量（--bg/--card/--line/--brand…）定义配色；LibTV 式深色。浮层必须 portal 到 `document.body`（画布容器带 transform，fixed 会错位）。

## 6. 已完成里程碑

- **M0** 骨架：Electron + tldraw 集成、启动恢复上次项目。
- **M1** 项目管理：列表/新建/重命名/删除（软删）/打开；自动保存（防抖 + 关窗同步落盘）；原子写 + .bak 回退。
- **M2** 节点系统：NodeType 注册表（扩展点）；五类节点（文本/图片/视频/音频/对话）；双击画布建节点；左侧栏「＋」按住拖到画布释放（拖动式添加）；拖文件/对话框导入媒体；媒体预览（portal）；LibTV 风格 UI（Logo 项目菜单、五键左侧栏、顶栏双击重命名、小地图为 tldraw 默认）。
- **审查修复轮（P0/P1）**：预览浮层 portal 修复错位；快照恢复失败禁写保护；媒体导入异步化 + 2GB 上限；导入失败 toast 透传；文本文件内容内联；节点拖不动根因修复（pointerdown 拦截）；media 路径穿越校验补分隔符。

## 7. 已知问题 / 待办（按优先级）

**P1（待实测/待修）**
- [ ] `media://` 未处理 HTTP Range 请求，`<video>` 拖进度条可能失效 —— 实测，失效则在协议 handler 解析 Range 头
- [ ] 卡片内可滚动区域（长文本）滚轮是否会缩放画布 —— tldraw 常见坑，需在 wheel 事件上判定
- [ ] tldraw 字体/图标走 `cdn.tldraw.com`，**离线时缺失**（单机应用硬伤）→ 用 tldraw `assetUrls` 本地化打包

**P2（已记录，排期处理）**
- [ ] 项目软删后 project.json + 媒体文件残留磁盘（M7 回收站规划内）
- [ ] 保存全量重写（节点多后写放大），M5+ 做增量
- [ ] `window.confirm` 与深色 UI 不符，换自绘确认弹窗
- [ ] `detectKind` 认 `.avi` 但导入过滤器不含（不一致）；db 未显式 close；`exec` 状态字段当前恒为 idle（M4 执行引擎才用）
- [ ] git 换行符警告（LF→CRLF），可加 `.gitattributes` 统一

**M3 开发内容（下一步）**
脚本节点（script）、节点端口/连线系统（CanvasEdge 已有类型）、节点编排与依赖执行。参考《技术框架与规范》§5/§6 与 libtv_guide.md 对应章节。

## 8. 工作流约定

- 提交前必过：`pnpm typecheck && pnpm lint`
- 修改 `shared/` 或 `preload/` 后必须**重启 dev**（主进程不热更，渲染端 HMR 会造成两端契约不一致）
- 新增节点类型：在 `nodes/specs/bodies.tsx` 写内容组件 + `index.tsx` 注册，不改核心
- UI 改动对照 LibTV 指南（libtv_guide.md §1.4 画布四大模块）
- 本地无测试框架；浏览器 mock + `http://localhost:5173/` 做交互冒烟
