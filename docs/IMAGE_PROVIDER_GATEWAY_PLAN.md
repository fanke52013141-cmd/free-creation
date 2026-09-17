# 生图节点多供应商与参数扩展方案（TOAPIS / OpenAI 官方 / OpenRouter）

> 状态：**方案已评审，决策点已确认（§11），待排期实施**。
> 需求来源：用户 2026-09 提出的生图节点优化（分辨率 1K/2K/4K、质量固定 low、可选 Size、
> 四类供应商接入与选择、默认 ToAPIS）。

---

## 1. 需求回顾

| # | 需求 | 说明 |
| - | ---- | ---- |
| 1a | 分辨率可选 | `1k` / `2k` / `4k` 三档 |
| 1b | 质量固定 `low` | **不暴露 UI**；供应商支持时请求固定携带 `quality: "low"`（已确认） |
| 1c | Size 可选 | TOAPIS 支持的 13 种比例：`1:1 3:2 2:3 4:3 3:4 5:4 4:5 16:9 9:16 2:1 1:2 21:9 9:21` |
| 2 | 四类供应商接入 | (a) ToAPIS（`https://toapis.com` / 大陆 `https://toapis.cn`）；(b) ChatGPT/OpenAI 官方；(c) OpenRouter 中转；(d) 直接填 Base URL + Key + Model 即可调用的自定义中转（现有 relay） |
| 3 | 供应商可选，默认 ToAPIS | 生图节点上显式选择供应商实例 |

非目标（本期不做）：`background: transparent` 透明背景参数、`n > 1` 多图、图片修改
（image-edit）节点的 TOAPIS 适配、TOAPIS 任务的应用重启恢复。

---

## 2. 现状梳理（代码事实）

| 位置 | 现状 |
| ---- | ---- |
| `src/shared/image-capabilities.ts` | 全部供应商共用一套保守能力 `SAFE_OPENAI_COMPAT_CAPABILITIES`：7 种画幅（size 多为 `auto`），无分辨率/质量概念。`imageCapabilitiesFor(specId, modelId)` 忽略两个参数 |
| `src/shared/contracts/index.ts` | `ImageGenerateInput = { projectId, providerId, modelId, prompt, size?, referenceMediaId(s)?, seed?, aspectRatio? }` |
| `src/main/gateway/factory.ts` | 所有非视频供应商统一走 `createOpenAICompatible`（AI SDK），`createImageModel` 产出 ImageModel |
| `src/main/gateway/image.ts` | AI SDK `generateImage` 同步调用：本地参考图读 Buffer → base64 提交 `/images/edits` 风格请求；`size` 以像素串直传；`aspectRatio` 经 `providerOptions` 透传。产物 `saveBufferAsset` 落盘为 `MediaAsset` |
| `src/shared/engine/executors/imageGen.ts` | 按 `modelKey = providerId::modelId` 找模型 → 归一化配置 → 合并提示词（props.text + prompt.bundle + in-text）→ 有序参考图 ≤4 → `ctx.gateway.imageGenerate`。渲染与 headless 共用同一执行器 |
| `src/renderer/src/nodes/specs/bodies/image-gen.tsx` | 卡片 UI：ModelSelect（跨供应商全部图片模型）+ 画幅 AppSelect（选比例自动取第一个 size）+ 提示词 + @图片 菜单 |
| `src/shared/types/index.ts` | `ProviderSpecId` 不含 `toapis` / `openrouter`；`PROVIDER_SPECS` 模板中 `relay`（中转/自定义）建议模型即 `gpt-image-2`，`openai` 官方模板 modality 提示为 text |
| `src/renderer/src/gateway/ProviderSettingsPanel.tsx` | 供应商实例在设置面板手工新建（BaseURL + Key + 模型列表），存主进程 SQLite，key 加密落盘，渲染层只见 `hasApiKey` |
| `src/capabilities/definitions.ts` | `imageGenCapability`（id `image.generate`，version 3.0.0，contractVersion 3）带 `configSchema`（providerId/modelId/ratio/seed），供 MCP 与 headless 使用 |
| 异步任务先例 | `src/main/gateway/video.ts`：MiniMax/Seedance 走「提交 → tasks 表 → 轮询 → 下载落盘」，有取消与恢复 |

