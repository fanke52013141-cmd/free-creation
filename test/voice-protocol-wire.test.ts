// 音色能力协议 wire 断言（Batch C3 / C4 / C5 / C6）。
//
// 只断言「发出去的请求体」与「对返回值的解码」，不 mock 整个主进程：
// 请求体是纯函数，返回值解码走可单独调用的解析函数，因此这里的失败都能
// 精确定位到某个字段，而不是「网关挂了」。
import { describe, expect, it } from 'vitest'
import { buildDoubaoSpeechBody, buildMiniMaxAsyncTtsBody } from '../src/main/gateway/audio'
import { buildVoiceCloneBody, buildVoiceDesignBody } from '../src/main/gateway/voice'
import { DEFAULT_SPEECH_CONFIG, parseSpeechConfig } from '../src/shared/speech'
import { DEFAULT_TTS_CONFIG, parseTtsConfig, isValidMiniMaxVoiceId } from '../src/shared/tts'
import {
  DEFAULT_VOICE_DESIGN_CONFIG,
  parseVoiceDesignConfig,
  parseVoiceProfile
} from '../src/shared/voice-design'

const speechConfig = (patch: Record<string, unknown> = {}) =>
  parseSpeechConfig(JSON.stringify(patch))

describe('MiniMax 异步语音合成 t2a_async_v2', () => {
  it('发送完整的 voice_setting / audio_setting 参数面', () => {
    const body = buildMiniMaxAsyncTtsBody(
      { modelId: 'speech-2.8-hd', text: '  你好世界  ', voiceId: 'CanvasVoice_2026' },
      speechConfig({
        speed: 1.25,
        volume: 2,
        pitch: -3,
        emotion: 'happy',
        englishNormalization: true,
        format: 'flac',
        sampleRate: 44100,
        bitrate: 256000,
        audioChannel: 2,
        languageBoost: 'Chinese',
        aigcWatermark: true
      })
    )
    expect(body).toEqual({
      model: 'speech-2.8-hd',
      text: '你好世界',
      voice_setting: {
        voice_id: 'CanvasVoice_2026',
        speed: 1.25,
        vol: 2,
        pitch: -3,
        emotion: 'happy',
        english_normalization: true
      },
      audio_setting: {
        audio_sample_rate: 44100,
        bitrate: 256000,
        format: 'flac',
        channel: 2
      },
      language_boost: 'Chinese',
      aigc_watermark: true
    })
  })

  it('未指定音色时不伪造 voice_id，可选项为空时不出现空字段', () => {
    const body = buildMiniMaxAsyncTtsBody(
      { modelId: 'speech-2.8-hd', text: '你好', voiceId: '' },
      speechConfig({ emotion: '', englishNormalization: false, pronunciationTones: '' })
    )
    expect(body.voice_setting).toEqual({ speed: 1, vol: 1, pitch: 0 })
    expect(body).not.toHaveProperty('pronunciation_dict')
    expect(body).not.toHaveProperty('voice_modify')
  })

  it('发音词典与音色修饰按解析结果写入', () => {
    const body = buildMiniMaxAsyncTtsBody(
      { modelId: 'speech-2.8-turbo', text: '你好', voiceId: '' },
      speechConfig({
        pronunciationTones: '调音台 tiao2 yin1 tai2',
        soundEffects: 'spacious_echo',
        voicePitch: 20
      })
    )
    expect(body.pronunciation_dict).toEqual({ tone: ['调音台 tiao2 yin1 tai2'] })
    expect(body.voice_modify).toEqual({
      pitch: 20,
      intensity: 0,
      timbre: 0,
      sound_effects: 'spacious_echo'
    })
  })

  it('MiniMax 只接受 mp3/pcm/flac，wav 请求回落 mp3', () => {
    const body = buildMiniMaxAsyncTtsBody(
      { modelId: 'speech-2.8-hd', text: '你好', voiceId: '' },
      speechConfig({ backend: 'minimax', format: 'wav' })
    )
    expect((body.audio_setting as Record<string, unknown>).format).toBe('mp3')
  })
})

describe('豆包语音合成 /api/v3/tts/create', () => {
  it('只发送文档化字段：speaker 与 audio_config / watermark / aigc_metadata', () => {
    const body = buildDoubaoSpeechBody(
      { modelId: 'seed-audio-1.0', text: '  你好  ', voiceId: 'speaker-a' },
      speechConfig({
        backend: 'doubao',
        speechRate: 20,
        loudnessRate: -10,
        pitchRate: 2,
        enableSubtitle: true,
        format: 'ogg_opus',
        sampleRate: 24000
      })
    )
    expect(body).toEqual({
      model: 'seed-audio-1.0',
      text_prompt: '你好',
      speaker: 'speaker-a',
      audio_config: {
        format: 'ogg_opus',
        sample_rate: 24000,
        speech_rate: 20,
        loudness_rate: -10,
        pitch_rate: 2,
        enable_subtitle: true
      },
      watermark: { aigc_watermark: false },
      aigc_metadata: { enable: false }
    })
  })

  it('未接入的 references / audio_data / audio_url 不出现在请求体里', () => {
    const body = buildDoubaoSpeechBody(
      { modelId: 'seed-audio-1.0', text: '你好', voiceId: '' },
      speechConfig({ backend: 'doubao' })
    )
    expect(body).not.toHaveProperty('references')
    expect(body).not.toHaveProperty('audio_data')
    expect(body).not.toHaveProperty('audio_url')
    expect(body).not.toHaveProperty('speaker')
  })
})

