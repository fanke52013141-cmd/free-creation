/**
 * 签发端操作库（tools/cs-issuer 与测试共用）。
 *
 * 流程对应方案 §3.2：enroll-ek 登记 → challenge 离线挑战 → 设备提交证明 →
 * issue 发证 →（可选）revoke 撤销。本文件只提供纯操作，不含文件 IO 与台账。
 */
import { createHash, randomBytes } from 'node:crypto'
import { Buffer } from 'node:buffer'
import {
  buildProofMessage,
  decodeBase64Url,
  DeviceProofSchema,
  DeviceRequestSchema,
  encodeBase64Url,
  generateEd25519Key,
  hmacSha256,
  IssuerCertPayloadSchema,
  kidFromSpki,
  LICENSE_PRODUCT,
  LicensePayloadSchema,
  LICENSE_PROTOCOL_VERSION,
  RevocationPolicyPayloadSchema,
  rsaOaepSha256Encrypt,
  rsaPssSha256Verify,
  safeEqual,
  sealEnvelopePayload,
  signWithPurpose,
  ROLE_CAPABILITIES,
  type DeviceProof,
  type DeviceRequest,
  type Envelope,
  type IssuerCertCapability,
  type IssuerCertPayload,
  type IssuerRole,
  type JsonValue,
  type LicensePayload,
  type RevocationPolicyPayload
} from './index.ts'

export interface IssuerSigningKey {
  privateKeyPem: string
  publicKey: string
  kid: string
}

export interface RootKey extends IssuerSigningKey {}

/** 生成新的离线根密钥。 */
export function generateRootKey(): RootKey {
  return generateEd25519Key()
}

/** 生成新的签发人密钥（由根签发证书）。 */
export function generateIssuerKey(): IssuerSigningKey {
  return generateEd25519Key()
}

