# MiniMax 音色设计与音色克隆的计费口径（2026-11-02 查证）

来源（抓取时间 2026-11-02，官方开放平台）：

- 定价概览：<https://platform.minimax.cn/docs/pricing/overview>（由 `platform.minimaxi.com/document/price` 重定向）
- 音色快速复刻 API：<https://platform.minimax.cn/docs/api-reference/voice-cloning-clone>（由 `document/voice_clone` 重定向）

## 官方原文

定价概览 → 语音 → **音色管理**（单位：元/音色）：

> **音色设计 Voice Design**：基于用户输入的声音描述 prompt 生成音色（voice_id），可用于同步/异步语音合成接口。**9.90**
> **生成音色时不立即收费，首次使用该音色进行合成时才计入。接口内的试听语音合成按 2.00 元/万字符计费。**

> **快速复刻 Voice Cloning**：基于大语言模型的音色克隆…… **9.90**
> **复刻音色时不立即收费，首次使用该音色进行合成时才计入。试听字符按所选试听模型的单价计费。**

音色快速复刻 API 文档：

> `text`：复刻试听参数，限制 1000 字符以内…… **注：试听将根据字符数正常收取语音合成费用，定价与 T2A 各接口一致**
> `extra_info`：试听音频的元信息和计费信息。**仅当请求中带 `text`（即触发了试听合成、有计费）时返回。**

T2A 价格（同页）：speech-2.8-hd / 2.6-hd 3.50 元/万字符；speech-2.8-turbo / 2.6-turbo 2.00 元/万字符；
**1 个汉字算 2 个字符**，英文字母/标点/空格各算 1 个字符。

## 结论（对产品的影响）

| 操作 | 是否立即计费 |
| --- | --- |
| 创建设计音色 / 复刻音色（只拿到 voice_id） | 否，9.90 元/音色延迟到**首次合成**时计入 |
| 接口内试听（音色设计的 preview_text、克隆的 text） | 是，按 TTS 字符计费 |
| 用该音色正式合成 | 是，按字符计费（并触发该音色的 9.90 一次性费用） |

本仓库对应实现：

- **语音克隆节点**（`src/main/gateway/voice.ts:buildVoiceCloneBody`）不发送 `text`，构造体里没有试听参数
  → 只克隆不合成**不产生合成费**；`text_validation` 是参考语音内容校验，不属于试听合成。
- **音色设计节点**（`buildVoiceDesignBody`）必带 `preview_text`（上限 `VOICE_DESIGN_PREVIEW_LIMIT = 500`），
  因为设计接口要返回试听才能确认音色 → 这一步会产生一笔很小的试听费（≤500 字符 × 2.00 元/万字符，
  汉字双计，实测量级约几分钱），9.90 元仍然延迟到首次合成。

## 未核实边界

- 音色设计 API 文档页（`.../api-reference/voice-design`、`.../guides/voice-design`）多次请求被对端断连，
  未能确认 `preview_text` 是否必填、能否省略以零试听费创建；如需“设计也零费用”要先向平台确认该字段可省略。
- 未做真实扣费验证（不使用生产账号做付费实验）；价格与规则可能调整，以控制台账单为准。
