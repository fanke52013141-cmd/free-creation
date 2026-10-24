# 本地外部 Agent 接入规范（评审草案 v0.1）

日期：2026-10-24。适用：Canvas Studio 本地单用户 Electron 软件。

A1.1接续：项目打开、名称更新及活动画布保存/导出采用桌面握手，最新实际实现/验证见[接续台账](docs/local-agent-access/06-a1-1-desktop-projects.md)。本规范的未实施历史描述不能替代该台账。

**本文件规定完整设计目标，不代表全部接口、门禁或节点适配已经实现。** 按 [实施计划](docs/local-agent-access/04-implementation-plan.md) 逐包交付，真实状态以交付台账为准；不得直接恢复旧 CLI/MCP/headless 代码。

2026-10-24 接续：用户已授权先实现A0+A1最小纵向包；[实际交付与使用边界](docs/local-agent-access/05-a0-a1-minimal-delivery.md)优先于本文件历史现状描述。本规范仍是完整目标，不能将最小包等同全部A0/A1或全部节点支持。

“必须 / 禁止”为方案生效后的强制要求；“建议”为可调整的实现选择。人工审查要求与自动检查的实际落地状态必须分开报告。

## 1. 目标、范围与名词

目标是让本机 Agent 能可靠地查询项目、创建和修改画布、连接和执行节点、读取正式成果、管理项目并导出项目；功能变化时，同步修改接入契约、能力声明、测试和文档。

外部 Agent 是通过 MCP、CLI 或本地 API 调用软件的客户端；画布中的 `agent` 节点是软件内的业务节点。两者共用画布和业务事实，但不是同一个入口，也不能互相冒充人工操作。

本期纳入：

- 项目查询、新建、打开、修改、重命名、复制、删除、保存和导出。
- 全部 31 个 Active 节点的能力发现，以及适用的创建、读取、配置、连接、结果查询和执行。
- 本地素材引用、资源库检索和管理、产物导出、执行任务查询与诊断。
- 已有画布 Agent Flow 的受控启动、观察、停止、核对和适用的继续操作。

本期排除：项目包导入。MCP、CLI、HTTP、批量命令、模板入口都不得提供可绕过此排除的项目导入能力。受控登记单个媒体文件不属于项目包导入。资源库资产包导入不是本期必要交付项，可另行排期。

“项目修改”分为三层：`project.update` 修改声明元数据，`graph.patch / node.update` 修改画布内容，`project.save` 请求权威宿主提交并确认持久版本。保存接口不接收客户端整份快照。`project.get` 是只读查询，`project.open` 改变宿主驻留/呈现状态，须处理当前项目未保存修改和占用。

不建设登录、团队、租户、云端项目或第二套任务工作台。本地连接凭据和调用范围只保护本机入口，不构成多用户权限产品。

## 2. 已核对的工程基础

| 事实                                                           | 源码依据                                                                                                                                                  | 对方案的约束                                         |
| -------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------- |
| 31 个 Active 类型已登记                                        | [共享类型](src/shared/types/index.ts)、[节点 Spec](src/renderer/src/nodes/specs/index.tsx)、[Agent Flow Spec](src/renderer/src/nodes/specs/agentFlow.tsx) | 清单必须逐个覆盖，不能只写“所有节点”                 |
| 已有节点契约、共享 executor、各类型输出投影                    | [节点规范](NODE_CONTRACT_SPEC.md)、[执行上下文](src/shared/engine/executor-types.ts)、[执行器表](src/shared/engine/executors/index.ts)                    | 外部调用必须复用契约与输出投影                       |
| 项目操作已有 main IPC/repo，导出 IPC 带文件对话框              | [项目 IPC](src/main/ipc/project.ipc.ts)、[项目仓库](src/main/store/projects.repo.ts)、[传输实现](src/main/store/transfer.ts)                              | 抽出公共业务入口，交互式对话框由 UI 适配器处理       |
| 内部 Flow 命令已有账本、租约、语义修订及 unknown 恢复          | [命令契约](src/shared/agent-flow/commands.ts)、[命令账本](src/main/agent-flow/command-ledger.ts)、[桌面桥](src/main/ipc/flow-commands.ipc.ts)             | 扩展准入，不绕过账本或假造回执                       |
| 普通执行仍依赖桌面运行宿主，main 账本不是通用节点运行器        | [桌面桥](src/main/ipc/flow-commands.ipc.ts)、[命令账本](src/main/agent-flow/command-ledger.ts)                                                            | 首版要求应用和执行宿主可用，不声称纯 headless        |
| 内部普通 target adapter 仅覆盖 6 类，另有 Agent/审核专用协议   | [目标适配器](src/shared/agent-flow/video-adapter.ts)、[协同规范](docs/canvas-agent-flow/05-node-coordination-standard.md)                                 | 有 executor 不等于可被 Agent 自动协调                |
| 旧外部接口已撤下，曾发生配置、输出、正文、取消和多路输入不一致 | [历史审查 F05–F09](docs/HANDOFF_2026_09_15_CODE_REVIEW.md)                                                                                                | 历史代码不作恢复基线，必须有桌面与外部入口一致性验收 |

