# Canvas Studio 工程约束

本项目是本地单用户 Electron 软件：不实现登录、团队、权限或云端项目依赖。

## 日志是功能交付的一部分

新增功能、修改执行/数据路径或修复故障前，必须阅读 [LOGGING_SPEC.md](./LOGGING_SPEC.md)。
所有变更必须做日志影响检查；涉及节点执行、模型请求、异步任务、文件、数据库、保存恢复的路径，
必须补齐适用的开始/终态、失败阶段、关联信息及脱敏验证，并更新
[日志覆盖清单](./docs/LOGGING_COVERAGE.md)。纯样式、静态文案或文档变更可说明“不涉及”。

使用 [日志检查模板](./docs/templates/LOGGING_CHANGE_TEMPLATE.md) 完成自查；复用公共执行器已记录的阶段，
不得重复记同一终态，不得用业务 `console.log/error` 代替正式诊断，不得记录密钥、提示词、回复或原始请求/响应。
日志写入失败不能改变业务结果。当前接入使用现有 `ctx.trace`、`ctx.setDiagnosticTarget` 及诊断 IPC；
统一事件 SDK、独立事件存储、查询导出与自动门禁已有实现；优先使用 `src/shared/observability`、
renderer 的 `emitDiagnosticsEvent` 和 main 的诊断入口。实际验收范围及剩余盲区以
[日志覆盖清单](./docs/LOGGING_COVERAGE.md) 为准，不得把局部验收宣称为全链路完成。
已有盲区按受影响路径迁移并登记，新增关键路径不能长期以“以后接入”跳过。
交付说明必须列出日志覆盖、验证证据及未覆盖边界。

## 节点是强制协议

节点内部的空白、图标和字段标题必须可单击选中、拖动移动；卡片输入框遵守“双击编辑、单击选中”的公共指针规则，见 UI 规范 §19。不要通过整个表单的 stopPropagation 保护单个控件；新控件须完成内部区域及拖动验收。

新增或修改节点 UI 前，必须先读 [节点 UI 统一规范 v1.3](./docs/NODE_UI_STANDARD.md#19-v13-按内容布局协议2026-10-05当前权威)。
§19 为按需说明、零/单/多操作、间距、预览适配及高度滚动的现行裁决（图标色板与 §18 未冲突尺寸继续沿用）；不得以旧截图、
历史验收或节点私有样式豁免。新增节点须复用公共呈现组件并完成该节验收；规则定稿不等于界面已整改。

新增或修改引用呈现前，必须遵守 [节点引用呈现规范](./docs/NODE_REFERENCE_SPEC.md)：整个引用区只显示一排，完整内容通过统一详情查看；该规范取代旧版逐条换行规则，实施状态以其迁移清单为准。

所有滚动区域必须遵守 UI 规范 §19 的全局规则：保留滚动能力，始终隐藏横向/纵向滚动条及自绘滑块，悬停和聚焦不得恢复显示。复用 `assets/scrollbars.css`，不得用 `overflow:hidden` 禁止滚动或另设可见滚动条。

新增或修改节点图标、分类、身份色前，必须阅读并遵循
[节点分类与图标颜色规范](./docs/NODE_COLOR_SPEC.md)。五大分类主色固定为：输入玫红、图片绿色、
视频蓝色、声音紫色、流程橙色。新增节点必须先在规范中登记所属分类与颜色变体，再使用统一色板；
不得在组件中自行配色。现有界面的迁移状态以该规范的迁移清单为准。

新增或修改节点前必须阅读 `NODE_CONTRACT_SPEC.md`。可创建节点必须同时具备：

1. `ActiveNodeTypeId`、`NodeTypeSpec` 和稳定的 `contractVersion`；
2. 明确的输入/输出端口、JSON Schema、必填性与基数；
3. 自注册 `executor` 与 `projectOutputs`；
4. 使用 `props.config` 保存固定配置，使用 `props.text` 保存用户正文，使用
   `meta.nodeRun` / `meta.nodeResult` 保存运行记录和结果；
5. 契约、连线、输出、失败路径与持久化测试；
6. `test/node-compliance.test.ts` 和全量 `npm run verify` 通过。

不得在 React 组件中绕过 executor 调用模型，不得按上游节点标题或类型猜测输入，不得用
快捷按钮隐式产生未声明的业务输出。任何新处理能力必须是独立节点或明确的工作流模板。

## Agent 对接已下线（2026-09-17）

Agent/CLI/MCP/headless 的全部实现代码已从本仓库移除（`src/capabilities`、`src/application`、
`src/cli`、`src/mcp`、`src/main/headless`、`test/agent`、`generated/` 及相关脚本与 CI 步骤）。
原因：项目未稳定前对接反复返工，且 headless 链路存在契约缺口（详见
`docs/HANDOFF_2026_09_15_CODE_REVIEW.md` F05–F09）。旧对接规划和旧 Agent 专用交接
已退出当前工作区，不作为恢复依据。未来增加执行宿主仍须验证与桌面输出一致性。

## 画布原生 Agent Flow（2026-10-11）

当前唯一方案入口：[画布原生 Agent Flow](docs/canvas-agent-flow/README.md)。

2026-10-12 用户已确认[完整方案](docs/canvas-agent-flow/00-approved-plan.md)并授权按 C0–C4 开发；状态以[开发台账](docs/canvas-agent-flow/08-development-ledger.md)的真实证据为准。首版新增 Agent、状态机、AI 审核三种类型。Agent 职责与人机协作/纯 AI 参与方式独立配置；资产固定版本，审核返工走显式控制关系和有界预算，不形成反向数据环。
这是待实施设计，不能引用已撤回 S0/P0/P1 的完成状态作为当前实现证据。

1. 上帝 Agent 构建画布中的 Flow；主 Agent 节点协调流程、任务、最小输入和产物；专业 Agent 节点承担复杂执行任务。主 Agent 与专业 Agent 复用 Agent 节点类型，以角色及工具权限区分。
2. 目标、讨论、状态、人工选择和继续发生在画布节点内；成果由可查看、可连接的节点承载。
3. 首版包含声明式状态机节点，校验事件、条件与迁移；每个节点保留独立任务状态。执行事实来自真实运行记录，不能由模型或聊天文字直接改为成功。
4. 画布语义图是唯一可编辑流程定义；控制/状态关系显式可见，不能混入普通数据边。
5. UI 与 Agent 共用图操作和节点执行契约；后台存储和运行服务只服务这张图。
6. 保留现有节点和手动流程；不建立独立协作工作台、第二份任务拓扑或云端依赖。
7. 每包先定义并验收一条画布用户路径，明确已实现/已验证/未支持；不能用测试数量替代产品验收。
8. 测试使用隔离数据；可见测试窗口必须标注并在退出时清理，不留下无标识测试项目窗口。

新增 Agent、状态机或接入节点调度前，必须遵守[节点协同规范](docs/canvas-agent-flow/05-node-coordination-standard.md)。已有 executor 不等于已支持 Agent 调度；未经适配验收的类型继续支持手动使用，不能宣称已可自动协调。

## 本地数据安全

项目导入导出不得包含 API Key。导入时必须重映射所有媒体 ID 和相对路径，包括
`tldrawSnapshot`、`meta.nodeResult` 与导演台引用；临时目录和数据库事务成功后才可显示项目。

## 参考项目

Infinite Atelier 仅可参考视觉、状态和操作层级。不可复制其“按节点类型扫描上游”的数据流、
无端口连接、巨型 Config 节点、浏览器 localStorage 持久化或 iframe 导演台架构。