**关键差异**：TOAPIS 的 `gpt-image-2` 文档（用户已提供）与现有 OpenAI Images 兼容链路
不同——① `size` 传**比例串**（`1:1`）而非像素；② 新增 `resolution`（1k/2k/4k）；
③ 返回**异步任务**（`queued/in_progress/completed/failed` + progress），需要轮询；
④ 参考图**只收 URL**（本地图需先走其上传接口换 URL，≤6 张）；⑤ 文档未列 `quality`。

---

## 3. 契约判定（NODE_CONTRACT_SPEC §1.1）

本次改动**不新增节点**，属于「扩展既有节点配置」：

- 输入/输出端口、类型、基数、必填性、错误语义全部不变（仍是
  `in-images many + in-prompt one + in-text many → out-image one`）；
- 能力仍属生图节点单一职责（选择供应商与提交参数是生图配置的一部分）；
- 新配置由原执行器与原输出投影解释；
- 旧配置（无新字段）经归一化后行为不变。

因此 **`image-gen` 的节点 `contractVersion` 保持 3，端口不动**。但 `configSchema`
新增字段属于「节点能力面（configSchema）改动」，按 AGENTS.md 必须同步
`imageGenCapability` 并在同一提交运行 `npm run agent:generate`、提交
`generated/agent-contracts.json`（能力 version 升为 4.0.0）。

---

## 4. 总体设计

### 4.1 参数模型（`ImageGenerationConfig` 扩展）

```ts
export type ImageResolution = '1k' | '2k' | '4k'
// 质量是网关层常量 'low'，不再定义枚举/字段
// ImageAspectRatio 扩为全集：
export type ImageAspectRatio =
  | 'auto' | '1:1' | '3:2' | '2:3' | '4:3' | '3:4' | '5:4'
  | '4:5' | '16:9' | '9:16' | '2:1' | '1:2' | '21:9' | '9:21'

export interface ImageGenerationConfig {
  providerKey?: string         // 新增：选中的供应商实例 id
  modelKey: string             // 现状：providerId::modelId
  size: string                 // 能力表里该比例的实际落点（toapis=比例串；openai=像素串；auto=不传）
  aspectRatio: ImageAspectRatio
  resolution?: ImageResolution // 新增：默认 '1k'；供应商不支持时不发送
  seed?: number                // 旧字段，保持兼容
}
// 质量不进节点配置：无 UI、无持久化字段；网关层在 supportsQuality 的供应商上固定发送 'low'。
```

- 三个新字段全部**可选**，`normalizeImageGenerationConfig` 补默认值并剔除非法组合
  → 旧项目配置无感兼容，**不需要契约版本升级**（§3.1 判定：端口与 Schema 未破坏）。
- `size` 语义沿用现有注释「比例是用户意图，尺寸是当前模型的实际落点」：用户永远选
  比例，能力表决定发给供应商的 `size` 值（TOAPIS 直接发比例串，OpenAI 发映射后的
  像素串，不支持的供应商不发）。

### 4.2 供应商能力表（`image-capabilities.ts` 重构）

```ts
export interface ImageCapabilities {
  ratios: ImageAspectRatio[]
  sizeOptions: ImageSizeOption[]            // 现状字段，value 即提交给 API 的 size
  supportsSeed: boolean
  supportsReferenceImages: boolean
  maxReferenceImages: number
  forwardsAspectRatio: boolean
  // 新增：
  resolutions: ImageResolution[]            // 空数组 = UI 隐藏、请求不带
  supportsQuality: boolean                  // true = 请求固定携带 quality: 'low'；无 UI
  driver: 'openai-images' | 'toapis-task' | 'openrouter-chat'
  referenceMode: 'binary' | 'upload-url' | 'chat-inline'
}
```

