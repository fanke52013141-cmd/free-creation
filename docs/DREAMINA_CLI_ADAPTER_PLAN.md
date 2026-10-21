# 即梦（Dreamina）CLI 生成能力接入方案 v1.1

> 状态：**方案待评审**。需求来源：用户 2026-10-21 确认范围（图片 2 项 + 视频 4 项）。
> 关联规范：[NODE_CONTRACT_SPEC.md](../NODE_CONTRACT_SPEC.md)、[LOGGING_SPEC.md](../LOGGING_SPEC.md)、
> [IMAGE_PROVIDER_GATEWAY_PLAN.md](./IMAGE_PROVIDER_GATEWAY_PLAN.md)（同类先例，本方案沿用其结构）。
>
> **v1.1 变更**：移除"多图故事线"（`multiframe2video`）。范围收缩后，本方案**不新增任何节点**，
> 不改任何端口，不提升任何 `contractVersion`，全部落在既有 `image-gen`(v3) / `video`(v7) 与网关层。

---

## 1. 需求与范围

### 1.1 本期要做（6 项）

| # | 能力 | 即梦命令 | 落到画布 | 契约变化 |
| - | ---- | -------- | -------- | -------- |
| 图-1 | 文生图 | `text2image` | `image-gen` v3 | 无 |
| 图-2 | 图生图 | `image2image` | `image-gen` v3 | 无 |
| 视-1 | 提示词生视频 | `text2video` | `video` v7 `mode=text` | 无 |
| 视-2 | 首帧视频 | `image2video` | `video` v7 `mode=first-frame` | 无 |
| 视-3 | 首尾帧视频 | `frames2video` | `video` v7 `mode=first-last-frame` | 无 |
| 视-4 | 参考生视频 | `multimodal2video` | `video` v7 `mode=reference` | 无 |

### 1.2 本期明确不做

| 不做项 | 原因 |
| ------ | ---- |
| 多图故事线 `multiframe2video` | 用户确认不需要（v1.0 中的独立节点 `video-story` 一并移除） |
| 图片超分 `image_upscale` | 用户明确放弃；职责是后处理而非生成 |
| `generate_num > 1`（一次多图） | `out-image` 是单值端口，`projectImageGenOutputs` 只取最后一张；多图需独立集合节点 |
| 即梦 `session` / `list_task` / `logout` | 非生成能力；内部固定 `session=0`，账号操作只保留登录/重新登录 |
| 打包 `dreamina.exe` | 31 MB 闭源 beta 二进制，自更新、杀软误报、许可证不可控；沿用 FFmpeg"探测本机安装"模式 |

### 1.3 范围收缩带来的结构性好处

| 项 | v1.0（含故事线） | v1.1（本期） |
| -- | ---------------- | ------------ |
| 新增节点 | 1（`video-story`） | **0** |
| 端口/`contractVersion` 变化 | 新节点 v1 | **无** |
| 契约快照、节点合规、图标色板登记 | 需要 | **不需要** |
| 网关新增分支 | 图片驱动 + 视频适配器 + story 分支 | 图片驱动 + 视频适配器 |
| 需要步骤 0 实测的未知项 | 6 项 | **4 项** |

---

## 2. 现状梳理（代码事实）

### 2.1 即梦 CLI 实际能力（2026-10-21 逐条实测 `-h`）

**图片**

| 命令 | 输入 | 模型 | 分辨率 | 画幅 |
| ---- | ---- | ---- | ------ | ---- |
| `text2image` | prompt | 3.0 / 3.1 / 4.0 / 4.1 / 4.5 / 4.6 / 4.7 / 5.0 / 5.0Pro | 3.x→1k/2k；4.x、5.0→2k/4k；5.0Pro→**1.5k**/2k/4k | 8 种 |
| `image2image` | 1–10 张图 + prompt | 4.0~5.0Pro（**无 3.0/3.1**） | 同上 | 同上 |

8 种画幅：`21:9 16:9 3:2 4:3 1:1 3:4 2:3 9:16`（**无 `auto`**）。
`--resolution_type` 与显式 `--ratio` 都是严格校验：不支持的值直接拒绝，不会静默调整。

**视频**（全部 `--video_resolution` 必填、`--ratio` 可选）

| 命令 | 输入 | 模型 | 分辨率 | 时长 |
| ---- | ---- | ---- | ------ | ---- |
| `text2video` | prompt | seedance2.0 / 2.0fast / 2.0_vip / 2.0fast_vip / 2.0mini / 2.5 | 2.5→480p/720p/1080p；2.0_vip→720p/1080p/4k；其余→720p | 4–15s（2.5：4–30s） |
| `image2video` | 1 首帧 | 上述 + 1.0fast / 1.5pro | 同上 | 1.0fast 5–10s；1.5pro 5–12s |
| `frames2video` | 首帧+尾帧 | 上述（**无 1.0fast**） | 同上 | 同上 |
| `multimodal2video` | 图/视频/音频 | 2.0 家族 + 2.5（**无 1.x**） | 同上 | 同上 |

