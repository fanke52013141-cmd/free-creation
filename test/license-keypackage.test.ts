/**
 * .cskeys v2 协议测试：双软件设备适配器模拟「发放员设备 A / 接收设备 B」。
 * 覆盖：密封/开封往返、错密码、错设备、过期、篡改、能力缺失、限制、密码策略、来源规范化。
 */
import { describe, expect, it } from 'vitest'
import {
  generateIssuerKey,
  generateRootKey,
  issueIssuerCert,
  issueLicense,
  issueChallenge,
  KEY_PACKAGE_LIMITS,
  kidFromSpki,
  LicenseProtocolError,
  openKeyPackage,
  originOf,
  PASSWORD_MIN_BYTES,
  randomUuid,
  sealKeyPackage,
  validatePasswordPolicy,
  verifyProof,
  type DeviceRequest,
  type TrustedRoot
} from '@free-creation/license-protocol'
import { createInMemorySoftwareAdapter } from '../src/main/security/license/device/software'

const nowSec = 1_900_000_000
const STRONG_PASSWORD = 'correct-horse-battery-staple-42' // 31 字节

interface SimulatedDevice {
  adapter: ReturnType<typeof createInMemorySoftwareAdapter>
  request: DeviceRequest
  licenseEnvelope: unknown
  wrapPublicKey: string
  deviceSummary: string
  expiresAtSec: number | null
}

async function makeDevice(input: {
  rootKey: ReturnType<typeof generateRootKey>
  issuerKey: ReturnType<typeof generateIssuerKey>
  certPayload: ReturnType<typeof issueIssuerCert>['payload']
  certEnvelope: unknown
  role: 'recipient' | 'key-issuer'
  term: 'days' | 'permanent'
  days?: number
}): Promise<SimulatedDevice> {
  const adapter = createInMemorySoftwareAdapter()
  await adapter.createDeviceKeys()
  const publicKeys = await adapter.readPublicKeys()
  const request = {
    v: 1,
    product: 'com.canvas-studio.app',
    requestId: randomUuid(),
    createdAt: nowSec,
    device: publicKeys
  } as DeviceRequest
  const requestText = JSON.stringify(request)
  const challenge = issueChallenge({ issuer: input.issuerKey, request, requestText, nowSec })
  const proof = await adapter.attestChallenge({
    challengeId: challenge.payload.challengeId,
    nonceBase64Url: challenge.payload.nonce,
    wrappedSecretBase64Url: challenge.payload.wrappedSecret
  })
  const proofText = JSON.stringify({
    v: 1,
    product: 'com.canvas-studio.app',
    requestId: request.requestId,
    challengeId: challenge.payload.challengeId,
    requestSha256: challenge.payload.requestSha256,
    secretHmac: proof.secretHmac,
    challengeSignature: proof.challengeSignature,
    device: publicKeys,
    createdAt: nowSec
  })
  // 签发端核对（与 cs-issuer 相同逻辑）。
  verifyProof({ request, challenge, proofText, nowSec })
  const license = issueLicense({
    issuer: input.issuerKey,
    issuerCert: input.certPayload,
    request,
    sequence: 1,
    role: input.role,
    term: input.term,
    days: input.days,
    nowSec
  })
  return {
    adapter,
    request,
    licenseEnvelope: license.envelope,
    wrapPublicKey: publicKeys.wrapPublicKey,
    deviceSummary: publicKeys.deviceSummary,
    expiresAtSec: license.payload.expiresAt
  }
}

async function makeAuthority() {
  const rootKey = generateRootKey()
  const issuerKey = generateIssuerKey()
  const { envelope, payload } = issueIssuerCert({
    root: rootKey,
    issuer: issuerKey,
    subject: 'kp-test',
    capabilities: ['challenge.issue', 'license.issue', 'revocation.issue'],
    notBefore: nowSec - 3600,
    notAfter: nowSec + 365 * 86400
  })
  const trustedRoot: TrustedRoot = { kid: rootKey.kid, publicKey: rootKey.publicKey }
  return { rootKey, issuerKey, certPayload: payload, certEnvelope: envelope, trustedRoot }
}

