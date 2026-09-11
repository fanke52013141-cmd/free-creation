# 节点深度审查报告（2026-09-11）

> 状态：第一轮已完成（23 个 Active 节点空态结构 + 视频节点深度审查）；视频 P0 协议/交互修复已完成并留有二次浏览器证据。
>
> 本报告不是“所有节点已验收”的声明。浏览器演示页的布局/交互证据已经采集，但远程模型的真实生成、任务轮询和结果落盘必须在桌面 Electron + 已配置供应商环境中单独通过。

## 1. 审查目标与结论

本轮把“能看到控件”与“能力真的可用”拆开验证，重点检查：

1. 节点 UI 是否在空态、已配置、已连接、错误和结果态保持可读且不溢出；
2. 用户操作是否改变了正确的 `props.config` / `meta.nodeRun` / `meta.nodeResult`，而不是只改变 React 局部状态；
3. 连线是否通过真实端口、类型、Schema、基数和稳定顺序建立；
4. 点击运行后是否调用对应 executor、provider/本地转换器，是否产生可连接输出；
5. 模型特性是否真正约束模式和参数，而不是展示一组“看起来能选”的通用控件。

当前最重要的判断：

- 节点注册、端口矩阵和大部分本地执行器已有基础；已有静态契约测试不能代替逐节点运行验收。
- 视频节点曾是当前最高风险样板。用户提出“连图片后不能再用文生视频、默认多参”已在 UI 与执行器共用的模式解析器中落实；本轮浏览器证据只证明本地 UI/连线/提交前约束，不代替真实供应商验收。
- 浏览器演示供应商已拆为 `specId: minimax`、`specId: seedance`，`MiniMax-H3` 不再错误落入 relay fallback。
- 23 个节点中，视频节点空态截图出现横向溢出；其余节点本轮空态截图未发现横/纵向 body 溢出，但这不代表其操作和真实输出已经通过。

## 2. 审查方法（以后每个节点都按同一流程）

### 2.1 事实源顺序

每个节点先建立一份“能力卡”，禁止从按钮文案或节点标题猜测：

1. `src/capabilities/definitions.ts`：Active capability、输入/输出端口、Schema、必填性、基数、configSchema；
2. `src/renderer/src/nodes/specs/index.tsx` 与 Body：实际呈现控件、保存字段、输入预览和状态；
3. `src/shared/engine/executors/*`：运行时读取的端口和输出投影；
4. `src/main/gateway/*` 或本地媒体服务：真实请求字段、任务轮询、结果入库；
5. 测试与浏览器/桌面运行证据：只把可复现的结果标为通过。

### 2.2 每节点状态矩阵

每个节点至少要截图并记录以下状态：

| 状态           | 必查内容                                                                    |
| -------------- | --------------------------------------------------------------------------- |
| 空态           | 标题、色条、端口、正文、主按钮、缺省值、body 是否溢出                       |
| hover/focus    | 下拉、按钮、端口、Tooltip 是否遮挡，键盘焦点是否可见                        |
| 已配置         | 配置是否写入 `props.config`，刷新后是否恢复                                 |
| 单输入/多输入  | 来源名称、端口名、顺序、缩略图/文本摘要、角色是否正确                       |
| 非法输入       | 类型、Schema、基数、模型能力冲突是否在放下/运行前阻断                       |
| running        | 禁止重复提交，保留旧结果，进度与取消入口清晰                                |
| success        | `meta.nodeRun`、`meta.nodeResult`、`projectOutputs`、媒体资产和下游预览一致 |
| failed/blocked | 错误可操作、旧成功结果不被伪装覆盖、重试路径有效                            |
| reload         | 保存、关闭、重开后边、输入顺序、结果来源和状态仍一致                        |

### 2.3 连线验收

每条关系都要同时验证四层：

```text
source.outPort
  -> persisted edge(fromPortId, toPortId)
  -> target resolved input (type/schema/cardinality/order)
  -> executor request/output
```

放下连线前验证类型、Schema、`one/many` 占用和环路；放下后检查目标节点显示真实值；运行后检查 executor 是否消费同一个 `portId`，不得通过“上游节点类型/标题扫描”补数据。

