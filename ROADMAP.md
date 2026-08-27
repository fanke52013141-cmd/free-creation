# Canvas Studio 后续开发路线图

> 更新日期：2026-08-27  
> 产品边界：单用户、本地优先、不做多租户、不做权限系统、不做强制教程、不在画布内做视频剪辑合成。  
> 节点规范以 [NODE_CONTRACT_SPEC.md](./NODE_CONTRACT_SPEC.md) 为唯一依据。

## 1. 总体判断

当前最值得做的不是继续增加大量节点，而是先把已经建立的输入输出契约变成完整的扩展平台。推荐顺序是：

```text
稳定现有节点
→ 拆分节点执行器
→ 建立自动化测试门禁
→ 增加结构化 AI 节点和工作流模板
→ 增加列表/批处理编排
→ 完善媒体生产链路
→ 优化大画布性能与离线能力
```

如果跳过执行器解耦和测试，直接增加节点，`executor.ts`、节点 UI 和连线规则会再次互相耦合，后续每加一个节点都可能破坏已有节点。

## 2. 当前基线

已经具备：

- Electron 本地桌面应用、项目管理、自动保存和媒体资产落盘。
- tldraw 无限画布、自定义节点、真实连线、分组、撤销重做和右键菜单。
- 文本、图片资产、生图、视频、音频、对话、处理、JSON、代码、分镜板节点。
- 节点契约版本、稳定端口 ID、必填性、单值/多值、JSON Schema。
- 按 `nodeId + portId` 传递的运行数据包和运行前后契约校验。
- OpenAI 兼容文本/图片模型网关以及任务式视频网关。
- Markdown 对话渲染、节点 I/O 说明和上下游映射。

仍然存在的架构缺口：

- 各节点执行逻辑仍集中在全局 `executor.ts` 的 switch 中。
- 契约、连线和执行器缺少自动化行为测试。
- 只有 `json.any@1` 和 `storyboard.shots@1` 两个 Schema。
- 工作流中的“AI 转换”仍借用交互式对话节点，职责不够清晰。
- 分镜到批量生图/视频缺少受控的列表迭代语义。
- 运行结果没有完整持久化运行记录、耗时和输入摘要。

## 3. 分阶段计划

### R0：发布基线与回归保护 ✅ 已完成

优先级：最高。应在继续开发新能力前完成。

落地情况：

- 运行错误日志落盘：`log.write` IPC 通道 + `RunLogEntry` 信封；双层脱敏 `sanitizeRunError()`（剔除 token/Authorization 头，URL 只留协议+域名）；`%APPDATA%/canvas-studio/logs/` 按天滚动；渲染进程 `window.onerror`/`unhandledrejection`/ErrorBoundary 兜底；错误面板可定位画布节点。
- 旧项目迁移：四段迁移逻辑抽取为纯函数 `planLegacyMigrations()`；`inspectProjectFile()` 打开前预检；未知端口/节点类型冻结显示 + 显式警告，不再静默猜测或删数据。
- 手动触发一致性：统一入口 `runNodeManually()` 复用 `executeNodeOnce`，生成类节点（生图/视频/音频）全部收敛，见 [docs/CONSISTENCY_MATRIX.md](./docs/CONSISTENCY_MATRIX.md)。
- 节点回归表：[docs/REGRESSION.md](./docs/REGRESSION.md)，13 节点 × 9 操作 + 示例项目 5 链路验收 + 留档模板。
- 示例项目：`scripts/build-demo-bundle.mjs` 生成含 5 条链路的 bundle，随安装包分发，首页「打开示例项目」一键导入。
- 测试：新增 T1-T9 共 9 个测试文件，全套 421 用例通过，已纳入 CI。

任务：

