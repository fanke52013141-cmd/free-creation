# 全软件 GUI／CLI／MCP 一致性详细测试计划

日期：2026-11-09。基线提交：`6196625`（本地与 origin/main 一致）。
依据：[15 完整开发计划](15-gui-cli-mcp-parity-plan.md)（F0–F10、§7 验证方法）、
[16 节点动作覆盖](16-node-action-coverage.md)（N1–N8）、
[AGENT_PARITY_SPEC](../../AGENT_PARITY_SPEC.md)、[65 铁律](65-AGENT-PARITY-IRON-RULE.md)。
现状输入：[HANDOFF 第九轮](HANDOFF-2026-11-08.md)、[58 全量验收](58-mcp-acceptance-full-report.md)、
[59 ABC 优化](59-abc-optimizations-delivery.md)、[63 批 2/3](63-batch2-3-delivery.md)、[64 批 4](64-batch4-delivery.md)。

**本文是待执行的测试计划，不是完成声明。** 纯文档变更，不改变运行契约、存储、模型请求或日志路径，
日志影响"不涉及"。文中所有"当前数字"均为 2026-11-08 台账口径；**执行日以门禁和目录实际导出为准**，
禁止把历史数字写死进断言（"34 个工具"事故的教训）。

---

## 0. 测试目标与完成判据

### 0.1 总目标场景（15 §2.1，必须无人代点 GUI 完成）

1. 连接本机应用；未启动时按显式配置启动并等待就绪。
2. 创建"角色素材／视频剪辑／配音"三个独立项目画布，取得稳定 ID。
3. 查询节点类型、端口、参数、可用模型（不靠标题猜类型）。
4. 各画布批量建节点、写内容/参数/位置、按明确端口连线。
5. 导入文件、引用资源库素材、给对话节点绑定命名 Skill。
6. 运行单节点/子图/工作流，取 taskId，观察进度与状态。
7. 读取文本/JSON/图片/视频/音频正式结果，选版本，继续连接或保存资源。
8. 时间线编辑、截取、抽帧、声音调整、复杂工作区发布。
9. 节点/组合存节点库，按名插入另一画布，重映射节点/媒体/连线。
10. 全部保存、关闭重启；人在 GUI 打开后图、参数、素材、结果、可续编状态一致。
11. 重复请求/冲突/断线/任务失败时：不覆盖其他画布、不重复计费、不伪造成功。

### 0.2 一致性比较口径（SPEC §2）

比较单位是**业务动作**，至少比较：输入与默认值、参数单位、端口派生、引用顺序、业务校验、
任务语义、结果投影、保存重开、失败/取消/恢复、GUI 继续编辑。模型生成物不要求字节相同；
参数与结果协议用可重复测试验证，受理/进度/取消/落盘用真实供应商验证（L6）。

### 0.3 发布完成判据（SPEC §8）

- 32 类 Active 节点与全软件动作清单中，**适用项均有 GUI/CLI/MCP 证据**，历史缺口为零；
- 环境/授权限制项有**相同的拒绝或人工协作路径**；
- 仍为 planned、仅 mock 通过、仅文档登记的项**不计入完成**；
- 每轮报告必须展示 15 §7.3 的数字（见 §10）。

---

## 1. 测试分母与范围

| 分母 | 当前口径（2026-11-08） | 执行日取值方式 |
| --- | --- | --- |
| 软件业务动作 | 213 = 175 external + 30 excluded + 8 F9(license) | `node scripts/audit-business-actions.cjs` 与 action-coverage.json |
| 外部操作 | 143 项（CLI/MCP 同一 Registry 生成） | `npm run verify:agent-access` 输出 |
| 节点 | 32 类 Active × N1–N8 × 模式 × 入口 | `node.type.list` / node-contracts 快照 |
| 历史兼容 | script / video-audio / vocal-separate / group / compose 共 5 类 | 只读/迁移对照，不新建不伪造执行 |
| 发行版 | 可见集三入口一致（edition-node-parity 锁定） | `test/edition-node-parity.test.ts` |

