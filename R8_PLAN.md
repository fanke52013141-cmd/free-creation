# R8 数据模型与运行内核收敛：开发计划与测试计划

> 制定日期：2026-08-27
> 前置状态：R0-R7 全部完成（R0 收尾的发布冒烟除外）。本计划是 ROADMAP 全部阶段完成后的第一轮内核还债，目标是在 v1.0 发布前把数据模型和运行协议收敛到位，避免发布后做 v2→v3 迁移。
> 依据：[ROADMAP.md](./ROADMAP.md) R1 遗留项与 §2 架构缺口、[HANDOFF.md](./HANDOFF.md) §10-11、当前工作区代码实况（R0 完成时点）。
> 原则：行为等价优先——本轮不改变任何节点的用户可见行为，只改数据存放位置与运行协议；全部门禁（typecheck/lint/test/build）与契约快照测试（75 用例）保持绿色。

## 1. R8 要解决什么

R0-R7 完成后，功能面已闭环，但内核有四类债务，全部有代码证据：

| 问题 | 代码证据 | 后果 |
| --- | --- | --- |
| `text` 单字段承载一切 | `NodeCardShape.tsx:12-22`：props 共 9 个字段，`text` 被文本节点存正文、被 11 个执行器 `JSON.stringify` 写入配置（chat 的 messages、image-gen 的 prompt/modelKey/seed、code 的 source/params 等） | 配置/内容/结果混存一个字符串；无法做字段级校验与 diff；每加一个节点复用加深一分；HANDOFF §10 第 3 条遗留 |
| 运行结果投影双轨 | 投影入口 `nodeValues.ts:68` 一半读 `props.text` 配置（chat :108 取 messages、script :120 取 shots），一半读 `meta.nodeResult`（json/code :137-147）；写侧 `executor.ts:96-107` 把结果写 meta | "输出从哪来"没有单一规则；meta 在部分导出/复制路径可能丢失，回退行为不统一 |
| 运行记录不持久 | `exec` 仅是 `'idle'/'success'/...` 字符串（`NodeCardShape.tsx:21`）；错误落盘了（R0），但成功运行无耗时、无输入摘要、无历史；`projects.repo.ts` 无 runs 表 | 用户无法回答"上次跑了什么、花了多久、哪次改坏了"；ROADMAP §2 架构缺口原文"运行结果没有完整持久化运行记录、耗时和输入摘要" |
| 长任务无统一超时 | 仅 `executors/shared.ts:155-183`（waitForChat）有计时器；生图/视频/音频任务无超时 | 网关悬挂时节点永远 running，只能手动取消；HANDOFF §11 第 3 条遗留 |

R8 完成标准：

1. 任一节点的配置、内容、上次运行结果在 props/meta 中各有专属字段，`text` 只存用户可见文本。
2. 输出投影有单一规则：已运行节点从登记结果投影，未运行节点从持久化状态投影，两侧测试锁定。
3. 每次全局运行产出持久化 RunRecord（耗时、各节点状态、输入摘要），重开项目可查。
4. 所有网关调用受统一超时约束，超时自动取消并记 phase='timeout' 错误。
5. 旧项目（含 R0 之前与 R0-R7 期间保存的）打开即自动迁移到新字段，迁移幂等且有测试。
6. 现有 420+ 测试全绿，节点契约快照零变化（证明行为等价）。

## 2. 总体安排

四个工作包，合计 4.5-6.5 人日：

```text
WP1 数据字段三分（config/text/result）──→ WP2 运行记录持久化 ──→ WP4 连线 E2E 测试
                └────────────────────────→ WP3 超时协议（独立，可并行）
```

- WP1 是地基，必须最先做；WP2 的 RunRecord 依赖 WP1 的 result 字段定稿。
- WP3 与 WP1 无字段依赖，只改运行器与执行器约定，可穿插并行。
- WP4（tldraw 连线端到端测试）成本高、收益是长期回归保护，放最后，可砍。

## 3. 工作包明细

