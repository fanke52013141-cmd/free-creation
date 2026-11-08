# 事故与修复报告：视频生成在退出项目后被误判为「应用关闭或重启中断」

**日期**：2026-11-08
**修复提交**：`9d3f49f`（视频后台续跑）与本次补充提交（恢复提示语/运行日志）
**影响范围**：所有在此修复之前打包的客户端；在项目里发起视频生成后返回首页/切换项目，再进入时出现。

---

## 一、用户看到的现象

在项目内发起「即梦」视频生成，返回首页后再进入项目，节点显示：

```
运行 ID：8264f607-…
状态：cancelled
耗时：104983 ms
execution：应用关闭或重启中断了上次运行，请重新运行
```

用户无法判断：到底生成了、没生成，还是仍在等待。

## 二、真正发生了什么（根因）

1. **远端任务并没有被终止。**
   视频提交后，主进程 `src/main/gateway/video.ts` 的 `pollLoop` 会独立轮询供应商；
   画布关闭、返回首页、甚至 app 重启（`resumePendingVideoTasks`）都不会停止它。
   结果仍会落到 `tasks` / `media` 数据库。
2. **renderer 的等待循环随画布卸载丢失。**
   `waitForVideo` 只在当前画布里等待；项目一关，等待就没了，任务号也只存在内存。
3. **重新进入项目时被快照修复误判。**
   `CanvasEditor` 加载快照时调用
   `repairTldrawSnapshot(initialSnapshot, { interruptRunning: true })`，
   把所有 `running` 节点直接改成 `cancelled`，并写死原因
   「应用关闭或重启中断了上次运行」。

所以这条 `cancelled` **只是一条错误的本地状态**，不代表远端失败，也不代表没生成。

## 三、修复方式

1. **持久化任务号**：视频执行器提交成功后把 `taskId` 写入节点 `props.config`，随项目保存
   （`src/shared/engine/executors/video.ts`）。
2. **进入项目自动接回**：`CanvasEditor` 不再无条件中断 running；新增
   `src/renderer/src/engine/recoverVideoRuns.ts`，加载完成后：
   - 有 `taskId`：用 `gateway.videoTask` 继续轮询，完成后把 `mediaId/mediaPath` 写回
     `meta.nodeResult`，运行记录置 `success`，节点恢复为成功；
   - 无 `taskId`（旧版本发起的运行）：标记为不可恢复，并明确提示
     「未找到可恢复的任务号（可能由旧版本发起）；后台任务可能仍在校验中，请先到运行中心核对原任务，避免重复计费后再重跑」；
   - 恢复过程会向运行记录写入一条 trace，并在接回/完成时 toast 提示。
3. **不重复计费**：恢复只查询原 taskId，不重新提交；主进程对同节点在途任务仍有去重保护。

## 四、对已打包客户端意味着什么

- **你现在这个安装包仍然有该问题**，因为修复在打包之后；旧包里发起的运行没有保存 taskId，无法自动恢复。
- 需要**从最新 `main` 重新打包**：
  - 开发包：`npm run build`
  - Windows 安装包：`npm run build:win`
  - 发行分发：`npm run build:distribution`
  - 或按你们现有流程 `build:unpack` / `build:desktop-latest`
- **无需数据库迁移**：taskId 只存在节点 `props.config`，不新增表/字段；旧项目可正常打开。
- 旧版本已经产生的 `cancelled` 记录不会被自动修复；重新运行即可。新版本发起的运行才会自动续跑。

## 五、打包前建议检查

1. `git log -1` 确认包含修复提交（`9d3f49f` 及之后）。
2. `npm run typecheck`、`npm run lint`、`npm run build` 通过。
3. 手动冒烟：
   - 发起视频生成 → 返回首页 → 重新进入项目；
   - 预期：节点保持「运行中」并提示「已接回 N 个后台视频任务」，完成后自动出现结果；
   - 若是旧版本残留的运行，预期提示「未找到可恢复的任务号…」而不是笼统的「应用关闭…」。
4. 可选：查看运行中心日志，应能看到接回/完成记录（trace 已写入节点运行记录）。

## 六、验证证据

- 新增 `test/recover-video-runs.test.ts`：有 taskId → 成功写回；无 taskId → 明确不可恢复原因；
- 浏览器端到端：running 节点带 taskId → 返回首页 → 重新进入，节点自动变 `success` 且结果写入；
- 全量单测 264 文件 / 3089 项通过（7 skipped）；typecheck / lint（本次改动文件）/ 生产构建通过；
- 详细实现边界见 `docs/VIDEO_BACKGROUND_RECOVERY_2026_11_08.md`。

## 七、已知边界

- 退出发生在「提交成功之前、还没拿到 taskId」：无法恢复，只能重跑；
- 非视频节点仍按原策略标记中断；
- 老客户端遗留的 cancelled 运行不会追溯修复，需要重跑。