**明确不在分母内**：`license.*` 8 项的功能本身（按用户决定永不开放，只测其**稳定拒绝**）；
无业务语义的呈现（动画/悬浮）；其他操作系统（本次仅 Windows）；项目内多页画布（未定义的产品功能）。
30 项 excluded 逐项有理由，测试其拒绝语义与理由一致性，不得为提覆盖率悄悄删项。

---

## 2. 测试分层与证据等级

15 §7.1 的四层证据展开为可执行的八层；每层对应 SPEC §4 的开发状态升级。

| 层 | 名称 | 主要设施 | 证据等级上限 |
| --- | --- | --- | --- |
| L0 | 静态门禁 | `guard:agent-parity`（契约快照+动作分母+日志）、`typecheck`、`lint`、audit | 准入 |
| L1 | 契约/单元 | 全仓 vitest（当前 3110 通过/7 跳过）、`test:contract`、node-compliance | contract-tested |
| L2 | 服务级接入 | 31 个 `test/local-agent-*.test.ts`（mock 宿主，验证可达性与前置拒绝） | contract-tested |
| L3 | 真实协议+桌面 | 8 个 `scripts/mcp-acceptance*.cjs`（官方 SDK Client + 真实 Electron）、`test-agent-graph-milestone.cjs` | desktop-tested |
| L4 | 三入口一致性对照 | 同一意图走 GUI/CLI/MCP，规范化比较（见 T-各包与 §6） | desktop-tested |
| L5 | 故障/恢复/并发 | 冲突、unknown、崩溃、断线、隔离专项（§7） | desktop-tested |
| L6 | 人工/付费/环境 | [62 runbook](62-manual-runbook.md) 三条路径 + CUDA + 付费分组 | desktop-tested（真实依赖） |
| L7 | 发布验收 | 干净克隆、安装包、打包态 CLI/MCP（T10） | release-verified |

规则：**下层通过不能替代上层**；L2 的 mock 宿主测不出真实 API 语义（tldraw `groupShapes()` 事故），
关键路径必须有 L3 兜底；L6 未做不得宣称真实依赖可用。

---

## 3. 环境准备与通用规则

1. 干净工作区：`git status` 无未提交修改；记录基线 commit。本轮同步后 lockfile 已变，先 `pnpm install`。
2. `npm run build`（CLI/MCP 验收走 `out/main/local-agent.js`，源码 dev 模式不算数）。
3. 授权：本机已激活；验收脚本自动探测授权目录并复制进**隔离数据目录**（设备绑定、同机有效，不伪造签名）。
4. ffmpeg 在 PATH（抽帧/截取/合成必需）；Python/CUDA 仅 L6 需要。
5. 隔离数据目录 + 有标识测试窗口，退出清理（AGENTS.md 强制）。
6. **每轮开测先重跑 L0/L1**——历史证据不等于当前工作区通过。
7. 所有数字从门禁/目录读真值；断言禁止写死操作数/节点数。
8. 默认零成本零联网：凡涉及付费/网络的操作，验收"未确认必须拒绝且零请求"；真实调用只走 L6 授权路径。
9. 打包态验收用 `CANVAS_LOCAL_AGENT_INSTALL_ROOT` 把脚本 cliPath/executablePath 指向安装目录。

---

## 4. 分阶段测试包（T0–T10，对应开发计划 F0–F10）

每包给出：目的 → 关键用例 → 通过判据 → 现有证据与缺口。执行时按 §9 轮次组织。

### T0 基线复现（F0）

- 干净克隆/干净工作区 `pnpm install && npm run build` 成功；L0 三关 + typecheck + 全仓测试全绿。
- 导出当日分母：业务动作数、external/excluded/F9 计数、操作数、32 类清单，写入本轮报告。
- 判据：主分支不依赖未入库模块；任何门禁红先定位归属，不批量刷 hash。
- 现状：设施齐备（audit/check/guard）；**每次接手必重跑**。

