# 规范体系全面审查报告 · 2026-11-20

基线：commit 35c4343 · 方法：四域并行审查（节点契约 / 节点 UI / CLI-MCP 接入 / Agent Flow+日志），逐条"规范声明 vs 实现"比对，所有发现带 文件:行号 证据；关键矛盾经主审二次实锤复核。

> **2026-11-20 深夜修订补记（全部 P0 已实施后的勘误与增补）**：
> 1. **B-❌1（端口核心 8px/12px）判定为误报**：DOM 探针实测（Playwright 读 computed width）端口核心渲染就是 **12px、净距 18px**——`node-interaction-refinement.css:99`（与视觉 v2 同一晚提交）以同特异性+更晚加载修正了 `node-visual-system.css:283` 的旧 8px 块，浏览器门禁的 18px 断言实际通过。规范文本与实现一致；审查代理只看 CSS 未验 DOM，漏了终裁规则。真正残留债是 `edge-geometry.ts` 注释（8px/净距20）——已修正，并在 `node-ui-decisions.test.ts` 钉住终裁层 12px。
> 2. **Agent Flow 深审（第四代理最终完成）新增 2 个真问题并已修复**：① `runtime.ts:474-479` task-bind 工具白名单与 `desktop-host.bind` 不同口径（web.search 专家会被沉睡守卫误拒）——已同口径修复 + 回归测试；② `LOGGING_COVERAGE.md` AF-02～07/web.search/composite.run.waiting 断档——已补登记。
> 3. **A-⚠6 门禁化的额外收获**：新增的 `test/output-source-parity.test.ts` 双表门禁在首跑即抓到审查未发现的 3 处漂移（json/storyboard GUI 侧漏声明 document、voice-design 缺 main 侧登记），均已修复——门禁价值当场验证。
> 4. **收敛 backlog（未在本轮实施，留待冻结阶段）**：Agent Flow 建议收敛为 SPEC-00～07 八份权威文档（产品/协同/运行时/阶段流水线/graph 模式/审核返工/技能系统/恢复语义）；graph 执行模式（2026-11-14 波次）方案文档仍在仓库外需移入；`af01-stage-parity` 验收脚本未入 npm scripts。详见 docs/canvas-agent-flow/README.md 文档分类索引。
> 本轮全部修复已随提交入库，commit 列表见文末。

---

## 一、总体结论

**四域规范均"不能原样冻结"，但都离冻结很近。** 真正的阻塞项不是规范缺失，而是三类债：**① 头部状态行与"当前权威"声明不随实现更新；② 同一事实多处记载必漂移；③ 计数口径漂移**。核心契约层（端口/类型/连线/Schema/投影/幂等信封/鉴权边界）与实现高度一致且大多有机器门禁，这部分已具备冻结条件。

| 规范域 | 权威文档 | 与实现一致性 | 冻结就绪度 | 冻结前必办 |
|---|---|---|---|---|
| 节点输入输出契约 + 连线 | NODE_CONTRACT_SPEC.md | **高**（12 项关键点全对上，4 层机器门禁） | ★★★★☆ | 修 3 处硬矛盾 + 2 块规范空白 + 文档卫生 |
| 节点 UI / 画布呈现 | NODE_UI_STANDARD.md（v2.2）+ NODE_COLOR_SPEC.md | **中高**（颜色/材质/循环体全对上，有活门禁） | ★★★☆☆ | 收敛五代几何口径 + 修 1 处文档-实现数值相反 |
| Agent 对接 CLI/MCP | AGENT_ACCESS_SPEC.md + AGENT_PARITY_SPEC.md | **骨架高、清单脱节**（规范 25 项 vs 实际 190 项） | ★★☆☆☆ | 补记 165 项操作 + headless 键约定 + 计费门 |
| Agent Flow | docs/canvas-agent-flow/（52 份） | **核心契约一致**（调度目标/白名单/修订防护全对上） | ★★☆☆☆ | 从 52 份中收敛出 3-4 份权威规范，其余归档 |
| 日志 | LOGGING_SPEC.md + LOGGING_COVERAGE.md | **高**（事件登记、脱敏红线、门禁三关全绿） | ★★★★☆ | 无阻塞，可冻结 |
| 项目协作规范 | AGENTS.md | **中**（4 处过时引用） | ★★★☆☆ | 更新 4 处引用与计数 |

