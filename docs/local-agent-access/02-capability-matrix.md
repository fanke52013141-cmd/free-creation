# 本地 Agent 接入能力矩阵（评审草案）

2026-10-24 内容 Skill Agent 接续：AI 对话与 AI 处理桌面节点增加固定 Skill 配置和自主内容循环；外部节点执行、Skill 安装仍未开放，不提升本矩阵状态。公共端口/输出和外部 Schema 不变；接入影响、持久化、日志和验证见[本包交付记录](../SKILL_AGENT_DELIVERY_2026_10_24.md)。

状态：评审草案；日期：2026-10-24；范围：本地单用户桌面应用。

2026-10-24 A1.4接续：当前Registry为18项（14项项目/发现操作+4项只读查询），具体实现和验证见[最新查询台账](08-a1-4-read-only-queries.md)。下方9/11项描述保留为早期基线，不能用作当前总数。

A1.1接续：当前Registry为11项操作，project.open/update及活动画布保存/导出已实施，最终验证状态见[桌面项目操作台账](06-a1-1-desktop-projects.md)。下文9项为前包历史基线，整个A1及31类节点不升级为完成。

实施接续：以下矩阵为完整目标基线；A0+A1最小包的9项实际操作、入口、验证与限制见[交付台账](05-a0-a1-minimal-delivery.md)。其机器目录见[当前契约快照](generated/contracts.json)；未列入已交付子集的项目/节点动作继续planned，不将整行或整个阶段升级为verified。

本文件是完整目标清单；当前CLI/MCP已有9项最小操作，HTTP未实现。下表中的 `A1` 至 `A4` 表示计划归属，逐行planned是设计基线，具体动作的最新支持与证据以交付台账及机器目录为准，不能把整个阶段解释为已完成。

本文件不改动执行、文件、数据库或网络路径，日志影响为“不涉及”。实施每一项时，仍须按 [日志检查模板](../templates/LOGGING_CHANGE_TEMPLATE.md) 完成该项的事件、脱敏、失败与覆盖清单验收。

## 1. 状态语义、口径与范围

### 1.1 状态

| 状态          | 含义                              | 对外承诺                             |
| ------------- | --------------------------------- | ------------------------------------ |
| `planned`     | 已有接口设计，尚未实现外部适配器  | 不能调用                             |
| `implemented` | 已实现 MCP/CLI/API 适配及最小测试 | 可在标明的 transport 上调用          |
| `verified`    | 已通过规定的自动与真实桌面验收    | 可作为稳定能力宣称                   |
| `excluded`    | 本版本明确不开放                  | 返回稳定的“不支持”错误，不能静默降级 |

“内部 Flow 支持”只表示画布原生 Agent Flow 已有目标适配/命令协议；它不是 `implemented`，也不是外部 MCP/CLI/API 的可用证明。桌面节点有 executor 同样不能推导为可由外部 Agent 自动执行。

覆盖率分母由主规范的 operation Registry 自动生成：每个唯一 `operationId`、每个 transport 暴露和 31 个 Active 节点分别计数。每次发布报告列出 `implemented / verified / excluded / planned` 的实际 operation、transport 和节点清单，不以“已有 IPC 数”或“已有 executor 数”替代。

### 1.2 阶段

| 阶段 | 交付目标                                           | 退出条件                                                                                    |
| ---- | -------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| `A0` | 规范、操作目录、统一请求信封、身份与日志门禁底座   | 本文件、接口规范、变更门禁和测试模板进入 CI；没有业务接口                                   |
| `A1` | 一条端到端 MCP + CLI 路径，项目读写与导出          | `run.get`、项目 CRUD/导出在隔离数据中完成，并发/幂等/脱敏通过                               |
| `A2` | 图与全部 31 节点的结构化读取、编辑；确定性节点执行 | 任意 Active 节点均可被枚举、读取契约、创建/更新配置、连线和删除；已开放执行的节点有独立验收 |
| `A3` | 模型/媒体长任务与已有 Agent Flow 协议              | 租约、固定输入、异步状态、取消、unknown、恢复和结果版本与桌面一致                           |
| `A4` | 复杂交互、高风险动作及可选 localhost HTTP          | 专项安全与人工确认完成；HTTP 不早于 stdio MCP/CLI 验证后开放                                |

