# Agent Flow 新增节点与流程测试方案

日期：2026-10-26。基线：`origin/main` @ `fdea986`（含 `194e19b` 本地功能交付：L1–L4 / Skill / 状态机独立执行 / 媒体停止 / P2-B Flow target 扩展 / A1.4 只读查询 / 审查 P1 修复）。

## 1. 目标

1. 验证近期新增的节点与 Agent Flow 流程在当前源码基线上能否跑通（编译、契约、执行、持久化、恢复、门禁全链）。
2. 发现真实缺陷并分级记录，形成测试报告与优化意见。
3. 按优化意见修复可修复项，回归验证后提交推送 origin/main。

## 2. 被测范围

| # | 被测对象 | 对应交付 | 主要风险 |
| --- | --- | --- | --- |
| N1 | 状态机节点（state-machine）独立执行 | P2-A：配置声明迁移、卡片提交事件、修订号乐观锁、lastEventId 去重、配置漂移显式失败、快照重开一致 | 事件重复/乱序、配置漂移、重开丢失 |
| N2 | 内容 Skill（chat / ai-process 节点） | SKILL_AGENT_DELIVERY：版本化 Skill 库、内容 hash 版本不可变、有限步数内容循环、skill.read-resource | 版本冲突、预算、越权工具 |
| N3 | Flow target 扩展至 9 种 | P2-B：新增 image-crop@2 / image-split@3 / code@3，命令准入校验 | 非法 config 归类错误、单参数单输出约束 |
| N4 | 媒体运行中停止与一致性 | P1-A/P1-B + L1 停止准入：真终止、迟到成果、占用释放、保存重开一致、summary 按 trace/span 配对 | 停止后假成功、资源泄漏、状态漂移 |
| N5 | 外部接入 A1.4 只读查询 | model.list / library.search / run.get / diagnostics.summary，CLI/MCP 共 18 项 | 契约漂移、脱敏泄漏 |
| N6 | Agent Flow 主链路回归 | 建图预览/提交、主控协调、专业任务、人机等待/继续、审核与三类返工、恢复、并行媒体、资产/命令账本 | 既有回归破坏 |

不在本轮范围（维持既有边界）：R11 真实供应商付费调用、物理掉电、安装包更新、Skill 目录/ZIP/脚本扩展、P1-B 剩余 correlationMissing 历史路径。

## 3. 环境与前置

- Windows 10.0.26200 / Node 24.12 / pnpm 10.33 / ffmpeg 8.1（PATH 可见）。
- 源码目录 `D:\Program Files (x86)\canvas-studio\source`，工作树必须干净（`git status` 为空）后再执行。
- 浏览器门禁用 Chrome/Edge headless（`scripts/qa-browser.cjs` 自动选择），Vite 服务端口 5194。
- Electron 桌面测试使用合成供应商/SDK 夹具，不产生供应商费用；隔离数据目录，退出即清理。
- 全部证据写入 `qa/verification/agent-flow-test-20261026/`（本地产物，不入库）。

## 4. 分层测试矩阵

| 层 | 内容 | 命令 | 通过标准 |
| --- | --- | --- | --- |
| A 静态门禁 | lint + 三组类型检查 | `npm run lint`、`npm run typecheck`、`npm run typecheck:model` | 退出码 0，无新增告警 |
| B 单元/集成 | 全量 vitest（含 agent-flow 40+ 测试文件、状态机、Skill、媒体停止、恢复） | `npm run test`；补充 `npm run test:contract` | 全部通过（允许既有跳过 5 项） |
| C 专项门禁 | 日志覆盖 + 外部接入契约 | `npm run verify:logging`、`npm run verify:agent-access` | 退出码 0 |
| D 浏览器行为 | UI 门禁（含 local-stop / local-consistency / skill-agent / agent-flow-tab/c1/declarations/anchors/assets） | `npm run test:optimization-ui` | 退出码 0 |
| D+ 计划外补充 | P2-A 状态机真实画布验收（**未接入任何 npm script**，单独执行） | `node scripts/test-browser-state-machine.cjs`（经门禁服务 5194） | 断言全过 + 证据落盘 |
| E 桌面端到端 | Agent Flow 主链路（建图/协调/并行/审核/返工/恢复） | `test:agent-flow-desktop` 及 `--coordination/--builder/--builder-parallel/--review/--rework×3/--recovery` | 每个 Electron 场景退出码 0 |
| E+ 新增专项 | 媒体停止桌面验收 + Skill 桌面验收 + 资产/命令 + 外部接入 | `node scripts/test-media-local-acceptance.cjs`、`node scripts/test-skill-agent-electron.cjs`、`test:agent-flow-assets`、`test:agent-flow-commands`、`test:local-agent-access`、`test:diagnostics-window-close` | 退出码 0 |
| F 构建 | 生产构建作为桌面测试前置 | `npm run build`（electron-vite build） | 退出码 0 |
| G 回归抽样 | 视频适配器与并行媒体各抽 1 条 | `test:agent-flow-video`、`test:agent-flow-parallel-media` | 退出码 0 |

## 5. 重点功能用例（E/D+ 层关注点）

**状态机（N1）**：draft→working→completed 声明式迁移；人工事件提交推进；重复事件去重；非法事件拒绝；修订冲突恢复；JSON 快照重开后阶段一致；完成态 out-state 投影。

**Skill（N2）**：SKILL.md/JSON 安装进本地库；版本 hash 不可变；chat/ai-process 绑定后有限步数自主读取参考资源；无技能回退原行为；越权工具（shell/任意文件）拒绝；取消与预算耗尽路径。

**媒体停止（N4）**：拆图/截取运行中停止 → 真终止（无迟到成功写库）→ 资源槽释放 → 可编辑重跑；固定结果在上游失败/取消时不静音；强杀后重开只核对原任务或补提交，不自动再生成；保存重开正文/配置/连线/结果一致。

**A1.4（N5）**：18 项操作契约快照一致；model.list/library.search/run.get/diagnostics.summary 输出不含密钥与正文；operationVersion 不变。

**主链路（N6）**：预览→显式提交→主控分派→专业任务完成→人机等待/继续→审核通过/返工（autonomous/collaborative/manual）→恢复重开接回→并行媒体 2 路不冲突。

## 6. 执行顺序与记录

1. A → B → C（快速失败：静态与单元先行）。
2. F 构建 → D → D+ → E+ → E → G（先新增专项，后主链路回归）。
3. 每条命令记录：开始/结束时间、退出码、关键断言输出、证据目录。
4. 缺陷分级：P1 阻断主链路或数据一致；P2 功能缺陷有绕行；P3 门禁/工程化缺口；P4 建议项。

## 7. 退出标准

- A–G 全部按矩阵执行并有退出码证据；
- 发现的 P1/P2 全部修复并回归，P3 记录处理决策；
- 报告（`docs/AGENT_FLOW_TEST_REPORT_2026_10_26.md`）含通过/失败矩阵、问题清单、优化意见；
- 修复与文档一并提交推送 origin/main，提交信息符合仓库惯例（feat/fix/docs + 中文说明）。
