# GLM 模型接入与本地默认选择

日期：2026-10-14。范围：本地模型目录、未来新建 Flow 节点及官方智谱请求适配。没有改写已有节点配置或运行快照，没有新增媒体 Agent 调度能力。

## 本地配置

通过现有 SqliteModelHost 保存官方 OpenAI 兼容连接与两个模型；密钥经 Electron safeStorage 加密，仅在个人数据目录中保存。先完成真实 SDK 探测，再进行实际能力验证和功能绑定。迁移前的一致数据库备份保存在个人用户数据目录，不进入源码或 QA 证据。

- `agent.default`、`text.process`：GLM-5.3。
- `text.chat`、`text.vision`：GLM-5.3-Flash。
- 模型定义仅登记实际接入的 `text.generate`；Flash 声明图片输入。视频、文件、音频、媒体审核及媒体 Agent 调度没有因此开放。

画布初始化读取现有本地功能绑定，新建 Agent 和 AI 审核节点从 `agent.default` 写入明确模型定义 ID；已有配置、任务快照及显式选择保持原值。建图后的子 Agent 沿现有建图契约继承搭建节点选定模型。源码中不硬编码个人模型 ID 或密钥。

## 请求策略

官方说明：[GLM-5.3](https://docs.bigmodel.cn/cn/guide/models/text/glm-5.3)、[GLM-5.3-Flash](https://docs.z.ai/guides/vlm/glm-5.3-flash)。前者仅支持文本，后者支持多模态输入、文本输出；两者不能关闭思考，支持 low/high/max 强度。

共享 SDK 工厂只对官方 HTTPS 主机、标准 Chat Completions 路径和这两个精确模型 ID 补充 `thinking.type=enabled`，缺省 `reasoning_effort=low`，适应现有有界决策。保留显式强度、SDK 工具选择、token 上限、AbortSignal、超时与重试策略；其他模型、供应商和路径不变。不将示例中的 65536 token 上限全局应用到 Agent 单步请求。

目录能力验证使用同一策略和 256 token 的小型探测预算；空正文或只有推理内容不得被标为已验证。Flash 还必须正确识别测试图片。

## 验证与局限

真实官方接口：两个模型文本请求、强制工具调用成功；Flash 正确识别测试图片。生产 `createCatalogChatModel` 与 `probeAgentModel` 验证两模型流式强制工具和真实工具回执往返，四次 SDK 请求全部通过。配置后的目录文本/识图验证通过，密钥密文前缀已核对。本地证据在忽略的 `qa/glm-switch-20261014/results.json`。

不以这些最小探测宣称优于豆包；GLM 的完整专业任务、主控顺序协调、建图、审核返工与跨进程重开仍需分别进行真实用户路径验收。历史豆包验收不能转记为 GLM 已验收。取消、并行和视频/文件能力没有真实验收。

GLM-5.3 的生产 `AgentSdkModel` 另以合成材料验证讨论、一步文本建图提案与固定对象审核：约 10.9/4.9/4.2 秒通过；三次请求开始/终态配对，敏感内容匹配为零。证据 `actions-results.json`。这是 SDK 操作适配验收，仍不等于完整画布 Flow 真模型验收。

本轮最终验证：lint、两端及模型模块类型检查通过；160 个测试文件、1716 项通过、1 项既有跳过，模型模块另 2 项通过；日志门禁、17 组浏览器门禁、生产构建、资产/命令/Agent/协作/协调/建图/审核七组隐藏 Electron 验收均已通过。新建 Agent/审核的菜单路径、旧模型保留和快照恢复另有 `canvas-results.json`。

验收分段完成，不能称最后一次 `npm run verify` 单命令串行全绿：默认 Node 24 的首次执行因 SQLite ABI 137/140 不匹配失败；匹配 ABI 的 Electron Node 复跑通过单元测试后，日志扫描将参数装饰器识别为独立请求。按门禁现有机制，在 `scripts/logging-allowlist.json` 登记两处生命周期委托理由，继续完成其余阶段，没有重复记录请求终态。首次画布取景快捷键断言、首次隐藏命令桥 canvas-ready 阶段失败均保留；未修改的两处画布代码和当前代码的独立取景复跑均通过，命令桥独立复跑通过，没有修改或放宽断言。

证据：`verify.log`、`verify-electron.log`、`verify-remainder.log`、`browser-rest.log`、`browser-baseline.log`、`browser-proportions-repeat.log`、`build.log`、`desktop.log`、`desktop-repeat.log`，均在忽略的本地 QA 目录。使用 pnpm 10.33.0、匹配 ABI 的 Electron Node 与本机现存 Chromium；没有重编译个人 native 模块，QA 绝对路径适配不纳入源码。

当前源码版重启后使用本地默认绑定；本轮未更新旧桌面安装包或快捷方式。源码变更未提交或推送。下一开发包仍为 C3.3 主控自动审核和三类主体有界返工；本次模型切换不推进该包完成状态。

2026-10-14 接续更新：以上为模型切换阶段的历史边界。随后已完成 GLM 文本模板建图、固定版本审核和三类返工的真实桌面两进程路径，最终完整 verify 通过（161 文件/1729 项/1 既有跳过，模型另 2；17 浏览器、构建、十组 Electron）。当前下一步为 C4，实际证据与未支持范围见 [C3.3 返工验收](19-c33-review-rework.md)。旧安装包仍未更新，个人绑定和凭据不随源码分发。

## 日志自查

按日志检查模板自查：请求适配复用公共 `model.request` 开始、唯一终态和失败阶段，不创建第二套请求日志；能力验证复用 `configuration.validation_completed/failed`；配置与绑定落盘保留现有宿主边界。新增默认读取失败经 `project.canvas_failed` 的 `model-defaults` 阶段报告。诊断只保留连接/模型/trace/span 标识、阶段和计数，不记录密钥、请求体、推理、回复或业务正文。

实际 SDK 诊断四个开始与四个终态配对，密钥及合成正文匹配为零；transport 故障、AbortSignal 保留与不自动重试有定向回归。没有修改公共日志故障隔离语义；完整恢复与父子 trace 等盲区继续见日志覆盖清单和 C4 台账。
