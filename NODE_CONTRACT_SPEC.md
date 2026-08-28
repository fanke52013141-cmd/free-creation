# 节点输入输出契约规范

> 状态：强制规范 1.2（P0-P3.1 已落地）
> 代码入口：`src/shared/types/index.ts`、`src/shared/node-schemas.ts`、`src/renderer/src/nodes/registry.tsx`  
> 节点定义：`src/renderer/src/nodes/specs/index.tsx`
> 运行时：`src/renderer/src/engine/contracts.ts`、`src/renderer/src/nodes/nodeValues.ts`

## 1. 设计原则

画布上的节点不是彼此直接调用的功能孤岛。节点只负责一件事：按照已声明的输入契约接收数据，执行自己的能力，再按照输出契约产生数据。

连线的准确含义是：

```text
sourceNode.outputs[sourcePortId]
  -> targetNode.inputs[targetPortId]
```

因此，任何执行逻辑都不得只根据“节点 A 连到了节点 B”猜测数据含义，也不得扫描上游节点标题来决定输入。历史连线只通过稳定的 `nodeId + portId` 寻址。

核心规则：

1. 每个节点必须先定义输入和输出，再实现 UI 与执行逻辑。
2. 端口 ID 是持久化协议，显示名称只是 UI 文案。
3. 连线必须携带真实数据依赖，装饰线或流程提示线不属于业务连线。
4. 类型不兼容时禁止连线，不能依赖执行器隐式猜测或强制转换。
5. JSON 必须有结构标识和版本，不能只写一个含糊的 `json`。
6. 复合业务优先做成工作流模板，不新增“把多个步骤藏起来”的巨型节点。
7. 右侧契约面板是调试与理解入口；节点卡片默认保持简洁。

## 2. 标准数据类型

| `PortType` | 传递内容         | 说明                                        |
| ---------- | ---------------- | ------------------------------------------- |
| `text`     | 普通字符串       | 提示词、台词、纯文本                        |
| `markdown` | Markdown 字符串  | AI 回复、带标题/列表/代码块的文档           |
| `json`     | 结构化值         | 对象、数组、分镜数据、参数                  |
| `image`    | 图片资产引用     | 传 `mediaId/path/mime`，不传二进制          |
| `video`    | 视频资产引用     | 同上                                        |
| `audio`    | 音频资产引用     | 同上                                        |
| `file`     | 通用文件资产引用 | 无法归入具体媒体类型的文件                  |
| `any`      | 显式声明的动态值 | 仅通用处理/代码类节点使用，业务节点禁止滥用 |

兼容矩阵：

- 相同类型可以直连。
- `text` 与 `markdown` 可以直连，数据仍保留原始语义类型。
- `any` 可以和所有类型连接，但目标节点仍必须在执行阶段验证实际值。
- `json -> text`、`text -> json` 不自动转换，必须通过处理、解析或格式化节点。
- 图片、视频、音频和文件默认严格匹配。

## 3. 节点契约

每个 `NodeTypeSpec` 必须声明：

```ts
interface NodeTypeSpec {
  type: NodeTypeId
  contractVersion: number
  label: string
  description: string
  ports: {
    in: PortDecl[]
    out: PortDecl[]
  }
  projectOutputs(shape): RawNodeOutputs
  executionMode?: 'auto' | 'manual-publish' | 'display-only'
  // icon、size、Body 等 UI 字段略
}
```

`projectOutputs` 是“节点已持久化状态 → 正式输出端口”的唯一投影入口。只要节点
声明了输出端口，就必须注册它；禁止在运行器或公共工具里新增按 `nodeType` 判断的
输出 `switch`。新增节点必须自行提供 Spec、Body、Executor 与投影函数。

`executionMode` 的含义：

- `auto`：工作流可直接执行。
- `manual-publish`：节点拥有交互式工作区，只有用户明确“发布”后才产生新的下游
  数据；全局运行只能复用最近一次已发布结果，不能擅自打开工作区。
- `display-only`：只呈现数据，不参与执行。

### 3.1 契约版本

以下变化必须提升 `contractVersion`：

- 删除端口。
- 修改端口 ID。
- 修改端口类型。
- 单值改多值或多值改单值。
- 修改必填规则。
- JSON Schema 出现不向后兼容的变化。

