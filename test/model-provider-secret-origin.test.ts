import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import Database from 'better-sqlite3'
import { migrateDatabase } from '../src/main/store/db-migrations'
import { SecretVault, setActiveVault, type VaultDatabase } from '../src/main/security/keystore/vault'
import { createInMemorySoftwareAdapter } from '../src/main/security/license/device/software'
import { getProvider, saveProvider } from '../src/main/gateway/providers.repo'
import { draftToConfig, probeProvider } from '../src/main/gateway/provider-check'
import { testProvider } from '../src/main/gateway/factory'

const state = vi.hoisted(() => ({ db: null as Database.Database | null }))
vi.mock('../src/main/store/db', () => ({ getDb: () => state.db }))

let db: Database.Database

const providerInput = {
  id: 'provider-1',
  name: 'origin provider',
  specId: 'relay' as const,
  baseURL: 'https://old.example/v1',
  models: [{ id: 'model-1', modality: 'text' as const }]
}

beforeEach(async () => {
  db = new Database(':memory:')
  state.db = db
  migrateDatabase(db)
  const adapter = createInMemorySoftwareAdapter()
  await adapter.createDeviceKeys()
  setActiveVault(new SecretVault({ adapter, database: () => db as unknown as VaultDatabase }))
})

afterEach(() => {
  setActiveVault(null)
  vi.unstubAllGlobals()
  state.db = null
  db.close()
})

describe('legacy provider origin-bound secrets', () => {
  it('rejects an origin change without a new key and keeps the old provider binding', async () => {
    await saveProvider({ ...providerInput, apiKey: 'sk-old-origin' })

    await expect(saveProvider({
      ...providerInput,
      baseURL: 'https://attacker.example/v1'
    })).rejects.toThrow(/必须重新输入 API Key/)

    const row = db.prepare('SELECT base_url, api_key_ref FROM providers WHERE id = ?')
      .get(providerInput.id) as { base_url: string; api_key_ref: string }
    expect(row.base_url).toBe(providerInput.baseURL)
    expect(row.api_key_ref).toContain('vault:provider:')
    expect((await getProvider(providerInput.id))?.apiKey).toBe('sk-old-origin')
    expect((await getProvider(providerInput.id, 'https://attacker.example/v1'))?.apiKey).toBe('')
  })

  it('keeps the key for ordinary same-origin updates', async () => {
    await saveProvider({ ...providerInput, apiKey: 'sk-old-origin' })
    await saveProvider({
      ...providerInput,
      name: 'renamed',
      baseURL: 'https://old.example/v2'
    })

    expect((await getProvider(providerInput.id))?.apiKey).toBe('sk-old-origin')
    expect((await getProvider(providerInput.id, 'https://old.example/v2'))?.apiKey).toBe('sk-old-origin')
  })

  it('binds legacy enc/plain refs to the persisted provider origin', async () => {
    const legacySecret = `plain:${Buffer.from('sk-legacy', 'utf8').toString('base64')}`
    db.prepare(`INSERT INTO providers (id, name, spec_id, base_url, api_key_ref, models, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)`).run(
      providerInput.id,
      providerInput.name,
      providerInput.specId,
      providerInput.baseURL,
      legacySecret,
      JSON.stringify(providerInput.models),
      Date.now()
    )

    expect((await getProvider(providerInput.id))?.apiKey).toBe('sk-legacy')
    expect((await getProvider(providerInput.id, 'https://attacker.example/v1'))?.apiKey).toBe('')
  })

  it('rejects an origin change for a legacy ref without a new key', async () => {
    const legacySecret = `plain:${Buffer.from('sk-legacy', 'utf8').toString('base64')}`
    db.prepare(`INSERT INTO providers (id, name, spec_id, base_url, api_key_ref, models, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)`).run(
      providerInput.id,
      providerInput.name,
      providerInput.specId,
      providerInput.baseURL,
      legacySecret,
      JSON.stringify(providerInput.models),
      Date.now()
    )

    await expect(saveProvider({
      ...providerInput,
      baseURL: 'https://attacker.example/v1'
    })).rejects.toThrow(/必须重新输入 API Key/)
    const row = db.prepare('SELECT base_url, api_key_ref FROM providers WHERE id = ?')
      .get(providerInput.id) as { base_url: string; api_key_ref: string }
    expect(row.base_url).toBe(providerInput.baseURL)
    expect(row.api_key_ref).toBe(legacySecret)
  })

  it('does not let an unsaved draft probe pair a new origin with the saved key', async () => {
    await saveProvider({ ...providerInput, apiKey: 'sk-old-origin' })
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const draft = {
      ...providerInput,
      baseURL: 'https://attacker.example/v1'
    }

    await expect(draftToConfig(draft)).rejects.toMatchObject({ code: 'PROVIDER_NO_KEY' })
    await expect(probeProvider(draft)).rejects.toMatchObject({ code: 'PROVIDER_NO_KEY' })
    await expect(testProvider(draft)).rejects.toMatchObject({ code: 'PROVIDER_NO_KEY' })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('allows a same-origin draft test to reuse the bound key', async () => {
    await saveProvider({ ...providerInput, apiKey: 'sk-old-origin' })
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ data: [{ id: 'model-1' }] }), {
      status: 200,
      headers: { 'content-type': 'application/json' }
    }))
    vi.stubGlobal('fetch', fetchMock)

    await expect(testProvider({
      ...providerInput,
      baseURL: 'https://old.example/v2'
    })).resolves.toMatchObject({ models: ['model-1'] })
    expect(fetchMock).toHaveBeenCalledWith('https://old.example/v2/models', expect.objectContaining({
      headers: { Authorization: 'Bearer sk-old-origin' }
    }))
  })
})