### 2.4 真实功能验收

- 本地媒体节点：用真实 PNG/JPG/MP4/WAV，检查文件读取、转换、媒体表、`mediaPath` 和输出端口；
- 远程生成节点：记录最终 HTTP method/URL/headers/body、task id、轮询响应、下载、入库和重启恢复；
- 浏览器 mock 只证明 UI、连接和演示数据流，不证明真实供应商协议；
- 每个“生成/修改/配置”按钮必须有前后快照和可断言结果，不能只验证按钮存在。

## 3. 第一轮证据

### 3.1 23 个节点空态截图

执行：

```powershell
node scripts/audit-node-ui.cjs http://127.0.0.1:3123/ artifacts/node-ui-audit-2026-09-11
```

证据目录：`artifacts/node-ui-audit-2026-09-11/`，包含 23 张节点截图和 `report.json`。视口为 `1708×879`，每个节点使用独立浏览器上下文，避免前一节点的配置污染后一节点。

### 3.2 视频节点深度审查

执行：

```powershell
node scripts/audit-video-node.cjs http://127.0.0.1:3123/ artifacts/video-node-audit-2026-09-11
```

证据目录：`artifacts/video-node-audit-2026-09-11/`，包含空态、选择模型、连接图片、手动选择非法模式等截图和结构化状态。

本轮真实观察到：

- fresh video：模型下拉有 `演示中转站 · MiniMax-H3`，但实际 value 为空；节点立即显示能力错误，生成按钮 disabled；
- 选择该模型后，因为演示供应商 `specId=relay`，仍解析为 fallback，只暴露“文生视频”；
- 图片输出接入视频 `in-images` 后，边确实创建，但模式仍是 `text`，节点显示“文生视频模式不能连接图片”；
- 视频空态 body `scrollWidth > clientWidth`，宽度在放大/适配后会出现横向内容挤压；
- 当前脚本的自动模式断言因此失败，证明演示 fixture 本身不能代表 MiniMax H3 的能力，不能把 mock 通过当真实验收通过。

### 3.3 P0 修复后二次证据

执行：

```powershell
node scripts/audit-video-node.cjs http://127.0.0.1:3123/ artifacts/video-node-audit-2026-09-11-p0-final3
```

结果：三个自动断言均通过：

1. 新建视频节点没有隐式 provider fallback，必须显式选择模型；
2. H3 连接一张真实图片后，默认模式为 `reference`（UI 名称“多参模式”）；
3. 接图后的模式选择只有 `reference`、`first-frame`，`text` 不再出现，提交按钮保持可用。

截图 `04-h3-one-image-filtered-modes.png` 同时确认输入卡展示缩略图、`video-audit` 资产名称和“参考图 1”角色。这是 browserMock 证据；真实模型请求、任务轮询、资产落盘仍须在 Electron + 已配置供应商环境完成。

## 4. 视频节点详细问题

### P0-VIDEO-001：未选择模型时直接进入错误态（已修复）

证据：

- `src/renderer/src/nodes/specs/bodies/video.tsx:173-181`：`data.modelKey` 为空时，能力退化为 `videoCapabilitiesFor('seedance')` 的 fallback；
- `src/shared/video-capabilities.ts:111-125`：fallback 只支持 `modes: ['text']`；
- `video.tsx:46-57`：未保存模式默认返回 `reference`；
- 浏览器截图 `artifacts/video-node-audit-2026-09-11/01-fresh.png`：模型有可选项但未选中，同时显示“当前模型不支持此视频生成模式”。

影响：新建节点第一眼就是“有模型但不能跑”，用户无法分辨是未选模型、模型加载中还是模式错误。

修复：明确拆分“未选模型 / 已选模型无素材 / 已选模型有素材”。未选模型时不套用 provider fallback；显示“请选择视频模型”，禁用生成和模型参数，待模型选中后再计算模式与参数。二次审查断言 `fresh-requires-an-explicit-model-choice` 已通过。

### P0-VIDEO-002：图片接入后仍允许选择文生视频（已修复）

证据：

