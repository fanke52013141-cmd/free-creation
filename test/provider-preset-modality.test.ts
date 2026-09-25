// 供应商预设 → 节点模型下拉 的链路门禁。
//
// 「填好 Key 就能跑」有一个隐藏前提：按模板新建供应商后，节点要用的那个模型必须
// 真的出现在节点下拉里。语音类节点的下拉一律是 modelsByModality(providers, 'audio')
// 再按协议过滤，于是猜错模态、或预设里缺模型，都会让它凭空消失：
//   - 火山 Seed Audio 的建议模型必须按 audio 建模，配音节点才能列出它；
//   - speech-2.8-hd（配音节点默认值）与 gpt-4o-mini-tts 都不在各自模板的预设里。
// 下面的协议↔供应商对照表刻意按节点契约重写一份，而不是复用组件里的判定：本测试要抓的
// 正是「预设与猜模态」同「节点过滤」对不上，复用同一份判定时两边一起错就测不出来。
import { describe, expect, it } from 'vitest'
import { PROVIDER_SPECS, type ProviderSpecId, type ProviderSummary } from '@shared/types'
import { guessModelModality } from '@shared/provider-driver'
import { modelsByModality } from '@shared/engine/models'
import { DEFAULT_SPEECH_CONFIG, SPEECH_BACKENDS, type SpeechBackend } from '@shared/speech'

/** 复现设置面板新建供应商的路径：模板建议 ID + guessModelModality 的猜测结果。 */
function providerFromSpec(specId: ProviderSpecId): ProviderSummary {
  const spec = PROVIDER_SPECS.find((item) => item.id === specId)
  if (!spec) throw new Error(`缺少供应商模板 ${specId}`)
  return {
    id: `prov-${specId}`,
    name: spec.label,
    specId,
    baseURL: spec.baseURL,
    models: spec.suggestions.map((id) => ({ id, modality: guessModelModality(id, specId) })),
    createdAt: 0,
    hasApiKey: true
  }
}

/** 与配音节点 acceptsProvider 同一契约：协议与供应商实例强绑定。 */
function acceptsSpeechProvider(backend: SpeechBackend, specId: ProviderSpecId): boolean {
  if (backend === 'minimax') return specId === 'minimax'
  return specId === 'volc-speech'
}

const EXPECTED_AUDIO_MODEL: Record<SpeechBackend, string> = {
  minimax: DEFAULT_SPEECH_CONFIG.modelId,
  volc: 'seed-audio-1.0'
}

function audioModelsOf(backend: SpeechBackend): string[] {
  return PROVIDER_SPECS.filter((spec) => acceptsSpeechProvider(backend, spec.id))
    .flatMap((spec) => providerFromSpec(spec.id).models)
    .filter((model) => model.modality === 'audio')
    .map((model) => model.id)
}

describe('供应商预设的模态与语音模型可选性', () => {
  it('火山语音模板只推荐 seed-audio-1.0，并按 audio 建模', () => {
    const provider = providerFromSpec('volc-speech')
    expect(provider.models.length).toBeGreaterThan(0)
    expect(provider.models.every((model) => model.modality === 'audio')).toBe(true)
    const audio = modelsByModality([provider], 'audio').map((option) => option.model.id)
    expect(audio).toContain('seed-audio-1.0')
  })

  it('MiniMax 模板同时给出视频与语音模型，两类节点各取所需', () => {
    const provider = providerFromSpec('minimax')
    const video = modelsByModality([provider], 'video').map((option) => option.model.id)
    const audio = modelsByModality([provider], 'audio').map((option) => option.model.id)
    expect(video).toEqual(expect.arrayContaining(['MiniMax-H3', 'MiniMax-H3-Max']))
    // speech-2.8-turbo 是语音克隆节点的默认值，speech-2.8-hd 是配音节点的默认值。
    expect(audio).toEqual(expect.arrayContaining(['speech-2.8-hd', 'speech-2.8-turbo']))
  })

  it('语音/视频专用模板不会把建议模型猜成 text', () => {
    for (const specId of ['minimax', 'seedance', 'volc-speech'] as ProviderSpecId[]) {
      for (const model of providerFromSpec(specId).models) {
        expect(model.modality, `${specId} · ${model.id}`).not.toBe('text')
      }
    }
  })

  it('每个语音通道都能列出自己的语音模型', () => {
    for (const backend of SPEECH_BACKENDS.map((item) => item.value)) {
      expect(audioModelsOf(backend), `${backend} 通道按模板建好供应商后没有可选语音模型`).toContain(
        EXPECTED_AUDIO_MODEL[backend]
      )
    }
  })
})

// MiniMax 没有 /models 端点（自检那里就写死了），所以它家模型的模态只能按 ID 猜；
// 而同一个 Key 既能调 H3 视频、也能调 speech 语音和 M2 大模型。猜错的代价是不对称的：
// 视频节点不做能力白名单，任何被标成 video 的行都会进下拉并按 FALLBACK 参数发请求。
describe('MiniMax 一个供应商三种产品线时的模态归类', () => {
  it('视频族按视频建模，H3 之外的历史型号也一样', () => {
    for (const id of [
      'MiniMax-H3',
      'MiniMax-H3-Max',
      'MiniMax-Hailuo-02',
      'T2V-01-Director',
      'I2V-01',
      'S2V-01'
    ]) {
      expect(guessModelModality(id, 'minimax'), id).toBe('video')
    }
  })

  it('大模型不再被当成视频模型，语音与图片各归各位', () => {
    for (const id of [
      'MiniMax-M2',
      'MiniMax-M2.1',
      'MiniMax-M1-80k',
      'MiniMax-Text-01',
      'abab6.5s-chat'
    ]) {
      expect(guessModelModality(id, 'minimax'), id).toBe('text')
    }
    expect(guessModelModality('speech-2.8-hd', 'minimax')).toBe('audio')
    expect(guessModelModality('voice-clone-001', 'minimax')).toBe('audio')
    expect(guessModelModality('MiniMax-Image-01', 'minimax')).toBe('image')
  })

  it('认不出型号时仍兜底成视频：新发布的 H 系列不能因为这份表落后就选不到', () => {
    expect(guessModelModality('MiniMax-H4', 'minimax')).toBe('video')
  })

  it('用户手动补的 MiniMax-M2 不会出现在视频节点下拉里', () => {
    const provider = providerFromSpec('minimax')
    provider.models.push({
      id: 'MiniMax-M2',
      modality: guessModelModality('MiniMax-M2', 'minimax')
    })
    const video = modelsByModality([provider], 'video').map((option) => option.model.id)
    expect(video).toEqual(['MiniMax-H3', 'MiniMax-H3-Max'])
    // 反过来，M2 得能在文本通道里被选到，否则用户会以为 MiniMax 的大模型没接上。
    expect(modelsByModality([provider], 'text').map((option) => option.model.id)).toContain(
      'MiniMax-M2'
    )
  })
})