三条硬约束（必须进能力表，不能只靠 UI 隐藏）：

1. `seedance2.5` 在 `image2video` / `frames2video` 下**拒绝 `--ratio`**（跟首帧走）。
2. `multimodal2video` 在 2.0 家族**至少需要 1 张图或 1 段视频**（禁止纯音频）；2.5 允许纯音频。
3. 部分模型首次使用返回 `AigcComplianceConfirmationRequired`，需先去即梦 Web 用该模型生成一次。

### 2.2 仓库现状（接入点）

| 位置 | 现状 | 对本方案的意义 |
| ---- | ---- | -------------- |
| `src/shared/provider-driver.ts`:6 | `ProviderDriver = 'openai-compatible' \| 'video' \| 'native-speech'`，注释明确它是"网关走哪条链路"的唯一真值 | 新增 `'local-cli'` |
| `src/main/gateway/factory.ts`:20 `requireProvider()` | 强制 baseURL + apiKey | CLI 无 Key，必须旁路 |
| `src/main/gateway/providers.repo.ts`:311 `saveProvider()` | 新建供应商必须提供 API Key | 同上需按 specId 放宽；`providers.api_key_ref` 本就可空 |
| `src/main/ipc/gateway.ipc.ts`:133 | `driverForSpec === 'openai-compatible'` 才走 `testProvider`，其余走 `probeProvider` | 为 `local-cli` 增加第三种探测（二进制+登录态） |
| `src/shared/image-capabilities.ts`:5 | `ImageResolution = '1k'\|'2k'\|'4k'` | 需补 `1.5k`（5.0Pro） |
| 同上 `:268` `normalizeImageGenerationConfig()` | **不填分辨率默认值**（只有视频会填） | 真实缺口：CLI 该参数必填，必须补 `defaultResolution` |
| `src/shared/video-capabilities.ts`:61-70 | 已有 `cheapestResolution()` + `RESOLUTION_COST_ORDER` | 成本最优哲学已内置，直接复用 |
| 同上 `:221` `normalizeVideoGenParams()` | 默认时长取 `defaultDuration`，注释明确"不依赖数组顺序" | 直接复用 |
| 同上 `:209` `videoRatioIsDerivedByFrames()` | 已处理 minimax 与 seedance2.5 | 增加即梦同款规则 |
| `src/main/gateway/image.ts`:82 | `switch (capabilities.driver)` 三分支 | 加第四分支 |
| `src/main/gateway/video.ts`:757 `adaptersFor()` | 按 specId 选 `{submit, poll}`；`:8-10` 注释说明已有"提交→tasks 表→轮询→下载"骨架与重启恢复 | 加即梦适配器 |
| `src/shared/engine/executors/imageGen.ts` / `video.ts` | **完全 provider 无关**，只调 `ctx.gateway.*` | **两张执行器零改动** |
| `src/renderer/src/nodes/specs/index.tsx`:384,445 | `image-gen` 端口 `in-images(any)/in-prompt/in-text → out-image`；`video` 端口 `in-images/in-reference-video/in-reference-audio/in-prompt/in-text → out-video` | 6 项能力全覆盖，端口不动 |
| `src/shared/types/index.ts`:449 | `VideoGenParams { ratio, duration, resolution, generateAudio, seed, watermark }` | `ratio/duration/resolution` 正好对应 CLI 三个 flag |
| `src/main/store/db-migrations.ts`:26 | `tasks` 表含 `input/output/attempts/updated_at`，无 kind 约束 | 生图与视频共用同一任务表 |

---

## 3. 契约判定（NODE_CONTRACT_SPEC §1.1）

### 3.1 图片：扩展既有节点配置

| 判定项 | 结论 |
| ------ | ---- |
| 是否产生新数据 | 是（图片资产） |
| 输入/输出/数量/错误语义是否与 `image-gen` 一致 | **完全一致** |
| 是否改变输出类型、数量或核心语义 | 否 |
| 结论 | 只增加"供应商 + driver"，`contractVersion` 保持 **3**，端口不动 |

`text2image` 与 `image2image` 的区分**不在节点层、不加配置项**：执行器本来就知道"有没有连参考图"，网关按 `referenceMediaIds.length > 0` 选择命令即可。这与"不得根据节点标题/类型猜输入"不冲突——它用的是已声明端口 `in-images` 的真实连线。

### 3.2 视频四模式：扩展既有节点配置

| 即梦命令 | `video` v7 `mode` | 执行器取值位置（`executors/video.ts`） |
| -------- | ----------------- | ------------------------------------ |
| `text2video` | `'text'` | 无图片输入，`images.length === 0` |
| `image2video` | `'first-frame'` | `images[0]` → `firstFrameMediaId`（:56） |
| `frames2video` | `'first-last-frame'` | `images[0]/[1]` → 首/尾帧（:56-57） |
| `multimodal2video` | `'reference'` | 全部 `images` + `in-reference-video` + `in-reference-audio`（:58,44-45） |

`VideoGenParams.ratio / duration / resolution` 与 `--ratio / --duration / --video_resolution` 一一对应。
`contractVersion` 保持 **7**，端口不动。