- `video.tsx:509-513` 直接渲染 `capabilities.modes`，没有结合图片、参考视频、参考音频过滤选项；
- `video.tsx:204-227` 只在输入数量变化时尝试自动切换；
- `video-capabilities.ts:233-237` 只能在运行前报错，不能阻止用户先选出非法模式；
- 实际浏览器操作：图片边创建成功，但 mode 仍为 `text`，按钮只是 disabled 并显示冲突错误。

影响：核心约束变成“允许非法配置，再在最后拦截”，用户会认为图片连线失效；切换模型或重载时也可能保留不合法 mode。

修复：模式选项由“真实选中模型能力 + 当前输入集合”计算：

- 无图/无参考媒体：只显示文生视频；
- H3 + 1 张图：默认多模态参考，可明确切换首帧；
- H3-Max + 1 张图：隐藏多模态，只显示首帧；
- 两张图：允许首尾帧；多模态模型可另选参考模式；
- 参考视频/音频接入：仅支持参考能力的模型可进入多模态；不支持时直接标出具体端口和模型原因。

`resolveVideoMode` 同时被 renderer 与 executor 调用；已有保存的 `text` mode 在接入图片后会收敛为合法的 `reference`/首帧模式，无法再从 UI 下拉选择。二次审查断言 `one-image-forces-non-text-mode`、`text-mode-is-not-selectable-after-image-connects` 均通过。

### P0-VIDEO-003：浏览器演示 fixture 将 MiniMax H3 错标为 relay（已修复）

证据：`src/renderer/src/dev/browserMock.ts:43-55`：同一个 `specId: 'relay'` provider 里放入 `MiniMax-H3` 视频模型。

影响：`videoCapabilitiesFor('relay', 'MiniMax-H3')` 无法命中 H3 profile；浏览器审查永远看不到多参、首尾帧和 H3 参数，导致 UI 回归测试产生错误结论。

修复：浏览器演示已拆成独立的 `specId: minimax` 与 `specId: seedance` fixture。浏览器脚本已断言模型选择、模式收敛和提交可用性；真实请求 payload、轮询和结果入库仍列为桌面端验收项。

### P1-VIDEO-004：renderer 与 executor 的默认 mode 逻辑不是同一个函数（已修复）

证据：

- `video.tsx:68-75` 的 `automaticMode` 会看 capability；
- `src/shared/engine/executors/video.ts:16-27` 缺少 mode 时无条件返回 `reference`；
- `video.tsx:204-227` 与执行器各自维护默认策略。

影响：画布看起来已自动回退到首帧，但整图/headless 运行仍可能按 reference 提交；H3-Max 这类不支持参考的模型会产生 renderer/executor 分歧。

修复：已新增共享 `resolveVideoMode(capabilities, inputs, savedMode)`；renderer 与 executor 共用。保存的显式 mode 只在当前能力/输入组合仍合法时保留。

### P1-VIDEO-005：图片端口是 many，但首帧/尾帧/参考图角色只存在于 mode 推断（已修复）

证据：

- `definitions.ts:172-177` 只有一个 `in-images` many 端口；
- `video.tsx:181-196` 根据 mode 和顺序解释同一批图片。

影响：同一条边在切换模式后含义改变；用户无法在卡片里确认“图片 1 是首帧、图片 2 是尾帧、图片 3 是参考图”，上游也无法得知自己的输出角色。

修复：不拆分端口，但在目标卡片把每个已连接图片呈现为缩略图、资产名称与角色标签（首帧/尾帧/参考图 N）；模式切换同步更新，避免让连线只剩抽象圆点。

### P1-VIDEO-006：默认分辨率依赖数组最后一项，默认成本过高（已修复）

证据：`video-capabilities.ts:195-199` 和 `video.tsx:606-610` 都使用 `resolutions.at(-1)`。

当前会把 H3 默认成 `2K`，Seedance 2.0 默认成 `4k`。这不是“默认稳定档位”，而是由数组排序偶然决定的。

修复：能力 profile 已增加 `defaultResolution/defaultDuration/defaultRatio`。H3 默认 768P、5 秒、16:9；Seedance 默认 720p、5 秒、16:9；数组顺序不再承担业务语义。

