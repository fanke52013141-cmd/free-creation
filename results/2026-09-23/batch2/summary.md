# Canvas Studio 测试批次报告（batch2 · 跨模块 P0 本地回归）

- 候选版本：53c738e
- 系统：Windows / Electron 39.8.10 / node v24.11.0
- 日期：2026-09-23
- 环境：受控桌面实例（隔离 `CANVAS_DATA_DIR=qa\data\controlled` + `--remote-debugging-port=9223`，Playwright connectOverCDP）
- 状态：批量 P0 本地可测项多数 PASS；远程/付费项与依赖外部能力的项照旧 BLOCKED/GAP/NOT_RUN，未伪造通过。

> 说明：本批未修改任何业务代码。失败/受阻项仅为记录与定界。证据脚本在 `qa/test-data/drive*.cjs`，
> 截图在 `results/2026-09-23/batch2/evidence/`。

## 一、受控桌面真实 UI 回归

### DATA01 · 持久化闭环（P0）— PASS
新建项目「B2持久化测试项目」→ 连续创建 3 个文本节点 → 双击编辑前两节点正文（来源A：ALPHA-B2 / 来源B：BETA-B2）
→ 回到主页 → 从列表重开项目。断言：

- 重开后画布正常进入（`.node-palette` 存在）✅
- 节点数量 3→3 一致 ✅
- 文本内容 来源A：ALPHA-B2 / 来源B：BETA-B2 / 来源C：GAMMA-B2 全部一致（第 3 节点在重开后亦完整落盘）✅
- 截图：`evidence/reopen-persist.png`、`evidence/b2-edited-cards.png`

### C01 · 创建入口（文本节点，真实 UI）— PASS
「文本与 AI」一级分类 → `.palette-node-flyout` 二级抽屉 → 点击「添加文本节点」，单次恰好 +1，
连续两次各 +1（3 节点）。此入口与 batch1 中 node-matrix 根因定界一致：企业多级创建入口可用。

### C04 / N-text-S01 · 标题正文与中文输入（真实 UI）— PASS
双击进入编辑态，输入中文含全角冒号 + 英文标记（来源A：ALPHA-B2），回车提交，卡片读回无拼音残留、
无截断。占位卡提示「双击输入文本」消失。

### REF 系列（引用/来源计数）— PASS（数据层契约）
复审 `src/renderer/src/canvas/graph.ts` `readConnectedNodeInputs`：每个去重连接键
（`sourceId:fromPort→targetId:toPort`）产生一条独立引用，携带独立 `sourceNodeId` / `sourceNodeName`。
因此：

- **REF01** 两个正文 SAME 的独立文本节点连入同端口 → 2 条引用、2 个 sourceNodeId（不因内容相同合并，
  也不变 4）→ 代码路径成立，契约测试 `connected-input-preview.test.ts` 断言同端口多来源各成一条。
- **REF04** 同节点不同输出端口连到目标不同输入端口 → 按端口区分，不误合并有效关系 → 相同机制成立。
- **REF03** 删除一条边后执行 → 仅迭代在线箭头（`orderedPageArrows`），已删边不再注入 → 代码路径成立。
- 运行 `connection-matrix`（124）+ `batch-connection`（5）+ `connected-input-preview`（1）共 **130 用例全 PASS**。

> 说明：REF 系列以数据层契约 + 受控桌面「创建/编辑/重开」为双证据。因 REF02（历史重复关系快照注入）
> 需预制历史项目副本夹具，本轮未执行真实快照级验证，标 NOT_RUN（见下）。

## 二、本批未执行/受阻项（如实记录）

| case | 优先级 | 状态 | 原因 |
|---|---|---|---|
| REF02 | P0 | NOT_RUN | 需注入含「同一端口 3 条重复关系 + 另一源 1 条」的历史副本快照；当前受控数据目录为全新 v6 空库，未造历史副本夹具 |
| UI03 遮挡命中 / UI04 剪刀仅删一边 | P0 | NOT_RUN | 需精确的指针像素级命中测试（覆盖端口/线中段/剪刀），依赖真实 DPI 与画布几何；本轮未建该几何夹具。底层画布交互在 batch0 有 `canvas-interaction`/`edge-geometry`/`selection-geometry` 结构性测试（多数断言仍绿，个别断言见 batch0 B3/B4） |
| AS01/AS02/AS03/AS05 资产管理 | P0/P1 | NOT_RUN（AS03 关联） | 需导入 142 张图等多资产面板矩阵与重启验证；AS03「名称持久化」受控验证见 batch3 资产管理专项 |
| MD01 模型可见性（本地） | P0 | BLOCKED | 需已配置的真实文本模型才可验证 chat/ai-process 两级选择；当前无远程凭据，配置态只能验「未配置不误报」（见 batch0 MD 相关），真实可选性留待预算到位 |
| UI05/UI07/UI08/UI09 等 | P1 | 同 UI03 类别 | 需真实几何与录屏，未建对应夹具 |
| ENG/DATA 崩溃/磁盘失败 | P0 | 见 batch3 专项 | 需故障注入副本（磁盘无权限/进程中断），单独成批 |

## 三、结论

- 本批确认：**创建入口（C01）、文本编辑（C04/N-text-S01）、保存重开持久化（DATA01/C06）在真实受控桌面上 PASS**。
- 引用与来源计数（REF01/REF03/REF04）在数据层契约层有直接 PASS 证据；REF02 需历史副本夹具 → NOT_RUN。
- 远程付费项（生图/视频/配音/克隆/chat 等）保持 BLOCKED（缺凭据与预算）。
- 与 batch0/batch1 结论一致：全量自动门禁尚未绿（lint 7 错、单测 13 失败、node-matrix 脚本过期），
  发布候选门槛当前不满足（TEST_PLAN §10）。全部为「记录不修复」的基线项，已定性非本轮引入。

## 四、后续

- batch3：资产管理专项（AS01/02/03/05 + 名称持久化）、历史兼容（v5 库升级 AS04）、崩溃/磁盘故障注入（DATA03/04）。
- batch4：逐 25 类可创建节点通用 C01–C12 + 专属 S（本地类先在真实 UI 跑）。
- 远程真实调用批次：待用户提供模型配置/预算后执行，未提供则维持 BLOCKED。