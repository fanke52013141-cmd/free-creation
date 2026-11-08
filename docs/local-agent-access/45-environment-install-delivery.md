# F9（四）交付：环境探测补强与视频引擎安装外部接入

日期：2026-11-08。范围：GUI「环境」页/视频节点本地推理环境面板的**安装启动**动作（`media:video-engine-install`）
与 `environment.local` 只读探测补强。

结论：**新增 1 项外部写操作 `environment.videoEngine.install`；`environment.local` 以向后兼容方式补齐
FFmpeg/FFprobe 版本与视频引擎阶段（phase）**。安装下载逻辑完全复用 GUI 的 `installVideoEngine()`，
外部不能指定 URL/镜像/路径；未确认时不触碰实现（0 次下载）。本包不做真实联网安装验收。

- 外部操作（三入口同源）：本包 **+1**（基线 95 → 96；最终聚合数字以 Lead 刷新后的审计输出为准）；
- 不新增数据库迁移、不新增桌面握手动作、不新增下载器、不修改 `video-conversion.ts` 安装逻辑；
- 安装进度与终态仍由既有 `environment.videoEngine.status` 读取（后台任务，不等安装完成）。

---

## 1. 逐项三入口状态

| 变化 | 外部操作 | GUI 同一动作 | 公共实现 | CLI | MCP |
| --- | --- | --- | --- | --- | --- |
| 新增（write） | `environment.videoEngine.install` | 环境面板「安装本地推理环境」（`ipc.media.videoEngineInstall`） | `installVideoEngine()`（同一实现，含固定下载源与 SHA-256 校验） | `environment videoEngine install` | `environment_videoEngine_install` |
| 补强（read） | `environment.local` | 媒体执行前置 + 环境面板（`ipc.media.localCapabilities`） | 同一 `getLocalMediaCapabilities()` + `ffmpeg-runner` 版本读取 + `getVideoEngineStatus()` | `environment local` | `environment_local` |

CLI/MCP 名由同一 Registry 自动派生，`test/local-agent-parity.test.ts` 已验证无保留字冲突、MCP 名唯一。

## 2. 安装语义（write）

### 2.1 确认与副作用

- 输入只有 `confirmInstall: boolean`（缺省 false），**必须显式 true**。
  未确认 → `failed` + `INSTALL_CONFIRM_REQUIRED`，且**不调用** `installVideoEngine()`（0 次下载、0 次写盘）。
- 不接受任何自定义下载源（`url`/`mirror`/`path` 等未知字段被 strict Schema 拒绝为 `INVALID_INPUT`）：
  下载地址、PyTorch 源、模型权重与 SHA-256 校验都在 `installVideoEngine()` 内固定，外部无法改写。
- 需要联网 + 本机 Python 3.12：这是 GUI 安装按钮的同一前提，外部不额外放宽或收紧。

### 2.2 `started` 到底表示什么

| 返回 | 含义 |
| --- | --- |
| `started=true` | **本次调用**启动了一次安装（后台已受理，尚未完成） |
| `started=false` + `ready=true` | 环境已就绪，无需安装 |
| `started=false` + `installing=true` | 已有安装在进行（本次没有重复启动） |

"安装成功"不能用 `started=true` 表达；完成/失败/GPU 名称一律经 `environment.videoEngine.status`
（`ready`/`installing`/`progress`/`message`/`gpuName`）读取。本操作在安装启动后立即返回，
**不把安装等待塞进请求**（首次安装需要下载约 3.3 GB CUDA 依赖）。

### 2.3 幂等与并发（三层）

1. **dispatch 幂等账本**：write 操作必须带幂等键；同键同参重放返回原回执且不再执行（含不再调安装实现）；
   同键异参 → `IDEMPOTENCY_CONFLICT`。
2. **外部启动去重**：`settings-ops` 内部共享一个 `installStartAttempt`；并发调用只有一个真正进入
   `startVideoEngineInstall()`，后来者等待同一尝试后返回 `started=false`，不会启动第二个安装。
3. **安装实现自带护栏**：`installVideoEngine()` 的 `installPromise`/`installStarting` 保证进程内只有
   一个安装任务（本包未改动该文件）。

并发在 dispatch 层还有既有全局写锁：两个并发请求只有一个进入业务，另一个得到 `RESOURCE_BUSY`。

如实边界：极端竞态（本操作读完状态、尚未调用安装实现的极短窗口内，GUI 恰好点了安装按钮）下
本次响应可能报 `started=true` 而实际是 GUI 启动的那次；此时**不会**产生第二个安装
（`installVideoEngine` 自身护栏拒绝重复启动），但"谁启动的"标注可能偏差。该窗口无法在不修改
`video-conversion.ts` 的前提下消除（它不暴露"本次是否真的启动"的独立标志）。

### 2.4 失败语义（稳定码）

| 错误码 | 触发 | 说明 |
| --- | --- | --- |
| `INSTALL_CONFIRM_REQUIRED` | 未带 `confirmInstall: true` | 未调用安装实现 |
| `PYTHON_REQUIRED` | 本机缺 Python 3.12（GUI 安装路径唯一会同步抛出的可预期失败） | `detail` 是 GUI 同一句可操作提示（如「未找到 Python 3.12；请先安装 Python 3.12（64 位）后重试」），不含路径/异常栈 |
| `INSTALL_START_FAILED` | 其它同步失败 | 只给固定文案，不把原始异常文本回给外部；下一步用 status 核对 |
| `ENVIRONMENT_PROBE_FAILED` | 读取安装状态本身异常 | 不伪造安装已开始 |

安装**后台**失败（pip/下载/显卡检测）不会改变本次受理回执；失败原因由 `status.message` 如实反映
（与 GUI 面板同一文案），因此外部必须用 status 判定终态。

