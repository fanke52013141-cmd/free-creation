/**
 * F11 回归测试：编辑供应商未提交新密钥时逐字节保留原密文
 * （HANDOFF_2026_09_15_CODE_REVIEW）
 *
 * 缺陷背景：saveProvider 的 api_key_ref 通过 decryptSecret → encryptSecret 往返
 * 生成。safeStorage 暂不可用时 decryptSecret 返回空串，空串被 encryptSecret
 * 重新加密落盘（实际为 null/空），密文永久丢失。
 *
 * 修复语义：直接读取原始 ProviderRow.api_key_ref 原样写回；只有用户提交了新
 * apiKey 或新建供应商时才调用 encryptSecret。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

// ── 可变 keycrypto 状态：模拟 safeStorage 可用性切换 ──

const cryptoState = vi.hoisted(() => ({
  available: true,
  decryptFails: false
}))

vi.mock('electron', () => ({
  safeStorage: {
    isEncryptionAvailable: () => cryptoState.available,
    encryptString: (s: string) => Buffer.from(`enc:${s}`),
    decryptString: (buf: Buffer) => {
      const text = buf.toString('utf8').replace(/^enc:/, '')
      if (cryptoState.decryptFails) throw new Error('解密失败（注入）')
      return text
    }
  }
}))

// ── 可变行存储 ──

interface ProviderRow {
  id: string
  name: string
  spec_id: string
  base_url: string
  api_key_ref: string | null
  models: string
  created_at: number
}

const dbState = vi.hoisted(() => ({ rows: new Map<string, Record<string, unknown>>() }))

vi.mock('../src/main/store/db', () => ({
  getDb: () => ({
    prepare: (sql: string) => ({
      all: () => [...dbState.rows.values()],
      get: (id: string) => dbState.rows.get(id),
      run: (row: Record<string, unknown>) => {
        if (sql.includes('INSERT INTO providers')) {
          dbState.rows.set(row.id as string, { ...row })
        }
        return { changes: 1 }
      }
    })
  })
}))

import { saveProvider, getProvider, listProviders } from '../src/main/gateway/providers.repo'
import { encryptSecret, decryptSecret } from '../src/main/gateway/keycrypto'

const ORIGINAL_CIPHER = 'enc:' + Buffer.from('original-secret', 'utf8').toString('base64')

beforeEach(() => {
  dbState.rows.clear()
  cryptoState.available = true
  cryptoState.decryptFails = false
  dbState.rows.set('p1', {
    id: 'p1',
    name: '原供应商',
    spec_id: 'relay',
    base_url: 'https://old.example/v1',
    api_key_ref: ORIGINAL_CIPHER,
    models: JSON.stringify([{ id: 'chat-1', modality: 'text' }]),
    created_at: 100
  })
})

describe('saveProvider 密文保留（F11）', () => {
  it('未提交新 apiKey 时 api_key_ref 逐字节保留（即使解密不可用）', () => {
    // 模拟 safeStorage 暂不可用：decryptSecret 返回空串
    cryptoState.available = false
    const summary = saveProvider({
      id: 'p1',
      name: '只改名',
      specId: 'relay',
      baseURL: 'https://new.example/v1',
      apiKey: undefined,
      models: [{ id: 'chat-2', modality: 'text' }]
    })
    // 修复前：existing.apiKey 为空串 → falsy → api_key_ref 被写成 null，密文丢失
    // 修复后：原始密文原样保留
    expect(dbState.rows.get('p1')!.api_key_ref).toBe(ORIGINAL_CIPHER)
    expect(summary.hasApiKey).toBe(true)
    // 其余字段正常更新
    expect(dbState.rows.get('p1')!.name).toBe('只改名')
    expect(dbState.rows.get('p1')!.base_url).toBe('https://new.example/v1')
  })

  it('提交了新 apiKey 时正常重新加密', () => {
    cryptoState.available = false // 加密降级为 plain:，但不影响断言
    saveProvider({
      id: 'p1',
      name: '换密钥',
      specId: 'relay',
      baseURL: 'https://old.example/v1',
      apiKey: 'sk-new-key',
      models: []
    })
    const stored = dbState.rows.get('p1')!.api_key_ref as string
    expect(stored).not.toBe(ORIGINAL_CIPHER)
    expect(stored.length).toBeGreaterThan(0)
  })

  it('getProvider 在解密恢复后仍能读出原始密钥（密文未损坏）', () => {
    cryptoState.available = false
    saveProvider({
      id: 'p1',
      name: '只改名',
      specId: 'relay',
      baseURL: 'https://new.example/v1',
      apiKey: undefined,
      models: []
    })
    // 解密能力恢复后，原密文仍可解出（原始明文为 'original-secret'）
    cryptoState.available = true
    cryptoState.decryptFails = false
    const config = getProvider('p1')
    expect(config?.apiKey).toBe('original-secret')
  })

  it('真正解密失败时也不破坏密文（enc: 密文完好保留）', () => {
    cryptoState.decryptFails = true // decryptString 抛错 → decryptSecret 返回 ''
    saveProvider({
      id: 'p1',
      name: '改名不改钥',
      specId: 'relay',
      baseURL: 'https://old.example/v1',
      apiKey: undefined,
      models: []
    })
    expect(dbState.rows.get('p1')!.api_key_ref).toBe(ORIGINAL_CIPHER)
  })

  it('列表摘要仍不泄露密钥（回归 providers-security 语义）', () => {
    const list = listProviders()
    expect(list[0]).toMatchObject({ id: 'p1', hasApiKey: true })
    expect(list[0]).not.toHaveProperty('apiKey')
    expect(JSON.stringify(list[0])).not.toContain('original-secret')
  })
})

describe('keycrypto 前缀约定（背景回归）', () => {
  it('encryptSecret 在 safeStorage 可用时输出 enc: 前缀', () => {
    expect(encryptSecret('abc')).toMatch(/^enc:/)
  })
  it('encryptSecret 在不可用时降级 plain: 前缀且可解回', () => {
    cryptoState.available = false
    const stored = encryptSecret('abc')
    expect(stored).toMatch(/^plain:/)
    expect(decryptSecret(stored)).toBe('abc')
  })
})
