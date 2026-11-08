# F7 桌面补验：资源库物化 / 节点库实例化 / 历史恢复（附音频族零成本桌面段）

日期：2026-11-08。负责人：f7-desktop（共享任务板 `task-7`）。
范围：只在验收脚本追加**真实 Electron** 段落，**未修改产品源码**。本文是交付台账，不是"F7 全能力完成"声明；
未覆盖边界见第六节。脚本：`scripts/test-agent-graph-milestone.cjs` 的 6.10–6.13 段；
证据：`qa/local-agent-access/milestone-a-b-c/report.json`（`qa/` 不入库，为本机产物）。

## 一、结论

- 里程碑脚本 checks：**28 → 45**，真实 Electron + 隔离数据目录 + 授权协作激活，**45 项全绿**。
- 既有 28 项**全部保持通过**：没有删除或放宽任何既有 check / 断言，只追加段落。
  最终 45 项中，"graph structure and task ledger survive app restart"、"human reopened project in GUI,
  continued editing without conversion"、"diagnostics JSONL exists without prompt/body/user-content leakage"
  三条既有后段（原 26–28）仍在并通过。
- 补齐三处桌面缺口：资源库物化、节点库组合保存→插入另一画布、历史快照恢复/检查点回退；
  并按用户要求追加音频族三节点（speech / tts / voice-design）的**零成本**创建/读取/GUI 可见/门禁一致性段。

## 二、门禁真实输出（本轮最终运行）

| 门禁 | 命令 | 真实结果 |
| --- | --- | --- |
| 构建 | `npm run build` | exit 0（main/preload/renderer 全部 `✓ built`） |
| 桌面验收 | `node scripts/test-agent-graph-milestone.cjs` | `Agent graph milestone acceptance passed: …\qa\local-agent-access\milestone-a-b-c`；report `status=passed`、`checks=45` |
| 类型 | `npm run typecheck` | node / web / license-protocol / issuer 四段全部 exit 0 |
| 业务动作分母 | `node scripts/audit-business-actions.cjs` | `Business action audit passed: 171 IPC channels + 40 canvas actions; external ops 86; by phase {"external":91,"F8":11,"excluded":23,"F9":44,"F2":5,"F7":6,"F4":7,"F5":19,"F6":3,"F3":2}`，exit 0 |

说明：本批其它包并行改动工作区（F8 进行中），本轮未跑 `npm run verify`（全仓验证）——桌面证据与四道门禁均在本轮
实际构建产物上得到；未把其它包未收口的工作算作本次验收范围。

## 三、逐段验收点与真实证据

### 6.10 音频族零成本桌面验收（speech / tts / voice-design）

用户明确要求验收阶段**不做真实音色克隆 / 音色设计产物**（会产生付费请求）。本段只走外部
`graph.patch` / `node.execute` 与 GUI 可见性断言：**不点击任何"合成 / 试听 / 生成"按钮、不配置密钥**。

验收点：

1. 外部 `graph.patch` 在当前画布创建三个节点（各带接近真实的 JSON 配置；speech 为默认 minimax 后端，
   voice-design 正文写音色描述）；回执 `created` 映射齐全，`node.get` 读回 `type/title/text`，
   `config` 是 JSON 对象（不是 null/空壳）。
2. GUI 可见性：三个标题对应的 `.node-card-wrap` 在画布 DOM 中真实可见；**没有打开它们的编辑器**。
3. 门禁一致性（关键）：逐个 `node.execute` → `run.wait` 终态如实为 `failed`（外部任务对执行器
   `skipped` 的诚实投影），`error` 与执行器源码文案**逐字一致**：
   - tts 无参考音频：`缺少参考语音`
   - speech（minimax 无绑定模型）：`功能 speech.synthesize 尚未绑定已验证语音模型`
   - voice-design（有描述、功能未绑定）：`功能 voice.design 尚未绑定已验证音色设计模型`
4. 无付费副作用：执行前后 `media.list` 总数不变；`output.get` 不给出伪造媒体输出；节点 `exec` 不是
   `success`。

真实证据（report.json `audioFamily`）：

| 节点 | 终态 | reason | exec | output.get |
| --- | --- | --- | --- | --- |
| `f7-speech`（speech@4） | failed | 功能 speech.synthesize 尚未绑定已验证语音模型 | idle | empty |
| `f7-tts`（tts@4） | failed | 缺少参考语音 | idle | empty |
| `f7-voice-design`（voice-design@1） | failed | 功能 voice.design 尚未绑定已验证音色设计模型 | idle | `UNSUPPORTED_CONTRACT` |

