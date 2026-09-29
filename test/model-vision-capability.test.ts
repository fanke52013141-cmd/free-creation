import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Connection, ModelDefinition } from '@free-creation/model-contracts'
import { HttpValidationAdapter } from '../src/main/model-host/http-validation-adapter'
import { SqliteModelHost, type ModelHostDatabase } from '../src/main/model-host/sqlite-model-host'

vi.mock('../src/main/gateway/keycrypto', () => ({ encryptSecret: (value: string) => value, decryptSecret: (value: string) => value }))

const capability = (imageInput: boolean) => ({
  operation: 'text.generate' as const,
  asynchronous: false,
  streaming: true,
  acceptedAssetKinds: imageInput ? ['image' as const] : [],
  producedAssetKinds: [],
  controls: {}
})

function model(imageInput: boolean): ModelDefinition {
  return { id: 'model-1', name: 'test', connectionId: 'connection-1', modelId: 'test-model', capabilities: [capability(imageInput)], validation: {}, enabled: true, metadata: {} }
}

function connection(protocol: Connection['protocol'] = 'openai-compatible'): Connection {
  return { id: 'connection-1', name: 'test', protocol, baseUrl: 'https://example.test/v1', auth: { type: 'none' }, headers: {}, enabled: true, metadata: {} }
}

afterEach(() => vi.unstubAllGlobals())

describe('text model with image input', () => {
  it('sends an image probe and requires the correct visual answer', async () => {
    const requests: Record<string, unknown>[] = []
    vi.stubGlobal('fetch', vi.fn(async (_url: string, options: RequestInit) => {
      requests.push(JSON.parse(String(options.body)) as Record<string, unknown>)
      return new Response(JSON.stringify({ choices: [{ message: { content: requests.length === 1 ? 'blue' : 'red' } }] }), { status: 200 })
    }))
    const adapter = new HttpValidationAdapter()
    const request = { connection: connection(), model: model(true), operation: 'text.generate' as const, target: { connectionId: 'connection-1', modelId: 'test-model', operation: 'text.generate' as const }, secret: 'test-secret' }
    expect((await adapter.validate(request)).status).toBe('failed')
    expect((await adapter.validate(request)).status).toBe('verified')
    const content = (requests[0].messages as Array<{ content: Array<{ type: string; image_url?: { url: string } }> }>)[0].content
    expect(content.find((part) => part.type === 'image_url')?.image_url?.url).toMatch(/^data:image\/png;base64,/)
  })

  it('invalidates old verification and binding when image input is enabled', () => {
    const db = new DatabaseSync(':memory:')
    try {
      db.exec(`CREATE TABLE model_connections (id TEXT PRIMARY KEY, name TEXT, protocol TEXT, base_url TEXT, secret_ref TEXT, headers_json TEXT, metadata_json TEXT, enabled INTEGER, created_at TEXT, updated_at TEXT);
        CREATE TABLE model_definitions (id TEXT PRIMARY KEY, connection_id TEXT, model_id TEXT, name TEXT, capabilities_json TEXT, metadata_json TEXT, enabled INTEGER, created_at TEXT, updated_at TEXT);
        CREATE TABLE model_validations (connection_id TEXT, model_definition_id TEXT, operation TEXT, status TEXT, checked_at TEXT, verified_at TEXT, message TEXT, PRIMARY KEY (connection_id, model_definition_id, operation));
        CREATE TABLE model_feature_bindings (feature_key TEXT PRIMARY KEY, connection_id TEXT, model_definition_id TEXT, operation TEXT);`)
      const host = new SqliteModelHost(db as unknown as ModelHostDatabase)
      host.saveConnection({ id: 'connection-1', name: 'test', protocol: 'openai-compatible', baseUrl: 'https://example.test/v1', apiKey: 'test-secret' })
      host.saveModel({ id: 'model-1', connectionId: 'connection-1', modelId: 'test-model', name: 'test', capabilities: [capability(false)] })
      db.prepare("INSERT INTO model_validations (connection_id, model_definition_id, operation, status) VALUES ('connection-1', 'model-1', 'text.generate', 'verified')").run()
      db.prepare("INSERT INTO model_feature_bindings VALUES ('text.process', 'connection-1', 'model-1', 'text.generate')").run()
      expect(host.listModels('connection-1')[0].validation['text.generate']?.status).toBe('verified')
      const updated = host.saveModel({ id: 'model-1', connectionId: 'connection-1', modelId: 'test-model', name: 'test', capabilities: [capability(true)] })
      expect(updated.capabilities[0].acceptedAssetKinds).toEqual(['image'])
      expect(db.prepare('SELECT * FROM model_validations').all()).toHaveLength(0)
      expect(db.prepare('SELECT * FROM model_feature_bindings').all()).toHaveLength(0)
      db.prepare("INSERT INTO model_validations (connection_id, model_definition_id, operation, status) VALUES ('connection-1', 'model-1', 'text.generate', 'verified')").run()
      host.saveConnection({ id: 'connection-1', name: 'renamed', protocol: 'openai-compatible', baseUrl: 'https://example.test/v1' })
      expect(host.listModels('connection-1')[0].validation['text.generate']?.status).toBe('verified')
      host.saveConnection({ id: 'connection-1', name: 'renamed', protocol: 'openai-compatible', baseUrl: 'https://other.test/v1' })
      expect(host.listModels('connection-1')[0].validation['text.generate']).toBeUndefined()
    } finally {
      db.close()
    }
  })
})