---

## 二、A 域：节点输入输出契约 + 连线规范

### ❌ 矛盾（规范说 A，代码做 B）——冻结前必须修

**A-❌1 Speech 后端枚举缺 indextts 第三通道**
- 规范：`NODE_CONTRACT_SPEC.md:346` 写死 `SpeechBackend = 'minimax' | 'volc'`，:349-350 只描述两套端口结构。
- 实现：`src/shared/speech.ts:13` = `'minimax' | 'volc' | 'indextts'`；specs/index.tsx:251-253 有 indextts 端口结构。
- 连带：契约快照测试（node-contract-snapshot.test.ts:329-376）只覆盖两态，indextts 无快照——修规范时同步补测试。

**A-❌2 输出端口"固定为 one" vs composite 公开输出可 many**
- 规范：`NODE_CONTRACT_SPEC.md:264、:316`（§4.3）输出端口基数固定 one。
- 实现：`src/shared/composite/manifest.ts:42-43` compositePortSchema 允许 many 且输出继承不收紧；validate.ts:186-187 只拦反方向。
- 处置二选一：规范补"composite 公开输出例外条款"，或收紧实现。**建议补例外条款**（复合流的"多产物输出"是已验收能力，本次节点流测试 P3/P4 都在用）。

**A-❌3 合规矩阵 C1 表"执行待接入、投影为空"已失真**
- 规范：`docs/NODE_COMPLIANCE_MATRIX.md:55、:59-61` 声称 agent/state-machine/ai-review 执行未接入。
- 实现：specs/agentFlow.tsx:1422-1428 已注册真实执行器；deterministic-projections.ts:96-99 已有投影；run-ops.ts:90-95 标 'run'。该列不在 compliance-matrix-doc.test.ts 机器比对范围内，所以漂移测试抓不到。

### ⚠️ 过时（文档滞后实现）

- **A-⚠1** NodeValuePacket 签名：规范 :431-442 写 `value: unknown`；实现 inputs.ts:11-17 为 `value: NodeValue` 且 source 增 `assetId?/versionId?`。
- **A-⚠2** 视频 in-reference-video"最多 3 段"（:568）→ 实现按供应商能力驱动（video-capabilities.ts:148-150 seedance2.5 =10）。应改写为"由能力描述驱动"。
- **A-⚠3** 代码入口清单（:24-26）缺整个 `src/shared/engine/` 层（inputs/values/projections/executors——契约真正的运行时核心），点名的 renderer 文件如今只是 re-export shim。
- **A-⚠4** 自身编号错乱：两个 "4.1"（:289/:389）、两个 "## 11."（:705/:732）。
- **A-⚠5** STRUCTURED_CREATIVE_DATA.md:44 循环"保持串行"→ 实现 iterate.ts:93-101 已有 runMode:'changed' + concurrency 1-4。
- **A-⚠6** **实现内部矛盾**：image/audio/video-asset 在 GUI specs 是 `outputSource:'document'`（specs/index.tsx:342/674/525），main 侧 run-ops.ts:67/84/88 却标 'run'；file 节点在两张表中都缺失（main 侧会 fail-closed UNSUPPORTED_CONTRACT）。需二选一对齐。
- **A-⚠7** NODE_REFERENCE_SPEC.md:83 "全部 28 节点"→ 现为 33 类（历史记录应标注历史属性）。

### 🕳️ 缺口（实现已成事实标准，规范未写）——冻结前必须补

