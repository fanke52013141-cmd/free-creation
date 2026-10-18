# 2026-10-19 优化与验收收口交接

日期：2026-10-19  
基线：`b96faf4`（`origin/main` 与本轮开始时的 `HEAD` 相同）  
方案：[OPTIMIZATION_EXECUTION_PLAN_2026_10_18.md](./testing/OPTIMIZATION_EXECUTION_PLAN_2026_10_18.md)  
主台账：[AGENT_TEST_REPORT_2026_10_16.md](./testing/AGENT_TEST_REPORT_2026_10_16.md)、`testing/AGENT_TEST_EXECUTION_2026_10_16.csv`

> 本文件记录截至 2026-10-19 的工作树交付内容。`qa/`、`dist/`、`out/` 按仓库约定不入库；文中引用的 `qa/...` 证据位于本次交付机器，需随交付包单独保存。

## 1. 结论

执行方案的 0–5 步已全部执行；6/7 按前置条件维持暂缓/阻塞。

- 144 项主用例：**113 通过、0 失败、18 未执行、12 暂缓、1 阻塞**。
- P0：**97 通过、0 失败、1 未执行（REL-08）、5 暂缓、1 阻塞**。
- 本轮关闭：**CFG-03、REL-02、REL-03**。
- 仍未签字：**REL-08 发布门禁**（剩余 18 项未执行、12 项暂缓、1 项阻塞；缺签名安装/干净机器验收）。
- AI-01…AI-12 维持暂缓；REC-12 维持阻塞。

## 2. 本轮完成的工作

### 2.1 控制关系连线显示（方案步骤 1）

- 新增 [agent-flow-relation-geometry.ts](../../src/renderer/src/canvas/agent-flow-relation-geometry.ts)，把锚点、曲线与标签几何从 React 组件中抽出。
- [AgentFlowRelationLayer.tsx](../../src/renderer/src/canvas/AgentFlowRelationLayer.tsx) 改为纯投影：
  - 横向节点从相对左右边出入，纵向节点从上下边出入；
  - 斜向/近邻布局在 4×4 边组合中取最短且不穿过卡片的路径；
  - 箭头终点落在目标卡片外边缘；标签避开所有卡片；
  - 重叠卡片固定从共同外侧绕行，避免缩放时锚点边翻转。
- 关系配置、授权范围、数据 DAG、点击标签打开设置的行为未改；纯显示变更，不涉及业务日志。
- 新增 `test/agent-flow-relation-geometry.test.ts`（11 项）与 `scripts/test-browser-agent-flow-relation-anchors.cjs`，并接入 `test:optimization-ui` 门禁。真实画布覆盖横向/纵向/斜向/重叠/阻挡卡片、移动与 0.5 缩放。

### 2.2 Agent 流程与验收链路硬化

工作树还包含此前多轮未提交的 Agent Flow 收口代码，本轮一并交付：

- **模型准入与工具能力**：新增只读决策模型预检与显式 Agent 工具调用验证，启动/继续/建图/审核入口在保存、工作流准入、任务写入和模型请求前拒绝缺失/禁用/能力不足配置。
- **命令与成果**：固定输入版本、输出集合、命令台账、回执重放、unknown 恢复、占用/lease、预算与停止路径的回归与修复。
- **审核与返工**：完整图片/音频/音画/采样视频审核证据，审核拒绝/有界返工/复审 gate，迟到裁决与停止边界。
- **恢复与诊断**：保存阶段故障注入、跨进程重开、强退/unknown 核对、诊断事件脱敏、renderer/main 退出 drain 与丢弃计数。
- **桌面验收夹具**：`scripts/test-agent-flow-desktop.cjs` 扩展、M01/M03/M06/M08 包级脚本与清单、`scripts/test-renderer-save-recovery.cjs` R09 路径。
- **UI/配置**：ModelCatalogPanel 的 Agent 验证入口、Agent/审核/Builder 控件、项目列表与首页删除/恢复交互、节点指针策略。
- **依赖补丁**：`patches/@tldraw__editor@4.5.12.patch` 修复 `FocusManager` bound handler 身份问题（PER-04），并在 `pnpm-workspace.yaml` 登记。

### 2.3 文档与证据

- 新增/更新：
  - [GAP_MAP_2026_10_18.md](./testing/GAP_MAP_2026_10_18.md)
  - [CFG03_CLOSURE_2026_10_18.md](./testing/CFG03_CLOSURE_2026_10_18.md)
  - [REL03_SUPPORT_MATRIX_2026_10_18.md](./testing/REL03_SUPPORT_MATRIX_2026_10_18.md)
  - [AGENT_TEST_REPORT_2026_10_16.md](./testing/AGENT_TEST_REPORT_2026_10_16.md)（追加本轮逐日结论）
  - `AGENT_TEST_EXECUTION_2026_10_16.csv`（追加 CFG-03、REL-02、REL-03 收口记录）
- `docs/LOGGING_COVERAGE.md` 与 `docs/canvas-agent-flow/10-c1-control-declarations.md` 同步本轮边界与锚点说明。

## 3. 验收证据

### 3.1 最终快照全量验证

- 命令：`npm run verify`
- runId：`run-ubMAld`
- 时间：2026-10-18T15:35:14.565Z–15:49:43.211Z，退出码 0
- 结果：192 个 Vitest 文件 **2377 通过 / 1 跳过**；model-runtime 2/2；ESLint、Node/Web/model 类型检查、日志旁路门禁、优化 UI 浏览器门禁、Electron/Vite 生产构建、全部 Agent 桌面 fixture 通过。
- 清单：`qa/verification/run-ubMAld/execution-manifest.json`（含源码 diff、out 哈希 `e5e725a5…2d4248b`、逐文件 SHA-256、`verify.log`、`status.json`）。

