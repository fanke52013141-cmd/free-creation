/**
 * .cskeys v2 指定设备密钥包与 .csdevcred 接收设备凭证（方案 §4.1/§4.2）。
 *
 * 保密模型：
 * - 每包生成 32 字节设备秘密 S，用接收者 K_wrap 公钥 RSA-OAEP 封装——只有接收设备的
 *   TPM 能解开；
 * - 密码 scrypt 派生 P（N=131072, r=8, p=1, 单飞），HKDF-SHA256(S||P) 得内容密钥，
 *   AES-256-GCM 加密负载，AAD 绑定包头（包 ID、双方设备摘要、期限、salt、nonce）；
 * - 发放员设备 K_sign（RSA-PSS/SHA-256）对 包头||密文||tag 签名，包内携带其授权信封，
 *   接收端验证签发链与 credentials.export 能力；
 * - 错误密码与验签失败对外同一提示；任何失败路径不产生部分导入（由调用方保证）。
 */
import { createCipheriv, createDecipheriv, hkdfSync, randomBytes, scrypt as scryptCb } from 'node:crypto'
import { promisify } from 'node:util'
import { Buffer } from 'node:buffer'
import { z } from 'zod'
import {
  canonicalJsonString,
  decodeBase64Url,
  encodeBase64Url,
  parseStrictJson,
  type JsonValue
} from './canonical.ts'
import { LicenseProtocolError } from './errors.ts'
import { kidFromSpki } from './sign.ts'
import { rsaOaepSha256Encrypt, rsaPssSha256Verify } from './rsa.ts'
import {
  EnvelopeSchema,
  Hex16Schema,
  LICENSE_PRODUCT,
  LicensePayloadSchema,
  IssuerCertPayloadSchema,
  UtcSecondsSchema,
  UuidSchema,
  type Envelope
} from './types.ts'
import { verifyEnvelope } from './verify.ts'
import type { TrustedRoot } from './index.ts'

const scryptAsync = promisify(scryptCb) as (
  password: string | Buffer,
  salt: string | Buffer,
  keylen: number,
  options: { N: number; r: number; p: number; maxmem: number }
) => Promise<Buffer>

/** 密码 KDF 参数（OWASP 推荐；生产参数变更以新协议版本发布）。 */
export const KDF_PARAMS = { N: 131_072, r: 8, p: 1, maxmem: 256 * 1024 * 1024 } as const
/** 密码长度限制（UTF-8 字节，不截断不规范化）。 */
export const PASSWORD_MIN_BYTES = 20
export const PASSWORD_MAX_BYTES = 256
/** 包体限制。 */
export const KEY_PACKAGE_LIMITS = {
  fileBytes: 4 * 1024 * 1024,
  maxConnections: 64,
  maxModelsPerConnection: 128,
  /** 有效期：默认自导出起 7 天。 */
  defaultTtlSec: 7 * 86400
} as const

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

/** 接收设备凭证（.csdevcred）：接收者在模型设置导出，交给发放员。 */
export const ReceiveDeviceCredentialSchema = z.strictObject({
  v: z.literal(1),
  product: z.literal(LICENSE_PRODUCT),
  /** 接收者当前有效授权信封。 */
  license: EnvelopeSchema,
  issuerCert: EnvelopeSchema,
  /** 接收者 K_wrap 公钥（SPKI base64url）——密钥包封装目标。 */
  wrapPublicKey: z.string().min(1),
  deviceSummary: Hex16Schema,
  exportedAt: UtcSecondsSchema
})
export type ReceiveDeviceCredential = z.infer<typeof ReceiveDeviceCredentialSchema>

/** 包头（公开部分，整体作为 AES-GCM AAD）。 */
export const KeyPackageHeaderSchema = z.strictObject({
  format: z.literal('canvas-studio-keys'),
  v: z.literal(2),
  packageId: UuidSchema,
  recipient: z.strictObject({ wrapPublicKey: z.string().min(1), deviceSummary: Hex16Schema }),
  /** 发放员设备公钥与其设备摘要。 */
  issuerDevice: z.strictObject({ signPublicKey: z.string().min(1), deviceSummary: Hex16Schema }),
  issuedAt: UtcSecondsSchema,
  expiresAt: UtcSecondsSchema,
  kdf: z.strictObject({ salt: z.string().min(1) }),
  cipher: z.strictObject({ nonce: z.string().min(1) })
})
export type KeyPackageHeader = z.infer<typeof KeyPackageHeaderSchema>

/** 加密负载中的连接条目（models 以 JSON 字符串承载，形状由主进程目录层负责）。 */
export const KeyPackageConnectionSchema = z.strictObject({
  id: z.string().regex(/^[\w-]{1,128}$/),
  name: z.string().min(1).max(200),
  protocol: z.string().min(1).max(40),
  baseUrl: z.string().min(1).max(2048),
  headers: z.record(z.string(), z.string()),
  apiKey: z.string().min(1).max(8192),
  modelsJson: z.string().max(1024 * 1024)
})
export type KeyPackageConnection = z.infer<typeof KeyPackageConnectionSchema>

