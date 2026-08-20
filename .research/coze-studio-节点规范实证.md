# 扣子（coze-dev/coze-studio）前端工作流节点规范调研报告

> 数据来源：用 `git clone --depth 1 --filter=blob:none --sparse` 拉取了 `frontend/packages/workflow`、`frontend/packages/common/flowgram-adapter`、`frontend/packages/data/memory/variables`（绕开 GitHub REST API 60次/小时限制），逐文件阅读真实代码。仓库默认分支 `main`，rush monorepo，前端 React+TS，后端 Go+Eino。

## 一、关键结论速览

- **画布引擎不是 React Flow**，而是字节开源的 **FlowGram.ai**（`@flowgram.ai/free-layout-editor@0.1.28` + free-lines / auto-layout / snap / minimap / container / node-variable 等 20 个插件）。另有独立的 `@coze-workflow/fabric-canvas`（Fabric.js 6）只用于「图像画布」节点的图层合成，不是主画布。
- **节点 = 注册项 `WorkflowNodeRegistry`**：`type`（数字枚举）+ `meta`（尺寸/端口/路径）+ `formMeta`（FlowGram `FormMetaV2`，驱动配置面板）。
- **变量系统原生支持多媒体类型**：`Image/Video/Audio/File/Svg/Voice/Ppt/Excel…` 及其数组，前端枚举 39 种、后端 FDL `string/integer/float/boolean/image/object/list/time` + `assistType` 辅助类型。
- **运行机制**：整流运行 `WorkFlowTestRun`；**单节点调试** `WorkflowNodeDebugV2`（带 `isSingleMode`，手动填输入即可跑单个节点）；支持 pause/continue/cancel + 轮询进度。运行结果「默认展开所有图片流」。
- **强制 Start→End**：每个工作流必须有且仅有一个 Start（`isStart/deleteDisable/copyDisable`，只有输出端口）和一个 End（只有输入端口）。这与「松散、不强制首尾」的诉求冲突。

## 二、【节点规范】如何定义一个节点

核心数据结构（`base/src/types/registry.ts` 的 `WorkflowNodeRegistry`，继承 FlowGram 原生注册项）：

```ts
export interface WorkflowNodeRegistry {
  type: StandardNodeType;              // 数字字符串枚举，如 '3'=LLM
  meta: NodeMeta;                      // nodeDTOType / size / defaultPorts / useDynamicPort / 各种 *Path
  variablesMeta?: WorkflowNodeVariablesMeta; // outputsPathList 默认 ['outputs']，inputsPathList 默认 ['inputs.inputParameters']
  formMeta: FormMetaV2;                // FlowGram 表单引擎：render/validate/effect/formatOnInit/formatOnSubmit
}
export interface NodeMeta {
  isStart?; isNodeEnd?; deleteDisable?; nodeDTOType; size?:{width,height};
  defaultPorts?: any[]; useDynamicPort?: boolean;
  nodeMetaPath?; outputsPath?; inputParametersPath?; batchPath?;
  getLLMModelIdsByNodeJSON?; helpLink?; test?;
}
```

节点序列化结构 `NodeDTO`（`base/src/types/dto.ts`）：`{ id, type, meta:{position:{x,y}}, data:NodeDataDTO, edges:[{sourceNodeId,targetNodeId,sourcePortId}] }`；`NodeDataDTO = { inputs:{inputParameters,settingOnError}, nodeMeta:{title,icon,subTitle,description,mainColor}, outputs:VariableMetaDTO[] }`。

`StandardNodeType` 枚举了 **约 60 种节点**（`base/src/types/node-type.ts`），下面 7 类内置节点的 schema 要点：

| 节点 | type | registry 要点 |
|---|---|---|
| **Start 开始** | `'1'` | `isStart:true`，不可删/不可复制/表头只读，`defaultPorts:[{type:'output'}]`（只有输出端口）；`outputs` 即工作流输入参数 |
| **End 结束** | `'2'` | `isNodeEnd:true`，只有 `{type:'input'}` 端口；`inputParametersPath` 收集输出 |
| **LLM 大模型** | `'3'` | `width:360`；输入走 `/$$input_decorator$$/inputParameters`（装饰器机制）；`getLLMModelIdsByNodeJSON` 从 `inputs.llmParam` 取 modelType；含 vision/skills/cot 子能力 |
| **Code 代码** | `'5'` | `width:484`，`inputParametersPath` 指向输入，`outputsPath` 指向输出树（用户声明输出变量），`enableCopilotGenerateTestNodeForm:true` |
| **If 条件判断** | `'8'` | **`useDynamicPort:true` + `defaultPorts:[{type:'input'}]`**——分支输出端口是动态生成的，画布上按条件数量生成多个「+」输出端口 |
| **ImageGenerate 图像生成** | `'16'` | `width:508`；含 model-setting(prompt/ratio/model)、references(参考图) 字段 |
| **Dataset 知识库检索/写入** | `'6'/'27'` | dataset-search / dataset-write，含 runtime-type、chunk/parser 配置 |
| 其余 | — | Plugin(`'4'` HTTP式)、SubWorkflow(`'9'`)、Loop/Batch(`'21'/'28'`)、Text 文本处理(`'15'` concat/split)、Question 选择器(`'18'`)、Http(`'45'`)、ImageCanvas(`'23'` Fabric 图层合成)、Database CRUD、Trigger CURD、会话/消息 CRUD、JsonStringify/Parser 等 |

