import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import Database from 'better-sqlite3'
import { migrateDatabase } from '../src/main/store/db-migrations'
import { SecretVault, setActiveVault, type VaultDatabase } from '../src/main/security/keystore/vault'
import { createInMemorySoftwareAdapter } from '../src/main/security/license/device/software'
import { SqliteModelHost } from '../src/main/model-host/sqlite-model-host'

const mocks = vi.hoisted(() => ({
  createCatalogChatModel: vi.fn(),
  probeAgentModel: vi.fn(),
  emitDomainEvent: vi.fn()
}))

vi.mock('../src/main/gateway/factory', () => ({
  createCatalogChatModel: mocks.createCatalogChatModel
}))
vi.mock('../src/main/agent-flow/model-probe', () => ({
  probeAgentModel: mocks.probeAgentModel
}))
vi.mock('../src/main/diagnostics/ipc-domain-events', () => ({
  emitDomainEvent: mocks.emitDomainEvent
}))

import { validateAgentToolCallingOnHost } from '../src/main/model-host/agent-tool-calling'

let db: Database.Database
let host: SqliteModelHost

beforeEach(async () => {
  vi.clearAllMocks()
  db = new Database(':memory:')
  migrateDatabase(db)
  const adapter = createInMemorySoftwareAdapter()
  await adapter.createDeviceKeys()
  setActiveVault(new SecretVault({ adapter, database: () => db as unknown as VaultDatabase }))
  host = new SqliteModelHost(db)
  await host.saveConnection({
    id: 'connection-1',
    name: 'tool origin fixture',
    protocol: 'openai-compatible',
    baseUrl: 'https://old.example/v1',
    apiKey: 'sk-old-origin'
  })
  host.saveModel({
    id: 'model-1',
    connectionId: 'connection-1',
    name: 'tool model',
    modelId: 'fixture-model',
    capabilities: [{
      operation: 'text.generate',
      asynchronous: false,
      streaming: true,
      acceptedAssetKinds: [],
      producedAssetKinds: [],
      controls: {}
    }]
  })
})

afterEach(() => {
  setActiveVault(null)
  db.close()
})

describe('Agent tool-calling origin-bound secret read', () => {
  it('does not send the old key when the persisted endpoint no longer matches its bound origin', async () => {
    db.prepare('UPDATE model_connections SET base_url = ? WHERE id = ?')
      .run('https://attacker.example/v1', 'connection-1')

    await expect(validateAgentToolCallingOnHost(host, {
      connectionId: 'connection-1',
      modelDefinitionId: 'model-1',
      allowCost: true
    })).rejects.toThrow('模型密钥与当前端点不匹配')

    expect(mocks.createCatalogChatModel).not.toHaveBeenCalled()
    expect(mocks.probeAgentModel).not.toHaveBeenCalled()
  })

  it('uses the bound key for the same origin', async () => {
    mocks.createCatalogChatModel.mockReturnValue({ fixture: true })
    mocks.probeAgentModel.mockResolvedValue({
      structuredToolCall: 'verified',
      toolResultRoundTrip: 'verified'
    })

    await expect(validateAgentToolCallingOnHost(host, {
      connectionId: 'connection-1',
      modelDefinitionId: 'model-1',
      allowCost: true
    })).resolves.toMatchObject({ status: 'verified' })

    expect(mocks.createCatalogChatModel).toHaveBeenCalledWith(expect.objectContaining({
      baseURL: 'https://old.example/v1',
      apiKey: 'sk-old-origin'
    }))
    expect(mocks.probeAgentModel).toHaveBeenCalledTimes(1)
  })
})