export const KeyPackagePayloadSchema = z.strictObject({
  connections: z.array(KeyPackageConnectionSchema).min(1).max(KEY_PACKAGE_LIMITS.maxConnections),
  exportedAt: UtcSecondsSchema
})
export type KeyPackagePayload = z.infer<typeof KeyPackagePayloadSchema>

/** .cskeys 文件顶层。 */
export const KeyPackageFileSchema = z.strictObject({
  header: KeyPackageHeaderSchema,
  wrappedSecret: z.string().min(1),
  payload: z.string().min(1),
  authTag: z.string().min(1),
  sig: z.string().min(1),
  license: EnvelopeSchema,
  issuerCert: EnvelopeSchema
})
export type KeyPackageFile = z.infer<typeof KeyPackageFileSchema>

// ---------------------------------------------------------------------------
// 口令派生（单飞：进程内一次只执行一个 scrypt）
// ---------------------------------------------------------------------------

let scryptChain: Promise<unknown> = Promise.resolve()

/** 单飞 scrypt：并发调用串行执行，避免低配机器内存与 CPU 尖峰。 */
export function derivePasswordKey(password: string, salt: Buffer): Promise<Buffer> {
  const run = scryptChain.then(
    () => scryptAsync(password, salt, 32, { ...KDF_PARAMS }),
    () => scryptAsync(password, salt, 32, { ...KDF_PARAMS })
  )
  scryptChain = run.catch(() => undefined)
  return run as Promise<Buffer>
}

export function validatePasswordPolicy(password: string): void {
  const bytes = Buffer.byteLength(password, 'utf8')
  if (bytes < PASSWORD_MIN_BYTES || bytes > PASSWORD_MAX_BYTES) {
    throw new LicenseProtocolError(
      'SCHEMA_INVALID',
      `密码长度须为 ${PASSWORD_MIN_BYTES}-${PASSWORD_MAX_BYTES} 个 UTF-8 字节（当前 ${bytes}）`
    )
  }
}

function contentKeyFrom(secret: Buffer, passwordKey: Buffer, salt: Buffer): Buffer {
  return Buffer.from(hkdfSync('sha256', Buffer.concat([secret, passwordKey]), salt, 'CS/keys/v2/aes', 32))
}

// ---------------------------------------------------------------------------
// 签名输入：CS/keys/v2/sign || 0x00 || packageId || 0x00 || 包头规范字节 || payload || tag
// ---------------------------------------------------------------------------

export function keyPackageSigningInput(header: KeyPackageHeader, payload: Buffer, authTag: Buffer): Buffer {
  return Buffer.concat([
    Buffer.from('CS/keys/v2/sign', 'utf8'),
    Buffer.from([0x00]),
    Buffer.from(header.packageId, 'utf8'),
    Buffer.from([0x00]),
    Buffer.from(canonicalJsonString(header as unknown as JsonValue), 'utf8'),
    payload,
    authTag
  ])
}

// ---------------------------------------------------------------------------
// 密封（发放员侧；signFn 由设备适配器提供——K_sign 在 TPM 内）
// ---------------------------------------------------------------------------

export interface SealKeyPackageInput {
  packageId: string
  /** 接收设备凭证中解析出的 K_wrap 公钥与设备摘要。 */
  recipient: { wrapPublicKey: string; deviceSummary: string }
  /** 发放员设备 K_sign 公钥（SPKI）与设备摘要；签名经 signFn 在设备内完成。 */
  issuerDevice: { signPublicKey: string; deviceSummary: string }
  password: string
  payload: KeyPackagePayload
  /** 接收者授权的到期 UTC 秒；permanent 传 null。用于包有效期取交集。 */
  recipientLicenseExpiresAtSec: number | null
  nowSec: number
  ttlSec?: number
  /** 设备签名（RSA-PSS/SHA-256），如 adapter.sign。 */
  signFn: (message: Uint8Array) => Promise<string>
  /** 发放员授权信封与签发人证书信封（从发放员本地授权存储读取）。 */
  licenseEnvelope: Envelope
  issuerCertEnvelope: Envelope
}

export interface SealedKeyPackage {
  file: KeyPackageFile
  fileText: string
  packageId: string
  expiresAt: number
}

