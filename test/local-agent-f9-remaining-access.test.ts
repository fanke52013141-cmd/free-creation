// F9 剩余可开放项的验收：调色板偏好读写 + 诊断包导出到受控目录。
//
// 断言重点：
// 1) 面板偏好是"纯界面偏好"：读写与 GUI 同一归一化（未知分类忽略、去重、补默认顺序），
//    重复保存 changed=false，不产生第二次写；
// 2) 诊断导出**只能写受控导出目录**：不接受路径参数、不覆盖已有文件、回执给
//    文件名/sha256/字节数，且不返回绝对路径；
// 3) 空范围/服务不可用必须如实拒绝，不能导出"全部事件"或空包冒充成功。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { closeDb, getDataDir } from '../src/main/store/db'
import { LocalAccessService } from '../src/main/agent-access/service'
import { setGatewayEventSink } from '../src/main/diagnostics/gateway-events'
import { defaultPalettePreferences } from '../src/shared/palette-preferences'
import {
  getPalettePreferences,
  savePalettePreferences
} from '../src/main/store/workspace-state.repo'

let directory: string
let service: LocalAccessService
const originalDirectory = process.env.CANVAS_DATA_DIR
const key = () => `${Date.now()}:${randomUUID()}`

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

const write = (operationId: string, input: unknown, idempotencyKey = key()) =>
  call(operationId, input, idempotencyKey)

/** 诊断服务替身：只实现本包用到的 health/query/exportBundle 三个方法。 */
function diagnosticsHost(options: { available?: boolean; writeBytes?: number } = {}) {
  const available = options.available !== false
  return {
    health: () => ({ available }),
    query: vi.fn(async () => ({ events: [], truncated: false, badLines: 0, scannedShards: 1 })),
    exportBundle: vi.fn(async (_input: unknown, filePath: string) => {
      writeFileSync(filePath, Buffer.alloc(options.writeBytes ?? 128, 7))
      return { totalEvents: 42 }
    })
  }
}

function withDiagnostics(host: ReturnType<typeof diagnosticsHost> | null): LocalAccessService {
  return new LocalAccessService({
    instanceId: randomUUID(),
    appVersion: 'test',
    exportDirectory: join(getDataDir(), 'agent-exports'),
    activeProjectId: () => null,
    diagnostics: host as never
  })
}

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'canvas-f9-remaining-test-'))
  process.env.CANVAS_DATA_DIR = directory
  setGatewayEventSink({ emit: () => undefined })
  service = withDiagnostics(null)
})

afterEach(() => {
  closeDb()
  if (originalDirectory === undefined) delete process.env.CANVAS_DATA_DIR
  else process.env.CANVAS_DATA_DIR = originalDirectory
  rmSync(directory, { recursive: true, force: true })
})

describe('调色板偏好读写', () => {
  it('默认值为完整分类顺序，读取不修改任何状态', async () => {
    const response = await call('workspace.palettePreferences.get')
    expect(response.status).toBe('completed')
    const fallback = defaultPalettePreferences()
    expect((response.data as { order: string[] }).order).toEqual(fallback.order)
    expect(getPalettePreferences().order).toEqual(fallback.order)
  })

  it('保存后读回一致；重复项去重、缺失分类补默认顺序；未知分类被严格 Schema 拒绝', async () => {
    const saved = await write('workspace.palettePreferences.save', {
      order: ['image', 'image', 'video'],
      labels: { image: '图片创作' }
    })
    expect(saved.status, JSON.stringify(saved.error)).toBe('completed')
    const data = saved.data as { order: string[]; labels: Record<string, string>; changed: boolean }
    expect(data.changed).toBe(true)
    // 去重
    expect(data.order.slice(0, 2)).toEqual(['image', 'video'])
    // 缺失分类被补齐，且总长度等于全部分类
    expect(new Set(data.order).size).toBe(data.order.length)
    expect(data.labels.image).toBe('图片创作')
    // 读回与落库一致
    expect(getPalettePreferences().order).toEqual(data.order)

    const read = await call('workspace.palettePreferences.get')
    expect((read.data as { order: string[] }).order).toEqual(data.order)

    // 未知分类属于输入错误：严格 Schema 直接拒绝，而不是"悄悄忽略后照常保存"。
    const unknown = await write('workspace.palettePreferences.save', {
      order: ['image', 'not-a-category']
    })
    expect(unknown.status).toBe('failed')
    expect(unknown.error?.code).toBe('INVALID_INPUT')
  })

  it('重复保存相同内容 changed=false 且不产生第二次写', async () => {
    const first = await write('workspace.palettePreferences.save', {
      order: ['image', 'video', 'audio', 'input', 'ai', 'data'],
      labels: { video: '视频创作' }
    })
    expect(first.status).toBe('completed')
    const before = getPalettePreferences()
    const second = await write('workspace.palettePreferences.save', {
      order: ['image', 'video', 'audio', 'input', 'ai', 'data'],
      labels: { video: '视频创作' }
    })
    expect((second.data as { changed: boolean }).changed).toBe(false)
    expect(getPalettePreferences()).toEqual(before)
  })

  it('非法输入被 Schema 拒绝（空顺序/超长名称）', async () => {
    const empty = await write('workspace.palettePreferences.save', { order: [] })
    expect(empty.status).toBe('failed')
    expect(empty.error?.code).toBe('INVALID_INPUT')
    const longLabel = await write('workspace.palettePreferences.save', {
      order: ['image'],
      labels: { image: 'x'.repeat(40) }
    })
    expect(longLabel.error?.code).toBe('INVALID_INPUT')
  })

  it('同一幂等键重放返回原回执', async () => {
    const idempotencyKey = key()
    const first = await call(
      'workspace.palettePreferences.save',
      { order: ['image', 'video'] },
      idempotencyKey
    )
    const replay = await call(
      'workspace.palettePreferences.save',
      { order: ['image', 'video'] },
      idempotencyKey
    )
    expect(replay.data).toEqual(first.data)
  })
})

