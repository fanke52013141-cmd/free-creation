# 本地外部 Agent 接入：当前入口与状态

> 当前口径（2026-11-26，基线 `8c5c155e`）：GUI／CLI／MCP 业务能力一致是持续维护目标，不代表所有动作均已验收。操作与节点清单的机器真值是 [`generated/contracts.json`](./generated/contracts.json)，运行时枚举以 `capability.list` 为准；本文不手写数量。

## 权威与阅读顺序

| 文件 | 用途 |
| --- | --- |
| [一致性规范](../../AGENT_PARITY_SPEC.md) | 完整目标、三个入口同源、后续功能同包维护与发布要求 |
| [本地外部接入规范](../../AGENT_ACCESS_SPEC.md) | 边界、架构、协议、版本、运行、保存、导出与本地安全 |
| [能力矩阵](./02-capability-matrix.md) | 业务动作与节点适配的说明；当前可调用集合以机器契约为准 |
| [同步维护与强制门禁](./03-change-enforcement.md) | 如何避免桌面功能改了、Agent 接入没有跟着改 |
| [完整开发计划](./15-gui-cli-mcp-parity-plan.md) | 现状、架构、多画布、F0–F10 落地与验收 |
| [节点动作计划](./16-node-action-coverage.md) | 每个节点必须接入的编辑、执行、结果和专有动作 |
| [详细测试计划](./66-parity-test-plan.md) | 分层验收、必测场景、故障/人工/付费专项与发布判据 |

## 当前已实现的主路径

- **统一契约与入口**：Operation Registry、main Dispatcher、CLI 与 MCP stdio/SSE 适配均已实现；三者派生同一操作目录。应用 REST HTTP API 仍未实现，也不是本目标前提。
- **项目与传输**：项目查询、新建、打开、元数据修改、保存、重命名、复制、预检删除、导出，以及 `project.import` / `project.importStructure` / `library.import` / `library.export` 已实现。包路径、重映射、凭据剥离、事务与失败边界见[包传输台账](./24-transfer-delivery.md)。
- **画布与节点**：`graph.get` / `graph.patch` / `graph.validate`、节点创建/读取/更新/删除/连线、`node.execute`、运行查询/等待/取消/核对、输出读取与布局操作已接入；逐节点、逐动作的可用性仍以机器契约和验收记录为准。
- **Agent Flow 与状态机**：`flowAgent.*`、`flowGraph.*`、`flowGraphDefinition.*`、`humanTask.*` 已接入；`flowStateMachine.submitEvent` / `flowStateMachine.get` 已实现，外部事件与 GUI 提交按钮写入同一待处理事件，不能直接设置状态；外部人工事件需桌面确认。
- **headless 节点流**：`composite.execute` 等独立路径已实现，不依赖项目或画布实例；`inputs` 使用 `in-<id>`，`outputs` / `outputValues` / `resubmit` 使用 `out-<id>`，旧裸 id 仅读取兼容。`composite.run.submitHuman` / `composite.run.resubmit` 属于人工决定，需目标项目在桌面打开并人工确认。

## 交付与证据

| 主题 | 记录 |
| --- | --- |
| A0+A1 最小包 | [05 交付台账](./05-a0-a1-minimal-delivery.md) |
| 桌面项目操作 | [06 台账](./06-a1-1-desktop-projects.md) |
| 图与节点访问 | [18 台账](./18-graph-access-delivery.md)、[19 运行台账](./19-run-access-delivery.md) |
| 资源库与包传输 | [23 台账](./23-library-delivery.md)、[24 台账](./24-transfer-delivery.md) |
| Flow Agent | [28 台账](./28-flow-agents-delivery.md)、[29 命令台账](./29-flow-commands-delivery.md)、[40 运行台账](./40-flow-agent-run-delivery.md)、[41 构建台账](./41-flow-agent-build-delivery.md) |
| 三入口门禁 | [33 台账](./33-three-entry-parity-gate.md) |
| 历史能力快照 | [14 号文件](./14-current-capabilities.md)仅保留 2026-11-07 时点内容，不得作为现状 |

## 维护规则

1. 一份公共业务契约承载 UI、MCP、CLI 以及可选 HTTP；不建设第二份画布或独立 headless 运行器。
2. 新增 GUI 业务能力必须同包提供 CLI/MCP 契约、实现与验证；不得只新增 `planned` 声明便发布 GUI 功能。
3. 模型媒体任务复用现有命令账本、租约、固定资产和 unknown 核对；交互型或高风险能力逐项验收。
4. 接入影响检查、Registry 完整性、生成文件一致性、版本差异、桌面一致性和失败恢复形成发布门禁。
5. 文档登记、静态门禁和测试数量都不能替代真实用户路径、真实传输、真实模型或安装包验收。