const samplePayload = {
  connections: [
    {
      id: 'conn-1',
      name: '测试连接',
      protocol: 'openai',
      baseUrl: 'https://api.example.com/v1',
      headers: { 'X-Custom': 'v' },
      apiKey: 'sk-test-abcdef',
      modelsJson: JSON.stringify([{ definitionId: 'm1', displayName: '模型一' }])
    },
    {
      id: 'conn-2',
      name: '第二连接',
      protocol: 'anthropic',
      baseUrl: 'https://api2.example.com',
      headers: {},
      apiKey: 'sk-test-ghijkl',
      modelsJson: '[]'
    }
  ],
  exportedAt: nowSec
}

describe('.cskeys v2 密钥包', () => {
  it('密封→开封往返：正确设备与密码解出负载，签发链与设备绑定通过', async () => {
    const authority = await makeAuthority()
    const issuer = await makeDevice({ ...authority, role: 'key-issuer', term: 'permanent' })
    const recipient = await makeDevice({ ...authority, role: 'recipient', term: 'permanent' })

    const sealed = await sealKeyPackage({
      packageId: randomUuid(),
      recipient: { wrapPublicKey: recipient.wrapPublicKey, deviceSummary: recipient.deviceSummary },
      issuerDevice: {
        signPublicKey: issuer.request.device.signPublicKey,
        deviceSummary: issuer.deviceSummary
      },
      password: STRONG_PASSWORD,
      payload: samplePayload,
      recipientLicenseExpiresAtSec: recipient.expiresAtSec,
      nowSec,
      signFn: (message) => issuer.adapter.sign(message),
      licenseEnvelope: issuer.licenseEnvelope,
      issuerCertEnvelope: authority.certEnvelope
    })

    expect(sealed.file.header.recipient.deviceSummary).toBe(recipient.deviceSummary)
    expect(JSON.parse(sealed.fileText)).toBeTruthy()

    const opened = await openKeyPackage({
      file: sealed.fileText,
      localWrapPublicKey: recipient.wrapPublicKey,
      localLicenseExpiresAtSec: recipient.expiresAtSec,
      password: STRONG_PASSWORD,
      nowSec,
      trustedRoot: authority.trustedRoot,
      unwrapFn: (wrapped) => recipient.adapter.unwrap(wrapped)
    })
    expect(opened.payload.connections).toHaveLength(2)
    expect(opened.payload.connections[0].apiKey).toBe('sk-test-abcdef')
    expect(opened.header.packageId).toBe(sealed.packageId)
  })

  it('错误密码与篡改给出同一对外错误码（不区分探测）', async () => {
    const authority = await makeAuthority()
    const issuer = await makeDevice({ ...authority, role: 'key-issuer', term: 'permanent' })
    const recipient = await makeDevice({ ...authority, role: 'recipient', term: 'permanent' })
    const sealed = await sealKeyPackage({
      packageId: randomUuid(),
      recipient: { wrapPublicKey: recipient.wrapPublicKey, deviceSummary: recipient.deviceSummary },
      issuerDevice: { signPublicKey: issuer.request.device.signPublicKey, deviceSummary: issuer.deviceSummary },
      password: STRONG_PASSWORD,
      payload: samplePayload,
      recipientLicenseExpiresAtSec: null,
      nowSec,
      signFn: (m) => issuer.adapter.sign(m),
      licenseEnvelope: issuer.licenseEnvelope,
      issuerCertEnvelope: authority.certEnvelope
    })

    await expect(
      openKeyPackage({
        file: sealed.fileText,
        localWrapPublicKey: recipient.wrapPublicKey,
        localLicenseExpiresAtSec: null,
        password: 'wrong-password-entropy-9999-x',
        nowSec,
        trustedRoot: authority.trustedRoot,
        unwrapFn: (w) => recipient.adapter.unwrap(w)
      })
    ).rejects.toMatchObject({ code: 'SIGNATURE_INVALID' })

    // 篡改一个负载字节（保持 JSON 合法）→ 签名失败（同一对外码）。
    const parsed = JSON.parse(sealed.fileText) as { payload: string }
    parsed.payload = 'Z' + parsed.payload.slice(1)
    const tampered = JSON.stringify(parsed)
    await expect(
      openKeyPackage({
        file: tampered,
        localWrapPublicKey: recipient.wrapPublicKey,
        localLicenseExpiresAtSec: null,
        password: STRONG_PASSWORD,
        nowSec,
        trustedRoot: authority.trustedRoot,
        unwrapFn: (w) => recipient.adapter.unwrap(w)
      })
    ).rejects.toMatchObject({ code: 'SIGNATURE_INVALID' })
  })

  it('非接收设备无法开封（同密码也不行）', async () => {
    const authority = await makeAuthority()
    const issuer = await makeDevice({ ...authority, role: 'key-issuer', term: 'permanent' })
    const recipient = await makeDevice({ ...authority, role: 'recipient', term: 'permanent' })
    const outsider = await makeDevice({ ...authority, role: 'recipient', term: 'permanent' })

    const sealed = await sealKeyPackage({
      packageId: randomUuid(),
      recipient: { wrapPublicKey: recipient.wrapPublicKey, deviceSummary: recipient.deviceSummary },
      issuerDevice: { signPublicKey: issuer.request.device.signPublicKey, deviceSummary: issuer.deviceSummary },
      password: STRONG_PASSWORD,
      payload: samplePayload,
      recipientLicenseExpiresAtSec: null,
      nowSec,
      signFn: (m) => issuer.adapter.sign(m),
      licenseEnvelope: issuer.licenseEnvelope,
      issuerCertEnvelope: authority.certEnvelope
    })

    // 外人设备：接收方绑定检查先于解密（不泄露任何可探测信息差异）。
    await expect(
      openKeyPackage({
        file: sealed.fileText,
        localWrapPublicKey: outsider.wrapPublicKey,
        localLicenseExpiresAtSec: null,
        password: STRONG_PASSWORD,
        nowSec,
        trustedRoot: authority.trustedRoot,
        unwrapFn: (w) => outsider.adapter.unwrap(w)
      })
    ).rejects.toMatchObject({ code: 'REQUEST_MISMATCH' })

    // 即使跳过绑定检查（传接收者公钥），外人也无法解密。
    await expect(
      openKeyPackage({
        file: sealed.fileText,
        localWrapPublicKey: recipient.wrapPublicKey,
        localLicenseExpiresAtSec: null,
        password: STRONG_PASSWORD,
        nowSec,
        trustedRoot: authority.trustedRoot,
        unwrapFn: (w) => outsider.adapter.unwrap(w)
      })
    ).rejects.toMatchObject({ code: 'SIGNATURE_INVALID' })
  })

  it('过期密钥包拒绝；按天授权接收者的包有效期取交集', async () => {
    const authority = await makeAuthority()
    const issuer = await makeDevice({ ...authority, role: 'key-issuer', term: 'permanent' })
    // 接收者只有 3 天授权 → 包有效期应为 3 天而非 7 天。
    const shortRecipient = await makeDevice({ ...authority, role: 'recipient', term: 'days', days: 3 })

    const sealed = await sealKeyPackage({
      packageId: randomUuid(),
      recipient: { wrapPublicKey: shortRecipient.wrapPublicKey, deviceSummary: shortRecipient.deviceSummary },
      issuerDevice: { signPublicKey: issuer.request.device.signPublicKey, deviceSummary: issuer.deviceSummary },
      password: STRONG_PASSWORD,
      payload: samplePayload,
      recipientLicenseExpiresAtSec: shortRecipient.expiresAtSec,
      nowSec,
      signFn: (m) => issuer.adapter.sign(m),
      licenseEnvelope: issuer.licenseEnvelope,
      issuerCertEnvelope: authority.certEnvelope
    })
    expect(sealed.expiresAt).toBe(nowSec + 3 * 86400)

    // 4 天后打开 → 过期。
    await expect(
      openKeyPackage({
        file: sealed.fileText,
        localWrapPublicKey: shortRecipient.wrapPublicKey,
        localLicenseExpiresAtSec: shortRecipient.expiresAtSec,
        password: STRONG_PASSWORD,
        nowSec: nowSec + 4 * 86400,
        trustedRoot: authority.trustedRoot,
        unwrapFn: (w) => shortRecipient.adapter.unwrap(w)
      })
    ).rejects.toMatchObject({ code: 'TIME_OUT_OF_RANGE' })
  })

  it('发放员授权缺少 credentials.export 时接收端拒绝', async () => {
    const authority = await makeAuthority()
    // 发放员只有 recipient 角色（无 credentials.export）。
    const nonIssuer = await makeDevice({ ...authority, role: 'recipient', term: 'permanent' })
    const recipient = await makeDevice({ ...authority, role: 'recipient', term: 'permanent' })

    const sealed = await sealKeyPackage({
      packageId: randomUuid(),
      recipient: { wrapPublicKey: recipient.wrapPublicKey, deviceSummary: recipient.deviceSummary },
      issuerDevice: { signPublicKey: nonIssuer.request.device.signPublicKey, deviceSummary: nonIssuer.deviceSummary },
      password: STRONG_PASSWORD,
      payload: samplePayload,
      recipientLicenseExpiresAtSec: null,
      nowSec,
      signFn: (m) => nonIssuer.adapter.sign(m),
      licenseEnvelope: nonIssuer.licenseEnvelope,
      issuerCertEnvelope: authority.certEnvelope
    })

    await expect(
      openKeyPackage({
        file: sealed.fileText,
        localWrapPublicKey: recipient.wrapPublicKey,
        localLicenseExpiresAtSec: null,
        password: STRONG_PASSWORD,
        nowSec,
        trustedRoot: authority.trustedRoot,
        unwrapFn: (w) => recipient.adapter.unwrap(w)
      })
    ).rejects.toMatchObject({ code: 'CERT_CAPABILITY_MISSING' })
  })

  it('连接数与每连接模型数超限拒绝；密码策略强制', async () => {
    validatePasswordPolicy('x'.repeat(PASSWORD_MIN_BYTES))
    validatePasswordPolicy('x'.repeat(256))
    expect(() => validatePasswordPolicy('short')).toThrow(LicenseProtocolError)

    const authority = await makeAuthority()
    const issuer = await makeDevice({ ...authority, role: 'key-issuer', term: 'permanent' })
    const recipient = await makeDevice({ ...authority, role: 'recipient', term: 'permanent' })
    const base = {
      recipient: { wrapPublicKey: recipient.wrapPublicKey, deviceSummary: recipient.deviceSummary },
      issuerDevice: { signPublicKey: issuer.request.device.signPublicKey, deviceSummary: issuer.deviceSummary },
      password: STRONG_PASSWORD,
      recipientLicenseExpiresAtSec: null,
      nowSec,
      signFn: (m: Uint8Array) => issuer.adapter.sign(m),
      licenseEnvelope: issuer.licenseEnvelope,
      issuerCertEnvelope: authority.certEnvelope
    }

    await expect(
      sealKeyPackage({
        ...base,
        packageId: randomUuid(),
        payload: {
          connections: Array.from({ length: KEY_PACKAGE_LIMITS.maxConnections + 1 }, (_, i) => ({
            id: `c${i}`,
            name: `n${i}`,
            protocol: 'openai',
            baseUrl: 'https://x.example.com',
            headers: {},
            apiKey: 'k',
            modelsJson: '[]'
          })),
          exportedAt: nowSec
        }
      })
    ).rejects.toMatchObject({ code: 'FILE_TOO_LARGE' })

    await expect(
      sealKeyPackage({
        ...base,
        packageId: randomUuid(),
        payload: {
          connections: [
            {
              id: 'c',
              name: 'n',
              protocol: 'openai',
              baseUrl: 'https://x.example.com',
              headers: {},
              apiKey: 'k',
              modelsJson: JSON.stringify(
                Array.from({ length: KEY_PACKAGE_LIMITS.maxModelsPerConnection + 1 }, (_, i) => ({ id: `m${i}` }))
              )
            }
          ],
          exportedAt: nowSec
        }
      })
    ).rejects.toMatchObject({ code: 'FILE_TOO_LARGE' })
  })

  it('originOf 规范化来源（端点绑定用）', () => {
    expect(originOf('https://api.example.com/v1/chat')).toBe('https://api.example.com')
    expect(originOf('http://127.0.0.1:8000/api')).toBe('http://127.0.0.1:8000')
    expect(originOf('https://api.example.com:443/x')).toBe('https://api.example.com')
  })
})
