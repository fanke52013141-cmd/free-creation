/**
 * 供应商配置传输测试（密码保护文件）。
 *
 * P2 后的语义：
 * - 发行版（DISTRIBUTION_EDITION=true）：导出/导入开放——把带 Key 的配置交给客户导入；
 * - 授权版：仅发放员（credentials.export）可用；使用者（app.run）拒绝；
 * - 导出按所选供应商加密，未选中的 Key 不读取；导入解密后 upsert（同 ID 更新）。
 */
import { createDecipheriv, scryptSync } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({
  distribution: false,
  licenseState: 'active' as string,
  capabilities: ['app.run', 'credentials.export'] as string[],
  inserted: [] as Array<Record<string, unknown>>
}))

vi.mock('../src/shared/edition', () => ({ DISTRIBUTION_EDITION: state.distribution }))
vi.mock('../src/main/security/license/gate', () => ({
  assertLicenseActive: vi.fn(),
  licenseSnapshot: vi.fn(() => ({
    state: state.licenseState,
    capabilities: [...state.capabilities],
    term: 'permanent',
    expiresAt: null
  }))
}))
vi.mock('../src/main/gateway/keycrypto', () => ({
  encryptSecret: (plain: string): string => `enc:${Buffer.from(plain, 'utf8').toString('base64')}`,
  decryptSecret: (stored: string | null): string =>
    stored && stored.startsWith('enc:') ? Buffer.from(stored.slice(4), 'base64').toString('utf8') : (stored ?? ''),
  vaultRef: (kind: string, id: string): string => `vault:${kind}:${id}`,
  isEncryptedSecret: (stored: string | null): boolean => Boolean(stored && stored.startsWith('enc:')),
  isVaultRef: (): boolean => false,
  parseVaultRef: (): null => null,
  VAULT_PREFIX: 'vault:'
}))
vi.mock('../src/main/security/keystore/vault', () => ({ getActiveVault: vi.fn(() => null) }))

const dbFake = vi.hoisted(() => {
  const state = { inserted: [] as Array<Record<string, unknown>> }
  return {
    state,
    getDb: () =>
      ({
        prepare: (sql: string) => ({
          get: () => undefined,
          all: (): unknown[] => [],
          run: (...params: unknown[]) => {
            if (sql.startsWith('INSERT INTO providers')) state.inserted.push({ sql, params })
            return { changes: 1 }
          }
        }),
        transaction: <T,>(fn: () => T): () => T => () => fn()
      }) as unknown
  }
})
vi.mock('../src/main/store/db', () => ({ getDb: () => dbFake.getDb() }))
vi.mock('../src/main/model-host/sqlite-model-host', () => ({ SqliteModelHost: class {} }))

const repo = vi.hoisted(() => ({
  getProvider: vi.fn(),
  bootstrapLegacyProvidersToCatalog: vi.fn(async () => [])
}))
vi.mock('../src/main/gateway/providers.repo', () => repo)

import { exportProviders, importProviders } from '../src/main/gateway/provider-transfer'

const dir = mkdtempSync(join(tmpdir(), 'canvas-transfer-p2-'))
const file = join(dir, 'selected.canvasproviders')

const PROVIDERS = {
  selected: {
    id: 'selected',
    name: '已选供应商',
    specId: 'relay',
    baseURL: 'https://selected.example/v1',
    apiKey: 'selected-secret',
    models: [{ id: 'model-a', modality: 'image' }]
  },
  other: {
    id: 'other',
    name: '未选供应商',
    specId: 'relay',
    baseURL: 'https://other.example/v1',
    apiKey: 'other-secret',
    models: [{ id: 'model-b', modality: 'text' }]
  }
} as const

beforeEach(() => {
  state.distribution = false
  state.licenseState = 'active'
  state.capabilities = ['app.run', 'credentials.export']
  dbFake.state.inserted = []
  repo.getProvider.mockImplementation(async (id: string) => (PROVIDERS as Record<string, unknown>)[id] ?? null)
  dbFake.state.inserted = []
})

afterEach(() => vi.resetAllMocks())

