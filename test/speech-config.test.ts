// 配音节点「模型驱动配置」的纯函数门禁（Batch C3 / C6）。
//
// 这些断言保护三件事：
//   1. 旧 speech 配置（mode/modelKey/voice/format）不会把项目悄悄改成别的协议；
//   2. 每个协议的取值范围与格式档位在解析层就收敛，不把非法值发到服务端；
//   3. 发音词典与音色修饰只在真的偏离默认值时才出现在请求体里。
import { describe, expect, it } from 'vitest'
import {
  DEFAULT_SPEECH_CONFIG,
  parsePronunciationTones,
  parseSpeechConfig,
  serializeSpeechConfig,
  voiceModifyOf
} from '@shared/speech'

describe('配音配置解析', () => {
  it('空/坏 JSON 回退为 MiniMax 默认通道和读音纠正示例', () => {
    expect(parseSpeechConfig('')).toEqual(DEFAULT_SPEECH_CONFIG)
    expect(parseSpeechConfig('{bad json')).toEqual(DEFAULT_SPEECH_CONFIG)
    expect(DEFAULT_SPEECH_CONFIG.backend).toBe('minimax')
    expect(DEFAULT_SPEECH_CONFIG.pronunciationTones).toContain('重庆/(chong2)(qing4)')
  })

  it('不识别的旧通道回到 MiniMax，且不继承旧供应商和音色 ID', () => {
    const config = parseSpeechConfig(
      JSON.stringify({ mode: 'generate', modelKey: 'prov-1::tts-1', voice: 'nova', format: 'wav' })
    )
    expect(config.backend).toBe('minimax')
    expect(config.providerId).toBe('')
    expect(config.modelId).toBe('speech-2.8-hd')
    expect(config.voiceId).toBe('')
    expect(config.format).toBe('mp3')
  })

  it('旧命名音色不会污染 MiniMax 音色字段', () => {
    const config = parseSpeechConfig(JSON.stringify({ modelKey: 'prov-1::tts-1', voice: 'alloy' }))
    expect(config.voiceId).toBe('')
  })

  it('数值参数按各协议的真实区间收敛', () => {
    const config = parseSpeechConfig(
      JSON.stringify({ speed: 9, volume: -3, pitch: 40, voicePitch: 900, accuracy: 7 })
    )
    expect(config.speed).toBe(2)
    expect(config.volume).toBe(0.01)
    expect(config.pitch).toBe(12)
    expect(config.voicePitch).toBe(100)
  })

  it('火山的语速/音量/音调区间按 1.0 参数收敛', () => {
    const config = parseSpeechConfig(
      JSON.stringify({ backend: 'volc', speechRate: 500, loudnessRate: -500, pitchRate: -40 })
    )
    expect(config.speechRate).toBe(100)
    expect(config.loudnessRate).toBe(-50)
    expect(config.pitchRate).toBe(-12)
  })

  it('配音节点固定采用供应商默认格式和采样率，忽略旧配置里的自定义值', () => {
    const minimax = parseSpeechConfig(
      JSON.stringify({ backend: 'minimax', format: 'flac', sampleRate: 44100 })
    )
    expect(minimax.format).toBe('mp3')
    expect(minimax.sampleRate).toBe(32000)

    const volc = parseSpeechConfig(
      JSON.stringify({ backend: 'volc', format: 'ogg_opus', sampleRate: 48000 })
    )
    expect(volc.format).toBe('wav')
    expect(volc.sampleRate).toBe(40000)
  })

  it('按模型收敛情绪值，语言增强自动判别且读音纠正仅对 MiniMax 保留', () => {
    expect(
      parseSpeechConfig(JSON.stringify({ modelId: 'speech-2.8-hd', emotion: 'whisper' })).emotion
    ).toBe('')
    expect(
      parseSpeechConfig(JSON.stringify({ modelId: 'speech-2.6-turbo', emotion: 'whisper' })).emotion
    ).toBe('whisper')
    const hiddenOptions = parseSpeechConfig(
      JSON.stringify({
        languageBoost: 'Chinese',
        pronunciationTones: '调音台 tiao2 yin1 tai2',
        soundEffects: 'robotic'
      })
    )
    expect(hiddenOptions.languageBoost).toBe('auto')
    expect(hiddenOptions.pronunciationTones).toBe('调音台 tiao2 yin1 tai2')
    expect(hiddenOptions.soundEffects).toBe('')
    expect(
      parseSpeechConfig(
        JSON.stringify({ backend: 'volc', pronunciationTones: '行长/(hang2)(zhang3)' })
      ).pronunciationTones
    ).toBe('')
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
  it('解析 MiniMax 官方读音格式，并兼容早期的空格拼音写法', () => {
    expect(
      parsePronunciationTones('重庆/(chong2)(qing4)\n银行 yin2 hang2\n危险/dangerous\n只有一段')
    ).toEqual(['重庆/(chong2)(qing4)', '银行/(yin2)(hang2)', '危险/dangerous'])
    expect(parsePronunciationTones('')).toEqual([])
  })

  it('未修改任何音色修饰时不产生 voice_modify 字段', () => {
    const config = parseSpeechConfig('{}')
    expect(voiceModifyOf(config)).toBeNull()
  })

  it('遗留音效设置被忽略，不会改变 voice_modify', () => {
    const config = parseSpeechConfig(JSON.stringify({ soundEffects: 'robotic' }))
    expect(config.soundEffects).toBe('')
    expect(voiceModifyOf(config)).toBeNull()
  })
})