### 3.3 结论

| 项 | 结果 |
| -- | ---- |
| 新增节点 | **0** |
| 端口增删改 | **0** |
| `contractVersion` 提升 | **0** |
| 契约快照 / 节点合规 / 图标色板登记 | **不涉及** |
| 改动性质 | 与 `IMAGE_PROVIDER_GATEWAY_PLAN` 接 ToAPIS 完全同类：新增供应商通道 + 能力表 + driver |

---

## 4. 总体设计

### 4.1 通道模型：把"本机 CLI"做成一等供应商

即梦不是 HTTP 供应商：没有 BaseURL、没有 API Key、凭据是本机 OAuth 登录态、调用是 spawn 子进程。但下游（节点选模型、功能绑定、执行器、日志）全部按 `ProviderConfig` 组织，因此**保留供应商实例作为载体，只增加通道类型**。

```ts
// src/shared/provider-driver.ts
export type ProviderDriver = 'openai-compatible' | 'video' | 'native-speech' | 'local-cli'

export function driverForSpec(specId: ProviderSpecId): ProviderDriver {
  if (specId === 'dreamina') return 'local-cli'
  if (specId === 'minimax' || specId === 'seedance') return 'video'
  if (specId === 'volc-speech') return 'native-speech'
  return 'openai-compatible'
}
```

**`PROVIDER_SPECS` 新增模板**

| specId | label | baseURL | modality | suggestions |
| ------ | ----- | ------- | -------- | ----------- |
| `dreamina` | 即梦（本机 CLI） | `''`（面板不显示该输入） | `image` | `5.0`、`5.0Pro`、`4.7`、`4.5`、`seedance2.0fast`、`seedance2.0_vip`、`seedance2.5` |

模型列表**静态预置**（CLI 没有 `/models` 端点），来源就是能力表的键集合；用户可增删但不会被网络探测覆盖。

**模态推断**（`guessModelModality`）需为即梦单独判定，因为图片模型名 `5.0` 里没有 `image` 字样：

```ts
if (specId === 'dreamina') return /^seedance/i.test(id) ? 'video' : 'image'
```

**凭据判定旁路**（两处必改，否则实例建不出来）

| 位置 | 改动 |
| ---- | ---- |
| `providers.repo.ts saveProvider()` | `driverForSpec(specId) === 'local-cli'` 时跳过"必须提供 API Key"；`base_url` 存空串（列 `NOT NULL`，空串合法） |
| `factory.ts` | 新增 `requireCliProvider(id)`：校验"二进制可执行 + 已登录"，**不校验 baseURL/apiKey**；`generateImageToAsset` 等入口按 driver 分派到它 |

**单实例约束**：`specId='dreamina'` 只允许一个实例（同一台机器只有一个 CLI、一个登录态）；保存第二个时复用已有实例并提示。

**二进制探测顺序**（沿用 FFmpeg 先例 `CANVAS_STUDIO_FFMPEG_PATH`）

```text
1. process.env.CANVAS_STUDIO_DREAMINA_PATH
2. PATH 中的 dreamina / dreamina.exe
3. 未找到 → 可操作错误：安装命令 + 环境变量说明
```

**连通性测试**：`gateway.ipc.ts:133` 增加第三分支，`local-cli` 的"测试"= 探测二进制 + `dreamina version` + `dreamina user_credit`（顺带取余额与登录态），不发起任何生成，不消耗额度。

### 4.2 图片能力表（`shared/image-capabilities.ts`）

```ts
export type ImageResolution = '1k' | '1.5k' | '2k' | '4k'   // 新增 1.5k

export type ImageGatewayDriver =
  | 'openai-images' | 'toapis-task' | 'openrouter-chat' | 'dreamina-cli'

export type ImageReferenceMode = 'binary' | 'upload-url' | 'chat-inline' | 'local-path'

/** 最便宜的一档；成本顺序 1k < 1.5k < 2k < 4k。 */
export function cheapestImageResolution(resolutions: ImageResolution[]): ImageResolution | undefined
```

`ImageCapabilities` 增加 `defaultResolution?: ImageResolution`，并让 `normalizeImageGenerationConfig()` 在
`resolutions` 非空而用户未选/选了非法值时收敛到 `defaultResolution`（**这是当前真实缺口**：视频有该逻辑，图片没有，而 CLI 的 `--resolution_type` 必填）。

按 `modelId` 分表（本次**必须启用 modelId 维度**，因为分辨率随模型变）：

| model_version | resolutions | 默认（最便宜） | maxReferenceImages | 说明 |
| ------------- | ----------- | -------------- | ------------------ | ---- |
| 3.0 / 3.1 | `['1k','2k']` | `1k` | **0** | `image2image` 不支持，连参考图必须明确拒绝 |
| 4.0 / 4.1 / 4.5 / 4.6 / 4.7 / 5.0 | `['2k','4k']` | `2k` | 10 | **最低就是 2k**，无法更省 |
| 5.0Pro | `['1.5k','2k','4k']` | `1.5k` | 10 | |

