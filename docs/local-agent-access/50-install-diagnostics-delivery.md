# F9 收尾：本地推理环境安装的后台诊断事件（消除既有日志盲区）

日期：2026-11-08。基线：117 项操作。本包**不新增外部操作**，只补一个被 45 号台账如实登记过的
盲区：安装后台阶段没有任何诊断事件。

## 1. 问题

`installVideoEngine()` 的后台阶段——创建 venv → 更新 pip → 安装 PyTorch（约 3.3 GB）→
安装推理依赖 → 检测 CUDA → 下载并 SHA-256 校验权重——此前只有内存 `installStatus`
（progress/message）。后果：

- 装失败时用户只看到一句文案，**无法事后定位卡在哪一步**；
- 诊断 JSONL 里没有安装生命周期，出问题只能靠猜；
- GUI 同样缺失（不是外部接入引入的问题，是既有欠账）。

## 2. 补了什么

在 `src/shared/observability/events.ts` 登记 5 个事件，全部由
`main/media/video-conversion.ts`（安装的唯一执行者）写出：

| 事件 | 触发 | attributes |
| --- | --- | --- |
| `video_engine.install.started` | 通过 preflight 后开始 | `phase` |
| `video_engine.install.phase` | 每个阶段推进 | `phase` |
| `video_engine.install.completed` | 全部完成并写入 ready 标记 | `gpuPresent`、`durationMs` |
| `video_engine.install.failed` | 任一阶段失败 | `phase`、`code` |
| `video_engine.install.skipped` | 已就绪 / 已有安装在跑 | `phase`、`code` |

阶段：`preflight`/`venv`/`pip`/`pytorch`/`dependencies`/`gpu-check`/`weights`，
失败额外 `python-missing`/`install`，跳过 `already-ready`/`already-installing`。

稳定错误码：`PYTHON_REQUIRED`、`GPU_UNAVAILABLE`、`MODEL_DOWNLOAD_FAILED`、
`MODEL_INTEGRITY_FAILED`、`INSTALL_FAILED`、`ENGINE_ALREADY_READY`、`INSTALL_IN_PROGRESS`。
（新增 `classifyInstallFailureCode()` 把文案映射成码，文案给人看、码给诊断与外部回执用。）

## 3. 关键设计

- **只加观测，不改安装行为**：所有 `updateInstallStatus` 调用与流程顺序完全不变，
  新增的只是 `traceInstall()` 调用。
- **脱敏**：事件不含本机绝对路径、pip 输出、下载 URL、`--index-url` 参数或权重哈希细节。
- **唯一终态**：安装生命周期归 `video-conversion.ts`；外部操作的 `agent.access.*` 只代表
  "操作受理"，不重复记安装终态。
- **不谎报**：已就绪 → `skipped/ENGINE_ALREADY_READY`；已在安装 → `skipped/INSTALL_IN_PROGRESS`，
  绝不写第二个 `started`。

## 4. 真实验证（`test/video-engine-install-diagnostics.test.ts`，5 项通过）

**安全前提**：本机装有 Python 3.12，若放任执行会真的创建 venv 并下载 3.3 GB。测试因此
`mock` 掉 `child_process.spawn`，让任何子进程调用立即失败（等价"无可用 Python"），
**绝不触发真实安装与下载**。

1. 子进程不可用 → 记 `failed` + `PYTHON_REQUIRED`，`status=failed`，**零网络请求**（fetch spy），
   且不出现 `completed`；
2. 事件 JSON 不含数据目录、`huggingface.co`、`download.pytorch.org`、`--index-url`；
3. 重复调用最多一个 `started`，且必然留下 `skipped` 或 `failed`；
4. sink 同步抛错时安装流程照常返回；
5. sink 返回拒绝的 Promise 时不产生未处理拒绝。

配套：`npm run verify:logging` 通过；`npm run typecheck` 0 错误。

## 5. 未覆盖边界

- 真实联网安装的成功路径、中途失败恢复、耗时统计未验收（需真实 CUDA 环境 + 数 GB 下载）；
- 安装取消与进度订阅未开放（仍用 `environment.videoEngine.status` 轮询 `progress`）；
- 本包只补事件，不改外部接口，因此 `verify:agent-access` 操作数不变（117）。
