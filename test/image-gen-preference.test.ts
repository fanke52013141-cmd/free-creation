import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  imageGenInitialConfig,
  readImageGenSelection,
  rememberImageGenSelection
} from '../src/renderer/src/stores/imageGenPreference'
import type { ProviderSummary } from '../src/shared/types'

const memory = new Map<string, string>()

beforeEach(() => {
  memory.clear()
  ;(globalThis as Record<string, unknown>).localStorage = {
    getItem: (key: string) => memory.get(key) ?? null,
    setItem: (key: string, value: string) => {
      memory.set(key, value)
    },
    removeItem: (key: string) => {
      memory.delete(key)
    }
  }
})

afterEach(() => {
  delete (globalThis as Record<string, unknown>).localStorage
})

const providers = [
  {
    id: 'relay-a',
    name: '中转站 A',
    specId: 'relay',
    baseURL: 'https://a.example/v1',
    apiKey: 'k',
    models: [{ id: 'gpt-image-2.6', name: 'GPT Image 2.6', modality: 'image' }],
    createdAt: 0
  }
] as unknown as ProviderSummary[]

describe('生图供应商选择记忆', () => {
  it('无记忆时新建节点回退默认（undefined）', () => {
    expect(imageGenInitialConfig(providers)).toBeUndefined()
  })

  it('记住的选择成为新建生图节点初始配置', () => {
    rememberImageGenSelection({ providerKey: 'relay-a', modelKey: 'relay-a::gpt-image-2.6' })
    expect(readImageGenSelection()).toEqual({
      providerKey: 'relay-a',
      modelKey: 'relay-a::gpt-image-2.6'
    })
    const config = imageGenInitialConfig(providers)
    expect(config).toBeDefined()
    expect(JSON.parse(config as string)).toEqual({
      providerKey: 'relay-a',
      modelKey: 'relay-a::gpt-image-2.6'
    })
  })

  it('记忆的供应商/模型已不在目录时回退默认', () => {
    rememberImageGenSelection({ providerKey: 'gone', modelKey: 'gone::m' })
    expect(imageGenInitialConfig(providers)).toBeUndefined()
  })
})