// F9 收尾：供应商目录只读投影的验收（重点是**去敏**）。
//
// 断言：只返回 id/名称/协议/模型数/是否有密钥/是否遗留；
// **绝不返回 baseURL、鉴权头、密钥密文或密钥引用**；不联网探测；分页边界正确。
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { closeDb, getDataDir, getDb } from '../src/main/store/db'
import { LocalAccessService } from '../src/main/agent-access/service'
import { setGatewayEventSink } from '../src/main/diagnostics/gateway-events'

let directory: string
let service: LocalAccessService
const originalDirectory = process.env.CANVAS_DATA_DIR

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

/** 插一条遗留 providers 行：含地址与密钥引用，用于验证投影不会泄漏它们。 */
function seedLegacyProvider(): void {
  getDb()
    .prepare(
      `INSERT INTO providers (id, name, spec_id, base_url, api_key_ref, models, created_at)
       VALUES (?,?,?,?,?,?,?)`
    )
    .run(
      'legacy-1',
      '遗留供应商',
      'toapis',
      'https://secret-host.example.com/v1?token=SHOULD-NOT-LEAK',
      'vault:provider:legacy-1',
      JSON.stringify([
        { id: 'legacy-model-a', name: 'A', modality: 'image' },
        { id: 'legacy-model-b', name: 'B', modality: 'video' }
      ]),
      Date.now()
    )
}

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'canvas-provider-test-'))
  process.env.CANVAS_DATA_DIR = directory
  setGatewayEventSink({ emit: () => undefined })
  service = new LocalAccessService({
    instanceId: randomUUID(),
    appVersion: 'test',
    exportDirectory: join(getDataDir(), 'agent-exports'),
    activeProjectId: () => null
  })
})

afterEach(() => {
  closeDb()
  if (originalDirectory === undefined) delete process.env.CANVAS_DATA_DIR
  else process.env.CANVAS_DATA_DIR = originalDirectory
  rmSync(directory, { recursive: true, force: true })
})

describe('供应商目录只读投影', () => {
  it('provider.list 返回遗留档案且不泄漏地址/密钥引用', async () => {
    seedLegacyProvider()
    const response = await call('provider.list', { limit: 50 })
    expect(response.status, JSON.stringify(response.error)).toBe('completed')
    const data = response.data as {
      items: Array<Record<string, unknown>>
      total: number
      offset: number
      limit: number
      nextOffset: number | null
    }
    expect(data.total).toBeGreaterThanOrEqual(1)
    const legacy = data.items.find((item) => item.id === 'legacy-1')
    expect(legacy, '遗留档案应可见').toBeDefined()
    expect(legacy!.legacy).toBe(true)
    expect(legacy!.modelCount).toBe(2)
    // 关键：字段白名单
    expect(Object.keys(legacy!).sort()).toEqual(
      ['hasApiKey', 'id', 'legacy', 'modelCount', 'name', 'specId'].sort()
    )
    const serialized = JSON.stringify(response.data)
    expect(serialized).not.toContain('secret-host.example.com')
    expect(serialized).not.toContain('SHOULD-NOT-LEAK')
    expect(serialized).not.toContain('vault:provider')
    expect(serialized).not.toContain('baseUrl')
    expect(serialized).not.toContain('apiKeyRef')
  })

  it('分页边界正确（nextOffset 在末页为 null）', async () => {
    seedLegacyProvider()
    const page = await call('provider.list', { limit: 1, offset: 0 })
    expect(page.status).toBe('completed')
    const data = page.data as { items: unknown[]; nextOffset: number | null }
    expect(data.items).toHaveLength(1)
    // 只有 1 条档案时 nextOffset 必须是 null
    expect(data.nextOffset).toBeNull()
  })

  it('provider.listExecutable 只给可执行目录，不含遗留档案', async () => {
    seedLegacyProvider()
    const response = await call('provider.listExecutable')
    expect(response.status).toBe('completed')
    const data = response.data as { items: Array<{ id: string; legacy: boolean }> }
    expect(data.items.some((item) => item.id === 'legacy-1')).toBe(false)
    for (const item of data.items) expect(item.legacy).toBe(false)
  })

  it('provider.exportableConnections 同样去敏且只含可执行目录', async () => {
    seedLegacyProvider()
    const response = await call('provider.exportableConnections')
    expect(response.status).toBe('completed')
    const data = response.data as { items: Array<Record<string, unknown>> }
    expect(data.items.some((item) => item.id === 'legacy-1')).toBe(false)
    const serialized = JSON.stringify(response.data)
    expect(serialized).not.toContain('secret-host.example.com')
    expect(serialized).not.toContain('vault:provider')
  })

  it('非法分页被 Schema 拒绝', async () => {
    const response = await call('provider.list', { limit: 0 })
    expect(response.status).toBe('failed')
    expect(response.error?.code).toBe('INVALID_INPUT')
  })
})