### P1-VIDEO-007：Seedance 兼容网关把参数拼进 prompt，正式控件与真实能力不一致（已透明化，待真实 wire 验收）

证据：`src/main/gateway/video.ts:394-406` 把画幅、清晰度、时长、seed、水印拼成 `--rt/--rs/--dur/--seed/--wm` 后缀；非代理才发送结构化字段。

影响：UI 显示为参数控件，但兼容网关是否识别完全未知；参数失效时没有结构化错误，也无法证明 Seedance 2.0 的真实协议已接入。

已处理：能力 profile 现在显式声明 `parameterTransport`。官方端点显示为 `structured`；`/gateway/ark/` 兼容地址显示“兼容网关”说明，明确画幅、时长、清晰度按兼容格式提交且以任务回执为准；不再把它误呈现为已验证的官方结构化字段。仍待：用已开通价格的 Seedance 账号保存真实 request/response fixture，再将兼容模式升级为已验证适配器。

### P1-VIDEO-008：视频 configSchema 没有声明 mode/params（已修复）

证据：`src/capabilities/definitions.ts:223-225` 只有 `providerId`、`modelId`；实际 `mode`、`params`、prompt 仍由 Body 私有 JSON 解析。

影响：Agent/契约生成层看不到画幅、时长、分辨率和模式；节点协议无法独立描述“哪些配置组合可运行”。

修复：在不改变端口的前提下，已将 `prompt`、`modelKey`、`mode` 与 `params.ratio/duration/resolution/generateAudio/seed/watermark` 置入可版本化 configSchema，并将视频节点提升至 contractVersion 5、同步生成 Agent 契约。模型能力约束仍由共享 profile 与 resolver 校验。

### P1-VIDEO-009：输入格式、尺寸、请求体和提示词限制没有在节点侧提前验证（部分修复）

MiniMax H3 V2 当前文档给出的限制包括：提示词不超过 7000 字符；图片单个不超过 30 MB、宽高 [256, 5760] 且宽高比 0.4～2.5；视频单个不超过 50 MB、单段 2～15 秒且总时长不超过 15 秒；音频单个不超过 15 MB、单段/总时长同样受限；请求体总大小不超过 64 MB。当前 `VideoBody` 没有 `maxLength` 或媒体探测错误展示，`main/gateway/video.ts:285-325` 还会把媒体读成 Data URL 直接拼入请求。

影响：用户在 UI 里可以选择合法模式，但大文件、错误尺寸或过长提示词会在远端才失败；Data URL 会放大请求体并造成主进程内存峰值，尤其是多参模式。

已处理：H3 profile 已声明 7000 字符提示词上限，UI `maxLength`、renderer executor 与 main gateway 共同校验；主进程在读取 Data URL 前按媒体索引校验 H3 的图片 30MB、视频 50MB、音频 15MB 单项上限，并将原始参考媒体合计限制为 46MB，为 Base64/JSON 预留 64MB HTTP 请求体空间。仍待：在导入时写入图片宽高和视频/音频时长，再补齐 256～5760 像素、比例、2～15 秒等更细限制；优先改为供应商上传/临时 URL 后可取消 Data URL 总量折算。

### P2-VIDEO-010：H3 的 Context-IR 与视频再生成能力尚未形成独立可验收入口

MiniMax 官方指南还提供 H3-Context-IR（只生成增强提示词）和基于 H3 768P 成片再生成 2K 的任务入口。当前视频节点只有一次普通生成和 regenerate UI，没有把这两种能力建成独立节点/命令或明确标记为未支持。

影响：用户无法判断“重新生成”是复用当前 prompt 重新抽卡，还是调用官方 regeneration；Context-IR 也无法在工作流中复用。

优化：保持节点单一职责，后续分别设计 `video.context-ir` 与 `video.regeneration` 能力（或明确列为暂不支持），各自声明输入、输出和 provider capability；不得在现有“生成视频”按钮里隐式追加未声明业务输出。

## 5. 23 个节点第一轮 UI/端口矩阵