部分旧文档开头的“尚未实现”和源码中的 headless 注释早于后续实现，不能作为当前支持状态的唯一证据。当前内部交付证据参见 [开发台账](docs/canvas-agent-flow/08-development-ledger.md) 和 [后续完成计划](docs/canvas-agent-flow/38-agent-completion-plan.md)。本轮做了静态调查，没有重新运行这些历史验收。

## 3. 总体架构：一份业务契约，多个薄入口

```text
外部 Agent / 本地脚本
    ├─ MCP stdio 适配器 ─┐
    ├─ CLI JSON 适配器 ──┼─ 本地连接边界 ─ 统一 Operation Registry / Dispatcher
    └─ 可选 HTTP API ────┘                         │
桌面 UI ─ 现有 IPC 适配器 ────────────────────────┤
                                               ├─ 项目 / 资源库 / 导出公共服务
                                               ├─ 画布图操作服务
                                               └─ 执行准入 / 命令账本 / 任务服务
                                                         │
                                               现有桌面执行宿主
                                                         │
                                               公共 executor / 网关 / 输出投影
                                                         │
                                               正式结果 / 固定资产 / 项目保存
```

以上是目标架构。统一 Registry、外部 Dispatcher 和本地传输层均待实现。迁移按受影响模块进行，不要求一次重写全部 UI；已迁移的操作必须由 UI 与外部入口调用同一业务规则和提交边界。

### 3.1 业务与存储的拥有者

1. main 是项目文件、数据库、媒体、业务命令账本和访问边界的唯一拥有者。
2. 画布语义图是唯一可编辑流程定义。外部读取可生成 DTO，但 DTO 不是另一套可独立写回的拓扑。
3. 图修改通过受控命令完成；禁止外部客户端直接修改 `project.json`、SQLite、tldraw 原始快照或任意 `meta`。
4. 节点执行仍通过正式准入、桌面执行宿主、公共 executor、`projectOutputs` 和产物提交路径。禁止另建外部专用 switch/运行器。
5. 项目 CRUD、资源库和传输复用 main 服务；IPC handler 中的业务、对话框与日志职责需要拆清，不能在新适配器中复制一份。
6. 无内部 Agent 任务的普通外部节点执行需要新增受控调用主体，映射到现有命令权威；不得伪造 `agentNodeId/taskId`，也不得绕过现有任务占用和审核门禁。此扩展必须独立验收。

### 3.2 桌面驻留与本地连接

- 首版以应用正在运行、对应项目运行宿主可用为前提。未运行返回 `APP_NOT_RUNNING`；宿主未就绪返回 `HOST_NOT_READY`，不能由适配器自行接管执行。
- CLI 可提供显式启动选项，启动同一安装版本的应用，再等待就绪；默认不因为一次查询隐式打开项目窗口。后台驻留模式在独立验收之前不列为支持。
- 每个项目同一时刻只有一个图写入/执行拥有者；切换、关闭、重载项目必须与命令占用协调。运行中的项目不能被另一客户端悄悄替换。
- Windows 优先建议本机命名管道连接 CLI/MCP 代理与应用；其他平台采用等价的本机 socket。实施阶段核验打包与账户隔离能力后锁定。IPC framing 与凭据验证属于内部连接协议，不等于直接对外暴露 Electron IPC。
- 连接必须绑定 `instanceId/dataStoreId/appVersion`。存在多个隔离实例时要求显式选择；不能默认连接“最近打开的项目库”。
- 客户端退出只关闭客户端连接；不得顺带终止用户的软件。应用关闭时，已受理业务任务按账本处理，不能将断线伪装成取消或成功。

