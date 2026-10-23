# Handoff：Vidu 本机 CLI 供应商接入（2026-10-23）

> 本机复验更新：完整 `npm run verify`（`run-awurJV`）退出 0；Q3/Q4 均已真实生成、下载、解码成功。Q3 冒烟报价漏传 `transition=pro` 已修正，1 秒实际扣费 30 积分，Q4 为 4 积分。详见 [本机验证记录](./VIDU_VERIFICATION_2026_10_23.md)。下方“Q3 未做”为原交接快照，以本条更新为准；画布真实端到端验收仍未完成。

## 状态总览

Vidu 以「本机 CLI 供应商」形态接入，定位与即梦（Dreamina）同类，但凭据是 Vidu Token
（加密保存于本机），而不是 OAuth 登录态。当前进度：**共享契约、主进程 CLI 执行器、
网关视频任务接线、模型目录 UI、真实生成验证适配器、契约单测与 Q4 真实冒烟均已完成**；
Q3 真实冒烟、旧供应商面板预设、免费连通性探测、视频节点真实路径人工验收尚未做（见
「未完成与边界」）。

本批改动共 9 个修改文件 + 5 个新增文件，全部未提交状态已于 2026-10-23 提交
（见文末「提交」）。

## 设计要点

- 通过官方 npm 包 `vidu-cli`（版本门 ≥ 0.2.33）以子进程调用，`shell: false`、
  `windowsHide`，永不走 .cmd/shell。
- Token 不进 argv：以环境变量 `VIDU_TOKEN`、`VIDU_BASE_URL` 传给子进程；stderr
  直接丢弃不转发，stdout 只整段 JSON 解析，解析失败不返回原文（防提示词/密钥/签名
  URL 泄漏）。
- Base URL 白名单：仅 `https://service.vidu.cn` 与 `https://service.vidu.com`。
- 提交恰好一次：CLI v0.2.33 对写操作无重试；5xx 语义区分「查询失败（可继续核对）」
  与「提交结果未知（必须先核对原任务，避免重复计费）」。
- 复用网关视频任务的既有链路：tasks 表、轮询、恢复、取消、成片下载与入库；
  Vidu 没有旁路任何公共执行器。

## 支持的模型与能力

| 模型 ID | 名称 | 模式 | 参考图 | 分辨率 | 时长 | 备注 |
| ------- | ---- | ---- | ------ | ------ | ---- | ---- |
| `3.4` | Vidu Q4 | 图片参考生视频（`reference`，CLI `character2video`） | 1–7 张 | 540p/720p/1080p/2k/4k | 1–10 秒 | 默认 540p |
| `3.2` | Vidu Q3 | 首尾帧生视频（`first-last-frame`，CLI `headtailimg2video` + `--transition pro`） | 恰好 2 张（有序） | 仅 1080p | 1–10 秒 | 画幅跟随首帧，不传 `--aspect-ratio` |

- 禁止模型回退：Q4 与 Q3 的模式互不 substitute，选错显式报错（CLI 0.2.33 的硬约束，
  不是缺陷）。
- 首尾帧下画幅由首帧决定：`videoRatioIsDerivedByFrames` 已包含 vidu。

## 关键入口

| 文件 | 职责 |
| ---- | ---- |
| `src/shared/vidu-cli.ts` | 纯契约：常量、`buildViduVideoArgs`、`parseViduOutput`、`classifyViduTask`、`ViduCliError` |
| `src/main/gateway/vidu-cli.ts` | 二进制解析（`CANVAS_STUDIO_VIDU_PATH` → APPDATA npm → PATH）、版本门、`runViduJson`（120s/45s 超时、abort、2MB 输出上限、429/5xx 分类）、`submitVideoWithVidu`（本地媒体路径解析）、`pollVideoWithVidu`、`validateViduBaseURL` |
| `src/main/model-host/vidu-validation-adapter.ts` | `video.generate` 真实生成验证：`@napi-rs/canvas` 造参考图（Q3 造两帧），15 分钟轮询截止，独立 trace/span 四态诊断事件，临时目录清理 |
| `src/main/gateway/video.ts` | `adaptersFor('vidu')` 接入提交/轮询；`submitVideoTask` 白名单加 `vidu`；`controlVideoTask` 取消路径改为用 `pollVideoWithVidu` 核对远端事实再落终态 |
| `src/main/gateway/providers.repo.ts` | `vidu-cli` 协议 ↔ `vidu` spec 双向目录映射 |
| `src/main/ipc/models.ipc.ts` | 保存连接时校验 Vidu Base URL；「拉取可用模型」固定返回 3.4 / 3.2 |
| `src/main/model-host/runtime.ts` | 注册 `ViduValidationAdapter` |
| `src/shared/provider-driver.ts` | 驱动类型 `vidu-cli`；`guessModelModality` 对 vidu 一律返回 video |
| `src/shared/video-capabilities.ts` | 两个模型的能力档位；`RESOLUTION_COST_ORDER` 增加 `540p`；首尾帧画幅派生 |
| `src/renderer/src/gateway/ModelCatalogPanel.tsx` | 协议选项「Vidu（本机 CLI）」，选中自动填 Base URL/名称/模型；Token 字段文案；保存模型仅允许 video 分类 + 3.4/3.2；发现模型自动归视频分类 |
| `packages/model-contracts/src/index.ts` | `ConnectionProtocol` 增加 `vidu-cli` |
| `test/vidu-cli.test.ts` | 契约单测（离线） |
| `test/vidu-live-smoke.test.ts` | 真实计费冒烟，需 `VIDU_LIVE_SMOKE=1` + `VIDU_TOKEN`，可选 `VIDU_SMOKE_MODEL=3.2`、`VIDU_SMOKE_DIR` |

