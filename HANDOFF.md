# Canvas Studio 开发交接文档

> 最后更新：2026-08-24
>
> 当前主分支：`main`
>
> 远程仓库：`https://github.com/fanke52013141-cmd/free-creation`
>
> 产品形态：单用户、本地优先的 Windows Electron 无限画布创作工具。

## 1. 接手者先读

开始修改前，按顺序阅读：

1. [README.md](./README.md)：项目入口和常用命令。
2. [NODE_CONTRACT_SPEC.md](./NODE_CONTRACT_SPEC.md)：节点、端口、连线、Schema 和执行协议的强制规范。
3. [ROADMAP.md](./ROADMAP.md)：推荐的后续开发顺序和验收标准。
4. 本文档：当前架构、关键决策、遗留风险和发布步骤。

产品边界已经确定：

- 只有一个本地用户，不做多租户和权限系统。
- 不做强制教程。
- 保持当前整体 UI 格局，不重新设计导航结构。
- 分组是画布状态，不是业务节点。
- 图片资产和图片生成是两种不同节点。
- 视频合成交给剪映等工具，不在画布内实现时间线和成片合成。
- 连线必须表示真实的输入输出依赖。

## 2. 快速启动

要求：Node.js 20+、pnpm 10、Windows 开发环境。

```bash
pnpm install
pnpm dev
```

发布前检查：

```bash
pnpm typecheck
pnpm lint
pnpm build
```

Windows 打包：

```bash
pnpm build:win
```

`better-sqlite3`、Electron 和 esbuild 等原生构建许可定义在根目录 `pnpm-workspace.yaml`。不要重新把已失效的 `pnpm.onlyBuiltDependencies` 放回 `package.json`。

## 3. 技术栈

| 层       | 技术                                                   |
| -------- | ------------------------------------------------------ |
| 桌面外壳 | Electron 39、electron-vite 5                           |
| UI       | React 19、TypeScript 5.9                               |
| 画布     | tldraw 4.5.12                                          |
| 状态     | Zustand                                                |
| 本地数据 | better-sqlite3 + 项目 JSON + 媒体目录                  |
| 模型调用 | Vercel AI SDK、OpenAI-compatible、自定义异步视频适配器 |
| Markdown | react-markdown + remark-gfm                            |
| 包管理   | pnpm 10                                                |

注意：`tldraw` 与 `@tldraw/tlschema` 必须保持完全相同的版本。

## 4. 目录和职责

```text
src/
├─ main/
│  ├─ gateway/              模型供应商、对话、生图、视频任务
│  ├─ ipc/                  Electron IPC 处理
│  └─ store/                SQLite、项目和媒体仓库
├─ preload/index.ts         安全暴露 window.api
├─ shared/
│  ├─ contracts/            IPC 通道与信封
│  ├─ types/                跨进程领域类型
│  └─ node-schemas.ts       JSON Schema 版本化验证仓库
└─ renderer/src/
   ├─ canvas/               tldraw 宿主、连线、分组、菜单和侧栏
   ├─ engine/               工作流编排、契约收集、代码运行
   ├─ nodes/                节点注册、输出投影和节点 UI
   ├─ gateway/              模型供应商设置 UI
   ├─ pages/                项目列表和画布页面
   └─ stores/               Zustand 状态
```

关键文件：

- `src/renderer/src/nodes/specs/index.tsx`：全部节点 Spec 和端口契约。
- `src/renderer/src/nodes/registry.tsx`：节点注册和注册时硬校验。
- `src/renderer/src/nodes/nodeValues.ts`：节点持久化状态到端口输出的唯一投影。
- `src/renderer/src/engine/contracts.ts`：输入收集、数据包和运行前后契约校验。
- `src/renderer/src/engine/executor.ts`：当前全局工作流执行编排。
- `src/renderer/src/canvas/graph.ts`：创建连线、类型/Schema/数量/环校验和图数据派生。
- `src/renderer/src/canvas/NodeCardView.tsx`：统一节点壳、标题、端口和交互。
- `src/renderer/src/canvas/NodeContractPanel.tsx`：I/O 契约、连接来源/去向和值预览。
- `src/renderer/src/canvas/ChatSidePanel.tsx`：对话节点完整侧栏、Markdown 和参数设置。

## 5. 当前节点状态

