# 测试媒体素材

## speech-sample.wav

- 来源：https://github.com/snakers4/silero-vad （`tests/data/test.wav`，Silero VAD 仓库自带的语音测试样本）
- 许可：MIT（随 silero-vad 仓库分发）
- 处理：裁剪为 3 秒、16kHz、单声道、pcm_s16le（约 94KB），仅用于 `test/silence-trim-media.test.ts` 的 VAD 真实推理验收。
- 说明：合成波形（正弦）会被 Silero VAD 正确判为非语音，因此不能用作 VAD 的语音 fixture；真实的呼吸/静音气口裁剪听感需用真实录音验收。
