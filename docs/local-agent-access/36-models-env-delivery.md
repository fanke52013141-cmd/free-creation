# F9（二）交付：模型目录与环境读取外部接入（6 项只读）

日期：2026-11-08。范围：GUI「模型设置」与「环境」两页的**读取**类动作开放给外部入口。
基线：86 项外部操作 / 157 项接入测试 / 45 项真实桌面里程碑（第三轮交接）。
结论：**本包新增 6 项外部操作，全部 `effect=read`，三入口同一实现；本包不产生任何供应商请求，
语音克隆/音色设计/视频生成三类只做代码层接通，不做真实调用或产出测试。**
不新增数据库迁移、不新增桌面握手动作、不新增日志事件类型、不新增外部专用执行器。

新增登记：`model.connection.list`、`model.definition.list`、`model.binding.list`、`model.binding.resolve`、
`environment.local`、`environment.videoEngine.status`。

---

## 1. 逐项状态（GUI / CLI / MCP）

CLI 与 MCP 由同一 Registry 自动派生（`operationId` 按 `.` 分段 → CLI 子命令；
`.`→`_` → MCP 工具名），因此三项状态一致；`test/local-agent-parity.test.ts` 已验证本包 6 个操作的
CLI 令牌合法、MCP 名唯一且不与保留命令冲突。

| 外部操作 | GUI 入口（同一业务动作） | 公共实现（复用现有 main 服务） | CLI | MCP | 效果 |
| --- | --- | --- | --- | --- | --- |
| `model.connection.list` | 模型设置 · 连接列表（`ipc.models.connections`） | `SqliteModelHost.listConnections()` + 字段白名单投影 | `model connection list` | `model_connection_list` | read |
| `model.definition.list` | 模型设置 · 模型定义列表（`ipc.models.definitions`，可按连接过滤） | `SqliteModelHost.listModels(connectionId)` + 投影 | `model definition list` | `model_definition_list` | read |
| `model.binding.list` | 模型设置 · 默认功能绑定（`ipc.models.bindings`） | `SqliteModelHost.listBindings()` + 投影 | `model binding list` | `model_binding_list` | read |
| `model.binding.resolve` | 节点模型解析（`ipc.models.resolveBinding`，节点执行与设置页共用） | `ModelRuntime.resolveForExecution()`（GUI 同一解析服务，含验证/适配器/密钥存在性检查） | `model binding resolve` | `model_binding_resolve` | read |
| `environment.local` | 媒体执行前置 · 本机能力（`ipc.media.localCapabilities`）+ 配音节点 · 本地 IndexTTS 检测（`ipc.media.indexttsDetect`） | `getLocalMediaCapabilities()` + `getVideoEngineStatus()` 摘要 + `detectIndexTts()` 粗粒度投影 | `environment local` | `environment_local` | read |
| `environment.videoEngine.status` | 环境状态 · 视频引擎（`ipc.media.videoEngineStatus`） | `getVideoEngineStatus()` | `environment videoEngine status` | `environment_videoEngine_status` | read |

补充说明：

- 两个环境操作的输入都是空对象（`empty.strict()`），**没有项目作用域**；附带 `projectId` 会按未知字段
  被拒绝（`INVALID_INPUT`），不会被静默忽略。
- `model.binding.resolve` 的 `modelKey`（形如 `provider::model`，`provider` 即模型连接 id）与 GUI 节点配置
  里显式选择模型时的 `modelKey` 同格式；解析优先级也与 GUI 执行器一致：**显式目标优先，其次默认功能绑定**。
  响应里的 `resolvedFrom` 如实标注本次用了哪条路径。

## 2. 去敏口径：字段白名单，不是黑名单

原则：**只有明确列出的字段会出现在响应里**。新增字段必须同时改输出 Schema、测试与本文档，
否则默认不对外。这样避免"以后给连接加个字段，顺手就泄漏了"。

### 2.1 连接（最敏感）

`model.connection.list` 只返回：

| 字段 | 说明 |
| --- | --- |
| `id` | 连接 id（GUI 生成 UUID 形态） |
| `name` | 连接显示名（用户可改，GUI 列表同款） |
| `protocol` | 协议枚举（`openai`/`openai-compatible`/`vidu-cli`…，即供应商类型标识） |
| `enabled` | 启用状态 |
| `createdAt` / `updatedAt` | 记录时间（ISO 字符串） |

**不返回**：`baseUrl`（可能带内部域名或查询串凭据）、`headers`（可能含 `Authorization`）、`auth`、
`metadata`（任意 JSON）、`secret_ref`（密钥引用/密文）、任何密钥明文。它们只存在于 main 进程的
`SqliteModelHost` 内部；外部投影在 `settings-ops.listConnections` 里逐字段构造。

### 2.2 模型定义

