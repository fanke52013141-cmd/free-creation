# 视频抽帧审核有界自动返工（2026-10-15）

## 画布用户路径

主 Agent 控制视频专业 Agent、审核节点和下游专业 Agent；视频专业 Agent 通过已支持的 video@7 生成视频。视频生成节点 out-video 连接审核 in-video，选择 sampled-video，负责人明确设为控制该视频节点的专业 Agent，并声明下游门禁、返工策略及预算。

首次审核未通过后，主控创建独立返工任务，原提示词和参考素材保持固定。网关从 main 持久化任务取出审核标准和反馈，追加“仅来自四张抽样画面”的返工指令后生成新视频；每个返工任务对该视频节点最多创建一个命令。新固定版本再次审核，通过后放行下游。停止策略、轮次预算、总控制步数和专业任务预算继续确定性裁决，模型不能扩大权限或预算。

未知结果保留原任务与命令，不进入下一质量轮次。关闭重开后明确核对与继续原任务，复审通过才推进。协作式专业 Agent 沿原人工明确启动/确认机制，不由审核反馈冒充人工同意。普通视频素材仍可走 35 包的人工替换复审；自动返工首包仅支持专业 Agent 已控制的 video@7 生成节点，不支持素材节点自动改写。

## 契约与实现

- 自动审核来源与负责人可分别为“视频生成节点”和“其专业 Agent”。只允许单一 out-video 来源、所属专业 Agent、主控控制范围内的目标；拒绝外国/未控制/手动素材来源、自门禁和无负责关系。审核结论必须对应该专业任务真实 committed 输出引用。
- 生成视频审核直接复用当前成功 nodeRun 对应 committed 命令回执的唯一固定视频引用，并核对公共投影。不能对生成节点调用无命令许可的再次资产提交，也不能从旧运行冒充当前成果。四图、MP4 完整性与可信下载回执沿用 35 包。
- AgentTaskSnapshot.rework 增加可选 videoTargetNodeId；node.execute 意图增加可选 videoRework（reviewId/round），纳入命令签名。只有可信运行时生成该标记，命令准入核对冻结任务，省略/伪造标记拒绝，同一轮第二个视频命令拒绝；原 commandId 重放仍只读原回执。
- main 网关在既有任务去重之前，验证专业任务、主控周期、未通过报告、规则、反馈、被拒固定版本及真实视频字节。从冻结快照组合有效提示词，最多 32 KiB；不接受 renderer 自报反馈，不改写画布提示词/参考输入/旧任务。有效提示词沿原视频 tasks.input 保存，重复接回确定性相同，不重复追加。
- 返工与初始分派一样使用独立 LangGraph 根运行环境，避免继承父运行的中断/检查点命名空间。结果未知时为等待核对，不能标成质量失败或开启新生成。
- 公共单节点/成果呈现每次生成独立 workflow span，parentSpanId 指向原命令/呈现操作；节点继续有独立 nodeExecutionId。修复自动审核中多次呈现复用同一 workflow span 的歧义，不改业务幂等身份。
- 无新增依赖、节点类型或端口。仍只审核 0.1–60 秒、至少 4 帧、最多 20 MiB 的一路固定 MP4 / 四张画面；不含音轨或完整时序。

## 日志影响检查

| 路径 | 事件与阶段 | 关联、敏感信息与职责 |
| --- | --- | --- |
| 自动审核/返工状态 | 复用 agent.coordination.stage 的 review.started/rejected/passed、rework.created | 主控负责；project/node/task/request/review/reworkTask/version/round，正文不进入属性 |
| 返工启动、未知、重开 | agent.desktop/coordination/runtime、command.operation 和公共 node/workflow | 新操作 trace 关联原任务，恢复不补造未观察终态；每次工作流有独立 span 与父关联 |
| 提示词绑定拒绝/预算 | FLOW_VIDEO_REWORK_INVALID / FLOW_VIDEO_REWORK_BUDGET_EXHAUSTED，video-rework 阶段，沿已有 IPC 唯一失败终态 | 只返回安全枚举；不写标准、反馈、实际提示词、原始响应、路径或媒体字节 |
| 视频提交与成果 | 既有 model.request.started/accepted、task/media/save/asset | 保持异步提交日志边界；不新增重复提交或重复终态 |

诊断失败不改变业务的原底座保持，沿现有相关故障单测回归。正式诊断扫描排除 private-c3 正文/假 Key、图片/音频/视频 Data URL 与 JPEG/PNG/WAV/MP4 字节前缀。测试夹具退出前排空正常 renderer 缓冲，不在生产路径补造事件。

## 验证与失败记录

首轮最终定向 **9 文件 / 200 项通过**；随后补齐正常执行与保存报告恢复共用的专业交付固定版本校验，扩展至 **10 文件 / 216 项通过**（含既有多进程恢复竞争复验）。覆盖固定生成版本复用、返工意图签名/遗漏/伪造、每轮单命令与去重、外部来源/自门禁拒绝、冻结反馈/标准、错误轮次/审核/目标/停止/篡改/文件变化、32 KiB 限制、停止策略、轮次/总预算、取消、旧文本协调/返工与媒体恢复、工作流独立 span 回归。证据 qa/video-rework-directed-final-second.log；类型、lint、构建已通过。

