// 配音节点「模型驱动配置」的纯函数门禁（Batch C3 / C6）。
//
// 这些断言保护三件事：
//   1. 旧 speech 配置（mode/modelKey/voice/format）不会把项目悄悄改成别的协议；
//   2. 每个协议的取值范围与格式档位在解析层就收敛，不把非法值发到服务端；
//   3. 发音词典与音色修饰只在真的偏离默认值时才出现在请求体里。
import { describe, expect, it } from 'vitest'
import {
  DEFAULT_SPEECH_CONFIG,
  SPEECH_FORMATS_BY_BACKEND,
  parsePronunciationTones,
  parseSpeechConfig,
  serializeSpeechConfig,
  voiceModifyOf
} from '@shared/speech'

describe('配音配置解析', () => {
  it('空/坏 JSON 回退为 MiniMax 默认通道', () => {
    expect(parseSpeechConfig('')).toEqual(DEFAULT_SPEECH_CONFIG)
    expect(parseSpeechConfig('{bad json')).toEqual(DEFAULT_SPEECH_CONFIG)
    expect(DEFAULT_SPEECH_CONFIG.backend).toBe('minimax')
  })

  it('旧 speech 配置迁移为 openai 兼容通道，并拆出 provider/model', () => {
    const config = parseSpeechConfig(
      JSON.stringify({ mode: 'generate', modelKey: 'prov-1::tts-1', voice: 'nova', format: 'wav' })
    )
    expect(config.backend).toBe('openai')
    expect(config.providerId).toBe('prov-1')
    expect(config.modelId).toBe('tts-1')
    expect(config.voiceId).toBe('nova')
    expect(config.format).toBe('wav')
  })

  it('OpenAI 命名音色不会污染 MiniMax/豆包音色字段', () => {
    const config = parseSpeechConfig(JSON.stringify({ modelKey: 'prov-1::tts-1', voice: 'alloy' }))
    expect(config.voiceId).toBe('')
  })

  it('数值参数按各协议的真实区间收敛', () => {
    const config = parseSpeechConfig(
      JSON.stringify({ speed: 9, volume: -3, pitch: 40, voicePitch: 900, accuracy: 7 })
    )
    expect(config.speed).toBe(2)
    expect(config.volume).toBe(0.1)
    expect(config.pitch).toBe(12)
    expect(config.voicePitch).toBe(100)
  })

  it('豆包的语速/音量/音调区间与 MiniMax 不同，必须分别收敛', () => {
    const config = parseSpeechConfig(
      JSON.stringify({ backend: 'doubao', speechRate: 500, loudnessRate: -500, pitchRate: -40 })
    )
    expect(config.speechRate).toBe(100)
    expect(config.loudnessRate).toBe(-50)
    expect(config.pitchRate).toBe(-12)
  })

  it('输出格式按协议收窄：豆包不支持 flac，MiniMax 不支持 ogg_opus', () => {
    expect(parseSpeechConfig(JSON.stringify({ backend: 'doubao', format: 'flac' })).format).toBe(
      SPEECH_FORMATS_BY_BACKEND.doubao[0]
    )
    expect(
      parseSpeechConfig(JSON.stringify({ backend: 'minimax', format: 'ogg_opus' })).format
    ).toBe(SPEECH_FORMATS_BY_BACKEND.minimax[0])
    expect(
      parseSpeechConfig(JSON.stringify({ backend: 'doubao', format: 'ogg_opus' })).format
    ).toBe('ogg_opus')
  })

  it('未知情绪回落为空串，采样率/码率只接受受控档位', () => {
    const config = parseSpeechConfig(
      JSON.stringify({ emotion: 'excited', sampleRate: 12345, bitrate: 999 })
    )
    expect(config.emotion).toBe('')
    expect(config.sampleRate).toBe(DEFAULT_SPEECH_CONFIG.sampleRate)
    expect(config.bitrate).toBe(DEFAULT_SPEECH_CONFIG.bitrate)
  })

  it('序列化后可原样解析回来（保存模型往返一致）', () => {
    const config = parseSpeechConfig(
      JSON.stringify({
        backend: 'minimax',
        providerId: 'minimax-main',
        voiceId: 'CanvasVoice_2026',
        speed: 1.3,
        emotion: 'happy',
        languageBoost: 'Chinese',
        enableSubtitle: true,
        aigcWatermark: true
      })
    )
    expect(parseSpeechConfig(serializeSpeechConfig(config))).toEqual(config)
  })
})

describe('发音词典与音色修饰', () => {
  it('每行「词 拼音」解析为 tone 数组，坏行被丢弃而不是发出去', () => {
    expect(parsePronunciationTones('调音台 tiao2 yin1 tai2\n\n好  hao3\n只有一段')).toEqual([
      '调音台 tiao2 yin1 tai2',
      '好 hao3'
    ])
    expect(parsePronunciationTones('')).toEqual([])
  })

  it('未修改任何音色修饰时不产生 voice_modify 字段', () => {
    const config = parseSpeechConfig('{}')
    expect(voiceModifyOf(config)).toBeNull()
  })

  it('只改音效也会产生 voice_modify', () => {
    const config = parseSpeechConfig(JSON.stringify({ soundEffects: 'robotic' }))
    expect(voiceModifyOf(config)).toEqual({
      pitch: 0,
      intensity: 0,
      timbre: 0,
      sound_effects: 'robotic'
    })
  })
})