`model.definition.list` 返回：`id`、`connectionId`、`modelId`（上游模型 ID）、`name`、`enabled`、
`connectionEnabled`（连接是否启用，GUI 同款提示）、`capabilities`（仅 `operation`/`asynchronous`/
`streaming`/`acceptedAssetKinds`/`producedAssetKinds`）、`validation`（仅 `operation`/`status`/
`checkedAt`/`verifiedAt`）、`agentToolCalling`（仅 `status`/`checkedAt`/`verifiedAt`）、
`capabilitiesTruncated`。

**不返回**：能力 `controls`（任意执行参数）、定义 `metadata`、验证 `message`（可能是供应商原始响应
或探测原文）。`modelId` 是上游模型标识，不是地址或凭据。

过滤：`connectionId` 可选；未知连接 id 返回空页（`listModels(connectionId)` 与 GUI 一致），不伪造错误。
分页为 `offset/limit`（`limit` 1–100），响应带 `total`。

### 2.3 功能绑定

`model.binding.list` 返回 `featureKey`、`modelDefinitionId`、`connectionId`、`modelId`、`operation`、
`enabled`、`updatedAt`。**不返回** `overrides`（功能级执行参数，可能是任意 JSON）。
只列已启用绑定（与 `SqliteModelHost.listBindings()` 语义一致——GUI「模型设置」也只展示生效绑定）。

### 2.4 绑定解析

`model.binding.resolve` 输出（逐字段构造，**不整体展开** runtime 结果）：

```
{ featureKey, providerId, modelId, operation, modelKey, resolvedFrom }
```

`ResolvedModelTarget` 里还有 `connection`（地址/头/元数据）与 `secret`，响应构造处刻意只取
`target.connectionId`/`target.modelId`/`operation`，避免以后加字段时变成泄漏点。密钥只在解析函数
局部用于"是否可用"的存在性检查（与 GUI `models:bindings:resolve` 完全相同），不进入响应、事件或日志。

失败语义（稳定码，全部 `failed`，不伪造成功）：

| 情况 | 错误码 |
| --- | --- |
| 功能未绑定 / 绑定已停用 | `MODEL_BINDING_NOT_FOUND` |
| 绑定目标能力与请求 `operation` 不一致 | `MODEL_OPERATION_MISMATCH` |
| 显式 `provider::model` 在目录里不存在 | `MODEL_TARGET_NOT_FOUND` |
| 绑定/目标未通过验证 | `MODEL_NOT_VERIFIED` |
| 连接停用、缺适配器或缺可用密钥 | `MODEL_NOT_CONFIGURED` |
| `modelKey` 不是 `provider::model` 形态 | `INVALID_INPUT` |

`detail` 只带稳定阶段标记（如 `model-resolve:feature-binding`），**不带** `ModelRuntimeError.message`
（该文案可能包含供应商验证原文）。

检查集与 GUI 完全一致（连接启用、能力已验证、协议适配器已注册、密钥存在）；本操作**不额外**增加
"模型定义 enabled=false 就拒绝"之类 GUI 解析服务没有的私有规则——否则会出现"GUI 能解析、外部解析不了"
的新不一致。定义是否启用经 `model.definition.list.enabled` 如实可查。

### 2.5 环境

- `environment.local`：`ffmpeg`/`ffprobe`/`audioSeparator` 各为 `{available, message}`（与 GUI 提示同源），
  另附 `videoEngine: {pythonAvailable, ready, installing, gpuName?}` 与
  `indexTts: {ready, state}`（`state` ∈ `ready|incomplete|missing`）。
  - 缺媒体依赖时 `available=false` 且 `message` 是 GUI 同款可操作提示（安装/环境变量），
    **不让整个操作失败**。
  - IndexTTS 只给粗粒度状态：GUI 的详情文案里嵌了本机解释器/模型目录的**绝对路径**，
    因此不投影 `pythonPath`/`modelDir`/`reason`（与"输出不含内部路径"同口径）；具体缺哪一项由 GUI 显示。
    `detectIndexTts` 与 GUI 配音节点「重新检测」同一实现、同款不缓存语义；探测只做
    `import indextts` 与有界目录扫描（`SCAN_BUDGET_MS=3.5s`），不加载模型、不做推理。
    测试用引擎自带的环境变量 `CANVAS_STUDIO_INDEXTTS_SCAN_ROOTS` 把扫描根收敛到临时目录。
- `environment.videoEngine.status`：完整 `{pythonAvailable, ready, installing, progress, message, gpuName?}`，
  即 GUI「环境」页显示的同一状态（本地 CUDA 推理环境，video-depth/video-clay 使用）。
- 两项都**只读本地事实**：探测只 spawn 本机工具（`ffmpeg -version`、`py -3.12 --version`、
  `python -c "import indextts"`）与读取本地就绪文件；不下载、不安装、不联网、不做模型推理。
  视频引擎安装（`media:video-engine-install`）未开放。