公共字段：`ratios` 为上述 8 种、`sizeOptions` 的 `value` 直接用比例串、
`supportsSeed:false`、`supportsQuality:false`、`supportsTransparentBackground:false`、
`forwardsAspectRatio:true`（CLI 确实接受独立 `--ratio`，执行器据此把 `aspectRatio` 传给网关）、
`driver:'dreamina-cli'`、`referenceMode:'local-path'`。

> `maxPromptChars` 不设：CLI 未文档化上限，按规范"未文档化不臆测拦截"。

### 4.3 视频能力表（`shared/video-capabilities.ts`）

新增即梦 profile，复用既有 `cheapestResolution()` 与 `defaultDuration = min(durations)`：

| 模型 | resolutions | durations | modes | 图/视频/音频上限 |
| ---- | ----------- | --------- | ----- | ---------------- |
| seedance2.5 | 480p/720p/1080p | 4–30 | 全 4 种 | 30 / 10 / 10 |
| seedance2.0_vip | 720p/1080p/4k | 4–15 | 全 4 种 | 9 / 3 / 3 |
| seedance2.0 / 2.0fast / 2.0fast_vip / 2.0mini | 720p | 4–15 | 全 4 种 | 9 / 3 / 3 |
| seedance1.5pro | 720p | 5–12 | text / first-frame / first-last-frame | 0 |
| seedance1.0fast | 720p | 5–10 | 仅 first-frame | 0 |

- `ratios`: 6 种（**无 `adaptive`**）。
- `supportsGeneratedAudio:false`、`supportsSeed:false`、`supportsWatermark:false`（CLI 无对应 flag，UI 同步隐藏）。
- **新增一个能力字段**（只影响即梦，不动既有供应商）：

```ts
/** reference 模式是否必须有图像/视频锚点（即梦 2.0 家族禁止纯音频，2.5 允许）。 */
requiresVisualReference?: boolean
```

- `videoRatioIsDerivedByFrames()` 增加即梦分支：模型含 `seedance-2-5` 且存在首/尾帧时返回 `true`
  （对应 CLI"2.5 拒绝 `--ratio`"）。`resolveVideoMode`/`normalizeVideoGenParams` 会自动隐藏并停发画幅。
- **默认模型预选 `seedance2.0fast`**（CLI 在 `image2video`/`frames2video` 默认 `seedance2.0_vip`，那是更贵的一档；我们不继承它的默认值）。

### 4.4 网关驱动

#### 4.4.1 图片：`src/main/gateway/image.ts` 第四个 case

```ts
case 'dreamina-cli':
  asset = await generateWithDreaminaCli(provider, input, capabilities, diagnostics)
```

```text
referenceMediaIds 非空 → dreamina image2image --images <本地路径…> --prompt …
referenceMediaIds 为空 → dreamina text2image --prompt …
公共参数：--model_version --ratio --resolution_type --session=0 --poll=0
→ stdout JSON { submit_id, gen_status }
→ success  → 取 result_json.images[0].image_url
   querying → 循环 `query_result --submit_id`（1–3s，超时可配）
→ 立即下载 URL → saveBufferAsset 落盘为 MediaAsset
```

要点：

- **必须立即下载**：CDN URL 带 `x-expires` 签名，绝不能把 URL 存进 `nodeResult`。
- **本地路径直接传**：媒体库 `MediaAsset.path` 本身就是本地绝对路径，无需 base64 或临时文件（这是 CLI 与 HTTP 供应商最大的实现差异）。
- 错误映射：`AigcComplianceConfirmationRequired` → 可操作错误；未登录 → `DREAMINA_AUTH_REQUIRED`；二进制缺失 → `DREAMINA_CLI_MISSING`。
- 提交即扣额度，**提交阶段超时不重试**（见 §7）。

#### 4.4.2 视频：`video.ts adaptersFor()` 增加即梦适配器

```ts
function dreaminaAdapter(): { submit; poll }   // submit 按 mode 组装子命令
```

| mode | 命令与参数 |
| ---- | ---------- |
| `text` | `text2video --prompt --model_version --ratio --duration --video_resolution` |
| `first-frame` | `image2video --image <首帧路径> --prompt …`（2.5 不传 `--ratio`） |
| `first-last-frame` | `frames2video --first <首帧> --last <尾帧> --prompt …`（2.5 不传 `--ratio`） |
| `reference` | `multimodal2video --image … --video … --audio … --prompt …` |

复用既有 `tasks` 表：`kind='video'`、`input` 存 `{ command, submit_id, mode, params 摘要 }`、
`status` 走既有状态机；`poll` 调 `query_result --submit_id` 并归一化到 `UpstreamState`。
**这样重启恢复、取消补偿、`waitForVideo` 全部零改动继承。**

取消：`child.kill()`；已提交的远端任务按现有 R-01 语义补偿（不能留下"节点已 skipped、远端仍在计费"）。

### 4.5 节点与 UI

#### 4.5.1 `image-gen`（contractVersion 保持 3，端口不动）

