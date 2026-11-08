# 付费生成族"接线级"验收（image-gen / image-edit / video / speech / tts / voice-design）

日期：2026-11-08。负责人：f7-nodelib（复用席位）。
交付物：`test/paid-family-wiring.test.ts`（15 项）＋本文；另修复 2 处真实接线缺陷（见第五节）。

---

## 一、仅接线级验证，真实供应商未测

**本文件证明的是"外部/节点配置 → 共享执行器同一套解析 → `ctx.gateway.<method>()` 入参逐字段正确"这一段。**
它**不是供应商验收**：没有任何真实模型请求、没有真实受理/进度/取消确认/产物落盘验证，也没有付费。

用户约束（本轮）：语音克隆、音色设计、视频生成**只做代码层接通**，真实测试由用户自测；图片生成可测但保持最小。
因此本包：

- 用"间谍 gateway"在调用边界拦截并记录入参、返回可预期的假结果（假媒体资产 / 假 video taskId & 终态），
  绝不真发请求；
- 用 `fetch` spy 在 `beforeEach` 替换为抛错桩、在 `afterEach` 断言 **0 次调用**——任何"顺手"发出的网络请求都会让用例失败；
- 间谍对象只声明被用到的方法：未声明的方法在执行器看来就是"本机没有该能力"（与生产最小宿主同形），
  声明了却没有处理器的调用直接失败（"多调一次付费方法"不会静默通过）。

## 二、覆盖与断言清单（六类 / 15 项）

| 族 | 用例 | 关键接线断言 |
| --- | --- | --- |
| **image-gen** | 归一化与逐张提交 | 旧像素尺寸 `1536x1024` 迁移成等比画幅 `size:'16:9'`；TOAPIS 不额外发 `aspectRatio`；`resolution:'2k'`、`background:'transparent'` 原样下发；`count:2` → **两次独立请求**（不折叠成供应商私有 n 参数）；参考图按连线顺序去重 `['r2','r1']`；提示词顺序 = prompt.bundle(prompt+style) → 上游文本 → 节点正文（`$$$` 分隔符）；每次请求的 `diagnostics.itemId` 带 `#1/#2` 与 `batchId`；逐张 `updateResult`/`emitArtifact(out-image)` |
| | 上限/拦截 | `count:0` 夹紧为 1；无提示词 → `skipped:无提示词`；取消 → `skipped:已取消`；参考图 7>6 → `failed`（模型上限文案），**0 次调用** |
| | 分辨率不跨供应商外溢（缺陷修复复现） | 即梦专属 `1.5k` 在 TOAPIS 模型下**不发送**（且留安全诊断 trace）；支持的 `2k` 仍发送 |
| **image-edit** | 标注/遮罩/提示词 | `sourceMediaId` 来自 `in-image`；`size:'auto'`；旧标注颜色 `orange`→`blue`（语义迁移）、默认 `strokeWidth:3`；提示词含"第 1 张是原图，第 2 张是带标注的原图"与编号标注行；TOAPIS 异步通道 **不发 mask**（提示词不承诺"只改遮罩区域"，配置仍保留 `mask.enabled`）；产物为 `out-image` |
| | 拦截 | 缺原图 → `skipped`；取消 → `skipped:已取消`；矩形标注只有 1 点 → `skipped:矩形标注不完整`；均 0 次调用 |
| **video** | 参考模式全链路 | `mode:'reference'`；`referenceImageMediaIds` 按连接顺序 `['img-1','img-2']`、参考视频/参考音频各自数组；**非法时长 99 → 收敛最短档 4s**（按秒计费默认不加长）、`ratio:'9:16'`、`resolution:'2K'` 原样；`@图片1` → `第1张参考图`；`diagnostics.traceId` 透传；`videoTask` 轮询携带 `(taskId, traceId)`；终态媒体落 `updateResult` + `out-video` 资产 |
| | 首帧模式语义 | 有首帧时 minimax **不发送 ratio**（画幅跟帧走）；`firstFrameMediaId` 正确；提交失败 → `failed` 且不进入轮询 |
| | 取消补偿（R-01） | 提交已成功而取消先到 → **`videoCancel(taskId, traceId)` 补偿取消**，返回 `skipped:已取消`，不进入轮询（否则远端会继续计费） |
| **speech（minimax）** | 绑定解析 + 音色优先级 | `providerId/modelId` 来自能力解析（配置里为空）；上游音色档案 `in-voice.voice_id` **优先于**手填 `voiceId`；正文 = 上游文本 + `$$$` + 节点正文；minimax 不带 `referenceAudioIds`；`speed/volume/pitch/emotion` 与 `format:'mp3'` 原样进 config；`updateResult` 带网关确认的 `voiceId`，产物 `out-audio` |
| **speech（volc）** | 多参考顺序与上限 | 连线音频按顺序 + 节点上传音频**追加末尾** → `['conn-1','conn-2','uploaded-3']`；`voiceId`=spaker；`config.backend:'volc'`、`format:'wav'`；3 连线+1 上传=4 段 → `failed`（"最多 3 段"）且 **0 次合成调用** |
| **speech（本地 indextts）** | 本机通道逐字段 | `indexttsSynthesize` 收到 `text/referenceAudioId/pythonPath/modelDir/device/fp16/durationFactor/lang/projectId/nodeId`；**绝不调用 `speechGenerate`**（即使该通道存在）；合成返回后取消 → `skipped:已取消` |
| **tts（音色克隆）** | 参考音频优先级 + 关联 | 连线参考音频**优先于**节点配置 `refMediaId`；`runId/nodeId/traceId` 原样传递；克隆参数（`needNoiseReduction/needVolumeNormalization/aigcWatermark/textValidation/accuracy/languageBoost/promptMediaId/promptText/format`）进 config；成功回写 `out-json` 音色档案 |
| | 配置来源 + 拦截 | 无连线时用 `refMediaId`；取消 → `skipped`；供应商里没有复刻白名单模型 → `skipped`（`diagnosticPhase:'capability'`）；`hasApiKey:false` → `skipped`（"API Key 未保存"）；均 0 次调用 |
| **voice-design** | 描述合并 + 参数下发 | `prompt` = 上游文本 + `$$$` + 节点正文；`providerId` 来自解析；`previewText/aigcWatermark/voiceId` 进 config；**input 不带 `modelId`**（供应商协议只接受 prompt/preview_text/voice_id/aigc_watermark，不臆造字段）；成功回写音色档案 + `out-audio` |
| | 拦截 | 绑定到非 MiniMax 模型 → `failed:音色设计功能必须绑定 MiniMax 模型`；无描述 → `skipped:无音色描述`；取消 → `skipped:已取消`；均 0 次设计调用 |