每个节点的 `formMeta` 用 FlowGram 的 `FormMetaV2<FormData>`，结构高度统一：

```ts
export const CODE_FORM_META: FormMetaV2<FormData> = {
  render: () => <FormRender />,             // 配置面板 React 渲染
  validateTrigger: ValidateTrigger.onChange,
  validate: { nodeMeta, ...createCodeInputsValidator(), [CODE_PATH]:codeEmptyValidator, [OUTPUT_PATH]:outputTreeMetaValidator },
  effect: { nodeMeta: fireNodeTitleChange, outputs: provideNodeOutputVariablesEffect }, // 把输出发布成可用变量
  formatOnInit: transformOnInit,            // 后端DTO → 前端FormData
  formatOnSubmit: transformOnSubmit,        // 前端FormData → 后端DTO
};
```

## 三、【变量与数据流】

**类型枚举**（`base/src/types/view-variable-type.ts`，前端 `ViewVariableType`）：String/Integer/Boolean/Number/Object、Image/File/Doc/Code/Ppt/Txt/Excel/Audio/Zip/Video/Svg/Voice/Time，外加 18 种 `Array<X>`（共 39 种，从 99 起避免与后端冲突）。后端 FDL `VariableTypeDTO`：`string/integer/float/boolean/image/object/list/time`，再用 `AssistTypeDTO`（file/image/doc/code/ppt/txt/excel/audio/zip/video/svg/voice）补充语义。

**传递机制（节点间靠引用表达式，不靠连线传值）**：
- 连线（edges）只表达执行顺序/拓扑；**数据通过「变量引用」流动**。引用结构 `RefExpression.content` 三种 `source`：
  ```ts
  { source:'variable', blockID:undefined, name }               // 当前节点/全局变量
  { source:'block-output', blockID:'1002', name:'result' }     // 引用某节点(id=blockID)的输出
  { source:`global_variable_${string}`, path:[], blockID, name }// 全局变量
  ```
- 基于 FlowGram VariablePlugin 的 **provider/consumer 作用域**（`variable/src/form-extensions/`）：每个节点把输出发布到命名空间 `/node/outputs`（`provide-node-output-variables`，namespace `'/node/outputs'`），下游节点的输入框就能在表达式编辑器里选到上游输出；另有 `provide-node-batch-variables`、`provide-loop-input/output-variables`、`provide-merge-group-variables` 等特殊作用域。`consume-ref-value-expression` 处理引用消费。
- `inputs/outputs` 的存放路径由 `WorkflowNodeVariablesMeta` 配置（默认 `outputs` 和 `inputs.inputParameters`，批次在 `inputs.batch.inputLists`），`WorkflowJSONFormat` 负责 init/submit 时的 DTO↔View 双向转换。

## 四、【运行机制】

- **执行在后端（Go + Eino）**，前端只发请求 + 轮询进度（`playground/src/services/workflow-operation-service.ts`、`workflow-run-service.ts`）。
- **整流试运行**：`operationService.testRun` → `workflowApi.WorkFlowTestRun({input, commit_id})`，从 Start 节点输入开始跑到 End。
- **单节点调试（部分运行）**：`runService.testRunOneNode({nodeId, input, batch, setting})` → `workflowApi.WorkflowNodeDebugV2({node_id, input, batch, setting})`，执行态置 `isSingleMode:true`，再 `loop(executeId)` 轮询。**即：框选单个节点、手动填好输入即可单独跑，不依赖整流连通过**——这正是「中间节点单独运行」的能力（但粒度是「单节点」，不是「任意子图从中间跑到末尾」）。
- 进度与生命周期：`getProcess` 轮询 `GetWorkFlowProcess`（支持 `sub_execute_id` 用于子工作流），`pauseTestRun/continueTestRun/cancelTestRun` 提供暂停/继续/取消；节点状态 Running/Success/Fail 驱动连线高亮。
- 运行结果渲染默认规则：**「所有 image 流自动展开」+ 展开结束节点**（`playground/src/typing/index.ts:212`），图片类输出会得到可视化预览。

## 五、【画布渲染】

