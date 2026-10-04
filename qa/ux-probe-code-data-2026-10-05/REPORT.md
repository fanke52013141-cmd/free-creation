# 全节点测试与代码/数据节点 UX 深度探针报告（2026-10-05，真实 Electron 桌面）

本次工作分两层：

1. **全节点操作矩阵**（`scripts/audit-node-operation-matrix.cjs`）：在隔离数据目录的真实 Electron 里逐节点验证「创建 → 契约端口 → 诚实拦截 → 配置 → 连线 → 运行 → 失败有因 → 保存重载不丢」。修复门禁与产品缺陷后 **254/254 全部通过**（证据：`artifacts/node-matrix-2026-10-04T16-50-41-859Z/`，含逐项截图与磁盘真值）。
2. **代码/数据节点 UX 深度探针**（本目录 `probe.cjs`）：矩阵回答「能不能用」，探针回答「用起来顺不顺」，覆盖错误反馈质量、调试手段、复制反馈、文档承诺一致性。13 项观察 + 13 张截图，3 项体验缺口当场修复并复测。

## 一、发现并已修复的真实产品缺陷

### D1（P1）代码节点动态端口在同类型端口存在时不可达
- **现象**：代码节点声明自定义参数后，UI 承诺「画布上会出现同名输入端口」。参数类型为「任意」时端口能出现（共享 any 组锚点）；但参数改成 JSON/文本等类型后，端口圆点消失——`createNodePortLayout` 每个类型组只渲染一个代表端口，参数端口被先声明的 `in-json` 挡住，**用户无法把第二路 JSON 连到参数上**。同类型多输出字段同理。
- **根因**：`src/renderer/src/canvas/node-port-layout.ts` 的类型组合并策略没有豁免 `resolvePorts` 动态生成的端口；而 `getNodePorts` 的注册例外明确承诺代码节点「每个字段仍有独立、稳定的端口 ID」。
- **修复**：新增 `dynamicPortIdsForShape`（`graph.ts`），把动态端口传入 `createNodePortLayout` 的 `forcedPortIds`——强制端口不并入类型组、始终渲染、各自独立锚点。`NodeCardView`（渲染）、`DataEdgeLayer`（连线锚点）、`graph.ts` 三处调用点（建连、批量、落点解析）全部同步，锚点与圆点位置严格一致。
- **验证**：矩阵代码配方全绿，包括「many 参数接第二路同类型输入」「多输出字段分别流入下游」；单元测试 `node-ui-decisions` 新增独立锚点断言。

### D2（P2）代码节点 console.log 输出无处可见
- **现象**：桌面端没有可打开的开发者工具，用户代码里 `console.log("调试信息")` 运行成功后界面毫无痕迹——代码节点唯一的调试手段是断的。
- **修复**：Web Worker 内捕获 console（log/info/warn/error，上限 50 条、单条 500 字符防死循环撑爆），随结果/错误一起 postMessage 回传；执行器写入 `meta.nodeResult.logs`；代码卡片新增 `.code-result-logs` 调试输出块（失败时同样显示）。探针 DOM 级验证：logs 块=1、内容="调试信息XYZ"。

### D3（P2）运行时错误无行号
- **现象**：`return x.deep.field` 抛 `Cannot read properties of null (reading 'deep')`——用户不知道错在哪一行。
- **修复**：Worker 捕获堆栈中用户函数帧的行号（折算 "use strict" 前缀偏移），错误信息追加「（第 5 行附近）」。探针复测反馈变为 `Cannot read properties of null (reading 'deep')（第 5 行附近）`。

### D4（P3）结构数据节点复制无反馈
- **现象**：点击 `{{text}}` 占位符或字段路径只写剪贴板，无任何提示；用户不确定是否复制成功。
- **修复**：复制后 toast「已复制 {{text}}」/「已复制 路径」，与 JSON 节点复制行为一致。探针复测通过。

## 二、节点矩阵门禁修复（测试代码，非产品）

2026-09-27 端口分组（fb12c06）与 AppSelect 替换原生 select 后，矩阵脚本大面积过时失效（首跑 168/191，23 失败中仅 4 类是真问题）：

