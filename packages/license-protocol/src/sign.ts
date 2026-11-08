/**
 * Ed25519 签名与设备 RSA 原语封装（Node crypto）。
 *
 * 签名一律针对 canonical.signingInput 产出的「用途前缀字节」；
 * 验签失败、键格式错误等一律返回 false 或抛稳定原因码，不允许静默通过。
 */
import {
  createHash,
  createHmac,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  sign as cryptoSign,
  verify as cryptoVerify,
  timingSafeEqual
} from 'node:crypto'
import { Buffer } from 'node:buffer'
import { LicenseProtocolError } from './errors.ts'
import {
  decodeBase64Url,
  encodeBase64Url,
  signingInput,
  type SigningPurpose
} from './canonical.ts'

export interface GeneratedEd25519Key {
  /** PKCS8 PEM，仅保存在签发/根密钥介质，绝不进入客户端包。 */
  privateKeyPem: string
  /** SPKI DER base64url。 */
  publicKey: string
  kid: string
}

export function generateEd25519Key(): GeneratedEd25519Key {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519')
  const spki = publicKey.export({ format: 'der', type: 'spki' })
  return {
    privateKeyPem: privateKey.export({ format: 'pem', type: 'pkcs8' }).toString(),
    publicKey: encodeBase64Url(spki),
    kid: kidFromSpki(spki)
  }
}

export function kidFromSpki(spkiDer: Uint8Array): string {
  return `sha256-${createHash('sha256').update(Buffer.from(spkiDer)).digest('hex')}`
}

export function kidFromSpkiBase64Url(spkiBase64Url: string): string {
  return kidFromSpki(decodeBase64Url(spkiBase64Url))
}

/** Ed25519 签名（用途前缀输入）。返回 base64url 签名。 */
export function signWithPurpose(input: {
  purpose: SigningPurpose
  kid: string
  privateKeyPem: string
  payloadBytes: Uint8Array
}): string {
  const message = signingInput(input.purpose, input.kid, input.payloadBytes)
  const signature = cryptoSign(null, message, createPrivateKey(input.privateKeyPem))
  return encodeBase64Url(signature)
}

/** Ed25519 验签。任何异常都归并为 false。 */
export function verifyWithPurpose(input: {
  purpose: SigningPurpose
  kid: string
  publicKey: string
  payloadBytes: Uint8Array
  sig: string
}): boolean {
  try {
    const message = signingInput(input.purpose, input.kid, input.payloadBytes)
    return cryptoVerify(
      null,
      message,
      createPublicKey({ key: decodeBase64Url(input.publicKey), format: 'der', type: 'spki' }),
      decodeBase64Url(input.sig)
    )
  } catch {
    return false
  }
}

export function hmacSha256(key: Buffer, data: Buffer): Buffer {
  return createHmac('sha256', key).update(data).digest()
}

/** 常量时间比较；长度不一致直接返回 false。 */
export function safeEqual(a: Buffer, b: Buffer): boolean {
  if (a.length !== b.length) return false
  return timingSafeEqual(a, b)
}

export { decodeBase64Url, encodeBase64Url, signingInput }
export type { SigningPurpose }
export { LicenseProtocolError }
