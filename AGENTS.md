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

新增或修改节点 UI 前，必须先读 [节点 UI 统一规范 v1.3](./docs/NODE_UI_STANDARD.md#19-v13-按内容布局协议2026-10-05当前权威)。
§19 为按需说明、零/单/多操作、间距、预览适配及高度滚动的现行裁决（图标色板与 §18 未冲突尺寸继续沿用）；不得以旧截图、
历史验收或节点私有样式豁免。新增节点须复用公共呈现组件并完成该节验收；规则定稿不等于界面已整改。

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
`docs/HANDOFF_2026_09_15_CODE_REVIEW.md` F05–F09）。**对接规划已保留**：
目标架构、入口分层与重接前提见 `docs/AGENT_INTEGRATION_PLAN.md`（含下线记录与
重接清单）；契约同步门禁设计见 `docs/AGENT_SYNC_MECHANISM.md`（历史机制存档）。
重接前必须先补“桌面 vs headless 输出一致性”对比测试。

## 本地数据安全

项目导入导出不得包含 API Key。导入时必须重映射所有媒体 ID 和相对路径，包括
`tldrawSnapshot`、`meta.nodeResult` 与导演台引用；临时目录和数据库事务成功后才可显示项目。

## 参考项目

Infinite Atelier 仅可参考视觉、状态和操作层级。不可复制其“按节点类型扫描上游”的数据流、
无端口连接、巨型 Config 节点、浏览器 localStorage 持久化或 iframe 导演台架构。
