# Agent 全部剩余开发：工作中 handoff

2026-10-16（Asia/Shanghai）。本文件是接续记录，不是完成交付。用户目标完整保留：完成聊天列出的全部开发与验证，最后同步线上仓库并提供备注/handoff。总要求 R01–R12 见 [总台账](38-agent-completion-plan.md)。目标保持 active，未提交或推送，不更新安装包。

## 当前真实进展

- [39 并行审核返工](39-parallel-review-rework.md)：修复人工/协作等待遮挡其他审核，以及审核等待遮挡普通已完成子项收集。6 文件 120 定向通过；两初始视频必须重叠，两独立审核各返工一次，一侧 unknown 不阻止另一侧批准，下游双门禁保持。双进程累计 4 POST/4 下载/4 审核、原快照与四个不可变视频版本保留。
- [40 多参考与修订指令](40-multi-reference-prompt-bundle.md)：prompt.bundle 结构在专业任务/命令两处验证；视频/音频由单路扩为有序列表，结构硬界 30，真实数量仍服从所选模型较低上限。三图/两视频/两音频及提示词包实际字节、顺序、prompt/style 通过桌面测试，两进程仅 1 POST/1 下载/1 任务，正式项目 IPC 导入 11 版本。已扩充数组交换、重复、字节替换等门禁。
- execute_node 可在已授权 video@7 返工中提出 1–4096 字符修订指令，保存在命令 videoRework.prompt，进入意图签名/checkpoint。原目标/参考/审核标准和反馈保留，不改画布或旧输入；初始任务、非视频或错误目标拒绝，改同一命令的提案会冲突。运行/审核/命令 3 文件首轮 88 定向通过，之后又加一项 ledger 去重断言，待完整门禁统一收录。
- 加强提案后的并行双进程退出码 0，证据 `qa/prompt-revision-parallel-isolated.log`、`qa/agent-parallel-review-20261016/revision-isolated/results.json`。实际供应商夹具第三/四次请求必须包含模型修订指令，4 POST/4 下载保持；恢复 trace 与 node/workflow/模型/桌面唯一终态、正文/Key/媒体排除沿 runner 严格断言。
- 39 首轮独立实际日志审计已通过：desktop 13/13、coordination 2/2、command 31/31、node 19/19、workflow 19/19、同步 model 21/21 唯一终态；异步视频 4 started/4 accepted；save 51/51 只是总数。旧证据目录后续保留了新的失败 setup 报告，不要把混合目录当作一轮完整结果；以 revision-isolated 的两份 pass 报告为当前提案桌面证据。

## 正在运行的具体验证句柄

当前完整 `npm run verify`：exec session **62409**，日志 `qa/agent-remaining-verify-second.log`。使用 write_stdin 观察此 session，不因超时另起一轮。完成会写 `qa/agent-remaining-verify-second-exit.json`，记录明确退出码与 UTC 终止时间。启动时已保存 **705** 个代码/测试/脚本/配置文件的 SHA-256 到 `qa/agent-remaining-verify-source.json`；完成后比较当前文件集合及摘要，发现变化时不得把这轮当成新源码的完整验证。

前一轮 exec session 85736 已退出 1，失败日志 `qa/agent-remaining-verify.log`，exit 文件 `qa/agent-remaining-verify-exit.json`。全仓 lint 发现视频审核临时目录清理在 finally 中抛错。重新读取的权威工作区已将其改为暂存 cleanupFailure、块外按原始错误优先抛出；该文件定向 lint 通过，再启动当前完整门禁。不要覆盖现有不可变字节抽样/清理修复。

## 本机 native 环境

共享 better_sqlite3.node 在 00:52:31 形成 electron-abi140.bak 后，默认二进制无法被 Electron ABI140 加载。三次复验都在 setup-project 因 ERR_DLOPEN_FAILED 退出，尚未进入业务。未重建或覆盖共享依赖：将现有 ABI140 备份复制至忽略目录 `qa/agent-native-runtime/better_sqlite3.node`，本地 QA loader 用 better-sqlite3 的 nativeBinding 选项注入该副本。探测默认失败/隔离成功；没有生产代码开关或新依赖。

当前验证环境：Path 前置 `qa/audio-reference-runtime`（现有 Electron-as-Node node.cmd）和 Windows System32；PLAYWRIGHT_BROWSERS_PATH 为 `qa/audio-reference-browsers`；LANGSMITH_TRACING/LANGCHAIN_TRACING_V2 为 false；NODE_OPTIONS 为 `--require "D:/Program Files (x86)/canvas-studio/source/qa/agent-native-runtime/sqlite-loader.cjs"`。NODE_OPTIONS 的路径必须用正斜线，反斜线会被 Node 参数解析吃掉。loader/二进制均仅为本地 QA，不上传。

桌面 setup 现细分 project/protocol/supplier/model/ipc/load/canvas 阶段；失败只保留安全 nativeCode/类别及文件名行列，不输出原始异常正文。

## 后续完整范围

先读当前验证句柄与结果，修复任何失败，再继续 R03 更多能力节点调度、R04 多媒体/分支/审核建图、R05 画布空间预览、R06 图像/音轨/时序/音画审核、R08 多路/共享排队/多成果、R09 长期故障与供应商撤回、R10 诊断关联、R11 真实供应商验收；不能用 R01/R07 的局部证据标记总目标完成。

R03 当前可执行目标仍仅 processor@1/video@7。图片生成和声音生成有公共 executor，但 main 资产投影、媒体回执、准入、取消/未知恢复尚未接通。imageGen 有 count/重试和逐张成果，speech 有动态 backend/音色/音频输入及异步供应商；不能只放开白名单。沿公共执行桥、实际媒体回执、固定版本和停止/迟到保护逐项适配。新增/改节点 UI 要先读 UI §19 和引用/色板规范。

最终 R12：code-review-and-quality 五轴审查、完整门禁/支持矩阵、凭据及产物扫描后才提交与正常推送，核对远端 commit，提供最终 handoff。保留既有 34–37 包工作区内容和所有失败证据；不上传个人配置、数据库、媒体、QA 原日志/截图或安装包。不要将本文件视作可以缩小目标或提前完成的授权。
