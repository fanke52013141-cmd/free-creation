# 视频 Agent Flow 回归修复（2026-11-09）

R3 全链中 11 个视频 Agent Flow 脚本稳定失败（`VIDEO_UNKNOWN_NOT_HELD` /
`VIDEO_REWORK_UNKNOWN_NOT_HELD` / `PARALLEL_*`）。已归因为 **2026-10-24 之后的既有回归**
（回退本轮源码到 HEAD 重建同样失败），本轮完成根因修复。

## 一、根因

提交 `9d3f49f`（视频生成退出项目后自动续跑）在供应商受理后把任务号持久化到节点配置：

```ts
// src/shared/engine/executors/video.ts（修复前）
ctx.updateProps({ config: JSON.stringify({ ...rawConfig, taskId: submitted.data.taskId }) })
```

但 `config` 同时参与两条"业务意图"判定：

1. **命令意图语义修订**（`semanticProjectPayload` → `config` 与 `node.params.config`）；
2. **提交期输入指纹**（`computeInputFingerprint` 包含 `config`）。

Flow 命令在下发时记录修订/指纹，供应商受理发生在**下发之后**；执行器写入 taskId 后，
提交阶段重新计算就得到不同的修订/指纹，被判定为"画布已变更 / 输入已变更"：

- `FLOW_REVISION_CONFLICT`，phase `saved-revision`；
- `FLOW_SAVED_INPUT_MISMATCH`，phase `saved-input`。

命令无法 commit，Agent 流程直接失败，而不是按设计停在 `waiting/reconcile` 等待人工核对；
返工与并行流程（依赖 unknown 保持与部分完成）随之全部失败。症状与诊断序列
（`command.operation.failed saved-revision/saved-input` → `FLOW_LEASE_REJECTED` → `mark unknown`）
在 `qa/agent-video-20261015/desktop/` 等证据目录中可复现。

## 二、修复

1. **运行时标记移出 config**：供应商任务号改存 `meta.videoTaskId`
   （`NodeMetaPatch` 新字段；执行器 `ctx.updateMeta`）。`recoverVideoRuns` 优先读 meta，
   旧项目的 `config.taskId` 保留回退，升级后可继续接回既有后台任务。
2. **语义修订归一化**：`semanticProjectPayload` 对视频节点的 `config` / `node.params.config`
   忽略遗留 `taskId`（旧项目仍可能带该字段），其余 mode/modelKey/params 仍参与修订。
3. **诊断改进（测试专用）**：Agent Flow harness 对非稳定码异常保留 `testFailureMessage`，
   避免报告只剩 `AGENT_ACCEPTANCE_FAILED` 而无法定位。

修复后，供应商受理只改变运行记录与 meta，不再改变业务意图；命令提交恢复通过，
unknown 分支按设计进入 `waiting/reconcile`。

## 三、验证

| 项 | 结果 |
| --- | --- |
| `test/agent-flow-command-intent.test.ts` | 9/9（新增：taskId 不参与修订，mode 变更仍参与） |
| `test/recover-video-runs.test.ts` | 通过（新增：meta 优先；旧 config.taskId 兼容） |
| 11 个原红点脚本 | 全部通过（见下） |
| `npm run verify:acceptance` | **9/9 批次通过**（stamp `2026110906462`） |
| `npm run verify`（R3 全链） | 结果见 §五 |

原红点脚本：

- `test:agent-flow-video`
- `test:agent-flow-video-first-frame`
- `test:agent-flow-video-first-last-frame`
- `test:agent-flow-video-reference`
- `test:agent-flow-video-motion-reference`
- `test:agent-flow-media-transfer`
- `test:agent-flow-video-audio-reference`
- `test:agent-flow-video-multi-reference`
- `test:agent-flow-video-rework`
- `test:agent-flow-parallel-media`
- `test:agent-flow-parallel-review`

## 四、影响与边界

- **外部契约不变**：143 操作/32 节点 Schema 未改；CLI/MCP/GUI 共用同一实现，无新增执行器或旁路。
- **兼容**：旧项目 `config.taskId` 仍可接回；语义修订对旧字段取忽略策略，不需要迁移。
- **日志**：无新增事件；修复路径复用既有 `command.operation.*` 与运行诊断，
  不记录提示词、任务正文或供应商标识之外的敏感信息。
- **未覆盖**：真实供应商长任务（付费）仍属 R4；本轮使用隔离 fixture 供应商。

## 五、R3 全链结果

（`npm run verify` 结果在本轮完成后回填。）

## 附：变更文件

- `src/shared/engine/executors/video.ts` — taskId 写 meta
- `src/shared/engine/executor-types.ts` — `NodeMetaPatch.videoTaskId`
- `src/renderer/src/engine/recoverVideoRuns.ts` — meta 优先 + legacy 兼容
- `src/shared/agent-flow/semantic-revision.ts` — 视频 config 归一化（props + params）
- `src/main/agent-flow/desktop-electron.ts` — harness 失败消息留存（测试专用）
- `test/agent-flow-command-intent.test.ts`、`test/recover-video-runs.test.ts` — 定向单测
- `docs/local-agent-access/change-impact.json` — 受保护源码变更声明
