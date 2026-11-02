# 本地 IndexTTS 2.5 语音合成接入

日期：2026-11-02 · 状态：已实现并在开发机真机验证（真实权重 + RTX 5080）

## 1. 用户需求

语音合成节点增加一个本地引擎模式：**选择本机 IndexTTS 2.5**，上传一段参考音频做音色克隆合成，
不需要云端供应商/模型配置。

## 2. 实现方式（调用本机已装运行时）

不随包分发权重（bilibili Model Use License 且约 10.2GB），也不要求用户另建服务：

- **解释器与权重自动探测**：配置路径优先 → 环境变量 `CANVAS_STUDIO_INDEXTTS_PYTHON` /
  `CANVAS_STUDIO_INDEXTTS_MODEL_DIR` → PATH 中的 `python` / `py` → 有界扫描常见 ComfyUI 安装
  （含非标准安装：`<盘符>/<套件>/ComfyUI`）与 `models/IndexTTS2.5`。
- **合成**：`python -m indextts.cli_v2 synth --text-file <tmp.txt> --voice <参考音频> --output <tmp.wav>
  --model-dir <dir> --device cuda --fp16 --force`，成功后 `saveFileAsset` 落成项目音频资产。
- **不依赖 `cli_v2 check`**：2.5 用 tiktoken，而 check 的清单含 `bpe.model`，会误报失败；本实现自己做
  最小文件清单校验（`config.yaml` + 权重文件）。
- **取消/超时**：复用媒体取消作用域（`trackMediaJob` → Windows `taskkill /T`），进程超时 10 分钟。
- **临时目录**：文本/音频中间文件在 `os.tmpdir()` 唯一目录，成功失败都清理。

## 3. 配置与 UI

`props.config` 新增字段（`shared/speech.ts`）：`localPythonPath`、`localModelDir`、`localDevice`、
`localFp16`、`durationFactor`（0.5–2，IndexTTS 的时长因子，**不是**云端的 speed）、`localLang`（ZH/EN/JA/ES/AR）。
切到本地引擎时强制清空 `providerId/modelId/voiceId`，避免把云端音色 ID 带到本地。

语音合成节点（`bodies/speech.tsx`）：

- 供应商下拉新增「本地 · IndexTTS 2.5（参考音频克隆）」；选它后隐藏云端「模型」与「音色 ID」；
- 「参考音频（必填）」区块：可上传（wav/mp3/ogg/flac，≤50 MB）或连接上游音频；提示 15 秒截断；
- 「本地运行时」状态行：已就绪 / 原因 + 「重新检测」按钮；未就绪时合成按钮不可用。

端口（`speechPorts('indextts')`）：`in-text` + `in-audio`（参考音频） → `out-audio`，不产生字幕输出。

## 4. 验证证据

| 检查 | 结果 |
| --- | --- |
| `test/indextts-engine.test.ts` | 12 项通过（探测候选、参数拼装、成功/失败/取消、临时目录清理、wav 时长解析） |
| 本机真实探测（`CANVAS_INDEXTTS_REAL=1`） | `pythonPath=D:\PPT_Studio_Assets\InfiniteTalk_TTS\InfiniteTalk_Runtime\venv\Scripts\python.exe`；`modelDir=D:\PPT_Studio_Assets\InfiniteTalk_TTS\TTS\IndexTTS2.5`；`ready=true` |
| 本机真实合成 | 中文 20 字 + 4s 参考音频 → `projects/projtest/media/VKkRZlWr6y.wav`，161,836 字节，3.669s，总耗时 20.0s（含加载 10GB 权重） |
| `test/speech-config.test.ts` | 新增 2 项：本地通道清空云端字段、固定 wav/22050；默认 cuda+fp16+ZH |

## 5. 已知边界

- **权重与解释器需用户自备**：应用只探测与调用，不下载、不分发；许可非 OSI，UI 不承诺可用性。
- **显存**：约 6GB 起（本机 RTX 5080 16GB 实测通过）；与其他本地推理共用单卡时需串行。
- **首字节**：每次调用都会重新加载权重，冷启动约 10–20 秒（本机实测 20s 含推理）。
- **参考音频**：模型内部硬截断 15 秒；建议单人不带背景音的 5–10 秒片段。
- **超长文本**：单次请求限制 3000 字；模型内部分段合成，段间停顿由模型决定。
- **不支持**：情感参考音频、方言精细控制、字幕时间轴（该通道不产出 `out-subtitle`）。