### 2.5 测试如何保证"绝不真的联网安装"

`test/local-agent-models-env-access.test.ts` 用 `vi.mock` 替换 `installVideoEngine`（只计数 + 改状态替身），
`getVideoEngineStatus` 默认委托真实只读实现、需要时切到可控状态。断言包括：

- 未确认/未知字段 → `INSTALL_CONFIRM_REQUIRED`/`INVALID_INPUT` 且 `installCalls === 0`；
- 确认后 `installCalls === 1` 且 `started=true`；
- 已就绪/已在装 → `started=false` 且 `installCalls === 0`；
- 缺 Python → `PYTHON_REQUIRED` + GUI 提示，`installCalls === 1`；
- 并发（分组实现层）→ `installCalls === 1`，恰好一个 `started=true`；
- dispatch 层并发 → 一个 completed、另一个 `RESOURCE_BUSY`，`installCalls === 1`；
- 幂等重放 → 回执一致且 `installCalls === 1`；
- 全流程 `fetch` spy 0 次调用。

## 3. 探测补强（environment.local，保持只读）

| 字段 | 补强内容 | 说明 |
| --- | --- | --- |
| `ffmpeg` / `ffprobe` | 新增可选 `version` | 可用性与缺失提示仍来自 GUI 同一 `getLocalMediaCapabilities()`；版本由**同一二进制** `-version` 读取（`ffmpeg-runner`，同一缺失提示），只取版本令牌（如 `8.1-essentials_build…`），不含构建 URL/本机路径。缺失时无 `version` 字段 |
| `videoEngine` | 新增 `phase` | `ready` / `installing` / `python-ready`（有 Python，可安装或待修复）/ `python-missing` / `unsupported-platform`；与 `ready`/`installing`/`pythonAvailable` 一一对应，便于不解析文案就判断下一步 |
| `audioSeparator` / `indexTts` | 不变 | audio-separator 无稳定版本接口；IndexTTS 仍只 `ready`/`state`（GUI 详情文案含本机绝对路径） |

去敏（与 36 号台账同一口径，并扩展到新品文案）：
- 输出不含连接地址/密钥（模型目录部分不变）；
- `environment.local`、`environment.videoEngine.status`、`environment.videoEngine.install` 的
  `message`/`progress` 统一抹除应用数据目录与 Windows 盘符/POSIX 常见绝对路径（标记为
  `[数据目录]` / `[本机路径]`），避免 pip/解释器输出把本机路径带出；
- 仍不返回 IndexTTS 解释器/模型目录、不返回安装日志。

## 4. 真实验证证据

```
> node scripts/run-vitest.cjs run test/local-agent-models-env-access.test.ts --reporter=dot
Test Files  1 passed (1)
     Tests  21 passed (21)      # 原 12 项 + 安装 8 项 + 探测补强 1 项

> node scripts/run-vitest.cjs run test/local-agent-models-env-access.test.ts test/local-agent-parity.test.ts --reporter=dot
Test Files  2 passed (2)
     Tests  28 passed (28)

> npm run typecheck
（typecheck:node / web / license-protocol / issuer 全部通过）

> node scripts/audit-business-actions.cjs
（见第 6 节：本包映射无 ORPHAN/UNKNOWN；聚合 inventory 由 Lead 统一 --write 刷新）
```

测试覆盖细节：未确认 0 次调用、确认受理、已就绪/已在装 `started=false`、缺 Python 稳定码 + GUI 提示、
分组层并发、dispatch 层并发、幂等重放、事件字段、探测补强版本与 phase、无本机路径、fetch 0 次。

## 5. 日志覆盖与脱敏

- **不新增事件类型**（需登记 `src/shared/observability/events.ts`，不在本包文件范围）：
  `environment.videoEngine.install` 复用 dispatch 的 `agent.access.started/completed/failed`
  （`attributes.operation` + `phase` + 稳定 `code` + trace/span），只代表**操作受理**生命周期，
  不代表安装成功。
- 安装后台阶段（创建 venv / pip / 下载权重 / GPU 检测）目前只有内存状态 `installStatus`
  （`progress`/`message`），GUI 同样没有对应诊断事件——这是**既有盲区**，本包如实登记，
  下一包建议新增 `videoEngine.install.started/completed/failed` 事件（含 duration、阶段、GPU 名称摘要，
  不含 URL 查询串/密钥/本机路径）。
- 脱敏：`message`/`progress` 经统一路径抹除；`detail` 只含稳定阶段与 GUI 提示句；
  事件不含安装命令、pip 输出、模型 URL 或数据目录。
- 日志写入失败不改变业务结果（dispatch 既有语义），安装启动不依赖日志。

## 6. 门禁现状与边界

- `npm run typecheck`：通过（退出码 0）。
- `node scripts/audit-business-actions.cjs`：本包 1 个新映射被识别（无 `ORPHAN_EXTERNAL_OP`）；
  `generated/action-inventory.json` 属聚合产物，需 Lead 统一 `--write` 刷新。
- `npm run verify:agent-access`：预计红在聚合产物（`generated/contracts.json` 新操作快照 +
  `change-impact.json` 受保护源码哈希），由 Lead 统一 `--write --accept-contract-change --reason "…"`；
  本包未改快照/影响声明。
- **未做**：真实联网安装、真实下载/安装时长与失败恢复实测、桌面端「安装→进度→就绪」全流程、
  真实 MCP 客户端逐动作；安装取消/进度订阅未开放（用 status 轮询 `progress`）。
- 本包对 `src/main/agent-access/service.ts` 有 1 行必要追加（exhaustive `unhandledOperation(never)`
  要求为新操作登记占位 case，与上包同一模式）——超出给定文件清单，已在交付说明中标注。