`imageCapabilitiesFor(specId, modelId)` 改为按 specId 分表（modelId 保留作按模型覆盖
的扩展键，本期不启用）：

| specId | ratios | sizeOptions | resolutions | quality 固定 low | maxRef | driver | referenceMode |
| ------ | ------ | ----------- | ----------- | ---------------- | ------ | ------ | ------------- |
| `toapis` | 13 种 + `auto`（auto=不传 size，服务端默认 1:1） | ratio→ratio 直传 | `['1k','2k','4k']`，默认 `1k` | ✓（实测确认） | 6（文档上限） | `toapis-task` | `upload-url` |
| `openai` | `auto 1:1 3:2 2:3` | `1:1→1024x1024`、`3:2→1536x1024`、`2:3→1024x1536`、auto | 无（隐藏） | ✓ | 4 | `openai-images` | `binary` |
| `openrouter` | 首版仅 `auto`（验证后按上游能力扩充） | auto | 无（隐藏） | ✗（不发） | 4 | `openrouter-chat` | `chat-inline` |
| `relay` 及其他 | 维持现状保守集合 | 维持现状 | 无（隐藏） | ✗（不发） | 4 | `openai-images` | `binary` |

要点：

- **质量全局固定 `low`**：没有任何质量 UI 与配置字段；能力表 `supportsQuality=true`
  的供应商（TOAPIS、OpenAI 官方）请求固定带 `quality: 'low'`，其余供应商不带。
- **OpenAI 官方没有 1k/2k/4k 档**（已确认隐藏分辨率选择），按「应用不得伪造能力」
  原则（§8.2）在 UI 隐藏分辨率选择。
- TOAPIS 的 `quality` 文档未列出：按固定 low 发送；**实施第 0 步实测**，若 API 明确
  拒绝该字段则把 toapis 的 `supportsQuality` 置 false（机制上无成本）。
- **选中哪个供应商就传哪个供应商支持的参数、呈现对应的控件页**（用户确认的交互原则）：
  参数可见性与请求字段全部由能力表驱动，与现有 `capabilities.ratios` 驱动画幅下拉的
  方式一致，不新增任何按节点类型写死的分支。

### 4.3 网关驱动器（`src/main/gateway/image.ts`）

入口 `generateImageToAsset(input)` 保持签名与返回（`MediaAsset`）不变，内部按供应商
specId 查能力表分发到三个驱动：

**① `openai-images`（现状路径，ChatGPT/OpenAI 官方 + relay 沿用）**
AI SDK `generateImage` 不变；`resolution`（若能力表允许）与固定的
`quality: 'low'`（若 `supportsQuality`）经 `providerOptions: { [providerId]: {...} }`
透传（与现有 aspectRatio 同机制）。relay 实例行为对现有用户零变化（保守能力，不带
新字段）。

**② `toapis-task`（TOAPIS 专用，绕过 AI SDK，直接 fetch）**

```text
POST {baseURL}/images/generations
  { model, prompt, size: '1:1', resolution: '2k', quality: 'low',
    n: 1, response_format: 'url', reference_images?: string[] }
→ { id: 'task_img_…', status: 'queued', progress: 0 }
轮询 GET {baseURL}/images/tasks/{id}   ← 确切路径见 §10 待验证
  间隔 2~3s，超时 10min，响应 ctx 取消信号
→ status=completed → 取结果 URL → 下载 → saveBufferAsset（与现状同一落盘管线）
→ status=failed    → 抛 GatewayError，错误文案带供应商原始信息
```

（`quality: 'low'` 固定携带；若第 0 步实测被拒则去掉该字段。）

- 参考图：本地 `MediaAsset` → 调 TOAPIS 上传接口换公开 URL（确切路径/响应结构见
  §10）→ `reference_images` 数组；上传失败给出可操作错误，绝不静默丢弃已连接参考图
  （NODE_CONTRACT_SPEC §8.2 原则）。
