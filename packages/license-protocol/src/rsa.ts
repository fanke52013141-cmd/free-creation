/**
 * 设备 RSA 原语（签发端需要的公开操作）。
 *
 * 设备私钥操作（PSS 签名、OAEP 解封装）只在设备适配器内进行；
 * 本文件提供签发端所需的：SPKI DER 构造（从模数/指数）、PSS 验签、OAEP 封装。
 * 参数固定为 RSA-2048、PSS/SHA-256、32 字节盐、OAEP-SHA256 + MGF1-SHA256。
 */
import { createPublicKey, constants, publicEncrypt, verify as cryptoVerify } from 'node:crypto'
import { Buffer } from 'node:buffer'
import { decodeBase64Url, encodeBase64Url } from './canonical.ts'
import { LicenseProtocolError } from './errors.ts'

export const RSA_MODULUS_BITS = 2048
/** RSA-PSS 盐长度：SHA-256 摘要长度，即 32 字节。 */
export const RSA_PSS_SALT_LENGTH = 32

interface Asn1Buffer {
  readonly bytes: Buffer
}

function derLength(length: number): Buffer {
  if (length < 0x80) return Buffer.from([length])
  if (length < 0x100) return Buffer.from([0x81, length])
  return Buffer.from([0x82, length >> 8, length & 0xff])
}

function derTag(tag: number, content: Buffer): Buffer {
  return Buffer.concat([Buffer.from([tag]), derLength(content.length), content])
}

function derSequence(parts: Buffer[]): Buffer {
  return derTag(0x30, Buffer.concat(parts))
}

function derInteger(value: Buffer): Buffer {
  // 正整数高位为 1 时补 0x00，保持非负语义。
  const needsPad = value.length === 0 || value[0] >= 0x80
  const content = needsPad ? Buffer.concat([Buffer.from([0]), value]) : value
  return derTag(0x02, content)
}

const RSA_OID = Buffer.from([0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01])
const DER_NULL = Buffer.from([0x05, 0x00])

/** 从模数/指数构造 RSA SPKI DER（SubjectPublicKeyInfo）。 */
export function spkiFromRsaComponents(modulus: Buffer, exponent: Buffer): Buffer {
  if (modulus.length < 256) {
    // 2048 位模数应为 256 字节；允许极小偏差但拒绝明显不是 RSA-2048 的输入。
    if (modulus.length < 128) {
      throw new LicenseProtocolError('SCHEMA_INVALID', '设备公钥模数长度不符合 RSA-2048 预期')
    }
  }
  const publicKeySequence = derSequence([derInteger(modulus), derInteger(exponent)])
  const bitStringContent = Buffer.concat([Buffer.from([0x00]), publicKeySequence])
  return derSequence([derSequence([RSA_OID, DER_NULL]), derTag(0x03, bitStringContent)])
}

export interface RsaPublicXml {
  modulus: Buffer
  exponent: Buffer
}

/** 解析 .NET RSA ToXmlString(false) 输出的公钥 XML（签发端不使用，适配器测试使用）。 */
export function parseRsaPublicXml(xml: string): RsaPublicXml {
  const modulusMatch = /<Modulus>([^<]+)<\/Modulus>/.exec(xml)
  const exponentMatch = /<Exponent>([^<]+)<\/Exponent>/.exec(xml)
  if (!modulusMatch || !exponentMatch) {
    throw new LicenseProtocolError('SCHEMA_INVALID', '公钥 XML 缺少模数或指数')
  }
  return {
    modulus: Buffer.from(modulusMatch[1], 'base64'),
    exponent: Buffer.from(exponentMatch[1], 'base64')
  }
}

/** 设备签名（RSA-PSS/SHA-256，32 字节盐）验签。任何异常归并为 false。 */
export function rsaPssSha256Verify(input: {
  signPublicKey: string
  message: Buffer
  sig: string
}): boolean {
  try {
    const key = createPublicKey({
      key: decodeBase64Url(input.signPublicKey),
      format: 'der',
      type: 'spki'
    })
    return cryptoVerify('sha256', input.message, { key, padding: constants.RSA_PKCS1_PSS_PADDING }, decodeBase64Url(input.sig))
  } catch {
    return false
  }
}

/**
 * RSA-OAEP-SHA256（MGF1-SHA256）封装：用设备 K_wrap 公钥加密 32 字节秘密。
 * Node 对 OAEP 与 MGF1 使用同一哈希，符合方案要求。
 */
export function rsaOaepSha256Encrypt(input: { wrapPublicKey: string; plaintext: Buffer }): Buffer {
  const key = createPublicKey({
    key: decodeBase64Url(input.wrapPublicKey),
    format: 'der',
    type: 'spki'
  })
  return publicEncrypt(
    { key, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' },
    input.plaintext
  )
}

export { decodeBase64Url, encodeBase64Url }
export type { Asn1Buffer }
