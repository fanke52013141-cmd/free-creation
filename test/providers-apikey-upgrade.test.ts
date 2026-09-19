/**
 * 启动时的历史明文 Key 收口（upgradeLegacyApiKeys）。
 *
 * safeStorage 加密是在 providers 表落库之后才上线的，所以真实用户库里既有 enc: 行
 * 也有加密前的裸明文行——密钥至今明文躺在 app.db 里。这里用真实的 keycrypto 语义
 * （只 mock electron 的 safeStorage 与 db）验证：明文行升级、密文行不动、
 * 无加密能力时一行都不写。
 */
import { describe, expect, it, vi } from 'vitest'

const cryptoState = vi.hoisted(() => ({ available: true }))

vi.mock('electron', () => ({
  safeStorage: {
    isEncryptionAvailable: () => cryptoState.available,
    encryptString: (s: string) => Buffer.from(`enc:${s}`),
    decryptString: (buf: Buffer) => buf.toString('utf8').replace(/^enc:/, '')
  }
}))

interface Row {
  id: string
  api_key_ref: string | null
}

const rows = new Map<string, Row>()
const writes: string[] = []

vi.mock('../src/main/store/db', () => ({
  getDb: () => ({
    prepare: (sql: string) => ({
      all: () => [...rows.values()],
      run: (...args: unknown[]) => {
        if (sql.startsWith('UPDATE providers SET api_key_ref')) {
          const [ref, id] = args as [string, string]
          writes.push(id)
          rows.get(id)!.api_key_ref = ref
        }
        return { changes: 1 }
      }
    })
  })
}))

import { upgradeLegacyApiKeys } from '../src/main/gateway/providers.repo'
import { decryptSecret, encryptSecret } from '../src/main/gateway/keycrypto'

const BARE_KEY = 'sk-bare-legacy'
const PLAIN_KEY = 'sk-downgraded'

function seedRows(): void {
  rows.clear()
  writes.length = 0
  cryptoState.available = true
  rows.set('bare', { id: 'bare', api_key_ref: BARE_KEY })
  rows.set('downgraded', {
    id: 'downgraded',
    api_key_ref: `plain:${Buffer.from(PLAIN_KEY, 'utf8').toString('base64')}`
  })
  rows.set('already-encrypted', { id: 'already-encrypted', api_key_ref: encryptSecret('sk-safe') })
  rows.set('no-key', { id: 'no-key', api_key_ref: null })
}

describe('历史明文 API Key 启动收口', () => {
  it('裸明文与 plain: 降级串都升级成 enc:，且原密钥读得回来', () => {
    seedRows()
    const before = rows.get('already-encrypted')!.api_key_ref
    expect(upgradeLegacyApiKeys()).toBe(2)
    expect([...writes].sort()).toEqual(['bare', 'downgraded'])
    expect(getProviderRef('bare')).not.toContain(BARE_KEY)
    expect(decryptSecret(getProviderRef('bare'))).toBe(BARE_KEY)
    expect(decryptSecret(getProviderRef('downgraded'))).toBe(PLAIN_KEY)
    expect(getProviderRef('already-encrypted')).toBe(before)
    expect(rows.get('no-key')!.api_key_ref).toBeNull()
  })

  it('safeStorage 不可用时一行都不写：宁可留着明文，也不写回降级串', () => {
    seedRows()
    cryptoState.available = false
    expect(upgradeLegacyApiKeys()).toBe(0)
    expect(writes).toEqual([])
    expect(getProviderRef('bare')).toBe(BARE_KEY)
  })

  it('跑一次就够了：第二次没有待升级的行', () => {
    seedRows()
    upgradeLegacyApiKeys()
    writes.length = 0
    expect(upgradeLegacyApiKeys()).toBe(0)
    expect(writes).toEqual([])
  })
})

function getProviderRef(id: string): string {
  return rows.get(id)!.api_key_ref as string
}
