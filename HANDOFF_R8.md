# R8 收尾与后续开发交接计划

> 编写日期：2026-08-27
> 当前提交：`dc3f8e6`（main 分支，已推送 GitHub）
> 前置状态：R0-R7 全部完成，R8 WP1（字段三分）+ WP2（运行记录持久化）已完成，P1（节点悬停工具栏）已完成。
> 门禁状态：typecheck ✅ lint ✅ 437 tests ✅ build ✅
> 文档更新：HANDOFF.md §4/§9/§10/§11/§13 已同步，ROADMAP.md §3 已新增 R8 章节。

---

## 1. 本次提交内容概览

### 1.1 R8 WP1 — 节点数据字段三分（config / text / result）

**问题**：`NodeCardProps.text` 单字段被全部节点复用——文本节点存正文、11 个执行器把配置 JSON 写进 text、投影再从 text 拆配置取结果。配置/内容/结果混存一个字符串。

**解决方案**：

| 字段 | 用途 | 访问器 |
| --- | --- | --- |
| `text` | 用户可见文本：文本节点正文、对话 messages、剧本源文 | `getNodeText()` |
| `config` | 节点固定配置 JSON：模型 key、系统提示词、参数、seed | `getNodeConfig()` |
| `result` | 上次运行登记结果（NodeValue JSON），投影优先来源 | `getNodeResult()` / `setNodeResult()` |
| `runMeta` | 轻量运行元数据 JSON：`{ at, durationMs, runId, error? }` | 运行器统一写入 |

**关键文件**：
- `src/renderer/src/nodes/nodeData.ts` — 访问器全集（getNodeConfig/getNodeText/getNodeResult/setNodeResult + splitLegacyTextField）
- `src/renderer/src/canvas/NodeCardShape.tsx` — tldraw 迁移 v1→v2（AddConfigResult + AddRunMeta）
- `src/renderer/src/nodes/migrations/legacy.ts` — 旧项目迁移逻辑
- 全部 13 节点 Body 和 11 执行器已切换到访问器读写

**投影规则（单一）**：已运行节点从 `result` 投影 → 未运行从 `config` 派生 → 旧 `meta.nodeResult` 兼容读。

### 1.2 R8 WP2 — 运行记录持久化

**问题**：运行结束只有内存 store 复位与状态灯；错误落盘了（R0），但成功路径无耗时、无输入摘要、无历史。

**解决方案**：

```
节点级 runMeta                  项目级 runs.json
┌─────────────────────┐        ┌─────────────────────────────────┐
│ props.runMeta: JSON │        │ <projectId>/runs.json           │
│ { at, durationMs,   │  ──→   │ [{ runId, startedAt, durationMs, │
│   runId, error? }   │  IPC   │   total, ok, failed,            │
└─────────────────────┘  fire  │   nodes: [...] }]               │
                         and    │ 最多 50 条 FIFO 淘汰             │
                         forget └─────────────────────────────────┘
```

**关键文件**：
- `src/shared/contracts/index.ts` — `IPC.run.append`/`IPC.run.list` + `RunMeta`/`RunRecordNode`/`RunRecordEntry` 类型
- `src/main/ipc/run.ipc.ts` — `appendRunRecord`（原子写 .tmp+rename+.bak，50 FIFO，损坏降级重建）+ `readRunRecords`（容错读取）+ `registerRunIpc`
- `src/renderer/src/engine/executor.ts` — `runWorkflow`/`runNodeManually` 统一计时（performance.now 包裹）+ `writeRunMeta`/`reportRunRecord`
- `src/renderer/src/canvas/NodeCardView.tsx` — 状态灯 hover 提示（解析 runMeta JSON → "上次运行：成功 · 2.3s · 14:32"）
- `src/renderer/src/canvas/CanvasSidePanel.tsx` — RunsPanel 组件（运行列表卡片 + 展开看每节点明细 + 点击失败节点定位画布）
- `test/runs-repo.test.ts` — 10 个测试用例

**验收**：跑 3 次全局运行（含 1 次故意失败），重开项目运行历史完整可见；runs.json 损坏时历史降级为空且应用不崩。

### 1.3 P1 — 节点悬停工具栏（借鉴 infinite-atelier）

**关键文件**：
- `src/renderer/src/canvas/node-toolbar/imageProcessing.ts` — 前端 Canvas2D 处理（裁剪/拆分/放大/替换）
- `src/renderer/src/canvas/node-toolbar/nodeToolbarTools.ts` — 工具定义 + localStorage 配置
- `src/renderer/src/canvas/node-toolbar/NodeHoverToolbar.tsx` — 悬停工具栏组件（处理结果生成新节点）
- `test/nodeToolbarTools.test.ts` — 7 个测试用例

**适配原则**：处理结果成为新节点而非就地替换（符合节点画布范式）；无"保存到资产"因 MediaStore 已集中管理；无"反向提示词"因 chat 网关暂不支持图片输入。

---

## 2. R8 剩余工作包