| 类别 | 修复 |
|---|---|
| 端口空闲态断言（8 项） | `checkPorts` 期望改为「空闲态只显示首个类型组代表端口」；连线步骤仍会真实命中并验证隐藏端口 |
| AppSelect 交互（11 处 selectOption） | 新增 `pickOption`：点触发器 → 等 portal 中 role=option → 按可见文本选择 |
| 拖线时端口才显现（connect） | `connect` 改为拖动开始后再取目标端口坐标（候选渲染需要 draft 状态）；源端口隐藏时自动走用户可达的反向拖线路径 |
| 人声分离退役配方 | 改为验证「创建入口不再出现」（`nodeButtonAbsent`），与 2026-09-25 退役决定一致 |
| 导演台按钮选择器 | `title` → `aria-label`（发布/关闭按钮） |
| 文本节点空态/就绪预检 | 空态断言改为「输入文本」按钮；空正文运行断言改为「待补充」置灰拦截（T06 预检的新行为） |
| 回到主页点击偶发超时 | 三级降级点击（常规 → Esc 清浮层重试 → force） |

修复后全量重跑 **254/254**（检查数从 191 涨到 254：此前中断的配方现在能跑完全程，如 JSON 双输入优先级、代码多输出消费链、停止/续跑/重启恢复）。

## 三、代码/数据节点可用性总评（探针结论）

| 维度 | 评价 | 证据 |
|---|---|---|
| 错误反馈 | **良好** | 语法错误、类型不符（"应返回字符串"）、禁用 API（"代码节点不支持网络访问"）、超时（"代码执行超时（10 秒）"）、JSON 非法（徽标+tooltip 含原因）、处理节点字段路径缺失（报出具体路径）全部即时且说人话；本轮补上行号 |
| 调试手段 | **本轮前缺失，已修复** | console.log 捕获显示；死循环 11s 明确报超时；确定性运行时（dayjs 固定 1970）已在代码模板注释说明 |
| 数据安全 | **良好** | 媒体引用不允许伪造（必须来自输入资产）；网络/模块/动态执行三层封锁；参数重命名端口 ID 稳定（`in-param-param1` 不随名字漂移，已连线不破坏） |
| 可发现性 | **本轮前有缺陷，已修复** | 参数端口常显；隐藏类型端口拖线时显现 + 落点自动磁吸改连有 toast 解释 |
| 大数据 | **可接受** | 60 项列表渲染截断提示「还有 20 项未显示」；结构数据字段树限 24 条 |

**总体判断：代码/数据节点矩阵级功能全部可用，主要体验缺口（调试输出、错误定位、端口可达性、复制反馈）已在本轮修复。**

## 四、遗留建议（未在本轮处理）

| 编号 | 观察 | 建议 | 严重度 |
|---|---|---|---|
| R1 | 空代码节点运行按钮可点，点击后才报「请输入要执行的代码」 | 就绪预检把「源码为空」作为 config-missing 呈现（需 readiness 接收 config） | P3 |
| R2 | dayjs() 返回 1970-01-01：模板注释已说明，但运行结果旁无即时提示 | 结果条 hover 说明或首次固定时间输出时 toast | P3 |
| R3 | tldraw CDN 资源离线不可达产生 7876 次「source image cannot be decoded」异常（矩阵脚本已豁免为已知噪声） | 内置 tldraw 资源到本地包（AGENTS.md 已列离线方向） | P2 |
| R4 | JSON 错误 tooltip 内容较技术（原始 Parser 错误） | 已有行号徽标；如需更友好可映射常见错误措辞 | P3 |

## 五、证据清单

- 全量矩阵：`artifacts/node-matrix-2026-10-04T16-50-41-859Z/`（254/254，截图 + tldrawSnapshot 磁盘真值）
- 探针：本目录 `probe.cjs`、`findings.json`、`shots/01–13`
- 单元测试：`node-ui-decisions.test.ts` 新增动态端口独立锚点断言；`canvas-ui-interactions.test.ts` 同步分组断言
- 修复涉及源码：`node-port-layout.ts`、`graph.ts`（`dynamicPortIdsForShape`）、`NodeCardView.tsx`、`DataEdgeLayer.tsx`、`codeRuntime.ts`（console 捕获 + 行号 + `CodeRunResult`）、`executor-types.ts`（runCode 类型加 logs）、`executors/code.ts`（logs 持久化）、`bodies/code.tsx`（logs 块 + 模板说明）、`bodies/structured.tsx`（复制 toast）、`app.css`（`.code-result-logs`）
- 日志影响检查：console 捕获属于业务结果（meta.nodeResult）而非诊断日志，未记录提示词/回复/密钥；`npm run verify:logging` 通过；`eslint` 无新增告警
