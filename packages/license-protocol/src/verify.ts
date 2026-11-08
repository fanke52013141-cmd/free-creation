/**
 * 签名信封验证管线（从包入口抽出，供其他模块无循环引用地复用）。
 *
 * 结构 → 尺寸 → 负载解码与严格解析 → Schema → 签名。任何一步失败都抛稳定原因码。
 */
import { Buffer } from 'node:buffer'
import { z } from 'zod'
import {
  canonicalBytes,
  decodeBase64Url,
  parseStrictJson,
  type JsonValue,
  type SigningPurpose
} from './canonical.ts'
import { LicenseProtocolError } from './errors.ts'
import { verifyWithPurpose } from './sign.ts'
import { EnvelopeSchema } from './types.ts'

export function verifyEnvelope<T>(input: {
  envelope: unknown
  purpose: SigningPurpose
  schema: z.ZodType<T>
  signerPublicKey: string
  maxPayloadBytes: number
  label: string
}): T {
  const envelope = EnvelopeSchema.parse(input.envelope)
  const payloadBytes = decodeBase64Url(envelope.payload)
  if (payloadBytes.length > input.maxPayloadBytes) {
    throw new LicenseProtocolError(
      'FILE_TOO_LARGE',
      `${input.label} 负载超过 ${input.maxPayloadBytes} 字节上限`
    )
  }
  let parsedPayload: JsonValue
  try {
    parsedPayload = parseStrictJson(payloadBytes.toString('utf8'))
  } catch (error) {
    if (error instanceof LicenseProtocolError) throw error
    throw new LicenseProtocolError('JSON_MALFORMED', `${input.label} 负载不是合法 JSON`)
  }
  if (parsedPayload === null || typeof parsedPayload !== 'object' || Array.isArray(parsedPayload)) {
    throw new LicenseProtocolError('SCHEMA_INVALID', `${input.label} 负载必须是 JSON 对象`)
  }
  const payload = input.schema.parse(parsedPayload)
  const signatureValid = verifyWithPurpose({
    purpose: input.purpose,
    kid: envelope.kid,
    publicKey: input.signerPublicKey,
    payloadBytes,
    sig: envelope.sig
  })
  if (!signatureValid) {
    throw new LicenseProtocolError('SIGNATURE_INVALID', `${input.label} 签名验证失败`)
  }
  return payload
}

/** 信封产出共用：把负载对象变成规范字节。 */
export function sealEnvelopePayload(payload: JsonValue): { payloadBytes: Buffer; payloadText: string } {
  const payloadBytes = canonicalBytes(payload)
  return { payloadBytes, payloadText: payloadBytes.toString('utf8') }
}