media：`before=21`、`after=21`（零媒体新增）。`paidRequests` 记录为
"none: executors gate on missing reference audio / unbound verified voice models before any gateway call"。
Lead 提供的三条 reason 文案与实际桌面终态一致，未出现版本差异。

### 6.11 资源库物化（library.resource.create → library.resource.materialize）

前置：当前活动画布为 A。物化要求目标画布已打开（否则 `ACTIVE_PROJECT_REQUIRED`），链路与 GUI 同一份实现：
复制资源 blob 为项目受控媒体 → `graph-patch` 权威宿主应用 → 正式保存。

验收点：

1. `library.resource.create`（本机 PNG）→ 资源库组件 `hasBlob=true`，`sizeBytes=2007` 与源文件一致。
2. `library.resource.materialize`（带权威稳定版本）→ `assetCount=1`、创建 1 个 `image` 节点、
   `graph.get` 可见、`saved=true`、`graphVersion=88`。
3. `node.get` 的 `mediaId` 是**复制后的项目受控媒体**：`mediaPath=projects/<A>/media/<mediaId>.png`
   （不在 `library/` 下），磁盘文件可读、大小 2007 字节且与源文件**逐字节一致**；`media.list` 已登记；
   资源使用记录回填 `materializedNodeCount >= 1`。
4. 重启应用 → `project.open` 后节点与 `mediaId/mediaPath` 不变、媒体文件仍在。

真实证据（report.json `library`，最终运行）：

- `resourceId=1IyWAs-ddio-`、`revisionId=zoCBPcyYq0EN`、`componentId=ypPIzgqUpdi4`
- `blob={hasBlob:true,sizeBytes:2007}`
- `materialize={usageId:ldQRGLEQEO-8, graphVersion:74, nodeId:shape:Vf3t-YUdi1uRMh9LCBGfh, mediaId:Xf5RHubFjO, mediaPath:projects/4h7ESEGh3TtD/media/Xf5RHubFjO.png, bytes:2007}`
- `restart={nodeId:shape:Vf3t-YUdi1uRMh9LCBGfh, mediaId:Xf5RHubFjO}`（重启后一致）

### 6.12 节点库组合与跨画布实例化（node.library.compose → insert）

验收点：

1. 在当前画布 A 用 `graph.patch` 建 3 个节点（图片 + 两个裁剪，含一份 `media.import` 素材）和 2 条连线；
   `node.library.compose` 保存组合条目：`nodeCount=3`、`impact.edgeCount=2`、CC 含 image 节点的媒体引用
   （外部输入始终只有 `mediaId`）。
2. `project.open(B)` 后 `node.library.insert`：`applied.nodeCreated=3 / edgeCreated=2 / saved=true`，
   `skippedEdges=0`；B 的节点数 4→7、连线数 2→4；插入的 3 个节点 ID 与源节点**全部不同**，
   2 条连线端点均为新 ID。
3. 媒体在 B 项目下且与 A 不串用：回执 `entryMediaId` → 目标项目新 `mediaId`；
   目标节点 `mediaPath` 在 `projects/<B>/media/`；A 的源媒体仍在、A 不包含目标媒体。
4. 同幂等键重放：返回原回执（同一 `graphVersion`），B 节点数仍为 7、媒体仍为 2——不产生第二份。

真实证据（report.json `nodeLibrary`，最终运行）：

- 条目 `entryId=55J_plImuiHO`，`entry={nodeCount:3,edgeCount:2}`
- 源：`projectId=4h7ESEGh3TtD`，`mediaId=f-h0dFSeZ_`
- 插入：`projectId=tYzo4aZEF1fI`、`graphVersion=7`、`applied.nodeCreated=3`、`applied.edgeCreated=2`、
  `media=[{entryMediaId:f-h0dFSeZ_, mediaId:dGHwoPGN4q}]`、`skippedEdges=0`、
  `before={total:4,edges:2,media:1}`
- 重放：`graphVersion=7`、`total=7`、`media=2`

### 6.13 历史快照与恢复（history.snapshot.create → restore.precheck → restore → 检查点回退）

验收点：

