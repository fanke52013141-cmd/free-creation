// API Key 加密工具测试（路线图 R7 / P2 收口）
//
// 覆盖 keycrypto.ts 的加密/解密/旧数据兼容逻辑。safeStorage 用 vi.mock 模拟，
// 分别切到「可用 / 不可用」状态。P2 起：明文回退已停用——safeStorage 不可用时
// encryptSecret 必须抛错拒绝保存；plain:/裸值只保留读取兼容（迁移路径）。
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
  isVaultRef,
  parseVaultRef,
  vaultRef,
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

describe('encryptSecret（P2：明文回退已停用）', () => {
  it('safeStorage 可用时以 enc: 前缀加密', () => {
    safeStorageState.available = true
    const stored = encryptSecret('sk-test')
    expect(stored.startsWith('enc:')).toBe(true)
    expect(isEncryptedSecret(stored)).toBe(true)
  })

  it('safeStorage 不可用时抛错拒绝保存（绝不降级明文）', () => {
    safeStorageState.available = false
    expect(() => encryptSecret('sk-test')).toThrowError(/SECRET_ENCRYPTION_UNAVAILABLE/)
  })

  it('加密失败抛错拒绝保存（绝不降级明文）', () => {
    safeStorageState.encrypt = (): Buffer => {
      throw new Error('dpapi broken')
    }
    expect(() => encryptSecret('sk-test')).toThrowError(/SECRET_ENCRYPTION_FAILED/)
  })

  it('空串返回空串（不入库）', () => {
    expect(encryptSecret('')).toBe('')
  })
})

describe('vault 引用', () => {
  it('解析与组装往返', () => {
    const ref = vaultRef('connection', 'conn-1')
    expect(isVaultRef(ref)).toBe(true)
    expect(parseVaultRef(ref)).toEqual({ kind: 'connection', id: 'conn-1' })
    expect(parseVaultRef(vaultRef('provider', 'p1'))).toEqual({ kind: 'provider', id: 'p1' })
  })

  it('非法引用与普通值返回 null/否', () => {
    expect(isVaultRef('enc:AAAA')).toBe(false)
    expect(isVaultRef(null)).toBe(false)
    expect(parseVaultRef('vault:bad')).toBeNull()
    expect(parseVaultRef('vault:weird:too:many')).toBeNull()
    // decryptSecret 不处理 vault 引用（防御性返回空）。
    expect(decryptSecret(vaultRef('connection', 'c1'))).toBe('')
  })
})

describe('decryptSecret（兼容读取）', () => {
  it('解 enc: 密文还原原始密钥', () => {
    safeStorageState.available = true
    const stored = encryptSecret('sk-abc')
    expect(decryptSecret(stored)).toBe('sk-abc')
  })

  it('解 plain: 明文 base64（仅迁移兼容读取）', () => {
    const stored = `plain:${Buffer.from('sk-plain', 'utf8').toString('base64')}`
    expect(decryptSecret(stored)).toBe('sk-plain')
  })

  it('兼容旧版裸明文（无前缀，仅迁移兼容读取）', () => {
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