### T1 契约、准入与目录一致（F1）

- 三入口目录一致：CLI 命令集合 = MCP tools/list = Registry；无孤儿操作、无幽灵接口。
- Schema 严格校验：非法参数返回结构化 `INVALID_INPUT`（字段路径+原因，不含具体值）；
  `required` 不含带默认值字段；`capability.list` 带 `requires` 前置与 `errorCatalog`。
- 准入拒绝：错误实例、过期授权、过期/超前版本、重复幂等键、缺确认、占用 busy，各给稳定错误码。
- 版本冲突回执带结构化 `currentGraphVersion`，**用它直接重试成功**（不靠正则解析文本）。
- ABC 十一项优化回归：`mcp-acceptance-optimizations.cjs` 全过（group 可解组、AGENT_TASK_MISSING、
  id 别名、hasRecipe、precheck 无参、结构包外部直出等）。
- 旧客户端兼容：已发布操作的旧输入仍可用；Schema 变更有版本化与兼容结论。
- 判据/证据：protocol 族 91 项 + optimizations 9 项 + L1/L2 契约测试。**已覆盖，属每轮回归项**。

### T2 画布读写与多画布串行（F2）

- A/B/C 三项目串行打开，每图批量 ≥10 节点建改删连线；ref→正式 ID 映射正确；改 A 不动 B/C。
- 非法端口/非法引用混入批量 → 整批拒绝不留半图；两组非法类型（引用+兼容）都测。
- 用户未保存内容：flush 保留；过期版本拒绝后重读重试成功（数据级比对）。
- 画布五件套：复制粘贴、对齐、组合/解组（group.create 回传 groupId → group.delete → 读图为空）、
  撤销重做（版本建议值语义）、关闭项目。
- 每组编辑一个可撤销记录；GUI 实时可见并能续编；保存重启后图一致。
- 判据/证据：family1 25 项 + milestone 前段。**已覆盖；GUI 手工组合的解组走 graph.get groups[].groupId 路径**。

### T3 执行、任务与结果闭环（F3）

- 同一确定性图（text/json/structured/processor/storyboard）分别经 GUI、CLI、MCP 创建并执行：
  规范化参数、连线、端口值、结果投影、保存重开一致（L4 对照，见 §6 缺口）。
- `node.execute`：single 读持久化上游 / subgraph 上游闭包；付费上游重跑缺 `confirmPaidRerun`
  → `PAID_RERUN_CONFIRM_REQUIRED` 且零请求。
- 任务语义：accepted≠completed；终态只由 `run.get` 判定；`run.wait` 有界 ≤120s；
  取消请求与确认分离；终态任务取消是诚实 no-op；未知任务稳定拒绝。
- 失联/unknown：按确定 ID 查回原 run，幂等键重放原回执，**不重跑、不重计费**。
- 结果：`output.get` 覆盖全部确定性/文档族投影；`node.select-result` 版本切换（graph.patch op）
  切换后下游消费新版本；读取型素材节点不强制假跑模型。
- 判据/证据：milestone 文本流程段 + families-4-5-6-9 执行族 + 契约测试。

### T4 图片与素材（F4）

- `media.import`（字节不过线、受控 mediaId）→ 节点引用 → `media.list`（id 别名、hasRecipe）→
  `media.delete`（归属校验+引用计数回执）；跨项目 mediaId 引用 → `MEDIA_NOT_FOUND`。
- 裁剪：矩形/quad 透视、越界钳制（与 GUI 同一 normalization）、源变化；拆分：2×2 四资产有序、
  选中格投影、 corrupt 源失败回滚无孤儿。
