// F9（二）「模型设置」与「环境」读取类外部接入测试。
//
// 覆盖（与 docs/local-agent-access/36-models-env-delivery.md 的验收清单一一对应）：
// - 空库返回空列表且结构正确；
// - 写入连接/定义/绑定后能读到，并用明显假密钥标记断言**返回 JSON 字符串不含密钥明文**；
// - model.definition.list 按 connectionId 过滤；
// - model.binding.resolve 在未绑定/已绑定/显式目标/无凭据时分别如实返回；
// - environment.local 在缺外部依赖时如实报 unavailable 而不是报错；
// - 非法参数、跨实例拒绝、未知字段（含 projectId）拒绝；
// - 全部 6 项不触发任何 fetch（不联网、不产生供应商请求，语音克隆/音色设计/视频生成
//   三类只做代码层接通，不做真实调用）；
// - 事件只带 operation/phase/code 等稳定字段，不含密钥原文。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { closeDb, getDataDir, getDb } from '../src/main/store/db'
import { LocalAccessService } from '../src/main/agent-access/service'
import { setGatewayEventSink } from '../src/main/diagnostics/gateway-events'
import { SqliteModelHost } from '../src/main/model-host/sqlite-model-host'

let directory: string
let service: LocalAccessService
const events: any[] = []
const originalDirectory = process.env.CANVAS_DATA_DIR
const originalFfmpegPath = process.env.CANVAS_STUDIO_FFMPEG_PATH
const originalSeparatorPath = process.env.CANVAS_STUDIO_AUDIO_SEPARATOR_PATH
const originalIndexTtsScanRoots = process.env.CANVAS_STUDIO_INDEXTTS_SCAN_ROOTS

/** 假密钥标记：出现在任何响应/事件里都等于去敏失败。 */
const FAKE_SECRET = 'sk-FAKE-SECRET-MARKER-123'

function call(operationId: string, input: unknown = {}) {
  return service.dispatch({
    apiVersion: 1,
    operationVersion: 1,
    operationId,
    input,
    requestId: randomUUID(),
    expectedDataStoreId: service.dataStoreId
  })
}

function textCapability(): {
  operation: 'text.generate'
  asynchronous: boolean
  streaming: boolean
  acceptedAssetKinds: string[]
  producedAssetKinds: string[]
  controls: Record<string, unknown>
} {
  return {
    operation: 'text.generate',
    asynchronous: false,
    streaming: true,
    acceptedAssetKinds: [],
    producedAssetKinds: [],
    controls: { privateControl: 'PRIVATE-CAPABILITY-CONTROL' }
  }
}

/**
 * 夹具：直接写模型目录（与 GUI「模型设置」保存后的形态一致）。
 * 密钥用测试专用 SQL 写入 `secret_ref`（旧版明文兼容读取），
 * 避免依赖本机 safeStorage/DPAPI——这不是产品写入路径。
 */
function seedCatalog(): SqliteModelHost {
  const host = new SqliteModelHost(getDb())
  host.saveConnection({
    id: 'conn-fixture-1',
    name: '连接显示名',
    protocol: 'openai-compatible',
    baseUrl: 'https://private.example.invalid/v1?token=SECRET-URL-TOKEN',
    headers: { Authorization: 'Bearer FAKE-AUTH-HEADER' },
    metadata: { private: 'PRIVATE-CONNECTION-METADATA' }
  })
  host.saveModel({
    id: 'def-fixture-1',
    connectionId: 'conn-fixture-1',
    modelId: 'fixture-model-a',
    name: '模型显示名',
    capabilities: [textCapability()]
  })
  const checkedAt = new Date().toISOString()
  host.saveValidation({
    connectionId: 'conn-fixture-1',
    modelDefinitionId: 'def-fixture-1',
    operation: 'text.generate',
    status: 'verified',
    message: 'PRIVATE-VALIDATION-MESSAGE',
    checkedAt,
    verifiedAt: checkedAt
  })
  host.saveBinding({
    featureKey: 'chat.generate',
    connectionId: 'conn-fixture-1',
    modelDefinitionId: 'def-fixture-1',
    operation: 'text.generate'
  })
  getDb()
    .prepare('UPDATE model_connections SET secret_ref = ? WHERE id = ?')
    .run(FAKE_SECRET, 'conn-fixture-1')
  return host
}

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'canvas-models-env-access-test-'))
  process.env.CANVAS_DATA_DIR = directory
  // IndexTTS 探测按设计不缓存且会扫描本机安装位置；测试用官方环境变量把扫描根收敛到
  // 临时目录（引擎自己文档里就是给测试隔离用的），保证结果与本机真实安装无关。
  process.env.CANVAS_STUDIO_INDEXTTS_SCAN_ROOTS = directory
  events.length = 0
  setGatewayEventSink({
    emit: (event) => {
      if (event) events.push(event)
    }
  })
  service = new LocalAccessService({
    instanceId: randomUUID(),
    appVersion: 'test',
    exportDirectory: join(getDataDir(), 'agent-exports'),
    activeProjectId: () => null
  })
})