只修改名称、说明、颜色和布局不需要提升契约版本。

已经发布的端口 ID 不允许复用。端口退役后应保留迁移逻辑，把旧快照迁移到新 ID；无法安全迁移时必须保留兼容读取并在 UI 中标记为旧版。

## 4. 端口契约

```ts
interface PortDecl {
  id: string
  name: string
  dir: 'in' | 'out'
  type: PortType
  required: boolean
  cardinality: 'one' | 'many'
  description: string
  schema?: { id: string; version: number }
}
```

### 4.1 端口 ID

- 输入使用 `in-*`，输出使用 `out-*`。
- 使用小写 kebab-case，例如 `in-reference-image`。
- ID 表达业务语义，禁止新增长期使用的 `input1`、`output2`。
- 显示名称可以翻译或调整，ID 不可随文案变化。

### 4.1.1 动态端口

代码等节点允许根据节点配置生成端口，但动态端口同样是正式契约，不能只存在于 UI：

- 必须由同一个 `resolvePorts(shape)` 同时驱动画布圆点、连线校验、右侧契约面板、保存图数据和运行时校验。
- 动态 JSON 端口必须声明 Schema；通用结构使用 `json.any@1`。
- 配置生成的端口 ID 必须在单个节点内去重；名称归一化后碰撞时，应拒绝或显式提示，不能悄悄生成两条同 ID 的端口。
- 动态输出的投影必须使用同一个动态 `out-*` ID，不能声明命名输出却仍把结果写到固定端口。

### 4.2 `required`

- 输入端口：运行前是否必须获得值。
- 输出端口：节点成功运行后是否保证产生值。
- 节点内允许填写固定值时，对应输入通常不是必填；运行器应采用“连线值优先，固定值兜底”。
- 一个节点存在互斥输出时，例如代码节点可能输出文本或 JSON，这些输出不能同时标记必填。

### 4.3 `cardinality`

- `one`：数据是单值，且输入端口只能连接一个上游。
- `many`：数据是列表或允许多个上游，执行器必须定义合并顺序。
- 输出端口的 `one/many` 描述一次执行产生一个值还是一组值，不限制它可以连接多少个下游。

禁止把“多个上游字符串拼接”当作默认行为。只有声明为 `many` 的文本输入才允许合并，合并规则必须稳定并写入节点说明。

### 4.4 JSON Schema

所有 JSON 端口必须声明：

```ts
schema: {
  id: 'storyboard.shots',
  version: 1
}
```

- 完全开放的 JSON 使用 `json.any@1`，不能省略 Schema。
- 相同 Schema ID 的新版本应尽量向后兼容。
- 分镜、字幕、角色、镜头参数等业务结构必须使用独立 Schema ID。
- 列表批处理使用 `list.items@1`：根值必须是数组，每个元素必须是对象（建议带稳定 id）。迭代/批处理节点的输入输出用它，使批量结果仍是可连接的结构化列表，而不是把几十个生成资产藏进一个不可连接的节点内部。
- P2 已注册 `character.profile@1`、`scene.definition@1`、`shot.definition@1`、`prompt.bundle@1`；字段定义、校验错误和模板用法见 [docs/STRUCTURED_CREATIVE_DATA.md](./docs/STRUCTURED_CREATIVE_DATA.md)。
- Schema 的字段定义必须集中到共享目录，并在运行前后执行实际校验。

#### 动态输出的 Schema 声明原则

当节点的输出 Schema 需要由用户运行时选择（如 AI 处理节点可在 `json.any` 与 `storyboard.shots` 之间切换）时：

- 输出端口静态声明最宽泛的 Schema（通常 `json.any@1`），以保证连线阶段能与任意具体 Schema 连通。
- 执行器内部按用户实际选择的 Schema 调用 `validateNodeSchema` 做运行时严格校验；不通过则执行失败并报错，绝不能把不符合所选 Schema 的值伪装成合法输出输出到下游。
- 其意义：连线规则（§5）看静态声明，执行结果（§8）看运行时校验，两者职责分离，避免为动态输出预先枚举所有可能 Schema。

