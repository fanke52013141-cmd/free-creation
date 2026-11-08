/**
 * 设备证明材料与设备摘要。
 *
 * .csproof 的两条持有证明与 deviceSummary 的字节布局在这里固定，
 * 设备端（适配器）与签发端（cs-issuer）共用，避免两端各自实现产生漂移。
 */
import { createHash } from 'node:crypto'
import { Buffer } from 'node:buffer'
import { SIGNING_PURPOSE, decodeBase64Url } from './canonical.ts'

/**
 * 证明消息 = utf8(用途) || 0x00 || utf8(challengeId) || 0x00 || nonce 原始字节(32)。
 * - proofHmac：HMAC-SHA256 的消息（密钥为解封装出的 32 字节秘密）；
 * - proofSign：K_sign RSA-PSS 签名的消息。
 */
export function buildProofMessage(
  purpose: 'proofHmac' | 'proofSign',
  challengeId: string,
  nonceBase64Url: string
): Buffer {
  const nonce = decodeBase64Url(nonceBase64Url)
  if (nonce.length !== 32) {
    throw new Error('challenge nonce 必须是 32 字节')
  }
  return Buffer.concat([
    Buffer.from(SIGNING_PURPOSE[purpose], 'utf8'),
    Buffer.from([0x00]),
    Buffer.from(challengeId, 'utf8'),
    Buffer.from([0x00]),
    nonce
  ])
}

/** 设备摘要：sha256(signSpki || wrapSpki) 前 16 个十六进制字符，用于人工核对设备。 */
export function deviceSummaryFromSpki(signSpki: Buffer, wrapSpki: Buffer): string {
  return createHash('sha256')
    .update(signSpki)
    .update(wrapSpki)
    .digest('hex')
    .slice(0, 16)
}
