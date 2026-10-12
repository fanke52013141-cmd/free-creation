# 模型探测与生产桥审阅

日期：2026-10-12；基线：08be32a。结论：可进入 C1 配置开发；生产执行须在 C2 验收后开放。

## 模型能力与证据

独立构建入口 agent-flow-model-probe 复用现有 AI SDK / OpenAI-compatible chat adapter。`node scripts/probe-agent-model.cjs --allow-cost` 可指定 `--target-id=模型定义ID`；默认选择绑定文本模型。应用 DB 只读，不迁移、不改变 text.generate 验证结果；凭据只在 main 使用。临时凭据由本次进程环境提供，不写应用配置。

最多两次纯文本请求，每次 128 输出 token、30 秒、0 重试，无真实工具副作用。第一轮验证指定工具/参数；第二轮给不同回传值，验证读取真实工具结果，复制原参数不通过。取消/并行工具/媒体均为 unverified。

已保存目标的两次准备检查止于 credentials，未发出请求。随后用用户提供的 `doubao-seed-2-1-turbo-260628`：2026-10-12 04:17:43 UTC 两次真实请求，structuredToolCall/toolResultRoundTrip 均 verified。证据在 qa/canvas-agent-flow/model-probe 本次时间目录。未调用图片示例；源码/报告/日志不含凭据、端点或请求/回复正文。

仅证明当前目标/适配器的最小协议，不证明任务质量或生产桥。临时目标未持久绑定；正式能力缓存须绑定连接修订、定义和适配器版本，变更后重测，归 C2/C3 实施。

## 生产桥审阅结论

| 源码证据                                    | 现有事实                                                              | 接入裁决                                                       |
| ------------------------------------------- | --------------------------------------------------------------------- | -------------------------------------------------------------- |
| renderer/engine/executor.ts runNodeManually | 依赖 Editor、图快照、单节点范围、已保存输入；返回 done/skipped/failed | main 不导入 React 注册表执行；派发当前项目 renderer 的窄适配器 |
| executeNodeOnce                             | 资源队列、输入/输出校验、注册 executor、物化、取消和诊断              | 必须复用，不另写业务执行器或在 Agent 中直调模型                |
| seedPersistedOutputs                        | 正式输出投影                                                          | 缺通用不可变版本清单，不能把当前选中输出当作已审核版本         |
| 手动返回值                                  | 无命令身份、固定输入版本、输出版本/保存回执                           | done/toast 不作为权威提交回执                                  |
| C0 ledger/checkpoint                        | 隔离表与大写 fixture，验证 pending/去重/unknown/等待恢复              | 不是正式项目事务，不宣称生产副作用恰好一次                     |

生产路径：main 先保存 pending → 校验会话/项目/范围/语义修订/输入版本 → 派发 renderer → 公共单节点执行 → 校验产物/保存 → main 提交回执 → 推进 checkpoint。手动/Agent 共用审核 gate。日志和内存不作恢复真值。

命令包含 commandId/projectId/taskId/agentNodeId/targetNodeId、expectedSemanticRevision、contractVersion、固定输入版本与关联 ID。配置/正文/连线/审核关系改变推进语义修订；移动节点/相机不影响业务命令。回执包含 attempt/nodeExecutionId、状态、输入快照、输出版本、提交状态。同 ID 同载荷返回原结果，不同载荷拒绝；IPC 超时、renderer 退出、外部接受后本地失败保留 unknown，不自动重发。main 校验 sender/window/project，覆盖可信诊断字段；Skill/tool 声明不授予额外执行权限。

## C2 验收门槛

1. 固定输入经手动/Agent 执行，端口、指纹、资产来源、错误/取消一致。
2. 并发/重复/重启提交同命令只有一份效果；差异载荷拒绝。
3. 派发前、接受后、物化中、保存后断开有明确回执；unknown 不重发。
4. 语义变更拒绝旧命令，纯位置变更不影响；迟到的人工/审核响应不推进新修订。
5. 审核 v1 不放行 v2；技术错误无 verdict；三种主体返工和预算耗尽分别验收。
6. 开始/唯一终态、命令/资产/保存关联、logger 故障及实际诊断脱敏通过。

## C1 交付与剩余工作

本轮加入三种配置节点的 v1 Schema、公共外壳、设置/正文、标准端口、菜单和配置保存。executor 明确 skipped，投影为空，显示执行待接入，不捏造运行资产。review.decision 与 flow.state 已注册；固定版本匹配和状态转换校验有测试，尚非生产 gate。

剩余 C1：控制关系可视化/目标选择器、转换编辑器、完整声明编辑与交互验收。C2/C3 再接正式命令、资产版本、结果投影、Skill 加载与工具执行。relations 保存在 config，不进普通数据 edges；本轮不是完整 C1 或 Agent 产品验收。

## 日志自查

准备用 agent.probe.started/completed/failed，请求复用 model.request.*，共享 trace、独立 requestId，错误只留固定 phase/code。关闭 SDK 原始异常默认输出。仅拷贝安全报告和诊断，不含 DB。测试覆盖坏回传、0 重试、唯一终态、原始异常脱敏、logger 故障；真实取消/媒体/并行未测。C1 保存/skipped 沿用公共持久化与执行日志，纯呈现/颜色/文档不新增业务事件。验证结果登记开发台账。

2026-10-12 后续更新：上述剩余 C1 控制关系、目标选择和转换编辑已交付，见 [C1 声明交付](10-c1-control-declarations.md)。生产执行边界仍按本文 C2 门槛验收。
