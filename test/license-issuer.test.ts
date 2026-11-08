/**
 * cs-issuer CLI e2e 测试：真实子进程跑签发工具，与设备端 LicenseService
 * （内存软件适配器）完成 申领→登记→挑战→证明→发证→激活→撤销 全流程。
 *
 * 覆盖：期限互斥/非法天数拒绝、未登记设备拒绝、挑战消费与幂等补发、
 * 强模式 EK 要求、根签发的签发人撤销、过期挑战拒绝。
 */
import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { TrustedRoot } from '@free-creation/license-protocol'
import { createInMemorySoftwareAdapter } from '../src/main/security/license/device/software'
import { LicenseService } from '../src/main/security/license/service'
import { loadIssuerCert, type StoredIssuerCert } from '../tools/cs-issuer/keystore'

const CLI_PATH = join(__dirname, '..', 'tools', 'cs-issuer', 'cli.ts')
const NODE_OPTIONS = ['--experimental-transform-types', '--no-warnings']

function runCli(storeDir: string, args: string[], expectExit = 0): { stdout: string; status: number } {
  try {
    const stdout = execFileSync(process.execPath, [...NODE_OPTIONS, CLI_PATH, ...args, '--store', storeDir], {
      encoding: 'utf8',
      timeout: 60_000
    })
    expect(expectExit).toBe(0)
    return { stdout, status: 0 }
  } catch (error) {
    const err = error as { status?: number; stdout?: string; stderr?: string }
    if (expectExit === 0) {
      throw new Error(`CLI 意外失败 (exit=${err.status}): ${err.stderr ?? err.stdout ?? String(error)}`)
    }
    expect(err.status).toBe(expectExit)
    return { stdout: err.stdout ?? '', stderr: err.stderr ?? '', status: err.status ?? -1 }
  }
}