- **A-🕳1** `outputSource: 'run' | 'document'` 整个语义未进规范（registry.tsx:135-143 有完整规则、executor.ts:2069-2074 统一消费）——这是"输出可见性"的核心契约。
- **A-🕳2** main 进程 `DETERMINISTIC_PROJECTIONS` 镜像投影表与规范 :191-193"唯一投影入口"条款冲突——需在规范中承认双源并规定同步门禁，或收敛单一共享源。
- **A-🕳3** composite 与 code 并享"同类型多端口"受控例外（registry.tsx:463-466），规范 §1.16/§8.0 只写了 code。
- **A-🕳4** human-task 停等/仅 completed 投影语义、processor 跨域共享契约（processor-contract.ts）未登记。

### ✅ 已确认一致（抽查全过，可安心冻结的部分）

10 种 PortType 枚举、in-/out- kebab-case 命名正则、one/many 基数与 `$$$` 合并语义、15 个版本化 JSON Schema 仓库、连线允许/拒绝矩阵（connection-matrix 129 项全绿）、33 个可创建节点清单零漂移、全部 32 个 contractVersion 逐一相符、投影单入口原则、W1 重试参数（0-5 次/500-30000ms 退避）、W2 循环并发钳制 1-4。**连线规范本身没有任何矛盾**——它由 connection-matrix.test.ts 129 项真值表把守，是全项目把守最严的规范。

### A 域冻结判定

修完 ❌1-3、补 🕳1-2、做完文档卫生后，**正文可作为冻结基线**。

---

## 三、B 域：节点 UI / 画布呈现规范

### ❌ 矛盾

- **B-❌1 端口核心直径：规范 12px，画布实际 8px**。`NODE_UI_STANDARD.md:761`（§22）宣称"2026-11-05 由 8px 调整为 12px"，但 `node-visual-system.css:283-289` 用更高特异性压回 8px；edge-geometry.ts:7-12 注释也是 8px；守护测试 node-ui-decisions.test.ts:116-118 断言的是被覆盖的层——**测试通过但画布真实值是 8px**。唯一一处"文档宣称已改而实现未改"。须二选一对齐（连带 edge-geometry 注释与测试断言目标）。
- **B-❌2 连线样式双权威打架**：`NODE_CANVAS_PRESENTATION_SPEC.md:168-172`（1.5/1.8/2.2px 旧表）未随 11-17 加粗（3/3.8/4.1/4.5px，ui-surfaces.css:2448-2558）同步；拖拽预览"品牌蓝虚线"描述也与实现（来源节点色+彩色水流）不符。本次连线加粗漏同步正是双权威的必然结果。
- **B-❌3 分镜板默认尺寸三方打架**：960×420（STANDARD §19）vs 340×260（STORYBOARD_TABLE_STANDARD + node-ui-tokens.ts:4 注释）vs 340×300（实现值 STORYBOARD_UI + §22 全员默认）。
- **B-❌4/5 UI_ICON_SYSTEM 颜色章节与 NODE_COLOR_SPEC 正面冲突**（8 色旧系 vs 六族 37 ID）；图标尺寸槽位 15px vs 实现 17px。
- **B-❌6 图标描边下限 1.5 被实现突破**（Icon.tsx 4 处 1.4）——需"特例登记"条款。
- **B-❌7 STANDARD 内部 §13/§18/§19 与 §22/§23 互相矛盾且都自称"当前权威"**（340×260 vs 340×300、28px vs 36px 头部）——"先读 §18"的入口指引本身就是 bug 源。
- **B-❌8 §15.1 头部细则（序号 19px/图标 20×20/状态灯 8×8）与 §22 v2.2 实现（20px 中轴/17px svg/6px 状态灯）不符，未标废止**。

### ⚠️ 过时（10 项，摘要）

