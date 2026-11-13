# Handoff：Agent Flow 特定任务优化 — AF-00 基线已交付

日期：2026-11-13（Asia/Shanghai）。基线提交：见本文件所在 commit（父提交 `10d932a5`）。
方案入口：[canvas-agent-flow/README](canvas-agent-flow/README.md) → [48-优化方案](canvas-agent-flow/48-task-specific-flow-optimization-plan-2026-11-13.md) → [49-AF-00 基线与样例](canvas-agent-flow/49-af00-baseline-and-sample-2026-11-13.md)。

## 0. 大白话现状（给非技术读者）

这个软件叫 Canvas Studio，是一块"画布"：你在上面摆节点、连线，让 AI 和人一起把一件事做完。

- **现在能用的**：让一个"总调度 AI"把活分给几个"专业 AI"，每个专业 AI 干完交出固定成果；中途可以插一个"必须人来填"的环节，人填完提交，流程继续；AI 还能受控联网搜资料；整条小流程可以打包重复用，失败了能定位到具体哪一步、能受控重试或人工补交。这些都有真实跑通的证据。
- **还没做到的（接下来要做的）**：现在的流程还偏"自由发挥"——总调度 AI 每次自己决定下一步派谁。我们要把它改成"固定轨道"：每一步的输入/输出/谁来做/什么时候算完成，都在一开始由"上帝 Agent"设计好并冻结；每一步只拿它必需的那点材料（不是把全部历史灌进去）；人提的意见和写作方法必须真正传到"实际写稿的 AI"那里；人能围着真实稿件反复讨论、改稿、选版本，而不是只点"确认"。
- **一句话目标**：把"人手工在多个 AI 网页之间复制结论"的做法，升级成"一条可反复使用、可持续打磨、每步上下文干净、人意见真正生效"的固定人机共创流水线。

## 1. 已实现且已验证（有真实证据）

证据等级：真实模型（付费小额）／真实搜索（豆包免费额度）／确定性夹具（无计费）／Playwright 合成事件（**非人工鼠标**）。本机回执在 gitignore 的 `qa/agent-flow-*/receipt.json`，其他 checkout 不保证存在。

| 能力 | 证据 |
| --- | --- |
| 外部上帝 Agent 建图（graph.patch/智能布局/契约发现） | layout 8 项（CLI 驱动桌面） |
| 主 Agent 协调分派 + 固定资产版本/输入快照/来源校验 | closed-loop 6、reliability 6（真实模型） |
| 状态机声明校验 + 外部事件推进 | state-machine 7（确定性） |
| 审核/有界返工/unknown 核对/重启恢复（不重跑已付费任务） | reliability 6（重启资产 5→5） |
| 纯人工任务节点（停等/提交/查询/固定产物/修订防过期） | human-task 10、human-task-dispatch 8 |
| 人机协同专家（AI 执行→停等→人工提交→消费→交付） | human-task-dispatch 8（真实模型） |
| 受控联网搜索（内部工具 + 外部 webSearch.run，双确认） | web-search 10（真实豆包）+ 外部 op 单测 8 |
| 组合发布/headless 运行/受控重试（上限 3）/人工补交/失败定位 | composite-model 4、composite-failure 9、composite-retry 14 |
| 画布智能布局/连线治理/角色徽标 | layout 8、edges 8（合成事件） |

## 2. 已实现但未充分验收（不能当作产品已达标）

- 节点内讨论 note/discuss/submit/revise：collaboration host 存在，但 **discuss 不自动携带当前稿件**（模型可能看不到稿子），缺多轮稿件版本比较与"草稿/采用/交付"分离 UI。
- 所有 GUI 证据均为 Playwright 合成事件，**没有真实人工鼠标/键盘共创验收**。
- 局部返工（审核返工已有，普通阶段修订无统一产品语义）、定义/方法版本的任务效果评测（composite/skill 版本已有，缺固定样本质量基线）。

## 3. 尚未支持 = 后期开发目标（AF-01～AF-07）

| 包 | 目标 | 解决的核心痛点 |
| --- | --- | --- |
| **AF-01 阶段与输出契约** | 声明式阶段契约（目标/最小输入/产物/人工点/完成条件）+ coordinator 最小固定顺序模式 + 状态条件校验 + 稳定 JSON/Markdown 输出适配 + human-task JSON 适配 | 流程不再靠模型每次重新定义；下一步由规则推进 |
| **AF-02 输入编制** | ContextManifest：按阶段选字段/片段/版本，去重、预算、缺项补充、输入预览 | 上下文越来越大、注意力分散；必需内容不静默截断 |
| **AF-03 真实内容指令** | ExecutionEnvelope：阶段目标/固定方法/人工意见/返工反馈真正传到公共内容执行器 | "讨论了但成稿没改"；方法与反馈生效可验证 |
| **AF-04 连续共创** | 围绕工作稿多轮讨论/直接编辑/采用修改/版本比较；草稿/采用/交付分离 | 人只能确认、无法围绕真实成果取舍 |
| **AF-05 质量与返工** | 阶段交付验收记录 + 防偏移约束包 + 显式分支 + 下游过期 + 局部重跑 | "有输出≠业务合格"；改中间只影响相关分支 |
| **AF-06 复用与任务评测** | 定义/方法版本与每次运行分离 + 模板调用 + 差异预览 + 固定样本评测 | 证明某版本确实更好更稳定，而非仅能跑 |
| **AF-07 嵌套/后台人机 Flow** | 含人工等待的 composite 封装/父子运行/外部续接（当前 fail-closed） | 整条人机 Flow 当可嵌套节点（条件必做，单独评估） |

