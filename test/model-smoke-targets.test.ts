import { describe, expect, it } from 'vitest'
import { collectSmokeTargets } from '../src/main/model-smoke'
import type { ProviderSummary } from '@shared/types'

const provider: ProviderSummary = {
  id: 'provider-a',
  name: '验收供应商',
  specId: 'volc-speech',
  baseURL: 'https://example.test/v1',
  createdAt: 0,
  hasApiKey: true,
  models: [
    { id: 'text-1', modality: 'text' },
    { id: 'image-1', modality: 'image' },
    { id: 'audio-1', modality: 'audio' },
    { id: 'video-1', modality: 'video' },
    { id: 'text-1', modality: 'text' }
  ]
}

describe('真实模型验收目标选择', () => {
  it('只选择文本、图片、音频，并按供应商/模型/模态去重', () => {
    expect(collectSmokeTargets([provider]).map((target) => [target.kind, target.model.id])).toEqual(
      [
        ['text', 'text-1'],
        ['image', 'image-1'],
        ['speech', 'audio-1']
      ]
    )
  })
})