export async function sealKeyPackage(input: SealKeyPackageInput): Promise<SealedKeyPackage> {
  validatePasswordPolicy(input.password)
  if (input.payload.connections.length > KEY_PACKAGE_LIMITS.maxConnections) {
    throw new LicenseProtocolError('FILE_TOO_LARGE', `连接数超过 ${KEY_PACKAGE_LIMITS.maxConnections}`)
  }
  for (const connection of input.payload.connections) {
    if (connection.modelsJson.length > 0) {
      const models = JSON.parse(connection.modelsJson) as unknown
      if (Array.isArray(models) && models.length > KEY_PACKAGE_LIMITS.maxModelsPerConnection) {
        throw new LicenseProtocolError('FILE_TOO_LARGE', `连接 ${connection.id} 模型数超过上限`)
      }
    }
  }

  const issuedAt = input.nowSec
  const packageExpiry = issuedAt + (input.ttlSec ?? KEY_PACKAGE_LIMITS.defaultTtlSec)
  // 包有效期与接收者授权期限取交集：接收者按天授权先到期时，包随之失效。
  const expiresAt =
    input.recipientLicenseExpiresAtSec !== null
      ? Math.min(packageExpiry, input.recipientLicenseExpiresAtSec)
      : packageExpiry
  if (expiresAt <= issuedAt) {
    throw new LicenseProtocolError('TIME_OUT_OF_RANGE', '接收者授权即将到期，无法签发 7 天密钥包')
  }

  const salt = randomBytes(16)
  const nonce = randomBytes(12)
  const header: KeyPackageHeader = {
    format: 'canvas-studio-keys',
    v: 2,
    packageId: input.packageId,
    recipient: { ...input.recipient },
    issuerDevice: { ...input.issuerDevice },
    issuedAt,
    expiresAt,
    kdf: { salt: encodeBase64Url(salt) },
    cipher: { nonce: encodeBase64Url(nonce) }
  }

  // 1. 设备秘密 S → 接收者 K_wrap 封装。
  const secret = randomBytes(32)
  const wrappedSecret = rsaOaepSha256Encrypt({ wrapPublicKey: input.recipient.wrapPublicKey, plaintext: secret })

  // 2. 内容密钥 = HKDF(S || scrypt(密码))，AES-256-GCM 加密负载，AAD = 包头规范字节。
  const passwordKey = await derivePasswordKey(input.password, salt)
  const contentKey = contentKeyFrom(secret, passwordKey, salt)
  const aad = Buffer.from(canonicalJsonString(header as unknown as JsonValue), 'utf8')
  const payloadText = canonicalJsonString(input.payload as unknown as JsonValue)
  const payloadBytes = Buffer.from(payloadText, 'utf8')
  const cipher = createCipheriv('aes-256-gcm', contentKey, nonce, { authTagLength: 16 })
  cipher.setAAD(aad)
  const ciphertext = Buffer.concat([cipher.update(payloadBytes), cipher.final()])
  const authTag = cipher.getAuthTag()

  // 3. 发放员设备签名（K_sign 在设备内）。
  const signature = await input.signFn(keyPackageSigningInput(header, ciphertext, authTag))

  const file: KeyPackageFile = {
    header,
    wrappedSecret: encodeBase64Url(wrappedSecret),
    payload: encodeBase64Url(ciphertext),
    authTag: encodeBase64Url(authTag),
    sig: signature,
    license: input.licenseEnvelope,
    issuerCert: input.issuerCertEnvelope
  }
  const fileText = canonicalJsonString(file as unknown as JsonValue)
  if (Buffer.byteLength(fileText, 'utf8') > KEY_PACKAGE_LIMITS.fileBytes) {
    throw new LicenseProtocolError('FILE_TOO_LARGE', `密钥包超过 ${KEY_PACKAGE_LIMITS.fileBytes} 字节上限，请分批导出`)
  }
  return { file, fileText, packageId: input.packageId, expiresAt }
}

// ---------------------------------------------------------------------------
// 开封（接收者侧；unwrapFn 由设备适配器提供——K_wrap 私钥在 TPM 内）
// ---------------------------------------------------------------------------

export interface OpenKeyPackageInput {
  file: unknown
  /** 接收者本机 K_wrap 公钥（用于确认包是发给本机的）。 */
  localWrapPublicKey: string
  /** 本机当前授权到期秒；permanent 传 null。 */
  localLicenseExpiresAtSec: number | null
  password: string
  nowSec: number
  /** 受信根（客户端固定公钥）。 */
  trustedRoot: TrustedRoot
  /** 设备解封装（RSA-OAEP），如 adapter.unwrap。 */
  unwrapFn: (wrapped: Uint8Array) => Promise<Buffer>
}

export interface OpenedKeyPackage {
  header: KeyPackageHeader
  payload: KeyPackagePayload
}