### 1.3 统一请求和结果

统一信封、版本规则和 operation Registry 以 [主规范 §5](../../AGENT_ACCESS_SPEC.md#5-调用版本与事务协议) 为准，本文件不重复维护 TypeScript 定义。`operationId` 是稳定业务名称，调用唯一身份使用 `requestId`；可重试写入另带幂等键。MCP 工具、CLI 命令与可选 HTTP 只负责转换 transport，不拥有业务逻辑。下表建议操作初版均为 operationVersion=1，版本与稳定名称分字段保存。

`completed` 只表示该操作自己的提交事实；模型任务被服务端接受、媒体下载完成、节点输出通过校验、项目保存完成是不同事实。长任务先返回 `accepted + taskId`，由 `run.get` 按taskId查询，内部runId/commandId和供应商upstreamTaskId分别关联。远端结果不明时返回 `unknown`，禁止自动重发可能产生费用或副作用的动作。

适配层只能调用 main 进程中的公共 service/repository、命令账本和既有桌面执行桥。它不得读取/写入 `project.json`、SQLite、媒体目录，不能调用 React、DOM 或自行实现 headless 图运行器。此约束来自历史缺陷：旧 headless 曾发生 config/text 映射、输出投影、取消恢复与多输入持久化不一致（[历史评审](../HANDOFF_2026_09_15_CODE_REVIEW.md) F05–F09）。

## 2. 能力矩阵

### 2.1 项目

项目的真实事务拥有者是 [projects.repo.ts](../../src/main/store/projects.repo.ts)，保存具有 `expectedGraphVersion` 乐观锁、写锁、备份与索引校准。对外适配器必须复用它。

| 能力             | 建议 `operationId` | 阶段 | 当前外部状态 | 风险与约束                                                                                             | 验收                                                  |
| ---------------- | ------------------ | ---- | ------------ | ------------------------------------------------------------------------------------------------------ | ----------------------------------------------------- |
| 列出项目         | `project.list`     | A1   | verified（CLI/MCP，见[台账05](05-a0-a1-minimal-delivery.md)） | 只返回受控摘要；不回传本地绝对路径或 API Key                                                           | 空库/多项目排序/字段脱敏                              |
| 读取项目语义 DTO | `project.get`      | A1   | verified（CLI/MCP，见[台账05](05-a0-a1-minimal-delivery.md)） | 按 projectId 返回受控语义 DTO，不对外给任意原始快照                                                    | 旧快照、缺失媒体、只读不改版本                        |
| 打开项目         | `project.open`     | A1   | verified（CLI/MCP，见[台账06](06-a1-1-desktop-projects.md)） | 改变宿主驻留/呈现状态；协调当前未保存修改、活跃任务和占用                                              | 未保存内容保留；忙碌项目不能被替换                    |
| 新建项目         | `project.create`   | A1   | verified（CLI/MCP，见[台账05](05-a0-a1-minimal-delivery.md)） | 名称长度/字符校验；请求重试复用幂等键                                                                  | 同键不重复创建、保存重开可见                          |
| 保存项目         | `project.save`     | A1   | verified（CLI/MCP，见[台账06](06-a1-1-desktop-projects.md)） | 请求权威宿主flush并确认提交版本；不接收客户端语义 DTO或快照覆盖                                        | 冲突、备份、保存重开                                  |
| 更新项目元数据   | `project.update`   | A1   | verified（CLI/MCP，见[台账06](06-a1-1-desktop-projects.md)） | 只更新声明的元数据；图变化由 `graph.patch` 承担                                                        | 字段白名单、冲突、幂等                                |
| 重命名           | `project.rename`   | A1   | verified（CLI/MCP，见[台账05](05-a0-a1-minimal-delivery.md)） | 带期望版本或当前项目修订；不得借名称传递内容                                                           | 重试幂等、冲突、持久化                                |
| 复制项目         | `project.clone`    | A1   | verified（CLI/MCP，见[台账07](07-a1-2-clone-delete.md)） | 复用 clone 的媒体 ID/结构化引用重映射；固定源版本，活动源先保存握手；不继承运行任务                       | 源项目不变、克隆可独立打开                            |
| 删除项目         | `project.delete`（前置 `project.delete.precheck` 签发短期 impactToken） | A1   | verified（CLI/MCP，见[台账07](07-a1-2-clone-delete.md)） | 硬删除；必须精确 `projectId`、预检令牌绑定权威修订与影响摘要、显式确认；拒绝活动画布与运行/未知占用；禁止批量删除；同名新项目不受旧回执影响 | 确认缺失/令牌过期或事实漂移/占用拒绝；审计与幂等       |
| 导出项目         | `project.export`   | A1   | verified（CLI/MCP，见[台账06](06-a1-1-desktop-projects.md)） | 调用 [transfer.ts](../../src/main/store/transfer.ts)；目标限在调用方声明的已允许目录；回传缺失媒体计数 | API Key 排除、媒体与结构化引用检查、临时文件提交/清理 |
| 导入项目包       | `project.import`   | —    | excluded     | 用户本轮明确不对接项目导入；保留桌面路径，不开放工具                                                   | tools/list 中不存在；直调返回稳定拒绝码               |

“媒体受控接入”是把一个已选定的本地文件经受控目录、MIME/大小/哈希检查后物化为媒体资产；它不接受项目包，也不替代项目导入。因此它不违反上述 `project.import` 的排除范围。

项目修改 = 元数据更新 + 画布内容修改 + 提交保存，分别对应 `project.update`、`graph.patch / node.update` 和 `project.save`，不以“可保存”替代“可修改”。

### 2.2 资源库

资源库适配复用 [library.repo.ts](../../src/main/store/library.repo.ts) 和 [library.ipc.ts](../../src/main/ipc/library.ipc.ts) 的 repository/诊断边界。资源名称、说明和文件内容是用户内容，日志不可记录。

| 能力               | 建议 `operationId`                                      | 阶段        | 当前外部状态 | 风险与约束                                                                    | 验收                         |
| ------------------ | ------------------------------------------------------- | ----------- | ------------ | ----------------------------------------------------------------------------- | ---------------------------- |
| 搜索/列出/读取资源 | `library.search` / `library.get`                        | A1          | search摘要implemented；get planned      | 分页、字段白名单、正文按需读取                                                | 权限外路径不可泄露、分页稳定 |
| 创建资源与文件夹   | `library.create_resource` / `library.create_folder`     | A2          | planned      | 文本及元数据结构校验；媒体只能走受控接入                                      | 幂等、失败不留半成品         |
| 采集项目节点/媒体  | `library.capture_project_asset`                         | A2          | planned      | 固定来源 project/revision/media；不复制密钥                                   | 来源可追溯、源项目不变       |
| 发布/归档资源修订  | `library.publish_revision` / `library.archive_revision` | A4          | planned      | 版本不可变；归档含确认                                                        | 修订冲突、回读一致           |
| 集合/展板维护      | `library.save_collection` / `library.save_board`        | A2          | planned      | 仅 ID 引用；不把项目图复制为第二拓扑                                          | 顺序/引用校验、保存重开      |
| 导出资源包         | `library.export_package`                                | A1 可选扩展 | planned      | 与用户明确要求的project.export分开；复用现有 transfer；不含 API Key，路径受控 | 包往返、脱敏、缺失引用报告   |
| 导入资源包         | `library.import_package`                                | A4          | planned      | 非本轮必须项，待单独安全设计；与项目导入不同                                  | 重映射、事务回滚、恶意包拒绝 |

### 2.3 画布图与节点通用操作

图是唯一可编辑流程定义，不能通过 Agent 侧保存第二份任务拓扑。操作使用声明端口 ID，不根据节点标题或类型猜测数据。

| 能力                 | 建议 `operationId`                          | 阶段  | 当前外部状态 | 风险与约束                                                                         | 验收                                       |
| -------------------- | ------------------------------------------- | ----- | ------------ | ---------------------------------------------------------------------------------- | ------------------------------------------ |
| 读取图与契约目录     | `graph.get` / `node.type.list`              | A1    | planned      | 返回稳定 nodeId/type/contractVersion/ports/schema 引用                             | 与注册表快照一致                           |
| 受控原子图写         | `graph.patch`                               | A2    | planned      | 显式 add/update/remove node/edge 与关系类型；不接收任意快照覆盖                    | 全成或全拒绝、修订冲突、关系类型校验       |
| 创建节点             | `node.create`                               | A2    | planned      | 只接受 Active 类型与声明 config/text；必须经注册校验                               | 31 类型逐项创建、旧类型拒绝                |
| 读取节点/运行摘要    | `node.get`                                  | A2    | planned      | 默认安全摘要；正文可在显式字段选择下返回，但不得进入诊断                           | 结果与保存快照一致                         |
| 更新配置或正文       | `node.update`                               | A2    | planned      | config 与 text 分离；契约版本不可由更新伪造                                        | 输入 schema、冲突、保存恢复                |
| 重命名/摆放/删除节点 | `node.rename` / `node.move` / `node.delete` | A2    | planned      | 删除仅影响声明关系；产物/来源按现有业务规则处理                                    | 连线清理、产物不被隐式误删                 |
| 创建/删除关系        | `edge.create` / `edge.delete`               | A2    | planned      | 明确数据/控制/状态关系及相应准入；生产溯源只读，由正式产物路径生成，不能由外部伪造 | 全连接矩阵、many 顺序、拒绝无效边/伪造溯源 |
| 校验图               | `graph.validate`                            | A2    | planned      | 只读；报告 portId/字段路径，不写入用户内容至诊断                                   | 断边、循环、schema、版本案例               |
| 提交节点执行         | `node.execute`                              | A2–A3 | planned      | 逐节点按第 3 节开放；长任务不得伪装同步成功                                        | 状态机、取消、unknown、重开恢复            |

A1.4首包接续：[查询交付台账](08-a1-4-read-only-queries.md)。`library.search`只开放摘要检索；`model.list`只回本地配置/验证事实，不探测在线；`run.get`仅覆盖持久化内部Agent任务；`diagnostics.summary`仅健康计数。其余动作继续planned。

### 2.4 模型、媒体和运行诊断

| 能力                    | 建议 `operationId`                                                                  | 阶段                   | 当前外部状态 | 风险与约束                                                                            | 验收                                     |
| ----------------------- | ----------------------------------------------------------------------------------- | ---------------------- | ------------ | ------------------------------------------------------------------------------------- | ---------------------------------------- |
| 列出已验证模型能力      | `model.list`                                                                        | A1                     | implemented（首包）      | 只给连接 ID、模型 ID、能力和状态；绝不返回密钥/完整 URL                               | 脱敏、离线/失效状态                      |
| 受控媒体接入            | `media.ingest`                                                                      | A3                     | planned      | 目录授权、大小/MIME/内容校验、临时落盘后提交                                          | 失败回滚、媒体 ID/相对路径重映射         |
| 读取媒体元信息/受控导出 | `media.get` / `media.export`                                                        | A3                     | planned      | 返回资源 ID、尺寸、MIME；文件传输须显式路径或二进制通道                               | 越界路径/签名 URL 不泄露                 |
| 运行查询/取消/核对/继续 | `run.get` / `run.list` / `run.wait` / `run.cancel` / `run.reconcile` / `run.resume` | A1 基础查询，A2–A3扩展 | run.get子集implemented；其余planned      | 按taskId；接受不等于完成；unknown 不重放；取消核对远端事实；resume逐类开放            | 超时、远端未知、重开、幂等               |
| 输出列出/读取/选择/导出 | `output.list` / `output.get` / `output.select` / `output.export`                    | A2 基础，A3媒体扩展    | planned      | 选择只改变显式活动输出，不覆盖不可变产物；导出受控路径                                | 产物版本、来源、缺失媒体、导出脱敏       |
| Flow 生命周期           | `flow.start` / `flow.get` / `flow.stop` / `flow.resume` / `flow.reconcile`          | A3                     | planned      | 复用命令账本/租约；未知不重放，不建立第二任务拓扑                                     | 占用、冲突、暂停、恢复、未知             |
| 审核读取/AI 继续        | `review.get` / `review.continue`                                                    | A3                     | planned      | AI 只能按固定资产/规则继续；人类确认、发布、选择门禁不可由调用方冒充                  | 技术失败与质量拒绝区分；人工门禁拒绝伪造 |
| 诊断摘要/导出           | `diagnostics.summary` / `diagnostics.export`                                        | A1                     | summary健康计数implemented；export planned      | 复用诊断包；不能导出密钥、签名 URL 或原始请求响应；正文/提示词/回复不进入日志或诊断包 | 脱敏样例、范围/截断/丢失显示             |
| provider/API Key 管理   | —                                                                                   | —                      | excluded     | 外部 Agent 不读写供应商配置、密钥或任意 URL                                           | tools/list 不暴露，直调拒绝              |

## 3. 节点逐项对接清单

节点标识、版本和可创建范围以 [共享节点清单](../../src/shared/types/index.ts) 和 [注册表](../../src/renderer/src/nodes/specs/index.tsx) 为准。下表的“结构化适配”均为 A2 目标：列举、读取契约与安全摘要、创建、更新 config/text、端口连线和图校验。`执行`描述的是建议开放阶段，并不表示当前对外可执行。

**31个节点的外部动作目前全部为planned，登记完成不等于可调用。** 实施账本按 `discover/read/create/update/connect/execute/result/export` × transport 记录独立状态、证据链接和不适用原因；表中合并展示的A2目标不能代替动作级验收。资产节点可查询/投影而无需创建执行任务；没有对应端口或产物的动作明确不适用。

| 节点              | 标签      | 结构化适配与执行建议         | 当前内部 Flow    | 外部限制                                                               |
| ----------------- | --------- | ---------------------------- | ---------------- | ---------------------------------------------------------------------- |
| `text@3`          | 文本      | A2 结构化读写；无需远端执行  | 无               | 正文可由显式读取返回，不能进入诊断                                     |
| `image@3`         | 图片      | A2 结构化读写；媒体接入 A3   | 无               | 只能引用受控媒体 ID，不能给任意路径                                    |
| `image-crop@2`    | 裁剪      | A2 读写；A2 确定性执行       | 支持 target      | 归一化裁剪配置与输出资产需校验；配置在命令准入处校验                   |
| `image-split@3`   | 拆分      | A2 读写；A2 确定性执行       | 支持 target      | 一次生成多资产，保持来源关系；配置在命令准入处校验                     |
| `image-gen@3`     | 生图      | A2 读写；A3 模型任务         | 支持 target      | 固定输入、单任务、模型能力与费用型重试规则                             |
| `image-edit@2`    | P图       | A2 读写；A3 模型任务         | 支持 target      | 必须固定一张原图；遮罩为版本化配置                                     |
| `website@1`       | 网址节点  | A2 读写；A4 执行             | 无               | 需要网络许可、域名/体积/超时策略                                       |
| `video@7`         | 视频生成  | A2 读写；A3 模型长任务       | 支持 target      | 固定有序输入；引用上限与所选模型更低上限均生效                         |
| `video-asset@2`   | 视频素材  | A2 读写；媒体接入 A3         | 无               | 仅受控媒体资产，不能直接读取本机任意路径                               |
| `video-frame@4`   | 抽帧      | A2 读写；A3 媒体处理         | 无               | 时间点以毫秒；独立图像产物                                             |
| `video-clip@5`    | 视频截取  | A2 读写；A3 媒体处理         | 无               | 起止范围/多输出受契约约束                                              |
| `video-depth@1`   | 深度视频  | A2 读写；A3 本地异步任务     | 无               | 本地 Python/CUDA/ffmpeg 安装状态、资源预算、取消清理与保存恢复另验收   |
| `video-clay@1`    | 白模视频  | A2 读写；A3 本地异步任务     | 无               | 本地 Python/CUDA/ffmpeg 安装状态、资源预算、取消清理与保存恢复另验收   |
| `audio@3`         | 音频      | A2 读写；媒体接入 A3         | 无               | 仅媒体 ID 与安全摘要                                                   |
| `sound-adjust@1`  | 声音调整  | A2 读写；A3 媒体处理         | 无               | exclusiveGroup 输入与媒体输出校验                                      |
| `file@2`          | 文件      | A2 读写；受控接入 A3         | 无               | MIME/大小/路径白名单；不解析任意可执行文件                             |
| `speech@4`        | 语音合成  | A2 读写；A3 模型任务         | 支持 target      | 文本/音色/参考音频固定；异步任务与媒体资产                             |
| `tts@4`           | 语音克隆  | A2 读写；A3 模型任务         | 支持 target      | 参考音频与配置校验；输出 JSON 版本固定                                 |
| `voice-design@1`  | 音色设计  | A2 读写；A3 模型任务         | 无               | 模型适配、输出版本和脱敏单独验收                                       |
| `chat@1`          | AI 对话   | A2 读写；A4 会话执行         | 无               | 多轮会话、附件和人工输入需专门协议；消息正文不得写入日志               |
| `processor@1`     | 数据处理  | A2 读写与确定性执行          | 支持 target      | 与 `PROCESSOR_CONTRACT_VERSION` 保持一致；输入/输出 schema 校验        |
| `code@3`          | 代码      | A2 读写；A4 执行             | 支持 target（限单参数单输出） | 内部调度仅接受 single 形态配置；对外 sandbox 安全边界仍待专项核验，不得假定现有 `runCode` 已满足隔离要求 |
| `json@1`          | JSON      | A2 读写与确定性校验          | 无               | 结构必须通过声明 schema                                                |
| `structured@1`    | 结构数据  | A2 读写与确定性校验          | 无               | 结构必须通过声明 schema                                                |
| `storyboard@1`    | 分镜板    | A2 读写与确定性校验          | 无               | 保留字段标题映射，禁止隐式改 shots 语义                                |
| `ai-process@1`    | AI 处理   | A2 读写；A3 模型任务         | 无               | 先定义输入/输出与供应商适配再开放                                      |
| `iterate@2`       | 循环      | A2 读写；A4 执行             | 无               | 子流程、暂停、取消、并行、恢复需与宿主等价                             |
| `director@3`      | 3D 预演台 | A2 读写；A4 `manual-publish` | 无               | Agent 只能准备输入/请求发布，不能绕过人工发布                          |
| `agent@1`         | Agent     | A2 读写；A3 专用 Flow 协议   | 专用协议         | 使用任务、租约、最小输入、固定结果与恢复，不作为普通 target            |
| `state-machine@1` | 状态机    | A2 读写；确定性执行          | 支持独立执行    | 执行不经网关，事件/条件/迁移由可信宿主裁决；外部接入执行仍按 A2/A3 推进 |
| `ai-review@1`     | AI 审核   | A2 读写；A3 专用审核协议     | 专用协议         | 固定资产/规则/报告；质量拒绝不等于技术失败                             |

当前 Flow target 共九种：`processor@1`、`image-gen@3`、`image-edit@2`、`video@7`、`speech@4`、`tts@4`、`image-crop@2`、`image-split@3`、`code@3`（限单参数单输出形态），其输入和输出由 [video-adapter.ts](../../src/shared/agent-flow/video-adapter.ts) 固定，裁剪/拆图配置在命令准入处校验。接入 A3 必须先复用或抽取同等的输入固定、内容哈希、配置限制、占用、命令去重与修订检查，不能把这九个 target 的存在解释为所有节点已经“Agent 可调度”。

`script`、`video-audio`、`vocal-separate`、`group`、`compose` 是历史兼容类型：只能通过通用的历史项目读取和受控迁移保留；新建、重写和新执行入口均不开放。它们不计入 31 个 Active 节点覆盖率分母，但其读取迁移应有独立兼容测试。

## 4. transport 与工具目录

首发优先采用 stdio MCP 和同一 Node 包内的 CLI。二者共用 operation service、Zod/JSON Schema、错误码、日志上下文与测试夹具；CLI 不绕过 MCP/service 直接读取数据目录。MCP 使用有输入/输出 Schema 的工具结果；其 JSON-RPC/stdout 分帧要求与取消语义见 [MCP stdio 规范](https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/stdio)，工具 schema/结构化结果见 [MCP Tools 规范](https://modelcontextprotocol.io/specification/2026-07-28/server/tools)。

建议首发工具按低风险、可组合粒度组织：

| MCP 工具 / CLI 子命令                                                         | 对应 operation                     | 首发          | 说明                                     |
| ----------------------------------------------------------------------------- | ---------------------------------- | ------------- | ---------------------------------------- |
| `canvas.projects.list/get/open/create/save/update/rename/clone/delete/export` | `project.*`                        | A1            | 删除有单独 impact 确认与占用拒绝         |
| `canvas.graph.get/validate/patch`                                             | `graph.*`                          | A1–A2         | A1 只读，A2 增加受控原子写               |
| `canvas.nodes.type-list/get/create/update/delete/execute`                     | `node.*`                           | A2–A3         | 每个参数指向 portId/nodeId，不以标题猜测 |
| `canvas.edges.create/delete`                                                  | `edge.*`                           | A2            | 显式关系类型并运行连线矩阵校验           |
| `canvas.runs.get/cancel/reconcile`                                            | `run.*`                            | A1/A3         | 查询与取消分开，取消不承诺远端必定取消   |
| `canvas.diagnostics.summary/export`                                           | `diagnostics.*`                    | A1            | 仅安全诊断包                             |
| `canvas.outputs.*` / `canvas.flows.*` / `canvas.reviews.*`                    | `output.*` / `flow.*` / `review.*` | A2基础输出/A3 | Flow与审核只开放已验收协议               |

本地 HTTP 不是首发前提。若 A4 确有多进程或非 MCP 客户端需求，可分别评估 REST API 与 MCP Streamable HTTP；二者不是同一协议，不能互相替代。MCP Streamable HTTP 仅绑定 `127.0.0.1`、验证 `Origin`、使用每次启动随机令牌和显式关闭开关，且不将令牌写入 CLI 参数、日志或诊断包。该要求与 [MCP Streamable HTTP 安全要求](https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/streamable-http) 一致。

## 5. 每次功能变更的同步维护门禁

任何功能变更在设计开始时必须回答：“它是否改变了本文件矩阵中某项的输入、输出、状态、失败语义、保存格式、可用性或安全边界？”答案为“是”时，同一变更不得绕过下列动作：

1. 更新本矩阵对应行的版本、状态、范围或明确的排除原因；新增功能先登记 operation/node 行，再写实现。
2. 更新 operation schema、MCP tool/CLI help、错误码和版本兼容策略；破坏性变更提升 schema/协议版本，旧版本保留明确迁移/拒绝语义。
3. 节点变化同步检查 `ActiveNodeTypeId`、`NodeTypeSpec`、`contractVersion`、端口/Schema、`projectOutputs`、运行/持久化测试，以及本表该节点的执行适配状态。节点契约仍以 [NODE_CONTRACT_SPEC.md](../../NODE_CONTRACT_SPEC.md) 为准。
4. 运行涉及行的适配器 schema、操作幂等、并发修订、成功/失败/取消/unknown、保存重开、结果版本与桌面同源性测试。媒体或模型操作还要验证固定输入、远端未知不重放、产物入库和导出。
5. 完成 [日志检查模板](../templates/LOGGING_CHANGE_TEMPLATE.md)，更新 [日志覆盖清单](../LOGGING_COVERAGE.md)。适配层只记录外部操作的受理/拒绝与关联 ID；业务层拥有唯一终态，repo、执行器和网关已有终态不重复记录。日志不得含密钥、提示词、回复、文件正文、完整路径、签名 URL、原始请求/响应。
6. CI 增加并执行“注册表/矩阵同步”检查：Active 节点集合、operation 目录、MCP/CLI 暴露集合和测试夹具必须一致；未登记节点或已删除的 operation 使门禁失败。仍须运行适用的 `npm run test:contract`、日志门禁及 `npm run verify`。

变更说明必须列出：矩阵影响、外部接口状态、日志覆盖、验证证据和未覆盖边界。纯样式或文案变更可以写“不涉及”，但应写明没有改变执行、网络、文件、数据库或错误路径。

## 6. A1–A4 验收包

| 阶段 | 必须验证的用户路径                                                                                       | 必须验证的失败/安全路径                                                                      |
| ---- | -------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| A1   | Agent 列项目 → 新建 → 打开语义 DTO → 更新元数据 → 保存重开 → 导出；诊断包可查到安全关联                  | 重试不重复创建；版本冲突；导出失败清理临时文件；API Key/未授权路径不进入结果，正文不进入诊断 |
| A2   | Agent 枚举 31 节点 → 读取每个契约 → 创建/更新/连线/保存重开；确定性节点产生可连接结果                    | 非 Active/legacy 新建拒绝；schema/基数/exclusiveGroup 拒绝；不合法边零部分提交               |
| A3   | 对已适配模型节点提交固定输入 → `accepted` → 查询 → 成果资产/端口投影 → 项目重开；审核/任务沿既有协议继续 | 取消、供应商超时、unknown、命令冲突、语义修订冲突、重复 operationId；不会重放副作用          |
| A4   | 导演台人工发布、代码 sandbox、循环恢复及可选 HTTP 分别完成专项路径                                       | 删除确认失效、sandbox 越权、网络越权、localhost Origin/令牌/DNS rebinding 防护               |

对 A3/A4 的真实桌面验收必须使用隔离数据目录和有标识测试窗口，并在退出后清理；不得把单元测试数量写成“所有外部 Agent 已支持”。当前已有命令账本、流控、恢复和桌面测试位于 [flow-commands.ipc.ts](../../src/main/ipc/flow-commands.ipc.ts)、[command-ledger.ts](../../src/main/agent-flow/command-ledger.ts) 与 `test/agent-flow-*.test.ts`；对外适配器还必须增加与手动/桌面同源行为的 parity 测试。

## 7. 源码与规范依据

- Active/legacy 节点清单：[src/shared/types/index.ts](../../src/shared/types/index.ts)
- 节点注册与契约：[nodes/specs](../../src/renderer/src/nodes/specs/index.tsx)、[node registry](../../src/renderer/src/nodes/registry.tsx)、[NODE_CONTRACT_SPEC.md](../../NODE_CONTRACT_SPEC.md)
- 共享执行上下文：[executor-types.ts](../../src/shared/engine/executor-types.ts)
- 项目 IPC 与 repository：[project.ipc.ts](../../src/main/ipc/project.ipc.ts)、[projects.repo.ts](../../src/main/store/projects.repo.ts)
- 导出与导入事务：[transfer.ts](../../src/main/store/transfer.ts)
- 资源库 IPC 与 repository：[library.ipc.ts](../../src/main/ipc/library.ipc.ts)、[library.repo.ts](../../src/main/store/library.repo.ts)
- 原生 Agent Flow 边界：[节点协同规范](../canvas-agent-flow/05-node-coordination-standard.md)、[命令模式](../../src/shared/agent-flow/commands.ts)、[Flow target 适配](../../src/shared/agent-flow/video-adapter.ts)
- 诊断与脱敏：[LOGGING_SPEC.md](../../LOGGING_SPEC.md)、[日志覆盖清单](../LOGGING_COVERAGE.md)