### 3.3 三种入口的顺序

| 入口          | 定位                       | 建议交付顺序               | 要求                                                               |
| ------------- | -------------------------- | -------------------------- | ------------------------------------------------------------------ |
| MCP stdio     | 本机 Agent 发现和调用能力  | A1 与 CLI 共用首条用户路径 | 标准 SDK；stdout 只写 MCP 消息；不承载业务实现                     |
| CLI           | 本机脚本、调试、可重复验收 | A1                         | JSON 输出、稳定退出码、文件/stdin 输入、可等待任务                 |
| 本地 HTTP API | 需要 HTTP 的本机工具       | A4 可选                    | 仅 loopback、随机凭据、来源/Host 校验、请求限额；复用相同 Registry |

API 首先指稳定的应用操作契约，不要求第一阶段就开放 HTTP 监听。MCP 的 Streamable HTTP 与应用 REST API 是不同协议，只有明确需要时才增加对应适配器，不能混用。

MCP 协议版本和 SDK 必须锁定并建立客户端兼容表。2026-10-24 核对的官方当前版本为 `2026-07-28`；旧版 `2025-11-25` 及更早版本存在不同连接/握手语义。是否提供兼容层由实际目标客户端验证决定，不能仅安装“最新 SDK”就宣称兼容。官方依据见 §11。

## 4. 统一操作与节点能力声明

### 4.1 OperationSpec（待实现的数据结构）

每个对外操作必须注册唯一声明，至少包含：

| 字段                             | 语义                                               |
| -------------------------------- | -------------------------------------------------- |
| `operationId / operationVersion` | 稳定业务 ID 与独立接口版本，如 `project.export@1`  |
| `inputSchema / outputSchema`     | 严格输入、输出 Schema；拒绝未声明字段和原型污染键  |
| `handler`                        | 指向唯一公共业务实现；适配器不得注册另一份同名业务 |
| `effect`                         | read / write / execute / export / destructive      |
| `preconditions`                  | 宿主、项目、版本、模型能力、审核和占用要求         |
| `idempotency / concurrency`      | 幂等边界、作用域、写范围及冲突处理                 |
| `executionMode`                  | 同步或持久任务；可取消、可核对、可恢复的实际能力   |
| `resultPolicy`                   | 正式结果类型、内容分页、媒体引用与落盘确认         |
| `diagnostics`                    | 入口事件、业务生命周期拥有者、关联字段、脱敏分类   |
| `exposure`                       | UI/CLI/MCP/HTTP 是否开放及未开放原因               |
| `tests / status / owner`         | 证据、状态、维护模块；不把计划当通过               |

Registry 是 Schema、CLI 参数描述、MCP 工具描述、HTTP 契约与覆盖报告的公共来源。可生成的内容必须生成；节点私有配置不能靠手写多份参数表长期维护。

当前注册表位于 renderer 的 TSX 模块，不能被 main/CLI 直接导入。实施时将纯数据的类型、版本、端口与配置契约抽到 shared，renderer 的 NodeTypeSpec 复用这些契约并补充 UI 呈现；main/外部目录从同一纯数据源生成。禁止为方便接入将 React/Editor/DOM 依赖带入 main，也不能再手抄一份端口。

### 4.2 NodeAccessSpec（对现有 NodeTypeSpec 的补充）

每个 Active 类型必须有一项声明，包含：`typeId`、`contractVersion`、`configSchemaVersion`、正文/配置 Schema、端口契约引用、可编辑字段白名单、支持动作、执行前置条件、能力/模型限制、产物协议、恢复策略、适配状态与测试。