示例见 `ai-process` 节点：`out-json` 静态声明 `json.any@1`，执行器按配置里的 `jsonSchema` 做运行时校验。

#### 结构数据节点的字段映射

`structured` 是 P2 的通用结构编辑节点，不为角色、场景或镜头分别创建特例 UI。它的正文保存 JSON，`props.config` 保存所选 Schema；输出端口由 `resolvePorts(shape)` 显示为该 Schema。

- `in-context`：多个 `json.any@1` 上游，可在正文中使用 `{{input[0].field}}`、`{{input[1].nested.field}}` 明确引用。
- `in-text`：多个文本上游，可用 `{{text}}` 引用合并文本。
- 占位符只能读取上述已连线端口；禁止扫描任意上游节点、标题或节点类型。
- 整个值恰为一个占位符时，可保留对象/数组（例如把单条 `shot.definition` 组装进 `storyboard.shots`）；嵌入文本时才转为字符串。
- 执行后先做字段级 Schema 校验，失败不产生 `out-json`；未运行但本地正文已合法时可作为手工编辑的数据源输出。

#### 迭代作用域端口

`iterate` 不是把一条普通结果线同时拿来表示“循环控制”和“最终数据”。它有两个语义严格分离的输出：

- `out-item`（`json.any@1`，可选）：当前列表项的**临时作用域**数据。只能连接循环体的入口输入端口；运行器会为每个 item 把该值注入这条端口，并沿循环体内的真实数据连线继续执行。
- `out-items`（`list.items@1`）：循环完成后产生的**项目级结果列表**。它只能供汇总、展示或下一阶段的普通节点消费，不能作为循环体的隐式控制线。

循环体由 `out-item` 的入口向下沿数据边展开；同一迭代节点 `out-items` 的目标是边界外的汇总消费者，不会在每项中重复运行。循环节点本身不会把 `out-item` 持久化为“最后一项”的普通输出，避免画布外部错误消费不确定的单项状态。

运行器对动态注入仍执行目标端口的类型、Schema、基数和必填校验。禁止把当前项硬编码注入某个叫 `in-json` 的端口；循环体入口可以是 `in-context`、`in-prompt` 或任何已声明且兼容的 JSON 输入。

迭代的可恢复运行记录保存在 `meta.nodeResult`，其中每项都有 `source.index`，并在存在非空字符串 `id` 时附带 `source.itemId + source.fingerprint`。恢复规则只能复用 **ID 和内容指纹均匹配** 的 `done/reused` 项；没有稳定 ID、内容已变或上轮失败/中断的项必须重新执行。`runMode: 'failed'` 只允许重跑这次记录中仍匹配的失败项。运行器会在每项完成后写入进度检查点；暂停是协作式的，只在当前原子项结束后停下，停止会解除暂停等待。循环体执行时若把输入解析后写回 `props.text/config`，运行器必须在每项前恢复冻结的静态输入，并在循环结束后再恢复一次，不能把最后一项的解析结果当作下一轮模板。

## 5. 连线规则

创建连线必须依次校验：

1. 源节点和目标节点存在。
2. 源端口是输出，目标端口是输入。
3. 两端类型兼容。
4. JSON Schema 兼容。
5. 单值输入端口没有被其他上游占用。
6. 不存在完全重复的连线。
7. 不产生循环依赖。

当目标节点存在多个兼容输入时：

- 用户拖到明确端口附近时使用该端口。
- 只有一个可用输入时可以自动选择。
- 存在多个同等候选时应弹出端口选择，而不是永远取数组第一项。

删除节点时必须同步清理关联边；删除或改名端口时必须提供快照迁移。

## 6. 统一执行协议

目标执行流程：

```text
读取入边
-> 取得上游端口的实际输出包
-> 按目标 portId 填充输入
-> 验证类型 / 必填 / 数量 / Schema
-> 执行节点
-> 验证输出
-> 保存运行结果和来源信息
-> 提供给下游
```

目标数据包：

```ts
interface NodeValuePacket {
  type: PortType
  value: unknown
  schema?: PortSchemaRef
  source: {
    nodeId: string
    portId: string
    runId: string
  }
  createdAt: number
}
```

执行器不得继续增加 `if (nodeType === ...)` 式的输入采集分支。节点专属逻辑属于节点执行器；收集输入、验证契约、保存输出属于统一运行时。

