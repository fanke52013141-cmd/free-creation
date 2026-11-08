// F9 网络类操作验收（用户授权边界：显式确认才执行）。
//
// 断言重点：
// 1) **默认不执行**：不传 confirmNetwork 时直接拒绝，且**一次网络请求都不发**；
// 2) validate 会真实计费，因此必须在 confirmNetwork 之外再给 confirmCost；
// 3) 供应商不可用是**业务结果**（reachable=false）而不是"操作失败"，让调用方能区分
//    "没发出去"和"发了但失败"；
// 4) 回执去敏：不含地址、密钥或响应正文。
//
// 本测试把 gateway 与 model-runtime 全部替身化，**绝不产生真实供应商请求或费用**。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'

const testProviderMock = vi.fn()
const validateModelMock = vi.fn()

vi.mock('../src/main/gateway/factory', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/main/gateway/factory')>()
  return {
    ...actual,
    testProvider: (...args: unknown[]) => testProviderMock(...args)
  }
})
vi.mock('../src/main/model-host/runtime', () => ({
  createDesktopModelRuntime: () => ({ validateModel: (...args: unknown[]) => validateModelMock(...args) })
}))
vi.mock('../src/main/model-host/sqlite-model-host', () => ({
  SqliteModelHost: class {
    constructor() {}
  }
}))

import { closeDb, getDataDir } from '../src/main/store/db'
import { LocalAccessService } from '../src/main/agent-access/service'
import { setGatewayEventSink } from '../src/main/diagnostics/gateway-events'

let directory: string
let service: LocalAccessService
const originalDirectory = process.env.CANVAS_DATA_DIR
const key = () => `${Date.now()}:${randomUUID()}`

function write(operationId: string, input: unknown) {
  return service.dispatch({
    apiVersion: 1,
    operationVersion: 1,
    operationId,
    input,
    requestId: randomUUID(),
    expectedDataStoreId: service.dataStoreId,
    idempotencyKey: key()
  })
}

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'canvas-network-test-'))
  process.env.CANVAS_DATA_DIR = directory
  testProviderMock.mockReset()
  validateModelMock.mockReset()
  const fetchSpy = vi.spyOn(globalThis, 'fetch')
  fetchSpy.mockRejectedValue(new Error('NETWORK_FORBIDDEN_IN_TEST'))
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
  vi.restoreAllMocks()
  if (originalDirectory === undefined) delete process.env.CANVAS_DATA_DIR
  else process.env.CANVAS_DATA_DIR = originalDirectory
  rmSync(directory, { recursive: true, force: true })
})

describe('provider.testConnection', () => {
  it('未确认联网时拒绝，且不调用供应商测试、不发任何请求', async () => {
    const response = await write('provider.testConnection', { providerId: 'conn-1' })
    expect(response.status).toBe('failed')
    expect(response.error?.code).toBe('NETWORK_CONFIRM_REQUIRED')
    expect(testProviderMock).not.toHaveBeenCalled()
    expect(globalThis.fetch).not.toHaveBeenCalled()
  })

  it('确认后只传 id（不传密钥/地址），不可用按 reachable=false 返回', async () => {
    testProviderMock.mockRejectedValue(new Error('401 Unauthorized at https://secret.example.com/v1'))
    const response = await write('provider.testConnection', {
      providerId: 'conn-1',
      confirmNetwork: true
    })
    expect(response.status, JSON.stringify(response.error)).toBe('completed')
    const data = response.data as { reachable: boolean; message: string; modelCount: number }
    expect(data.reachable).toBe(false)
    expect(data.modelCount).toBe(0)
    // 只传 id：外部无法借这个接口注入密钥或探测任意地址
    expect(testProviderMock).toHaveBeenCalledTimes(1)
    expect(testProviderMock.mock.calls[0][0]).toEqual({ id: 'conn-1' })
    // 回执去敏
    expect(JSON.stringify(response.data)).not.toContain('secret.example.com')
  })

  it('可用时返回模型数量', async () => {
    testProviderMock.mockResolvedValue({ models: ['a', 'b', 'c'], message: '连接可用' })
    const response = await write('provider.testConnection', {
      providerId: 'conn-1',
      confirmNetwork: true
    })
    expect(response.status).toBe('completed')
    const data = response.data as { reachable: boolean; modelCount: number }
    expect(data.reachable).toBe(true)
    expect(data.modelCount).toBe(3)
  })
})

describe('model.validate', () => {
  it('未确认联网时拒绝且不发请求', async () => {
    const response = await write('model.validate', {
      connectionId: 'conn-1',
      modelDefinitionId: 'model-1',
      operation: 'text.generate'
    })
    expect(response.error?.code).toBe('NETWORK_CONFIRM_REQUIRED')
    expect(validateModelMock).not.toHaveBeenCalled()
  })

  it('确认联网但未确认费用时拒绝（validate 会真实计费）', async () => {
    const response = await write('model.validate', {
      connectionId: 'conn-1',
      modelDefinitionId: 'model-1',
      operation: 'text.generate',
      confirmNetwork: true
    })
    expect(response.status).toBe('failed')
    expect(response.error?.code).toBe('COST_CONFIRM_REQUIRED')
    expect(validateModelMock).not.toHaveBeenCalled()
  })

  it('双重确认后调用同一 validateModel 并返回状态', async () => {
    validateModelMock.mockResolvedValue({ status: 'verified', message: '验证通过' })
    const response = await write('model.validate', {
      connectionId: 'conn-1',
      modelDefinitionId: 'model-1',
      operation: 'text.generate',
      confirmNetwork: true,
      confirmCost: true
    })
    expect(response.status, JSON.stringify(response.error)).toBe('completed')
    const data = response.data as { status: string }
    expect(data.status).toBe('verified')
    expect(validateModelMock).toHaveBeenCalledWith('conn-1', 'model-1', 'text.generate')
  })

  it('验证失败如实报 failed 而不是伪造通过', async () => {
    validateModelMock.mockResolvedValue({ status: 'failed', message: '供应商返回 400' })
    const response = await write('model.validate', {
      connectionId: 'conn-1',
      modelDefinitionId: 'model-1',
      operation: 'text.generate',
      confirmNetwork: true,
      confirmCost: true
    })
    expect(response.status).toBe('completed')
    expect((response.data as { status: string }).status).toBe('failed')
  })
})