- 供应商下拉自然出现"即梦（本机 CLI）"实例——由 `driverForSpec` 驱动，**不写死 specId 分支**。
- 分辨率下拉由 `capabilities.resolutions` 驱动，**默认选中 `cheapestImageResolution`**，选项后缀标注档位（如 `2k（最低）`）。
- 参考图上限由能力表决定：3.x 模型 `maxReferenceImages=0` 时，连了参考图由执行器给出可读错误（执行器已有该检查，:61-65）。
- 无 Key 实例的 `NoModelHint` 文案改为"去设置检测 CLI / 登录"。

#### 4.5.2 `video`（contractVersion 保持 7，端口不动）

- 清晰度、时长、画幅控件**已存在且完全由能力表驱动**，本期只新增即梦 profile。
- 默认值全部取最便宜档（`cheapestResolution` / `min(durations)`，均已实现）。
- 2.5 + 首/尾帧时画幅控件隐藏（`videoRatioIsDerivedByFrames` 表达）。
- 模型下拉默认预选 `seedance2.0fast`。
- `generateAudio` / `seed` / `watermark` 对即梦自动隐藏（能力表 false）。

### 4.6 分辨率与成本控制

| 手段 | 实现 |
| ---- | ---- |
| 图片分辨率可选 | 能力表 `resolutions` 驱动下拉，默认最低档（`cheapestImageResolution`） |
| 视频清晰度可选 | 既有 `resolutions` + `cheapestResolution()`，默认最低档 |
| 时长可控 | 既有 `defaultDuration = min(durations)`，不依赖数组顺序 |
| 余额可见 | 设置页与节点复用 `user_credit`（只读，**不估算单价**——CLI 未公开单价表，不伪造价格） |
| 提交前告知 | 首次连接即梦实例时提示"每次生成消耗即梦会员额度"；节点上显示当前档位 |
| 默认模型 | 预选最便宜的 `seedance2.0fast`，而非 CLI 的 `seedance2.0_vip` |

> 原则：**默认永远是最便宜的组合**，用户主动加档位才增加成本；界面只出现具体档位，不出现"高清/质量"这类模糊文案。
>
> 一个必须如实告知用户的限制：4.x/5.0 图片模型的**最低档就是 2k**，`seedance2.0` 系列**只有 720p**。
> 想更省只能换模型（3.x 图片 / 2.0fast 视频），不能靠调参数。

---

## 5. 契约同步（AGENTS.md 强制）

| 项 | 动作 |
| -- | ---- |
| `image-gen` / `video` | 端口与 `contractVersion` **不变**（3 / 7），仅新增供应商与能力表 |
| `src/capabilities/definitions.ts` | **不改**：`image.generate` / `video.generate` 的 `configSchema` 已含 provider/model 选择，不新增字段 |
| `generated/agent-contracts.json` | **不需要**重新生成（无能力面变化） |
| 契约快照 / `node-compliance` | **不涉及**（无新节点、无端口变化） |
| `docs/NODE_COLOR_SPEC.md` | **不涉及**（无新节点） |

> 本方案的最大优势就在这一节：**契约层零改动**，评审时不需要重新走节点合规。

---

## 6. 日志与本地数据安全

### 6.1 日志（LOGGING_SPEC 强制）

复用既有 `ctx.trace` 与 `emitGatewayEvent`，**不重复记录公共终态**，只补即梦特有计划：

| 阶段 | 事件 | 脱敏要求 |
| ---- | ---- | -------- |
| 通道探测 | `cli.probe`（路径命中 / 版本 / 未找到） | 只记路径与版本，不记登录态内容 |
| 登录态 | `cli.auth.checked`（已登录 / 需登录 / 过期） | **不记 device_code、user_code、token** |
| 提交 | 既有 `model.request.started` + `cli.task.submitted`（submit_id） | submit_id 可记；提示词不记 |
| 轮询 | `cli.task.poll`（状态迁移、次数、耗时） | 不记 CDN 签名 URL |
| 落盘 | `cli.task.downloaded`（大小、宽高/时长、耗时） | 只记元数据 |
| 失败 | 复用 `model.request.failed`，附 `stage`（probe/auth/submit/poll/download） | 供应商原始错误截断 180 字符 |

必须更新 `docs/LOGGING_COVERAGE.md`，并证明"日志写入失败不改变业务结果"。

### 6.2 数据安全

- CLI 路径与登录态**不进项目文件**；项目导入导出仍不含供应商表，安全边界不变。
- 即梦会把参考图上传到其服务端（CLI 内部完成），在节点说明中提示一句。
- 不从 `~/.dreamina_cli` 读取或复制任何 token 到应用数据库。

---

## 7. 重试与并发（W1 特例，必须显式覆盖）

现有 W1"只重试提交阶段、提交成功后轮询失败不重试"方向正确，但即梦要更严：