- 横竖/透明图片、参考图上限、失效文件、取消、部分多产物失败、保存故障。
- 生图/P图：全参数/参考图顺序/遮罩进入 Schema；**真实生成属 L6 付费专项**，本轮只验接线与拒绝。
- 判据/证据：milestone F4 段（登记→引用→裁剪→落盘索引、quad、钳制、拆分、回滚、取消契约）。

### T5 视频、音频与时间线（F5）

- 抽帧：首/尾/指定时刻，毫秒单位、帧边界、旋转元数据；截取：双产物同区间、流保留、
  ffprobe **独立核验**时长/尺寸；声音调整：倍速产物时长实测。
- 时间线：轨道/片段/入出点/起始/层次/音量编辑经 graph.patch 多轮读回一致；合成独立成片
  （不写回节点 mediaId）；轨道吸附、同轨不重叠（e8f6290 回归）。
- 视频生成：模式/结构提示/多参考顺序进 Schema；**退出项目后后台续跑**：持久化 taskId、
  重进接回、不可恢复原因明确、不重复生成（9d3f49f + recover-video-runs 测试）。
- video-depth/clay：依赖不足稳定拒绝、安装闸门确认前零下载；**真实转换属铁律例外**（CUDA 就绪后）。
- 语音合成/克隆/音色设计：参数与音色/字幕投影契约；真实调用属 L6。
- 判据/证据：milestone F5 段 + 时间线/恢复专项测试；付费与 CUDA 边界单列。

### T6 对话、Skill 与复杂工作区（F6）

- chat：会话 CRUD/切换、消息追加/编辑/截断、`intent:image` 与附件注入（mediaId 归属预检）、
  删除唯一会话无幽灵再造；`chat.read` 不含正文、`chat.messages` 分页；流式/取消/压缩语义。
- Skill：安装/查询/绑定真实画布端到端；指令型 Skill 不假称有工具权限。
- code：多参数/动态端口/多输出、隔离、超时、中止；iterate：循环体/项身份/预算/取消项不算成功/恢复。
- website：只暴露 GUI 实际具备的动作，不假称网页抓取；director：场景/机位/镜头编辑、
  同步连线输入、发布授权等待/继续（49179a8 桌面段）、版本与真实产物；ai-process 模型/指令/预算。
- 判据/证据：chat-access 测试 + a7f5e60 桌面端到端 + 49179a8 发布授权段；
  会话与附件保存重开一致；代码隔离真实有效。

### T7 资源库、节点库、历史与传输（F7）

- 资源库：全类型资源/组成/修订/分类/文件夹/收藏集 CRUD、归档、批量删除/导出
  （**部分失败逐项回执**，重试不重复删/导成功项）、采集项目资产、物化到画布。
- 节点库：全类型单节点/组合保存、命名/更新/删除/搜索、跨画布实例化重映射（节点/边/媒体/声明引用）；
  纯结构预设与含资产资源包区分，附件不静默丢失。
- 历史：快照创建/查询/删除/恢复、恢复副本三入口协议、`history.recovery.precheck` 无参只读。
- 传输：项目包/结构包/资源包导出导入——暂存、媒体重映射、**密钥剥离**、失败清理不留假项目、
  越界拒绝；外部建图后直接 exportStructure 成功（C9）；导入包不含 API Key。
- 判据/证据：families-2-3-7-8（24 项）+ families-4-5-6-9 资源库段（21 项）+ 传输/历史测试。

### T8 内部 Agent Flow 与多画布并发（F8）

- flowAgent：建图预览/提交、角色/工具绑定、run/pause/stop、观察；协作缺任务 → `AGENT_TASK_MISSING`
  稳定码且零写入；`cooperate`/`publication` 不开放项稳定拒绝。
- 命令账本：check/dispatch/abort 外部接入；固定资产版本固定；审核：质量拒绝≠技术失败、
  返工有界预算、不能自改通过；状态机：非法事件/迁移拒绝，状态来自正式运行。