### 3.2 REL-02 最终包

- 包：Windows x64 `win-unpacked` v1.0.0，exe `2e275ed2…fa8ed61`，app/out `e5e725a5…2d4248b`（28 文件）。
- 同一包上通过：
  - M01：公开 Agent 启动、工具验证、一次授权 processor、固定文本成果、新进程重开；
  - M03：Builder 预览、显式提交、重开、重复提交无重复节点；
  - M06：首轮审核拒绝、一次有界返工、第二轮通过、下游批准后执行、双进程重开；
  - M08：公开 UI 导出 3,494 字节 bundle、导入并打开、项目/媒体/固定版本重映射、媒体 SHA-256 保持 `6a8f6823…471b8`、SQLite 完整、新进程恢复画布与 Agent 正文；22 项检查全为 true。
- 清单：`qa/agent-comprehensive/run-20261018-optimization-final-package/execution-manifest.json`；M08 清单：`qa/agent-comprehensive/run-20261018-optimization-rel02-m08/execution-manifest.json`。
- M08 的文件选择器通过**验收进程主进程 inspector**替换 `dialog.showSaveDialog/showOpenDialog`，不修改产品源码或包内文件；导出/导入/事务/重映射仍走正式 IPC 与存储。

### 3.3 REL-03 支持矩阵

- 冻结目标：processor@1、video@7、image-gen@3、image-edit@2、speech@4、tts@4；`test/agent-flow-target-matrix.test.ts` 4/4 防止漂移。
- 旧手动文本/图片/音频/视频路径：最终包双进程运行/保存/重开。
- 受控 gate/占用：正式包旧图像/音频/视频节点在 Agent unknown 占用下拒绝；未支持目标 `image-crop`/`sound-adjust` 启动前拒绝。
- 支持目标 Agent 正向：桌面 Electron 命令/视频 fixture（`test:agent-flow-commands`、`test:agent-flow-video`）。
- 边界：媒体目标正向使用源码 Electron 桌面夹具，不是正式包媒体 UI；真实旧客户项目人工走查和真实供应商生成质量不在本用例声明范围。

## 4. 未完成 / 发布门禁

REL-08 仍为“未执行”，不能签字：

- 18 项主用例未执行：CFG-07/CFG-08、SKL-07、BLD-08、MED-07、REC-11、LOG-06/LOG-08、PER-02/05/06/07/08、REL-04/05/06/07 等。
- 12 项 AI 专项暂缓：需先冻结供应商、模型、单次/总预算、语料、质量判据、停止线。
- REC-12 阻塞：需先冻结可丢弃设备/数据、断电注入、丢失窗口、恢复判据与清理步骤。
- 未做签名安装/干净机器安装验收；不得把全量自动化通过当作发布签字。

## 5. 复跑方式

```powershell
# 本机 DSH 环境默认注入 ELECTRON_RUN_AS_NODE=1，桌面/打包验收前必须清除
Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
npm run verify
```

定向回归：

```powershell
npx vitest run test/agent-flow-relation-geometry.test.ts test/agent-flow-target-matrix.test.ts
npm run test:agent-flow-commands
npm run test:agent-flow-video
npm run test:optimization-ui
```

最终包：`qa/agent-comprehensive/run-20261018-optimization-final-package/package/win-unpacked/canvas-studio.exe`。  
M08 驱动：`qa/agent-comprehensive/run-20261018-optimization-rel02-m08/m08-inspect-drive.cjs`（export/import 两阶段）。

## 6. 提交与推送备注

- 分支：`main`；远端：`https://github.com/fanke52013141-cmd/free-creation`。
- 提交范围：`src/`、`test/`、`scripts/`、`docs/`、`patches/`、`package.json`、`pnpm-lock.yaml`、`pnpm-workspace.yaml`。
- 明确排除：`qa/`、`dist/`、`out/`、`node_modules/`、临时 `0/1/2` 文件、构建产物与截图。
- 建议提交信息：

```
feat(agent-flow): close optimization acceptance for CFG-03, REL-02 and REL-03

- add side-aware control relation geometry with arrow/label collision handling
- harden Agent model/tool preflight, command ledger, review/rework and recovery paths
- add desktop/package acceptance fixtures and final-package manifests
- close CFG-03, REL-02 and REL-03 in the test ledger and report
- document REL-08 release-gate and AI/REC-12 dependencies
```

- 本轮不宣称发布完成：REL-08 未签字，剩余未执行/暂缓/阻塞项见第 4 节。
- 本次交付提交：`f314f0f`（`main`，已推送 `origin/main`；amend 前为 `04230b1`），108 个文件、13,424 行新增、304 行删除。

## 7. 接手提示

1. 先 `git fetch origin && git status -sb`，确认 `main` 与线上一致。
2. 复核第 3 节证据时以清单中的 SHA-256 为准，不以截图或文件大小代替。
3. 若继续 REL-08，先关闭第 4 节未执行项，再对新的最终快照重跑完整 `npm run verify` 并重新生成清单。
4. 若只做桌面验收，务必清除 `ELECTRON_RUN_AS_NODE`；否则打包 Electron 会以 Node 模式退出（`bad option`）。
5. `qa/` 不入库，迁移机器时需单独打包保存 `qa/verification/run-ubMAld/`、`qa/agent-comprehensive/run-20261018-optimization-final-package/`、`run-20261018-optimization-rel02-*/` 及 `run-20261018-relation-anchors-v1/`。
