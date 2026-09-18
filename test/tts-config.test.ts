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

  it('补齐 MiniMax 复刻的文本校验、相似度与语言增强', () => {
    const config = parseTtsConfig(
      JSON.stringify({
        backend: 'minimax',
        textValidation: true,
        accuracy: 0.85,
        languageBoost: 'Chinese'
      })
    )
    expect(config.textValidation).toBe(true)
    expect(config.accuracy).toBe(0.85)
    expect(config.languageBoost).toBe('Chinese')
  })

  it('相似度收敛到 [0,1]，越界值回落到默认 0.7', () => {
    expect(parseTtsConfig(JSON.stringify({ accuracy: 5 })).accuracy).toBe(1)
    expect(parseTtsConfig(JSON.stringify({ accuracy: -1 })).accuracy).toBe(0)
    expect(parseTtsConfig(JSON.stringify({ accuracy: 'x' })).accuracy).toBe(0.7)
  })

  it('克隆提示音（clone_prompt）的音频与原文一起保存', () => {
    const config = parseTtsConfig(
      JSON.stringify({
        backend: 'minimax',
        promptMediaId: 'prompt-audio',
        promptMediaPath: 'projects/p/prompt.wav',
        promptMediaMime: 'audio/wav',
        promptMediaName: '提示音',
        promptText: '这是一段提示音原文'
      })
    )
    expect(config).toMatchObject({
      promptMediaId: 'prompt-audio',
      promptMediaPath: 'projects/p/prompt.wav',
      promptMediaMime: 'audio/wav',
      promptMediaName: '提示音',
      promptText: '这是一段提示音原文'
    })
  })

  it('本地 ComfyUI 默认配置不含任何 MiniMax 专属参数', () => {
    const config = parseTtsConfig('{}')
    expect(config.backend).toBe('comfyui')
    expect(config.textValidation).toBe(false)
    expect(config.promptMediaId).toBe('')
    expect(config.languageBoost).toBe('')
  })
})