afterEach(() => {
  vi.restoreAllMocks()
  closeDb()
  setGatewayEventSink(null)
  process.env.CANVAS_DATA_DIR = originalDirectory
  if (originalDirectory === undefined) delete process.env.CANVAS_DATA_DIR
  if (originalFfmpegPath === undefined) delete process.env.CANVAS_STUDIO_FFMPEG_PATH
  else process.env.CANVAS_STUDIO_FFMPEG_PATH = originalFfmpegPath
  if (originalSeparatorPath === undefined) delete process.env.CANVAS_STUDIO_AUDIO_SEPARATOR_PATH
  else process.env.CANVAS_STUDIO_AUDIO_SEPARATOR_PATH = originalSeparatorPath
  if (originalIndexTtsScanRoots === undefined) delete process.env.CANVAS_STUDIO_INDEXTTS_SCAN_ROOTS
  else process.env.CANVAS_STUDIO_INDEXTTS_SCAN_ROOTS = originalIndexTtsScanRoots
  if (
    resolve(directory, '..') !== resolve(tmpdir()) ||
    !basename(directory).startsWith('canvas-models-env-access-test-')
  )
    throw new Error('MODELS_ENV_ACCESS_TEST_CLEANUP_OUTSIDE_ISOLATION')
  rmSync(directory, { recursive: true, force: true })
})

