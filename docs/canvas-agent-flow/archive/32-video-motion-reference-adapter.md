# 单路视频运动参考接入 Agent Flow

日期：2026-10-15。接续 [图片参考包](31-video-reference-images-adapter.md)，保留工作区此前首尾帧及图片参考改动。本包不提交/推送、不打包，不改变生产节点 UI。

## 画布路径与边界

普通视频素材节点 `out-video` 接 video v7 的 `in-reference-video`，接线后明确选择 reference 模式；使用视频节点正文或一路提示文本，可另接既有有序固定图片。主 Agent 分派专业 Agent，经公共 node.execute/executor 执行。首版最多一路参考视频、每个参考视频最多 20 MiB，实际模式/图片/视频数量继续受所选模型能力约束；音频、提示词包、多路视频、视觉审核与并行调度未开放。

视频输入来自普通 video-asset，main 准入时自动冻结项目内媒体身份、MIME、相对路径和 SHA-256。既有生成视频成果继续按原协议读取、预览和连接，不对原成果追加 20 MiB 限制；历史没有内容摘要的成果版本不能直接伪装成受验证的运动参考，需要使用普通视频素材节点重新固定。固定素材不复制文件，原文件变化、丢失或索引漂移会阻断。

unknown 后关闭重开，明确核对/继续，只接回原命令和视频任务；参考视频列表、图片顺序、模型、提示词或参数变化不重新生成。停止意图、迟到保护、远端查询、排他物化和固定成果复用已有实现。没有可信远端查询能力时保持 unknown，不把本地停止称为远端撤回。

项目包边界：本包验收本机保存/重开，不宣称固定媒体版本可导入导出。现有 `src/main/store/flow-transfer.ts/parseFlowVersions` 仅接受文本/Markdown/JSON，因此包含固定图片或视频版本的项目包会拒绝。这是此前媒体包已存在的未适配路径，本包不放宽校验绕过媒体重映射，也不将其称为迁移完成。

## 实现

- videoFlowInputsValid/正式目标输入支持 reference 模式的一路 video，图片与文本保持各自准入规则；普通端口、video@7 contractVersion 和公共 executor 保持。
- 原图片完整性辅助函数提取通用 fixedFlowMedia，继续保留 fixedFlowImage 的既有接口/错误语义；普通视频素材投影与 renderer 一致。资产读取仅对带固定摘要的视频版本校验文件，旧生成成果版本兼容。
- 命令账本要求视频参考携带内容摘要；gateway 回读原命令、完整版本身份和摘要，逐项匹配 plural referenceVideoMediaIds，异步媒体读取后再次核验实际编码字节及 MIME。单复数别名不能绕过命令绑定。
- 原任务重接增加有序视频列表匹配；能力校验分别判断图片/视频支持和数量。固定媒体 parse/pinned 输出保留视频摘要，main/renderer 指纹沿公共计算，不引入第二套执行器。

## 验证

首轮三个相关文件 91 项通过：视频固定版本/重开、同长度替换/缺失、错误类型、跨项目和超限、重复来源、图片加视频组合、原任务列表漂移、异步实际视频字节拒绝、停止查询与明确接回。随后补充普通视频素材投影与固定摘要保存/读取回归。两端类型检查、构建和隐藏 Electron 双进程已通过；最终完整门禁已通过，结果见下方。

桌面使用实际 MP4、SQLite/preload/画布/公共 executor、主/专业 Agent；SDK 和供应商为隔离协议夹具，无付费视频请求。逐字节检查 reference_video Data URL 与原 MP4，一次 unknown → 关闭重开 → 明确核对/继续 → 一个固定视频成果，报告为 1 POST/1 下载/1 任务；固定视频原生单击选中、拖动、双击预览及诊断脱敏通过。证据 `qa/video-motion-desktop.log`、`qa/agent-video-motion-20261015/desktop/results.json` 与 `video-fixed.png`；完整日志将写 `qa/agent-motion-20261015/verify.log`。

首轮完整门禁：171 文件/1883 项通过/1 既有跳过，模型另 2、日志门禁、17 浏览器、构建及已有 Agent/三类返工/恢复桌面通过；旧文生视频在成果节点已创建、React 预览尚未挂载时即时查询 DOM 失败（VIDEO_PREVIEW_MISSING），记录 `verify-first-desktop-mount-failed.log`。验收改为聚焦成果、等待真实预览元素，再保留原媒体解码与原生点击/拖动/双击断言；新放置图片同样先聚焦。没有修改生产 UI 或放宽元素/媒体断言，最终复验结果以下方接续为准。

聚焦/挂载等待修正后重新构建，文生视频、运动参考、单首帧、首尾帧及图片参考五种双进程定向全部退出码 0。记录在 `qa/agent-motion-20261015/` 的 `text-video-fixed.log`、`motion-fixed.log`、`frame-final.log`、`frames-final.log`、`references-final.log`；不是跳过失败的旧视频路径。完整 verify 随后重新从 lint 开始执行。

最终完整 `npm run verify` 退出码 0：171 文件、1883 项通过、1 既有跳过，模型模块另 2 项；日志门禁、17 浏览器、生产构建与 16 组隐藏 Electron 路径全部通过。证据 `qa/agent-motion-20261015/verify.log`。实际诊断独立扫描未发现测试正文、Key、图片/视频 Data URL 或 MP4 前缀；desktop 6/6、coordination 2/2 开始/唯一终态配对通过，见 `diagnostic-check.json`。未更新安装包。

## 日志检查模板自查

本包涉及媒体文件、固定版本、模型请求与恢复，复用 agent.desktop/coordination、command.operation、公共 node、model.request、task.control、media/download/persist、asset 和 project.save 的开始/唯一终态。辅助摘要和投影函数不另记终态，日志不作为恢复权威。关联 project/node/task/command/run/trace/span 和受控媒体/版本 ID。

失败沿 input/video-input/saved-input、source-projection 与 video-integrity；新增 ASSET_VIDEO_CHANGED 的安全 IPC 和任务失败文案，文件内容/大小/类型/项目漂移不会带入原始异常。实际发送字节不符沿 FLOW_INPUT_CONTRACT_INVALID；未知结果与停止继续保留原任务和占用。诊断不记录 MP4/Base64/Data URL、提示词、回复、Key、私有路径或原始响应。现有公共 logger 故障隔离继续复验，不重复公共请求/执行终态，不补造崩溃终态。共享失败提示仅新增该代码的静态文案，不改变执行或日志生命周期。

实际桌面扫描排除 private-c3/假 Key/Data URL/PNG Base64，Agent 开始/唯一终态与恢复 trace 关联通过；本包补充视频 Data URL 的排除验证。日志覆盖清单同步更新。物理掉电、磁盘损坏、长期故障组合、真实供应商计费/撤回与完整媒体 trace 树未验证。

## 下一包

优先独立适配固定图片/视频项目包：完整媒体 ID/相对路径/固定引用重映射、摘要复核和事务后显示；不恢复旧执行/批准权威。这是现有媒体能力的项目包支持，不安排旧项目迁移专项。完成后再适配单路参考音频；视频视觉理解/审核与并行媒体仍分别验收。