下表来自 `artifacts/node-ui-audit-2026-09-11/report.json`。它是结构审查，不是功能通过表。

| 节点      | 初始尺寸 | 输入/输出端口 | 空态溢出       | 第一轮判断                                          |
| --------- | -------: | ------------: | -------------- | --------------------------------------------------- |
| 文本      |  340×260 |         1 / 1 | 无             | 空态可见；需继续验证双击输入、保存、下游文本消费    |
| 图片      |  340×260 |         0 / 1 | 无             | 资产入口可见；需真实文件、替换、输出预览和下游连接  |
| 裁剪      |  340×260 |         1 / 1 | 无             | 配置入口可见；需真实裁剪结果、比例、动态高度        |
| 拆分      |  340×220 |         1 / 2 | 无             | 网格参数可见；需 2×2/4×4 结果展开、端口和尺寸重算   |
| 生图      |  340×260 |         3 / 1 | 无             | 模型/画幅/按钮可见；需真实比例请求和参考图关联      |
| 修改      |  340×260 |         2 / 1 | 无             | 工作台入口可见；需标注→mask→真实图生图结果          |
| 视频      |  340×356 |         5 / 1 | **有横向溢出** | **P0，见第 4 节**                                   |
| 取帧      |  340×260 |         1 / 1 | 无             | 需真实 FFmpeg/FFprobe、时间定位、媒体落盘           |
| 截取      |  340×260 |         1 / 1 | 无             | 需真实裁剪区间、输出视频和取消/失败                 |
| 提音      |  340×260 |         1 / 1 | 无             | 需真实音频输出、格式/路径和下游连接                 |
| 人声分离  |  340×260 |         1 / 1 | 无             | 需能力探测、模式、伴奏第二输出和失败路径            |
| 音频      |  340×260 |         0 / 1 | 无             | 需真实导入、名称、音频预览和下游输入                |
| 配音      |  340×260 |         1 / 1 | 无             | 需文本合并、模型/音色/格式和真实音频输出            |
| 语音克隆  |  340×466 |         2 / 1 | 无             | 需参考语音、后端可用性、克隆结果和状态              |
| 对话      |  340×260 |         1 / 1 | 无             | 需选中开侧栏、真实多轮、markdown 下游               |
| 处理      |  340×260 |         1 / 1 | 无             | 需透传/字段提取/模板和输出类型                      |
| JSON      |  340×464 |         2 / 1 | 无             | 需输入解析、非法 JSON、Schema 和保存重开            |
| 结构数据  |  340×260 |         2 / 1 | 无             | 需模板替换、角色/场景/镜头 schema 校验              |
| 代码      |  340×342 |         2 / 1 | 无             | 需动态输入端口、离线沙箱、失败和确定性              |
| 分镜板    |  340×260 |         2 / 2 | 无             | 需 storyboard Schema、解析/编辑、下游 prompt bundle |
| AI 处理   |  340×260 |         2 / 3 | 无             | 需 text/markdown/json 分支、Schema 错误和真实模型   |
| 循环      |  340×260 |         1 / 2 | 无             | 需顺序、限数、失败策略、取消和 item/out-items 关系  |
| 3D 预演台 |  340×260 |         3 / 4 | 无             | 本轮按约束暂不作为视频前置；需单独人工验收发布链路  |

## 6. 当前关系与测试覆盖判断

已有的 `test/connection-matrix.test.ts`、`test/contracts.test.ts`、`test/batch-connection.test.ts` 和 `test/connected-input-preview.test.ts` 能证明部分静态关系规则：类型、Schema、基数、many 顺序和批量连接计划的纯函数逻辑存在。

本轮运行结果：

```text
npm run typecheck                         PASS
npx vitest run test/video-capabilities.test.ts test/async-executors.test.ts   21 tests PASS
23-node empty-state browser audit         PASS (evidence generated)
video deep browser audit                  找到 P0/P1 证据（不是通过）
```

仍缺少的关键证据：

