# AF-00 基线复核与三阶段固定样例

日期：2026-11-13（Asia/Shanghai）。状态：**已实施并验证**（基线修复包）。
上游方案：[48-特定任务 Agent Flow 优化方案](48-task-specific-flow-optimization-plan-2026-11-13.md)。

本包是 AF-00（基线与样例），只做基线修复与现状固化，**不引入阶段契约/上下文编制/执行说明等新业务语义**（那些是 AF-01～AF-06）。

## 1. 修正后的真实基线（本轮实测，不沿用旧结论）

旧交接曾写"lint 25 条基线、本批零新增"，与实测不符。本轮重新建立基线：

| 门禁/检查 | 本轮实测 | 说明 |
| --- | --- | --- |
| `npm run lint` | **退出 0，0 错误** | 修复前为 29 错误 / 4 文件 |
| `npm run guard:agent-parity` | 退出 0 | 169 operations、190 IPC、50 canvas actions |
| `npm run verify:agent-access` | 退出 0 | 169 operations、33 planned nodes |
| `npm run verify:logging` | 退出 0 | 本批无日志旁路 |
| web/node `tsc --noEmit` | 0 错误 | 两侧均通过 |
| 全量 `scripts/run-vitest.cjs run` | **3404 过 / 0 失败 / 7 跳过**（300 文件，298 过 2 跳过） | 修复前为 3402 过 / 2 失败 |

### 1.1 lint 29 项的根因与修法（不放宽业务校验）

| 文件 | 错误 | 根因 | 修法 |
| --- | --- | --- | --- |
| `src/renderer/src/nodes/specs/humanTask.tsx` | 1 | `instanceOf` 缺显式返回类型 | 真实补 `HumanTaskInstance \| null` 并补类型导入（生产源码严格规则不变） |
| `docs/agent-flow-verification-20261112/repro_sdk.mjs` | 3 | 空 catch + 2 处 TS 返回类型规则 | 空 catch 补注释；返回类型规则见下 |
| `scripts/activate-dev-license.cjs` | 13 | 未用导入 + require + TS 返回类型规则 | 删除未用的 `readFileSync`/`mkdirSync`；其余见下 |
| `scripts/license-tool.cjs` | 13 | 未用导入 + require + TS 返回类型规则 | 删除未用的 `rmSync`；其余见下 |

关键判断：`.cjs`/`.mjs` 是**纯 JavaScript**，写 TS 返回类型注解会破坏 Node 执行，`require()` 是 CommonJS 合法导入。`@typescript-eslint/explicit-function-return-type` 与 `no-require-imports` 对其本就不适用。修法是在 `eslint.config.mjs` 对 `scripts/**/*.cjs` 与 `docs/**/*.mjs` 关闭这两条 TS 专属规则（沿用仓库已有 `test/**` 同类先例），**保留 no-unused-vars 等通用质量规则**。生产源码 `src/**` 与测试不受影响。这是语言适配，不是放宽业务校验。

### 1.2 全量 2 项历史失败的甄别与修正

`test/local-agent-provider-network-access.test.ts` 的 2 项 `provider.testConnection` 失败，经核实是**测试夹具陈旧，非产品回归**：

- 实现（`provider-network-ops.ts`）正确且安全：外部仅传 `providerId`，密钥/地址由 `getProvider(id)` 从设备密钥库读取后传给 `testProvider`，回执去敏。
- 旧测试未向新建 DB 播种 provider（`getProvider` 返回 null → 走 PROVIDER_NOT_FOUND 分支，`testProvider` 从未被调用），且断言过时的内部调用形状 `toEqual({id:'conn-1'})`。

修正：替身化 `getProvider` 模拟密钥库返回受控连接，断言改为验证真实安全契约——外部仅传 id、`testProvider` 收到的密钥/地址来自密钥库（`apiKey:'vault-secret-key'`）、reachable 如实反映、回执不含地址与密钥。修正后该文件 7/7 通过，全量归零失败。**未放宽任何断言意图，安全边界断言反而加强。**

## 2. 当前支持矩阵（四态区分）

