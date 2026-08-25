// API Key 加密工具测试（路线图 R7 / 发布与数据安全）
//
// 覆盖 keycrypto.ts 的加密/解密/旧数据兼容逻辑。safeStorage 用 vi.mock 模拟，
// 分别切到「可用 / 不可用」状态，验证 enc:/plain: 前缀与旧裸明文三种存储形态。
import { describe, it, expect, vi, beforeEach } from 'vitest'

// mock electron 的 safeStorage
const safeStorageState = {
  available: true,
  encrypt: (s: string): Buffer => Buffer.from(`enc:${s}`)
}
vi.mock('electron', () => ({
  safeStorage: {
    isEncryptionAvailable: () => safeStorageState.available,
    encryptString: (s: string) => safeStorageState.encrypt(s),
    decryptString: (buf: Buffer) => buf.toString('utf8').replace(/^enc:/, '')
  }
}))

import {
  encryptSecret,
  decryptSecret,
  isEncryptedSecret,
  encryptionAvailable
} from '../src/main/gateway/keycrypto'

beforeEach(() => {
  safeStorageState.available = true
  safeStorageState.encrypt = (s: string): Buffer => Buffer.from(`enc:${s}`)
})

describe('encryptionAvailable', () => {
  it('safeStorage 可用时返回 true', () => {
    safeStorageState.available = true
    expect(encryptionAvailable()).toBe(true)
  })
  it('safeStorage 不可用时返回 false', () => {
    safeStorageState.available = false
    expect(encryptionAvailable()).toBe(false)
  })
})

describe('encryptSecret', () => {
  it('safeStorage 可用时以 enc: 前缀加密', () => {
    safeStorageState.available = true
    const stored = encryptSecret('sk-test')
    expect(stored.startsWith('enc:')).toBe(true)
    expect(isEncryptedSecret(stored)).toBe(true)
  })

  it('safeStorage 不可用时降级为 plain: 前缀', () => {
    safeStorageState.available = false
    const stored = encryptSecret('sk-test')
    expect(stored.startsWith('plain:')).toBe(true)
    expect(isEncryptedSecret(stored)).toBe(false)
  })

  it('空串返回空串（不入库）', () => {
    expect(encryptSecret('')).toBe('')
  })
})

describe('decryptSecret', () => {
  it('解 enc: 密文还原原始密钥', () => {
    safeStorageState.available = true
    const stored = encryptSecret('sk-abc')
    expect(decryptSecret(stored)).toBe('sk-abc')
  })

  it('解 plain: 明文 base64', () => {
    const stored = `plain:${Buffer.from('sk-plain', 'utf8').toString('base64')}`
    expect(decryptSecret(stored)).toBe('sk-plain')
  })

  it('兼容旧版裸明文（无前缀）', () => {
    expect(decryptSecret('sk-legacy')).toBe('sk-legacy')
  })

  it('空/空串返回空串', () => {
    expect(decryptSecret('')).toBe('')
    expect(decryptSecret(null)).toBe('')
  })

  it('safeStorage 不可用时 enc: 密文无法解密返回空串', () => {
    safeStorageState.available = true
    const stored = encryptSecret('sk-x')
    safeStorageState.available = false
    expect(decryptSecret(stored)).toBe('')
  })
})
