// 供应商列表是渲染进程的公开边界，绝不能把解密后的 API Key 带过 IPC。
import { describe, expect, it, vi } from 'vitest'

const rows = [
  {
    id: 'provider-1',
    name: '测试供应商',
    spec_id: 'relay',
    base_url: 'https://example.test/v1',
    api_key_ref: 'enc:secret-material',
    models: JSON.stringify([{ id: 'chat-1', modality: 'text' }]),
    created_at: 1
  }
]

vi.mock('../src/main/store/db', () => ({
  getDb: () => ({
    prepare: () => ({
      all: () => rows,
      get: (id: string) => rows.find((row) => row.id === id)
    })
  })
}))

vi.mock('../src/main/gateway/keycrypto', () => ({
  decryptSecret: () => 'sk-should-never-leave-main',
  encryptSecret: (value: string) => `enc:${value}`
}))

import { listProviders } from '../src/main/gateway/providers.repo'

describe('供应商公开摘要', () => {
  it('列表不解密也不返回 API Key，仅报告是否已配置', () => {
    const [provider] = listProviders()
    expect(provider).toMatchObject({
      id: 'provider-1',
      hasApiKey: true,
      models: [{ id: 'chat-1', modality: 'text' }]
    })
    expect(provider).not.toHaveProperty('apiKey')
    expect(JSON.stringify(provider)).not.toContain('secret-material')
  })
})