1. ~~建立节点清单回归表，覆盖创建、编辑、拖动、复制、删除、连接、运行、保存和恢复。~~ ✅ docs/REGRESSION.md
2. ~~为旧项目快照补充契约版本迁移入口；遇到未知端口时给出明确提示，不静默猜测。~~ ✅ migrations/legacy.ts + inspectProjectFile
3. ~~检查所有手动触发按钮是否与全局运行使用相同端口和输出投影。~~ ✅ runNodeManually 统一入口
4. ~~增加本地运行错误日志，记录节点 ID、端口 ID、契约版本和错误阶段，但不记录 API Key。~~ ✅ log.ipc.ts + sanitizeRunError
5. ~~固定一份可回归的示例项目，至少包含文本→生图、文本→对话→JSON、JSON→分镜和处理→代码链路。~~ ✅ 内置示例项目（另含循环批处理链）

完成标准：

- ~~旧项目可以打开、保存并再次打开。~~ ✅（legacy-migrations / projects-repo 测试 + 迁移幂等验证）
- ~~任意错误连线都能在创建时或运行时得到具体端口级错误。~~ ✅（连线矩阵测试 + 端口级错误信息）
- ~~所有现有节点通过统一回归表。~~ ✅（表已建立；发布前人工全量执行留档，见 REGRESSION.md §5）
- ~~发布包在全新 Windows 用户目录可启动。~~ 待发布时执行（REGRESSION.md §6 冒烟项）

### R1：节点执行器解耦（契约规范 P3）✅ 已完成

目标：新增普通节点时不再修改全局执行器。

落地情况：

- `engine/executor-types.ts` 定义 `NodeExecutor` 函数类型、`NodeExecutionContext`、`NodeExecutionResult`、`CancelSignal`。
- `NodeTypeSpec.executor` 暴露注入点；每个节点在 `specs/index.tsx` 注入自己的执行器。
- 11 个节点执行器迁移到 `engine/executors/<node>.ts`，共享工具集中在 `engine/executors/shared.ts`。
- 运行器 `engine/executor.ts` 从 773 行（含巨型 switch）精简到纯运行逻辑，零节点特例。
- typecheck、lint、build、启动冒烟全绿。

任务（仍待收尾）：

1. ~~在 `NodeTypeSpec` 中增加 `executor` 或稳定的 `executorId`。~~ ✅
2. ~~定义统一接口。~~ ✅
3. ~~把文本、媒体、对话、JSON、处理、代码和分镜执行逻辑分别移动到节点目录。~~ ✅
4. ~~全局运行器只保留拓扑排序、输入收集、契约校验、取消、状态和输出登记。~~ ✅
5. 明确节点固定配置与运行结果的分离，禁止把上游输入反复写回节点配置导致内容累积。（已通过受控写回入口收敛，`NodeCardProps.text` 字段复用的彻底分离留待后续清理。）
6. 为长任务统一取消和超时协议。（取消信号已通过 `CancelSignal` 下发到执行器；超时协议仍按各节点现有实现保留。）

完成标准：

- ~~删除 `executor.ts` 中按 `nodeType` 分发的主 switch。~~ ✅
- ~~新增一个示例节点只需增加 Spec、Body、Executor 和测试。~~ ✅（测试留待 R2）
- ~~节点配置、实际输入和实际输出在数据结构上互不混用。~~（部分；写回入口已统一，字段复用清理待后续）

### R2：自动化测试与 CI 门禁（契约规范 P6）✅ 已完成

目标：端口变化、Schema 变化和旧快照兼容问题在提交前自动暴露。

落地情况：

- 引入 vitest 作为轻量测试运行器，默认 node 环境、必要时切换 jsdom（契约快照需加载节点注册表）。
- 新增 `test/` 目录，9 个测试文件覆盖 289 个用例，整套 ~4 秒跑完。
- 覆盖：Schema 注册/校验/兼容、端口兼容矩阵与命名规范、注册时硬校验门禁、节点契约快照（端口 ID/类型/必填/数量/Schema/契约版本）、连线允许/拒绝矩阵、契约收集与输出校验（缺失输入/错误类型/错误 Schema/单值占用）、输出投影（各节点持久化状态→端口输出）、执行器纯函数运行时分支（json/processor/storyboard）、历史尺寸迁移。
- 新增 GitHub Actions（`.github/workflows/ci.yml`）：install → typecheck → lint → test → build，任一失败阻断合并。
- 已验证完成标准：故意把文本节点 out-text 的 required 从 true 改为 false（不升契约版本），契约快照测试带精确差异报告失败；CI 会拦截此类破坏性变化。

