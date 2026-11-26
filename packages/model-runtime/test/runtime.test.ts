import { describe, expect, it, vi } from 'vitest'
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

  it('uses target-url-aware secret reads for validation and execution', async () => {
    const host = new InMemoryModelHost()
    host.setConnection(connection, 'sk-test')
    host.setModel(model)
    const readSecret = vi.fn(async () => 'sk-test')
    const readSecretForRequest = vi.fn(async () => 'sk-test')
    const runtime = new ModelRuntime({
      ports: {
        configuration: host,
        secrets: { readSecret, readSecretForRequest },
        validations: host,
        tasks: host,
        artifacts: host
      }
    })
    runtime.register(adapter)

    expect((await runtime.validateModel(connection.id, model.id, 'image.generate')).status).toBe('verified')
    await expect(runtime.resolveForExecution(connection.id, model.id, 'image.generate')).resolves.toMatchObject({ secret: 'sk-test' })
    expect(readSecretForRequest).toHaveBeenCalledWith(connection.id, connection.baseUrl)
    expect(readSecret).not.toHaveBeenCalled()
  })

  it('does not release an old-origin secret after the connection moves to a new origin', async () => {
    const host = new InMemoryModelHost()
    host.setConnection(connection, 'sk-old-origin')
    host.setConnection({ ...connection, baseUrl: 'https://attacker.example/v1' })
    host.setModel(model)
    const validate = vi.fn(async () => ({ status: 'verified' as const, message: 'should not run' }))
    const runtime = new ModelRuntime({ ports: { configuration: host, secrets: host, validations: host, tasks: host, artifacts: host } })
    runtime.register({ ...adapter, validate })

    const result = await runtime.validateModel(connection.id, model.id, 'image.generate')
    expect(result.status).toBe('failed')
    expect(validate).not.toHaveBeenCalled()

    await host.saveValidation({
      connectionId: connection.id,
      modelDefinitionId: model.id,
      operation: 'image.generate',
      status: 'verified',
      checkedAt: new Date().toISOString(),
      verifiedAt: new Date().toISOString()
    })
    await expect(runtime.resolveForExecution(connection.id, model.id, 'image.generate')).rejects.toMatchObject({
      code: 'invalid-configuration'
    })
  })

  it('does not fall back to an unbound read when origin-bound access is rejected', async () => {
    const host = new InMemoryModelHost()
    host.setConnection(connection)
    host.setModel(model)
    const readSecret = vi.fn(async () => 'sk-old-origin')
    const readSecretForRequest = vi.fn(async () => { throw new Error('origin mismatch') })
    const validate = vi.fn(async () => ({ status: 'verified' as const, message: 'should not run' }))
    const runtime = new ModelRuntime({
      ports: {
        configuration: host,
        secrets: { readSecret, readSecretForRequest },
        validations: host,
        tasks: host,
        artifacts: host
      }
    })
    runtime.register({ ...adapter, validate })

    await expect(runtime.validateModel(connection.id, model.id, 'image.generate')).resolves.toMatchObject({
      status: 'failed',
      message: expect.stringContaining('端点不匹配')
    })
    expect(readSecretForRequest).toHaveBeenCalledWith(connection.id, connection.baseUrl)
    expect(readSecret).not.toHaveBeenCalled()
    expect(validate).not.toHaveBeenCalled()
  })

  it('keeps the secret for ordinary same-origin updates', async () => {
    const host = new InMemoryModelHost()
    host.setConnection(connection, 'sk-test')
    host.setConnection({ ...connection, name: 'Renamed', baseUrl: 'https://example.test/v2' })
    host.setModel(model)
    const runtime = new ModelRuntime({ ports: { configuration: host, secrets: host, validations: host, tasks: host, artifacts: host } })
    runtime.register(adapter)

    expect((await runtime.validateModel(connection.id, model.id, 'image.generate')).status).toBe('verified')
    await expect(runtime.resolveForExecution(connection.id, model.id, 'image.generate')).resolves.toMatchObject({ secret: 'sk-test' })
  })
})
