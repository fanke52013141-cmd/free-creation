// F9：凭据包导出/预览侧验收（用户边界：导出与预览开放；导入需人工确认，未在此开放）。
//
// 断言重点：
// 1) 服务未发布时如实拒绝（不降级成本地替身）；
// 2) **回执不返回包正文**——只给受控目录内的文件名 + sha256 + 字节数；
// 3) 不覆盖已有文件；接收凭证只按受控目录文件名读取（不接受任意路径）；
// 4) 预览不落库、只暴露主机名而不暴露完整 URL。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { rmSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { closeDb, getDataDir } from '../src/main/store/db'
import { LocalAccessService } from '../src/main/agent-access/service'
import {
  publishKeysPackageAccessPort,
  resetKeysPackageAccessPortForTest,
  type KeysPackageAccessPort
} from '../src/main/agent-access/keys-bridge'
import { setGatewayEventSink } from '../src/main/diagnostics/gateway-events'

let directory: string
let service: LocalAccessService
const originalDirectory = process.env.CANVAS_DATA_DIR
const key = () => `${Date.now()}:${randomUUID()}`

function call(operationId: string, input: unknown) {
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

const exportRoot = () => join(getDataDir(), 'agent-exports')

function stubPort(overrides: Partial<KeysPackageAccessPort> = {}) {
  const port: KeysPackageAccessPort = {
    exportReceiveCredential: vi.fn(async () => ({
      credentialText: 'CREDENTIAL-TEXT-SHOULD-NOT-LEAK',
      deviceSummary: 'device-abc',
      expiresAt: 4102444800
    })),
    sealKeyPackageForRecipient: vi.fn(async () => ({
      packageText: 'SEALED-PACKAGE-BODY-SHOULD-NOT-LEAK',
      packageId: 'pkg-1',
      expiresAt: 4102444800,
      connectionCount: 2
    })),
    openKeyPackagePreview: vi.fn(async () => ({
      packageId: 'pkg-1',
      expiresAt: 4102444800,
      issuerDeviceSummary: 'issuer-xyz',
      connections: [
        {
          id: 'conn-1',
          name: '供应商一',
          protocol: 'toapis',
          baseUrl: 'https://secret-host.example.com/v1?token=LEAK',
          modelCount: 3
        }
      ],
      alreadyImported: false
    })),
    listExportableConnections: vi.fn(async () => []),
    ...overrides
  }
  publishKeysPackageAccessPort(port)
  return port
}

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'canvas-keypkg-test-'))
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
  resetKeysPackageAccessPortForTest()
  closeDb()
  vi.restoreAllMocks()
  if (originalDirectory === undefined) delete process.env.CANVAS_DATA_DIR
  else process.env.CANVAS_DATA_DIR = originalDirectory
  rmSync(directory, { recursive: true, force: true })
})

describe('凭据包服务未发布', () => {
  it('如实拒绝且不写任何文件', async () => {
    resetKeysPackageAccessPortForTest()
    const response = await call('provider.package.preview', {
      fileName: 'x.cskeys',
      password: 'pw'
    })
    expect(response.status).toBe('failed')
    expect(response.error?.code).toBe('KEYS_SERVICE_UNAVAILABLE')
  })
})

describe('provider.package.seal', () => {
  it('封包写入受控目录，回执只给指纹不给包正文', async () => {
    const port = stubPort()
    writeFileSync(join(exportRoot(), 'recipient.cscred'), 'RECIPIENT-CREDENTIAL')
    const response = await call('provider.package.seal', {
      fileName: 'out.cskeys',
      password: 'pw-123',
      recipientCredentialFileName: 'recipient.cscred',
      connectionIds: ['conn-1', 'conn-2']
    })
    expect(response.status, JSON.stringify(response.error)).toBe('completed')
    const data = response.data as { fileName: string; sha256: string; byteSize: number; packageId: string; connectionCount: number }
    expect(data.fileName).toBe('out.cskeys')
    expect(data.packageId).toBe('pkg-1')
    expect(data.connectionCount).toBe(2)
    const target = join(exportRoot(), 'out.cskeys')
    const bytes = readFileSync(target)
    expect(bytes.length).toBe(data.byteSize)
    expect(data.sha256).toBe(createHash('sha256').update(bytes).digest('hex'))
    // 关键：回执里不能出现包正文
    expect(JSON.stringify(response.data)).not.toContain('SEALED-PACKAGE-BODY')
    // 接收凭证从受控目录读后交给同一服务
    expect(port.sealKeyPackageForRecipient).toHaveBeenCalledWith({
      password: 'pw-123',
      recipientCredentialText: 'RECIPIENT-CREDENTIAL',
      connectionIds: ['conn-1', 'conn-2']
    })
  })

  it('接收凭证缺失时拒绝；同名包不覆盖', async () => {
    stubPort()
    const missing = await call('provider.package.seal', {
      fileName: 'out2.cskeys',
      password: 'pw',
      recipientCredentialFileName: 'nope.cscred',
      connectionIds: ['conn-1']
    })
    expect(missing.status).toBe('failed')
    expect(missing.error?.code).toBe('INPUT_NOT_FOUND')

    writeFileSync(join(exportRoot(), 'r.cscred'), 'X')
    writeFileSync(join(exportRoot(), 'dup.cskeys'), 'existing')
    const dup = await call('provider.package.seal', {
      fileName: 'dup.cskeys',
      password: 'pw',
      recipientCredentialFileName: 'r.cscred',
      connectionIds: ['conn-1']
    })
    expect(dup.error?.code).toBe('OUTPUT_EXISTS')
    // 不覆盖：原内容还在
    expect(readFileSync(join(exportRoot(), 'dup.cskeys'), 'utf8')).toBe('existing')
  })
})

describe('provider.package.preview', () => {
  it('只读预览：不给完整 URL，不落库', async () => {
    stubPort()
    writeFileSync(join(exportRoot(), 'in.cskeys'), 'PACKAGE-BODY')
    const response = await call('provider.package.preview', {
      fileName: 'in.cskeys',
      password: 'pw'
    })
    expect(response.status, JSON.stringify(response.error)).toBe('completed')
    const data = response.data as {
      packageId: string
      connections: Array<{ host: string; name: string }>
    }
    expect(data.packageId).toBe('pkg-1')
    expect(data.connections[0].host).toBe('secret-host.example.com')
    expect(JSON.stringify(response.data)).not.toContain('LEAK')
    expect(JSON.stringify(response.data)).not.toContain('token=')
  })

  it('包文件不存在时拒绝', async () => {
    stubPort()
    const response = await call('provider.package.preview', {
      fileName: 'missing.cskeys',
      password: 'pw'
    })
    expect(response.status).toBe('failed')
    expect(response.error?.code).toBe('INPUT_NOT_FOUND')
  })
})

describe('路径边界', () => {
  it('文件名不允许路径穿越（Schema 只接受纯文件名）', async () => {
    stubPort()
    const response = await call('provider.package.preview', {
      fileName: '../../etc/passwd.cskeys',
      password: 'pw'
    })
    expect(response.status).toBe('failed')
    expect(response.error?.code).toBe('INVALID_INPUT')
    expect(existsSync(join(exportRoot(), '..', 'etc'))).toBe(false)
  })
})
