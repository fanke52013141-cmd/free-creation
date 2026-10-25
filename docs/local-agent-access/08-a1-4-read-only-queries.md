# A1.4 首包：只读查询与诊断健康

日期：2026-10-24；基线：`71b70f3`。用户授权规划后续并开始开发。本首包源码实现及完整验证已完成；A1.4诊断包等接续范围仍待实施。

优先级调整：用户随后明确只在本地使用，第三方MCP客户端与安装器不作为必做项；当前开发转向[本地功能优先级](../LOCAL_FUNCTION_DEVELOPMENT_2026_10_24.md)。下表保留外部接入的可选路线，不作为本地功能完成标准。

## 后续开发顺序

| 包 | 用户路径与交付内容 | 完成条件 |
| --- | --- | --- |
| A1.4 首包（本轮） | Agent 发现模型 → 检索资源摘要 → 按项目/taskId观察内部 Agent 任务 → 检查诊断记录是否完整 | CLI/MCP 同源；分页、字段白名单、状态真实性、脱敏与日志拒写验证；完整 verify |
| A1.4 接续 | 按时间/项目/任务范围查询诊断摘要，导出安全诊断包 | 复用现有诊断服务；受控目录、不覆盖、25 MiB 上限、二次脱敏；资源包单独验收 |
| A1.5 | 安装正式应用并配置一个第三方 MCP 客户端 | 安装器、精确应用/协议/客户端版本、实际端到端操作及回执 |
| A2 首包 | 在画布创建/编辑文本节点，保存关闭重开，与桌面手动结果一致 | 先抽公共节点纯数据契约；NodeAccessSpec、版本冲突、图命令原子提交和真实桌面回读 |
| A2 扩展 | 逐批适配其余节点的读取/创建/配置/连线与正式结果读取 | 每类型独立标状态；端口、many顺序、正文与配置分离、固定资产和错误路径回归 |
| A3 | 外部提交受支持节点执行并观察/取消/核对 | 扩展正式调用主体、共用账本与桌面执行器；unknown不重放；最小真实供应商验收 |
| A4 | 代码sandbox、导演台人工发布、循环恢复及按需HTTP各自专项 | 保留人工门禁、沙箱和恢复约束；HTTP只在有实际客户端需求时另包验收 |

每包以用户路径和证据关闭；不预先承诺工期或将31类型登记等同可编辑/执行。

## 本轮用户路径与范围

继续使用现有 `--local-agent-access` 显式启动应用和本机连接方式。
新增4项只读操作，CLI/MCP共用Registry和main服务，工具总数由14增至18；原14项输入/输出Schema不变，operationVersion仍为1，属于新增兼容能力。

```text
node out/main/local-agent.js model list --input-file query.json
node out/main/local-agent.js library search --input-file query.json
node out/main/local-agent.js run get --input-file query.json
node out/main/local-agent.js diagnostics summary
```

输入文件为 `{ "input": { ... } }`。只读操作不需要幂等键。

| 操作 | 输入 | 返回事实和明确边界 |
| --- | --- | --- |
| `model.list` | offset默认0，limit默认50、最大100 | 本地模型/连接ID、启用标志、能力验证状态；连接禁用与模型禁用分开；`reachability=not-probed`，不联网、不证明当前在线或密钥有效；每模型最多32项能力，显式`capabilitiesTruncated` |
| `library.search` | query最长300；数字cursor；limit默认40、最大100；includeArchived默认false | 复用桌面`searchResources`，只回摘要ID、标题（最多200字符）、类型、版本、组件数、更新时间和归档标志；不返回组件、正文、媒体路径、metadata或资源包 |
| `run.get` | projectId、taskId | 仅持久化`flow_agent_tasks`，source固定`flow-agent-task`；返回真实state、waitRevision、适用waitKind、stateReason、reconcileRequired；本包allowedActions为空，不开放继续/核对/取消；未找到返回NOT_FOUND；不涵盖节点命令、普通节点运行或模型媒体任务 |
| `diagnostics.summary` | 空对象 | 复用真实诊断服务健康计数：可用性、降级、收写/队列/丢失/失败/坏行数；服务缺失明确available=false、degraded=true；不返回incident明细、事件、路径或诊断包，不代表业务执行成功 |

