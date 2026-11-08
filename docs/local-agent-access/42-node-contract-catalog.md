# N1 交付：节点类型契约目录（不创建实例就能查端口/默认值/依赖）

日期：2026-11-08。对应 [16 号节点动作表](16-node-action-coverage.md) 的 N1，也是
[38 号矩阵](38-node-action-matrix.md) 里最大的一片空白（32 类节点的 N1 全是 `planned`）。

## 1. 为什么这件事一直没做（以及为什么现在能做）

节点定义在 renderer 的 TSX 模块里（`src/renderer/src/nodes/specs/*`），会间接拉入
React/tldraw 与节点 Body 组件；main/CLI 不能导入它。于是外部 Agent 只能"先建一个节点再
`node.get` 猜端口"，而真正需要它的场景恰恰是**建节点之前**：选类型、看端口、看初始配置。

本轮的做法不是把 React 塞进 main，而是**生成快照 + 漂移门禁**：

1. `test/node-contracts-export.test.ts`（jsdom 环境）加载真实节点注册表，用与 GUI 相同的
   `getNodePorts()` 导出契约，写成 `src/shared/agent-access/generated/node-contracts.generated.ts`；
2. 该测试在普通 `npm test` 运行时是**门禁**：注册表改了却忘记重生成快照 → 立即失败
   （所以快照不可能悄悄过期）；
3. main 侧 `node-contracts.ts` 只读这份生成常量，新操作 `node.type.get` 返回真实契约。

生成方式（提交前必须跑，否则门禁红）：

```
$env:CANVAS_NODE_CONTRACTS_WRITE=1; node scripts/run-vitest.cjs run test/node-contracts-export.test.ts
```

## 2. 对外能力

`node.type.get`（read，输入 `{typeId}`）返回：

| 字段 | 用途 |
| --- | --- |
| `contractVersion` | 判断是否需要迁移 |
| `ports.in/out[]`（id/type/required/cardinality/schema/name/description） | 连线前就能确定端口、基数与 Schema（如 `voice.profile@1`） |
| `initialConfig` | GUI 创建该节点时写入的初始配置（JSON 字符串），外部建节点应据此对齐默认值 |
| `executionMode` | `auto` / `manual-publish`（导演台这类不能由普通执行触发的节点提前可见） |
| `outputSource` | `run`（跑完才有输出）还是 `document`（正文即真值） |
| `dynamicPorts` | **关键诚实标记**：true 表示端口随配置变化，本记录只是默认配置下的结果，实例端口必须用 `node.get` 读 |
| `creatable` / `sizePolicy` / `category` / `description` | 创建入口与用途说明 |

同时把 `node.type.list` 的 N1 状态从 `planned` 升级为 `contract-tested`（32 类同时生效），
矩阵自洽门禁与契约快照门禁都接进 `validateAccessRegistry()`。

## 3. 真实验证

- `test/node-contracts-export.test.ts`（jsdom）：生成 + 漂移门禁 2 项通过；
- `test/local-agent-node-contract-access.test.ts`：6 项通过，覆盖
  文本节点契约/动态端口标注/manual-publish 执行方式/JSON 端口 Schema/未知类型拒绝/
  **32 类全部可查询且 N1 不再是 planned**；
- `node.type.get` 出现在 Registry（98 → 99 项操作，计入后续批次刷新）；
- `validateAccessRegistry()` 现在同时校验：矩阵自洽 + 契约快照覆盖全部 Active 节点。

## 4. 边界

1. **动态端口只导出默认配置那一组**：`speech`/`code` 等节点的端口随配置变化，
   外部要拿"配置后的端口"仍需创建实例后 `node.get`（或在 GUI 配置面板查看）。
   这是当前架构的诚实边界，不伪造"全配置覆盖"。
2. 导出的是**创建时**的初始配置，不是用户改过的配置；后者属于实例状态。
3. 快照文件是生成物：任何节点契约变更都必须重跑生成命令并提交，
   否则 `npm test` 与 `verify:agent-access` 任一都会报不一致。
4. 仍未做：把同一快照接进发布报告的"节点×动作"统计口径（F10），
   以及 `node.type.get` 的桌面段（本能力不依赖桌面，服务级即可判定）。