### 2.1 WP3 — 长任务统一超时协议（优先级：高，0.5-1 人日）

**现状**：仅 chat 等待有计时器（`executors/shared.ts` 的 `waitForChat`），生图/视频轮询/音频合成无超时约束。网关悬挂时节点永远 running，只能手动取消。

**实施方案**：

1. **新建 `src/renderer/src/engine/timeouts.ts`**：
   ```typescript
   const DEFAULT_TIMEOUTS: Record<string, number> = {
     chat: 120_000,
     'ai-process': 120_000,
     'image-gen': 300_000,
     audio: 300_000,
     video: 1_800_000,  // 轮询型，较长
   }
   export function resolveTimeoutMs(nodeType: string, config?: Record<string, unknown>): number {
     const override = typeof config?.timeoutMs === 'number' ? config.timeoutMs : undefined
     return override ?? DEFAULT_TIMEOUTS[nodeType] ?? 120_000
   }
   ```

2. **修改 `executor.ts` 的 `invokeExecutor`**：
   ```typescript
   const timeoutMs = resolveTimeoutMs(nodeType, config)
   const timeoutPromise = new Promise<NodeExecutionResult>((_, reject) =>
     setTimeout(() => reject(new TimeoutError(nodeType, timeoutMs)), timeoutMs)
   )
   const result = await Promise.race([executor(ctx), timeoutPromise])
   ```
   超时时触发该节点的 `CancelSignal`（复用 R0/WP3 既有取消链路），运行器记 `phase='timeout'` 错误（label 带"超时（300s）"），exec=error。

3. **节点 config 增可选 `timeoutMs`**：通过 WP1 的 `getNodeConfig()` 读取，UI 不做专门控件（高级用户直接改 JSON），文档说明。

4. **测试 `test/timeout.test.ts`**：
   - `vi.useFakeTimers` 验证各分级默认值触发
   - 超时触发取消信号
   - 错误 phase='timeout' 且文案含秒数
   - 配置覆盖生效
   - 正常完成不受影响

**验收**：用假网关挂起 6s、超时设 100ms 的注入测试，节点在 100ms 变 error 且错误面板/日志出现"超时"；对照组正常运行不受影响。

### 2.2 WP4 — tldraw 连线端到端测试（优先级：低，可砍，0.5-1 人日）

**现状**：连线创建/拒绝/环检测靠纯函数测试 + 人工回归；tldraw Editor 重环境未覆盖。

**实施方案**：

1. **测试环境升级**：为 vitest 配 jsdom + tldraw `Editor` 实例的 headless 创建（复用 `test/helpers/fakeEditor.ts` 经验）。
2. **覆盖 6 条**：
   - 拖线创建成功
   - 类型不兼容拒绝
   - Schema 不兼容拒绝
   - 成环拒绝
   - 重复边拒绝
   - 节点删除连带删线
3. **降级方案**：若 headless Editor 初始化成本超过半天，把 6 条并入 `docs/REGRESSION.md` 人工表并关闭本 WP（不阻塞 R8）。

**验收**：6 条 E2E 用例进 CI 且稳定（连跑 10 次无 flaky）；或按降级方案明确留档。

---

## 3. R8 完成后的发布流程

R8 全部 WP 完成后，按以下流程发布 v1.0：

### 3.1 发布前回归

1. **全量人工回归**：按 `docs/REGRESSION.md` 全表执行（13 节点 × 9 操作 + 示例项目 5 链路），留档结果。
2. **安装冒烟**：`pnpm build:win` 后在全新 Windows 用户目录安装启动，验证 `%APPDATA%/canvas-studio/data/` 自动创建。
3. **运行历史验证**（R8 WP2 新增）：
   - 运行 3 次全局工作流（含 1 次故意失败），侧面板「运行历史」可见完整记录
   - 状态灯 hover 显示"上次运行：成功/失败 · 耗时 · 时间"
   - 关闭并重开项目，运行历史保留
   - 手动删除 `runs.json` 内容（模拟损坏），再次运行后降级重建为仅含当前记录，应用不崩
4. **旧项目迁移验证**（R8 WP1 新增）：
   - 用 R0 之前的旧项目文件打开，验证 config/text/result 字段自动迁移
   - 连续打开保存两次，验证迁移幂等（第二次不重复迁移）

### 3.2 发布检查清单