- 两项分开而不是合并成一个"本机状态"的原因：GUI 本身就是两个独立面板项，且 `videoEngine.status`
  在安装/修复后需要独立刷新；合并会让"环境就绪"变成两套判断口径。
- 探测实现自身异常时返回稳定错误码 `ENVIRONMENT_PROBE_FAILED`，不回传原始异常文本。

## 3. 真实验证证据

### 3.1 定向测试（新增 `test/local-agent-models-env-access.test.ts`，12 项全绿）

覆盖：

1. 空库：三个列表均返回空数组、`total=0`、`reachability='not-probed'`，结构稳定；
2. 连接列表字段白名单：断言响应 JSON 与事件里**不含**地址、查询串 token、`Authorization` 头、
   metadata 私密值、假密钥明文 `sk-FAKE-SECRET-MARKER-123`、以及 `Authorization` 字样；
3. 定义列表：按 `connectionId` 过滤、未知连接空页、`connectionEnabled` 反映停用连接、
   `capabilities` 不含 `controls`、`validation` 不含 `message`；
4. 绑定列表：只含目标三元组，不含 `overrides`；
5. 解析：未绑定 → `MODEL_BINDING_NOT_FOUND`；已绑定 → 返回
   `{providerId:'conn-fixture-1', modelId:'fixture-model-a', modelKey:'conn-fixture-1::fixture-model-a',
   resolvedFrom:'feature-binding'}` 且响应/事件不含假密钥或地址；显式 `provider::model` →
   `resolvedFrom='explicit-target'`；目标不存在 → `MODEL_TARGET_NOT_FOUND`；
   能力不匹配 → `MODEL_OPERATION_MISMATCH`；已绑定但无密钥 → `MODEL_NOT_CONFIGURED`；
6. 环境：把 `CANVAS_STUDIO_FFMPEG_PATH`/`CANVAS_STUDIO_AUDIO_SEPARATOR_PATH` 指向必然不存在的文件，
   `environment.local` 仍 `completed`，`ffmpeg/ffprobe/audioSeparator.available=false`、
   `videoEngine.ready=false`（全新数据目录）、不声称 installing；`indexTts` 只含 `ready`/`state`
   两个键（白名单），且整个响应不含临时数据目录路径（无本机路径泄漏）；
7. 参数与实例边界：`limit=101`、负 offset、超长 `connectionId`、缺 `operation`、非法 `operation`、
   畸形 `modelKey`、环境操作附 `install`/`download`/`projectId` → 全部 `INVALID_INPUT`；
   跨实例 `dataStoreId` → `INSTANCE_MISMATCH`；
8. **零供应商请求**：对 6 个操作各调用一次，`vi.spyOn(globalThis,'fetch')` 断言 `not.toHaveBeenCalled()`；
9. 事件脱敏：`agent.access.*` 只携带 `operation`/阶段，不含地址、验证原文或假密钥。

### 3.2 本包实际运行结果（真实输出）

```
> npm run typecheck
（typecheck:node / typecheck:web / typecheck:license-protocol / typecheck:issuer 全部通过，退出码 0）

> node scripts/audit-business-actions.cjs
Business action audit passed: 171 IPC channels + 40 canvas actions; external ops 95;
by phase {"external":99,"F8":11,"excluded":23,"F2":5,"F7":6,"F4":7,"F5":19,"F9":36,"F6":3,"F3":2}

> node scripts/run-vitest.cjs run test/local-agent-models-env-access.test.ts \
    test/local-agent-access.test.ts test/local-agent-parity.test.ts --reporter=dot
Test Files  3 passed (3)
     Tests  57 passed (57)
```

说明：57 项 = 本包新增 12 项 + `local-agent-access` 既有 38 项 + `local-agent-parity` 7 项。
（`local-agent-access.test.ts` 里"契约快照过期"门禁用例在 Lead 重新生成 `generated/contracts.json`
后已恢复通过；本包没有改快照文件。）

### 3.3 门禁现状（如实记录）

- `npm run typecheck`：**通过**（退出码 0）。
- `node scripts/audit-business-actions.cjs`：**通过**（171 IPC + 40 画布动作，95 项外部操作；
  本包 6 个 `external` 映射被识别，无 `ORPHAN_EXTERNAL_OP`/`UNKNOWN_EXTERNAL_OP`/`EXTERNAL_WITHOUT_GUI`）。
- `npm run verify:agent-access`：当前红在**聚合产物**——`docs/local-agent-access/change-impact.json`
  的受保护源码哈希落后于本包最后一批编辑（`ops/settings.ts`、`settings-ops.ts`）。
  按分工该文件由 Lead 统一 `check-agent-access.cjs --write --accept-contract-change --reason "..."` 重生成；
  本包未改该文件、未改契约快照。快照本身已由 Lead 重新生成并与当前 registry 一致
  （`check-agent-access.cjs` 的 stale 分支已不再触发）。
