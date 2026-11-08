# 2026-11-08 退出项目后视频生成不再被判中断

## 现象

在项目里发起即梦视频生成 → 返回首页 → 重新进入项目，节点显示：

> 运行 ID … 状态 cancelled
> 应用关闭或重启中断了上次运行，请重新运行

用户不知道到底是生成了、没生成，还是还在等。

## 根因

1. **主进程没有停止任务**：`main/gateway/video.ts` 的 `pollLoop` 在提交后独立轮询，
   与 renderer 是否打开项目无关；app 重启还有 `resumePendingVideoTasks` 续跑。
   所以远端任务通常仍在生成/已完成，结果已落到 `tasks`/`media`。
2. **renderer 把它误判为中断**：重新进入项目时 `CanvasEditor` 加载快照时调用
   `repairTldrawSnapshot(initialSnapshot, { interruptRunning: true })`，
   把所有 running 节点直接改成 cancelled；运行记录写死"应用关闭或重启中断了上次运行"。
3. 原等待循环（`waitForVideo`）随画布卸载丢失，且任务号只存在内存里，重进后没有接回入口。

## 修改

### 1. 提交成功后持久化任务号

`shared/engine/executors/video.ts`：`videoSubmit` 返回 taskId 后，把它写入节点
`props.config.taskId`（随项目保存）。轮询/结果处理逻辑不变。

### 2. 重新进入项目时接回任务

- `CanvasEditor` 加载快照不再 `interruptRunning: true`，running 状态保留；
- 新增 `renderer/src/engine/recoverVideoRuns.ts`，在画布初始化、迁移完成后执行：
  - 扫描 running/pending 节点；
  - 有 `config.taskId`：保持 running，调用 `window.api.gateway.videoTask(taskId)` 每 3s 轮询；
    - success：把 mediaId/mediaPath 写回 `meta.nodeResult`（复用
      `appendMediaResult/serializeMediaResultCollection`），运行记录置 success，节点 exec=success；
    - failed/cancelled：如实落失败/取消与原因；
  - 无 taskId（旧记录、非视频节点）：沿用原逻辑标记 cancelled 并给出原提示；
- 卸载时停止轮询（主进程仍继续，下次进入还能再恢复）。

### 3. 结果不重复计费

恢复只查询原 taskId，不重新提交；主进程同一节点在途任务仍由既有去重保护。

## 用户看到的语义

- 离开项目**不会终止**视频任务；主进程继续轮询；
- 回来时如果后台还没完成：节点保持「运行中」，完成后自动写回结果并提示；
- 如果回来时后台已完成：直接显示结果；
- 只有确实没有可恢复任务号（例如旧版本记录或提交前就退出）才显示「中断，请重新运行」。

## 日志影响

- 复用既有 `gateway.videoTask` 与 main 的 `task.resume_started/task.state_changed` 诊断事件，
  不新增事件字段；恢复过程不记录提示词/密钥/URL；
- 节点运行记录（`meta.nodeRun`）沿用原结构，新增的 taskId 存在 `props.config`，不改变契约 Schema。

## 验证

- 新增 `test/recover-video-runs.test.ts`：
  - 有 taskId → 轮询成功写回 nodeResult 与 success；
  - 无 taskId → 仍标记 cancelled 且原因保持原提示；
- `tldraw-snapshot-repair` 用例保持通过；typecheck/lint 通过。

## 边界

- 退出发生在「提交成功之前」（还没拿到 taskId）时无法恢复，只能重新运行；
- 全量 app 重启时依赖 main 的 `resumePendingVideoTasks` 继续轮询，本恢复负责把结果接回节点；
- 非视频节点仍按原策略标记中断。