### WP1 节点数据字段三分：config / text / result（对应 ROADMAP R1 遗留）

**现状**：`NodeCardProps`（NodeCardShape.tsx:12-22）9 字段中 `text` 被全部节点复用；写侧执行器经 `updateProps` 把配置 JSON 写进 text；读侧 13 个 Body 直接 `JSON.parse(shape.props.text)`；投影 `projectNodeOutputs` 再从 text 里拆配置取结果。

**目标数据模型**（`NodeCardProps` v2）：

```ts
interface NodeCardProps {
  w: number; h: number
  nodeType: string
  title: string
  /** 用户可见文本：文本节点正文、对话 messages、剧本源文 */
  text: string
  /** 节点固定配置 JSON：模型 key、系统提示词、参数、seed 等（按节点类型 Schema 化） */
  config: string
  /** 上次运行的登记结果（NodeValue JSON），投影的优先来源 */
  result: string
  mediaId: string; mediaPath: string; mediaMime: string
  exec: string
}
```

要点：`result` 从 `meta.nodeResult` 转正为 props 字段——tldraw 对 props 有正式迁移机制（`migrations()`），meta 没有同等保障且在部分复制/导出路径可能丢失。

**任务**：

1. `NodeCardShape.tsx`：新增 `config`、`result` 字段（`T.string`，默认 `''`），挂 tldraw shape props 迁移（v1→v2，首次加载自动补默认值）。
2. 新建 `nodes/config.ts` 访问器层：`readNodeConfig<T>(shape, fallback): T`（读 `props.config`，空则回退解析旧 `props.text`）、`nodeConfigPatch(config): Partial<NodeCardProps>`。13 个 Body 与 11 个执行器的读写全部换走访问器，禁止再直接 `JSON.parse(props.text)` 读配置。
3. 字段迁移纯函数 `splitLegacyTextField(nodeType, text): { config, text }`：按节点类型把旧 text 中的配置键拆到 config、内容键留在 text（chat 的 messages 留 text，system/modelKey 进 config；code 的 source/params 进 config；image-gen 全部进 config；文本节点原样留 text）。并入 R0 的 `planLegacyMigrations` 流水线，打开项目即迁移，幂等。
4. 投影统一：`projectNodeOutputs` 规则改为——`props.result` 非空优先投影 result；为空回退现行 props 派生逻辑（保住"未运行节点也能投影"的现状）。`updateResult` 改写 `props.result`，`meta.nodeResult` 仅作兼容读。
5. `graph.ts` deriveGraph 的 content 派生、右侧面板 valuePreview、demo bundle 生成脚本同步新字段。
6. 现有测试改造：所有直接构造 `props.text` 配置的用例换 `readNodeConfig`/新字段；新增迁移与双读真值表（见 §5 T1/T2/T3）。

**验收**：
- `rg "JSON.parse\(shape.props.text\)" src/` 零命中（访问器内部除外）。
- 契约快照测试（node-contract-snapshot 75 用例）零变化。
- R0 示例项目与任一旧项目打开后配置/内容/结果各归其位，保存重开不回退。

工作量：2-3 人日。

### WP2 运行记录持久化：RunRecord 与运行历史（对应 ROADMAP §2 架构缺口）

**现状**：运行结束只有内存 store 复位与 props.exec 状态灯；错误进日志（R0），成功路径无任何留痕；无法对比两次运行的耗时差异。

**设计**：

- 节点级 `runMeta`：props 增加轻量 `runMeta: string`（JSON：`{ at, durationMs, runId, error? }`），执行器包裹计时由运行器统一写入（执行器零改动）。
- 项目级 RunRecord：每次全局运行结束，主进程向项目目录追加 `<projectId>/runs.json`（数组，上限 50 条 FIFO 淘汰）。条目含 `runId、startedAt、durationMs、total、ok、failed、nodes: [{ id, label, type, status, durationMs, errorReason? }]`。
- 走既有 IPC 模式新增 `run.append` 通道（渲染进程 fire-and-forget，主进程原子写复用 projects.repo 的 .tmp+rename 模式），不进 project.json 避免主文件膨胀。
- UI（两处轻入口）：
  1. 节点卡片状态灯 hover 显示"上次运行：成功 · 2.3s · 14:32"。
  2. CanvasSidePanel 新增「运行历史」tab：运行列表（时间/总数/成败/总耗时）→ 展开看各节点耗时与失败原因，失败原因点击复用 R0 的错误定位（选中并居中节点）。