- 端口仍以 NodeTypeSpec 为权威，不再手抄一份 Agent 端口定义。
- `props.config` 在外部使用已校验的类型化对象；公共适配层负责与现有字符串序列化互转。`props.text` 独立保存，不得被配置覆盖或清空。
- 运行事实和 `meta.nodeRun/nodeResult` 仅由可信运行路径写入。客户端不能直接设置 success、回执、固定资产摘要或审核通过。
- 动态端口必须通过对应节点的正式字段定义产生；如代码节点更新字段后，返回受影响连线的预检，不得默默删边。
- 创建、编辑、执行、结果读取分开声明；“可创建”不能推导“可执行”。
- 普通媒体资产节点通过登记/选择固定资产和端口投影使用，不人为新增一次“生成任务”。
- 每一项未支持动作返回稳定原因和后续路径，不得静默无操作。

### 4.3 工具颗粒度

建议保留 `project.*`、`graph.*`、`node.*`、`edge.*`、`run.*`、`output.*`、`media.*`、`library.*`、`model.*`、`diagnostics.*` 命名空间，详见 [覆盖清单](docs/local-agent-access/02-capability-matrix.md)。

MCP 工具名可以将点号映射为下划线；CLI 映射为层级命令。映射由 Registry 生成。禁止提供可调用任意 IPC、任意 SQL、任意 JS、任意 shell 或任意文件路径的通用逃逸工具。若提供 `graph.patch` 批量操作，其 action 必须是有限的已声明 union，整体预检和原子提交，不能是任意对象覆盖。

## 5. 调用、版本与事务协议

### 5.1 统一请求上下文

- 客户端传业务参数、操作版本、`requestId`；写/执行/导出/删除还必须传 `idempotencyKey`。
- 所有项目内操作显式指定 `projectId`；禁止依赖 UI 当前项目隐式决定写入对象。
- 写图操作携带 `expectedGraphVersion`；节点执行/控制操作携带适用的 `expectedSemanticRevision`、契约版本和固定输入引用。两个版本的含义不同，不能互换或统一成一个含糊的 version。
- 服务端生成/验证 trace/span，绑定可信本地连接主体和来源。不能相信客户端自报“人工”“内部管理员”或伪造业务终态。
- `timeoutMs` 仅限制本次等待；业务任务是否取消由单独的取消请求决定。

| 版本/确认字段              | 适用操作                                                                   | 不能替代什么                                                                    |
| -------------------------- | -------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| `expectedGraphVersion`     | graph/node写入、保存、复制、导出源版本；重命名/删除使用仓库权威修订        | 不能替代执行语义修订；元数据若未推进现有graphVersion，须补独立CAS修订并公开含义 |
| `expectedSemanticRevision` | 节点执行、Flow命令准入及语义冲突检查                                       | 不能代替磁盘保存成功，也不能用相机/摆放版本推算                                 |
| `taskWaitRevision`         | 等待选择、resume、人工/AI继续的乐观核对                                    | 不能用最初提交时的项目版本代替                                                  |
| `impactToken`              | 删除等明确破坏性操作，绑定实例、目标ID、源修订、影响摘要、有效期与调用主体 | 不是幂等键，也不是人工授权凭据；真实人工门禁另由可信宿主确认                    |

`project.rename/delete/export` 的具体CAS读取/推进规则必须在A0定义、A1测试；不能因为现有rename函数没有CAS就宣称已支持并发安全。调用方不提供猜测版本，先查询权威修订或操作预检。

### 5.2 统一响应

所有入口返回同一业务 envelope：`apiVersion/requestId/traceId/operationId/status/data/error`；任务另有 `taskId`，写操作另有提交版本和 `saved` 事实。MCP 外层仍遵守其协议结果格式；HTTP 状态码和 CLI 退出码只是映射，不代替业务结果。

建议状态为 `completed/accepted/waiting/blocked/failed/cancelled/unknown`；运行的细节由持久任务状态提供。状态名在实现前与现有状态机明确映射，不为了接口便利改写内部事实。

`waiting/blocked/unknown` 必须带稳定 `stateReason`、有限枚举 `allowedActions`、适用的当前图/语义/等待修订和 `reconcileRequired`。无权限或不适用的动作不能出现在列表中；`HUMAN_REQUIRED` 不因客户端传入 `confirmed=true` 就解除。

失败的 `error` 至少给出稳定 `code`、`phase`、安全摘要、`retryable` 和适用的当前版本。不能以中文文案作为机器协议，不能返回原始异常、请求或供应商响应。

最低错误集合（新规范目标，并非当前已有）：