- **并发**：≥2 独立画布同时运行、第三张排队；按项目锁隔离（取消/诊断/媒体/版本/保存互不串）；
  停 A 不影响 B；重启后各图核对自己的任务/结果；前台手动编辑与外部写冲突可见不丢数据。
- 判据/证据：flow 各族接入测试 + families-4-5-6-9 Flow 段 + parallel-media/queue 脚本；
  **外部双画布同时运行的端到端段需按 §6 补齐确认**。

### T9 全软件余项与维护门禁（F9）

- 模型：连接/定义/绑定 CRUD、默认绑定；`model.discover` 必须 `confirmNetwork` 否则拒绝零请求；
  `model.validateAgentToolCalling` 必须 network+cost 双确认；端点绑定校验（密钥来源与 URL 一致）。
- 凭据：受控写入复用设备 vault，回执只给不可逆指纹；`hasApiKey` 三态真值
  （保存→true、留空更新→true、删除→false，GUI 与外部一致）；`provider.probe` 空结果给
  `probeSupported:false`+原因；明文不出现在回执/日志/目录/诊断/项目包。
- 环境：探测如实；`environment.videoEngine.install` 确认前零下载（mock 子进程）；安装诊断事件覆盖。
- 设置/诊断：节点可见集读写（隐藏入口≠发行版不提供）、调色板偏好、诊断查询/包导出、
  `diagnostics.exportNodeRun`（受控目录、sha256、脱敏白名单：无提示词/密钥/绝对路径）。
- 传输安全：SSE 仅 loopback、无令牌/错令牌 401、令牌只走 stdout 不落盘不进日志、真实 SSE 客户端调用成功。
- license 8 项：tools/list 不暴露、直调稳定拒绝。
- 判据/证据：f9-remaining 17 项 + sse 4 项 + keystore/license 测试族。

### T10 发布验收（F10，**未启动；需用户明确授权打包后执行**）

1. 打包态 MCP stdio：安装目录启 `local-agent mcp serve`，tools/list 数量与门禁一致 + 3 个只读操作。
2. 打包态 MCP SSE：loopback、无令牌 401、真实 SSE 客户端连上调只读。
3. 打包态 CLI：`project.create` / `graph.get` / `media.list` 与 GUI 同数据目录一致。
4. 安装包完整性：`out/main/local-agent.js` 在包内、无缺失 Node 依赖、干净机器可启动连桌面。
5. 干净克隆构建复现；真实目标 MCP 客户端逐动作一致性；付费分组验收（L6 授权后）；
   本地 GPU/代码/3D/音视频依赖分别验证。
6. 交付：命令/工具说明、示例图配方、版本兼容表、迁移/回滚说明、剩余限制清单、全动作覆盖报告。
- 判据：同一业务场景三入口保存的规范化数据与正式结果一致；人接手无额外转换；
  **仍有 planned 项不得发布"全软件已打通"**。

---

## 5. 32 类节点 × N1–N8 矩阵细则

N1（目录/契约）、N2（创建/布局/克隆/删除/组合）、N3（配置/正文/专有字段）、N4（连线/动态端口）
由 T1/T2 公共骨架统一覆盖；每类节点仍须按 16 §5 六条件逐行关闭。N5–N8 专有验收点：

