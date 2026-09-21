import { describe, expect, it } from 'vitest'
import type { Connection, ModelDefinition } from '@free-creation/model-contracts'
import { InMemoryModelHost, ModelRuntime, ModelRuntimeError, type ProviderAdapter } from '../src/index.js'

const connection: Connection = {
  id: 'openai-main', name: 'OpenAI', protocol: 'openai-compatible', baseUrl: 'https://example.test/v1',
  auth: { type: 'bearer-token', token: 'not-persisted-here' }, headers: {}, enabled: true, metadata: { adapterId: 'test' }
}
const model: ModelDefinition = {
  id: 'image-1', name: 'Image 1', connectionId: connection.id, modelId: 'image-1', enabled: true,
  capabilities: [{ operation: 'image.generate', asynchronous: false, streaming: false, acceptedAssetKinds: [], producedAssetKinds: ['image'], controls: {} }],
  validation: {}, metadata: {}
}

const adapter: ProviderAdapter = {
  id: 'test',
  supports: () => true,
  validate: async () => ({ status: 'verified', message: '模型验证通过' })
}

describe('ModelRuntime validation gate', () => {
  it('rejects execution until the exact model operation has been verified', async () => {
    const host = new InMemoryModelHost()
    host.setConnection(connection, 'sk-test')
    host.setModel(model)
    const runtime = new ModelRuntime({ ports: { configuration: host, secrets: host, validations: host, tasks: host, artifacts: host, voices: host, events: host } })
    runtime.register(adapter)
    await expect(runtime.resolveForExecution(connection.id, model.id, 'image.generate')).rejects.toBeInstanceOf(ModelRuntimeError)
    const result = await runtime.validateModel(connection.id, model.id, 'image.generate')
    expect(result.status).toBe('verified')
    await expect(runtime.resolveForExecution(connection.id, model.id, 'image.generate')).resolves.toMatchObject({ secret: 'sk-test', target: { modelId: 'image-1' } })
  })

  it('records unsupported models and keeps them out of execution', async () => {
    const host = new InMemoryModelHost()
    host.setConnection(connection, 'sk-test')
    host.setModel(model)
    const runtime = new ModelRuntime({ ports: { configuration: host, secrets: host, validations: host, tasks: host, artifacts: host } })
    runtime.register({ ...adapter, supports: () => false })
    const result = await runtime.validateModel(connection.id, model.id, 'image.generate')
    expect(result.status).toBe('unsupported')
    await expect(runtime.resolveForExecution(connection.id, model.id, 'image.generate')).rejects.toMatchObject({ code: 'not-verified' })
  })
})