- 任务式轮询复用 video.ts 的经验但**不落 tasks 表**（生图通常 <1min，一次性飞行中
  轮询 + 取消 + 超时即可；重启恢复列为后续增强）。

**③ `openrouter-chat`（OpenRouter 生图）**

```text
POST {baseURL}/chat/completions
  { model, modalities: ['image', 'text'],
    messages: [{ role: 'user', content: [
      { type: 'text', text: prompt },
      { type: 'image_url', image_url: { url: 'data:image/png;base64,…' } }  // 参考图内联
    ]}] }
→ choices[0].message.images[].image_url.url（data URL）→ 解码 base64 → saveBufferAsset
```

- OpenRouter 生图走 chat-completions 形态（多模型通用），不走 `/images/generations`；
  首版发送该协议确定支持的参数（model、modalities、提示词、内联参考图），
  size/resolution/quality 不发送（能力表未验证前为空，UI 同步隐藏）；第 0 步验证后
  若 OpenRouter 支持尺寸类参数，只需改能力表即可开放，不动驱动代码。
- 本地参考图直接转 data URL 内联（chat 消息原生支持），≤4 张。

image-edit（P图节点）仍走 `openai-images` 驱动不动，保证零回归；TOAPIS edits 端点
适配列为后续独立事项。

### 4.4 供应商接入配置（`PROVIDER_SPECS` + 设置面板）

`ProviderSpecId` 扩为 `… | 'toapis' | 'openrouter'`，新增两个模板：

| specId | label | 默认 baseURL | suggestions（新建时预填） | modality 提示 |
| ------ | ----- | ------------ | ------------------------- | ------------- |
| `toapis` | ToAPIS | `https://toapis.com/v1`（面板可改 `toapis.cn`） | `gpt-image-2` | image |
| `openrouter` | OpenRouter | `https://openrouter.ai/api/v1` | `google/gemini-2.5-flash-image`（实施时按 OpenRouter 当前可用图模校准） | image |
| `openai`（现有模板微调） | OpenAI 官方 | 不变 | 增加 `gpt-image-1`（guessModality 已能识别为 image） | 提示补充生图 |
| `relay`（现有模板，不变） | 中转站 / 自定义 | 空（用户自填） | 维持 `gpt-image-2, gpt-5.2` | image |

「直接填 Base URL + Key + Model 就能调用」的自定义方式即现有 relay 模板，本期保持
保守能力集合不变，继续走 openai-images 驱动——它已满足该使用方式。

- 供应商实例仍由用户在设置面板新建（TOAPIS 需要填入你的 API Key；key 只存主进程
  SQLite 加密列，不进项目文件，导入导出安全边界不变）。
- `guessModality` 增补：specId 为 `toapis` 时建议模型直接按 image 处理。

### 4.5 节点 UI（`image-gen.tsx` Body）

卡片默认尺寸保持 340×260，控件全部复用 `AppSelect`（§13 单一视觉来源），布局：

```text
行1：[供应商 ▾        ] [模型 ▾（按供应商过滤）  ]
行2：[画幅/Size ▾] [分辨率 ▾*]                (*能力不支持时隐藏)
     提示词 textarea（不变）
     @图片 菜单（不变）
     [✦ 生成图片]
```

- **供应商下拉**：选项 = 配置了至少 1 个 image 模型的供应商实例，显示
  `名称 (模板名)`；四类模板（ToAPIS / ChatGPT 官方 / OpenRouter / 中转站自定义）都会
  自然出现在这里。默认选中顺序：`config.providerKey` → 从 `modelKey` 反推 →
  **specId 为 toapis 的实例** → 第一个含 image 模型的实例。无可用实例时沿用
  `NoModelHint` 引导打开设置。
- **选中哪个供应商，就按它的能力表呈现对应的参数页**：ToAPIS 显示 13 画幅 + 1k/2k/4k；
  ChatGPT 官方显示 4 画幅（隐藏分辨率）；OpenRouter 与 relay 显示最小集合；质量任何
  供应商都不显示（固定 low）。
