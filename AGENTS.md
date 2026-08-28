# Canvas Studio 工程约束

本项目是本地单用户 Electron 软件：不实现登录、团队、权限或云端项目依赖。

## 节点是强制协议

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

## 本地数据安全

项目导入导出不得包含 API Key。导入时必须重映射所有媒体 ID 和相对路径，包括
`tldrawSnapshot`、`meta.nodeResult` 与导演台引用；临时目录和数据库事务成功后才可显示项目。

## 参考项目

Infinite Atelier 仅可参考视觉、状态和操作层级。不可复制其“按节点类型扫描上游”的数据流、
无端口连接、巨型 Config 节点、浏览器 localStorage 持久化或 iframe 导演台架构。
