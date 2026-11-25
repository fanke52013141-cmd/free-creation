# 有序多路媒体参考与固定提示词包

2026-10-16，接续完整目标 R07。工作区开发中，尚未提交或推送，不更新安装包。

## 用户路径与契约

视频专业 Agent 控制 reference 模式视频节点，连接三张固定图片、两路视频、两路音频和 prompt.bundle@1 JSON；提示词包沿普通 in-prompt，顺序沿各端口真实边顺序。文本/首尾帧旧路径保持。Agent 和 command 准入验证提示词包正文结构；模型实际支持的模态、各类数量与文件限制仍由已有公共能力验证裁决。

结构上限每类 30，实际供应商上限更低时严格拒绝；上限不授予模型未声明的能力。固定摘要、项目归属、MIME、媒体列表顺序、原视频命令和供应商任务绑定保持；交换/重复/替换/缺失阻断，未知不能重发。首尾帧不能混入视频/音频参考。

## 验证

4 文件 110 定向通过（qa/multi-reference-directed.log）。新增双路视频/音频的原任务接回、交换/重复/更改字节拒绝后，供应商恢复测试 57 项通过（qa/multi-reference-recovery.log）。提示词包有效/无效结构及视频/音频结构数量边界有断言；node 类型通过（qa/multi-reference-typecheck.log）。

新增 --video-multi-reference 隔离桌面首轮退出码 0（qa/multi-reference-desktop.log、qa/agent-multi-reference-20261016/desktop/results.json）：实际编码请求校验三图、两视频、两音频字节和顺序，提示词包 prompt/style 确实发送；两进程累计 1 POST/1 下载/1 供应商任务，视频/图片原生指针及预览、音频播放沿原路径通过。正式 IPC 项目包导入 11 版本/3 固定呈现节点并验证旧运行权威不导入。

随后补强多参考路径的实际 node/workflow/同步 model 唯一终态、异步提交和诊断保留断言；加强后的桌面复验、最终完整门禁、截图与实际日志审计待补。

## 返工生成提示词修订

专业模型 execute_node 在已授权 video 返工任务中可提出可选 prompt 修订指令（1–4096 字符）。runtime 拒绝普通任务、错误目标和非 video@7 的提案；main 将指令固定在 videoRework 命令中，与 reviewId/round 一起进入命令签名和 checkpoint。gateway 从持久命令读取指令，并保留原目标/参考材料及冻结审核标准/反馈，不修改画布正文/配置或旧任务输入。相同命令改指令视为冲突，unknown 恢复仍使用同一命令与指令。

新增提案的任务范围/身份拒绝、unknown/checkpoint 接回、原快照不变、命令签名和组合提示词测试；首轮 3 文件 88 定向通过（qa/prompt-revision-directed.log）。已追加 ledger 提案去重测试待全量收录；node 类型与相关文件 lint 通过。并行桌面供应商已强化为必须在实际请求中观察到模型提案，复验中。

### 本机验证环境记录

复验三次在 setup-project 报 ERR_DLOPEN_FAILED，未进入业务路径；setup 阶段细化和仅文件名/行列的安全堆栈位置帮助定位。共享 node_modules 中 better_sqlite3.node 在 00:52:31 产生 ABI140 备份并换成不兼容文件。本包未重建或改写该共享模块；只复制已有 ABI140 备份至忽略 QA 目录，使用本地 NODE_OPTIONS loader 对 QA 子进程注入 better-sqlite3 官方 nativeBinding 选项。探测确认默认绑定失败、隔离绑定 ABI140 成功，沿隔离环境继续。失败日志 prompt-revision-parallel-desktop/second/third 保留，不能当作业务失败或成功。

## 日志与边界

复用已有视频/命令/任务/保存/资产/项目迁移诊断，不记录提示词包、参考字节或模型正文，不增加业务网络入口。新准入失败沿现有安全错误码，不重复终态。实际诊断脱敏和关联须以桌面结果补录。

R07 的提示词包、多路媒体和模型修订指令均已有实现；修订指令的桌面、实际日志和最终完整门禁仍待完成。模型只修订本次授权生成命令的内容，不自行更改画布拓扑。其他模态审核、更多生成节点、建图、并行调度和完整稳定性继续依总台账推进。
