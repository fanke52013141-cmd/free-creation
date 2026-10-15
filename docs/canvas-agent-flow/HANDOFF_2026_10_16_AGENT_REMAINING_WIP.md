# Agent 开发与交付 handoff（进行中）

2026-10-16（Asia/Shanghai）。用户授权完成 Agent 总台账 R01–R12 的开发、验证，随后同步线上仓库并交付备注。本轮实现已提交并同步，提交与远端信息见 [线上同步 handoff](HANDOFF_2026_10_16_AGENT_ONLINE_SYNC.md)；不要覆盖既有用户改动、34–37 包工作或 QA 证据。完整范围见 [总台账](38-agent-completion-plan.md)。

## 当前实现

- R01 并行审核/返工：双专业分支、双审核与独立返工、unknown 恢复、等待公平性和模型固定修订指令已有隔离桌面及日志证据，详见 [39](39-parallel-review-rework.md)。
- R03 能力节点：processor、video、image-gen、image-edit、speech、TTS 接入 Agent 命令账本及固定资产；image-edit/TTS 固定输入和输出投影单测通过。`npm run test:agent-flow-commands` 当前源码两进程桌面验收覆盖四类图片/音频命令、取消、回执与脱敏，没有供应商调用。
- R04/R05 建图：有限能力目录、顺序流程、2–4 路并行分支、画布 ghost 预览、显式提交和撤销/重做已实现。2026-10-16 的 Builder 三路桌面报告通过：预览不改图，重开后可提交，协调器并发执行三条独立分支并保留所有资产。
- R06 媒体审核：完整固定图片、完整限长音轨、A/V 时间戳和帧时间线摘要均已进入主进程。`npm run test:agent-flow-media-review` 两进程验收覆盖真实画布审核按钮、全量媒体载荷、回执重开和无模型重放。视频语义只给模型四个画面样本，不能宣称逐帧语义审核。
- R07 有序多参考、prompt bundle 与固定返工修订已实现；三图、双视频、双音轨、项目导入及双进程修订证据见 [40](40-multi-reference-prompt-bundle.md)。
- R08 并行上限扩到四路；共享写范围分支按协调器派发顺序排入 FIFO 波次，独立分支保持并发；等待/重开恢复及四路独立并发回归通过。多成果以固定资产引用集合投影。
- R10 `drainDiagnosticsEvents()` 等待缓冲批次和 renderer→main IPC 确认；视频任务提交、状态、下载和入库事件现沿同一 request/task trace，双进程多参考桌面逐项配对。异步、关窗同步及恢复副本保存均有 trace/span 唯一终态；旧历史调用和进程恢复时未知的祖先 trace 仍会标记 `correlationMissing`。

## 最终验证

之前源码快照的 `npm run verify` 退出 **0**（175 个 Vitest 文件，2001 项通过、1 项既有跳过；model-runtime 2 项通过），不能代表本轮源码。当前使用 `node qa/agent-native-runtime/run-vitest.cjs` 运行相同全量套件：175 文件、2003 项通过、1 项跳过；lint、node/web/model 类型检查、model-runtime 2 项、日志检查和 build 通过。标准 Node 24.12 的 `npm run verify` 中 20 个 SQLite 测试文件因 better-sqlite3 ABI 140/137 不匹配受影响（331 项），Electron-as-Node 同套件全部通过。`test:optimization-ui` 的首项验收报告为 passed；组合 UI 门禁因会覆盖固定 QA 证据而在执行中停止，未记为完整通过。命令、媒体审核和多参考视频两进程桌面门禁及针对性 89 项通过；没有真实供应商调用或账单。

五轴审查检查了正确性、可读性、分层、安全和资源上限；先前版本发现并修正 Builder 并发数字和内部能力 ID 文案。本轮保存 trace、异步视频关联、共享写入 FIFO 和多模态审核经过针对性回归与手工审查；凭据/媒体/数据库/大文件扫描及 `git diff --check` 已完成，远端同步核验仍待最后记录。

桌面三路 Builder 最新报告：`qa/agent-builder-parallel-20261016/desktop/execute-report.json` 和 `reopen-report.json`，两份 status 均为 pass；执行报告检查空间预览与显式提交，重开报告检查三路并发、公共处理器执行及全部分支资产保留。

本机 Electron-as-Node 测试环境使用 `qa/agent-native-runtime/sqlite-loader.cjs` 与 `qa/audio-reference-runtime`。这些是本机 QA 辅助文件，不应作为生产开关或上传依赖。不要覆盖 `qa/optimization-remaining/groups.png`、`results.json` 和既有日志/截图证据。

## 仍需完成或受外部条件限制

- R09：组合故障注入证明软件恢复边界，不能代替物理掉电验收。火山 Ark 官方 DELETE 对 queued 才取消，running 不支持，删除 succeeded/failed 记录会失去查询事实；GET→DELETE 有竞态，当前没有安全远端撤回保证。
- R11：用户选择“暂不做”真实模型/供应商调用；本轮没有发出计费请求。固定夹具验收保留，未来重新启动时再设置费用上限并单独验收供应商质量与 usage。
- R12：代码、测试、脚本、支持矩阵与 handoff 已按已授权范围同步；不上传个人配置、数据库、媒体、密钥、QA 产物或安装包。标准 Node 的 ABI 与组合 UI 门禁限制见最终验证记录。

## 接续顺序

1. 完成本轮五轴审查、完整 verify、差异与产物扫描，并更新 R01–R12 支持矩阵。
2. 同步已完成；远端撤回和实机掉电边界清楚记录。
3. R11 由用户后续决定是否启动；本轮按“暂不做”保留为未验收，不产生供应商账单。