四态：**已实现**（代码存在）／**已验证**（有验收证据）／**已实现但未充分验收**（仅部分或 CLI/合成事件证据）／**尚未支持**（无代码）。
验收证据等级：真实模型（付费小额）／真实搜索（豆包免费额度）／确定性夹具（无计费）／Playwright 合成事件（**非人工鼠标**）。本机回执位于 gitignore 的 `qa/agent-flow-*/receipt.json`，不保证其他 checkout 存在。

| 能力 | 状态 | 证据/落点 |
| --- | --- | --- |
| 外部上帝 Agent 建图（graph.patch/布局/契约发现） | 已实现 + 已验证（CLI 驱动桌面） | `agent-flow-layout` 8 项；非人工 GUI |
| 主 Agent 协调分派（specialist 子节点） | 已实现 + 已验证（真实模型） | `agent-flow-closed-loop` 6、`agent-flow-reliability` 6 |
| 固定资产版本/输入快照/来源校验/端口投影 | 已实现 + 已验证 | assets 单测 + closed-loop |
| 状态机声明校验 + 外部事件 | 已实现 + 已验证（确定性） | `agent-flow-state-machine` 7 |
| 审核/有界返工/unknown 核对/重启恢复 | 已实现 + 已验证（真实模型） | `agent-flow-reliability` 6（重启资产 5→5 不重跑） |
| 纯人工任务节点（停等/提交/查询/固定产物） | 已实现 + 已验证（确定性 + 真实模型调度） | `agent-flow-human-task` 10、`agent-flow-human-task-dispatch` 8 |
| 人机协同专家（collaborative + wait_for_human） | 已实现 + 已验证（真实模型） | human-task-dispatch（AI 执行→停等→人工提交→消费→交付） |
| 受控联网搜索（内部工具 + 外部 webSearch.run） | 已实现 + 已验证（真实豆包） | `agent-flow-web-search` 10；外部 op 单测 8 |
| 组合发布/headless 运行/受控重试/人工补交/失败定位 | 已实现 + 已验证（确定性 + 真实模型） | `composite-model` 4、`composite-failure` 9、`composite-retry` 14 |
| 画布智能布局/连线治理/角色徽标 | 已实现 + 已验证（合成事件） | `agent-flow-layout` 8、`agent-flow-edges` 8；非人工鼠标 |
| 节点内讨论 note/discuss/submit/revise | 已实现但**未充分验收** | collaboration host 存在；discuss 仅传 goal/history/message，**不自动带当前稿件**（G3） |
| 阶段契约（声明式最小 I/O + 完成条件） | **尚未支持** | AF-01；当前 I/O 由节点类型+连线推导 |
| 确定性阶段顺序闸门 | **尚未支持** | AF-01；当前主控模型自由选 available 节点 |
| ContextManifest（字段/片段选择/去重/预算） | **尚未支持** | AF-02；当前固定整份资产，262144 字节兜底 |
| ExecutionEnvelope（方法/反馈传到内容生成器） | **尚未支持** | AF-03；Agent goal 与 aiProcess 自身 config 两层分离（G2） |
| 围绕工作稿连续共创（多轮/采用/版本比较 UI） | 部分实现，**未充分验收** | AF-04；草稿/采用/交付未完全分离 |
| 阶段交付验收记录 + 防偏移约束包 | **尚未支持** | AF-05；committed≠业务 accepted |
| 局部返工影响预览/下游过期 | 部分（审核返工已有），**未充分验收** | AF-05；普通阶段修订无统一产品语义 |
| 定义/方法版本 + 固定样本任务评测 | 部分（composite/skill 版本已有），**未充分验收** | AF-06；缺任务效果基线 |
| 含人工等待的嵌套/后台 Flow | **尚未支持**（fail-closed） | AF-07；`run-composite.ts` 显式拒绝 human-task |
| 真实 GUI 鼠标/键盘共创验收 | **未充分验收** | 所有 GUI 证据为 Playwright 合成事件 |

> 不能把 33 个 Active 节点或 169 个外部操作解释为全部节点已可被专业 Agent 调度；普通 target adapter 有 12 类支持项且受版本/模式限制，Agent/审核另有专用协议。

