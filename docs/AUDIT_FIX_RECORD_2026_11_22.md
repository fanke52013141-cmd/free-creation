# 审计修复批次记录 · 2026-11-22

> 本文件是 2026-11-22 审计修复批次的仓库内备注（Commit 说明之外的长期记录）。
> 完整证据（运行前后截图、manifest、逐项覆盖、缺陷清单）在工作区 `audit-20261122/`，不随代码仓库提交。
> 发布标记：annotated tag `audit-20261122`。

## 基线

| 项 | 值 |
|---|---|
| 起点 | `28d02e8`（BL-05~08 四个小 P0） |
| 终点 | 本批次最后提交（tag `audit-20261122`） |
| 说明 | 合并了主干上未提交的 agent-flow / agent-access WIP，并按铁律补齐契约快照与 change-impact |

## 修复清单

### D-01 文本节点：运行结果不写回正文，新增只读结果区

- **问题**：文本执行器把「上游 + 正文」的合并结果写回 `props.text`；上游集合变化后旧前缀无法识别，内容累积成 `A、C、A、B`。
- **修复**：结果只写 `meta.nodeResult`（带 `runId`），投影按 `currentTextResult(shape)` 取本次运行；卡片新增只读「运行结果」区（`NODE_UI_STANDARD §24.5`）。
- **测试**：`test/text-merge-accumulation.test.ts`、`test/flow-target-text.test.ts`、`test/flow-matrix-basic.test.ts`、`test/flow-matrix-model-host.test.ts`。

### D-02 对话节点：就绪检查与执行器同源

- **问题**：就绪检查读 `props.config` 且用 `text.chat`，执行器用 `chat.generate` 并读序列化会话数据；只绑定 `chat.generate` 时节点被判「模型未配置」。
- **修复**：`models.ts` 新增 `CHAT_FEATURE_KEY`；`NodeCardView` 经 `chat-readiness.ts` 读会话数据。
- **测试**：`test/chat-model-binding.test.ts`；桌面证据：文本→对话→文本 12/12。

### D-08 操作节点：卡内结果区读运行结果

- **问题**：语音合成 / 音色设计 / P图的结果区以 `props.mediaPath` 为门，而操作节点按产物不变式禁止持久化 mediaPath，结果区永远是死的。
- **修复**：新增 `latestSuccessMediaResult(shape)`（仅成功运行取 nodeResult 最近一条）；三个 Body 的播放器/预览/对比图统一改用；未运行/失败保留工作台入口（`NODE_UI_STANDARD §24.6`）。
- **测试**：`test/media-result-area.test.ts`；桌面证据：注入成功运行结果后 P图显示结果图、语音出现播放器 9/9。

### D-25 时间线：成片时长按时间线总时长

- **问题**：`composeTimeline` 只累计视频轨末尾，音频轨用 `amix duration=longest` 延长后又被 `-t` 截回；界面 00:09、成片 5.04s，尾部音频被丢弃。
- **修复**：先解析音频轨，按 `max(视频末尾, 音频末尾)` 出片；视频轨不足用黑帧补齐尾部。
- **测试**：`test/timeline-compose.test.ts` 新增真实 FFmpeg 用例；桌面复跑 11/11（成片 9.06s = 00:09）。

### D-15 可选输入重复询问 / 等待输入无反馈

- **问题**：全局汇总预检只记录实际填值；留空的可选端口在节点级预检再弹一次，单端口兜底还会第三次询问；等待期间顶栏仅显示「执行中…」。
- **修复**：`WorkflowInputOptions.skippedPorts` 记录「已确认跳过」，节点级 `unsupplied` 与 `missing` 均过滤；`CanvasPage` 在等待输入时显示「等待补充输入…」。必填端口不受影响；跨「再次运行」仍重新询问（每轮独立）。
- **测试**：`test/manual-run.test.ts` 新增去重用例；桌面矩阵新增 `d15-feedback` 配方 9/9。

## 测试与门禁

| 检查 | 结果 |
|---|---|
| `npm test` | 3781 passed / 7 skipped |
| `npm run typecheck` / `npm run lint` | 通过 |
| `npm run test:contract` | 331/331 |
| `npm run guard:agent-parity` | 契约、动作分母、日志三关全绿 |
| `npm run test:node-matrix` | **269/269**（旧断言校准后；覆盖缩放坞、文本结果区、就绪提示、代码稳定端口、图片取景、声音控件、停止续跑延迟弹窗等） |
| `test/iteration-any-coverage.test.ts` | iteration 43 条注入边 + any 口 50 条透传边契约锁定 |

## 测试环境要点

- Electron 桌面测试必须清除 `ELECTRON_RUN_AS_NODE` 并设置 `CANVAS_LICENSE_DEV_BYPASS=1`；
- UI 级 Agent / 审核 / 对话链路需在 5196 起渲染层 dev server（见工作区 `audit-20261122/tmp-review-dev-server.mjs`）。

## 已知遗留

1. 深度/白模本地推理环境未安装时按「环境跳过」记录（不计产品失败）；
2. 代码节点参数改名/多值编辑在 Playwright 合成输入下不落盘（pre-merge 基线同样复现），矩阵保留端口级断言并显式留痕；
3. 其余覆盖缺口与缺陷分级见工作区 `audit-20261122/`（连接逐项覆盖、缺陷清单、SIGN-OFF）。