| 场景 | 策略 | 理由 |
| ---- | ---- | ---- |
| 提交阶段超时 / 网络错误 | **不重试**（`maxRetries` 强制 0） | CLI 可能在超时前已提交成功并扣额度；HTTP 供应商尚有幂等键，CLI 没有，重试必然双重扣费 |
| 提交阶段明确的本地错误（找不到二进制 / 未登录 / 参数非法） | 不重试 | 重试无意义 |
| 提交成功后轮询失败 | 不重试，保留 submit_id 供 `query_result` 复查 | 与既有视频语义一致 |
| 并发 | main 进程内按 CLI **全局串行队列** | 单机单 CLI 单登录态；画布多选运行、循环 `concurrency>1` 必须排队，排队期间响应取消 |

---

## 8. 实施步骤

依赖关系：1 → 2/3 可并行；4 为收尾。

| 步骤 | 内容 | 产出 |
| ---- | ---- | ---- |
| **0** | 实测验证（不改代码，见 §12） | §12 结论表补全 |
| 1 | **通道底座**：`ProviderDriver` + `local-cli`、`dreamina` 模板、`requireCliProvider`、探测/登录/余额 IPC、设置面板通道卡片、`gateway.ipc` 第三分支 | 设置面板可新建"即梦（本机）"实例，显示版本 / 登录态 / 余额，**不消耗额度** |
| 2 | **图片**：`ImageResolution` 加 `1.5k`、`defaultResolution` + `cheapestImageResolution`、按 modelId 分表、`dreamina-cli` 驱动、UI 分辨率默认最低 | 文生图 / 图生图 可用 |
| 3 | **视频四模式**：即梦 profile、`ratioIsDerivedByFrames`、`requiresVisualReference`、`adaptersFor` 适配器、tasks 表复用、默认模型预选 | text / first-frame / first-last-frame / reference 可用 |
| 4 | **收尾**：日志覆盖清单、`docs/LOGGING_COVERAGE.md`、`npm run verify` 全量门禁 | 门禁绿 + 验收记录 |

---

## 9. 测试计划

**新增单测**

- `test/dreamina-cli.test.ts`（mock `spawn`）：
  - 参数组装：文/图生图分支（有/无参考图）、4 个 mode、2.5 不传 `--ratio`、3.x 传参考图被拒；
  - `querying → success` 轮询、`fail` 与 `AigcComplianceConfirmationRequired` 映射；
  - 下载落盘、取消时子进程终止、`--resolution_type` 与 `--ratio` 的透传值。
- `test/dreamina-probe.test.ts`：`CANVAS_STUDIO_DREAMINA_PATH` 优先、PATH 回退、未找到文案、未登录/过期/版本不符的报错码、`user_credit` 解析。

**扩展既有单测**

- `test/image-capabilities.test.ts`：按 modelId 分表、`1.5k` 解析、**默认取最便宜**、3.x `maxReferenceImages=0`。
- `test/video-capabilities.test.ts`：即梦 profile 的 resolutions/durations/modes 断言；
  `cheapestResolution` 对 480p/720p/4k 排序；`requiresVisualReference`；`ratioIsDerivedByFrames`。
- `test/executors-shared.test.ts`：确认两张执行器**无需改动**即可跑通即梦（回归证明 provider 无关性）。

**全量门禁**：`npm run verify`（lint + typecheck + test + build）。

---

## 10. 手工验收清单

**通道**

- [ ] 设置面板新建"即梦（本机 CLI）"实例：无需 BaseURL/Key，显示版本、登录状态、余额。
- [ ] 未安装 CLI 时给出可操作错误（含安装命令），不白屏不崩溃。
- [ ] 未登录时提示"请先登录"，可一键触发登录并回填状态；`device_code` 不出现在日志。
- [ ] 保存第二个即梦实例时复用已有实例并提示单实例约束。

**图片**

- [ ] 文生图：8 种画幅各出一张，落盘尺寸符合 `resolution_type`。
- [ ] 图生图：连接 1 张 / 10 张参考图成功；接 11 张给出可读错误。
- [ ] 3.0 模型连接参考图被明确拒绝（不静默忽略）。
- [ ] 分辨率下拉每档各生成一次，确认确实影响出图尺寸；**默认停在最低档**。
- [ ] 5.0Pro 的 `1.5k` 档可用且默认选中。

**视频**

- [ ] 4 模式各出 1 条：文本 / 首帧 / 首尾帧 / 参考（图+视频+音频）。
- [ ] `seedance2.5` 首帧与首尾帧时画幅控件隐藏，且未发送 `--ratio`。
- [ ] `seedance2.0` 家族纯音频参考被拒绝；`seedance2.5` 纯音频通过。
- [ ] `seedance2.0` 系列分辨率下拉只有 720p；2.0_vip 有 720p/1080p/4k。
- [ ] 时长默认值 = 该模型最短时长（4s 起），不是 5s 或 15s。
- [ ] 默认模型停在 `seedance2.0fast`。

**健壮性**

- [ ] 取消运行后子进程被终止，tasks 表记录 cancelled，不产生半截资产。
- [ ] 应用重启后未完成的视频任务能恢复轮询（复用既有恢复）。
- [ ] 额度不足 / 合规确认缺失时错误文案可操作。
- [ ] 并发运行 3 个即梦节点：按队列串行，界面有排队中状态。
- [ ] 项目导出再导入后节点配置完整、无 Key/路径泄漏。

