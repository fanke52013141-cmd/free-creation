import { describe, expect, it } from 'vitest'
import { DEFAULT_TTS_CONFIG, parseTtsConfig, TTS_FORMATS_BY_BACKEND } from '@shared/tts'

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

  it('相似度与语言增强入库；老配置里的布尔 textValidation 被丢掉', () => {
    const config = parseTtsConfig(
      JSON.stringify({
        backend: 'minimax',
        textValidation: true,
        accuracy: 0.85,
        languageBoost: 'Chinese'
      })
    )
    // 上游的 text_validation 要的是参考音频原文（字符串），布尔值一律 2013；
    // 因此配置里不再保留这个开关，老节点存量的 true 也在解析时被丢弃。
    expect(config).not.toHaveProperty('textValidation')
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

  it('新建节点的空配置默认走云端 MiniMax，格式落在它发得出的取值域', () => {
    const config = parseTtsConfig('{}')
    expect(config.backend).toBe('minimax')
    expect(config.format).toBe('mp3')
    expect(DEFAULT_TTS_CONFIG.backend).toBe('minimax')
    expect(TTS_FORMATS_BY_BACKEND.minimax).not.toContain('wav')
    expect(TTS_FORMATS_BY_BACKEND.comfyui[0]).toBe('wav')
  })

  it('MiniMax 不会保留它发送不了的 wav，本地后端不受影响', () => {
    expect(parseTtsConfig(JSON.stringify({ backend: 'minimax', format: 'wav' })).format).toBe('mp3')
    expect(parseTtsConfig(JSON.stringify({ backend: 'comfyui', format: 'flac' })).format).toBe(
      'flac'
    )
    // 显式选择本地链路是用户的决定，不会被默认值翻回云端。
    expect(parseTtsConfig(JSON.stringify({ backend: 'comfyui' })).backend).toBe('comfyui')
  })
})