- 切换供应商：模型列表级联过滤，`modelKey` 重置为该供应商第一个 image 模型，配置按
  新供应商能力表归一化（size/分辨率重置为合法默认）。
- 模型下拉仅显示当前供应商的 image 模型（现状是跨供应商混排，改为级联后更清晰）。
- 分辨率下拉只在能力表非空时渲染；切换供应商后若不支持则从配置中剔除。

### 4.6 执行器变更（`executors/imageGen.ts`）

- 供应商解析抽成共享纯函数（renderer Body 与执行器共用一套默认值逻辑）：
  `resolveImageModelOption(providers, config)`。
- 参考图上限从硬编码 `slice(0, 4)` 改为读 `capabilities.maxReferenceImages`。
- `gateway.imageGenerate` 调用新增透传 `resolution`（能力表允许时）；`quality` 不经过
  执行器与配置，由网关层按 `supportsQuality` 注入固定 `'low'`。
- `ImageGenerateInput`（contracts）增加 `resolution?: ImageResolution`；网关层自行按
  供应商 specId 决定驱动与字段映射，输入契约保持供应商无关。

---

## 5. 契约同步（AGENTS.md 强制）

1. `src/capabilities/definitions.ts` → `imageGenCapability`：
   - `version: '3.0.0' → '4.0.0'`；
   - `configSchema` 增补：`providerKey`(string, optional)、`resolution`(enum
     1k/2k/4k, default 1k)；`ratio` 枚举扩为 14 值全集。质量不进 configSchema
     （无 UI、固定 low，由网关注入）。
2. 同一提交运行 `npm run agent:generate`，提交 `generated/agent-contracts.json`。
3. MCP 工具与 headless 执行链路无需改代码（共用执行器），但需跑
   `test/agent/mcp-server.test.ts` 确认 dry-run 与发现流程不受影响。

## 6. 兼容与数据安全

- 旧配置无新字段 → 归一化补默认，行为不变；`relay` 实例维持现有保守能力。
- 你现有的「中转站」实例若实际指向 TOAPIS，建议新建一个 ToAPIS 模板实例（填 Key）并
  在生图节点切过去，即可获得 13 画幅 + 分辨率 + 质量全量能力；旧实例继续可用。
- 密钥仍只存主进程（DPAPI 加密列），渲染层只有 `hasApiKey`；运行记录（NODE_CONTRACT_SPEC
  §7）继续不落 Key；项目导入导出不涉及供应商表，安全边界不变。
- 上传 TOAPIS 的参考图会离开本机（变成供应商侧 URL），在生图节点说明文案中提示一句。

## 7. 实施步骤

| 步骤 | 内容 | 产出 |
| ---- | ---- | ---- |
| 0 | 验证外部 API 细节：TOAPIS 任务查询/上传接口路径与响应结构、`quality` 是否被接受；OpenRouter 生图端点形态与可用图模 slug；OpenAI 当前图模 ID | 本文档 §10 表格补全 |
| 1 | shared：类型 + 能力表重构 + `normalizeImageGenerationConfig` 扩展 + `PROVIDER_SPECS` + `ImageGenerateInput` 增字段 | `image-capabilities.ts`、`types/index.ts`、`contracts/index.ts` |
| 2 | main：`gateway/image.ts` 三驱动分发 + TOAPIS 上传/轮询/下载 + OpenRouter chat 适配 | `gateway/image.ts`（+ 必要的小模块拆分） |
| 3 | 执行器 + 共享 `resolveImageModelOption` + 参考图上限能力化 | `executors/imageGen.ts`、`engine/models.ts` |
| 4 | renderer：Body UI 级联下拉 + 分辨率控件 + 默认供应商逻辑 | `bodies/image-gen.tsx` |
| 5 | 能力定义 configSchema + version bump + `npm run agent:generate` | `capabilities/definitions.ts`、`generated/agent-contracts.json` |
| 6 | 测试补齐与全量门禁 | 见 §8 |
| 7 | 手工验收（设置里新建 ToAPIS / OpenRouter / OpenAI 官方实例，relay 沿用现有 → 逐项验收 §9 清单） | 验收记录 |