export async function openKeyPackage(input: OpenKeyPackageInput): Promise<OpenedKeyPackage> {
  const text = typeof input.file === 'string' ? input.file : null
  const parsedFile = text
    ? KeyPackageFileSchema.parse(parseWithinLimit(text))
    : KeyPackageFileSchema.parse(input.file)
  const header = parsedFile.header

  // 1. 发放员授权链：根 → 证书 → 授权，能力必须含 credentials.export。
  const cert = verifyEnvelope({
    envelope: parsedFile.issuerCert,
    purpose: 'issuerCert',
    schema: IssuerCertPayloadSchema,
    signerPublicKey: input.trustedRoot.publicKey,
    maxPayloadBytes: 64 * 1024,
    label: '签发人证书'
  })
  if (parsedFile.issuerCert.kid !== input.trustedRoot.kid) {
    throw new LicenseProtocolError('KID_MISMATCH', '发放员授权证书不是由受信根签署')
  }
  const license = verifyEnvelope({
    envelope: parsedFile.license,
    purpose: 'license',
    schema: LicensePayloadSchema,
    signerPublicKey: cert.publicKey,
    maxPayloadBytes: 64 * 1024,
    label: '发放员授权'
  })
  if (!license.capabilities.includes('credentials.export')) {
    throw new LicenseProtocolError('CERT_CAPABILITY_MISSING', '发放员授权缺少 credentials.export 能力')
  }
  // 发放员设备绑定：授权的 signKeyId 必须等于包内设备公钥的 kid。
  if (license.signKeyId !== kidFromSpki(decodeBase64Url(header.issuerDevice.signPublicKey))) {
    throw new LicenseProtocolError('KID_MISMATCH', '发放员设备公钥与授权不匹配')
  }

  // 2. 期限：包有效期 + 本机授权期限取交集，now 必须落在窗口内。
  const effectiveExpiry =
    input.localLicenseExpiresAtSec !== null
      ? Math.min(header.expiresAt, input.localLicenseExpiresAtSec)
      : header.expiresAt
  if (input.nowSec < header.issuedAt || input.nowSec >= effectiveExpiry) {
    throw new LicenseProtocolError('TIME_OUT_OF_RANGE', '密钥包已过期或尚未生效')
  }

  // 3. 接收方绑定：包必须发给本机。
  if (header.recipient.wrapPublicKey !== input.localWrapPublicKey) {
    throw new LicenseProtocolError('REQUEST_MISMATCH', '密钥包的接收设备与本机不符')
  }

  // 4. 发放员设备签名。
  const ciphertext = decodeBase64Url(parsedFile.payload)
  const authTag = decodeBase64Url(parsedFile.authTag)
  const signatureValid = rsaPssSha256Verify({
    signPublicKey: header.issuerDevice.signPublicKey,
    message: keyPackageSigningInput(header, ciphertext, authTag),
    sig: parsedFile.sig
  })
  if (!signatureValid) {
    throw new LicenseProtocolError('SIGNATURE_INVALID', '密钥包签名验证失败')
  }

  // 5. 解封装 S（本机 TPM）+ 口令派生 → 内容密钥 → AES-GCM 解密。
  let secret: Buffer
  try {
    secret = await input.unwrapFn(decodeBase64Url(parsedFile.wrappedSecret))
  } catch {
    // 与签名失败同一对外提示，避免区分探测。
    throw new LicenseProtocolError('SIGNATURE_INVALID', '密钥包无法解封：设备或口令不匹配')
  }
  try {
    const salt = decodeBase64Url(header.kdf.salt)
    const nonce = decodeBase64Url(header.cipher.nonce)
    const passwordKey = await derivePasswordKey(input.password, salt)
    const contentKey = contentKeyFrom(secret, passwordKey, salt)
    const decipher = createDecipheriv('aes-256-gcm', contentKey, nonce, { authTagLength: 16 })
    decipher.setAAD(Buffer.from(canonicalJsonString(header as unknown as JsonValue), 'utf8'))
    decipher.setAuthTag(authTag)
    const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()])
    const payload = KeyPackagePayloadSchema.parse(JSON.parse(plaintext.toString('utf8')))
    return { header, payload }
  } catch (error) {
    if (error instanceof LicenseProtocolError) throw error
    // 口令错误与 GCM 认证失败统一提示。
    throw new LicenseProtocolError('SIGNATURE_INVALID', '密钥包无法解封：设备或口令不匹配')
  } finally {
    secret.fill(0)
  }
}

function parseWithinLimit(text: string): JsonValue {
  if (Buffer.byteLength(text, 'utf8') > KEY_PACKAGE_LIMITS.fileBytes) {
    throw new LicenseProtocolError('FILE_TOO_LARGE', `密钥包超过 ${KEY_PACKAGE_LIMITS.fileBytes} 字节上限`)
  }
  return parseStrictJson(text)
}

/** 规范 HTTPS/HTTP 来源（端点绑定用）：scheme://host[:port]。 */
export function originOf(baseUrl: string): string {
  const url = new URL(baseUrl)
  return `${url.protocol}//${url.host}`
}