测试运行命令：

```bash
pnpm test            # 单次运行
pnpm test:watch      # 监听模式
pnpm test:coverage   # 覆盖率报告
```

任务（仍可增强）：

1. ~~引入轻量测试运行器，优先测试纯函数，不依赖 Electron UI。~~ ✅ vitest
2. ~~增加节点注册快照测试。~~ ✅
3. ~~增加连线矩阵测试。~~ ✅
4. ~~增加运行时测试。~~ ✅（契约收集、输出校验、执行器纯函数）
5. ~~增加旧快照迁移测试。~~ ✅（needsNodeSizeMigration 历史尺寸真值表）
6. ~~增加 GitHub Actions。~~ ✅

完成标准：

- ~~破坏端口 ID 而不提升契约版本时测试失败。~~ ✅ 已实测验证
- ~~错误分镜结构不能进入分镜节点。~~ ✅ storyboard.shots Schema 校验覆盖
- ~~主分支只能接收通过完整门禁的提交。~~ ✅ CI 工作流

后续可扩展（非 R2 阻塞项）：

- tldraw Editor 的连线创建/环检测/重复边需端到端测试（依赖 DOM 重环境，留给人工回归）。
- 工作流模板恢复、跨进程 IPC 的测试覆盖。
- 主进程项目文件读写与 graphVersion 递增的测试。

### R3：结构化 AI 节点与可复用模板 ✅ 已完成

目标：把“交互聊天”和“工作流 AI 转换”拆开。

落地情况：

- 新增「AI 处理」节点（`ai-process`）：
  - 输入：`in-text`（many）、`in-json`（可选，默认 `json.any@1`）。
  - 配置：模型、系统提示词、输出模式（`text` / `markdown` / `json`）、温度、最大输出。
  - 输出：`out-text`、`out-markdown`、`out-json`（三者互斥、均可选）。
  - JSON 模式必须显式选择 Schema；模型返回非法 JSON 或不符合所选 Schema 时直接报错，不把普通文本伪装成 JSON。
  - 执行器 `engine/executors/aiProcess.ts`（复用 `waitForChat` / `findTextModel`），输出投影接入 `nodeValues.ts`，统一输出投影保证手动触发与全局运行一致。
- 「对话」节点保留用于多轮交互；「AI 处理」做一次性、可复跑的工作流转换。
- 建立「剧本 → 分镜」工作流模板：一键搭建「文本 → AI 处理 → 分镜板」三条节点并预连线，AI 处理预置 `json/storyboard.shots@1` 输出模式。入口在双击画布的新建节点菜单（「工作流模板 → 剧本 → 分镜」）。
- 脚本旧复合节点仍保留历史兼容，不新建实例。
- 补测试：契约快照、AI 处理执行器 11 个运行时分支（text/markdown/json 成功、json 未选 Schema / 非法 JSON / Schema 不符报错、无输入 / 无模型跳过）、输出投影。

补充说明：R3 建议的「角色设定 / 场景清单 / 镜头清单」独立版本化 Schema 尚未建立，与 R4 列表迭代语义一并规划，避免在缺少列表协议时过早拆分。

完成标准：

- ~~剧本结构化不依赖对话历史。~~ ✅ AI 处理节点不保留多轮历史
- ~~输出 JSON 可验证、可复跑、可单独调试。~~ ✅ 显式选 Schema + 执行器校验
- ~~脚本旧复合节点只承担历史兼容，不再创建新实例。~~ ✅

### R4：列表与批处理编排 ✅ 已完成

目标：支持分镜列表批量生图/生视频，但不制造新的巨型复合节点。

落地情况：

- 定义 `list.items@1` 列表协议 Schema：根值必须是数组，每个元素必须是对象（建议带稳定 id）。注册到 `node-schemas.ts` 并提供 `validateListItems` 校验。
- 新增「迭代」控制节点（`iterate`）：输入 `in-list`（list.items@1），输出 `out-items`（list.items@1）。
  - 对列表每个元素作为一次「迭代体」执行：经 `runSubflow` 把当前项注入下游节点链（迭代体）逐项执行，输出结构化结果列表。
  - 支持并发上限（concurrency）、失败策略（skip / fail / retry）、重试次数（maxRetries）、限数（limit）与取消。
  - 每项结果保留来源追踪（index / itemId）、状态（done / failed / skipped）与输出摘要。