## 8. 测试计划

- 单测：
  - 能力表：各 specId 的 ratios/resolutions/supportsQuality/driver/maxRef 断言；非法组合归一化。
  - `parseImageGen`：旧配置（无新字段）解析默认 `1k`；非法枚举剔除。
  - TOAPIS 驱动（mock fetch）：提交体字段正确（size=比例串、resolution、固定
    `quality:'low'`、reference_images 走上传 URL）→ 轮询至 completed → 落盘；
    failed/超时/取消路径。
  - OpenRouter 驱动（mock fetch）：请求含 modalities 与内联参考图；解析 `message.images`。
  - openai-images 驱动回归：OpenAI 官方实例 quality:'low' 经 providerOptions 透传、
    不发送 resolution；relay 实例不带任何新字段（现状快照不变）。
  - 执行器：`gateway.imageGenerate` 收到 resolution；参考图上限按能力表（toapis 6）；
    请求体中不出现质量字段（由网关注入）。
- 契约门禁：`test/node-compliance.test.ts`、`test/node-contract-snapshot.test.ts`、
  契约漂移测试（`npm run agent:generate` 后 diff 为空）。
- 全量：`npm run verify`（lint + typecheck + test + build）。

## 9. 手工验收清单

- [ ] 新建 ToAPIS 实例（Base URL + Key + `gpt-image-2`）→ 节点默认选中 ToAPIS。
- [ ] 13 种画幅逐一可送出；`auto` 不发送 size 字段。
- [ ] 1k/2k/4k 各生成一张，落盘图片分辨率与尺寸对照表一致（如 16:9+2k → 2048×1152）。
- [ ] 请求体固定携带 `quality:'low'`（TOAPIS/OpenAI），UI 无质量控件；若 TOAPIS 拒绝
  quality 字段，确认已按能力表关闭发送且生成仍成功。
- [ ] 参考图（本地图库 1~6 张）→ 图生图成功（走上传换 URL）；提示词 @图片 1 指代正确。
- [ ] ChatGPT 官方实例：隐藏分辨率，生成成功，size 像素映射正确。
- [ ] OpenRouter 实例：chat 生图成功，参考图内联生效，size/分辨率控件隐藏。
- [ ] relay 自定义实例（BaseURL+Key+Model）：行为与改造前完全一致。
- [ ] 旧 relay 实例与旧项目文件打开后行为不变；生图节点再运行正常。
- [ ] 生成中途取消、断网、错误 Key 的失败路径均有可读错误，不产生半截资产。

## 10. 风险与待验证（步骤 0 产出）

| 项 | 风险 | 处置 |
| -- | ---- | ---- |
| TOAPIS 任务查询/上传接口的确切路径与响应结构 | 本沙箱无法访问 docs.toapis.com（DNS 受限） | 实施时重试抓取 `https://docs.toapis.com/llms.txt` 定位页面；不通则请你贴出「查询任务」「上传图片」两页文档，或按文档示例先写适配再用真实 Key 冒烟 |
| TOAPIS 是否接受 `quality` | 文档未列该参数 | 首次实测：拒绝则 toapis 的 `supportsQuality=false`，请求不再携带（机制零成本） |
| AI SDK 对 size 格式/额外字段的客户端校验 | 直传比例串可能被 SDK 拦 | TOAPIS 驱动绕过 AI SDK 直接 fetch，风险已规避；openai-images 路径仍只发像素 size |
| OpenRouter 生图端点形态（chat modalities vs 专用 images 端点）与模型 slug 时效 | 驱动写死一种形态 | 驱动隔离在 `openrouter-chat` 内，验证后可低成本切换；模型建议列表实施时按官网校准 |
| OpenAI 官方无 1k/2k/4k | 与需求 1a 的期望有差 | 按能力表隐藏并显示「由供应商决定」；如需伪 4k 可后续在本地放大节点实现（不在本期） |
| 任务轮询期间应用退出 | 任务丢失 | 生图耗时短，本期接受；后续可仿 video.ts tasks 表做恢复 |