1. `project.create` D → `project.open` → `graph.patch` 3 节点 + 2 连线 → **显式 `project.save` 到稳定版本** →
   `history.snapshot.create`：`restorable=true`、`nodeCount=3`。
2. `graph.patch` 新增 1 个节点并保存（4 节点）→ 切到另一项目（恢复只对**未在桌面打开**的项目执行）→
   无令牌 `history.restore` 被拒 `IMPACT_CONFIRM_REQUIRED` → `restore.precheck` 无 `ACTIVE_PROJECT`
   阻塞并签发令牌 → `history.restore`：`graphVersion=10`、`nodeCount=3`、`edgeCount=2`；
   数据级比对（节点 id/type/title、节点正文 + config JSON、连线数）与快照状态完全一致。
3. 回执 `checkpointSnapshotId` 存在且 `history.list` 中 `restorable=true`；再恢复该检查点 →
   回到"修改后的状态"（4 节点，含新增节点 id，正文/config 一致）。
4. 对**打开中**的项目：`restore.precheck` 的 `blockers=[ACTIVE_PROJECT]` 且**不签发令牌**；
   `history.restore` 返回 `RESOURCE_BUSY`（detail `desktop-ownership`）；项目 `graphVersion` 未变。

真实证据（report.json `history`，最终运行）：

- `snapshotId=SX8Vh8Kf87OB`、`checkpointSnapshotId=lN7rmdyFHc-2`
- `base={nodeCount:3,edgeCount:2,graphVersion:4}` → `modified={nodeCount:4,edgeCount:2,graphVersion:7,addedNodeId:shape:MTPWO7gK8Q9abHZZyvBDH}`
- `restore={graphVersion:10, previousGraphVersion:9, nodeCount:3, edgeCount:2}`
- `checkpointRestore={nodeCount:4, edgeCount:2}`
- `tokenRequired=IMPACT_CONFIRM_REQUIRED`
- `activeRestore={code:RESOURCE_BUSY, detail:desktop-ownership, blockers:[ACTIVE_PROJECT]}`

## 四、本轮失败过的点（脚本侧 / 环境侧，非产品缺陷）

1. **音频段第一版：tts / voice-design 的 config 为 null。** 这两个 NodeTypeSpec 没有 `initialConfig`，
   `node.create` 后 `node.get.config=null`，触发"config 必须是 JSON"断言失败。
   修正：脚本显式给出合法 JSON 配置（tts `{backend:'minimax',modelId:'speech-2.8-turbo'}`、
   voice-design `{previewText:'你好，很高兴认识你。'}`）；**断言未放宽**（仍要求 config 为 JSON 对象）。
   产品行为（无 `initialConfig` 的类型默认空配置）未改，仅记录事实。
2. **`history.restore` 首次调用多带 `expectedGraphVersion`。** 该操作登记输入是
   `project + snapshotId + impactToken?`（不是 `revision`），严格 Schema 直接 `INVALID_INPUT`
   （CLI 侧表现 `CLI_INVALID_RESULT:2:LOCAL_AGENT_COMMAND_FAILED`）。
   修正：按登记 Schema 去掉多余字段；令牌本身绑定 graphVersion，删除该字段**不降低断言强度**。
   定位方式：用 `out/main/local-agent.js contracts` 导出 `history.restore.inputSchema` 逐字段核对。
3. **一次基线运行在 6.6 段报 `Cannot read properties of undefined (reading 'meta')`。**
   事后诊断 JSONL 显示：`app.session_ended` 前主窗口被关闭，随后 CLI 拿到 `APP_NOT_RUNNING`
   （`project.get` 返回 data 缺失）→ 属测试环境的外部干扰/关闭，不是既有断言失败。同日诊断目录里还有
   同类短会话（23–43s）记录。为后续可诊断，脚本启动器新增**仅测试用**生命周期取证：
   写 `<dataDir>/lifecycle.log`（`window-created/close/closed`、`window-all-closed`、`before-quit`、
   `powerMonitor suspend/resume/lock-screen/unlock-screen`、`render-process-gone` 等），
   仅失败时随 failed-diagnostics 复制到证据目录。**未修改产品行为**；复跑两次均 45 项全绿。