**任务**：

1. `shared/contracts` 增 `run.append` 通道与 `RunRecord` 类型；preload 暴露。
2. `main/ipc/run.ipc.ts`：追加写入 runs.json（读-截断-原子写，损坏时重建为单条）。
3. 运行器 `runWorkflow` 收尾：汇总各节点 runMeta + store 错误 → 上报；`runNodeManually` 单节点运行同样记录（runId 区分 manual/global）。
4. UI 两处入口 + `test/runs-repo.test.ts`。

**验收**：跑 3 次全局运行（含 1 次故意失败），重开项目运行历史完整可见；runs.json 损坏时历史降级为空且应用不崩。

工作量：1-1.5 人日。

### WP3 长任务统一超时协议（对应 HANDOFF §11 第 3 条）

**现状**：仅 chat 等待有计时器（shared.ts:155-183）；生图/视频轮询/音频合成无超时，网关悬挂即永久 running。

**设计**：

- 分级默认值（毫秒，集中在 `engine/timeouts.ts` 单一事实源）：文本/对话/AI 处理 120_000；生图/音频 300_000；视频任务 1_800_000（轮询型）。
- 运行器统一实施：`invokeExecutor` 用 `Promise.race([exec, timeoutRejected])` 包裹，超时时触发该节点的 CancelSignal（复用 R0/WP3 既有取消链路）→ 执行器内部清挂起请求 → 运行器记 `phase='timeout'` 错误（label 带"超时（300s）"）、exec=error。
- 节点配置可覆盖：config 增可选 `timeoutMs`（WP1 访问器统一读写），UI 不做专门控件（高级用户直接改 JSON 配置），文档说明。
- 执行器侧唯一要求：尊重 ctx.cancel（已具备）；不各自实现 setTimeout。

**任务**：

1. `engine/timeouts.ts` 默认表 + `resolveTimeoutMs(nodeType, config)`。
2. `executor.ts` invokeExecutor 包超时 + 取消联动 + 错误构造（带 durationMs，供 WP2）。
3. 测试：vi.useFakeTimers 验证超时触发取消、错误 phase/文案、配置覆盖生效、正常完成不受影响。

**验收**：用假网关挂起 6s、超时设 100ms 的注入测试，节点在 100ms 变 error 且错误面板/日志出现"超时"；对照组正常运行不受影响。

工作量：0.5-1 人日。

### WP4 tldraw 连线端到端测试（对应 HANDOFF §11 第 4 条，可砍）

**现状**：连线创建/拒绝/环检测/重复边靠 `connection-matrix.test.ts` 的纯函数测试 + 人工回归；tldraw Editor 重环境（jsdom）未覆盖。

**任务**：

1. 测试环境升级：为 vitest 配 jsdom + tldraw `Editor` 实例的 headless 创建（复用 WP4 demo bundle 的 `createTLStore` 经验）。
2. 覆盖 5 条：拖线创建成功、类型不兼容拒绝、Schema 不兼容拒绝、成环拒绝、重复边拒绝；节点删除连带删线。
3. 若 headless Editor 初始化成本超过半天，降级方案：把这 5 条并入 REGRESSION.md 人工表并关闭本 WP（不阻塞 R8）。

**验收**：5 条 E2E 用例进 CI 且稳定（连跑 10 次无 flaky）；或按降级方案明确留档。

工作量：0.5-1 人日。

## 4. 实施顺序建议

