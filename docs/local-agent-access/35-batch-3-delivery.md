# 第三轮交付汇总：F8（部分）+ F9 门禁 + 节点可见集修复 + 桌面补验

日期：2026-11-08。承接 [27 号汇总](27-f6-f7-batch-delivery.md)。用户在本轮提出两件事：
① 继续按计划逐包开发；② 验收阶段**不做真实音色克隆/音色设计产物**（会花钱）；
并在中途指出"图片创作/声音创作节点看起来缺失"——后者被证实是真实缺陷，见第 3 节。

## 一、数字

| 指标 | 上轮末 | 本轮末 |
| --- | --- | --- |
| 外部操作（CLI/MCP 同源） | 77 | **86** |
| external 映射业务动作 | 76 | **91** |
| 业务动作分母 | 171 IPC + 35 画布 | 171 IPC + **40** 画布 |
| 接入测试 | 116 | **157** |
| 真实桌面里程碑 | 28 | **45** |

本轮提交（7 个，均在本地未推送）：

| 提交 | 范围 |
| --- | --- |
| `acbb07c` | F8（三）多画布按项目锁并发（放宽单一 mutating 标志）+ flow 族登记位拆分 |
| `cf84a25` | 音频三族（speech/tts/voice-design）零成本门禁证据 |
| `0fee187` | F9（一）三入口目录一致性门禁 + 反向覆盖检查（查出 11 个孤儿操作） |
| `8b18425` | F8（二）Flow 命令账本协作外部接入 3 项 |
| `c3cb54a` | F8（一）Flow 观察/生命周期与固定资产外部接入 6 项 |
| `5cc940e` | 修复：CLI/MCP 创建的项目默认少 8 类节点入口（三入口可见集不一致） |
| `985efff` | F7 桌面补验：物化/实例化/历史恢复 + 音频族零成本段（里程碑 28→45） |

## 二、F8：Flow 与并发

**已开放 9 项**（三入口同一实现）：
- 观察/资产：`flowAgent.inspect|catalog|collaboration`、`flowAsset.submit|list|read`；
- 命令账本：`flow.command.lookup|availability|reconcile`。

**未开放 16 项且写明原因**——这是本轮的诚实重点：
- `flowAgent.run/pause/stop/publication`：内部 Agent 运行由 flow-agents.ipc 创建的桌面宿主实例
  独占（模型端口 + renderer 命令交付 + 在途运行表），外部另建实例 = 第二个权威；
- `flowAgent.cooperate`：协作事件没有外部主体身份维度，外部写 note/submit 会与人工输入不可区分；
- `flowAgent.review`：需同一宿主模型端口 + 工具调用预检，且付费路径无实测；
- `flowAgent.build`：真正落画布是 renderer 权威动作，需新增桌面动作；
- `flow.command.prepare/dispatch/check/abort`：需要外部专属主体 + 租约 + 受控 grant 通道；
- `flow.command.attach/detach/grant/cancel`：渲染器内部绑定 / main→renderer 单向推送，不是可调用动作。

**多画布并发**：写入锁从"全局单标志"改为按项目锁——同项目严格串行（语义不变）、不同项目可并行、
无 projectId 的全局写与 `project.open`（应用级活动画布）仍走全局锁、异常路径必释放。
4 项确定性测试用"悬住所主握手"的手法验证。**如实边界**：单窗口权威宿主下"两张画布同时执行节点"
仍不可能（需多宿主，F10 专项），本包只放开服务层互斥。

## 三、节点"缺失"：真实缺陷（`5cc940e`）

用户在 GUI 打开验收应用后看到图片创作/声音创作节点缺失。核实结论：**不是错觉，也不是发行版裁剪**，
而是同一个业务动作在两个入口的默认节点可见集不同：

| 入口 | 默认预设 | 可见节点 |
| --- | --- | --- |
| GUI「新建项目」 | `all` | 32 类 |
| 外部 `project.create` | `general` | 24 类 |

