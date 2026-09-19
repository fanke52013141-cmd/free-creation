// 供应商预设 → 节点模型下拉 的链路门禁。
//
// 「填好 Key 就能跑」有一个隐藏前提：按模板新建供应商后，节点要用的那个模型必须
// 真的出现在节点下拉里。语音类节点的下拉一律是 modelsByModality(providers, 'audio')
// 再按协议过滤，于是猜错模态、或预设里缺模型，都会让它凭空消失：
//   - 豆包语音（Seed-Audio）的建议模型曾被猜成 text，配音节点的豆包/火山通道列出 0 个模型；
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
  // 火山语音合成 1.0 与豆包共用 openspeech 供应商实例，只是路径不同。
  if (backend === 'doubao' || backend === 'volc') return specId === 'doubao-speech'
  return specId !== 'minimax' && specId !== 'doubao-speech'
}

/** 该通道可选中的语音模型：新建节点即写入的默认值，或兼容通道的预设语音模型。 */
const EXPECTED_AUDIO_MODEL: Record<SpeechBackend, string> = {
  minimax: DEFAULT_SPEECH_CONFIG.modelId,
  doubao: 'seed-audio-1.0',
  // 1.0 端点只吃 cluster + voice_type，这里查的是该通道至少列得出模型。
  volc: 'seed-audio-1.0',
  // OpenAI 兼容通道各家端点不同、没有统一默认，预设里至少要有一个可选语音模型。
  openai: 'gpt-4o-mini-tts'
}

function audioModelsOf(backend: SpeechBackend): string[] {
  return PROVIDER_SPECS.filter((spec) => acceptsSpeechProvider(backend, spec.id))
    .flatMap((spec) => providerFromSpec(spec.id).models)
    .filter((model) => model.modality === 'audio')
    .map((model) => model.id)
}

describe('供应商预设的模态与语音模型可选性', () => {
  it('豆包语音模板的建议模型全部按 audio 建模，语音通道才列得出模型', () => {
    const provider = providerFromSpec('doubao-speech')
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
    for (const specId of ['minimax', 'seedance', 'doubao-speech'] as ProviderSpecId[]) {
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