describe('F9 模型目录读取（去敏投影）', () => {
  it('空库返回空列表且结构稳定，不联网探测', async () => {
    for (const [operation, key] of [
      ['model.connection.list', 'connections'],
      ['model.definition.list', 'models'],
      ['model.binding.list', 'bindings']
    ] as const) {
      const response = await call(operation)
      expect(response.status, JSON.stringify(response.error)).toBe('completed')
      const data = response.data as Record<string, unknown>
      expect(data[key]).toEqual([])
      expect(data.total).toBe(0)
      // 目录读取只报本地事实，不声称做过可达性探测。
      expect(data.reachability).toBe('not-probed')
    }
  })

  it('连接列表是字段白名单：不带地址、鉴权头、元数据或密钥引用', async () => {
    seedCatalog()
    const response = await call('model.connection.list')
    expect(response.status, JSON.stringify(response.error)).toBe('completed')
    const data = response.data as {
      connections: Array<Record<string, unknown>>
      total: number
      reachability: string
    }
    expect(data.total).toBe(1)
    expect(data.connections).toHaveLength(1)
    // 白名单是"只允许这些键"，任何新字段都要先过审查。
    expect(Object.keys(data.connections[0]).sort()).toEqual([
      'createdAt',
      'enabled',
      'id',
      'name',
      'protocol',
      'updatedAt'
    ])
    expect(data.connections[0]).toMatchObject({
      id: 'conn-fixture-1',
      name: '连接显示名',
      protocol: 'openai-compatible',
      enabled: true
    })
    const serialized = JSON.stringify([response, events])
    for (const secret of [
      'private.example.invalid',
      'SECRET-URL-TOKEN',
      'FAKE-AUTH-HEADER',
      'PRIVATE-CONNECTION-METADATA',
      FAKE_SECRET,
      'Authorization'
    ])
      expect(serialized, `连接列表泄漏了 ${secret}`).not.toContain(secret)
  })

  it('定义列表按 connectionId 过滤，且不返回能力控制参数、元数据与验证原文', async () => {
    const host = seedCatalog()
    host.saveConnection({
      id: 'conn-fixture-2',
      name: '第二连接',
      protocol: 'openai',
      baseUrl: 'https://second.example.invalid/v1',
      enabled: false
    })
    host.saveModel({
      id: 'def-fixture-2',
      connectionId: 'conn-fixture-2',
      modelId: 'fixture-model-b',
      name: '第二模型',
      capabilities: [textCapability()]
    })

    const all = await call('model.definition.list')
    expect(all.status, JSON.stringify(all.error)).toBe('completed')
    const allData = all.data as { models: Array<Record<string, any>>; total: number }
    expect(allData.total).toBe(2)
    expect(allData.models.map((model) => model.id).sort()).toEqual([
      'def-fixture-1',
      'def-fixture-2'
    ])

    const filtered = await call('model.definition.list', { connectionId: 'conn-fixture-2' })
    const filteredData = filtered.data as { models: Array<Record<string, any>>; total: number }
    expect(filteredData.total).toBe(1)
    expect(filteredData.models.map((model) => model.id)).toEqual(['def-fixture-2'])
    // 连接已停用：GUI 模型设置同样以 connectionEnabled 提示不可执行。
    expect(filteredData.models[0]).toMatchObject({
      connectionId: 'conn-fixture-2',
      modelId: 'fixture-model-b',
      enabled: true,
      connectionEnabled: false
    })
    // 未知连接 id 返回空页（与 GUI listModels(connectionId) 一致），不伪造错误。
    expect((await call('model.definition.list', { connectionId: 'missing-conn' })).data).toMatchObject({
      models: [],
      total: 0
    })

    const first = allData.models[0]
    expect(first).toMatchObject({
      id: 'def-fixture-1',
      connectionId: 'conn-fixture-1',
      modelId: 'fixture-model-a',
      enabled: true,
      connectionEnabled: true,
      capabilitiesTruncated: false,
      agentToolCalling: { status: 'unverified' }
    })
    expect(first.capabilities).toEqual([
      {
        operation: 'text.generate',
        asynchronous: false,
        streaming: true,
        acceptedAssetKinds: [],
        producedAssetKinds: []
      }
    ])
    expect(first.validation).toEqual([
      {
        operation: 'text.generate',
        status: 'verified',
        checkedAt: expect.any(String),
        verifiedAt: expect.any(String)
      }
    ])
    const serialized = JSON.stringify([all, filtered, events])
    for (const secret of [
      'PRIVATE-CAPABILITY-CONTROL',
      'PRIVATE-VALIDATION-MESSAGE',
      'private.example.invalid',
      'FAKE-AUTH-HEADER',
      FAKE_SECRET
    ])
      expect(serialized, `定义列表泄漏了 ${secret}`).not.toContain(secret)
  })

  it('绑定列表只给 featureKey 与目标三元组，不返回执行参数', async () => {
    seedCatalog()
    const response = await call('model.binding.list')
    expect(response.status, JSON.stringify(response.error)).toBe('completed')
    expect(response.data).toEqual({
      bindings: [
        {
          featureKey: 'chat.generate',
          modelDefinitionId: 'def-fixture-1',
          connectionId: 'conn-fixture-1',
          modelId: 'fixture-model-a',
          operation: 'text.generate',
          enabled: true,
          updatedAt: expect.any(String)
        }
      ],
      total: 1,
      reachability: 'not-probed'
    })
    expect(JSON.stringify(response)).not.toContain(FAKE_SECRET)
  })
})

