/**
 * LicenseService 测试：用内存软件适配器 + 协议包签发端模拟完整发证流程。
 *
 * 覆盖：激活（按天/永久）、到期锁定、跨设备拒绝、序号回退、撤销策略、
 * 失败激活保留旧授权、守卫断言、时钟回拨、挑战绑定、证书覆盖检查。
 */
import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, copyFileSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { Buffer } from 'node:buffer'
import {
  decodeBase64Url,
  encodeBase64Url,
  generateIssuerKey,
  generateRootKey,
  issueChallenge,
  issueIssuerCert,
  issueLicense,
  issueRevocationPolicy,
  verifyWithPurpose,
  type DeviceRequest,
  type IssuerCertPayload,
  type TrustedRoot
} from '@free-creation/license-protocol'
import { SoftwareDeviceAdapter, createInMemorySoftwareAdapter } from '../src/main/security/license/device/software'
import { LicenseService } from '../src/main/security/license/service'
import { LicenseError } from '../src/main/security/license/errors'

interface SimulatedAuthority {
  root: TrustedRoot
  rootKey: ReturnType<typeof generateRootKey>
  issuerKey: ReturnType<typeof generateIssuerKey>
  cert: IssuerCertPayload
  certEnvelope: unknown
  sequenceByDevice: Map<string, number>
}

function createAuthority(nowSec: number, certValidity?: { notBefore: number; notAfter: number }): SimulatedAuthority {
  const rootKey = generateRootKey()
  const issuerKey = generateIssuerKey()
  const { envelope, payload } = issueIssuerCert({
    root: rootKey,
    issuer: issuerKey,
    subject: 'test-issuer',
    capabilities: ['challenge.issue', 'license.issue', 'revocation.issue'],
    notBefore: certValidity?.notBefore ?? nowSec - 3600,
    notAfter: certValidity?.notAfter ?? nowSec + 365 * 86400
  })
  return {
    root: { kid: rootKey.kid, publicKey: rootKey.publicKey },
    rootKey,
    issuerKey,
    cert: payload,
    certEnvelope: envelope,
    sequenceByDevice: new Map()
  }
}

function challengeFileText(authority: SimulatedAuthority, issued: ReturnType<typeof issueChallenge>): string {
  return JSON.stringify({ challenge: issued.envelope, issuerCert: authority.certEnvelope })
}

function licenseFileText(authority: SimulatedAuthority, issued: ReturnType<typeof issueLicense>): string {
  return JSON.stringify({ license: issued.envelope, issuerCert: authority.certEnvelope })
}

/** 模拟管理员完成 申领→挑战→证明→发证 全流程，返回 .cslicense 文件文本。 */
async function simulateIssuance(input: {
  authority: SimulatedAuthority
  service: LicenseService
  role?: 'recipient' | 'key-issuer'
  term: 'days' | 'permanent'
  days?: number
  /** 以「现在」为基准的签发时刻偏移（秒），默认 0。 */
  issuedAtOffsetSec?: number
  nowSec: number
}): Promise<{ licenseText: string; licenseId: string; deviceSummary: string; requestId: string }> {
  const { requestText, deviceSummary, requestId } = await input.service.createDeviceRequest()
  const request = JSON.parse(requestText) as DeviceRequest
  const issuedAt = input.nowSec + (input.issuedAtOffsetSec ?? 0)
  const challenge = issueChallenge({
    issuer: input.authority.issuerKey,
    request,
    requestText,
    nowSec: input.nowSec,
    ttlSec: 48 * 3600
  })
  const { proofText } = await input.service.importChallenge(challengeFileText(input.authority, challenge))
  void proofText // 台账核对逻辑由 issuer e2e 测试覆盖；这里信任协议包 verifyProof。
  const sequence = (input.authority.sequenceByDevice.get(deviceSummary) ?? 0) + 1
  input.authority.sequenceByDevice.set(deviceSummary, sequence)
  const license = issueLicense({
    issuer: input.authority.issuerKey,
    issuerCert: input.authority.cert,
    request,
    sequence,
    role: input.role ?? 'recipient',
    term: input.term,
    days: input.days,
    nowSec: issuedAt
  })
  return {
    licenseText: licenseFileText(input.authority, license),
    licenseId: license.payload.licenseId,
    deviceSummary,
    requestId
  }
}