说明：共享执行器的返回值没有"错误码"字段，稳定语义 = `status`（failed/skipped）+ 固定人读原因 + `diagnosticPhase`（运行器据此落诊断事件）。

## 三、方法学要点（为什么这能算"接线证据"）

1. **只跑真实共享执行器**（`src/shared/engine/executors/*`），不复制一份测试内实现；GUI 与 CLI/MCP 走的是同一份代码。
2. **模型解析走真实路径**：`resolveFeatureOption / resolveFeatureOptionDetailed` 与 GUI 同一实现；用例里分别覆盖"按功能绑定解析"与"按 config.modelKey 显式命中供应商目录"两种入口。
3. **参数归一化走真实能力表**：`normalizeImageGenerationConfig`、`normalizeVideoGenParams`、`parseSpeechConfig`、`parseImageEditConfig`、`parseTtsConfig`、`parseVoiceDesignConfig`；断言的是归一化**之后**真正交给网关的值。
4. **网关替身只做两件事**：记录入参 + 返回可预期假信封；没有任何计费/联网能力（`fetch` spy 兜底 0 次）。

## 四、验证证据（本机实际运行）

| 检查 | 命令 | 真实结果 |
| --- | --- | --- |
| 类型 | `npm run typecheck` | 通过（node/web/license-protocol/issuer，exit 0） |
| 本包 + 既有门禁 | `node scripts/run-vitest.cjs run test/paid-family-wiring.test.ts test/local-agent-audio-family-gating.test.ts --reporter=dot` | **24 项全通过**（本包 15 + 既有零成本门禁 9），exit 0 |
| 相关执行器回归 | `node scripts/run-vitest.cjs run test/async-executors.test.ts test/executors-shared.test.ts test/media-result-executor.test.ts --reporter=dot` | 全部通过（含既有的 video R-01/参考模式、image-gen count/布局、shared 解析用例） |
| 业务动作分母 | `node scripts/audit-business-actions.cjs` | 语义检查通过；仅因**生成物陈旧**失败：`Action inventory is stale; run audit-business-actions.cjs --write`（按 Lead 指示不跑 `--write`） |
| 定向 lint | `npx eslint test/paid-family-wiring.test.ts src/shared/engine/executors/speech.ts src/shared/engine/executors/imageGen.ts --quiet` | 0 error |
| 联网断言 | 每个用例后自动断言 `fetch` 0 次调用 | 通过（本次运行全程 0 次网络调用） |

观察（与本包无关）：`test/node-ui-decisions.test.ts` 的"v1.2 §16.28 焦距与时长只有一个真值"当前失败，它扫描的是 `src/renderer/src/canvas/DirectorStudioPanel.tsx`（本包未改动、`git status` 也显示未修改），属当前基线的既有失败，与本次改动无关。

## 五、发现并修复的真实接线缺陷（先复现，再最小修复）

### 缺陷 1：模型专属分辨率档位被跨供应商外溢（image-gen）

- **现象**：`normalizeImageGenerationConfig` 会保留"用户意图档位"，执行器旧代码只判断 `capabilities.resolutions.length > 0` 就原样下发。
  用户在即梦 5.0Pro（支持 `1.5k`）配置过 1.5k 后切到 TOAPIS（只支持 `1k/2k/4k`），请求会把 `resolution:'1.5k'` 发给 TOAPIS。
