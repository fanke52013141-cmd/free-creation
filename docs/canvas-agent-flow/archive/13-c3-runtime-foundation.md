# C3.1a：有界运行底座

日期：2026-10-13。状态：模块已实现，最终全量结果见台账；**尚未开放画布 Agent 自主执行**。这是 C3 第一包，不是 C3.1–C3.3 全部完成。

## 用户路径和边界

目标：在画布 Agent 给出目标、绑定 Skill/工具和固定输入 → 启动有限循环 → 调用已有能力节点 → 检查资产回执 → 在本节点等待人或完成 → 保存重开继续。

本包完成 main 运行底座。隔离 SQLite、真实 LangGraph 与 C2 账本验证两次处理步骤、结果检查、固定输出和持久人工等待；决策使用明确的 fixture。另有真实 AI SDK + 合成供应商协议测试，验证单步模型动作。这些不能替代真实供应商、画布按钮或专业分析质量的验收。

Agent NodeTypeSpec 仍是配置阶段 executor、空投影。现有 C2 手动流程和处理节点桥继续可用；本包不改类型、颜色、端口或数据连线。全量回归发现并修复既有侧栏点击边界：控制关系标签的 pointerdown 不提前关闭侧栏，避免画布重排吞掉后续 click；原画布空白处关闭行为保留。

## 运行协议

- main 单一 StateGraph：决策 → Skill/节点工具/人工等待 → 观察 → 下一轮或结束。AI SDK 每请求只提出一个动作，不执行业务工具，不叠加第二重循环。
- 创建时固定 runtimeVersion=1、项目/Agent/task、画布语义修订、目标、输入、工具版本、Skill 内容及指纹。未来可信 main 宿主必须提供与保存画布一致的 admission/revision 校验；本包未暴露让 renderer 自行授权的任务 IPC。
- thread 对结构化项目/节点/任务身份求哈希，避免字符串拼接碰撞。同 Agent 只有一个未终结任务，重复启动只读事实。
- 默认最多 12 次模型决策、20 次工具步骤、600000ms 活动请求时间；节点 maxSteps 和 C2 命令预算进一步限制。人工等待不计请求时间。调用前持久预留次数，崩溃不返还；同 commandId 的核对不再占工具额度。模型忽略 AbortSignal 时，本地超时仍可结束等待。
- 完成只接受 committed 回执中的完整固定资产引用。文字、失败回执、pending、unknown、未观察资产不能写成功。这是执行事实校验，目标质量审核仍待独立 AI 审核适配。
- 取消写任务终态并通知请求；迟到结果不能推进已取消任务。不声称可撤回已接受的供应商请求或已执行的业务副作用。

## Skill 和工具

严格内容包包含身份、版本、名称、描述、指令、精确工具依赖及声明的 Markdown 资源。版本不可覆盖，内容有 SHA256 指纹；支持停用、以新版本编辑。任务固定内容不受库停用/新增版本影响。

基础上下文只放名称、描述、版本和指纹；load-skill 按需加载指令或声明资源。资源键不能含路径；禁止 scripts、额外字段或任意本机文件读取。单包 UTF-8 128KiB，任务 Skill 快照有界，已加载内容 128KiB，模型上下文 256KiB。缺失、停用、精确依赖不匹配及资源越界分别拒绝。

三个内容示范包：材料分析、JSON 整理、结果检查，含回执成功/失败例子。它们不把 processor 伪装为分析或模型加工能力。可信业务工具只有 node.execute@1，复用 C2 ledger + desktop grant transport；类型仍限已验收 processor@1。Skill 不授予工具权限。

未支持：SKILL.md/目录包的用户导入界面、资源编辑器、模板携带、shell/脚本/MCP/CLI/任意文件工具。

## checkpoint 和等待

数据库 v13 增加版本库、任务、响应去重、工具预留及生产 checkpoint/writes，沿现有事务迁移。任务/checkpoint 关联项目并级联清理；Skill 库为本机内容库。C0 实验表不作为生产真值。

等待分 human/reconcile；纯 AI 禁止必经人工确认，但未知副作用可以暂停核对。继续携带 task、语义修订、waitRevision、eventId 和种类；同意图去重，异意图/过期/错任务/错等待拒绝。等待后重建 runtime 从 SQLite 继续，已观察步骤不重跑。

每步骤固定 commandId；适配器读取回执并经 C2 prepare 核对意图，已有 pending/unknown 不派发。新步骤先持久 grant；派发/保存不能确认就保留 unknown 和占用。checkpoint 只保存循环位置，C2 账本拥有业务事实。

未支持自动接管 running/blocked 遗留任务、checkpoint/回执间隙的完整人工恢复入口或自动重放。C4 故障矩阵仍待验收；关闭重开数据库测试不等于整个桌面恢复已验收。

## 日志自查

依据 LOGGING_CHANGE_TEMPLATE：

| 路径 | 事件/复用 | 关联和允许字段 | 验证 |
| --- | --- | --- | --- |
| 任务 | agent.runtime.started/resumed → waiting/completed/blocked；cancelled | project/node/task/trace/span，phase/code | 正常、预算、等待、取消、超时、恢复 |
| Skill 库写入/绑定 | skill.library.started → completed/failed | 独立 trace/span，phase/code | 版本、停用、依赖、非法包、logger 故障 |
| Skill/checkpoint 阶段 | agent.runtime.skill_loaded/checkpoint_saved；失败阶段 | 同任务上下文，不记资源名和内容 | SQLite 持久化/恢复 |
| 模型 | 复用 model.request 生命周期 | request/父上下文/operation | SDK 协议、非法工具、过大上下文、脱敏 |
| 节点业务/保存 | 复用 C2 公共执行/保存/回执，不重复终态 | command/run/节点实例/资产版本 | 真实账本联测及既有双进程门禁 |

诊断失败不改变业务结果；无 prompt、reply、密钥、原始请求、供应商异常或 Skill 正文。任务创建/继续校验均有开始及成功/失败阶段；恢复开启新 trace 并关联原 trace。库操作当前是独立 trace，未来任务宿主仍需将库操作和模型请求关联到同一次继续操作。证据是测试内统一入口和原 C2 双进程文件；未新增 C3 桌面诊断文件验收，不宣称全链路完成。

## 验证和下一包

定向 39 项通过：18 C3 运行/Skill/SDK、14 C2 账本（新增真实两步联测）、7 迁移。包含重开 SQLite 等待、响应去重、过期语义、预算、unknown 核对、取消迟到、超时、项目级联、SDK 单步及正文/假密钥脱敏。最终全量记录 qa/canvas-agent-flow/C3/core-verify.log，不提交用户数据库、密钥或运行正文。

下一包 C3.1b：可信 main admission、模型 catalog/能力检查、Agent 卡片开始/停止/继续、Skill/工具选择、任务视图及正式输出投影。必须验收真实模型“工具 → 检查 → 再工具”和画布用户路径，才能标记 C3.1 可用。随后 C3.2 讨论修订/人工资产选择、C3.3 建图/多 Agent/状态机；审核返工、C4 恢复和迁移继续登记。