| 族 | 节点 | N5–N7 专有断言 | N8 复用断言 |
| --- | --- | --- | --- |
| 文本确定性 | text@3 / json@1 / structured@1 / processor@1 / storyboard@1 | 正文与配置不混层；非法 JSON 报错；类型化输出不降级字符串；镜序稳定身份；失败非假空成功 | 组合保存/实例化后字段映射与引用完整 |
| 图片 | image@3 / file@2 | 导入替换、归属、预览导出；类型/大小限制 | 跨项目复制重映射 |
| 图片编辑 | image-crop@2 / image-split@3 | 坐标单位/越界/源变化/取消；多结果顺序/部分失败/回滚 | 结果版本与物化 |
| 图片生成 | image-gen@3 / image-edit@2 | 模型上限/参考顺序/遮罩完整/多结果/远端 unknown；**真实生成 L6** | 选版本后下游消费 |
| 视频 | video@7 / video-asset@2 | 模式与多参考顺序/受理恢复不重计费；探测时长/尺寸/音轨 | 后台续跑接回 |
| 视频本地 | video-frame@4 / video-clip@5 | ms/帧边界/旋转；双产物同区间/流保留/短片边界 | 产物正式索引 |
| 视频转换 | video-depth@1 / video-clay@1 | 依赖/显存/清理/重启事实；**真实转换属例外** | 环境就绪后补 |
| 时间线 | timeline@1 | 时间基准/边界/音画同步/编辑重开；不只开放渲染 | 成片作固定资产 |
| 音频 | audio@3 / sound-adjust@1 | MIME/时长/采样率；调整字段全量/源与结果分离 | 保存引用 |
| 语音 | speech@4 / tts@4 / voice-design@1 | 字幕与音频投影/音色档案同记录/任务身份；**真实调用 L6** | 音色可复用输出 |
| 对话 | chat@1 | 会话完整保存/最后回复投影/附件归属/Skill 绑定真实画布 | 预设旧语义不静默改 |
| 复杂 | website@1 / code@3 / iterate@2 / ai-process@1 | 不假称抓取；隔离超时多输出；项身份/预算/取消不算成功；Skill 工具可用性 | 跨图配置引用 |
| 3D | director@3 | 场景/机位/镜头编辑、合法发布授权、WebGL 依赖、真实产物 | 发布记录版本一致 |
| Flow | agent@1 / state-machine@1 / ai-review@1 | 外部主体不伪造内部身份；租约幂等恢复；非法迁移拒绝；质量拒绝≠技术失败、来源固定 | 固定资产版本 |

每行关闭记录：`nodeType + contractVersion + actionId + mode + operationVersion + GUI/CLI/MCP状态
+ 环境 + 证据 + 限制 + 负责人模块`。关闭六条件见 16 §5（校验/三入口等价/边界/正式产物/重映射脱敏/
安装包与真实依赖）。**未实测组合单列，不扩大为全部支持。**

---

## 6. 必测场景对照（15 §7.2 → 现有证据 → 缺口）

| 场景 | 现有证据 | 缺口与补法 |
| --- | --- | --- |
| 三画布批量建图 | milestone + family1 | 无（回归项） |
| 32 类逐动作 | 矩阵 + 各族脚本 | 付费族仅接线级 → L6；depth/clay → 例外 |
| 人与 Agent 交替 | R2 补齐：GUI 撤销/重做外部补丁、外部读 GUI 未保存正文（[68](68-r2-gap-report.md) §二A） | 无（已补真实桌面对照） |
| 多输入/动态端口 | 契约 + graph.patch 校验 | 变更影响预检的桌面断言复核 |
| 多模态复杂工作区 | T4–T6 各族 | 真实依赖部分 → L6 |
| 同名/重复请求 | 幂等 + family4 同名资源 | 无（回归项） |
| 崩溃与未知 | R2 补齐：执行中硬杀→重启结算 failed/HOST_RESTARTED、占用解除、零重放（[68](68-r2-gap-report.md) §二B） | 无（已补；取消语义另见观察 O1） |
| 多画布并行 | R2 实测：桌面为单活动画布，在途切换被 RESOURCE_BUSY 保护，**不存在跨画布并行**；已改为"切换保护/隔离/依次完成"（[68](68-r2-gap-report.md) §一、§二C） | 原假设作废，不再要求并行端到端段 |
| 模板/包迁移 | families-2/3/4 | 无（回归项） |
| 升级与发行版 | edition-node-parity + 兼容测试 | 旧参数/旧项目迁移专项复核；其他 OS 不标支持 |