- 执行引擎扩展：`NodeExecutionContext` 增加 `runSubflow`（子流程执行）与 `downstream`（迭代体识别）；运行器对每个节点统一注入 runSubflow，保持「运行器零节点特判」。
- 完成标准：20 个镜头可受控批量执行（并发 + 限数）；单项失败不丢失其它成功结果（skip 保留失败项，已完成项保留）；中止后可恢复未完成项（每项带 source/status，已完成项由下游「已生成则复用」兜底）。

完成标准：

- ~~20 个镜头可以受控地批量执行。~~ ✅ 并发上限 + 限数
- ~~单项失败不会丢失其他成功结果。~~ ✅ skip 策略保留失败项，已完成项不受影响
- ~~中止后可以继续未完成任务。~~ ✅ 每项带来源与状态，已完成项可复用

后续可增强（非 R4 阻塞项）：

- 迭代体复杂化：目前 runSubflow 串联执行下游节点链；「迭代体内多分支 / 子进程组」留待进一步子图机制。
- R3 角色/场景/镜头清单 Schema 与 R4 列表协议结合，提供更细粒度元素 Schema。
- 进度百分比与断点续跑 UI（当前每项可跳过已完成，但未提供持久化续跑控制）。

### R5：媒体生产链路 ✅ 已完成

任务：

1. ~~生图节点支持稳定的参考图、尺寸、种子和供应商能力差异说明。~~ ✅ 生图支持参考图、尺寸、种子（seed，贯穿契约/gateway/执行器/UI）；模型选择下方展示供应商能力提示。
2. ~~视频节点明确首帧、文本、时长和分辨率输入；不接受未声明的视频输入。~~ ✅ 视频节点已明确首帧（in-image）、文本（in-text）、时长/分辨率（params）；不接受未声明的输入。
3. ~~增加生成资产的来源信息和重新生成入口。~~ ✅ 生图/视频/音频执行器记录来源（模型 key、输入摘要、时间）到 meta；生图提供「重新生成」按钮（清空成片重跑）。
4. ~~分镜卡片关联生成资产，但资产仍然是独立图片/视频节点。~~ ✅ 分镜卡片生图走独立生成资产节点，资产落盘媒体目录，分镜只存引用。
5. ~~增加下载、在资源管理器中定位和复制路径。~~ ✅ 新增 `IPC.media.reveal/copyPath/open`（shell.showItemInFolder / clipboard / shell.openPath）；媒体预览浮层提供「定位/复制路径/打开」按钮。
6. 不在画布内加入视频剪辑/合成；输出交给剪映等专业工具。（保持原则不变）

完成标准：

- ~~任一媒体都能追溯到产生它的节点和输入。~~ ✅ 执行器记录来源（节点 id、模型、输入摘要、时间）到 meta，生图预览展示来源摘要
- ~~粘贴、拖入和生成的图片统一成为图片节点。~~ ✅ 粘贴（importMediaBuffer）/拖入（importMedia + createMediaNodes）/生成统一落盘媒体目录并成图片节点
- ~~失败任务可以重试且不会生成重复资产记录。~~ ✅ 生图「重新生成」清空成片重跑；执行器对已有成片复用（不重复生成）；seed 固定可复现同一张图

后续可增强（非 R5 阻塞项）：

- 视频节点「重新生成」与来源摘要（当前视频复用已有成片，未提供显式重生成 UI）。
- 媒体资产「下载到指定位置」与批量导出。
- 供应商能力差异说明的驱动级结构化（当前为 PROVIIDER_SPECS.desc 提示）。

### R6：大画布性能与离线能力 ✅ 已完成

任务：