4. **另一环境抖动（最终构建上的第一次收口运行，开场 14s 失败）：** 6.2 建图循环在为用户 B 打
   `graph.patch` 时返回 `ACTIVE_PROJECT_REQUIRED`（`project.open B` 已回执 completed，约 4.5s 后
   活动画布又变为非 B）。诊断证据：失败的 `graph.patch` 后紧接 `app.session_ended`；失败复制的
   `lifecycle.log` 显示窗口创建→业务窗→脚本收尾关闭的完整正常生命周期，**没有** render-process-gone /
   power 事件。判断为应用"切换项目时活动画布声明"的时序抖动（非本批断言、非新段引入；同日基线在
   14:18 也出现过一次外部关闭类抖动）。按约束未改产品源码，也未改既有 6.2 段逻辑；预检/断言强度不变，
   直接复跑同一最终构建产物即 45 项全绿。若该抖动复现频率升高，应作为**产品侧**项目切换竞态另行报告
   （需要活动画布版本化/等待渲染端就绪，而非在验收脚本里加重试掩盖）。

## 五、既有 28 项未放宽

- 没有删除、跳过或放宽任何既有 check 与断言；`report.json.checks` 中既有的 25 项前段（含 F4/F5/F6
  全部桌面断言）与 3 项后段（重启一致性、GUI 继续编辑、诊断脱敏）都在最终 45 项里并通过。
- 唯一的既有代码改动是启动器（bootstrap）追加生命周期取证与对应失败证据复制——测试夹具行为，
  不改变应用启动路径、权限激活流程或任何业务断言。

## 六、仍未覆盖的边界（不得当成已完成）

1. **付费供应商路径未实测**：音频族只证明"缺依赖时不发请求、不产生媒体"；真实语音合成/音色克隆/
   音色设计需要预算授权，本段刻意不触发。
2. **物化的呈现层差异**：外部物化不写 `meta.librarySource`、不建 tldraw 分组（23 号台账已登记）；
   本段验证的是节点业务字段 + 受控媒体 + 正式保存 + 重启，不宣称呈现层与 GUI 完全一致。
3. **GUI 节点库拖拽/点击入口**未逐动作验收：本段验证外部 `node.library.insert` 的桌面链路
   （权威宿主握手 + 落盘），GUI 面板插入仍是既有实现。
4. **GUI 侧插入含媒体条目的媒体策略**仍是"纯结构预设清空媒体"（25 号台账 §6.2），未对齐。
5. **打开中的画布不能外部恢复**：本段只断言 `RESOURCE_BUSY / desktop-ownership`；
   "关闭→恢复→重开"需 F9 的 `project.close` 落地后另立段落。
6. **恢复故障注入未做**：核对失败自动回退（`RESTORE_ROLLED_BACK`）与回退失败 `unknown` 分支
   未在真实桌面注入。
7. **多画布并发仍是串行口径**（单 mutating 标志 + 活动画布唯一宿主）；本段全部串行执行。
8. **MCP stdio 真实客户端与安装包**未纳入本轮桌面证据（CLI/MCP 由同一 Registry 生成，另有契约门禁）。
9. **音频节点 `exec` 状态**：缺依赖终态下实测为 `idle`（不是 `failed`）；本段按"不是 success"断言，
   GUI 卡片对该状态的具体呈现未单独验收。

## 七、复现

```powershell
npm run build
node scripts/test-agent-graph-milestone.cjs
npm run typecheck
node scripts/audit-business-actions.cjs
```

期望：`Agent graph milestone acceptance passed: …\qa\local-agent-access\milestone-a-b-c`；
`report.json` 的 `status=passed`、`checks=45`；`npm run typecheck` exit 0；
`audit-business-actions` 输出 `Business action audit passed: … external ops 86 …`。

## 八、report.json 字段索引（本轮新增）

| 字段 | 内容 |
| --- | --- |
| `audioFamily.nodes` | speech/tts/voice-design 的 nodeId、taskId、终态、执行器 reason、exec、output 形态 |
| `audioFamily.media` | 执行前后 `media.list` 总数（零副作用证据） |
| `library` | resourceId/revisionId/componentId、blob 大小、物化 usageId/graphVersion/节点/受控媒体路径与字节数、重启后 nodeId/mediaId |
| `nodeLibrary` | 条目 id/节点数/连线数、源节点与媒体、插入 applied/媒体映射/前后计数、幂等重放计数 |
| `history` | 快照/检查点 id、base/modified 图特征、恢复回执版本与计数、检查点回退计数、无令牌错误码、打开中 RESOURCE_BUSY 与 blockers |
