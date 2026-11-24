---
title: 节点流（composite）规范
status: draft            # draft → review → frozen
version: 0.1
last-verified: 2026-11-24
baseline-commit: aea3987a (main)
owner: Canvas Studio 规范组
supersedes: NODE_CONTRACT_SPEC.md §8.0（该节改为指向本文）
machine-truth: src/shared/composite/*.ts · docs/local-agent-access/generated/contracts.json
---

# 节点流（composite）规范 v0.1（草案）

## 阅读约定

- **【现行】**：已实现并由代码或测试强制执行的条款。修改时必须同包更新实现、测试和本文。
- **【目标】**：本规范要求、但当前实现尚未达到的条款。每条都附带差距编号（对应 `规范体系深度审查报告-20261122.md`）。目标条款未落地前，相关能力不得对外宣称已支持。
- 条款编号 `NF-x.y` 是稳定引用 ID，测试和日志登记可以直接引用。
- 本文**不写任何计数**（如节点数、操作数、错误码数）。计数一律以机器真值为准。
- 冲突处理：本文与 `NODE_CONTRACT_SPEC.md` 冲突时，**单节点契约**以 NODE_CONTRACT 为准，**组合语义**以本文为准；本文与代码冲突时，必须二选一修正，不允许长期保留冲突。

---

## 1. 定位与分层（宪法级）

**NF-1.1【现行】** 节点流是把一组已调通的基础节点（及已发布的节点流），发布成**一个有固定公开契约、可复用、可嵌套的能力单元**。它是工作流模板之外，第二条合法的复合路径。

**NF-1.2【现行】** 节点流内部图是**确定性数据 DAG**：
- 允许：串联、广播并联（一个公开输入映射到多个内部目标）、扇入（多个上游进入 `many` 输入）、嵌套已发布的固定版本节点流、内部使用 `iterate` 循环节点；
- 禁止：内部环（`CYCLE`）、条件分支、由模型决定的路由、隐藏输出、在节点流里另写执行器。

**NF-1.3【现行】** 三层分工固定如下，任何新能力必须先确定落在哪一层：

| 层 | 图性质 | 由谁决定流转 | 典型内容 |
|---|---|---|---|
| 基础节点 | 单一职责 | — | 生图、裁剪、AI 处理、配音 |
| **节点流（本文）** | 确定性数据 DAG | 拓扑序 | 「脚本 → 分镜 → 批量生图」这类可复用加工链 |
| Agent Flow | 控制流图（条件、有界循环、汇合、人工节点） | 声明式路由器（见 AGENT_FLOW_SPEC） | 跨角色、需要人参与、需要审核返工的任务流程 |

**NF-1.4【目标·A1】** 节点流是 Agent Flow 的**一等能力**：一旦发布，就能被上帝 Agent 发现，并在 FlowGraph 中以 `capabilityRef: { kind: 'composite', id, version }` 引用（见 §13）。

---

## 2. 术语

| 术语 | 含义 |
|---|---|
| manifest | 节点流的完整契约快照：公开端口、内部图、端口快照、依赖、执行策略 |
| 草稿（draft） | 可编辑的 manifest，带 `revision` 做乐观并发 |
| 版本（version） | 已发布的不可变 manifest，带 `contentHash`（SHA-256） |
| 实例（instance） | 画布上一个 `composite` 节点，绑定某个固定版本 |
| 公开输入 / 公开输出 | 实例对外端口；实例端口 ID = `in-<公开 id>` / `out-<公开 id>` |
| 内部目标 / 内部来源 | 公开端口映射到的内部节点端口 `{nodeId, portId}` |
| 运行语义版本（runtimeVersion） | 决定输入接入方式和输出收集方式，详见 §7 |

---

## 3. 生命周期

```
草稿(revision) ──validate──▶ 发布(version + contentHash，不可变)
                                  │
                ┌─────────────────┼──────────────────────┐
                ▼                 ▼                      ▼
        画布实例(内嵌/引用)   被其他节点流嵌套引用    headless 执行
                │
          升级预检 → 升级应用
                │
        归档 / 删除（先做引用检查）
```

**NF-3.1【现行】草稿**：保存时可以携带 `expectedRevision`，与当前草稿不一致就返回 `DRAFT_REVISION_CONFLICT`，并保留现有草稿。
- **NF-3.1a【目标】** 外部入口（CLI/MCP）保存草稿时**必须**携带 `expectedRevision`；只有 GUI 的首次创建允许省略（现行允许任何入口省略，等同覆盖保存）。

**NF-3.2【现行】发布**：发布必须通过 §6 的完整校验，失败返回 `PUBLISH_INVALID` 并附带结构化 issues。同一版本号重复发布、内容不同时返回 `VERSION_IMMUTABLE`；版本号必须递增，否则返回 `VERSION_NOT_NEWER`。

**NF-3.3【现行】实例两种形态**：
- 内嵌形态：`props.config` 里内嵌完整 manifest（历史形态）；
- 引用形态：`props.config` 只存 `{capabilityId, version, contentHash}`，宿主从发布仓库解析后缓存到 `meta.compositeManifest`。

**NF-3.3a【目标】** 新建实例一律使用引用形态。内嵌形态只读兼容，规范不再允许新建。引用解析失败（版本被删除或摘要不符）必须报 `COMPOSITE_REF_NOT_RESOLVED`，并指出是哪个 capabilityId@version。

**NF-3.4【现行】删除前引用检查**：删除或归档前必须给出 `CompositeReferenceReport`，包括各项目里的画布实例，以及其他节点流已发布版本里的嵌套引用。
- **NF-3.4a【目标】** 存在嵌套引用的版本**禁止删除**，只能归档。被归档的版本仍能被已绑定的实例和嵌套引用解析。

---

## 4. Manifest 契约

**NF-4.1【现行】** manifest 字段如下（`src/shared/composite/manifest.ts`，zod strict）：

| 字段 | 约束 | 说明 |
|---|---|---|
| `schemaVersion` | 字面量 1 | manifest 结构版本 |
| `runtimeVersion` | 1 \| 2，缺省 1 | 运行语义版本，详见 §7；新发布必须写 2 |
| `capabilityId` | `[a-zA-Z0-9][a-zA-Z0-9._-]*` | 稳定能力 ID，发布后不能改名 |
| `version` | 当前只允许 `N.0` / `N.0.0` | 详见 §11 |
| `name / description / tags` | 展示用 | 不参与语义 |
| `inputs[]` | 见 §5 | 公开输入，每个带 `targets[]`（≥1） |
| `outputs[]` | ≥1，见 §5 | 公开输出，每个带唯一 `source` |
| `graph.nodes[]` | 带 `nodeType`、`contractVersion`、端口快照 `ports[]`、`mediaRefs[]` | 端口快照让发布后的校验不依赖当前注册表 |
| `graph.edges[]` | `{from, to}` | 只允许数据边 |
| `dependencies[]` | `kind: node \| capability \| media \| model` | 详见 §10 |
| `executionPolicy` | timeout、maxDepth、maxExpandedNodes/Edges、waitForInput、requiresManualGate | 详见 §9、§10 |
| `contentHash` | 发布时计算 | 规范化 JSON（键排序、排除自身）的 SHA-256 |

**NF-4.2【现行】** 内部节点 ID 在保存时生成，发布后不能修改；数组下标不能作为长期身份。

**NF-4.3【现行】依赖锁定**：内部图里每一种 `nodeType@contractVersion`，都必须在 `dependencies` 中以 `kind: node` 登记，否则报 `DEPENDENCY_MISSING`。目的是防止注册表升级后，同一版本的节点流静默换用新的节点实现。

**NF-4.4【目标·F3】** 删除自由格式的 `schema` 片段，JSON 端口一律使用 `schemaRef {id, version}`，并且必须命中 `node-schemas` 注册表。过渡期内 `schema` 只能用于 GUI 提示，不参与校验。

---

## 5. 公开边界

**NF-5.1【现行】公开边界自动推导，不提供手动挑选**（2026-11-11、2026-11-13 两次用户裁决）。推导规则见 `boundary.ts`：
1. **输入**：每个**没有内部上游**的源节点只公开一个**主输入**。选择顺序：先必填，再按类型优先级 `text > markdown > json > image > video > audio > file > any`，同级按声明顺序。辅助可选端口不自动公开。
2. 文本源节点公开它的 `in-text`，并以节点正文作为 `defaultValue`。
3. 所有自动公开的输入都标为 `required: true`，这样运行前缺少输入时会弹出补输入，而不是空跑后在下游失败。
4. **输出**：每个**没有内部下游**的汇节点只公开一个**主输出**，类型优先级为 `image > video > audio > file > text > markdown > json`（媒体优先）。中间节点的输出不公开。
5. 端口 ID 冲突时追加 `-2`、`-3`……

**NF-5.2【现行】** 实例端口 ID 固定为 `in-<公开输入 id>` 和 `out-<公开输出 id>`。

**NF-5.3【目标·C-❌2】键约定（三入口必须一致）**：
- 画布连线、`outputPorts`、升级预检、`run.resubmit` 一律使用**带前缀**的实例端口 ID；
- headless 结果里的 `outputs` 对象改为同样带前缀，或者在 Schema 的 description 中写死「outputs 的键 = 裸公开 id」。二选一，冻结前必须确定；建议统一带前缀。

**NF-5.4【目标】** 自动推导不能表达的边界（如需要公开第二个输出），**不能靠手动挑选**，只能通过调整内部图实现，例如增加一个汇集节点。这一条是 NF-5.1 的直接推论，写明是为了防止将来有人绕过推导规则。

---

## 6. 内部图校验（发布门禁）

所有校验都是纯函数（`validateCompositeManifest`），GUI/CLI/MCP/CI 用同一份 manifest 必须得到相同结论。

**NF-6.1【现行】结构**：内部节点 ID 唯一；边引用的节点存在；端口存在且方向为 `out → in`；没有重复边；单值（`one`）输入端口最多一条内部入边（`PORT_CARDINALITY`）；DAG（`CYCLE`）。

**NF-6.2【现行】必填满足**：每个必填内部输入端口，必须满足以下之一：有内部入边；被公开输入绑定；节点契约认可的固定输入（文本节点非空正文满足 `in-text`；带 `mediaRefs` 的资产节点满足媒体输入）。否则报 `REQUIRED_INPUT_UNBOUND`。
- **NF-6.2a【目标·F4】** 媒体固定输入必须**按端口类型匹配** `mediaRefs[].mime`。现行实现是「任意媒体引用满足任意媒体端口」，图片引用也会被当作满足音频必填。

**NF-6.3【现行】公开映射**：公开输入必须映射到存在的输入端口，同一个内部目标不能被两个公开输入占用（`INPUT_DUPLICATE_TARGET`），JSON 公开输入必须有 `schemaRef`；公开输出必须来自存在的输出端口，类型匹配（`OUTPUT_TYPE_MISMATCH`），多值来源不能声明为单值公开输出。

**NF-6.4【目标·F2】端口兼容判定只能有一个函数**：节点流内部边、公开映射、画布连线、FlowGraph 数据边，**必须共用** `portPairCompatible`（connection-matrix 真值表）。现行节点流使用独立的 `portsCompatible`，只允许「同类型或 any」，与画布规则不一致（画布允许 `text↔markdown`、`iteration→json/camera/媒体`）。结果是：在画布上能连通的图，封装成节点流以后会被拒绝。

**NF-6.5【目标·F2】端口类型枚举与 PortType 全集一致**：`COMPOSITE_PORT_TYPES` 必须包含 `iteration` 和 `camera`，或者在规范中明确「含这两种端口的节点不能进入节点流」，并在封装入口给出明确错误。不能出现端口快照 schema 静默拒绝的情况。

**NF-6.6【目标·F3】JSON Schema 兼容**：内部数据边和公开输出，必须按 `NODE_CONTRACT_SPEC §5` 第 4 步比较 `schemaRef` 是否兼容。现行实现只对公开 JSON 输入要求声明 schemaRef，内部边不比较。

**NF-6.7【现行】预算（发布期）**：内部节点数、边数不超过 `executionPolicy.maxExpandedNodes/Edges`；注入 resolver 后，递归检查嵌套依赖的深度、展开节点总数和依赖环（`DEPENDENCY_CYCLE`）。

---

## 7. 运行语义

### 7.1 运行语义版本

**NF-7.1【现行】** `runtimeVersion` 决定以下两件事：

| | 1（历史，缺省） | 2（新发布必须使用） |
|---|---|---|
| 外部文本输入 | 直接替换文本节点正文 | 作为**虚拟上游**接入 `in-text`，沿用普通文本节点的合并和投影规则 |
| 公开输出 | 只收集首个媒体结果（多个媒体输出共享同一份） | 按每个公开输出的映射分别收集，支持文本和 JSON |

**NF-7.2【现行】** 已发布的历史版本不写这个字段，继续按 1 运行。`runtimeVersion` 是加性字段，`schemaVersion` 保持 1。

### 7.2 输入接入

**NF-7.3【现行】** 每个公开输入的数据包，按 `targets[]` 生成**虚拟上游节点和真实连线**（`planCompositeInputBindings`），不改写内部节点正文。多值端口保留调用顺序（`order` 从 1 开始）。

**NF-7.4【现行】输入错误（phase=input）**：
- `INPUT_REQUIRED`：必填且没有 `defaultValue`、没有收到值；
- `INPUT_VALUE_INVALID`：单值端口收到多份值；
- `INPUT_TYPE_UNSUPPORTED`：值的种类与声明类型不符，或者该种类暂不支持接入。

**NF-7.5【目标·N5】必填输入在运行前预检**：所有入口（画布运行、headless、Agent Flow 调度）都必须在**执行任何内部节点之前**完成 NF-7.4 检查，不允许出现「必填输入没给 → 内部节点被跳过 → 最后报 `REQUIRED_OUTPUT_MISSING`」这种误导性路径（11-20 节点流测试报告中的高频踩坑点）。

### 7.3 执行

**NF-7.6【现行】** 内部节点继续使用公共 executor、模型和媒体服务以及运行台账，不得另写执行器；内部运行记录可以追溯到父调用和固定版本。

**NF-7.7【现行·守卫测试待恢复】确定性**：同一版本、同一输入，在不调用外部模型的前提下，重复运行的输出必须逐字节一致。涉及模型调用的节点只保证结构一致。11-20 用来验证这一条的测试（`node-flow-e2e-composition.test.ts`）随丢失的提交一起不在 main 上，恢复之前，这一条没有自动守卫。

### 7.4 输出收集与投影

**NF-7.8【现行】** 按公开输出映射读取本次运行结果（`collectCompositeOutputs`）：
- 必填输出缺失 → `REQUIRED_OUTPUT_MISSING`（phase=output，附带内部 nodeId.portId）；
- 可选输出缺失 → 正常结果，该端口本次不投影；
- 类型不符 → `OUTPUT_TYPE_MISMATCH`。

**NF-7.9【现行】投影只认本次成功**：runtimeVersion 2 只读取本次运行写入 `meta.nodeExtra` 的映射结果；没有成功运行记录时**不投影**，绝不用上一轮的产物冒充本轮结果。

**NF-7.10【现行】** 媒体输出遵守 `NODE_CONTRACT_SPEC §11`：产物由独立资产节点承载，实例不回写自身的 mediaId/mediaPath。

### 7.5 错误定位

**NF-7.11【现行】** 每个运行错误都必须带上 `code`、`phase`（input/step/output），以及适用时的 `publicPortId`、`nodeId`、`portId`。message 已脱敏，只包含 ID，不包含正文。

---

## 8. 串联与并联语义

**NF-8.1【现行】串联**：沿内部数据边按拓扑序执行，每一步输出按节点契约投影，供下游消费。

**NF-8.2【现行】广播并联**：一个公开输入的多个 `targets` 各自获得同一份值；分支之间互不读取彼此的中间状态。

**NF-8.3【现行】扇入**：多条边进入 `many` 输入时，按**连线记录顺序**排列（文本 `\n$$$\n` 合并，JSON 和媒体组成有序数组）。
- **NF-8.3a【目标】** 扇入顺序必须在 GUI 上**可见、可调整**，并持久化为边的 `order` 字段，不能隐式依赖创建时间。

**NF-8.4【目标·F5】分支失败策略**：`executionPolicy.onBranchFailure: 'fail-fast' | 'continue'`，缺省为 `fail-fast`。
- `fail-fast`：任一内部节点失败，就停止认领尚未开始的节点（已经在运行的节点自然结束，不强杀），整体返回 failed。
- `continue`：其他独立分支继续执行。对于必填输出，只要来源分支失败就整体 failed；可选输出照常投影。

**NF-8.5【目标】内部并发**：`executionPolicy.maxConcurrency`（1–4，缺省 1）。并发只发生在无依赖关系的就绪节点之间，结果聚合顺序与并发无关。

---

## 9. 缺席、跳过与等待

**NF-9.1【目标·N5】三种「无值」必须可区分**，并且沿数据边传播：

| 缺席原因 | 含义 | 下游行为 |
|---|---|---|
| `optional-not-produced` | 上游成功，但本次没有产出该可选输出 | 下游按「未连接」处理（使用固定值或默认值） |
| `skipped` | 上游被跳过（如可选输入为空、循环体为空） | 下游如果有**必填**输入依赖它，自身也 skipped；全部可选则照常执行 |
| `not-run` | 上游尚未运行或已过期 | 不允许执行，提示先运行上游 |

**NF-9.2【现行】等待输入**：`executionPolicy.waitForInput: true` 时，运行过程中可以暂停，等待补输入；通过 `composite.run.submitHuman` 和 `composite.run.resume` 继续。
- **NF-9.2a【目标】** 等待状态必须持久化 `waitingFor: { publicPortId | internalNodeId, reason }`；重开应用后可恢复，且不重复执行已完成的内部节点。

**NF-9.3【现行】人工门**：内部节点包含人工发布或审核时，必须设置 `executionPolicy.requiresManualGate: true`，并在能力描述中展示。
- **NF-9.3a【目标】** 发布校验**自动推断**这个标记：内部图里出现 `manual-publish`、`human-task`、`ai-review` 等节点时，标记必须为 true，否则校验失败。不能依赖作者手填。

---

## 10. 嵌套与运行期预算

**NF-10.1【现行】** 嵌套只能引用**已发布的固定版本**；运行时同一 `capabilityId` 再次进入调用链即判定为递归（`RECURSIVE_COMPOSITE`）。

**NF-10.2【现行 · BL-08，2026-11-22】发布期与运行期的预算缺省值统一**：唯一来源为 `src/shared/composite/budget.ts`（`COMPOSITE_BUDGET_DEFAULTS` = 8 层 / 200 展开节点 / 1500 连线），由 `test/composite-budget-parity.test.ts` 守护。修复前两套缺省不一致：

| 预算 | 发布校验缺省（`validate.ts`） | 运行守卫缺省（`runtime.ts`） |
|---|---|---|
| 最大嵌套深度 | 5 | 8 |
| 最大展开节点数 | 500 | 200 |

后果是：嵌套展开总数在 200 到 500 之间的节点流能**通过发布**，但**运行必然失败**（`EXPANSION_BUDGET_EXCEEDED`）。统一采用运行期取值，因此存量实例的运行行为不变。

**NF-10.3【现行】** 运行期预算错误：`RECURSIVE_COMPOSITE`、`DEPTH_EXCEEDED`、`EXPANSION_BUDGET_EXCEEDED`。

---

## 11. 版本、升级与兼容

**NF-11.1【现行】** 版本只能前进，不能原地修改；当前只允许主版本号（`1.0`、`2.0`……）。

**NF-11.2【目标】语义化版本**：改为 `major.minor`：
- minor：只做向后兼容的变化，即新增**可选**公开输入、新增公开输出、内部实现变化但公开契约不变。已绑定的实例可以一键升级。
- major：任何会被 NF-11.3 判为 breaking 的变化。

**NF-11.3【现行】升级预检**（`planCompositeUpgrade`）结合外层实际连线判定以下变化是否阻断：

| 变化 | 端口已连线 | 端口未连线 |
|---|---|---|
| 公开端口被移除 | 阻断 | 兼容 |
| 类型、Schema、基数变化 | 阻断 | 兼容（记录在影响清单中） |
| 新增**必填**输入 | 阻断（现有实例没有对应连线） | — |
| 必填性变化 | 记录在影响清单中 | 记录在影响清单中 |

**NF-11.4【现行】** 升级预检和升级应用三入口一致（`composite.upgrade.preview / apply`）；阻断项定位到具体的外层节点和边。

**NF-11.5【目标】** 升级应用必须是**单个撤销步**，失败时整体回滚；升级不会重跑已经计费的任务。

---

## 12. 副作用、计费与外部调用

**NF-12.1【目标·F6，修复已丢失需恢复】** manifest 只要声明了 `kind: model` 依赖，或者内部包含任何付费生成节点：
- headless `composite.execute` 必须携带显式的计费确认，或者持有用户预授权（范围、额度、期限）；
- 否则返回 `CONFIRMATION_REQUIRED`，不执行任何内部节点。

**NF-12.2【目标】** 能力描述（`composite.get`、`capability.list`、FlowGraph 能力菜单）必须展示 `cost: none | possible | certain` 和 `network: none | required`，这两个值**由 dependencies 自动派生**。

**NF-12.3【现行】** 重试只针对「提交前/提交失败」；提交成功后的失败不自动重提，按运行台账核对（与 `NODE_CONTRACT_SPEC §4.1 W1` 的 video 规则一致）。
- **NF-12.3a【目标·N9】** image-gen 等所有远端异步生成节点，统一适用这条规则。

---

## 13. 作为 Agent Flow 能力（跨层接口）

**NF-13.1【现行·BL-10】发布即注册能力**：每个已发布版本自动生成一条可编排能力描述：

```jsonc
{
  "capabilityRef": { "kind": "composite", "id": "<capabilityId>", "version": "<version>" },
  "inputs":  [ /* 公开输入：in-<id>、type、required、cardinality、schemaRef */ ],
  "outputs": [ /* 公开输出：out-<id>、... */ ],
  "participation": "autonomous | collaborative | human",   // 由 NF-13.2 推导
  "cost": "none | possible | certain",                       // NF-12.2
  "network": "none | required",
  "agentSchedulable": true | false, "reason": "..."
}
```

**NF-13.2【现行·BL-10】参与形态推导**：
- `requiresManualGate` 或 `waitForInput` 为 true → 至少为 `collaborative`；
- 否则为 `autonomous`。
- 这个推导值是**下限**：FlowGraph 可以声明更高的人工参与度，但不能更低。

**NF-13.3【现行·BL-10】** FlowGraph 编译器、上帝 Agent 的能力菜单、MCP 工具描述，全部从这份能力描述**生成**；禁止在编译器里硬编码能力白名单（`CAPABILITY_COMPILE` 已删除，改为 `src/shared/agent-flow/capability-catalog.ts` 驱动；节点侧由节点注册表导出快照生成，节点流侧由已发布版本生成）。

**NF-13.4【目标】** 节点流在 Agent Flow 中执行时：最小输入来自 Agent Flow 的 ContextManifest，经公开输入接入；交付为公开输出对应的**不可变资产版本**；内部失败通过 `failureNodeId/failurePortId` 透传给 Agent Flow 的运行总览。（BL-10 已打通编译/运行准入/交付与 `failureNodeId` 透传；最小输入编制与真实端口校验随 BL-11/12 推进。）

---

## 14. 三入口与外部操作

**NF-14.1【现行】** 节点流操作属于 `composite.*` 操作族，覆盖：发现（search/get/version.list/references）、草稿（draft.get/draft.save）、校验与发布（validate/publish）、升级（upgrade.preview/apply）、归档与删除、执行（execute/execute.wait）、运行管理（run.get/list/retry/submitHuman/resume/resubmit）。**完整清单与 Schema 以 `contracts.json` 为准**，本文不维护清单。

**NF-14.2【现行】** 三入口共用同一份业务实现和同一组稳定错误码；IPC 与 Agent 接入只映射 code，不解析中文 message。

**NF-14.3【目标】** 每个操作在 OperationSpec 中逐项声明 `idempotent`、`destructive`、`cost`；MCP 注解由这些声明**派生**（例如 `delete`、`execute` 不得声明为幂等）。

---

## 15. 错误码目录

> 机器真值是各模块的 TypeScript 联合类型；本表只做语义说明。

| 阶段 | 错误码 | 说明 |
|---|---|---|
| 发布/草稿 | `VERSION_IMMUTABLE` `VERSION_NOT_NEWER` `DRAFT_REVISION_CONFLICT` `DRAFT_NOT_FOUND` `PUBLISH_INVALID` | `errors.ts` |
| 发布校验 | `MANIFEST_SCHEMA` `NODE_REF_MISSING` `PORT_MISSING` `PORT_TYPE_MISMATCH` `PORT_CARDINALITY` `DUPLICATE_EDGE` `CYCLE` `INPUT_NO_TARGET` `INPUT_TARGET_MISSING` `INPUT_DUPLICATE_TARGET` `REQUIRED_INPUT_UNBOUND` `OUTPUT_SOURCE_MISSING` `OUTPUT_TYPE_MISMATCH` `NO_BUSINESS_OUTPUT` `SCHEMA_UNREGISTERED` `DEPENDENCY_MISSING` `BUDGET_EXCEEDED` `SELF_RECURSION` `DEPENDENCY_CYCLE` | `validate.ts` |
| 运行·输入/输出 | `INPUT_REQUIRED` `INPUT_TYPE_UNSUPPORTED` `INPUT_VALUE_INVALID` `OUTPUT_SOURCE_MISSING` `REQUIRED_OUTPUT_MISSING` `OUTPUT_TYPE_MISMATCH` `OUTPUT_VALUE_INVALID` | `runtime.ts` |
| 运行·预算 | `RECURSIVE_COMPOSITE` `DEPTH_EXCEEDED` `EXPANSION_BUDGET_EXCEEDED` | `runtime.ts` |
| 引用 | `COMPOSITE_REF_NOT_RESOLVED` | 实例解析 |
| 【目标】 | `CONFIRMATION_REQUIRED` `SCHEMA_INCOMPATIBLE` `MANUAL_GATE_UNDECLARED` | NF-12.1 / NF-6.6 / NF-9.3a |

---

## 16. 日志

**NF-16.1【现行】** 遵守 `LOGGING_SPEC.md`：`composite.run.*` 事件记录开始、终态、失败阶段、`failureNodeId/PortId` 和调用链；不记录输入输出正文、提示词或媒体内容。新增路径要同包更新 `LOGGING_COVERAGE.md`。

---

## 17. 验收与门禁

新增或修改节点流相关能力，必须同包提供：

1. **校验测试**：每条 `NF-6.*`、`NF-7.4` 至少一个正例和一个反例。
2. **口径一致测试【目标】**：遍历 connection-matrix 真值表，断言节点流的端口兼容判定与画布完全相同（NF-6.4）；断言发布期和运行期的预算常量相同（NF-10.2）。
3. **端到端组合测试**：单节点、串联、广播并联、扇入、引用形态、内嵌形态、三层嵌套、递归拒绝、确定性重复运行（恢复 11-20 丢失的 `node-flow-e2e-composition.test.ts`）。
4. **升级测试**：NF-11.3 的每一格至少一例。
5. `npm run verify` + `guard:agent-parity` + `verify:logging` 全绿。

---

## 18. 变更流程

- 修改任何【现行】条款：同一提交中更新实现、测试和本文，并更新头部的 `last-verified / baseline-commit`。
- 把【目标】转为【现行】：附带实现提交和测试名，同时删除对应差距编号。
- 本文不记录历史；历史写入 `docs/archive/CHANGELOG-node-flow.md`。

---

## 附录 A：现行与目标差距（冻结前必须清零或明确延期）

| 差距 | 条款 | 优先级 |
|---|---|---|
| ~~节点流不可被 Agent Flow 编排~~ ✅ BL-10（capabilityRef + 能力目录；最小输入编制/真实端口随 BL-11/12） | NF-1.4 / NF-13.* | P1 |
| ~~端口兼容判定与画布分裂~~ ✅ BL-11（`port-compatibility.ts` 单一实现；`iteration/camera` 类型枚举待 BL-12） | NF-6.4 / NF-6.5 | P1 |
| ~~发布期/运行期预算缺省不一致~~ ✅ BL-08 | NF-10.2 | — |
| headless 计费确认门（修复提交已丢失） | NF-12.1 | **P0** |
| 必填输入运行前预检 | NF-7.5 | P1 |
| 媒体固定输入按类型匹配 | NF-6.2a | P1 |
| JSON Schema 兼容校验 | NF-6.6 | P1 |
| 缺席/跳过三态 | NF-9.1 | P1 |
| 分支失败策略、内部并发 | NF-8.4 / NF-8.5 | P2 |
| 人工门自动推断 | NF-9.3a | P2 |
| semver major.minor | NF-11.2 | P2 |
| 键约定统一 | NF-5.3 | P1 |
