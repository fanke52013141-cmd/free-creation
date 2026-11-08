/**
 * 授权文件契约（.csreq / .cschallenge / .csproof / .cslicense / .cspolicy）。
 *
 * 依据 docs/CANVAS_STUDIO_SECURITY_PLAN.md §3.3：
 * - 授权文件为严格 UTF-8 JSON，二进制字段使用无填充 base64url；
 * - 签名信封为 { kid, payload, sig }，payload 是负载对象规范 JSON 字节的 base64url；
 * - 时间一律 UTC 秒；kid 为规范 SPKI DER 的完整 SHA-256；
 * - 使用 zod strictObject 拒绝未知字段；文件尺寸设上限。
 */
import { z } from 'zod'
import { LicenseProtocolError } from './errors.ts'
import { parseStrictJson, type JsonValue } from './canonical.ts'

export const LICENSE_PRODUCT = 'com.canvas-studio.app'
export const LICENSE_PROTOCOL_VERSION = 1

/** 文件尺寸上限（字节）。 */
export const FILE_SIZE_LIMITS = {
  license: 64 * 1024,
  request: 1024 * 1024,
  challenge: 1024 * 1024,
  proof: 1024 * 1024,
  policy: 1024 * 1024
} as const

// ---------------------------------------------------------------------------
// 基础标量
// ---------------------------------------------------------------------------

/** kid = 'sha256-' + SPKI DER 的完整 SHA-256 十六进制。 */
export const KidSchema = z.string().regex(/^sha256-[0-9a-f]{64}$/, 'kid 格式非法')
export type Kid = z.infer<typeof KidSchema>

export const Base64UrlSchema = z.string().regex(/^[A-Za-z0-9_-]+$/, 'base64url 格式非法')

export const Hex64Schema = z.string().regex(/^[0-9a-f]{64}$/, '要求 64 位小写十六进制')
export const Hex16Schema = z.string().regex(/^[0-9a-f]{16}$/, '要求 16 位小写十六进制')

/** UTC 秒时间戳；上限取 4100 年附近的安全整数边界，拒绝明显越界值。 */
export const UtcSecondsSchema = z
  .number()
  .int()
  .min(0)
  .max(67_000_000_000)

export const UuidSchema = z.uuid()

/** 设备密钥来源。software-dev 仅用于开发与测试，生产构建必须拒绝。 */
export const KeySourceSchema = z.enum(['tpm-pcp', 'software-dev'])
export type KeySource = z.infer<typeof KeySourceSchema>

// ---------------------------------------------------------------------------
// 签名信封
// ---------------------------------------------------------------------------

export const EnvelopeSchema = z.strictObject({
  kid: KidSchema,
  /** 负载对象规范 JSON 字节的 base64url。 */
  payload: Base64UrlSchema,
  /** Ed25519 签名（签名输入见 canonical.signingInput）的 base64url。 */
  sig: Base64UrlSchema
})
export type Envelope = z.infer<typeof EnvelopeSchema>

// ---------------------------------------------------------------------------
// 授权能力
// ---------------------------------------------------------------------------

export const LicenseCapabilitySchema = z.enum(['app.run', 'credentials.export'])
export type LicenseCapability = z.infer<typeof LicenseCapabilitySchema>

/** 使用者角色固定能力；发放员额外具备 credentials.export。 */
export const ROLE_CAPABILITIES = {
  recipient: ['app.run'],
  'key-issuer': ['app.run', 'credentials.export']
} as const satisfies Record<string, readonly LicenseCapability[]>

export type IssuerRole = keyof typeof ROLE_CAPABILITIES

// ---------------------------------------------------------------------------
// 设备公钥（内嵌于各文件，单独成对象以便复用与校验）
// ---------------------------------------------------------------------------

export const DevicePublicKeysSchema = z.strictObject({
  signPublicKey: Base64UrlSchema,
  wrapPublicKey: Base64UrlSchema,
  /** EK 公钥 SHA-256；软件设备没有 EK，必须为 null。 */
  ekPublicKeyHash: Hex64Schema.nullable(),
  keySource: KeySourceSchema,
  /** 设备摘要：sha256(signSpki || wrapSpki) 前 16 个十六进制字符，供人工核对。 */
  deviceSummary: Hex16Schema
})
export type DevicePublicKeys = z.infer<typeof DevicePublicKeysSchema>

// ---------------------------------------------------------------------------
// .csreq 设备申请（未签名：设备此刻尚无授权）
// ---------------------------------------------------------------------------

export const DeviceRequestSchema = z.strictObject({
  v: z.literal(1),
  product: z.literal(LICENSE_PRODUCT),
  requestId: UuidSchema,
  createdAt: UtcSecondsSchema,
  device: DevicePublicKeysSchema
})
export type DeviceRequest = z.infer<typeof DeviceRequestSchema>

// ---------------------------------------------------------------------------
// .cschallenge 挑战（签发人 Ed25519 签名，purpose=challenge）
// ---------------------------------------------------------------------------

export const ChallengePayloadSchema = z.strictObject({
  v: z.literal(1),
  product: z.literal(LICENSE_PRODUCT),
  challengeId: UuidSchema,
  requestSha256: Hex64Schema,
  /** 32 字节随机数的 base64url（固定 43 字符）。 */
  nonce: z.string().length(43),
  /** RSA-OAEP-SHA256 封装到设备 K_wrap 的 32 字节秘密。 */
  wrappedSecret: Base64UrlSchema,
  issuedAt: UtcSecondsSchema,
  expiresAt: UtcSecondsSchema
})
export type ChallengePayload = z.infer<typeof ChallengePayloadSchema>