describe('cs-issuer CLI e2e', () => {
  let rootDir: string
  let storeDir: string

  beforeEach(() => {
    rootDir = mkdtempSync(join(tmpdir(), 'cs-issuer-e2e-'))
    storeDir = join(rootDir, 'issuer-store')
  })

  afterEach(() => {
    rmSync(rootDir, { recursive: true, force: true })
  })

  /** 设备端服务：信任 CLI 签发库的根公钥；CLI 用真实时间签发，这里同样走真实时钟。 */
  function makeDeviceService(): LicenseService {
    const rootPublic = JSON.parse(readFileSync(join(storeDir, 'root.public.json'), 'utf8')) as TrustedRoot
    return new LicenseService({
      root: rootPublic,
      adapter: createInMemorySoftwareAdapter(),
      storageDir: join(rootDir, 'device-security')
    })
  }

  /** 第二台设备：独立存储目录（跨设备拒绝验证用）。 */
  function makeDeviceServiceB(): LicenseService {
    const rootPublic = JSON.parse(readFileSync(join(storeDir, 'root.public.json'), 'utf8')) as TrustedRoot
    return new LicenseService({
      root: rootPublic,
      adapter: createInMemorySoftwareAdapter(),
      storageDir: join(rootDir, 'device-b-security')
    })
  }

  it('全流程：init-root → enroll-ek → challenge → 证明 → issue → 激活 → revoke', async () => {
    // 1. 初始化签发库。
    const init = runCli(storeDir, ['init-root', '--subject', 'e2e-issuer'])
    expect(init.stdout).toContain('根密钥已生成')
    expect(existsSync(join(storeDir, 'root-signing.private.json'))).toBe(true)

    // 2. 设备导出申请。
    const service = makeDeviceService()
    const { requestText } = await service.createDeviceRequest()
    const requestPath = join(rootDir, 'device.csreq')
    writeFileSync(requestPath, requestText, 'utf8')

    // 3. 未登记设备 → challenge 拒绝（exit 2）。
    runCli(storeDir, ['challenge', '--request', requestPath, '--out', join(rootDir, 'x.cschallenge')], 2)

    // 4. 登记 → 挑战。
    runCli(storeDir, ['enroll-ek', '--request', requestPath, '--note', 'e2e 机'])
    const challengePath = join(rootDir, 'device.cschallenge')
    runCli(storeDir, ['challenge', '--request', requestPath, '--out', challengePath])

    // 5. 设备处理挑战 → 证明。
    const proofPath = join(rootDir, 'device.csproof')
    const { proofText } = await service.importChallenge(readFileSync(challengePath, 'utf8'))
    writeFileSync(proofPath, proofText, 'utf8')

    // 6. 期限参数校验：缺省 / 双选 / 非法天数 → exit 2。
    const common = ['--proof', proofPath, '--out', join(rootDir, 'device.cslicense')]
    runCli(storeDir, ['issue', ...common], 2)
    runCli(storeDir, ['issue', ...common, '--days', '30', '--permanent'], 2)
    runCli(storeDir, ['issue', ...common, '--days', '0'], 2)
    runCli(storeDir, ['issue', ...common, '--days', '-1'], 2)
    runCli(storeDir, ['issue', ...common, '--days', '2.5'], 2)

    // 7. 正式发证（按天 30 天）。
    const licensePath = join(rootDir, 'device.cslicense')
    const issueOut = runCli(storeDir, [
      'issue',
      '--proof',
      proofPath,
      '--days',
      '30',
      '--role',
      'recipient',
      '--operator',
      'e2e-admin',
      '--out',
      licensePath
    ])
    expect(issueOut.stdout).toContain('授权已签发')
    expect(issueOut.stdout).toContain('30 天')

    // 8. 设备导入授权 → active。
    const snapshot = await service.importLicense(readFileSync(licensePath, 'utf8'))
    expect(snapshot.state).toBe('active')
    expect(snapshot.term).toBe('days')

    // 9. 幂等重试：同证明再 issue → 原样补发，文件内容一致。
    const replayOut = runCli(storeDir, [
      'issue',
      '--proof',
      proofPath,
      '--days',
      '30',
      '--out',
      join(rootDir, 'device-replay.cslicense')
    ])
    expect(replayOut.stdout).toContain('原样补发')
    expect(readFileSync(join(rootDir, 'device-replay.cslicense'), 'utf8')).toBe(
      readFileSync(licensePath, 'utf8')
    )

    // 10. inspect 验签。
    const inspectOut = runCli(storeDir, ['inspect', '--file', licensePath])
    expect(inspectOut.stdout).toContain('签名已验证')
    expect(inspectOut.stdout).toContain('按天')

    // 11. 撤销 → 设备导入策略 → locked。
    const licenseId = snapshot.licenseId as string
    const policyPath = join(rootDir, 'revocations.cspolicy')
    const revokeOut = runCli(storeDir, ['revoke', '--license-id', licenseId, '--out', policyPath])
    expect(revokeOut.stdout).toContain('撤销策略已签发')

    const policyResult = await service.importRevocationPolicy(readFileSync(policyPath, 'utf8'))
    expect(policyResult.applied).toBe(true)
    expect(service.snapshot.state).toBe('locked')
    expect(service.snapshot.reasonCode).toBe('LICENSE_REVOKED')

    // 12. 台账核对。
    const listOut = runCli(storeDir, ['list'])
    expect(listOut.stdout).toContain('登记设备: 1')
    expect(listOut.stdout).toContain(licenseId)
  })


  it('信任直发：申请过来 → 授权回去 → 激活（一来一回）', async () => {
    runCli(storeDir, ['init-root', '--subject', 'e2e-direct'])
    const service = makeDeviceService()
    const { requestText } = await service.createDeviceRequest()
    const requestPath = join(rootDir, 'device.csreq')
    writeFileSync(requestPath, requestText, 'utf8')
    runCli(storeDir, ['enroll-ek', '--request', requestPath])

    const licensePath = join(rootDir, 'device-direct.cslicense')
    const out = runCli(storeDir, [
      'issue',
      '--request',
      requestPath,
      '--trust-request',
      '--allow-soft-dev',
      '--permanent',
      '--role',
      'recipient',
      '--operator',
      'e2e-direct',
      '--out',
      licensePath
    ])
    expect(out.stdout).toContain('信任直发')
    expect(out.stdout).toContain('永久有效')

    // 导入即激活——无任何挑战/证明前置。
    const snapshot = await service.importLicense(readFileSync(licensePath, 'utf8'))
    expect(snapshot.state).toBe('active')
    expect(snapshot.term).toBe('permanent')

    // 续期 = 同申请再签（序号递增），仍只对此设备有效。
    const renewal = runCli(storeDir, [
      'issue',
      '--request',
      requestPath,
      '--trust-request',
      '--allow-soft-dev',
      '--days',
      '30',
      '--out',
      join(rootDir, 'device-renewal.cslicense')
    ])
    expect(renewal.stdout).toContain('序号: 2')

    // 跨设备：把直发授权复制到设备 B → 拒绝。
    const serviceB = makeDeviceServiceB()
    await serviceB.createDeviceRequest()
    await expect(serviceB.importLicense(readFileSync(licensePath, 'utf8'))).rejects.toMatchObject({
      code: 'LICENSE_DEVICE_MISMATCH'
    })

    // 台账记录模式。
    const listOut = runCli(storeDir, ['list'])
    expect(listOut.stdout).toContain('模式=trust-request')
  })

  it('信任直发拒绝 software-dev 申请（防一码多机）', async () => {
    runCli(storeDir, ['init-root', '--subject', 'e2e-direct-soft'])
    const service = makeDeviceService()
    const { requestText } = await service.createDeviceRequest()
    // 篡改申请的 keySource 为 software-dev（模拟软件密钥伪造申请）。
    const request = JSON.parse(requestText) as { device: { keySource: string } }
    request.device.keySource = 'software-dev'
    const forgedPath = join(rootDir, 'forged.csreq')
    writeFileSync(forgedPath, JSON.stringify(request), 'utf8')
    const out = runCli(
      storeDir,
      [
        'issue',
        '--request',
        forgedPath,
        '--trust-request',
        '--permanent',
        '--out',
        join(rootDir, 'forged.cslicense')
      ],
      2
    )
    expect(out.stderr).toContain('software-dev')
  })

  it('challenge --strong 拒绝无 EK 摘要的软件设备', async () => {
    runCli(storeDir, ['init-root', '--subject', 'e2e-strong'])
    const service = makeDeviceService()
    const { requestText } = await service.createDeviceRequest()
    const requestPath = join(rootDir, 'device.csreq')
    writeFileSync(requestPath, requestText, 'utf8')
    runCli(storeDir, ['enroll-ek', '--request', requestPath])
    // 软件设备没有 EK：强模式拒绝。
    runCli(
      storeDir,
      ['challenge', '--request', requestPath, '--out', join(rootDir, 'x.cschallenge'), '--strong'],
      2
    )
    // 非强模式允许（隔离联调用途）。
    runCli(storeDir, ['challenge', '--request', requestPath, '--out', join(rootDir, 'ok.cschallenge')])
  })

  it('revoke-issuer 由根签署', () => {
    runCli(storeDir, ['init-root', '--subject', 'e2e-root-revoke'])
    const cert: StoredIssuerCert = loadIssuerCert(storeDir)
    const policyPath = join(rootDir, 'issuer-revoke.cspolicy')
    const out = runCli(storeDir, ['revoke-issuer', '--cert-id', cert.payload.certId, '--out', policyPath])
    expect(out.stdout).toContain('由根签署')
    // 根直签策略无需携带签发人证书信封。
    expect(readFileSync(policyPath, 'utf8')).not.toContain('"issuerCert"')
  })

  it('过期挑战拒绝发证（台账为准）', async () => {
    runCli(storeDir, ['init-root', '--subject', 'e2e-expire'])
    const service = makeDeviceService()
    const { requestText } = await service.createDeviceRequest()
    const requestPath = join(rootDir, 'device.csreq')
    writeFileSync(requestPath, requestText, 'utf8')
    runCli(storeDir, ['enroll-ek', '--request', requestPath])
    const challengePath = join(rootDir, 'device.cschallenge')
    runCli(storeDir, ['challenge', '--request', requestPath, '--out', challengePath])

    // 把台账中的挑战期限改为已过期（模拟挑战在签发端长期滞留）。
    // 设备端只看签名挑战内的有效期，因此设备侧证明仍可生成；
    // 签发端按台账时间拒绝发证。
    const ledgerPath = join(storeDir, 'ledger.json')
    const ledger = JSON.parse(readFileSync(ledgerPath, 'utf8')) as {
      challenges: Array<{ expiresAtUtcSec: number }>
    }
    ledger.challenges[0].expiresAtUtcSec = Math.floor(Date.now() / 1000) - 10
    writeFileSync(ledgerPath, JSON.stringify(ledger, null, 2), 'utf8')

    const proofPath = join(rootDir, 'device.csproof')
    const { proofText } = await service.importChallenge(readFileSync(challengePath, 'utf8'))
    writeFileSync(proofPath, proofText, 'utf8')

    runCli(
      storeDir,
      ['issue', '--proof', proofPath, '--days', '30', '--out', join(rootDir, 'late.cslicense')],
      2
    )
    // 未产生任何授权记录。
    const ledgerAfter = JSON.parse(readFileSync(ledgerPath, 'utf8')) as { issues: unknown[] }
    expect(ledgerAfter.issues).toHaveLength(0)
  })
})
