# 画布原生 Agent Flow：当前状态

> 当前口径（2026-11-26，基线 `57a7e60d`）：本页只做导航与状态摘要，不维护能力清单。现行规范是 [AGENT_FLOW_SPEC.md](../AGENT_FLOW_SPEC.md)，开发状态以 [BACKLOG.md](../BACKLOG.md) 为准，可调用操作与节点集合以 [`generated/contracts.json`](../local-agent-access/generated/contracts.json) 和运行时 `capability.list` 为准。`archive/` 只用于追溯，不得作为当前规范或能力矩阵。

## 1. 权威与阅读顺序

| 文件 | 用途 |
| --- | --- |
| [AGENT_FLOW_SPEC.md](../AGENT_FLOW_SPEC.md) | Agent Flow 语义、执行模式、输入/交付、审核返工、角色与外部接入的现行规范 |
| [BACKLOG.md](../BACKLOG.md) | BL 系列开发状态、验收证据与未闭环项 |
| [机器契约](../local-agent-access/generated/contracts.json) / `capability.list` | 操作、节点与运输面的机器真值；数量不在 Markdown 手写 |
| [日志覆盖清单](../LOGGING_COVERAGE.md) | 各执行/模型/异步/文件/保存路径的实际日志覆盖与盲区 |
| [节点协同规范](05-node-coordination-standard.md) / [AI 审核节点](07-ai-review-node.md) | 配套说明；与 AGENT_FLOW_SPEC 冲突时以后者为准 |
| [历史归档索引](archive/README.md) | C/R/AF 阶段交付、交接与审查证据，仅用于追溯 |

## 2. 当前实现状态

- **画布唯一定义**：FlowGraph 是编译输入与版本快照，不建立第二份可编辑任务拓扑；模型文字不能赋予成功或改变路由。
- **执行模式**：`graph` 使用声明式路由；`fixed-order` 编译为线性路由并共用就绪/分派/完成处理；`model` 仅作探索模式，不作为可复现交付模板。
- **FlowGraph v2**：`capabilityRef`、能力目录、`params`、真实端口、子图循环、`executor × decider`、`roles[] / humanRole` 已落地。`params` 只覆盖已登记的公开配置子集，不可调度能力仍明确拒绝。
- **运行准入**：Agent/Review 的模型、工具、范围、审核来源与门禁在 propose/commit 前校验；缺失绑定不再留到首次运行。
- **路由与输入**：条件分支、otherwise、死路径 `skipped`、all/any 汇合、有界多节点循环与停滞判定已实现。声明 `inputs` 时生成 ContextManifest；未声明时沿用路由后的固定输入。
- **人工与媒体**：human-task 支持 `text / json / image / video`，媒体以项目媒体 ID 固定提交；音频结果类型仍未定义。
- **审核返工**：固定版本审核、显式 rework 控制关系、局部返工与下游 stale 已实现；新配置返工上限统一为 0–3、缺省 3，历史配置读取截断到 3。
- **角色化单用户**：角色归属取节点 `humanRole`，收件箱按角色分组，角色视图只是筛选器；不引入登录、多身份或权限系统。
- **外部接入**：`flowAgent.*`、`flowGraph.*`、`flowGraphDefinition.*`、`humanTask.*`、`flowStateMachine.*` 共用同一宿主。人工决定类操作采用桌面实时确认，未做持久草稿队列。
- **headless 节点流键约定**：`inputs` 使用 `in-<id>`；`outputs` / `outputValues` / `resubmit` 统一使用 `out-<id>`，旧裸 id 仅读取兼容。

## 2.1 C0 测试专用资产

- **决策：保留，不删除。** [`src/main/agent-flow/c0/`](../../src/main/agent-flow/c0/README.md) 与对应脚本/测试仍是活跃测试基础设施：16 项单测覆盖 checkpoint、命令回执、人工等待与诊断隔离；双进程 Electron pause/resume 用例仍验证跨进程恢复且工具效果计数为 1。
- **边界**：C0 只使用隔离数据库、隐藏 fixture 窗口和确定性模型，不注册生产节点、不打开产品项目库、不调用真实供应商；不得作为新功能入口或生产真值。
- **删除条件**：独有覆盖已迁移到正式测试、双进程恢复用例已有替代且持续通过、所有构建/脚本/文档引用清理完毕，并在同一变更中通过完整验证。详见 [C0 README](../../src/main/agent-flow/c0/README.md)。
- **迁移影响**：现在不移动到 `test/fixtures`；该动作会同时影响测试导入、shared 契约、Electron 独立构建入口、产物名、npm 脚本与 native ABI 运行方式，需另开变更处理。

## 3. 已验证与未证明

| 证据层级 | 当前口径 |
| --- | --- |
| 确定性单测 / 宿主测试 | 覆盖路由、编译、账本、准入、预算、恢复与输出投影；不证明真实模型或 GUI 成功 |
| 三入口定义走查 | 证明 GUI/CLI/MCP 对同一契约的读写一致；不等于真实鼠标共创或真实供应商调用 |
| 真实桌面自动驱动 | 已有分段 Electron/CLI/MCP 路径；必须逐项标明是否使用模型夹具、是否人工点击 |
| 真实 GUI 鼠标 / 真实模型 / 安装包 | 仍须按具体路径单独验收，不能由上述层级外推 |

历史 AF-00～AF-07 七包已实施，但[交付备注](archive/51-af01-07-delivery-2026-11-13.md)明确记录：当时未做真实模型固定顺序长任务、真实 GUI 鼠标共创和完整 `npm run verify`。这些记录是历史证据，不是当前完成度声明。

## 4. R 系列与审查遗留边界

R 系列不能整体称为“全部验收”：R09（真实磁盘/物理掉电/目录耐久/远端撤回）、R11（真实供应商质量、计费与远端取消）、R12（最终发布门禁与线上同步）仍未闭环。精确口径见[历史总台账](archive/38-agent-completion-plan.md)与 [BACKLOG](../BACKLOG.md)。

2026-11-26 外部审查见[审查报告](audits/agent-flow-external-agent-review-2026-11-26.md)。报告是审查时快照；后续工作区修复是否完成，以最终测试、BACKLOG 和提交为准，不把审查结论或未提交修复直接当作当前验收结果。

## 5. 历史文档使用规则

- [archive/49-af00-baseline-and-sample-2026-11-13.md](archive/49-af00-baseline-and-sample-2026-11-13.md) 的 §2 是 2026-11-13 时点快照，不是当前唯一矩阵；其中数量、支持状态和“当前”只代表当时。
- 年表、交接中的“最新”“当前”“未提交/推送”“下一步”均为该文档时点记录。当前状态只读本页、AGENT_FLOW_SPEC、BACKLOG 与机器契约。
- 新增阶段交付、审查或交接文档时，必须标明日期、基线、证据层级和未覆盖边界，并登记到[归档索引](archive/README.md)。
