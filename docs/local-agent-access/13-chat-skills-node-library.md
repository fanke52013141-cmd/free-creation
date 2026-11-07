# AI 对话 Skill 与节点库外部接入

2026-11-07。新增 6 项 v1 操作，CLI 与 MCP stdio 共用 Registry、准入、幂等账本和结果 Schema。既有操作输入输出不变。HTTP 不开放；不新增节点类型、端口或执行器，不代表通用节点编辑已开放。

| operationId | 输入 |
| --- | --- |
| skill.list | offset、limit（可省略） |
| skill.install | sourcePath（本机绝对路径）、name（技能显示名称） |
| chat.skill.list | projectId、offset、limit；返回已保存节点 ID、标题、技能版本及 graphVersion |
| chat.skill.bind | projectId、nodeId、expectedGraphVersion、skills:[{id,version}]、maxSteps（默认6） |
| node.library.save | projectId、nodeId、expectedGraphVersion、name（节点库条目名称） |
| node.library.list | offset、limit |

技能名称和节点库名称独立，均为必填输入。安装支持单文件 .md/.json，或根部 SKILL.md 与最多16个根级 .md 参考的目录；整包128KiB。使用现有解析器与 FlowSkillStore。拒绝脚本、ZIP、符号链接文件、嵌套目录及当前对话不支持的工具依赖。同 ID 同版本不可更名或改内容；更新需在源文件提升 version。名称不改变技能 ID。

绑定要求目标项目当前已打开，拒绝过期持久版本与任务占用；桌面先保存未保存内容，再由 main 核准目标节点，renderer 修改 props.config.agent，经原保存协调器落盘。main 再读取正式图核对实际配置及版本后才返回 saved。skills 是完整替换集合，空数组清空，最多8项；不隐式启动模型请求。运行中的对话或工作流拒绝绑定。query 只读取已保存内容，未保存修改需先 project.save。

节点库保存只支持 AI 对话节点。保存固定的 Skill 指令、参考和步骤预算及原节点标题、尺寸；text 为空，不带聊天记录、附件、模型选择、系统提示词或运行结果。绑定保持节点原配置；模板保存是精简的技能助手预设。条目 name 只命名节点库条目。复用现有 saveWorkflowTemplate，节点库每次打开重新读取，外部创建可见。

CLI 例如 `npm run agent:cli -- skill install --input-file install.json`，文件内容：

```json
{"input":{"sourcePath":"D:\\skills\\role\\SKILL.md","name":"角色设计技能"},"idempotencyKey":"<由 app.status 获取的 nextIdempotencyKey>"}
```

MCP 工具对应 `skill_install`、`skill_list`、`chat_skill_list`、`chat_skill_bind`、`node_library_save`、`node_library_list`，参数同 CLI 的 JSON 包装。每个不同写操作使用不同幂等键；失败/超时 unknown 不自动重放。绑定成功返回的新 graphVersion 用于下一步保存。可先 project.open，再 chat.skill.list 定位节点。

日志：统一 agent.access.started/completed/failed/rejected/unknown 负责外部操作生命周期，SkillStore 已记录 skill.library 生命周期，不增加重复终态。日志仅操作 ID、请求/trace/span、阶段和稳定错误码，不记技能名称、正文、参考、源路径或聊天记录。日志失效不改变业务结果；账本失败阻断写入。超时、保存后回执失败仍按现有 unknown 语义核对。当前 binding 桌面拒绝返回通用握手失败，不承诺细分 UI 拒绝原因。

验证记录见本轮交付回复；尚未完成的安装包/真实客户端验证不能称已验证。

## 本轮验证证据

- `node scripts/run-vitest.cjs run test/local-agent-access.test.ts --reporter=dot`：38项通过；包括命名/不可变版本/超限拒绝、绑定持久化核对、缺少版本拒绝、保存清除聊天私有数据、过期版本和幂等重放，以及启动真实 CLI 子进程和 MCP stdio 客户端的安装与查询。
- `npm run typecheck`、定向 ESLint、electron-vite build 通过。桌面绑定主流程测试使用受控 AccessDesktop 替身；真实 Electron 画布与安装包尚未验收，不称已完成该部分。
- `npm run verify`：qa/verification/run-T9SEIF，停在全仓 lint；其他并行改动的 test-keys-electron.cjs 等存在25个错误。本轮变更定向 lint 无错误。
- `npm run verify:agent-access`：机器契约已更新为25项；受保护源码另有并行修改，因此全局影响哈希检查仍阻断。只更新本轮实际审查的五个文件哈希，不替其他工作宣告通过。
- 不调用收费供应商，不执行 Skill 脚本。日志脱敏断言包括技能正文、源路径、聊天记录不进入事件；复用既有 agent.access 与 skill.library 日志，没有新增日志协议。