- **复现**：`paid-family-wiring.test.ts` →「模型专属分辨率档位不跨供应商外溢」。
- **根因**：能力表声明了"支持分辨率"这个布尔式事实，但没有按**具体档位**校验；供应商会以 400 拒绝或静默忽略，表现为"用户选了档位却没生效/直接失败"。
- **修复**（`src/shared/engine/executors/imageGen.ts`，最小 2 处）：
  1. 下发条件改为 `capabilities.resolutions.includes(config.resolution)`；
  2. 不支持时留一条安全诊断 trace（`phase:'capability'`，只含档位名），不静默假装按用户档位出图。
- **兼容性**：支持该档位的模型（含即梦、TOAPIS 自身的 1k/2k/4k）行为不变；只有"配置里残留其他模型专属档位"才会从"发出去被拒绝"变成"不发送 + 诊断"。

### 缺陷 2：按功能绑定解析模型时情绪参数被静默丢弃（speech）

- **现象**：`config.modelId` 为空（外部/Agent 用功能绑定 `speech.synthesize` 指定模型）时，`parseSpeechConfig` 只能拿默认模型 `speech-2.8-hd` 判断 `emotion` 是否受支持，
  而只有 2.6 系列声明了 emotional —— 于是配置里合法的 `emotion:'fluent'` 在解析阶段就被清空，即使绑定最终解析到 2.6 模型也丢失。
- **复现**：`paid-family-wiring.test.ts` →「MiniMax 后端…」用例断言 `input.config.emotion === 'fluent'`（绑定解析到 `speech-2.6-hd`）。
- **根因**：校验发生在"模型尚未解析"的阶段，用的是伪造的默认模型猜测；后续解析出真实模型后没有重新确认。
- **修复**（`src/shared/engine/executors/speech.ts`，最小 3 处）：在解析出 `option` 后，用**配置里的原始合法 emotion** + **解析到的真实模型**重新确认：
  `emotion: isSpeechEmotionSupported(option.model.id, rawEmotion) ? rawEmotion : ''`；原始值仅接受注册枚举（`SPEECH_EMOTIONS`），不合法回落解析结果。
- **兼容性**：显式选择 2.8 模型时 `emotion` 依旧按能力丢弃（主进程 `gateway/audio.ts` 也按真实模型再闸一次，不会把不支持的参数发给供应商）；2.6 系列不再丢参数。

两处修复都在公共层（共享执行器），**测试没有后门**：用例断言的是真实执行器在真实归一化后的网关入参。

## 六、验证盲区（真实供应商未测，须用户自测）

1. **真实受理与进度**：供应商是否接受上述参数组合、任务受理/进度/重试/限流行为，本包完全未覆盖（假信封）。
2. **取消的真实确认**：视频"取消请求已发出"不等于"远端已停止计费"；本包只证明执行器调用了 `videoCancel`（R-01 补偿路径），未验证远端确认。
3. **产物落盘与正式输出**：假媒体资产不经过主进程下载/落盘/索引；媒体可读性、ffprobe 元数据、结果版本选择均未验证。
4. **main 侧路径解析**：tts 的 `referenceAudioId → media 行 → 绝对路径` 解析发生在 `src/main/media/tts-transform.ts`（`getMediaAbsPath`），需要 DB 媒体行与真实文件，本包只断言执行器把 mediaId 与配置原样交给网关；该段由用户真实测试或后续主进程级夹具覆盖。
5. **供应商能力表与真实模型的一致性**：本包用固定能力档位（TOAPIS/MiniMax H3/2.6）构造断言；真实模型 id 与能力映射若变更，需要同步能力表与用例。
6. **图片生成的真实出图**：按"最小"约束，本包只验证入参（含参考图顺序/分辨率/画幅归一化），不出图、不评质量。
7. **真实 CLI/MCP 客户端**：本包是执行器级服务测试；CLI/MCP 目录派生与传输由既有 `local-agent-parity` 与本包之外的接入测试覆盖，但未做"真实 MCP 客户端跑六类"的端到端。
8. **计费**：本包**零付费调用**；真实成本、并发配额、供应商账单口径不在验证范围。

## 七、未触碰的范围

- 未改 main 网关/供应商适配/凭据/许可（`src/main/gateway/*`、`src/main/media/*`、`src/main/security/*` 均未改）。
- 未跑 `npm run build`；未跑 `--write` 聚合产物（契约快照/动作清单由 Lead 统一刷新）；未 git 提交。
- 未新增/修改任何外部操作 Registry 条目（本包是执行器级验收，不增加能力分母）。

## 八、后续建议

1. 用户真实自测清单（建议按族各 1 次最小付费）：image-gen（1 张，带 1 参考图）、image-edit（1 张，含标注）、video（最短时长 + 参考模式）、speech（minimax 与 volc 各 1 条）、tts（clone 后接 speech 使用音色）、voice-design（设计后接 speech）——每项记录受理耗时、产物可读与成本。
2. 真实桌面/真实客户端验收后，把"真实受理/取消确认/落盘"证据补进本台账第六节，并把本节标题改为"接线级 + 供应商实测"（当前明确不是）。
3. 若后续要覆盖主进程路径解析，建议用主进程级夹具（临时数据目录 + 媒体行 + 假供应商 HTTP 端点）而不是再改造执行器。