L4 规范化对照方法：同一起始项目与同一操作意图分别走 GUI（真实桌面脚本驱动）、CLI、MCP；
比较规范化后的内容/布局/端口/引用顺序/结果投影/保存重开；ID、时间戳等允许差异必须有显式映射。
**当前对照多为"CLI 建图 → GUI 重开核对"，需补"GUI 先做 → 外部读取/续作"反向腿。**

---

## 7. 故障与安全专项清单（L5）

每项都要真实桌面或真实协议证据，mock 不算：

1. 幂等：同键重放原回执，副作用只发生一次（建项目/建节点/执行/删除各抽一例）。
2. unknown：准入后失败 → `OUTCOME_UNKNOWN`；按确定 ID + graph.get/run.get 核对；禁止盲目重放。
3. 版本：冲突回执结构化 currentGraphVersion 直接重试成功；超前版本拒绝；建议值语义（撤销/重做）。
4. 占用：busy 项目不被替换；锁按项目隔离；应用级资源写入串行。
5. 取消：请求≠确认；不支持远端取消明确声明；迟到产物清理；取消项不记成功。
6. 崩溃：执行中 kill → 重启账本/图一致；保存后回执丢失 → 核对不重做；视频远端任务接回不重复生成。
7. 断线：订阅断开按游标恢复；不因断线重发收费请求。
8. 存储失败：磁盘写失败/保存故障 → 失败如实、临时文件清理、无假项目。
9. 隔离：跨项目 mediaId/节点/run 引用拒绝；A 的取消/诊断/保存不影响 B。
10. 秘密三不出：密钥/提示词/回复/正文/绝对路径/签名 URL 不进日志、导出包、诊断包；
    `diagnostics.exportNodeRun` 脱敏白名单断言；凭据回执只有指纹。
11. 传输：SSE 仅 loopback；无/错令牌 401；令牌不落盘不进日志；stdio 分帧正确。
12. 闸门：缺确认的网络/付费/安装操作拒绝且**零请求零下载零计费**；人工确认不可由布尔冒充。
13. 边界：路径越界拒绝；导入黑名单/白名单按显式能力范围；退役类型新建拒绝。
14. 发行版：GUI 隐藏而 CLI 能建 = 缺陷（edition-node-parity 锁死）；依赖不足报 dependency-unavailable
    而不是"接口未开发"。

---

## 8. 人工与付费专项（L6，需用户参与，不允许自动化冒充）

按 [62 runbook](62-manual-runbook.md) 执行并填验收记录（谁确认/外部回执/结果/费用）：

1. **凭据包导入**：.cskeys 放受控目录 → 外部 `provider.package.import`（confirmImport）→
   人在界面点允许 → 回执 packageId/added/updated/humanConfirmed → `provider.list` 连接数 +N；
   拒绝路径 → `HUMAN_DENIED` 不重试。
2. **即梦设备流登录**：`dreamina.login.start`（confirmNetwork）→ pending 带 verificationUri/userCode →
   人浏览器授权 → `login.check` 轮询 pending→success；无 success 不得跑生成。
3. **付费生成最小路径**（建议先最便宜项，如 image-gen）：配置并验证模型（验证需本人确认）→
   建节点写配置 → `node.execute` → `run.get/wait` 终态 → `output.get` 产物 → `media.list` 可见 →
   失败有诊断事件 → **同幂等键重放费用只发生一次**。逐族分组：image-gen/image-edit/video/
   speech/tts/voice-design，各自记录模型组合与费用；未验组合明确标注。
4. **CUDA 真实安装**：`environment.videoEngine.install` 真人确认 → 数 GB 下载 → 探测成功 →
   video-depth/clay 真实转换各一例 → 产物有效、失败清理、重启事实。完成后关闭铁律例外第一项。

预算与排期由用户决定；未做前报告必须写"仅接线级验证，真实调用未测"。

---

## 9. 执行轮次与退出条件

