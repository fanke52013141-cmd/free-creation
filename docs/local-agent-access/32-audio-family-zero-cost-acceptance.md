# 音频三族（语音合成/音色克隆/音色设计）：零成本验收口径与证据

日期：2026-11-08。起因：用户指出"完整版项目的音频应该有音色设计和音色克隆"，而我此前的
里程碑只覆盖了 `audio`/`sound-adjust`，从未验证 `speech`、`tts`、`voice-design` 三类。
同时用户明确要求：**验收阶段不做真实的音色克隆与音色设计产物（会花钱）**。

本文件记录：这三类节点在当前仓库里的真实形态、本轮零成本验收到了什么、以及付费部分
必须满足什么条件才能验收。

## 1. 事实核对（先确认"完整版"有什么）

`ACTIVE_NODE_TYPE_IDS` 共 32 类，音频相关四类都在：

| 节点 | 契约版本 | 输入端口 | 输出端口 | 执行器 |
| --- | --- | --- | --- | --- |
| `audio` | 3 | — | `out-audio` | `executors/audio.ts`（素材，非生成） |
| `sound-adjust` | 1 | `in-audio` | `out-audio` | `executors/soundAdjust`（已在本轮前验收） |
| `speech` 语音合成 | 4 | 按 `backend` 动态（`in-text`/`in-audio`/`in-voice`） | `out-audio` + `out-subtitle` | `executors/speech.ts` |
| `tts` 音色克隆 | 4 | `in-audio` | `out-json`（`voice.profile@1`）+ 音频 | `executors/tts.ts` |
| `voice-design` 音色设计 | 1 | `in-text` | `out-audio` + `out-json` | `executors/voiceDesign.ts` |

三条真实产出路径：

- `speech`：**MiniMax / 火山 语音合成**（付费），以及**本机 IndexTTS 2.5 本地合成**（免费，
  见 [10-indextts-local-speech.md](10-indextts-local-speech.md)，本机已装运行时）；
- `tts`：MiniMax 云端声音复刻（付费）；
- `voice-design`：MiniMax 音色设计（付费，一次运行产出试听音频 + 音色档案 JSON）。

此前交付登记"付费生成族执行验收待预算"是准确的，但**没有把"契约/门禁/三入口"这类不需要
花钱的部分验完**——这是本包补上的缺口。

## 2. 本轮零成本验收的证据

### 2.1 执行器门禁（新增 `test/local-agent-audio-family-gating.test.ts`，9 项通过）

手法：注入"凡是付费方法被调用就记录并抛错"的 gateway 代理（`speechGenerate` /
`ttsGenerate` / `voiceDesign` / `indexttsSynthesize` 四个计费/联网入口），断言：

| 场景 | 期望 | 实际 |
| --- | --- | --- |
| speech 无朗读文本 | skipped「无朗读文本」 | ✔ 且零计费调用 |
| speech MiniMax 后端、功能未绑定已验证模型 | skipped「功能 speech.synthesize 尚未绑定已验证语音模型」 | ✔ 零计费 |
| speech 本地 IndexTTS、无参考音频 | skipped「本地 IndexTTS 需要一段参考音频…」 | ✔ 零计费（不会退化成付费通道） |
| speech 本地 IndexTTS、有参考音频但本机无合成通道 | failed「当前运行环境不支持本地 IndexTTS…」 | ✔ 零计费 |
| tts 无参考语音 | skipped「缺少参考语音」（phase=input） | ✔ |
| tts 有参考语音、无可用 MiniMax 语音模型 | skipped「当前 MiniMax 语音模型不可用…」（phase=capability） | ✔ 零计费 |
| voice-design 无描述 | skipped「无音色描述」 | ✔ |
| voice-design 有描述、功能未绑定已验证模型 | skipped「功能 voice.design 尚未绑定已验证音色设计模型」 | ✔ 零计费 |
| voice-design 无功能解析通道且未选供应商 | skipped「未选择 MiniMax 供应商」 | ✔ 零计费 |

结论：**在缺少已验证模型/凭据时，这三个执行器在任何付费调用之前就停下**，既不会偷偷
降级到付费通道，也不会伪造产物。这正是"不做真实克隆/设计"前提下能给出的最强保证。

### 2.2 真实桌面（由里程碑 6.10 段承担）

- 外部 `graph.patch` 创建 `speech`/`tts`/`voice-design` 三个节点并保存；`node.get` 读回
  类型/契约版本/配置 JSON；
- GUI 画布上三个节点卡片真实可见（不打开编辑器、不点合成按钮）；
- `node.execute` 三者均如实 `skipped`/`failed`，reason 与执行器文案一致（三入口同一句原因）；
- 执行前后 `media.list` 总数不变、`output.get` 不产出伪造媒体、节点 exec 状态非 `success`。

（若该段实际文案与上表不一致，以里程碑 receipt 里记录的真实值为准，并在 30 号台账说明。）

## 3. 必须花预算才能验收的部分（不做，如实登记）

| 能力 | 为什么不能现在验 | 需要的条件 |
| --- | --- | --- |
| `tts` 声音复刻真实产出 | 每次调用 = MiniMax 计费请求 | 明确预算授权 + 已验证 MiniMax 语音模型 + 一段短参考音频 |
| `voice-design` 音色设计与试听音频 | 同上，且一次运行产两个产物（音频 + 音色档案） | 预算授权 + `voice.design` 功能绑定 |
| `speech` MiniMax/火山 合成真实产出 | 同上 | 预算授权 + 对应供应商模型 |
| `speech` 本地 IndexTTS 真实合成 | **不花钱**，但需要 10GB 权重冷启动约 20s，且要求提供参考音频（本质也是音色克隆） | 用户明确同意跑本地合成（本轮按"不做真实克隆"要求未跑） |

## 4. 下一步

1. 桌面 6.10 段落地后，把 checks 数写进 30 号台账；
2. 如需验收付费路径，按供应商分组（voice.clone / voice.design / speech.synthesize）逐组申请
   预算授权，每次只跑一条最小请求，并记录受理/进度/落盘/取消；
3. 本地 IndexTTS 路径若要验收，先用一份 3-5 秒参考音频跑一次最小合成，记录耗时与产物，
   不与付费验收混为一谈。