node-ui-tokens.ts 4 处 260 时代注释、NodeCardShape.tsx:130 悬浮头部注释、色条/45° 切角已删但 COLOR_SPEC §4.1 与 STANDARD §20.1 仍列为允许、PRESENTATION_SPEC §3.1 token 表大面积失效、EXEC_COLORS 记载错误（pending 实为灰色）、COLOR_SPEC 引用不存在的 test/icon-contract.test.ts（实为 icon-system.test.ts）、176KB 的 NODE_UI_SPEC.md 停更于 9-27、根目录"节点卡片统一规范优化方案-v1.5.md"已实施完毕却仍以现行规范姿态留在根目录。

### 🕳️ 缺口（7 项，摘要）

1/6 流动段比例**无任何规范记载**（只活在测试注释里）；连线 hover 3.8/selected 4.1/invalid 2.4 与失效边红色虚线语义无文档；glow 层实际已停用但文档记录了它的加粗；exec 八态全集（idle/pending/queued/running/success/failed/cancelled/cached）无完整规范（两份规范各写一半）；卡头与侧栏双轨状态色未写明；**2026-11-19 裁决"连线不得改变节点原有编辑能力"只存在于测试注释与 commit**。

### ✅ 已确认一致

尺寸双真值已根治（Shape/Registry/校验三链路单一真值 340×300）；**NODE_COLOR_SPEC 37 ID 与实现逐值一致且有"读规范文件比对代码"的活门禁**（node-color-spec.test.ts）——全项目最扎实的规范-代码同步机制；11-16/17 循环体呈现裁决全部落地且有测试守护；§23 卡片材质逐值吻合；GENERATION_LOADING 与 OVERVIEW_PANEL 全条目可验证。

### B 域收敛方案（冻结路线）

现行权威只有"两份半"：**NODE_UI_STANDARD（需几何收敛）+ NODE_COLOR_SPEC（微修后冻结）+ 半份 NODE_CANVAS_PRESENTATION_SPEC（交互/手势章节保留，token/线宽/高度章节删除改指针）**。归档：NODE_UI_SPEC.md（176KB 决定日志）移入 docs/archive/；根目录 v1.5 方案标注"已实施并吸收"。UI_ICON_SYSTEM 保留语义字典、颜色段改为指向 COLOR_SPEC。

---

## 四、C 域：Agent 对接 CLI/MCP 规范

### ❌ 矛盾

- **C-❌1 headless composite 六操作在两份核心规范中零登记**：`AGENT_ACCESS_SPEC.md` 与 `AGENT_PARITY_SPEC.md` 全文 0 次提及 composite；Registry 已注册 composite.execute / execute.wait / run.retry / run.submitHuman / run.resume / run.resubmit（ops/composite.ts:132-210），且有 7 项验收全绿。`02-capability-matrix.md:246` 的"执行路径复用 graph.patch+node.execute"声明对 headless 已不成立。
- **C-❌2 headless 输出键约定三处不一致（Agent 集成必踩的协议暗礁）**：同一运行里 `outputPorts` 用 `out-<id>`（runtime.ts:252）、`outputs` 用裸 id（runtime.ts:231，**主审已实锤**）、`run.resubmit` 收裸 id——Agent 按 `out-<id>` 取 outputs 必然拿不到数据。Schema 与 description 均未写键规则。
- **C-❌3 MCP 注解对所有操作虚报 `idempotentHint: true`**（local-agent/index.ts:66-71）——media.delete 等重复调用不幂等，违反 AGENT_ACCESS_SPEC:117"幂等边界如实声明"。
- **C-❌4 计数漂移**：同一事实三个数——规范 25 项 / metadata.ts 注释 133 项 / **实际 190 项**（contracts.json）；节点数 31/32/33 三个口径。`14-current-capabilities.md` 整篇停留在 25 项时代且无过期标记。

### ⚠️ 过时（8 项，摘要）