| 节点   | 职责                     | 输入                  | 输出                | 状态             |
| ------ | ------------------------ | --------------------- | ------------------- | ---------------- |
| 文本   | 编辑原始文本             | 可选多文本            | `out-text`          | 可用             |
| 图片   | 保存导入/粘贴的图片资产  | 无                    | `out-image`         | 可用             |
| 生图   | 文本或参考图生成图片     | `in-text`、`in-image` | `out-image`         | 可用             |
| 视频   | 文本和可选首帧生成视频   | `in-text`、`in-image` | `out-video`         | 可用，依赖供应商 |
| 音频   | 导入音频或文本转语音     | `in-audio`、`in-text` | `out-audio`         | 可用，依赖供应商 |
| 对话   | 多轮交互对话             | `in-text`             | `out-markdown`      | 可用             |
| 处理   | 单个动态值原样传递/兜底  | `in-value`            | `out-value`         | 可用，能力较基础 |
| JSON   | 解析、展示和输出结构化值 | `in-json`、`in-text`  | `out-json`          | 可用             |
| 代码   | 本地受限转换             | `in-text`、`in-json`  | 文本或 JSON         | 可用             |
| 分镜板 | 展示和编辑分镜列表       | 分镜 JSON 或兼容文本  | 分镜 JSON、摘要文本 | 可用             |
| 脚本   | 旧版复合拆解节点         | 文本                  | 分镜 JSON/文本      | 仅兼容，不可新建 |

已经退役：

- `group` 节点：改用 tldraw 原生分组状态。
- `compose` 节点和主进程视频合成：已删除。
- 右侧悬浮删除/复制/置顶/置底工具条：改为右键菜单。

## 6. 节点契约运行方式

连线含义固定为：

```text
source.outputs[sourcePortId] -> target.inputs[targetPortId]
```

全局运行流程：

```text
拓扑排序
→ 按 target portId 收集 NodeValuePacket
→ 校验端口、类型、必填、数量和 Schema
→ 执行节点
→ 投影实际输出
→ 校验必需输出和 Schema
→ 登记为下游可读取的数据包
```

重要规则：

1. 端口 ID 发布后不能随意改名。
2. 破坏性端口变化必须提升 `contractVersion` 并提供迁移。
3. JSON 端口必须声明 Schema；通用 JSON 使用 `json.any@1`。
4. `any` 只允许通用处理/代码类节点使用，运行时仍会恢复实际类型。
5. 单值输入只能连接一个上游，多值文本按稳定连线顺序合并。
6. 已连接但上游没有产生对应输出时，目标节点失败，不能静默使用旧值。
7. 节点卡片内手动生成与全局运行必须使用相同的输出投影。

当前 Schema：

- `json.any@1`
- `storyboard.shots@1`

## 7. 画布交互约定

- 单击节点：选中并可拖动。
- 双击标题：编辑标题。
- 双击内容：编辑节点内容。
- 右键节点：删除、复制、置顶、置底。
- 分组：框选多个节点后建立 tldraw group；移动一个成员时整组移动。
- 撤销/重做：位于顶部搜索按钮左侧。
- 输出端口是纯圆点，没有加号；端口按整张卡片高度均分。
- 所有标准节点默认尺寸为 `340 × 260`；只迁移已知历史默认尺寸，不覆盖用户手动缩放。
- 画布空白引导已移除。
- 左侧节点栏保持现有布局和两个字标签。

tldraw 交互特别注意：

- 卡片根元素不能拦截 pointer 事件，否则节点无法拖动。
- 输入框、按钮、端口等真正交互元素才调用 `stopEventPropagation`。
- 删除节点后必须同步删除失去 binding 的 arrow。
- 连接线必须是 arrow + start/end binding，不能画纯装饰线代替。
- 浮层需要考虑画布 transform；现有预览和菜单实现可作为参考。

## 8. 模型网关

供应商配置保存在本地 SQLite。应用是单用户本地工具，目前 API Key 明文落盘，这是已知取舍；禁止把 Key 写进代码、日志、示例项目或 Git。

文本/图片：

- 使用 OpenAI-compatible 接口。
- 支持自定义 Base URL、Key 和模型 ID。
- 对话使用流式事件。
- 生图结果落盘到项目媒体目录。

视频：

- 使用任务式提交、轮询、下载和恢复。
- 支持文本生视频和首帧图生视频。
- 重启后会恢复 submitted/running 任务。
- 供应商差异封装在主进程 gateway 适配层。

不要在渲染进程直接发带 API Key 的请求。

## 9. 本地数据

默认数据位置：