底层 = **FlowGram.ai free-layout-editor**（确认见 `flowgram-adapter/free-layout-editor/package.json` 的 20 个 `@flowgram.ai/*` 依赖）。它是一个**自由布局节点引擎**：节点可在无限画布上随意摆放（`free-auto-layout-plugin`、`free-snap-plugin` 对齐、`minimap-plugin` 小地图、`free-container-plugin` 分组、`free-lines-plugin` 贝塞尔/折线/箭头连线、`free-stack-plugin` 层级）。Coze 自己的 `render` 包叠了画布层（`background-layer / hover-layer / lines-layer / shortcuts-layer`）和**端口渲染** `WorkflowPortRender`：端口（`WorkflowPortEntity`）是可拖拽圆点，输出端口 `onMouseDown` 调 `dragService.startDrawingLine` 开始拉线，输入端口不可拉；端口带 hover/linked/error 态与 tooltip。节点配置面板则由每个节点的 `FormMetaV2.render` 用 React 组件渲染（`with-node-config-form` HOC），字段类型集中在 `setters` 包（array/boolean/enum/enum-image-model/number/string/text）和 `node-registries/common/fields/`。

## 六、【对「无限画布广告生产」的借鉴价值】

✅ **可直接借鉴**
1. **节点注册表范式**（`WorkflowNodeRegistry = type + meta + formMeta`）清晰、可扩展，新增节点只需加一个 registry 文件；`FormMetaV2` 用 init/submit 双向转换统一「前后端数据映射」。
2. **引用式数据流**而非「连线即传值」——节点输出发布到作用域、下游用表达式引用，非常适合广告流水线里「任一节点的产物被多个下游复用」（一张图被文案/合成/审核多处引用）。
3. **多媒体类型原生入枚举**（Image/Video/Audio/Svg/Ppt… + 数组）+ 结果面板自动展开图片，与「图片/视频良好可视化」高度契合。
4. **单节点调试 `WorkflowNodeDebugV2`** 直接满足「框选中间节点单独运行」。
5. **动态端口（`useDynamicPort`）**可用于「条件分支/多产出」类节点。

⚠️ **与诉求冲突 / 需改造**
1. **强制单一 Start/End**（`isStart/isNodeEnd`、不可删、只有单向端口）——与「不必强制从开始连到结束」冲突。要做松散画布，需放开此约束（允许多入口/无入口/孤立片段运行）。
2. **部分运行粒度有限**：仅支持「单节点」或「整流」，未见「框选任意子图批量跑」的现成能力，需自研（可复用 `WorkflowNodeDebugV2` 的 input 注入模式扩展为多节点批跑）。
3. **数据流绑死引用结构**（`block-output` 靠 blockID），广告场景下若要更松散的「素材即节点」，可能需要把文件/媒体作为一等变量挂在全局作用域而非节点输出。
4. **引擎是 FlowGram（非自研）**：能力强但要吃透其插件体系；若想完全自主可控，可借鉴其分层（core/document/form/renderer/variable-plugin）自研或直接 fork。

---

## 附：实际阅读过的关键文件（证据）

- `README.md`（确认 React+TS、FlowGram 引擎、Go+Eino 后端）
- `rush.json`（259 包定位，确认 workflow 子包路径）
- `frontend/packages/workflow/nodes/src/typings/node.ts`
- `frontend/packages/workflow/nodes/src/workflow-json-format.ts`
- `frontend/packages/workflow/base/src/types/node-type.ts`（StandardNodeType 枚举）
- `frontend/packages/workflow/base/src/types/view-variable-type.ts`（ViewVariableType 媒体类型）
- `frontend/packages/workflow/base/src/types/registry.ts`（NodeMeta / WorkflowNodeRegistry）
- `frontend/packages/workflow/base/src/types/dto.ts`（NodeDataDTO / VariableMetaDTO / RefExpression / AssistTypeDTO）
- `playground/src/node-registries/{code,if,image-generate,start,end}/node-registry.ts`
- `playground/src/node-registries/code/form-meta.tsx`（FormMetaV2 范式）
- `playground/src/nodes-v2/llm/llm-node-registry.ts`
- `playground/src/node-registries/code/types.ts`、`start/types.ts`（FormData 形状）
- `playground/src/services/workflow-operation-service.ts`（testRun / testOneNode / getProcess）
- `playground/src/services/workflow-run-service.ts`（testRunOneNode / isSingleMode / loop）
- `playground/src/entities/workflow-exec-state-entity.ts`（isSingleMode 字段）
- `render/src/components/workflow-port-render/index.tsx`（端口拉线渲染）
- `render/src/layer/{background,hover,lines,shortcuts}-layer.tsx`
- `fabric-canvas/package.json`（Fabric.js 6，仅图像画布节点）
- `flowgram-adapter/free-layout-editor/package.json`（@flowgram.ai/* 20 插件）
- `variable/src/form-extensions/variable-providers/provide-node-output-variables.tsx`（/node/outputs 作用域）
- `variable/src/form-extensions/variable-consumers/consume-ref-value-expression.ts`
- `playground/src/node-registries/image-canvas/components/index.tsx`（图层合成节点）
- `playground/src/typing/index.ts:212`（"all image streams are expanded" 图片预览）
