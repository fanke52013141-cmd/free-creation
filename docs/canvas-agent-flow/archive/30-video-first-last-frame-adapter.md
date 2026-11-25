# 首尾帧双图接入 Agent 视频调度

日期：2026-10-15。接续 [单首帧适配](29-video-first-frame-adapter.md)。本包继续功能开发，不生成安装包、不安排旧项目迁移专项。源码尚未提交或推送。

## 画布用户路径

依次将首帧、尾帧两个图片节点的 `out-image` 接到 video v7 的 `in-images`，接线后明确选择「首尾帧生视频」。首尾身份使用保存画布的有序连线，不根据节点标题、位置或文件名判断；可另接一路文本或使用节点提示词。主 Agent 分派视频专业 Agent，经原 `node.execute` 和公共视频 executor 执行。

首次结果 unknown 时保留命令、任务与占用，关闭重开后明确核对、继续，接回同一任务并提交一个固定视频成果。恢复不重发生成请求；首尾图片替换、缺失或顺序变更会阻断，需先处理原任务事实，再明确新建任务。

## 实现与保护

- `videoFlowInputsValid` 按模式校验固定图片数量：text 为零、first-frame 为一、first-last-frame 恰好二；文本最多一个版本，其他参考端口仍未开放。
- main admission 按保存连线顺序冻结输入；命令账本逐条匹配同一端口的有序来源，包含固定成果节点的引用匹配，拒绝漏图、交换、重复媒体、额外边和错误类型。既有 processor 的单来源准入保持。
- gateway 回读原命令和完整固定资产身份，分别校验首尾媒体 ID、版本摘要、项目媒体边界和内容 SHA-256；异步读取后校验真正编码发送的两张图片字节。每张图片继续限 20 MiB，不复制原图片。
- 原视频任务重接比较 mode、首帧、尾帧、模型、提示词与参数，变化时保留 unknown，不通过重新提交绕过。停止、迟到保护、排他恢复及固定视频物化沿既有实现。
- video v7 的端口、executor、输出投影和持久化协议保持；未创建新节点、新端口或第二套视频执行器，未修改节点生产 UI。

## 验收记录

三文件首轮定向 74 项通过，涵盖有序来源、原账本重开接续、换序、漏图、重复/额外输入、尾帧同长度替换/缺失、原任务尾帧漂移以及分别对首尾异步字节拒绝。后增双图停止和 main/renderer 顺序指纹回归；最终结果另记下方。

两端类型检查、生产构建通过。真实隐藏 Electron 两进程验收通过：主控分派 → unknown → 关闭重开 → 明确核对/继续 → 专业/主控完成 → 固定视频预览/保存；合成供应商实际收到与两个原始 PNG 逐字节对应的 first_frame/last_frame，最终 1 POST、1 下载、1 视频任务。图片/视频原生单击选中、拖动、双击预览通过，已查看两张最终截图。使用真实 SQLite、公共 IPC/executor、图片和可解码 MP4；SDK 与供应商是隔离协议夹具，没有付费媒体请求，不代表真实模型自主决策或计费/撤回验收。

首轮定向两处旧错误文案/分类断言随新增尾帧和边数校验更新；首轮桌面原生点击后即时读取选择状态失败，改为等待选择状态（最多 1 秒，仍只有一次真实点击）后通过。失败日志保留，不将首轮记为成功。

首次完整门禁新增停止用例误断言零网络请求，实际停止会查询原供应商状态。修正为等待停止完成、只允许一次 GET、禁止新增 POST，39 项视频恢复回归已通过；不删除供应商事实查询、不放宽重复计费保护。随后重新完成完整门禁，首轮失败仍保留。

修正后全量单元已通过：171 文件、1867 项通过、1 项既有跳过，模型包另 2 项；lint、两端/模型类型和日志门禁通过。随后浏览器阶段因 Playwright 默认所需 Chromium 1234 未安装而停止，切换 QA 预加载为显式使用已安装 Chromium 1228，未安装/更新应用依赖、未修改产品浏览器配置。该次失败单独留档，最终完整结果仍以下方接续为准。

浏览器环境修正后，17 组 `test:optimization-ui` 独立运行退出码 0（`qa/agent-first-last-20261015/browser-gate.log`）。包含 31 节点原生选中/拖动、双击编辑、引用、滚动、主题/颜色、C1 控制声明与固定资产普通端口消费；断言和截图要求未放宽。最终完整轮在同一 QA 环境通过。