14 号文档整篇失效；16 号逐节点表全标"待接入"（实际已交付）；CLI 示例参数 `--json/--task-id/--stdio` 不存在（实际 `--transport stdio|sse`）；MCP 协议版本声明与 SDK 1.32.1 现实脱节且承诺的兼容表从未产出；33 号 parity 例外清单只列 3 项（实际 7+8 项）；HANDOFF.md:27"正式执行尚未接入"；**幽灵契约**：OPERATION_REQUIREMENTS 引用 chat.start 等 3 个未注册操作（capability.list 会自相矛盾）；PACKAGE_IMPORT_BLOCKLIST 因目标从未注册而永不命中。

### 🕳️ 缺口（11 项，摘要）

§6 操作族按名未落地（run.list/reconcile/resume、review.* 无对应注册，语义由 flowAgent.* 承接但无映射登记）；信封状态集是规范建议的子集（无 accepted/waiting/blocked 信封级）；CLI 传输层错误无结构化信封、无 stdin；**composite.execute 无费用/网络确认门**（provider/flow 族都有 confirm 门，headless 却会真实执行已发布流内的模型调用，违反 PARITY_SPEC §4 计费声明要求）；operationVersion 形同虚设（全为字面量 1）；SSE 传输未在规范登记；`allowIncomplete` 导出路径未实现；审计分母 action-coverage.json 不含六个 headless 操作。

### ✅ 已确认一致（骨架可信）

三入口同源派生（CLI=operationId 点分段、MCP=点换下划线）+ parity 测试 + 契约快照 190 项全等；幂等信封核心语义逐条吻合（先落库/冲突/unknown/TTL 30 天/HMAC）；impactToken 逐字段一致；鉴权边界（命名管道+32 字节 token+timingSafeEqual+maxConnections 16）；graph.patch 有限 union + 原子提交；parity 铁律三道门存在且当前全绿（实测 190 ops）。

### C 域冻结判定与策略

**当前不能冻结为"稳定 API 面"，可先冻结为"v1 草案面"。** 推荐策略：**以 `docs/local-agent-access/generated/contracts.json` + `capability.list` 为唯一机器权威**（而非 markdown），read 族 + project.* + graph.* + run.get/wait/cancel + composite W1/W3 族标 stable；composite.execute 六操作标 beta（写死键约定 + 补计费门后转正）；规范 markdown 降级为"导读 + 边界声明"，操作清单不再手工维护在 md 里——这是根治"文档落后实现 165 项"的唯一办法。

---

## 五、D 域：Agent Flow + 日志 + 项目规范

### 现状清单（52 份 canvas-agent-flow 文档分三类）

- **活规范（描述当前行为，保留并冻结）**：00-approved-plan（总纲）、01-product、02-architecture、05-node-coordination-standard、06-implementation-plan、07-ai-review-node、10-c1-control-declarations、08-development-ledger（活台账）
- **历史交付记录（有价值但非规范，归档/标注）**：09、11-47 的 DELIVERY/HANDOFF/适配器记录（30+ 份）、51 份 testing/ 下记录
- **过时（头部状态失真）**：05 号头部仍写"**状态：设计规范，尚未实现**"（实现已落地，30+ 测试文件 + L3 验收）；AGENT_FLOW_EXECUTION_SPEC_2026_11_12.md 是**批次执行计划**而非规范（其附录 C 基线"provider 夹具 2 项失败"今天实测已不复现——全量回归仅 1 项 UI 失败且已修复）

### 核心契约核对结果（本人逐条实锤）