`APP_NOT_RUNNING / HOST_NOT_READY / INSTANCE_MISMATCH / UNSUPPORTED_OPERATION / UNSUPPORTED_CONTRACT / INVALID_INPUT / NOT_FOUND / REVISION_CONFLICT / RESOURCE_BUSY / IDEMPOTENCY_CONFLICT / IDEMPOTENCY_EXPIRED / MODEL_UNAVAILABLE / HUMAN_REQUIRED / OUTCOME_UNKNOWN / CANCEL_NOT_CONFIRMED / EXPORT_INCOMPLETE / PATH_NOT_ALLOWED`。

现有 Flow 错误码保留可追溯映射，不能吞掉根因。`retryable=true` 只表示满足规定条件后可重试，不能指导 Agent 对有未知副作用的操作直接重发。

### 5.3 幂等与并发

1. 幂等记录必须先于副作用持久化，绑定数据实例、操作、目标项目、规范化意图及操作版本；规范化不得把敏感正文写进诊断日志。
2. 同一 key、同一意图返回原任务/原结果；同一 key、不同意图拒绝。MCP 和 CLI 使用同一 key 时也必须去重。
3. 先预留稳定 projectId/commandId 等业务身份，提交时与业务事实关联。断电后如无法判定是否生效，标记 unknown，不能因记录不完整重建一个新操作。
4. 幂等记录保留期、任务/删除墓碑及过期行为必须在 A0 锁定。默认建议完整回执至少 30 天；过期 key 返回 `IDEMPOTENCY_EXPIRED`，不得静默当新请求；新意图必须使用新 key。
5. 幂等只防重复，不代替 expected revision；写冲突返回当前版本，Agent 重新读取后生成新意图。
6. 图写入与现有 UI 自动保存共用写入协调器，保留尚未保存的用户改动。禁止“外部打开磁盘快照后全量覆盖”在线画布。
7. 批量图修改预检全部 action、Schema、连线及限制后原子提交；任何一项失败不留下半张图。模型调用不属于数据库原子事务，不承诺批量生成可整体回滚。

幂等key需绑定可验证的有效期/服务端操作票据，或保留足够的拒绝元信息；不得在删除完整回执后把旧key重新当新请求。具体保留上限和过期识别机制在A0落地，不承诺无限保存完整结果。

### 5.4 何时算完成

模型接受请求、远端完成、本地下载、媒体入库、输出校验、画布物化和项目保存是不同事实。外部写入成功必须返回实际提交版本；执行成功必须能读取正式结果并说明 `saved` 状态。

如果业务执行完成但项目保存失败，响应保留执行与产物事实，标记保存未完成并提供核对/保存路径；不能建议重新生成，也不能伪装为可安全重试的普通失败。数据库与文件无法同一事务时，使用可核对的分阶段提交和恢复记录。

## 6. 运行、等待、取消与恢复

| 操作族                                                    | 唯一职责与主身份                                                                                |
| --------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `node.execute`                                            | 提交普通节点执行，返回持久业务 `taskId`                                                         |
| `run.get/list/wait/cancel/reconcile`、适用的 `run.resume` | 对已存在的业务 `taskId` 查询/等待/取消/核对/继续；关联内部runId、commandId与upstreamTaskId      |
| `flow.start/get/stop/resume/reconcile`                    | 内部Agent Flow的控制操作，绑定真实主控节点/Flow任务和范围；复用其子任务事实，不新建同义任务账本 |
| `review.get/continue`                                     | 读取审核事实或提交协议允许的AI继续；不替代人工确认                                              |

`runId` 保留现有执行/诊断含义，不能代替 `taskId`。普通运行控制和Flow控制共享状态来源；Flow的停止/继续处理其声明控制范围，不能只取消一个传输等待请求。