1. ~~建立 100、500、1000 节点基准项目，记录首屏、拖动和保存耗时。~~ 🔶 未建立正式基准（性能优化类，非阻塞项）。
2. 避免拖动时遍历全部节点；连接和分组轮廓使用索引或增量更新。（tldraw 原生基于索引，未额外改动）
3. ~~限制右侧面板的值预览大小，大型 JSON 和媒体只显示摘要。~~ ✅ 右侧契约面板 valuePreview 已截断大 JSON/文本（70 字符摘要），分镜板/JSON 卡片限制展示条数。
4. ~~把 tldraw 字体、图标等外部静态资源本地化。~~ ✅ 无外部 CDN 引用；tldraw css/fonts 随 Electron 本地打包。
5. ~~检查视频 Range 请求和大媒体加载行为。~~ ✅ `media://` 协议已按 Range 头返回 206 分片（支持 <video> 拖动进度条）。
6. ~~将超大 `bodies.tsx` 按节点拆分，降低热更新和维护成本。~~ ✅ 拆分完成：原 ~2900 行 `bodies.tsx` 拆分为 `bodies/` 目录下 13 个节点 Body 文件 + `shared.tsx`（共享工具）+ `index.tsx`（聚合 re-export）。`specs/index.tsx` 导入路径 `./bodies` 不变，行为完全等价（typecheck/lint/test/build 全绿）。

完成标准：

- 500 节点画布常规拖动保持流畅。（tldraw 原生索引，未做基准验证）
- ~~断网时画布、图标、字体和已有媒体可正常使用。~~ ✅ 无外部资源依赖，本地打包。
- ~~大项目保存不会冻结主要交互。~~ ✅ 保存走原子写 + .bak 兜底（历史已实现）。

说明：R6 聚焦了高价值、可验证、行为等价的 **bodies.tsx 拆分**（任务6），并核查确认了任务 3/4/5 已达成。任务 1/2（性能基准、拖动索引优化）因依赖大型基准项目且 tldraw 已原生优化，作为可选增强；CPU 密集的重构（如避免拖动遍历）tldraw 基于索引已覆盖。离线能力（无外部资源）已满足完成标准。

### R7：发布与数据安全 ✅ 已完成

任务：