// ---------------------------------------------------------------------------
// .csproof 设备证明（未由签发人签名；由设备双密钥持有证明构成）
// ---------------------------------------------------------------------------

export const DeviceProofSchema = z.strictObject({
  v: z.literal(1),
  product: z.literal(LICENSE_PRODUCT),
  requestId: UuidSchema,
  challengeId: UuidSchema,
  requestSha256: Hex64Schema,
  /** HMAC-SHA256(解封装秘密, "CS/proof/hmac/v1" || challengeId || nonce)，证明 K_wrap 持有。 */
  secretHmac: Base64UrlSchema,
  /** RSA-PSS(K_sign, "CS/proof/sign/v1" || challengeId || nonce)，证明 K_sign 持有。 */
  challengeSignature: Base64UrlSchema,
  device: DevicePublicKeysSchema,
  createdAt: UtcSecondsSchema
})
export type DeviceProof = z.infer<typeof DeviceProofSchema>

// ---------------------------------------------------------------------------
// .cslicense 授权（签发人 Ed25519 签名，purpose=license）
// ---------------------------------------------------------------------------

export const LicensePayloadSchema = z
  .strictObject({
    v: z.literal(1),
    product: z.literal(LICENSE_PRODUCT),
    licenseId: UuidSchema,
    /** 同一设备内单调递增；签发台账保证。 */
    sequence: z.number().int().min(1),
    /** 设备两把公钥的 kid，把授权绑定到具体设备。 */
    signKeyId: KidSchema,
    wrapKeyId: KidSchema,
    capabilities: z.array(LicenseCapabilitySchema).min(1).max(4),
    issuedAt: UtcSecondsSchema,
    notBefore: UtcSecondsSchema,
    term: z.enum(['days', 'permanent']),
    /** days 授权的绝对到期秒；permanent 必须为 null。 */
    expiresAt: UtcSecondsSchema.nullable()
  })
  .refine((payload) => payload.notBefore === payload.issuedAt, {
    message: 'notBefore 必须等于 issuedAt'
  })
  .refine(
    (payload) =>
      payload.term === 'permanent'
        ? payload.expiresAt === null
        : payload.expiresAt !== null && payload.expiresAt > payload.notBefore,
    { message: 'term 与 expiresAt 组合非法' }
  )
export type LicensePayload = z.infer<typeof LicensePayloadSchema>

// ---------------------------------------------------------------------------
// .cspolicy 撤销/策略文件（签发人签名，purpose=revocation；根可签发人撤销）
// ---------------------------------------------------------------------------

export const RevocationPolicyPayloadSchema = z.strictObject({
  v: z.literal(1),
  policyId: UuidSchema,
  /** 递增序号：只接受比本地已应用序号更大的策略。 */
  sequence: z.number().int().min(1),
  kind: z.enum(['license-revocation', 'issuer-revocation']),
  revokedLicenseIds: z.array(UuidSchema).max(10_000),
  revokedIssuerCertIds: z.array(UuidSchema).max(1_000),
  issuedAt: UtcSecondsSchema
})
export type RevocationPolicyPayload = z.infer<typeof RevocationPolicyPayloadSchema>

// ---------------------------------------------------------------------------
// 签发人证书（根 Ed25519 签名，purpose=issuerCert；独立置于信封外分发）
// ---------------------------------------------------------------------------

export const ISSUER_CERT_CAPABILITIES = ['challenge.issue', 'license.issue', 'revocation.issue'] as const
export type IssuerCertCapability = (typeof ISSUER_CERT_CAPABILITIES)[number]

export const IssuerCertPayloadSchema = z
  .strictObject({
    v: z.literal(1),
    certId: UuidSchema,
    subject: z.string().min(1).max(120),
    purpose: z.literal('license-issue'),
    capabilities: z.array(z.enum(ISSUER_CERT_CAPABILITIES)).min(1).max(3),
    /** 签发人 Ed25519 公钥（SPKI DER base64url）。 */
    publicKey: Base64UrlSchema,
    notBefore: UtcSecondsSchema,
    notAfter: UtcSecondsSchema
  })
  .refine((cert) => cert.notAfter > cert.notBefore, { message: '证书有效期区间非法' })
export type IssuerCertPayload = z.infer<typeof IssuerCertPayloadSchema>

// ---------------------------------------------------------------------------
// 受信根（发行包内置公钥；文件中自带根证书一律不取得信任）
// ---------------------------------------------------------------------------

export interface TrustedRoot {
  kid: Kid
  /** Ed25519 公钥 SPKI DER base64url。 */
  publicKey: string
}

// ---------------------------------------------------------------------------
// 便捷解析函数：严格尺寸 + 严格 JSON（拒绝重复键）+ 顶层对象形状
// ---------------------------------------------------------------------------

export function parseFileJson(text: string, limit: number, label: string): Record<string, JsonValue> {
  if (Buffer.byteLength(text, 'utf8') > limit) {
    throw new LicenseProtocolError('FILE_TOO_LARGE', `${label} 超过 ${limit} 字节上限`)
  }
  const parsed = parseStrictJson(text)
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new LicenseProtocolError('SCHEMA_INVALID', `${label} 顶层必须是 JSON 对象`)
  }
  return parsed as Record<string, JsonValue>
}