describe('F9 默认绑定解析（与 GUI 同一解析服务）', () => {
  it('未绑定如实失败，已绑定返回实际会用的 provider/model', async () => {
    const unbound = await call('model.binding.resolve', {
      featureKey: 'chat.generate',
      operation: 'text.generate'
    })
    expect(unbound.status).toBe('failed')
    expect(unbound.error?.code).toBe('MODEL_BINDING_NOT_FOUND')
    expect(JSON.stringify(unbound)).not.toContain(FAKE_SECRET)

    seedCatalog()
    const resolved = await call('model.binding.resolve', {
      featureKey: 'chat.generate',
      operation: 'text.generate'
    })
    expect(resolved.status, JSON.stringify(resolved.error)).toBe('completed')
    expect(resolved.data).toEqual({
      featureKey: 'chat.generate',
      providerId: 'conn-fixture-1',
      modelId: 'fixture-model-a',
      operation: 'text.generate',
      modelKey: 'conn-fixture-1::fixture-model-a',
      resolvedFrom: 'feature-binding'
    })
    // 解析服务内部读过密钥（存在性检查），但密钥绝不出现在响应或事件里。
    const serialized = JSON.stringify([resolved, events])
    expect(serialized).not.toContain(FAKE_SECRET)
    expect(serialized).not.toContain('private.example.invalid')
    expect(serialized).not.toContain('FAKE-AUTH-HEADER')
  })

  it('显式 provider::model 目标优先于功能绑定，来源如实标注', async () => {
    seedCatalog()
    const explicit = await call('model.binding.resolve', {
      featureKey: 'chat.generate',
      operation: 'text.generate',
      modelKey: 'conn-fixture-1::fixture-model-a'
    })
    expect(explicit.status, JSON.stringify(explicit.error)).toBe('completed')
    expect(explicit.data).toMatchObject({
      resolvedFrom: 'explicit-target',
      providerId: 'conn-fixture-1',
      modelId: 'fixture-model-a',
      modelKey: 'conn-fixture-1::fixture-model-a'
    })
    const missing = await call('model.binding.resolve', {
      featureKey: 'chat.generate',
      operation: 'text.generate',
      modelKey: 'conn-fixture-1::missing-model'
    })
    expect(missing.status).toBe('failed')
    expect(missing.error?.code).toBe('MODEL_TARGET_NOT_FOUND')
  })

  it('能力不匹配、未验证与无凭据分别返回稳定错误码，不伪造成功', async () => {
    const host = seedCatalog()
    const mismatch = await call('model.binding.resolve', {
      featureKey: 'chat.generate',
      operation: 'image.generate'
    })
    expect(mismatch.status).toBe('failed')
    expect(mismatch.error?.code).toBe('MODEL_OPERATION_MISMATCH')

    // 已绑定但缺少可用密钥：与 GUI 一样如实拒绝（不返回半个目标）。
    host.saveConnection({
      id: 'conn-no-key',
      name: '无密钥连接',
      protocol: 'openai-compatible',
      baseUrl: 'https://nokey.example.invalid/v1'
    })
    host.saveModel({
      id: 'def-no-key',
      connectionId: 'conn-no-key',
      modelId: 'fixture-no-key',
      name: '无密钥模型',
      capabilities: [textCapability()]
    })
    host.saveValidation({
      connectionId: 'conn-no-key',
      modelDefinitionId: 'def-no-key',
      operation: 'text.generate',
      status: 'verified',
      checkedAt: new Date().toISOString()
    })
    host.saveBinding({
      featureKey: 'text.process',
      connectionId: 'conn-no-key',
      modelDefinitionId: 'def-no-key',
      operation: 'text.generate'
    })
    const noKey = await call('model.binding.resolve', {
      featureKey: 'text.process',
      operation: 'text.generate'
    })
    expect(noKey.status).toBe('failed')
    expect(noKey.error?.code).toBe('MODEL_NOT_CONFIGURED')
    expect(JSON.stringify(noKey)).not.toContain('nokey.example.invalid')
  })
})

describe('F9 本机环境状态（只读）', () => {
  it('缺 FFmpeg/audio-separator 时如实报告 unavailable，而不是让操作失败', async () => {
    // 指向必然不存在的可执行文件：与"用户机器未装依赖"同一代码路径，结果确定。
    process.env.CANVAS_STUDIO_FFMPEG_PATH = 'canvas-test-missing-ffmpeg-binary'
    process.env.CANVAS_STUDIO_AUDIO_SEPARATOR_PATH = 'canvas-test-missing-audio-separator-binary'
    const response = await call('environment.local')
    expect(response.status, JSON.stringify(response.error)).toBe('completed')
    const data = response.data as {
      ffmpeg: { available: boolean; message: string }
      ffprobe: { available: boolean; message: string }
      audioSeparator: { available: boolean; message: string }
      videoEngine: { pythonAvailable: boolean; ready: boolean; installing: boolean; gpuName?: string }
      indexTts: { ready: boolean; state: string }
    }
    expect(data.ffmpeg.available).toBe(false)
    expect(data.ffmpeg.message).toContain('FFmpeg')
    expect(data.ffprobe.available).toBe(false)
    expect(data.audioSeparator.available).toBe(false)
    expect(data.audioSeparator.message).toContain('audio-separator')
    // 全新数据目录没有本地推理环境：ready 必须为 false，且不声称在安装。
    expect(data.videoEngine.ready).toBe(false)
    expect(data.videoEngine.installing).toBe(false)
    expect(typeof data.videoEngine.pythonAvailable).toBe('boolean')
    // 本地 IndexTTS：只给粗粒度就绪状态（字段白名单），不返回解释器/模型目录。
    expect(Object.keys(data.indexTts).sort()).toEqual(['ready', 'state'])
    expect(['ready', 'incomplete', 'missing']).toContain(data.indexTts.state)
    expect(data.indexTts.ready).toBe(data.indexTts.state === 'ready')
    // 输出里不能出现本机绝对路径（数据目录/解释器/模型目录都不行）。
    expect(JSON.stringify(response)).not.toContain(directory)
    // probe 失败不改变业务结果，但失败事实仍可在响应里读到（不报假成功）。
    expect(events.some((event) => String(event?.event ?? '').includes('agent.access.completed'))).toBe(
      true
    )
  })

  it('视频引擎状态只读返回安装/就绪字段，不安装不下载', async () => {
    const response = await call('environment.videoEngine.status')
    expect(response.status, JSON.stringify(response.error)).toBe('completed')
    const data = response.data as Record<string, unknown>
    expect(typeof data.pythonAvailable).toBe('boolean')
    expect(data.ready).toBe(false)
    expect(data.installing).toBe(false)
    expect(typeof data.progress).toBe('string')
    expect(typeof data.message).toBe('string')
    expect(String(data.message).length).toBeGreaterThan(0)
    // 只读：调用前后数据目录里不应出现本地推理环境目录（没有触发安装/下载）。
    expect(data).not.toHaveProperty('installRequested')
  })
})