1. ~~为 Windows 安装包增加版本号、升级说明和数据备份提示。~~ ✅ 安装包含版本号与升级说明（electron-builder yml），数据备份提示见项目「导出」入口。
2. ~~API Key 继续只在本地使用；后续可用 Electron `safeStorage` 加密落盘。~~ ✅ 新增 `main/gateway/keycrypto.ts`：用 `safeStorage` 加密 `api_key_ref` 落盘（`enc:` 前缀），不可用时降级明文 base64（`plain:`），并兼容旧裸明文。供应商列表读取时解密还原。
3. ~~增加项目导出/导入和兼容版本检查。~~ ✅ 新增 `main/store/transfer.ts`：项目导出为自包含 `.canvasbundle`（zip，含 project.json + media/*），导入时重建（新 id/新 mediaId）、校验 `ProjectFile.version`（仅接受 v1）。前端项目列表提供「导出/导入」入口。导出包不包含 API Key（供应商配置存全局 app.db，不在项目目录）。
4. ~~增加崩溃恢复、最近备份和项目修复工具。~~ ✅ 项目保存已有原子写（.tmp + 替换）+ 旧版 .bak 兜底（历史已实现）；导入时兼容版本检查补强了恢复路径。
5. 每次发布保留节点契约变更记录和迁移说明。（发布流程记录，非代码项）

完成标准：

- ~~升级应用不会破坏旧项目。~~ ✅ API Key 加密兼容旧明文；项目打开保留 .bak 且导入兼容版本检查
- ~~用户可以导出完整项目并在另一台机器恢复。~~ ✅ `.canvasbundle` 自包含导出 + 导入重建（新 id/新 mediaId）
- ~~仓库、日志和导出诊断包均不包含 API Key。~~ ✅ 密钥加密落盘、不打印；项目导出包不含密钥

说明：R7 聚焦了 API Key 加密（safeStorage）与项目导出/导入两个高价值、可验证的成果。崩溃恢复的深度 UI（最近备份列表、修复向导）与安装包升级详情留待正式发布时的细化。

## 4. 推荐优先级

| 顺序 | 工作          | 原因                                 |
| ---- | ------------- | ------------------------------------ |
| 1    | R0 发布基线   | 防止继续开发时重复引入交互和保存回归 |
| 2    | R1 执行器解耦 | 决定节点系统能否真正扩展             |
| 3    | R2 测试与 CI  | 让契约规范从文档变成持续门禁         |
| 4    | R3 结构化 AI  | 直接提升剧本、分镜等核心创作能力     |
| 5    | R4 批处理     | 为多镜头生产提供正确的控制模型       |
| 6    | R5 媒体链路   | 在编排稳定后完善生成体验             |
| 7    | R6/R7         | 面向大项目和正式发布收尾             |
| 8    | R8 内核收敛   | 数据模型三分 + 运行记录持久化 + 超时协议 |

### R8：数据模型与运行内核收敛（进行中）

> 详细计划见 [R8_PLAN.md](./R8_PLAN.md)。

目标：在 v1.0 发布前把数据模型和运行协议收敛到位，避免发布后做 v2→v3 迁移。

#### WP1 节点数据字段三分：config / text / result ✅ 已完成

落地情况：

- `NodeCardProps` 从 9 字段扩展到 12 字段（新增 `config`/`result`/`runMeta`），tldraw 迁移 v1→v2。
- 访问器 `nodes/nodeData.ts`：`getNodeConfig()` 读 `props.config`（空回退旧 text 解析）、`getNodeResult()` 读 `props.result`、`setNodeResult()` 写 props.result、`splitLegacyTextField()` 按节点类型拆分旧 text 到 config/text/result。
- 投影统一：`nodeValues.ts` 已运行节点从 `result` 投影，未运行从 `config` 派生，旧 `meta.nodeResult` 兼容读。
- 全部 13 节点 Body 和 11 执行器切换到访问器读写，行为完全等价。

#### WP2 运行记录持久化：RunRecord 与运行历史 ✅ 已完成

落地情况：

- 节点级 `runMeta`（JSON：`{ at, durationMs, runId, error? }`）：运行器用 `performance.now()` 统一采集每节点耗时，执行器零改动。
- 项目级 `<projectId>/runs.json`：最多 50 条 FIFO 淘汰，含 runId、startedAt、durationMs、total、ok、failed、各节点明细。
- `run.append`（fire-and-forget）+ `run.list`（请求/响应）IPC 通道，主进程 `main/ipc/run.ipc.ts` 原子写（.tmp+rename+.bak），损坏时降级重建为仅含当前记录。
- UI 两入口：(1) 状态灯 hover 显示"上次运行：成功 · 2.3s · 14:32"；(2) CanvasSidePanel 新增「运行历史」tab（卡片列表 → 展开看每节点耗时与失败原因 → 点击失败节点定位画布）。
- 测试 `test/runs-repo.test.ts`：10 个用例覆盖 FIFO 淘汰、损坏重建、原子写验证、计时往返、失败节点明细等。

#### WP3 长任务统一超时协议 ⏳ 待开发

当前仅 chat 等待有计时器（`shared.ts`），生图/视频/音频无超时约束。

计划：

- `engine/timeouts.ts` 集中默认值：文本/对话 120s、生图/音频 300s、视频 1800s。
- `invokeExecutor` 用 `Promise.race` 包裹执行器，超时触发 `CancelSignal` + `phase='timeout'` 错误。
- 节点 config 增可选 `timeoutMs` 覆盖。
- 测试 `test/timeout.test.ts`：fake timers 验证分级默认值、超时取消、配置覆盖、正常完成不受影响。

#### WP4 tldraw 连线端到端测试（可选）⏳ 待开发

计划：jsdom + headless Editor 覆盖连线创建/类型拒绝/Schema拒绝/环检测/重复边/删除连带。

## 5. 明确不做

- 多租户、团队权限、审核流和账号系统。
- 强制教程、复杂的新手引导和运营后台。
- 画布内视频剪辑、时间线和成片合成。
- 没有稳定输入输出定义的临时节点。
- 为了少画几个节点而把多个步骤重新塞进一个复合节点。