- 长操作先持久受理，再返回 `accepted + taskId`；查询/等待/事件读取作为公共能力。MCP 的传输请求 ID、应用 taskId、内部 Flow commandId、供应商 taskId 必须分开关联。
- 查询任务是所有客户端的最低兼容路径；实时事件是可选加速。事件有游标和保留边界，过期后要求重新取快照，不宣称无限回放。
- 客户端断开、CLI 等待超时、MCP 子进程退出，不自动重发或取消已受理业务任务。
- `run.cancel` 先记录取消请求，再核对本地与供应商事实。未确认远端取消时返回真实状态；不得把 cancel requested 当作 cancelled。
- renderer 崩溃、切换项目、命令租约丢失或远端受理结果不明时，保持占用并进入 unknown/blocked；通过 `run.reconcile` 核对原命令，禁止重放未知操作。
- 支持 resume 的任务必须绑定 task/wait revision、固定输入、原命令身份与适用预算；不支持的类型明确拒绝。
- 人工等待包含 `waitingReason`、允许动作和当前修订。外部 Agent 可提供建议或执行已授权的 AI 继续；需要真实人工确认、审核或导演台发布的步骤不能由 Agent 冒充。
- Agent/状态机/审核采用 [节点协同规范](docs/canvas-agent-flow/05-node-coordination-standard.md)；控制边、状态关系与普通数据边分开。质量拒绝与技术失败不是同一状态。
- 外部 Agent 驱动内部 Agent Flow 时，仅能控制声明范围，避免形成两个不受约束的嵌套调度器；预算、总步数、返工轮次与并发上限仍由可信宿主裁决。

## 7. 节点与产物一致性

任何类型开放执行前，必须验证以下完整路径，而不是仅测调用返回成功：

1. 类型/版本和配置匹配；用户正文未丢失。
2. 输入仅按真实端口收集；many 输入的数量、顺序和固定版本保持。
3. 复用公共 executor、模型能力解析和错误规则。
4. 复用 `projectOutputs` 校验正式输出；独立资产节点和操作节点身份不混写。
5. 媒体生成通过正式产物物化路径，每次运行产生新资产且有溯源，不覆盖原媒体。
6. 保存、关闭、重开后，配置、正文、连线、运行结果与产物仍一致。
7. 取消、超时、失败、未知结果和恢复不产生假成功或重复计费提交。

旧 F05–F09 各建立防回归样例：`config` 不错层、专用输出投影不丢、JSON 正文不清空、取消循环不复用为成功、多输入不只留下最后一项。

本轮逐节点建议与限制见 [31 节点清单](docs/local-agent-access/02-capability-matrix.md)。所有类型首先登记；具体执行开放必须逐个验收，不能通过一个全局 `agentEnabled=true` 批量放行。

## 8. 项目、资源库、媒体与导出

### 8.1 项目修改和复制

- `project.update` 只修改声明的项目元数据；画布正文、节点与连线通过图操作；不允许上传任意项目快照冒充“修改”。
- 复制复用现有仓库的媒体复制/引用重映射与固定资产处理；不继承原项目的运行租约、未完成业务任务或审批权威。
- 导出、复制前固定来源版本。在线项目须先协调保存；有未保存改动或占用时返回明确冲突/等待，不悄悄导出旧磁盘版本。
- 删除先检查目标、关联范围、未完成任务和版本。首版可复用现有硬删除，但调用必须显式携带目标确认与 impact token/等价机制，并拒绝运行中或未知结果占用的项目。不是给每次普通编辑增加人工确认。
- 当前没有可据实宣称的回收站；是否另做软删除属于独立产品变更。删除成功后重复同一幂等请求返回原回执，不能误删同名新项目。

### 8.2 导出协议

`project.export` 必须是无需文件对话框的公共业务操作。桌面端保留文件选择器；Agent 传本次明确目标或预配置导出目录，服务端进行路径规范化、根目录与符号链接/联接点检查、重名处理和写入预检。

必须固定源版本，在自身临时文件写完、完整性检查和最终提交后才返回完成，附格式版本、源修订、文件引用、字节数、摘要和媒体完整性。默认缺失媒体拒绝完成；只有明确 `allowIncomplete` 才允许部分包，并返回缺失清单与不完整标识。

复用现有项目包格式和凭据剥离，不默认打包日志、应用设置或供应商密钥。包中允许携带可重开的声明配置与固定成果，不携带本机执行授权或可重放的活跃任务权威。失败仅清理自己创建的临时文件，不覆盖现有文件或清理用户目录。

### 8.3 资源与结果