```text
%APPDATA%/canvas-studio/data/
├─ app.db
└─ projects/<projectId>/
   ├─ project.json
   └─ media/
```

`project.json` 同时保存：

- tldraw snapshot：真实画布恢复源。
- 派生 `nodes/edges/groups`：工作流和检查器使用。
- `graphVersion`：项目图版本。

项目写入使用临时文件和重命名，保留 `.bak` 回退。恢复快照失败时禁止自动保存空画布覆盖原项目。

## 10. 当前已知问题

必须优先处理：

1. `executor.ts` 仍通过节点类型 switch 执行，下一步应拆成节点自注册执行器。
2. 没有契约和工作流的自动化测试，当前主要依赖 typecheck、lint、build 和人工回归。
3. 节点固定配置与运行结果仍有历史混用，文本/旧脚本节点尤其需要在执行器解耦时分开。
4. `bodies.tsx` 体积较大，应该按节点拆文件，但不要在行为改造期间同时做无关视觉重写。
5. JSON Schema 种类不足，角色、场景、字幕和列表协议尚未建立。
6. 工作流模板的旧端口只能在唯一可推断时迁移；含糊的旧连线会跳过并提示。
7. API Key 尚未使用 Electron `safeStorage` 加密。
8. 生产构建会提示 `db.ts` 同时被动态和静态导入；当前不影响构建，但可在整理主进程模块时统一。
9. `pnpm audit --prod` 会报告 Electron 依赖链中的 `extract-zip@2.0.1` 路径穿越公告；上游目前没有可用修复版本。该包用于受信任的 Electron 安装/解包链路，不接收应用运行时用户输入。升级 Electron 时必须重新审计并移除此风险接受项。

产品能力缺口：

- 缺少独立的一次性“AI 处理”节点；当前工作流结构化转换借用对话节点。
- 缺少列表迭代和受控批量生图/视频。
- 缺少项目导出/导入和跨机器迁移。
- tldraw 外部字体/资源尚未完全本地化。
- 大节点数量下还没有系统性能基准。

## 11. 推荐的下一项工作

优先执行 [ROADMAP.md](./ROADMAP.md) 的 R0 和 R1：

1. 先补契约/连线/旧快照回归保护。
2. 定义 `NodeExecutor` 接口。
3. 把每个节点执行逻辑移到节点目录。
4. 将节点配置、运行输入和运行输出彻底分离。
5. 再增加结构化 AI 节点和批处理能力。

不要首先增加更多特殊业务节点。否则新的契约层会再次被全局 switch 和节点特例侵蚀。

## 12. 新节点接入步骤

1. 在共享类型中增加稳定 `NodeTypeId`。
2. 在节点 Spec 中声明职责、契约版本和全部端口。
3. JSON 端口先注册版本化 Schema。
4. 实现节点 Body，但不要让 Body 自己猜测上游节点类型。
5. 实现输出投影和节点执行器。
6. 右侧契约面板必须能解释输入、输出和连接来源。
7. 添加契约、连线、执行和旧项目迁移测试。
8. 更新 `NODE_CONTRACT_SPEC.md`、`ROADMAP.md` 或本文档中受影响的部分。

注册表会拒绝不完整契约。不要绕过校验来临时让节点出现。

## 13. 发布检查清单

```text
[ ] git status 中没有 Word、解析缓存、数据库、媒体或 API Key
[ ] pnpm install 没有原生依赖许可警告
[ ] pnpm typecheck 通过
[ ] pnpm lint 通过
[ ] pnpm build 通过
[ ] 文本节点双击可编辑
[ ] 图片粘贴/拖入后成为节点
[ ] 单值端口不能连接第二个上游
[ ] JSON Schema 不兼容连线被拒绝
[ ] 节点删除时关联线同步删除
[ ] 分组移动、撤销和重做正常
[ ] 旧项目打开、保存、重开正常
[ ] 对话 Markdown 正常渲染
[ ] 生图/视频真实供应商至少各冒烟一次
[ ] 提交信息说明行为变化和兼容策略
```

## 14. Git 与临时文件

以下内容禁止提交：

- Word 参考原文和 `.docx_review/` 解析缓存。
- 本地 SQLite、媒体文件和 Python `__pycache__`。
- API Key、Authorization header 和真实供应商配置。
- `node_modules/`、`out/`、安装包和日志。

本仓库当前直接使用 `main`。推送前必须先拉取/比较远程，再执行完整发布检查；远程领先时先停止并处理冲突，不能强推覆盖。