describe('LicenseService 全流程', () => {
  let rootDir: string
  let nowSec: number
  let authority: SimulatedAuthority

  beforeEach(() => {
    rootDir = mkdtempSync(join(tmpdir(), 'cs-license-service-'))
    nowSec = 1_900_000_000
    authority = createAuthority(nowSec)
  })

  afterEach(() => {
    rmSync(rootDir, { recursive: true, force: true })
  })

  function makeService(
    device: SoftwareDeviceAdapter = createInMemorySoftwareAdapter(),
    clockNow: () => number = () => nowSec,
    auth: SimulatedAuthority = authority,
    storageDir: string = join(rootDir, 'security')
  ): LicenseService {
    return new LicenseService({
      root: auth.root,
      adapter: device,
      storageDir,
      now: clockNow
    })
  }

  it('未导入授权时为 unlicensed，守卫拒绝', async () => {
    const service = makeService()
    const snapshot = await service.evaluateOnBoot('test')
    expect(snapshot.state).toBe('unlicensed')
    expect(() => service.assertActive('model.secret.read')).toThrowError(LicenseError)
  })

  it('按天授权：申请→挑战→证明→发证→激活→重启复验', async () => {
    const device = createInMemorySoftwareAdapter()
    const service = makeService(device)
    const issuance = await simulateIssuance({ authority, service, term: 'days', days: 30, nowSec })

    const snapshot = await service.importLicense(issuance.licenseText)
    expect(snapshot.state).toBe('active')
    expect(snapshot.term).toBe('days')
    expect(snapshot.expiresAt).toBe(nowSec + 30 * 86400)
    expect(snapshot.licenseId).toBe(issuance.licenseId)
    expect(snapshot.sequence).toBe(1)

    // 冷启动复验：同一设备密钥 + 同一存储目录。
    const rebooted = makeService(device)
    const afterBoot = await rebooted.evaluateOnBoot('test')
    expect(afterBoot.state).toBe('active')
    expect(afterBoot.licenseId).toBe(issuance.licenseId)

    // 激活后守卫放行，暂存申请已清理。
    expect(() => service.assertActive('model.secret.read')).not.toThrow()
    expect(existsSync(join(rootDir, 'security', 'pending-request.json'))).toBe(false)
    expect(existsSync(join(rootDir, 'security', 'license-current.json'))).toBe(true)
  })

  it('永久授权：激活并显示永久有效', async () => {
    const service = makeService()
    const issuance = await simulateIssuance({ authority, service, term: 'permanent', nowSec })
    const snapshot = await service.importLicense(issuance.licenseText)
    expect(snapshot.state).toBe('active')
    expect(snapshot.term).toBe('permanent')
    expect(snapshot.expiresAt).toBeNull()
    expect(snapshot.message).toContain('永久')
  })

  it('key-issuer 角色带 credentials.export 能力', async () => {
    const service = makeService()
    const issuance = await simulateIssuance({ authority, service, term: 'permanent', role: 'key-issuer', nowSec })
    const snapshot = await service.importLicense(issuance.licenseText)
    expect(snapshot.capabilities).toContain('credentials.export')
  })

  it('过期授权导入被拒绝且保留旧授权', async () => {
    // 证书有效期覆盖到过去，保证「过去签发、现已到期」的授权能通过链验证。
    const pastAuthority = createAuthority(nowSec, { notBefore: nowSec - 5 * 86400, notAfter: nowSec + 86400 })
    const device = createInMemorySoftwareAdapter()
    const service = makeService(device, () => nowSec, pastAuthority)
    const good = await simulateIssuance({ authority: pastAuthority, service, term: 'days', days: 30, nowSec })
    const active = await service.importLicense(good.licenseText)
    expect(active.state).toBe('active')

    // 再签一个已过期的授权（签发于 2 天前、1 天期）。
    const expired = await simulateIssuance({
      authority: pastAuthority,
      service,
      term: 'days',
      days: 1,
      issuedAtOffsetSec: -2 * 86400,
      nowSec
    })
    await expect(service.importLicense(expired.licenseText)).rejects.toMatchObject({
      code: 'LICENSE_EXPIRED'
    })
    // 旧授权仍然生效。
    expect(service.snapshot.state).toBe('active')
    expect(service.snapshot.licenseId).toBe(good.licenseId)
  })

  it('跨设备：A 的授权导入 B 被拒绝', async () => {
    const serviceA = makeService()
    const issuance = await simulateIssuance({ authority, service: serviceA, term: 'permanent', nowSec })
    expect((await serviceA.importLicense(issuance.licenseText)).state).toBe('active')

    // 设备 B：独立存储目录 + 先走正常申请流程创建自己的密钥，再导入 A 的授权文件。
    const serviceB = makeService(undefined, () => nowSec, authority, join(rootDir, 'security-device-b'))
    await serviceB.createDeviceRequest()
    await expect(serviceB.importLicense(issuance.licenseText)).rejects.toMatchObject({
      code: 'LICENSE_DEVICE_MISMATCH'
    })
    expect(serviceB.snapshot.state).toBe('unlicensed')
    expect((await serviceB.evaluateOnBoot('test')).state).toBe('unlicensed')
  })

  it('复制存储目录到另一台机器后锁定（单机锁）', async () => {
    const serviceA = makeService()
    const issuance = await simulateIssuance({ authority, service: serviceA, term: 'permanent', nowSec })
    await serviceA.importLicense(issuance.licenseText)

    // 模拟把授权存储目录复制到设备 B（B 有自己的硬件密钥）。
    const copiedSecurityDir = join(rootDir, 'copied-security')
    mkdirSync(copiedSecurityDir, { recursive: true })
    copyFileSync(join(rootDir, 'security', 'license-current.json'), join(copiedSecurityDir, 'license-current.json'))
    copyFileSync(join(rootDir, 'security', 'license-state.json'), join(copiedSecurityDir, 'license-state.json'))

    const deviceB = createInMemorySoftwareAdapter()
    await deviceB.createDeviceKeys()
    const serviceB = new LicenseService({
      root: authority.root,
      adapter: deviceB,
      storageDir: copiedSecurityDir,
      now: () => nowSec
    })
    const snapshot = await serviceB.evaluateOnBoot('test')
    expect(snapshot.state).toBe('locked')
    expect(snapshot.reasonCode).toBe('LICENSE_DEVICE_MISMATCH')
    expect(() => serviceB.assertActive('model.secret.read')).toThrowError(LicenseError)
  })

  it('序号回退：低序号旧文件覆盖被识别', async () => {
    const service = makeService()
    const v1 = await simulateIssuance({ authority, service, term: 'days', days: 30, nowSec })
    await service.importLicense(v1.licenseText)
    const v2 = await simulateIssuance({ authority, service, term: 'days', days: 30, nowSec })
    await service.importLicense(v2.licenseText)

    // 用 v1 文件覆盖回 v2（模拟旧文件复制回来）。
    await expect(service.importLicense(v1.licenseText)).rejects.toMatchObject({
      code: 'LICENSE_SEQUENCE_REGRESSED'
    })
    expect(service.snapshot.licenseId).toBe(v2.licenseId)
  })

  it('撤销策略：导入后当前授权立即锁定，旧策略重放无效', async () => {
    const service = makeService()
    const issuance = await simulateIssuance({ authority, service, term: 'permanent', nowSec })
    await service.importLicense(issuance.licenseText)
    expect(service.snapshot.state).toBe('active')

    const policy = issueRevocationPolicy({
      signer: authority.issuerKey,
      sequence: 1,
      kind: 'license-revocation',
      revokedLicenseIds: [issuance.licenseId],
      nowSec
    })
    const policyText = JSON.stringify({ policy: policy.envelope, issuerCert: authority.certEnvelope })
    const result = await service.importRevocationPolicy(policyText)
    expect(result.applied).toBe(true)
    expect(service.snapshot.state).toBe('locked')
    expect(service.snapshot.reasonCode).toBe('LICENSE_REVOKED')

    const replay = await service.importRevocationPolicy(policyText)
    expect(replay.applied).toBe(false)
  })

  it('时钟明显回拨触发 TIME_AMBIGUOUS', async () => {
    let clock = nowSec
    const device = createInMemorySoftwareAdapter()
    const service = makeService(device, () => clock)
    const issuance = await simulateIssuance({ authority, service, term: 'permanent', nowSec })
    await service.importLicense(issuance.licenseText)
    expect(service.snapshot.state).toBe('active')

    clock = nowSec - 3600 * 6 // 回拨 6 小时
    const snapshot = await service.evaluateOnBoot('test')
    expect(snapshot.state).toBe('locked')
    expect(snapshot.reasonCode).toBe('LICENSE_TIME_AMBIGUOUS')
  })

  it('挑战与本机申请不匹配时拒绝', async () => {
    const service = makeService()
    const { requestText } = await service.createDeviceRequest()
    const request = JSON.parse(requestText) as DeviceRequest
    const challenge = issueChallenge({
      issuer: authority.issuerKey,
      request,
      requestText: '{"different":true}',
      nowSec
    })
    await expect(service.importChallenge(challengeFileText(authority, challenge))).rejects.toMatchObject({
      code: 'ACTIVATION_CHALLENGE_MISMATCH'
    })
  })

  it('篡改负载（保持 JSON 合法）导致签名验证失败', async () => {
    const service = makeService()
    const issuance = await simulateIssuance({ authority, service, term: 'days', days: 30, nowSec })
    const parsed = JSON.parse(issuance.licenseText) as {
      license: { payload: string; sig: string; kid: string }
      issuerCert: unknown
    }
    // 解出负载 JSON，合法地修改一个字段，再用原签名——签名验证必须失败。
    const payloadJson = Buffer.from(decodeBase64Url(parsed.license.payload)).toString('utf8')
    const tamperedJson = payloadJson.replace('"sequence":1', '"sequence":99')
    expect(tamperedJson).not.toBe(payloadJson)
    const tamperedText = JSON.stringify({
      license: { ...parsed.license, payload: encodeBase64Url(Buffer.from(tamperedJson, 'utf8')) },
      issuerCert: parsed.issuerCert
    })
    await expect(service.importLicense(tamperedText)).rejects.toMatchObject({ code: 'SIGNATURE_INVALID' })
    expect(service.snapshot.state).toBe('unlicensed')
  })

  it('证书缺少 license.issue 能力时导入被拒', async () => {
    const limitedKey = generateIssuerKey()
    const limited = issueIssuerCert({
      root: authority.rootKey,
      issuer: limitedKey,
      subject: 'limited-issuer',
      capabilities: ['challenge.issue'],
      notBefore: nowSec - 3600,
      notAfter: nowSec + 86400
    })
    const limitedAuthority: SimulatedAuthority = {
      ...authority,
      issuerKey: limitedKey,
      cert: limited.payload,
      certEnvelope: limited.envelope
    }

    const service = makeService()
    const issuance = await simulateIssuance({ authority: limitedAuthority, service, term: 'permanent', nowSec })
    await expect(service.importLicense(issuance.licenseText)).rejects.toMatchObject({
      code: 'CERT_CAPABILITY_MISSING'
    })
  })

  it('证书未覆盖授权签发时间时导入被拒（客户端纵深防御）', async () => {
    const service = makeService()
    const { requestText } = await service.createDeviceRequest()
    const request = JSON.parse(requestText) as DeviceRequest
    // 证书已在 1 小时前过期；绕过签发端 issueLicense 的自检，直接构造信封，
    // 验证客户端仍会拒绝「证书未覆盖签发时间」的授权。
    const stale = issueIssuerCert({
      root: authority.rootKey,
      issuer: authority.issuerKey,
      subject: 'short-issuer',
      capabilities: ['challenge.issue', 'license.issue'],
      notBefore: nowSec - 7200,
      notAfter: nowSec - 3600
    })
    const { kidFromSpki, sealEnvelopePayload, signWithPurpose, randomUuid, LICENSE_PRODUCT } = await import(
      '@free-creation/license-protocol'
    )
    const payload = {
      v: 1,
      product: LICENSE_PRODUCT,
      licenseId: randomUuid(),
      sequence: 1,
      signKeyId: kidFromSpki(Buffer.from(decodeBase64Url(request.device.signPublicKey))),
      wrapKeyId: kidFromSpki(Buffer.from(decodeBase64Url(request.device.wrapPublicKey))),
      capabilities: ['app.run'],
      issuedAt: nowSec, // 现在 → 超出过期证书范围
      notBefore: nowSec,
      term: 'permanent',
      expiresAt: null
    }
    const { payloadBytes } = sealEnvelopePayload(payload)
    const envelope = {
      kid: authority.issuerKey.kid,
      payload: encodeBase64Url(payloadBytes),
      sig: signWithPurpose({
        purpose: 'license',
        kid: authority.issuerKey.kid,
        privateKeyPem: authority.issuerKey.privateKeyPem,
        payloadBytes
      })
    }
    const licenseText = JSON.stringify({ license: envelope, issuerCert: stale.envelope })
    await expect(service.importLicense(licenseText)).rejects.toMatchObject({ code: 'CERT_EXPIRED' })
    expect(service.snapshot.state).toBe('unlicensed')
  })
})

describe('错误码稳定性', () => {
  it('LicenseError 携带稳定原因码', () => {
    const error = new LicenseError('LICENSE_REQUIRED', '测试')
    expect(error.code).toBe('LICENSE_REQUIRED')
    expect(error.name).toBe('LicenseError')
  })
})