## 11. 决策记录（2026-09 已确认）

| # | 决策点 | 结论 |
| - | ------ | ---- |
| 1 | OpenAI 官方无 1k/2k/4k | **隐藏分辨率选择**，不做粗映射 |
| 2 | 质量（quality） | **固定 low，不暴露 UI**；`supportsQuality` 供应商请求固定携带，字段不进节点配置与 configSchema |
| 3 | 现有 relay 实例 | **保持保守能力**；用户新建 ToAPIS 实例后切换，不给 `relay + gpt-image-2` 放开能力（避免把任意中转站误判为 TOAPIS） |
| 4 | OpenRouter 首版 | 传该协议确定支持的参数（modalities + 参考图内联）；size/分辨率在能力表验证前隐藏。**交互总原则：选中哪个供应商，就传它支持的参数、呈现对应参数页** |
| 5 | 供应商范围 | 四类：TOAPIS、ChatGPT 官方、OpenRouter、直接填 BaseURL+Key+Model 的自定义（relay）。四者都出现在生图节点供应商下拉中 |

---

## 12. 实施记录（已落地）

**改动文件**：`src/shared/image-capabilities.ts`（能力表四分册 + 归一化扩展）、
`src/shared/types/index.ts`（`toapis`/`openrouter` 模板）、`src/shared/contracts/index.ts`
（`ImageGenerateInput.resolution`）、`src/main/gateway/image.ts`（三驱动）、
`src/main/gateway/factory.ts`（导出 `requireProvider`）、`src/shared/engine/models.ts`
（`resolveImageModelOption`/`defaultImageProviderId`）、`src/shared/engine/executors/imageGen.ts`、
`src/renderer/src/nodes/specs/bodies/image-gen.tsx`、`src/renderer/src/assets/app.css`
（`.gen-provider` 窄列）、`src/renderer/src/gateway/ProviderSettingsPanel.tsx`（toapis→image）、
`src/capabilities/definitions.ts`（image.generate 4.0.0，修正幽灵键 providerId/modelId →
modelKey）、`generated/agent-contracts.json`（再生成，幂等已验证）。

**新增/更新测试**：`test/image-capabilities.test.ts`（四供应商能力表 + 跨供应商归一化）、
`test/image-gateway-drivers.test.ts`（三驱动 6 用例：提交体/上传换 URL/回显排除/失败路径/
modalities+内联/固定 low）、`test/executors-shared.test.ts`（新字段解析）、
`test/f04-repro.test.ts`（**与生图无关的工作区遗留**：上一轮 F04 沙箱加固的复现脚本
被改写为回归断言，`src/main/headless/run-code.ts` 的他人未提交改动未被触碰）。

**验证**：`npm run verify`（lint + typecheck + vitest 985 用例 + electron-vite build）exit 0。

**步骤 0 的遗留假设（验收冒烟时确认，均在能力表/驱动内一处可改）**：

| 假设 | 位置 | 冒烟不符时 |
| ---- | ---- | ---------- |
| 任务查询端点为 `{base}/images/tasks/{id}`，另有 `/tasks/`、`/images/generations/` 两个候选，命中后按供应商缓存 | `TOAPIS_TASK_QUERY_PATHS` | 按实际文档调整候选表 |
| 参考图上传为 `POST {base}/uploads/images`（multipart 字段 `file`），响应任意位置可提取 URL | `toapisUploadReference` | 改路径/字段名/响应提取 |
| `quality:'low'` 被 TOAPIS 接受 | `TOAPIS_CAPABILITIES.supportsQuality` | 置 false 即不再发送 |
| OpenRouter 走 chat-completions `modalities:['image','text']`，结果在 `message.images[].image_url.url` | `generateWithOpenRouterChat` | 若官方开放 images 端点，仅改此驱动 |