| 轮次 | 内容 | 命令/设施 | 退出条件 |
| --- | --- | --- | --- |
| R1 基线重跑（约半天） | L0+L1+L3 全量，产出当日真相快照 | `guard:agent-parity` → `typecheck` → `test` → `build` → `verify:acceptance`（全量 8 批）→ milestone | 全绿；当日分母/操作数/检查数写入报告；任何红先修再进 R2 |
| R2 缺口补齐（1–2 天） | §6 三个缺口：GUI 反向腿对照、真实崩溃/回执丢失专项、画布切换与隔离（原"双画布并发"假设已作废见 §6） | 新增 `scripts/test-agent-parity-gaps.cjs`，纳入 `verify:acceptance` | **已完成 2026-11-09**：A 6/6、C 6/6、B 6/6；修复 2 个真实缺陷 + 1 个验证链回归；证据见 [68 报告](68-r2-gap-report.md) |
| R3 全量回归（约半天） | 完整验证链 | `npm run verify:checks` + `verify:acceptance` | **2026-11-09 已跑**：前段全绿、验收 9/9；视频 Agent Flow 11 个脚本为既有回归红点（HEAD 复现，非本轮引入），待单独定位后再判全链绿 |
| R4 人工/付费（用户排期） | §8 四条路径 | runbook + 一次性手测脚本 | 验收记录四列填完；例外清单相应关闭 |
| R5 发布验收（用户授权打包后） | T10 全部 | 打包 + `CANVAS_LOCAL_AGENT_INSTALL_ROOT` 指向安装目录重跑验收 | §0.3 发布判据满足；剩余限制清单发布 |

每轮结束：证据归档（§10）→ 台账追加 → `guard:agent-parity` 绿 → 才允许提交。
R1–R3 可循环；R4/R5 不阻塞源码态结论，但**阻塞任何"安装包可用/全软件已打通"声明**。

---

## 10. 证据归档与报告格式

- 验收报告先写 `qa/local-agent-access/*/report.json`（gitignore），结束必须经
  `scripts/archive-acceptance-evidence.cjs` 归档到 `docs/local-agent-access/evidence/`（入库）。
- 每轮报告必列（15 §7.3）：
  1. 业务动作总数与 GUI/CLI/MCP 分别实现、实测数；
  2. 32 类每类适用动作数/已实测数（不只报类型登记数）；
  3. 人工协作、环境限制、发行版限制、legacy 兼容项单列；
  4. planned、implemented 但仅 mock、真实客户端未测项分别列出；
  5. 本轮新发现缺陷、修复提交、回归证据。
- 状态语义沿用 SPEC §4：planned → implemented → contract-tested → desktop-tested → release-verified；
  运行可用性（available/requires-approval/dependency-unavailable/edition-unavailable/busy）分开报。
- 禁止：mock 计完成、文档登记计完成、删难项提比例、写死数字断言、局部验收宣称全链路完成。

---

## 11. 风险与明确边界

1. `license.*` 8 项永不开放（65 §7 硬红线）；本计划只测其拒绝语义。
2. 付费生成、CUDA 真实安装、人工确认落库、即梦完整链路未实测前，相关结论限"接线级"。
3. 保存降噪（P1-6）已回退：本轮**不测**"保存不推进版本"；测缓解措施（建议值+结构化 current）。
   根因迁移是独立专项（63 §一），不在本计划内冒充完成。
4. F10 未启动：一切实测结论仅适用源码构建；打包态四项验收前不得宣称安装包可用。
5. 仅 Windows 实测；其他 OS 在真实验收前不标支持。
6. 视频后台恢复、按项目锁并发等新路径若回归失败，优先怀疑真实时序而非放宽断言。

---

## 12. 本文档交付边界

本次只新增测试计划文档；不修改业务/执行/日志路径，不新增运行能力，不宣称任何新验收已通过。
计划完成检查：与 15/16/SPEC 的阶段与判据一致、分母口径一致、命令与脚本真实存在、
缺口与例外如实列出。执行证据产生后按 §10 归档并更新台账。