桌面首轮暴露生成节点无许可重复资产提交，改为复用 committed 引用。第二、三轮发现返工继承父 LangGraph 上下文，真实 unknown 中断被误标 AGENT_RUNTIME_FAILED；沿初始分派隔离方式修复。第四轮 unknown 保持正确，但夹具恢复仍使用旧节点控制快照，改为与正式 AgentTaskControls 一致从 main 最新 inspect 选择继续。第五轮业务双进程通过、严格日志门禁发现 workflow span 重用；修复公共执行入口并补测试。上述失败保留，不能用局部旧通过替代最终结果。

第六轮真实隐藏 Electron 两进程通过（qa/agent-video-rework-20261015/desktop-sixth）：实际公共执行器、固定资产、四张真实 JPEG 经 SDK、多模态审核、不通过、绑定反馈的第二次生成、unknown、重开核对/继续、第二轮通过及真实下游 processor 执行，**2 POST / 2 下载**。原始/返工 snapshot 的参考输入与目标完全相同，任务/命令/视频版本独立。供应商及模型决策为隔离协议夹具：真实解码收到的 JPEG 后按红/蓝判断，并检查第二个供应商请求含冻结标准/反馈；没有付费模型请求，不代表真实模型质量或真实供应商计费验收。桌面通过公共 executor 与 main 控制快照，未宣称测试点击媒体替换/所有按钮。

第六轮独立审计两 session：desktop **9/9**、同步模型 **15/15**、command **23/23**、node **13/13**、workflow **13/13** 唯一终态配对；另两次 video.generate 为 started/accepted，后续由 task/media 承载，不计完整请求终态。project.save **35/35** 仅总数，既有 correlationMissing 盲区保持。正文/Key/媒体排除通过，截图已人工查看。日志证据 lifecycle-audit.json 与 results.json 在同一目录。

第一轮完整 verify 单元 1939 通过后，日志门禁要求给独立验收夹具的 fetch 替身登记理由；按既有 desktop-electron 隔离入口规则在 scripts/logging-allowlist.json 逐文件说明，不豁免生产路径或秘密正文。第二轮既有 recovery-contention 的一次双恢复竞争出现 SQLite database is locked，1 失败/1938 通过；未放宽断言或改锁逻辑，随后同文件与业务回归 216 项复验通过。记录 qa/video-rework-verify.log、qa/video-rework-verify-final.log 保留。

最终完整 **npm run verify 退出码 0**，证据 **qa/video-rework-verify-accepted.log**：**172 文件 / 1940 通过 / 1 既有跳过**，模型模块另 **2 项**；lint、两端/模型类型、日志门禁、**17 项浏览器门禁**、生产构建及 **20 组隐藏 Electron 路径**全部通过。最终新增桌面路径 qa/agent-video-rework-20261015/desktop/results.json 保持 **2 POST / 2 下载 / 2 独立专业任务 / 2 审核版本**，原始与返工参考输入/目标不变，两个报告和原视频字节均再次校验。

最终截图已人工查看；按最新报告项目选出的两 session，独立审计同为 desktop 9/9、同步 model 15/15、command 23/23、node 13/13、workflow 13/13 唯一终态配对，恢复 trace 与脱敏通过；35/35 保存仅总数和异步视频 started/accepted 盲区保持。见最新目录 lifecycle-audit.json。门禁生成的两份受跟踪 QA 截图/报告已复制到 qa/video-rework-generated-evidence 后恢复，最终门禁后只更新文档。沿既有 Electron-as-Node/native ABI 与 Chromium QA 适配，未改依赖/锁文件或重建个人模块。

按 code-review-and-quality 的正确性、可读性、架构、安全和性能维度自查，补齐恢复时同一固定版本守卫、独立根中断、生成回执复用、每轮单命令和工作流 span 唯一性。预算/停止在新生成之前校验，提示词组合与临时解码有界，无新依赖或第二执行器。当前无未解决的必须修改项，已知边界见下节。已有单路参考音频与抽帧审核工作区改动保留。源码未提交/推送、不更新安装包，不改个人模型配置或 native 模块。

## 未覆盖与后续

真实供应商的视觉理解质量、计费与撤回，完整音轨/时序、多格式解码、多路视频、并行媒体、长期组合故障与物理掉电未验收；本包没有增加媒体强杀矩阵。返工启动/控制状态跨存储极端中断继续安全阻断核对，不能据此自动重派。模型不能自由改写任意提示词或画布拓扑；本包是固定目标/参考素材加冻结审核反馈的新生成任务。

本包完成后进入并行媒体的范围、占用、停止与恢复适配，并单独定义可见用户路径。后续真实供应商验证须明确预算，不使用隔离协议测试冒充质量/计费事实。