/** UUID v4 形态的随机 ID（台账与证书共用）。 */
export function randomUuid(): string {
  const hex = randomBytes(16).toString('hex')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`
}

function sealed(
  purpose: 'issuerCert' | 'license' | 'challenge' | 'revocation',
  signer: IssuerSigningKey,
  payload: JsonValue
): Envelope {
  const { payloadBytes } = sealEnvelopePayload(payload)
  return {
    kid: signer.kid,
    payload: encodeBase64Url(payloadBytes),
    sig: signWithPurpose({ purpose, kid: signer.kid, privateKeyPem: signer.privateKeyPem, payloadBytes })
  }
}

// ---------------------------------------------------------------------------
// 登记与挑战
// ---------------------------------------------------------------------------

/** enroll-ek 校验：申请结构 +（登记模式下）EK 摘要与台账一致。返回设备摘要。 */
export function validateRequest(input: {
  request: unknown
  /** 台账登记的 EK 摘要；null 表示尚未登记。 */
  enrolledEkHash: string | null
  /** 非空时要求申请携带 EK 摘要（强模式）。 */
  requireEk: boolean
}): DeviceRequest {
  const request = DeviceRequestSchema.parse(input.request)
  if (request.device.ekPublicKeyHash === null) {
    if (input.requireEk) {
      throw new Error('申请未携带 EK 公钥摘要；强模式（生产发证）要求 TPM EK 登记')
    }
  } else if (input.enrolledEkHash !== null && input.enrolledEkHash !== request.device.ekPublicKeyHash) {
    throw new Error('申请 EK 摘要与台账登记不一致')
  }
  if (request.device.keySource === 'software-dev' && input.requireEk) {
    throw new Error('软件设备密钥不能用于生产发证（强模式拒绝）')
  }
  return request
}

export interface IssuedChallenge {
  envelope: Envelope
  payload: {
    v: 1
    product: string
    challengeId: string
    requestSha256: string
    nonce: string
    wrappedSecret: string
    issuedAt: number
    expiresAt: number
  }
  /** 签发端留存：用于核对 .csproof 的 HMAC。必须与挑战一同入台账，绝不写入挑战文件。 */
  secretHex: string
}

/** challenge 命令：生成挑战（一次性秘密经设备 K_wrap 公钥封装）。 */
export function issueChallenge(input: {
  issuer: IssuerSigningKey
  request: DeviceRequest
  requestText: string
  nowSec: number
  ttlSec?: number
  challengeId?: string
}): IssuedChallenge {
  const requestSha256 = createSha256Hex(Buffer.from(input.requestText, 'utf8'))
  const nonce = randomBytes(32)
  const secret = randomBytes(32)
  const wrappedSecret = rsaOaepSha256Encrypt({ wrapPublicKey: input.request.device.wrapPublicKey, plaintext: secret })
  const nowSec = input.nowSec
  const ttlSec = input.ttlSec ?? 48 * 3600
  const payload = {
    v: 1 as const,
    product: LICENSE_PRODUCT,
    challengeId: input.challengeId ?? randomUuid(),
    requestSha256,
    nonce: encodeBase64Url(nonce),
    wrappedSecret: encodeBase64Url(wrappedSecret),
    issuedAt: nowSec,
    expiresAt: nowSec + ttlSec
  }
  return {
    envelope: sealed('challenge', input.issuer, payload as unknown as JsonValue),
    payload,
    // 秘密以十六进制留存台账；导出文件只含封装值。
    secretHex: secret.toString('hex')
  }
}

// ---------------------------------------------------------------------------
// 证明核对
// ---------------------------------------------------------------------------

/** 核对 .csproof：双密钥持有证明 + 挑战绑定。返回设备公钥（发证绑定用）。 */
export function verifyProof(input: {
  request: DeviceRequest
  challenge: IssuedChallenge
  proofText: string
  nowSec: number
}): { device: DeviceRequest['device']; proof: DeviceProof } {
  const proof = DeviceProofSchema.parse(JSON.parse(input.proofText))

  // 绑定：申请、挑战与证明三方一致。
  if (proof.requestId !== input.request.requestId) throw new Error('证明 requestId 与申请不一致')
  if (proof.challengeId !== input.challenge.payload.challengeId) throw new Error('证明 challengeId 与挑战不一致')
  if (proof.requestSha256 !== input.challenge.payload.requestSha256) throw new Error('证明申请摘要与挑战不一致')
  if (proof.device.deviceSummary !== input.request.device.deviceSummary) throw new Error('证明设备摘要与申请不一致')
  if (input.nowSec >= input.challenge.payload.expiresAt) throw new Error('挑战已过期，拒绝发证')

  // K_wrap 持有：用台账留存的秘密复算 HMAC。
  const secret = Buffer.from(input.challenge.secretHex, 'hex')
  const expectedMac = hmacSha256(
    secret,
    buildProofMessage('proofHmac', input.challenge.payload.challengeId, input.challenge.payload.nonce)
  )
  if (!safeEqual(expectedMac, decodeBase64Url(proof.secretHmac))) {
    throw new Error('解封装证明（HMAC）核对失败')
  }

  // K_sign 持有：用申请中的签名公钥验证。
  const signMessage = buildProofMessage('proofSign', input.challenge.payload.challengeId, input.challenge.payload.nonce)
  if (!rsaPssSha256Verify({ signPublicKey: input.request.device.signPublicKey, message: signMessage, sig: proof.challengeSignature })) {
    throw new Error('签名证明（K_sign）核对失败')
  }

  // 公钥一致性：证明中的设备公钥必须与申请一致（防止换钥重放）。
  if (
    proof.device.signPublicKey !== input.request.device.signPublicKey ||
    proof.device.wrapPublicKey !== input.request.device.wrapPublicKey
  ) {
    throw new Error('证明中的设备公钥与申请不一致')
  }
  return { device: proof.device, proof }
}

// ---------------------------------------------------------------------------
// 发证
// ---------------------------------------------------------------------------

export interface IssueLicenseOptions {
  issuer: IssuerSigningKey
  issuerCert: IssuerCertPayload
  request: DeviceRequest
  /** 同一设备的授权序号（台账维护，从 1 开始）。 */
  sequence: number
  role: IssuerRole
  term: 'days' | 'permanent'
  /** term=days 时必填的正整数天数。 */
  days?: number
  nowSec: number
  licenseId?: string
}

/** 计算按天授权的到期时间。 */
export function expiresAtForDays(issuedAt: number, days: number): number {
  if (!Number.isSafeInteger(days) || days <= 0) {
    throw new Error('天数必须为正整数')
  }
  const expiresAt = issuedAt + days * 86400
  if (!Number.isSafeInteger(expiresAt)) {
    throw new Error('到期时间超出可表示范围')
  }
  return expiresAt
}

export function issueLicense(input: IssueLicenseOptions): { envelope: Envelope; payload: LicensePayload } {
  const issuedAt = input.nowSec
  const expiresAt =
    input.term === 'days' ? expiresAtForDays(issuedAt, requireDays(input.days)) : null
  const signKeyId = kidFromSpki(decodeBase64Url(input.request.device.signPublicKey))
  const wrapKeyId = kidFromSpki(decodeBase64Url(input.request.device.wrapPublicKey))
  const payload = LicensePayloadSchema.parse({
    v: LICENSE_PROTOCOL_VERSION,
    product: LICENSE_PRODUCT,
    licenseId: input.licenseId ?? randomUuid(),
    sequence: input.sequence,
    signKeyId,
    wrapKeyId,
    capabilities: [...ROLE_CAPABILITIES[input.role]],
    issuedAt,
    notBefore: issuedAt,
    term: input.term,
    expiresAt
  })
  // 发证前自检：签发人证书必须覆盖授权签发时间。
  if (issuedAt < input.issuerCert.notBefore || issuedAt > input.issuerCert.notAfter) {
    throw new Error('签发人证书未覆盖授权签发时间，请先续签证书')
  }
  return { envelope: sealed('license', input.issuer, payload as unknown as JsonValue), payload }
}

function requireDays(days: number | undefined): number {
  if (days === undefined) throw new Error('按天授权必须提供 --days')
  return days
}

// ---------------------------------------------------------------------------
// 撤销
// ---------------------------------------------------------------------------

export function issueRevocationPolicy(input: {
  signer: IssuerSigningKey
  sequence: number
  kind: 'license-revocation' | 'issuer-revocation'
  revokedLicenseIds?: string[]
  revokedIssuerCertIds?: string[]
  nowSec: number
  policyId?: string
}): { envelope: Envelope; payload: RevocationPolicyPayload } {
  const payload = RevocationPolicyPayloadSchema.parse({
    v: LICENSE_PROTOCOL_VERSION,
    policyId: input.policyId ?? randomUuid(),
    sequence: input.sequence,
    kind: input.kind,
    revokedLicenseIds: input.revokedLicenseIds ?? [],
    revokedIssuerCertIds: input.revokedIssuerCertIds ?? [],
    issuedAt: input.nowSec
  })
  return { envelope: sealed('revocation', input.signer, payload as unknown as JsonValue), payload }
}

// ---------------------------------------------------------------------------
// 证书
// ---------------------------------------------------------------------------

export function issueIssuerCert(input: {
  root: RootKey
  issuer: IssuerSigningKey
  subject: string
  capabilities: readonly IssuerCertCapability[]
  notBefore: number
  notAfter: number
  certId?: string
}): { envelope: Envelope; payload: IssuerCertPayload } {
  const payload = IssuerCertPayloadSchema.parse({
    v: LICENSE_PROTOCOL_VERSION,
    certId: input.certId ?? randomUuid(),
    subject: input.subject,
    purpose: 'license-issue',
    capabilities: [...input.capabilities],
    publicKey: input.issuer.publicKey,
    notBefore: input.notBefore,
    notAfter: input.notAfter
  })
  return { envelope: sealed('issuerCert', input.root, payload as unknown as JsonValue), payload }
}

function createSha256Hex(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex')
}
