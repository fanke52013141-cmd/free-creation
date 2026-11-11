# 节点流优化接续与本次提交备注

2026-11-11。后续以[节点流执行方案](WORKFLOW_IMPLEMENTATION_PLAN.md)和[执行 Agent 指令](WORKFLOW_AGENT_INSTRUCTIONS.md)为入口。此前[组合编辑交接](COMPOSITE_HANDOFF_2026_11_11.md)及[发布备注](RELEASE_NOTES_2026_11_11.md)保留为已实现基线。

## W1 文本调用闭环（2026-11-11）

已完成：公开端口稳定映射与编辑保留、文本经 `in-text` 合并、按本次映射收集输出、草稿恢复/不可变发布/固定嵌套版本、升级公共预检、GUI/CLI/MCP 同源契约、运行与发布诊断事件、M28 运行关联字段。详情、兼容结论与未验证边界见 [W1 交付](W1_DELIVERY_2026_11_11.md)；后续执行 Agent 的接手说明见 [W1 交接](W1_HANDOFF_2026_11_11.md)。

行为修订：同版本发布不再覆盖，改为 `VERSION_IMMUTABLE`；历史版本缺省按运行语义 1 保留旧文本替换与首媒体输出行为，新封装写 `runtimeVersion=2`。旧数据不迁移。

## W2 完整画布与统一入口（2026-11-11）

已完成：真实桌面 GUI 全链路自动化验收（12 项检查，Playwright 驱动真实 Electron，非人工点击）、
发布差异预览与关闭未保存确认（Stitch 屏幕 `799a9a6c…` / `acfa2724…`）、验收脚本入仓
（`npm run acceptance:composite-desktop` / `acceptance:composite-gui`）。
过程修复 3 个 GUI 缺陷：defaultValue 必填口径（就绪判定/输入契约/工作流补输入）、全屏编辑层叠遮挡。
详情、兼容结论与未验证边界见 [W2 交付](W2_DELIVERY_2026_11_11.md)。人工点击验收与 W3 范围仍单列未验证。

## W3 多类型与版本生命周期（2026-11-11）

已完成：实例升级 UI（右键「升级节点流」→ 同源预检 → 引用形态写入，兼容连线保留）、
多类型/多端口逐类验收（图片/JSON/多值/多输出/媒体资产，媒体同时写 nodeExtra 供下游消费）、
运行期递归/深度/展开预算守卫、引用保护（references/delete CAPABILITY_IN_USE、归档不阻断）、
固定版本引用 + 仓库解析（config 只存引用、快照缓存 meta，解除 64KiB；存量快照实例不迁移）。
新增 3 个外部操作（156→159），升级预检例外移除并映射 GUI 入口。
过程修复：隔离执行嵌套引用解析缺陷（内部 composite 节点预解析快照缓存 meta）、
升级对话框 set-state-in-effect 与 busy 竞态、验收脚本幂等键/口径/保存竞态/嵌套运行覆盖缺口。
证据：定向 24 文件 186 项、全量 3218 过（2 项基线失败）、桌面 22 项 / GUI 13 项自动化验收、门禁三关全绿。
详情与未验证边界见 [W3 交付](W3_DELIVERY_2026_11_11.md)。人工点击与 W4（真实模型/重启恢复/付费核对）仍单列未验证。

## 此前提交内容

- 现有 UI 调整：保存方式去除外围框及选项描边，组合 ID 与版本同行，公开端口区域去除层叠容器。组合全屏画布把新增工具置左上、关闭置右上，选中节点复用原设置，画布展示现有数据线。背景板工具按横向、纵向、自动整理、圆形颜色排列。
- 刷新受保护源码影响声明。远端已有 `af7bbb1` 修改了 `CanvasSidePanel.tsx` 的组合编辑入口，核对其沿用 `composite.version.get`、`composite.validate`、`composite.draft.save` 和 `composite.publish`，本次生成的 Agent 契约快照内容一致。
- 本次 UI 调整沿用现有保存、发布、排序和配色路径。业务 Schema、执行器、数据库与诊断事件保持原有契约。组合数据线图层仅呈现，新增端口拖线能力归 W2 验收。

## 证据与边界

- 已通过 Web 类型检查、改动文件 lint 和 19 项组合及节点契约定向测试。此前浏览器实测覆盖保存选项与窄屏关闭，背景板浏览器回归覆盖排列、拖动、撤销与重开。Electron 开发窗口已启动供用户测试。
- `npm run guard:agent-parity` 与 `npm run verify:agent-access` 通过，契约、动作分母和日志检查均通过。`npm run verify`（`run-xNYeCN`）在基线 lint 阶段退出，`scripts/activate-dev-license.cjs`、`scripts/license-tool.cjs` 共 25 条错误，后续全量步骤未运行。
- 真实桌面的端口拖线、发布后重开和真实模型运行仍待验收。
- W1–W4 属于待执行方案。本次界面仍沿用现有版本管理、发布和输入处理。旧实现的同版本覆盖与文本正文替换，需要在 W1 处理并验证兼容。Stitch [新项目](https://stitch.withgoogle.com/projects/18414626961577825789)已建，生成请求遇到传输错误，复查时未返回设计稿。
