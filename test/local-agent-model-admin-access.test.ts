// F9（四）：模型连接与受控凭据写入的外部接入测试。
//
// 这组断言的重点不是"能存"，而是**凭据边界**：
// 1) 明文密钥绝不回传给调用方、也不出现在诊断事件里（只在主进程内用于写入与指纹计算）；
// 2) 指纹稳定且不可逆：同一把密钥指纹相同、不同密钥不同、省略密钥时保留原值；
// 3) 密钥真的落进了设备绑定密钥库（密文列不含明文）；
// 4) 连接事实变化会清除验证与功能绑定，回执如实标记；
// 5) 功能绑定只在"该模型该操作已验证"时成立——外部无法自行验证，因此未验证一律拒绝；
// 6) 删除连接会连同其模型定义一起删，回执给出数量；删除后查询如实 NOT_FOUND。
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { closeDb, getDataDir, getDb } from '../src/main/store/db'
import { LocalAccessService } from '../src/main/agent-access/service'
import { setGatewayEventSink } from '../src/main/diagnostics/gateway-events'
import { SecretVault, setActiveVault, type VaultDatabase } from '../src/main/security/keystore/vault'
import { createInMemorySoftwareAdapter } from '../src/main/security/license/device/software'

let directory: string
let service: LocalAccessService
const events: any[] = []
const originalDirectory = process.env.CANVAS_DATA_DIR
const key = () => `${Date.now()}:${randomUUID()}`
const SECRET_MARKER = 'sk-FAKE-CREDENTIAL-MARKER-9f3a'

function call(operationId: string, input: unknown = {}, idempotencyKey?: string) {
  return service.dispatch({
    apiVersion: 1,
    operationVersion: 1,
    operationId,
    input,
    requestId: randomUUID(),
    expectedDataStoreId: service.dataStoreId,
    ...(idempotencyKey ? { idempotencyKey } : {})
  })
}

function write(operationId: string, input: unknown, idempotencyKey = key()) {
  return call(operationId, input, idempotencyKey)
}

function connectionInput(overrides: Record<string, unknown> = {}) {
  return {
    id: 'conn-test',
    name: '本地测试连接',
    protocol: 'openai-compatible',
    baseUrl: 'http://127.0.0.1:5200/v1',
    ...overrides
  }
}

beforeEach(async () => {
  directory = mkdtempSync(join(tmpdir(), 'canvas-model-admin-test-'))
  process.env.CANVAS_DATA_DIR = directory
  events.length = 0
  setGatewayEventSink({ emit: (event) => void events.push(event) })
  service = new LocalAccessService({
    instanceId: randomUUID(),
    appVersion: 'test',
    exportDirectory: join(getDataDir(), 'agent-exports'),
    activeProjectId: () => null
  })
  // 设备绑定密钥库：用软件适配器模拟本机设备（测试不触碰 TPM/系统密钥库）。
  const adapter = createInMemorySoftwareAdapter()
  await adapter.createDeviceKeys()
  setActiveVault(
    new SecretVault({ adapter, database: () => getDb() as unknown as VaultDatabase })
  )
})

afterEach(() => {
  setActiveVault(null)
  closeDb()
  if (originalDirectory === undefined) delete process.env.CANVAS_DATA_DIR
  else process.env.CANVAS_DATA_DIR = originalDirectory
  rmSync(directory, { recursive: true, force: true })
})