查询不调用模型、不打开/保存画布、不写业务回执、不改变任务状态。诊断计数随查询的开始/终态事件变化，CLI与MCP不要求计数逐值一致。资源标题属于显式查询返回的用户内容，永不进入诊断日志。

## 接入与日志影响检查

- 公共拥有者：模型沿用`SqliteModelHost`，资源库沿用`searchResources`，任务由`FlowTaskStore.summary`投影，诊断由启动时注入的`DiagnosticsService.health`提供。CLI/MCP只传输，无独立数据库/执行实现。
- 修改范围：Registry、main接入查询/分发、宿主启动注入、模型与任务仓库只读投影、接入验收脚本、生成契约与影响声明。同步门禁新增模型宿主、资源库仓库、诊断服务受保护路径。
- 版本/占用/恢复：无写入，无图版本CAS或破坏性确认；查询仍绑定实例/dataStore，任务按projectId+taskId定位。不会把读取失败变成成功或建议重放；终态任务不因历史wait_kind残留而误报等待/核对。
- 日志：继承`LocalAccessService.dispatch`公共`agent.access.started`与唯一终态；新操作不另写终态，不记录搜索词、目录内容、任务正文、模型配置和诊断明细。失败阶段为validate/read/flow-task-read/storage，错误只回稳定code和phase。
- 输入和输出均严格Schema；列表有分页上限；模型验证消息、连接地址/headers/metadata、资源组件、任务snapshot/skills/code/outputRefs、诊断incidentLog不进入响应。查询仅输出白名单；未知内部错误回安全STORAGE_UNAVAILABLE。
- 日志拒写不得改变查询结果；实例和Schema检查继续复用公共入口。没有新增迁移、网络请求、计费任务、文件导出或UI变更；不涉及节点交互/颜色/图执行协议。

## 验证记录

- `npm test -- test/local-agent-access.test.ts`：33项通过（包含5项新增查询场景）；覆盖分页、禁用连接、验证失败/未验证、资源归档、跨项目任务隔离、人机等待/核对与终态、字段白名单、严格输入和日志拒写。
- `npm run typecheck:node`：退出0。依赖按`pnpm install --frozen-lockfile`补齐MCP SDK，不改变锁文件。
- 完整`npm run verify`：`qa/verification/run-dRDuuy/status.json`为passed、退出0（北京时间19:41:18–19:56:20）。2504项单元通过/5项既有跳过，model-runtime 2项，lint、node/web/model类型、日志与接入门禁、浏览器交互、构建、全部Agent Flow桌面专项与R09可靠性通过。
- 源码真实CLI/MCP闭环：`qa/verification/run-dRDuuy/qa/local-agent-access/vertical-slice/report.json`为passed。桌面IPC创建隔离模型/资源，CLI与MCP读回一致；禁用连接事实正确，模型URL/headers和资源正文不进入响应，新增安全样例未进入实际JSONL，公共开始/唯一终态配对通过。`run.get`真实MCP验证项目范围内不存在任务的NOT_FOUND；成功、人工等待、核对、跨项目隔离与终态残留的证据为定向仓库单测，未声称真实供应商任务端到端验证。
- 本轮文档相对链接检查：116项、零断链；历史交接所列`qa/local-agent-access/check-doc-links.cjs`未随仓库同步，本机采用Python解析Markdown相对目标逐一检查。`git diff --check`通过。
- 安装包、第三方客户端、诊断包导出、真实计费供应商：本包未验收。

## 审查

审查维度：正确性、可读性、架构、安全、性能。按职责在仓库层提供有界只读投影，公共入口负责认证与生命周期；未增加依赖或执行器。已修正终态任务残留wait_kind误导核对的问题，并加入回归断言。生成契约保持原14项不变，新增目录和受保护源码影响声明同包更新。