- ✅ 12 类 flowTargetContract（processor/text/ai-process/human-task/video/image-gen/image-edit/speech/tts/image-crop/image-split/code）与 video-adapter.ts:32-69 逐一相符；timeline 不在其中 → FLOW_TYPE_UNSUPPORTED（command-ledger.ts:281）与文档"轨道线不接自动调度"声明一致
- ✅ tools 白名单 node.execute@1 / web.search@1（runtime.ts:189-191、:312-319）
- ✅ interactionMode autonomous/collaborative + HUMAN_WAIT_DENIED（runtime.ts:197-198）
- ✅ skills 绑定 FixedSkill + 128KiB 上下文上限 + 资源白名单（runtime.ts:201-229）
- ✅ revision/semanticRevision 防护 + canonicalFlowJson 回执校验（runtime.ts:113-118、:290-297）
- ✅ 控制关系单一来源（allowedNodeIds→controls / gatedNodeIds→review-gate / responsibleNodeId→rework）与 declarations.ts 校验器架构，10 号文档与实现一致

### ⚠️ AGENTS.md（项目规范）过时 4 处

1. `:55`"当前已有 25 项外部操作"→ 实际 190 项
2. `:25-26` 引用"节点 UI 统一规范 v1.3 §19 现行裁决"→ STANDARD 已 v2.2，§19 已被 §22/§23 接管
3. `:97-98` Agent Flow 段仍写"这是待实施设计"→ 已实现并验收
4. `:34`"五大分类主色"→ NODE_COLOR_SPEC v2 已是六族色相带（2026-11-02，本人实锤）

### 日志规范：可冻结

`canvas.flow_config.started/applied`（events.ts:193/268）、`agent.access.*`（dispatch 全程）、`composite.run.*`（LOGGING_COVERAGE.md:996-1004，含明确脱敏红线）抽查全部对上；LOGGING_COVERAGE.md 1009 行持续登记；`verify:logging` 门禁三关绿。**LOGGING_SPEC 是四域中唯一无阻塞、可直接冻结的规范。**

---

## 六、跨领域系统性问题（五个模式——修规范前先立"防复发规则"）

1. **头部状态行腐化**：05 号"尚未实现"、矩阵 C1"执行待接入"、HANDOFF"正式执行尚未接入"、AGENT_ACCESS"25 项"——所有"当前状态"声明都滞后于实现。**规则建议：每份规范头部必须有 `status:` 与 `last-verified:` 字段，且 verify 门禁抽查该字段与机器真值（contracts.json/registry）的偏差超过阈值即红。**
2. **同事实多处记载必漂移**：连线线宽（两份规范两套数字，本次漏同步）、端口几何（8px/12px 双记载）、分镜板尺寸（三个值）。
3. **计数无单一真值**：25/133/190、31/32/33——**规则建议：规范中禁止出现"当前共 N 项"式计数，一律写"以 contracts.json / ActiveNodeTypeId 为准"**。
4. **实现有守卫、规范无条目**：1/6 流动段、exec 八态、headless 键约定、11-19 连线裁决——"只有测试知道规范"。**规则建议：每次给 node-ui-decisions 类测试加新断言时，同包在对应规范追加条目（与 parity 铁律同构）。**
5. **规范权威叠层**：UI STANDARD 五代口径共存且都自称权威。**规则建议：新版本接管时必须删除旧数值（不是追加新数值）。**

---

## 七、修订优先级清单

### P0（冻结前必须——共 10 件）