| 阶段 | 内容 | 产出 | 门禁 |
| --- | --- | --- | --- |
| 第 1 段 | WP1 任务 1-3（字段 + 访问器 + 迁移函数），先双读不切写 | 旧项目可开、行为不变 | 全量测试绿 |
| 第 2 段 | WP1 任务 4-6（切投影、切全部调用方、测试改造） | text 只剩内容；投影单一规则 | 契约快照零变化 |
| 第 3 段 | WP3（独立，穿插做） | 超时协议 | 错误注入测试 |
| 第 4 段 | WP2（runMeta 已随 WP1 字段就绪） | 运行历史 | runs-repo 测试 |
| 第 5 段 | WP4（可选） | 连线 E2E | 稳定性验证 |

每段收尾跑 `pnpm typecheck && pnpm lint && pnpm test && pnpm build`。全部完成后按 R0 流程更新 ROADMAP/HANDOFF，并把 WP1 字段变化补进 REGRESSION.md 的"恢复"列预期（旧项目迁移项）。

## 5. 测试计划

| 编号 | 文件 | 覆盖内容 | 对应 WP |
| --- | --- | --- | --- |
| T1 | `test/node-config.test.ts` | 访问器真值表：props.config 命中、空回退旧 text 解析、非法 JSON 回退默认、写回 patch 正确 | WP1 |
| T2 | `test/text-split-migration.test.ts` | `splitLegacyTextField` 全 13 节点类型真值表 + `planLegacyMigrations` 集成 + 二次运行幂等 | WP1 |
| T3 | `test/projection-unified.test.ts` | result 优先投影、空 result 回退 props 派生、meta.nodeResult 兼容读、13 节点投影快照不变 | WP1 |
| T4 | `test/runs-repo.test.ts` | RunRecord 追加、50 条 FIFO、损坏重建、原子写；runMeta 计时写入 | WP2 |
| T5 | `test/timeout.test.ts` | fake timers：各分级默认值、超时取消、配置覆盖、正常完成不受影响、错误 phase='timeout' | WP3 |
| T6 | `test/connection-e2e.test.ts` | headless Editor 拖线创建/拒绝/环/重复边/删除联动（可降级） | WP4 |
| 回归 | 现有 21 文件 | 420 用例全绿；契约快照 75 用例零差异 = 行为等价证明 | 全部 |

## 6. 验收映射

| 来源条目 | 对应 WP | 验收物 |
| --- | --- | --- |
| ROADMAP R1 完成标准"节点配置、实际输入和实际输出在数据结构上互不混用" | WP1 | 字段三分 + 访问器 + rg 零命中 |
| ROADMAP §2 架构缺口"运行结果没有完整持久化运行记录、耗时和输入摘要" | WP2 | runs.json + 运行历史 UI |
| HANDOFF §11 第 3 条"长任务统一超时协议" | WP3 | timeouts.ts + 错误注入 |
| HANDOFF §11 第 4 条"tldraw 连线端到端测试" | WP4 | E2E 用例或降级留档 |
| HANDOFF §10 第 8 条"db.ts 动静双导入"（顺手项） | WP2 实施中 | run.ipc 静态导入 db，消除提示 |

## 7. 决策点（已确认 2026-08-27）

1. **旧项目迁移时机**：✅ 已确认——打开即写回迁移（与 R0/WP2 一致），幂等有测试保护。
2. **RunRecord 存储位置**：✅ 已确认——项目目录独立 `runs.json`，原子写 + 50 条 FIFO，隔离主文件。
3. **超时 UI 暴露**：按推荐执行——本轮只做 config 可覆盖（`timeoutMs`），不做专门控件，文档说明。
4. **WP4 取舍**：✅ 已确认——本轮做（headless Editor 连线 E2E，含 5 条用例与稳定性验证）。

## 8. R9 展望（本轮不做，仅锚定顺序）

R8 之后进入 v1.0 发布冲刺：性能基准项目生成脚本（100/500/1000 节点）与指标留档 → 崩溃恢复深度 UI（最近备份列表 + 修复向导）→ REGRESSION.md 全表人工回归 + 全新 Windows 用户目录安装冒烟 → 版本发布与契约变更记录归档。
