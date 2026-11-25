# BL-40 能力节点上下文补料：现状、缺口与实现选项

日期：2026-11-26（Asia/Shanghai）。状态：**待拍板实现选项**；本文只记录结论与代码事实，未改业务代码。

## 0. 一句话

Agent 阶段的「上下文超限 → 人工补料 → 继续」已端到端可用；**能力节点（capability 图节点）还差最后一段**：它能进入超限等待，但补料没有进入 `node.execute` 的入口，且总览投影刻意不暴露这类等待。缺口不在 UI 表单，而在「能力节点的输入只有固定资产引用，没有承载自由文本的通道」。

## 1. 代码事实（2026-11-26 复核）

| 位置 | 现状 |
|---|---|
| `src/shared/agent-flow/context-manifest.ts:136` | `overflow: 'ask-human'` 且 `humanMaterial` 非空时，用 `human:context` 单条文本重建清单，预算内则返回替换清单 |
| `src/main/agent-flow/coordinator-host.ts:1420` | `dispatchCapability` 调用 `buildContextManifest` 时**没有传 `humanMaterial`**（Agent 分支 1000/1275 行有） |
| `src/main/agent-flow/coordinator-host.ts:1421` | 能力节点超限时已调用 `waitForContextBudget`，即**等待本身已打通** |
| `src/main/agent-flow/coordination-store.ts:341-345` | 投影 `contextMaterialWait` 时**显式排除 capability 节点**，所以总览拿不到等待态、表单不出现 |
| `src/main/agent-flow/coordinator-host.ts:1430-1472` | 能力节点输入是 `assets.submit` 产生的固定资产引用（`FixedNodeInputSchema`），**没有 text 值通道** |
| `src/shared/agent-flow/commands.ts:18-66` | `node.execute` 只有 `inputs: FixedNodeInput[]` 与执行信封，没有原始文本字段 |

结论：需要一次**协议层小扩展**或一个**资产化方案**，二选一。

## 2. 实现选项

### 选项 A（推荐）：`node.execute` 增加可选 `contextMaterial`

- 命令新增 `contextMaterial?: { portId: string; text: string }`（≤ 预算，缺省无）。
- 协调器在能力节点补料续跑时，把人工材料映射到该节点**第一个文本类输入端口**（从节点契约 ports + `next.inputs.selectors` 推导；无文本端口时直接拒绝并提示）。
- 渲染器执行节点时，为该端口注入一个 `kind:'text'` 的固定输入覆盖（优先于资产引用），并写入运行记录（人工来源）。
- 预算用替换后的 ContextManifest 重新校验；等待键/上限在成功分派后清空；总览把 capability 纳入 `contextMaterialWait`。
- 成本：命令 schema + 协调器 + 渲染器执行装置 + 单测/桌面验收；**不新增外部操作**（`node.execute` 是内部 Agent 工具，不是 CLI/MCP op，parity 只需跑三关确认无契约变化）。

### 选项 B：把人工材料资产化

- 新增「human:context 文本交付」入口，`FlowAssetStore` 登记一条文本资产版本，能力节点按正常固定输入消费。
- 优点：完全复用资产版本/审计语义；缺点：资产存储基于已保存画布投影，需要合成节点或迁移，改动面比 A 大。

### 选项 C：缩小承诺

- 明确能力节点只支持 `fail` / `summarize`，`ask-human` 仅适用于 Agent 阶段；改规范与界面提示，BL-40 以「能力节点 ask-human 明确拒绝」收尾。
- 成本最小、语义最诚实；但用户最初要的是「任何阶段都能补料」。

## 3. 推荐

选 **A**：与 AF-10.4 的目标语义一致（人工提交精简材料后从当前阶段继续），协议改动是内部可选字段、向后兼容，且能复用现有等待/修订/预算机制。实现顺序：

1. `NodeExecuteCommand` 增可选字段 + 契约测试；
2. 协调器：能力节点补料续跑时传 `humanMaterial`、映射端口、清等待键；store 放开 capability；
3. 渲染器：`node.execute` 注入文本覆盖并记录人工来源；
4. 定向测试 + 桌面端到端（超限 → 总览表单 → 提交 → 能力节点完成 → 下游交付）；
5. 规范 AF-10.4 从【目标】改【现行】，BACKLOG BL-40 勾选。

## 4. 需要拍板

选 A / B / C？若选 A，确认「多文本输入端口时取第一个文本端口」这一默认（或要求作者在 `inputs` 里声明 `materialPortId`）。