describe('模型连接与受控凭据写入', () => {
  it('写入连接与密钥：明文不回传、不进事件，密钥进入设备绑定密钥库', async () => {
    const response = await write(
      'model.connection.save',
      connectionInput({ apiKey: SECRET_MARKER })
    )
    expect(response.status, JSON.stringify(response.error)).toBe('completed')
    const data = response.data as {
      id: string
      baseUrlHost: string
      secret: { present: boolean; fingerprint: string; algorithm: string }
      invalidatedBindings: boolean
    }
    expect(data.secret.present).toBe(true)
    expect(data.secret.fingerprint).toMatch(/^[a-f0-9]{12}$/)
    expect(data.secret.algorithm).toBe('sha256:12')
    expect(data.baseUrlHost).toBe('127.0.0.1')
    expect(data.invalidatedBindings).toBe(false)
    // 回执与事件里都不得出现明文。
    expect(JSON.stringify(response)).not.toContain(SECRET_MARKER)
    expect(JSON.stringify(events)).not.toContain(SECRET_MARKER)
    // 密钥库列只存密文。
    const row = getDb()
      .prepare("SELECT content_cipher FROM secret_vault WHERE kind='connection' AND id='conn-test'")
      .get() as { content_cipher: string } | undefined
    expect(row).toBeDefined()
    expect(row!.content_cipher).not.toContain(SECRET_MARKER)
  })

  it('指纹稳定且区分不同密钥；省略密钥时保留原值', async () => {
    const first = await write('model.connection.save', connectionInput({ apiKey: SECRET_MARKER }))
    const fingerprint = (first.data as any).secret.fingerprint as string

    const same = await write('model.connection.save', connectionInput({ apiKey: SECRET_MARKER }))
    expect((same.data as any).secret.fingerprint).toBe(fingerprint)

    const kept = await write('model.connection.save', connectionInput())
    expect((kept.data as any).secret.present).toBe(true)
    expect((kept.data as any).secret.fingerprint).toBe(fingerprint)

    const changed = await write(
      'model.connection.save',
      connectionInput({ apiKey: 'sk-FAKE-CREDENTIAL-MARKER-other' })
    )
    expect((changed.data as any).secret.fingerprint).not.toBe(fingerprint)
  })

  it('连接事实变化标记 invalidatedBindings（宿主会清除验证与功能绑定）', async () => {
    await write('model.connection.save', connectionInput({ apiKey: SECRET_MARKER }))
    const moved = await write(
      'model.connection.save',
      connectionInput({ baseUrl: 'http://127.0.0.1:5300/v1' })
    )
    expect((moved.data as any).invalidatedBindings).toBe(true)
  })

  it('credential.status 只返回存在性与指纹；连接不存在 NOT_FOUND', async () => {
    const missing = await call('model.credential.status', { connectionId: 'conn-missing' })
    expect(missing.status).toBe('failed')
    expect(missing.error?.code).toBe('NOT_FOUND')

    const saved = await write('model.connection.save', connectionInput({ apiKey: SECRET_MARKER }))
    const status = await call('model.credential.status', { connectionId: 'conn-test' })
    expect(status.status).toBe('completed')
    const data = status.data as { secret: { present: boolean; fingerprint: string } }
    expect(data.secret.present).toBe(true)
    expect(data.secret.fingerprint).toBe((saved.data as any).secret.fingerprint)
    expect(JSON.stringify(status)).not.toContain(SECRET_MARKER)
  })

  it('删除连接会连同模型定义一起删，回执给出数量；之后查询 NOT_FOUND', async () => {
    await write('model.connection.save', connectionInput())
    for (const id of ['model-a', 'model-b']) {
      const saved = await write('model.definition.save', {
        id,
        connectionId: 'conn-test',
        name: id,
        modelId: `upstream-${id}`,
        capabilities: [
          {
            operation: 'text.generate',
            asynchronous: false,
            streaming: true,
            acceptedAssetKinds: [],
            producedAssetKinds: [],
            controls: {}
          }
        ]
      })
      expect(saved.status, JSON.stringify(saved.error)).toBe('completed')
    }
    const removed = await write('model.connection.delete', { connectionId: 'conn-test' })
    expect(removed.status).toBe('completed')
    expect((removed.data as any).deletedModels).toBe(2)

    const after = await call('model.credential.status', { connectionId: 'conn-test' })
    expect(after.error?.code).toBe('NOT_FOUND')
    const definition = await write('model.definition.delete', { id: 'model-a' })
    expect(definition.error?.code).toBe('NOT_FOUND')
  })

  it('模型定义：连接不存在 NOT_FOUND，能力为空被 Schema 拒绝', async () => {
    const textCapability = {
      operation: 'text.generate',
      asynchronous: false,
      streaming: true,
      acceptedAssetKinds: [],
      producedAssetKinds: [],
      controls: {}
    }
    const noConnection = await write('model.definition.save', {
      id: 'model-x',
      connectionId: 'conn-missing',
      name: 'x',
      modelId: 'x',
      capabilities: [textCapability]
    })
    expect(noConnection.error?.code).toBe('NOT_FOUND')

    await write('model.connection.save', connectionInput())
    const empty = await write('model.definition.save', {
      id: 'model-x',
      connectionId: 'conn-test',
      name: 'x',
      modelId: 'x',
      capabilities: []
    })
    expect(empty.error?.code).toBe('INVALID_INPUT')
  })

  it('功能绑定：未验证模型一律拒绝；外部不能靠绑定伪造"可用"', async () => {
    await write('model.connection.save', connectionInput())
    await write('model.definition.save', {
      id: 'model-a',
      connectionId: 'conn-test',
      name: 'model-a',
      modelId: 'upstream-a',
      capabilities: [
        {
          operation: 'text.generate',
          asynchronous: false,
          streaming: true,
          acceptedAssetKinds: [],
          producedAssetKinds: [],
          controls: {}
        }
      ]
    })
    const rejected = await write('model.binding.save', {
      featureKey: 'chat.default',
      connectionId: 'conn-test',
      modelDefinitionId: 'model-a',
      operation: 'text.generate'
    })
    expect(rejected.status).toBe('failed')
    expect(rejected.error?.code).toBe('MODEL_NOT_VERIFIED')

    // 夹具：直接写一条验证通过记录，模拟"人已在 GUI 里完成验证"，用于验证绑定写入本身。
    // 这不代表外部可以自行验证——验证操作（network/provider）没有开放。
    getDb()
      .prepare(
        `INSERT INTO model_validations (connection_id, model_definition_id, operation, status, checked_at, verified_at)
         VALUES (?,?,?,?,?,?)`
      )
      .run(
        'conn-test',
        'model-a',
        'text.generate',
        'verified',
        new Date().toISOString(),
        new Date().toISOString()
      )
    const bound = await write('model.binding.save', {
      featureKey: 'chat.default',
      connectionId: 'conn-test',
      modelDefinitionId: 'model-a',
      operation: 'text.generate'
    })
    expect(bound.status, JSON.stringify(bound.error)).toBe('completed')
    expect((bound.data as any).featureKey).toBe('chat.default')
    expect((bound.data as any).operation).toBe('text.generate')
  })

  it('同一幂等键重放返回原回执，不产生第二条连接', async () => {
    const idempotencyKey = key()
    const first = await call('model.connection.save', connectionInput({ apiKey: SECRET_MARKER }), idempotencyKey)
    const replay = await call('model.connection.save', connectionInput({ apiKey: SECRET_MARKER }), idempotencyKey)
    expect(first.status).toBe('completed')
    expect(replay.data).toEqual(first.data)
    const rows = getDb()
      .prepare("SELECT COUNT(*) AS n FROM model_connections WHERE id='conn-test'")
      .get() as { n: number }
    expect(rows.n).toBe(1)
  })
})