---

## 11. 风险与待验证

| 项 | 风险 | 处置 |
| -- | ---- | ---- |
| CLI 为 beta，stdout JSON 无版本契约 | 解析随时可能失效 | 严格解析 + 明确失败；pin `version.json`，版本不符时提示而非静默降级 |
| 会员额度单价不透明 | 无法预估单次成本 | 只显示余额与实际档位，不伪造金额；首次使用提示扣费 |
| 重复扣费 | 提交超时后重试 = 双倍扣费 | §7：提交阶段禁止重试 |
| 单机并发 | 多节点并行互相干扰登录态/队列 | main 进程全局串行队列 |
| 登录态过期 | 运行中途失败 | `DREAMINA_AUTH_REQUIRED` + 一键重登，不自动重试 |
| `AigcComplianceConfirmationRequired` | 部分模型首次使用被拦 | 映射为"请先去即梦 Web 用该模型生成一次"的明确指引 |
| 闭源二进制分发 | 合规与更新不可控 | 不打包，运行时探测（同 FFmpeg） |
| 与既有 Seedance API 通道重叠 | 两套实现、双份维护 | 模型清单共用 `video-capabilities.ts`，仅 driver 不同；文档标注差异（会员额度计费 vs API 计费） |
| 图片分辨率有下限 | 4.x/5.0 最低 2k，省不下来 | 如实告知：想更省只能换 3.x 模型，不靠调参 |

---

## 12. 决策记录（2026-10-21 用户确认）

| # | 决策点 | 结论 |
| - | ------ | ---- |
| 1 | 超分 `image_upscale` | **不做** |
| 2 | 图片能力 | 仅文生图 + 图生图 |
| 3 | 视频能力 | 文本 / 首帧 / 首尾帧 / 参考（**4 项**） |
| 4 | 多图故事线 `multiframe2video` | **不做**（v1.0 的独立节点方案作废） |
| 5 | 过渡提示词 | 不涉及（随故事线一并移除） |
| 6 | 分辨率 | **必须可选**，默认最低档控成本 |
| 7 | 一次多图（`generate_num>1`） | 不做，`count` 固定 1 |
| 8 | 通道形态 | 供应商实例 + `local-cli` driver；不打包二进制 |
| 9 | 新增节点数 | **0** |

**步骤 0 实测定论（待填）**

| 编号 | 待验证项 | 结论 | 影响 |
| ---- | -------- | ---- | ---- |
| 0-A | `image2image` 传 10 张与 11 张的实际表现 | 待测 | 决定 `maxReferenceImages` 是否设 10 |
| 0-B | 各模型 `--resolution_type` 越界时的错误文案 | 待测 | 决定错误映射是否需额外兜底 |
| 0-C | 两次并发提交是否互相干扰 | 待测 | 决定队列是全局还是按节点 |
| 0-D | 登录态有效期与过期表现 | 待测 | 决定是否需要定时探测或运行前校验 |

> 步骤 0 全部为只读探测（`-h` / `version` / `user_credit`），**不消耗额度**；0-A 若已由 CLI 自行校验，则只需读错误信息即可，不必真跑。

---

## 13. 实施记录（2026-10-21 已落地）

### 13.1 改动文件

| 层 | 文件 | 改动 |
| -- | ---- | ---- |
| shared | `src/shared/provider-driver.ts` | 新增 `'local-cli'` 驱动、`dreamina` 映射、模态推断 |
| shared | `src/shared/types/index.ts` | `ProviderSpecId` + `PROVIDER_SPECS` 增加即梦模板（无 BaseURL，预置 7 个模型） |
| shared | `src/shared/image-capabilities.ts` | `1.5k` 档、`dreamina-cli` 驱动、`local-path` 参考模式、`defaultResolution`、`cheapestImageResolution()`、按 modelId 分表 |
| shared | `src/shared/video-capabilities.ts` | 即梦 5 组模型 profile、`requiresVisualReference`、2.5 画幅跟随首帧 |
| shared | `src/shared/dreamina-cli.ts`（新） | 纯协议层：命令组装 + stdout 归一化，零进程/DB 依赖，可直接单测 |
| main | `src/main/gateway/dreamina-cli.ts`（新） | 二进制探测、spawn、登录/版本/余额探测、串行队列、瞬态错误容忍 |
| main | `src/main/gateway/image.ts` | 第四驱动 `dreamina-cli`：参考图传本地绝对路径，产物立即下载落盘 |
| main | `src/main/gateway/video.ts` | `adaptersFor()` 增加即梦；放开 specId 白名单 |
| main | `src/main/gateway/factory.ts` | `requireProvider()` 对本机 CLI 通道跳过 BaseURL/Key 校验 |
| main | `src/main/gateway/providers.repo.ts` | 新建即梦实例不强制 API Key |
| main | `src/main/ipc/gateway.ipc.ts` | 保存校验放行；"测试"按钮走 `probeDreamina()`（版本+登录态+余额，零计费） |
| renderer | `src/renderer/src/gateway/ProviderSettingsPanel.tsx` | 即梦卡片隐藏 BaseURL/Key，改为本机通道说明；按钮文案变"检测本机 CLI" |
| test | `test/dreamina-capabilities.test.ts`（新） | 14 用例：分辨率默认最便宜、3.x 禁参考图、2.5 拒绝 ratio、2.0 禁纯音频 |
| test | `test/dreamina-cli-args.test.ts`（新） | 13 用例：四条视频路径、文/图生图分支、状态归一化 |
| test | `test/dreamina-live-smoke.test.ts`（新） | 真实 CLI 冒烟，默认跳过，`DREAMINA_LIVE_SMOKE=1` 才跑 |