**首条贯穿验收路径**：材料整理 → 人机共创定稿 → 基于已采用成果生成交付稿。AF-01～04 交付后形成三阶段共创试点；AF-05/06 通过才可宣称某类任务达标。

**核心架构原则（用户已确认）**：判定可以交给 Agent（概率性），但**推进必须确定性**（完成→改状态→点亮下一环节→居中聚焦）；每步上下文隔离、最小 I/O、方法论可独立打磨；画布仍是唯一可编辑流程定义，不建第二套任务拓扑或外部专用执行器。

## 4. 当前真实基线（AF-00 本轮实测，已修正旧结论）

旧交接"lint 25 条/2 项历史失败"说法**错误**，已修正：

| 检查 | 实测 |
| --- | --- |
| `npm run lint` | **0 错误**（修复前 29） |
| `guard:agent-parity` / `verify:agent-access` / `verify:logging` | 全绿（169 操作 / 33 节点 / 190 IPC + 50 canvas / 240 动作） |
| web/node `tsc --noEmit` | 0 错误 |
| 全量 `scripts/run-vitest.cjs run` | **3404 过 / 0 失败 / 7 跳过** |

AF-00 修法（不放宽业务校验）：humanTask.tsx 纯类型修复；纯 JS 工具脚本（.cjs/.mjs）语言适配（关闭对其不适用的两条 TS 规则，沿用 test/** 先例）；provider 测试陈旧夹具修正为真实安全契约（外部仅传 id、密钥来自密钥库、回执去敏，安全断言加强）；contracts.json 零 diff。详见 49 号文档。

## 5. 下一步精确入口（AF-01）

落点（方案 §10.1）：
- 共享协议：`src/shared/agent-flow/node-contracts.ts`、`runtime-contracts.ts`、`commands.ts`、`coordination.ts`，按职责新增小型 stage 契约文件（main 不导入 React）。
- 固定协调：`coordinator-host.ts`、`coordination-store.ts`、`parallel-admission.ts`——新增显式任务型执行模式，旧 Flow 保持旧语义，不默认迁移存量。
- 输出适配：`video-adapter.ts`、`agent-outputs.ts`、`node-schemas.ts`——稳定 JSON/Markdown 端口由保存配置派生，投影/适配器/资产登记/外部读取同源。
- 三入口：`src/shared/agent-access/ops/*`、registry、main ops、desktop bridge、IPC/preload 同包一致。

AF-01 退出条件：两阶段按声明顺序交接；字段缺失/人工决定缺失时不能越过；不靠模型任意补写目标；旧模式保持；正式交付绑定具体产物。

## 6. 环境与交付纪律（接手必读）

- 仓库 `D:\software\free-creation`，origin `github.com/fanke52013141-cmd/free-creation`（main）。本机代理 127.0.0.1:7897 失效：git 按命令加 `-c http.proxy= -c https.proxy=` 绕过，**绝不替换 origin URL**。
- 构建 `$env:CANVAS_OWNER='1'; npx electron-vite build`；桌面验收启动带 `--local-agent-access` 并清除 `ELECTRON_RUN_AS_NODE`。
- 测试必须走 `scripts/run-vitest.cjs`（裸 vitest 撞 better-sqlite3 Electron ABI）；查留档 DB 用 `ELECTRON_RUN_AS_NODE=1 electron.exe` 跑仓库内助手；WAL 库副本须带 -wal/-shm。
- 模型/搜索密钥仅经环境变量或设备密钥库注入，不进仓库/日志/回复。真实计费调用先说明模型/次数/预算。
- 铁律：凡改"用户能做的业务动作"，同包完成 GUI/CLI/MCP 一致 + 日志 + 版本兼容 + 恢复验证；提交前必跑 `guard:agent-parity`。不得放宽校验/绕过人工门禁/盲目重试 unknown 来"跑通"。
- 受保护源码变化须刷新契约快照与 change-impact.json（先不带 --accept-contract-change 验纯加性并人工核对 diff）。
- 每包先定义并验收一条真实用户路径，不用节点数/接口数/测试数代替产品验收；区分已实现/已验证/未支持/已实现未充分验收。
- 不擅自 commit/push/部署，授权后执行。PowerShell `>` 重定向输出 UTF-16 会破坏 JSON/日志解析，用 Node execSync/fs 或按 utf16le 读。

## 7. 未覆盖边界（如实）

- 未跑完整 `npm run verify`（浏览器/桌面/生产构建全链路）；AF-00 跑 lint/三门禁/类型/全量单测。
- 无真实 GUI 鼠标共创验收；无新真实计费调用（真实模型结论引用既有本机回执）。
- AF-01～AF-07 业务语义均未实现；安装包与源码一致性未核查。
- 不能将局部通过宣称为整个 Agent Flow 已达目标。