差的 8 类正是用户看到的：`image-crop`/`image-split`（图片创作）、`voice-design`（声音创作）、
`video-clip`/`video-depth`/`video-clay`/`director`/`ai-process`。调色板按 `visibleNodeTypeIds`
过滤，所以 CLI 建的项目在 GUI 里打开就"少了节点"。

修复：新增 `allWorkspaceProfile()`，`createProject` 未显式给可见集时与 GUI 对齐；
`defaultWorkspaceProfile()`（general）保留作损坏配置兜底；老项目已保存的可见集不改写。
回归用例断言外部建的项目包含全部 32 类且 8 个高级节点都在（台账 34）。

## 四、F9：三入口门禁

`scripts/audit-business-actions.cjs` 新增五类阻断检查：孤儿操作、例外清单腐化、外部动作缺 GUI 入口、
MCP 撞名、CLI 保留字遮蔽。**首次运行就查出 11 个孤儿操作**（登记了却没有任何业务动作引用），
逐个核实 GUI 入口后：5 个补成真实读取型分母（对话读取、技能绑定、运行观察、模型目录、项目摘要），
3 个进显式例外并写明原因（`capability.list`/`node.type.list` 协议自省；`node.library.update`
GUI 无重命名入口，待补或下线）。

新增 `test/local-agent-parity.test.ts`（7 项）验证运行时一致性：MCP 名唯一合法、CLI 不被保留子命令
遮蔽、`capability.list` 与 Registry 完全相同（含顺序）、`node.type.list` 覆盖 32 类、
`app.status` 身份一致，以及上面第 3 节的可见集回归。

## 五、音频族与桌面补验

- **音频零成本门禁**（9 项测试）：注入"付费方法一被调用就抛错"的 gateway 代理，证明 speech/tts/
  voice-design 在缺模型/凭据时**在任何计费请求之前**就 skipped/failed，文案与 GUI 一致，零副作用。
- **桌面 6.10**：三节点外部创建 → GUI 可见 → 执行门禁文案逐字一致 → 媒体 21→21 无产物 →
  `output.get` 无伪造媒体 → exec 非 success。
- **桌面 6.11–6.13**：资源库物化（媒体逐字节一致、重启存活）、节点库组合跨画布实例化
  （ID 全重映射、媒体不串用、幂等）、历史恢复（三段令牌、数据级比对、检查点回退、打开中 RESOURCE_BUSY）。

## 六、本轮真实门禁输出

- `npm run typecheck` → 0 错误（node/web/license-protocol/issuer）
- `node scripts/audit-business-actions.cjs` → 171 IPC + 40 画布动作；external ops 86
- `npm run verify:agent-access` → 86 operations；32 planned nodes
- 16 个接入测试文件 → **157 项通过**
- `npm run build` → 通过；`node scripts/test-agent-graph-milestone.cjs` → **45 项通过**
  （真实 Electron + 独立数据目录 + 授权协作激活；`qa/` 不入库，证据为本机产物）

## 七、仍未完成（不得算已验收）

1. **付费供应商执行**（voice.clone / voice.design / speech.synthesize / video / image-gen / image-edit）
   从未实测——需预算授权后按供应商分组做最小请求验收。
2. **F8 未开放的 16 项**（见第 2 节）需要外部主体/租约协议或共享宿主句柄，属后续包。
3. **两张画布同时执行节点**需要多宿主（F10）；本轮只放开服务层写入互斥。
4. **F9 剩余**：模型连接/受控凭据/环境探测/节点可见集设置/诊断导出等 44 项；持久化一致性
   与故障恢复两类机器门禁仍未自动化。
5. **F10**：干净克隆构建、真实安装包、真实 MCP 客户端逐动作一致性。
6. 打开中画布的历史恢复仍需 F9 `project.close`；GUI 节点库拖拽插入、含媒体条目的 GUI 插入清空媒体
   等既有口径未改。