## 用户可见流程

1. 前置：本机安装 CLI —— `npm install -g vidu-cli@0.2.33`（或更高），或设置
   `CANVAS_STUDIO_VIDU_PATH` 指向原生可执行文件。
2. 画布「模型管理」→ 添加连接 → 服务商类型选「Vidu（本机 CLI）」（自动填
   `https://service.vidu.cn` 与默认模型）→ 粘贴 Vidu Token → 保存（仅加密存本机）。
3. 添加模型（3.4 或 3.2，video 分类）→「验证模型」：真实生成 1 秒视频
   （Q4 540p 实测 4 积分；Q3 1080p），通过后绑定 `video.generate` 功能键。
4. 视频节点引用该模型：端口与参数由能力表驱动（Q4 参考图端口 1–7 张；Q3 首尾帧）。
5. 生成走统一视频任务：提交一次 → 轮询 → 成片自动下载入库；取消/停止先核对远端
   事实，避免重复计费。

## 已验证

- **契约单测**：`test/vidu-cli.test.ts` 5/5 通过（参数构造、模式/模型互斥、能力表、
  终态分类、恶意输出不落原文）。注：接手时发现两条 `--type` 断言与实现漂移
  （断言等号连写、实现为分离参数）；以真实 CLI 冒烟通过的实现为准，已修正断言。
- **Q4 真实冒烟**（2026-10-23 17:39）：任务 `3521107143975243`，1 秒 / 540p / 1:1，
  远端 success，成片下载校验 MP4 `ftyp` 头（28,427 字节），积分 10423 → 10419
  （消耗 4）。证据 `qa/vidu/live-20261023-q4/receipt.json`（`qa/` 不入库，仅本机）。
- **本会话回归**：lint、typecheck（node / web / model）、全量 vitest、
  `test:model`、`verify:logging` 日志门禁（结果见提交信息与下方「日志覆盖」）。
- 此前未跑：完整 `npm run verify` 的 Electron 桌面场景（agent-flow 系列、R09 等，
  与本次改动无交集）。

## 日志覆盖（按 AGENTS.md 交付要求）

- **执行路径**：完全复用网关视频任务既有生命周期，未新增也未旁路：
  `model.request.started/accepted`、`task.state_changed`、`task.poll_summary`、
  `task.failed`、`task.control.started/completed`、`task.resume_*`、
  `media.download_*`、`media.persist_*`。取消路径改为「先核对远端事实再落终态」，
  仍走 `task.control.*` 同 trace 配对。
- **验证路径**：`ViduValidationAdapter` 使用独立 trace/span 发射
  `model.request.started/accepted/completed/failed`，失败标注 phase
  （`validation-fixture` / `upload-submit` / `poll`），唯一终态，不重复记。
- **脱敏**：stdout 仅整段 JSON 解析、失败不返回原文；stderr 丢弃；输出超 2MB 即断；
  错误文案不包含提示词、密钥、签名 URL（单测覆盖 `parseViduOutput` 拒绝自由文本）。
- **门禁**：`verify:logging`（L06 增量旁路检查）通过——新增 main 进程文件无裸
  console、无 electron-log 直连、`spawn` 不触发 A18 网络规则、验证适配器自带诊断接入。
- `docs/LOGGING_COVERAGE.md` 已补 2026-10-23 条目。

## 未完成与边界

1. **Q3（3.2 首尾帧）未做真实 CLI 冒烟**：只有契约单测。补法：
   `VIDU_LIVE_SMOKE=1 VIDU_SMOKE_MODEL=3.2 VIDU_TOKEN=… npm run test -- test/vidu-live-smoke.test.ts`。
2. **`PROVIDER_SPECS`（`src/shared/types/index.ts`）没有 `vidu` 模板**：旧供应商设置
   面板与节点空态「可新增预设」提示看不到 Vidu。新增时需同步
   `ProviderSettingsPanel.modalitiesForSpec`（返回 `['video']`）与白名单逻辑。
3. **provider-check 无 Vidu 分支**：连接自检退化为「该协议没有只读端点可探测」提示。
   CLI 本有零计费 `task cost` / `quota credit`，可仿照 `probeDreamina` 做免费探测
   （二进制 + 版本 + Token + 余额）。
4. **视频节点真实路径未人工验收**：能力表已数据驱动（与 seedance reference 模式同
   一路径），但按节点规范未走一次真实节点验收（参考图端口、Q3 首尾帧端口、参数
   面板、成片回填）。
5. **日志盲区**：Q3 真实链路、真实超时/取消后的远端状态核对，未做人工桌面验收；
   已在 LOGGING_COVERAGE 条目中登记为边界，不得宣称全链路完成。
6. 取消语义：CLI 无删除任务接口，本地停止只是「停止等待 + 核对事实」，远端任务可能
   继续计费完成；UI 文案已按此表述。

## 后续建议

按优先级：补 Q3 真实冒烟 → `PROVIDER_SPECS` 加 `vidu` 模板（label 建议
「Vidu（本机 CLI）」、baseURL `https://service.vidu.cn`、suggestions `['3.4','3.2']`）
→ provider-check 零计费探测 → 视频节点真实路径人工验收并入节点验收清单。

## 提交

本批内容（9 个修改文件 + 5 个新增文件 + 本文档 + LOGGING_COVERAGE 条目 + 两条测试
断言修正）已提交进入 `main` 并推送；提交列表以
`git log --oneline -- src/shared/vidu-cli.ts` 为准。