describe('诊断包导出', () => {
  it('没有范围时拒绝（不允许导出"全部事件"）', async () => {
    service = withDiagnostics(diagnosticsHost())
    const response = await write('diagnostics.exportBundle', {})
    expect(response.status).toBe('failed')
    expect(response.error?.code).toBe('INVALID_INPUT')
  })

  it('服务不可用如实拒绝，不返回空包', async () => {
    service = withDiagnostics(diagnosticsHost({ available: false }))
    const response = await write('diagnostics.exportBundle', { traceId: 'trace-1' })
    expect(response.status).toBe('failed')
    expect(response.error?.code).toBe('DIAGNOSTICS_UNAVAILABLE')
  })

  it('导出成功：写入受控目录、回执含 sha256/字节数/事件数，且不返回绝对路径', async () => {
    const host = diagnosticsHost({ writeBytes: 256 })
    service = withDiagnostics(host)
    const response = await write('diagnostics.exportBundle', {
      traceId: 'trace-abc',
      label: '节点失败排查'
    })
    expect(response.status, JSON.stringify(response.error)).toBe('completed')
    const data = response.data as {
      fileName: string
      sha256: string
      byteSize: number
      totalEvents: number
    }
    expect(data.fileName).toMatch(/^diagnostics-.*\.zip$/)
    expect(data.byteSize).toBe(256)
    expect(data.totalEvents).toBe(42)
    // 文件真实落在受控导出目录内
    const target = join(getDataDir(), 'agent-exports', data.fileName)
    const bytes = readFileSync(target)
    expect(bytes.length).toBe(256)
    expect(data.sha256).toBe(createHash('sha256').update(bytes).digest('hex'))
    // 回执里不能出现绝对路径
    expect(JSON.stringify(response.data)).not.toContain(directory)
    expect(JSON.stringify(response.data)).not.toContain('agent-exports')
  })

  it('导出范围透传给同一 exportBundle（traceId/runId/时间窗）', async () => {
    const host = diagnosticsHost()
    service = withDiagnostics(host)
    await write('diagnostics.exportBundle', {
      runId: 'run-1',
      since: 1700000000000,
      until: 1700000001000
    })
    expect(host.exportBundle).toHaveBeenCalledTimes(1)
    const passed = host.exportBundle.mock.calls[0][0] as { scope: Record<string, unknown> }
    expect(passed.scope).toMatchObject({
      runId: 'run-1',
      since: 1700000000000,
      until: 1700000001000
    })
  })

  it('不接受任意输出路径（多余字段被 strict Schema 拒绝）', async () => {
    service = withDiagnostics(diagnosticsHost())
    const response = await write('diagnostics.exportBundle', {
      traceId: 'trace-1',
      filePath: 'C:\\Windows\\evil.zip'
    })
    expect(response.status).toBe('failed')
    expect(response.error?.code).toBe('INVALID_INPUT')
  })
})

describe('模型定义批量删除', () => {
  const textCapability = {
    operation: 'text.generate',
    asynchronous: false,
    streaming: true,
    acceptedAssetKinds: [],
    producedAssetKinds: [],
    controls: {}
  }

  async function seedConnectionAndModels(): Promise<void> {
    await write('model.connection.save', {
      id: 'conn-bulk',
      name: '批量删除用连接',
      protocol: 'openai-compatible',
      baseUrl: 'http://127.0.0.1:5400/v1'
    })
    for (const id of ['model-1', 'model-2']) {
      const saved = await write('model.definition.save', {
        id,
        connectionId: 'conn-bulk',
        name: id,
        modelId: 'upstream-' + id,
        capabilities: [textCapability]
      })
      expect(saved.status, JSON.stringify(saved.error)).toBe('completed')
    }
  }

  it('批量删除：已存在的被删、不存在的计入 notFound，不让整批失败', async () => {
    await seedConnectionAndModels()
    const response = await write('model.definition.deleteMany', {
      modelDefinitionIds: ['model-1', 'model-2', 'model-missing']
    })
    expect(response.status, JSON.stringify(response.error)).toBe('completed')
    const data = response.data as { deleted: string[]; notFound: string[] }
    expect(data.deleted.sort()).toEqual(['model-1', 'model-2'])
    expect(data.notFound).toEqual(['model-missing'])
    // 删除后单独删除应 NOT_FOUND（证明真的删掉了）
    const again = await write('model.definition.delete', { id: 'model-1' })
    expect(again.error?.code).toBe('NOT_FOUND')
  })

  it('空列表被 Schema 拒绝；重复 ID 只删一次', async () => {
    await seedConnectionAndModels()
    const empty = await write('model.definition.deleteMany', { modelDefinitionIds: [] })
    expect(empty.error?.code).toBe('INVALID_INPUT')

    const duplicated = await write('model.definition.deleteMany', {
      modelDefinitionIds: ['model-1', 'model-1']
    })
    expect(duplicated.status).toBe('completed')
    expect((duplicated.data as { deleted: string[] }).deleted).toEqual(['model-1'])
  })

  it('同一幂等键重放返回原回执，不重复删除', async () => {
    await seedConnectionAndModels()
    const idempotencyKey = key()
    const first = await call(
      'model.definition.deleteMany',
      { modelDefinitionIds: ['model-1'] },
      idempotencyKey
    )
    const replay = await call(
      'model.definition.deleteMany',
      { modelDefinitionIds: ['model-1'] },
      idempotencyKey
    )
    expect(replay.data).toEqual(first.data)
  })
})