```text
[ ] git status 中没有临时文件、数据库、媒体或 API Key
[ ] pnpm install 没有原生依赖许可警告
[ ] pnpm typecheck 通过
[ ] pnpm lint 通过
[ ] pnpm test 通过（437 用例）
[ ] pnpm build 通过
[ ] 文本节点双击可编辑
[ ] 图片粘贴/拖入后成为节点
[ ] 单值端口不能连接第二个上游
[ ] JSON Schema 不兼容连线被拒绝
[ ] 节点删除时关联线同步删除
[ ] 分组移动、撤销和重做正常
[ ] 旧项目打开、保存、重开正常（含 R8 字段迁移）
[ ] 对话 Markdown 正常渲染
[ ] 生图/视频真实供应商至少各冒烟一次
[ ] API Key 保存后落盘为加密密文（非明文），重新读取可还原
[ ] 项目可导出 .canvasbundle 并在另一台机器导入恢复
[ ] 错误日志落盘且不含 API Key/Authorization token
[ ] 首页「打开示例项目」可用，5 条链路全部运行成功
[ ] 全新 Windows 用户目录安装启动正常
[ ] 运行工作流后侧面板「运行历史」可见各节点耗时与状态（R8 WP2）
[ ] 状态灯 hover 显示运行摘要（R8 WP2）
[ ] 重开项目后运行历史保留（R8 WP2）
```

---

## 4. R8 之后的后续方向

R8 完成后，内核债务基本清偿完毕。后续方向按优先级排列：

### 4.1 P2 — 导演台轻量版（分镜镜头控制台）

**来源**：借鉴 infinite-atelier 的 MONOFORM 导演面板，但**以我们的节点规范为准**。

**设计思路**：
- 不是独立组件，而是在分镜板节点的侧面板增加「镜头控制台」视图
- 每个分镜卡片增加状态指示（待生成/已生成图片/已生成视频/已完成）
- 支持"一键生成选中镜头的图片/视频"（复用现有生图/视频节点链路）
- 严格遵守 NODE_CONTRACT_SPEC.md：不绕过节点契约直接调网关

**前置依赖**：R8 WP3（超时协议）完成后开始，避免批量生成时网关悬挂。

### 4.2 结构化 Schema 扩展

当前只有 `json.any@1` 和 `storyboard.shots@1` 两个 Schema。后续可建立：
- `character.profile@1` — 角色设定（名字、外貌、性格、服装）
- `scene.description@1` — 场景清单（地点、时间、氛围、道具）
- `subtitle.track@1` — 字幕轨道（时间码、文本、说话人）
- 结合 R4 的 `list.items@1` 列表协议，提供更细粒度的元素 Schema

### 4.3 性能基准与优化

- 建立 100/500/1000 节点基准项目，记录首屏、拖动和保存耗时
- tldraw 原生基于索引优化，但自定义节点渲染层可能成为瓶颈
- 大 JSON 预览截断已做（R6），但节点数量增长时的虚拟化渲染未验证

### 4.4 发布与分发

- 正式版版本号、升级说明、数据备份提示
- 安装包签名（Windows Authenticode）
- 自动更新机制（electron-updater）
- 用户文档和快速上手指南

---

## 5. 关键架构决策记录

以下决策在本轮工作中确立，后续开发应遵守：

### 5.1 数据字段三分原则

节点的配置、内容、运行结果**必须**分别存放在 `config`/`text`/`result` 三个字段中，不得复用 `text` 存储配置或结果。

- **读**：通过 `nodeData.ts` 访问器，不直接 `JSON.parse(shape.props.text)`
- **写**：执行器通过 `ctx.updateProps` / `ctx.updateResult` 受控写回
- **迁移**：`splitLegacyTextField` 按 `nodeType` 拆分旧 text，幂等

### 5.2 运行记录持久化原则

- 节点级 `runMeta` 由运行器统一写入，执行器零改动
- 项目级 `runs.json` 不进 `project.json`（避免主文件膨胀）
- IPC 模式：`run.append` 是 fire-and-forget（渲染进程不等主进程写完），`run.list` 是请求/响应
- 容错：runs.json 损坏时降级为空或仅含当前记录，不阻断应用

### 5.3 外部借鉴适配原则

用户明确指示："如果是外部的东西接入到我们里面来，一定要符合我们的节点规范，以我们的节点规范为准。"

- P1 悬停工具栏：处理结果成为新节点（非就地替换），符合节点画布范式
- P2 导演台：镜头控制台嵌入分镜板节点侧面板，不绕过节点契约直接调网关
- 所有外部功能必须通过现有的节点 Spec → 执行器 → IPC → 网关链路实现

---

## 6. 开发环境快速恢复

接手者按以下步骤可快速恢复开发环境：

```bash
# 1. 克隆仓库
git clone https://github.com/fanke52013141-cmd/free-creation.git
cd free-creation

# 2. 安装依赖（Node.js 20+, pnpm 10）
pnpm install

# 3. 启动开发服务器
pnpm dev

# 4. 验证门禁
pnpm typecheck   # 类型检查
pnpm lint        # ESLint
pnpm test        # 437 个测试用例
pnpm build       # 生产构建
```

阅读顺序：
1. `README.md` — 项目入口
2. `NODE_CONTRACT_SPEC.md` — 节点契约强制规范
3. `HANDOFF.md` — 当前架构和关键决策
4. `ROADMAP.md` — 后续开发顺序
5. `R8_PLAN.md` — 本轮内核收敛计划
6. `ATELIER_PLAN.md` — 外部借鉴策略（P1/P2/P3）