- MiniMax H3/H3-Max 的真实 HTTP body 逐字段断言；
- Seedance 2.0 官方方舟 endpoint、content role、参数和轮询响应的 wire fixture；
- 每个远程生成节点成功/失败/取消/重试的桌面端结果入库；
- 每个节点至少一条真实“上游输出 → 下游输入 → executor 消费”的保存重开链路；
- 模式切换后图片角色、画幅来源和输出结果摘要的截图门禁。

## 7. 模型协议核对基线

MiniMax 官方文档明确说明：

- H3 支持文生、图生、首尾帧和多模态参考；768P/2K，4–15 秒；
- H3-Max 只支持文生和图生（首帧/尾帧），不支持多模态参考；480P/768P，5–15 秒；
- V2 使用 `content[]`，必须有非空 text；首帧/尾帧和 reference role 互斥；图片 ≤9、参考视频 ≤3、参考音频 ≤3，总输入 ≤12；
- 文生视频 ratio 必须是明确比例；首/尾帧画幅由输入图片决定；参考模式可使用 adaptive 或明确比例；创建返回 `task_id`，成功后从 `task.content.url` 下载。

来源：

- [MiniMax 官方视频模型概览](https://platform.minimaxi.com/docs/api-reference/api-overview)
- [MiniMax 官方视频生成指南](https://platform.minimaxi.com/docs/guides/video-generation)
- [MiniMax H3/H3-Max V2 创建任务 API](https://platform.minimaxi.com/docs/api-reference/video-generation-v2-create)

火山引擎官方资料确认 Seedance 2.0 面向 API 采用任务提交与 task id 查询的异步形态，并支持视频创作场景；但当前项目中具体字段、角色和兼容网关语法必须以当前方舟账户/endpoint 的正式接口响应为准，不能仅凭模型名称或第三方适配器推断。

来源：[火山引擎 Seedance 2.0 API 接入教程](https://www.volcengine.com/article/40550)

## 8. 后续实施顺序

### P0：先让视频节点不再产生非法状态（已完成）

1. 修复未选模型状态；
2. 建立共享 `resolveVideoMode`；
3. 图片/视频/音频输入变化时重算模式，并过滤非法下拉项；
4. 修复 browserMock provider identity，增加 H3/H3-Max/Seedance fixture；
5. 目前已覆盖空态与 1 图→多参/首帧收敛；2 图、参考视频、参考音频的浏览器场景仍纳入 P2 的逐节点关系审查。

### P1：按真实模型能力收口参数和请求（进行中）

1. ✅ profile 已有显式默认值、提示词上限和 H3 媒体体积/总量约束；
2. ⏳ 补 MiniMax V2 的 text、first-frame、first-last、reference request fixture；
3. ✅ H3-Max 的禁止 reference 已有 capability/UI 回归；
4. ⏳ 补 Seedance 官方方舟和兼容网关两套真实 adapter fixture；
5. ✅ configSchema 已声明 mode/params，并已更新生成的 Agent 契约。

### P2：全节点操作验收

按上表 23 个节点逐个执行：空态 → 配置 → 单输入 → 多输入 → 运行 → 成功/失败 → 保存重开。每个节点必须留下截图、输入/输出快照、运行记录和关系断言。

### P3：桌面端真实发布验收

使用本机已配置的 MiniMax/Seedance 供应商，执行真实成片、下载、入库、下游消费、重启恢复和取消；浏览器 mock 不能替代这一门禁。导演台依照既定安排，放在其它节点能力和真实连线全部稳定之后。

## 9. 单节点完成标准

一个节点只有同时满足以下条件，才可以标为“完成”：

- UI 所有矩阵状态无遮挡、无溢出、无伪状态；
- 输入/输出端口、Schema、必填性和基数与 capability registry 一致；
- 连线后卡片显示具体来源和顺序；
- executor 只消费声明端口，并写入正确的 `meta.nodeRun/meta.nodeResult`；
- `projectOutputs` 只在成功结果存在时暴露输出；
- 成功、失败、取消、重试和保存重开都有证据；
- 远程节点的 provider 请求与官方接口字段逐项对齐；
- 改动涉及协议时，`npm run agent:generate`、契约测试和全量 `npm run verify` 通过。
