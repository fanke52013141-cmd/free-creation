import { describe, expect, it } from 'vitest'
import { DEFAULT_TTS_CONFIG, parseTtsConfig } from '@shared/tts'

describe('语音克隆配置', () => {
  it('旧的本地 ComfyUI 配置会安全补齐新的后端字段', () => {
    const config = parseTtsConfig(JSON.stringify({ text: '你好', lang: 'ZH', format: 'mp3' }))
    expect(config).toMatchObject({
      backend: 'comfyui',
      providerId: '',
      modelId: 'speech-2.8-turbo',
      text: '你好',
      lang: 'ZH',
      format: 'mp3'
    })
  })

  it('保留 MiniMax 复刻的供应商、音色和预处理选项', () => {
    const config = parseTtsConfig(
      JSON.stringify({
        backend: 'minimax',
        providerId: 'minimax-main',
        modelId: 'speech-2.8-hd',
        voiceId: 'CanvasVoice_2026',
        needNoiseReduction: true,
        needVolumeNormalization: true,
        aigcWatermark: true
      })
    )
    expect(config).toMatchObject({
      backend: 'minimax',
      providerId: 'minimax-main',
      modelId: 'speech-2.8-hd',
      voiceId: 'CanvasVoice_2026',
      needNoiseReduction: true,
      needVolumeNormalization: true,
      aigcWatermark: true
    })
  })

  it('无效配置始终回退为可执行的本地默认值', () => {
    expect(parseTtsConfig('{bad json')).toEqual(DEFAULT_TTS_CONFIG)
  })
})