| # | 事项 | 位置 | 工作量 |
|---|---|---|---|
| 1 | Speech 补 indextts + 契约快照测试 | NODE_CONTRACT_SPEC:346 + snapshot test | 小 |
| 2 | §4.3 补 composite 输出 many 例外条款 | NODE_CONTRACT_SPEC:316 | 小 |
| 3 | 合规矩阵 C1 表改"已接入" | NODE_COMPLIANCE_MATRIX:55-61 | 小 |
| 4 | `outputSource` 语义 + 镜像投影表进规范（含 run-ops vs specs 的 document/run 矛盾对齐） | NODE_CONTRACT_SPEC 新章 | 中 |
| 5 | 端口核心 8px vs 12px 二选一对齐（代码或文档+测试） | node-visual-system.css:283 / STANDARD §22 | 小 |
| 6 | STANDARD 几何收敛：§13-§19 加"已被 §22/§23 替代"标注，撤"当前权威"字样 | NODE_UI_STANDARD | 中 |
| 7 | PRESENTATION_SPEC 删 §3.1/§4.1/§6.2 改指针 | NODE_CANVAS_PRESENTATION_SPEC | 小 |
| 8 | AGENT_ACCESS_SPEC 补记 headless 六操作 + 键约定写死（outputs=裸 id，outputPorts=out-id，schema description 同步）+ 计费门补齐 + MCP idempotentHint 如实化 | 两份规范 + ops/composite.ts + local-agent/index.ts | 中 |
| 9 | 幽灵契约清理（OPERATION_REQUIREMENTS 3 个未注册操作、KEY_PACKAGE_OPERATION_IDS、PACKAGE_IMPORT_BLOCKLIST） | metadata.ts / key-package-ops.ts / registry.ts | 小 |
| 10 | AGENTS.md 四处过时更新 | AGENTS.md:25/34/55/97 | 小 |

### P1（冻结前应做）

- NODE_CONTRACT_SPEC 文档卫生（编号重排、代码入口清单补 shared/engine、NodeValuePacket 签名、视频参考改能力驱动）
- composite many 输出在 registry 注册校验侧是否收紧的拍板（或维持现状+规范条款）
- 1/6 流动段、连线 hover/selected/invalid、exec 八态、2026-11-19 裁决补写进 NODE_UI_STANDARD
- UI_ICON_SYSTEM 颜色段改指针 + 尺寸槽位 + 描边特例条款；COLOR_SPEC 删色条/切角描述 + 修正测试文件名
- Agent Flow 收敛：00/01/02/05/06/07/10 标"活规范"+ 修 05 头部状态行；其余 40+ 份移入 docs/canvas-agent-flow/archive/（README 加索引）
- 14-current-capabilities.md 标过期或重写为指向 contracts.json

### P2（归档卫生，可延后）

- NODE_UI_SPEC.md（176KB）与根目录 v1.5 方案移入归档
- node-ui-tokens.ts 等 6 处旧尺寸注释清理
- LOGGING_AGENT_HANDOFF.md 标注"与 Agent 接入无关，历史文件"
- AGENT_FLOW_EXECUTION_SPEC 附录 C 基线刷新

---

## 八、冻结路线图（建议顺序）

1. **第一周（P0）**：10 件 P0 逐项修完，每项带对应测试/快照更新；跑 `npm run verify` + `guard:agent-parity` + `verify:logging` 三关。
2. **第二周（P1）**：UI 权威收敛 + Agent Flow 收敛 + 规范头部 status/last-verified 制度建立。
3. **冻结令**：每份权威规范头部追加"冻结基线：commit <hash>；变更须走规范修订流程（同包更新实现+测试+文档）"。**首个冻结集**：LOGGING_SPEC（即刻可冻）→ NODE_CONTRACT_SPEC + 连线（P0 修完）→ NODE_COLOR_SPEC + NODE_UI_STANDARD（收敛后）→ AGENT_ACCESS（机器权威模式落地后）→ Agent Flow 收敛集。
4. **长期机制**：推广 NODE_COLOR_SPEC 的"测试读规范文件比对"模式到连线几何/尺寸令牌；规范计数一律指向机器真值。

---

## 附：审查方法说明

- A/B/C 三域由三个并行审查代理完成逐条比对（合计约 240 次工具调用），主审对全部 ❌ 级发现做了二次实锤（本次报告中的行号均为二次核实后的工作区实际行号）。
- D 域（Agent Flow + 日志）由主审直接完成（并行代理连续受限），核心契约逐条实锤。
- 本轮**未修改任何规范文档**——按你的要求先交审查结论，规范修订待你拍板后执行。
- 上轮节点流测试报告见 `节点流全面测试报告-20261120.md`；本轮报告：`规范全面审查报告-20261120.md`。