- 真实桌面端到端与真实 MCP 客户端逐动作验收未做（与 F9 其余读取类包同口径）；本包证据为服务级
  真实 SQLite + 真实 main 服务（非 mock）+ CLI/MCP 目录派生门禁。

## 4. 明确不开放（原因与后续条件）

| 非公开动作 | 原因 | 后续条件 |
| --- | --- | --- |
| `models.discover`（拉取供应商模型列表） | **会联网**：用已保存密钥请求 `/models`，可能被供应商计费/限流；与本轮"不做真实调用"要求冲突 | 需独立网络验收 + 预算/授权口径，并在 Provider 侧确认零成本 |
| `models.validate` / `validateAgentToolCalling` | **会向供应商发真实请求并计费**（后者是两次结构化工具调用探针）；无预算授权 | F10 付费供应商分组验收（需预算授权） |
| `models.saveConnection` / `saveDefinition` / `deleteDefinition(s)` / `deleteConnection` / `saveBinding` | 受控凭据写入与目录写入需要独立的**凭据与写入契约包**（去敏回执、原子性、删除的引用/绑定级联语义、确认令牌）；不能借模型读取通道顺手开放 | 独立 F9 凭据包：prepare/commit 双段 + 迁移/回滚 + 去敏契约 + 桌面实测 |
| `keys.*`（供应商密钥导入/导出/清单） | 外部不得读写密钥库或导出密文；密钥库设备绑定与授权规则不得被外部入口绕过（AGENT_PARITY_SPEC §6） | 不计划向外部开放；只保留 GUI 受控路径 |
| `license.*`（授权状态/申请/导入/策略） | 授权是发行版边界，外部不得签发、伪造或绕过 | 后续如需"授权状态只读"须单独立项并先定秘密/设备边界 |
| `media.videoEngineInstall`（环境安装） | 会下载模型/创建 Python 环境（数 GB、改变本机状态），属写/安装而非读取 | 若将来开放，必须 prepare/进度/取消/失败补偿协议 |
| `models.discover`（替代路径说明） | 已开放的 `model.definition.list` 只读**本地已保存**定义，`reachability='not-probed'` 如实标注未探测，不能当作"模型发现" | — |

设计理由复述：本包只做"读目录/读状态"，凡是会产生**费用、远端副作用、本机安装或凭据写入**的动作
一律不碰；请求方仍可先用本包读取现状，再让 GUI 或后续凭据包完成写入/验证。

## 5. 日志覆盖与脱敏

- **不新增事件类型**：6 个操作走 dispatch 既有 `agent.access.started/completed/failed`（唯一终态由
  dispatch 拥有，`attributes.operation` + `phase` + 稳定 `code` + trace/span），业务模块不重复记终态。
- 失败只带稳定错误码（`MODEL_BINDING_NOT_FOUND`/`MODEL_NOT_VERIFIED`/…）与阶段标记；**不记录**
  连接名/地址/头、模型展示名、能力 controls、验证 message、假密钥或探测原文。
- `model.binding.resolve` 内部读取密钥做存在性检查会触发既有 `license.guard.skipped`（debug，
  仅开发/测试路径未注入门禁时）——只含 `operation='model.secret.read'`，不含密钥。
- 环境探测 spawn 本机工具的失败只体现在响应 `message`（GUI 同款提示）与 dispatch 失败终态；
  不新增逐工具事件，避免高频噪声。
- 日志写入失败不改变业务结果（`emitGatewayEvent` 已吞异常；dispatch 失败语义不变），
  定向测试覆盖"logger 抛错仍 completed"的既有用例，本包未改该路径。
- 覆盖清单已追加 `docs/LOGGING_COVERAGE.md` 对应小节。

## 6. 下一包建议

1. **F9 凭据/写入包**：`saveConnection`/`saveDefinition`/`delete*`/`saveBinding` 的受控写入契约
   （prepare/commit、去敏回执、级联与确认令牌），这是模型设置"写"侧唯一的正确入口。
2. **F9 诊断读取包**：`diagnostics.query`（并行包已登记）与诊断包导出复用现有诊断服务，
   注意脱敏扫描与包内密钥排除。
3. **F10 验收**：真实 MCP 客户端逐动作、桌面端到端（本包两项环境操作应可直接在真实 Electron 中
   与「环境」页对照），以及付费供应商分组（需预算授权）。
4. 环境依赖真机矩阵（Windows 有/无 FFmpeg、Python 3.12、NVIDIA GPU）在 F10 补齐，本包只保证
   "缺依赖如实报告 unavailable"。