describe('MiniMax 快速复刻 voice_clone', () => {
  it('补全的复刻参数都进入请求体', () => {
    const config = parseTtsConfig(
      JSON.stringify({
        backend: 'minimax',
        modelId: 'speech-2.8-hd',
        voiceId: 'CanvasVoice_2026',
        textValidation: true,
        accuracy: 0.85,
        needNoiseReduction: true,
        needVolumeNormalization: true,
        aigcWatermark: true,
        languageBoost: 'Chinese'
      })
    )
    expect(buildVoiceCloneBody(12345, 'CanvasVoice_2026', config, null)).toEqual({
      file_id: 12345,
      voice_id: 'CanvasVoice_2026',
      model: 'speech-2.8-hd',
      text_validation: true,
      accuracy: 0.85,
      need_noise_reduction: true,
      need_volume_normalization: true,
      aigc_watermark: true,
      language_boost: 'Chinese'
    })
  })

  it('有提示音时才出现 clone_prompt', () => {
    const withPrompt = buildVoiceCloneBody(1, 'CanvasVoice_2026', DEFAULT_TTS_CONFIG, {
      prompt_audio: 77,
      prompt_text: '这是一段提示音原文'
    })
    expect(withPrompt.clone_prompt).toEqual({
      prompt_audio: 77,
      prompt_text: '这是一段提示音原文'
    })
    expect(buildVoiceCloneBody(1, 'CanvasVoice_2026', DEFAULT_TTS_CONFIG, null)).not.toHaveProperty(
      'clone_prompt'
    )
  })

  it('Voice ID 规则与官方约束一致：长度 [8,256]、字母开头、末位不可为 - 或 _', () => {
    expect(isValidMiniMaxVoiceId('CanvasVoice_2026')).toBe(true)
    expect(isValidMiniMaxVoiceId('abcdefgh')).toBe(true)
    // 7 位太短 / 257 位太长
    expect(isValidMiniMaxVoiceId('abcdefg')).toBe(false)
    expect(isValidMiniMaxVoiceId(`a${'b'.repeat(256)}`)).toBe(false)
    // 数字开头
    expect(isValidMiniMaxVoiceId('1bcdefgh')).toBe(false)
    // 末位是 - 或 _
    expect(isValidMiniMaxVoiceId('abcdefg-')).toBe(false)
    expect(isValidMiniMaxVoiceId('abcdefg_')).toBe(false)
    // 非法字符
    expect(isValidMiniMaxVoiceId('abc defgh')).toBe(false)
  })
})

describe('MiniMax 音色设计 voice_design', () => {
  it('只发送 prompt / preview_text / voice_id / aigc_watermark', () => {
    expect(buildVoiceDesignBody('清亮女声', '你好', 'CanvasVoice_2026', true)).toEqual({
      prompt: '清亮女声',
      preview_text: '你好',
      voice_id: 'CanvasVoice_2026',
      aigc_watermark: true
    })
  })

  it('未指定自定义 voice_id 时不发送该字段', () => {
    const body = buildVoiceDesignBody('清亮女声', '你好', '', false)
    expect(body).not.toHaveProperty('voice_id')
    expect(body).not.toHaveProperty('model')
  })

  it('试听文本上限 500 字符，在解析层就被截断', () => {
    const long = 'a'.repeat(900)
    const config = parseVoiceDesignConfig(JSON.stringify({ previewText: long }))
    expect(config.previewText).toHaveLength(500)
    expect(parseVoiceDesignConfig('{bad').previewText).toBe(DEFAULT_VOICE_DESIGN_CONFIG.previewText)
  })
})

describe('音色档案 voice.profile', () => {
  it('voice_id 是唯一必填字段，缺失即视为无效档案', () => {
    expect(parseVoiceProfile({ voice_id: 'CanvasVoice_2026' })).toEqual({
      voice_id: 'CanvasVoice_2026'
    })
    expect(parseVoiceProfile({ voice_id: '   ' })).toBeNull()
    expect(parseVoiceProfile({ label: '没有 ID' })).toBeNull()
    expect(parseVoiceProfile(null)).toBeNull()
    expect(parseVoiceProfile(['CanvasVoice_2026'])).toBeNull()
  })

  it('保留来源信息但忽略未知字段', () => {
    expect(
      parseVoiceProfile({
        voice_id: 'CanvasVoice_2026',
        provider: 'minimax',
        source: 'voice_design',
        label: '清亮女声',
        preview_media_id: 'media-1',
        secret: 'should-not-leak'
      })
    ).toEqual({
      voice_id: 'CanvasVoice_2026',
      provider: 'minimax',
      source: 'voice_design',
      label: '清亮女声',
      preview_media_id: 'media-1'
    })
  })
})