## 7. 右侧契约面板

节点卡片默认只保留标题、状态和端口圆点。选中节点或点击标题栏的详情按钮后，右侧面板显示：

### 概览

- 节点类型和职责。
- 契约版本。
- 当前执行状态。

### 输入

- 名称、稳定 ID、类型、必填性和单值/多值。
- JSON Schema ID/版本。
- 当前连接来源：节点标题、节点 ID、输出端口。
- 当前实际值预览，敏感值和大型媒体只显示摘要。
- 未连线时使用的固定值或默认值。

### 输出

- 名称、稳定 ID、类型、数量和 Schema。
- 最近一次实际输出预览。
- 当前连接的下游节点列表。

### 运行信息

- 本次运行 ID、耗时、缓存状态。
- 校验错误、执行错误和模型原始错误摘要。
- 记录输入来源的 `nodeId + portId` 与本次实际输出端口，但不得复制 API Key、完整敏感正文或媒体二进制到运行记录。
- 不显示伪造的思考过程；只展示供应商真实返回且允许展示的 reasoning 数据。

## 8. 复合能力规范

“脚本”“批量生图”“视频生产”等由多个阶段组成的能力优先定义为工作流模板：

```text
文本
-> AI/处理节点
-> JSON 数据节点
-> 分镜呈现节点
-> 生图/视频节点
```

模板负责创建和连接若干普通节点，不引入新的特殊执行协议。只有满足以下条件才创建新节点类型：

- 该能力具备明确且稳定的单一职责。
- 无法由已有节点组合清晰表达。
- 输入输出可以独立定义和测试。
- 不是为了隐藏多个尚未梳理清楚的步骤。

### 8.1 导演台（`director`）

导演台是 `manual-publish` 节点：画布卡片只展示工程摘要和发布状态，完整预演在独立
工作区打开。它不是没有连线的特殊工具，也不能把场景状态藏进下游节点。

| 方向 | 端口                  | 类型                        | 数量 | 语义                         |
| ---- | --------------------- | --------------------------- | ---- | ---------------------------- |
| 输入 | `in-storyboard`       | `json / storyboard.shots@1` | one  | 分镜同步为镜头列表           |
| 输入 | `in-reference-images` | `image`                     | many | 人物、场景、构图参考图       |
| 输入 | `in-camera-preset`    | `json / previs.camera@1`    | one  | 初始机位参数                 |
| 输出 | `out-frame`           | `image`                     | one  | 明确发布的当前预演帧         |
| 输出 | `out-preview-video`   | `video`                     | one  | 明确导出的 WebM 预演         |
| 输出 | `out-camera`          | `json / previs.camera@1`    | one  | 已发布镜头机位参数           |
| 输出 | `out-project`         | `json / previs.project@1`   | one  | 轻量工程摘要，不含媒体二进制 |

导演工程改动后，在未重新发布帧/视频之前，节点必须标示“尚未发布”；下游仅可消费
最近一次已发布数据。参考图和分镜的“同步输入”只读取其声明的 `portId`，不得按
节点标题、节点类型或隐藏标签推断资源。

## 9. 分阶段改造方案

### P0：契约基础（已完成）

- 扩展 `PortDecl`：说明、必填、数量、Schema。
- 增加节点 `contractVersion`。
- 注册阶段执行硬校验。
- 文本与 Markdown 分型。
- 单值输入在连线阶段拒绝第二条上游。

完成标准：任何缺少契约字段的新节点都无法注册。

### P1：Schema 仓库与真实校验（基础能力已完成）

- 已建立 `src/shared/node-schemas.ts` 版本化注册表。
- 已注册 `json.any@1` 与 `storyboard.shots@1`；字幕、角色、镜头参数在对应节点进入开发时再注册，禁止预埋空 Schema。
- 已在连线时校验 Schema ID/版本兼容。
- 已在节点运行前验证输入、运行后验证输出。

完成标准：错误结构无法悄悄进入下游，错误信息能指出具体端口和字段。

### P2：统一数据包与执行上下文（已完成）