**零新增节点、零端口变更、`contractVersion` 未动（`image-gen` 仍为 3，`video` 仍为 7）。**

### 13.2 真实验证结果（CLI 1.4.21，本机实测）

| 能力 | 参数 | 结果 | 额度 |
| ---- | ---- | ---- | ---- |
| 文生图 | `3.0` / `1k` / `1:1` | success，返回 **4 张** 1328×1328（取第一张） | 1 |
| 图生图 | `4.5` / `2k` / `1:1`，参考图路径**含空格** | success，2048×2048 | 4 |
| 文生视频 | `seedance2.5` / `480p` / **4 秒** | success，854×480、24fps、**4.042s** | 48 |
| 首帧视频 | `seedance2.5` / `480p` / **4 秒**，首帧图路径**含空格** | success，640×640、**4.042s**（画幅自动跟随首帧） | 48 |
| 文生视频（自动化用例） | `DREAMINA_LIVE_SMOKE=1` 跑 `test/dreamina-live-smoke.test.ts` | **通过**，submit_id `bba63b45-…`，约 348s | 48 |
| 文生视频 | `seedance2.0fast` / `720p` / 4 秒 | 已受理并扣额度，但排队未完成（见 §13.3 第 3 条） | 12 |

构建：`electron-vite build` exit 0；`npm run typecheck` / `npm run lint` / `npm test`（2404 passed）全绿。

### 13.3 实测发现（已直接改变实现）

1. **`query_result` 刚提交后会返回 `get_history_by_ids failed: ret=1015`**，几秒后同一 `submit_id` 又能正常查询。这是"记录尚未可查"的瞬时错误，**不能判为任务失败**——已在 `isTransientQueryError()` 中容忍，并给首轮轮询加了一跳延迟。
2. **`3.0 + 1k` 一次返回 4 张图**（1 额度）。当前实现取 `images[0]`；若将来要做多图，这就是天然的 `generate_num` 来源，但必须走独立集合节点（`out-image` 是单值）。
3. **不同视频模型队列差异极大**：`seedance2.0fast/720p/4s` 的 `queue_length≈478,346`、预计 33,786 秒（约 9.4 小时），5 分钟只前进 5 位；而 `seedance2.5/480p/4s` 走 `dreamina_fusion_video45_pro` 队列，约 4 分钟出片。**这意味着"最便宜的模型"当前未必是"可用的模型"**，但默认值仍按成本原则取最便宜的 `seedance2.0fast`，不把当天拥堵写死进代码。
4. `query_result` 会返回 `queue_info` 与 `estimated_remaining_seconds`，可作为后续"排队进度"提示的数据来源（本期未做）。
5. 既有 `VIDEO_TIMEOUT_MS = 30 分钟` 对长队列不够：超过 30 分钟会按既有语义标记为"结果未知"（不重复提交），用户可稍后重查。本期未改该全局常量。

### 13.4 未覆盖边界（不得宣称已完成）

| 项 | 状态 |
| -- | ---- |
| 首尾帧视频 | 仅有参数组装单测；**未做真实出片验证**（与首帧共用同一条 `frames2video` 提交+轮询落盘管线，差别仅多一个 `--last`） |
| 参考生视频 | 仅有参数组装单测；**未做真实出片验证**（需要真实视频/音频素材，且 2.0 家族有"至少一个视觉锚点"限制） |
| 首帧视频 | **已真实验证**（§13.2） |
| 设置面板"一键登录" | **未做**；当前需在终端执行 `dreamina login`，面板只显示登录状态 |
| GUI 人工点击验收 | **未做**；本轮验收为编译 + 全量单测 + 真实 CLI 冒烟 + 首次构建 |
| 项目导出/导入 | 未复测；本次无新增持久化字段，风险低 |
| 并发排队可视化 | 未做；仅实现串行队列，界面无"排队中"提示 |
| 30 分钟视频超时 | 未调整；长队列会在 30 分钟后按既有语义标记"结果未知"（不重复提交） |
| CLI 专有诊断事件 | 未新增。生图/视频的 `model.request.started / completed / failed` 由既有网关入口统一发射，`npm run verify:logging` 通过；§6.1 里列的 `cli.probe / cli.task.*` 细分事件列为后续增强 |