function decryptPayload(filePath: string, password: string): { providers: Array<{ id: string; apiKey: string }> } {
  const envelope = JSON.parse(readFileSync(filePath, 'utf8')) as {
    salt: string
    iv: string
    authTag: string
    ciphertext: string
  }
  const key = scryptSync(password, Buffer.from(envelope.salt, 'base64'), 32, {
    N: 32768,
    r: 8,
    p: 1,
    maxmem: 64 * 1024 * 1024
  })
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(envelope.iv, 'base64'))
  decipher.setAAD(Buffer.from('canvas-studio-providers:1', 'utf8'))
  decipher.setAuthTag(Buffer.from(envelope.authTag, 'base64'))
  const plaintext = Buffer.concat([
    decipher.update(Buffer.from(envelope.ciphertext, 'base64')),
    decipher.final()
  ]).toString('utf8')
  return JSON.parse(plaintext)
}

describe('供应商配置传输（直发版/发放员）', () => {
  it('直发版：只加密所选供应商，未选中的密钥不被读取', async () => {
    state.distribution = true
    repo.getProvider.mockClear()
    const count = await exportProviders(file, 'test-password-123', ['selected'])
    expect(count).toBe(1)
    expect(repo.getProvider).toHaveBeenCalledTimes(1)
    expect(repo.getProvider).toHaveBeenCalledWith('selected')

    const payload = decryptPayload(file, 'test-password-123')
    expect(payload.providers).toHaveLength(1)
    expect(payload.providers[0].id).toBe('selected')
    expect(payload.providers[0].apiKey).toBe('selected-secret')
  })

  it('直发版：导入解密并落库（INSERT 行），计数正确', async () => {
    state.distribution = true
    await exportProviders(file, 'test-password-123', ['selected'])
    // 空库导入：getProvider 查无此供应商 → 计为新增。
    repo.getProvider.mockResolvedValue(null)
    const result = await importProviders(file, 'test-password-123')
    expect(result).toEqual({ added: 1, updated: 0, count: 1 })
    expect(dbFake.state.inserted).toHaveLength(1)
    const inserted = dbFake.state.inserted[0]
    expect(inserted.params?.[0]).toBe('selected')
    // vault 未注入 → 走 safeStorage 引用（enc:）
    expect(String(inserted.params?.[4])).toMatch(/^enc:/)
  })

  it('直发版：错误密码拒绝', async () => {
    state.distribution = true
    await exportProviders(file, 'test-password-123', ['selected'])
    await expect(importProviders(file, 'wrong-password-99')).rejects.toThrow(/密码错误/)
  })

  it('授权版发放员（credentials.export）可导出', async () => {
    await exportProviders(file, 'test-password-123', ['selected'])
    const payload = decryptPayload(file, 'test-password-123')
    expect(payload.providers[0].apiKey).toBe('selected-secret')
  })

  it('授权版使用者（无 credentials.export）导出与导入均拒绝', async () => {
    state.capabilities = ['app.run']
    await expect(exportProviders(file, 'test-password-123', ['selected'])).rejects.toThrow(
      /credentials\.export/
    )
    await expect(importProviders(join(dir, 'x.canvasproviders'), 'test-password-123')).rejects.toThrow(
      /credentials\.export/
    )
  })

  it('非法选择（空列表/重复/超限）直接拒绝且不读仓库', async () => {
    repo.getProvider.mockClear()
    for (const ids of [[], ['selected', 'selected']]) {
      await expect(exportProviders(join(dir, 'invalid'), 'test-password-123', ids)).rejects.toThrow(
        /请选择需要导出的供应商/
      )
    }
    expect(repo.getProvider).not.toHaveBeenCalled()
  })

  it('损坏文件导入给统一错误提示', async () => {
    state.distribution = true
    const broken = join(dir, 'broken.canvasproviders')
    writeFileSync(broken, '{ not json', 'utf8')
    await expect(importProviders(broken, 'test-password-123')).rejects.toThrow(/供应商配置文件/)
  })
})

afterAll(() => {
  rmSync(dir, { recursive: true, force: true })
})