- 已引入带 `type/schema/source/runId/createdAt` 的 `NodeValuePacket`。
- 执行结果按 `nodeId + portId` 保存，输入只按目标 `portId` 收集。
- 全局执行使用统一收集器；卡片内手动触发使用同一个节点输出投影，不再按上游节点类型猜值。
- 多值文本按画布连线的稳定顺序用 `\n\n---\n\n` 合并，JSON 多值保留为数组。

完成标准：新增节点不需要修改全局输入收集分支。

### P3：节点执行器解耦（已完成）

- 每个节点在 Spec 中通过 `executor` 字段注册自己的执行器。
- 执行器统一为函数类型别名 `NodeExecutor = (ctx) => result`，定义在 `engine/executor-types.ts`。
- 执行器拿到 `NodeExecutionContext`（节点、shape、已校验输入、供应商、取消信号、`updateProps` / `updateResult` 写回入口），返回 `{ status, reason? }`。
- 全局运行器 `engine/executor.ts` 只保留拓扑排序、输入收集、契约校验、取消、状态、输出投影与登记；不再含按 `nodeType` 分发的主 switch。
- 各节点执行逻辑迁移到 `engine/executors/<node>.ts`，共享工具集中在 `engine/executors/shared.ts`。

完成标准：新增普通节点只新增 Spec（注入执行器）、Body 和执行器文件，不修改核心运行器。`executor.ts` 中不再出现节点类型分支。

### P4：右侧契约与运行检查器

- 展示完整端口契约。
- 展示真实上下游映射。
- 展示固定值、实际输入、实际输出和错误。
- 在节点标题栏增加轻量详情按钮；默认不展开。

完成标准：无需读代码即可回答“这个值从哪里来、到哪里去、是什么结构”。

### P5：模板化复合流程

- 脚本改为“文本 -> 处理/AI -> JSON -> 分镜”的模板。
- 宫格生图、批量分镜生图改为模板或批处理编排。
- 保留旧复合节点的只读兼容与迁移。

完成标准：复合流程中的每一步都可以单独替换、调试和复用。

### P6：测试与发布门禁

- 为每个节点生成契约快照测试。
- 测试所有允许和禁止的类型组合。
- 测试单值/多值、必填、Schema 版本和旧快照迁移。
- CI 中运行节点注册校验、类型检查和工作流样例。

完成标准：修改端口导致不兼容时，测试必须在发布前失败。

## 10. 新增节点检查清单

新增节点前必须逐项确认：

- [ ] 节点只有一个清晰职责。
- [ ] 已添加稳定的 `NodeTypeId`。
- [ ] 已声明 `contractVersion`。
- [ ] 每个端口都有稳定 ID、名称、类型和业务说明。
- [ ] 每个端口都声明必填性与单值/多值。
- [ ] 所有 JSON 端口都有 Schema ID 和版本。
- [ ] 没有为了省事使用不必要的 `any`。
- [ ] 执行器读取的输入 ID 与 Spec 完全一致。
- [ ] 执行器写出的输出 ID 与 Spec 完全一致。
- [ ] 右侧面板可以解释所有输入输出。
- [ ] 已定义固定值和连线值的优先级。
- [ ] 已定义错误和空输入行为。
- [ ] 已添加契约、连线、执行和迁移测试。
- [ ] 未破坏已发布端口；如有破坏性变化，已提升版本并提供迁移。

## 11. 示例

```ts
registerNodeType({
  type: 'example',
  contractVersion: 1,
  label: '示例',
  description: '把一段文本转换为结构化数据。',
  ports: {
    in: [
      {
        id: 'in-source-text',
        name: '原始文本',
        dir: 'in',
        type: 'text',
        required: true,
        cardinality: 'one',
        description: '等待解析的原始文本。'
      }
    ],
    out: [
      {
        id: 'out-result',
        name: '解析结果',
        dir: 'out',
        type: 'json',
        required: true,
        cardinality: 'one',
        description: '解析并校验后的字段对象。',
        schema: { id: 'example.result', version: 1 }
      }
    ]
  }
  // 其他 UI/执行字段略
})
```

注册表会拒绝缺失契约版本、错误端口 ID、重复端口、空说明和没有 Schema 的 JSON 端口。不要绕过注册校验；如果规则不适合新的真实场景，应先修改本规范和共享类型，再实现节点。
