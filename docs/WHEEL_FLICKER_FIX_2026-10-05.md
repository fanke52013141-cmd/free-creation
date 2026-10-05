# 滚轮缩放明暗闪动修复

## 原因与改动

旧版 CanvasEditor 在 window 捕获所有 wheel 事件，给 body 添加 camera-interacting，250ms 后移除。配套高优先级 CSS 将多选工具条背景强制设为 #1a1f26，覆盖 ui-surfaces.css 的透明样式。滚轮间歇超过 250ms 时，每次操作都会出现透明 → 深色 → 透明的跳变；节点内滚动也会触发。小地图的 backdrop-filter 同时反复开关。

浏览器在真实双节点多选状态读取最终样式，证实工具条背景从 rgba(0,0,0,0) 变为 rgb(26,31,38)，停止后又恢复。节点本体背景及画布点阵背景在该复现中保持不变。

删除动态切换 effect 和 CSS；小地图固定使用 #1a1f26、backdrop-filter:none。工具条继续使用现有透明外观。滚轮路由、缩放公式、节点内容与项目保存路径保持原样。

## 日志影响检查

依据 LOGGING_SPEC.md 与 docs/templates/LOGGING_CHANGE_TEMPLATE.md。

- 受影响文件：CanvasEditor.tsx、ui-foundation.css；验证脚本及本记录。
- 分类：不涉及业务日志。仅删除改变界面材质的全局事件/定时器，固定小地图样式，不改变节点执行、模型、网络、文件、持久化及业务错误行为。
- 开始/终态、关联 ID、重试/恢复及日志失败注入：不适用；不新增逐滚轮或逐帧日志，不采集用户正文、密钥或鼠标轨迹。
- 验证证据：浏览器脚本采集界面背景/模糊/透明度，检查连续与间歇双向缩放、平移及小地图；相关 Vitest 4 文件、35 用例通过。
- 未覆盖边界：浏览器验证不能代替用户当前 Electron 窗口的主观视觉复验；未证明 GPU/驱动造成的其他闪烁已排除。运行中的旧包需退出后启动修复版。

## 验证命令

在 Vite 浏览器验收服务启动后执行 `node scripts/test-browser-wheel-stability.cjs`，可通过 CANVAS_QA_URL 指定端口。证据位于 qa/wheel-flicker/（fixed.png、evidence.json）。

`npm exec vitest -- run test/canvas-wheel-routing.test.ts test/canvas-interaction.test.ts test/canvas-dark-theme.test.ts test/ui-foundation.test.ts --maxWorkers=1 --minWorkers=1`

审查覆盖：删除的事件与定时器没有业务调用方；固定样式沿用旧降级颜色；CSS 层叠由浏览器最终样式验证；不新增订阅、热路径状态或敏感日志。

构建与门禁：受影响 TSX/验收脚本 ESLint、verify:logging、完整 node/web 类型检查及生产构建通过；独立 Windows 修复包生成于 dist/wheel-flicker-fix-20261005/win-unpacked，校验其 HTML/CSS 入口及旧动态材质规则已移除。没有替换用户正在运行的 current-source-release。

仓库提交范围：本修复单独提交 5 个文件，不包含工作区其他开发改动。提交前从 Git 暂存区导出独立副本，再次验证 35 项定向用例、完整 node/web 类型检查、生产构建及实际浏览器滚轮材质稳定性，均通过。临时浏览器服务使用独立缓存，避免与工作区服务共用 Vite 缓存。