- 资源库优先开放检索、详情、版本、采集/发布、分类/集合管理、引用与导出；归档/删除采用显式范围和引用检查。
- 媒体登记校验允许根目录、类型、体积与实际文件；返回项目受控 mediaId，不能将任意绝对路径注入节点。
- 结果接口默认返回摘要、端口、Schema、固定资产/媒体引用及分页信息。正文是显式读取的数据，不能进入日志；大媒体按文件引用或受控读取输出，避免 base64 撑满 Agent 上下文。
- 不开放密钥读取、任意模型配置写入和任意文件系统浏览。模型查询仅返回去敏的本地连接身份、能力、参数限制和可用状态。

## 9. 日志、故障与本地入口保护

遵循 [LOGGING_SPEC.md](LOGGING_SPEC.md)，每个新增操作做 [日志检查](docs/templates/LOGGING_CHANGE_TEMPLATE.md)，并更新 [覆盖清单](docs/LOGGING_COVERAGE.md)。

- 外部入口记录安全的受理/拒绝和关联，业务层负责唯一业务终态；不能让 MCP、CLI、IPC、executor 各写一遍同一终态。
- 关联 `source/clientId/requestId/operationId/idempotencyReference/traceId` 与已有 project/run/nodeExecution/command/task ID；新增字段先登记允许列表。幂等原文和调用正文不写日志。
- 失败能定位连接、校验、准入、执行、供应商、下载、媒体落盘、输出、保存、导出阶段；依赖已有阶段的明确引用，不制造不存在的 SDK。
- 不记录 API key、连接凭据、提示词、回复、代码正文、原始 stdout/stderr、签名 URL 或私有绝对路径。CLI/MCP 协议响应含用户主动读取的业务数据，不等同诊断日志；诊断路径仍严格脱敏。
- 日志写入失败不改变业务结果；幂等/命令账本写入失败则不得开始有副作用的操作，两者不能混淆。
- 入口只允许本机连接；凭据自动生成、受本机账户保护、可撤销，不放在命令行参数、项目包或日志中。本地 HTTP 若启用需校验凭据、Origin/Host、Content-Type、请求体和并发上限，禁止通配 CORS。
- 对 schema、路径、operation、节点字段和返回体设上限；工作内容及错误文本均视为数据，不可被客户端解释为新的系统指令。

## 10. 同步维护与发布门禁

每次功能新增、修改、删除或故障修复，都必须判断 Agent 接入影响；受影响功能在同一次变更中同步更新公共契约、暴露面、兼容策略、测试、覆盖状态与文档。仅改 UI 外观且不改变业务的，可注明“不涉及”，但不能省略影响判断。

新增节点缺失 NodeAccessSpec、既有操作修改未更新声明、破坏兼容但未升版本、声明支持而无适配/证据、生成产物过期，均属于阻断项。文档勾选不代替自动门禁；静态检查也不代替运行验收。

可执行检查设计、例外处理、建议写入 AGENTS.md 的条款见 [同步维护规范](docs/local-agent-access/03-change-enforcement.md)；逐包用户路径和验收见 [实施计划](docs/local-agent-access/04-implementation-plan.md)；变更记录使用 [接入检查模板](docs/templates/AGENT_ACCESS_CHANGE_TEMPLATE.md)。

## 11. 外部协议资料与核验范围

2026-10-24 阅读的官方资料：

- [MCP 协议版本](https://modelcontextprotocol.io/specification/versioning)：当前版本与旧协议兼容边界。
- [MCP 传输概览](https://modelcontextprotocol.io/specification/2026-07-28/basic/transports)：stdio 与 Streamable HTTP。
- [MCP stdio](https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/stdio)：消息 framing、stdout 与子进程生命周期。
- [MCP Streamable HTTP](https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/streamable-http)：本地绑定、来源验证及新旧传输差异。
- [MCP Tools](https://modelcontextprotocol.io/specification/2026-07-28/server/tools)：输入/输出 Schema 与结构化结果。

MCP 传输文档只约束协议请求，不承诺应用业务的“恰好执行一次”。断线后的业务是否已执行由本项目持久账本核对，不能因协议允许重试而自动重发计费任务。

最初规范编写的日志影响不涉及；后续最小包已改变本地调用、文件/数据库和诊断路径，适用的日志覆盖、验证及未支持边界见[交付台账](docs/local-agent-access/05-a0-a1-minimal-delivery.md)。
