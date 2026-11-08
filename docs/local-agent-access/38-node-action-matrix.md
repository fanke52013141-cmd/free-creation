# F9 逐节点动作矩阵：把"还差多少"变成可审计数字

日期：2026-11-08。对应 [16 号节点动作表](16-node-action-coverage.md) 的 N1–N8 与
[AGENT_PARITY_SPEC](../../AGENT_PARITY_SPEC.md) §4（开发状态必须可机器读取）。

## 1. 改之前的问题

`node.type.list` 对全部 32 类 Active 节点一律返回：

```json
{ "typeId": "text", "actions": "planned", "reason": "NODE_ACCESS_NOT_IMPLEMENTED" }
```

但事实上 `text`/`image`/`chat`/`director` 等已在真实桌面逐动作验收过。于是：
- 发布报告里"按节点×动作算覆盖率"给不出可信数字；
- 想确认"某类节点的哪个动作还没做"只能翻台账；
- 占位值与现实不符，属于规范明确反对的"把 planned 当挡箭牌"。

## 2. 现在的机器目录

新增 `src/shared/agent-access/node-actions.ts`：
- `NODE_ACTION_IDS = N1..N8` + 每个动作的中文含义；
- 状态枚举：`desktop-tested`（真实 Electron 里程碑有对应检查）/ `contract-tested`（服务级或契约
  级测试）/ `implemented`（有实现但缺可复核证据，**门禁直接拒绝**）/ `planned`（未接通）/
  `not-applicable`（不适用，必须写理由）；
- 每格都带 `evidence`（台账路径、测试文件或里程碑段落），**空证据或过短证据门禁失败**；
- `node.type.list` 输出改为：逐节点 `contractVersion` + 8 个动作状态与证据 + 每节点汇总，
  以及全局汇总 `{nodes, actions, byStatus}`；
- `validateAccessRegistry()` 追加 `validateNodeActionMatrix()`：缺类型、缺动作、非法状态、
  无证据、`implemented` 长期悬挂都会阻断门禁。

当前真实数字（由 `node.type.list` 的 `summary` 直接给出）：**32 类 × 8 动作 = 256 格**，
其中 `desktop-tested` 是里程碑真实覆盖到的格子（文本流程、媒体本地族、对话、导演台发布、
音频族门禁等），其余多为 `contract-tested` 或 `planned`。**没有 `implemented` 悬挂项**。

## 3. 这次填格子时刻意守的边界

- 服务级测试**不写成** `desktop-tested`（例如 processor/json/structured 的执行没有桌面逐动作证据）；
- "有执行器"不等于"外部可执行已验收"：付费族（image-gen/image-edit/video/speech/tts/voice-design/
  video-depth/video-clay）统一标 `planned`，理由写明"付费执行从未实测（无预算），且用户要求
  语音克隆/音色设计/视频生成只做代码层接通、由用户自行测试"；
- 音频三族（speech/tts/voice-design）的 N2/N3/N5 标 `desktop-tested` 是**门禁语义**而非产出语义：
  里程碑验证的是"外部能创建、GUI 可见、缺模型时在付费调用前如实跳过、零副作用"，
  证据里写清了这一点，不冒充"生成成功"；
- Agent/状态机/审核三类：外部不能伪造内部运行身份；状态机与审核的 N2/N5/N7 标 `planned`，
  N8 标 `not-applicable` 并给理由。**agent 节点的 N5/N7 已在 F8 第二批升级为 `contract-tested`**
  （`flowAgent.run/pause/stop` 经共享宿主端口执行、预检失败零模型请求；真实长任务未实测，
  见 [40 号台账](40-flow-agent-run-delivery.md)）。

## 4. 顺手修的基础设施问题

`scripts/check-agent-access.cjs` 的 TS 钩子原先只能解析相对路径，操作登记文件一旦复用工作区
共享契约（如 `@free-creation/model-contracts` 的 zod Schema）就会 `MODULE_NOT_FOUND`。
现在钩子按 `tsconfig.node.json` 的 `paths` 解析（`@shared/*`、`@free-creation/*`），
于是**外部 Schema 可以直接复用 GUI 同一份契约定义**，不需要为了能在门禁里跑而复制一份而漂移。
该解析只在维护脚本进程内生效，不影响应用运行时。

## 5. 验证

- `test/local-agent-access.test.ts` 更新断言：32 类目录、每类 8 个动作、状态枚举合法、
  证据非空、每类节点不允许"整行 planned"；
- `test/local-agent-parity.test.ts` 更新断言：`node.type.list` 与目录逐字节一致、
  全局汇总的 `actions = nodes × 8`、`byStatus` 求和一致；
- `validateAccessRegistry()` 现在覆盖矩阵自洽性（接入测试与门禁脚本都会调用）。

## 6. 仍未完成

1. **N1 全部为 planned**：外部还无法在"不创建实例"的前提下查询某类节点的默认值/字段/端口/依赖。
   这需要 F1 遗留的"共享节点契约抽取"（main 不能 import renderer 的 TSX 规格），
   建议做法：用 esbuild 把 specs 打成数据模块生成 `node-contracts.json`，再由新操作
   `node.type.get` 读取；这是下一包的第一优先级（它同时是矩阵里最大的一片空白）。
2. 矩阵里的 `contract-tested` 需要随桌面补验逐批升级为 `desktop-tested`，升级时必须改证据字段，
   不允许只改状态。
3. 发布报告还需要把矩阵汇总接进 F10 的发布清单（现在是 `node.type.list` 的运行时数字）。