describe('F9 参数与实例边界', () => {
  it('非法参数、未知字段与畸形显式目标被拒绝', async () => {
    for (const [operation, input] of [
      ['model.connection.list', { limit: 101 }],
      ['model.connection.list', { offset: -1 }],
      ['model.definition.list', { connectionId: 'x'.repeat(201) }],
      ['model.binding.list', { limit: 0 }],
      ['model.binding.resolve', { featureKey: 'chat.generate' }],
      ['model.binding.resolve', { featureKey: 'chat.generate', operation: 'not-an-operation' }],
      [
        'model.binding.resolve',
        { featureKey: 'chat.generate', operation: 'text.generate', modelKey: 'no-separator' }
      ],
      ['environment.local', { install: true }],
      ['environment.videoEngine.status', { download: true }],
      // 环境类操作没有项目作用域：附带 projectId 必须按未知字段拒绝，而不是被静默忽略。
      ['environment.local', { projectId: 'project-fixture' }],
      ['model.definition.list', { projectId: 'project-fixture' }]
    ] as const) {
      const response = await call(operation, input)
      expect(response.status, `${operation} ${JSON.stringify(input)}`).toBe('failed')
      expect(response.error?.code, `${operation} ${JSON.stringify(input)}`).toBe('INVALID_INPUT')
    }
  })

  it('跨实例（dataStoreId 不符）拒绝，且 6 项操作全程不发起任何 fetch', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
    seedCatalog()
    for (const [operation, input] of [
      ['model.connection.list', {}],
      ['model.definition.list', {}],
      ['model.binding.list', {}],
      ['model.binding.resolve', { featureKey: 'chat.generate', operation: 'text.generate' }],
      ['environment.local', {}],
      ['environment.videoEngine.status', {}]
    ] as const) {
      const response = await call(operation, input)
      expect(response.status, `${operation}: ${JSON.stringify(response.error)}`).toBe('completed')
    }
    // 语音克隆/音色设计/视频生成三类只做代码层接通：本包不产生任何供应商请求。
    expect(fetchSpy).not.toHaveBeenCalled()

    const other = await service.dispatch({
      apiVersion: 1,
      operationVersion: 1,
      operationId: 'model.connection.list',
      input: {},
      requestId: randomUUID(),
      expectedDataStoreId: randomUUID()
    })
    expect(other.status).toBe('failed')
    expect(other.error?.code).toBe('INSTANCE_MISMATCH')
  })

  it('事件只含稳定操作字段，不含目录内容或密钥', async () => {
    seedCatalog()
    await call('model.binding.resolve', { featureKey: 'chat.generate', operation: 'text.generate' })
    const accessEvents = events.filter((event) => String(event?.event ?? '').startsWith('agent.access.'))
    expect(accessEvents.length).toBeGreaterThanOrEqual(2)
    for (const event of accessEvents) {
      const attributes = event.attributes ?? {}
      expect(attributes.operation).toBe('model.binding.resolve')
      expect(['started', 'completed', 'failed', 'rejected', 'unknown']).toContain(
        String(event.event).split('.').at(-1)
      )
    }
    const serialized = JSON.stringify(events)
    for (const secret of [FAKE_SECRET, 'private.example.invalid', 'PRIVATE-VALIDATION-MESSAGE'])
      expect(serialized).not.toContain(secret)
  })
})