## 3. 三阶段固定样例（首条贯穿路径）

路径：**材料整理 → 人机共创定稿 → 基于已采用成果生成交付稿**。

本样例用于 AF-00"看清当前能复现什么、不支持什么"，并作为 AF-01～AF-05 的贯穿验收载体。下表"今天可复现"指用现有机制（CLI 驱动桌面宿主）能跑通；"缺口"指方案目标尚未强制保证的部分。

| 阶段 | 今天可复现（现有机制） | 缺口（指向包） |
| --- | --- | --- |
| ① 材料整理 | text/ai-process 目标 + specialist 执行，固定素材资产引用→committed 整理成果（closed-loop text 目标已验证） | 无声明式阶段契约与最小输入选择（AF-01/02）；大材料仍整份注入 |
| ② 人机共创定稿 | human-task 停等 + collaborative 专家：AI 执行→skipped 停等→人工 humanTask.submit→continue 消费 pending→committed（human-task-dispatch 已验证） | discuss 不自动带当前稿件（AF-04/G3）；缺多轮稿件版本比较与"草稿/采用/交付"分离 UI |
| ③ 基于已采用成果生成交付稿 | ai-process 消费阶段②的 committed 固定引用→交付稿（固定引用消费已验证） | 方法/人工反馈不保证进入实际生成请求（AF-03/G2）；下游消费的是 committed 而非业务"已采用"验收（AF-05） |

**复现命令（确定性，无计费）**：
```powershell
node scripts/run-vitest.cjs run --maxWorkers=1 --minWorkers=1 test/human-task.test.ts test/agent-flow-target-matrix.test.ts test/flow-target-text.test.ts test/composite-run-repo.test.ts
npm run acceptance:agent-flow-human-task        # 停等/提交/修订冲突/fail-closed
npm run acceptance:agent-flow-composite-retry   # 失败定位/受控重试/人工补交
```

**真实模型贯穿（付费小额，需先说明预算）**：`npm run acceptance:agent-flow-human-task-dispatch`（智谱 glm-5.3-flash，约 4 次专家决策 + 1 次主控决策；本轮未重新调用，引用既有回执 ok=true）。AF-00 不发起新的真实计费调用。

## 4. 本包改动与日志/接入影响

改动文件：
- `src/renderer/src/nodes/specs/humanTask.tsx`（纯类型：返回类型 + 类型导入）
- `docs/agent-flow-verification-20261112/repro_sdk.mjs`（空 catch 补注释）
- `scripts/activate-dev-license.cjs`、`scripts/license-tool.cjs`（删未用导入）
- `eslint.config.mjs`（JS 工具脚本语言适配）
- `test/local-agent-provider-network-access.test.ts`（陈旧夹具修正为真实安全契约）
- `docs/local-agent-access/change-impact.json`（受保护源码 humanTask.tsx 影响声明刷新；contracts.json **零 diff**，确证无契约变化）

日志影响：**不涉及运行路径**。humanTask.tsx 为纯类型修复，无执行/模型/数据库/文件路径变化；eslint 配置与测试修正不涉业务诊断。不改事件覆盖状态。
Agent 接入影响：无接口行为变化；契约快照零 diff，仅刷新受保护源码影响声明。

## 5. 未覆盖边界（如实）

- 未运行完整 `npm run verify`（含浏览器/桌面/生产构建全链路）；本包跑 lint/三门禁/类型/全量单测。
- 未做真实 GUI 鼠标共创验收；既有 GUI 证据均为合成事件。
- 未发起新的真实模型/搜索计费调用；真实模型结论引用既有本机回执。
- 阶段契约/最小上下文/执行说明/连续共创/交付验收/任务评测均未实现（AF-01～AF-06），本包不声称其完成。
- 安装包与源码一致性未核查。

## 6. 下一步

AF-01（阶段与输出契约）：shared 阶段契约 + coordinator 最小固定顺序模式 + 状态条件校验 + 稳定 JSON/Markdown 输出适配 + human-task JSON 适配。退出条件：两阶段按声明顺序交接，字段/人工决定缺失时不能越过；旧模式保持；正式交付绑定具体产物。依赖本包样例。