# 首个开发里程碑交付：A/B/C 三画布 → 执行 → 保存重启 → GUI 续编（真实桌面验收通过）

日期：2026-11-08。基线：F3（`11ad6dd`）。

## 1. 验收结论

`node scripts/test-agent-graph-milestone.cjs` 在真实 Electron 桌面（`npm run build` 产物 + 独立数据目录 + 授权协作激活）上完整通过，证据固化于 `qa/local-agent-access/milestone-a-b-c/`（report.json + 重开画布截图 + 失败时诊断包）。十项检查全部通过：

1. CLI 创建三个独立项目画布（角色素材/视频剪辑/配音），ID 互相独立。
2. 串行打开后逐张 `graph.patch` 批量建图（每张 4 节点 + 2 连线，同批 ref→正式 ID 映射返回）。
3. 同幂等键重放返回原回执，不重复产生节点。
4. 非法操作（悬空引用、不兼容端口）整批拒绝，画布无半张成功图。
5. 人在 GUI 输入未保存正文后：Agent 过期版本被 REVISION_CONFLICT 拒绝；用户正文被保存且未被覆盖（数据级验证）；新版本重试成功。
6. `node.execute` 提交确定性文本流程（script → processor(pass) → merge），`run.wait` 等到 completed，`output.get` 读到正式合并文本（用户改写正文 + 批次前缀同时在场——证明执行用的是最新权威内容）。
7. 项目隔离：B/C 的图不含 A 的节点，跨项目无泄漏。
8. 保存 → 关闭 → 重启：三张图结构与版本一致，任务账本终态可查（run.get 仍返回 completed）。
9. 人在 GUI 重新打开 A，节点可见，双击正文继续编辑，数据级验证新正文进入权威宿主。
10. 诊断 JSONL 存在且不含提示词/正文/用户内容（脱敏断言）。

## 2. 过程中发现并修复的真实缺陷

1. **读取型桌面请求取消自动保存调度**（真实缺陷，里程碑发现）：read-graph/execute-nodes 等 handler 公共路径 `clearTimeout(saveTimerRef)`，未保存编辑因此失去唯一落盘调度，dirty 状态永久滞留。已修复：计时器清除移入会执行保存的分支。
2. **graph.patch 无条件 flush 推进版本**：改为仅在有未保存修改时落盘，避免无谓版本前进把每次首批编辑都变成冲突。
3. **执行终态补保存屏障**：run 报告 completed 前先 `ensureCanvasSaved`，正式结果落盘才算完成；保存失败如实报 failed。
4. 验收脚本侧修正：授权门禁协作激活（导出申请→issuer 挑战→证明→发证→导入，与 test-license-electron.cjs 同一合法路径）；版本一律先读权威修订再提交，不猜测。

## 3. 现状与边界

- 外部操作现共 32 项（F3 后），覆盖：项目全生命周期、画布读写编辑、单节点/子图执行、任务查询/等待/取消、确定性正式输出读取。
- 多画布为**串行**口径（显式 project.open 切换）；两画布并发按计划在 F8。
- 付费模型路径未验收（无预算授权）；里程碑流程全部为确定性本地节点。
- `test-local-agent-access.cjs`（既有桌面验收）因授权门禁需同一激活流程，其工具数检查已更新为 32；该脚本的授权协作改造列入下一包。
- 31/25 等历史计数为旧口径；当前权威分母见 [action-coverage.json](action-coverage.json)（206 动作，29 项 external）。

## 4. 下一工作包

F4 图片素材：媒体登记/导入公共服务 + image/image-gen/image-edit/image-crop/image-split 逐类接入（执行、参数 Schema、取消、结果选择、物化），并为既有桌面验收脚本补授权协作。
