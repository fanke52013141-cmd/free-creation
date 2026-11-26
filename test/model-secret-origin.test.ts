import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import Database from 'better-sqlite3'
import { migrateDatabase } from '../src/main/store/db-migrations'
import { SecretVault, setActiveVault, type VaultDatabase } from '../src/main/security/keystore/vault'
import { createInMemorySoftwareAdapter } from '../src/main/security/license/device/software'
import { SqliteModelHost } from '../src/main/model-host/sqlite-model-host'

let db: Database.Database
let host: SqliteModelHost

const baseInput = {
  id: 'connection-1',
  name: 'origin fixture',
  protocol: 'openai-compatible' as const,
  baseUrl: 'https://old.example/v1',
  headers: {}
}

beforeEach(async () => {
  db = new Database(':memory:')
  migrateDatabase(db)
  const adapter = createInMemorySoftwareAdapter()
  await adapter.createDeviceKeys()
  setActiveVault(new SecretVault({ adapter, database: () => db as unknown as VaultDatabase }))
  host = new SqliteModelHost(db)
})

afterEach(() => {
  setActiveVault(null)
  db.close()
})

describe('SqliteModelHost origin-bound secrets', () => {
  it('rejects an origin change without a new key and leaves the old binding intact', async () => {
    await host.saveConnection({ ...baseInput, apiKey: 'sk-old-origin' })

    await expect(host.saveConnection({
      ...baseInput,
      baseUrl: 'https://attacker.example/v1'
    })).rejects.toThrow(/必须重新输入 API Key/)

    const row = db.prepare('SELECT base_url, secret_ref FROM model_connections WHERE id = ?')
      .get(baseInput.id) as { base_url: string; secret_ref: string }
    expect(row.base_url).toBe(baseInput.baseUrl)
    expect(row.secret_ref).toContain('vault:connection:')
    await expect(host.readSecretForRequest(baseInput.id, 'https://old.example/v1/models'))
      .resolves.toBe('sk-old-origin')
    await expect(host.readSecretForRequest(baseInput.id, 'https://attacker.example/v1/models'))
      .resolves.toBeNull()
  })

  it('rejects protocol and header changes without a new key', async () => {
    await host.saveConnection({ ...baseInput, apiKey: 'sk-old-origin' })

    await expect(host.saveConnection({ ...baseInput, protocol: 'openai' }))
      .rejects.toThrow(/必须重新输入 API Key/)
    await expect(host.saveConnection({ ...baseInput, headers: { 'X-Route': 'other' } }))
      .rejects.toThrow(/必须重新输入 API Key/)
  })

  it('keeps the secret for ordinary same-origin updates', async () => {
    await host.saveConnection({ ...baseInput, apiKey: 'sk-old-origin' })
    await host.saveConnection({
      ...baseInput,
      name: 'renamed',
      baseUrl: 'https://old.example/v2'
    })

    await expect(host.readSecretForRequest(baseInput.id, 'https://old.example/v2/models'))
      .resolves.toBe('sk-old-origin')
  })

  it('binds a replacement key to the new origin', async () => {
    await host.saveConnection({ ...baseInput, apiKey: 'sk-old-origin' })
    await host.saveConnection({
      ...baseInput,
      baseUrl: 'https://new.example/v1',
      apiKey: 'sk-new-origin'
    })

    await expect(host.readSecretForRequest(baseInput.id, 'https://new.example/v1/models'))
      .resolves.toBe('sk-new-origin')
    await expect(host.readSecretForRequest(baseInput.id, 'https://old.example/v1/models'))
      .resolves.toBeNull()
  })

  it('never releases a legacy enc/plain secret to a different target origin', async () => {
    const legacySecret = `plain:${Buffer.from('sk-legacy', 'utf8').toString('base64')}`
    db.prepare(`INSERT INTO model_connections
      (id, name, protocol, base_url, secret_ref, headers_json, metadata_json, enabled, created_at, updated_at, agent_tool_calling_revision)
      VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?, 0)`).run(
      baseInput.id,
      baseInput.name,
      baseInput.protocol,
      baseInput.baseUrl,
      legacySecret,
      '{}',
      '{}',
      new Date().toISOString(),
      new Date().toISOString()
    )

    await expect(host.readSecretForRequest(baseInput.id, 'https://old.example/v1/models'))
      .resolves.toBe('sk-legacy')
    await expect(host.readSecretForRequest(baseInput.id, 'https://attacker.example/v1/models'))
      .resolves.toBeNull()
    await expect(host.saveConnection({
      ...baseInput,
      baseUrl: 'https://attacker.example/v1'
    })).rejects.toThrow(/必须重新输入 API Key/)
    const row = db.prepare('SELECT base_url, secret_ref FROM model_connections WHERE id = ?')
      .get(baseInput.id) as { base_url: string; secret_ref: string }
    expect(row.base_url).toBe(baseInput.baseUrl)
    expect(row.secret_ref).toBe(legacySecret)
  })
})