本机证据：`qa/agent-first-last-desktop.log`（首轮失败）、`qa/agent-first-last-desktop-second.log`、`qa/agent-video-first-last-frame-20261015/desktop/results.json`、`video-fixed.png`、`image-fixed.png`。完整门禁记录 `qa/agent-first-last-20261015/verify.log`；之前两次失败分别保存在 `verify-first-failed.log` 和 `verify-second-browser-missing.log`，不以旧门禁替代本轮结果。

### 最终完整门禁

2026-10-15 最终 `npm run verify` 完整串行退出码 **0**：171 个测试文件、**1867 项通过、1 项既有跳过**，模型包另 2 项通过；lint、两端/模型类型、日志门禁、17 组浏览器、生产构建与 14 组桌面路径全部通过。含资产/命令、专业/协作/主控/建图/审核、三类返工、恢复以及文生视频/单首帧/首尾帧三种视频路径。最后首尾帧报告仍为 1 POST、1 下载、1 视频任务、9 次合成 SDK 决策，固定预览/原生指针和实际诊断脱敏通过。验收自动改写的两份受跟踪 QA 基线恢复，不纳入源码改动；隔离临时数据、服务和窗口由验收脚本退出清理。源码尚未提交/推送，安装包未更新。

本机沿用现存 native ABI，使用 Electron-as-Node 22.22.1（ABI 140）及缓存的 pnpm 10.33.0；当前系统 Node 24 与现存 better-sqlite3 ABI 不匹配。仅 QA PATH 包装使用该运行时，无 native rebuild。浏览器用仅对验收进程生效的预加载适配，移除本机缺失的 Chrome channel 后使用已安装 Playwright Chromium；不提交本机路径、包装脚本或运行数据库。

## 日志影响检查

按 [日志检查模板](../templates/LOGGING_CHANGE_TEMPLATE.md) 自查：本包修改输入和模型/恢复路径，复用已有公共事件，无新增事件族或重复终态。

| 路径 | 责任与事件 | 关联/失败阶段 | 脱敏边界 |
| --- | --- | --- | --- |
| 开始、准入与来源/版本校验 | agent.desktop/coordination、command.operation、公共 node 生命周期 | project/node/task/command/run/trace/span；input、video-input、revision | 不输出固定输入全文、图片、路径 |
| 提交、下载、入库和保存 | model.request、task、media.download/persist、asset、project.save | 原 command/task、独立请求及媒体 ID；只有可信事实提交才交付 | 无提示词、回复、Data URL、Base64、Key 或供应商地址 |
| 校验失败 | 现有 command/asset/gateway 包装边界 | FLOW_INPUT_MANIFEST_INCOMPLETE、FLOW_INPUT_SOURCE_MISMATCH、FLOW_INPUT_CONTRACT_INVALID、ASSET_IMAGE_CHANGED；image-integrity/input/saved-input | 固定错误文案，不输出原始异常或素材内容 |
| 超时、取消、停止与重开 | 原任务控制和核对生命周期 | TASK_OUTCOME_UNKNOWN、原命令/任务、恢复 trace；unknown 不释放占用 | 不伪造远端撤回，不因缺日志重发 |

桌面实际 JSONL 扫描 `diagnosticRedaction=true`，9 次合成 SDK 决策；已验证 Agent/协调开始与唯一终态配对、恢复关联，排除 private-c3 材料/假 Key、Data URL 和 PNG Base64。logger 故障隔离沿既有公共测试，本包不把摘要/匹配辅助函数改为日志权威。崩溃未观察到的终态不补造。覆盖清单同步登记。

## 未支持边界与下一步

未开放多参考图片模式、视频/音频/运动参考、提示词包、视频视觉理解/审核或并行媒体调度。没有真实视频供应商计费/撤回验证；官方 Ark 以外缺乏可信任务查询身份时继续 unknown。物理掉电、磁盘损坏、跨机器租约和长期全故障组合不在本包验收内。

下一步按独立能力包适配多参考图片：先明确供应商能力及有序数量上限，再复用固定版本、实际编码字节校验与原命令恢复，不能只放宽双图数量。模型视频审核与并行继续独立验收。
